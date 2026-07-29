# MPS Next Generation

## Project Overview

MPS_NG is the next-generation ERP system for **ETS Malterre**, a French textile/knitting manufacturing company (bonnetterie/tricotage). This project migrates the legacy WinDev/HFSQL application to a modern web-based solution.

> **Note**: `MPS_NG` is a temporary name used during the migration period. Once the legacy WinDev app is fully migrated, this project will be renamed to simply **MPS**.

- **Company**: ETS Malterre — https://etsmalterre.fr
- **Industry**: Textile manufacturing (bonnetterie/tricotage — knitting)
- **Owner**: Vincent Malterre
- **Legacy system**: `C:\Mes Projets\MPS\` — WinDev (PCSoft) + HFSQL, French UI, 204 tables, 318 windows

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
| Tickets | LIVA issue tracker (product `etm-erp`) via server-side proxy `apps/api/src/routes/tickets.ts` (`/api/tickets/*`, env `ISSUE_TRACKER_URL/_API_KEY/_PRODUCT_SLUG` — required in prod env too); widget `apps/web/src/components/tickets/` + header trigger, screenshot via lazy `html-to-image`. **Widget feature version 1.1.1** (spec + upgrade path: `issue_tracker_integration` skill) — "Mes tickets" collapses closed tickets into a drawer, and the header trigger carries a red unread badge computed from `localStorage` signatures per user (`useTicketNotifications.ts`, **no DB change**). Two scoping rules: `resolu` counts as **open** (fixed but its release hasn't shipped — the tracker flips it to `ferme` on publish, and only then does it belong in the drawer), and every read is pinned to `product_slug` because the tracker API key is *company*-scoped (without it a reporter using the same email in MFProd sees MFProd tickets here) |

## Project Structure

Full file/directory tree with per-file annotations: **`claude_doc/project_structure.md`** (load when navigating the codebase layout).

## Navigation Structure

Mirrors the legacy WinDev main menu (top → bottom):

1. **Tableau de bord** (`/`) — widgets per-user permission-gated (`dashboard_*` keys); toggled in Paramètres › Utilisateurs. **Permission decides availability, the user's layout decides display**: "Personnaliser" enters an edit mode with **direct manipulation only — no per-widget control panel**. The desktop grid is **`react-grid-layout` v2** (`GridLayout` + `verticalCompactor`): every widget has a real **(x, y) position** plus size (`width` 1-12 cols, `heightPx`), the whole card is the drag handle (`dragConfig.cancel: '.widget-no-drag'` exempts the hide-eye), edges/corner resize (`resizeConfig.handles: ['e','s','se']`, gold bars styled in `index.css` under `.dashboard-grid`), and dragging shows the library's live placeholder while vertical gravity compacts everything upward — which is what lets a widget sit in the right column under a short neighbour while a tall one fills the left (the earlier order-based flow model could NOT express that; don't regress to it). Hide via the hover-revealed eye; re-show by clicking the tray chip. Below `lg` the grid is bypassed: plain single-column stack ordered by (y, x) with **definite** pixel heights (with `auto` a scrolling widget body never engages and the card grows to its full content). Persistence: `x`/`y` stored per widget (optional in the API schema — pre-positional layouts are shelf-packed at load); saved layouts are normalised through the same vertical compaction so loading isn't already "dirty". **Vite gotcha**: react-draggable inside RGL reads `process.env.DRAGGABLE_DEBUG` — `vite.config.ts` defines it, else the browser throws "process is not defined" on first drag. The trigger and the edit-mode buttons live in the **app header** via the screen-actions slot (`contexts/HeaderActionsContext.tsx`, `mps_designer §3`) — zero vertical cost, and the header is sticky so Enregistrer survives scrolling; right-click on the dashboard background is a secondary accelerator (gated to the background so widget text stays copyable). Saved per user in `data/user-profiles.json` (`GET`/`PUT /api/user-profiles/me/dashboard`); a layout equal to the defaults is stored as `null` so the user keeps tracking future default changes. Adding a widget = **one entry** in `apps/web/src/components/dashboard/registry.tsx` — a widget the saved layout doesn't mention is appended visible, so a stale layout can never hide a newly granted one. Widgets render `<WidgetFrame>` (shared gold header + edit strip) and read `useWidgetChrome()` for their height preset. **Chiffre d'affaires** (`dashboard_ca`, gated on the API too — confidential): ports legacy *Comparatif CA* + *Rapport CA/Client*. Formula reverse-engineered from the data (WinDev sources are PCS-compressed): `CA = Σ round2(ligne_facture.quantite × prix)` over `facture` with `IDsociete = 1`, **`facture.TYPE = 2` (avoir) negated**, accumulated in integer centimes. Route `apps/api/src/routes/rapports.ts` (`/ca-clients`, `/ca-mensuel`); regression check `apps/api/src/scripts/check-ca-legacy-parity.ts`
2. **Prospects** (renamed from legacy "Marketing") — **Demandes** (`/prospects/demandes`; catalogue requests from the `prospect` table; master-detail, implemented)
3. **Clients** — Commandes, Devis, Facturation, Gestion
4. **Sous-traitants** — **Commandes** (ennoblisseur; see `sous_traitants_status_model.md`), **Gestion** (`/sous-traitants/gestion`, implemented; master-detail mirror of FilsGestion over `sous_traitant`+`type_sst` with contacts/adresses — route `apps/api/src/routes/sous-traitants.ts`)
5. **Transferts** — placeholder
6. **Fils** (route `/fils/*`, renamed from `/fournisseurs/*`) — Références, Stock (table-centric), Commandes, Gestion, Prévisions
7. **Tombé Métier** — placeholder, custom `TmRollIcon`
8. **Finis** — Références, **Stock** (implemented, table-centric; edit-mode multi-select + cut-roll via `POST stock-fini/:id/cut`), **Études coloris** (implemented), **Tarifs** (implemented) — custom `FiniRollIcon`. **Tarifs** is the price *simulator* (ports legacy `FI_Tarifs.wdw`): a `ref_tarif` row is a standalone what-if record with its own composition (`asso_fil_tarif`, whose `prix` is a per-simulation **snapshot** the user overrides — never a live read of `ref_fil.prix_kg`) and its own treatments (`asso_traitement_tarif`, same treatment may repeat). Pricing lives in `apps/api/src/lib/pricing-ref-tarif.ts`; it shares the catalog pricer's tranches/margins/majorations but with two reverse-engineered differences: the ennoblissement uplift is the manual `ref_tarif.multiplicateur`, **not** the rendement-derived MATEL multiplier, and the knitting price is the typed `prix_tricotage` rather than `ref_ecru.prix`. Dye mode is driven by `IDteinture` (0 = sans; `simple_teinture` splits simple/double, `designation_interne` splits Blanc/Tous Coloris) — `avec_teinture` on this table is a vestigial copy of the source ref. `ok_tarif` = 1 means archivée. `POST /tarifs-fini/:id/preview` prices **unsaved** parameters so the right panel recalculates live while editing (debounced). Route `apps/api/src/routes/tarifs-fini.ts`; parity check `apps/api/src/scripts/check-ref-tarif-parity.ts` (46/46 exact vs the legacy screen)
9. **Divers** — **Références** (`/divers/references`, implemented; `ref_divers` catalog with two variation axes + per-combination `tarif_divers` pricing — see `claude_doc/implemented_screens.md`)
10. **Qualité** — **Suivi lots** (implemented), **Dossiers** (`/qualite/dossiers`, implemented; non-conformity dossiers over `dossier_qualite` + FNC round-trip + piece traceability — route `apps/api/src/routes/dossiers-qualite.ts`), Actions, Analyse (placeholders)
11. **Rapports** — **Commandes clients**, **Commandes sst**, **Commandes fils** (all three implemented). Flat read-only line-level tables sharing one shape (Tableau layout, no page title, sticky sortable header, row tint red=late / amber=soon, Excel export with a per-user localStorage column picker), all served by `apps/api/src/routes/rapports.ts`. `commandes-fil` scopes like legacy `FI_Rapport_fil.wdw` (open lines of open commandes) and derives a phase per line — attente délai / en cours / réception partielle / reçue / terminée — measuring urgency against `ref_fil_commande.date_notif` while waiting for a délai and `date_livraison` afterwards. **Finance** (`/rapports/finance`) is the odd one out: it ports legacy `FI_Analyse_Finance.wdw` (Analyse › Finance) as a balance comptable rather than a line-level table, with a Charges fixes / Charges variables toggle and an N vs N-1 comparison over `upload_compta` + `compte_compta` + `releve_compta`. Amount for a year = `debit - credit` at the **last upload of that calendar year** (uploads are cumulative YTD, so never sum them, and never take January's upload which closes the prior exercise); class-7 accounts are produits and are excluded. It is the only rapport that is **permission-gated** (`view_rapport_finance`, child `edit_compte_description`) because the balance names payroll accounts

12. **Réseau** — Entreprises
13. **Paramètres** — Utilisateurs (**admin-only**: per-user permissions + per-user email for Gmail impersonation)

## Reference Documentation

Load these on demand when working on the matching topic:

| File | When to load |
|------|--------------|
| `claude_doc/project_structure.md` | Full file/directory tree with per-file annotations |
| `claude_doc/dev_setup.md` | Fresh-machine setup: HFSQL server/driver, `.env.development`, dev ports |
| `claude_doc/hfsql_odbc.md` | HFSQL connection details, driver install, bridge, platform-specific SQL, accented columns |
| `claude_doc/implemented_screens.md` | Canonical reference screens (Entreprises, Fournisseurs, Commandes, Stock) — grep first before inventing patterns |
| `claude_doc/auth_permissions.md` | Cookie auth picker, effective vs session admin, permission catalog, admin guard |
| `claude_doc/pdf_email.md` | `@react-pdf/renderer` gotchas, Gmail DWD setup, per-document email endpoint pattern |
| `claude_doc/legacy_tables.md` | All 204 HFSQL tables with fields |
| `claude_doc/legacy_windows.md` | All 319 windows + 49 reports |
| `claude_doc/navigation_mapping.md` | Legacy windows → MPS_NG routes |
| `claude_doc/business_glossary.md` | Domain vocabulary, production flow |
| `claude_doc/sous_traitants_status_model.md` | Sst commandes computed-phase model, card urgency frames + pills, Soumission Lot Client flow, Historique tab, Reprise flow, type_doc codes |
| `claude_doc/worktrees.md` | Parallel dev with git worktrees, **multi-project** (MPS_NG `300N`/`808N` + MPS-TRM `517N`, disjoint slots): slot model (incl. reserved **slot 0** = serve `master` via `/serve-main`), the `/new-feature-worktree [ng\|trm]` · `/feature-checkpoint` · `/feature-complete` · `/worktree-status` skills (project auto-detected from the invoking repo; run TRM worktrees from the MPS-TRM checkout), concurrency-safe shared registry, merge discipline, **§Shared-API changes**: TRM features needing endpoints use a *paired NG worktree* (API lands via NG's pipeline; deploy ownership: NG `/mps_deploy` = shared API + NG web → `mpsng.malterre`, TRM `/mps_deploy` = TRM web only → `mpstrm.malterre`) |

## HFSQL rules (footguns — always apply)

Full details in `claude_doc/hfsql_odbc.md`. These are the non-negotiable rules for every route that touches HFSQL:

- **No parameterized queries**: `?` placeholders fail. Use string interpolation with `esc()` (single-quote doubling) for strings, `parseInt` for IDs, hex literals `x'${buffer.toString('hex')}'` for blobs.
- **No `RETURNING *`**: use follow-up `SELECT` after INSERT/UPDATE.
- **Booleans are `0`/`1`**: in React always `!!value &&` to avoid rendering `0` as text.
- **Accented identifiers are platform-specific**: Linux bridge rejects them entirely (use `sf.*` + ASCII-truncated column names); Windows silently returns 0 rows on `alias.*` in JOINs (use explicit `alias.terminé AS termine`). Branch on `process.platform === 'win32'` via `IS_WINDOWS`. Canonical pattern in `apps/api/src/routes/stock.ts`. Truncation is **in the driver itself** (even a raw Latin-1 `0xE9` is dropped) — the "Latin-1 bridge" idea is a dead end (`project_hfsql_bridge_accent_fix`). Resolve accent-mangled `SELECT *` keys with a `/^prefix/i` regex (`pickKey`), not hardcoded fallbacks. **Writing accented columns on Linux** (e.g. `asso_fil_matiere`): never name them — positional `INSERT … VALUES(...)` in column order (PK isn't auto-assigned; compute `max+1`), edit/delete via delete-by-ASCII-key + reinsert. Canonical: `references-fil.ts` composition (`project_matiere_premiere_unreachable_pk`). When the table has an **ASCII PK** but accented data columns (`dossier_qualite`), the cheaper shape is a **full-row positional rewrite keyed on the PK**: split writes so ASCII columns take a normal named `UPDATE` and only a change to an accented column triggers read-`queryB64Text` → `DELETE … WHERE <ascii PK>` → positional `INSERT` (same PK, so child FKs survive), with a best-effort restore on failure. Canonical: `dossiers-qualite.ts` `patchAccented()`; round-trip guard `apps/api/src/scripts/test-dq-positional-rewrite.ts`. Reading accented-NAMED columns (`prénom`/`société`): bridge `queryB64Text()` (base64-text → Latin-1); `project_hfsql_accented_column_b64text`.
- **A query naming a non-existent column = prod outage on Linux**: silently caught on Windows ODBC, but on the bridge it triggers a respawn storm that floods the shared HFSQL server (`mps.malterre`=`10.10.20.2`, shared with mfprod) and hangs both apps. Any helper building `WHERE <col>=<id>` from a row property MUST use the target table's real PK. **`WHERE col = NaN` storms identically**: `fixEncoding`/`repairAliased`'s `idField` MUST be selected by the feeding query — `SELECT nom FROM x` + `fixEncoding(…,'IDx',['nom'])` reads `undefined`→`NaN` (helpers now skip non-integer ids as backstop; `project_fixencoding_nan_storm`). Verify prod via `https://mpsng.malterre` (NOT `localhost:8081` — IPv6 false 000s); don't hammer-restart. Naming an accented column in SQL storms the same way — never name `invalidé`/`société`/etc.; `SELECT *` + prune in JS. `isConnectionLostError` now excludes SQL errors so bad columns throw, not storm. Memories: `project_hfsql_bridge_storm`, `feedback_prod_health_check`.
- **Encoding (reads)**: ODBC corrupts accents (é→U+FFFD). Use `fixEncoding()` / `CONVERT(field USING 'UTF-8')` per affected field. **On large lists, batch the repair** — one `CONVERT … WHERE id IN (…)` per source column, not per row (per-row CONVERT is an N+1 that floods the bridge). Batched pattern in `stock-fini.ts repairAliased`.
- **Encoding (writes)**: raw multi-byte UTF-8 in a SQL string corrupts the Linux bridge (→ `[HY090]` / "string without end" / 500). HFSQL text columns are Latin-1 — emit accented values as a hex literal of their Latin-1 bytes (`x'${Buffer.from(v,'latin1').toString('hex')}'`), not `'${esc(v)}'`; ASCII values keep the normal quoted literal. Helper: `sqlText()` in `commandes-sous-traitant.ts`.
- **BinMemo `IS NOT NULL`**: unreliable — empty blobs pass. File-serving endpoints return 404 if buffer is empty; UI does HEAD pre-check before rendering iframes.
- **Avoid accents in HFSQL table names and backup folder file names** — both cause "fichier de données est déjà décrit" errors at connection time.
- **JOIN + `CONVERT()` collapses result sets**: `SELECT a.col, CONVERT(b.text USING 'UTF-8') FROM a JOIN b WHERE …` returns **one row** instead of all matches. Split into two flat queries and merge in JS. Same shape kills `CONVERT(tel)` even single-table when `tel` is empty on some rows — read phone-like cols raw. Reference: `commandes-sous-traitant.ts` `/lookups/sous-traitants`.
- **Reserved-word columns return uppercased**: `SELECT lcs.type FROM ligne_commande_sous_traitant lcs` returns the column key as `TYPE`, not `type`; likewise `date` comes back as `DATE` (seen on `prospect`). Always alias (`lcs.type AS type_kind`) or read case-insensitively. Affected anywhere a reserved-word column exists.
- **`commande_sous_traitant`: `commentaire` is RTF, `journal` is plain text**: `commentaire` round-trips via `stripRtf()`/`wrapRtf()` (legacy still reads it); `journal` writes via `sqlText()` (RTF rows migrated to plain text 2026-05-26, reads keep `stripRtf()` defensively). The app surfaces `journal` where legacy wrongly bound the "journal" UI to per-line `lcsst.commentaire`.
- **Empty FK columns store `0`, not `NULL`**: HFSQL keeps integer FK columns at `0` when there's no foreign key (not NULL). Predicates like `WHERE IDligne_expedition IS NULL` silently match zero rows. Use `(col IS NULL OR col = 0)`. Bit the `stock-fini.ts` default filter; same shape on `IDligne_commande_client`, `IDcommande_donation`, `IDProprietaire`, etc.
- **`IDsociete` partitioning**: shared tables (`client`, `commande_client`, likely `facture`/`devis` — verify per table) are partitioned across the 3 companies via `IDsociete` (1=ETM, 2=TRM, 3=Confection). Legacy filters on it — `IDsociete = 0` rows are **invisible** in the legacy app. Every MPS_NG INSERT must set it (= 1 for ETM; TRM-view writes set 2). Memory: `project_societe_multi_company.md`.
- **Per-table polymorphism / FK quirks** (`ged` multi-parent, `asso_colorisfil_frs`, lcsst `IDreference` × 3 catalogs, fini `IDColoris` by `ref_fini.avec_teinture` [`0`=wash `colori_ecru` / `1`,`2`=dye `ref_fini_colori`; memory `project_avec_teinture_coloris_rule.md`], `defaut_qualite` `Type_Reference`, `envoi_email.IDreference` by `IDtype_doc`): see `claude_doc/hfsql_odbc.md`.
- **Ennoblisseur lines (sst, `type=2`)**: `quantite=Ml`, `prix=€/Kg` — never multiply directly; € total = `Σ(stock_ecru.poids) × prix`. `prix` auto via `pricing-sst.ts` (ports legacy `CalculTarifSST` with MATEL/ESAT multipliers). Manual entry for out-of-catalog ssts (`auto_pricing_enabled` gates). Algo: memory `project_pricing_calcultarifsst.md`.
- **Tricoteur lines (sst, `type=1`)**: `quantite=kg` (output écru), `prix=€/Kg`, € total = `qty × prix`. `prix` auto via `pricing-trm.ts trmLinePrix = max(PrixDeRevientTRM(IDref_ecru, qty) / 0.7, ref_ecru.prix)`. Gate on `line.type=1` (ALL tricoteurs). Yarn affectations: `asso_fil_lignecmdsst`. Algo: memory `project_pricing_prixderevient_trm.md`.
- **ETM↔TRM cross-ledger bridge** (TRM = Tricotage Malterre, IDsous_traitant=1): auto-mirrors tricoteur sst as TRM `commande_client` (`IDcommande_ETM` back-pointer). Gate via `isTricotageMalterreSst(sstId)` — external tricoteurs (37/10/66) get NO mirror. TRM-side rolls surface via `stock_ecru.IDref_commande_source`. Detail: memory `project_etm_trm_bridge.md`.

**Connection**: `DRIVER={HFSQL};Server Name=localhost;Server Port=4900;Database=MPS;UID=Admin;PWD=;`

## React / frontend rules

- **Hooks before early returns**: all `use*` hooks must come before any conditional `return` — violating this crashes production builds (minified React error #310).
- **Shared `apiFetch`**: all fetch calls go through `apps/web/src/lib/api.ts` (sets `credentials: 'include'` for cookie auth). **Never duplicate per page** — the cookie won't be sent without `credentials: 'include'`.
- **SW denylist for `/api/`**: the PWA SW has `navigateFallbackDenylist` for `/api/`. Never remove — without it, the SW intercepts `/api/` navigations and serves `index.html`, breaking React Router.
- **Modifier button = `variant="gold"`**: the view-mode "Modifier" CTA on every detail screen MUST use `<Button variant="gold">`. Never `outline` or `default`. Canonical "enter edit mode" affordance.
- **Stale `.js` build artifacts**: `apps/web/src/**/*.js` is gitignored; web `build` is `tsc --noEmit && vite build` — **never revert to `tsc -b`** (composite tsconfig emits `.js`/`.d.ts` into `src/`). Vite resolves `.js` before `.tsx`, so stray emitted `.js` shadow source and serve stale code (symptom: white screen / edits not showing). Fix: delete the `.js`/`.d.ts` AND restart Vite (clearing `node_modules/.vite` isn't enough — old module graph lives in memory until restart).

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
- **Related project**: MPS_NG follows the architecture of **MFProd_NG** (`C:\dev\etsmalterre\mfprod\mfprod_erp`) — same tech stack, same layout patterns, different branding (gold vs orange) and domain (textile vs fencing).

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
