// One-time data fix that ships with « Comptes Appareils » (plan
// ~/.claude/plans/comptes-appareils.md, point 4). Dry run by default: prints
// what it would do. --write applies it. Needs migration 0005 first
// (`mps-migrate.ts --write`, owner role).
//
//   node --env-file=.env --import tsx src/scripts/comptes-appareils-fix.ts [--write]
//
// Station account #14 « Atelier » (ex-Regleur, a poste member of TRM) holds
// only the pointeuse and the shared atelier phones, which run their own apps.
// It becomes an 'appareils' account (lib/types-compte.ts): its `permission`
// rows (ETM + TRM) and its `utilisateur_app` rows are deleted, so a phone
// enrolled under it carries no ERP right anywhere. Same id: every device
// keeps its cookie. No credential change.
// Idempotent: a second run finds nothing to do.

import '../load-env.js'
import type { Sql } from 'postgres'
import { mpsPg, closeMpsPg } from '../lib/mps-pg.js'
import { listerAppareils } from '../lib/appareils-atelier.js'
import { listerSessions } from '../lib/sessions.js'

const write = process.argv.slice(2).includes('--write')
const ID_ATELIER = 14
const tag = write ? '' : '[dry run] '

async function main(): Promise<void> {
  const sql = mpsPg()
  const [c] = await sql<{ prenom: string | null; nom: string | null; type_compte: string; est_admin: boolean }[]>`
    SELECT prenom, nom, type_compte, est_admin FROM utilisateur WHERE idutilisateur = ${ID_ATELIER}`
  if (!c) { console.log(`account #${ID_ATELIER} not found — nothing to do`); return }
  if (c.prenom !== 'Atelier' || c.nom) {
    console.log(`account #${ID_ATELIER} is « ${c.prenom} ${c.nom ?? ''} », not « Atelier » — run postes-appareils-fix.ts first; skipped`)
    return
  }
  if (c.est_admin) { console.log(`account #${ID_ATELIER} is an administrator — skipped, look at it by hand`); return }

  const permissions = await sql<{ app: string; cle: string }[]>`
    SELECT app, cle FROM permission WHERE idutilisateur = ${ID_ATELIER} ORDER BY app, cle`
  const apps = await sql<{ app: string }[]>`SELECT app FROM utilisateur_app WHERE idutilisateur = ${ID_ATELIER} ORDER BY app`
  const devices = (await listerAppareils()).filter((a) => a.IDutilisateur === ID_ATELIER)
  const sessions = await listerSessions(ID_ATELIER)

  console.log(`account #${ID_ATELIER} « Atelier » (${c.type_compte})`)
  for (const d of devices) console.log(`   device ${d.id} « ${d.libelle} » (${d.type ?? 'atelier'}) — keeps its cookie`)
  for (const s of sessions) {
    console.log(`   ⚠️ live ${s.type} session ${s.ref} « ${s.libelle ?? ''} » — left alone; an appareils account opens no app`)
  }

  if (c.type_compte === 'appareils' && !permissions.length && !apps.length) {
    console.log('already an appareils account with no app and no right — nothing to do')
    return
  }
  if (c.type_compte !== 'appareils') console.log(`${tag}type_compte ${c.type_compte} → appareils`)
  if (permissions.length) {
    console.log(`${tag}delete ${permissions.length} permission row(s): ${permissions.map((p) => `${p.app}:${p.cle}`).join(', ')}`)
  }
  if (apps.length) console.log(`${tag}leave app(s): ${apps.map((a) => a.app).join(', ')}`)
  if (!write) return

  await sql.begin(async (t) => {
    const tx = t as unknown as Sql // postgres.js typing: TransactionSql loses its call signatures
    await tx`DELETE FROM permission WHERE idutilisateur = ${ID_ATELIER}`
    await tx`DELETE FROM utilisateur_app WHERE idutilisateur = ${ID_ATELIER}`
    await tx`UPDATE utilisateur SET type_compte = 'appareils' WHERE idutilisateur = ${ID_ATELIER}`
  })
  console.log('done — the API sees it within 30 s (permission / membership caches)')
}

try {
  await main()
  if (!write) console.log('\nDry run — rerun with --write to apply.')
} finally {
  await closeMpsPg()
}
