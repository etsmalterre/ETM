// One avis d'expédition leaves from ONE place (Vincent 2026-11-27).
//
// A roll's place is its magasin (stock_fini / stock_ecru.IDmagasin): 0 = the factory, shown
// « Malterre » as on the stock screens, else the sous-traitant holding it (every dyer ships straight
// to the client). An avis whose rolls sit in two places is two pickups: the demande de transport
// refused it (`magasins_multiples`), but only there, once the avis was made and mailed.
//
// What happened: avis 12548 was made with 32 rolls at MATEL and 2 at the factory. The roll list did not
// print « Malterre » (it named sous-traitants only), so nothing said where the two were, and nothing
// refused them. Isabelle split it by hand (12549). Measured on prod that day: of the 2 534 avis with
// rolls of 2024 to 2026 none mixes two places (the last one is of January 2023), so the refusal below
// takes nothing away from what people do.
//
// Every road that puts a roll on an avis asks `refusLieuExpedition()` BEFORE its first write:
//   - the Affectation tab's « Expédier » (POST /commandes-client/:id/lignes/:ligneId/expedier);
//   - the Expéditions screen's roll picker (PUT /expeditions/formelle/:id/lignes/:lcc/rolls/:stockId).
// The place of an avis cannot drift afterwards: Transferts never offer nor accept a roll that is on an
// avis (routes/transferts.ts).

import { mpsPg } from './mps-pg.js'

/** The factory's name as a place (magasin 0), on every screen. */
export const LIEU_MALTERRE = 'Malterre'

export type FormeRouleau = 'fini' | 'ecru'

/** A place and how many rolls of the avis sit there. */
export interface LieuDepart { id: number; nom: string; rouleaux: number }

export interface RefusLieuExpedition {
  error: 'lieux_multiples'
  message: string
}

/** A place's name: the factory for 0, the sous-traitant otherwise. */
export function nomLieu(id: number, noms: ReadonlyMap<number, string>): string {
  if (!(id > 0)) return LIEU_MALTERRE
  return noms.get(id)?.trim() || `magasin ${id}`
}

/** Rolls per place, from their magasin ids (an empty magasin is the factory). */
export function compterLieux(magasins: readonly unknown[]): Map<number, number> {
  const out = new Map<number, number>()
  for (const m of magasins) {
    const id = Math.max(0, Number(m) || 0)
    out.set(id, (out.get(id) ?? 0) + 1)
  }
  return out
}

/** The places of a count, the fullest first. */
export function lieuxTries(parLieu: ReadonlyMap<number, number>, noms: ReadonlyMap<number, string>): LieuDepart[] {
  return [...parLieu]
    .map(([id, rouleaux]) => ({ id, nom: nomLieu(id, noms), rouleaux }))
    .sort((a, b) => b.rouleaux - a.rouleaux || a.id - b.id)
}

const enListe = (lieux: readonly LieuDepart[]) => lieux.map((l) => `${l.nom} × ${l.rouleaux}`).join(', ')

/** May the rolls of `ajout` join an avis that already holds `surAvis`? null = yes. */
export function refusLieux(
  surAvis: ReadonlyMap<number, number>,
  ajout: ReadonlyMap<number, number>,
  noms: ReadonlyMap<number, string>,
): RefusLieuExpedition | null {
  const tous = new Map(surAvis)
  for (const [id, n] of ajout) tous.set(id, (tous.get(id) ?? 0) + n)
  if (tous.size <= 1) return null

  const fin = 'faites une expédition par lieu.'
  // The avis has its place: say where the newcomers are.
  if (surAvis.size === 1) {
    const [depart] = surAvis.keys()
    const ailleurs = lieuxTries(new Map([...ajout].filter(([id]) => id !== depart)), noms)
    const nb = ailleurs.reduce((s, l) => s + l.rouleaux, 0)
    const message = nb === 1
      ? `Ce rouleau est chez ${ailleurs[0].nom}, l'expédition part de chez ${nomLieu(depart, noms)} : ${fin}`
      : `L'expédition part de chez ${nomLieu(depart, noms)}, ces rouleaux sont ailleurs (${enListe(ailleurs)}) : ${fin}`
    return { error: 'lieux_multiples', message }
  }
  return {
    error: 'lieux_multiples',
    message: `Ces rouleaux ne sont pas au même endroit (${enListe(lieuxTries(tous, noms))}) : ${fin}`,
  }
}

// ── Reads ──────────────────────────────────────────────

const entiers = (ids: Iterable<unknown>) => [...new Set([...ids].map(Number).filter((x) => Number.isInteger(x) && x > 0))]

/** Names of the places (the factory is always there). */
export async function nomsLieux(ids: Iterable<unknown>): Promise<Map<number, string>> {
  const out = new Map<number, string>([[0, LIEU_MALTERRE]])
  const u = entiers(ids)
  if (u.length === 0) return out
  const sql = mpsPg()
  const rows = await sql<{ id: number; nom: string | null }[]>`
    select idsous_traitant as id, nom from sous_traitant where idsous_traitant in ${sql(u)}`
  for (const r of rows) out.set(Number(r.id), (r.nom ?? '').trim())
  return out
}

/** Rolls per place among the given rolls (a roll that does not exist counts nowhere). */
export async function lieuxDesRouleaux(forme: FormeRouleau, stockIds: Iterable<unknown>): Promise<Map<number, number>> {
  const u = entiers(stockIds)
  if (u.length === 0) return new Map()
  const sql = mpsPg()
  const rows = forme === 'fini'
    ? await sql<{ mag: number | null }[]>`select idmagasin as mag from stock_fini where idstock_fini in ${sql(u)}`
    : await sql<{ mag: number | null }[]>`select idmagasin as mag from stock_ecru where idstock_ecru in ${sql(u)}`
  return compterLieux(rows.map((r) => r.mag))
}

/** Rolls per place on an avis d'expédition, every line and both forms together. */
export async function lieuxDeLAvis(idExpedition: number): Promise<Map<number, number>> {
  if (!(idExpedition > 0)) return new Map()
  const sql = mpsPg()
  const rows = await sql<{ mag: number | null }[]>`
    select sf.idmagasin as mag
      from stock_fini sf join ligne_expedition le on le.idligne_expedition = sf.idligne_expedition
     where le.idexpedition = ${idExpedition} and sf.idligne_expedition > 0
    union all
    select se.idmagasin
      from stock_ecru se join ligne_expedition le on le.idligne_expedition = se.idligne_expedition_etm
     where le.idexpedition = ${idExpedition} and se.idligne_expedition_etm > 0`
  return compterLieux(rows.map((r) => r.mag))
}

/** Where an avis leaves from: one place, none while it holds no roll (several on an avis made before the rule). */
export async function departDeLAvis(idExpedition: number): Promise<LieuDepart[]> {
  const parLieu = await lieuxDeLAvis(idExpedition)
  if (parLieu.size === 0) return []
  return lieuxTries(parLieu, await nomsLieux(parLieu.keys()))
}

/** The guard of every writer: null = the rolls may go on the avis (`idExpedition` null = an avis to be made). */
export async function refusLieuExpedition(p: {
  idExpedition: number | null
  forme: FormeRouleau
  stockIds: readonly number[]
}): Promise<RefusLieuExpedition | null> {
  const [surAvis, ajout] = await Promise.all([
    p.idExpedition ? lieuxDeLAvis(p.idExpedition) : Promise.resolve(new Map<number, number>()),
    lieuxDesRouleaux(p.forme, p.stockIds),
  ])
  if (new Set([...surAvis.keys(), ...ajout.keys()]).size <= 1) return null
  return refusLieux(surAvis, ajout, await nomsLieux([...surAvis.keys(), ...ajout.keys()]))
}
