import type { QueryClient } from '@tanstack/react-query'

// Lot quality state (suivilot.IDetatLot) and roll state (stock_fini.IDetat_stock_fini)
// are shared by two screens that write to it independently:
//   • Sous-traitants › Commandes — réception, reprise, soumission (sets the lot
//     to "Attente Client"), and the computed phase pill.
//   • Qualité › Suivi des lots — the responsable's Valider / Reprendre verdict
//     (Reprendre also flags the lot's rolls).
// A change on either screen alters data the other renders, so both query
// families must be invalidated together. Without this, the global 5-minute
// staleTime (main.tsx) keeps the other screen on stale cache until a hard
// reload. invalidateQueries marks matching queries stale regardless of
// staleTime, so active queries refetch immediately and inactive ones refetch on
// their next mount.
export function invalidateLotQualityCaches(qc: QueryClient): void {
  // Qualité › Suivi des lots
  qc.invalidateQueries({ queryKey: ['suivi-lots'] }) // list (état pills)
  qc.invalidateQueries({ queryKey: ['suivi-lot'] }) // any open detail (footer pill, pièces)

  // Sous-traitants › Commandes — note these are distinct key roots (React Query
  // matches by array prefix, element-by-element, so each family is listed).
  qc.invalidateQueries({ queryKey: ['commandes-sst'] }) // list (computed phase pill)
  qc.invalidateQueries({ queryKey: ['commande-sst'] }) // detail
  qc.invalidateQueries({ queryKey: ['commande-sst-pieces'] }) // réception / affectés drawer (roll état badges)
  qc.invalidateQueries({ queryKey: ['commande-sst-lots-eligibles'] }) // soumission eligibility
  qc.invalidateQueries({ queryKey: ['commande-sst-urgency-counts'] }) // header urgency counts
}

// Where a roll/lot physically IS, and whether it is still available, is written
// by a dozen screens and read by the four stock screens plus the dashboard.
// None of the writers sit on the stock screens:
//   • Transferts — a bon moves stock_ecru/stock_fini/stock_fil.IDmagasin the
//     moment a piece is added to it (est_valide does NOT gate the movement).
//   • Clients › Expéditions — putting a roll on a shipment line sets
//     stock_fini.IDligne_expedition / stock_ecru.IDligne_expedition_ETM, which
//     is half of what "shipped" means, and divers items decrement quantities.
//   • Clients › Commandes — reserving a roll to an order line.
//   • Clients › Gestion › Marchandise — retour stock (clears the expedition,
//     demotes the état, releases the order line).
//   • Sous-traitants › Commandes — réception CREATES stock_ecru/stock_fini rows,
//     affectation sets IDref_commande_affectation.
// Ticket #1089: three pieces transferred MATEL → Ets Malterre still showed the
// old magasin on Finis › Stock, then "fixed themselves" — the global 5-minute
// staleTime (main.tsx) was serving the pre-transfer list until it expired.
//
// Cheap to call unconditionally: invalidateQueries only refetches queries that
// have a mounted observer, so naming a family no screen is showing just marks
// it stale for its next mount. Pass every family rather than guessing which
// one moved — a rouleaux bon carries écru AND fini, a réception writes both.
// Every query-key root whose data depends on where stock is / whether it is
// still available. `cache-sync.test.ts` diffs this against the `['stock-…']`
// keys actually used in the app, so a new stock family cannot quietly escape
// the helper the way the four screens escaped it before #1089.
export const STOCK_QUERY_ROOTS = [
  'stock-ecru', // Tombé Métier › Stock (list, detail, provenance)
  'stock-fini', // Finis › Stock
  'stock-fil', // Fils › Stock
  'stock-divers', // Divers › Stock
  'stock-valorisation', // dashboard — Valorisation du stock
  'suivi-piece', // dashboard — Suivi pièce (magasin + transferts)
] as const

export function invalidateStockCaches(qc: QueryClient): void {
  for (const root of STOCK_QUERY_ROOTS) qc.invalidateQueries({ queryKey: [root] })
}

// Freshness for the stock screens' own queries. `staleTime: 0` +
// `refetchOnMount: 'always'` means arriving on a stock screen always re-reads
// the warehouse (the screens unmount on navigation, so arriving IS the remount)
// — same idiom as CommandesDuJourWidget.
//
// This is the half invalidation cannot cover: **the legacy WinDev app writes
// these very tables live** (Phase 2 — both apps share the HFSQL data), as do
// other users' sessions. Nothing in this browser can invalidate those, so a
// 5-minute staleTime on a "where is my stock right now" screen is wrong on its
// own terms. Spread it into the list and detail queries, not the lookups
// (magasins/refs/coloris/états barely change and are worth caching).
export const STOCK_QUERY_FRESHNESS = {
  staleTime: 0,
  refetchOnMount: 'always',
} as const
