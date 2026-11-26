// Dev only: replays LIVA #1398 (order 3957) on mps_dev through the API routes, then removes everything
// it wrote. Needs the worktree's API up (default http://localhost:8082/api, or pass its URL).
//   npx tsx src/scripts/essai-tricotage-plusieurs-lignes.ts [http://localhost:808N/api]
//   … --garder            leaves the case ready to LOOK at in the screen: lines 1 and 2 with their yarn
//                         reserved (open « Tricoter chez … » on line 1), line 3 launched with 12 kg for the
//                         stock, line 4 with its yarn reserved (click the order in its Tricotage tab)
//   … --nettoyer <id>     removes a case kept that way (the client order id it printed)
//
// A · two client lines of 186A (two dyed coloris, one écru) reserve their yarn, ONE knitting order
//     is launched from the first with the second ticked: each keeps its share.
// B · a third line launches an order made big on purpose (« pour le stock »), a fourth line then
//     takes a share of it from the order (« Réservation — Commande N° … »): the yarn it held in
//     stock for that écru goes back free.
// C · the knitting orders are deleted: every line gets its yarn back, reserved in stock.
import '../load-env.js'
import { mpsPg, closeMpsPg } from '../lib/mps-pg.js'

const args = process.argv.slice(2)
const API = (args.find((a) => a.startsWith('http')) ?? 'http://localhost:8082/api').replace(/\/$/, '')
const garder = args.includes('--garder')
const aNettoyer = args.includes('--nettoyer') ? parseInt(args[args.indexOf('--nettoyer') + 1] ?? '', 10) : 0
const sql = mpsPg()
const [{ db }] = await sql<{ db: string }[]>`SELECT current_database() AS db`
if (db !== 'mps_dev') throw new Error(`refus : base ${db}, ce script ne tourne que sur mps_dev`)

const REF_FINI = 1471 // 186A
const MAGASIN = 1 // Tricotage Malterre
const coloris = (await sql<{ id: number }[]>`
  SELECT idref_fini_colori AS id FROM ref_fini_colori WHERE idref_fini = ${REF_FINI} ORDER BY 1 LIMIT 2`).map((r) => Number(r.id))
if (coloris.length < 2) throw new Error('il faut deux coloris teints sur la référence 186A')

const api = async (method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> => {
  const r = await fetch(`${API}${path}`, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, json: await r.json().catch(() => null) }
}
const ok = (cond: boolean, quoi: string, detail?: unknown) => {
  console.log(`  ${cond ? 'OK ' : 'KO '} ${quoi}${detail !== undefined ? ` : ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
  if (!cond) echecs++
}
let echecs = 0
const fmt = (x: number) => Math.round(x * 100) / 100

/** Removes a test order and all it wrote (its knitting orders through the API: their TRM mirrors go too). */
const nettoyer = async (C: number, lignes: number[], sst: number[]) => {
  for (const id of sst) await api('DELETE', `/commandes-sous-traitant/${id}`)
  await sql`DELETE FROM reservation_fil WHERE idligne_commande_client = ANY(${lignes})`
  await sql`DELETE FROM lancement_ligne_client WHERE idligne_commande_client = ANY(${lignes})`
  await sql`DELETE FROM ligne_commande_client WHERE idcommande_client = ${C}`
  await sql`DELETE FROM commande_client WHERE idcommande_client = ${C}`
}
if (aNettoyer > 0) {
  const [c] = await sql<{ ref: string | null }[]>`SELECT ref_client AS ref FROM commande_client WHERE idcommande_client = ${aNettoyer}`
  if (c?.ref !== 'ESSAI #1398') throw new Error(`la commande ${aNettoyer} n'est pas une commande d'essai`)
  const ls = (await sql<{ id: number }[]>`SELECT idligne_commande_client AS id FROM ligne_commande_client WHERE idcommande_client = ${aNettoyer}`).map((r) => Number(r.id))
  const ks = (await sql<{ id: number }[]>`
    SELECT DISTINCT l.idcommande_sous_traitant AS id FROM reservation_fil r
      JOIN ligne_commande_sous_traitant l ON l.idligne_commande_sous_traitant = r.idligne_commande_sous_traitant
     WHERE r.idligne_commande_client = ANY(${ls})`).map((r) => Number(r.id))
  await nettoyer(aNettoyer, ls, ks)
  console.log(`commande d'essai ${aNettoyer} retirée (${ks.length} commande(s) de tricotage)`)
  await closeMpsPg()
  process.exit(0)
}

const [client] = await sql<{ id: number }[]>`
  SELECT idclient AS id FROM commande_client WHERE idsociete = 1 AND donation = 0 ORDER BY idcommande_client DESC LIMIT 1`
const [{ numero }] = await sql<{ numero: number }[]>`SELECT COALESCE(MAX(numero), 0) + 9000 AS numero FROM commande_client WHERE idsociete = 1`
const [cmd] = await sql<{ id: number }[]>`
  INSERT INTO commande_client (idclient, idsociete, numero, date_commande, ref_client, validee_le, validee_par)
  VALUES (${client.id}, 1, ${numero}, CURRENT_DATE, 'ESSAI #1398', now(), 'essai')
  RETURNING idcommande_client AS id`
const C = Number(cmd.id)
const ligne = async (ml: number, col: number) => {
  const [l] = await sql<{ id: number }[]>`
    INSERT INTO ligne_commande_client (idcommande_client, quantite, prix, date_livraison, idcolori, unite, type, idreference)
    VALUES (${C}, ${ml}, 10, CURRENT_DATE + 45, ${col}, 3, 2, ${REF_FINI})
    RETURNING idligne_commande_client AS id`
  return Number(l.id)
}
const L1 = await ligne(158, coloris[0])
const L2 = await ligne(32, coloris[1])
const L3 = await ligne(40, coloris[0])
const L4 = await ligne(30, coloris[1])
const lignes = [L1, L2, L3, L4]
const sstCrees: number[] = []
console.log(`commande d'essai ${C} (N° ${numero}), lignes ${lignes.join(', ')}`)

/** Reserves the line's whole yarn need on the knitter's lots, the oldest first. */
const reserverTout = async (l: number) => {
  const { json } = await api('GET', `/commandes-client/${C}/lignes/${l}/fil`)
  for (const y of json?.yarns ?? []) {
    let reste = Number(y.manque_kg) || 0
    const lots = (y.lots ?? []).filter((x: any) => x.magasin_id === MAGASIN && x.dispo > 0).sort((a: any, b: any) => a.dispo - b.dispo)
    for (const x of lots) {
      if (!(reste > 0.005)) break
      const kg = fmt(Math.min(reste, x.dispo))
      const r = await api('PUT', `/commandes-client/${C}/lignes/${l}/fil/reservations/source`, { IDstock_fil: x.IDstock_fil, kg: fmt((Number(x.pour_ligne) || 0) + kg) })
      if (r.status !== 200) throw new Error(`réservation refusée (${r.status}) : ${JSON.stringify(r.json)}`)
      reste = fmt(reste - kg)
    }
    if (reste > 0.005) throw new Error(`pas assez de fil ${y.reference} chez le tricoteur en dev (manque ${reste} kg)`)
  }
}
const resas = (l: number) => sql<{ lot: number; kg: number; lsst: number }[]>`
  SELECT idstock_fil AS lot, quantite::float8 AS kg, idligne_commande_sous_traitant AS lsst
    FROM reservation_fil WHERE idligne_commande_client = ${l} AND liberee_le IS NULL ORDER BY id`
const tousLesLots = async (l: number) => {
  const { json } = await api('GET', `/commandes-client/${C}/lignes/${l}/supply/tricotage/new-order-context?magasin=${MAGASIN}`)
  return json
}

if (garder) {
  await reserverTout(L1)
  await reserverTout(L2)
  await reserverTout(L3)
  await reserverTout(L4)
  const c = await tousLesLots(L3)
  let min = Infinity
  for (const y of c.yarns) min = Math.min(min, (y.stock.reduce((s: number, x: any) => s + (Number(x.reserve_ligne) || 0), 0) / (y.pourcentage / 100)) * (1 - (y.freinte || 0)))
  const r = await api('POST', `/commandes-client/${C}/lignes/${L3}/supply/tricotage/orders`, {
    IDsous_traitant: MAGASIN, poids_affecte: Math.floor(min * 10) / 10, poids_stock: 12,
    lots: c.yarns.flatMap((y: any) => y.stock.filter((x: any) => x.poids > 0).map((x: any) => x.id)),
  })
  console.log(`gardée : /clients/commandes?commande=${C} (N° ${numero}), tricotage ${r.json?.IDcommande_sous_traitant ?? r.status}`)
  console.log(`à retirer par : npx tsx src/scripts/essai-tricotage-plusieurs-lignes.ts --nettoyer ${C}`)
  await closeMpsPg()
  process.exit(0)
}

try {
  console.log('\nA · une commande de tricotage pour deux lignes')
  await reserverTout(L1)
  await reserverTout(L2)
  const ctx = await tousLesLots(L1)
  const autre = (ctx?.autres_lignes ?? []).find((a: any) => a.ligneId === L2)
  ok(!!autre && autre.raison === null && autre.ecru_kg > 0, 'la ligne 2 est proposée dans « Tricoter aussi pour »', autre && { kg: autre.ecru_kg, meme_commande: autre.meme_commande })
  const couvert = (c: any) => {
    let min = Infinity
    for (const y of c.yarns) min = Math.min(min, (y.stock.reduce((s: number, x: any) => s + (Number(x.reserve_ligne) || 0), 0) / (y.pourcentage / 100)) * (1 - (y.freinte || 0)))
    return Math.floor(min * 10) / 10
  }
  const kg1 = couvert(ctx)
  const lotsA = ctx.yarns.flatMap((y: any) => y.stock.filter((x: any) => x.reserve_ligne > 0 || (autre?.lots ?? []).some((z: any) => z.id === x.id)).map((x: any) => x.id))
  const sans = await api('POST', `/commandes-client/${C}/lignes/${L1}/supply/tricotage/orders`, { IDsous_traitant: MAGASIN, poids_affecte: kg1, poids_stock: 0, lots: lotsA, autres_lignes: [L2, 999999999] })
  ok(sans.status === 409 && sans.json?.error === 'ligne_non_joignable', 'une ligne inconnue est refusée, rien n’est écrit', sans.json?.error)
  const cree = await api('POST', `/commandes-client/${C}/lignes/${L1}/supply/tricotage/orders`, { IDsous_traitant: MAGASIN, poids_affecte: kg1, poids_stock: 0, lots: lotsA, autres_lignes: [L2] })
  ok(cree.status === 201, 'la commande part', cree.status === 201 ? { commande: cree.json.IDcommande_sous_traitant } : cree.json)
  if (cree.status !== 201) throw new Error('lancement refusé')
  sstCrees.push(Number(cree.json.IDcommande_sous_traitant))
  const K1 = Number(cree.json.IDligne_commande_sous_traitant)
  const [k1] = await sql<{ q: number }[]>`SELECT quantite::float8 AS q FROM ligne_commande_sous_traitant WHERE idligne_commande_sous_traitant = ${K1}`
  ok(Math.abs(k1.q - (kg1 + autre.ecru_kg)) < 0.02, 'sa quantité = part de la ligne 1 + part de la ligne 2', { commande: k1.q, ligne1: kg1, ligne2: autre.ecru_kg })
  const partis = [...(await resas(L1)), ...(await resas(L2))]
  // (a line may also hold yarn in ANOTHER open order of the same écru: reserving on a lot takes what
  // such an order knits for the stock first. That yarn is not this launch's, so only the stock is checked.)
  ok(partis.every((r) => r.lsst !== 0) && partis.some((r) => r.lsst === K1), 'le fil que les deux lignes tenaient en stock est parti avec la commande', partis.filter((r) => r.lsst === 0))
  const s2 = await api('GET', `/commandes-client/${C}/lignes/${L2}/supply`)
  const row2 = (s2.json?.tricotage ?? []).find((r: any) => r.id === K1)
  ok(!!row2 && Math.abs(row2.poids_affecte - autre.ecru_kg) < 0.3, 'la ligne 2 lit sa part sur la commande', row2 && { part: row2.poids_affecte, pour_stock: row2.pour_stock })

  console.log('\nB · une commande faite grosse, une autre ligne y réserve')
  await reserverTout(L3)
  await reserverTout(L4)
  const ctx3 = await tousLesLots(L3)
  const kg3 = couvert(ctx3)
  const STOCK = 12
  // Free yarn for the stock part: every lot of the knitter may give.
  const lotsB = ctx3.yarns.flatMap((y: any) => y.stock.filter((x: any) => x.poids > 0).map((x: any) => x.id))
  const gros = await api('POST', `/commandes-client/${C}/lignes/${L3}/supply/tricotage/orders`, { IDsous_traitant: MAGASIN, poids_affecte: kg3, poids_stock: STOCK, lots: lotsB })
  ok(gros.status === 201, `commande lancée depuis la ligne 3 avec ${STOCK} kg pour le stock`, gros.status === 201 ? undefined : gros.json)
  if (gros.status !== 201) throw new Error('lancement refusé')
  sstCrees.push(Number(gros.json.IDcommande_sous_traitant))
  const K2 = Number(gros.json.IDligne_commande_sous_traitant)
  const url4 = `/commandes-client/${C}/lignes/${L4}/supply/tricotage/${K2}/affectation`
  const base = await api('PUT', url4, { poids_affecte: 0, apercu: true })
  ok(base.status === 200 && Math.abs(base.json.pour_stock - STOCK) < 0.05, 'la ligne 4 voit ce que la commande tricote pour le stock', base.json && { pour_stock: base.json.pour_stock, besoin: base.json.besoin, max: base.json.max })
  const avant4 = await resas(L4)
  const vu = await api('PUT', url4, { poids_affecte: 8, apercu: true })
  ok(vu.status === 200 && vu.json.fil.length > 0 && vu.json.liberes.length > 0, 'l’aperçu dit quel fil suit et quel fil en stock redevient libre', vu.json && { fil: vu.json.fil, liberes: vu.json.liberes })
  ok(JSON.stringify(await resas(L4)) === JSON.stringify(avant4), 'l’aperçu n’a rien écrit')
  const trop = await api('PUT', url4, { poids_affecte: STOCK + 5 })
  ok(trop.status === 409, 'au-delà du stock de la commande (ou du besoin) : refusé', trop.json?.error)
  const pris = await api('PUT', url4, { poids_affecte: 8 })
  ok(pris.status === 200 && Math.abs(pris.json.a - 8) < 0.01, 'la ligne 4 prend 8 kg de la commande', pris.json && { de: pris.json.de, a: pris.json.a })
  const apres4 = await resas(L4)
  ok(apres4.some((r) => r.lsst === K2), 'son fil est tenu dans la commande', apres4)
  const enStock = (rs: { kg: number; lsst: number }[]) => fmt(rs.filter((r) => r.lsst === 0).reduce((s, r) => s + r.kg, 0))
  ok(enStock(apres4) < enStock(avant4), 'et son fil en stock a baissé d’autant', { avant: enStock(avant4), apres: enStock(apres4) })
  const s3 = await api('GET', `/commandes-client/${C}/lignes/${L3}/supply`)
  const row3 = (s3.json?.tricotage ?? []).find((r: any) => r.id === K2)
  ok(!!row3 && Math.abs(row3.pour_stock - (STOCK - 8)) < 0.05 && row3.autres_reservations.length === 1, 'la ligne 3 voit la part de la ligne 4 et le stock qui reste', row3 && { pour_stock: row3.pour_stock, autres: row3.autres_reservations })
  const rendu = await api('PUT', url4, { poids_affecte: 0 })
  ok(rendu.status === 200 && (await resas(L4)).every((r) => r.lsst === 0), 'zéro libère la part')
  await api('PUT', url4, { poids_affecte: 8 })

  console.log('\nC · supprimer la commande rend le fil')
  const filAvant = fmt((await resas(L4)).reduce((s, r) => s + r.kg, 0))
  const del = await api('DELETE', `/commandes-sous-traitant/${sstCrees[1]}`)
  ok(del.status === 200, 'commande supprimée', del.status === 200 ? undefined : del.json)
  if (del.status === 200) sstCrees.pop()
  const r3 = await resas(L3)
  const r4 = await resas(L4)
  ok(r3.length > 0 && r3.every((r) => r.lsst === 0) && r4.every((r) => r.lsst === 0), 'le fil des lignes 3 et 4 est de nouveau réservé en stock')
  ok(Math.abs(fmt(r4.reduce((s, r) => s + r.kg, 0)) - filAvant) < 0.01, 'la ligne 4 tient autant de fil qu’avant', { avant: filAvant, apres: fmt(r4.reduce((s, r) => s + r.kg, 0)) })
  const [{ n }] = await sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM asso_fil_lignecmdsst WHERE idligne_commande_sous_traitant = ${K2}`
  ok(n === 0, 'plus aucun lot lié à la commande disparue')
} finally {
  // Everything the script wrote goes, whatever happened.
  await nettoyer(C, lignes, sstCrees)
  const [{ n }] = await sql<{ n: number }[]>`
    SELECT COUNT(*)::int AS n FROM reservation_fil r
     WHERE r.liberee_le IS NULL AND r.idligne_commande_sous_traitant > 0
       AND NOT EXISTS (SELECT 1 FROM ligne_commande_sous_traitant l WHERE l.idligne_commande_sous_traitant = r.idligne_commande_sous_traitant)`
  console.log(`\nnettoyé. Réservations pointant une commande disparue en base : ${n}`)
  await closeMpsPg()
}
console.log(echecs === 0 ? '\nTout est conforme.' : `\n${echecs} point(s) KO.`)
process.exit(echecs === 0 ? 0 : 1)
