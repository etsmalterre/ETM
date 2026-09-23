# Legacy WinDev webservice `MPS_WS`: the customer space and the QR sample page (investigation 2026-09-23)

Context for the rewrite of the WinDev REST webservice into the MPS API. Secrets are masked (`xx***`); the full
values are in the cited WinDev cache files. **Certain** = read in code, probed live or measured. **Inferred** = labelled.

## 1. The pieces and who calls what

```
QR on the sample tag (EtiquetteRefFiniPdf / legacy FI_Ref_Fini)
  https://etsmalterre.fr/echantillon/?ID=<IDref_fini>      (URL printed on tags customers hold: KEEP IT)
    └─302 (Apache, OVH)→ https://etsmalterre.fr/client/echantillon/?ID=<id>
         WordPress "client" (OVH shared hosting) + WooCommerce + plugin malterre-api v0.3
           └─ PHP wp_remote_get (server-to-server, no auth, 30 s timeout)
                https://alpha.etsmalterre.com/<route>
                  public IP → OPNsense → Caddy 10.10.20.5 → http://10.10.55.2:80
                  VM 104 "webservice": Apache 2.4 + WebDev 30 app server, site MPS_WS
                    └─ HFSQL mps.malterre (10.10.20.2:4900)
```

- **Website** (`C:\dev\etsmalterre\etsmalterre.com`, NOT a git repo): two WordPress installs on OVH cluster128.
  - `etsmalterre.fr` (Astra child + Elementor): two Elementor forms POST to `commande_catalogue`.
  - `etsmalterre.fr/client` (sunergy-child + WooCommerce + wholesale prices + **`malterre-api.php`**, 5 748 lines, local copy):
    the customer space. The theme and page templates are on the server only.
  - ⚠️ That folder's `CLAUDE.md` holds the OVH SSH password in plain text. Move it out and rotate it.
- **Webservice**: WinDev project `C:\Mes Projets\MPS`, configuration "Webservice".
  - Files: `REST_MPS.wdrest` (routes) and `Webservice.wdg` (code) are PCS-compressed.
  - Readable source: the compile cache `MPS.cpl\vincent@etsmalterre.com\00000001\`, files `Webservice.7FDA7014.wdg.wcg`,
    `COL_Tarifs.B3F83D2B.wdg.wcg` and `MPS.wdp.wcp`.
  - Deploy description: `MPS_Webservice_WBINST.WWF` (XML). Last build 2025-11-03, WINDEV 2025 (v30), target alpha.etsmalterre.com.
- **Not part of it**: `ExtranetTRM` (a WebDev site on the same VM that reads HFSQL directly: login plus the customer's yarn
  stock `stock_fil` and orders), `Suivi_Matiere` (a 2023 WebDev site on OVH), and the TricoBot API (VM 106, n8n).

## 2. Routes (confirmed live; routes sit at the root of alpha.etsmalterre.com)

| Verb | Path | Procedure | Consumer |
|---|---|---|---|
| GET | `/Ref_Interne/{IDref_fini}` | `RefInterne` | **QR sample page** |
| GET | `/ListeIDRefInterne` | lists `ref_fini` not archived: `{ref_produit:[{IDRef_Produit, date_modification "AAAAMMJJHHmm"}]}` (473 rows) | QR page (freshness check) |
| GET | `/Ref_Produit/{IDdesignation_client}/{IDclient}` | `RefProduit` → `DesignationClient` | nightly sync, client creation |
| GET | `/ListeIDRefProduit` | lists `designation_client` not archived/hidden: IDRef_Produit, IDClient, date_modification, Ordre (~1 970 rows) | nightly sync |
| GET | `/Ref_Client/{IDclient}` | `RefClient`: contact, billing/delivery addresses, `ListeRefColoris [{IDRef=IDdesignation_client, IDColoris=IDref_client_colori}]` | client creation |
| GET | `/ListeIDClient` | loops clients, then one `contact` query per client (N+1) → `[{IDClient, email}]` | client import |
| GET | `/ListeCategoriesProduit` | `categorie_produit` | (call commented out) |
| GET | `/ListeVertus` | hard-coded `Bio / Recyclé / 100% FR`, no DB | sync + QR page |
| POST | `/commande_catalogue` | website form → duplicate check → INSERT `prospect` | main site Elementor forms |
| POST | `/NouvelleCommande` | sends an email only (hard-coded Gmail SMTP) | unknown (theme?) |
| GET | `/RapportQuotidien/{key}` | daily email report (orders of the day, CA, rendement quality, tariff alert); key literal `Rapport***` | unknown scheduler |

- **No authentication anywhere** except the report key. `Ref_Client/{id}` gives anyone on the internet a client's
  name, email, phone, addresses and product list.
- Hard-coded secrets in the WinDev code: the Gmail app password, the SMTP password for contact@, and an HFSQL login.

## 3. The QR sample flow and why it is slow

`mise_a_jour_echantillon($_GET['ID'])` in `malterre-api.php:4019` runs synchronously on every scan:

1. `GET Ref_Interne/{ID}` (~10.3 s). The full price calculation runs, but only `reference` is used.
2. MySQL lookup of the WooCommerce product: `_product_attributes LIKE '%"ID"%'`, then `_sku LIKE '%<ref>-E%'`.
   This is fuzzy: an id can also match a laize or weight value.
3. `GET ListeIDRefInterne` (~10.1 s): the whole list, fetched to read one `date_modification`.
4. Only if the date changed (or `?force=1`): `GET ListeVertus` (~10 s), then the full WooCommerce product rebuild while
   the customer waits. The rebuild covers variations per coloris, price tables in `_variation_description`, wholesale
   tiers in `wwpp_post_meta_quantity_discount_rule_mapping`, and a photo/vignette download per coloris.
5. Otherwise the page shows the **prices cached in WooCommerce, which are stale**. Price changes never bump
   `ref_fini.dateModification`, so they are never picked up. For 1730 the page shows 21.55 €/ml at 1 roll; the API says 22.62 today.

**Measured timings (2026-09-23, LAN → 10.10.55.2):**

| Request | Time |
|---|---|
| Unknown path (Apache 404) | 0.06 s |
| `OPTIONS /ListeVertus` (no procedure runs) | 10.04 s |
| `GET /ListeVertus` (no DB) | 10.05 s |
| `GET /Ref_Interne/1730` (full price calculation) | 10.33 s |
| `GET /Ref_Produit/1885/252` (9 tranches × 8 coloris) | 10.58 s |
| TricoBot API (same project, other config) | 0.05 s |
| **The website page `/echantillon/?ID=1730`** | **24.6 s** |

**Root cause: a fixed ~10 s is added to every request before any code runs.** The real work takes 0.05–0.6 s.

- **Inferred, strong:** the "Webservice" configuration's project init code (`00000001\MPS.wdp.wcp`) opens
  `MaConnexion` on **`193.70.86.221`**, the old OVH server, whose port 4900 times out from the factory. It waits
  ~10 s, fails, and falls back to the analysis connection `mps.malterre` (the data it returns is live).
  - The other configurations use `mps.malterre`.
  - The unreachable port is confirmed from the VM (below). That the init code is what waits is still inferred:
    watching the process needs root, and we connect without sudo.
- **Checked on VM 104 (2026-09-23, `debian` user, claude_deploy key, no sudo):** from the VM, `193.70.86.221:4900`
  never answers (TCP attempt still pending after 30 s), while `mps.malterre:4900` (= `10.10.20.2`) opens instantly.
  The code inside the deployed library is compressed, so the address can't be grepped there.
- **Quick fix before the rewrite:** change that address to `mps.malterre` in WinDev and redeploy. That should bring a
  scan from ~25 s down to a few seconds. Even so, the page would still show stale WooCommerce prices.

## 4. Price logic (what the rewrite must reproduce)

- **`RefInterne`**: public catalogue grid, no client.
  - Reads `ref_fini`, `ref_ecru`, `contexture`, `REQ_CategoriePoids`, `REQ_Compo_Ecru_Detail`, and the coloris
    (`ref_fini_colori` or `colori_ecru` by `avec_teinture`).
  - Calls `COL_Tarifs.QuantitéDesTranches` + `PrixDeVenteV4` for each coloris, with a memo: identical yarn cost within
    the same dye family (Blanc/TC × Simple/Double) → reuse the previous grid.
  - Fixed tranches **1, 2, 3, 4, 5, 10 rolls**; `qte_ml = round(nb × longueur_rouleaux)`; `prix` is a STRING with 2 decimals.
  - Parity sample: 1730 (001A) → 22.62 / 17.08 / 14.32 / 11.98 / 10.63 / 9.03 €/ml.
- **`DesignationClient`**: client grid.
  - Tranches come from `ref_client_colori.lst_tranche` (client 252 gets all 9: 0=<1, 1, 2, 3, 4, 5, 10, 15, 30).
  - Adds `contrat_tarif` + `tranche_tarifaire` (`coefficient` / `prix_saisi`) and `designation_client.fil_non_facturé`.
  - Parity sample: 1885/252, 17.11 down to 4.31.
- **Already ported in the MPS API:**
  - `lib/pricing-fini-tarif.ts` `calcTarifRefFini(IDref_fini, IDcoloris)` = `PrixDeVenteV4` (9 tranches, ~10 flat queries per coloris).
  - `lib/tarif-client.ts` + `lib/pricing-ligne-client.ts` (contract / coefficient / `lst_tranche`).
  - ⚠️ Expired contract: the order path blocks it (409), but `GET /clients/:id/coloris/:rccId/tarif` falls back to the
    standard grid. Decide which rule the public surface follows.
  - Not the same thing as `lib/pricing-ref-tarif.ts` (the Finis › Tarifs simulator, "46/46 parity").
- **A precomputed-price design already exists in the schema**, used by the unexposed `RefCatalogue` and by `AlerteTarif`:
  - `tarif_coloris` (`IDRef_Catalogue`, `IDdesignation_client`, `IDColoris`, `prix_publié`, `prix_calculé`, `prochain_prix`,
    `tranche_tarifaire`, `date_calcul`, `date_expiration`)
  - `prix_gamme_colori`
  - `ref_catalogue` / `categorie_produit` / `asso_ref_catalogue_categorie` / `gamme_coloris` / `colori_fini`
- **Other `ref_fini` flags**: `site` (bool, inferred "published on the website") and `catalogue_privé`.
- **Photos**: `ref_fini_colori.photo`, `photo_produit` (photo + vignette, via `ref_client_colori.IDphoto_produit`),
  `vignette_coloris`. The webservice publishes them as `alpha.etsmalterre.com/fichiers/photos/…`.
  The technical sheet URL `…/fichiers/documents/FT<id>.pdf` answers 404.

## 5. The customer space (WooCommerce)

- **Login**: plain WordPress (role `customer`); the webservice is never called at login.
- **Account creation**: WinDev `FI_Gestion_Client` › `IMG_Synchro` calls
  `etsmalterre.fr/client/api-malterre-client/?id_client=<id>&force=1`, which runs the `[creation-client]` shortcode:
  - calls `Ref_Client`;
  - creates the WP user with a random password, **emailed in plain text to contact@**;
  - stores the meta `ID_Client_Malterre` + `disponible_a_la_commande`;
  - syncs products 3 at a time through a JS redirect. Inferred: called from WinDev, no JS runs, so only 3 products sync.
- **Nightly WP cron** `malterre_update_products_cron`: `ListeIDRefProduit`, then `Ref_Produit` per product in batches of 5.
  Change detection is on `date_modification` only (a price change is never picked up; incident on product 053B).
- **Screens**: standard WooCommerce (catalogue with each client's own products, the price table per roll count,
  cart, checkout with woo-clicandpay, my orders).
  - No screen reads ERP orders, stock, shipments or invoices.
  - Where WooCommerce orders go (`NouvelleCommande`? the theme?) is on the OVH server only, not on disk.

## 5b. The deployment on VM 104 and real usage (read 2026-09-23)

- **Layout** (`/home/webdevuser`):
  - `WebservicesREST/MPS_WS/MPS.wdl` (2.7 MB, dated **2025-10-09**: older than the 2025-11-03 build in the WWF).
  - `Donnees/MPS_WS/Log/WWSession_YYYYMMDD.log`: one tab-separated line per call (timestamp, `BUFFEROK`/`*ERROR*`,
    `Webservice.<Procedure>`, response bytes, source IP). `WDSessionErr_*.log` holds the error text.
  - `Sites/ExtranetTRM/V1.00A*` (several versions kept). `HFREP.INI` → `Donnees/stock/mps.rep`.
- **The embedded OpenAPI 3.0.3** (plain JSON inside the WDL; copy in the session scratchpad, `mps_ws_openapi.json`)
  confirms the 11 routes of §2 and documents `POST /NouvelleCommande` as *"called by the WooCommerce webhook when a
  new order is created"*. So a web-shop order only produces an email; nothing is written to HFSQL.
- **Usage from the logs** (2025-08-27 → 2026-09-23, 321 days, ~516 000 calls):

  | Procedure | Calls | Note |
  |---|---|---|
  | `RefProduit` | 196 575 | nightly WooCommerce sync, one per client product |
  | `ListeIDRefProduit` | 196 490 | **the 180 KB list is re-fetched once per product** by the sync (`lecture_produits`) |
  | `ListeVertus` | 115 554 | constant, fetched again each time |
  | `RefClient` | 18 375 | |
  | **`RefInterne` (QR scans)** | **558** | on 161 days, i.e. ~3 scans per active day; each also calls `ListeIDRefInterne` (553) |
  | `ListeIDClient` | 202 | |
  | `CommandeCatalogue` | 35 | website sample/contact forms, last on 2026-09-14 |

  - The median is ~1 900 calls a day (peak 6 200), recently 450–950. At ~10 s each, the service spends hours a day
    doing the fixed wait.
  - Sources: `10.10.2.167` (350 k, an earlier path before Caddy), `5.135.37.210` (OVH, direct, 125 k),
    `91.134.248.249` (46 k, another OVH address), and `10.10.20.5` (Caddy, since 2026-09-09). Everything else is our own probes.
- **Consequence for the rewrite:** the QR page is low volume. The load is the sync pattern, which should become
  one bulk endpoint (or a push) instead of `list + detail` per product.

## 6. Infrastructure facts for the rewrite

- The MPS API (VM 108, `10.10.20.3:8081`) is **intranet-only**: `*.intra` has no public DNS, and Caddy's `intra_guard` returns 403.
- **Never expose `:8081` wholesale.** There is no global auth, and `references-fini.ts` / `tarifs-fini.ts` have no
  permission checks, writes included.
  - A public surface needs its own read-only router with an explicit allowlist.
  - Publish it under a public Caddy name that matches only its path prefix. `api.etsmalterre.com` exists as a dead
    route today (KB issue P2).
- On Linux every MPS API query goes through one serialized `hfsql_bridge` queue, so public traffic would queue behind
  the ERP. Precompute or cache the public prices rather than computing them per scan.
- There is no DMZ and the network is flat. The firewall must allow OVH's outgoing IP `5.135.37.210` if the website
  keeps calling server-to-server.
- The migration plan (`windev_migration/docs/plan.md` §A1) lists this webservice as an HFSQL client to port or retire
  before the PostgreSQL cutover. `legacy-activity-report.ts` already tags 10.10.55.2.

## 7. The replacement in the MPS API (built 2026-09-23, branch `feat/webservice`)

**Mount `/api/site`, drop-in compatible**: same 9 routes, verbs, JSON shapes and key order, so the WordPress plugin needs
**no change**. Cutover = Caddy points `alpha.etsmalterre.com` at the MPS API with a `/api/site` prefix, instead of VM 104.
Rollback = point it back.

| File | Role |
|---|---|
| `lib/webservice-site-data.ts` | Bulk loader: every table read once, flat queries (~20 queries for the whole catalogue, 1.8 s on prod) |
| `lib/webservice-site.ts` | Pure builder: documents in the legacy shapes, priced through the ERP engine (`assembleTarifFini`) |
| `lib/webservice-site-store.ts` | Snapshot in memory + `data/webservice-site-snapshot.json`; background rebuild after 20 min (`WEBSERVICE_SITE_TTL_MIN`); content-hash dates in `data/webservice-site-state.json` |
| `routes/webservice-site.ts` | HTTP layer; optional IP allowlist `WEBSERVICE_SITE_ALLOWED_IPS`; `GET /_etat` = snapshot status |
| `lib/composition-matieres.ts` | Matière composition shared with the fiche technique (`references-fini.ts`) |
| `scripts/check-webservice-site-parity.ts` | Compares every document with answers saved from the legacy service (`--prod-env` to price prod data; SELECT only) |

Refactors that ship with it (ERP behaviour unchanged; the 449 API tests pass):
- `pricing-fini-tarif.ts`: `assembleTarifFini()` (pure) split out of `calcTarifRefFini()`, plus a new `filExclu` option;
- `prospects.ts`: `insertProspect()` extracted and shared with the form.

**Speed.** Every route answers from the snapshot in 4–30 ms. The legacy service took ≥ 10 s per call and 24.6 s per QR
scan. `Ref_Client` reads its contact block live (3 single-client queries). The technical-sheet PDF is rendered once,
then cached for an hour.

**Parity on prod data** (all 473 public references + 83 sampled client products, 4 476 coloris):
- 92 % of the coloris match to the centime; every other gap is ≤ 0,02 € (rounding order), except the legacy bug below.
- The ERP engine is the reference, not the webservice: the ERP's figures are the ones on orders and invoices.

**Deliberate differences (legacy bugs fixed):**
1. **Roll weight truncated** to an integer by the legacy (32,6 kg → 32). This changed the metres per roll (171 coloris)
   and sometimes the price band.
2. **Price-grid reuse between coloris** (`tabBufferPrix…`) misfired: ref 1867 marfil/marino sold at 10,09 €/m instead
   of 16,19 €/m (their yarn costs 6,09 €/kg, the reused grid had free yarn).
3. **Composition**: one line per matière, merged and normalised (legacy: « coton recyclé 31 + … + coton recyclé 19 »).
4. **CategoriePoids**: same rule (thirds of the [min, max] `poids_Moy` range per contexture, non-archived refs —
   180/180 legacy answers reproduced), but a reference without a weight no longer drags the minimum to 0 (26 refs change class).
5. **Unpriceable coloris are LEFT OUT** (expired contract, écru without roll weight).
   - The legacy sent some with prices computed as if a roll weighed 1 kg, and some with an empty grid.
   - With an empty grid, the plugin creates the variation **in stock at the 1 € base wholesale price** → sellable at 1 €/m.
6. **One-row grids are never sent.**
   - The plugin prices the quantities below a grid's last row at the previous row's price, starting at 0 €.
   - Where the legacy sent `[1 rouleau]` alone (coefficient row, one-band contract, `lst_tranche` "7"), the new API adds
     the row below it.
7. **Client tarif modes follow the ERP** (`tarif-client.ts`):
   - fixed coefficient → the engine with that margin on every `lst_tranche` row (legacy: one flat row);
   - active contract → `contratPrixForTrancheIdx` on every row;
   - `fil_non_facturé` (client-supplied yarn) → excluded from the yarn cost. The legacy did apply it (`sFilExclu`); the
     ERP's client fiche and order pricing still do NOT — gap to close on the ERP side.
8. **`date_modification` moves when the content changes** (content hash), so price changes finally reach the shop.
   The first build dates everything « now » → the shop refreshes every product once after go-live.
9. **Other small fixes:**
   - designations of deleted clients (71) or client 0 are not listed;
   - `Ref_Client` serves ETM (société 1) clients only;
   - the placeholder refs 1904/1905 no longer inherit a stale « jersey » contexture;
   - labels are trimmed and correctly accented;
   - `associee` is "" when the column holds "0";
   - `fiche_technique` points to a real PDF (`/fichiers/documents/FT<id>.pdf` → `buildFicheTechniquePdfData`);
   - unknown `Ref_Interne` → 404 (same body « Erreur »).

**Kept as-is on purpose:**
- `commande_catalogue` rejects a known prospect (same email, or same street + postcode) with 500 « Ce client existe
  déjà dans la BDD ». Whether a known prospect may ask again is a commercial decision, and the theme's form handler
  (OVH, not in the repo) may test that status.
- `NouvelleCommande` and `RapportQuotidien` are not ported: 0 calls in a year of logs.

**Data to fix in the ERP** (found by the parity run, 2026-09-23):
- 11 live references on an écru with no roll weight (`ref_ecru.poids = 0`) → no price on the site until filled:
  E148 (25), 620/03/L (1255), N5 (607), 002A (1615), 035A (1612), COR01 (1611), COR02 (1609), HAP04C (1394),
  HAP05C (1395), and the two « Nouvelle référence » placeholders (1904, 1905).
- 18 yarns used by live references have `ref_fil.prix_kg = 0` (priced only where the yarn coloris carries a price),
  e.g. 1/28 PES/COT 55/45 (ref_fil 181, ref 1867).

**Go-live checklist** (not done — needs the user's go-ahead: it deploys the shared MPS API and changes a public route):
1. Merge + `/etm_deploy` (the MPS API serves every client — smoke-check ETM/TRM too).
2. On the server: `curl localhost:8081/api/site/_etat`, then `/api/site/ListeIDRefInterne` (first build ~2 s).
3. Caddy (`10.10.20.5`), site `alpha.etsmalterre.com`:
   - `rewrite * /api/site{uri}` → `reverse_proxy 10.10.20.3:8081` instead of `10.10.55.2:80`;
   - restrict it to the website's addresses (OVH `5.135.37.210`, `91.134.248.249`) with a `remote_ip` matcher;
   - keep the old block commented out for rollback.
4. Set `WEBSERVICE_SITE_ALLOWED_IPS` on the API to the same list (the peer is Caddy, a private address → the first
   X-Forwarded-For hop is checked).
5. Submit one catalogue form with accents from the site and read the prospect back on the ERP.
   - Windows dev stores accents as « ? » through the shared `sqlText()` hex literals — pre-existing, the ERP
     Prospects screen does the same in dev;
   - prod runs the Linux bridge, where this write path is the verified one.
6. Scan a QR (`/echantillon/?ID=1730`): the page should answer in a few seconds (WordPress rebuilds the product once).
7. After a quiet week or two: stop `WEBDEV30` on VM 104 and watch its logs for a few days (a call arriving after the
   Caddy change = a consumer we missed). Then a last PBS backup, delete VM 104 and its backup job, update the network
   KB, drop `10.10.55.2` from `legacy-activity-report.ts`, delete the WinDev « Webservice » deploy configuration, and
   rotate the secrets that were in the WinDev code (deferred security cleanup).

**ExtranetTRM is retired with the VM** (decision 2026-09-23). It is the other WebDev site on VM 104
(`alpha.etsmalterre.com/ExtranetTRM/`: login + the customer's yarn stock `stock_fil` and orders).
- Its logs (`Donnees/stock/Log`) show 12 days of use from Nov 2025 to 15 Apr 2026, none since.
- So Caddy sends the WHOLE `alpha.etsmalterre.com` to the new API; `/ExtranetTRM` stops answering at the Caddy switch.
- If a customer asks for it back, the yarn-stock view becomes a page of the customer space, not a WebDev revival.
- The rest of VM 104 is leftovers: an Apache `n8n.conf` pointing at the old n8n address, a default page, expired
  Apache certificates.
