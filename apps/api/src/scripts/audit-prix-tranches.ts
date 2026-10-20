// Ennoblisseur order lines (sst `type = 2`) priced while their weight fell
// BETWEEN two tariff bands (LIVA #1301): ETM matched `mini <= poids <= maxi`,
// so 240,7 kg was in neither 221-240 nor 241-260 and the auto-price was stored
// without its dye (or at 0). The legacy truncated to the kilo, as MATEL bills
// and as lib/tranche-poids.ts does now, so lines it priced are already right.
// Lists every line whose current weight sits in such a gap and whose stored
// price differs from today's rule. Dry run by default.
//
//   tsx --env-file=.env.development src/scripts/audit-prix-tranches.ts             # dry run, since 20250101
//   tsx --env-file=.env src/scripts/audit-prix-tranches.ts --since=20260101 --write
//
// --write re-prices the listed lines through recalcLignePrix(), the same call
// an affectation change makes. The weight is the line's CURRENT affected écru,
// so a line whose pieces moved since is re-priced on what it holds today.
import { mpsPg } from '../lib/mps-pg.js'
import { calcTarifSST, recalcLignePrix } from '../lib/pricing-sst.js'
import { kgTranche } from '../lib/tranche-poids.js'
import { closeConnection } from '../lib/hfsql-auto.js'

async function main() {
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const since = (args.find((a) => a.startsWith('--since='))?.slice(8) ?? '20250101').replace(/\D/g, '')
  if (!/^\d{8}$/.test(since)) throw new Error('--since=YYYYMMDD')
  const sql = mpsPg()

  const bandes = await sql<{ idsous_traitant: number; quantite_maxi: number }[]>`
    SELECT DISTINCT idsous_traitant, quantite_maxi FROM tranche_tarif_ennoblissement`
  const maxis = new Map<number, number[]>()
  for (const b of bandes) maxis.set(Number(b.idsous_traitant), [...(maxis.get(Number(b.idsous_traitant)) ?? []), Number(b.quantite_maxi)])

  const lignes = await sql<{ id: number; idcommande: number; sst: number; dc: string; ref: number; col: number; prix: number | null; num_facture: string | null; poids: number }[]>`
    SELECT l.idligne_commande_sous_traitant AS id, l.idcommande_sous_traitant AS idcommande, c.idsous_traitant AS sst,
           c.date_commande::text AS dc, l.idreference AS ref, l.idcoloris AS col, l.prix, l.num_facture::text AS num_facture,
           SUM(e.poids) AS poids
      FROM ligne_commande_sous_traitant l
      JOIN commande_sous_traitant c ON c.idcommande_sous_traitant = l.idcommande_sous_traitant
      JOIN stock_ecru e ON e.idref_commande_affectation = l.idligne_commande_sous_traitant
     WHERE l.type = 2 AND c.date_commande >= ${`${since.slice(0, 4)}-${since.slice(4, 6)}-${since.slice(6)}`}::date
     GROUP BY l.idligne_commande_sous_traitant, l.idcommande_sous_traitant, c.idsous_traitant, c.date_commande,
              l.idreference, l.idcoloris, l.prix, l.num_facture
     ORDER BY c.date_commande, l.idligne_commande_sous_traitant`

  let listed = 0
  for (const l of lignes) {
    const poids = Number(l.poids) || 0
    const kg = kgTranche(poids)
    // In a gap = above a band's maxi by less than one kilo.
    if (kg === poids || !(maxis.get(Number(l.sst)) ?? []).some((m) => poids > m && poids < m + 1)) continue
    const nouveau = await calcTarifSST({ xPoids: poids, IDsous_traitant: Number(l.sst), IDref_fini: Number(l.ref), IDref_fini_colori: Number(l.col) })
    const ancien = Number(l.prix) || 0
    if (Math.abs(nouveau - ancien) < 0.005) continue
    listed++
    const facture = String(l.num_facture ?? '').trim()
    console.log(`  cde ${l.idcommande} ligne ${l.id} sst ${l.sst} du ${l.dc.slice(0, 10)} : ${poids} kg, prix ${ancien} -> ${nouveau} €/kg${facture ? ` (facture ${facture})` : ''}`)
    if (write) await recalcLignePrix(Number(l.id))
  }
  console.log(`${lignes.length} ligne(s) ennoblisseur depuis ${since}, ${listed} ${write ? 're-tarifée(s)' : 'à re-tarifer (relancer avec --write)'}`)
  await sql.end()
  await closeConnection()
}

main().catch((e) => { console.error(e); process.exit(1) })
