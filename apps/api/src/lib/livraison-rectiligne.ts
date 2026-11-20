/**
 * Delivering cols / bandes by quantity (LIVA #1381, Nicolas Antonino,
 * 2026-11-18 : « expédier des pièces ou un lot de pièces quand j'ai une
 * commande de bandes et de cols, histoire de solder en allant les lignes »).
 *
 * A rectiligne order line (ligne_commande_client TYPE 4, lib/sst-line-kind.ts)
 * has no OF and no roll: nothing is weighed, nothing is stamped. What leaves
 * is a COUNT, typed by the person who ships it. One delivery = one avis
 * d'expédition of the order (`expedition`, société 2) with one
 * `ligne_expedition` per delivered line carrying `quantite` (migration 0082).
 * The avis is then invoiced like any other (routes/factures.ts).
 *
 *   livré d'une ligne  = Σ ligne_expedition.quantite of the line
 *   reste              = max(0, commandé − livré)
 *   ligne livrée       = commandé > 0 and livré ≥ commandé
 *
 * Delivering MORE than the remainder is allowed (a batch comes out a few
 * pieces over) and so is closing the order short: a rectiligne line never
 * blocks « Solder ». No stock is kept: `stock_rectiligne` has never held a row
 * and the cols land in ETM's own « stock de divers », which TRM does not write.
 *
 * Pure — no I/O. Callers: routes/commandes-trm.ts (« Livrer »),
 * routes/expeditions-trm.ts (the avis), routes/factures.ts (the invoice line).
 */

/** Quantities are pieces, or Kg for the one reference sold by weight (R005):
 *  two decimals, like every other quantity of the ledger. */
export function arrondiQuantite(x: unknown): number {
  const v = Number(x)
  if (!Number.isFinite(v)) return 0
  return Math.round(v * 100) / 100
}

/** What is still to deliver on a line. Never negative. */
export function resteALivrer(commande: unknown, livre: unknown): number {
  return Math.max(0, arrondiQuantite(arrondiQuantite(commande) - arrondiQuantite(livre)))
}

/** A line is delivered once everything ordered has left. A line ordered at 0
 *  is never « delivered »: there is nothing to tick off. */
export function ligneLivree(commande: unknown, livre: unknown): boolean {
  const c = arrondiQuantite(commande)
  return c > 0 && arrondiQuantite(livre) >= c
}

export interface LigneLivrable {
  IDligne_commande_client: number
  /** ligne_commande_client.TYPE — only 4 (rectiligne) is delivered by quantity. */
  type_kind: number
}

export interface DemandeLivraison { IDligne_commande_client: number; quantite: number }

export type LivraisonRefusee =
  | { error: 'livraison_vide'; message: string }
  | { error: 'ligne_inconnue'; message: string }
  | { error: 'ligne_non_rectiligne'; message: string }

/**
 * Checks a delivery request against the order's lines and returns what to
 * write: one entry per line, quantities of a line asked twice added up, zero
 * and negative entries dropped, in the order's line order.
 */
export function normaliserLivraison(
  demande: DemandeLivraison[],
  lignes: LigneLivrable[],
): { ok: true; lignes: DemandeLivraison[] } | ({ ok: false } & LivraisonRefusee) {
  const parId = new Map(lignes.map((l) => [l.IDligne_commande_client, l]))
  const cumul = new Map<number, number>()
  for (const d of demande) {
    const q = arrondiQuantite(d.quantite)
    if (!(q > 0)) continue
    const ligne = parId.get(d.IDligne_commande_client)
    if (!ligne) {
      return { ok: false, error: 'ligne_inconnue', message: "Une des lignes n'appartient pas à cette commande." }
    }
    if (Number(ligne.type_kind) !== 4) {
      return {
        ok: false,
        error: 'ligne_non_rectiligne',
        message: 'Seules les lignes de cols et de bandes se livrent par quantité : les rouleaux partent depuis l’onglet Affectation.',
      }
    }
    cumul.set(ligne.IDligne_commande_client, arrondiQuantite((cumul.get(ligne.IDligne_commande_client) ?? 0) + q))
  }
  if (cumul.size === 0) {
    return { ok: false, error: 'livraison_vide', message: 'Saisissez au moins une quantité à livrer.' }
  }
  return {
    ok: true,
    lignes: lignes
      .filter((l) => cumul.has(l.IDligne_commande_client))
      .map((l) => ({ IDligne_commande_client: l.IDligne_commande_client, quantite: cumul.get(l.IDligne_commande_client)! })),
  }
}

/** « 26 pièces », « 1 pièce », « 12,5 Kg » — the count as people read it on
 *  the avis and the screens. `unite` is ligne_commande_client.unite (1 = Kg). */
export function libelleQuantite(quantite: unknown, unite: unknown): string {
  const q = arrondiQuantite(quantite)
  const txt = q.toLocaleString('fr-FR', { maximumFractionDigits: 2 }).replace(/[  ]/g, ' ')
  if (Number(unite) === 1) return `${txt} Kg`
  return `${txt} pièce${q > 1 ? 's' : ''}`
}
