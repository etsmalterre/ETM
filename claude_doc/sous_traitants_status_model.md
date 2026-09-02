# Sous-traitants Commandes — status model, soumission lot, historique

Reference doc for the sous-traitant commande detail screen
(`apps/web/src/pages/SousTraitantsCommandes.tsx` + `apps/api/src/routes/commandes-sous-traitant.ts`).

## Status model — computed "phase" + line sstatut state machine

Legacy MPS had three layers of status. ETM now writes to two of them:

| Layer | Field | Today |
|---|---|---|
| Header | `commande_sous_traitant.est_soldee` BOOLEAN | Gates writes via `refuseIfTerminee`. Drives the Clôturer / Rouvrir toggle. |
| Line | `ligne_commande_sous_traitant.sstatut` VARCHAR (12 legacy values) | ETM drives three of them as a state machine (see below). Other legacy values preserved on read, never written from the new app. |
| Roll | `stock_fini.IDetat_stock_fini` SMALLINT FK → `etat_stock_fini` | Per-roll workflow state, real DB enum: **1**=En Contrôle, **2**=En Reprise, **3**=Validé, **4**=Expédié, **5**=Attente de décision. |

### Line `sstatut` state machine (writes from ETM)

Three of the 12 legacy values are wired into a state machine that's
driven entirely from server-side handlers. The four state transitions:

| Transition | Fires from | Server effect |
|---|---|---|
| (create) → `Non_Envoye` | `POST /:id/lignes` | Default sstatut on new line, **unless** `envoi_email` already has an `IDtype_doc=13` row for the commande (then defaults to `Attente_Delai` so the commande phase doesn't regress when a line is added after the bon de commande was already sent). |
| `Non_Envoye` → `Attente_Delai` | `POST /:id/email` (bon de commande) | After `sendMail`, the handler runs `logEnvoiEmails(13, …)` (closes a legacy-only logging gap; the historique tab already expected type=13 rows) AND `UPDATE … SET sstatut = 'Attente_Delai' WHERE sstatut = 'Non_Envoye'`. |
| `Attente_Delai` → `En_Cours` | `PUT /lignes/:lineId` with `date_livraison` in the patch | When the row's current sstatut is exactly `Attente_Delai`, the same UPDATE that changes `date_livraison` also sets `sstatut = 'En_Cours'`. Lines still in `Non_Envoye` keep their status (the bon de commande hasn't been sent yet — the date is hypothetical). An explicit `sstatut` in the PUT body always wins over this auto-flip. |
| (any open) → `Terminé` | StatusFooter "Clôturer" button | Header est_soldee=1 path. Per-line sstatut is left as-is. |

Constants: `STATUT_DONE`, `STATUT_OPEN`, `STATUT_NON_ENVOYE`,
`STATUT_ATTENTE_DELAI` at the top of `commandes-sous-traitant.ts`.

### Computed phase pill — derived on-read

The header pill priority (first match wins):

| Phase | When | Color |
|---|---|---|
| **terminée** | `est_soldee = 1` | Green (`bg-success`) |
| **trm_soldee** | the TRM mirror (`commande_client.IDcommande_ETM = commandeId`) has `est_soldee = 1` — Tricotage Malterre finished the knitting (all OFs terminés, all rolls shipped; its API enforces that) and waits for ETM to check reception and clôturer its own order (LIVA #1100, 2026-09-02) | Teal (`bg-teal-600`) |
| **en_reprise** | any `stock_fini` row has `IDetat_stock_fini = 2` | Orange |
| **soumis** | any `envoi_email` with `IDtype_doc = 15 AND IDreference = commandeId` | Violet |
| **en_controle** | any `stock_fini` row exists (rolls received) | Amber |
| **en_cours** | MAX line rank = 2 (any non-Non_Envoye / non-Attente_Delai sstatut, including legacy values) | Primary blue |
| **attente_delai** | MAX line rank = 1 (any Attente_Delai line, none higher) | Yellow |
| **non_envoye** | MAX line rank = 0 OR no lines at all (default for a fresh commande) | Slate |

Sub-phase classification uses `lineStatutRank()`:
`Non_Envoye=0`, `Attente_Delai=1`, everything else (including all 10 other
legacy values) `=2`. Helpers: `classifyEnCoursBucket(id)` (detail path) +
inline batched line-rank query in `computePhasesBatch` (list path).

`SstPhase` type lives in both `commandes-sous-traitant.ts` and
`SousTraitantsCommandes.tsx`. `SST_PHASE_META` carries label + lucide icon
(non_envoye=Mail, attente_delai=Hourglass, …) + pill class + solid class
(for the StatusFooter band). `lineEtatColors()` mirrors the palette on the
per-line cards (slate / yellow / blue / green).

**Manual close only**: the auto-close trigger (`maybeAutoCloseCommande`)
is no longer called from the line-update path. Users clôture via the
StatusFooter button. The function definition remains for future revert.

### List filter + smart phase-keyword search

The toggle bar at the top of the left list exposes only three macro
buckets: **En cours** (`status=open` → `est_soldee=0`), **Terminées**
(`status=terminee`), **Toutes** (`status=all`). Sub-phase drilldown
moves to the search bar via `matchPhaseKeyword(q)`:

- Accent-stripped, lowercased query, minimum 3 chars
- Prefix match first (`"rep"` → `en_reprise`, `"soum"` → `soumis`,
  `"term"` → `terminée`)
- Substring fallback (`"dela"` → `attente_delai`, `"trole"` → `en_controle`)
- On match, `statusFilter` is overridden to the matched phase and the
  catalog `resolveSearch` is skipped. Alias order in `PHASE_KEYWORD_ALIASES`
  controls tie-breaking (e.g. `"en c"` → `en_cours`).

The list endpoint also still accepts every individual sub-phase value
(`non_envoye`, `attente_delai`, `en_cours`, `en_controle`, `soumis`,
`en_reprise`, `trm_soldee` — keyword « soldee ») via `SUB_PHASES` so smart-search overrides keep working;
the `en_cours` bucket is sub-classified server-side by line-rank MAX.

After a commande is created via the "+ Nouveau" dialog, the page auto-
switches the toggle to **En cours** so the freshly-created `non_envoye`
row stays visible.

### Card urgency frames + header pills

Each left-list card gets a red or amber frame (border + 4 px inset shadow
on the leading edge) when the underlying commande is running late. Two
rules drive the colour, depending on phase:

| Phase | Signal | `late` (red) | `soon` (amber) |
|---|---|---|---|
| `attente_delai` | `commande_sous_traitant.date_notif` relance date (HFSQL `YYYYMMDD`; legacy rows without one fall back to bon de commande send + 3 working days) | `date_notif ≤ today` | `date_notif ≤` next working day after today (last working day before the relance) |
| any other open phase | earliest open-line `date_livraison` (`earliest_delivery`, min over `sstatut != Terminé` lines) | deadline ≤ today, OR no valid `earliest_delivery` | deadline within 3 days |
| `terminée` | — | never | never |

Frontend helpers: `attenteDelaiUrgency(dateNotifHfsql, isoSentDay)` and
`deliveryUrgency(yyyymmdd, est_soldee)` in `SousTraitantsCommandes.tsx`.
The list endpoint returns `date_notif` (`YYYYMMDD`, primary anchor),
`bon_envoye_at` (`YYYY-MM-DD`, fallback anchor) and `earliest_delivery`
(`YYYYMMDD`) per row. Working-day math (`addWorkingDays` — Sat/Sun skipped,
French bank holidays not considered) is duplicated in both files; the
single change point for holiday support is that helper in each.

Backend `computeUrgencyBuckets()` (shared helper in
`commandes-sous-traitant.ts`) mirrors the same rules over every open
commande and returns `{ late: Set<number>, soon: Set<number> }`. Both
endpoints below consume it so the pill counts and the filter narrow to
the exact same set the cards paint.

- `GET /commandes-sous-traitant/urgency-counts` → `{ late, soon }`
  scalars feeding the two header pills. Polled by React Query, 30 s
  stale window, refetch on window focus.
- `GET /commandes-sous-traitant?…&urgency_in=late` (or `=soon`, or
  `=late,soon`) → restricts the result set to commandes whose urgency is
  in the comma-separated list. Composes with `status`, search, and
  keyset pagination via an `IN (...)` predicate.

UI pills sit on the same row as the search input
(`SousTraitantsCommandes.tsx`, `CommandeList`). Number-only, ~28 px high,
red-tinted / amber-tinted when off, solid red / amber when on. Each pill
is an independent toggle (`urgencyLateOn`, `urgencySoonOn`); a pill with
a zero count is hidden. Cross-filter rules:

- Clicking a pill while the toggle bar shows **Terminées** flips the bar
  back to **En cours** before applying the pill — urgency only exists on
  open commandes.
- Clicking **Terminées** while either pill is on clears both pills.

When either pill is on the client-side memo resorts the loaded rows so
red sits above amber, with ID DESC inside each band.

### Relance date (`date_notif`)

`commande_sous_traitant.date_notif` is the per-commande relance reminder
and the primary anchor for the `attente_delai` urgency frame. Surfaced as
an editable date field ("Relance", `BellRing` icon) in its own card at the
top of the Info tab, saved via `PUT /:id`. `POST /:id/email` (bon de
commande) seeds it to today + 3 working days — **only when unset**, so a
manual edit, or a value from an earlier send, is never overwritten
(re-sending does not restart the relance clock).

## Soumission Lot Client feature

End-to-end flow for sending a soumission to a client whose
`designation_client.soumettre = 1` for that ref_fini.

### Eligibility

A "lot" is eligible when:
1. A `stock_fini` row points back to this commande's lines
   (`IDref_commande_source IN (lines)`)
2. The roll is reserved to a client via the chain
   `stock_fini.IDligne_commande_client → ligne_commande_client → commande_client.IDclient`
3. `designation_client.soumettre = 1 AND archivé = 0` for that
   `(IDclient, IDref_fini)` pair

Lot key tuple: `(IDref_fini, IDColoris, lot, IDcommande_client)`.
Helper: `findEligibleLots(commandeId)` (exported from
`commandes-sous-traitant.ts` for the dump-soumission-pdf dev script).

### Endpoints (all under `/commandes-sous-traitant/:id/soumission/…`)

- `GET /lots-eligibles` — returns `{ lots: EligibleLot[] }` (frontend
  uses `length === 0` to hide the button, `length === 1` to skip the picker)
- `GET /pdf?ref_fini=&coloris=&lot=&commande_client=` — inline PDF preview
- `GET /email-defaults?…` — recipients (client contacts with
  `envoi_soumission = 1` pre-selected) + subject + body
- `POST /email` — sends + logs to `envoi_email` with `IDtype_doc = 15`,
  `notes = <lot string>`, `IDreference = commandeId` (matches the legacy
  WinDev convention so the legacy app reads our outgoing soumissions
  alongside its own)

### PDF

`apps/api/src/lib/pdf/SoumissionLotPdf.tsx` — one-page document built on
`MalterreDocument`. Layout mirrors the legacy WinDev report: reference
strip (Référence Client / Malterre / Coloris) → "Détails de la commande"
table → "Adresse de livraison" panel → "Soumission" table (Date /
Expéditeur / Destinataire / Lot ou Bain) → large empty
"Attacher l'échantillon ici" frame for the physical swatch.

Custom inline SVG icons in the file: `FabricRollIcon`, `PaletteIcon`.

Destinataire is auto-filled from the client's contact whose
`contact.envoi_soumission = 1` (same boolean already used by
`etudes-coloris.ts:701` for sst soumissions).

### Frontend

`SousTraitantsCommandes.tsx`:
- "Soumettre au client" button in `DetailHeader` (between Email + Modifier),
  gated on `eligibleLots.length > 0`. Send icon (lucide).
- `SoumissionLotPicker` dialog — modelled on the existing
  `AdressePickerDialog` (~line 3494). Shown only when 2+ lots are eligible;
  single-lot flow jumps straight to the email modal.
- Reuses `SendEmailDialog` with the soumission-specific endpoints. The
  `extraBody` field on `postEmail()` carries the lot params through
  to the server (lot params survive across recipient changes).

## Historique tab

Right-sidebar tab (4th tab, Clock icon) showing the commande's event
timeline. Backed by `GET /:id/historique`.

### Sources

- `envoi_email` rows where `IDtype_doc IN (13, 15)` AND
  `IDreference = commandeId`. (Type 14 = avis expedition is **excluded**
  — its `IDreference` is polymorphic and points to `expedition.IDexpedition`
  not commande_sous_traitant. See HFSQL rules.)
- `reponse_soumission` rows where `IDcommande_sous_traitant = id`. Each
  row is one client decision: `reponse = 1` (approved, green check) or
  `0` (rejected, red X), with `DATE` + `lot`.

### Linux iODBC quirk on this endpoint

`envoi_email` carries a `société` column with an accented identifier.
On Linux the iODBC bridge **cannot tokenize accented identifiers in a
SELECT column list**, so the handler branches on `IS_WINDOWS`: Windows
keeps the explicit column list, Linux falls back to `SELECT *` and lets
`fixEncoding` decode the row dict. Same pattern as `computePhase`'s
soumis-check. Symptom of forgetting: prod returns 500, dev (Windows)
works. See `apps/api/src/routes/commandes-sous-traitant.ts` historique
handler.

### Event grouping (envoi_email)

Multi-recipient sends produce one row per recipient (e.g. 4 MATEL
recipients of a single bon-de-commande email). The endpoint groups by
`(IDtype_doc, DATE truncated to the minute)` so the timeline shows one
event per real action. **Minute precision is intentional** — a send burst
can straddle the second boundary (e.g. timestamps `17:00:31.855 → :32.026`).

### Frontend types

`HistoriqueEvent` is a discriminated union:
- `{ kind: 'email', recipients[], notes (lot id), … }` — rendered by `EmailEventCard`
- `{ kind: 'reponse', reponse (0|1), lot, … }` — rendered by `ReponseEventCard`

`HISTORIQUE_EMAIL_META` maps `IDtype_doc → { label, icon, accent }`:
- 13 = "Bon de commande envoyé" (AtSign, blue)
- 14 = "Avis d'expédition envoyé" (Truck, cyan) — meta retained for a
  future expedition-chain wiring (sst lines → stock_fini → expedition)
- 15 = "Soumission au client" (Send, violet)

## Qualité verdict → roll cascade

The responsable qualité's verdict in **Qualité › Suivi Lots**
(`POST /suivi-lots/:id/etat`) cascades onto the lot's received rolls, keyed on
`stock_fini.IDref_commande_source = suivilot.IDligne_commande_sous_traitant AND
stock_fini.lot = suivilot.lot` (same key as the détail/pièces query):

- **Valider** (`IDetatLot = 3`) → rolls set to `IDetat_stock_fini = 3` (Validé).
- **Reprendre** (`IDetatLot = 2`) → rolls set to `IDetat_stock_fini = 2` (En reprise).
- Guard `IDetat_stock_fini <> 4` so an already-Expédié roll is never pulled
  backward. Best-effort: a cascade failure must not fail the recorded verdict.

Both directions cascade (added 2026-06-30; the Valider half was missing, leaving
rolls stuck "En Contrôle" after lot validation — fixed + back-filled 79 prod rolls).

## Reprise flow

Multi-select fini rolls whose `IDetat_stock_fini = 2` ("En reprise") in
the Réception tab → "Reprendre (X)" button in the tab strip header →
opens `BatchReceptionDialog` in `mode='reprise'` (discriminated union):

- Pre-fills lot/poids/metrage/observations from the existing fini rows
- Submits PATCH per fini (not POST) with the edited values
- Resets `IDetat_stock_fini` back to `1` (En contrôle) server-side
- "Couper en deux" works here too (added 2026-07-02): the existing row is
  PATCHed into piece 1 (renamed `<base>-1`) and piece 2 POSTs as a new
  `stock_fini` row (`<base>-2`) via the create endpoint, passing the
  original's `IDstock_ecru` / `IDColoris` / `IDmagasin` so both halves
  match apart from poids/metrage (create mode instead splits the écru
  into two POSTed rows)
- Tricobot works here too (added 2026-07-02): matches BL `num_piece`
  against the **fini** numeros (create mode matches écru numeros), and
  only non-empty BL values overwrite the pre-filled fields. The tricobot
  endpoint orders by PK ascending so when the same num_piece exists twice
  (original + corrected reprise BL) the newest row wins in the frontend's
  last-write map.

PATCH endpoint at `PATCH /:commandeId/lignes/:ligneId/pieces/fini/:stockFiniId`
accepts: `observations`, `observation_sst`, `numero`, `lot`, `poids`,
`metrage`, `IDetat_stock_fini`.

## PDF: Bon de commande sous-traitant

`apps/api/src/lib/pdf/CommandeSoustraitantPdf.tsx` — significantly
redesigned this session:

- Header: two-line yellow band ("BON DE COMMANDE" / "SOUS-TRAITANT N°X")
- Top right card combines délai de livraison + adresse de livraison
  (single bordered cell with internal divider)
- DÉSIGNATION column hierarchy: large primary-blue ref label →
  prominent coloris → designation subtitle → treatment chip pills →
  "OUVERT AU LARGE" comment (gray, MessageSquare icon, no frame) →
  POIDS/LAIZE/RENDEMENT chips on one line → ARTICLE INITIAL block
- Quantité prévue + Poids affecté + grand total bigger (11pt → 13pt
  grand). Top margin tightened (32pt → 16pt).
- "Stock à mettre en œuvre" moved to a **second logical Page**
  (`MalterreDocument.secondPage` prop, `paddingTop: 36`). Pieces
  chunked at `V2_CHUNK_SIZE = 17` so each chunk renders as a complete
  rounded-corner table that fits on its own physical page (with the
  section title on page 1 of secondPage).
- Lato Black quirk: ALL CAPS accented chars (À, É, Œ) render with
  detached diacritics under @react-pdf — strip accents from any
  uppercase title (e.g. "STOCK A METTRE EN OEUVRE").

`MalterreDocument` gained a `secondPage?: { paddingTop?, children }` prop
and a `PageFooter` helper extracted from the original single-page render.

## type_doc codes used by this screen

Legacy lookup `type_doc` (29 rows). Codes touched by ETM:
- `13` "commande sst" — bon de commande email to the ennoblisseur
- `15` "soumission" — sst → client soumission. `IDreference =
  commande_sous_traitant.IDcommande_sous_traitant`, `notes = <lot>`
- `27` "labo coloris" — étude-coloris demande (`etudes-coloris.ts`)

History: we briefly used `30` in one session before catching the legacy
`15` convention. The reverse migration is
`apps/api/src/scripts/migrate-revert-type-doc-30.ts` (idempotent — safe
to re-run in any environment that may have stale rows).

## LinkEcruDialog — picker scoped to sst magasin

The "+ Affecter" picker on the ennoblisseur drawer's Affectés tab only
shows `stock_ecru` rolls whose `IDmagasin = commande.IDsous_traitant`
(the magasin id space and the sous_traitant id space share the same
integer column; `stock_*.IDmagasin → sous_traitant.IDsous_traitant`).
Without this scope an operator could "affecter" rolls still physically
at Malterre, which the legacy workflow never permits — they have to
be transferred first. `LineContext.IDsous_traitant` carries the value
from `loadEnnoblisseurLineContext`; the dialog subtitle reads
`"N rouleaux disponibles chez <sst>"` so the scope is obvious.

## BatchReceptionDialog — completion gate + Suivant focus

The "Réceptionner N rouleaux" submit is disabled until every roll has a
non-empty `lot` AND `metrage > 0`. Footer shows `Total : X Ml` (live sum)
+ `K / N rouleaux complets` (amber when incomplete, muted when full).
`Précédent` / `Suivant` punt focus into the métrage input via a
`queueMicrotask(() => metrageInputRef.current?.focus().select())` —
runs after React commits the next row's value so `.select()` selects
the freshly-rendered string. `LabeledInput` accepts an optional
`inputRef?: React.Ref<HTMLInputElement>` for this kind of programmatic
focus.

## Dev-only "Faux envoi" send

`SendEmailDialog` shows a dashed amber "Faux envoi (dev)" button next to
Annuler / Envoyer when `import.meta.env.DEV` is true. It hardcodes
recipient to `vincent@etsmalterre.com` and sends `devSkipSend: true`,
which the server forwards as `dev_skip_send: true`. Backend gate:
`ALLOW_DEV_SKIP_SEND = process.env.NODE_ENV !== 'production'`. When
honoured, `getUserEmail` / PDF rendering / `sendMail` are all skipped
but `logEnvoiEmails` + the sstatut flip (or whatever side effects the
endpoint has) still run, so status transitions can be exercised in dev
without spamming real recipients. Prod builds ignore the flag.

## Tests (manual)

- Phase distribution probe: `apps/api/src/scripts/inspect-phase-distribution.ts`
- Soumission PDF dump: `apps/api/src/scripts/dump-soumission-pdf.ts`
  (uses exported `findEligibleLots` + `buildSoumissionLotPdfData`)
- Bon de commande PDF dump: `apps/api/src/scripts/dump-sst-pdf.ts`
