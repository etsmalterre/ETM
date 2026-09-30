// One-time data fixes that ship with « Postes & appareils » (plan
// ~/.claude/plans/postes-appareils.md, point 5). Dry run by default: prints
// what it would do. --write applies it.
//
//   node --env-file=.env --import tsx src/scripts/postes-appareils-fix.ts [--ref <12 hex>] [--write]
//
// Safe with the API running: no credential changes. Every device keeps its cookie:
//   1. Station account #14 « Regleur » → « Atelier » (identifiant `atelier`).
//      Same id: the shared phones and the pointeuse are bound to it.
//   2. The Visitage PC's session (#10) — a browser session made from the name-
//      picker cookie on 2026-09-30 (« Reprise du choix de nom ») — becomes a
//      named POSTE session IN PLACE: same row, same token, no expiry. The API
//      re-sends the cookie with the poste lifetime on its next touch
//      (lib/auth.ts attach). Several candidates → pick one with --ref.
//   3. The test enrolment « pointeuse vincent » (device 7 under Vincent #1)
//      is revoked.
// Idempotent: a second run finds nothing to do.

import '../load-env.js'
import { mpsPg, closeMpsPg } from '../lib/mps-pg.js'
import { listerAppareils, revoquer } from '../lib/appareils-atelier.js'
import { oublierCache } from '../lib/sessions.js'

const args = process.argv.slice(2)
const write = args.includes('--write')
const refIdx = args.indexOf('--ref')
const refChoisie = refIdx >= 0 ? args[refIdx + 1] : undefined

const ID_ATELIER = 14
const ID_VISITAGE = 10
const LIBELLE_VISITAGE = 'PC visitage'
const ID_POINTEUSE_TEST = 7

const tag = write ? '' : '[dry run] '

async function renommerAtelier(): Promise<void> {
  const sql = mpsPg()
  const [c] = await sql<{ prenom: string | null; nom: string | null; identifiant: string | null; type_compte: string }[]>`
    SELECT prenom, nom, identifiant, type_compte FROM utilisateur WHERE idutilisateur = ${ID_ATELIER}`
  if (!c) { console.log(`1. account #${ID_ATELIER} not found — skipped`); return }
  if (c.prenom === 'Atelier') { console.log(`1. account #${ID_ATELIER} already « Atelier » — nothing to do`); return }
  if (c.prenom !== 'Regleur' || c.type_compte !== 'poste') {
    console.log(`1. account #${ID_ATELIER} is « ${c.prenom} ${c.nom ?? ''} » (${c.type_compte}), not the Regleur poste — skipped`)
    return
  }
  const [pris] = await sql`SELECT idutilisateur FROM utilisateur WHERE identifiant = 'atelier' AND idutilisateur <> ${ID_ATELIER}`
  if (pris) { console.log(`1. identifiant « atelier » already taken by #${pris.idutilisateur} — skipped`); return }
  console.log(`1. ${tag}account #${ID_ATELIER}: « Regleur » (${c.identifiant}) → « Atelier » (atelier)`)
  if (write) await sql`UPDATE utilisateur SET prenom = 'Atelier', identifiant = 'atelier' WHERE idutilisateur = ${ID_ATELIER}`
}

async function visitageEnPoste(): Promise<void> {
  const sql = mpsPg()
  const deja = await sql<{ ref: string; libelle: string | null }[]>`
    SELECT left(id, 12) AS ref, libelle FROM session
    WHERE idutilisateur = ${ID_VISITAGE} AND type = 'poste' AND revoque_le IS NULL`
  const candidats = await sql<{ id: string; ref: string; libelle: string | null; cree_le: Date; vu_le: Date; ip: string | null; user_agent: string | null }[]>`
    SELECT id, left(id, 12) AS ref, libelle, cree_le, vu_le, ip, user_agent FROM session
    WHERE idutilisateur = ${ID_VISITAGE} AND type = 'navigateur' AND revoque_le IS NULL AND expire_le > now()
    ORDER BY vu_le DESC`
  for (const d of deja) console.log(`2. already a poste: ${d.ref} « ${d.libelle ?? ''} »`)
  for (const c of candidats) {
    console.log(`   candidate ${c.ref} « ${c.libelle ?? ''} » opened ${c.cree_le.toISOString()}, seen ${c.vu_le.toISOString()}, ${c.ip ?? '?'} · ${c.user_agent?.slice(0, 60) ?? ''}`)
  }
  const cible = refChoisie
    ? candidats.find((c) => c.ref === refChoisie)
    : candidats.length === 1 && candidats[0].libelle === 'Reprise du choix de nom' ? candidats[0] : undefined
  if (!cible) {
    if (refChoisie) console.log(`2. --ref ${refChoisie} is not a live browser session of #${ID_VISITAGE} — skipped`)
    else if (candidats.length === 0) console.log(`2. no browser session left on #${ID_VISITAGE} — nothing to do`)
    else console.log(`2. ${candidats.length} candidate(s), none certain — rerun with --ref <ref>`)
    return
  }
  console.log(`2. ${tag}session ${cible.ref} → poste « ${LIBELLE_VISITAGE} », no expiry (same token)`)
  if (write) {
    await sql`UPDATE session SET type = 'poste', libelle = ${LIBELLE_VISITAGE}, expire_le = NULL WHERE id = ${cible.id}`
    oublierCache(cible.id)
  }
}

async function revoquerPointeuseTest(): Promise<void> {
  const a = (await listerAppareils()).find((x) => x.id === ID_POINTEUSE_TEST)
  if (!a) { console.log(`3. device ${ID_POINTEUSE_TEST} not enrolled — nothing to do`); return }
  if (a.IDutilisateur !== 1 || !/pointeuse\s+vincent/i.test(a.libelle)) {
    console.log(`3. device ${ID_POINTEUSE_TEST} is « ${a.libelle} » under #${a.IDutilisateur}, not the test pointeuse — skipped`)
    return
  }
  console.log(`3. ${tag}revoke device ${a.id} « ${a.libelle} » (${a.type ?? 'atelier'}, seen ${a.vuLe ?? 'never'})`)
  if (write) await revoquer(a.id)
}

try {
  await renommerAtelier()
  await visitageEnPoste()
  await revoquerPointeuseTest()
  if (!write) console.log('\nDry run — rerun with --write to apply.')
} finally {
  await closeMpsPg()
}
