// Dispenses a client of the rapport de contrôle of some lots (migration 0034,
// lib/rapport-controle-lot.ts): the lot then owes that client nothing.
//
//   npx tsx src/scripts/rc-dispense.ts --client 237 --lots MA107740,MA107910 --motif "…" [--env production] [--write]
//
// Dry run by default (read-only transaction). A lot is resolved through the
// client's rolls (stock_fini → its order line → commande_client.idclient), so
// every (sst line, lot) the client holds pieces of gets one row; a pair already
// dispensed is skipped. First use 2026-10-23 (decision Vincent): Le teeshirt
// propre's lots validated before it asked for RCs.
import { config } from 'dotenv'
import { resolve } from 'node:path'
import type { Sql } from 'postgres'

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined }
const env = arg('env') ?? 'development'
const write = process.argv.includes('--write')
config({ path: env === 'production' ? resolve(process.cwd(), '../../../ETM/apps/api/.env.production') : resolve(process.cwd(), '.env.development') })
if (!write) process.env.PGOPTIONS = '-c default_transaction_read_only=on'

const idclient = parseInt(arg('client') ?? '', 10)
const lots = (arg('lots') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const motif = (arg('motif') ?? '').trim()
if (!(idclient > 0) || lots.length === 0 || !motif) {
  console.error('usage: --client <id> --lots L1,L2 --motif "…" [--env production] [--write]')
  process.exit(1)
}

const { mpsPg, closeMpsPg } = await import('../lib/mps-pg.js')
const sql = mpsPg()

const paires = await sql<{ ligne: number; lot: string; pieces: number; non_exp: number }[]>`
  SELECT sf.idref_commande_source AS ligne, trim(sf.lot::text) AS lot, count(*)::int AS pieces,
         count(*) FILTER (WHERE COALESCE(sf.idligne_expedition, 0) = 0)::int AS non_exp
  FROM stock_fini sf
  JOIN ligne_commande_client lcc ON lcc.idligne_commande_client = sf.idligne_commande_client
  JOIN commande_client cc ON cc.idcommande_client = lcc.idcommande_client
  WHERE cc.idclient = ${idclient} AND sf.idligne_commande_client > 0 AND sf.idref_commande_source > 0
    AND COALESCE(sf.idcommande_donation, 0) = 0 AND upper(trim(sf.lot::text)) = ANY(${lots.map((l) => l.toUpperCase())})
  GROUP BY 1, 2 ORDER BY 2, 1`
// A dry run only reads: it works before the migration created the table.
const [{ table }] = await sql<{ table: boolean }[]>`SELECT to_regclass('rapport_controle_dispense') IS NOT NULL AS table`
if (write && !table) throw new Error('table rapport_controle_dispense absente : lancer mps-migrate --write d’abord')
const deja = table
  ? await sql<{ ligne: number; lot: string }[]>`
      SELECT idligne_commande_sous_traitant AS ligne, lot FROM rapport_controle_dispense WHERE idclient = ${idclient}`
  : []
const dejaSet = new Set(deja.map((d) => `${Number(d.ligne)}|${d.lot}`))

const trouves = new Set(paires.map((p) => p.lot.toUpperCase()))
for (const l of lots) if (!trouves.has(l.toUpperCase())) console.log(`  ?  ${l} : aucune pièce de ce client`)
const aEcrire = paires.filter((p) => !dejaSet.has(`${Number(p.ligne)}|${p.lot}`))
for (const p of paires) {
  const skip = !aEcrire.includes(p)
  console.log(`  ${skip ? '=' : '+'}  ligne ${p.ligne}  ${p.lot.padEnd(10)}  ${p.pieces} pièce(s), ${p.non_exp} non expédiée(s)${skip ? '  (déjà dispensé)' : ''}`)
}

if (write && aEcrire.length > 0) {
  await sql.begin(async (tx) => {
    const t = tx as unknown as Sql // postgres.js typing: TransactionSql loses its call signatures
    for (const p of aEcrire) {
      await t`INSERT INTO rapport_controle_dispense (idligne_commande_sous_traitant, lot, idclient, motif, saisi_par)
              VALUES (${Number(p.ligne)}, ${p.lot}, ${idclient}, ${motif}, 'script rc-dispense')`
    }
  })
  console.log(`${aEcrire.length} dispense(s) écrite(s).`)
} else {
  console.log(`${aEcrire.length} dispense(s) à écrire${write ? '' : ' (essai — relancer avec --write)'}.`)
}
await closeMpsPg()
