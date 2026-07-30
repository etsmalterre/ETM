// Probe: commande client 3686 — ennoblissement tab "affecté" discrepancy.
// Legacy shows affecté only for sst cmd 8569; ETM shows values for 8558/8559 too.
import 'dotenv/config'
import { query } from '../lib/hfsql-auto.js'

async function main() {
  const cc = await query<any>(
    `SELECT IDcommande_client, numero, IDclient FROM commande_client WHERE numero = 3686`,
  )
  console.log('commande_client:', cc)
  const ccId = Number(cc[0]?.IDcommande_client)

  const lignes = await query<any>(
    `SELECT IDligne_commande_client AS id, IDreference, TYPE AS type_kind, quantite, unite, IDcolori
       FROM ligne_commande_client WHERE IDcommande_client = ${ccId}`,
  )
  console.log('lignes client:', lignes)

  for (const cstId of [8558, 8559, 8569]) {
    const cst = await query<any>(
      `SELECT IDcommande_sous_traitant AS id, IDsous_traitant, est_soldee
         FROM commande_sous_traitant WHERE IDcommande_sous_traitant = ${cstId}`,
    )
    console.log(`\n=== sst commande id=${cstId} ===`, cst)
    const lcs = await query<any>(
      `SELECT IDligne_commande_sous_traitant AS lid, IDreference, IDColoris, quantite, sstatut, lcs.type AS type_kind
         FROM ligne_commande_sous_traitant lcs WHERE IDcommande_sous_traitant = ${cstId}`,
    )
    console.log('lignes sst:', lcs)
    for (const l of lcs) {
      const lid = Number(l.lid)
      const rolls = await query<any>(
        `SELECT IDstock_ecru AS id, poids, IDligne_commande_client AS lcc, IDcommande_donation AS don
           FROM stock_ecru WHERE IDref_commande_affectation = ${lid}`,
      )
      const byLcc = new Map<number, { n: number; kg: number }>()
      for (const r of rolls) {
        const k = Number(r.lcc) || 0
        const e = byLcc.get(k) ?? { n: 0, kg: 0 }
        e.n++; e.kg += Number(r.poids) || 0
        byLcc.set(k, e)
      }
      console.log(`  lcs ${lid}: ${rolls.length} input rolls, by IDligne_commande_client:`)
      for (const [k, v] of byLcc) console.log(`    lcc=${k}: ${v.n} rolls, ${v.kg.toFixed(2)} kg`)
      const dons = rolls.filter((r: any) => Number(r.don) > 0)
      if (dons.length) console.log(`    (donation rolls: ${dons.length})`)
    }
  }
  // Simulate the fixed buildEnnoblissement columns for line 12627.
  const rf = await query<any>(`SELECT rendement FROM ref_fini WHERE IDref_fini = 639`)
  const rdt = Number(rf[0]?.rendement) || 0
  console.log(`\nrendement ref_fini 639 = ${rdt}`)
  for (const [cstId, lid] of [[8558, 8534], [8559, 8535], [8569, 8545]]) {
    const rolls = await query<any>(
      `SELECT poids, IDligne_commande_client AS lcc, IDcommande_donation AS don
         FROM stock_ecru WHERE IDref_commande_affectation = ${lid}`,
    )
    let aff = 0, dispo = 0
    for (const r of rolls) {
      const p = Number(r.poids) || 0
      if (Number(r.lcc) === 12627) aff += p
      else if (!(Number(r.lcc) > 0) && !(Number(r.don) > 0)) dispo += p
    }
    console.log(`cst ${cstId}: affecté=${(aff * rdt).toFixed(1)} dispo=${(dispo * rdt).toFixed(1)}`)
  }
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
