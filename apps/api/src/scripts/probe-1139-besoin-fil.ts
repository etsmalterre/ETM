// LIVA #1139: does "Besoin" on the état de stock fil widget ignore what the OFs already produced?
// Chain: sst commande (Tricotage Malterre) → mirror TRM commande_client (IDcommande_ETM)
//        → ligne_commande_client → ordre_fabrication.IDligne_commande_client → stock_ecru / asso_fil_of
import { query, closeConnection } from '../lib/hfsql-auto.js'
const num = (v: any) => Number(v) || 0
async function main() {
  const fresh = await query<any>(`SELECT MAX(IDordre_fabrication) AS m FROM ordre_fabrication`)
  console.log('max OF id (freshness):', fresh[0]?.m)
  for (const cmd of [8972, 8884, 8998, 9005, 9004]) {
    const hdr = await query<any>(`SELECT IDcommande_sous_traitant AS id, est_soldee, IDsous_traitant AS sst FROM commande_sous_traitant WHERE IDcommande_sous_traitant = ${cmd}`)
    console.log(`\n=== STT ${cmd}`, JSON.stringify(hdr[0]))
    const lines = await query<any>(`SELECT IDligne_commande_sous_traitant AS l, quantite, sstatut, IDreference AS ref FROM ligne_commande_sous_traitant WHERE IDcommande_sous_traitant = ${cmd}`)
    for (const l of lines) {
      console.log(' ligne', JSON.stringify(l))
      const asso = await query<any>(`SELECT a.IDstock_fil AS sf, a.quantite AS q, sf.lot, sf.stock, sf.stock_initial AS ini, sf.IDref_fil AS rf, sf.IDcolori_fil AS cf FROM asso_fil_lignecmdsst a JOIN stock_fil sf ON sf.IDstock_fil = a.IDstock_fil WHERE a.IDligne_commande_sous_traitant = ${num(l.l)}`)
      for (const a of asso) console.log('   asso_fil_lignecmdsst', JSON.stringify(a))
    }
    const trm = await query<any>(`SELECT IDcommande_client AS id, est_soldee FROM commande_client WHERE IDcommande_ETM = ${cmd}`)
    for (const t of trm) {
      console.log(' TRM commande', JSON.stringify(t))
      const tl = await query<any>(`SELECT IDligne_commande_client AS l, quantite FROM ligne_commande_client WHERE IDcommande_client = ${num(t.id)}`)
      for (const x of tl) {
        console.log('  TRM ligne', JSON.stringify(x))
        const ofs = await query<any>(`SELECT IDordre_fabrication AS of, quantite, est_termine, est_actif, nb_pieces FROM ordre_fabrication WHERE IDligne_commande_client = ${num(x.l)}`)
        for (const o of ofs) {
          console.log('   OF', JSON.stringify(o))
          const prod = await query<any>(`SELECT COUNT(*) AS n, SUM(poids) AS kg FROM stock_ecru WHERE IDordre_fabrication = ${num(o.of)}`)
          console.log('     produced stock_ecru:', JSON.stringify(prod[0]))
          const af = await query<any>(`SELECT a.IDstock_fil AS sf, a.pourcentage AS p, sf.lot, sf.stock, sf.stock_initial AS ini FROM asso_fil_of a JOIN stock_fil sf ON sf.IDstock_fil = a.IDstock_fil WHERE a.IDordre_fabrication = ${num(o.of)}`)
          for (const y of af) console.log('     asso_fil_of', JSON.stringify(y))
        }
      }
    }
  }
  await closeConnection()
}
main().catch((e) => { console.error(e); process.exit(1) })
