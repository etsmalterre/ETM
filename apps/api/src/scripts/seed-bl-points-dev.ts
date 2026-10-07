// Seeds an avis d'expédition with « points à signaler » in the DEV database,
// to try the BL email paragraph of LIVA #1266 (Clients › Commandes, order
// 3874 LEMAHIEU → avis → @ Envoyer).
//
//   npx tsx src/scripts/seed-bl-points-dev.ts
//
// Creates (or reuses — idempotent) one avis on order 3874 with four rolls:
//   3560/48  observation already in dev  → listed (observations shown)
//   3560/10  8 Ml non facturés + motif    → listed
//   3569/18  12 Ml non facturés           → motif added, listed
//   3560/1   nothing                      → not listed
// plus a BL observation. Rolls are set « Validé » (only those ship).
// Writes through the same SQL as the routes; the Ml non facturés through
// ecrireMlNonFactures (journaled, author « Seed dev »). Refuses anything but a
// *_dev database.

import dotenv from 'dotenv'

dotenv.config({ path: '.env.development' })
const url = process.env.PG_CONNECTION_STRING ?? ''
if (!/\/[a-z_]+_dev(\?|$)/.test(url)) {
  console.error('Refusé : PG_CONNECTION_STRING ne pointe pas sur une base *_dev.')
  process.exit(1)
}

const { query } = await import('../lib/hfsql-auto.js')
const { wrapRtf } = await import('../lib/rtf-utils.js')
const { sqlText, maxId, newIdAfterInsert } = await import('../routes/expeditions.js')
const { ecrireMlNonFactures } = await import('../lib/ml-non-factures.js')
const { closeMpsPg } = await import('../lib/mps-pg.js')

const NUMERO_COMMANDE = 3874
const OBSERVATION_BL = 'Livraison partielle : le solde suivra la semaine prochaine.'
const ROULEAUX: Array<{ numero: string; ml?: number; motif?: string; observation?: string }> = [
  { numero: '3560/48' },
  { numero: '3560/10', ml: 8, motif: 'barre de teinture sur les 8 premiers mètres' },
  { numero: '3569/18', ml: 12, motif: 'trous en lisière' },
  { numero: '3560/1' },
]

const cmd = await query<{ IDcommande_client: number }>(
  `SELECT IDcommande_client FROM commande_client WHERE numero = ${NUMERO_COMMANDE} AND IDsociete = 1`,
)
const idCommande = Number(cmd[0]?.IDcommande_client) || 0
if (!idCommande) { console.error(`Commande ${NUMERO_COMMANDE} introuvable`); process.exit(1) }

// Reuse the avis this script made earlier (recognised by its BL observation).
const existing = await query<{ IDexpedition: number; observation_bl: string | null }>(
  `SELECT IDexpedition, observation_bl FROM expedition WHERE IDcommande_client = ${idCommande} AND IDsociete = 1 AND est_facture = 0`,
)
let idExpedition = Number(existing.find((e) => (e.observation_bl ?? '').includes('Livraison partielle'))?.IDexpedition) || 0
if (!idExpedition) {
  const cmdRows = await query<{ IDclient: number; IDadresse_livraison: number }>(
    `SELECT IDclient, IDadresse_livraison FROM commande_client WHERE IDcommande_client = ${idCommande}`,
  )
  const cli = await query<{ IDtransporteur: number }>(`SELECT IDtransporteur FROM client WHERE IDclient = ${Number(cmdRows[0].IDclient) || 0}`)
  const d = new Date()
  const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const before = await maxId('expedition', 'IDexpedition')
  await query(
    `INSERT INTO expedition (IDsociete, IDcommande_client, IDadresse, IDtransporteur, IDcontact, DATE, donation, affiche_observations, est_valide, est_facture, inclureRapportQualite) ` +
      `VALUES (1, ${idCommande}, ${Number(cmdRows[0].IDadresse_livraison) || 0}, ${Number(cli[0]?.IDtransporteur) || 0}, 0, '${date}', 0, 1, 0, 0, 0)`,
  )
  idExpedition = await newIdAfterInsert('expedition', 'IDexpedition', before)
  if (!idExpedition) { console.error('Création de l’avis échouée'); process.exit(1) }
}
await query(`UPDATE expedition SET affiche_observations = 1, observation_bl = ${sqlText(wrapRtf(OBSERVATION_BL))} WHERE IDexpedition = ${idExpedition}`)

for (const r of ROULEAUX) {
  const rows = await query<{ IDstock_fini: number; IDligne_commande_client: number }>(
    `SELECT IDstock_fini, IDligne_commande_client FROM stock_fini WHERE numero = '${r.numero}' AND IDligne_commande_client IN ` +
      `(SELECT IDligne_commande_client FROM ligne_commande_client WHERE IDcommande_client = ${idCommande})`,
  )
  const roll = rows[0]
  if (!roll) { console.warn(`Pièce ${r.numero} absente de la commande — ignorée`); continue }
  const lcc = Number(roll.IDligne_commande_client)
  let le = await query<{ IDligne_expedition: number }>(
    `SELECT IDligne_expedition FROM ligne_expedition WHERE IDexpedition = ${idExpedition} AND IDligne_commande_client = ${lcc}`,
  )
  if (le.length === 0) {
    await query(`INSERT INTO ligne_expedition (IDexpedition, IDligne_commande_client, est_facture) VALUES (${idExpedition}, ${lcc}, 0)`)
    le = await query(`SELECT IDligne_expedition FROM ligne_expedition WHERE IDexpedition = ${idExpedition} AND IDligne_commande_client = ${lcc}`)
  }
  const idLe = Number(le[0].IDligne_expedition)
  await query(`UPDATE stock_fini SET IDetat_stock_fini = 3, IDligne_expedition = ${idLe} WHERE IDstock_fini = ${Number(roll.IDstock_fini)}`)
  if (r.ml) {
    await ecrireMlNonFactures(Number(roll.IDstock_fini), { ml: r.ml, motif: r.motif ?? '' }, { idutilisateur: 0, nom: 'Seed dev' }, 'rouleau')
  }
  console.log(`  ${r.numero} → avis ${idExpedition}${r.ml ? ` (${r.ml} Ml non facturés)` : ''}`)
}

console.log(`\nAvis N°${idExpedition} prêt — Clients › Commandes › ${NUMERO_COMMANDE} › Expéditions, puis @ Envoyer.`)
await closeMpsPg()
process.exit(0)
