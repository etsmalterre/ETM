// ── TRM rapports — finance & chiffre d'affaires ───────────────────────────
//
// Mounted at `/api/rapports-trm`. The implementation is ETM's, verbatim:
// `upload_compta` / `compte_compta` and `facture` are partitioned tables whose
// two halves are the SAME OBJECT, so this is the `factures.ts` shape — one
// router factory, two scopes — and never a second aggregation over the same
// books. Everything société-dependent (including which permission store
// answers) lives in `FINANCE_SCOPE_TRM`.
//
// Consumers today are the four tableau de bord widgets:
//   Charges              → GET /finance          (dashboard_charges)
//   Analyse financière   → GET /finance/analyse  (dashboard_finance)
//   Chiffre d'affaires   → GET /ca-clients       (dashboard_ca)
//   Évolution du CA      → GET /ca-evolution     (dashboard_ca)
//
// `/finance/comptes/:id/*` is deliberately NOT mounted here — TRM has no
// Rapports › Finance screen yet, so there is nothing to edit a compte from.
// See `FINANCE_SCOPE_TRM` for what that screen will flip when it lands.
import type { Router as RouterType } from 'express'
import { createFinanceRouter, FINANCE_SCOPE_TRM } from '../lib/finance-common.js'

export const rapportsTrmRouter: RouterType = createFinanceRouter(FINANCE_SCOPE_TRM)
