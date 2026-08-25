// ── TRM rapports — finance & chiffre d'affaires ───────────────────────────
//
// Mounted at `/api/rapports-trm`. The implementation is ETM's, verbatim:
// `upload_compta` / `compte_compta` and `facture` are partitioned tables whose
// two halves are the SAME OBJECT, so this is the `factures.ts` shape — one
// router factory, two scopes — and never a second aggregation over the same
// books. Everything société-dependent (including which permission store
// answers) lives in `FINANCE_SCOPE_TRM`.
//
// Consumers:
//   Rapports › Finance   → GET /finance                        (view_rapport_finance)
//                          GET /finance/comptes/:id/historique
//                          PATCH /finance/comptes/:id          (+ edit_compte_description)
//   Charges              → GET /finance          (dashboard_charges — same payload,
//                                                 any-of with the screen's key)
//   Analyse financière   → GET /finance/analyse  (dashboard_finance)
//   Chiffre d'affaires   → GET /ca-clients       (dashboard_ca)
//   Évolution du CA      → GET /ca-evolution     (dashboard_ca)
//
// The screen is ETM's file, imported by the TRM web through its `@etm` alias
// with `basePath="/rapports-trm/finance"` — the one thing that differs between
// the two mounts on the frontend, as `FinanceScope` is on the backend.
import type { Router as RouterType } from 'express'
import { createFinanceRouter, FINANCE_SCOPE_TRM } from '../lib/finance-common.js'

export const rapportsTrmRouter: RouterType = createFinanceRouter(FINANCE_SCOPE_TRM)
