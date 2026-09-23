// Verify PDF data builder returns the right qty_unit per commande.
import 'dotenv/config'
import { buildCommandePdfData } from '../routes/commandes-sous-traitant.js'

async function main() {
  const tricot = await buildCommandePdfData(8582)
  const ennob = await buildCommandePdfData(8587)
  // A rectiligne order (type 4, cols / bandes — LIVA #1185): pieces, and the
  // line reads R002 (ref_rectiligne), never the écru sharing its id.
  const recti = await buildCommandePdfData(8394)
  console.log('sst 8582 (tricoteur): qty_unit =', tricot?.qty_unit, '- line qty =', tricot?.lignes[0]?.quantite)
  console.log('sst 8587 (ennoblisseur): qty_unit =', ennob?.qty_unit, '- line qty =', ennob?.lignes[0]?.quantite)
  console.log('sst 8394 (rectiligne): qty_unit =', recti?.qty_unit, '- ref =', recti?.lignes[0]?.ref_label, '- fils =', recti?.lignes[0]?.fils_label)
  if (recti && (recti.qty_unit !== 'U' || recti.lignes[0]?.ref_label !== 'R002')) {
    console.error('FAIL: sst 8394 should be qty_unit U, ref R002')
    process.exit(1)
  }
}
main().catch(e => { console.error(e); process.exit(1) })
