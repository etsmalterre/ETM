// What a knitting order still holds of a yarn lot, and for whom it knits (Vincent 2026-11-13).
//
// Why: the same yarn was held by three records that did not know each other. Order 9147 (2 645 kg
// of 029): `asso_fil_lignecmdsst` said 2 752 kg of lot 10568 « affectés » — the plan written the day
// the yarn was affected, never lowered, removable only whole and never once a roll exists — while
// the lot held 1 690 kg; the client lines' shares of the order showed nowhere on the order; and 17
// of its pieces (335 kg) had gone to another client order without anyone seeing that the lines
// counting on the whole 2 645 kg would be short. Meanwhile 100 kg for an order of another écru
// could not be taken from the lot, though the lines it served were due three months later.
//
// A knitting order is work on yarn, not a stock. So:
//   - the link lot → knitting line (the asso row) says WHICH lot feeds the order, never how many kg:
//     what the order holds of the lot is what it still has to knit, in yarn —
//     (quantity − knitted) × the yarn's share ÷ (1 − freinte), spread over its lots. The asso
//     `quantite` only weighs that spread when the order draws a yarn from several lots (the open
//     OFs' own lots weigh it first, once TRM has planned them);
//   - who the order knits for is read: the pieces already delivered by their reservation, what is
//     still to come by the client lines' shares — the yarn reserved to each line that the order
//     holds (lib/parts-tricotage.ts: a share is never typed on an order knitting our yarn) —, the
//     rest « Stock ». More promised than the order will still bring = `surPromesse`;
//   - a client line of the order's own écru takes yarn the order holds (`fixerFilEnTricotage`):
//     what it knits for the stock first; beyond, another line's share, and the person validates
//     who loses what before anything is written;
//   - yarn engaged in a knitting order of ANOTHER écru can be taken for a client line: the order
//     gives it back by knitting less (`planArbitrage`: its stock part first, then the client lines
//     with the latest délai), validated the same way.
//
// Yarn and écru convert both ways with the knitting order's own écru: its yarn share and its
// freinte de tricotage (lib/freinte-tricotage.ts).

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'
import { filPourEcru, ecruPourFil, freintesTricotage } from './freinte-tricotage.js'
import { allocationsParLigneTricot, repartir, reserverPiecesTricotees, type AllocationRepartition } from './repartition-tricotage.js'

const round2 = (x: number) => Math.round(x * 100) / 100
const num = (v: unknown) => Number(v) || 0
const EPS = 0.005

export interface PaireTricotage {
  refFil: number
  coloriFil: number
  /** share of the écru, 0..100 */
  pourcentage: number
}

export interface LotTricotage {
  lot: number
  refFil: number
  coloriFil: number
  /** the asso row's kg: the plan of the day the yarn was affected (a weight, never a holding) */
  plan: number
  /** yarn the order's open OFs still draw from this lot (écru kg × share), 0 without an OF */
  of: number
  /** the asso row tying the lot to the line (0 when only an OF draws on it) */
  asso: number
}

export interface PieceTricotage {
  id: number
  poids: number
  /** client line it is reserved to, 0 = none */
  lcc: number
  /** it is ETM's (TRM shipped it, or an outside knitter's roll was received): it carries the sst line */
  livree: boolean
  /** given away (IDcommande_donation) */
  don: boolean
}

export interface LigneTricotage {
  /** IDligne_commande_sous_traitant */
  id: number
  commande: number
  ecru: number
  coloris: number
  /** kg of écru ordered */
  quantite: number
  /** kg knitted, delivered or still at the knitter */
  tricote: number
  /** kg still to knit */
  reste: number
  /** not done, on an order not soldée */
  ouverte: boolean
  freinte: number
  paires: PaireTricotage[]
  lots: LotTricotage[]
  pieces: PieceTricotage[]
  /** every OF knitting it at TRM (the mirror line's) */
  ofs: number[]
}

// ── Pure rules ──────────────────────────────────────────────

/** Yarn kg of each lot the knitting line still needs: what it has left to knit, per yarn of its
 *  écru, spread over the lots feeding it (OF plan first, else the asso plan, else evenly). */
export function engagementParLot(k: Pick<LigneTricotage, 'reste' | 'freinte' | 'paires' | 'lots'>): Map<number, number> {
  const out = new Map<number, number>()
  if (!(k.reste > EPS)) return out
  for (const p of k.paires) {
    const besoin = filPourEcru(k.reste * (p.pourcentage / 100), k.freinte)
    const lots = k.lots.filter((l) => l.refFil === p.refFil && l.coloriFil === p.coloriFil)
    if (!(besoin > EPS) || lots.length === 0) continue
    const parOf = lots.reduce((s, l) => s + Math.max(0, l.of), 0)
    const parPlan = lots.reduce((s, l) => s + Math.max(0, l.plan), 0)
    const poids = (l: LotTricotage) => (parOf > EPS ? Math.max(0, l.of) / parOf : parPlan > EPS ? Math.max(0, l.plan) / parPlan : 1 / lots.length)
    for (const l of lots) {
      const kg = round2(besoin * poids(l))
      if (kg > 0) out.set(l.lot, round2((out.get(l.lot) ?? 0) + kg))
    }
  }
  return out
}

export interface PartTricotage {
  /** IDligne_commande_client */
  lcc: number
  /** écru kg the line reserved on the order */
  reserve: number
  /** kg of the order's pieces it holds (delivered and reserved to it, or free and due to it) */
  recu: number
  /** still to come to it */
  reste: number
  toute: boolean
  delai: string
}

export interface RepartitionTricotage {
  /** knitted, still at the knitter */
  chezTricoteur: number
  /** what the order will still bring to ETM: still to knit + at the knitter */
  aVenir: number
  parts: PartTricotage[]
  /** delivered pieces held without a share of the order: another client line, or a donation (lcc 0) */
  autres: { lcc: number; don: boolean; recu: number }[]
  /** what nobody claims: delivered and free, and what is still to come beyond the lines' shares */
  stock: { recu: number; aVenir: number }
  /** kg promised to client lines beyond what the order will still bring (0 = none) */
  surPromesse: number
}

/** Pure: who a knitting line knits for. `allocations` = the client lines' shares (écru kg). */
export function lireRepartition(p: {
  quantite: number
  pieces: readonly PieceTricotage[]
  allocations: readonly AllocationRepartition[]
}): RepartitionTricotage {
  const tricote = p.pieces.reduce((s, x) => s + x.poids, 0)
  const livrees = p.pieces.filter((x) => x.livree)
  const chezTricoteur = round2(tricote - livrees.reduce((s, x) => s + x.poids, 0))
  const aVenir = round2(Math.max(0, p.quantite - tricote) + chezTricoteur)

  // A donated piece is nobody's to hand out: it counts as held elsewhere (lcc −1 for the split).
  const pourSplit = livrees.map((x) => ({ id: x.id, poids: x.poids, lcc: x.don ? -1 : x.lcc }))
  const { attribution, tenu } = repartir(p.allocations, pourSplit)
  const parts: PartTricotage[] = []
  const vues = new Set<number>()
  for (const a of p.allocations) {
    if (!(a.lcc > 0) || !(a.poids > 0) || vues.has(a.lcc)) continue
    vues.add(a.lcc)
    const reserve = round2(p.allocations.filter((x) => x.lcc === a.lcc).reduce((s, x) => s + Math.max(0, x.poids), 0))
    const recu = round2(tenu.get(a.lcc) ?? 0)
    parts.push({
      lcc: a.lcc, reserve, recu, reste: round2(Math.max(0, reserve - recu)),
      toute: p.allocations.some((x) => x.lcc === a.lcc && x.toute), delai: a.delai,
    })
  }
  parts.sort((x, y) => (x.delai || '99999999').localeCompare(y.delai || '99999999') || x.lcc - y.lcc)

  const autresKg = new Map<string, { lcc: number; don: boolean; recu: number }>()
  let stockRecu = 0
  for (const x of livrees) {
    if (x.don) {
      const e = autresKg.get('don') ?? { lcc: 0, don: true, recu: 0 }
      e.recu += x.poids
      autresKg.set('don', e)
    } else if (x.lcc > 0 && !vues.has(x.lcc)) {
      const e = autresKg.get(String(x.lcc)) ?? { lcc: x.lcc, don: false, recu: 0 }
      e.recu += x.poids
      autresKg.set(String(x.lcc), e)
    } else if (x.lcc === 0 && !attribution.has(x.id)) {
      stockRecu += x.poids
    }
  }
  const promis = parts.reduce((s, x) => s + x.reste, 0)
  // Under half a kilo is the last piece's weight, not a promise in excess.
  const exces = promis - aVenir
  return {
    chezTricoteur,
    aVenir,
    parts,
    autres: [...autresKg.values()].map((e) => ({ ...e, recu: round2(e.recu) })).sort((x, y) => x.lcc - y.lcc),
    stock: { recu: round2(stockRecu), aVenir: round2(Math.max(0, aVenir - promis)) },
    surPromesse: exces > 0.5 ? round2(exces) : 0,
  }
}

export interface CibleArbitrage {
  /** the knitting line holding yarn of the lot */
  lsst: number
  commande: number
  quantite: number
  /** écru kg still to knit */
  reste: number
  /** share of the lot's yarn in the knitting line's écru, 0..100 */
  pct: number
  freinte: number
  /** yarn kg of the lot the line still needs */
  engage: number
  /** écru kg still to come that no client line claims */
  stockAVenir: number
  /** the client lines' shares still to come */
  parts: { lcc: number; delai: string; reste: number }[]
  /** the yarn stays in the order, for another client line of its écru: it knits as much */
  garde?: boolean
}

export interface EffetArbitrage {
  lsst: number
  commande: number
  deQuantite: number
  aQuantite: number
  /** yarn kg of the lot the order gives back */
  fil: number
  /** écru kg taken from what was knitted for the stock */
  stock: number
  /** écru kg each client line loses on this knitting order */
  lignes: { lcc: number; perd: number }[]
  /** the order keeps its quantity: only the shares move */
  interne: boolean
}

/** Pure: how `kg` of a lot's yarn are taken back from the knitting orders holding it. Each order
 *  knits less; what it knitted for the stock goes first (every order's), then the client lines'
 *  shares, the latest délai first (no délai = not promised: before any date). Never below what is
 *  already knitted. `ok` false = the orders cannot give that much (`libere` says how much they can). */
export function planArbitrage(kg: number, cibles: readonly CibleArbitrage[]): { ok: boolean; libere: number; effets: EffetArbitrage[] } {
  const ecruDe = (c: CibleArbitrage, fil: number) => (c.pct > 0 ? ecruPourFil(fil / (c.pct / 100), c.freinte) : 0)
  const filDe = (c: CibleArbitrage, ecru: number) => filPourEcru(ecru * (c.pct / 100), c.freinte)
  // An order gives back at most what it still has to knit, and no more yarn than it holds of the lot.
  const max = new Map(cibles.map((c) => [c.lsst, Math.max(0, Math.min(c.reste, ecruDe(c, c.engage)))]))
  const pris = new Map<number, { stock: number; lignes: Map<number, number> }>(cibles.map((c) => [c.lsst, { stock: 0, lignes: new Map() }]))
  let reste = kg

  const prendre = (c: CibleArbitrage, cap: number): number => {
    const deja = pris.get(c.lsst)!
    const dejaEcru = deja.stock + [...deja.lignes.values()].reduce((s, x) => s + x, 0)
    const dispo = Math.min(cap, (max.get(c.lsst) ?? 0) - dejaEcru)
    if (!(dispo > EPS) || !(reste > EPS) || !(c.pct > 0)) return 0
    // Rounded up to the centikilo of écru, so the yarn given back covers what is asked.
    const voulu = Math.ceil(ecruDe(c, reste) * 100 - 1e-6) / 100
    const ecru = Math.min(dispo, voulu)
    reste = Math.max(0, reste - filDe(c, ecru))
    return ecru
  }

  for (const c of [...cibles].sort((a, b) => b.stockAVenir - a.stockAVenir)) {
    pris.get(c.lsst)!.stock += prendre(c, c.stockAVenir)
  }
  const lignes = cibles.flatMap((c) => c.parts.map((p) => ({ c, p })))
    .sort((a, b) => (b.p.delai || '99999999').localeCompare(a.p.delai || '99999999') || b.p.lcc - a.p.lcc)
  for (const { c, p } of lignes) {
    const e = prendre(c, p.reste)
    if (e > 0) pris.get(c.lsst)!.lignes.set(p.lcc, (pris.get(c.lsst)!.lignes.get(p.lcc) ?? 0) + e)
  }

  const effets: EffetArbitrage[] = []
  for (const c of cibles) {
    const x = pris.get(c.lsst)!
    const ecru = x.stock + [...x.lignes.values()].reduce((s, v) => s + v, 0)
    if (!(ecru > EPS)) continue
    effets.push({
      lsst: c.lsst,
      commande: c.commande,
      deQuantite: round2(c.quantite),
      aQuantite: c.garde ? round2(c.quantite) : round2(c.quantite - ecru),
      fil: round2(filDe(c, ecru)),
      stock: round2(x.stock),
      lignes: [...x.lignes].map(([lcc, perd]) => ({ lcc, perd: round2(perd) })),
      interne: !!c.garde,
    })
  }
  return { ok: !(reste > EPS), libere: round2(kg - reste), effets }
}

// ── Reads ───────────────────────────────────────────────────

/** Knitting lines with what they have knitted and the lots feeding them: the ones named, or every
 *  OPEN one drawing on these lots (by its asso rows or by its OFs). */
export async function lignesTricotage(filtre: { lots?: readonly number[]; lignes?: readonly number[] }, sql: Sql = mpsPg()): Promise<LigneTricotage[]> {
  let ids = [...new Set((filtre.lignes ?? []).filter((x) => x > 0))]
  const lots = [...new Set((filtre.lots ?? []).filter((x) => x > 0))]
  if (lots.length > 0) {
    const rows = await sql<{ k: number }[]>`
      SELECT idligne_commande_sous_traitant AS k FROM asso_fil_lignecmdsst WHERE idstock_fil = ANY(${lots})
      UNION
      SELECT m.idligne_commande_etm FROM asso_fil_of a
        JOIN ordre_fabrication o ON o.idordre_fabrication = a.idordre_fabrication AND o.est_termine = 0
        JOIN ligne_commande_client m ON m.idligne_commande_client = o.idligne_commande_client
       WHERE a.idstock_fil = ANY(${lots}) AND m.idligne_commande_etm > 0`
    ids = [...new Set([...ids, ...rows.map((r) => num(r.k))])].filter((x) => x > 0)
  }
  if (ids.length === 0) return []

  const lignes = await sql<{ id: number; commande: number; ecru: number; coloris: number; quantite: number; sstatut: string | null; soldee: number | null }[]>`
    SELECT l.idligne_commande_sous_traitant AS id, l.idcommande_sous_traitant AS commande, l.idreference AS ecru,
           l.idcoloris AS coloris, l.quantite::float8 AS quantite, l.sstatut, c.est_soldee AS soldee
      FROM ligne_commande_sous_traitant l
      JOIN commande_sous_traitant c ON c.idcommande_sous_traitant = l.idcommande_sous_traitant
     WHERE l.idligne_commande_sous_traitant = ANY(${ids}) AND l.type = 1`
  const ouverte = (l: { sstatut: string | null; soldee: number | null }) =>
    num(l.soldee) !== 1 && !String(l.sstatut ?? '').startsWith('Termin')
  // From lots, only the open lines hold anything; a line asked by name is read whatever its state.
  const gardees = lignes.filter((l) => (filtre.lignes ?? []).includes(num(l.id)) || ouverte(l))
  if (gardees.length === 0) return []
  const ks = gardees.map((l) => num(l.id))
  const ecrus = [...new Set(gardees.map((l) => num(l.ecru)).filter((x) => x > 0))]

  const [compo, assos, ofs, freintes] = await Promise.all([
    sql<{ ecru: number; coloris: number; ref: number; col: number; pct: number }[]>`
      SELECT DISTINCT idref_ecru AS ecru, idcolori_ecru AS coloris, idref_fil AS ref, idcolori_fil AS col, pourcentage::float8 AS pct
        FROM composition_ecru WHERE idref_ecru = ANY(${[0, ...ecrus]}) AND idcolori_ecru > 0 AND idref_fil > 0 AND pourcentage > 0`,
    sql<{ k: number; lot: number; kg: number; ref: number; col: number; asso: number }[]>`
      SELECT a.idligne_commande_sous_traitant AS k, a.idstock_fil AS lot, SUM(a.quantite)::float8 AS kg,
             s.idref_fil AS ref, s.idcolori_fil AS col, MIN(a.idasso_fil_lignecmdsst) AS asso
        FROM asso_fil_lignecmdsst a JOIN stock_fil s ON s.idstock_fil = a.idstock_fil
       WHERE a.idligne_commande_sous_traitant = ANY(${ks})
       GROUP BY a.idligne_commande_sous_traitant, a.idstock_fil, s.idref_fil, s.idcolori_fil`,
    sql<{ of: number; k: number; quantite: number; termine: number | null }[]>`
      SELECT o.idordre_fabrication AS of, m.idligne_commande_etm AS k, o.quantite::float8 AS quantite, o.est_termine AS termine
        FROM ligne_commande_client m
        JOIN ordre_fabrication o ON o.idligne_commande_client = m.idligne_commande_client
       WHERE m.idligne_commande_etm = ANY(${ks})`,
    freintesTricotage(ecrus),
  ])
  const ofIds = ofs.map((o) => num(o.of))
  const kDeOf = new Map(ofs.map((o) => [num(o.of), num(o.k)]))
  const [pieces, lotsOf] = await Promise.all([
    sql<{ id: number; of: number | null; src: number | null; poids: number | null; lcc: number | null; don: number | null }[]>`
      SELECT idstock_ecru AS id, idordre_fabrication AS of, idref_commande_source AS src, poids::float8 AS poids,
             idligne_commande_client AS lcc, idcommande_donation AS don
        FROM stock_ecru
       WHERE idref_commande_source = ANY(${ks}) OR idordre_fabrication = ANY(${[0, ...ofIds]})`,
    sql<{ of: number; lot: number; pct: number; ref: number; col: number }[]>`
      SELECT a.idordre_fabrication AS of, a.idstock_fil AS lot, a.pourcentage::float8 AS pct, s.idref_fil AS ref, s.idcolori_fil AS col
        FROM asso_fil_of a JOIN stock_fil s ON s.idstock_fil = a.idstock_fil
       WHERE a.idordre_fabrication = ANY(${[0, ...ofIds]}) AND a.idstock_fil > 0`,
  ])

  const tricoteOf = new Map<number, number>()
  const piecesDe = new Map<number, PieceTricotage[]>()
  const set = new Set(ks)
  for (const p of pieces) {
    const of = num(p.of)
    const src = num(p.src)
    // A TRM piece carries the sst line only once shipped: before, its OF says which order knitted it.
    const k = (of > 0 ? kDeOf.get(of) : undefined) ?? (set.has(src) ? src : 0)
    if (!(k > 0)) continue
    if (of > 0) tricoteOf.set(of, (tricoteOf.get(of) ?? 0) + num(p.poids))
    const arr = piecesDe.get(k) ?? []
    arr.push({ id: num(p.id), poids: num(p.poids), lcc: num(p.lcc), livree: src === k, don: num(p.don) > 0 })
    piecesDe.set(k, arr)
  }
  const resteOf = new Map(ofs.filter((o) => num(o.termine) !== 1).map((o) => [num(o.of), Math.max(0, num(o.quantite) - (tricoteOf.get(num(o.of)) ?? 0))]))

  return gardees.map((l) => {
    const id = num(l.id)
    const mesPieces = (piecesDe.get(id) ?? []).sort((a, b) => a.id - b.id)
    const tricote = round2(mesPieces.reduce((s, p) => s + p.poids, 0))
    const lotsK = new Map<number, LotTricotage>()
    for (const a of assos) {
      if (num(a.k) !== id) continue
      lotsK.set(num(a.lot), { lot: num(a.lot), refFil: num(a.ref), coloriFil: num(a.col), plan: num(a.kg), of: 0, asso: num(a.asso) })
    }
    for (const a of lotsOf) {
      if (kDeOf.get(num(a.of)) !== id || !resteOf.has(num(a.of))) continue
      const e = lotsK.get(num(a.lot)) ?? { lot: num(a.lot), refFil: num(a.ref), coloriFil: num(a.col), plan: 0, of: 0, asso: 0 }
      e.of += (resteOf.get(num(a.of)) ?? 0) * (num(a.pct) / 100)
      lotsK.set(num(a.lot), e)
    }
    return {
      id,
      commande: num(l.commande),
      ecru: num(l.ecru),
      coloris: num(l.coloris),
      quantite: round2(num(l.quantite)),
      tricote,
      reste: round2(Math.max(0, num(l.quantite) - tricote)),
      ouverte: ouverte(l),
      freinte: freintes.get(num(l.ecru))?.taux ?? 0,
      paires: compo.filter((c) => num(c.ecru) === num(l.ecru) && num(c.coloris) === num(l.coloris))
        .map((c) => ({ refFil: num(c.ref), coloriFil: num(c.col), pourcentage: num(c.pct) })),
      lots: [...lotsK.values()],
      pieces: mesPieces,
      ofs: ofs.filter((o) => num(o.k) === id).map((o) => num(o.of)),
    }
  })
}

export interface LectureTricotage extends RepartitionTricotage {
  ligne: LigneTricotage
  /** yarn kg of each lot the line still needs */
  engagement: Map<number, number>
}

/** One knitting line read whole: what it holds of each lot and who it knits for. */
export async function lectureTricotage(lsst: number, sql: Sql = mpsPg()): Promise<LectureTricotage | null> {
  const [ligne] = await lignesTricotage({ lignes: [lsst] }, sql)
  if (!ligne) return null
  const allocations = (await allocationsParLigneTricot([lsst])).get(lsst) ?? []
  return {
    ligne,
    engagement: ligne.ouverte ? engagementParLot(ligne) : new Map(),
    ...lireRepartition({ quantite: ligne.quantite, pieces: ligne.pieces, allocations }),
  }
}

export interface CibleLot extends CibleArbitrage {
  ecru: number
  coloris: number
}

/** The open knitting lines holding yarn of a lot, each with what it can give back. */
export async function ciblesDuLot(lot: number, sql: Sql = mpsPg()): Promise<CibleLot[]> {
  const [l] = await sql<{ ref: number; col: number }[]>`
    SELECT idref_fil AS ref, idcolori_fil AS col FROM stock_fil WHERE idstock_fil = ${lot}`
  if (!l) return []
  const lignes = (await lignesTricotage({ lots: [lot] }, sql)).filter((k) => k.ouverte)
  if (lignes.length === 0) return []
  const allocs = await allocationsParLigneTricot(lignes.map((k) => k.id))
  const out: CibleLot[] = []
  for (const k of lignes) {
    const engage = engagementParLot(k).get(lot) ?? 0
    const pct = k.paires.find((p) => p.refFil === num(l.ref) && p.coloriFil === num(l.col))?.pourcentage ?? 0
    if (!(engage > EPS) || !(pct > 0)) continue
    const r = lireRepartition({ quantite: k.quantite, pieces: k.pieces, allocations: allocs.get(k.id) ?? [] })
    out.push({
      lsst: k.id, commande: k.commande, ecru: k.ecru, coloris: k.coloris,
      quantite: k.quantite, reste: k.reste, pct, freinte: k.freinte, engage,
      stockAVenir: r.stock.aVenir,
      parts: r.parts.filter((p) => p.reste > EPS).map((p) => ({ lcc: p.lcc, delai: p.delai, reste: p.reste })),
    })
  }
  return out
}

export class RefusArbitrage extends Error {
  constructor(public code: string, message: string) { super(message) }
}

/** A client line loses `perd` kg of écru of a knitting line: its yarn held there shrinks, each yarn
 *  of the recipe by its part ÷ (1 − freinte), newest reservation first. */
async function reduirePartFil(tx: Sql, k: LigneTricotage, lcc: number, perd: number): Promise<void> {
  for (const p of k.paires) {
    let moins = round2(filPourEcru(perd * (p.pourcentage / 100), k.freinte))
    const rows = await tx<{ id: number; kg: number }[]>`
      SELECT id, quantite::float8 AS kg FROM reservation_fil
       WHERE idligne_commande_client = ${lcc} AND idligne_commande_sous_traitant = ${k.id}
         AND idref_fil = ${p.refFil} AND idcolori_fil = ${p.coloriFil} AND liberee_le IS NULL
       ORDER BY id DESC`
    for (const r of rows) {
      if (!(moins > EPS)) break
      const pris = Math.min(moins, num(r.kg))
      if (num(r.kg) - pris > EPS) await tx`UPDATE reservation_fil SET quantite = ${round2(num(r.kg) - pris)} WHERE id = ${num(r.id)}`
      else await tx`DELETE FROM reservation_fil WHERE id = ${num(r.id)}`
      moins = round2(moins - pris)
    }
  }
}

/** Writes an arbitration: each knitting line knits less (its TRM mirror line follows, its asso
 *  plan keeps its proportions) unless the yarn only changes hands inside it, and each losing client
 *  line's share shrinks. One transaction; refused when an order's quantity moved since the plan
 *  was shown. */
export async function appliquerArbitrage(effets: readonly EffetArbitrage[]): Promise<void> {
  if (effets.length === 0) return
  const sql = mpsPg()
  const lignes = new Map((await lignesTricotage({ lignes: effets.map((e) => e.lsst) }, sql)).map((k) => [k.id, k]))
  await sql.begin(async (t) => {
    const tx = t as unknown as Sql
    for (const e of effets) {
      await tx`SELECT pg_advisory_xact_lock(hashtext('arbitrage_tricotage'), ${e.lsst}::int)`
      const [l] = await tx<{ quantite: number }[]>`
        SELECT quantite::float8 AS quantite FROM ligne_commande_sous_traitant WHERE idligne_commande_sous_traitant = ${e.lsst}`
      const k = lignes.get(e.lsst)
      if (!l || !k || Math.abs(num(l.quantite) - e.deQuantite) > 0.01) {
        throw new RefusArbitrage('perime', 'La commande de tricotage a changé entre-temps : rouvrez la réservation.')
      }
      if (!e.interne) {
        await tx`UPDATE ligne_commande_sous_traitant SET quantite = ${e.aQuantite} WHERE idligne_commande_sous_traitant = ${e.lsst}`
        // The TRM mirror line is read-only at TRM and follows the ETM line.
        await tx`UPDATE ligne_commande_client SET quantite = ${e.aQuantite} WHERE idligne_commande_etm = ${e.lsst}`
        if (e.deQuantite > 0) {
          await tx`UPDATE asso_fil_lignecmdsst SET quantite = quantite * ${e.aQuantite / e.deQuantite}
                    WHERE idligne_commande_sous_traitant = ${e.lsst}`
        }
      }
      for (const p of e.lignes) await reduirePartFil(tx, k, p.lcc, p.perd)
    }
  })
}

// ── Yarn a knitting order holds, reserved by a client line of its écru ──

export interface SourceTricotage {
  lsst: number
  commande: number
  lot: number
  refFil: number
  coloriFil: number
  /** the asso row tying the lot to the knitting line */
  asso: number
  /** yarn kg of what the order still brings for the stock: free for a client line */
  libre: number
  /** yarn kg the line holds there, less what its received pieces took */
  mien: number
  /** yarn kg other client lines hold there (their shares still to come) */
  autres: number
  /** the line's share of the order, écru kg, and the pieces of it the line already holds */
  partEcru: number
  recuEcru: number
}

/** The yarn of the OTHER yarns of the recipe that `ecru` kg of the order take, lot by lot. */
function autresFilsDe(k: LigneTricotage, sauf: { refFil: number; coloriFil: number }, ecru: number): { lot: number; asso: number; refFil: number; coloriFil: number; kg: number }[] {
  const out: { lot: number; asso: number; refFil: number; coloriFil: number; kg: number }[] = []
  for (const p of k.paires) {
    if (p.refFil === sauf.refFil && p.coloriFil === sauf.coloriFil) continue
    const lots = k.lots.filter((l) => l.asso > 0 && l.refFil === p.refFil && l.coloriFil === p.coloriFil)
    const plan = lots.reduce((x, l) => x + Math.max(0, l.plan), 0)
    for (const l of lots) {
      const kg = round2(filPourEcru(ecru * (p.pourcentage / 100), k.freinte) * (plan > EPS ? Math.max(0, l.plan) / plan : 1 / lots.length))
      if (kg > 0) out.push({ lot: l.lot, asso: l.asso, refFil: l.refFil, coloriFil: l.coloriFil, kg })
    }
  }
  return out
}

function sourcesDeLigne(k: LigneTricotage, r: RepartitionTricotage, ligne: number, miennes: ReadonlyMap<number, number>): SourceTricotage[] {
  const out: SourceTricotage[] = []
  const moi = r.parts.find((p) => p.lcc === ligne)
  const autresEcru = r.parts.filter((p) => p.lcc !== ligne).reduce((x, p) => x + p.reste, 0)
  for (const p of k.paires) {
    const lots = k.lots.filter((l) => l.asso > 0 && l.refFil === p.refFil && l.coloriFil === p.coloriFil)
    const plan = lots.reduce((x, l) => x + Math.max(0, l.plan), 0)
    for (const l of lots) {
      const part = plan > EPS ? Math.max(0, l.plan) / plan : 1 / lots.length
      const fil = (ecru: number) => filPourEcru(ecru * (p.pourcentage / 100), k.freinte) * part
      out.push({
        lsst: k.id, commande: k.commande, lot: l.lot, refFil: l.refFil, coloriFil: l.coloriFil, asso: l.asso,
        libre: round2(fil(r.stock.aVenir)),
        mien: round2(Math.max(0, (miennes.get(l.lot) ?? 0) - fil(moi?.recu ?? 0))),
        autres: round2(fil(autresEcru)),
        partEcru: moi?.reserve ?? 0,
        recuEcru: moi?.recu ?? 0,
      })
    }
  }
  return out
}

async function filTenuParLot(ligne: number, lsst: readonly number[], sql: Sql): Promise<Map<number, Map<number, number>>> {
  const out = new Map<number, Map<number, number>>()
  if (lsst.length === 0) return out
  const rows = await sql<{ k: number; lot: number; kg: number }[]>`
    SELECT idligne_commande_sous_traitant AS k, idstock_fil AS lot, SUM(quantite)::float8 AS kg FROM reservation_fil
     WHERE idligne_commande_client = ${ligne} AND idligne_commande_sous_traitant = ANY(${[...lsst]}) AND liberee_le IS NULL
     GROUP BY idligne_commande_sous_traitant, idstock_fil`
  for (const x of rows) {
    const m = out.get(num(x.k)) ?? new Map<number, number>()
    m.set(num(x.lot), num(x.kg))
    out.set(num(x.k), m)
  }
  return out
}

/** The yarn open knitting orders of an écru hold, per lot, as a client line of that écru can
 *  reserve it. Orders whose knitter brings the yarn have none (their shares are typed on them). */
export async function sourcesTricotage(p: { ecru: number; coloris: readonly number[]; ligne: number }, sql: Sql = mpsPg()): Promise<SourceTricotage[]> {
  if (!(p.ecru > 0)) return []
  const ids = (await sql<{ id: number }[]>`
    SELECT l.idligne_commande_sous_traitant AS id
      FROM ligne_commande_sous_traitant l
      JOIN commande_sous_traitant c ON c.idcommande_sous_traitant = l.idcommande_sous_traitant
     WHERE l.type = 1 AND l.idreference = ${p.ecru} AND c.est_soldee = 0 AND COALESCE(l.sstatut, '') NOT LIKE 'Termin%'
       AND (${p.coloris.length === 0} OR l.idcoloris = ANY(${[0, ...p.coloris]}))`).map((x) => num(x.id))
  const ks = (await lignesTricotage({ lignes: ids }, sql)).filter((k) => k.ouverte && k.lots.some((l) => l.asso > 0))
  if (ks.length === 0) return []
  const [allocs, miennes] = await Promise.all([
    allocationsParLigneTricot(ks.map((k) => k.id)),
    filTenuParLot(p.ligne, ks.map((k) => k.id), sql),
  ])
  return ks.flatMap((k) => sourcesDeLigne(
    k, lireRepartition({ quantite: k.quantite, pieces: k.pieces, allocations: allocs.get(k.id) ?? [] }), p.ligne, miennes.get(k.id) ?? new Map(),
  ))
}

/** Sets the yarn of one lot a client line holds in a knitting order of its écru (`kg` = what it
 *  holds there once done, its received pieces aside). More: what the order knits for the stock
 *  first; beyond, another line's share — then returns the plan to validate (`arbitrage` false) or
 *  applies it. Less: the yarn goes back to the order's stock part. The pieces already knitted and
 *  free follow the new shares.
 *
 *  A share of a knitting order is every yarn of its recipe: the kg set on one lot move the OTHER
 *  yarns of the order with them, in the recipe's proportions (taking the cotton of a line left its
 *  élasthanne nobody's, and the taker without a share until it took élasthanne from a third line). */
export async function fixerFilEnTricotage(p: {
  ligne: number; lsst: number; lot: number; kg: number
  /** the most the line may add of this yarn (its need + 10 %) */
  max?: number
  arbitrage: boolean
  parId: number; par: string | null
}): Promise<{ arbitrage?: { libre: number; kg: number; effets: EffetArbitrage[]; cibles: CibleArbitrage[] } }> {
  const sql = mpsPg()
  const [k] = await lignesTricotage({ lignes: [p.lsst] }, sql)
  if (!k || !k.ouverte) throw new RefusArbitrage('commande_close', 'Cette commande de tricotage est terminée.')
  const allocations = (await allocationsParLigneTricot([k.id])).get(k.id) ?? []
  const r = lireRepartition({ quantite: k.quantite, pieces: k.pieces, allocations })
  const src = sourcesDeLigne(k, r, p.ligne, (await filTenuParLot(p.ligne, [k.id], sql)).get(k.id) ?? new Map()).find((x) => x.lot === p.lot)
  if (!src) throw new RefusArbitrage('lot_hors_commande', "Ce lot n'alimente pas cette commande de tricotage.")
  const delta = round2(Math.max(0, p.kg) - src.mien)
  const pctSrc = k.paires.find((x) => x.refFil === src.refFil && x.coloriFil === src.coloriFil)?.pourcentage ?? 0
  // The écru share these kg stand for, and the other yarns of the recipe that go with it.
  const suite = autresFilsDe(k, src, pctSrc > 0 ? ecruPourFil(Math.abs(delta) / (pctSrc / 100), k.freinte) : 0)

  if (delta < -EPS) {
    await sql.begin(async (t) => {
      const tx = t as unknown as Sql
      for (const x of [{ lot: p.lot, kg: -delta }, ...suite]) {
        let moins = x.kg
        const rows = await tx<{ id: number; kg: number }[]>`
          SELECT id, quantite::float8 AS kg FROM reservation_fil
           WHERE idligne_commande_client = ${p.ligne} AND idligne_commande_sous_traitant = ${k.id} AND idstock_fil = ${x.lot}
             AND liberee_le IS NULL ORDER BY id DESC`
        for (const row of rows) {
          if (!(moins > EPS)) break
          const pris = Math.min(moins, num(row.kg))
          if (num(row.kg) - pris > EPS) await tx`UPDATE reservation_fil SET quantite = ${round2(num(row.kg) - pris)} WHERE id = ${num(row.id)}`
          else await tx`DELETE FROM reservation_fil WHERE id = ${num(row.id)}`
          moins = round2(moins - pris)
        }
      }
    })
    await reserverPiecesTricotees([k.id])
    return {}
  }
  if (!(delta > EPS)) return {}

  const fmt = (x: number) => x.toLocaleString('fr-FR', { maximumFractionDigits: 1 })
  if (p.max !== undefined && delta > p.max + 0.05) {
    throw new RefusArbitrage('au_dela_du_besoin', `La ligne ne peut réserver que ${fmt(Math.max(0, p.max))} kg de plus de ce fil.`)
  }
  const manque = round2(delta - src.libre)
  if (manque > EPS) {
    const autres = r.parts.filter((x) => x.lcc !== p.ligne && x.reste > EPS)
    const cibles: CibleArbitrage[] = [{
      lsst: k.id, commande: k.commande, quantite: k.quantite, pct: pctSrc, freinte: k.freinte, garde: true,
      reste: autres.reduce((x, a) => x + a.reste, 0), engage: src.autres, stockAVenir: 0,
      parts: autres.map((a) => ({ lcc: a.lcc, delai: a.delai, reste: a.reste })),
    }]
    const plan = planArbitrage(manque + 0.02, cibles)
    if (!plan.ok) {
      throw new RefusArbitrage('libre_insuffisant', `Cette commande de tricotage ne peut donner que ${fmt(src.libre + plan.libere)} kg de ce fil à la ligne.`)
    }
    if (!p.arbitrage) return { arbitrage: { libre: src.libre, kg: manque, effets: plan.effets, cibles } }
    await appliquerArbitrage(plan.effets)
  }
  await sql.begin(async (t) => {
    const tx = t as unknown as Sql
    for (const x of [{ lot: p.lot, asso: src.asso, refFil: src.refFil, coloriFil: src.coloriFil, kg: delta }, ...suite]) {
      await tx`
        INSERT INTO reservation_fil (idligne_commande_client, idref_fil, idcolori_fil, quantite, idstock_fil,
                                     idligne_commande_sous_traitant, idasso_fil_lignecmdsst, cree_par_id, cree_par)
        VALUES (${p.ligne}, ${x.refFil}, ${x.coloriFil}, ${x.kg}, ${x.lot}, ${k.id}, ${x.asso}, ${p.parId}, ${p.par})`
    }
  })
  await reserverPiecesTricotees([k.id])
  return {}
}
