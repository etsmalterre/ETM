// The website catalogue — replacement of the WinDev REST webservice MPS_WS
// (alpha.etsmalterre.com), consumed server-to-server by the WordPress plugin
// `malterre-api` of etsmalterre.fr/client (customer space + QR sample page).
// Legacy map, measurements and consumers: claude_doc/webservice_legacy.md.
//
// This file is PURE: it turns a loaded `Catalog` (lib/webservice-site-data.ts)
// into the JSON documents of every route, in the legacy shapes, key order
// included. The snapshot/refresh/dates layer is lib/webservice-site-store.ts;
// the HTTP layer routes/webservice-site.ts.
//
// Deliberate differences from the legacy procedures (bugs fixed — the legacy
// code is not a spec where it is wrong):
//   • composition: one line per matière, merged and normalised (legacy
//     repeated a matière once per yarn — « coton recyclé 31 … coton recyclé 19 »);
//   • CategoriePoids thresholds ignore references without a weight (legacy
//     counted poids 0 as the minimum, skewing two contextures);
//   • designations of a client that no longer exists are not listed;
//   • fiche_technique points to a PDF that exists (legacy linked a
//     /fichiers/documents/FT<id>.pdf that was never there);
//   • `date_modification` moves when the computed content changes (the store
//     does it) — legacy only tracked the row date, so price changes never
//     reached the shop.

import {
  assembleTarifFini, prixFilLines,
  type TarifFiniInputs, type TarifTranche,
} from './pricing-fini-tarif.js'
import { parseLstTrancheIdx, contratPrixForTrancheIdx, type ContratTarifInfo } from './tarif-client.js'
import { chooseCompositionRows, composeMatieres } from './composition-matieres.js'
import type { Catalog, DesignationRow, RccRow, RefFiniRow } from './webservice-site-data.js'

/** Legacy `ListeVertus` — hard-coded in WinDev too (no table). */
export const VERTUS = [
  { IDVertu: 1, Label: 'Bio', Ordre: 1 },
  { IDVertu: 2, Label: 'Recyclé', Ordre: 2 },
  { IDVertu: 3, Label: '100% FR', Ordre: 3 },
] as const

/** Tranche indices of the public (QR) grid: 1, 2, 3, 4, 5, 10 rolls — legacy
 *  `RefInterne` never showed « < 1 », 15 or 30. */
export const PUBLIC_TRANCHE_IDX = [1, 2, 3, 4, 5, 6]

/** `nb_rouleau` of each of the engine's 9 tranches (0 = « < 1 rouleau »). */
const NB_ROULEAU = [0, 1, 2, 3, 4, 5, 10, 15, 30]

export interface TrancheJson { nb_rouleau: number; qte_ml: number; prix: string }
export interface MatiereJson { label: string; proportion: number }
export type VertuJson = { IDVertu: number; Label: string }

export interface RefInterneDoc {
  ref_produit: {
    IDRef_Produit: number
    date_modification: string
    titre: string
    reference: string
    contexture: string
    poids: number
    CategoriePoids: string
    laize: number
    longueur_rouleaux: number
    associee: string
    fiche_technique: string
    vertus: VertuJson[] | null
    matiere: MatiereJson[]
    coloris: { id_ref_coloris: number; Nom: string; tranche_tarifaire: TrancheJson[] }[]
  }
}

export interface RefProduitDoc {
  ref_produit: {
    IDRef_Produit: number
    date_modification: string
    titre: string
    reference: string
    ref_client: string
    contexture: string
    poids: number
    CategoriePoids: string
    laize: number
    longueur_rouleaux: number
    associee: string
    fiche_technique: string
    description: string
    categories: null
    vertus: VertuJson[] | null
    matiere: MatiereJson[]
    coloris: { id_ref_coloris: number; photo: string; vignette: string; Nom: string; tranche_tarifaire: TrancheJson[] }[]
  }
}

/** One built document + the source row's own modification time (epoch ms);
 *  the store turns both into `date_modification`. */
export interface Built<D> { doc: D; sourceMs: number }

export interface SiteBuild {
  refInterne: Map<number, Built<RefInterneDoc>>
  /** By IDdesignation_client. */
  refProduit: Map<number, Built<RefProduitDoc> & { IDclient: number }>
  /** Ref_Client's ListeRefColoris, by IDclient. */
  refColorisByClient: Map<number, { IDRef: number; IDColoris: number }[]>
  /** ListeIDClient rows (IDsociete 1). */
  clients: { IDClient: number; email: string }[]
  categories: Catalog['categories']
}

export interface BuildOptions {
  /** Base URL the technical-sheet links are built on (no trailing slash). */
  publicBaseUrl: string
  /** YYYYMMDD — decides which contracts are active. */
  today: string
}

// ── Weight category ─────────────────────────────────────────

/** Legacy REQ_CategoriePoids(IDcontexture): thirds of the [min, max] poids_Moy
 *  range over the non-archived references of the contexture. Reproduced on
 *  the 180 legacy answers checked (2026-09-23), except that a reference without
 *  a weight no longer drags the minimum to 0. */
export function categoriePoidsThresholds(cat: Catalog): Map<number, { min: number; max: number }> {
  const out = new Map<number, { min: number; max: number }>()
  for (const r of cat.refFini.values()) {
    if (r.archive || !(r.poids_Moy > 0)) continue
    const ctx = cat.refEcru.get(r.IDref_ecru)?.IDcontexture ?? 0
    if (!(ctx > 0)) continue
    const t = out.get(ctx)
    if (!t) out.set(ctx, { min: r.poids_Moy, max: r.poids_Moy })
    else {
      t.min = Math.min(t.min, r.poids_Moy)
      t.max = Math.max(t.max, r.poids_Moy)
    }
  }
  return out
}

export function categoriePoids(poids: number, t: { min: number; max: number } | undefined): string {
  if (!t) return 'Normal'
  const third = (t.max - t.min) / 3
  if (poids < t.min + third) return 'Léger'
  if (poids <= t.min + 2 * third) return 'Normal'
  return 'Lourd'
}

// ── Pricing through the shared engine ───────────────────────

interface PriceOpts { coefficient?: number; filExclu?: readonly number[] }

/** calcTarifRefFini's loader, over the in-memory catalogue. Same guards: a
 *  reference without rendement, écru, roll weight or coloris prices nothing. */
export function tarifInputs(cat: Catalog, IDref_fini: number, IDcoloris: number, opts: PriceOpts): TarifFiniInputs | null {
  const ref = cat.refFini.get(IDref_fini)
  if (!ref || !(ref.rendement > 0) || !(IDcoloris > 0) || !(ref.IDref_ecru > 0)) return null
  const ecru = cat.refEcru.get(ref.IDref_ecru)
  if (!ecru || !(ecru.poids > 0)) return null

  let dye: TarifFiniInputs['dye'] = null
  let colorisEcruForFil = ref.IDcolori_ecru
  if (ref.avec_teinture !== 0) {
    const rfc = cat.refFiniColori.get(IDcoloris)
    if (!rfc) return null
    if (rfc.IDteinture > 0) {
      const t = cat.teinture.get(rfc.IDteinture)
      dye = {
        IDteinture: rfc.IDteinture,
        label: t?.label ?? null,
        gots: rfc.gots,
        prixGots: t?.prixGots ?? 0,
        bands: cat.bandsByTeinture.get(rfc.IDteinture) ?? [],
      }
    }
  } else {
    colorisEcruForFil = IDcoloris
  }

  // computePrixFil: the coloris' own composition, else the base one (coloris 0).
  const all = cat.compositionByEcru.get(ref.IDref_ecru) ?? []
  let comp = all.filter((c) => c.IDcolori_ecru === colorisEcruForFil)
  if (comp.length === 0 && colorisEcruForFil !== 0) comp = all.filter((c) => c.IDcolori_ecru === 0)

  const treatments = cat.traitementsByRef.get(IDref_fini) ?? []
  const bandsByTreatment = new Map(treatments.map((t) => [t.IDtraitement, cat.bandsByTraitement.get(t.IDtraitement) ?? []]))

  return {
    IDref_fini,
    IDcoloris,
    avecTeinture: ref.avec_teinture,
    rendement: ref.rendement,
    ref_ecru: { IDref_ecru: ecru.IDref_ecru, reference: ecru.reference || null, poids: ecru.poids, prix: ecru.prix },
    detailFil: prixFilLines(comp, cat.refFil, cat.coloriFil, opts.filExclu),
    treatments,
    bandsByTreatment,
    dye,
    coefficient: opts.coefficient,
  }
}

/** Memoised per build: many client designations share a (ref × coloris) grid. */
type PriceMemo = Map<string, TarifTranche[]>

function priceTranches(cat: Catalog, memo: PriceMemo, IDref_fini: number, IDcoloris: number, opts: PriceOpts): TarifTranche[] {
  const key = `${IDref_fini}|${IDcoloris}|${opts.coefficient ?? ''}|${(opts.filExclu ?? []).join(',')}`
  const hit = memo.get(key)
  if (hit) return hit
  const inputs = tarifInputs(cat, IDref_fini, IDcoloris, opts)
  const tranches = inputs ? assembleTarifFini(inputs).tranches : []
  memo.set(key, tranches)
  return tranches
}

const prix = (v: number): string => v.toFixed(2)

// ── Shared reference header ─────────────────────────────────

function refHeader(cat: Catalog, ref: RefFiniRow, thresholds: Map<number, { min: number; max: number }>, o: BuildOptions) {
  const ecru = cat.refEcru.get(ref.IDref_ecru)
  const ctx = ecru?.IDcontexture ?? 0
  const vertus: VertuJson[] = []
  if (ecru?.bio) vertus.push({ IDVertu: 1, Label: 'Bio' })
  if (ecru?.recycle) vertus.push({ IDVertu: 2, Label: 'Recyclé' })
  const matiere = composeMatieres(
    chooseCompositionRows(cat.compositionByEcru.get(ref.IDref_ecru) ?? [], ref.IDcolori_ecru),
    cat.assoByFil,
    cat.matiereLibelle,
  ).map((m) => ({ label: m.matiere, proportion: Math.round(m.pourcentage * 100) / 100 }))
  return {
    titre: ref.designation,
    reference: ref.reference,
    contexture: cat.contexture.get(ctx) ?? '',
    poids: ref.poids_Moy,
    CategoriePoids: categoriePoids(ref.poids_Moy, thresholds.get(ctx)),
    laize: ref.laizeHT_Moy,
    // One roll in metres = roll weight × rendement (legacy printed the float32 noise).
    longueur_rouleaux: ecru ? Math.round(ecru.poids * ref.rendement * 1000) / 1000 : 0,
    fiche_technique: `${o.publicBaseUrl}/fichiers/documents/FT${ref.IDref_fini}.pdf`,
    vertus: vertus.length > 0 ? vertus : null,
    matiere,
  }
}

/** The reference's coloris: ref_fini_colori when dyed, the écru's colori_ecru
 *  when wash-only (avec_teinture = 0 — the #1158 rule). */
function refColoris(cat: Catalog, ref: RefFiniRow): { id: number; reference: string }[] {
  const rows = ref.avec_teinture !== 0
    ? cat.refFiniColoriByRef.get(ref.IDref_fini) ?? []
    : cat.coloriEcruByEcru.get(ref.IDref_ecru) ?? []
  return [...rows].sort((a, b) => a.reference.localeCompare(b.reference, 'fr', { sensitivity: 'base' }) || a.id - b.id)
}

// ── Ref_Interne (public grid — the QR sample page) ──────────

export function buildRefInterne(
  cat: Catalog, memo: PriceMemo, ref: RefFiniRow,
  thresholds: Map<number, { min: number; max: number }>, o: BuildOptions,
): RefInterneDoc {
  const h = refHeader(cat, ref, thresholds, o)
  return {
    ref_produit: {
      IDRef_Produit: ref.IDref_fini,
      date_modification: '',
      titre: h.titre,
      reference: h.reference,
      contexture: h.contexture,
      poids: h.poids,
      CategoriePoids: h.CategoriePoids,
      laize: h.laize,
      longueur_rouleaux: h.longueur_rouleaux,
      // Always "" on the public sheet (legacy): the plugin syncs related
      // products from it, which the QR page never did.
      associee: '',
      fiche_technique: h.fiche_technique,
      vertus: h.vertus,
      matiere: h.matiere,
      // Unpriceable coloris are left out — see clientTranches' ⚠️.
      coloris: refColoris(cat, ref).flatMap((c) => {
        const t = priceTranches(cat, memo, ref.IDref_fini, c.id, {})
        if (t.length === 0) return []
        return [{
          id_ref_coloris: c.id,
          Nom: c.reference,
          tranche_tarifaire: PUBLIC_TRANCHE_IDX.map((i) => ({
            nb_rouleau: NB_ROULEAU[i],
            qte_ml: t[i].qte_ml,
            prix: prix(t[i].moPrixDeVenteAuMl),
          })),
        }]
      }),
    },
  }
}

// ── Ref_Produit (a client's own product and prices) ─────────

/** The client's tarif mode on one coloris — lib/tarif-client.ts
 *  `fetchTarifModes`, over the in-memory rows. */
function rccMode(cat: Catalog, rcc: RccRow, today: string): {
  mode: 'standard' | 'coefficient' | 'contrat'
  coefficient: number
  actif: ContratTarifInfo | null
} {
  const rows = cat.tranchesByRcc.get(rcc.IDref_client_colori) ?? []
  const coefficient = rows.find((t) => t.IDcontrat_tarif === 0 && t.coefficient > 0)?.coefficient ?? 0
  const contrats = (cat.contratsByRcc.get(rcc.IDref_client_colori) ?? [])
    .map((c): ContratTarifInfo => ({
      IDcontrat_tarif: c.IDcontrat_tarif,
      date_debut: c.date_debut,
      date_expiration: c.date_expiration,
      tranches: rows
        .filter((t) => t.IDcontrat_tarif === c.IDcontrat_tarif)
        .map((t) => ({ nb_rouleaux: t.nb_rouleaux, prix: t.prix_saisi })),
    }))
    .sort((a, b) => (a.date_debut === b.date_debut ? b.IDcontrat_tarif - a.IDcontrat_tarif : b.date_debut.localeCompare(a.date_debut)))
  const actif = contrats.find(
    (c) => c.date_debut.length === 8 && c.date_expiration.length === 8 && c.date_debut <= today && today <= c.date_expiration,
  ) ?? null
  const mode = rcc.contrat === 1 ? 'contrat' : coefficient > 0 ? 'coefficient' : 'standard'
  return { mode, coefficient, actif }
}

/** The tranches a client sees on one coloris, or null when it cannot be
 *  priced: contract mode with no contract covering today (the ERP rule — an
 *  expired contract is never a silent fall back to the standard grid), or a
 *  reference the engine refuses (no roll weight, no rendement…).
 *
 *  ⚠️ An unpriced coloris must be LEFT OUT, never sent with an empty grid: the
 *  plugin (malterre-api.php, « Mise à jour des coloris et des variations »)
 *  creates the variation in stock at its 1 € base wholesale price with no
 *  quantity rule — sellable at 1 €/Ml. The legacy service did send some
 *  expired-contract coloris that way. */
export function clientTranches(
  cat: Catalog, memo: PriceMemo, d: DesignationRow, rcc: RccRow, ref: RefFiniRow, today: string,
): TrancheJson[] | null {
  const idxs = parseLstTrancheIdx(rcc.lst_tranche)
  const colorisId = ref.avec_teinture !== 0 ? rcc.IDref_fini_colori : rcc.IDcolori_ecru
  const m = rccMode(cat, rcc, today)
  const grid = priceTranches(cat, memo, ref.IDref_fini, colorisId, {
    coefficient: m.mode === 'coefficient' ? m.coefficient / 100 : undefined,
    filExclu: d.filExclu,
  })
  if (grid.length === 0) return null
  let priceAt: (i: number) => number = (i) => grid[i].moPrixDeVenteAuMl
  if (m.mode === 'contrat') {
    // Same rule as the ERP order line: the largest negotiated band at or below
    // the tranche, else the contract's smallest one.
    const actif = m.actif
    if (!actif || contratPrixForTrancheIdx(actif, 8) == null) return null
    priceAt = (i) => contratPrixForTrancheIdx(actif, i) ?? 0
  }
  return shopSafeTrancheIdx(idxs).map((i) => ({ nb_rouleau: NB_ROULEAU[i], qte_ml: grid[i].qte_ml, prix: prix(priceAt(i)) }))
}

/** The plugin prices the quantities BELOW a grid's last row at the previous
 *  row's price, which starts at 0 — so a one-row grid of « 1 rouleau » or more
 *  (lst_tranche "7", a coefficient row on « 1 », a one-band contract) sold
 *  everything under that row at 0 €. The legacy service sent such grids.
 *  Never emit one: add the row just below (« < 1 » under « 1 », « 1 » under
 *  anything larger). */
export function shopSafeTrancheIdx(idxs: readonly number[]): number[] {
  if (idxs.length !== 1 || idxs[0] === 0) return [...idxs]
  return [idxs[0] === 1 ? 0 : 1, idxs[0]]
}

function colorisName(cat: Catalog, ref: RefFiniRow, rcc: RccRow): string {
  return ref.avec_teinture !== 0
    ? cat.refFiniColori.get(rcc.IDref_fini_colori)?.reference ?? ''
    : cat.coloriEcru.get(rcc.IDcolori_ecru)?.reference ?? ''
}

export function buildRefProduit(
  cat: Catalog, memo: PriceMemo, d: DesignationRow, ref: RefFiniRow,
  thresholds: Map<number, { min: number; max: number }>, o: BuildOptions,
): RefProduitDoc {
  const h = refHeader(cat, ref, thresholds, o)
  const coloris: RefProduitDoc['ref_produit']['coloris'] = []
  for (const rcc of cat.rccByDesignation.get(d.IDdesignation_client) ?? []) {
    if (rcc.archive) continue
    const tranche_tarifaire = clientTranches(cat, memo, d, rcc, ref, o.today)
    if (tranche_tarifaire === null) continue
    coloris.push({ id_ref_coloris: rcc.IDref_client_colori, photo: '', vignette: '', Nom: colorisName(cat, ref, rcc), tranche_tarifaire })
  }
  return {
    ref_produit: {
      IDRef_Produit: d.IDdesignation_client,
      date_modification: '',
      titre: h.titre,
      reference: h.reference,
      ref_client: d.designation,
      contexture: h.contexture,
      poids: h.poids,
      CategoriePoids: h.CategoriePoids,
      laize: h.laize,
      longueur_rouleaux: h.longueur_rouleaux,
      associee: d.associee,
      fiche_technique: h.fiche_technique,
      description: '',
      categories: null,
      vertus: h.vertus,
      matiere: h.matiere,
      coloris,
    },
  }
}

/** A designation the shop sells: live, visible, a finished reference, and a
 *  client that still exists. */
export function isShopDesignation(cat: Catalog, d: DesignationRow): boolean {
  return !d.archive && !d.cache && d.IDref_fini > 0 && cat.refFini.has(d.IDref_fini) && cat.client.has(d.IDclient)
}

// ── Whole build ─────────────────────────────────────────────

export function buildSite(cat: Catalog, o: BuildOptions): SiteBuild {
  const memo: PriceMemo = new Map()
  const thresholds = categoriePoidsThresholds(cat)

  const refInterne = new Map<number, Built<RefInterneDoc>>()
  for (const ref of cat.refFini.values()) {
    if (ref.archive) continue
    refInterne.set(ref.IDref_fini, { doc: buildRefInterne(cat, memo, ref, thresholds, o), sourceMs: ref.modifiedMs })
  }

  const refProduit = new Map<number, Built<RefProduitDoc> & { IDclient: number }>()
  const refColorisByClient = new Map<number, { IDRef: number; IDColoris: number }[]>()
  for (const d of cat.designation.values()) {
    if (d.archive || d.cache) continue
    // Ref_Client lists every live designation of the client (legacy RefClient).
    const pairs = refColorisByClient.get(d.IDclient) ?? []
    for (const rcc of cat.rccByDesignation.get(d.IDdesignation_client) ?? []) {
      if (!rcc.archive) pairs.push({ IDRef: d.IDdesignation_client, IDColoris: rcc.IDref_client_colori })
    }
    refColorisByClient.set(d.IDclient, pairs)
    if (!isShopDesignation(cat, d)) continue
    const ref = cat.refFini.get(d.IDref_fini)!
    refProduit.set(d.IDdesignation_client, {
      doc: buildRefProduit(cat, memo, d, ref, thresholds, o),
      sourceMs: d.modifiedMs,
      IDclient: d.IDclient,
    })
  }

  const clients = [...cat.client.entries()]
    .filter(([, c]) => c.IDsociete === 1)
    .map(([id]) => ({ IDClient: id, email: cat.clientEmail.get(id) ?? 'Non Disponible' }))
    .sort((a, b) => a.IDClient - b.IDClient)

  return { refInterne, refProduit, refColorisByClient, clients, categories: cat.categories }
}
