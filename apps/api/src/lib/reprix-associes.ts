import { query } from './hfsql-auto.js'
import { numOf } from './clients-common.js'
import { calcLignePriceClient } from './pricing-ligne-client.js'
import { colorisKey, loadClientAssociations, loadColorisNames, loadRefGeo, type PalierAssocie } from './palier-associe.js'

/**
 * Côte lines to reprice after their molleton changed (LIVA #1217, Vincent
 * 2026-09-25: "if the quantity of molleton changes, the user should be
 * prompted"). When a molleton line is added, edited or deleted, the screen asks
 * which côte lines of the same coloris now price differently, shows them, and
 * applies the new prices only on a « oui ».
 *
 * A côte already invoiced (a ligne_expedition with est_facture = 1) is left
 * alone — its price is on a facture. A côte whose price was set by hand shows up
 * too, which is why nothing is ever written without asking.
 */

export interface CoteARevoir {
  IDligne_commande_client: number
  reference: string
  coloris: string
  quantite: number
  unite: number
  prix_actuel: number
  prix_nouveau: number
  /** The molleton band now applied, null when the côte falls back to its own. */
  palier_associe: PalierAssocie | null
}

const cents = (v: number) => Math.round(v * 100)

interface OrderLine { IDligne_commande_client: number; IDreference: number; IDcolori: number; quantite: number; unite: number; prix: number }

async function loadFiniLines(IDcommande_client: number): Promise<OrderLine[]> {
  // TYPE is a reserved word — written uppercase.
  const rows = await query<Record<string, unknown>>(
    `SELECT IDligne_commande_client, IDreference, IDcolori, quantite, unite, prix FROM ligne_commande_client ` +
      `WHERE IDcommande_client = ${IDcommande_client} AND TYPE = 2`,
  )
  return rows.map((r) => ({
    IDligne_commande_client: numOf(r.IDligne_commande_client),
    IDreference: numOf(r.IDreference),
    IDcolori: numOf(r.IDcolori),
    quantite: numOf(r.quantite),
    unite: numOf(r.unite),
    prix: numOf(r.prix),
  }))
}

async function invoicedLineIds(ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set()
  const rows = await query<{ IDligne_commande_client: number }>(
    `SELECT IDligne_commande_client FROM ligne_expedition WHERE IDligne_commande_client IN (${ids.join(',')}) AND est_facture = 1`,
  )
  return new Set(rows.map((r) => numOf(r.IDligne_commande_client)))
}

async function loadClient(IDcommande_client: number): Promise<number> {
  const rows = await query<{ IDclient: number | null }>(
    `SELECT IDclient FROM commande_client WHERE IDcommande_client = ${IDcommande_client}`,
  )
  return numOf(rows[0]?.IDclient)
}

/** The côte line's price as it should be now, or null when it can't be auto-priced. */
async function currentAutoPrice(IDclient: number, IDcommande_client: number, l: OrderLine) {
  const r = await calcLignePriceClient({
    type: 2, IDreference: l.IDreference, IDcolori: l.IDcolori, quantite: l.quantite, unite: l.unite,
    IDclient, IDcommande_client, IDligne_commande_client: l.IDligne_commande_client,
  })
  if (!r.priceable || r.prix == null || r.blocked) return null
  return { prix: r.prix, palier_associe: r.palier_associe }
}

/** Côte lines paired (same coloris) with one of the given molleton (ref,
 *  coloris) pairs whose auto price now differs from the stored one. */
export async function cotesARevoir(
  IDcommande_client: number,
  molletons: { IDref_fini: number; IDcolori: number }[],
): Promise<CoteARevoir[]> {
  const IDclient = await loadClient(IDcommande_client)
  if (!(IDclient > 0) || molletons.length === 0) return []
  const assoc = await loadClientAssociations(IDclient)
  const lines = await loadFiniLines(IDcommande_client)

  // Côte refs linked under any of the changed molletons.
  const coteRefs = new Set<number>()
  for (const m of molletons) for (const c of assoc.get(m.IDref_fini) ?? []) coteRefs.add(c)
  const candidates = lines.filter((l) => coteRefs.has(l.IDreference) && l.quantite > 0)
  if (candidates.length === 0) return []

  const geo = await loadRefGeo([...molletons.map((m) => m.IDref_fini), ...candidates.map((l) => l.IDreference)])
  const nameOf = await loadColorisNames(
    [...molletons.map((m) => ({ IDreference: m.IDref_fini, IDcolori: m.IDcolori })), ...candidates],
    geo,
  )
  const paired = candidates.filter((l) => {
    const key = colorisKey(nameOf(l))
    return key !== '' && molletons.some((m) =>
      (assoc.get(m.IDref_fini)?.has(l.IDreference) ?? false)
      && colorisKey(nameOf({ IDreference: m.IDref_fini, IDcolori: m.IDcolori })) === key)
  })
  const invoiced = await invoicedLineIds(paired.map((l) => l.IDligne_commande_client))

  const out: CoteARevoir[] = []
  for (const l of paired) {
    if (invoiced.has(l.IDligne_commande_client)) continue
    const now = await currentAutoPrice(IDclient, IDcommande_client, l)
    if (!now || cents(now.prix) === cents(l.prix)) continue
    out.push({
      IDligne_commande_client: l.IDligne_commande_client,
      reference: geo.get(l.IDreference)?.reference ?? '',
      coloris: nameOf(l),
      quantite: l.quantite,
      unite: l.unite,
      prix_actuel: l.prix,
      prix_nouveau: now.prix,
      palier_associe: now.palier_associe,
    })
  }
  return out
}

/** Write the recomputed price on the given lines of this order. Each line is
 *  re-priced here, never trusted from the browser; invoiced or unpriceable
 *  lines are skipped. Returns how many were updated. */
export async function appliquerReprix(IDcommande_client: number, ligneIds: number[]): Promise<number> {
  const IDclient = await loadClient(IDcommande_client)
  if (!(IDclient > 0)) return 0
  const wanted = new Set(ligneIds)
  const lines = (await loadFiniLines(IDcommande_client)).filter((l) => wanted.has(l.IDligne_commande_client) && l.quantite > 0)
  const invoiced = await invoicedLineIds(lines.map((l) => l.IDligne_commande_client))
  let updated = 0
  for (const l of lines) {
    if (invoiced.has(l.IDligne_commande_client)) continue
    const now = await currentAutoPrice(IDclient, IDcommande_client, l)
    if (!now || cents(now.prix) === cents(l.prix)) continue
    await query(`UPDATE ligne_commande_client SET prix = ${now.prix} WHERE IDligne_commande_client = ${l.IDligne_commande_client}`)
    updated++
  }
  return updated
}
