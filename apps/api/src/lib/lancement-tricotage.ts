// A knitting order goes out WITH its yarn (decision Vincent 2026-10-23).
//
// Why: TRM must be able to start any order it receives. An order sent without yarn sat at TRM in
// « Fil à affecter » until someone at ETM picked lots, and the client-line launch put the whole need
// on the knitter's biggest lot, or on nothing at all when it had none — silently. Planning ahead is
// not a reason to send an order without its yarn: Malterre orders with a far délai and TRM plans
// its production from délais and load.
//
// So every launch names its lots: from the client line (Tricotage › Nouvelle commande) and on
// Sous-traitants › Tricotage (a new line at Tricotage Malterre). The order is refused (409
// `fil_non_couvert`) until every yarn of the composition is covered by lots chosen at the knitter.
// Yarn still on a supplier order does not count: the client line waits for it (« attente fil »,
// lib/reservation-fil.ts) and is launched once the lot is in.
//
// « Libre » on a lot = its stock minus what is already promised elsewhere:
//   - open OFs still to knit from it (asso_fil_of × what the OF has left to produce),
//   - affectations of open knitting lines no OF knits yet (asso_fil_lignecmdsst — once an OF
//     runs, the OF term above holds them, never both),
//   - yarn reserved on it for OTHER client lines (reservation_fil, state « lot »).
// The client line's own reservation stays inside its libre and is taken first.
//
// Yarn = écru ÷ (1 − freinte de tricotage of the écru, lib/freinte-tricotage.ts): a launch of
// 600 kg of écru at 3 % needs 618,56 kg of each 100 % yarn, and an open OF still needs what it
// has left to knit ÷ (1 − freinte). The lot's stock only moves by the knitted weight (TRM
// visitage), the freinte shows on it until it is archived — that is how it is measured.

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'
import { filPourEcru, ecruPourFil, freintesTricotage } from './freinte-tricotage.js'

const round2 = (x: number) => Math.round(x * 100) / 100

export interface PaireFil {
  refFil: number
  coloriFil: number
  /** share of the écru, 0..100 */
  pourcentage: number
}

export interface LotLibre {
  id: number
  refFil: number
  coloriFil: number
  lot: string
  /** YYYYMMDD or '' */
  dateEntree: string
  idRefFilCommande: number
  /** the knitter holding the lot (stock_fil.idmagasin) */
  magasin: number
  /** the yarn's supplier (stock_fil.idfournisseur) */
  fournisseur: number
  stock: number
  libre: number
  /** kg reserved on this lot for the client line launching (already inside `libre`) */
  reserveLigne: number
}

export interface EntreePlan {
  lot: number
  refFil: number
  coloriFil: number
  kg: number
}

export interface FilNonCouvert {
  refFil: number
  coloriFil: number
  besoin: number
  couvert: number
}

export interface PlanLancement {
  ok: boolean
  entrees: EntreePlan[]
  manques: FilNonCouvert[]
  /** chosen lots that are not in the composition, or not at this knitter */
  horsComposition: number[]
}

const cle = (rf: number, cf: number) => `${rf}:${cf}`

/** Order in which a yarn's lots serve a launch: the client line's own reservation first, then the
 *  oldest lot (FIFO, the « Affecter » rule of Sous-traitants › Tricotage), then by id. */
export function ordreDeService(a: LotLibre, b: LotLibre): number {
  return (b.reserveLigne > 0 ? 1 : 0) - (a.reserveLigne > 0 ? 1 : 0)
    || (a.dateEntree || '99999999').localeCompare(b.dateEntree || '99999999')
    || a.id - b.id
}

/** Pure: the asso rows a launch of `totalKg` of écru writes from the chosen lots, or what is
 *  missing. `freinte` = the écru's freinte de tricotage (0..1): the yarn covers écru ÷ (1 − f).
 *  `emporterReserve` (a launch from a client line, decision Vincent 2026-10-29): each yarn takes at
 *  least ALL that is reserved to the line on the chosen lots, its 5 % safety margin included: the
 *  margin is there for knitting defects, so it goes to the knitter, who gives back the écru it makes;
 *  none of it stays reserved at home doing nothing. */
export function planLancement(p: { totalKg: number; paires: readonly PaireFil[]; lots: readonly LotLibre[]; choisis: readonly number[]; freinte?: number; emporterReserve?: boolean }): PlanLancement {
  const choisis = new Set(p.choisis)
  const parCle = new Map<string, LotLibre[]>()
  for (const l of p.lots) {
    if (!choisis.has(l.id)) continue
    const arr = parCle.get(cle(l.refFil, l.coloriFil)) ?? []
    arr.push(l)
    parCle.set(cle(l.refFil, l.coloriFil), arr)
  }
  const cles = new Set(p.paires.map((x) => cle(x.refFil, x.coloriFil)))
  const connus = new Set(p.lots.filter((l) => cles.has(cle(l.refFil, l.coloriFil))).map((l) => l.id))
  const horsComposition = [...choisis].filter((id) => !connus.has(id))

  const entrees: EntreePlan[] = []
  const manques: FilNonCouvert[] = []
  for (const paire of p.paires) {
    const mesLots = parCle.get(cle(paire.refFil, paire.coloriFil)) ?? []
    const besoin = round2(filPourEcru(p.totalKg * (paire.pourcentage / 100), p.freinte ?? 0))
    if (!(besoin > 0)) continue
    const reserve = p.emporterReserve ? round2(mesLots.reduce((x, l) => x + l.reserveLigne, 0)) : 0
    let reste = Math.max(besoin, reserve)
    for (const l of [...mesLots].sort(ordreDeService)) {
      if (!(reste > 0.005)) break
      const kg = round2(Math.min(l.libre, reste))
      if (!(kg > 0)) continue
      entrees.push({ lot: l.id, refFil: l.refFil, coloriFil: l.coloriFil, kg })
      reste = round2(reste - kg)
    }
    if (reste > 0.005) manques.push({ refFil: paire.refFil, coloriFil: paire.coloriFil, besoin, couvert: round2(besoin - reste) })
  }
  return { ok: manques.length === 0 && horsComposition.length === 0 && p.paires.length > 0, entrees, manques, horsComposition }
}

/** Pure (decision Vincent 2026-10-28): a launch from a client line knits the line's part ONLY with
 *  the yarn reserved to it at that knitter — reserving and ordering are two gestures, and an order is
 *  possible only once the matter is reserved. What is knitted on top « pour le stock » may take free
 *  yarn. Returns the yarns whose reserved kg at the knitter do not cover the line's part (empty = ok);
 *  `affecteKg` = the écru knitted for the line. */
export function filNonReserve(p: { affecteKg: number; paires: readonly PaireFil[]; lots: readonly LotLibre[]; freinte?: number }): FilNonCouvert[] {
  const out: FilNonCouvert[] = []
  for (const paire of p.paires) {
    const besoin = round2(filPourEcru(p.affecteKg * (paire.pourcentage / 100), p.freinte ?? 0))
    if (!(besoin > 0)) continue
    const reserve = round2(p.lots
      .filter((l) => l.refFil === paire.refFil && l.coloriFil === paire.coloriFil)
      .reduce((s, l) => s + l.reserveLigne, 0))
    if (besoin > reserve + 0.05) out.push({ refFil: paire.refFil, coloriFil: paire.coloriFil, besoin, couvert: reserve })
  }
  return out
}

/** Pure: the écru the yarn reserved to the line at a knitter lets it knit (the scarcest yarn
 *  decides, after the freinte): the most a launch can give the line. */
export function ecruCouvertParReservation(p: { paires: readonly PaireFil[]; lots: readonly LotLibre[]; freinte?: number }): number {
  let min = Infinity
  for (const paire of p.paires) {
    if (!(paire.pourcentage > 0)) continue
    const reserve = p.lots
      .filter((l) => l.refFil === paire.refFil && l.coloriFil === paire.coloriFil)
      .reduce((s, l) => s + l.reserveLigne, 0)
    min = Math.min(min, reserve / (paire.pourcentage / 100))
  }
  return Number.isFinite(min) ? Math.max(0, Math.floor(ecruPourFil(min, p.freinte ?? 0) * 100) / 100) : 0
}

/** Pure: the lots a launch dialog ticks by default for a yarn — the same order as the plan, as
 *  many as the need takes. */
export function lotsParDefaut(lots: readonly LotLibre[], besoinKg: number): number[] {
  const out: number[] = []
  let reste = round2(besoinKg)
  for (const l of [...lots].sort(ordreDeService)) {
    if (!(reste > 0.005)) break
    if (!(l.libre > 0)) continue
    out.push(l.id)
    reste = round2(reste - l.libre)
  }
  return out
}

const ymd = (d: unknown): string => {
  if (d instanceof Date && !isNaN(d.getTime())) {
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  }
  const s = String(d ?? '').replace(/\D/g, '').slice(0, 8)
  return /^\d{8}$/.test(s) && s !== '00000000' ? s : ''
}

/** The yarn lots at a knitter for these pairs, with what is free on each (rules in the header).
 *  `ligneClient` = the client line launching (its own reservation is not « elsewhere »), 0 for a
 *  launch from Sous-traitants. */
export async function lotsLibres(p: { magasin: number | null; paires: readonly PaireFil[]; ligneClient: number }, sql: Sql = mpsPg()): Promise<LotLibre[]> {
  if (p.paires.length === 0) return []
  // magasin null = every knitter (the client line's Fil tab); a launch names its knitter.
  const params: unknown[] = []
  const conds = p.paires.map((x) => {
    params.push(x.refFil, x.coloriFil)
    return `(idref_fil = $${params.length - 1} AND idcolori_fil = $${params.length})`
  })
  let magasinSql = ''
  if (p.magasin !== null) {
    params.push(p.magasin)
    magasinSql = `idmagasin = $${params.length} AND `
  }
  const lots = await sql.unsafe<{ id: number; idref_fil: number; idcolori_fil: number; lot: string | null; date_entree: unknown; idref_fil_commande: number | null; idmagasin: number | null; idfournisseur: number | null; stock: number }[]>(
    `SELECT idstock_fil AS id, idref_fil, idcolori_fil, lot, date_entree, idref_fil_commande, idmagasin, idfournisseur, stock::float8 AS stock
       FROM stock_fil
      WHERE ${magasinSql}stock > 0 AND (${conds.join(' OR ')})
        AND (idclient IN (0, 1) OR gere_par_etm = 1)`, params as any[])
  if (lots.length === 0) return []
  const ids = lots.map((l) => Number(l.id))

  const [ofs, assos, resas] = await Promise.all([
    // What open OFs still have to knit, apportioned to each lot by the OF's composition (écru kg,
    // turned into yarn below with each écru's freinte).
    sql<{ lot: number; ecru: number; kg: number }[]>`
      SELECT a.idstock_fil AS lot, o.idref_ecru AS ecru,
             SUM(GREATEST(0, o.quantite - COALESCE(p.kg, 0)) * a.pourcentage / 100)::float8 AS kg
        FROM asso_fil_of a
        JOIN ordre_fabrication o ON o.idordre_fabrication = a.idordre_fabrication AND o.est_termine = 0
        LEFT JOIN (SELECT idordre_fabrication, SUM(poids) AS kg FROM stock_ecru GROUP BY idordre_fabrication) p
               ON p.idordre_fabrication = o.idordre_fabrication
       WHERE a.idstock_fil = ANY(${ids})
       GROUP BY a.idstock_fil, o.idref_ecru`,
    // Affectations of open knitting lines that no OF knits yet.
    sql<{ lot: number; kg: number }[]>`
      SELECT a.idstock_fil AS lot, SUM(a.quantite)::float8 AS kg
        FROM asso_fil_lignecmdsst a
        JOIN ligne_commande_sous_traitant l ON l.idligne_commande_sous_traitant = a.idligne_commande_sous_traitant
        JOIN commande_sous_traitant c ON c.idcommande_sous_traitant = l.idcommande_sous_traitant
       WHERE a.idstock_fil = ANY(${ids}) AND c.est_soldee = 0 AND COALESCE(l.sstatut, '') NOT LIKE 'Termin%'
         AND NOT EXISTS (
           SELECT 1 FROM ligne_commande_client m
             JOIN ordre_fabrication o ON o.idligne_commande_client = m.idligne_commande_client
            WHERE m.idligne_commande_etm = l.idligne_commande_sous_traitant)
       GROUP BY a.idstock_fil`,
    sql<{ lot: number; ligne: number; kg: number }[]>`
      SELECT idstock_fil AS lot, idligne_commande_client AS ligne, SUM(quantite)::float8 AS kg
        FROM reservation_fil
       WHERE idstock_fil = ANY(${ids}) AND liberee_le IS NULL AND idasso_fil_lignecmdsst = 0
       GROUP BY idstock_fil, idligne_commande_client`,
  ])
  const freintes = await freintesTricotage(ofs.map((r) => Number(r.ecru) || 0))
  const ofKg = new Map<number, number>()
  for (const r of ofs) {
    const kg = filPourEcru(Number(r.kg) || 0, freintes.get(Number(r.ecru))?.taux ?? 0)
    ofKg.set(Number(r.lot), (ofKg.get(Number(r.lot)) ?? 0) + kg)
  }
  const assoKg = new Map(assos.map((r) => [Number(r.lot), Number(r.kg) || 0]))
  const autres = new Map<number, number>()
  const miennes = new Map<number, number>()
  for (const r of resas) {
    const m = Number(r.ligne) === p.ligneClient && p.ligneClient > 0 ? miennes : autres
    m.set(Number(r.lot), (m.get(Number(r.lot)) ?? 0) + (Number(r.kg) || 0))
  }
  return lots.map((l) => {
    const id = Number(l.id)
    const stock = Number(l.stock) || 0
    const libre = round2(Math.max(0, stock - (ofKg.get(id) ?? 0) - (assoKg.get(id) ?? 0) - (autres.get(id) ?? 0)))
    return {
      id,
      refFil: Number(l.idref_fil),
      coloriFil: Number(l.idcolori_fil) || 0,
      lot: (l.lot ?? '').toString().trim(),
      dateEntree: ymd(l.date_entree),
      idRefFilCommande: Number(l.idref_fil_commande) || 0,
      magasin: Number(l.idmagasin) || 0,
      fournisseur: Number(l.idfournisseur) || 0,
      stock: round2(stock),
      libre,
      reserveLigne: round2(Math.min(libre, miennes.get(id) ?? 0)),
    }
  })
}

/** Writes the launch's asso rows; a client line's reservations on those lots are taken by the
 *  knitting order (« consommée », linked to the asso row), the kg it does not use stay reserved. */
export async function ecrireAffectation(p: { sstLine: number; ligneClient: number; entrees: readonly EntreePlan[] }): Promise<void> {
  const sql = mpsPg()
  await sql.begin(async (t) => {
    const tx = t as unknown as Sql
    for (const e of p.entrees) {
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO asso_fil_lignecmdsst (idstock_fil, idligne_commande_sous_traitant, quantite)
        VALUES (${e.lot}, ${p.sstLine}, ${e.kg}) RETURNING idasso_fil_lignecmdsst AS id`
      if (!(p.ligneClient > 0)) continue
      const resas = await tx<{ id: number; quantite: number }[]>`
        SELECT id, quantite::float8 AS quantite FROM reservation_fil
         WHERE idligne_commande_client = ${p.ligneClient} AND idstock_fil = ${e.lot}
           AND liberee_le IS NULL AND idasso_fil_lignecmdsst = 0
         ORDER BY id`
      let reste = e.kg
      for (const r of resas) {
        if (!(reste > 0.005)) break
        const pris = round2(Math.min(Number(r.quantite), reste))
        if (pris < Number(r.quantite)) {
          await tx`
            INSERT INTO reservation_fil (idligne_commande_client, idref_fil, idcolori_fil, quantite, idref_fil_commande,
                                         idstock_fil, cree_le, cree_par_id, cree_par)
            SELECT idligne_commande_client, idref_fil, idcolori_fil, ${round2(Number(r.quantite) - pris)}, idref_fil_commande,
                   idstock_fil, cree_le, cree_par_id, cree_par
              FROM reservation_fil WHERE id = ${Number(r.id)}`
        }
        await tx`UPDATE reservation_fil SET quantite = ${pris}, idligne_commande_sous_traitant = ${p.sstLine},
                                            idasso_fil_lignecmdsst = ${Number(row.id)}
                  WHERE id = ${Number(r.id)}`
        reste = round2(reste - pris)
      }
    }
  })
}

/** The 409 body when a launch is refused, with one sentence per yarn short of lots. */
export function messageFilNonCouvert(plan: PlanLancement, nom: (refFil: number, coloriFil: number) => string): string {
  const fmt = (x: number) => x.toLocaleString('fr-FR', { maximumFractionDigits: 1 })
  const parts = plan.manques.map((m) => m.couvert > 0
    ? `${nom(m.refFil, m.coloriFil)} : ${fmt(m.couvert)} kg choisis sur ${fmt(m.besoin)} kg`
    : `${nom(m.refFil, m.coloriFil)} : aucun lot choisi (${fmt(m.besoin)} kg)`)
  if (plan.horsComposition.length > 0) parts.push('un lot choisi ne correspond pas à la composition ou n’est pas chez ce tricoteur')
  return `Le fil n’est pas couvert : ${parts.join(' ; ')}. Une commande ne part chez le tricoteur qu’avec tout son fil.`
}

/** « 1/60 COTON PEIGNE BIO Z - ecru » per `refFil:coloriFil`, for the refusal message. */
export async function nomsFils(paires: readonly PaireFil[], sql: Sql = mpsPg()): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (paires.length === 0) return out
  const { ref, col } = await nomsCourts(paires, sql)
  for (const x of paires) {
    const c = col.get(x.coloriFil)
    out.set(cle(x.refFil, x.coloriFil), `${ref.get(x.refFil) || `fil ${x.refFil}`}${c ? ` - ${c}` : ''}`)
  }
  return out
}

export interface FilALancer {
  IDref_fil: number
  IDcolori_fil: number
  reference: string
  coloris: string
  pourcentage: number
  /** the écru's freinte de tricotage (0..1): the need of this yarn = écru × % ÷ (1 − freinte) */
  freinte: number
  /** the knitter's lots of this yarn, in the order they serve a launch */
  stock: {
    id: number
    lot: string
    fournisseur: string
    date_entree: string
    stock: number
    /** free kg (header rules) */
    poids: number
    reserve_ligne: number
  }[]
}

/** What a launch dialog shows: per yarn of the composition, the lots at the knitter. */
export async function filsALancer(p: { magasin: number; paires: readonly PaireFil[]; ligneClient: number; freinte?: number }): Promise<FilALancer[]> {
  if (p.paires.length === 0) return []
  const sql = mpsPg()
  const [lots, noms] = await Promise.all([lotsLibres(p, sql), nomsCourts(p.paires, sql)])
  const rfc = [...new Set(lots.map((l) => l.idRefFilCommande).filter((x) => x > 0))]
  const frs = new Map<number, string>()
  if (rfc.length > 0) {
    const rows = await sql<{ id: number; nom: string | null }[]>`
      SELECT l.idref_fil_commande AS id, f.nom
        FROM ref_fil_commande l
        JOIN commande_fil c ON c.idcommande_fil = l.idcommande_fil
        JOIN fournisseur f ON f.idfournisseur = c.idfournisseur
       WHERE l.idref_fil_commande = ANY(${rfc})`
    for (const r of rows) frs.set(Number(r.id), String(r.nom ?? '').trim())
  }
  return p.paires.map((x) => ({
    IDref_fil: x.refFil,
    IDcolori_fil: x.coloriFil,
    reference: noms.ref.get(x.refFil) || `#${x.refFil}`,
    coloris: noms.col.get(x.coloriFil) ?? '',
    pourcentage: x.pourcentage,
    freinte: p.freinte ?? 0,
    stock: lots
      .filter((l) => l.refFil === x.refFil && l.coloriFil === x.coloriFil)
      .sort(ordreDeService)
      .map((l) => ({
        id: l.id, lot: l.lot, fournisseur: frs.get(l.idRefFilCommande) ?? '', date_entree: l.dateEntree,
        stock: l.stock, poids: l.libre, reserve_ligne: l.reserveLigne,
      })),
  }))
}

async function nomsCourts(paires: readonly PaireFil[], sql: Sql) {
  const [refs, cols] = await Promise.all([
    sql<{ id: number; reference: string | null }[]>`
      SELECT idref_fil AS id, reference FROM ref_fil WHERE idref_fil = ANY(${paires.map((x) => x.refFil)})`,
    sql<{ id: number; reference: string | null }[]>`
      SELECT idcolori_fil AS id, reference FROM colori_fil WHERE idcolori_fil = ANY(${[0, ...paires.map((x) => x.coloriFil)]})`,
  ])
  return {
    ref: new Map(refs.map((r) => [Number(r.id), String(r.reference ?? '').trim()])),
    col: new Map(cols.map((r) => [Number(r.id), String(r.reference ?? '').trim()])),
  }
}

/** kg of écru the yarn affected to a knitting line covers (the scarcest yarn decides), or null
 *  when the line has no affectation at all (an old line still « Fil à affecter »). */
export async function couvertureLigne(sstLine: number, paires: readonly PaireFil[], freinte = 0, sql: Sql = mpsPg()): Promise<number | null> {
  const rows = await sql<{ ref: number; col: number; kg: number }[]>`
    SELECT s.idref_fil AS ref, s.idcolori_fil AS col, SUM(a.quantite)::float8 AS kg
      FROM asso_fil_lignecmdsst a JOIN stock_fil s ON s.idstock_fil = a.idstock_fil
     WHERE a.idligne_commande_sous_traitant = ${sstLine}
     GROUP BY s.idref_fil, s.idcolori_fil`
  if (rows.length === 0) return null
  const kg = new Map(rows.map((r) => [cle(Number(r.ref), Number(r.col)), Number(r.kg) || 0]))
  let min = Infinity
  for (const x of paires) {
    if (!(x.pourcentage > 0)) continue
    min = Math.min(min, (kg.get(cle(x.refFil, x.coloriFil)) ?? 0) / (x.pourcentage / 100))
  }
  // The écru that yarn makes, after the freinte de tricotage.
  return Number.isFinite(min) ? round2(ecruPourFil(min, freinte)) : 0
}

export interface PartLot {
  /** of = knitting now, commande = knitting order not started, client = reserved for a client line */
  kind: 'of' | 'commande' | 'client' | 'libre'
  kg: number
  details: { label: string; sub: string; kg: number }[]
}

/** Fils › Stock « Réservations » card: where a lot's stock is promised — the same three terms
 *  `lotsLibres()` subtracts, with who holds each kilo, then what is left. `exces` > 0 when the
 *  promises exceed the stock (an order will be short of this yarn). */
export async function repartitionLot(lotId: number): Promise<{ stock: number; parts: PartLot[]; exces: number }> {
  const sql = mpsPg()
  const [lot] = await sql<{ stock: number }[]>`SELECT stock::float8 AS stock FROM stock_fil WHERE idstock_fil = ${lotId}`
  if (!lot) return { stock: 0, parts: [], exces: 0 }
  const stock = round2(Number(lot.stock) || 0)

  const [ofs, assos, resas] = await Promise.all([
    sql<{ id: number; ecru: number; kg: number; numero: number | null }[]>`
      SELECT o.idordre_fabrication AS id, o.idref_ecru AS ecru,
             (GREATEST(0, o.quantite - COALESCE(p.kg, 0)) * a.pourcentage / 100)::float8 AS kg,
             cc.numero
        FROM asso_fil_of a
        JOIN ordre_fabrication o ON o.idordre_fabrication = a.idordre_fabrication AND o.est_termine = 0
        LEFT JOIN (SELECT idordre_fabrication, SUM(poids) AS kg FROM stock_ecru GROUP BY idordre_fabrication) p
               ON p.idordre_fabrication = o.idordre_fabrication
        LEFT JOIN ligne_commande_client lc ON lc.idligne_commande_client = o.idligne_commande_client
        LEFT JOIN commande_client cc ON cc.idcommande_client = lc.idcommande_client
       WHERE a.idstock_fil = ${lotId}
       ORDER BY o.idordre_fabrication`,
    sql<{ cmd: number; ligne: number; kg: number }[]>`
      SELECT l.idcommande_sous_traitant AS cmd, l.idligne_commande_sous_traitant AS ligne, SUM(a.quantite)::float8 AS kg
        FROM asso_fil_lignecmdsst a
        JOIN ligne_commande_sous_traitant l ON l.idligne_commande_sous_traitant = a.idligne_commande_sous_traitant
        JOIN commande_sous_traitant c ON c.idcommande_sous_traitant = l.idcommande_sous_traitant
       WHERE a.idstock_fil = ${lotId} AND c.est_soldee = 0 AND COALESCE(l.sstatut, '') NOT LIKE 'Termin%'
         AND NOT EXISTS (
           SELECT 1 FROM ligne_commande_client m
             JOIN ordre_fabrication o ON o.idligne_commande_client = m.idligne_commande_client
            WHERE m.idligne_commande_etm = l.idligne_commande_sous_traitant)
       GROUP BY l.idcommande_sous_traitant, l.idligne_commande_sous_traitant
       ORDER BY l.idcommande_sous_traitant`,
    sql<{ numero: number; client: string | null; kg: number }[]>`
      SELECT cc.numero, cl.nom AS client, SUM(r.quantite)::float8 AS kg
        FROM reservation_fil r
        JOIN ligne_commande_client lc ON lc.idligne_commande_client = r.idligne_commande_client
        JOIN commande_client cc ON cc.idcommande_client = lc.idcommande_client
        LEFT JOIN client cl ON cl.idclient = cc.idclient
       WHERE r.idstock_fil = ${lotId} AND r.liberee_le IS NULL AND r.idasso_fil_lignecmdsst = 0
       GROUP BY cc.numero, cl.nom
       ORDER BY cc.numero`,
  ])

  // An OF's remaining écru → the yarn it still takes (freinte de tricotage), as lotsLibres() counts it.
  const freintes = await freintesTricotage(ofs.map((o) => Number(o.ecru) || 0))
  for (const o of ofs) o.kg = filPourEcru(Number(o.kg) || 0, freintes.get(Number(o.ecru))?.taux ?? 0)

  // Who a knitting order not started yet is for (« Affecté à la commande … » of its launch).
  const lignes = assos.map((a) => Number(a.ligne))
  const pour = new Map<number, string[]>()
  if (lignes.length > 0) {
    const rows = await sql<{ ligne: number; numero: number; client: string | null }[]>`
      SELECT t.idligne_commande_sous_traitant AS ligne, cc.numero, cl.nom AS client
        FROM affectation_cmd_tricotage t
        JOIN ligne_commande_client lc ON lc.idligne_commande_client = t.idligne_commande_client
        JOIN commande_client cc ON cc.idcommande_client = lc.idcommande_client
        LEFT JOIN client cl ON cl.idclient = cc.idclient
       WHERE t.idligne_commande_sous_traitant = ANY(${lignes}) AND t.poids_affecte > 0`
    for (const r of rows) {
      const arr = pour.get(Number(r.ligne)) ?? []
      arr.push(`${String(r.client ?? '').trim() || 'client'} (cde ${r.numero})`)
      pour.set(Number(r.ligne), arr)
    }
  }

  const fmt = (n: number) => round2(Number(n) || 0)
  const parts: PartLot[] = [
    {
      kind: 'of',
      kg: 0,
      details: ofs.filter((o) => Number(o.kg) > 0.005).map((o) => ({
        label: `OF ${o.id}`, sub: o.numero ? `commande TRM ${o.numero}` : '', kg: fmt(o.kg),
      })),
    },
    {
      kind: 'commande',
      kg: 0,
      details: assos.map((a) => ({
        label: `Commande de tricotage ${a.cmd}`,
        sub: pour.get(Number(a.ligne))?.length ? `pour ${pour.get(Number(a.ligne))!.join(', ')}` : 'pour le stock',
        kg: fmt(a.kg),
      })),
    },
    {
      kind: 'client',
      kg: 0,
      details: resas.map((r) => ({ label: `Commande ${r.numero}`, sub: String(r.client ?? '').trim(), kg: fmt(r.kg) })),
    },
  ]
  for (const p of parts) p.kg = round2(p.details.reduce((s, d) => s + d.kg, 0))
  const promis = round2(parts.reduce((s, p) => s + p.kg, 0))
  parts.push({ kind: 'libre', kg: round2(Math.max(0, stock - promis)), details: [] })
  return { stock, parts: parts.filter((p) => p.kg > 0.005), exces: round2(Math.max(0, promis - stock)) }
}
