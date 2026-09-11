// Donation pieces — the stock side of a donation commande client (LIVA #1154).
//
// A donation commande has no ligne_commande_client rows: individual stock
// pieces point at it through stock_ecru.IDcommande_donation /
// stock_fini.IDcommande_donation. Attaching a piece IS the stock exit —
// there is never an expedition behind a donation (877 of the 888 legacy
// donation fini rolls carry no IDligne_expedition at all).
//
// The two catalogs leave stock differently, mirroring the legacy windows:
//
//   fini  — Finis › Stock (legacy FI_Stock_Fini and stock-fini.ts alike)
//           defines "in stock" as IDligne_expedition = 0 AND état 3 « Validé ».
//           The legacy FEN_Ligne_Donation window therefore stamped état 4
//           « Expédié » on every attached roll (its own picker offers
//           `IDetat_stock_fini = 3 OR IDcommande_donation = <this order>`,
//           which only makes sense if attached rolls have left état 3).
//           Until #1154 the NG picker wrote IDcommande_donation alone, so the
//           rolls of orders 3840 and 3868 stayed listed in Finis › Stock.
//   écru  — the legacy FI_Stock_TM_ETM simply excludes IDcommande_donation > 0;
//           no état column exists. Nothing else to write.
//
// Detaching (picker unchecks, or deleting the commande) restores état 3, but
// ONLY on a roll still in état 4 — the same rule as `unshipFiniRolls()` in
// expeditions.ts: another état is the magasin's own classification and is
// kept. Restore first, then clear the FK, so a crash between the two never
// leaves a roll in état 4 with no donation (the #1086 ghost).
//
// Pure SQL builders — unit-tested in donation-pieces.test.ts; the route runs
// the statements in order.

export type DonationKind = 'ecru' | 'fini'

export const ETAT_FINI_VALIDE = 3
export const ETAT_FINI_EXPEDIE = 4

const TABLE: Record<DonationKind, { table: string; pk: string }> = {
  ecru: { table: 'stock_ecru', pk: 'IDstock_ecru' },
  fini: { table: 'stock_fini', pk: 'IDstock_fini' },
}

/** Positive integers only, deduplicated, insertion order kept. */
function cleanIds(ids: readonly number[]): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  for (const raw of ids) {
    const x = Number(raw)
    if (!Number.isInteger(x) || x <= 0 || seen.has(x)) continue
    seen.add(x)
    out.push(x)
  }
  return out
}

/** Replace-set diff: `wanted` becomes the attached set. */
export function planDonationSet(
  current: readonly number[],
  wanted: readonly number[],
): { toAdd: number[]; toRemove: number[] } {
  const cur = new Set(cleanIds(current))
  const want = cleanIds(wanted)
  const wantSet = new Set(want)
  return {
    toAdd: want.filter((x) => !cur.has(x)),
    toRemove: Array.from(cur).filter((x) => !wantSet.has(x)),
  }
}

/** Statements that attach `ids` to `commandeId`. Fini rolls leave stock
 *  (état 4) in the same UPDATE as the FK. Empty when nothing to do. */
export function attachDonationSql(kind: DonationKind, commandeId: number, ids: readonly number[]): string[] {
  const clean = cleanIds(ids)
  const id = Number(commandeId)
  if (clean.length === 0 || !Number.isInteger(id) || id <= 0) return []
  const { table, pk } = TABLE[kind]
  const sets = kind === 'fini'
    ? `IDcommande_donation = ${id}, IDetat_stock_fini = ${ETAT_FINI_EXPEDIE}`
    : `IDcommande_donation = ${id}`
  return [`UPDATE ${table} SET ${sets} WHERE ${pk} IN (${clean.join(',')})`]
}

/** Statements that detach pieces from `commandeId` — `ids` given: those rolls
 *  only (picker uncheck); omitted: every piece of the commande (DELETE).
 *  Always scoped on IDcommande_donation = commandeId so a roll claimed by
 *  another donation since the dialog opened is never touched. */
export function detachDonationSql(kind: DonationKind, commandeId: number, ids?: readonly number[]): string[] {
  const id = Number(commandeId)
  if (!Number.isInteger(id) || id <= 0) return []
  const { table, pk } = TABLE[kind]
  let scope = `IDcommande_donation = ${id}`
  if (ids !== undefined) {
    const clean = cleanIds(ids)
    if (clean.length === 0) return []
    scope = `${pk} IN (${clean.join(',')}) AND ${scope}`
  }
  if (kind === 'ecru') return [`UPDATE ${table} SET IDcommande_donation = 0 WHERE ${scope}`]
  return [
    // 1. Roll back the stock exit on rolls we stamped (état 4 only).
    `UPDATE ${table} SET IDcommande_donation = 0, IDetat_stock_fini = ${ETAT_FINI_VALIDE} WHERE ${scope} AND IDetat_stock_fini = ${ETAT_FINI_EXPEDIE}`,
    // 2. Release whatever is left (rolls in another état keep it).
    `UPDATE ${table} SET IDcommande_donation = 0 WHERE ${scope}`,
  ]
}

/** Repair predicate for rolls attached before #1154 shipped: a fini roll on a
 *  donation, never shipped, still in état 3. Shared by the check script. */
export const DONATION_FINI_STRANDED_WHERE =
  `IDcommande_donation > 0 AND (IDligne_expedition IS NULL OR IDligne_expedition = 0) AND IDetat_stock_fini = ${ETAT_FINI_VALIDE}`

export function repairStrandedDonationSql(): string {
  return `UPDATE stock_fini SET IDetat_stock_fini = ${ETAT_FINI_EXPEDIE} WHERE ${DONATION_FINI_STRANDED_WHERE}`
}
