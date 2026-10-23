// Dev only: walks a yarn reservation through its life on mps_dev, then removes everything it wrote.
//   npx tsx src/scripts/essai-reservation-fil.ts
// réserver 100 kg sur une ligne de commande fil → lot de 60 kg (bascule partielle) → tricotage de
// 90 kg refusé (fil pas couvert) → lot de 50 kg (le reste bascule) → tricotage lancé sur les deux lots
// (les réservations deviennent les lignes asso) → « Réservé ».
import '../load-env.js'
import { mpsPg, closeMpsPg } from '../lib/mps-pg.js'
import {
  reserverSurCommande, basculerSurLot, reservationsDesLignes, etatReservation, filAttenduParLigne,
} from '../lib/reservation-fil.js'
import { lotsLibres, planLancement, ecrireAffectation } from '../lib/lancement-tricotage.js'
import { calculerEtatFil } from '../lib/fil-etat.js'

const sql = mpsPg()
const [{ db }] = await sql<{ db: string }[]>`SELECT current_database() AS db`
if (db !== 'mps_dev') throw new Error(`refus : base ${db}, ce script ne tourne que sur mps_dev`)

const [ligneFil] = await sql<{ id: number; quantite: number; idref_fil: number; idcolori_fil: number; idfournisseur: number; etat: number }[]>`
  SELECT l.idref_fil_commande AS id, l.quantite::float8 AS quantite, l.idref_fil, l.idcolori_fil, c.idfournisseur, l.etat
    FROM ref_fil_commande l JOIN commande_fil c USING (idcommande_fil)
   WHERE l.quantite >= 200 AND l.idcolori_fil > 0
   ORDER BY l.idref_fil_commande DESC LIMIT 1`
const [ligneClient] = await sql<{ id: number }[]>`
  SELECT idligne_commande_client AS id FROM ligne_commande_client WHERE type = 2 ORDER BY idligne_commande_client DESC LIMIT 1`
const etatAvant = await sql<{ id: number; etat: number; cetat: number }[]>`
  SELECT l.idref_fil_commande AS id, l.etat, c.etat AS cetat FROM ref_fil_commande l JOIN commande_fil c USING (idcommande_fil) WHERE l.idref_fil_commande = ${ligneFil.id}`
// The test needs the order line open; restored at the end.
await sql`UPDATE ref_fil_commande SET etat = 0 WHERE idref_fil_commande = ${ligneFil.id}`
await sql`UPDATE commande_fil SET etat = 0 WHERE idcommande_fil = (SELECT idcommande_fil FROM ref_fil_commande WHERE idref_fil_commande = ${ligneFil.id})`
const lotsCrees: number[] = []
const SST = 999999001
const show = async (titre: string) => {
  const r = await reservationsDesLignes([ligneClient.id])
  console.log(`\n${titre}`)
  for (const x of r) console.log(`  #${x.id} ${etatReservation(x).padEnd(9)} ${x.quantite} kg lot=${x.idstock_fil} sst=${x.idligne_commande_sous_traitant} asso=${x.idasso_fil_lignecmdsst}`)
}
const creerLot = async (kg: number) => {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO stock_fil (idclient, idfournisseur, idref_fil, idcolori_fil, stock, stock_initial, lot, idmagasin, idref_fil_commande, date_entree)
    VALUES (1, ${ligneFil.idfournisseur}, ${ligneFil.idref_fil}, ${ligneFil.idcolori_fil}, ${kg}, ${kg}, ${'ESSAI' + Date.now() % 100000}, 1, ${ligneFil.id}, now())
    RETURNING idstock_fil AS id`
  lotsCrees.push(Number(row.id))
  return Number(row.id)
}

try {
  console.log(`ligne fil ${ligneFil.id} (${ligneFil.quantite} kg), ligne client ${ligneClient.id}`)
  await reserverSurCommande({ ligneClient: ligneClient.id, ligneCommandeFil: ligneFil.id, kg: 100, parId: 0, par: 'essai' })
  await show('1. réservé 100 kg sur la commande')
  console.log('  attente fil :', JSON.stringify([...(await filAttenduParLigne([ligneClient.id])).entries()]))
  const reserveAvant = (await calculerEtatFil(ligneFil.idref_fil, ligneFil.idcolori_fil)).besoin

  const lot1 = await creerLot(60)
  console.log('  bascule :', JSON.stringify(await basculerSurLot(ligneFil.id, lot1)))
  await show('2. lot de 60 kg reçu')

  const paires = [{ refFil: ligneFil.idref_fil, coloriFil: ligneFil.idcolori_fil, pourcentage: 100 }]
  const lancer = async () => planLancement({
    totalKg: 90, paires, choisis: lotsCrees,
    lots: await lotsLibres({ magasin: 1, paires, ligneClient: ligneClient.id }),
  })
  console.log('\n3. tricotage de 90 kg sur le lot de 60 kg :', JSON.stringify((await lancer()).manques), '→ refusé')

  const lot2 = await creerLot(50)
  console.log('  bascule :', JSON.stringify(await basculerSurLot(ligneFil.id, lot2)))
  await show('4. lot de 50 kg reçu')

  const plan = await lancer()
  if (!plan.ok) throw new Error('le lancement aurait dû passer')
  await ecrireAffectation({ sstLine: SST, ligneClient: ligneClient.id, entrees: plan.entrees })
  await show('5. tricotage de 90 kg lancé sur les deux lots')
  const asso = await sql`SELECT idstock_fil, quantite FROM asso_fil_lignecmdsst WHERE idligne_commande_sous_traitant = ${SST}`
  console.log('  asso du tricotage :', JSON.stringify(asso))
  const reserveApres = (await calculerEtatFil(ligneFil.idref_fil, ligneFil.idcolori_fil)).besoin
  console.log(`  « Réservé » du fil : avant ${reserveAvant} (dont 100 de la réservation), après ${reserveApres} (asso du tricotage fictif hors commande ouverte → non comptée, reste 10 kg réservés sur le lot de 50 kg)`)
} finally {
  await sql`DELETE FROM asso_fil_lignecmdsst WHERE idligne_commande_sous_traitant = ${SST}`
  await sql`DELETE FROM reservation_fil WHERE idligne_commande_client = ${ligneClient.id} AND cree_par = 'essai' OR idref_fil_commande = ${ligneFil.id} AND cree_par = 'essai'`
  if (lotsCrees.length) await sql`DELETE FROM stock_fil WHERE idstock_fil IN ${sql(lotsCrees)}`
  await sql`UPDATE ref_fil_commande SET etat = ${etatAvant[0].etat} WHERE idref_fil_commande = ${ligneFil.id}`
  await sql`UPDATE commande_fil SET etat = ${etatAvant[0].cetat} WHERE idcommande_fil = (SELECT idcommande_fil FROM ref_fil_commande WHERE idref_fil_commande = ${ligneFil.id})`
  console.log('\nnettoyé')
  await closeMpsPg()
  process.exit(0)
}
