// Repair commande_sous_traitant headers whose IDadresse_sous_traitant or
// IDadresse_livraison is 0 while the sous-traitant has a visible address —
// the bon de commande then prints without any address (32 MATEL orders
// since July 2026: « Ennoblir » wrote 0/0, and the dialog sent 0/0 between
// 30/07 and 02/09). Dry run by default: prints every row it would touch.
//
//   tsx --env-file=.env.development src/scripts/repair-sst-adresses.ts            # dry run, since 20260701
//   tsx --env-file=.env src/scripts/repair-sst-adresses.ts --since=20260101 --write
//
// Same rule as lib/sst-adresses.ts: principal = est_defaut row, delivery =
// est_defaut_livraison row, each falling back to the other then to the first
// visible address. A side already set is never touched.
import { query, closeConnection } from '../lib/hfsql-auto.js'

interface AdrRow { IDadresse: number; est_defaut: number | null; est_defaut_livraison: number | null }
function pick(rows: AdrRow[]): { principal: number; livraison: number } {
  const defaut = rows.find((a) => Number(a.est_defaut) === 1) ?? rows[0]
  const defautLiv = rows.find((a) => Number(a.est_defaut_livraison) === 1) ?? defaut
  return { principal: Number(defaut?.IDadresse) || 0, livraison: Number(defautLiv?.IDadresse) || 0 }
}

async function main() {
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const since = (args.find((a) => a.startsWith('--since='))?.slice(8) ?? '20260701').replace(/\D/g, '')
  if (!/^\d{8}$/.test(since)) throw new Error('--since=YYYYMMDD')

  const rows = await query<{ id: number; sst: number; dc: string; ast: number; aliv: number }>(
    `SELECT IDcommande_sous_traitant AS id, IDsous_traitant AS sst, date_commande AS dc,
            IDadresse_sous_traitant AS ast, IDadresse_livraison AS aliv
       FROM commande_sous_traitant
      WHERE date_commande >= '${since}' AND (IDadresse_sous_traitant = 0 OR IDadresse_livraison = 0)
      ORDER BY IDcommande_sous_traitant`,
  )
  console.log(`${rows.length} commande(s) since ${since} with a missing address (${write ? 'WRITE' : 'dry run'})`)
  const defaults = new Map<number, { principal: number; livraison: number }>()
  let fixed = 0, skipped = 0
  for (const r of rows) {
    const sst = Number(r.sst) || 0
    if (!defaults.has(sst)) {
      const adr = await query<AdrRow>(
        `SELECT IDadresse, est_defaut, est_defaut_livraison FROM adresse
          WHERE IDsous_traitant = ${sst} AND (est_visible IS NULL OR est_visible = 1)
          ORDER BY est_defaut DESC, IDadresse`,
      )
      defaults.set(sst, pick(adr))
    }
    const d = defaults.get(sst)!
    const sets: string[] = []
    if ((Number(r.ast) || 0) === 0 && d.principal > 0) sets.push(`IDadresse_sous_traitant = ${d.principal}`)
    if ((Number(r.aliv) || 0) === 0 && d.livraison > 0) sets.push(`IDadresse_livraison = ${d.livraison}`)
    if (sets.length === 0) { skipped++; console.log(`  #${r.id} sst ${sst} ${r.dc}: no visible address to apply — skipped`); continue }
    console.log(`  #${r.id} sst ${sst} ${r.dc} (${r.ast}/${r.aliv}) → ${sets.join(', ')}`)
    if (write) {
      await query(`UPDATE commande_sous_traitant SET ${sets.join(', ')} WHERE IDcommande_sous_traitant = ${Number(r.id)}`)
      fixed++
    }
  }
  console.log(write ? `${fixed} updated, ${skipped} skipped` : `${rows.length - skipped} would be updated, ${skipped} skipped — re-run with --write`)
  await closeConnection()
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
