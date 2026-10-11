// Replays lib/cycle-ennoblissement.ts on the open dye orders and prints each
// order's step next to Pierre-Emmanuel's Journal, to compare with his codes.
// Read-only.
//   npx tsx src/scripts/essai-cycle-ennoblissement.ts [--env production] [--jour 2026-10-12]
import { config } from 'dotenv'
import { resolve } from 'node:path'

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined }
const env = arg('env') ?? 'development'
config({ path: env === 'production' ? resolve(process.cwd(), '../../../ETM/apps/api/.env.production') : resolve(process.cwd(), '.env.development') })
process.env.PGOPTIONS = '-c default_transaction_read_only=on'

const { mpsPg, closeMpsPg } = await import('../lib/mps-pg.js')
const { lireCommandesEnnoblissement, etatCommande, urgenceCommande } = await import('../lib/cycle-ennoblissement.js')
const jour = arg('jour') ?? new Date().toISOString().slice(0, 10)

const rows = await mpsPg()<{ id: number; journal: string | null }[]>`
  SELECT c.idcommande_sous_traitant AS id, c.journal::text AS journal
  FROM commande_sous_traitant c JOIN sous_traitant st ON st.idsous_traitant = c.idsous_traitant
  WHERE st.idtype_sst <> 1 AND c.est_soldee = 0 AND c.date_commande >= '2026-01-01'
  ORDER BY c.idcommande_sous_traitant`
const faits = await lireCommandesEnnoblissement(rows.map((r) => Number(r.id)))
for (const r of rows) {
  const e = etatCommande(faits.get(Number(r.id))!)
  const lots = e.lots.map((l) => `${l.lot.replace(/^MA/i, '')}:${l.etape}`).join(' ')
  console.log(`${r.id}  ${e.etape.padEnd(12)} ${String(e.main ?? '').padEnd(10)} ${String(e.relance ?? '').padEnd(10)} ${String(urgenceCommande(e, jour) ?? '').padEnd(4)} ${e.solde ? 'solde ' : ''}${lots}  ‖ ${(r.journal ?? '').replace(/\n/g, ' / ').slice(0, 60)}`)
}
await closeMpsPg()
