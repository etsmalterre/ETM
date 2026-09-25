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
- **Other clients**: the atelier phones (`TRM/apps/atelier`, `/api/atelier` — bonnetier side, and since 2026-09-08 the régleur side: `GET /machines?regleur=1`, `GET /of/:id/reglage`, `GET/POST/DELETE /of/:id/messages`, `PUT /of/:id/consigne`; since 2026-09-15 the OF's consultation reads `GET /of/:id/historique`, `/of/:id/pieces/:pieceId/evenements`, `/of/:id/fils` — the per-piece % there is the legacy's own formula in `lib/historique-atelier-trm.ts`, NOT of-trm's `vitesse` estimate; every régleur write checks `bonnetier.regleur = 1` on the named `IDbonnetier`, rules in `lib/atelier-regleur-trm.ts`), the TRS collector (`/api/recorder`, the only writer of `evenement_machine`), the **TRS wall tablet** (`TRM/apps/trs`, host `trs.intra.etsmalterre.com`, `GET /api/trs/atelier`, read-only; formula + tests in `lib/trs-trm.ts`, legacy source quoted in `~/.claude/plans/trs-atelier.md`; ⚠️ its « arrêts » pill is `arretsParPiece` — read by `lib/arrets-par-piece-trm.ts`, the one reader shared with the régleur phone list since 2026-09-14 — the per-PIECE `NombreArrets` averaged over the last 3 finished pieces of the active OF, NOT the shift count `calculerTrs.arrets`, which only feeds the deductibles). Planned: régleur app, bonnetier app, pointeuse, atelier screens. Dev CORS for the two PWAs (5176/5177) comes from `TRM_PWA_PORTS` in `scripts/worktree/lib.mjs`.
- ⚠️ **The website is a PUBLIC client** (etsmalterre.fr customer space + QR sample page, WordPress plugin `malterre-api`): `/api/site` (`routes/webservice-site.ts`) replaces the WinDev webservice MPS_WS in drop-in JSON shapes, served from a snapshot (`lib/webservice-site-store.ts`), published by Caddy as `alpha.etsmalterre.com`. Never mount an ERP router under that prefix; an unpriceable coloris is LEFT OUT (an empty grid sells at 1 €/m in the shop). `claude_doc/webservice_legacy.md` §7.
- ⚠️ **`apps/api` lives in this repo for historical reasons — a file location, not ownership.** A change needed by a TRM screen is a **normal change to this repo**, landed through an NG worktree. Deploying the MPS API from `/etm_deploy` deploys it **for every client at once** — smoke-check more than the app you are standing in. Whoever ships an app is responsible for the platform half it needs; "that's the other repo's job" is never the answer.
- ⚠️ **The API runs scheduled jobs in-process** (since 2026-09-22, TRM's pointage report emails, `lib/rapports-pointage-envoi.ts`): a minute tick started from `index.ts`, **active only when `NODE_ENV=production`** so a dev or worktree API never mails real people, with a journal in `data/` written before sending (at most once a day, catch-up the same day after a restart). A future scheduled job follows the same shape. Email subscriptions are per app like permissions: `createNotificationStore()` in `lib/notifications.ts` backs ETM's `notifications.json` and TRM's `notifications-trm.json` (dossier TRM `claude_doc/rapports-pointage-email.md`). **The daily report's rules (`lib/rapport-pointage.ts`) have a second reader since 2026-09-24**: the pointage tablet's « 7 derniers jours » (`GET /api/pointage/salaries/:id/journees`); both go through `analyserJours()` in `rapports-pointage-envoi.ts` — never copy that loop into a route.
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
- **Phase 2 — Database**: web app connects directly to HFSQL via ODBC; WinDev stays on HFSQL during the adaptation period — both share live data. **HFSQL → PostgreSQL migration restarted 2026-09-22** (switch in the MPS API, PG names lowercase/unaccented, HFSQL source of truth until cutover): plan, tools, review and cutover live in the sibling repo **`../windev_migration`** (`docs/plan.md`); only the API-side pieces stay here (`src/scripts/legacy-activity-report.ts`, future `pg-fix-*.ts` repairs and the `DB_BACKEND` switch).
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
| Auth | Cookie-based (HMAC-signed, no JWT lib) — `cookie-parser`. ⚠️ `POST /auth/login` authenticates nothing (any `IDutilisateur`); atelier phones carry a third, revocable cookie `mps_appareil` (`lib/appareils-atelier.ts`, `req.appareil`) and every atelier write requires it, never `mps_uid` alone |
| PDF | `@react-pdf/renderer` (server-side, Lato fonts bundled) |
| Excel | `xlsx` (SheetJS) — **client-side**, lazy `await import('xlsx')` so it's a separate chunk; API returns JSON, browser builds the `.xlsx` |
| Email | Gmail API via `googleapis` + domain-wide delegation |
| Tickets | LIVA issue tracker via server-side proxy `apps/api/src/routes/tickets.ts` (one router factory mounted twice: `/api/tickets/*` = `etm-erp`, `/api/tickets-trm/*` = `trm-erp`), widget `apps/web/src/components/tickets/`, **feature version 1.3.0** (spec + upgrade path: `issue_tracker_integration` skill). Every read is pinned to `product_slug` (the key is company-scoped), `resolu` counts as **open**, and an account without a mapped email still reports under a synthetic identity. Full rules: `claude_doc/screen_notes.md` § Tickets |

## Project Structure

Full file/directory tree with per-file annotations: **`claude_doc/project_structure.md`** (load when navigating the codebase layout).

## Navigation Structure

Mirrors the legacy WinDev main menu (top → bottom). **Per-screen rules, ticket post-mortems and data facts live in `claude_doc/screen_notes.md`** (one section per menu, same numbering) and, for the dashboard, in **`claude_doc/dashboard_widgets.md`**. Load the matching section before touching a screen; add new per-screen notes there, not here.

1. **Tableau de bord** (`/`) — per-user, permission-gated widgets (`dashboard_*` keys), several dashboards per user (tabs), `react-grid-layout` v2 with real (x, y) positions, layout saved in `data/user-profiles.json` scoped per app (`?app=etm|trm` — TRM renders this very screen with its own registry). Adding a widget = one entry in `components/dashboard/registry.tsx`. Widgets with their own doctrine (CA, Évolution du CA, Analyse financière + variation de stock estimée, Charges, Valorisation du stock [calcul actif, widget en sommeil], BFR [hors de portée], Notifications, Commandes du jour, État des stocks de fil [« Besoin » = réservation − déjà tricoté, #1139; sans affectation, réservation déduite des OF lancés, #1159], Utilisation fil, Suivi pièce): `claude_doc/dashboard_widgets.md`. ⚠️ Finance widgets are bounded to the exploitation perimeter (PCG 60-64 / 70-74), the year-end point is a pre-closing balance, and `valorisation-stock.ts` is NOT dead code — it feeds the EBE.
2. **Prospects** — Demandes (`/prospects/demandes`, implemented) + devis prospect (LIVA #1112: shared Clients › Devis editor, `IDprospect > 0`, two default-closed permission keys).
3. **Clients** — Commandes, Devis, Facturation, Gestion. Two ledgers on `client` (`clients.ts` ETM / `clients-trm.ts` TRM, shared `lib/clients-common.ts`; **a router must never NAME a column the other fiche owns**). Compte client `411xxx` generation, SIREN, TVA-by-client, contract pricing (`lib/tarif-client.ts`, expired contract = 409 `contrat_expire`), client-scoped coloris picker, per-roll link when launching an ennoblisseur order (#1115), divers lines priced off `tarif_divers`, carton contents as a table (#1098/#1099), divers delivery note without prices (#1127), facturation over two shipment registers (#1117), « non envoyée » = no `envoi_email` row of type 19 and « Marquer comme envoyée » writes one marker row with an ASCII `notes` prefix (`lib/envoi-manuel.ts`, #1174). **Simone Pérèle roll labels** (#1200): « Étiquettes » tab of a fini line for clients switched on in Gestion, MATEL measures kept in `data/etiquettes-sp.json`, real GS1-128 (the legacy's were unscannable), SSCC = roll number, 26/54 `code_sp` EANs one digit short → labels refused until fixed; **a new coloris code = highest + 1, never a duplicate, created on étude acceptance** (#1209, `lib/codes-sp.ts`). Details: `screen_notes.md` § 3.
4. **Sous-traitants** — Commandes (ennoblisseur; `claude_doc/sous_traitants_status_model.md`), Gestion (`routes/sous-traitants.ts`).
5. **Transferts** — Rouleaux + Fils (`TransfertsScreen.tsx` via `kind`, `routes/transferts.ts`). ⚠️ The movement is immediate — `est_valide` does not gate it. Picker: server-side search (200-row cap), selection always a subset of visible rows (#1120), 2e choix hidden by default (#1119), consumed écru excluded and pieces affected elsewhere hidden (#1121), **only `IDsociete = 1` rolls offered or accepted — a TRM roll is not ETM's until TRM ships it** (#1169), never a donated écru nor a merged-roll component (#1187), email recipient on `contact.envoi_bt` never `envoi_bl` (#1097). Details: `screen_notes.md` § 5.
6. **Fils** (`/fils/*`) — Références, Stock, Commandes, Gestion, Prévisions. « En commande » = what is still awaited, mirror of Rapports › Commandes fils (#1090, `lib/references-fil-agg.ts`).
7. **Tombé Métier** — Références (shared with TRM through `@etm`; per-app difference = the `obsOfEditor` prop, never a fork; Circulaire / **Rectiligne** switch `?type=rectiligne` — cols / bandes, #1185, sibling file imported RELATIVELY), **Stock** (Tableau over `routes/stock-ecru.ts`; `SmartSearchInput` chips since #1156; **magasin 0 = the factory, shown « Malterre »**, normalized in the list AND detail `select` on the three stock screens, never in the cell; perf audit + the bimodal-server rule in `hfsql_odbc.md` § Footguns).
8. **Finis** — Références (a §39 Classeur since #1155: Spécifications / Coloris [table, live stock per coloris] / Traitements [process chain in `traitement.ordre`], sidebar « Clients » card = who ordered it, by volume, `lib/clients-ref-fini.ts`; treatments attach/detach on the fiche in edit mode, `lib/traitements.ts`; `traitement_ref_fini` is a strict set → 409 `deja_associe`, unlike the Tarifs junction — #1136; « Dupliquer » copies the WHOLE row + treatments, no dyed coloris (#1186, `lib/duplicate-ref-fini.ts`, positional INSERT on Linux); **names are unique** case/accent-insensitively for every writer — compared in JS, never SQL `=` on an accented literal (`lib/ref-fini-reference.ts`); Imprimer › Étiquette = the client-facing Dymo tag `EtiquetteRefFiniPdf.tsx`, **black & white only** — thermal printer — with the mono M inside a level-H QR, no options dialog), Stock, Études coloris (single `edit_etudes_coloris` key gates all writes, default closed — #1092), Tarifs (price simulator, `lib/pricing-ref-tarif.ts`, 46/46 legacy parity).
9. **Divers** — Références, Stock (`stock_divers` is SPARSE: zero rows hidden unconditionally, `POST` is an upsert).
10. **Qualité** — Suivi lots, Dossiers (Envoyer la FNC = handover creating the TRM `retour_client` row, idempotent), Actions (`lib/actions-qualite.ts`; matching rule validated on all 248 legacy rows; `mention_qualite` has an accented PK; archiving is manual by decision).
11. **Rapports** — Commandes clients / sst / fils (flat tables, `routes/rapports.ts`), **Factures** (definitive invoices over a period with signed totals split by TVA rate; handler `createFacturesRapportHandler(scope)` in `factures.ts` mounted on both `/rapports` and `/rapports-trm`, row click deep-links `/clients/facturation?numero=`), Finance (balance N vs N-1, permission-gated `view_rapport_finance`, shared with TRM via `basePath`; routes in `lib/finance-common.ts`).
12. **Réseau** — Entreprises.
13. **Agents IA** — Agents (`/agents-ia/agents`, engine `lib/agents/`, state in `data/agents/`, piloting gated by `edit_agents_ia`, scoring by `evaluer_agents_ia`). ⚠️ **Every score is réussite / partielle / échec** — a comment required except for réussite, gathered per version in the « Retours » tab for the next prompt; an échec removes what the run wrote when the agent declares it (`AgentDef.evaluation.retirer`: BL = its pre-filled `data_bl_tricotbot` rows, never the PDF). **What is scored depends on the agent**: the run (BL) or each POINT of the run (Superviseur, `pointsEvaluables` — the report is never scored as a whole, `PUT /runs/:id/evaluation` answers 409; the version's score is `scorePoints()` in `superviseur/score.ts`, précision = confirmés + partiels / évalués). First agent **BL Ennoblisseur** (ex-« BL MATEL », still MATEL-only) replaces n8n « BL Processing » + the WebDev `load_bl_*`: Mistral OCR + `mistral-small` (`lib/mistral.ts`, `MISTRAL_API_KEY`), mailbox via `lib/gmail-reader.ts`. ⚠️ Modes `off` / `essai` (writes nothing) / `actif`; the poll runs in production only, and a blocking check never writes — the run goes « à vérifier » (`notif_agent_bl`). Checks + benchmark: `screen_notes.md` § 13. Second agent **Superviseur** (`lib/agents/superviseur/`): weekdays **05:00**, code checks over ETM + read-only triage of 5 mailboxes (`boites-liste.ts`) (`gmail.readonly`, never the `gmail.modify` client); **no mail since 2026-09-23 — the run IS the morning report** Isabelle reads in Agents IA under a KPI strip, each point scored on its own — never the report (an échec = false alarm, set aside in later reports while unchanged, `superviseur/avis.ts`); **a closed point always says why** (every check records `ctx.raison()` for what it lets pass) and a person may « Marquer résolu » with a mandatory explanation — not a score, feedback for the next version (`screen_notes.md` § 13 « Résolus »); **v2 (2026-09-25)**: the mail check keeps to Isabelle's scope and checks ETM (`envoi_email`, addresses) before raising a point — never count an arbitrary ETM send as an answer, only a cited or requested document (`screen_notes.md` § 13 « Superviseur v2 »); a prompt shipped with the code (`AgentDef.promptLivre`) is published from the Prompt tab, never automatically; what each score means + the « Comment noter ? » guide (one per report, never per point) live in `AgentDef.evaluation` — edit the texts there; dev test report: `scripts/seed-superviseur-dev.ts`; ⚠️ only the scheduled run updates the findings memory — « Lancer maintenant » previews. Deep links `?commande=<id>` on Clients › Commandes and Sous-traitants › Commandes.
14. **Paramètres** — Utilisateurs (admin-only), **Outils** (import of the weekly Sage balance — the ONLY writer of `upload_compta` / `releve_compta` once WinDev is off; `routes/import-sage.ts` mounted for ETM and TRM, gated by its Écrans grant (no action key), refuses a file from the other company; `screen_notes.md` § 14). **TRM has its own permission catalog + store** (`lib/permission-keys-trm.ts`, `/api/permissions-trm`); gate TRM routes with `trmUserHasPermission`, never `userHasPermission`, and any shared helper must take an explicit `PermissionScope` with no default. A key used by a TRM screen but absent from `TRM_PERMISSION_KEYS` fails silently — guard `check-permission-keys-trm.ts --web <TRM apps/web/src>`. **Menu / screen visibility is per user** (`claude_doc/auth_permissions.md` §Screen access): a menu is a grant (`screen_<menu>`), a screen inside it a hide (`hide_<menu>_<screen>`, read via `hasRaw()`); a curtain, not a lock. Grandfathering: `seed-screen-access.ts --write` on the server (never hands out Paramètres, `seed: false`). ⚠️ **Écrans = what a user SEES, permissions = what they can DO in it**: a new screen (Paramètres included — it is a menu of the axis, `screen_settings`) goes in the Écrans manifests with NO action key; add a key only when several viewers of the same screen need different rights. A write route still needs a server guard → check the screen grant (`userCanOpenScreen` / `trmUserCanOpenScreen`), don't invent a key.

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
| `claude_doc/pdf_email.md` | `@react-pdf/renderer` gotchas, Gmail DWD setup, per-document email endpoint pattern — **and how to verify a PDF you changed** (rasterize, or assert on the element tree; read this BEFORE inventing a way to check your output). ⚠️ **No `marginBottom` on a wrapping lines table** — the paginator counts it as presence and moves the table WHOLE to the next page when only the margin overflows (blank page 1, #1148); the gap goes on the next block's `marginTop` |
| `claude_doc/legacy_tables.md` | All 204 HFSQL tables with fields |
| `claude_doc/legacy_windows.md` | All 319 windows + 49 reports |
| `claude_doc/navigation_mapping.md` | Legacy windows → ETM routes |
| `claude_doc/business_glossary.md` | Domain vocabulary, production flow |
| `claude_doc/sous_traitants_status_model.md` | Sst commandes computed-phase model, card urgency frames + pills, Soumission Lot Client flow, Historique tab, Reprise flow, type_doc codes |
| `claude_doc/webservice_legacy.md` | The website API: legacy WinDev MPS_WS map + its `/api/site` replacement (parity, bugs fixed, go-live checklist) |
| `claude_doc/worktrees.md` | Parallel dev with git worktrees, **multi-project** (ETM `300N`/`808N` + TRM `517N`, disjoint slots): slot model (incl. reserved **slot 0** = serve `master` via `/serve-main`), the `/new-feature-worktree [ng\|trm]` · `/feature-checkpoint` · `/feature-complete` · `/worktree-status` skills (project auto-detected from the invoking repo; run TRM worktrees from the TRM checkout), concurrency-safe shared registry, merge discipline, **§Shared-API changes**: TRM features needing endpoints use a *paired NG worktree* (API lands via NG's pipeline; deploy ownership: `/etm_deploy` = shared API + NG web → `etm.intra.etsmalterre.com`, `/trm_deploy` = TRM web only → `trm.intra.etsmalterre.com`) |

## HFSQL rules (footguns — always apply)

One or two lines per rule. **The incident, the measurements, the canonical file and the guard script for each are in `claude_doc/hfsql_odbc.md` § Footguns** — read that entry before touching the area, and add the story of a new footgun there with a one-liner here.

**SQL dialect**
- **No parameterized queries**: `?` fails. Interpolate with `esc()` for strings, `parseInt` for ids, hex literals `x'…'` for blobs. **No `RETURNING *`**: follow-up `SELECT`.
- **Booleans are `0`/`1`**: in React always `!!value &&`.
- **Reserved-word columns come back uppercased** (`type` → `TYPE`, `date` → `DATE`): always alias, and write `DATE` uppercase in WHERE/ORDER BY. **Aliases too**: `AS exp` comes back `EXP`, `AS et` is a syntax error — never alias to a short French/SQL word.
- **Empty FK columns store `0`, not `NULL`**: predicate `(col IS NULL OR col = 0)`, never `IS NULL` alone.
- **JOIN + `CONVERT()` collapses the result set to one row** (also single-table when the column is empty on some rows): split into flat queries, merge in JS.
- **BinMemo `IS NOT NULL` is unreliable**: file endpoints 404 on an empty buffer; UI does a HEAD pre-check.
- **Avoid accents in HFSQL table names and backup folder names** ("fichier de données est déjà décrit").
- ⚠️ **Never `CREATE TABLE` through ODBC as a deploy step**: it writes a local `.fic` in the process cwd, visible to that connection only (every other connection: « fichier inconnu », a new CREATE: « existe déjà »). **Adding a table = copy its `.fic` + `.ndx` into the server's database folder, then restart the API** (a connection lists the files when it opens) — versioned pair in `apps/api/hfsql/`; the API probes it (`probeFiniSourceTable()`) and degrades while it is missing. No correlated `NOT EXISTS` / `NOT IN (SELECT…)` on such a table — flat lookups + JS sets (`lib/fini-sources.ts`).
- ⚠️ **Second database `pointage` (time clock) = `pointageDb` from `lib/hfsql-pointage.ts`, never the default client** — the dev `mps` folder holds stale `lst_horaire` / `lst_salarie` / `hors_prod` / `pointage` files that the wrong client reads silently. Dev copy: `scripts/copy-pointage-prod-to-dev.ts --write` (indexes last, cp1252 text — `hfsql_odbc.md` § « A second database »).
- ⚠️ **Admin Pointage lives in the TRM ERP (`/api/pointage-admin`, `routes/pointage-admin.ts`, gated by the TRM menu grant `screen_pointage` alone since LIVA #1196), a SEPARATE router from the tablet’s `/api/pointage`** — but every write of a shift still goes through `lib/pointage-ecritures.ts` (same lock, same `jumelle()`): an office correction moves the `lst_pointage` twin AND the `mps.pointage` presence journal (decision A, 2026-09-21), which the legacy never did. Pure rules + tests in `lib/pointage-admin.ts` (after-midnight placement, lissage floored to the quarter hour, meals from 6 h); dossier `TRM/claude_doc/admin-pointage.md`.

**Accents and encoding**
- **Accented identifiers are platform-specific**: the Linux bridge rejects them, Windows silently returns 0 rows on `alias.*` joins. Branch on `IS_WINDOWS`; canonical `routes/stock.ts`. Truncation is in the driver — the "Latin-1 bridge" idea is a dead end.
- ⚠️ **Resolve accent-mangled `SELECT *` keys with a `/^prefix/i` regex, never a fallback list** (`pickVal` / `stripKeys` in `lib/accented-keys.ts`): the truncated key carries a garbage trailing byte, so `row.termin ?? row['terminé']` reads 0 for every row in prod (shipped five times, #1090, #1177 — `pick()` in `clients-common.ts` falls back to the prefix pass; static guard `check-accented-key-fallback.ts`). Read by prefix, strip by prefix, then assign the ASCII key.
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
- ⚠️ **List-query cost is bimodal (~450 ms or ~2.5 s for the same SQL, server idle)**: A/B two shapes only INTERLEAVED in one run; never add a second pass over the same `WHERE` (it doubles in the slow state); labels by flat `IN` lookups, not JOINs; **an `IN` list on a STRING column stays indexed only in chunks of ~50** (`defaut_qualite.reference`, `fetchDefectsByEcru`); repair accents in one batched `repairAliased`, never per-row `fixEncoding` on a list (#1156 audit, `hfsql_odbc.md`).
- ⚠️ **A binary read needs `queryRaw`, never `query`** (`cleanRow` decodes buffers as UTF-8); verify magic bytes, 404 otherwise; resize with `sharp` (`.rotate()` first). Canonical `prime-trm.ts` photo route.
- **`commande_sous_traitant`: `commentaire` is RTF (`stripRtf()`/`wrapRtf()`), `journal` is plain text** (`sqlText()`).

**Sociétés, partitions and route families**
- **`IDsociete` partitioning** (1 ETM / 2 TRM / 3 Confection) on `client`, `commande_client`, `facture`, `devis`, … — every ETM INSERT sets it (`IDsociete = 0` rows are invisible in legacy). `stock_fil` is NOT partitioned (`IDclient` names the owner).
- **Serving a partitioned table**: different objects → two route files; same object → **one router factory mounted twice** with a scope record (`createFacturesRouter(scope)`, `createFinanceRouter(scope)` in `lib/finance-common.ts`). Never fork; never add `?societe=`. A scope record holding a permission checker declares it as a **method** + `satisfies PermissionKey`, and every `:id` handler checks the row's partition (**404**, not 403) — `inScope()` in `factures.ts`.
- ⚠️ **`client` has ONE `IDtva` / `IDcode_comptable` for all three companies** while `tva` / `code_comptable` are partitioned: re-home into the writing société (`clientBillingDefaults()`), never copy verbatim.
- **Two route families per company, don't unify**: `stock-ecru.ts` / `stock-ecru-trm.ts` (ETM reservation on `IDligne_commande_client`, TRM on **`IDLigne_Commande_TRM`**; "in stock" differs too), `commandes-client.ts` / `commandes-trm.ts`, `expeditions.ts` / `expeditions-trm.ts` (`expedition_divers` has no `IDsociete` — ETM-only). Shared helpers are **exported** from the ETM file, never duplicated.
- **ETM↔TRM bridge**: a tricoteur sst to Tricotage Malterre (`IDsous_traitant = 1`, `isTricotageMalterreSst`) auto-mirrors a TRM `commande_client` (`IDcommande_ETM`). ⚠️ **The mirror is one-way and READ-ONLY on the TRM side** (`refuseIfMirror`, 409) — two exceptions with their own routes: the **état** (`PUT /commandes-trm/:id/etat`, closes only when every OF is done and every roll shipped; the sst then shows « Soldée par TRM », never closes itself) and the **délai** (`PUT /commandes-trm/lignes/:id/delai` writes both ledgers via `sstDelaiSets`). ⚠️ **An OF on a mirror line may only knit fils AFFECTED on the ETM sst line** (`asso_fil_lignecmdsst`; `POST /of-trm` and `PUT /of-trm/:id/composition` answer 409 `fil_non_affecte`, `lib/affectation-fil-trm.ts`, #1159) — the fil (ref + coloris) is enforced, the lot is only the dialog's default; a TRM-native line is never checked. **Deleting a sst order deletes its mirror too, unless TRM has started on it** (an OF or a roll on a mirror line, or the mirror soldée → 409 with the reason, `lib/sst-delete.ts`; the mirror header exists from creation, so "a mirror exists" is never a blocker — #1184). A `ConfirmDialog` that fires a mutation passes the server's `message` back through its `error` prop; `apiFetch` carries the JSON body as `err.body`.
- ⚠️ **Shipping to ETS Malterre CHANGES a TRM piece's owner at « Expédier »** (`IDsociete` 2 → 1, `lot = 'trm<IDexpedition>'`, and on a mirror line `IDref_commande_source` = the ETM sst line — `handoverSets()` in `lib/trm-handover.ts`, used by `stampShippedPieces()` / `releaseShippedPieces()` in `expeditions-trm.ts`; **never `IDmagasin`** — the legacy « Expédier » reset it to 0 and sent transferred rolls back to the factory, #1172). Hence: queries listing "what was shipped" must NOT filter on `IDsociete`, and **counting TRM production means `IDordre_fabrication > 0`, NOT `IDsociete = 2`** (`prime-trm.ts`, any TRS/rapport query).
- **`ordre_fabrication`, `machine`, `operation_maintenance` & friends are TRM-only with NO `IDsociete`**: `of-trm.ts` + `visitage-trm.ts` (the only writer of TRM `stock_ecru`; reserves 1er choix only, #1129) over `lib/production-trm.ts`; `maintenance-trm.ts` (`SET` must name only maintenance columns; real column names `observation_maintenace`, `comm_pulsonque`; "Description" = `machine.commentaire`). Every write route carries its own TRM permission guard — **there is no global auth middleware**, an unguarded route is anonymous. `priorite` ranks within one métier, `POST /:id/terminer` owns the auto-activation flip. Réalisé = `Σ stock_ecru.poids`, never IDsociete-filtered.

**Money, pricing and quantities**
- ⚠️ **Round the unit price to the centime BEFORE multiplying** (`lineMontant()` / `round2()` in `factures.ts`), on every surface — 13/14 legacy invoices reproduced vs 4/14 with raw products.
- **Ennoblisseur lines (sst `type=2`)**: `quantite` = Ml, `prix` = €/Kg, € = `Σ stock_ecru.poids × prix`; auto via `pricing-sst.ts`. **Tricoteur lines (`type=1`)**: kg × €/Kg; auto via `pricing-trm.ts trmLinePrix`.
- ⚠️ **`pricing-trm.ts` has ONE retained-price rule**, the legacy `max(cost/0.7, base)` (the base is a floor on the *sale* price, retained flat): the ETM→TRM bridge and `/commandes-trm/lookups/line-price` quote the same number. A second `'cost-floor'` rule (`max(cost, base)/0.7`, ~+39 %) lived on the TRM suggestion from 2026-08-26 to 2026-09-11 and was retired on LIVA #1151 — do not bring back a per-caller role. `prixDeRevientTRM` is the *cost* (margin chip), never a price. `retainedFrom` compares the base to the MARGED cost. The legacy TRM window computes no price at all — a gap is expected.
- **Clients › Commandes: a line's price depends on the CLIENT** (`lib/tarif-client.ts`; expired contract blocks, 409 `contrat_expire`); **divers lines** price off `tarif_divers`, never re-derive a stored price. ⚠️ **A contract price is in the reference's selling unit: €/Ml on a fini, €/Kg on a tombé de métier** (always sold by the Kg — never × rendement, #1144; `contratPriceFn` + `calcTarifRefEcru`).
- ⚠️ **Prime TRM rates are dated** (`lib/bareme-prime-trm.ts`, semester boundaries 15/06 & 15/12; never edit a past line) and the **répartition includes the régleurs** (user decision 2026-08-25). Any retroactive barème (rouloir threshold 15 000 Kg) gets the same date-effective shape.

**Data semantics**
- ⚠️ **An invoiced avis is read-only EXCEPT its delivery address** (`PUT /expeditions/:kind/:id/adresse`, #1179): the facture carries its own address and never reads the avis's, so the change is free until the expedition app records physical departure. The general `PUT` keeps `isLocked()` — never widen it, the dedicated route is the carve-out.
- ⚠️ **`adresse` 795 « À définir » is a delivery address up to the factory door** (#1189, `lib/adresse-a-definir.ts`): any document that ships the goods (BL, email, demande de transport) answers 409 `adresse_a_definir` while an avis carries it; never offer it for billing.
- ⚠️ **"A roll is shipped" is TWO facts** — `stock_fini.IDligne_expedition > 0` AND `IDetat_stock_fini = 4`; a return must clear both and release `IDligne_commande_client` (#1086, `POST /:id/marchandise/retour-stock`, guard `check-retour-marchandise.ts`). **Deleting an avis or removing a roll from it clears both too** but KEEPS the line affectation (`unshipFiniRolls`, guard `check-expedition-unship.ts`).
- ⚠️ **Attaching a piece to a DONATION order is the stock exit — there is never an avis behind a donation** (#1154): a fini roll takes `IDetat_stock_fini = 4` with the FK, detaching restores 3 only on rolls still in 4 (`lib/donation-pieces.ts`); écru leaves stock by `IDcommande_donation` alone, excluded on every Tombé Métier › Stock tab. Guard `check-donation-etat.ts --repair`. **A donated piece never keeps `IDligne_commande_client`** (#1173: the two FKs are independent, the legacy writes each alone, and the gauge counted an invisible 29,8 Ml): attach clears it, the « Affecté » gauge excludes donations, affecter routes 409 `piece_donnee`; guard `check-donation-lien-client.ts --repair`.
- **Per-table polymorphism**: `ged` multi-parent, lcsst `IDreference` × 4 catalogs (4 = rectiligne, both ledgers, resolved strictly by type — `lib/sst-line-kind.ts`, #1185), fini `IDColoris` by `ref_fini.avec_teinture` (0 → `colori_ecru`, 1/2 → `ref_fini_colori`), `defaut_qualite.Type_Reference`, `envoi_email.IDreference` by `IDtype_doc` — `claude_doc/hfsql_odbc.md`.
- ⚠️ **A coloris LOOKUP for a fini branches on `avec_teinture` too** (#1158): wash-only finis (253 of 610) keep their coloris in `colori_ecru` of the écru — a lookup reading only `ref_fini_colori` offers « Aucun » and the order ships without a coloris. `/commandes-sous-traitant`, `/commandes-client` and `/devis` `lookups/colori-fini` all branch. The sst bon de commande derives the « Article initial » composition from `composition_ecru` when `ref_ecru.composition` is empty (`lib/composition-label.ts`, #1157).
- ⚠️ **An écru's yarns are read from the COLORIS composition first** (#1205): `composition_ecru` holds the ref's recipe (`IDcolori_ecru = 0`, usually no yarn colour) AND one per coloris with yarn colours — every yarn-picking reader (TRM Stock de fil / Créer un OF, sst affectation, PDF label) prefers the coloris rows, so a coloris recipe that diverges silently wins. Références shows and edits it (« ≠ composition » badge, `PUT /references-ecru/:id/coloris/:coloriId/composition`, locked only by rolls/OFs of that coloris). Detail in `claude_doc/screen_notes.md`.
- **Every `INSERT INTO commande_sous_traitant` resolves its addresses through `resolveSstAdresses()`** (`lib/sst-adresses.ts`: principal = `est_defaut`, livraison = `est_defaut_livraison`, fallbacks to each other then first visible). « Ennoblir » wrote 0/0 and the dialog trusted the browser — 34 MATEL orders printed without any address (2026-09-14). Repair: `scripts/repair-sst-adresses.ts`.
- ⚠️ **`defaut_qualite.reference` is NOT disambiguated by `Type_Reference`** (an id resolves in both `stock_ecru` and `stock_fini`): only read it filtered by écru ids you already hold; fini defects live on the roll (`observation_sst`, `second_choix`). **`taille_cm` is NOT centimetres** — the size qualifier is in `description`; count-shaped defects use `nombre`.
- **Who wrote a row: the HFSQL journal is readable over ODBC** — `Database=__jnl` for `jnl_users` (login, workstation, application, IP) and `jnl_operation`; the per-file journals (`stock_ecrujnl`…) live in `__jnl/mps/`, copy them into a dev database folder to read them. `expedition.est_valide = 1` = written by the legacy (the API always inserts 0). `hfsql_odbc.md` § « Reading the journal ».
- **A DATETIME's text shape differs per driver** (`'2025-11-24 19:58:40.412'` vs `'20251124195840'`): always `parseDtMs()` (`lib/production-trm.ts`), never `SUBSTR` on a date.
- ⚠️ **An address block on a PDF prints `adresse1`, `adresse2` AND `adresse3`** — the street itself sits in the third line when the first two hold « Attn » / « POUR … » (#1163: the confirmation, the devis, the sst and fournisseur orders each dropped a delivery line). Guard `adresse-livraison.test.ts` (element-tree walk; invoke nested components).
- **`adresse.pays` is free-typed** (« FRANCE » / « France » / « france », trailing spaces, « -1 » sentinels): any column, filter or export surfacing it goes through `normalizePays()` (`lib/pays.ts`); a facture's country is its OWN `IDadresse`, never the client's current default (Rapports › Factures « Pays », 2026-09-22).
- ⚠️ **A fini roll can be made of SEVERAL écru pieces** (the dyer joins them, #1149): `stock_fini.IDstock_ecru` = first piece, every component in `stock_fini_source` (declared in the analysis), numero printed as the BL `3510/11+3510/2` (`mergedNumero`). **"This écru is consumed" = own fini child OR component of a merged roll** — always `consumedEcruIds()` / `mergedComponentEcruIds()` from `lib/fini-sources.ts`, never a bare `SELECT IDstock_ecru FROM stock_fini`. **The affectation pointers on the écru row survive the dyeing**, so every reader keyed on `IDref_commande_affectation` / `IDligne_commande_client` must drop consumed écru (the Ennoblissement tab double-counted 871,5 Ml, #1188, `lib/ennoblissement-supply.ts`). Reception: Ctrl/Maj+clic in the dialog's preview list, one POST with `IDstock_ecru_sources`; cut children copy the components; surteinture traces every component.
- **Cutting a roll (fini or écru): the remainder KEEPS the numero, each cut-off piece gets `<base>-N` with N = max existing suffix + 1** (first cut `-1`, legacy MAX rule; `lib/roll-cut.ts`, #1135). ⚠️ `numero LIKE '<base>-%'` also returns the bare `<base>` on the driver — test the digits after the dash in JS, never trust the LIKE alone.
- ⚠️ **Column lists grepped out of `MPS.xdd` run into the NEXT table** (`IDclient` looked like a `ref_fini_colori` column and 500ed the whole fiche, #1155): confirm a column against a dev `SELECT` before naming it — a bogus name is the Linux outage above.
- **Recovering a PCS-compressed WinDev window**: compile cache first (`MPS.cpl\<user>\00000000\<Window>.<hash>.wdw.{wcw,wbw}` — literals, SQL, field inventory), then the Android `GWDF*.java`. Integer thresholds survive neither: **ask the user** (they have WinDev open) before measuring from data.

**Connection**: `DRIVER={HFSQL};Server Name=localhost;Server Port=4900;Database=MPS;UID=Admin;PWD=;`

## React / frontend rules

Full text and incident history: `claude_doc/frontend_rules.md`.

- **Hooks before early returns** — violating this crashes production builds (React #310).
- ⚠️ **Never `preventDefault()` on a controlled checkbox click** — the browser reverts the tick after React sets it (#1207); Shift+click lists use a button-as-checkbox.
- **`useElementSize` returns a CALLBACK ref, deliberately** — a `useRef` + effect never attaches on a conditionally rendered target. Don't simplify it back.
- ⚠️ **A responsive table/card pair mounts ONE branch** (`useMediaQuery(MD_UP)` gating both row maps, `hooks/useMediaQuery.ts`): `hidden md:flex` hides pixels, not work — 762 rows rendered twice = 34k DOM nodes (#1156 audit, `mps_designer §40.2`).
- **A guard must never decide while its permission fetch is in flight**: render nothing until `usePermissions().isLoading` is false (bit `AppShell` and the admin guard).
- **Shared `apiFetch`** (`apps/web/src/lib/api.ts`, `credentials: 'include'`) — never a per-page fetch.
- ⚠️ **A screen that MOVES stock must call `invalidateStockCaches(queryClient)`** (`lib/cache-sync.ts`) unconditionally for every family, and **the four stock screens spread `STOCK_QUERY_FRESHNESS`** (`staleTime: 0` + `refetchOnMount: 'always'`) into list and detail queries — the legacy app and other sessions write these tables live (#1089). Guard `cache-sync.test.ts`. Don't "optimise" it back. **Same rule for a screen that CREATES a sst order elsewhere** (`invalidateSstCommandeCaches`, the client line's ennoblissement / tricotage dialogs — the sst list took up to 5 min to show it, #1178; the sst list spreads `STOCK_QUERY_FRESHNESS` too).
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
