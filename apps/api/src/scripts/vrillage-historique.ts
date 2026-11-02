// The vrillage typed into lots' observations before ETM had the fields (LIVA #1332).
//
//   npx tsx src/scripts/vrillage-historique.ts [--env production] [--write]
//
// Dry run by default (read-only transaction). Reads « Vrillage = 5% » / « 5 à 7% »
// (our tirelle, worst value of a range) and « M V 5 % » / « MV 5% » (MATEL) from
// suivilot.observations (vrillagesDesObservations) into the colonnes fields —
// nobody wrote the rows. Never overwrites a value already typed in the new
// fields, never touches the observations text. Run after migration 0051.
import { config } from 'dotenv'
import { resolve } from 'node:path'

const arg = (k: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : undefined }
const env = arg('env') ?? 'development'
const write = process.argv.includes('--write')
config({ path: env === 'production' ? resolve(process.cwd(), '../../../ETM/apps/api/.env.production') : resolve(process.cwd(), '.env.development') })
if (!write) process.env.PGOPTIONS = '-c default_transaction_read_only=on'

const { mpsPg, closeMpsPg } = await import('../lib/mps-pg.js')
const { vrillagesDesObservations } = await import('../lib/vrillage.js')
const sql = mpsPg()

const rows = await sql<{ id: string; lot: string | null; o: string; col_sst: number | null; col_tir: number | null }[]>`
  SELECT idsuivilot AS id, trim(lot::text) AS lot, observations::text AS o,
         vrillage_colonnes_sst AS col_sst, vrillage_colonnes_tirelle AS col_tir
  FROM suivilot
  WHERE observations::text ~* 'vrill|M ?V ?[0-9]'
  ORDER BY date, idsuivilot`

interface Ajout { id: number; lot: string; tirelle: number | null; sst: number | null }
const ajouts: Ajout[] = []
let illisibles = 0
for (const r of rows) {
  const v = vrillagesDesObservations(r.o ?? '')
  const tirelle = r.col_tir === null ? v.tirelle : null
  const sst = r.col_sst === null ? v.sst : null
  if (tirelle === null && sst === null) {
    if (v.tirelle === null && v.sst === null) { illisibles++; console.log(`  ? ${r.lot}  « ${(r.o ?? '').replace(/\s+/g, ' ').slice(0, 80)} »`) }
    continue
  }
  ajouts.push({ id: Number(r.id), lot: r.lot ?? '', tirelle, sst })
}

for (const a of ajouts) console.log(`${a.lot.padEnd(12)} tirelle ${a.tirelle ?? '—'}  ennoblisseur ${a.sst ?? '—'}`)
console.log(`${ajouts.length} lot(s) à remplir, ${illisibles} observation(s) citant le vrillage sans valeur lisible (listées « ? »).`)

if (write && ajouts.length) {
  await sql.begin(async (t) => {
    const tx = t as unknown as typeof sql // postgres.js typing: TransactionSql loses its call signatures
    for (const a of ajouts) {
      await tx`
        UPDATE suivilot SET
          vrillage_colonnes_tirelle = COALESCE(vrillage_colonnes_tirelle, ${a.tirelle}),
          vrillage_colonnes_sst = COALESCE(vrillage_colonnes_sst, ${a.sst})
        WHERE idsuivilot = ${a.id}`
    }
  })
  console.log('Écrit.')
} else if (!write) console.log('Essai — relancer avec --write pour écrire.')

await closeMpsPg()
