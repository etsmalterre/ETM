# Worktree merge log

Newest first. `/feature-complete` prepends one entry per screen it lands on `master`, so
other worktrees see what changed when they rebase. Format:

```
## <date> — feat/<name>
<one-paragraph note: what the screen does / what changed>
```

<!-- entries below -->

## 2026-07-27 — feat/issue-tracker
Tickets — **"Mes tickets" hides closed tickets behind a drawer, and the header trigger gets a
red unread badge. LIVA ticket widget bumped to feature version 1.1.0.** (1) The list view now
splits on `isClosedStatus` (new in `tickets/types.ts`, covering `resolu` / `ferme` /
`ne_sera_pas_corrige`): open tickets render directly, closed ones collapse behind a single
`bg-zinc-100/80` row carrying the total count and a rotating chevron (§23 collapsible-section
language). The row list moved into a shared `TicketRow` component so both sections render
identically. (2) **Unread tracking with no DB change**, which was the open question: the LIVA
tracker has no per-user read state and no webhook, but `GET /bugs` turns out to return *full*
bug objects (`comment`, `fixed_in_version`, `resolved_at`, `updated_at`), so one poll of the
existing list endpoint is enough. New `useTicketNotifications.ts` derives a per-ticket
*signature* from the fields a reporter actually cares about (`status | comment |
fixed_in_version | resolved_at`) and stores the last-seen value in `localStorage` under
`mps.tickets.seen.<IDutilisateur>`. Deliberately **not** `updated_at`: that also moves on
assignee / internal-title churn and would badge tickets that explain nothing when opened. The
store is **seeded silently on first run** (adopt every current signature, show zero unread),
otherwise every user's first load would badge their whole history. Unread rows get the gold
attention frame plus a dot, opening a detail clears that ticket, "Tout marquer comme lu"
clears the rest, and the drawer **auto-expands when it holds unread tickets** so a
just-resolved ticket is not hidden exactly when the badge sends the user looking for it.
(3) Plumbing: the list fetch moved out of `useTickets` into a React Query query
(`['my-tickets', userId]`, `per_page=100` so the drawer and the count see the whole history
instead of page 1) shared by the header badge and the modal, backed by a module-level
seen-store with `useSyncExternalStore` (plus a cross-tab `storage` listener) so the two
surfaces can never disagree. Polling is 5 min + on window focus, and stops **permanently** on
400 / 401 / 503 (no mapped email, no session, tracker unconfigured) since none of those heal
by retrying and each poll costs a session lookup. `markSeen` also writes the fresher detail
object back into the list cache, otherwise a stale cached signature relights the badge on the
next render. `useTickets` keeps only the write side (submit / detail / attachments) and now
exports `ticketFetch` / `mapTicket` / `listMyTickets`. Verified in the browser: silent
seeding, correct count after tampering with stored signatures, drawer auto-expansion, and the
badge decrementing when a detail is opened. (4) The `issue_tracker_integration` skill (in
`C:\dev\claude_config`) was versioned in the same pass: CONTRACT.md gains a **§ Read state**
with the binding rules for this pattern, the two new UX invariants, and the `GET /bugs`
full-object / `per_page=100` findings; SKILL.md gains a **§ Feature version** with a
changelog, the "record the version marker in the host repo" rule, and an upgrade path for
projects still on 1.0.0. The marker lives at the top of `TicketModal.tsx` and in the Tickets
row of `CLAUDE.md`. Note: this branch had **no API changes** and no HFSQL schema change.

## 2026-07-27 — feat/expe
Email — **Cci (bcc) support app-wide + auto-copy of the sous-traitants holding the shipped
rolls.** (1) `SendEmailDialog` gains a Cci field alongside Cc, and both are now **collapsed
by default**: two small `Cc` / `Cci` toggle pills sit at the right of the "À" label row
(gold-active, §5 segmented-filter language) and the inputs render only when toggled on — the
reclaimed height goes to the message textarea. Closing a toggle clears that field's value, so
a hidden field can never smuggle recipients into a send. A field the server pre-filled opens
**automatically** on hydration. Contract: `EmailDefaults.bcc?: string[]` +
`SendPayload.bcc: string[]` in `lib/email.ts`; `postEmail` forwards `bcc` when non-empty.
API side: `bcc: z.array(z.string().email()).optional()` added to all 11 email schemas and
threaded to `sendMail` at all 13 send sites (expeditions ×2, commandes client ×2 / fil / sst
×2, devis, factures, clients tarifs, entreprises, études coloris ×2, transferts) —
`lib/gmail.ts` already emitted the `Bcc:` header, so the MIME builder was untouched. (2)
Expéditions formelle (`/expeditions/formelle/:id/email-defaults`, shared by Clients ›
Expéditions **and** the Clients › Commandes expedition tab) now returns a pre-filled `bcc`:
the sous-traitants **physically holding the rolls being shipped**, so they know what to send
out. Resolution is by **magasin**, not by production chain — the expedition header has no sst
FK, so rolls are read from `stock_fini.IDligne_expedition` + `stock_ecru.IDligne_expedition_ETM`,
their distinct `IDmagasin` (→ `sous_traitant.IDsous_traitant`; **0 = à l'usine → nothing**)
resolved to contacts flagged `envoi_bl = 1` (visible, valid mail, deduped lowercase). New
helpers `loadExpeditionMagasinSstIds()` + `loadSstBlEmails()` in `expeditions.ts`. Bcc
addresses are included in the `envoi_email` audit rows alongside To/Cc. The **divers** bucket
gets no auto-fill (no stock link ⇒ no magasin) — the field is still there for manual entry.
Verified against the dev DB over the 15 most recent expeditions: MATEL → `mct.celine@…`,
Société Bontemps → its two BL contacts, factory-held shipments → empty.

## 2026-07-24 — feat/transfert
Transferts › Rouleaux + Fils — **the Transferts placeholder becomes two real screens**
(`/transferts/rouleaux`, `/transferts/fils`), porting legacy `FEN_Bons_de_transfert` /
`FEN_Gestion_d_un_bon_de_transfert` / `ETAT_Bon_de_transfert`. Data model (established by
live introspection — `bon_transfert`/`piece_transfert` were undocumented): header
`bon_transfert` (`type_matiere` 1=pièces / 2=fil discriminates the screens; `DATE` is a
reserved word; `commentaire` is PLAIN text; `est_valide` is dead since 02/2025 — written 0,
never shown) + polymorphic lines `piece_transfert` (`IDpiece_ecru`/`IDpiece_fini`/
`IDstock_fil`, exactly one non-zero). "Magasins" are `sous_traitant` rows with **0 = Ets
Malterre** (the actual `magasin` table is broken/unused); stock location =
`stock_ecru.IDmagasin` / `stock_fini.IDmagasin` / `stock_fil.IDMagasin` (capital M). New
API cluster `apps/api/src/routes/transferts.ts` (`/api/transferts`): infinite list, detail
with enriched lines, create (defaults destination address to the sst's default; `IDadresse
= 1` for Ets Malterre), update, delete, `available` stock at the source (TOP 200 most
recent + server-side `?q=` — magasins hold 30k+ legacy rolls; stock_fil reads follow
stock.ts's IS_WINDOWS split + terminé-by-prefix), bulk piece add / remove. **Stock moves
immediately** (user-confirmed legacy semantics): add → roll/lot's magasin = destination;
remove/delete → back to source; source/destination therefore lock (400 `magasins_locked`)
once lines exist. PDF `BonTransfertPdf.tsx` renders the "Bordereau de livraison N° X"
(per-référence bands with designation - composition — fini composition comes from the
parent écru ref —, Coloris/Numéro/Lot/Poids/Métrage columns, gold grand-total; fils
variant Lot/Référence/Coloris/Poids/Fournisseur). Email pair (`email-defaults` + `email`)
targets the destination sous-traitant's contacts (`envoi_bl` → selected); no `envoi_email`
audit row (the type_doc catalog has no "bon de transfert" entry). Web: shared
`pages/transferts/TransfertsScreen.tsx` (Fiche master-detail) behind thin
`TransfertsRouleaux`/`TransfertsFils` wrappers — piece cards with TM/Fini/Bobine icons +
2e-choix badge, totals footer (pièces · kg · Ml), §31 in-screen picker drawer (TM/Fini
tabs, search, checkbox multi-select, "Tout sélectionner", works in view mode since adds
are immediate), sidebar Info/Adresse/Commentaire cards (magasin PopoverSelects use a +1 id
offset so Ets Malterre id 0 survives the empty-sentinel), Nouveau dialog (source defaults
Ets Malterre, transporteur defaults Divers), unsaved guard, ConfirmDialog, SendEmailDialog.
Verified end-to-end on the dev DB: full add/remove/delete cycles for both kinds with
magasin flips checked in-table, PDFs rendered against real legacy bons, CSV TAD & legacy
"Transport" button intentionally omitted.

## 2026-07-24 — feat/cmd-client
Clients › Commandes — **Affectation drawer UX overhaul + left-list color standard.**
(1) Roll état pills: shared `EtatPill` gains a `variant` prop — `soft` (pastel, tables)
vs new `solid` (saturated bg, white text; same hue map, single source) — and roll cards
anchor the solid pill at the FAR RIGHT of the row (the one element present on every row
gets the edge; conditional icons/buttons flow in on its left). Redundant per-roll coloris
dropped (drawer is already line-scoped). (2) Batch affectation: per-row "Affecter"
buttons replaced by checkbox multi-select in Stock disponible (same checkbox UX as the
quick-ship selection); the two selections are mutually exclusive and drive ONE bottom
action bar — appears only when ≥1 roll ticked, shows Tout/Aucun + count + summed qty,
button flips Expédier ↔ Affecter per selection source. New all-or-nothing endpoint
`POST /:id/lignes/:ligneId/pieces/:kind/affecter` (validates every roll with the per-roll
PUT rules before any UPDATE, returns refreshed payload). (3) Left list: cards now
NEUTRAL by default (delivery-urgency red/amber removed from list cards); amber liseré =
commande non affectée (`phase a_affecter`); amber counter pill flush right of the search
input (SST-pill recipe: hidden at 0, tinted → solid when armed, toggle narrows the list,
auto-disarms on empty bucket). (4) Info tab reordered: metadata, Commentaire, Journal,
Tombé de métier commandé, Fiche client. Design system: mps_designer §37 rewritten
(two-variant état table + far-right anchor rule), new §41 (neutral-by-default left-list
liseré + search-bar counter-pill standard, per-screen color registry), §30.5 reconciled.
Tooling (from the 2026-07-24 node-sweep incident): vite dev `strictPort: true` (a
squatted port can no longer silently shift a server onto the next slot's port),
`up.mjs --restart` aborts naming a foreign port owner instead of spawning a zombie
behind a port-based "UP", `/serve-main` failure-modes documents the LIVA-tracker-on-3000
squat and warns against blanket node kills.

## 2026-07-24 — feat/finis
Finis › Références — **print menu: fiche technique + fiche tarifs PDFs.** The view-mode
header gains the §42 `DocMenuButton` contextual print menu (pattern recorded in
`mps_designer` §42 — renumbered from §41 at rebase, cmd-client took §41 — cross-ref in
§6.1) with two documents. (1) **Fiche technique**
(`GET /api/references-fini/:id/pdf`, `FicheTechniquePdf.tsx`): ports the legacy
ETAT_Fiche_technique to the MalterreDocument frame — caractéristiques (référence /
désignation / contexture via `ref_ecru.IDcontexture→contexture.nom`, min-moy-max grid for
laize HT / laize utile / poids), composition computed from `composition_ecru` (rows scoped
to the ref's `IDcolori_ecru`, falling back to the generic `IDcolori_ecru=0` rows) ×
`asso_fil_matiere` × `matiere_premiere` (both have accented column NAMES — `SELECT *` +
`pickKey(/^idmati/i)`, never named in SQL; `matiere_premiere`'s accented PK also blocks
fixEncoding so libellés repair via U+FFFD→é), stabilités/allongements, conditionnement,
observations, static douane/provenance lines (60062100 / C.E.E oui / FRANCE — no DB field
anywhere, static in the legacy report too), five ISO care symbols as inline SVGs (wash tub
shows `temp_lavage`), legacy footnotes, and the création/modification dates pinned
bottom-right (`marginTop:'auto'`). (2) **Fiche tarifs**
(`GET /api/references-fini/:id/tarifs/pdf?rlx15=0|1&rlx30=0|1`): standard (non-negotiated)
price grid for ALL coloris of the ref, reusing `TarifsClientPdf` + `calcTarifRefFini` —
coloris priced sequentially (never Promise.all — bridge flood), unpriceable ones skipped,
columns chunked 4 per grid. The menu row opens a small options Dialog with two independent
§35 pill switches ("Inclure la tranche 15 rouleaux" / "30 rouleaux", both off by default =
the standard ≤10-rouleaux grid) before generating. Both endpoints follow the
build/render-buffer split + helmet header strip; `dump-fiche-technique-pdf.ts` renders a
ref against the dev DB for inspection.

## 2026-07-24 — feat/commande-client
Clients › Commandes — **Historique tab surfaces legacy "envoyée" confirmations.** The
legacy WinDev app never writes `envoi_email` for commandes client; it only flips the
accented boolean `commande_client.envoyé_client` (no date, no recipient). The historique
endpoint now also reads that flag (`SELECT *` + `pickKey(/^envoy/i)` — the accented column
is never named in SQL, safe on Windows ODBC and the Linux bridge) and appends an undated
`{kind:'legacy'}` event when set. If a dated MPS_NG confirmation send exists for the
commande, the legacy card is suppressed (the dated card is strictly more informative).
Frontend renders the legacy event as a muted-icon card titled "Confirmation de commande"
with the italic sub-line "Envoyée depuis l'ancienne application"; MPS_NG sends keep their
gold icon + timestamp + recipients. Known one-way limitation (documented, unchanged):
sends from MPS_NG cannot set `envoyé_client` through the Linux bridge, so the legacy app
still shows those as not sent. Investigation context: the original "card missing after
send" report was the pre-v0.1.1 stale-cache UI (fixed by the historique auto-refresh
invalidation deployed 2026-07-23); prod writes were verified intact. Also adds the
diagnostic script `apps/api/src/scripts/probe-historique-cmd-client.ts` (dumps recent
type-7 `envoi_email` rows + replays the historique SELECT for a given commande).

## 2026-07-24 — feat/expe
Clients › Expéditions — **delete now completes in the UI.** Clicking "Supprimer" in the
confirm modal deleted the expedition server-side but the screen froze on the open modal:
`deleteMut.onSuccess` read the list cache as a flat `ExpeditionListRow[]` and called
`.filter()` on it, but the expéditions list is a `useInfiniteQuery`, so the cache entry is
`{ pages, pageParams }` — the `TypeError` aborted the handler before it could close the
dialog, exit edit mode, or invalidate the list (handler predates the list's conversion to
infinite pagination; SousTraitantsCommandes, the only other infinite-list screen, was
already correct). Fix in `ClientsExpeditions.tsx`: read the cache as
`{ pages: ExpeditionListRow[][] }` and flatten before filtering. Post-delete behavior now
lands as designed: modal closes, edit mode exits, selection moves to the first remaining
expedition or the empty placeholder if none. Verified live through the browser (created a
throwaway expedition via the API, deleted it through the UI; no console errors).

## 2026-07-24 — feat/facturation
Clients › Facturation — **"Faire un avoir" from a definitive facture.** New icon-only
`FileMinus2` button in the detail header (leftmost of the Imprimer/Email trio; definitive
non-avoir factures only, `edit_factures` permission) opens a light confirm, then
`POST /factures/def/:id/avoir` creates a proforma Avoir prefilled from the facture: billing
header copied as-is (client, adresse, mode de paiement, échéance, TVA, n° TVA, code
comptable), `TYPE = 2`, DATE = today, every line duplicated into `ligne_facture_prov` with
positive amounts (credit sign stays presentational) and `IDligne_expedition` carried over
for traceability — the original facture still references those lines, so deleting the avoir
never reopens an expedition. 409 if the source is itself an avoir. On success the UI jumps
to the new avoir in the Proforma bucket in edit mode (clears search, relaxes a
'Factures'-only type filter so auto-select can't steal the selection), where the user trims
the lines to reimburse and later converts it like any proforma.

## 2026-07-23 — feat/responsive
App-wide (17 master-detail screens) — **phone/stacked mode no longer auto-jumps into the
first row's detail, and "Retour" works.** Root cause: every master-detail screen auto-selects
the first list row whenever nothing is selected (a desktop convention — the detail pane sits
beside the list). Below 1240px `MasterDetailLayout` stacks (list OR detail), so a null
selection IS the list view: the effect force-navigated to the first row's detail on arrival
and re-selected it the instant "Retour" set the selection back to null. Fix: new shared hook
`apps/web/src/hooks/useAutoSelectFirst.ts` — reproduces the historical behavior verbatim in
full/compact modes, but in stacked mode never picks a row on its own, and when the selection
drops out of a filtered list it falls back to null (return to the list) instead of jumping to
another row's detail. Two behaviors: `'fill'` (load-once auto-select: SettingsUtilisateurs,
Entreprises, FilsGestion, SousTraitantsGestion, FilsReferences, FinisReferences) and `'sync'`
(the mps_designer §5 canonical stillVisible reselect: ClientsGestion, ClientsCommandes,
ClientsFacturation, ClientsDevis, ClientsExpeditions, EtudesColoris, FilsCommandes,
ProspectsDemandes, QualiteSuiviLots, TombeMetierReferences), with `suspended` carrying each
screen's existing isEditing/isFetching/autoEditForId guards. SousTraitantsCommandes keeps its
lastAppliedListKey filter-reset logic and gets the same stacked gate inline via
`useResponsiveLayout`. Table-centric screens (FilsStock, FinisStock) were never affected.
Verified live at 390px (Utilisateurs, Fils › Commandes land on the list; Retour sticks) and
at 1920px (first row still auto-selected, 3-panel layout unchanged).

## 2026-07-23 — feat/issue-tracker
App-wide — **ticket widget: instant modal open, background screenshot capture.** The
header "Envoyer un ticket" button used to rasterize the whole page with `html-to-image`
(with `cacheBust: true`, re-downloading every image on the page) BEFORE opening the
modal — a multi-second spinner on the header button. Now the modal opens immediately and
the capture runs in the background: `cacheBust` is dropped, and the capture's `filter`
excludes any element carrying `data-dialog-root` (the marker our `Dialog` puts on its
portal) so the ticket modal never appears in its own screenshot — safe because dialog
overlays cover the header button, so no other dialog can be open at click time.
`TicketModal` gains a `capturingScreenshot` prop: while capturing, the "Capture d'écran"
attachment button shows a spinner + "Capture en cours..." and is disabled, becoming
clickable once the file arrives (capture failure leaves it disabled, as before).

## 2026-07-23 — feat/app-wide
App-wide — **app versioning + refresh from the profile menu.** The monorepo root
`package.json` `version` (currently 0.1.0) is now the single source of truth for the app
version: `apps/web/vite.config.ts` reads it and injects it as the `__APP_VERSION__`
constant (mirrored in `vitest.config.ts` so unit tests resolve it; declared for TS in the
new hand-written `apps/web/src/vite-env.d.ts`, which needed a `.gitignore` negation
against the stale-artifact `apps/web/src/**/*.d.ts` rule). The header profile menu
(avatar, top right) gains two items below "Changer d'utilisateur": an **"Actualiser
l'application"** button (RefreshCw icon, spins while pending) that calls
`registration.update()` on all service workers then reloads — with the PWA's
`autoUpdate` registration this pulls a fresh deploy without closing the app — and a
**"Version X.Y.Z"** footer line under a divider. Release convention documented in
CLAUDE.md §Versioning: bump the root package.json version, deploy; per-package versions
in `apps/*` are not displayed and need no syncing.

## 2026-07-23 — feat/facturation
Clients › Facturation — **one-off prod data backfill: legacy invoices marked "envoyée".**
The list derives `est_envoye` from the `envoi_email` audit log (`IDtype_doc = 19`,
`IDreference = IDfacture`), so the 3 293 of 4 870 definitive factures/avoirs issued or
sent outside the app (n°4300, Oct 2020 → n°9174, Jul 2026; 488 avoirs) had no log row and
showed the red "non envoyée" border. New script
`apps/api/src/scripts/backfill-factures-envoyees.ts` (dry-run / `--apply`, same pattern as
`migrate-journal-rtf-to-plain.ts`) inserts ONE marker `envoi_email` row per unsent facture
(empty `adresse`, `notes = 'backfill marque envoyee 2026-07-23'`) — idempotent, skips
anything already logged. **Executed against prod HFSQL (10.10.20.2, prod creds from the
API server env) on 2026-07-23: 3293/3293 inserted, 0 failures, verification pass reports
0 unsent.** Undo: `DELETE FROM envoi_email WHERE IDtype_doc = 19 AND notes = 'backfill
marque envoyee 2026-07-23'`. Side effect: each backfilled facture's Historique tab shows
one recipient-less "Document envoyé" event dated 2026-07-23. New invoices still show the
red border until actually emailed.

## 2026-07-23 — feat/commande-client
Clients › Commandes — **instant Donation toggle.** The center panel (lignes view vs
"Pièces en donation" view) used to switch on the *saved* `commande.donation` flag, so
flipping the Donation toggle in edit mode required Enregistrer + Modifier before the
layout followed. `DetailMain` now receives the `editDonation` draft and, while editing,
drives the layout from it — the panel swaps instantly on toggle. Because lignes and
donation pieces are written to the DB immediately while the flag itself only persists
on Enregistrer, content mutations are gated while the draft differs from the saved
value (`donationPending`): the "Ajouter une ligne" / "Ajouter des pièces" affordances
are replaced by a French hint ("Enregistrez la commande pour pouvoir ajouter des
lignes/pièces.") until the user saves, so cancelling an edit can never leave orphaned
lignes on a donation order or orphaned pieces on a normal one.

## 2026-07-22 — feat/issue-tracker
App-wide — **in-app bug/feature ticket reporting wired to the LIVA issue tracker**
(liva-holding.com/issues, product `etm-erp`). (1) **Proxy** `apps/api/src/routes/tickets.ts`
(`/api/tickets/*`): injects the company API key + product slug from server-side env
(`ISSUE_TRACKER_URL` / `_API_KEY` / `_PRODUCT_SLUG` — **must be added to the prod API env
before deploy**, they're in dev `.env.development` only, gitignored) and resolves reporter
identity from the session cookie — name from `utilisateur`, email from the admin-managed
Paramètres › Utilisateurs mapping (`user-emails.json`, same as Gmail send; users without a
mapped email get the same French 400). List/detail are ownership-scoped by `reporter_email`;
tracker 401 remaps to 502 (never confusable with an expired MPS session); missing config →
503; timeout → 504. Attachment uploads stream multipart through after an ownership check.
(2) **Widget** `apps/web/src/components/tickets/` + trigger in `Header.tsx` (MessageSquarePlus
icon left of fullscreen): clicking captures a screenshot of the page **before** the modal
opens (lazy `html-to-image` — new web dep), then a three-view modal (form / Mes tickets /
détail) with Bug↔Fonctionnalité tabs, per-category severity pills (fixed semantic palette
shared with the tracker), title/description, attachment zone (pre-captured screenshot toggle
+ file picker, 5×5 Mo, thumbnails + lightbox), and auto-captured navigation context
("Menu › Sous-menu (path)" from the router). Attachment failure after create is non-fatal
(warning, ticket still reported with its human n°). Verified end-to-end against the prod
tracker (test ticket n°1014 with screenshot, since closed).

## 2026-07-22 — feat/stock-fini
Finis › Stock — **granular edit sub-permissions, field-scoped search chips, Excel export,
plus dev-resilience fixes.** (1) **Sub-permissions**: `PERMISSION_KEYS` entries may now
carry `parent: '<key>'`; Paramètres › Utilisateurs renders those indented under the parent
toggle, visible only while it's granted (toggling the parent ON grants every child, OFF
removes them). Storage stays flat, so gated routes must check parent AND child.
`edit_stock_fini` gained four: `_stockage` (emplacement/conteneur/pointage), `_etat`
(2ᵉ choix, IDetat), `_affectation` (don/déstockage), `_notes` (observations/observation
sous-traitant) — enforced per field-group on `PATCH /stock/fini/:id`, and on
`PATCH /stock/fini/batch` which **was entirely ungated** (no auth, no permission check).
The drawer only renders inputs + the gold edit highlight for granted sections, sends only
those field groups, and hides "Modifier" when none are granted; Édition groupée hides
un-granted fields and its button. **Migration note**: users who already had
`edit_stock_fini` see nothing editable until sub-keys are granted — toggle the parent off
and on to grant all four. The permission tab's category cards are now **collapsed by
default** with a `granted/total` badge. (2) **Field-scoped search chips**: typing in the
Finis › Stock search opens a suggestion popover ("« bd » — toutes les colonnes" + one row
per column); picking one converts the term into a chip (`Emplacement : BD`) restricting it
to that column. Chips AND-combine with each other and the free text; × or Backspace
removes. Fixes the real complaint that searching "BD" for emplacement BD also matched every
lot/observation containing "bd" (14 rows → 13 correct ones). Free typing is unchanged.
(3) **Excel export**: icon-only toolbar button opening the same column-picker dialog as
Rapport sst (20 columns, per-user localStorage memory), exporting exactly the visible rows
(chips + search + sort) via lazy SheetJS; real date cells, numeric poids/métrage.
(4) **Magasin**: `IDmagasin = 0` (at the factory) now displays **"Malterre"** instead of an
em dash, normalized in the query `select` so table, drawer, sort and the Magasin chip agree.
(5) **Dev resilience** — a wedged native `odbc.connect()` poisons the whole API process
(in-process retries all time out while a fresh process connects in <1s); `hfsql.ts` now
counts consecutive connect timeouts and, in dev, **touches `src/index.ts` to force a tsx-watch
restart** (`process.exit()` does NOT work — tsx watch only reruns on file change). Verified by
reproducing the wedge. UserPicker drops to `retry: 1` + a "Réessayer" button so this surfaces
as an error in ~30s instead of a ~50s silent spinner. Also: the 7 baseline `@mps/api` tsc
errors are **fixed** (`tsc --noEmit` is now clean — the dead `params` arg was removed from all
three query layers since HFSQL rejects `?` placeholders), and `vitest.config.ts` scopes
`include` to `src/**` + `passWithNoTests` so `pnpm --filter @mps/web test` no longer always
fails by collecting the Playwright e2e specs.
## 2026-07-22 — feat/gestion-client
Clients › Gestion — **tarif print/email search, tabbed Référence client dialog, view/edit
tarif split.** (1) **TarifsSelectionDialog search** (Isabelle's request): the "Imprimer /
Envoyer les tarifs" ref×coloris picker gains an auto-focused, accent-insensitive search
field (matches ref client / ref interne / coloris); Tous/Aucun operate on the filtered
rows and selection survives filter changes so multi-ref picks work. (2) **RefSettingsDialog
is now tabbed** (Informations / Tarifs): fixes the July-16 regression where closing the
coloris drawer on edit-mode entry made TarifModeDialog unreachable for users with
`gestion_references`. The Tarifs tab lists the ref's saved coloris with their TarifModeTag;
click opens TarifModeDialog (with `gestion_tarifs`) or the read-only TarifDialog, stacked
over the settings dialog. Settings state stores the ref **id** and re-derives from the live
`client-references` query (tarif saves refresh the tab in place), while form hydration keys
on the id so refetches never clobber the draft; Tarifs tab disabled on create. `dialog.tsx`
now supports stacking: Escape closes only the topmost `[data-dialog-root]` and body scroll
stays locked until the last dialog closes. (3) **View/edit tarif split**: TarifDialog is
pure consultation (removed the inline gold Modifier 15/30 panel and "Dupliquer le
contrat" — renewal = "Nouveau contrat" in the edit dialog); TarifModeDialog gains a
"Tranches négociées" section (15/30 rlx toggle pills with Ml · €/Ml info from the shared
`client-tarif` query, hidden in contrat mode) whose save rides along the tarif-mode PUT
(separate `/tranches` PUT only when changed).

## 2026-07-21 — feat/commande-client (2)
Clients › Commandes — **invoice auto-surfaced in Docs, affecté gauge de-doubled, drawer
metrage total.** (1) **Facture in the Docs tab**: new `GET /commandes-client/:id/factures`
walks commande → `expedition.IDcommande_client` → `ligne_expedition` →
`ligne_facture(_prov).IDligne_expedition` and returns the definitive factures/avoirs plus
open facturation proformas covering the order's shipments (`facture.IDcommande_client` is
always 0 in live data — the chain is the only reliable link; pre-link legacy rows simply
aren't found). The Docs tab renders them as read-only cards (gold `ReceiptText`, "Facture
N°9097 · Facture définitive · date") above the ged documents, opening the facturation PDF
(`/factures/:kind/:id/pdf`) in the chrome-free viewer; orphaned `ligne_facture_prov` rows
are naturally excluded by the header lookup. (2) **Affecté gauge fix**: the per-line
"Affecté X / Y Ml" aggregate (`lineReservationAggregates`) counted écru rolls that had
already been dyed into `stock_fini` rolls — the same fabric twice (commande 3643 showed
4 404,8 / 1 635,0 Ml; truth is 1 866,0). The écru leg now carries the same
`NOT EXISTS (stock_fini.IDstock_ecru = se.IDstock_ecru)` guard as the available-écru
pools, so écru only counts while still écru (at the dyer). Restores real under-coverage
signals (two 3643 lines went from green to amber). (3) **Affectation drawer**: the
"Affecté à la commande (N)" heading now also shows the summed quantity of the listed
rolls in the line's dim — "(42 · 1 866,0 Ml)" — deliberately summing the displayed rolls,
not `affecte_total` (which also counts écru at the dyer + tricotage planning).

## 2026-07-21 — feat/facturation
Clients › Facturation — **XImport accounting export + "non envoyé" red urgency on the
Définitives list.** (1) **XImport**: new `apps/api/src/lib/ximport.ts` renders the Sage
fixed-width `XImport.txt` (142-char CRLF records, Latin-1) for one day's definitive
invoices — 3 écritures per facture (client tiers TTC / compte de vente HT / TVA), journal
`VT`, pied `O2003`, accents ASCII-flattened. Column layout reverse-engineered
byte-for-byte from two legacy WinDev files and pinned by `ximport.test.ts` (byte-identical
reproduction incl. the avoir case: **avoir = D/C reversed on all 3 lines + no échéance
date**; exonération keeps its 3rd line with an empty compte and 0.00). Échéance dates
reuse `computeDateEcheance`, falling back to the invoice date for TYPE-1 ("à réception")
rules, matching legacy output. Routes: `GET /factures/ximport/summary?date=` (preview
counts + total TTC) and `GET /factures/ximport?date=` (download, Latin-1). UI: an
**XImport button pinned above the list footer, Définitives bucket only** (read-only → no
permission gate), opening a dialog with a date picker (default today), a live summary
card (factures / avoirs / total TTC), and a download button disabled on empty days.
(2) **Non envoyé**: list rows now carry `est_envoye` (definitive only — batched `DISTINCT
IDreference` probe of `envoi_email` on `IDtype_doc` 19; `IDreference` = `IDfacture`,
verified to be the same convention legacy writes, so WinDev-sent invoices read as sent).
Unsent definitive cards get the §30 red urgency frame (inset left strip, red hover +
selection ring); a number-only **red count pill next to the search bar** (same design as
the SousTraitantsCommandes urgency pills) toggles filtering the view to just the unsent
ones, hides at zero, and auto-releases when the last red row leaves. Emailing a facture
invalidates the list so the frame clears live; auto-select drives off the filtered rows;
the pill resets on bucket switch; proformas never flag (they don't log sends —
id-collision rule in the file header).

## 2026-07-21 — feat/dev-resilience
Dev tooling — **spin-up paths tell the truth about whether the app actually works.**
Motivated by a session lost to two silent failures. (1) **Wedged HFSQL connect**: an API
whose cached `connectionPromise` never resolved served `/api/health` 200 while every data
route hung forever with nothing logged — an infinite loading screen on a server the tooling
reported `UP`. `hfsql.ts` (Windows dev path) now races `odbc.connect()` against
`HFSQL_CONNECT_TIMEOUT_MS` (default 15s) and clears the cached promise on failure, so the
next request retries instead of inheriting one hung connect for the process lifetime —
matching the self-healing respawn the Linux bridge already had. (2) **Readiness vs
liveness**: new `GET /api/health?db=1` runs a real query and returns 503 when HFSQL is
unreachable; `up.mjs` and `serve-main.mjs` both probe it, plus a `checkCors()` that sends a
real `Origin` header (a plain `curl` sends none, so CORS breakage is invisible from the
terminal while the browser fails). An API predating `?db=1` reports `not checked`, never a
false `UNREACHABLE`. (3) **The main checkout got the same preflight as worktrees** — it was
the only spin-up path with no dependency install and no CORS wiring, so on a fresh machine
`/serve-main` died as an instant "NOT UP" whose real cause (no `node_modules`) sat unread in
a log. `ensureDeps()` (non-interactive: `confirmModulesPurge=false`) and `ensureCorsOrigin()`
(rewrites `CORS_ORIGIN` from `DEV_WEB_ORIGINS` rather than trusting a gitignored per-machine
file) now live in `lib.mjs` and run on both paths; `tailLog()` makes a failed start print its
own cause. (4) **`up.mjs --restart`** reuses an existing tree's slot/ports/env, killing and
respawning it — previously the create path aborted on an existing dir and hand-rolled spawn
scripts were the only way back up. Docs corrected at the source: `dev_setup.md` was itself
prescribing the single-origin `CORS_ORIGIN=http://localhost:5174` that caused the breakage.

## 2026-07-21 — feat/commande-client
Clients › Commandes — **"Expédition" wording + Commandé/Expédié on line cards.**
(1) **Terminology**: every user-facing "livraison / date de livraison" around the client
order date now reads "expédition" — line-card labels and the two "Date d'expédition" form
inputs in ClientsCommandes, the confirmation PDF's lines-table column header
(LIVRAISON → EXPÉDITION in `CommandeClientPdf.tsx`), and the per-line recap in the
confirmation email body (`- expédition <date>`). DB columns (`date_livraison`) and the
delivery-address labels ("Adresse de livraison") are untouched. (2) **Per-line shipped
quantity**: `lineReservationAggregates` in `commandes-client.ts` now also sums shipped
rolls (fini: `IDetat_stock_fini = 4` or `IDligne_expedition > 0`; écru:
`IDligne_expedition_ETM > 0`, with the same rendement conversion) into
`exp_metrage`/`exp_poids`, exposed on detail lines as `expedie` in the line's dim —
no extra queries, just added columns on existing selects. (3) **Line card redesign**:
the old `qty × prix → montant` shorthand row is replaced by a labeled stat row mirroring
the PDF table vocabulary — Commandé · Expédié · Prix u. · Montant, with the Expédition
date pinned right keeping its urgency color (new `LineStat` micro label/value block,
CardKV language). Expédié turns green when fully shipped; the affectation gauge counter
is now labeled "Affecté … / …" so reserved vs shipped can't be confused. Divers lines
skip Expédié but share the same row shape.

## 2026-07-21 — feat/signature
**Structured signature template + Malterre design + Paramètres › Utilisateurs master tabs.**
Signatures are no longer pasted HTML blobs — they render server-side from per-user fields
through one company template. New `apps/api/src/lib/signature-template.ts`:
`SignatureFields { displayName, fonction, telFixe, email }`, `renderSignatureHtml()`
(email-client-safe tables + inline styles), `hasSignatureContent()`, and the logo as either
a `cid:` inline MIME part (outgoing mail — instant display, no remote fetch) or a data: URI
(in-app previews), from the new `assets/logo-m-email.png` badge (240px, 32px corner radius).
Approved design: 96px logo, 3px gold vertical bar exactly matching the logo height, 20px
bold name, fonction alone in blue uppercase (no "— ETS MALTERRE" suffix), single
"Tél. :" line (the Mobile field was removed everywhere), blue mailto link. `gmail.ts`
gains `inlineImages` support — the alternative pair wraps in multipart/related with
Content-ID parts (shared `base64Lines` helper); `sendMail()` resolves signature + inline
images together via `getSignatureForEmail()` which now returns `{ html, inlineImages }`.
`user-profiles.ts` stores structured `signature` fields (legacy `signatureHtml` still
honored until fields are saved, then superseded); router adds
`POST /user-profiles/signature-preview` (renders the exact template for the admin form) and
`PUT /users/:id/signature` now takes fields (Zod-validated). Frontend
(SettingsUtilisateurs): SignatureEditor becomes a 4-field form (Nom affiché / Fonction /
Téléphone / Email affiché) with a debounced live server-rendered preview + legacy-signature
warning; the whole center panel is restructured into the **Classeur** master-tab pattern
(§39) — "Profil" tab (email / photo / signature cards) and "Permissions" tab (admin notice +
category toggle cards), tab resets to Profil on selection change. Tests:
`signature-template.test.ts` (render/escape/plain-fallback) + extended `gmail.test.ts`.

## 2026-07-20 — feat/signature
**User profiles: photo + HTML email signature, "Mon profil" modal, auto-signature on
outgoing emails.** New JSON side-store `apps/api/src/lib/user-profiles.ts` (mirrors
`user-emails.ts`; the HFSQL `utilisateur` table has no photo/signature columns) keeping
`signatureHtml` in `data/user-profiles.json` and photos as disk files under
`data/user-photos/<id>.<ext>`. New router `user-profiles.ts` at `/api/user-profiles`:
`GET /me`, admin `GET /users`, `GET /users/:id/photo` (self-or-admin; CORP cross-origin +
immutable cache keyed by `?v=<photoVersion>`), admin `PUT /users/:id/signature` (raw HTML,
200 KB cap, empty clears), `PUT /users/:id/photo` (multipart, 5 MB, jpeg/png/webp/gif),
`DELETE /users/:id/photo`. **Email integration in one place**: `gmail.ts sendMail` resolves
the sender's signature from the `from` address via `getSignatureForEmail()` and
`buildMimeMessage` appends it to BOTH alternative parts (raw HTML after the escaped body
div; `signatureToPlain()` conversion in text/plain) — zero changes to the ~13 send call
sites; no signature → byte-identical output. Covered by `gmail.test.ts` (first vitest suite
in apps/api). Frontend: header avatar shows the photo when set (Avatar now resets its
error state on src change); user dropdown gains a "Mon profil" item for everyone opening a
view-only modal (`components/profile/ProfileModal.tsx` — prénom/nom, email from
`/user-emails/me`, photo, signature rendered in the new sandboxed-iframe
`ui/signature-preview.tsx`); Paramètres › Utilisateurs gains two admin cards under the
email card — PhotoEditor (immediate multipart upload via raw fetch + credentials, delete,
5 Mo client pre-check) and SignatureEditor (raw-HTML textarea + live preview, EmailEditor
draft pattern); SendEmailDialog shows a read-only "Signature — ajoutée automatiquement à
l'envoi" preview strip under the Message field when the sender has one.

## 2026-07-20 — feat/commande-client
Clients screens — **UX/permission fixes batch.** (1) **Historique refreshes instantly after
email sends**: `onSend` now invalidates the matching historique query after `postEmail`
(`facture-historique` in ClientsFacturation, `commande-client-historique` in ClientsCommandes
— confirmation AND proforma —, `devis-historique` in ClientsDevis), mirroring the
SousTraitantsCommandes pattern; previously the tab only updated on reload. (2) **Empty-list
selection clear**: every master-detail "keep the selection valid" effect now clears
`selectedId` (→ placeholder) when the visible list settles empty — e.g. search narrowed to
one commande then "Clôturer" moves it out of the bucket; previously the stale detail stayed.
Server-filtered screens (ClientsCommandes/Facturation/Devis/Expeditions) gate the clear on
`isFetching` (newly destructured where missing) so an in-flight search refetch never wipes a
valid selection; client-filtered screens (EtudesColoris, FilsCommandes, ClientsGestion,
ProspectsDemandes, QualiteSuiviLots, TombeMetierReferences) clear directly. (3) **Line-card
affectation gauge compacted**: single row — bar left (flex-1), `affecté / commandé` +unit
right at `text-xs` — the "Affecté" label row is gone. (4) **New permission
`cloture_commande_client`** ("Clôturer / rouvrir une commande", Commandes client category):
`PUT /commandes-client/:id/etat` now 403s without it and the StatusFooter pill hides its
toggle button (pill stays as read-only display). (5) **New permission `deverrouiller_tarifs`**
("Déverrouiller les tarifs"): the LineFormDialog price padlock only renders with it, and
without it the Prix input is read-only for tariff-priced types (écru/fini; divers stays
manual) — UI-level gating, line endpoints still accept `prix` under `edit_commandes_client`.
(6) **Tricobot tariff nudge**: the next-tranche commercial nudge is now a Tricobot speech
bubble (`/tricobot/tricobot-wave.png` avatar, gold bubble with tail + "✨ Tricobot" label),
and `pricing-ligne-client.ts geom()` treats a quantity within 1% of a roll of a clean
multiple as **exact rounded to the NEAREST roll count** (users type whole Ml against
fractional roll sizes) — fixes 1402 Ml reading "> 24 Rouleaux" and "Plus que 0 Ml" nudges;
exact quantities get the better tranche price and never show the nudge (`!priceInfo.exact`
guard added client-side too). Verified against live tariff data (078A@1402 exact 6,77 €;
138A@1255 still nudges 29 Ml → 3,49 €; 138A@1284 exact 3,49 €).

## 2026-07-17 — feat/commandes-client
Clients › Commandes — **print/email contextual menus + on-the-fly Facture proforma.**
The detail-header Printer and AtSign buttons are now `DocMenuButton` popover menus
(ClientsExpeditions `PrintMenuButton` pattern) choosing between "Confirmation de commande"
(existing flow, unchanged) and a new "Facture proforma" generated straight from the
commande header + lines — NEVER persisted to facturation (no `facture_prov` row, no
proforma sequence consumed). Rendering reuses `FacturePdf` with `isProforma: true` (bank
card, proforma title) extended with optional `remise`/`fraisPort` totals rows (TVA on net
HT; regular factures unaffected) and an optional `refCommande` "N° commande" meta row.
**Numbering: proforma numero = 1_000_000 + commande numero** (`PROFORMA_NUMERO_OFFSET`,
e.g. 3658 → N°1003658) — deterministic, purely numeric, and structurally collision-free
vs facturation's sequences (facture.numero ≈ 9k, IDfacture_prov ≈ 13k). Endpoints on
`commandes-client.ts`: `GET /:id/proforma/pdf` (filename `proforma-<numero>.pdf`),
`GET /:id/proforma/email-defaults` (same `envoi_commande=1` recipient logic, proforma
subject/body), `POST /:id/proforma/email` (proforma PDF attached, **no CGV** — matches
facturation; logs `envoi_email` with `notes='proforma'`). `/:id/historique` now reads
`notes` and labels events "Facture proforma" vs "Confirmation de commande" (grouping key
= timestamp + kind). Data builder `buildProformaPdfData` reuses `buildClientPdfData` +
client `num_tva`/client `IDtva` rate (fallback ETM default), dated at generation time,
échéance date via `computeDateEcheance`/`loadEcheanceRule` (now exported from
`factures.ts`). Frontend: `emailDoc` state parameterizes the single `SendEmailDialog`
(endpoints, attachment label with mirrored offset, CGV chip confirmation-only); donation
commandes hide the proforma menu entry (donations never invoice).

## 2026-07-17 — feat/stock-ecru
Tombé Métier › Stock — **responsive rollout step 3 (tablet / Z Fold / phone).** Same §40
treatment as Fils/Finis Stock, all changes additive (desktop + tablet proven pixel-identical
at `maxDiffPixels: 0` after every edit). (1) e2e coverage first: stock-ecru fixtures captured
from the live dev API (28-row list with défauts/observations/2ᵉ choix/magasin variety,
detail + provenance for the first-sorted row, trimmed refs/magasins lookups), mock routes,
`tombe-metier-stock.spec.ts` desktop baselines blessed on the untouched screen, then
`tombe-metier-stock-responsive.spec.ts` (13 mobile tests across fold-open-717 / phone-390 /
fold-cover-345). (2) Below `md` the 13-column table becomes a card list (`StockEcruCard`
in-file, shared `CardKV`/`MobileSortRow`): ref + coloris + 2ᵉ/Teinture badges,
numéro/poids/lot/magasin/cmd/client grid, red défauts line, observations + date footer;
memo'd with the edit-mode checkbox CSS-driven via `data-editing` (zero re-renders on mode
toggle); multi-select taps work on cards. (3) Drawer `w-full max-w-[440px]` + `md:hidden` X
close; outside-click selector widened to `[data-stock-row]`; the three dialogs (create, cut,
batch) get `max-h-[90dvh] overflow-y-auto`, create grid collapses to 1 column below `sm`;
one-line totalizer below `sm`. (4) **New toolbar rule (user-flagged at ~620px):** `order-*`
swaps alone don't pin the actions top-right when the toolbar has more than a checkbox —
flex-wrap only wraps on overflow, so the `w-40` statut select could share row 1 and push
the buttons off the corner. Fix: the select + checkbox live in an
`order-4 w-full … sm:contents` wrapper (forced full-width row 2 below `sm`, dissolved at
`sm`+). Recorded in `mps_designer` §40.5 + §40.1. Remaining table-centric port:
RapportCommandesSst.

## 2026-07-17 — feat/facturation
Clients › Facturation — **batch convert + lifecycle/PDF/email polish** on the existing
proforma/définitive screen. (1) **Conversion is now a MOVE**: `POST /prov/:id/convert`
copies the header + lines into `facture`/`ligne_facture` (fresh definitive numero) then
DELETES the proforma — the `IDexpedition_divers` converted-marker scheme and all its UI
("Converti → N°", "Voir la facture" button, converted locks) are removed; expeditions stay
`est_facture=1` because their lines are now referenced by `ligne_facture` (the batch-delete
reopen logic checks that ledger). DB had zero converted rows, so nothing was orphaned.
(2) **"Convertir des factures"** — third batch button on the proforma list (between Générer
and Supprimer) opening a pick-and-convert dialog; new `POST /prov/convert-batch {ids}`
converts each via the shared `convertProforma()` helper and returns
`{converted:[{prov_id, IDfacture, numero, client_nom}], skipped}`; the delete and convert
pickers share one generic `ProformaPickDialog`, results render in `BatchResultDialog`
("Proforma N°X → N°Y · client"). (3) **Frais de port in `/prov/generate`** — legacy rule
reverse-engineered from the live ledger: ONE line "Frais de port" (qty 1, unite '', prix =
`commande_client.frais_port`, `IDligne_expedition=0`) per contributing commande with
`frais_port > 0`, charged on EVERY invoicing run, never multiplied by the number of
expeditions (facture 4952 = 5 avis / 1 port line; commande 3329 = port on 4 successive
factures). (4) **Bank coordinates card on ALL facture PDFs** (was proforma-only).
(5) **Email default body** now "Bonjour, / Veuillez trouver ci-joint notre {facture|avoir}
N°X. / Bonne réception, / Belle journée,". (6) **Per-line domain icons**: API resolves
`stock_kind` ('fini'|'ecru'|'divers') per line via `ligne_expedition →
ligne_commande_client.TYPE`; LineCard shows FiniRollIcon / TmRollIcon / Package (same
glyphs as ClientsExpeditions). Verified E2E on the local dev DB (20-check script: convert
deletes prov, batch convert, port-line generation with rollback, PDF text extraction);
inspect/verify scripts kept under `apps/api/src/scripts/`.

## 2026-07-16 — feat/stock-fil
Fils › Stock + Finis › Stock — **responsive rollout step 1+2 (tablet / Z Fold / phone) +
Playwright screenshot-regression harness.** (1) New e2e harness in `apps/web/e2e/`
(@playwright/test, chromium-only, own vite server on port 3200 with `VITE_API_URL=/api`):
the whole `/api/` layer is fixture-mocked (`support/mock-api.ts`, unmocked endpoints 500
loudly), `Date.now()` frozen via `page.clock`, baselines committed per-machine (system-ui
fonts — policy in `e2e/README.md`). 6 viewport projects: desktop-1920/1366 + tablet-768 run
the table specs, fold-open-717 / phone-390 / fold-cover-345 run the `*-responsive` specs.
Workflow: bless desktop baselines on the UNTOUCHED screen first, then every responsive edit
must keep them green (proven at `maxDiffPixels: 0`). Scripts: `test:e2e`, `test:e2e:update`
(NOT in turbo test). (2) Both stock screens are now responsive, all changes additive
(desktop pixel-identical): below `md` the split tables become card lists sharing the same
rows/sort/selection/guard state (`StockLotCard` / `StockFiniCard` in-file; shared `CardKV`
+ generic `MobileSortRow` in `components/stock/StockCardParts.tsx`); FinisStock's edit-mode
multi-select works on cards with the checkbox CSS-driven via a `data-editing` group
attribute (zero re-renders on mode toggle); drawers are `w-full max-w-[440px]` with a
mobile-only X close routed through the unsaved guard; outside-click selector widened to
`[data-stock-row]`; all dialogs get `max-h-[90dvh] overflow-y-auto` + `grid-cols-1
sm:grid-cols-2` + `col-span-full`; the dialog primitive gained `p-4`. (3) Phone toolbar
rules (user-confirmed): primary actions stay top-right via `order-*` swaps, text buttons
collapse to icon-only (`hidden sm:inline` label + `title`), the Mode édition badge takes
its own row; FinisStock totalizer stays on ONE line at 345px (labels hidden below `sm`,
kg/Ml units carry the meaning), selection summary on its own row. (4) Doctrine recorded in
`mps_designer` §40 (+ §15/§27 refreshed). Remaining table-centric ports: TombeMetierStock,
RapportCommandesSst.

## 2026-07-16 — feat/expe
Clients › Expéditions — **Rapport de contrôle + Info matières PDFs, tickable email
attachments, print menu.** Two new branded documents port the legacy reports
(`ETAT_RapportQualité` / `ETAT_Info_Matiere`): `RapportControlePdf.tsx` (per-lot 5-column
table LOT · PARAMÈTRE · MIN · MAX · RELEVÉE; tolerances from `ref_fini`
laizeHT/poids/stab columns, relevé = in-house `suivilot.*_tirelle`, colored green/red
within/out of tolerance like legacy) and `InfoMatieresPdf.tsx` (per-article traceability:
Tissu Fini = ennoblisseur via suivilot + ged type-3 docs; Tombé de métier = tricoteur via
`stock_ecru.IDref_commande_source` (lcsst type 1 — affectation is the ennoblisseur!) +
ged type 4; Fil = fournisseur via asso_fil_of→stock_fil, certifs `ref_fil_certif`→
`certificat`, ged type 6 on `IDcommande_fil`, pays from `origine_matiere`/adresse).
Endpoints: `GET /expeditions/formelle/:id/rapport-controle/pdf` + `/info-matieres/pdf`
(404 when no fini lines). Email flow: `SendEmailDialog` gained `optionalServerAttachments`
— checkbox chips previewable even unticked; visibility + defaults come from
`email-defaults.optional_attachments` (RC pre-ticked when `expedition.inclureRapportQualite
OR client.inclureRapportQualite`; IM always unticked; omitted for écru-only/divers). POST
gains `attach_rapport_controle`/`attach_info_matieres` (400 if ticked but unavailable);
`logEnvoiEmails` now records the attachment set in `notes` ("BL+RC+IM"), still type_doc
14/16. Fix: both expedition INSERTs seeded `inclureRapportQualite` 0 — now copied from the
client. UI: formelle print button is a 3-entry popover menu (avis / RC / info matières);
new "Rapport de contrôle" ToggleSwitch in the sidebar Info tab (edit mode). HFSQL traps
discovered (memories saved): `stock_fil` SELECT * OR any list containing `certif_bio`
silently returns 0 rows on Windows — name ASCII columns without the certif block; suivilot
has no allongement columns. Probe/dump scripts: `probe-rc-info-matieres.ts`,
`dump-rapport-controle-pdf.ts`, `dump-info-matieres-pdf.ts` (synthetic + `--exp` live).
Verified live on exp 11669 (PDFs vs legacy samples RC12162/Info_Matière, defaults,
gating, notes logging, 404s, divers untouched).

## 2026-07-16 — feat/commandes-client
Clients › Commandes — **Affectation tab notes-as-icons + gated observation editing + 2 new
permissions.** (1) Roll cards in the line drawer's Affectation tab (and the shared RollRow
used by the enno/tricotage lists) no longer render the full-width blue/red `RollNotes`
banners; instead compact top-right icons appear only when content exists — red AlertTriangle
for the defect report (`observation_sst` and/or "2e choix"), blue MessageSquare for
`observations` — each with a styled left-side Tooltip that sizes to its content (`w-max`
capped at 320px, so short notes stay on one line). Défauts tooltip: only the title +
"2e choix" tag are red, the body text is default black. `RollNotes` itself is untouched
(SousTraitantsCommandes still uses it). (2) The observation icon is now the single edit
affordance (the per-roll pencil is gone): gray frameless ghost to add when no obs, blue
framed when filled; editing is armed by a "Modifier les observations" toggle that rides the
first section heading row of the Affectation tab (title left / action right, gold pill when
active; falls back to the "Stock disponible" heading when no rolls are affected yet, hidden
on soldée). (3) New permission `edit_observations_rouleaux` ("Commandes client") gates that
toggle in the UI and the `PUT .../pieces/:kind/:stockId/observations` endpoint (403 without
it). (4) New permission `edit_commandes_client` ("Commandes client") — without it the gold
"Modifier" and the list-footer "+ Nouvelle" buttons are hidden (screen read-only; view-mode
workflows — affectation, expédier, état pill, print/email, documents — stay open) and a
`requireEditFactures`-style `requireEditCommandes` guard 403s the six write paths:
`POST /commandes-client`, `PUT /:id`, `DELETE /:id`, `POST /:id/lignes`,
`PUT /lignes/:lineId`, `DELETE /lignes/:lineId`.

## 2026-07-16 — feat/gestion-client (3rd landing)
Clients › Gestion — **Negotiated 15/30-rouleaux tranches + expired-contract view/duplicate
+ coloris drawer edit-mode close.** The Tarif dialog now honors
`ref_client_colori.lst_tranche`: standard/coefficient modes only show the enabled tranche
rows (default = up to 10 rlx, indices 0..6 — shared `parseLstTrancheIdx()` helper in
`clients.ts`, also consumed by the Fiche Tarifs PDF path; new-coloris creation default
fixed from all-9 to 0..6). A gold "Modifier" button under the table (permission
`gestion_tarifs`, hidden in contrat mode) opens a "Tranches négociées" panel with two §35
toggle pills (15 / 30 rouleaux, each showing its Ml + computed €/Ml); saving goes through
the new `PUT /clients/:id/coloris/:rccId/tranches` (permission-gated, preserves base
indices, ASCII-safe write). GET `.../tarif` now returns `tranche_idx`. Expired contract:
the Tarif dialog shows the old contract read-only (dates + tranche table, "expiré" chip)
under the red banner, plus a "Dupliquer le contrat" button (gestion_tarifs) that opens the
Mode de tarification dialog hydrated from it as a NEW contract (same tranche grid, début =
today, no IDcontrat_tarif → renewal keeps history). Références tab: entering edit mode
(with gestion_references) now closes the in-screen coloris drawer (§31.3 — the card click
is reserved for the settings dialog there). Probe script
`inspect-tarif-tranche-flags.ts` dumps lst_tranche value distribution.

## 2026-07-16 — feat/commande-client
Clients › Commandes — **"Confirmation de commande" rename + CGV always attached + a batch
of drawer/sidebar UX fixes.** Rename: the client order document is now "Confirmation de
commande" everywhere the legacy "Accusé de réception" appeared — email subject/body
(`email-defaults`), PDF header (split across the type/reference header rows as
CONFIRMATION DE / COMMANDE N°X so no word is stranded), PDF title + attachment/download
filename (`confirmation-commande-N.pdf`), Historique tab label, docs empty-state copy.
CGV: new `CgvPdf.tsx` renders the Conditions Générales de Vente (verbatim legal text
provided 2026-07-16, sections I–X — the single source of truth; legacy `ETAT_CGV*.wde`
are PCS-compressed and unextractable) as a one-page two-column branded document
(I–VII left / VIII–X right, hand-balanced split); served by `GET /commandes-client/cgv/pdf`
(process-cached buffer) and **always attached** as `CGV - ETS Malterre.pdf` to every
confirmation email. The shared `SendEmailDialog` gained `extraServerAttachments` —
non-removable, previewable chips (used here for the CGV). PDF headers: uppercase accented
É renders badly in the header font, so documentType drops accents on purpose (Avis
d'expedition ×2, Conditions Generales de Vente); formelle BL header reference is now
`N°X` (no "BL"). Line drawer: Expédition tab trimmed to just the two tables (shipment-info
strip removed) and each expedition row gained per-row Imprimer / @ buttons reusing the
Clients › Expéditions endpoints (`/expeditions/formelle/:id/...`, BL PDF + SendEmailDialog);
Affectation tab roll cards are now click-anywhere-to-select (inner buttons stop
propagation). Line cards use the standard domain icons (TmRollIcon / FiniRollIcon / Box)
instead of Layers. Sidebar: Donation toggle hidden entirely once lignes exist (reappears
when all deleted; donation orders keep the pieces lock), Réf. client edit input flexes to
the full row width, donation section's Ajouter/Modifier buttons are edit-mode-only.
Verified live on the dev API: CGV render, email-defaults wording, PDF headers, BL 11525.

## 2026-07-16 — feat/gestion-client (2nd landing)
Clients › Gestion — **Associated refs + retour marchandise + 2 permissions + sidebar card
polish.** (1) Associated refs (legacy model reverse-engineered from data:
`ref_fini.associee` = messy CSV of associated IDref_fini defined in Finis › Références;
checking one in the legacy "Référence client" modal creates a hidden `designation_client`
child — designation "Reference Associée", `caché=1`, `unite=0`, no coloris rows — whose id
is stored in the parent's `associee` CSV): the refs list now filters `caché=1` (the "Reference
Associée 027A" ghost cards are gone), returns `associees: IDref_fini[]` per ref (link-icon
count on the card), new lookup `GET /clients/lookups/refs-associees?ref_fini=X`, and the
settings dialog gets a "Références associées" checklist (between Coloris and Fils, legacy
order) synced by `syncAssociees()` (delete unchecked children / insert checked / keep parent
CSV in sync). Verified with a full uncheck/recheck DB round-trip on 224A (client 111).
(2) Marchandise expédiée: "Reprendre des pièces" button (bottom right) enters a selection
mode — checkbox column + select-all + Shift-click range selection, gold action bar with
count/kg + Annuler + "Remettre en stock" (ConfirmDialog) → new
`POST /clients/:id/marchandise/retour-stock` unlinks rolls (`IDligne_expedition=0`) and
appends "Récupéré chez {client} le {dd/MM/yyyy}" to `observations` (read repaired via
fixEncoding, written via sqlText; scope-guarded to rolls actually shipped to that client).
Tab restructured: table scrolls internally with sticky header, bars are flex siblings (fixes
the overlapping sticky bar). (3) Two new permissions in "Gestion client":
`gestion_references` (gates references POST/PUT + settings dialog/add button — without it
edit mode behaves like view mode on the tab) and `retour_marchandise` (gates the whole
reprendre flow + endpoint); both verified 403 for a non-admin. (4) Contacts/Adresses sidebar
cards livened: initials avatar (gold for principal), gold star Principal(e) badge pinned top
right, hue-coded doc chips (Commande sky / BL teal / Facture orange / Soumission amber),
tel/mailto links, address icon box follows type (Truck teal / Receipt orange / MapPin gold).

## 2026-07-16 — feat/expe
Clients › Expéditions — **Print + email for expéditions diverses (previously "En
developpement" placeholders) + Ml label fix on the formelle BL.** New
`BonLivraisonDiversPdf.tsx`: "Avis d'expédition / BL divers N°X" in the shared
MalterreDocument frame — delivery-address + metadata cards (client, réf. client,
transporteur), one section per carton (free-text label, framed items table: désignation
with variation labels, quantité with pluralized unit, P.U. €, total €, per-carton totals
row), gold grand-total box (cartons · articles · total €). Price columns auto-hide when
every item's prix is 0 (free-sample shipments). API (`expeditions.ts`):
`buildBlDiversPdfData`/`renderBlDiversPdfBuffer` + `GET /divers/:id/pdf` (iframe header
strip), `GET /divers/:id/email-defaults` (client contacts split by `envoi_bl`),
`POST /divers/:id/email` (PDF re-render + user attachments, logs `envoi_email` with
`IDtype_doc=16` "avis expedition diver" — `logEnvoiEmails` now takes the typeDoc as a
param). Web: Imprimer opens `/expeditions/{bucket}/{id}/pdf` for both buckets; divers gets
the real `SendEmailDialog` (attachment `BL-divers-{id}.pdf`); the local `PlaceholderDialog`
was deleted. Also: formelle BL PDF's métrage column/units corrected `(M)` → `(ML)`/`Ml`
(métrage is always Ml), and an em-dash sweep on strings touched (formelle email subject,
From display name, BL total labels) per Vincent's preference. New synthetic render harness
`dump-bl-divers-pdf.ts`. Verified live: expedition 597 PDF (2 pages), email-defaults, and a
dev-skip send writing the type-16 audit row.


## 2026-07-16 — feat/gestion-client
Clients › Gestion — **"Classeur" layout (3rd gold-standard layout) + ref-level settings
(legacy "Référence client" window) + References tab UX overhaul (search + coloris drawer).**
Layout: the center panel's three stacked collapsible sections became master tabs
(Références / Historique des commandes / Marchandise expédiée) styled like the header
submenu pills on the natural background, landing on Références at every selection; adopted
into `mps_designer` as the **Classeur** layout (§39) and the three layouts got names
(Fiche / Tableau / Classeur). Ref settings: cards enriched with the catalog designation +
Kg badge + amber "À soumettre" pill; edit-mode card click opens a settings dialog mirroring
the legacy window — nom commercial, finition Tombé de métier / Ennobli, référence interne
(searchable, catalog switches with finition), unité Ml/Kg, soumission toggle, coloris made
available to the client, fils facturés (stored inverted in accented `fil_non_facturé` CSV);
"Ajouter une référence" creates one. API (`clients.ts`): references GET enriched with
`designation` + `fil_non_facture[]`; POST/PUT `/clients/:id/references(/:did)` write
`designation_client` via positional INSERT (accented `archivé`/`caché`/`fil_non_facturé`
never named; verified column order + datetime literal), updates delete+re-insert preserving
PK; `ref_client_colori` availability diff-sync archives/unarchives rows (tarif history
preserved) and inserts new ones with the 9-tranche default; new
`GET /clients/lookups/composition-fils` (composition_ecru yarns); refs-ecru lookup now
returns `designation`. References tab UX: accent-insensitive multi-criteria search
(every space-separated term must match ref/designation/coloris); coloris chips replaced by
the §31 in-screen drawer — selecting a ref docks it alone in a one-card band under the
search bar and the drawer below shows the coloris as a 2/3-column grid of white cards
(label + tarif mode, hover euro/pencil opening the tarif / tarif-mode dialogs); edit-mode
card click opens the settings dialog instead (drawer is view-mode-opened). Also fixed the
Classeur overflow-clip cropping focus rings (§31.5 padding) and synced the skill snippet.

## 2026-07-16 - feat/commandes-client
Clients > Commandes - **Order-confirmation email hardening: recap in body + bold 48h
tacit-acceptance clause + HTML email support.** Customers were not verifying the attached
accuse de reception, so mistakes slipped through. The default email body now includes (1) a
"Recapitulatif" bullet per order line (ref - coloris : quantite unite - livraison date),
built from `buildClientPdfData` so it always matches the attached PDF (best-effort: recap is
skipped on error), and (2) a bold clause asking the client to check references/coloris/
quantites/delais and report any anomaly within 48 hours, after which the order is considered
accepted as-is. To render bold, `gmail.ts sendMail` now always emits a multipart/alternative
body (text/plain + text/html) - nested in multipart/mixed when attachments are present - with
lightweight `**bold**` markup: HTML part renders `<strong>`, plain part strips the markers.
This benefits every email endpoint app-wide. `buildMimeMessage` is now exported for testing.
`SendEmailDialog` gained a hint under the Message textarea explaining the `**` syntax.
Also removed em-dashes from the commande-client email subject, recap separators, and From
display name (user preference: no em-dashes in user-facing text).

## 2026-07-16 — feat/bugs
Finis › Stock — **Fix: saving a roll's notes failed silently when the text contained accented
characters** (bug report from Isabelle, 2026-07-10: some pieces' comments could be edited, others
not — the difference was whether the existing Observations already held an accent like
"Pièce"/"N°"). Root cause: `PATCH /api/stock/fini/:id` wrote `observations`, `observation_sst`,
`emplacement` and `conteneur` as raw `'${esc(...)}'` quoted literals, so any non-ASCII text hit
the Linux bridge's `[HY090]` UTF-8 corruption and the request 500'd — the batch endpoint had
already been converted to `sqlText()` but the single-roll endpoint was missed. Since the drawer
resends the whole Observations text on save, any roll with pre-existing accented notes was
un-editable even to add ASCII text. Fix: the four text fields now go through `sqlText()`
(Latin-1 hex literal for accented values). Companion UI fix in `FinisStock.tsx`: the drawer's
save mutation previously had no `onError`, so a failed save looked like a dead Enregistrer
button; it now shows the standard AlertCircle destructive banner in the drawer header
("L'enregistrement a échoué…"), cleared on retry and on entering edit mode.

## 2026-07-15 — feat/gestion-client
Clients › Gestion — **Tarif modes per référence×coloris (standard / coefficient fixe / contrat)
+ permission « Gestion des tarifs » + historique divers fix + Ml label sweep.**
Reverse-engineered the legacy model: mode lives on `ref_client_colori` — *coefficient fixe* is a
`tranche_tarifaire` row (`coefficient` %, `IDcontrat_tarif=0`) replacing the degressive
COEFFICIENT_V2 margin on every tranche; *contrat* is `rcc.contrat=1` + `contrat_tarif` rows
(date_debut/date_expiration, renewals kept as history) + `tranche_tarifaire` rows carrying the
negotiated €/Ml (`prix_saisi`) per `nb_rouleaux` linked via `IDcontrat_tarif`. API: references
endpoint enriched with per-coloris mode info; `GET /clients/:id/coloris/:rccId/tarif` (mode-aware
PrixDeVente); `PUT .../tarif-mode` gated by new `gestion_tarifs` permission key;
`calcTarifRefFini` gained an `opts.coefficient` override. UI: mode tags on coloris chips
(Coef n / Contrat → date / Contrat expiré), mode-aware TarifDialog (contrat: only contracted
tranches shown as "N et plus", detail on the legacy 15-roll cost basis with the coefficient
derived from the contract price — verified byte-for-byte against legacy: revient 11,87, coef 13,
PV 4,06 €/Ml on 029A/0512), TarifModeDialog editor in edit mode (radio cards, contract editor
with tranche rows + history). Expired contract = ref unavailable everywhere (no standard
fallback): dialog notice, PDF drops the coloris, selection dialog disables the row. Fiche Tarifs
PDF honors both modes. Historique des commandes: divers lines (type 3) now resolve
`ref_divers.designation` + `ref_divers_variation` (couleur/taille) instead of the literal
"Divers"; unité 4 shows "unité". Métrage displays app-wide corrected to "Ml"
(ClientsGestion, FinisReferences, FinisStock, SousTraitantsCommandes).

## 2026-07-15 — feat/pwa
App-wide — **PWA identity renamed to "ETM" + missing install icons created** (`apps/web/vite.config.ts`,
`apps/web/index.html`, `apps/web/public/favicon.svg`, `apps/web/public/icons/*`). The manifest previously
referenced `icons/icon-192.png` / `icon-512.png` / `apple-touch-icon.png` that did not exist in `public/`,
so Chrome never offered the install prompt. Generated all three (gold "ETM" wordmark on primary blue
`#143D6B`, sized inside the maskable safe zone since `icon-512.png` doubles as the maskable icon —
`logo-small.png` at 80px was too low-res to composite). Manifest `name`/`short_name` are now `ETM`,
`lang: 'fr'` added, `theme_color` moved from the old `#00243E` navy to brand primary `#143D6B` (also in
the `index.html` meta). Tab title is now `ETM`; favicon.svg redrawn as ETM in brand colors. Removed the
phantom `favicon.ico` from `includeAssets` (never existed). Note: the install prompt only appears on
production builds (`vite preview` / prod) — vite-plugin-pwa serves no manifest in dev, and `devOptions`
was deliberately left off to keep the service worker out of the dev loop.

## 2026-07-15 — feat/permissions
Paramètres › Utilisateurs + Clients › Facturation — **new `edit_factures` permission
("Édition des factures", new "Facturation" catalog section between "Commandes client" and
"Gestion client")** (`apps/api/src/lib/permission-keys.ts`, `apps/api/src/routes/factures.ts`,
`apps/web/src/pages/ClientsFacturation.tsx`). Without the grant, Clients › Facturation is
strictly read-only: the UI hides « Nouveau », « Modifier », « Convertir en facture » and the
proforma batch block (« Générer les factures » / « Supprimer des factures »); list, detail,
print PDF and email stay open. Server-side, a shared `requireEditFactures()` guard (401 unauth /
403 without grant, effective-admin bypass via `userHasPermission`) gates every write endpoint:
`POST /:kind` (create), `PUT`/`DELETE /:kind/:id`, line CRUD (`POST /:kind/:id/lignes`,
`PUT`/`DELETE /:kind/lignes/:lineId`), `POST /prov/generate`, `POST /prov/delete-batch`,
`DELETE /prov/all`, `POST /prov/:id/convert`. Frontend gating threads one
`useHasPermission('edit_factures')` read down as `canEdit` props to `FactureList` and
`DetailHeader`.


## 2026-07-15 — feat/facturation
Clients › Facturation — **proforma display number = PK (legacy convention), PDF header/mention
cleanup, computed date d'échéance** (`apps/api/src/routes/factures.ts`,
`apps/api/src/lib/pdf/FacturePdf.tsx`, `apps/web/src/pages/ClientsFacturation.tsx`).
**(1) Proforma number.** The legacy app shows a proforma's `IDfacture_prov` (PK) as its number —
`facture_prov.numero` is a vestigial internal sequence (verified live: legacy "proforma 13521" =
IDfacture_prov 13521, numero 3). New `displayNumero()` helper routes every user-facing surface
(list, detail, PDF, email defaults/filename, generate-summary payload) through the PK for
`kind='prov'`; definitive factures keep their real `numero`. The MAX+1 numero allocator is
unchanged (still used for post-insert id resolution).
**(2) PDF header.** `FacturePdf` passed `reference={"FACTURE PROFORMA N°9"}` so the title
appeared twice in the header band; now `reference={"N°9"}` — title on line 1, number alone on
line 2. The proforma "Document non contractuel — ne tient pas lieu de facture." mention is removed.
**(3) Date d'échéance.** The `echeance` table carries calculation params (`TYPE` reserved-word
column, `nb_jours`, `jour`) and legacy auto-computes the due date from the facture date. Ported as
`computeDateEcheance()`: TYPE 2 = +N days; TYPE 3 = +N days then end of month (verified against
legacy: 15/07/2026 + "45 jours, fin de mois" → 31/08/2026); TYPE 4 = end of month then +N days;
TYPE 5 = TYPE 3 then +`jour` days (the Nth of the next month — best-guess, no live sample);
TYPE 1 (à réception / avant livraison / acomptes) = no date. `loadEcheanceLabel` became
`loadEcheanceRule` (returns libelle + params). The PDF top-right card now shows both rows —
Échéance (phrase, ClockIcon) and Date d'échéance (dd/mm/yyyy, CalendarIcon) — and the detail
response gained `date_echeance`, surfaced as a view-mode KV row in the web Info tab.


## 2026-07-13 — feat/soumission
Sous-traitants › Commandes — **Soumission Lot email defaults: ref commande client in the body,
emdash dropped from the subject** (`apps/api/src/routes/commandes-sous-traitant.ts`,
`buildSoumissionEmailDefaults`). The default body now includes a
`Réf commande client : <commande_client.ref_client>` line after the opening paragraph — the same
field the Soumission Lot PDF shows as "Ref commande client" (fetched with the usual `fixEncoding`
repair; line omitted when the order has no ref_client). The default subject's em dash separator
(`Soumission Lot X — ref`) became a plain ASCII hyphen (`Soumission Lot X - ref`). Defaults only —
the send endpoint and PDF are unchanged.


## 2026-07-13 — feat/devis
Clients › Devis — **Nouvelle ligne dialog: Prix (€) field no longer hidden**
(`apps/web/src/pages/ClientsDevis.tsx`). The Unité `PopoverSelect` in the 3-column
Quantité/Unité/Prix grid was passed `size="sm"`, whose variant forces a fixed `w-[220px]`
width (meant for compact right-panel KV rows). Inside the narrow grid cell that 220px button
overflowed and covered the adjacent Prix input. Dropped the `size="sm"` prop so the select
is `w-full` and fills its own cell — matching the canonical `ClientsCommandes.tsx` new-line
dialog. Pure CSS/layout fix, no behavior change.


## 2026-07-07 — feat/expe
Clients › Expéditions — **Diverses: carton contents (ref_divers_expedie)** + a Bon de Livraison
PDF pagination fix (`apps/api/src/routes/expeditions.ts`, `apps/web/src/pages/ClientsExpeditions.tsx`,
`apps/api/src/lib/pdf/BonLivraisonPdf.tsx`).
**(1) Divers cartons model.** A divers expedition's `ligne_expedition_divers` rows are **cartons/colis**
(`detail_ligne` = label, e.g. "CARTON 3"), and their real content lives in **`ref_divers_expedie`**
(FK `IDligne_expedition_divers`): one row per article = `ref_divers` catalog ref + up to two variation
axes (`IDVariation1/2` → `ref_divers_variation`, niveau 1↔`sTypeVariation1`, niveau 2↔`sTypeVariation2`,
∈ Couleur|Taille|Reference|Aucun) + quantite/unite + prix (frozen at ship time from the `tarif_divers`
grid keyed on (ref, v1, v2), (0,0)=base, fallback `ref_divers.prix_unitaire`). Verified against live
expedition 597 (4 cartons, 12 items). The previous code treated these lignes as free-text only — it
surfaced none of the article data. **API**: divers detail GET now returns each carton's `items[]` with
resolved ref + variation labels (batched `repairAliased`); new item CRUD
(`POST /divers/lignes/:id/items`, `PUT`/`DELETE /divers/items/:id`, all honoring the facturée lock)
and lookups (`GET /divers/lookups/refs` [`SELECT *` + `pickKey` for the accented `archivé` col],
`.../refs/:refId/variations`, `.../prix?ref&v1&v2`). Carton and expedition deletes now cascade to
`ref_divers_expedie` (previously orphaned rows). `stock_divers` intentionally untouched (legacy
movement semantics unverified). **UI**: each carton card lists its articles (désignation · variations
| qté | PU | total €) with a per-carton total; a pinned footer totals cartons/articles/€ for the
expedition; edit mode adds add/edit/delete per item via a dialog with a searchable ref picker,
variation dropdowns labeled by the ref's own axis names, and grid-auto-filled (editable) unit price.
List cards now read "N cartons". **(2) BL PDF fix**: `minPresenceAhead={70}` moved off the whole lot
`View` onto the "Lot :" label — on the block, react-pdf's keep-with-next semantics pushed an entire
snugly-fitting lot to the next page, blanking page bottoms (seen on prod BL 12112, whose first lot fell
on a nearly-empty page 1). On the label it just keeps the header + ~2 rows together; also added
`minPresenceAhead={100}` to the article identity block so a heading can't be stranded. Verified with a
12112-shaped render (6 pages → 4, first lot now on page 1).


## 2026-07-07 — feat/facturation
Clients › Facturation — **Facture/Proforma PDF redesign + proforma print & email**
(`apps/api/src/lib/pdf/FacturePdf.tsx`, `MalterreDocument.tsx`, `theme.ts`,
`apps/api/src/routes/factures.ts`, `apps/web/src/pages/ClientsFacturation.tsx`,
`apps/api/src/scripts/dump-facture-pdf.ts` [new], `mps_designer` SKILL §38).
**(1) PDF body redesign**: the facture/avoir lines table is now a squared ledger — muted
header band with a 2pt gold rule beneath, hairline row separators, and a matching 2pt gold
rule closing the table (no rounded box, no navy fills). The totalizer is condensed (tight
3.5pt rows, hairline between HT and TVA) with TOTAL TTC on the light `bgTotal` band, gold
top-rule, navy bold text. **(2) Header icon alignment fix**: the top-right meta-card labels
(N° TVA / Mode de paiement / Échéance) were floating above their center-aligned SVG icons
because the Text inherited the content area's `lineHeight: 1.45`; fixed with a tight
per-Text `lineHeight` (same latent bug fixed in `CommandeSoustraitantPdf.tsx`). Codified as
`mps_designer` §38 (meta-row icon alignment rule + financial-document ledger conventions).
**(3) Proforma print & email**: proformas can now be emailed as well as printed (previously
definitive-only). `GET/POST /factures/:kind/:id/email(-defaults)` accept both kinds; the
proforma attachment is named `proforma-<n>.pdf` and the subject/body say "Facture proforma".
`envoi_email` history stays definitive-only (prov/def share an id space on the same
`IDtype_doc`) — proforma sends are simply not logged, and their `/historique` returns [].
**(4) Bank card (proforma only)**: the proforma PDF prints a "COORDONNÉES BANCAIRES" card
(Titulaire / IBAN / BIC, from `company.bank` in `theme.ts`) pinned to the bottom of the last
page just above the footer via a flex spacer + `wrap={false}`, new `LandmarkIcon` in the
shared frame. Verified with `dump-facture-pdf.ts` (renders both a definitive and a proforma
variant with synthetic data, no DB).


## 2026-07-07 — feat/gestion-client (delete/archive + tarifs email + PDF redesign)
Clients › Gestion — a second round on the same screen: **delete-or-archive a client**, the
tarifs **email** path, a sidebar tidy-up, and a **Fiche Tarifs PDF redesign**.
**(1) Delete / archive** (`apps/api/src/lib/permission-keys.ts`, `apps/api/src/routes/clients.ts`,
`apps/web/src/pages/ClientsGestion.tsx`). New permission `delete_client` ("Supprimer / archiver
un client") in a new **"Gestion client"** category (renders below "Commandes client" in
Paramètres › Utilisateurs). The bin moved out of the view-mode header into **edit mode only** and
is permission-gated; its icon now reflects deletability fetched on entering edit mode — a **bin**
(destructive) when the client has no commandes/marchandise, an **archive box** when it has activity
(deletion impossible → archive instead), and an **unarchive** button when already archived. The
confirm dialog goes straight to the matching action (no "deletion impossible" explanation). New API:
`GET /clients/:id/deletability` (counts `commande_client` by `IDclient` + `stock_fini` by
`IDProprietaire` — verified those are client ids), `POST /clients/:id/archive` + `/unarchive`, and
`DELETE /clients/:id` now permission-gated, re-checks activity server-side (**409
`client_has_activity`**), and cascades `contact`/`adresse` cleanup (guarded on `id > 0` since those
tables store `IDclient = 0` for other parents). Archiving flips `client.archivé`: a named `UPDATE`
on Windows, and on the Linux bridge a `queryB64Text` `SELECT *` → flip → delete + positional
reinsert preserving the PK (the accented column can't be named on the bridge — same shape as
`references-ecru.ts setArchive`; **the Linux path is untested from Windows** — smoke-test one
archive/unarchive after deploy). The detail endpoint now returns an `archive` flag; the header shows
an "Archivé" badge. **(2) Tarifs email**: the header "Envoyer un email" button now opens the same
(référence × coloris) selector as Print (mode-aware title/footer) → **Envoyer par email** hands the
generated PDF to the shared `SendEmailDialog` pre-attached; the "En développement" placeholder was
removed. **(3) Sidebar**: dropped the count numbers next to the Contacts/Adresses tabs. **(4) Fiche
Tarifs PDF redesign** (`apps/api/src/lib/pdf/TarifsClientPdf.tsx`, new dev preview
`apps/api/src/scripts/dump-tarifs-pdf.ts`) to the MPS_NG document design language shared with
Devis/Commande/Facture: cream gold-left **section header cards** (Tag icon + French-blue reference +
muted contexture, with right-aligned Laize/Poids metric tiles and the BIO chip), a consolidated
top **conditions card** (HT · €/mètre linéaire + validity — replacing the per-section repetition and
the fixed bottom note), and **tinted quantity "axis" columns** in the price grid so the tranche axis
reads apart from the price matrix. Data builder untouched (both Print and Email paths get the new
look); verified end-to-end against live data (client THUASNE, 3 pages).


## 2026-07-07 — feat/gestion-client
Clients › Gestion — **Fiche Tarifs: selection-driven print & email** (`apps/api/src/lib/pdf/TarifsClientPdf.tsx`
[new], `apps/api/src/routes/clients.ts`, `apps/api/src/lib/pricing-fini-tarif.ts`,
`apps/web/src/pages/ClientsGestion.tsx`) + a cross-screen amber-bar design fix.
**(1) Fiche Tarifs** ports the legacy `Choix_Matiere_Tarif` → "Fiche Tarif" report. The header
Printer button opens a selection dialog listing every (référence × coloris) pair of the client
with checkboxes + Tous/Aucun; **Imprimer** opens the PDF, **Envoyer par email** opens the shared
`SendEmailDialog` with the PDF pre-attached. New API: `GET /clients/:id/tarifs/pdf?items=<rccIds>`,
`GET /clients/:id/tarifs/email-defaults` (recipients from client contacts — `envoi_soumission`
flag first, else the default contact), `POST /clients/:id/tarifs/email?items=…`. Prices reuse
`calcTarifRefFini` (PrixDeVenteV4 port); `ref_client_colori.lst_tranche` selects which of the 9
quantity tranches print; italic knit label from `contexture.nom` via `ref_ecru.IDcontexture`, BIO
chip from `ref_ecru.bio`, Laize/Poids from `ref_fini.laizeHT_Moy`/`poids_Moy`. PDF uses
`MalterreDocument` (no italic face — bundled Lato has none; @react-pdf hard-fails on it), one
section per référence, two per page via tight explicit lineHeights. Écru-only désignations (no
`IDref_fini`) are greyed out / skipped (no PrixDeVente tarif). Verified value-for-value against the
legacy `Fiche Tarif049A.pdf` sample for client 1083. **(2) Shared engine fix**: `calcTarifRefFini`'s
`qte_ml` now uses the **unrounded** rendement (legacy prints 355 Ml for 4 rolls of 124A where the
2dp-rounded rendement gave 354; prices keep the rounded value and still match). This also corrects
the in-app Tarif dialog quantities. **(3) Design fix**: 4 screens
(`ClientsGestion`, `ClientsExpeditions`, `ClientsFacturation`, `TombeMetierReferences`) rendered
the neutral item-card left amber edge as a **static** `className` string (`… border-l-4 border …
border-l-amber-400/60`), which skips twMerge's border-conflict resolution and draws a thick 4px
bar instead of the standard thin edge. Switched all to `cn(base, 'border-l-amber-400/60')` matching
the `FilsCommandes.tsx` `LineCard` reference; documented the symptom in `mps_designer` §7.


## 2026-07-07 — feat/facturation
Clients › Facturation — **pick-and-delete proformas + cross-screen expedition cache sync**
(`apps/api/src/routes/factures.ts`, `apps/web/src/pages/ClientsFacturation.tsx`).
**(1) "Supprimer des factures" selection dialog** replaces the blanket "Supprimer toutes les
factures" confirm: lists every OPEN proforma (converted ones excluded; independent of the panel's
search/type filters), checkbox per row + "Tout sélectionner" header (indeterminate on partial),
rows show N°/client/date/type-chip/TTC; the destructive "Supprimer (N)" footer button IS the
confirmation. **(2) API `POST /prov/delete-batch`** (`{ids}`, zod, ≤500): the old delete-all body
is factored into a shared `wipeOpenProformas()` used by both `/prov/all` and the new endpoint,
upgraded for subset deletes — an expedition only reopens (`est_facture=0`) when none of its lines
remain referenced by a definitive `ligne_facture` OR a *surviving* proforma's `ligne_facture_prov`.
Converted/unknown ids are skipped (counted in `kept_converted`), never errors. **(3) Cache sync**:
generate + batch-delete mutations now invalidate the `['expeditions']` / `['expedition']` query
families, so Clients › Expéditions reflects `est_facture` flips without a hard reload (the global
5-min staleTime kept it stale before); post-delete selection is recomputed from the pre-invalidation
cache (§25.2) so the detail pane never points at a deleted proforma.

## 2026-07-07 — feat/cmd-client
Clients › Commandes — **Donation orders: attach stock pieces instead of lignes**
(`apps/api/src/routes/commandes-client.ts`, `apps/api/src/routes/stock-ecru.ts`,
`apps/web/src/pages/ClientsCommandes.tsx`). Ports the legacy WinDev "Donation" tab: a donation
commande (`commande_client.donation = 1`) carries no `ligne_commande_client` rows — individual
stock pieces point at it via `stock_ecru.IDcommande_donation` / `stock_fini.IDcommande_donation`
(only tombé-de-métier écru + fini participate; `stock_divers` has no such column). **(1) API**:
`GET /:id/donation-pieces` (attached écru+fini, polymorphic coloris via `avec_teinture`, écru
défauts summary); `GET /:id/donation-candidates?kind=ecru|fini` (full eligible stock — in stock,
not shipped, not reserved to a client line, not at a dyer, not claimed by another donation — plus
pieces already attached to THIS commande so they stay visible/detachable even once shipped);
`PUT /:id/donation-pieces {kind, ids}` replace-set semantics per kind, re-validating adds so a
piece claimed elsewhere since the dialog opened is skipped not stolen, returning the refreshed
attached payload. Guards: the `donation` flag can only flip ON while the order has no lignes and
OFF while no pieces remain (both 409); `POST /:id/lignes` refuses on a donation order (409);
commande DELETE releases attached pieces (`IDcommande_donation = 0`) alongside line rolls; detail
now returns `nb_donation_pieces`. Exported `DefautQualite` / `defautSummary` / `fetchDefectsByEcru`
from `stock-ecru.ts`, reused `repairAliased` / `repairAllJoins` from `stock-fini.ts`. **(2) UI**:
`DetailMain` swaps the lignes panel for a `DonationSection` when `donation = 1` — a grouped
"Pièces tombé de métier" / "Pièces fini" table (legacy columns + totals footer, kg/ml) with an
"Ajouter / Modifier" button opening `DonationPickerDialog` (gold-pill Tombé/Fini tabs over the
full stock, search, pre-checked checkboxes, selection totals, Valider applies the replace-set
PUTs and hydrates the attached cache directly). The permission-gated Donation toggle in the Info
tab now locks (with an explanatory hint) once the order has lignes (can't turn ON) or attached
pieces (can't turn OFF), mirroring the API guards. Dev scripts: `probe-donation-stock.ts` /
`probe-donation-stock2.ts` (schema + eligibility investigation).

## 2026-07-07 — feat/expe
Clients › Expéditions — **Bon de Livraison PDF pagination/layout hardening + candidate-line
simplification** (`apps/api/src/lib/pdf/BonLivraisonPdf.tsx`, `apps/api/src/lib/pdf/MalterreDocument.tsx`,
`apps/api/src/routes/expeditions.ts`, `apps/web/src/pages/ClientsExpeditions.tsx`).
**(1) BL PDF**: tighter meta cards (padding 14→10, row padding 3→1.5, explicit lineHeights so rows
stop inheriting the body's 1.45); fixed-height table header (24pt, lineHeight 1.2) fixing two
`fixed`-repeat artifacts on continuation pages (blank gap above the gold rule, dropped column
labels); `clean()` trims whitespace-only legacy address columns; `N° commande` rendered raw (no
thousands separator); lot pagination hardened — `minPresenceAhead={70}` per lot block and last
piece row glued to the totals row in `wrap={false}` so totals are never orphaned. **(2) Shared
`MalterreDocument`**: header band + card/meta spacing tightened (consumed by BL / CmdSst / Facture
PDFs); `HEADER_HEIGHT` 92→96 so repeated fixed table headers never paint into the band.
**(3) API**: pieces sorted with natural-numeric `Intl.Collator('fr')` ("3386/87" before
"3386/100"); embedded CR/LF in legacy `ref_client` collapsed to spaces. **(4) UI**: the
collapsible "Autres lignes de la commande" group is replaced by derived `visibleCandidates` —
unshipped lines show only when the expedition owns no lines yet, or for the line whose roll
drawer is open. Dev script: `dump-bl-pdf.ts` (renders a synthetic multi-page BL to eyeball layout).

## 2026-07-07 — feat/facturation
Clients › Facturation — **batch proforma generation & wipe from expeditions**
(`apps/api/src/routes/factures.ts`, `apps/web/src/pages/ClientsFacturation.tsx`).
**(1) `POST /prov/generate`** ports legacy `FI_Facturation_ETM`: scans formelle ETM expeditions
(`IDsociete=1`, `est_facture` null/0), groups by client, creates one proforma per client. Lines
mirror expedition lines — designation from the article catalog (fini vs écru honoring
`avec_teinture`), `V/ref` / commande / `Avis` lines, quantity = summed shipped Kg/Ml from rolls,
price+unit from `ligne_commande_client`; contributing expeditions flip `est_facture=1`. Skips
clients internes, donations, and roll-less expeditions (left open); returns `{created, skipped}`.
Chunked `IN` lookups (500), catalog caches, `fixEncoding`, numero-collision retry ×3.
**(2) `DELETE /prov/all`** deletes every OPEN proforma (`IDexpedition_divers=0`) + lines, keeps
converted proformas as history, resets `est_facture=0` only on expeditions without a definitive
`ligne_facture` link; registered before the generic `/:kind/:id` route. Shared
`clientBillingDefaults()` extracted (used by manual create + generator). **(3) UI**: two batch
buttons pinned above the proforma list footer ("Générer les factures" / "Supprimer toutes les
factures", prov bucket only, disabled in edit mode), each behind a `ConfirmDialog`, with a
`BatchResultDialog` summarizing created proformas and skip counts (internes / donations / sans
marchandise) or deletion results.

## 2026-07-07 — feat/cmd-client
Clients › Commandes — **permission-gated Donation flag + CommandeClient PDF layout rework**
(`apps/api/src/lib/permission-keys.ts`, `apps/api/src/routes/commandes-client.ts`,
`apps/api/src/routes/expeditions.ts`, `apps/web/src/pages/ClientsCommandes.tsx`,
`apps/api/src/lib/pdf/CommandeClientPdf.tsx`, `apps/api/src/lib/pdf/MalterreDocument.tsx`).
**(1) Donation**: new `donation_commande_client` permission key (category "Commandes client");
`GET /:id` returns `donation`, `PUT /:id` accepts it but enforces the permission only when the
value actually changes (echoing the unchanged flag is fine). The UI shows a `TogglePill`
"Donation" switch in the Info tab (edit mode, permission-gated; field omitted from the save
payload when unprivileged). Donation propagates downstream: `POST /:id/lignes/:ligneId/expedier`
and formelle expedition creation now default the shipment's `donation` to the parent order's flag
(previously hardcoded 0 / explicit-only), so donation orders never spawn proformas.
**(2) PDF**: the acknowledgement's right "combo" card is split — payment terms move to the top
row next to the client card; the livraison address becomes its own card pinned to the bottom of
the last page (`wrap={false}`, grows into leftover space). Shared compact cream `card` style,
`lineHeight: 1` on icon-adjacent text (also in `MalterreDocument` card title/meta styles),
and a `pushLine` helper that trims HFSQL single-space "empty" address columns. Dev scripts:
`render-cc-pdf.ts` (render a commande's PDF to file by numero), `probe-donation-flag.ts`
(one-off donation-column probe).

## 2026-07-06 — feat/cmd-sst
Sous-traitants › Commandes — **per-lot tooltip on the totals-footer "Ml reçus"**
(`apps/api/src/routes/commandes-sous-traitant.ts`, `apps/web/src/pages/SousTraitantsCommandes.tsx`).
The detail endpoint's received-rolls aggregate now also reads each `stock_fini` roll's `lot`
(`fixEncoding` keyed on `IDstock_fini`) and returns a per-line `fini_lots: {lot, nb, metrage}[]`
(lot-less rolls group under `''`). The frontend merges `fini_lots` across lines (`finiLotsMerged`
useMemo in `LignesSection`); the green "· X Ml reçus" span in the totals footer gains a
`FiniRollIcon` + `cursor-pointer` and, on hover, the shared `Tooltip` (side top) titled
"Métrage reçu par lot" listing "Lot <n> — N rouleaux · X Ml" per lot ("Sans lot" for empty).
Falls back to the plain span when no breakdown exists. Verified against dev commande 8607
(4 rolls sans lot · 107 Ml + 3 rolls MA1234 · 25 Ml = 132 Ml total, matches
`total_metrage_fini_recu`).

## 2026-07-06 — feat/suivilot
Qualité › Suivi des lots — **"Pièces du lot" table footer now totals Poids & Métrage**
(`apps/web/src/pages/QualiteSuiviLots.tsx`, `RecapSection`). The read-only per-roll sub-table
previously showed only a single "Moyenne" row spanning the first 4 columns with the average Rdt.
It now shows a `Total` label with the summed `poids` (` Kg`) and `metrage` (` Ml`) in their own
columns (client-side `pieces.reduce`, `p.poids || 0` / `p.metrage || 0` guards), while the
existing average Rdt is preserved — its "Moyenne" label moved to the Magasin column, right-aligned
before the Rdt value in `text-accent`. Presentation-only; no API/data changes.

## 2026-07-03 — feat/expe
Clients › Expéditions — **facture lock model + Factures tab + Avis d'expédition PDF + email**
(`apps/api/src/routes/expeditions.ts`, `apps/api/src/lib/pdf/BonLivraisonPdf.tsx`,
`apps/web/src/pages/ClientsExpeditions.tsx`). **(1) Legacy validé/dévalider RETIRED**: an expedition
is either "non facturée" (fully editable) or "facturée" (fully locked). Lock = `est_facture=1` OR a
definitive facture actually references it — formelle via `ligne_facture.IDligne_expedition` →
`ligne_expedition`, divers via the `facture.IDexpedition_divers` header back-pointer
(`facture_prov.IDexpedition_divers` deliberately excluded — repurposed as the converted-proforma
marker). Every write path 409s `expedition_facturee`; `POST /:kind/:id/validate` removed; `est_valide`
is never read (still zero-filled on INSERT for legacy). UI: status footer pill removed (derived state
→ header badge Facturée/Non facturée per mps_designer §29.6), list pills recolored, Modifier hidden
when locked. **(2) Factures tab**: right panel now tabbed Info | Factures; detail returns `factures[]`
(numero/date/type incl. Avoir) + `locked`. **(3) Legacy-parity line list** (verified vs expedition
11644 / commande 6677, 12 lines across ~15 expeditions): only lines with a `ligne_expedition` row on
THIS expedition belong to it; other commande lines render as a collapsed "Autres lignes de la
commande" candidates group, only while editable — a locked expedition shows exactly the legacy view.
**(4) Roll icons**: FiniRollIcon / TmRollIcon per stock kind on line cards + roll drawer. **(5) Avis
d'expédition PDF** (`GET /expeditions/formelle/:id/pdf`, byte-matched vs legacy BL 11645): MalterreDocument
frame, livraison address + meta cards, the two fixed legacy quality notices, per-article identity block
(ref - coloris, designation, finition label from the WinDev `gtaFinition` enum {1: OUVERT AU LARGE,
2/3: TUBULAIRE…}, `V/réf.` from `designation_client`), per-lot pieces tables (obs column gated on
`affiche_observations`, prints `stock_fini.observations` NOT `observation_sst`), lot/article/avis
totals; écru lines supported via `IDligne_expedition_ETM`. **(6) Email**: `GET/POST
/formelle/:id/email-defaults|email` per the §32 pattern — contacts split by `envoi_bl`, Gmail DWD send,
BL PDF attachment, `envoi_email` audit with `IDtype_doc=14` ("avis expedition"; 16 = divers, reserved);
`SendEmailDialog` mounted on the Textile bucket (divers keeps placeholders for print + email). Also
fixed `loadContactName` (missing `IDcontact` in SELECT silently disabled fixEncoding accent repair).

## 2026-07-03 — feat/cmd-client
Clients › Commandes — line drawer **supply accuracy pass + Tricotage/Ennoblissement order creation +
Expédition tab + quick-ship** (`apps/api/src/routes/commandes-client.ts`, `commandes-sous-traitant.ts`,
`apps/web/src/pages/ClientsCommandes.tsx`). **(1) Supply semantics fixed against legacy (commande 3686,
validated to the cent)**: Ennoblissement "affecté" counts only écru rolls reserved to THIS client line;
the Tricotage grid reads the `affectation_cmd_tricotage` planning table (affecté = allocation to this
line, dispo = quantité − ALL allocations, métrage = affecté × rendement) instead of produced stock_ecru;
the "Stock de fil disponible" panel subtracts yarn still needed by open `ordre_fabrication`s
(`asso_fil_of`, `est_termine=0`: remaining × pourcentage — factored as `openOfPendingByLot`). Legacy
WinDev sources are PCS-compressed — all formulas reverse-engineered from HFSQL data. **(2) Combined
affecté gauge**: `lineReservationAggregates` now sums stock_fini rolls + stock_ecru rolls × rendement +
tricotage allocations (fixes 0/800 → 854,5/800 Ml); exposed as `affecte_total` on the `/pieces` payload
and used by the line bar, drawer, and modal footers (shared `AffecteGauge` w/ full-width progress bar).
"Ml" (mètres linéaires) capitalized app-wide. **(3) Knit-order creation** (legacy "Commande de Tricotage
Malterre" modal): per-tricoteur "Nouvelle commande" launcher on the stock-fil location bands
(`is_tricoteur` flag via IDtype_sst=1); modal has affecté/stock kg inputs with live Ml hints, net yarn
stock + pending yarn orders (`ref_fil_commande.etat=0`) tables; POST creates commande + line (unite=1,
prix via `trmLinePrix`) via exported `createKnitOrder` — TRM gets Attente_Delai + cross-ledger mirror,
external tricoteurs get Non_Envoye and no mirror — plus `affectation_cmd_tricotage` (input may be
negative, legacy parity) and one `asso_fil_lignecmdsst` per composition yarn against the knitter's lot.
**(4) Tricotage row-click modal** adjusts the (sst line, client line) allocation via new
`PUT …/supply/tricotage/:sstLineId/affectation` (over-allocation guarded). **(5) Expédition tab**:
expeditions carrying the line (`ligne_expedition`) with Facturée/Non facturée pill, per-expedition roll
list + transporteur/adresse info via new `GET …/lignes/:ligneId/expeditions`. **(6) Quick-ship**:
checkbox-select affected unshipped rolls in the Affectation tab → Expédier (ConfirmDialog) → new
`POST …/lignes/:ligneId/expedier` creates the expedition (address from commande, carrier from client,
est_valide=0) + `ligne_expedition` + points the rolls at it, then jumps to the Expédition tab.
**(7) Terminée = read-only Affectation tab**: lock banner, no available pool / affect / remove / ship /
observation edits (obs endpoint gained the missing `refuseIfSoldee`). All flows exercised end-to-end
against live HFSQL with test rows cleaned up afterwards; probe scripts under `apps/api/src/scripts/`.

## 2026-07-02 — feat/expe
Clients › Expéditions — filter + labelling + pagination pass (`apps/web/src/pages/ClientsExpeditions.tsx`,
`apps/api/src/routes/expeditions.ts`). **(1) Bucket labels**: the two category tabs "Formelles"/"Diverses"
now read **"Textile"/"Diverses"** (the internal `Kind` codes `formelle`/`divers` are unchanged; only the
French display strings + the create-modal Type toggle label). **(2) Invoiced filter**: the left-list state
filter was "Toutes / Brouillons / Validées" (on `est_valide`) and is now **"Non facturées / Facturées"**
(on `est_facture`), defaulting to **Non facturées**; "Toutes" was dropped and the two buttons split the row
50/50 with `whitespace-nowrap` so "Non facturées" stays on one line. API `?state=` accepts `facture` /
`nonfacture` (non-facturées guarded as `est_facture IS NULL OR est_facture = 0` per the HFSQL empty-flag=0
rule); legacy `all` still accepted but the UI never sends it. This matches the legacy app, where only 4
diverses are not-yet-invoiced (595/596/599/600). **(3) Load-more pagination**: the list was hard-capped at
`TOP 200`; it now pages via `useInfiniteQuery` (200/page) with a cursor `?before=<lastId>` (`IDexpedition <
before`, ignored while searching), a ghost "Charger plus" button under the last card when a full page came
back, and a `200+` footer count. Fixes the Textile/Facturées view showing exactly 200 when far more exist.
Verified `tsc --noEmit` clean on web (API baseline errors only, none in expeditions.ts).

## 2026-07-02 — feat/cmd-client
Clients › Commandes — line-item **Affectation drawer** upgrades plus supply-view accuracy fixes
(`apps/api/src/routes/commandes-client.ts`, `apps/web/src/pages/ClientsCommandes.tsx`). **(1) Roll cards
now show the fini/écru domain icon** (`FiniRollIcon` green box for fini lines, `TmRollIcon` for écru) instead
of a generic box, mirroring the sst pieces drawer. **(2) Défauts + observations are visible on each roll** via
the new shared `apps/web/src/components/shared/RollNotes.tsx` (blue observation banner / red défaut banner) —
extracted from `SousTraitantsCommandes.tsx` (which now imports it; its local copy was deleted). The `/pieces`
payload gained `observation_sst` (the ennoblisseur's defect report). **(3) Observations are editable** per roll
via a pencil → dialog, saved through new `PUT /commandes-client/:id/lignes/:ligneId/pieces/:kind/:stockId/observations`
(guards ref match + line ownership, writes via `sqlText()` for Linux-bridge-safe accents). **(4) Shipped rolls
are locked** — the "Retirer" button is hidden when a roll is expédié (fini état 4 or `IDligne_expedition` set;
écru `IDligne_expedition_ETM` set), and both unlink `DELETE` endpoints refuse with 409 server-side. **(5) New
"Stock de fil disponible" panel in the Tricotage tab** (`GET …/supply/tricotage/stock-fil`): yarn on hand usable
to knit the line's écru, scoped by `composition_ecru`, aggregated per holding location (`stock_fil.IDMagasin` →
sous_traitant), with métrage potentiel = poids / (pourcentage/100) × rendement. Composition pairs with no
on-hand lot still render under a synthetic "Sans stock" group so the full composition is always visible.
**(6) Tricotage orders now filter by écru coloris** — `buildTricotage` gained an `IDColoris IN (…)` restriction
(same `ennoInputColoriIds` rule as the écru-disponible pool) so a 029/gris-anthracite knitting order no longer
leaks into a line that needs 029/ecru (matches legacy; verified on commande 3686 / sst 8524). **(7) Supply tables
harmonized** — the enno location groups and the new stock-fil list now use the same table grammar as
"Commandes … en cours" (shared `GroupBandRow`, zinc band headers, right-aligned tabular numbers, bold métrage).
**(8) `KnitIcon`** (`apps/web/src/components/icons/KnitIcon.tsx`) — filled in the knit-mesh lattice: the hidden
`opacity="0"` connector was made visible and the missing rows-2→3 vertical connectors added, so the icon reads
as a closed diamond mesh rather than one filled loop.

## 2026-07-02 — feat/bug-pierrot
Sous-traitants › Reprise / Qualité › Suivi Lots (`apps/api/src/routes/commandes-sous-traitant.ts`) —
**correcting a roll's lot number in the Reprise modal now migrates the suivilot tracking** (bug reported by
Pierre-Emmanuel: Tricobot received commande 8801 under the truncated lot "MA"; after a reprise re-reception
with the right number, the "MA" lot stayed stuck "En reprise" with zero pieces in Qualité while the corrected
lot never appeared there at all). Root cause: `suivilot` is keyed on (ligne, lot), but the reprise PATCH only
updated `stock_fini.lot` and then synced `IDetatLot` against the NEW lot value (matching zero rows);
`upsertSuivilot()` only ran on the reception POST. New `migrateSuivilotLot()` runs on every lot-changing
PATCH: while rolls remain under the old lot it just ensures the new lot is tracked; when the last roll leaves,
the old suivilot is renamed onto the new lot. When old and new rows both exist, whichever carries
operator-entered contrôles survives (`suivilotHasControles()`, ASCII columns only) and a data-less placeholder
is deleted — so the modal's one-PATCH-per-roll batch ends with a single row that preserves measurements, and
operator input is never destroyed (worst case both rows survive + console.warn). Verified end-to-end on the
local DB (commande 8518, 7 rolls, suivilot with contrôles). Deployed to prod 2026-07-02 + one-shot data
repair: ligne 8776 rolls normalized `"MA 108715"`→`MA108715`, suivilot #5810 re-keyed MA→MA108715 état 2→1.

## 2026-07-02 — feat/cmd-client
Clients › Commandes line-drawer accuracy pass + shared état pill. **(1) `EtatPill`**: the stock_fini état
pill (green Validé / amber Contrôle / orange Reprise / red Refusé) is now a shared component in
`apps/web/src/lib/etat-stock-fini.tsx` (file renamed from `.ts`); the Affectation-tab roll rows in
`ClientsCommandes.tsx` (previously a plain grey outline Badge), `FinisStock.tsx` (table + drawer) and
`SousTraitantsGestion.tsx` all render it — rule recorded as mps_designer §37. **(2) `IDcommande_donation`
availability guard**: écru/fini rolls reserved to a donation-type commande client are no longer counted as
available anywhere — Affectation drawer (écru + fini pools), Ennoblissement per-location totals +
create-order roll picker (`fetchEnnoLocations`/`fetchEnnoAvailableRolls`), `buildEnnoblissement` (donation →
affecté bucket), create-order defensive filter, the sst écru picker in `commandes-sous-traitant.ts`, and
Tombé Métier/Stock "Disponible" (`stock-ecru.ts`; still visible under "Tous"). Verified: ref 040 phantom
44.7 kg gone, legacy-validated ref 029 totals unchanged. **(3) Wash-only enno input coloris** (user-found):
for `ref_fini.avec_teinture=0` the line's IDcolori IS a colori_ecru id, so the Ennoblissement écru pool
filters to that exact coloris (e.g. 040A/gris8985 ← écru 040/gris8985), not the natural "ecru" base (which
remains correct for dyed finis) — helper `ennoInputColoriIds`; panel title now shows the real coloris via
`ecru_coloris_label`; `computeTombeMetier` (sidebar "Tombé de métier commandé" card) aggregates per
(écru ref, input coloris) instead of hardcoding "/ecru". Verified: cmd 3692 (040A gris8985) now shows an
empty pool titled "040 /gris8985", matching legacy. **(4) Fiche client**: commande detail returns
`client_fiche` (= `client.commentaire`, fixEncoding + defensive stripRtf) and the Info tab shows it in a
read-only ClipboardList card — customer handling procedures visible on every commande like legacy.
**(5) Line commentaire**: `LineCard` renders the line's commentaire with the §24 MessageSquare pattern
(trim-guarded, ml-9, italic muted).

## 2026-07-02 — feat/cmd-sst
Sous-traitants › Commandes (`apps/web/src/pages/SousTraitantsCommandes.tsx`) — **"Couper en deux" is now
available in the Reprise reception modal** (was create-only: the toggle was gated `{!isReprise && …}` with a
comment claiming a reprise can't split rolls). The two-piece editor, preview list (scissors on both halves),
per-piece lot+métrage validation and progress counter were already mode-generic, so the toggle simply renders
in both modes. Submit for a split reprise roll: the existing `stock_fini` row is **PATCHed** into piece 1 —
renamed `<base>-1` (base trimmed to 18 chars for the 20-char numero column), new poids/métrage, état reset to
1 (En contrôle) — and piece 2 **POSTs** as a new roll `<base>-2` through the existing `pieces/fini` create
endpoint, passing the original's `IDstock_ecru`/`IDColoris`/`IDmagasin` explicitly so both halves match apart
from poids/métrage (the POST also inherits the écru's client reservation and upserts the suivilot
idempotently). No API changes — the PATCH already accepted `numero`. Doc updated in
`sous_traitants_status_model.md §Reprise flow`.

## 2026-07-02 — feat/prospect
Prospects › Demandes (`apps/web/src/pages/ProspectsDemandes.tsx`) — **search now auto-selects the top
visible result**. The screen's auto-select effect predated the mps_designer §5 guideline: it ran only on
first load (gated on `selectedId === null`) and against the raw list, so narrowing the search to a single
demande left the previous selection in place and the detail panel never switched. Replaced with the
canonical effect from `FilsCommandes.tsx`/`EtudesColoris.tsx`: it watches the **filtered** list, re-selects
`filtered[0]` whenever the current selection drops out of the visible set, and skips while `isEditing` so
unsaved changes are never discarded. No skill/doc update needed — the behaviour was already recorded in
mps_designer §5.

## 2026-07-02 — feat/cmd-sst
Sous-traitants › Commandes (`apps/web/src/pages/SousTraitantsCommandes.tsx` + `apps/api/src/routes/commandes-sous-traitant.ts`) —
**Tricobot autofill now works in the Reprise reception modal** (was create-only). When rolls "En reprise" are
multi-selected in the Réception tab and reopened via "Reprendre", the Tricobot mascot appears in the
`BatchReceptionDialog` header and pre-fills Lot / Poids / Métrage / Défaut from `data_bl_tricotbot`, matching BL
`num_piece` against the **fini** roll numeros (create mode keeps matching écru numeros) — a reprise sends the same
physical rolls back to the sst, so the corrected BL lists the same piece numbers incl. `-1`/`-2` split suffixes.
Overwrite semantics hardened for both modes: only **non-empty** BL values overwrite a field, so a hole in the BL
can't wipe the reprise pre-fill (or a user-typed value in create mode). API tricobot endpoint now `ORDER BY
IDdata_bl_tricotbot` so when the same num_piece exists twice (original + corrected reprise BL) the frontend's
last-write-wins map deterministically keeps the newest row. Doc updated in `sous_traitants_status_model.md §Reprise`.

## 2026-07-02 — feat/suivilot
Soumission Lot Client — per-coloris "Ref client" fix (`apps/api/src/routes/commandes-sous-traitant.ts`,
`findEligibleLots`). A client can hold SEVERAL `designation_client` rows for the same ref_fini, one per
coloris, each linked to its coloris through `ref_client_colori` (THUASNE has three for ref 1732:
65511008000→coloris 3520 Blanc, 65511227000→3521, 65511019000→3522). The eligibility map keyed only on
`(IDclient, IDref_fini)`, so an arbitrary sibling row overwrote the right one — commande 8500's soumission
PDF printed 65511019000 instead of 65511008000. Fix: also load the non-archived `ref_client_colori` rows for
the soumettre=1 designations and build a per-coloris map `client|ref|coloris → designation` (dye refs link via
`IDref_fini_colori`, wash via `IDcolori_ecru`), consulted first at assembly; the old `(client, ref)` map stays
as fallback for coloris without a `ref_client_colori` row. Flows into the eligible-lot card AND the soumission
PDF/email (shared data). Verified live: probe on 8500 now returns 65511008000 for Blanc 54508/1. Probe scripts
`inspect-soumission-8500-refclient.ts` / `probe-eligible-8500.ts` committed alongside.

## 2026-07-02 — feat/rapport-sst
Rapports › Commandes sous-traitants (`apps/web/src/pages/RapportCommandesSst.tsx`) — the Excel-export
column selection is now remembered **per user**, not per PC: the localStorage key is suffixed with the
logged-in `IDutilisateur` (`mps:rapport-sst:export-columns:<id>`), so users sharing or switching accounts
on one station no longer overwrite each other's choice (reported by an employee as "selection not
memorized"). Loader falls back to the old shared key so existing saved selections carry over; a
`useEffect` re-reads the selection when the logged-in user changes without a remount (user picker /
admin impersonation). Save still happens only on a successful export. Marked temporary — to be replaced
by a server-side per-user preference once proper user management lands post-migration.

## 2026-06-25 — feat/cmd-client
Clients › Commandes (`apps/web/src/pages/ClientsCommandes.tsx` + `apps/api/src/routes/commandes-client.ts`) —
polish + correctness pass on the line affectation drawer's **Ennoblissement** supply tab plus the right-panel
Info tab. **(1) Line pin-to-top drawer**: clicking a ligne now collapses the lines list to that line's height and
smooth-scrolls it to the very top so the affectation drawer always claims the space below it (was using a
max-height CSS transition that clamped the scroll and left the line short; now collapses height instantly and
scrolls to an absolute target). **(2) "Écru disponible" by location — three correctness fixes** in
`fetchEnnoLocations` / `fetchEnnoAvailableRolls`, all validated against the live legacy "029 - écru disponible"
panel (ref_fini 639 "029A" → écru ref 146, cmd 3686): (a) **natural-écru filter** — restrict source écru to the
`colori_ecru.reference = 'ecru'` base (helper `naturalEcruColoriIds`; fallback = whole pool if a ref has no
'ecru' coloris) because color-knitted variants ("Gris clair C5010" etc.) can't be re-dyed; this dropped MATEL
485→256.30 kg; (b) **"à l'usine" group** — dropped the old `IDsociete=1 AND IDmagasin>0` restriction so factory
écru (`IDmagasin=0`) surfaces, grouped by owning company via new `resolveSocieteNames` (1=Ets Malterre, 2=Tricotage
Malterre, 3=Malterre Confection); à-l'usine rows are read-only (no create button, synthetic `IDsous_traitant=-IDsociete`
React key); (c) **orphan-roll filter `IDLigne_Commande_TRM > 0`** — only écru traceable to a TRM knitting order counts,
which legacy applies uniformly (splits Tricotage Malterre 233.30→198.90 while leaving MATEL 256.30 intact; it is NOT a
second_choix filter — MATEL's 256.30 includes a 2nd-choix roll). **(3) UI polish on the location table**: larger/bolder
poids+métrage values with a gold icon box; the per-row button is now a ghost-accent "+ Nouvelle commande" matching the
left-list "+ Nouvelle"; the section title reads "{écru} /ecru — tombé de métier disponible" via a new `ecru_ref_label`
payload field. **(4) Info tab**: new "Tombé de métier commandé" card listing total écru kg ordered per écru ref
(`computeTombeMetier`: Kg lines count quantite, Ml lines convert kg = ml / rendement; fini lines trace through
`ref_fini.IDref_ecru`); and fixed Mode-paiement/Échéance showing "—" in view mode by removing the `enabled: isEditing`
gate on the two enum lookups (they're needed to resolve the labels outside edit mode).
## 2026-06-25 — feat/expeditions
Clients › Expéditions (`apps/web/src/pages/ClientsExpeditions.tsx` + `apps/api/src/routes/expeditions.ts`,
registered at `/api/expeditions`) — new screen combining the legacy `FEN_Gestion_expédition_ETMV2` (formal,
order-tied) and `FEN_Expéditions_diverses` (miscellaneous) windows into one master-detail with a **Formelles |
Diverses** bucket toggle (same `Kind`/`TBL` config shape as factures). **Formelle** = `expedition` +
`ligne_expedition`, tied to a `commande_client`: full create (pick a commande; transporteur + livraison
address auto-filled from client/order) / edit / **roll picking** — clicking a commande line opens an in-screen
drawer (mps_designer §31) to assign/free received rolls. Rolls point BACK at the shipment line via
`stock_fini.IDligne_expedition` (fini lines, type 2) or `stock_ecru.IDligne_expedition_ETM` (écru lines,
type 1); the `ligne_expedition` row is created **lazily** on first assign and deleted when emptied; deleting a
shipment frees all its rolls first. **Diverses** = `expedition_divers` + `ligne_expedition_divers` (no
`IDsociete` column; recipient = a registered `IDclient` or free-text `ref_client`), free-text `detail_ligne`
lines (RTF via stripRtf/wrapRtf). A sidebar **status-footer pill** drives `est_valide` (Brouillon → Validée);
a validated shipment is locked (header/line/roll writes return 409, like a definitive facture) but its lines
still open read-only to view shipped rolls. HFSQL footguns baked in: `date` is reserved (write/read as `DATE`);
`expedition.envoyé_client`/`envoyé_sst` are accented → never named (explicit column lists omit them, INSERT
zero-fills); empty FK = 0 not NULL; `expedition` has **no `numero`** (document № = PK; new-id resolved via
MAX-before + `TOP 1 > before DESC`); `IDsociete=1` on formelle reads/writes only. Per-line **dispo count is
per the line's own stock kind** — écru rolls merely *reserved* to a fini line (ennoblissement dyeing input)
are NOT shippable finished goods (bug found + fixed during build). Print / Email are "En developpement"
placeholders for V1 (real Bon de Livraison PDF + Gmail send — `envoi_email` type_doc 14, contact flag
`envoi_bl` — deferred; this screen also unblocks Facturation's génération-auto-from-expeditions). No conflict
with the `facture_prov.IDexpedition_divers` overload (that's a column on `facture_prov`, never a real
`expedition_divers` row). Verified end-to-end on local HFSQL — full formelle (create → assign/unassign roll →
delete, rolls freed) and divers (create → line CRUD → validate-lock 409 → reopen → delete) write roundtrips,
all reverted cleanly; web + api `tsc --noEmit` clean (api shows only the known baseline errors).

## 2026-06-25 — feat/facturation
Clients › Facturation (`apps/web/src/pages/ClientsFacturation.tsx` + `apps/api/src/routes/factures.ts` +
`apps/api/src/lib/pdf/FacturePdf.tsx`) — added the **proforma vs definitive** two-table model on top of the
existing manual-invoicing screen. The API routes are now generalized over a `Kind` config (`TBL` map) and
moved under `/factures/:kind/...` (`kind` = `prov` → `facture_prov`/`ligne_facture_prov`, `def` →
`facture`/`ligne_facture`); the list is `GET /factures?status=prov|def`. Each table keeps an **independent
`numero` sequence** (MAX+1 per table, retry loop). A proforma is fully editable; converting it
(`POST /factures/prov/:id/convert`) copies the header + lines into `facture` with a fresh definitive numero.
Because `facture_prov` has no spare flag, a converted proforma is marked by **overloading
`facture_prov.IDexpedition_divers`** (else always 0) as a back-pointer to the resulting `facture.IDfacture`
(`0` = open/editable, `>0` = converted/locked). Write-path **locks** (server 409 `DEF_LOCK` / `PROV_CONVERTED`,
FE hides the buttons): definitive is read-only AND non-deletable; a converted proforma is read-only. **Email +
historique are definitive-only** (prov/def share the `envoi_email` `IDtype_doc` 19 + a numeric id space, so
emailing a proforma would cross-contaminate histories). Proforma still prints via a `FacturePdf` `isProforma`
variant ("Facture proforma" title + "Document non contractuel" mention; no italic — bundled Lato has no italic
face). FE: the create dialog now picks `prov`/`def`; the detail header shows a Proforma/Définitive/Converti
badge, a "Convertir en facture" action on open proformas, and a "Voir la facture N°…" jump on converted ones.
**Left-panel redesign** (this session's ask): the proforma/definitive selector is now a prominent bordered
segmented control (`Proforma | Définitives` — renamed from "Factures" to kill the collision with the type
filter's "Factures"), and the type filter below it (`Tous | Factures | Avoirs`) uses the standard left-list
filter button group, so the category switch reads as dominant and the filter as subordinate. Verified end-to-end
on local HFSQL; web `tsc --noEmit` clean.

## 2026-06-25 — feat/gestion-client
Clients › Gestion (`apps/web/src/pages/ClientsGestion.tsx`) — right-panel reorganization (UI only, no
API/data changes). The master-data form that previously lived in the **center** panel was moved into the
right sidebar as two new tabs, so the sidebar now reads **Info / Commercial / Contacts / Adresses**:
- **Info** tab (new) holds Général (téléphone, fax, remise %, % AJEOL, secteur, activité, the *client
  interne* / *inclure rapports contrôle* toggles), Facturation (mode de paiement, échéance, TVA, N° TVA,
  code comptable, compte client), and Commentaire — rendered as `InfoCard` + `KVRow` (label-left /
  value-right; `size="sm"` `SearchableCombobox`/`PopoverSelect` in edit mode) wired straight through the
  existing `draft`/`onPatch` state, so the unsaved-changes guard and Enregistrer/Annuler flow cover it.
- **Commercial** tab (new) holds Dernier contact + Journal commercial (same `draft`/`onPatch` plumbing).
- The **center** panel is now purely the read-only history collapsibles (Références / Historique /
  Marchandise); `DetailMain` lost its now-unused `draft`/`onPatch`/lookup props.
The sidebar root width went `w-96` → `w-[26rem]` (one-off for this screen, not recorded in mps_designer)
to fit four tabs, and the per-tab count **pill** was replaced with a compact inline number so "Contacts"
and "Adresses" labels stop truncating against `flex-1` equal widths. Removed the now-dead `Field`,
`SelectField`, and `SectionCard` helpers.

## 2026-06-25 — feat/devis
Clients › Devis PDF (`apps/api/src/lib/pdf/DevisEtmPdf.tsx`) — CONDITIONS header card redesign (follow-up to
the 2026-06-24 header-height work). Three fixes: (1) **icon alignment** — every `flexDirection:'row'`+
`alignItems:'center'` icon+title row in this file rendered the Svg visually *below* its text, because the
content area inherits `lineHeight:1.45`, inflating each line box so glyphs sit at the top while the icon
centers in the tall box. Added tight `lineHeight:1` on the meta labels/values and the card/livraison/
commentaire titles so icons center against the real glyphs. (2) **relevant, distinct icons** — the old card
reused a chat bubble for Réf. client and the calendar for both Validité and Échéance, so at ~10px they read
as identical rectangles; now tag (réf. client) / calendar (validité) / credit-card (paiement) / clock
(échéance), built from a typed `metaItems` array. (3) **vertical space** — conditions moved from 4 full-width
stacked rows to a compact **2×2 grid** (icon beside a stacked caps-label + value), so the conditions card no
longer drives the header height (the client address does). Added a dev script
`apps/api/src/scripts/dump-devis-pdf.ts` (mirrors `dump-soumission-pdf.ts`/`dump-sst-pdf.ts`) that renders a
devis PDF from synthetic data for offline layout inspection. Pure PDF layout — no API/data changes.

## 2026-06-25 — feat/stock-finis
Finis › Stock table (`apps/web/src/pages/FinisStock.tsx`) — cosmetic weight fix. The Poids column cell in
`StockRow` carried a `font-medium` class that bolded every weight value relative to the surrounding columns.
Removed it so the Poids values render at normal weight, consistent with the rest of the table row.

## 2026-06-25 — feat/cmd-client
Clients › Commandes — Ennoblissement supply tab: affectation modal, état pills, and the **create-ennoblisseur-order
from a client line** flow (`apps/web/src/pages/ClientsCommandes.tsx` + `apps/api/src/routes/commandes-client.ts`).
The line-drawer Ennoblissement/Tricotage supply tables gained **N°** + **Date** columns and a solid-hue
`SupplyEtatPill` (En cours / Attente délai / Non envoyé), and single-clicking an ennoblisseur row opens
`EnnoblissementAffectationDialog` (two-panel transfer) to reserve a dyer's input écru rolls to the client fini line
— with a coloris-match fix on `buildEnnoblissement` (`lcs.IDColoris = ctx.coloriId`) so a dye order for a different
coloris of the same ref_fini no longer leaks in. New this branch: below the in-progress orders table, an
**EnnoLocationTable** ports the legacy "029 - écru disponible" panel — tombé-de-métier (écru) of this fini's écru ref
(`ref_fini.IDref_ecru`) available, aggregated by sous-traitant location and grouped **Chez les ennoblisseurs**
(IDtype_sst=2) vs **À l'usine** (other ssts), each row showing Poids (kg) + Métrage potentiel (poids×raw-rendement).
Only ennoblisseur rows carry a gold **Commande** button that opens a location-scoped `CreateEnnoblisseurOrderDialog`
("Disponible chez X" rolls, all pre-selected, Shift-range + Tout/Aucun, date commande/livraison). Creating commissions
a `commande_sous_traitant` + one `type=2` line (IDreference=ref_fini, IDColoris=coloris, quantite=Σpoids×rendement Ml,
unite=0, sstatut=Non_Envoye — INSERT shapes copied verbatim from commandes-sous-traitant.ts), affects the chosen écru
rolls (`stock_ecru.IDref_commande_affectation`), auto-reserves the FREE ones to the client line
(`IDligne_commande_client`, guarded so rolls reserved elsewhere keep their reservation), and auto-prices via
`calcTarifSST` (€/Kg, best-effort). **Affect-only** — `IDmagasin` untouched (physical shipment stays a separate step).
Backend endpoints (all scoped to a fini client line): `GET …/supply/ennoblissement/available-by-location`
(`fetchEnnoLocations` + `resolveSousTraitantTypes`; factory `IDmagasin=0` excluded — only sous-traitant locations),
`GET …/available-rolls[?magasin=<id>]` (`fetchEnnoAvailableRolls`; coloris NOT filtered — dyer dyes any source coloris;
`reserved_elsewhere` surfaced not excluded; available = ref match + not-dyer-affected + not-shipped + not-consumed-by-fini),
`GET/PUT/DELETE …/supply/ennoblissement/:sstLineId/rolls[/:stockId]` (`fetchEnnoRollsPayload`), and
`POST …/supply/ennoblissement/orders` (`ennoOrderBody`). Ennoblisseurs are external → no TRM mirror / no bridge-storm.
Reads verified live (cmd 6899/ligne 12648/040A → MATEL 2 rolls / 26.26 kg / 63 ml). (Memory:
project_clients_line_supply_tabs.)

## 2026-06-24 — feat/devis
Clients › Devis PDF (`apps/api/src/lib/pdf/DevisEtmPdf.tsx`) — header height reduction + delivery-address
relocation. The delivery address (`ADRESSE DE LIVRAISON`) was removed from the top-right combo card and now
renders as its own gold-accent box pinned to the **bottom** of the page, just above the footer band — pushed
down by a `flexGrow` `bottomSpacer`. The top row was reorganized into two tighter cards (`CLIENT` left,
`CONDITIONS` right) sharing a compact `headerCard` style (padding 14→10, tighter line-height, conditions as
a tight label/value grid with 10px icons) so the header band is noticeably shorter. The old `comboCard`/
`AddressCard` usage was dropped in favor of local compact card markup; `buildClientAddress` now returns a
plain `{ name, lines }` shape. No API/data changes — pure PDF layout.
Rapports › Commandes sous-traitants — Excel export date-sort fix (`apps/web/src/pages/RapportCommandesSst.tsx`).
The five date columns (Date commande, Délai initial, Délai actuel, Délai client, Relance) were exported as
French **text** strings (`"24/06/2026"`), so Excel sorted them lexically (by day-of-month) instead of
chronologically. New `dateVal()` helper parses the HFSQL `YYYYMMDD` string into a real JS `Date` (local
midnight; empty/invalid → `null` for a blank cell). Export columns gained a `kind?: 'date'` flag; the date
columns now emit `Date` values and `handleExport` builds the sheet with `aoa_to_sheet(aoa, { cellDates: true })`
so SheetJS writes true date cells (`t:'d'`). Each date cell then gets `z = 'dd/mm/yyyy'` so it still *displays*
in French format while the underlying serial makes the column sortable/filterable in Excel. Quantity/day
columns were already real numbers and unaffected.

## 2026-06-24 — feat/gestion-client
Clients › Gestion (`apps/web/src/pages/ClientsGestion.tsx` + `apps/api/src/routes/clients.ts`, wired in
`router.tsx` replacing the placeholder and `index.ts` under `/api/clients`) — the legacy "Gestion Client"
screen. Master-detail over the `client` table (32 cols) with an **Info / Contacts / Adresses** identity
side and commercial sub-views **Références (catalogue) / Historique (commandes) / Marchandise (expéditions)
/ Tarif (PrixDeVente)**. Contacts/adresses are the shared polymorphic tables keyed on `IDclient`. **HFSQL
rules baked in**: `SELECT * FROM client` returns 0 rows on the Windows ODBC driver, so Windows names an
explicit non-accented column list and reads the archive flag via a separate `WHERE archivé = 1` query
(WHERE tolerates the accent); Linux uses `SELECT *` and reads the truncated key (`archiv`/`bloqu`) off the
row. We NEVER name `archivé`/`bloqué` in a SELECT list. Accented text VALUES (client names like "Amalthée",
"37 Degrés") are written as Latin-1 hex literals via `sqlText()`. INSERT sets `IDsociete = 1` (ETM);
`archivé`/`bloqué` left to HFSQL defaults. Reused the proven client-read pattern from `etudes-coloris.ts` /
`commandes-client.ts` and mirrored `fournisseurs.ts` for CRUD + contacts/adresses. The expedition /
designation_client / ref_client_colori columns were reconstructed from the legacy schema. (Memory:
`project_clients_gestion_screen.md`.)

## 2026-06-24 — feat/suivilot (graphique d'évolution + freinte)
Qualité › Suivi des lots — freinte corrections, end-customer in the récap, and a new
"Graphique" trend modal. **(1) Freinte fixes**: the main-area spec-banner *Freinte* showed
`freinte_demandee` raw (`0,12 %`) — it's a stored fraction like `ref_fini.freinte`, now ×100
(→ 12 %). The computed `freinte_sst` (`1 − (poids_sst·laize_sst/100000)·moyenne_rdt`) was
**removed from the Sous-Traitant Contrôles panel** — it's only an internal-consistency check
between three measurements of the same fabric (≈0 when measured correctly, ambiguous otherwise),
not a real yield loss; the API still computes/returns it (unused by the UI — do not re-add). **(2)
Récap**: *Récapitulatif de la commande* now shows **Client final** (end customer) when the sst
order links to a `commande_client` → `client` (data already plumbed; no backend change). **(3)
Graphique modal**: a `LineChart` icon button left of Modifier (view mode, visible to all — read-only,
not gated on `responsable_qualite`) opens a self-contained SVG line chart (no charting dependency).
New endpoint `GET /suivi-lots/:id/serie?sst=<id>` (suivi-lots.ts) scoped to **same `IDref_fini`** +
a **selectable sous-traitant** (`?sst`, defaults to the lot's own); `SELECT TOP 200 * FROM suivilot
… ORDER BY DATE DESC` reversed to oldest→newest, SELECT * + prefix-regex extraction (never names
accented `*_demandée` cols). **Granularity differs by parameter**: *Rendement* is plotted **per roll**
(each `stock_fini` rdt = metrage/poids, with the lot's target as a reference line), *Laize / Poids /
Stab H / Stab L* **per lot** (SST + Tirelle + Demandé). Response returns `points[]` (per-lot),
`rolls[]` (per-roll, capped 200), and `sous_traitants[]` (every sst that worked on the réf, for the
selector — shown only when >1). Chart UI: param tabs × series toggles × window (50/100/200 = rolls
for rendement, lots otherwise); `0 = non mesuré` omitted; current lot's point(s) cerclé(s) en or when
viewing its own sst. `keepPreviousData` avoids flicker on sst switch. See memory
`project_suivilot_graph_freinte`.

## 2026-06-24 — feat/suivilot
Qualité › Suivi des lots — workflow reform + Contrôles UX, plus a cross-screen cache fix.
**(1) Header cleanup**: removed the non-functional print + email (@) buttons (and their placeholder
dialog) from the lot detail header. **(2) Tolerance gauges**: each Contrôles measurement (Laize, Poids,
Stab H/L, in both Sous-Traitant and Tirelle cards) now renders a tolerance gauge under the value — a
green min→max band with a colored needle at the measured value (green in-band, red out, hidden when not
yet measured), with min/max labels under the band edges; **stab** is a 0-centered ±band (the ref_fini
figure `-5` means ±5 %, mostly shrink) labelled `-5 · 0 · +5`. An unmeasured value renders blank (no "0").
The Rendement row was dropped from both cards. **(3) Quality workflow reform** (see
`project_quality_workflow_reform`): replaces the legacy two-role model with a single `responsable_qualite`
permission (new catalog entry, category "Qualité", per-user in Paramètres › Utilisateurs; effective admin
bypasses). Non-holders get the screen **read-only** (no Modifier, no status change). Backend gates
`PUT /suivi-lots/:id` + `POST /suivi-lots/:id/etat` via `userHasPermission`. The footer is now a **two-verdict**
control — **Valider** (→3) / **Reprendre** (→2) only; `POST /etat` rejects any état ≠ {2,3}; **Reprendre** also
flags the lot's `stock_fini` rolls to `IDetat_stock_fini = 2` so they queue in the Sous-traitants reprise
flow (2→1 happens via the existing re-réception sync). Sending a soumission on Sous-traitants › Commandes
now **auto-sets** the matching `suivilot` to état **5**. État 5 renamed "Attente décision" → **"Attente Client"**
(UI-only — HFSQL `etat_stock_fini` label untouched for legacy), recolored violet, icon changed from HelpCircle
to **User** (person). **(4) Cross-screen cache sync** (see `project_react_query_stale_cross_screen`): new
`apps/web/src/lib/cache-sync.ts` → `invalidateLotQualityCaches(qc)` invalidates both the Qualité and
Sous-traitants query families; wired into `QualiteSuiviLots` `etatMut` and `SousTraitantsCommandes`
`invalidateAll` + soumission-email success, so a change on either screen refreshes the other (the global
5-min React Query `staleTime` previously served stale cache until a hard reload).

## 2026-06-24 — feat/facturation
Clients › Facturation (`apps/web/src/pages/ClientsFacturation.tsx` + `apps/api/src/routes/factures.ts` +
`apps/api/src/lib/pdf/FacturePdf.tsx`, registered `/api/factures`, route wired in `router.tsx`) — the manual
client-invoicing screen (legacy "Détail facture" / "Nouvelle facture"), mirroring Clients/Commandes
(MasterDetailLayout, header Print/Email/Modifier trio, unsaved guard, auto-edit-after-create, SendEmailDialog,
ConfirmDialog) **minus** stock affectation and the status footer (a facture has no lifecycle/paid flag).
Browse/search/filter (Tous / Factures / Avoirs), view + create + edit + delete over `facture`/`ligne_facture`
(ETM scope `IDsociete=1`), free-text line editor (`designation` / `quantite` / free-text `unite` / `prix`),
and computed **HT / TVA / TTC** — no stored totals: HT = Σ(qty×prix), TVA = HT × `tva.valeur`, TTC = HT+TVA.
**`type` 1=Facture / 2=Avoir** as a category chip; an Avoir reads negative in the list + footer (ledger sign),
positive in the grid. `facture` has **no accented columns** (SELECT * safe) but `date`/`type` are reserved
words → written uppercase `DATE`/`TYPE` (same trick as `envoi_email.DATE`). `numero = MAX+1 WHERE IDsociete=1`
with a retry loop. **Create auto-fills billing defaults from the client row** (`num_tva`, `IDtva`,
`IDmode_paiement`, `IDecheance`, `IDcode_comptable` + the `est_defaut_facturation` adresse). PDF (Facture/Avoir,
Malterre frame) + Gmail send (`contact.envoi_facture`, type_doc 19, type-aware subject) + envoi historique.
Sidebar tabs: Info (client, type toggle, date, mode, échéance, TVA select, N° TVA, billing-address picker) +
Historique. **Deferred (Phase 2 — blocked on the not-yet-built Transport/Expéditions module):** legacy
"Génération automatique" + "Factures provisoires" (`facture_prov`, empty in prod) which build invoices from
un-invoiced `expedition` rows, plus the "Factures → Compta" export. No Docs tab (legacy facture detail has
none; `ged` has no IDfacture FK). Verified end-to-end on local HFSQL (list / detail / create-autofill / lines
CRUD / PDF / email-defaults / historique / delete + reserved DATE/TYPE + accent round-trip); web tsc + vite
build clean.

## 2026-06-24 — feat/devis
Clients › Devis (`apps/web/src/pages/ClientsDevis.tsx` + `apps/api/src/routes/devis.ts` + `apps/api/src/lib/pdf/DevisEtmPdf.tsx`, registered at `/api/devis`, route `/clients/devis`) — the ETM client quotations screen (`devis_etm`/`ligne_devis_etm`), ported from the legacy `FI_Devis_ETM`. Mirrors Clients › Commandes (master-detail, Info/Adresses/Docs/Historique tabs, En cours/Soldé footer pill, PDF, Gmail send, ged documents, unsaved-guard) but a devis never reserves stock, so there is **no affectation drawer**. Key model facts (verified against live HFSQL): scope is **`IDprospect = 0`** (client devis; `devis_etm` has **no `IDsociete`**); `numero` = global `MAX(numero)+1`; **`date` is a reserved column** (reads back as `DATE`, written bare) plus a real **`date_expiration`** (drives list urgency); **`remise` is a fraction** (0.05 = 5%), shown/edited as a % and applied as `Σ(qty×prix)×(1−remise)+frais_port`; lines are type 2=fini / 3=divers (with `IDref_ecru` resolved from the fini ref and stored so the legacy app still reads them); never name accented `archivé`/`delai_annoncé`/`déverrouiller`. **Pricing**: a `GET /devis/pricing/suggest` endpoint reuses the ported `PrixDeVenteV4` (`calcTarifRefFini`) to auto-fill an empty line price (editable hint, finished refs only); the client-contract `contrat_tarif`/`tranche_tarifaire` layer is deferred. **Passer en commande**: `POST /devis/:id/convert` creates a `commande_client` + lines, marks the devis soldé, and back-links `devis_etm.IDcommande_ETM` (re-convert blocked). Documents/historique/email key on **`type_doc = 28`** ("devis"); ged docs discriminate on `IDreference=devisId AND IDtype_doc=28` (collision-free, no devis FK on `ged`); email "selected" bucket = `contact.envoi_soumission`. Deferred: read-only "Stock disponible" panel and the full contract-pricing layer. Verified end-to-end (list matches the legacy 7 open devis exactly, N°178 total 803.04 € identical, full create→line→convert→delete round-trip cleaned up). New file `apps/web/src/pages/ClientsDevis.tsx`; replaced the `ClientsDevisPage` placeholder in `router.tsx`.
## 2026-06-24 — feat/rapport
Rapports › Commandes sst (`apps/web/src/pages/RapportCommandesSst.tsx` + `apps/api/src/routes/rapports.ts`) —
added a **Journal** column and corrected the **Commentaire** column source. **(1) Journal column**: surfaces
the commande sst header `journal` field (`commande_sous_traitant.journal`, plain text since the 2026-05-26 RTF
migration; still `stripRtf()`'d defensively). Added to the report row payload (`journal: hdr?.journal || ''`),
the sortable table (new `journal` SortKey + 220px column), the Excel export column catalog (so it appears as a
toggle in the "Colonnes à exporter" picker), and the search haystack/placeholder. **(2) Commentaire column
fix**: repointed it from the per-line `ligne_commande_sous_traitant.commentaire` (with header fallback) to the
commande sst **header** `commentaire` only. Legacy stored unrelated notes on the line comment (e.g. the literal
word "journal"), so a line comment was shadowing the order's real header note; the column now consistently
shows the commande-level commentaire. Both note columns are now header-level (commande sst), matching the
report's per-commande mental model. Note: the export defaults to all-columns only for first-time users — anyone
with a previously-saved selection ticks **Journal** once in the picker to include it.

## 2026-06-24 — feat/cmd-client
Clients › Commandes — line-item creation, pricing, and supply-chain visibility on the existing screen
(`apps/web/src/pages/ClientsCommandes.tsx` + `apps/api/src/routes/commandes-client.ts`, new
`apps/api/src/lib/pricing-ligne-client.ts`). **(1) Nouvelle commande modal**: address pickers now render the
full address (street · CP ville · pays) under each name via `PopoverSelect`'s `description` (canonical
`adresseOption` mapper, designer §11bis); selecting a client **prefills** Mode paiement + Échéance from the
client sheet (`client.IDmode_paiement`/`IDecheance`, now returned by `/lookups/clients`) and the billing/
delivery addresses from their `est_defaut_*` flags. **(2) Clients lookup scoping**: `/lookups/clients` now
filters `IDsociete = 1` (was leaking 27 TRM + 4 Confection clients into the ETM picker). **(3) "Note interne"
→ "Journal"** UI label rename (field `commentaire_interne` unchanged). **(4) Nouvelle ligne modal**: fixed the
Unité dropdown overflowing the Prix input (dropped `size="sm"` → fills its grid cell); `unite=4` label "U" →
"unité" (frontend + `uniteLabel`). **(5) Buyable-ref filter**: the line Référence dropdown is restricted to
the refs assigned to the client in `designation_client` (`/lookups/refs-ecru|refs-fini?client=`, `assignedRefIds`
prunes `archivé`/`caché` in JS via `pickKey` — never named in SQL). **(6) Auto-pricing + roll note** (PrixDeVenteV4
port, `calcLignePriceClient` + `/lookups/line-price`): typing a quantity on an écru/fini line auto-fills the unit
price (€/Ml or €/Kg) for the roll-count tariff tranche, with a padlock to override (session-only). A roll-count
note shows green when the quantity is a whole-roll multiple, amber `>` when it overshoots (roll size =
`poids × round2(rendement)`). A **commercial nudge** appears when the quantity is within 15% of the next cheaper
tranche ("Plus que X Ml pour atteindre N rouleaux → Y €/Ml (−Z%)"). Fini path validated EXACT vs legacy
(040A/beige2585 10 rolls → 10,43 €); écru path derived (fil + tricotage ÷ margin ÷ port), unvalidated. Used
`keepPreviousData` to stop the note collapsing/reflowing on each keystroke, gated on current form inputs so it
clears on a fresh dialog. **(7) Coloris-aware affectation**: the line affectation drawer's "stock disponible"
and the link endpoints now filter/guard by the line's coloris (`stock_fini.IDColoris` / `stock_ecru.IDcolori_ecru`
= line `IDcolori`), so e.g. a beige line no longer offers gris rolls. **(8) Supply tabs**: the affectation drawer
became tabbed (designer §31.4) — Affectation + **Ennoblissement** (fini lines) + **Tricotage** (écru/fini),
showing in-progress sous-traitant orders feeding the line via new `GET /:id/lignes/:ligneId/supply`. Ennoblissement
disponible/affecté (ml) = input écru (`stock_ecru.IDref_commande_affectation`) split by client-affectation × raw
fini rendement (validated EXACT: 240,60 kg × 3,548387 = 853,74 ml); Tricotage affecté/disponible (kg) = output écru
committed to clients / `quantité − affecté` (validated 6388/4000 kg), métrage potentiel = dispo × rendement.
`invalidateAll` now also refreshes the `commande-client-pieces` and `commande-client-supply` caches after line/
affectation edits. The legacy right-side stock panels (écru-by-location, fil-by-tricoteur) were not built.

## 2026-06-23 — feat/suivilot
Qualité › Suivi des lots — enhancements to the existing screen (`apps/web/src/pages/QualiteSuiviLots.tsx`
+ `apps/api/src/routes/suivi-lots.ts`). **(1) RTF commentaire**: the commande's `commentaire` (RTF in
`commande_sous_traitant`) is now run through `stripRtf()` so the Récap shows plain text, not raw `{\rtf…}`.
**(2) Pièces conformity**: each received roll (`stock_fini`) gets a rendement-validity flag via the legacy
`gxRendementMini`/`gxRendementMaxi` model — bounds computed from `ref_fini.poids_Min/Max · laizeHT_Min/Max ·
freinte · rendement` and `suivilot.rendement_demande`; a new **Conforme** column (far-left was moved to a
dedicated far-right **Qualité** column) shows green check / red triangle, and the header shows the valid Rdt
range. **(3) Per-roll quality history**: a new far-right **Qualité** column shows a comment/defect icon
(MessageSquare, or amber AlertTriangle when a defect exists) with a hover tooltip aggregating each roll's
quality stages — Tricotage (source `stock_ecru.observations` + `visiteur`), Défaut tricotage
(`defaut_qualite` Type_Reference=2 keyed on écru + Type_Reference=1 keyed on the écru's `piece_production`),
Ennoblisseur (`stock_fini.observation_sst`), Contrôle fini (`stock_fini.observations`); all accent-repaired,
NUL-padding stripped via `cleanText`. **(4) Contrôle conformity markers**: Laize / Poids / Stab H / Stab L
in both Sous-Traitant and Tirelle cards are flagged conforme/non-conforme live (view + edit) against
`ref_fini` bounds shipped as `ref_bounds` — laize `min≤val≤max`, poids `min≤val≤max`, stab `val ≥
stab_hauteur/largeur`; suppressed when no ref or value not measured. **(5) Freinte SST computed**: the
Sous-Traitant Freinte is now the legacy computed value `1 − (poids_sst·laize_sst/100000)·moyenneRdt`
(was wrongly showing `freinte_demandee`), displayed as a rounded percentage. **(6) En cours / Terminé
filter fix**: the left-list status filter now keys off lot état (`IDetatLot = 3` "Validé" = Terminé),
matching legacy (34 en cours / ~5114 terminé) — it previously keyed off `fin_archivage`, which is actually
the sample-disposal date, not a status. **(7) Archive concept removed**: dropped the bogus "archived"
status (card marker, header badge + toggle button, `POST /:id/archive`, `isArchived`) since `fin_archivage`
is just the disposal date — it remains as the editable "Fin d'archivage" field in the Observations card.
Also fixed a `fixEncoding` aliasing bug (the list selected `st.nom AS sous_traitant_nom` then repaired the
non-existent aliased column, so `Société` rendered mangled — now selects real `nom` and renames in JS), and
gave état 5 "Attente décision" a distinct violet hue so it no longer reads like the gray archived icon.

## 2026-06-23 — feat/ref-tm
Tombé Métier › Références (`apps/web/src/pages/TombeMetierReferences.tsx` + `apps/api/src/routes/references-ecru.ts`) refinements + a new **Coût de tricotage** breakdown. **Jauge/Diamètre** are stored as 1-based ordinals indexing legacy combos (`gtaJauge`: 2→14, 3→18, 4→20, 5→28, no unit — needles/inch; `gtaDiametreMachine`: 2→26", 3→30") — both now display the real value and edit via dropdowns (the raw ordinal is never shown; ordinal 1/`-1`/0 = unset). **Search** is multi-criteria (space-separated AND across reference, désignation, contexture, jauge, diamètre — list endpoint now returns `Jauge`/`diametre`); the footer count tracks the filtered list. Identification header subtitle falls back to contexture when no désignation; Composition/Coloris cards collapse by default per selection. **"+ Nouveau"** auto-generates the next free 3-digit zero-padded reference server-side; duplicate references are rejected on rename (409); fixed the create-selection race (new card stays selected + scrolls into view) and stale-detail-after-delete. **Safeguards**: composition must total 100 % to leave edit mode (empty allowed); the composition AND five fabric-defining header fields (contexture, jauge, diamètre, bio, recyclé) are **frozen** once rolls (`stock_ecru`) or tricoteur orders (`ligne_commande_sous_traitant` type 0/1) exist — UI locks + backend 409/silent-keep; a coloris can't be deleted while affected to a roll, order, or its own composition (per-coloris in-use flags drive a greyed lock affordance + 409 guard). Statistiques gained "Rouleaux créés" + "Poids total" (Σ `stock_ecru.poids`); "Réglages par métier" "+" now opens a modal (`MachineFormDialog`); "Tombé du métier" is a Rouleaux/Plis dropdown. **Coût de tricotage**: refactored `apps/api/src/lib/pricing-trm.ts` to expose `prixDeRevientTRMDetail()` (full per-component breakdown — Frais de structure / Frais de production / Main d'œuvre — with `prixDeRevientTRM`/`trmLinePrix` as thin wrappers, line pricing byte-identical, regression `test-prix-revient-trm.ts` still 9/10); new `GET /api/references-ecru/:id/cout-tricotage?qty=` (default 1000) + a sidebar card and read-only modal with an editable debounced quantity, the three sections, subtotals, and the totals chain (coût → prix de vente ×1/0.7 → prix plancher → prix retenu).
## 2026-06-23 — feat/ref-fini
Finis › Références — added a **Tarif** tab to the detail sidebar plus three small left-list/label
refinements. **Tarif tab** ports the legacy `FI_Tarifs` / WLanguage `PrixDeVenteV4` cost-price
algorithm (the `nType_Ref=2` finished-ref path). New `apps/api/src/lib/pricing-fini-tarif.ts` →
`calcTarifRefFini(IDref_fini, IDcoloris)`, exposed via `GET /api/references-fini/:id/tarif?coloris=<id>`
(added to `references-fini.ts`; defaults to the ref's first coloris when omitted; returns
`tranches: []` rather than erroring when rendement=0 / no coloris / no écru). For a ref+coloris it
builds 9 order-quantity tranches (`<1,1,2,3,4,5,10,15,30` rolls; `PoidsRef = ref_ecru.poids*rollMult+1`)
each with the full breakdown: **fil** (`Σ pourcentage×yarn €/Kg`, preferring `colori_fil.prix_kg`),
**tricotage** (`ref_ecru.prix`, −5%/−10% at 15/30 rolls), **traitement** (per `traitement_ref_fini`,
band price ×1.05 packaging, ×`multiplicateurMatel` for IDtraitement∈{298,285,302}), **teinture**
(dye band ×MATEL mult ×1.05 +GOTS, only `avec_teinture≠0`) → **revient** → vente Kg/Ml via
`venteKg = round(revient/(1-CoefficientV2[i])/(1-tauxPort),2)` (port 5%, 3% at 30 rolls;
`CoefficientV2=[0.60,0.50,0.45,0.40,0.35,0.30,0.27,0.22,0.17]`). All ennoblissement prices read
`tranche_tarif_ennoblissement` rows with **`IDsous_traitant=0`** (the company's own copied-from-MATEL
tariff — no supplier picker); reuses `multiplicateurMatel`/`MATEL_BANDS` from `pricing-sst.ts`. The
legacy `.wdw` is a compressed binary (not extractable); the algorithm came from the WLanguage source
the user supplied, with the output shape confirmed by the Android transpile (`STPrixDétaillé`). UI
(`FinisReferences.tsx`): the single-button sidebar header became a 2-tab bar (Informations | **Tarif**,
`BadgeEuro`); the Tarif tab has a coloris `SearchableCombobox`, a clickable volume-tier grid
(Qté Rlx / Qté Ml / Prix/Ml) and a gold-banded cost breakdown for the selected tranche, all read-only.
Bridge-safe throughout: flat queries + JS merge (no JOIN+CONVERT), `fixEncoding` for label text,
integer-only filters, idField always selected (no `WHERE col=NaN` storm). **Also in this branch**:
left-list search is now multi-criteria (space-separated terms AND-matched across reference+designation);
the footer count reflects the filtered list; and the teinture indicator distinguishes **Simple teinture**
(`avec_teinture=1`, one droplet) vs **Double teinture** (`=2`, two droplets) vs Écru/lavage. Full algo
+ reuse notes in memory `project_prixdevente_v4`.

## 2026-06-23 — feat/cmd-client
Clients › Commandes — new master-detail screen (`apps/web/src/pages/ClientsCommandes.tsx` +
`apps/api/src/routes/commandes-client.ts` mounted at `/api/commandes-client` + PDF
`apps/api/src/lib/pdf/CommandeClientPdf.tsx`; the `router.tsx` placeholder was replaced). First
real Clients screen. Mirrors `FilsCommandes` (§28 unsaved guard, §29 binary status footer, §30
deadline urgency, §31 in-screen drawer, §32 email, §34 ged docs) and the sous-traitant commande
flow. **Data/semantics**: `commande_client` / `ligne_commande_client`. ETM scope on every
read/write = `IDsociete=1 AND IDcommande_ETM=0` (IDsociete=2 rows are TRM mirrors owned by the
sister company — this route is NOT the TRM-mirror writer, so none of that machinery is carried).
numero allocator = `MAX(numero)+1 WHERE IDsociete=1` with retry. **Centerpiece = stock
affectation**: each line reserves rolls via `stock_ecru.IDligne_commande_client` /
`stock_fini.IDligne_commande_client` (distinct from the sst `IDref_commande_affectation`); the
in-screen drawer shows "Stock affecté" ↔ "Stock disponible" with a unit-aware progress gauge.
**Line polymorphism** (`ligne_commande_client.TYPE`, reserved word → `TYPE AS type_kind`, write
uppercase; `IDcolori` is lowercase not IDColoris): 1=écru (`ref_ecru`+`colori_ecru`), 2=fini
(`ref_fini`+coloris by `avec_teinture`), 3=divers (`ref_divers.designation`, display-only, no
affectation). **`unite` enum** (hardcoded, verified empirically): 1=Kg→sum roll `poids`, 3=Ml→sum
roll `metrage`, 4=U, 5=m² — écru rolls carry `metrage=0` so écru (unite=1) gauges on poids.
Available fini = `IDref_fini` match, not reserved, not on a shipment (`IDligne_expedition` 0/NULL),
`IDetat_stock_fini<>4` (Expédié); available écru = `IDref_ecru`, `IDsociete=1`, not shipped
(`IDligne_expedition_ETM` 0/NULL), not reserved, not at a dyer (`IDref_commande_affectation` 0/NULL),
not consumed into a stock_fini. **Real bon-de-commande PDF + Gmail email** (§32, `type_doc 7`
"commande client" for the envoi_email log + ged discriminator `IDcommande_client=id AND
IDcommande_sous_traitant=0`); TVA from the `IDsociete=1` default `tva` row (≈20%). Manual pricing
(montant = quantite×prix; no auto-pricing — devis/facture cost-price lives elsewhere). Computed list
phase = a_affecter / partielle / terminee. **HFSQL footguns honoured**: `SELECT * FROM client`
returns 0 rows → explicit columns only, and clients are filtered by `est_visible=1` only (NOT
IDsociete); accented cols never named (`archivé`/`expedié`/`envoyé_client`, line
`delai_annoncé`/`déverrouiller`); accent-safe writes via `sqlText()` (Latin-1 hex); `echeance` /
`mode_paiement` label col = `libelle`; flat-query resolution (no CONVERT-in-JOIN); batched
`fixEncoding`. Verified end-to-end on local HFSQL (list/detail/CRUD/affectation link-unlink/PDF/
email-defaults/historique).

## 2026-06-23 — feat/stock-ecru
Tombé Métier › Stock — new table-centric screen (`apps/web/src/pages/TombeMetierStock.tsx` +
`apps/api/src/routes/stock-ecru.ts`, mounted at `/api/stock`; the `router.tsx` placeholder was
replaced). Mirrors finis/stock: split sortable table, single fuzzy search, status filter,
multi-select edit mode, right slide-in drawer edit, batch edit ("Édition groupée"), cut-roll, and
Nouveau create. **Data/semantics**: `stock_ecru` (écru/tombé-de-métier fabric rolls). The "in
stock" base population every view operates on = `IDsociete=1` (ETM only — TRM rolls belong to the
sister company) AND `IDligne_expedition_ETM=0` (not shipped out) AND no `stock_fini` child (not yet
dyed/consumed into a finished roll) — this bounds ~52k historical rows to the ~1.5k live working
set, without which "Tous" would time out hydrating. Status filter = Disponible
(`IDref_commande_affectation=0`) / En teinture (`>0`) / Tous, plus a 2ᵉ-choix toggle.
(`IDligne_expedition_TRM` records TRM→ETM provenance, NOT a stock signal — don't filter on it.)
**Columns**: Référence (ref_ecru), Coloris (colori_ecru), Numéro, Poids (kg), Lot, Magasin
(sous_traitant via IDmagasin), N° Cmd + Client (IDligne_commande_client → ligne_commande_client →
commande_client → client, resolved as flat queries merged in JS), Date saisie, 2ᵉ choix, Visiteur
(free-text column, not an FK), Observations, Défauts (defaut_qualite Type_Reference=2). Provenance
drawer card reuses finis's resolvers — `resolveSstLine`/`resolveProvenanceFils` are now **exported**
from `stock-fini.ts` — via `GET /api/stock/ecru/:id/provenance` → Fils (ref_fil · fournisseur ·
Commande N°) + Tricotage (knitter · Commande N°); no ennoblissement row (dyeing is the écru's
destination, not its origin). **Permissions** (`permission-keys.ts`, category Tombé Métier):
`create_stock_ecru` (Nouveau), `cut_stock_ecru` (Couper), and `edit_stock_ecru` "Édition rouleau(x)"
— the edit permission gates the drawer "Modifier" AND the "Édition groupée" batch button, plus the
backend `PATCH /ecru/:id` and `PATCH /ecru/batch` (401/403, effective admins bypass); the top-right
edit-mode "Modifier" shows only when the user can edit OR cut. HFSQL footguns honoured throughout:
accent-safe reads (batched `repairAliased`/`fixEncoding`), writes via `sqlText()` (Latin-1 hex), no
CONVERT-in-JOIN, integer-only `IN` lists, empty text → `''` not NULL, and every named column
verified to exist (no bridge-storm risk).

## 2026-06-23 — feat/rapport
Rapports › Commandes sous-traitants — added a column-picker dialog to the Excel export on the
table-centric `apps/web/src/pages/RapportCommandesSst.tsx` report (no API change). Clicking
"Exporter Excel" now opens a modal (`mps_designer §18.A` basic-form Dialog: gold `Columns3`
title icon, "Colonnes à exporter") instead of exporting immediately. The 18 export columns were
extracted into a single `EXPORT_COLUMNS` catalog (stable `key`, label, value getter, Excel
`wch` width); the export builds headers/rows/widths from whichever columns are selected, always
in canonical order regardless of click order. The modal lists each column as a plain checkbox
(multi-select, per `§35.4`) with a live count and "Tout sélectionner / Tout désélectionner"
shortcuts, plus Annuler + a primary Exporter button (spinner while writing, disabled when no
column is selected). The selection is persisted to `localStorage`
(`mps:rapport-sst:export-columns`) on a successful export and restored on load — since user
identity is station-based, per-browser localStorage is effectively per-user. The loader is
defensive: drops unknown keys, preserves canonical order, and falls back to "all columns" on
missing/corrupt data or privacy-mode errors. Export still operates on the currently visible
(search-filtered + sorted) rows; quantity FP-noise rounding (`qty1`) was hoisted to module scope
and reused.

## 2026-06-23 — feat/stock-fini
Finis › Stock — enrichment pass on the existing table-centric stock_fini screen
(`apps/web/src/pages/FinisStock.tsx` + `apps/api/src/routes/stock-fini.ts`). Five changes:
(1) **New `edit_stock_fini` permission** — appended to `permission-keys.ts` (category Finis),
gates the `PATCH /api/stock/fini/:id` route (401/403 like `create_stock_fini`) and hides the
detail-drawer "Modifier" button via `useHasPermission`; effective admins bypass. (2) **État is
now read-only** in the detail drawer — the Statut `<select>` was removed (always renders the
read-only pill); dropped the now-dead `editEtat` state, the `etats` lookup in the drawer, and
`IDetat_stock_fini` from the PATCH payload + dirty-check (table-level "Édition groupée" batch
still edits emplacement/observations, unaffected). (3) **Drawer header + provenance rework** —
the bold title is now the roll number (`numero`, e.g. 3465/99); ref/coloris/lot moved to the
subtitle. New read-only endpoint `GET /api/stock/fini/:id/provenance` traces the origin chain:
stock_fini.IDstock_ecru → stock_ecru.IDref_commande_source (tricoteur sst line) → its
`asso_fil_lignecmdsst` yarn lots → stock_fil → ref_fil (designation) + fournisseur + commande_fil
(order N°); stock_fini.IDref_commande_source = the dyeing (ennoblisseur) sst line. The Provenance
card lists each fil (designation · supplier · Commande N°), the Tricotage origin (knitter ·
Commande N°), and the Ennoblissement origin (dyer · Commande N°, hidden when same commande as
tricotage). Removed the "Rouleau écru source" field; renamed "Date saisie" → "Date réception";
replaced `#` id prefixes with `N°`. (4) **Legacy columns restored on the table** — added
Contexture (ref_fini → ref_ecru → contexture.nom), Grammage (ref_fini.poids_Moy, g/m²), Client
(IDligne_commande_client → commande_client → client.nom) and N° Cmd (commande_client.numero) via a
new batched `enrichListExtras()` helper; columns reordered to mirror the legacy WinDev grid (kept
the app's État column + existing totals footer). Contexture/Client also searchable. (5) **Denser
table** — body text `text-sm`→`text-xs`, cell padding `px-3 py-2`→`px-2 py-1.5`, headers
normal-case (no uppercase/tracking) that wrap at spaces (not mid-word), "N° Cmd" abbreviated to
stay one line. HFSQL footguns honoured throughout: `STOCK_FINI_SELECT`/`JOINS` left untouched
(shared with detail+label endpoints) — all new joins done as batched flat queries + JS merge with
integer-only `IN` lists (no CONVERT-in-JOIN collapse, no bridge-storm risk); accented name columns
(sous_traitant/fournisseur/contexture/client `.nom`, ref_fil.reference) read raw + repaired via
`fixEncoding`, never named in a WHERE.

## 2026-06-23 — feat/rapport (refinements)
Polish pass on Rapports › Commandes sous-traitants (`/rapports/commandes-sst`, screen base
landed earlier same day). Changes: (1) removed the page-title `<h1>` — table-centric screens
take no screen-name heading (identity comes from the nav/submenu tab); codified this in
`mps_designer` §27.1 + §27.7 checklist so it isn't re-added. (2) Dropped the "Actualiser"
button; the report query now uses `staleTime: 0` so it refetches on every mount (each consult)
with `refetchOnWindowFocus: false` to spare the shared HFSQL bridge. (3) Shrank the table body
to `text-[13px]` with tighter cell padding (`px-2.5 py-2`) to fit more rows on screen. (4) Added
an "Exporter Excel" button (top-right of the toolbar) that builds the `.xlsx` client-side via a
lazy `await import('xlsx')` (keeps SheetJS out of the main bundle), exporting the currently
visible (search-filtered + sorted, soldées-toggle-aware) rows across all 18 columns; quantities
rounded to 1 decimal but kept numeric so Excel can sum them. Frontend-only — no API changes.

## 2026-06-23 — feat/suivilot
Qualité › Suivi Lots — new quality-control lot-tracking screen (first real Qualité screen;
the menu's other 3 submenus — Dossiers, Actions, Analyse — remain placeholders). Also adds the
4 Qualité submenus to the sidebar + router (`/qualite/suivi-lots` real, the rest placeholders).
Master-detail screen over the `suivilot` table (one row per (ligne_commande_sous_traitant, lot),
created on reception by `upsertSuivilot()` in commandes-sous-traitant.ts): left list with search +
En cours / Terminé / Tous filter (Terminé = archived via `fin_archivage`); center "Récapitulatif
de la commande" (date commande, N°, référence, coloris via the `avec_teinture` wash/dye rule,
spec banner Laize/Poids/Freinte/Rendement/Stab) + read-only "Pièces du lot" sub-table sourced from
`stock_fini` with per-roll Rdt = metrage/poids and a Moyenne footer; right sidebar tabs Contrôles
(editable SST + Tirelle measurements, observations, emplacement, fin d'archivage) / Documents
(read-only, reuses the commande-sst `ged` endpoints) / Défauts (read-only, `defaut_qualite`
aggregated over the lot's source écrus) / Client. A multi-state état footer pill (En contrôle /
En reprise / Validé / Expédié / Attente, persisted immediately) and a header archive/lock button.
Full Modifier→Enregistrer edit flow wired into the shared unsaved-changes guard. New API route
`apps/api/src/routes/suivi-lots.ts` (`/api/suivi-lots`: list, detail, PUT controls, POST etat,
POST archive, GET defauts). HFSQL footguns honoured: editable columns are all ASCII so writes are
Linux-bridge-safe; the only accented write (`approuvé_qualité`) is gated on `IS_WINDOWS` with
`IDetatLot` carrying validation state on the bridge; accented spec columns read via `SELECT *` +
pickKey; magasin resolved without `alias.*`. Permissions deferred to a later session. Known
flagged-but-deferred: SST "Freinte" shows `freinte_demandée` (no `freinte_sst` column exists); the
legacy Tricotage/Ennoblissement/Visiteur bottom block was not ported (no backing `suivilot`
columns — low-confidence mapping left for follow-up).

## 2026-06-23 — feat/rapport
Rapports › Commandes sous-traitants — new read-only report screen at
`/rapports/commandes-sst`, porting the legacy `FEN_Rapport_commandes_sous_traitants.wdw`
(which is non-decompilable — WinDev stores WLanguage in a proprietary encrypted blob, so the
screen was reconstructed from the production screenshot + the already-migrated MPS_NG
sous-traitant domain model). Also adds the three Rapports submenus (Commandes clients,
Commandes sst, Commandes fils) to the nav + router; clients/fils are placeholders for now.
The screen is a flat, table-centric grid (FilsStock pattern, no master-detail/drawer): one
row per `ligne_commande_sous_traitant`, with Statut, Numéro, Sous-traitant, Référence,
Coloris, Qté commandée/affectée/réceptionnée, Date commande, Délai initial/actuel/client,
Retard, Marge, Client, Relance, Commentaire. Sortable sticky-header columns (17, horizontal
scroll), French search across statut/n°/sous-traitant/réf/coloris/client/commentaire, a "Voir
les commandes soldées" toggle, an "Actualiser" button, and a totalizer (line count + late/
soon counts). Statut renders as polished MPS_NG pills (`LINE_STATUT_META`, friendly labels +
solid colors) from the per-line `sstatut`; rows tint red (late) / amber (soon) per MPS_NG
urgency language (attente_delai anchors on `date_notif`, else on `date_livraison`). Key
column derivations (verified against local HFSQL): **Marge = Délai Client − Délai Actuel in
DAYS** (not €); Délai Actuel = `lcs.date_livraison`, Délai Initial = frozen `lcs.date_delai`;
**Délai Client = `ligne_commande_client.date_livraison`** reached via
`stock_fini.IDref_commande_source` / `stock_ecru.IDref_commande_affectation` →
`IDligne_commande_client` → `commande_client` → `client.nom` (earliest valid lcc per line);
the bell column = `commande_sous_traitant.date_notif` (relance); Qté affectée sums
`stock_ecru.metrage` (ennoblisseur, Ml) or `poids` (tricoteur, Kg), Qté réceptionnée sums
`stock_fini.metrage` (type 2) or produced `stock_ecru.poids` (type 1/0). Backend:
`apps/api/src/routes/rapports.ts` (`GET /commandes-sst?soldees=0|1`) — entirely bulk,
set-based, chunked `IN(...)` queries (CHUNK 400, cap 2000 commandes), bounded query count with
no per-line fan-out (HFSQL bridge-storm safety). The reusable pure sst primitives (esc, n,
dateDigits, addWorkingDays, lineStatutRank, STATUT_* constants, IS_WINDOWS) were extracted to
`apps/api/src/lib/sst-shared.ts` and are now imported by both `rapports.ts` and
`commandes-sous-traitant.ts` (no copy-paste drift). Registered in `index.ts`. Frontend:
`apps/web/src/pages/RapportCommandesSst.tsx`. Permissions deferred (to be added later).

## 2026-06-23 — feat/stock-fini
Finis › Stock — new "Surteinture" (over-dye) multi-select action, porting the legacy
`FEN_Surteinture` window. In edit mode the user selects finished rolls of the **same ref +
coloris** (1 or more) and clicks the Paintbrush button; a wide two-table modal shows the
finished pieces to delete (left, rendered struck-through in muted red) and their source
tombé-de-métier écru rows to modify (right, read-only display of numéro/réf/coloris/poids/
magasin + the auto-generated trace observation). Validating appends
`"<lot> - <ref> - <coloris> a surteindre"` to each linked `stock_ecru.observations` and
deletes the finished `stock_fini` rows, so the écru returns to available stock for a fresh
dyeing cycle with a record of where it came from. The écru's coloris and magasin are left
untouched (no editable fields — earlier iterations had pickers; removed per spec). New
dedicated permission `surteindre_stock_fini` (added to `permission-keys.ts`, auto-surfaces in
Paramètres › Utilisateurs and gates both the button and the API). Backend adds two endpoints
to `stock-fini.ts`: `POST /fini/surteindre/preview` (drives the modal — resolves each roll's
linked écru via `stock_fini.IDstock_ecru`, plus ref_ecru/colori_ecru/magasin/client labels via
flat `IN(...)` queries + `fixEncoding`, never JOIN+CONVERT; builds the trace observation
server-side so preview and write can't drift; flags rolls with no écru as `skipped`) and
`POST /fini/surteindre` (gated; per valid non-shipped roll: appends the trace via `sqlText`,
then deletes the fini). Shares a `loadSurteintFiniRows` helper that reuses the list's
SELECT/JOIN/repair path so coloris labels match. Frontend is `SurteindreDialog` in
`FinisStock.tsx`, following the existing `CutRollDialog`/`BatchEditDialog` pattern; on success
invalidates `['stock-fini']` and exits edit mode.

## 2026-06-23 — feat/stock-ecru
Tombé Métier › Références screen — new master-detail screen for écru (loom-output) knitting-fabric
references (`ref_ecru`), porting the legacy WinDev `FI_Ref_TombéMetier.wdw`. Also adds the two
Tombé Métier submenus (Références + Stock placeholder) to the nav. New API router
`apps/api/src/routes/references-ecru.ts` (`/api/references-ecru`): list (En cours / Archivé filter),
full detail, create, update (auto-stamps `date_maj_ft`), archive/unarchive, deep **duplicate**
(copies composition + coloris + machine grid + liage diagram with id remapping), guarded delete,
plus sub-resource CRUD for composition (`composition_ecru`, base `IDcolori_ecru=0`), coloris
(`colori_ecru`), the per-machine technical grid (`ref_ecru_machine`), and the binding diagram
(`chute_liage` + `schema_liage`), and lookups (contextures, clients, refs-fil, machines, symboles).
New page `apps/web/src/pages/TombeMetierReferences.tsx`: 3-panel `MasterDetailLayout` with header
trio (Imprimer/Email placeholders + Dupliquer + Archiver + gold Modifier), editable Identification /
Composition / Coloris cards, and a 3-tab technical area — **Données Technique** (LFA-tour, pignons,
machine grid with computed Compteur Saisie/Calculé, écarteur/laize/rendement/vitesse/poids,
maille-d'ouverture/ouvert-au-large/sonneter pills, observations), **Obs OF** (read-only
`obs_ref_ecru`), and a paint-style **Schéma de liage** editor (chutes × symbol cells, custom inline
SVG knit glyphs). Full unsaved-changes guard (header draft + per-key sub-form dirty registry) and
ConfirmDialogs. Reverse-engineered formulas (memory `project_tombe_metier_references`):
**Coût/kg** = `ref_ecru.prix` + Σ(`composition_ecru.pourcentage` × `ref_fil.prix_kg`)/100 over the
base composition; **Compteur Saisie** = `round((trs_10kg_chute/nb_chutes) × (poids/20) / 10) × 10`
(Compteur Calculé = 0, needs an OF). HFSQL footguns honoured: `ref_ecru` accented column names
(`archivé`/`diamètre`/`recyclé`) read via `SELECT *`+`pickKey`, written named on Windows / archive via
positional reinsert on Linux; `colori_ecru` explicit columns only; no `IDsociete` on `ref_ecru`;
`client` has no `ville`. Out of scope this pass: permissions, Circulaire/Rectiligne filter,
Print/Email (placeholders), Obs OF editing.

## 2026-06-23 — feat/etude-coloris
Finis › Études coloris — search auto-select fix. The left-list auto-select effect only
fired on first load (gated on `selectedId === null`), so narrowing the list via the search
bar to a single result never selected it — unlike every other master-detail screen. Replaced
it with the canonical pattern (from `FilsCommandes.tsx`): an effect driven off the
search-filtered `filteredEtudes` array that re-selects the first visible row whenever the
current selection drops out of the results, skipped while editing so unsaved changes are never
discarded. Typing e.g. "2012 marin 63403" down to one match now auto-selects it. Also
documented this as a mandatory convention in the `mps_designer` skill's Search Bar section
(canonical effect snippet + the `selectedId === null` anti-pattern to avoid), since the bug was
a missing cross-screen convention rather than a one-off.

## 2026-06-23 — feat/gestion-sst
Sous-traitants/Gestion: tricoteur yarn-lots, ennoblisseur tariff editor, info relayout, shared type chip.
(1) **Tricoteur lots de fil** — new "Lots de fil présents sur le site" table shown for tricoteur
sous-traitants (`IDtype_sst = 1`), mirroring the ennoblisseur rolls table: every `stock_fil` lot with
`IDMagasin = sst AND stock > 0` (ref/coloris/fournisseur/lot/lot frs/stock kg/entrée), searchable +
sortable with a count·total-kg footer. Backed by `GET /api/sous-traitants/:id/rolls`'s sibling
`GET /:id/yarn-lots` (explicit ASCII columns, batched ref_fil/colori_fil/fournisseur label lookups, no
JOIN+CONVERT collapse). (2) **Ennoblisseur tariff editor** — a center-panel segmented toggle
"Rouleaux sur le site | Tarifs" (ennoblisseur only) reveals a two-pane editor over
`tranche_tarif_ennoblissement` (`apps/web/src/pages/sous-traitants/TariffsSection.tsx`): left lists
every dye (4) + treatment (20) + existing combinations; right edits that subject's quantity bands
(min/max/prix €/Kg) with an "au-delà"=999999 toggle, inline add/edit, `ConfirmDialog` deletes, server-side
overlap guard. Full combination support incl. a new-combination dialog (dye context + multi-treatment
checklist) and re-scope; a "Copier" dialog seeds an empty ennoblisseur from another sst or the
`IDsous_traitant=0` default catalog (9 of 12 ennoblisseurs start empty). New endpoints on
`sous-traitants.ts`: GET (grouped catalog), POST band, PUT band, DELETE band, PUT `/combinaison/rescope`,
POST `/copier`. This is the exact table `pricing-sst.ts` reads, so edits flow into auto-pricing of NEW
order lines (existing lines not retro-repriced; matches legacy). Confirmed: table is 8 ASCII columns,
PK auto-increments; combos keyed on `(IDteinture, sorted ListeTraitements)`. (3) **Info relayout** — the
center "Coordonnées" card is gone; Type + Statut moved into the right sidebar's Info tab (a new
"Informations" card above Commentaire); the zombie `tel`/`fax` fields are hidden in the UI but still
round-tripped on save so existing values aren't blanked. Non-ennoblisseur/non-tricoteur types now show a
"info is in the right panel" placeholder instead of a bare card. (4) **Shared type chip** — the
hue-per-type sous-traitant chip (Ennoblisseur=sky, Tricoteur=amber, Confectionneur=teal, Autre=stone)
was extracted from Commandes into `apps/web/src/lib/sst-type.tsx` (`sstTypeTagClasses` + `<SstTypeTag>`)
and adopted in Gestion (list card, header, Info row), replacing the grey secondary Badge; documented as
mps_designer §36.

## 2026-06-22 — feat/gestion-sst
Sous-traitants/Gestion screen enhancements. (1) Left-list status filter: a 3-way
segmented control (Actifs / Inactifs / Tous, default Actifs) under the search field,
filtering on `est_visible`; the auto-select-first effect now reads the filtered list.
The "Inactif" tag moved to the top-right corner of each list card as a red destructive
badge. (2) New "Rouleaux présents sur le site" table shown only for ennoblisseur
sous-traitants (`IDtype_sst = 2`): lists every fabric roll physically located at that
subcontractor — "tombé métier" (écru) rolls awaiting dyeing + finished (fini) rolls not
yet shipped back — in one unified, searchable, sortable table with a Tous/Tombé
métier/Finis filter and a count + total-kg footer. Backed by a new
`GET /api/sous-traitants/:id/rolls` endpoint: location resolved via
`stock_ecru.IDmagasin` / `stock_fini.IDmagasin` → `sous_traitant.IDsous_traitant`
(updated on physical transfer); écru already dyed into a fini are dropped to avoid
double-counting; fini already shipped (IDligne_expedition set or état 4) are hidden;
fini coloris obeys the `ref_fini.avec_teinture` rule by reusing the now-exported
`repairAliased`/`repairAllJoins` helpers from `stock-fini.ts`. The fini "État" renders
as the same pill tag used in Finis/Stock — its colour logic was extracted to the shared
`lib/etat-stock-fini.ts` and now maps "Validé" (and Disponible/Prêt) to green in both
screens. Also: documented the canonical left-list filter-button group pattern in the
mps_designer skill.

## 2026-06-22 — feat/stock-fini
Finis › Stock enhancements. (1) **Dymo étiquette printing**: a new white icon-only Printer button in the roll drawer header (view mode, left of "Modifier") opens an 89×36 mm label PDF in a new tab to print to the Dymo. New `StockFiniLabelPdf.tsx` (@react-pdf/renderer, built-in Helvetica, rotated `logo-malterre.png` band + N°/Réf./Col./Poids/Métrage/Lot lines, reproducing legacy `ETAT_Etiquette_SP.wde` from a physical sample) and a read-only `GET /api/stock/fini/:id/label` endpoint reusing the detail route's SELECT/JOINs/repair. (2) **Édition groupée**: a Pencil icon button appears in the edit-mode toolbar when >1 roll is selected, opening a modal to batch-set `emplacement` and/or `observations` (each gated by a toggle so one field can be set without wiping the other) across all selected rolls via a new `PATCH /api/stock/fini/batch` endpoint (accented-safe `sqlText()`, registered before `/fini/:id`). (3) **Shift-click range deselect**: shift-clicking an already-selected row now removes the inclusive range, not just adds. (4) **Performance**: stabilized `handleClose`/`handleRowClick` on `guard.guardAction` (was `[guard]`, a fresh object each render that busted the `StockRow` memo); removed `isEditing` from per-row props so the edit-mode toggle re-renders zero rows (view↔edit presentation now CSS-driven via `data-editing` on `<tbody className="group">` + `group-data-` variants, click unified into one stable `onRowClick` reading an `isEditingRef`); cached one `Intl.Collator` for sorting; `useDeferredValue` on the search term. Eliminates the ~1s edit-mode lag and the general re-render thrash on a ~1.4k-row table.

## 2026-06-22 — feat/ref-fini
Finis › Références screen (`/finis/references`) — the technical datasheet (fiche technique) for finished-fabric references (`ref_fini`, 43 cols). New `apps/web/src/pages/FinisReferences.tsx` (master-detail mirroring `FilsReferences`) + `apps/api/src/routes/references-fini.ts` (mounted `/api/references-fini`), replacing the router placeholder. Full CRUD on the ASCII datasheet fields (designation, conditionnement, rendement, freinte, temp. lavage, poids/laize HT/laize utile min·moy·max, stability & elongation, SST control flags, observations/technique/commercial, responsable, en_developpement) plus an écru picker (`IDref_ecru`). Coloris (polymorphic by `avec_teinture`: dye→`ref_fini_colori` / wash→`colori_ecru`), traitements (`traitement_ref_fini`) and stock aggregate (`stock_fini`) are READ-ONLY; `avec_teinture`/`archivé`/`catalogue_privé`/dates are read-only (structural / accented-write-unsafe). Archived refs filtered out of the list in JS. Notable HFSQL footguns handled: `ref_fini` accented column NAMES (`dateCréation`/`archivé`/`catalogue_privé`) resolved by prefix regex, never named in SQL; `SELECT *` FAILS on `ref_fini_colori`/`colori_ecru` so those are read with explicit columns only; list accent-repair is batched (one `CONVERT … WHERE id IN (…)` per column) to avoid the Linux-bridge N+1 storm. Verified: web tsc + vite build clean, full CRUD round-trip over HTTP, accented write/read round-trips exactly at the DB layer.
## 2026-07-22 — feat/profile-cache-fix
Hotfix — **"Mon profil" showed the previous user's email signature on shared PCs.**
The `user-profile-me` / `user-email-me` React Query keys were static; within the
global 5-min staleTime a user switch served the prior user's cached profile
(signature, header avatar photo, SendEmailDialog signature preview). Keys are now
scoped by `IDutilisateur` in Header, ProfileModal and SendEmailDialog. The
prefix-matching `invalidateQueries` calls in SettingsUtilisateurs are unaffected.
