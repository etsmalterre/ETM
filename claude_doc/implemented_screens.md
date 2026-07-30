# Implemented Screens

Canonical reference screens. When adding a feature to any data screen, grep these files first — the pattern almost certainly already exists.

## Entreprises (`/reseau/entreprises`)

First fully implemented data screen. 3-panel layout with:
- **Left**: Searchable enterprise list, "Nouveau" button in footer (edit mode only)
- **Center**: Company header (name, competence badges, @ email button, Modifier button), notes card, competences card, recommandations card
- **Detail API**: `GET /api/entreprises/:id` returns enterprise + adresses + contacts + competences + recommandations
- **CRUD endpoints**: Full CRUD for all sub-entities under `/api/entreprises/:id/{contacts,adresses,competences,recommandations}`
- **Email endpoints** (no PDF — entreprise has no document type): `GET /:id/email-defaults` splits contacts by `est_defaut=1` (→ `recipients.selected`) vs rest (→ `recipients.suggestions`) — entreprise contacts have no `envoi_*` flag, unlike fournisseur contacts. `POST /:id/email` uses the same shared `sendMail` helper with no attachments by default, but accepts `extra_attachments` for user-uploaded files. Wired to the shared `SendEmailDialog` with no `pdfUrl` so the right pane shows the empty state until the user attaches something.
- **Edit mode**: Inline forms, hover-reveal edit/delete, labeled inputs
- **HFSQL tables**: `entreprise`, `adresse`, `contact`, `competence`, `entreprise_competence`, `recommandation`

## Fournisseurs (`/fournisseurs/gestion`)

**Gold-standard reference** for all future data screens. The `mps_designer` skill (`.claude/skills/mps_designer/SKILL.md`) documents every pattern from this screen. Supplier management screen, 3-panel layout with:
- **Left**: Searchable supplier list (Factory icon, name only, no phone/fax in cards)
- **Center**: Supplier header (name, Modifier button), collapsible certificats card (clickable: view mode opens PDF viewer, edit mode opens edit dialog with document upload), collapsible references de fil card (BobineIcon, grouped by base ref with Bio/Recycle badges), collapsible commandes card (order lines with ref/coloris/qty/price, total weight/price summary)
- **Right sidebar**: 3 tabs — Info (commentaire), Contacts (with envoi_bl/facture/commande/soumission flags), Adresses (with facturation/livraison default flags)
- **Detail API**: `GET /api/fournisseurs/:id` returns fournisseur + adresses + contacts + refsFil + certificats (with `has_fichier`, `IDtype_doc`) + commandes (with lignes)
- **Certificat endpoints**: `GET /fournisseurs/certificats/:certId/fichier` (serves PDF blob with MIME detection), `PUT /fournisseurs/certificats/:certId` (multipart update), `POST /fournisseurs/:id/certificats` (multipart create), `DELETE /fournisseurs/certificats/:certId`, `GET /fournisseurs/type-doc` (document type list)
- **CRUD endpoints**: Full CRUD for fournisseurs + sub-entity CRUD under `/api/fournisseurs/:id/{contacts,adresses}`
- **Edit mode**: Inline forms for contacts/adresses, commentaire editable in Info tab, certificate edit dialog with document viewer/upload
- **HFSQL tables**: `fournisseur`, `adresse`, `contact`, `colori_fil`, `ref_fil`, `certificat`, `type_doc`, `commande_fil`, `ref_fil_commande`

## Fournisseurs Commandes (`/fournisseurs/commandes`)

**Reference for the in-screen contained drawer pattern** (mps_designer §31), **polymorphic `ged` document attachments** (mps_designer §34), **`ConfirmDialog`** (§33), **auto-edit on create + auto-select on delete workflows** (§25.1–25.2), **detached status bar** (§29), and the **iOS toggle pill** (§35). Bons de commande fournisseurs management screen, 3-panel layout with:
- **Left**: Searchable commandes list with delivery-urgency left edge (red = past/missing date, amber = within 3 days, none = normal). Selection ring + hover ring use the same urgency color or zinc-400 for normal.
- **Center**: Header (N°/fournisseur, Print + Email + **Modifier (gold)** buttons), commande lignes section. Click a line in view mode → in-screen drawer slides up below shrunk lines list (40%) and fills the bottom 60%, listing linked + available stock_fil lots for that ref/colori/fournisseur. Drawer click-to-toggle. Auto-closes when entering edit mode AND resets on every `selectedId` change via a page-level `useEffect` — otherwise the previous commande's non-null `stockDrawerLineId` leaks and the totals footer floats up next to the shrunk rows list.
- **Right sidebar**: 4 tabs — Info, Adresses, **Docs** (full CRUD, see below), Journal — with **detached `StatusFooter` pill** below the tabs panel (sibling of the panel with `gap-3`, solid colored bar: blue "En cours" / green "Terminée" with toggle button).
- **Docs tab** (polymorphic `ged` attachments): lists `ged` rows where `IDreference = IDcommande_fil AND IDcommande_client = 0 AND IDcommande_sous_traitant = 0`. View mode → click card opens full-bleed iframe viewer (`DocViewDialog`). Edit mode → click card opens side-by-side create/edit dialog (`DocCreateEditDialog`) with file picker + live preview, lots-linking section (iOS toggle: "Appliquer à tous les lots" default ON = zero `stock_fil_ged` rows; flip off to select specific lots). Delete via hover-reveal trash + `ConfirmDialog`. Card right side shows truncated `Lot A, Lot B…` when `linked_lots.length > 0`.
- **Detail API**: `GET /api/commandes-fil/:id` returns commande + adresses + lignes (with `nb_lots_lies`/`total_kg_lie` aggregates from stock_fil)
- **Stock linkage endpoints**: `GET /commandes-fil/:cId/lignes/:lId/stock`, `PUT .../stock/:stockId` (link), `DELETE .../stock/:stockId` (unlink) — strict ref/colori/fournisseur matching, single-FK `stock_fil.IDref_fil_commande`
- **Documents endpoints** (polymorphic `ged` pattern, mps_designer §34 is the full reference): `GET /:id/documents` (list with batched `linked_lots` join), `GET /:id/documents/:idged/fichier` (serve blob, MIME sniff, iframe header strip), `POST /:id/documents` (multipart create), `PUT /:id/documents/:idged` (multipart update + optional `remove_fichier=1`), `DELETE /:id/documents/:idged`. Per-lot scoping via `stock_fil_ged`: `GET /:id/documents/:idged/lots` (returns `{linked, available}`), `PUT /.../lots/:stockId` (idempotent link), `DELETE /.../lots/:stockId` (unlink), `DELETE /.../lots` (bulk clear — used when flipping the "all lots" toggle back on). Every write returns the refreshed `{linked, available}` so the dialog hydrates via `setQueryData`.
- **PDF endpoint**: `GET /api/commandes-fil/:id/pdf` — see `claude_doc/pdf_email.md`. Endpoint strips `X-Frame-Options` / `Content-Security-Policy` and sets `Cross-Origin-Resource-Policy: cross-origin` so the shared `SendEmailDialog` iframe can embed it across origins in dev.
- **Email endpoints**: `GET /api/commandes-fil/:id/email-defaults` returns the shared `EmailDefaults` shape `{ recipients: { selected, suggestions }, subject, body, fournisseurNom, numero }` — selected = `envoi_commande=1` contacts with `"Prénom Nom"` display names, suggestions = every other visible contact with a valid email. `POST /api/commandes-fil/:id/email` body `{ to, cc?, subject, body, attach_pdf?, extra_attachments? }` sends impersonating the acting user; `extra_attachments` is base64-decoded and merged with the server-rendered PDF. PDF generation refactored into shared `buildCommandePdfData` + `renderCommandePdfBuffer` helpers consumed by both `/pdf` and `/email`. **This is also the reference screen for the shared `SendEmailDialog` (mps_designer §32 / `claude_doc/pdf_email.md`)** — the old per-screen `EmailCommandeDialog` fork was replaced with `<SendEmailDialog pdfUrl={...} pdfAttachmentLabel="commande-fournisseur-${id}.pdf" />` wired via `postEmail`.
- **HFSQL tables**: `commande_fil`, `ref_fil_commande`, `stock_fil` (linkage), `stock_fil_ged` (per-lot doc scoping), `ged`, `type_doc`, `mode_paiement`, `echeance`, `adresse`, `fournisseur`

## Sous-traitants Gestion (`/sous-traitants/gestion`)

Subcontractor management screen — a near-clone of **FilsGestion** (the fournisseur gold standard) for the `sous_traitant` entity. 3-panel `MasterDetailLayout`. Files: `apps/web/src/pages/SousTraitantsGestion.tsx`, `apps/api/src/routes/sous-traitants.ts` (mounted `/api/sous-traitants`).
- **Left**: searchable list (Building2 icon); each card shows a **type badge** (Tricoteur/Ennoblisseur/Autre/Confectionneur) + an **"Inactif"** badge when `est_visible=0`. List shows ALL rows (not just visible — it's where you reactivate them); search matches name/type/tel.
- **Center**: header (name + type/Inactif badges, gold Modifier) + a **"Coordonnées" card**: Type (`PopoverSelect`), Téléphone, Fax, and an **active/visible toggle pill** (mps_designer §35). The fournisseur certs/refs/commandes sections do NOT apply here.
- **Right sidebar**: 3 tabs — Info (commentaire), Contacts, Adresses — identical to FilsGestion (contacts carry `envoi_*` flags). Full unsaved-changes guard (§28), auto-edit-after-create (§25.1).
- **Detail API**: `GET /api/sous-traitants/:id` → sous_traitant + `type_label` + adresses + contacts. `GET /api/sous-traitants/type-sst` (the 4-row type catalog; `type` is a reserved word → qualified + aliased `type_label`). List/create/update/delete + `/:id/{contacts,adresses}` CRUD mirror fournisseurs.ts.
- **Encoding**: writes use the Latin-1 hex-literal `sqlText()` helper (NOT `esc()`) so accented names survive the Linux prod bridge — fournisseurs.ts still uses `esc()` and is a latent prod-write risk; new routes should follow this route, not that one.
- **FK linkage**: `contact.IDsous_traitant` and `adresse.IDsous_traitant` (same polymorphic tables as fournisseur/entreprise, different FK column).
- **HFSQL tables**: `sous_traitant`, `type_sst`, `contact`, `adresse`

## Fournisseurs Stock (`/fournisseurs/stock`)

**Reference for table-centric screens** — first screen in ETM that does NOT use `MasterDetailLayout`. Mirrors the legacy `FEN_Stock_fil.wdw` window. Layout:
- **Toolbar** (top): full-width search input + "Masquer les lots terminés" toggle pinned right (default ON)
- **Table** (fills remaining height): rounded card with split header/body — header is a non-scrolling `<table>`, body is a separate `<table>` inside an `overflow-auto` div, both share the same `colgroup` with explicit percentage widths via `table-layout: fixed`. Sortable columns: Référence, Coloris, Lot interne, Lot fournisseur, Fournisseur, Stock (kg), Stock initial, Emplacement, Date entrée. Trailing icons: Bio (Leaf), Recyclé (Recycle), T (terminé).
- **Right slide-in drawer** (`fixed right-0 top-14 bottom-0 w-[440px]`): opens on row click, contains Stock / Provenance / Stockage / Notes / Certificats cards. Modifier/Annuler/Enregistrer buttons sit in the top-right of the drawer header (no separate close X). Edit-mode whitelist: `commentaire`, `observation_freinte`, `emplacement`, `niveau`, `terminé`, `controlé`, `dernier_pointage`.
- **Drawer dismissal**: click outside drawer (closes), click same row again (toggles), click another row (switches). Implemented via document `mousedown` listener that ignores clicks inside the drawer ref or on `tr[data-stock-row]`.
- **API endpoints** (in `apps/api/src/routes/stock.ts`):
  - `GET /api/stock/fil?fournisseur=<id>&termine=all&q=<text>` — list with joined display columns
  - `GET /api/stock/fil/:id` — single row + `has_certif_bio` / `has_certif_recycle` flags
  - `PATCH /api/stock/fil/:id` — whitelisted-field update
  - `GET /api/stock/fil/:id/certif/:type` — serves bio/recycle blob with MIME detection (same pattern as fournisseurs cert serving)
- **Accented columns (platform-specific SQL)**: see `claude_doc/hfsql_odbc.md § Accented column names`. The route has a `repairAliased()` helper that runs targeted `CONVERT(col USING 'UTF-8')` on aliased text fields when U+FFFD is detected.
- **HFSQL tables**: `stock_fil`, `ref_fil`, `colori_fil`, `fournisseur`

## Fournisseurs Références (`/fournisseurs/references`)

**Master catalog of yarn references** — mirrors the legacy `FEN_Gestion_des_références_de_fil.wdw`. 3-panel `MasterDetailLayout` with:
- **Left**: Searchable `ref_fil` list, BobineIcon + reference name, subtitle with variantes/fournisseurs count + price. Bio/Recyclé icons inline per row.
- **Center header**: Standard trio (`Printer` + `AtSign` + **Modifier (`variant="gold"`)**), icon box with BobineIcon, bio/recycle badges under title, trash button exposed in edit mode.
- **Center body cards**: Spécifications (titrage/unité/nb_fil/nb_brin/prix/bio/recycle — §35 pill toggles for bio & recyclé), Composition collapsible card (list of `asso_fil_matiere` rows with % total footer flipping green↔amber at exactly 100%), Variantes de coloris collapsible card (list of `colori_fil` rows with `fournisseurs_count` badge), Stock actuel (read-only aggregate linking out to `/fournisseurs/stock?q=...`), Commandes en cours (read-only aggregate), Notes. All cards get `editSectionClass` in edit mode (even the read-only aggregates).
- **Right sidebar**: Single untabbed Info panel — Statistiques KV rows + distinct fournisseurs list linking to `/fournisseurs/gestion`.
- **Detail API**: `GET /api/references-fil/:id` returns `ref_fil` + `variantes[]` (with `fournisseurs_count`) + `composition[]` (with joined `matiere_libelle`) + `stock_total_kg` / `stock_lots` / `stock_per_variante[]` + `commande_total_kg` / `commande_lignes` + distinct `fournisseurs[]`.
- **CRUD endpoints** (in `apps/api/src/routes/references-fil.ts`):
  - `GET /api/references-fil` — list with batched `variantes_count` + `fournisseurs_count` per ref
  - `GET/POST /api/references-fil` + `PUT/DELETE /:id` — `ref_fil` CRUD (delete guarded: 409 if variantes / stock_fil / ref_fil_commande reference it)
  - `POST/PUT/DELETE /:id/variantes[/:coloriId]` — `colori_fil` CRUD (delete guarded: 409 if in stock_fil / ref_fil_commande / asso_colorisfil_frs)
  - `POST/PUT/DELETE /:id/compositions[/:assoId]` — `asso_fil_matiere` CRUD, **Windows-only writes** (returns 501 on Linux — column names `IDasso_fil_matière`, `IDMatière`, `recyclé` are unreachable via the Linux HFSQL bridge)
  - `GET /lookups/matieres`, `GET /lookups/unites-titrage`
- **Accented column handling**: normaliser helpers in-file (`normalizeRefFilRow`, `normalizeAssoFilMatiereRow`, `normalizeMatiereRow`) map any platform's key shape to ASCII (`recyclé`/`recycl` → `recycle`, `IDasso_fil_matière` → `IDasso_fil_matiere`, `IDMatière` → `IDmatiere`, `IDmatière_première` → `IDmatiere_premiere`). `ref_fil.recyclé` is excluded from INSERT/UPDATE column list on Linux. Same approach as `stock.ts`.
- **Pourcentage units**: `asso_fil_matiere.pourcentage` is stored as a **decimal fraction 0..1** in HFSQL (0.31 = 31%). The frontend multiplies by 100 for display and divides by 100 on write.
- **HFSQL tables**: `ref_fil`, `colori_fil`, `asso_fil_matiere`, `matiere_premiere`, `unite_titrage`, `asso_colorisfil_frs` (read-only here — linking still lives in Fournisseurs/Gestion), `stock_fil` (aggregate read), `ref_fil_commande` (aggregate read), `commande_fil` (joined for etat filter)
- **Out of scope for Phase 1** (see plan `effervescent-percolating-tarjan.md`): variante↔fournisseur linking drawer, `offre_fil`, full PDF print, full email send via `SendEmailDialog`. Print + Email buttons are §18 A-bis placeholders.

## Divers Références (`/divers/references`)

**Master catalog of miscellaneous articles** (`ref_divers`) — mirrors the legacy `FI_Ref_Divers.wdw`. Client order / devis lines point at these rows with `TYPE = 3`. **Fiche** layout (3-panel `MasterDetailLayout`):
- **Left**: search + segmented `En cours` / `Archivé` filter (§5), card shows designation, stock total in the ref's unit, variation-axes summary (`Couleur · Taille — 48 valeurs`) and the display price (or `Tarifs détaillés`).
- **Center header**: standard trio (`Printer` + `AtSign` placeholders §18 A-bis) + Archiver/Désarchiver icon button + **Modifier (`variant="gold"`)**. Badges under the title: unit, active variation axes, `Archivée`. Trash exposed in edit mode.
- **Center body cards**: *Identification* (unité `PopoverSelect`; **prix unitaire only when the reference has no variation axis** — legacy hides it otherwise, and the slot becomes a read-only `Tarification` recap), *Variations*, *Tarifs*, *Observations* (hidden in view mode when empty).
- **Right sidebar**: two tabs — `Stock` (total headline + one card per `stock_divers` row, labelled by its variation combination) and `Commandes` (utilisation KV recap + the 40 most recent `ligne_commande_client` rows with client, N°, qty × prix, date).

### Variation model (reverse-engineered — the WinDev sources are PCS-compressed)

- `ref_divers.sTypeVariation1` / `sTypeVariation2` name the two **axes** (`Aucun` | `Couleur` | `Taille` | `Reference` — note: no accent on `Reference` in the stored value).
- `ref_divers_variation` holds the **values**; `niveau` = which axis (1 or 2). `niveau = 0` rows are pre-`niveau` leftovers on refs whose axes are both `Aucun` — unreachable in the legacy UI, surfaced here as a read-only "valeurs héritées" note.
- Turning an axis back to `Aucun` while values still exist returns **409** (it would orphan the tarif / stock rows keyed on them).

### Price model

| Case | Where the price lives |
|---|---|
| No variation axis | `ref_divers.prix_unitaire` (flat field on the Identification card) |
| Axis(es), *Global* mode | one `tarif_divers` row with `IDVariation1 = IDVariation2 = 0` |
| Axis(es), *Par variation* mode | one `tarif_divers` row per combination |

The mode is **derived**, not stored: any row with a non-zero variation id ⇒ `detail`. The Tarifs card's segmented `Saisie du prix` switch (legacy combo) calls `POST /:id/tarif-mode`, which is destructive in both directions and therefore goes through `ConfirmDialog`. Switching to `detail` seeds every combination from the previous global price, but **skips seeding above 200 rows** (Tissu Voltige is 19 couleurs × 29 tailles = 551) rather than firing hundreds of INSERTs at the shared HFSQL server — the grid then opens blank and each cell upserts on blur. Price cells are **not** part of the header save: each commits its own `PUT /:id/tarifs` on blur and the response rehydrates the detail cache via `setQueryData` (§31.6).

### Endpoints (`apps/api/src/routes/references-divers.ts`)

- `GET /api/references-divers?archived=0|1` — list with batched variation count / stock total / global tarif per ref
- `GET /api/references-divers/:id` — header + `variations[]` + `tarifs[]` + `tarif_mode` / `tarif_global` + `stock[]` + `commandes[]` + `usage{}`
- `POST /` (placeholder row) · `PUT /:id` (409 on duplicate designation, 409 when disabling a populated axis) · `DELETE /:id` (409 while stock / order / devis / expédition lines reference it — "Archivez-la plutôt"; variations + tarifs cascade)
- `POST /:id/archive` · `POST /:id/unarchive`
- `POST/PUT/DELETE /:id/variations[/:vid]` (delete 409 while stock / order / expédition rows use the value; its tarif rows cascade)
- `PUT /:id/tarifs` (upsert one combination, collapses legacy duplicate rows) · `POST /:id/tarif-mode`
- `GET /lookups/unites`, `GET /lookups/types-variation`

### HFSQL notes

- **`ref_divers.archivé` is accented** — never named in SQL. Reads go through `SELECT *` + `pickKey(/^archiv/i)`; the archive flip is a named `UPDATE` on Windows and a delete + positional reinsert on Linux (`REF_DIVERS_PHYSICAL_COLS`), same shape as `references-ecru.ts`. The create INSERT simply omits the column (defaults to 0 = en cours).
- `ligne_commande_client.TYPE` / `ligne_devis_etm.TYPE` are reserved words — always aliased.
- Unit enum is the shared one (1 Kg, 3 Ml, 4, 5 m²) but the Divers screens label `4` as **Pièce** (the legacy Divers combo) rather than the generic "unité". Values outside the enum (legacy `255`) render as `—` and round-trip untouched.
- **HFSQL tables**: `ref_divers`, `ref_divers_variation`, `tarif_divers`, `stock_divers`, `ref_divers_expedie` (guard only), `ligne_commande_client` / `ligne_devis_etm` (usage), `commande_client` + `client` (Commandes tab)

## Finis Tarifs (`/finis/tarifs`)

**Price simulator** (`ref_tarif`) — ports the legacy `FI_Tarifs.wdw`. A simulation is a costing *sandbox*, not a catalog entry: the user types every physical parameter, picks a yarn composition and a treatment list, and reads the resulting sale price across nine order-quantity tranches. Nothing here feeds the real catalog, which is why every input — including each yarn's €/Kg — is editable. **Fiche** layout (3-panel `MasterDetailLayout`):

- **Left**: search + segmented `En cours` / `Archivées` / `Toutes` filter (§5). Card shows the name, a hue-per-level teinture chip (`Sans teinture` stone / `Simple` sky / `Double` violet), and `poids g/m² · laize cm · N fils`.
- **Center header**: Trash (destructive icon) + **Modifier (`variant="gold"`)**. Badges: teinture chip, `rendement Ml/Kg`, `Archivée`. No Print/Email — the legacy screen has none either.
- **Center body cards**: *Composition* (table Référence / Coloris / Prix / %, a green-or-amber total-% badge, a `Coût matière €/Kg` footer, row click → inline edit, §7.1 dashed "Ajouter un fil"), *Paramètres* (prix de tricotage, poids rouleau, rendement, laize, poids, freinte + a `Pourcentage` / `Au Kg` port switch), *Ennoblissement* (Sans / Simple / Double + Blanc / Tous Coloris segmented, multiplicateur, treatment chips with add/remove), *Commentaire*.
- **Right sidebar**: two tabs — `Tarif` (the 9-tranche table, click a row to see its full cost breakdown in the shared gold `CostSection` rendering) and `Simulation` (free simulation at any weight). Below them, the §29 status pill `En cours` / `Archivée`.

### Live preview

`POST /tarifs-fini/:id/preview` prices **unsaved** parameters, so the right panel recalculates while the user is still typing — that is the point of the screen. The query key is the serialised parameter set, debounced 400 ms in edit mode (0 in view mode) and the request body is parsed back out of that same key, so a cache entry can never disagree with the parameters it priced. Composition and treatment edits persist immediately (same model as the FilsGestion sub-forms) and only invalidate the detail + calc queries.

### Pricing model (`apps/api/src/lib/pricing-ref-tarif.ts`)

Shares the catalog pricer's maths — `COEFFICIENT_V2` margin bands, `poids = rolls × poids_rouleau + 1` band lookup, +5 % packaging, −5 %/−10 % knitting rebates at 15/30 rolls, 3 % shipping on the 30-roll tranche — with **two deliberate differences**, both reverse-engineered from the live data:

1. The ennoblissement uplift is the manual `ref_tarif.multiplicateur`, **not** `multiplicateurMatel(rendement)`. Simulation 522 has rendement 3,78 (MATEL would say ×1,03) yet prints `X1` and its nine prices only reproduce with ×1.
2. The knitting price is the typed `prix_tricotage`; there is no `ref_ecru` behind a simulation.

`apps/api/src/scripts/check-ref-tarif-parity.ts` pins both against the legacy screen (46/46 exact on simulations 522 and 514, all 18 tranche prices plus the tranche-0 breakdowns).

The free simulation inverts the same formula: give it a coefficient and it returns the price; give it a target €/Ml and it solves the coefficient (clamped at 0 below cost).

### Data model

| Table | Role |
|---|---|
| `ref_tarif` | one row per simulation. `ok_tarif = 1` ⇒ archivée. `IDteinture` drives the dye mode (0 = sans; `teinture.simple_teinture` splits simple/double, `designation_interne` splits Blanc / Tous Coloris) — **`avec_teinture` on this table is a vestigial copy of the source ref and is not read**. Port mode is *derived*: `port_pct > 0` ⇒ percentage, else the flat `port_fixe` €/Kg; saving zeroes the unused column so the mode round-trips. |
| `asso_fil_tarif` | composition. `prix` is a per-simulation **snapshot** the user overrides — never a live read of `ref_fil.prix_kg`. Importing from a ref_fini snapshots the catalog price at import time, which is why an old "Copie de 081A" keeps pricing its 2026 yarn. |
| `asso_traitement_tarif` | applied treatments, one row per application — the same treatment may repeat (simulation 514 carries Chardonnage ×4). Its `metrage` / `coeff` / `pv_*` columns are legacy leftovers, always 0. Ordered by `traitement.ordre` for display. |

### Creation modes (`POST /api/tarifs-fini`)

- `from_fini` — seeds geometry + freinte + rendement from `ref_fini`, knitting price + roll weight from its `ref_ecru`, the écru's composition (prices snapshotted, coloris price preferred over the ref's), and `traitement_ref_fini`. `avec_teinture` 1/2 maps onto the "Tous Coloris" dye of that level (7 / 5). This is how every "Copie de …" row in the legacy data was made.
- `duplicate` — copies an existing simulation whole.
- `blank` — poids rouleau 20 Kg, port 5 %, freinte 10 %, sans teinture.

### Endpoints (`apps/api/src/routes/tarifs-fini.ts`)

- `GET /api/tarifs-fini` — list with batched composition-line count and resolved dye mode/shade
- `GET /:id` · `PUT /:id` · `PATCH /:id/archive` · `DELETE /:id` (children cascade)
- `GET /:id/tarif?poids=&coefficient=&prix_cible_ml=` (saved params) · `POST /:id/preview` (draft params)
- `POST/PUT/DELETE /:id/fils[/:lineId]` · `POST/DELETE /:id/traitements[/:lineId]` — all scope-guarded on the parent id, all returning the refreshed child list
- `GET /lookups/fils` (ref_fil + its coloris + prices), `/lookups/traitements`, `/lookups/teintures`, `/lookups/refs-finies` — **declared before `/:id`** so Express doesn't swallow them

### HFSQL notes

- `ref_tarif.reference` / `.commentaire` hold accented text under **ASCII column names** — safe to name in SQL, but reads need `fixEncoding()` and writes need `sqlText()` (Latin-1 hex literal). Round-trip verified including `«  »` guillemets.
- Composition labels come from flat queries + a JS merge, never a JOIN + `CONVERT` (which collapses the result set on the Linux bridge).
- **HFSQL tables**: `ref_tarif`, `asso_fil_tarif`, `asso_traitement_tarif`, `tranche_tarif_ennoblissement` (`IDsous_traitant = 0`), `traitement`, `teinture`, `ref_fil`, `colori_fil`, `ref_fini` + `ref_ecru` + `composition_ecru` + `traitement_ref_fini` (import only)

---

## Clients TRM — the second `client` ledger (`routes/clients-trm.ts`)

The `client` table is partitioned by `IDsociete` (1 = ETM, 2 = Tricotage Malterre, 3 = Confection), so this API serves **two** "Gestion client" screens: ETM's `/clients/gestion` (`routes/clients.ts`, mounted `/api/clients`) and the TRM app's (`routes/clients-trm.ts`, mounted `/api/clients-trm`). The TRM screen itself lives in the sibling repo, `TRM/apps/web/src/pages/ClientsGestion.tsx` — it is deliberately **not** an `@etm` shared screen, because the two fiches show different fields.

- **Shared plumbing → `lib/clients-common.ts`**: `sqlText` / `numOf` / `strOf` / `pick`, `requirePermission`, `repairNames`, `countClientActivity`, the accented-flag helpers (`setClientFlag` / `readClientFlag`) and `registerContactAdresseRoutes()`. Both routers import from it; neither redefines them. `contact` / `adresse` are polymorphic on `IDclient` and NOT partitioned, so their CRUD is registered verbatim on both mounts.
- **What is TRM-only**: `client.rib`, `client.domiciliation`, `client.IDtransporteur`, and « Attente paiement facture » = the accented **`client.bloqué`** flag (verified: A.E.T. / IDclient 627 is the only société-2 client with `bloqué = 1`, and the only one whose legacy checkbox is ticked). Plus two center panels — Historique des commandes and **Stocks de fil** (client-owned yarn lots: TRM knits à façon, so `stock_fil.IDclient` is the owner).
- **What is ETM-only, and therefore never NAMED by `clients-trm.ts`**: `client_interne`, `IDsecteur_activite`, `IDactivite`, `journal_commercial`, `dernier_contact`, `inclureRapportQualite`, `pct_ajeol`. The TRM fiche has no field for them, and an unnamed column keeps its stored value while a named one would be zeroed on every TRM save. Same reasoning in reverse for `clients.ts` and the TRM-only columns.
- **`tva` and `code_comptable` are partitioned too.** Serving ETM's rows to the TRM screen would silently rewrite a client's VAT to another company's row on the next save — TRM's « Vente à façon » is `IDcode_comptable = 1` (701103), ETM's « VENTE FACON » is 8 (707302).
- **`bloqué` writes go through `setClientFlag`**, never a named `SET`: the Linux bridge rejects accented identifiers, so it uses the delete + positional-reinsert path (same as `archivé`). It re-reads the row, so it MUST run *after* the plain-column `UPDATE`.
- **TRM order lines add `TYPE = 4`** (`type_sst` 4 = Confectionneur — 175 legacy rows, all mirrors of ETM sst lines on the "Ets Malterre" customer). Their ids resolve against the écru catalog, so the historique reads them exactly like type 1.
- **Unlike the ETM historique, the TRM one does NOT filter `IDcommande_ETM = 0`**: on this side the 2 518 mirrored orders ARE the work ETM ordered from TRM.
- **Not reproduced**: the legacy « Stocks de fil » panel's third radio, *En Attente*. `terminé` is the only state flag on `stock_fil`, and it is what makes the legacy screen show an empty "En Cours" list for A.E.T. (all 26 lots `terminé = 1`). Ruled out as the third state: `niveau` (rack level, paired with `emplacement`), `controlé` (0 on every open lot) and OF affectation (all 26 A.E.T. lots are linked to one, which would make "En Cours" non-empty). The `.wdw` source is PCS-compressed. Same story for the historique's « Marge Brute » column, kept but always empty.
