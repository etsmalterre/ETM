// One-time move to real accounts (plan ~/.claude/plans/user-management.md,
// step 2). Dry run by default: prints what it would do. --write applies it.
//
//   npx tsx src/scripts/comptes-import.ts [--data <dir>] [--write]
//
// Needs migration 0001_comptes_utilisateurs (scripts/mps-migrate.ts) and runs
// with the API role (PG_CONNECTION_STRING). ⚠️ In production, STOP the API
// first: it caches the JSON stores in memory and would write the old ids back.
//
// 1. One account per person: rows of the same person fold into their lowest
//    id (lib/comptes-fusion.ts), recorded in `utilisateur_fusion`, then deleted.
//    Rows without a last name become station accounts (type_compte 'poste').
// 2. Fills identifiant, email (ex data/user-emails.json), est_admin.
// 3. Imports data/permissions.json + permissions-trm.json into `permission`,
//    merging each person's sets (fusionnerCles) — only while the table is
//    empty for that app, so a second run never overwrites later edits.
// 4. Rewrites the old ids in the JSON stores that stay files (notifications,
//    hidden alerts, profiles + photos, ETM subscriptions, enrolled devices),
//    in `abonnement_user`, and in the RH database (`employe.idutilisateur`).
//    Every rewritten file is backed up first (<file>.bak-comptes-<stamp>).
// Idempotent: a second run finds nothing to fold and nothing to import.

import '../load-env.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import postgres, { type Sql } from 'postgres'
import { mpsPg, closeMpsPg } from '../lib/mps-pg.js'
import { migrationStatus } from '../lib/mps-schema.js'
import { carteFusion, fusionnerCles, planFusion } from '../lib/comptes-fusion.js'
import { isAdminUtilisateur } from '../lib/auth.js'
import { isKnownPermissionKey } from '../lib/permission-keys.js'
import { isScreenAccessKey } from '../lib/screen-keys.js'
import { isKnownTrmPermissionKey } from '../lib/permission-keys-trm.js'
import { isTrmScreenAccessKey } from '../lib/screen-keys-trm.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const write = args.includes('--write')
const dataIdx = args.indexOf('--data')
const DATA_DIR = dataIdx >= 0 ? path.resolve(args[dataIdx + 1]) : path.resolve(__dirname, '../../data')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')

type UsersFile<V> = { version: 1; users: Record<string, V> }

async function lireJson<T>(nom: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(DATA_DIR, nom), 'utf8')) as T
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

const ecritures: { nom: string; contenu: unknown }[] = []
const renommages: { de: string; vers: string }[] = []
const log = (s: string) => console.log(s)

/** Rekeys a `{ [id]: value }` map through the merge map. When the kept id
 *  already has a value, `fusion` decides (lists: union). */
function rekey<V>(users: Record<string, V>, carte: Map<number, number>, fusion: (garde: V, ancien: V) => V): { out: Record<string, V>; changes: string[] } {
  const out: Record<string, V> = { ...users }
  const changes: string[] = []
  for (const [ancien, garde] of carte) {
    const v = out[String(ancien)]
    if (v === undefined) continue
    const existant = out[String(garde)]
    out[String(garde)] = existant === undefined ? v : fusion(existant, v)
    delete out[String(ancien)]
    changes.push(`${ancien}→${garde}`)
  }
  return { out, changes }
}

const unionListes = <T>(a: T[], b: T[]) => [...new Set([...a, ...b])]

async function main(): Promise<void> {
  const sql = mpsPg()
  const st = await migrationStatus(sql)
  if (!st.applied.includes('0001_comptes_utilisateurs')) {
    throw new Error('Migration 0001_comptes_utilisateurs not applied — run scripts/mps-migrate.ts --write first.')
  }
  log(`Mode: ${write ? 'WRITE' : 'dry run'} — data dir ${DATA_DIR}`)

  // ── 1. Accounts ─────────────────────────────────────────────
  const rows = await sql<{ idutilisateur: number; prenom: string | null; nom: string | null; identifiant: string | null; email: string | null }[]>`
    SELECT idutilisateur, prenom, nom, identifiant, email FROM utilisateur ORDER BY idutilisateur`
  const plans = planFusion(rows)
  const carte = carteFusion(plans)
  const dejaIdentifies = new Map(rows.map((r) => [r.idutilisateur, r.identifiant]))
  log(`\n1. Accounts: ${rows.length} rows → ${plans.length} accounts`)
  for (const p of plans) {
    const garde = dejaIdentifies.get(p.idutilisateur) ?? p.identifiant
    log(`   #${p.idutilisateur} ${p.prenom} ${p.nom}`.padEnd(38) +
      ` ${p.typeCompte.padEnd(8)} identifiant=${garde}${p.anciens.length ? `  ← folds ${p.anciens.map((a) => `#${a}`).join(', ')}` : ''}` +
      `${isAdminUtilisateur(p) ? '  [admin]' : ''}`)
  }

  // ── 2. Emails ───────────────────────────────────────────────
  const emailsFile = await lireJson<UsersFile<string>>('user-emails.json')
  const emails = new Map<number, string>()
  const conflits: string[] = []
  for (const [k, v] of Object.entries(emailsFile?.users ?? {})) {
    const id = carte.get(Number(k)) ?? Number(k)
    const email = v.trim().toLowerCase()
    if (!email) continue
    const deja = [...emails].find(([, e]) => e === email)
    if (deja && deja[0] !== id) { conflits.push(`${email}: kept on #${deja[0]}, NOT given to #${id}`); continue }
    emails.set(id, email)
  }
  log(`\n2. Emails (user-emails.json): ${emails.size}`)
  for (const [id, e] of emails) log(`   #${id} ${e}`)
  for (const c of conflits) log(`   ⚠️ ${c}`)

  // ── 3. Permissions ──────────────────────────────────────────
  const imports: { app: 'etm' | 'trm'; fichier: string; storable: (k: string) => boolean }[] = [
    { app: 'etm', fichier: 'permissions.json', storable: (k) => isKnownPermissionKey(k) || isScreenAccessKey(k) },
    { app: 'trm', fichier: 'permissions-trm.json', storable: (k) => isKnownTrmPermissionKey(k) || isTrmScreenAccessKey(k) },
  ]
  const lignesPermission: { idutilisateur: number; app: string; cle: string }[] = []
  log('\n3. Permissions')
  for (const imp of imports) {
    const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM permission WHERE app = ${imp.app}`
    if (n > 0) { log(`   ${imp.app}: table already holds ${n} keys — file not imported`); continue }
    const f = await lireJson<UsersFile<string[]>>(imp.fichier)
    if (!f) { log(`   ${imp.app}: no ${imp.fichier}`); continue }
    const parCompte = new Map<number, string[][]>()
    for (const p of plans) {
      const ensembles = [p.idutilisateur, ...p.anciens].map((id) => f.users[String(id)]).filter((e): e is string[] => !!e)
      if (ensembles.length) parCompte.set(p.idutilisateur, ensembles)
    }
    const orphelins = Object.keys(f.users).filter((k) => !rows.some((r) => r.idutilisateur === Number(k)))
    for (const [id, ensembles] of parCompte) {
      const cles = fusionnerCles(ensembles)
      const rejetees = cles.filter((k) => !imp.storable(k))
      const gardees = cles.filter(imp.storable)
      for (const cle of gardees) lignesPermission.push({ idutilisateur: id, app: imp.app, cle })
      const detail = ensembles.length > 1 ? ` (merged ${ensembles.map((e) => e.length).join(' + ')} keys)` : ''
      log(`   ${imp.app} #${id}: ${gardees.length} keys${detail}${rejetees.length ? `, dropped unknown: ${rejetees.join(', ')}` : ''}`)
    }
    if (orphelins.length) log(`   ${imp.app}: ⚠️ keys of deleted users not imported: #${orphelins.join(', #')}`)
  }

  // ── 4. Files and other databases keyed by the old ids ──────
  log('\n4. Old ids elsewhere')
  for (const nom of ['notifications.json', 'notifications-trm.json', 'notification-hidden.json']) {
    const f = await lireJson<UsersFile<string[]>>(nom)
    if (!f) continue
    const { out, changes } = rekey(f.users, carte, unionListes)
    log(`   ${nom}: ${changes.length ? changes.join(', ') : 'nothing to rewrite'}`)
    if (changes.length) ecritures.push({ nom, contenu: { ...f, users: out } })
  }
  {
    const f = await lireJson<Record<string, number[]>>('abonnements-etm.json')
    if (f) {
      const { out, changes } = rekey(f, carte, unionListes)
      log(`   abonnements-etm.json: ${changes.length ? changes.join(', ') : 'nothing to rewrite'}`)
      if (changes.length) ecritures.push({ nom: 'abonnements-etm.json', contenu: out })
    }
  }
  {
    type Profil = { photo?: { ext: string } } & Record<string, unknown>
    const f = await lireJson<UsersFile<Profil>>('user-profiles.json')
    if (f) {
      // The kept account's profile wins; a folded row's photo moves only when
      // the kept account has none.
      const { out, changes } = rekey(f.users, carte, (garde) => garde)
      for (const [ancien, garde] of carte) {
        const p = f.users[String(ancien)]
        if (p?.photo && out[String(garde)] === p) {
          renommages.push({ de: `user-photos/${ancien}.${p.photo.ext}`, vers: `user-photos/${garde}.${p.photo.ext}` })
        }
      }
      log(`   user-profiles.json: ${changes.length ? changes.join(', ') : 'nothing to rewrite'}${renommages.length ? ` (+${renommages.length} photo)` : ''}`)
      if (changes.length) ecritures.push({ nom: 'user-profiles.json', contenu: { ...f, users: out } })
    }
  }
  {
    type Appareil = { id: number; IDutilisateur: number; creePar?: number } & Record<string, unknown>
    const f = await lireJson<{ version: 1; appareils: Appareil[] }>('appareils-atelier.json')
    if (f) {
      const changes: string[] = []
      const appareils = f.appareils.map((a) => {
        const u = carte.get(a.IDutilisateur)
        const c = a.creePar !== undefined ? carte.get(a.creePar) : undefined
        if (u === undefined && c === undefined) return a
        changes.push(`device ${a.id}`)
        return { ...a, ...(u !== undefined ? { IDutilisateur: u } : {}), ...(c !== undefined ? { creePar: c } : {}) }
      })
      log(`   appareils-atelier.json: ${changes.length ? changes.join(', ') : 'nothing to rewrite'}`)
      if (changes.length) ecritures.push({ nom: 'appareils-atelier.json', contenu: { ...f, appareils } })
    }
  }
  const anciens = [...carte.keys()]
  const abos = anciens.length
    ? await sql<{ idabonnement_user: number; idutilisateur: number; idabonnement: number }[]>`
        SELECT idabonnement_user, idutilisateur, idabonnement FROM abonnement_user WHERE idutilisateur IN ${sql(anciens)}`
    : []
  log(`   abonnement_user: ${abos.length ? abos.map((a) => `row ${a.idabonnement_user} #${a.idutilisateur}`).join(', ') : 'nothing to rewrite'}`)

  let rh: Sql | null = null
  let rhLignes: { id: number; idutilisateur: number }[] = []
  if (process.env.RH_PG_URL && anciens.length) {
    rh = postgres(process.env.RH_PG_URL, { max: 1, onnotice: () => {} })
    rhLignes = await rh<{ id: number; idutilisateur: number }[]>`
      SELECT id, idutilisateur FROM employe WHERE idutilisateur IN ${rh(anciens)}`
    log(`   rh.employe: ${rhLignes.length ? rhLignes.map((r) => `employé ${r.id} #${r.idutilisateur}`).join(', ') : 'nothing to rewrite'}`)
  } else {
    log(`   rh.employe: ${process.env.RH_PG_URL ? 'nothing to rewrite' : 'RH_PG_URL not set — skipped'}`)
  }

  if (!write) {
    log('\nDry run — nothing written. Re-run with --write (API stopped in production).')
    await rh?.end()
    return
  }

  // ── Apply ───────────────────────────────────────────────────
  await sql.begin(async (t) => {
    const tx = t as unknown as Sql
    for (const p of plans) {
      await tx`UPDATE utilisateur SET
        identifiant = COALESCE(identifiant, ${p.identifiant}),
        type_compte = ${p.typeCompte},
        est_admin = ${isAdminUtilisateur(p)}
        WHERE idutilisateur = ${p.idutilisateur}`
    }
    for (const [id, email] of emails) {
      await tx`UPDATE utilisateur SET email = ${email} WHERE idutilisateur = ${id} AND email IS NULL`
    }
    if (lignesPermission.length) await tx`INSERT INTO permission ${sql(lignesPermission)} ON CONFLICT DO NOTHING`
    for (const [ancien, garde] of carte) {
      await tx`UPDATE abonnement_user SET idutilisateur = ${garde} WHERE idutilisateur = ${ancien}`
      await tx`INSERT INTO utilisateur_fusion (ancien_id, idutilisateur) VALUES (${ancien}, ${garde}) ON CONFLICT DO NOTHING`
      await tx`DELETE FROM utilisateur WHERE idutilisateur = ${ancien}`
    }
    // The same subscription twice on one account after the fold.
    await tx`DELETE FROM abonnement_user a USING abonnement_user b
      WHERE a.idutilisateur = b.idutilisateur AND a.idabonnement = b.idabonnement
        AND a.idabonnement_user > b.idabonnement_user`
  })
  log('\nDatabase: committed.')

  if (rh && rhLignes.length) {
    for (const r of rhLignes) await rh`UPDATE employe SET idutilisateur = ${carte.get(r.idutilisateur)!} WHERE id = ${r.id}`
    log(`RH: ${rhLignes.length} employé(s) re-linked.`)
  }
  await rh?.end()

  for (const e of ecritures) {
    const fichier = path.join(DATA_DIR, e.nom)
    await fs.copyFile(fichier, `${fichier}.bak-comptes-${STAMP}`)
    await fs.writeFile(`${fichier}.tmp`, JSON.stringify(e.contenu, null, 2), 'utf8')
    await fs.rename(`${fichier}.tmp`, fichier)
    log(`File: ${e.nom} rewritten (backup .bak-comptes-${STAMP})`)
  }
  for (const r of renommages) {
    await fs.rename(path.join(DATA_DIR, r.de), path.join(DATA_DIR, r.vers)).catch((err) => log(`   ⚠️ photo ${r.de}: ${err.message}`))
  }
  for (const nom of ['permissions.json', 'permissions-trm.json', 'user-emails.json']) {
    const fichier = path.join(DATA_DIR, nom)
    await fs.rename(fichier, `${fichier}.imported-${STAMP}`).then(
      () => log(`File: ${nom} → ${nom}.imported-${STAMP} (now in PostgreSQL)`),
      () => {},
    )
  }
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(() => closeMpsPg())

