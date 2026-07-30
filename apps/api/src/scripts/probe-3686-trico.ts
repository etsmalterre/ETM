// Probe: commande client 3686 line 12627 — Tricotage tab discrepancy vs legacy.
// Legacy shows: cmd 8582 dispo 6388 / affecté 0 / métrage 0; cmd 8488 dispo 4000
// / affecté 0 / métrage 0. Fils: coton 3322.29 kg / 12541.24 ml, élasthanne
// 307.65 kg / 18194.33 ml. Replicates buildTricotage + fetchTricoStockFil.
import 'dotenv/config'
import { query } from '../lib/hfsql-auto.js'

const LIGNE = 12627

async function main() {
  const rf = await query<any>(
    `SELECT IDref_ecru, rendement, avec_teinture FROM ref_fini WHERE IDref_fini = 639`,
  )
  const ecruRefId = Number(rf[0]?.IDref_ecru) || 0
  const rendement = Number(rf[0]?.rendement) || 0
  const avecTeinture = Number(rf[0]?.avec_teinture) || 0
  console.log(`ref_fini 639: IDref_ecru=${ecruRefId} rendement=${rendement} avec_teinture=${avecTeinture}`)

  const nat = await query<any>(
    `SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDref_ecru = ${ecruRefId}`,
  )
  console.log('colori_ecru of ref:', nat)
  const ecruColoris = avecTeinture === 0
    ? [5192]
    : nat.filter((r: any) => String(r.reference) === 'ecru').map((r: any) => Number(r.IDcolori_ecru))
  console.log('ecruColoris filter:', ecruColoris)

  // buildTricotage line query
  const coloriFilter = ecruColoris.length > 0 ? ` AND lcs.IDColoris IN (${ecruColoris.join(',')})` : ''
  const lines = await query<any>(
    `SELECT lcs.IDligne_commande_sous_traitant AS lid, lcs.quantite AS q, lcs.date_livraison AS dl,
            lcs.sstatut AS st, cst.IDsous_traitant AS sstid,
            cst.IDcommande_sous_traitant AS cid, cst.date_commande AS dc
       FROM ligne_commande_sous_traitant lcs
       JOIN commande_sous_traitant cst ON cst.IDcommande_sous_traitant = lcs.IDcommande_sous_traitant
      WHERE lcs.type = 1 AND lcs.IDreference = ${ecruRefId}${coloriFilter}
        AND cst.est_soldee = 0 AND lcs.sstatut IN ('En_Cours','Attente_Delai')`,
  )
  console.log('\ntricoteur lines returned by buildTricotage query:')
  for (const l of lines) console.log(`  cst=${l.cid} lcs=${l.lid} q=${l.q} dl=${l.dl} st=${l.st} sst=${l.sstid} dc=${l.dc}`)

  // Output écru per line, with affectation split
  for (const l of lines) {
    const lid = Number(l.lid)
    const rolls = await query<any>(
      `SELECT IDstock_ecru AS id, poids, IDligne_commande_client AS lcc, IDcommande_donation AS don,
              IDref_commande_affectation AS aff, IDmagasin
         FROM stock_ecru WHERE IDref_commande_source = ${lid}`,
    )
    let affAny = 0, affThis = 0, tot = 0, unres = 0
    for (const r of rolls) {
      const p = Number(r.poids) || 0
      tot += p
      if (Number(r.lcc) > 0) affAny += p
      if (Number(r.lcc) === LIGNE) affThis += p
      if (!(Number(r.lcc) > 0) && !(Number(r.don) > 0)) unres += p
    }
    const q = Number(l.q) || 0
    console.log(`\n  lcs ${lid} (cst ${l.cid}): quantite=${q}, produced rolls=${rolls.length} (${tot.toFixed(1)} kg)`)
    console.log(`    affected-to-any-line=${affAny.toFixed(1)} kg, to-line-${LIGNE}=${affThis.toFixed(1)} kg, unreserved=${unres.toFixed(1)} kg`)
    console.log(`    ETM row: affecté=${affAny.toFixed(1)} dispo=${Math.max(0, q - affAny).toFixed(1)} métrage=${(Math.max(0, q - affAny) * rendement).toFixed(1)}`)
    console.log(`    legacy row: affecté=0.0 dispo=${q.toFixed(1)}? métrage=0.0`)
  }

  // Stock fil panel
  console.log('\n=== stock fil ===')
  const pairIn = ecruColoris.length > 0 ? ` AND IDcolori_ecru IN (${ecruColoris.join(',')})` : ''
  let pairRows = await query<any>(
    `SELECT DISTINCT IDref_fil, IDcolori_fil, pourcentage FROM composition_ecru
     WHERE IDref_ecru = ${ecruRefId}${pairIn} AND IDref_fil > 0`,
  )
  if (pairRows.length === 0) pairRows = await query<any>(
    `SELECT DISTINCT IDref_fil, IDcolori_fil, pourcentage FROM composition_ecru
     WHERE IDref_ecru = ${ecruRefId} AND IDref_fil > 0`,
  )
  console.log('composition pairs:', pairRows)
  for (const p of pairRows) {
    const rf2 = Number(p.IDref_fil), cf = Number(p.IDcolori_fil), pct = Number(p.pourcentage) || 0
    const lots = await query<any>(
      `SELECT IDstock_fil, IDMagasin, stock, stock_initial, lot FROM stock_fil
       WHERE IDref_fil = ${rf2} AND IDcolori_fil = ${cf} AND stock > 0`,
    )
    const byMag = new Map<number, number>()
    for (const l of lots) byMag.set(Number(l.IDMagasin) || 0, (byMag.get(Number(l.IDMagasin) || 0) ?? 0) + (Number(l.stock) || 0))
    console.log(`\n  fil ${rf2} colori ${cf} pct=${pct}: ${lots.length} lots with stock>0`)
    for (const [mag, kg] of byMag) {
      const ml = pct > 0 ? (kg / (pct / 100)) * rendement : 0
      console.log(`    magasin ${mag}: ${kg.toFixed(2)} kg -> métrage ${ml.toFixed(2)} ml`)
    }
  }
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
