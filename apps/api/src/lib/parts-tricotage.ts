// A client line's share of a knitting order (decision Vincent 2026-11-13).
//
// A client line reserves MATTER, never a transformation order: yarn on a supplier order (the entry
// point), a yarn lot, tombé de métier pieces, fini rolls. A knitting or dyeing order moves matter
// forward, and the matter it takes says which client it serves.
//
// So a line's share of a knitting order is no longer typed on the order: it is the yarn reserved to
// the line that the order holds — `reservation_fil` rows on a lot with the knitting line
// (idligne_commande_sous_traitant), written by the launch from the line and by « Réserver du fil »
// on a lot in knitting. In écru: the scarcest yarn of the order's recipe decides, after the freinte
// (a line holding the cotton of an order but not its élasthanne has no share yet). When the lines'
// yarn makes more than the order knits (their 5 % safety margin goes to the knitter with them), the
// shares are scaled to the order's quantity; and when it covers the whole order, nothing is for the
// stock: the line due last takes every piece left (`couvreTout`).
//
// One exception, the entry point: a knitter who brings the yarn (Chamatex) knits no lot of ours, so
// there is no matter to reserve — the order itself lets matter in, like a yarn supplier order. Its
// shares stay typed on the order (`affectation_cmd_tricotage`, the legacy table). A knitting line is
// such an entry when no yarn lot feeds it (no asso row). A closed order that never had yarn
// reservations (before this rule) is still read from that table: history.

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'
import { filPourEcru, ecruPourFil, freintesTricotage } from './freinte-tricotage.js'

const round2 = (x: number) => Math.round(x * 100) / 100
const num = (v: unknown) => Number(v) || 0
const cle = (rf: number, cf: number) => `${rf}:${cf}`

export interface PaireFilTricot { refFil: number; coloriFil: number; pourcentage: number }

export interface PartTricot {
  lcc: number
  /** écru kg of the order that are the line's */
  poids: number
  /** « tout le reste », as typed on an entry order (derived by the caller on our yarn: `couvreTout`) */
  toute: boolean
}

export interface PartsLigneTricot {
  lsst: number
  /** where the shares are read: typed on the order (entry, history) or from the yarn it holds */
  source: 'commande' | 'fil'
  /** the knitter brings the yarn: the order is an entry point, its shares are typed on it */
  entree: boolean
  /** our yarn, and the lines' yarn covers the whole order: nothing is knitted for the stock */
  couvreTout: boolean
  parts: PartTricot[]
}

// ── Pure rules ──────────────────────────────────────────────

/** The écru a set of yarns makes for a recipe: the scarcest decides, after the freinte. */
export function ecruDuFil(paires: readonly PaireFilTricot[], freinte: number, kgParFil: ReadonlyMap<string, number>): number {
  let min = Infinity
  for (const p of paires) {
    if (!(p.pourcentage > 0)) continue
    min = Math.min(min, (kgParFil.get(cle(p.refFil, p.coloriFil)) ?? 0) / (p.pourcentage / 100))
  }
  return Number.isFinite(min) && min > 0 ? ecruPourFil(min, freinte) : 0
}

/** Pure: the client lines' shares of a knitting order, from the yarn each holds in it.
 *  `excedents` = per line, the yarn it holds there that makes no écru yet (another yarn of the
 *  recipe is missing): still its reserved yarn, counted as such in its need. */
export function partsDepuisFil(p: {
  quantite: number
  freinte: number
  paires: readonly PaireFilTricot[]
  reservations: readonly { lcc: number; refFil: number; coloriFil: number; kg: number }[]
}): { parts: PartTricot[]; couvreTout: boolean; excedents: Map<number, Map<string, number>> } {
  const parLigne = new Map<number, Map<string, number>>()
  for (const r of p.reservations) {
    if (!(r.lcc > 0) || !(r.kg > 0)) continue
    const m = parLigne.get(r.lcc) ?? new Map<string, number>()
    m.set(cle(r.refFil, r.coloriFil), (m.get(cle(r.refFil, r.coloriFil)) ?? 0) + r.kg)
    parLigne.set(r.lcc, m)
  }
  const bruts: { lcc: number; ecru: number }[] = []
  const excedents = new Map<number, Map<string, number>>()
  for (const [lcc, kg] of parLigne) {
    const ecru = ecruDuFil(p.paires, p.freinte, kg)
    if (ecru > 0.005) bruts.push({ lcc, ecru })
    const ex = new Map<string, number>()
    for (const x of p.paires) {
      const tenu = kg.get(cle(x.refFil, x.coloriFil)) ?? 0
      const utile = filPourEcru(ecru * (x.pourcentage / 100), p.freinte)
      if (tenu - utile > 0.05) ex.set(cle(x.refFil, x.coloriFil), round2(tenu - utile))
    }
    if (ex.size > 0) excedents.set(lcc, ex)
  }
  const total = bruts.reduce((s, b) => s + b.ecru, 0)
  const echelle = total > p.quantite && total > 0 ? p.quantite / total : 1
  return {
    parts: bruts.map((b) => ({ lcc: b.lcc, poids: round2(b.ecru * echelle), toute: false })).sort((a, b) => a.lcc - b.lcc),
    // Within half a percent: the last kilo is rounding, not a share for the stock.
    couvreTout: p.quantite > 0 && total >= p.quantite * 0.995,
    excedents,
  }
}

// ── Reads ───────────────────────────────────────────────────

interface LigneK { id: number; quantite: number; ecru: number; coloris: number; ouverte: boolean; lots: number }

async function lignesK(ids: readonly number[], sql: Sql): Promise<LigneK[]> {
  if (ids.length === 0) return []
  const rows = await sql<{ id: number; quantite: number; ecru: number; coloris: number; sstatut: string | null; soldee: number | null; lots: number }[]>`
    SELECT l.idligne_commande_sous_traitant AS id, l.quantite::float8 AS quantite, l.idreference AS ecru, l.idcoloris AS coloris,
           l.sstatut, c.est_soldee AS soldee,
           (SELECT COUNT(*) FROM asso_fil_lignecmdsst a WHERE a.idligne_commande_sous_traitant = l.idligne_commande_sous_traitant)::int AS lots
      FROM ligne_commande_sous_traitant l
      JOIN commande_sous_traitant c ON c.idcommande_sous_traitant = l.idcommande_sous_traitant
     WHERE l.idligne_commande_sous_traitant = ANY(${[...ids]}) AND l.type = 1`
  return rows.map((l) => ({
    id: num(l.id), quantite: num(l.quantite), ecru: num(l.ecru), coloris: num(l.coloris), lots: num(l.lots),
    ouverte: num(l.soldee) !== 1 && !String(l.sstatut ?? '').startsWith('Termin'),
  }))
}

async function recettes(ks: readonly LigneK[], sql: Sql): Promise<{ paires: (k: LigneK) => PaireFilTricot[]; freinte: (k: LigneK) => number }> {
  const ecrus = [...new Set(ks.map((k) => k.ecru).filter((x) => x > 0))]
  const [compo, freintes] = await Promise.all([
    sql<{ ecru: number; coloris: number; ref: number; col: number; pct: number }[]>`
      SELECT DISTINCT idref_ecru AS ecru, idcolori_ecru AS coloris, idref_fil AS ref, idcolori_fil AS col, pourcentage::float8 AS pct
        FROM composition_ecru WHERE idref_ecru = ANY(${[0, ...ecrus]}) AND idcolori_ecru > 0 AND idref_fil > 0 AND pourcentage > 0`,
    freintesTricotage(ecrus),
  ])
  return {
    paires: (k) => compo.filter((c) => num(c.ecru) === k.ecru && num(c.coloris) === k.coloris)
      .map((c) => ({ refFil: num(c.ref), coloriFil: num(c.col), pourcentage: num(c.pct) })),
    freinte: (k) => freintes.get(k.ecru)?.taux ?? 0,
  }
}

/** The client lines' shares of knitting lines: the ones named, or every one a client line of
 *  `lcc` has a share of (then with ALL its shares: the others bound this line's). */
export async function partsTricotage(filtre: { lsst?: readonly number[]; lcc?: readonly number[] }, sql: Sql = mpsPg()): Promise<Map<number, PartsLigneTricot>> {
  const out = new Map<number, PartsLigneTricot>()
  let ids = [...new Set((filtre.lsst ?? []).filter((x) => x > 0))]
  const lccs = [...new Set((filtre.lcc ?? []).filter((x) => x > 0))]
  if (lccs.length > 0) {
    const rows = await sql<{ k: number }[]>`
      SELECT idligne_commande_sous_traitant AS k FROM reservation_fil
       WHERE idligne_commande_client = ANY(${lccs}) AND idligne_commande_sous_traitant > 0 AND liberee_le IS NULL
      UNION
      SELECT idligne_commande_sous_traitant FROM affectation_cmd_tricotage
       WHERE idligne_commande_client = ANY(${lccs}) AND poids_affecte > 0`
    ids = [...new Set([...ids, ...rows.map((r) => num(r.k))])].filter((x) => x > 0)
  }
  const ks = await lignesK(ids, sql)
  if (ks.length === 0) return out
  const kIds = ks.map((k) => k.id)
  const [typees, fil, r] = await Promise.all([
    sql<{ k: number; lcc: number; poids: number; toute: number | null }[]>`
      SELECT idligne_commande_sous_traitant AS k, idligne_commande_client AS lcc, poids_affecte::float8 AS poids, toute_commande AS toute
        FROM affectation_cmd_tricotage WHERE idligne_commande_sous_traitant = ANY(${kIds})`,
    sql<{ k: number; lcc: number; ref: number; col: number; kg: number }[]>`
      SELECT idligne_commande_sous_traitant AS k, idligne_commande_client AS lcc, idref_fil AS ref, idcolori_fil AS col,
             SUM(quantite)::float8 AS kg
        FROM reservation_fil
       WHERE idligne_commande_sous_traitant = ANY(${kIds}) AND liberee_le IS NULL
       GROUP BY idligne_commande_sous_traitant, idligne_commande_client, idref_fil, idcolori_fil`,
    recettes(ks, sql),
  ])
  for (const k of ks) {
    const duFil = fil.filter((x) => num(x.k) === k.id)
    const entree = k.lots === 0
    if (entree || (!k.ouverte && duFil.length === 0)) {
      const parLcc = new Map<number, PartTricot>()
      for (const t of typees) {
        if (num(t.k) !== k.id || !(num(t.poids) > 0)) continue
        const e = parLcc.get(num(t.lcc)) ?? { lcc: num(t.lcc), poids: 0, toute: false }
        e.poids = round2(e.poids + num(t.poids))
        e.toute ||= num(t.toute) === 1
        parLcc.set(num(t.lcc), e)
      }
      out.set(k.id, { lsst: k.id, source: 'commande', entree, couvreTout: false, parts: [...parLcc.values()] })
      continue
    }
    const { parts, couvreTout } = partsDepuisFil({
      quantite: k.quantite, freinte: r.freinte(k), paires: r.paires(k),
      reservations: duFil.map((x) => ({ lcc: num(x.lcc), refFil: num(x.ref), coloriFil: num(x.col), kg: num(x.kg) })),
    })
    out.set(k.id, { lsst: k.id, source: 'fil', entree: false, couvreTout, parts })
  }
  return out
}

/** Yarn a client line holds in open knitting orders that makes no écru share yet (a yarn of the
 *  recipe is missing there), per `refFil:coloriFil`: counted with its reserved yarn. */
export async function filEngageSansPart(lcc: number, sql: Sql = mpsPg()): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const rows = await sql<{ k: number; ref: number; col: number; kg: number }[]>`
    SELECT idligne_commande_sous_traitant AS k, idref_fil AS ref, idcolori_fil AS col, SUM(quantite)::float8 AS kg
      FROM reservation_fil
     WHERE idligne_commande_client = ${lcc} AND idligne_commande_sous_traitant > 0 AND liberee_le IS NULL
     GROUP BY idligne_commande_sous_traitant, idref_fil, idcolori_fil`
  if (rows.length === 0) return out
  const ks = (await lignesK([...new Set(rows.map((x) => num(x.k)))], sql)).filter((k) => k.ouverte && k.lots > 0)
  if (ks.length === 0) return out
  const r = await recettes(ks, sql)
  for (const k of ks) {
    const { excedents } = partsDepuisFil({
      quantite: k.quantite, freinte: r.freinte(k), paires: r.paires(k),
      reservations: rows.filter((x) => num(x.k) === k.id).map((x) => ({ lcc, refFil: num(x.ref), coloriFil: num(x.col), kg: num(x.kg) })),
    })
    for (const [fil, kg] of excedents.get(lcc) ?? []) out.set(fil, round2((out.get(fil) ?? 0) + kg))
  }
  return out
}

// ── Writes ──────────────────────────────────────────────────

/** Shares typed on knitting orders that knit OUR yarn become yarn reservations held by the order
 *  (the reprise of the old model, and a line that receives its lots after shares were typed):
 *  per share, each yarn of the recipe × its part ÷ (1 − freinte), on the lots feeding the order
 *  (by the asso plan). A line that already holds yarn in the order (it launched it: its
 *  reservations went with it) keeps that yarn as its share, nothing is added. The typed rows are
 *  then removed. Open orders only; idempotent.
 *  Returns what it did (or would do, `ecrire` false). */
export async function convertirPartsEnFil(lsstIds: readonly number[] | null, ecrire: boolean, sql: Sql = mpsPg()): Promise<{ lsst: number; lcc: number; ecru: number; lignes: number }[]> {
  const cibles = lsstIds
    ? [...new Set(lsstIds.filter((x) => x > 0))]
    : (await sql<{ k: number }[]>`SELECT DISTINCT idligne_commande_sous_traitant AS k FROM affectation_cmd_tricotage WHERE poids_affecte > 0`).map((x) => num(x.k))
  const ks = (await lignesK(cibles, sql)).filter((k) => k.ouverte && k.lots > 0)
  const fait: { lsst: number; lcc: number; ecru: number; lignes: number }[] = []
  if (ks.length === 0) return fait
  const r = await recettes(ks, sql)
  for (const k of ks) {
    const [typees, lots, deja] = await Promise.all([
      sql<{ id: number; lcc: number; poids: number }[]>`
        SELECT idaffectation_cmd_tricotage AS id, idligne_commande_client AS lcc, poids_affecte::float8 AS poids
          FROM affectation_cmd_tricotage WHERE idligne_commande_sous_traitant = ${k.id} AND poids_affecte > 0 ORDER BY 1`,
      sql<{ asso: number; lot: number; kg: number; ref: number; col: number }[]>`
        SELECT a.idasso_fil_lignecmdsst AS asso, a.idstock_fil AS lot, a.quantite::float8 AS kg, s.idref_fil AS ref, s.idcolori_fil AS col
          FROM asso_fil_lignecmdsst a JOIN stock_fil s ON s.idstock_fil = a.idstock_fil
         WHERE a.idligne_commande_sous_traitant = ${k.id} ORDER BY 1`,
      sql<{ lcc: number }[]>`
        SELECT DISTINCT idligne_commande_client AS lcc FROM reservation_fil
         WHERE idligne_commande_sous_traitant = ${k.id} AND liberee_le IS NULL`,
    ])
    if (typees.length === 0) continue
    const tient = new Set(deja.map((x) => num(x.lcc)))
    const lignes: { lcc: number; ref: number; col: number; kg: number; lot: number; asso: number }[] = []
    for (const t of typees) {
      let n = 0
      for (const p of tient.has(num(t.lcc)) ? [] : r.paires(k)) {
        const besoin = filPourEcru(num(t.poids) * (p.pourcentage / 100), r.freinte(k))
        const mes = lots.filter((l) => num(l.ref) === p.refFil && num(l.col) === p.coloriFil)
        const plan = mes.reduce((s, l) => s + Math.max(0, num(l.kg)), 0)
        for (const l of mes) {
          const kg = round2(besoin * (plan > 0 ? Math.max(0, num(l.kg)) / plan : 1 / mes.length))
          if (!(kg > 0)) continue
          lignes.push({ lcc: num(t.lcc), ref: p.refFil, col: p.coloriFil, kg, lot: num(l.lot), asso: num(l.asso) })
          n++
        }
      }
      fait.push({ lsst: k.id, lcc: num(t.lcc), ecru: num(t.poids), lignes: n })
    }
    if (!ecrire) continue
    await sql.begin(async (t) => {
      const tx = t as unknown as Sql
      for (const x of lignes) {
        await tx`
          INSERT INTO reservation_fil (idligne_commande_client, idref_fil, idcolori_fil, quantite, idstock_fil,
                                       idligne_commande_sous_traitant, idasso_fil_lignecmdsst, cree_par_id, cree_par)
          VALUES (${x.lcc}, ${x.ref}, ${x.col}, ${x.kg}, ${x.lot}, ${k.id}, ${x.asso}, 0, 'reprise des parts de commande de tricotage')`
      }
      await tx`DELETE FROM affectation_cmd_tricotage WHERE idligne_commande_sous_traitant = ${k.id}`
    })
  }
  return fait
}
