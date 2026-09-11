# ETM

## Project Overview

ETM is the next-generation ERP system for **ETS Malterre**, a French textile/knitting manufacturing company (bonnetterie/tricotage). This project migrates the legacy WinDev/HFSQL application to a modern web-based solution.

> **Note**: this project was called `MPS_NG` during the early migration period. It was renamed to **ETM** (the company's short code — `IDsociete` 1 = ETM, sister of **TRM** = 2) on 2026-07-30: repo, folder, and docs. One thing deliberately kept the old name because it is deployed infrastructure, not the project identity: the workspace package scope `@mps/*`. The production hostname was renamed on 2026-09-10 to `etm.intra.etsmalterre.com` (TRM `trm.intra.etsmalterre.com`, atelier PWA `atelier.intra.etsmalterre.com`, TRS tablet `trs.intra.etsmalterre.com`; HTTPS terminated by Caddy in front of nginx).

- **Company**: ETS Malterre — https://etsmalterre.fr
- **Industry**: Textile manufacturing (bonnetterie/tricotage — knitting)
- **Owner**: Vincent Malterre
- **Legacy system**: `C:\Mes Projets\MPS\` — WinDev (PCSoft) + HFSQL, French UI, 204 tables, 318 windows

## MPS — the platform, and why the API is not "ETM's"

**MPS = Malterre Productive System**: the shared platform every Malterre app runs on — the HFSQL `MPS` database and the **MPS API** (`mps-api.service`, `/home/debian/mps_api` on `10.10.20.3` — NOT the HFSQL box `10.10.20.2`, package `@mps/api`, `/api/health` answers `"app": "MPS API"`). Write "the MPS API", never "the ETM API" — that one word did real damage (see the ⚠️ in `etm_deploy` §Deploy ownership and TRM's `trm_deploy` §Scope).

- **ETM and TRM are two *clients* of the platform, not owner and guest.** ETM is `IDsociete` 1, TRM is 2, and the MPS API serves both from the same tables.
- **Other clients**: the atelier phones (`TRM/apps/atelier`, `/api/atelier` — bonnetier side, and since 2026-09-08 the régleur side: `GET /machines?regleur=1`, `GET /of/:id/reglage`, `GET/POST/DELETE /of/:id/messages`, `PUT /of/:id/consigne`; every régleur write checks `bonnetier.regleur = 1` on the named `IDbonnetier`, rules in `lib/atelier-regleur-trm.ts`), the TRS collector (`/api/recorder`, the only writer of `evenement_machine`), the **TRS wall tablet** (`TRM/apps/trs`, host `trs.intra.etsmalterre.com`, `GET /api/trs/atelier`, read-only; formula + tests in `lib/trs-trm.ts`, legacy source quoted in `~/.claude/plans/trs-atelier.md`; ⚠️ its « arrêts » pill is `arretsParPiece`, the per-PIECE `NombreArrets` averaged over the last 3 finished pieces of the active OF, NOT the shift count `calculerTrs.arrets`, which only feeds the deductibles). Planned: régleur app, bonnetier app, pointeuse, atelier screens. Dev CORS for the two PWAs (5176/5177) comes from `TRM_PWA_PORTS` in `scripts/worktree/lib.mjs`.
- ⚠️ **`apps/api` lives in this repo for historical reasons — a file location, not ownership.** A change needed by a TRM screen is a **normal change to this repo**, landed through an NG worktree. Deploying the MPS API from `/etm_deploy` deploys it **for every client at once** — smoke-check more than the app you are standing in. Whoever ships an app is responsible for the platform half it needs; "that's the other repo's job" is never the answer.
- **If the platform outgrows this**, extract `apps/api` into its own `MPS` repo with its own deploy. Not done — revisit when a third client ships.

## Branding

| Color | Hex | Usage |
|-------|-----|-------|
| **Primary Blue** | #143D6B | Sidebar, navigation, headers |
| **Vivid Gold** | #F2B80A | CTAs, highlights, active states |
| **Accent Blue** | #3B7DC9 | Links, alternative accent |

Full design system in `.claude/skills/mps_designer/SKILL.md`.

## Project Phases

- **Phase 1 — UI Shell**: complete.
- **Phase 2 — Database**: web app connects directly to HFSQL via ODBC. PostgreSQL migration abandoned (column casing); legacy scripts in `data_migration/`. WinDev app stays on HFSQL — both apps share live data.
- **Phase 3 — Features**: match legacy WinDev functionality screen by screen.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18 + TypeScript 5.7, Vite 6, Tailwind CSS 3.4 |
| UI | Radix primitives (shadcn-style), Lucide icons |
| State | TanStack React Query 5 |
| Monorepo | pnpm + Turborepo, Vitest |
| API | Express |
| Database | HFSQL Client/Server via `odbc` npm package |
| Auth | Cookie-based (HMAC-signed, no JWT lib) — `cookie-parser` |
| PDF | `@react-pdf/renderer` (server-side, Lato fonts bundled) |
| Excel | `xlsx` (SheetJS) — **client-side**, lazy `await import('xlsx')` so it's a separate chunk; API returns JSON, browser builds the `.xlsx` |
| Email | Gmail API via `googleapis` + domain-wide delegation |
| Tickets | LIVA issue tracker via server-side proxy `apps/api/src/routes/tickets.ts` (one router factory mounted twice: `/api/tickets/*` = `etm-erp`, `/api/tickets-trm/*` = `trm-erp`), widget `apps/web/src/components/tickets/`, **feature version 1.3.0** (spec + upgrade path: `issue_tracker_integration` skill). Every read is pinned to `product_slug` (the key is company-scoped), `resolu` counts as **open**, and an account without a mapped email still reports under a synthetic identity. Full rules: `claude_doc/screen_notes.md` § Tickets |

## Project Structure

Full file/directory tree with per-file annotations: **`claude_doc/project_structure.md`** (load when navigating the codebase layout).

## Navigation Structure

Mirrors the legacy WinDev main menu (top → bottom). **Per-screen rules, ticket post-mortems and data facts live in `claude_doc/screen_notes.md`** (one section per menu, same numbering) and, for the dashboard, in **`claude_doc/dashboard_widgets.md`**. Load the matching section before touching a screen; add new per-screen notes there, not here.

1. **Tableau de bord** (`/`) — per-user, permission-gated widgets (`dashboard_*` keys), several dashboards per user (tabs), `react-grid-layout` v2 with real (x, y) positions, layout saved in `data/user-profiles.json` scoped per app (`?app=etm|trm` — TRM renders this very screen with its own registry). Adding a widget = one entry in `components/dashboard/registry.tsx`. Widgets with their own doctrine (CA, Évolution du CA, Analyse financière + variation de stock estimée, Charges, Valorisation du stock [calcul actif, widget en sommeil], BFR [hors de portée], Notifications, Commandes du jour, État des stocks de fil [« Besoin » = réservation − déjà tricoté, #1139], Utilisation fil, Suivi pièce): `claude_doc/dashboard_widgets.md`. ⚠️ Finance widgets are bounded to the exploitation perimeter (PCG 60-64 / 70-74), the year-end point is a pre-closing balance, and `valorisation-stock.ts` is NOT dead code — it feeds the EBE.
2. **Prospects** — Demandes (`/prospects/demandes`, implemented) + devis prospect (LIVA #1112: shared Clients › Devis editor, `IDprospect > 0`, two default-closed permission keys).
3. **Clients** — Commandes, Devis, Facturation, Gestion. Two ledgers on `client` (`clients.ts` ETM / `clients-trm.ts` TRM, shared `lib/clients-common.ts`; **a router must never NAME a column the other fiche owns**). Compte client `411xxx` generation, SIREN, TVA-by-client, contract pricing (`lib/tarif-client.ts`, expired contract = 409 `contrat_expire`), client-scoped coloris picker, per-roll link when launching an ennoblisseur order (#1115), divers lines priced off `tarif_divers`, carton contents as a table (#1098/#1099), divers delivery note without prices (#1127), facturation over two shipment registers (#1117). Details: `screen_notes.md` § 3.
4. **Sous-traitants** — Commandes (ennoblisseur; `claude_doc/sous_traitants_status_model.md`), Gestion (`routes/sous-traitants.ts`).
5. **Transferts** — Rouleaux + Fils (`TransfertsScreen.tsx` via `kind`, `routes/transferts.ts`). ⚠️ The movement is immediate — `est_valide` does not gate it. Picker: server-side search (200-row cap), selection always a subset of visible rows (#1120), 2e choix hidden by default (#1119), consumed écru excluded and pieces affected elsewhere hidden (#1121), email recipient on `contact.envoi_bt` never `envoi_bl` (#1097). Details: `screen_notes.md` § 5.
6. **Fils** (`/fils/*`) — Références, Stock, Commandes, Gestion, Prévisions. « En commande » = what is still awaited, mirror of Rapports › Commandes fils (#1090, `lib/references-fil-agg.ts`).
7. **Tombé Métier** — Références (shared with TRM through `@etm`; per-app difference = the `obsOfEditor` prop, never a fork), rest placeholder.
8. **Finis** — Références (treatments attach/detach on the fiche in edit mode, `lib/traitements.ts`; `traitement_ref_fini` is a strict set → 409 `deja_associe`, unlike the Tarifs junction — #1136; Imprimer › Étiquette = the client-facing Dymo tag `EtiquetteRefFiniPdf.tsx`, **black & white only** — thermal printer — with the mono M inside a level-H QR, no options dialog), Stock, Études coloris (single `edit_etudes_coloris` key gates all writes, default closed — #1092), Tarifs (price simulator, `lib/pricing-ref-tarif.ts`, 46/46 legacy parity).
9. **Divers** — Références, Stock (`stock_divers` is SPARSE: zero rows hidden unconditionally, `POST` is an upsert).
10. **Qualité** — Suivi lots, Dossiers (Envoyer la FNC = handover creating the TRM `retour_client` row, idempotent), Actions (`lib/actions-qualite.ts`; matching rule validated on all 248 legacy rows; `mention_qualite` has an accented PK; archiving is manual by decision).
11. **Rapports** — Commandes clients / sst / fils (flat tables, `routes/rapports.ts`), Finance (balance N vs N-1, permission-gated `view_rapport_finance`, shared with TRM via `basePath`; routes in `lib/finance-common.ts`).
12. **Réseau** — Entreprises.
13. **Paramètres** — Utilisateurs (admin-only). **TRM has its own permission catalog + store** (`lib/permission-keys-trm.ts`, `/api/permissions-trm`); gate TRM routes with `trmUserHasPermission`, never `userHasPermission`, and any shared helper must take an explicit `PermissionScope` with no default. A key used by a TRM screen but absent from `TRM_PERMISSION_KEYS` fails silently — guard `check-permission-keys-trm.ts --web <TRM apps/web/src>`. **Menu / screen visibility is per user** (`claude_doc/auth_permissions.md` §Screen access): a menu is a grant (`screen_<menu>`), a screen inside it a hide (`hide_<menu>_<screen>`, read via `hasRaw()`); a curtain, not a lock. Grandfathering: `seed-screen-access.ts --write` on the server.

## Reference Documentation

Load these on demand when working on the matching topic:

| File | When to load |
|------|--------------|
| `claude_doc/project_structure.md` | Full file/directory tree with per-file annotations |
| `claude_doc/screen_notes.md` | **Per-screen rules and ticket post-mortems** for every menu (Prospects → Paramètres) + the Tickets widget — load the section for the screen you touch |
| `claude_doc/dashboard_widgets.md` | **Every dashboard widget's doctrine**: CA, finance (exploitation perimeter, EBE, variation de stock estimée), charges, valorisation du stock, BFR, notifications, commandes du jour, utilisation fil, suivi pièce |
| `claude_doc/hfsql_odbc.md` | HFSQL connection details, driver install, bridge, platform-specific SQL, accented columns — **and the full case history behind every rule in §HFSQL below** |
| `claude_doc/frontend_rules.md` | Full text behind §React rules below (stock-cache invalidation, dev-server failure modes) |
| `claude_doc/dev_setup.md` | Fresh-machine setup: HFSQL server/driver, `.env.development`, dev ports |
| `claude_doc/implemented_screens.md` | Canonical reference screens (Entreprises, Fournisseurs, Commandes, Stock) — grep first before inventing patterns |
| `claude_doc/auth_permissions.md` | Cookie auth picker, effective vs session admin, permission catalog, screen access (menu/screen visibility), admin guard |
| `claude_doc/pdf_email.md` | `@react-pdf/renderer` gotchas, Gmail DWD setup, per-document email endpoint pattern — **and how to verify a PDF you changed** (rasterize, or assert on the element tree; read this BEFORE inventing a way to check your output) |
| `claude_doc/legacy_tables.md` | All 204 HFSQL tables with fields |
| `claude_doc/legacy_windows.md` | All 319 windows + 49 reports |
| `claude_doc/navigation_mapping.md` | Legacy windows → ETM routes |
| `claude_doc/business_glossary.md` | Domain vocabulary, production flow |
| `claude_doc/sous_traitants_status_model.md` | Sst commandes computed-phase model, card urgency frames + pills, Soumission Lot Client flow, Historique tab, Reprise flow, type_doc codes |
| `claude_doc/worktrees.md` | Parallel dev with git worktrees, **multi-project** (ETM `300N`/`808N` + TRM `517N`, disjoint slots): slot model (incl. reserved **slot 0** = serve `master` via `/serve-main`), the `/new-feature-worktree [ng\|trm]` · `/feature-checkpoint` · `/feature-complete` · `/worktree-status` skills (project auto-detected from the invoking repo; run TRM worktrees from the TRM checkout), concurrency-safe shared registry, merge discipline, **§Shared-API changes**: TRM features needing endpoints use a *paired NG worktree* (API lands via NG's pipeline; deploy ownership: `/etm_deploy` = shared API + NG web → `etm.intra.etsmalterre.com`, `/trm_deploy` = TRM web only → `trm.intra.etsmalterre.com`) |

## HFSQL rules (footguns — always apply)

One or two lines per rule. **The incident, the measurements, the canonical file and the guard script for each are in `claude_doc/hfsql_odbc.md` § Footguns** — read that entry before touching the area, and add the story of a new footgun there with a one-liner here.

**SQL dialect**
- **No parameterized queries**: `?` fails. Interpolate with `esc()` for strings, `parseInt` for ids, hex literals `x'…'` for blobs. **No `RETURNING *`**: follow-up `SELECT`.
- **Booleans are `0`/`1`**: in React always `!!value &&`.
- **Reserved-word columns come back uppercased** (`type` → `TYPE`, `date` → `DATE`): always alias, and write `DATE` uppercase in WHERE/ORDER BY.
- **Empty FK columns store `0`, not `NULL`**: predicate `(col IS NULL OR col = 0)`, never `IS NULL` alone.
- **JOIN + `CONVERT()` collapses the result set to one row** (also single-table when the column is empty on some rows): split into flat queries, merge in JS.
- **BinMemo `IS NOT NULL` is unreliable**: file endpoints 404 on an empty buffer; UI does a HEAD pre-check.
- **Avoid accents in HFSQL table names and backup folder names** ("fichier de données est déjà décrit").

**Accents and encoding**
- **Accented identifiers are platform-specific**: the Linux bridge rejects them, Windows silently returns 0 rows on `alias.*` joins. Branch on `IS_WINDOWS`; canonical `routes/stock.ts`. Truncation is in the driver — the "Latin-1 bridge" idea is a dead end.
- ⚠️ **Resolve accent-mangled `SELECT *` keys with a `/^prefix/i` regex, never a fallback list** (`pickVal` / `stripKeys` in `lib/accented-keys.ts`): the truncated key carries a garbage trailing byte, so `row.termin ?? row['terminé']` reads 0 for every row in prod (shipped three times, #1090). Read by prefix, strip by prefix, then assign the ASCII key.
- **Writing accented columns on Linux**: never name them — positional `INSERT` in runtime column order (`max+1` PK), delete-by-ASCII-key + reinsert to edit (`references-fil.ts`); with an ASCII PK, full-row positional rewrite keyed on it (`dossiers-qualite.ts` `patchAccented()`). Read accented-NAMED columns through `queryB64Text()`.
- ⚠️ **The `.xdd` column order is NOT what a positional INSERT needs** — probe the runtime `SELECT *` order first (`piece_production` differs, silently writing a piece number into `bonnetier_debut`). Positional only when a reserved word or an accent forces it.
- **Encoding (reads)**: `fixEncoding()` / `CONVERT(field USING 'UTF-8')`, **batched** per column on lists (per-row CONVERT floods the bridge; `stock-fini.ts repairAliased`).
- **Encoding (writes)**: emit accented values as Latin-1 hex literals (`sqlText()` in `commandes-sous-traitant.ts`), ASCII as quoted literals. The helper is lossy above Latin-1 (em-dash → `-`), so assert round-trips on Latin-1 text only.
- ⚠️ **A user-typed search term is a write too**: map non-ASCII to `_` in `LIKE` patterns (`likePattern()` in `routes/transferts.ts`) and re-apply the exact accent-folded test client-side. `stock-ecru.ts` / `stock-fini.ts` / `stock.ts` still interpolate raw — port when touched.
- ⚠️ **`ligne_commande_sous_traitant.sstatut`: never compare to `'Terminé'`** — match the ASCII prefix (`NOT LIKE 'Termin%'`, `SUPPLY_NOT_DONE`, `isLineDone()` = `startsWith('Termin')`). Filter sst lines by "not done", never by an allowlist of open statuts (12 live values).

**Outages**
- ⚠️ **A query naming a non-existent column = prod outage on Linux** (respawn storm on the shared HFSQL server `10.10.20.2`, hangs mfprod too). `WHERE col = NaN` storms identically — `fixEncoding`'s `idField` must be selected by the feeding query (and a missing `idField` silently keeps the U+FFFD glyph, which a re-save or a PDF turns into a literal `?` — #1137/#1145/#1146; guard `check-fixencoding-idfield.ts`). Verify prod via `https://etm.intra.etsmalterre.com`, never `localhost:8081`; don't hammer-restart.
- ⚠️ **Never SELECT `ordre_fabrication.interruption_prod`** (the only *Durée* column: bridge emits unquoted text → invalid JSON, every OF route 500s in prod while Windows passes).

**Binary / memo columns**
- **Windows driver + memo-binary column = 0 rows** on `SELECT` naming a blob or `SELECT *` on a table holding one (`stock_fil`, `client`); probe with `LENGTH(col)`. Not universal (`bonnetier.photo` reads fine; `machine` has no memo) — probe the specific column, keep single-row `WHERE` shapes. MEMO text columns cost per row: select them only for returned rows (`stock-fil-trm.ts fetchBaseRows`).
- ⚠️ **A binary read needs `queryRaw`, never `query`** (`cleanRow` decodes buffers as UTF-8); verify magic bytes, 404 otherwise; resize with `sharp` (`.rotate()` first). Canonical `prime-trm.ts` photo route.
- **`commande_sous_traitant`: `commentaire` is RTF (`stripRtf()`/`wrapRtf()`), `journal` is plain text** (`sqlText()`).

**Sociétés, partitions and route families**
- **`IDsociete` partitioning** (1 ETM / 2 TRM / 3 Confection) on `client`, `commande_client`, `facture`, `devis`, … — every ETM INSERT sets it (`IDsociete = 0` rows are invisible in legacy). `stock_fil` is NOT partitioned (`IDclient` names the owner).
- **Serving a partitioned table**: different objects → two route files; same object → **one router factory mounted twice** with a scope record (`createFacturesRouter(scope)`, `createFinanceRouter(scope)` in `lib/finance-common.ts`). Never fork; never add `?societe=`. A scope record holding a permission checker declares it as a **method** + `satisfies PermissionKey`, and every `:id` handler checks the row's partition (**404**, not 403) — `inScope()` in `factures.ts`.
- ⚠️ **`client` has ONE `IDtva` / `IDcode_comptable` for all three companies** while `tva` / `code_comptable` are partitioned: re-home into the writing société (`clientBillingDefaults()`), never copy verbatim.
- **Two route families per company, don't unify**: `stock-ecru.ts` / `stock-ecru-trm.ts` (ETM reservation on `IDligne_commande_client`, TRM on **`IDLigne_Commande_TRM`**; "in stock" differs too), `commandes-client.ts` / `commandes-trm.ts`, `expeditions.ts` / `expeditions-trm.ts` (`expedition_divers` has no `IDsociete` — ETM-only). Shared helpers are **exported** from the ETM file, never duplicated.
- **ETM↔TRM bridge**: a tricoteur sst to Tricotage Malterre (`IDsous_traitant = 1`, `isTricotageMalterreSst`) auto-mirrors a TRM `commande_client` (`IDcommande_ETM`). ⚠️ **The mirror is one-way and READ-ONLY on the TRM side** (`refuseIfMirror`, 409) — two exceptions with their own routes: the **état** (`PUT /commandes-trm/:id/etat`, closes only when every OF is done and every roll shipped; the sst then shows « Soldée par TRM », never closes itself) and the **délai** (`PUT /commandes-trm/lignes/:id/delai` writes both ledgers via `sstDelaiSets`).
- ⚠️ **Shipping to ETS Malterre CHANGES a TRM piece's owner at « Expédier »** (`IDsociete` 2 → 1, `lot = 'trm<IDexpedition>'`, `stampShippedPieces()` / `releaseShippedPieces()` in `expeditions-trm.ts`). Hence: queries listing "what was shipped" must NOT filter on `IDsociete`, and **counting TRM production means `IDordre_fabrication > 0`, NOT `IDsociete = 2`** (`prime-trm.ts`, any TRS/rapport query).
- **`ordre_fabrication`, `machine`, `operation_maintenance` & friends are TRM-only with NO `IDsociete`**: `of-trm.ts` + `visitage-trm.ts` (the only writer of TRM `stock_ecru`; reserves 1er choix only, #1129) over `lib/production-trm.ts`; `maintenance-trm.ts` (`SET` must name only maintenance columns; real column names `observation_maintenace`, `comm_pulsonque`; "Description" = `machine.commentaire`). Every write route carries its own TRM permission guard — **there is no global auth middleware**, an unguarded route is anonymous. `priorite` ranks within one métier, `POST /:id/terminer` owns the auto-activation flip. Réalisé = `Σ stock_ecru.poids`, never IDsociete-filtered.

**Money, pricing and quantities**
- ⚠️ **Round the unit price to the centime BEFORE multiplying** (`lineMontant()` / `round2()` in `factures.ts`), on every surface — 13/14 legacy invoices reproduced vs 4/14 with raw products.
- **Ennoblisseur lines (sst `type=2`)**: `quantite` = Ml, `prix` = €/Kg, € = `Σ stock_ecru.poids × prix`; auto via `pricing-sst.ts`. **Tricoteur lines (`type=1`)**: kg × €/Kg; auto via `pricing-trm.ts trmLinePrix`.
- ⚠️ **`pricing-trm.ts` has ONE retained-price rule**, the legacy `max(cost/0.7, base)` (the base is a floor on the *sale* price, retained flat): the ETM→TRM bridge and `/commandes-trm/lookups/line-price` quote the same number. A second `'cost-floor'` rule (`max(cost, base)/0.7`, ~+39 %) lived on the TRM suggestion from 2026-08-26 to 2026-09-11 and was retired on LIVA #1151 — do not bring back a per-caller role. `prixDeRevientTRM` is the *cost* (margin chip), never a price. `retainedFrom` compares the base to the MARGED cost. The legacy TRM window computes no price at all — a gap is expected.
- **Clients › Commandes: a line's price depends on the CLIENT** (`lib/tarif-client.ts`; expired contract blocks, 409 `contrat_expire`); **divers lines** price off `tarif_divers`, never re-derive a stored price. ⚠️ **A contract price is in the reference's selling unit: €/Ml on a fini, €/Kg on a tombé de métier** (always sold by the Kg — never × rendement, #1144; `contratPriceFn` + `calcTarifRefEcru`).
- ⚠️ **Prime TRM rates are dated** (`lib/bareme-prime-trm.ts`, semester boundaries 15/06 & 15/12; never edit a past line) and the **répartition includes the régleurs** (user decision 2026-08-25). Any retroactive barème (rouloir threshold 15 000 Kg) gets the same date-effective shape.

**Data semantics**
- ⚠️ **"A roll is shipped" is TWO facts** — `stock_fini.IDligne_expedition > 0` AND `IDetat_stock_fini = 4`; a return must clear both and release `IDligne_commande_client` (#1086, `POST /:id/marchandise/retour-stock`, guard `check-retour-marchandise.ts`). **Deleting an avis or removing a roll from it clears both too** but KEEPS the line affectation (`unshipFiniRolls`, guard `check-expedition-unship.ts`).
- **Per-table polymorphism**: `ged` multi-parent, lcsst `IDreference` × 3 catalogs, fini `IDColoris` by `ref_fini.avec_teinture` (0 → `colori_ecru`, 1/2 → `ref_fini_colori`), `defaut_qualite.Type_Reference`, `envoi_email.IDreference` by `IDtype_doc` — `claude_doc/hfsql_odbc.md`.
- ⚠️ **`defaut_qualite.reference` is NOT disambiguated by `Type_Reference`** (an id resolves in both `stock_ecru` and `stock_fini`): only read it filtered by écru ids you already hold; fini defects live on the roll (`observation_sst`, `second_choix`). **`taille_cm` is NOT centimetres** — the size qualifier is in `description`; count-shaped defects use `nombre`.
- **A DATETIME's text shape differs per driver** (`'2025-11-24 19:58:40.412'` vs `'20251124195840'`): always `parseDtMs()` (`lib/production-trm.ts`), never `SUBSTR` on a date.
- **Cutting a roll (fini or écru): the remainder KEEPS the numero, each cut-off piece gets `<base>-N` with N = max existing suffix + 1** (first cut `-1`, legacy MAX rule; `lib/roll-cut.ts`, #1135). ⚠️ `numero LIKE '<base>-%'` also returns the bare `<base>` on the driver — test the digits after the dash in JS, never trust the LIKE alone.
- **Recovering a PCS-compressed WinDev window**: compile cache first (`MPS.cpl\<user>\00000000\<Window>.<hash>.wdw.{wcw,wbw}` — literals, SQL, field inventory), then the Android `GWDF*.java`. Integer thresholds survive neither: **ask the user** (they have WinDev open) before measuring from data.

**Connection**: `DRIVER={HFSQL};Server Name=localhost;Server Port=4900;Database=MPS;UID=Admin;PWD=;`

## React / frontend rules

Full text and incident history: `claude_doc/frontend_rules.md`.

- **Hooks before early returns** — violating this crashes production builds (React #310).
- **`useElementSize` returns a CALLBACK ref, deliberately** — a `useRef` + effect never attaches on a conditionally rendered target. Don't simplify it back.
- **A guard must never decide while its permission fetch is in flight**: render nothing until `usePermissions().isLoading` is false (bit `AppShell` and the admin guard).
- **Shared `apiFetch`** (`apps/web/src/lib/api.ts`, `credentials: 'include'`) — never a per-page fetch.
- ⚠️ **A screen that MOVES stock must call `invalidateStockCaches(queryClient)`** (`lib/cache-sync.ts`) unconditionally for every family, and **the four stock screens spread `STOCK_QUERY_FRESHNESS`** (`staleTime: 0` + `refetchOnMount: 'always'`) into list and detail queries — the legacy app and other sessions write these tables live (#1089). Guard `cache-sync.test.ts`. Don't "optimise" it back.
- **SW denylist for `/api/`** (`navigateFallbackDenylist`) — never remove.
- **Modifier button = `variant="gold"`**, always.
- **Stale `.js` build artifacts**: web `build` is `tsc --noEmit && vite build`, **never `tsc -b`**. Symptom white screen / edits not showing → delete stray `.js`/`.d.ts` AND restart Vite.
- **"The page loads forever" in dev = a wedged HFSQL connection, not your code** (`/api/health` 200, data routes 500 after exactly 15 s, right after a burst of API edits). Run `node scripts/worktree/status.mjs` first; fix with `node scripts/worktree/up.mjs <feature> --restart`. A `503` on `/api/*` = the worktree's API is down. A `ReferenceError: <Import> is not defined` with clean source and `tsc` = stale dev-server module graph → restart.

## Design system rule

**Before building or modifying any user-facing screen, component, button, tab, card, dialog, or interaction pattern, you MUST invoke the `mps_designer` skill (`Skill(skill: "mps_designer")`).** Not optional. It encodes every UI/UX convention — colors, layouts, detail-header button trios, placeholder dialogs, drawers, deadline indicators, status footers, etc.

**Invoke the skill when**: building a new screen; adding a button/tab/card/dialog to an existing screen; touching anything the user describes in visual terms ("add a print button", "make it red", "slide a drawer in"); deciding a color/icon/size/spacing/shape.

**Before inventing a pattern, grep the gold-standard reference screens**: `Entreprises.tsx`, `FilsGestion.tsx`, `FilsStock.tsx`, `FilsCommandes.tsx`, `EtudesColoris.tsx`. Existing screens almost always have the pattern — use the exact same icon, strings, and dialog structure. See `claude_doc/implemented_screens.md` for what each reference covers.

**Core visual language**: panel backgrounds `bg-zinc-100/80` (list/sidebar) / `bg-zinc-200/50` (header/footer) / `bg-white` (cards), `scrollbar-transparent` on scrollable panels. **Never hardcode hex values** — use Tailwind CSS variable classes (`text-accent`, `bg-primary`, `border-gold/30`). Colors in §Branding above.

**Typography**: OS system stack via `system-ui` (`font-sans` = `font-heading`). **No web fonts** — no `@import`/`<link>`/`@font-face`. Heading: `<h1 className="text-3xl font-heading font-bold tracking-tight">`. Header gradient: `bg-gradient-to-r from-gold/40 via-gold/15 to-transparent`. **Do not re-add Google Fonts `@import`** (earlier Anton/Lato attempts silently broke). See `mps_designer §2`.

**Edit mode pattern** (follow `Entreprises.tsx`): `isEditing` toggle, gold "Mode edition" badge, `border-l-4 border-l-accent/70 bg-accent/[0.03]` on editable cards, hover-reveal actions (`opacity-0 group-hover:opacity-100`), `LabeledInput` + `InlineForm` components.

**Layout**: 3-panel `MasterDetailLayout` for master-detail screens (left `w-72`, right `w-96`, responsive full/compact/stacked). Table-centric screens do NOT use `MasterDetailLayout` — see `FilsStock.tsx`.

**Status management**: user-controlled primary state goes to the **sidebar footer pill** (not a header badge), regardless of how many values it can take. Binary → split toggle button (`FilsCommandes`); 3+ values → menu button + popover (`EtudesColoris`). See `mps_designer §29`.

**"+ Nouveau" button**: bottom of every master-detail left list, **view mode only** (`{!isEditing && ...}`). Either inline-creates a placeholder row or opens a small initial-data modal (pick per whether the row needs data up front). After save: `setSelectedId(newId)` + auto-enter edit. `FilsStock` exempt (table layout). Full rules: `mps_designer §5`.

**Sidebar logo**: `public/logo-full.png` (expanded, `h-10 mx-auto`) / `public/logo-small.png` (collapsed, `h-8 mx-auto`).

## Versioning

- **Single source of truth**: `version` in the **root** `package.json` (currently the app-wide version, e.g. `0.1.0`). The web build injects it as `__APP_VERSION__` (see `apps/web/vite.config.ts` + `vitest.config.ts` `define`) and displays it in the header profile menu, which also holds the "Actualiser l'application" button (SW update + reload).
- To release a new version: bump the root `package.json` version, then deploy. The per-package versions in `apps/*/package.json` are not displayed anywhere - no need to keep them in sync.

## Conventions

- **Code**: English. **UI**: French. **Comments**: English.
- **"check last screenshot"** → read the latest file in `%USERPROFILE%\Pictures\Screenshots` (i.e. `C:\Users\<current-user>\Pictures\Screenshots` — `vince` on the factory PC, `malte` on the laptop)
- **Related project**: ETM follows the architecture of **MFProd_NG** (`C:\dev\etsmalterre\mfprod\mfprod_erp`) — same tech stack, same layout patterns, different branding (gold vs orange) and domain (textile vs fencing).
- **Where documentation goes**: `CLAUDE.md` holds rules that apply to every session, one or two lines each. The story behind a rule, a screen's post-mortem, a widget's doctrine go to the matching `claude_doc/*.md` (see §Reference Documentation). Keep this file under ~40 KB.

## Quick Start

```bash
pnpm install
pnpm dev          # start dev servers
pnpm build        # build all packages
pnpm test         # run tests
```

Fresh-machine setup (HFSQL server, ODBC driver, `.env.development`, dev ports): see `claude_doc/dev_setup.md`.

## Business Domain (Quick Reference)

Full glossary in `claude_doc/business_glossary.md`.

| French | English |
|--------|---------|
| Bonnetterie | Hosiery/Knitwear |
| Tricotage | Knitting |
| Teinture | Dyeing |
| Confection | Assembly/Manufacturing |
| Matières premières | Raw materials |
| Produits finis | Finished goods |
| Sous-traitant | Subcontractor |
