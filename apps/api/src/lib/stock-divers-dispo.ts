// Divers: nothing leaves without stock (Vincent 2026-11-27).
//
// Until then a divers shipment beyond the stock on hand went out anyway: the stock row went negative,
// and an article without a row shipped with nothing moved. An amber « Au-delà du stock disponible » was
// the only guard (tickets #1098 / #1099, « des avertissements, jamais des blocages », because 584
// order-line articles had no stock row at the time). Measured on prod the day of the decision: the 378
// articles shipped over twelve months all had a row, no row was negative, 18 of the 26 lines still to
// ship were covered. So the stock is entered first (Divers › Stock, or « Entrée en stock » on the order
// line), and every writer of ref_divers_expedie asks here before it takes more out:
//   - an article without a stock row has nothing on hand, like a row at 0;
//   - giving back (a smaller quantity, an article removed) is always allowed;
//   - what is checked is the NET move of the write, per article: a carton saved again as it is takes
//     nothing (its content is already off the stock — stock_divers is decremented at write time).

import { mpsPg } from './mps-pg.js'

/** One article: a reference narrowed by its two variation axes (0 = the axis does not apply). */
export interface ArticleDivers { ref: number; v1: number; v2: number }

/** What a write takes out of an article's stock on top of what it already holds; ≤ 0 = it gives back. */
export interface PriseDivers extends ArticleDivers { quantite: number }

export interface RefusStockDivers {
  error: 'stock_insuffisant'
  message: string
}

/** Thrown by a writer that has no response to answer on (setDiversCartonContenu); the route maps it to 409. */
export class StockDiversInsuffisant extends Error {
  readonly refus: RefusStockDivers
  constructor(refus: RefusStockDivers) {
    super(refus.message)
    this.name = 'StockDiversInsuffisant'
    this.refus = refus
  }
}

/** Quantities carry 4 decimals at most (expeditions.ts r4). */
const EPS = 0.00005
const cle = (a: ArticleDivers) => `${a.ref}|${a.v1}|${a.v2}`
const fmt = (x: number) => x.toLocaleString('fr-FR', { maximumFractionDigits: 2 }).replace(/[  ]/g, ' ')

/** The net move per article: several moves on one article add up (an item moved from one article to
 *  another gives the first back and takes the second). Articles that take nothing are dropped. */
export function prisesNettes(prises: readonly PriseDivers[]): PriseDivers[] {
  const m = new Map<string, PriseDivers>()
  for (const p of prises) {
    if (!(p.ref > 0) || !Number.isFinite(p.quantite)) continue
    const k = cle(p)
    const prev = m.get(k)
    if (prev) prev.quantite += p.quantite
    else m.set(k, { ...p })
  }
  return [...m.values()].filter((p) => p.quantite > EPS)
}

/** What is missing to take `aPrendre` out of `enStock` (0 = it can go). A negative stock holds nothing. */
export function manqueStockDivers(enStock: number, aPrendre: number): number {
  if (!(aPrendre > EPS)) return 0
  const manque = aPrendre - Math.max(0, enStock)
  return manque > EPS ? manque : 0
}

/** The sentence of a refusal: the first article short of stock, and how many others. */
export function messageStockInsuffisant(
  manquants: readonly { libelle: string; enStock: number; aPrendre: number }[],
): string {
  const [premier, ...autres] = manquants
  if (!premier) return ''
  const suite = autres.length === 0 ? '' : autres.length === 1 ? ' (et 1 autre article)' : ` (et ${autres.length} autres articles)`
  return `Stock insuffisant pour ${premier.libelle} : ${fmt(Math.max(0, premier.enStock))} en stock, ${fmt(premier.aPrendre)} à expédier${suite}.`
}

/** Stock on hand per article (`ref|v1|v2`); an article without a row is absent (= nothing on hand). */
export async function stockDiversEnMain(articles: readonly ArticleDivers[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const refs = [...new Set(articles.map((a) => a.ref).filter((x) => Number.isInteger(x) && x > 0))]
  if (refs.length === 0) return out
  const sql = mpsPg()
  const rows = await sql<{ ref: number; v1: number; v2: number; quantite: number | null }[]>`
    select idref_divers as ref, idvariation1 as v1, idvariation2 as v2, quantite
      from stock_divers where idref_divers in ${sql(refs)}`
  for (const r of rows) {
    const k = cle({ ref: Number(r.ref) || 0, v1: Number(r.v1) || 0, v2: Number(r.v2) || 0 })
    out.set(k, (out.get(k) ?? 0) + (Number(r.quantite) || 0))
  }
  return out
}

/** « Tissu Voltige ® · Rouge · 20 Mètres », as the order line and the stock screen name the article. */
async function libellesArticles(articles: readonly ArticleDivers[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const refs = [...new Set(articles.map((a) => a.ref).filter((x) => x > 0))]
  const vars = [...new Set(articles.flatMap((a) => [a.v1, a.v2]).filter((x) => x > 0))]
  if (refs.length === 0) return out
  const sql = mpsPg()
  const [refRows, varRows] = await Promise.all([
    sql<{ id: number; designation: string | null }[]>`select idref_divers as id, designation from ref_divers where idref_divers in ${sql(refs)}`,
    vars.length > 0
      ? sql<{ id: number; designation: string | null }[]>`select idref_divers_variation as id, designation from ref_divers_variation where idref_divers_variation in ${sql(vars)}`
      : Promise.resolve([] as { id: number; designation: string | null }[]),
  ])
  const nomRef = new Map(refRows.map((r) => [Number(r.id), (r.designation ?? '').trim()]))
  const nomVar = new Map(varRows.map((r) => [Number(r.id), (r.designation ?? '').trim()]))
  for (const a of articles) {
    const parts = [nomRef.get(a.ref) || `Réf. ${a.ref}`, a.v1 > 0 ? nomVar.get(a.v1) : '', a.v2 > 0 ? nomVar.get(a.v2) : '']
    out.set(cle(a), parts.filter(Boolean).join(' · '))
  }
  return out
}

/** Null when the stock on hand covers what the write takes out, else the refusal (409). Call it BEFORE
 *  the first write: a refused shipment must leave neither an empty avis nor a half-written carton. */
export async function refusStockDivers(prises: readonly PriseDivers[]): Promise<RefusStockDivers | null> {
  const nettes = prisesNettes(prises)
  if (nettes.length === 0) return null
  const stock = await stockDiversEnMain(nettes)
  const manquants = nettes
    .map((p) => ({ p, enStock: stock.get(cle(p)) ?? 0 }))
    .filter((x) => manqueStockDivers(x.enStock, x.p.quantite) > 0)
  if (manquants.length === 0) return null
  const libelles = await libellesArticles(manquants.map((x) => x.p))
  return {
    error: 'stock_insuffisant',
    message: messageStockInsuffisant(manquants.map((x) => ({
      libelle: libelles.get(cle(x.p)) ?? `Réf. ${x.p.ref}`, enStock: x.enStock, aPrendre: x.p.quantite,
    }))),
  }
}

/** Order lists: a divers line still to ship whose stock on hand does not cover what is left. It waits
 *  for its stock: « attente stock », neutral until its date (lib/urgence-commande-client.ts). */
export function stockDiversManquant(enStock: number | undefined, reste: number): boolean {
  return reste > 0.005 && manqueStockDivers(enStock ?? 0, reste) > 0.005
}
