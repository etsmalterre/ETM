// Tricotage Malterre auto-pricing — port of the legacy WLanguage
// procedure `PrixDeRevientTRM` (cost-price per kg of écru produced by
// TRM's own factory). Activated ONLY for TRM sst commandes
// (IDsous_traitant=1); external tricoteurs price manually.
//
// Algorithm summary (full legacy spec + WLanguage source in memory
// [[project-pricing-prixderevient-trm]]):
//
//   gxNbToursKg = MIN((ref_ecru_machine.trs_10kg_chute / nb_chutes) / 10)
//                 FOR ref_ecru_machine WHERE IDref_ecru = X
//   gxMinParKg  = gxNbToursKg / 20    // 20 turns / minute target speed
//
//   FraisStructure_€/kg = (energie + maintenance + amortissement +
//                          abonnement + direction + autre_frais)
//                         / prod_annuel
//   xCoutAmortissement_€/kg = cout_metier
//                             / (5_276_160 trs_annuel × duree_amortissement_metier)
//                             × gxNbToursKg
//   xCoutChangementAiguilles_€/kg = (NbAiguilles × cout_aiguille)
//                                   / duree_vie_aiguille × gxNbToursKg
//   xCoutConsoElec_€/kg  = (gxMinParKg × 3KW / 60) × prix_kwh
//
//   For each "employé" category (bonnetier, regleur, visiteur, magasinier,
//   administration):
//     cost = Σ coutOperation(tps_X, freq_X, cout_horaire) / xPoidsCommandé
//     coutOperation = tps_min × ceil(xPoidsCommandé / freq) × (cout_horaire/60)
//     freq = "" → nbOperations = 1 (one-off, not amortized over weight)
//
// Final per-kg cost = sum of all the above.
// Final line.prix = max(PrixDeRevientTRM, ref_ecru.prix).
//
// Legacy quirks preserved verbatim (do NOT "fix"):
//   - Visiteur block re-uses `cout_horaire_bonnetier` (not `cout_horaire_visiteur`).
//     Both rates are 14 €/h in current data so the math is identical, but
//     the legacy code has a literal bug. Port matches.
//   - Visiteur block also adds `tps_garniture` (already counted under
//     Bonnetier). Counted twice in legacy. Port matches.
//   - Magasinier block also adds `tps_preparation` (already counted under
//     Bonnetier with the same freq). Counted twice in legacy. Port matches.
//   - The "20 turns/min" target speed is hardcoded in both gxMinParKg and
//     xNb_Tour_Annuel (= 20 trs/min × 229 days × 80% TRS = 5 276 160).
//     Both stay as literals.

import { query } from './hfsql-auto.js'

// ── Pure helpers (no DB access) ────────────────────────────

/** Number of needles on the machine for the given (Jauge, diamètre) lookups.
 *  Both are integer codes on ref_ecru that map to actual values:
 *    Jauge:    1→0, 2→14, 3→18, 4→20, 5→28
 *    diamètre: 1→0, 2→26, 3→30
 *  Returns round(π × diamètre × jauge, 0). Returns 0 for unknown codes
 *  (matches legacy behaviour). */
export function NbAiguilles(jaugeCode: number, diametreCode: number): number {
  let jauge = 0
  switch (jaugeCode) {
    case 1: jauge = 0; break
    case 2: jauge = 14; break
    case 3: jauge = 18; break
    case 4: jauge = 20; break
    case 5: jauge = 28; break
  }
  let diametre = 0
  switch (diametreCode) {
    case 1: diametre = 0; break
    case 2: diametre = 26; break
    case 3: diametre = 30; break
  }
  return Math.round(Math.PI * diametre * jauge)
}

/** `coutOperation` — per-task cost for the line, in €.
 *  Time-based amortization: nbOperations = ceil(xPoidsCommandé / freq).
 *  When `freqKey` is empty, the task is treated as one-off (nbOperations=1).
 *  Returns the operation's total cost over the line — caller divides by
 *  xPoidsCommandé to get a €/kg figure. */
export function coutOperation(
  tpsKey: string,
  freqKey: string,
  hourlyRate: number,
  xPoidsCommandé: number,
  tarifMap: Map<string, number>,
): number {
  const xTemps = tarifMap.get(tpsKey) ?? 0
  const xCoutEmployeParMinute = hourlyRate / 60
  let nbOperations: number
  if (freqKey && freqKey.length > 0) {
    const xFrequence = tarifMap.get(freqKey) ?? 0
    if (xFrequence <= 0) {
      // Defensive: legacy passes through unchanged. Treat as 1 op.
      nbOperations = 1
    } else {
      nbOperations = Math.ceil(xPoidsCommandé / xFrequence)
    }
  } else {
    nbOperations = 1
  }
  return xTemps * nbOperations * xCoutEmployeParMinute
}

// ── DB-backed pieces ───────────────────────────────────────

/** Load every tarif_TRM row into a Map<identifiant, nombre> for O(1)
 *  lookups during the algo. ~50 rows, ~3ms. */
export async function loadTarifTrmConfig(): Promise<Map<string, number>> {
  const rows = await query<{ identifiant: string; nombre: number | null }>(
    `SELECT identifiant, nombre FROM tarif_TRM`,
  )
  const m = new Map<string, number>()
  for (const r of rows) {
    const key = (r.identifiant ?? '').toString().trim()
    if (key.length > 0) m.set(key, Number(r.nombre) || 0)
  }
  return m
}

/** Per-ref production data — `gxNbToursKg` is the min turns-per-kg across
 *  all machines defined for this ref_ecru. Returns 0 if no machine rows
 *  exist (then the algo returns 0 too → floor wins via max). */
export async function loadTrsParKg(IDref_ecru: number): Promise<number> {
  if (!(IDref_ecru > 0)) return 0
  const rows = await query<{ trs_par_kg: number | null }>(
    `SELECT MIN((trs_10kg_chute/nb_chutes)/10) AS trs_par_kg
     FROM ref_ecru_machine WHERE IDref_ecru = ${IDref_ecru}`,
  )
  return Number(rows[0]?.trs_par_kg) || 0
}

/** Per-ref Jauge + diamètre codes from ref_ecru.
 *  Accented column "diamètre" — Linux ODBC bridge rejects accented
 *  identifiers in SELECT lists, Windows accepts them. Use `SELECT *` so
 *  the row carries both forms (the bridge mangles to "diamtre" or
 *  similar on Linux; Windows keeps the accent). Pluck whichever key the
 *  driver surfaced. */
export async function loadRefEcruMachineCodes(IDref_ecru: number): Promise<{ Jauge: number; diametre: number }> {
  if (!(IDref_ecru > 0)) return { Jauge: 0, diametre: 0 }
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM ref_ecru WHERE IDref_ecru = ${IDref_ecru}`,
  )
  if (rows.length === 0) return { Jauge: 0, diametre: 0 }
  const r = rows[0] as any
  return {
    Jauge: Number(r.Jauge) || 0,
    diametre: Number(r['diamètre'] ?? r.diametre ?? r['diamtre']) || 0,
  }
}

/** `ref_ecru.prix` — the contractual floor. The final line.prix is
 *  max(PrixDeRevientTRM, this). */
export async function loadRefEcruPrixFloor(IDref_ecru: number): Promise<number> {
  if (!(IDref_ecru > 0)) return 0
  const r = await query<{ prix: number | null }>(
    `SELECT prix FROM ref_ecru WHERE IDref_ecru = ${IDref_ecru}`,
  )
  return Number(r[0]?.prix) || 0
}

// ── Main algorithm ─────────────────────────────────────────

/** Constants from the legacy code. */
const NB_TOUR_ANNUEL = 5_276_160 // 20 trs/min × 229 days × 80% TRS
const TARGET_SPEED_TRS_MIN = 20  // gxMinParKg = gxNbToursKg / 20
const MACHINE_POWER_KW = 3       // ConsoElecParKg = gxMinParKg × 3 / 60

/** Margin applied to the cost price to get the sale price. Legacy WLanguage:
 *  `moPrixMargé = PrixDeRevientTRM(...) / 0.7` — 30 % markup. */
export const TRM_MARGIN = 0.30

/** What role `ref_ecru.prix` plays when the retained price is derived.
 *
 *  - **`'price-floor'` (legacy, the default)** — `max(cost / 0.7, base)`. The
 *    base is a floor on the *sale* price: when it wins it is retained flat,
 *    with no markup on top. This is what the WinDev app does, and it is what
 *    the ETM → TRM sous-traitance bridge writes (verified 15/15 against recent
 *    mirrored lines, e.g. ref 4 @500 kg stored at 2,07 € = the bare base).
 *    **Do not change this default** — it would reprice the intercompany
 *    transfer price by ~+39 % and diverge from the legacy that still writes
 *    those lines.
 *  - **`'cost-floor'`** — `max(cost, base) / 0.7`. The base is a floor on the
 *    *cost*: whichever of the two is the higher assiette gets the 30 % margin,
 *    so TRM never sells below base + 30 %. Used by the native TRM client-order
 *    suggestion only (`/commandes-trm/lookups/line-price`), on the user's
 *    2026-08-26 decision. The two rules coincide only when `base <= cost`,
 *    which is the minority of refs (on 51 refs used by native TRM orders they
 *    differ on 40 at 100 kg).
 */
export type TrmBaseRole = 'price-floor' | 'cost-floor'

// ── Breakdown (per-component detail, for the "Coût de tricotage" UI) ────────

/** One displayed cost line within a section, with its €/kg contribution and a
 *  short description of the inputs that produced it. */
export interface CoutRow { key: string; label: string; eurPerKg: number; info?: string }

/** A display group (Frais de structure / Frais de production / Main d'œuvre). */
export interface CoutSection {
  key: 'structure' | 'production' | 'main_oeuvre'
  label: string
  rows: CoutRow[]
  subtotalPerKg: number
}

/** Full breakdown of `prixDeRevientTRM` for a ref at a given quantity. The
 *  `costPerKg` equals the scalar `prixDeRevientTRM` and `retainedPrice` equals
 *  `trmLinePrix`, so the displayed detail and the line price never diverge. */
export interface CoutTricotageBreakdown {
  computable: boolean // false when gxNbToursKg <= 0 (no ref_ecru_machine rows)
  IDref_ecru: number
  qty: number
  inputs: {
    gxNbToursKg: number
    gxMinParKg: number
    nbAiguilles: number
    prodAnnuel: number
    jaugeCode: number
    diametreCode: number
  }
  sections: CoutSection[]
  costPerKg: number
  salePrice: number
  floor: number
  retainedPrice: number
  /** Which rule produced `retainedPrice` — see `TrmBaseRole`. */
  baseRole: TrmBaseRole
  /** Which of the two inputs the retained price was built on, so a UI can say
   *  where the number came from instead of showing a bare figure. `'base'`
   *  means `ref_ecru.prix` won the max (under `'price-floor'` it was retained
   *  flat; under `'cost-floor'` it carries the 30 % margin). */
  retainedFrom: 'revient' | 'base'
}

/** Compact number formatter for the descriptive `info` strings (plain ASCII,
 *  no locale separators so it stays stable across environments). */
function num(n: number, dp = 2): string {
  const r = Math.round(n * 10 ** dp) / 10 ** dp
  return Number.isInteger(r) ? String(r) : r.toFixed(dp)
}

/** Run one labor block: sum `coutOperation` over its tasks (in order, so the
 *  arithmetic is identical to the legacy inline accumulation), returning both
 *  the € total over the line and the €/kg figure. */
function laborBlock(
  hourlyRate: number,
  ops: Array<[tpsKey: string, freqKey: string]>,
  xPoidsCommandé: number,
  tarif: Map<string, number>,
): { total: number; perKg: number } {
  let total = 0
  for (const [tpsKey, freqKey] of ops) {
    total += coutOperation(tpsKey, freqKey, hourlyRate, xPoidsCommandé, tarif)
  }
  return { total, perKg: total / xPoidsCommandé }
}

/** The retained price and its provenance, from the cost of revient and the
 *  base. Single place both breakdown paths (computable and not) go through, so
 *  the two rules can never drift apart between them. */
export function retain(
  costPerKg: number,
  floor: number,
  baseRole: TrmBaseRole,
): { retainedPrice: number; retainedFrom: 'revient' | 'base' } {
  const base = Math.max(0, floor)
  const cost = Math.max(0, costPerKg)
  const raw = baseRole === 'cost-floor'
    ? Math.max(cost, base) / (1 - TRM_MARGIN)
    : Math.max(cost > 0 ? cost / (1 - TRM_MARGIN) : 0, base)
  return {
    retainedPrice: Math.round(raw * 100) / 100,
    // Ties go to 'revient': with base == cost the algorithm is what priced it.
    retainedFrom: base > cost ? 'base' : 'revient',
  }
}

/** Breakdown skeleton for the not-computable case (no machine data / bad
 *  inputs). The floor still flows through to `retainedPrice` so the UI can show
 *  the price that will actually be retained — the floor under `'price-floor'`,
 *  the floor plus its margin under `'cost-floor'`. */
function emptyBreakdown(
  IDref_ecru: number,
  qty: number,
  floor: number,
  inputs: CoutTricotageBreakdown['inputs'],
  baseRole: TrmBaseRole,
): CoutTricotageBreakdown {
  const { retainedPrice, retainedFrom } = retain(0, floor, baseRole)
  return {
    computable: false,
    IDref_ecru,
    qty,
    inputs,
    sections: [
      { key: 'structure', label: 'Frais de structure', rows: [], subtotalPerKg: 0 },
      { key: 'production', label: 'Frais de production', rows: [], subtotalPerKg: 0 },
      { key: 'main_oeuvre', label: "Main d'œuvre", rows: [], subtotalPerKg: 0 },
    ],
    costPerKg: 0,
    salePrice: 0,
    floor,
    retainedPrice,
    baseRole,
    retainedFrom,
  }
}

/** Full per-component breakdown of the écru production cost per kg. The legacy
 *  inline math is preserved EXACTLY (same operands, same accumulation order) so
 *  `costPerKg` is bit-identical to the old scalar `prixDeRevientTRM` and
 *  `retainedPrice` to `trmLinePrix`. The per-row `eurPerKg` values are computed
 *  separately, for display only — section subtotals use the original aggregate
 *  expressions, not a re-sum of the rows. */
export async function prixDeRevientTRMDetail(
  IDref_ecru: number,
  xPoidsCommandé: number,
  baseRole: TrmBaseRole = 'price-floor',
): Promise<CoutTricotageBreakdown> {
  const zeroInputs = { gxNbToursKg: 0, gxMinParKg: 0, nbAiguilles: 0, prodAnnuel: 0, jaugeCode: 0, diametreCode: 0 }

  // Bad inputs — still surface the floor so retainedPrice is meaningful.
  if (xPoidsCommandé <= 0 || IDref_ecru <= 0) {
    const floor = await loadRefEcruPrixFloor(IDref_ecru)
    return emptyBreakdown(IDref_ecru, xPoidsCommandé, floor, zeroInputs, baseRole)
  }

  const [tarif, gxNbToursKg, codes, floor] = await Promise.all([
    loadTarifTrmConfig(),
    loadTrsParKg(IDref_ecru),
    loadRefEcruMachineCodes(IDref_ecru),
    loadRefEcruPrixFloor(IDref_ecru),
  ])

  const prodAnnuel = tarif.get('prod_annuel') ?? 0
  const nbAiguilles = NbAiguilles(codes.Jauge, codes.diametre)

  // Without machine data we can't compute amortization or needle wear —
  // not computable; the floor wins via retainedPrice.
  if (gxNbToursKg <= 0) {
    return emptyBreakdown(IDref_ecru, xPoidsCommandé, floor, {
      gxNbToursKg: 0, gxMinParKg: 0, nbAiguilles, prodAnnuel, jaugeCode: codes.Jauge, diametreCode: codes.diametre,
    }, baseRole)
  }

  const gxMinParKg = gxNbToursKg / TARGET_SPEED_TRS_MIN

  // ── Frais de structure (annual fixed costs / annual production) ──
  const xProdAnnuel = prodAnnuel
  let xCoutAnnuelTotal = 0
  const structureRows: CoutRow[] = []
  const STRUCTURE_KEYS: Array<[string, string]> = [
    ['energie', 'Énergie'],
    ['maintenance', 'Maintenance'],
    ['amortissement', 'Amortissement'],
    ['abonnement', 'Abonnement'],
    ['direction', 'Direction'],
    ['autre_frais', 'Autres frais'],
  ]
  for (const [key, label] of STRUCTURE_KEYS) {
    const annual = tarif.get(key) ?? 0
    xCoutAnnuelTotal += annual // same order as legacy → identical FraisStructure
    structureRows.push({
      key, label,
      eurPerKg: xProdAnnuel > 0 ? annual / xProdAnnuel : 0,
      info: `${num(annual)} € / ${num(xProdAnnuel)} kg`,
    })
  }
  const FraisStructure = xProdAnnuel > 0 ? xCoutAnnuelTotal / xProdAnnuel : 0

  // ── Frais de production ──
  // Amortissement machine
  const xCout_metier = tarif.get('cout_metier') ?? 0
  const xDuréé_amortissement = tarif.get('duree_amortissement_metier') ?? 0
  const denominator = NB_TOUR_ANNUEL * xDuréé_amortissement
  const xCoutAmortissement = denominator > 0
    ? (xCout_metier / denominator) * gxNbToursKg
    : 0

  // Changement des aiguilles
  const xCout_aiguille = tarif.get('cout_aiguille') ?? 0
  const xPrixJeuAiguille = nbAiguilles * xCout_aiguille
  const xDuréeDeVie = tarif.get('duree_vie_aiguille') ?? 0
  const xPrixParTour = xDuréeDeVie > 0 ? xPrixJeuAiguille / xDuréeDeVie : 0
  const xCoutChangementAiguilles = xPrixParTour * gxNbToursKg

  // Conso électrique — legacy hardcoded 3 KW machine power.
  const xPrixDuKWH = tarif.get('prix_kwh') ?? 0
  const ConsoElecParKg = (gxMinParKg * MACHINE_POWER_KW) / 60
  const xCoutConsoElec = ConsoElecParKg * xPrixDuKWH

  const productionRows: CoutRow[] = [
    {
      key: 'amortissement_machine', label: 'Amortissement métier', eurPerKg: xCoutAmortissement,
      info: `${num(xCout_metier)} € / (${num(NB_TOUR_ANNUEL)} trs/an × ${num(xDuréé_amortissement)} ans) × ${num(gxNbToursKg, 2)} trs/kg`,
    },
    {
      key: 'changement_aiguilles', label: 'Changement aiguilles', eurPerKg: xCoutChangementAiguilles,
      info: `${num(nbAiguilles)} aig. × ${num(xCout_aiguille)} € / ${num(xDuréeDeVie)} trs × ${num(gxNbToursKg, 2)} trs/kg`,
    },
    {
      key: 'conso_elec', label: 'Consommation électrique', eurPerKg: xCoutConsoElec,
      info: `${num(gxMinParKg, 3)} min/kg × ${MACHINE_POWER_KW} kW / 60 × ${num(xPrixDuKWH)} €/kWh`,
    },
  ]

  // ── Main d'œuvre ── (legacy quirks preserved verbatim: Visiteur reads the
  // bonnetier rate and re-counts tps_garniture; Magasinier re-counts
  // tps_preparation. See header comment. Do NOT "fix".)
  const rateBonnetier = tarif.get('cout_horaire_bonnetier') ?? 0
  const bonnetier = laborBlock(rateBonnetier, [
    ['tps_garniture', ''], ['tps_preparation', 'freq_preparation'], ['tps_doublage', 'freq_doublage'],
    ['tps_redemarrage_machine', 'freq_redemarrage_machine'], ['tps_nettoyage', 'freq_nettoyage'], ['tps_fin_piece', 'freq_fin_piece'],
  ], xPoidsCommandé, tarif)
  const regleur = laborBlock(tarif.get('cout_horaire_regleur') ?? 0, [
    ['tps_reglage_machine', ''], ['tps_controle_param', 'freq_controle_param'],
  ], xPoidsCommandé, tarif)
  const visiteur = laborBlock(rateBonnetier, [
    ['tps_garniture', ''], ['tps_visitage', 'freq_visitage'], ['tps_saisie_piece', 'freq_saisie_piece'], ['tps_manutention', 'freq_manutention'],
  ], xPoidsCommandé, tarif)
  const magasinier = laborBlock(tarif.get('cout_horaire_magasinier') ?? 0, [
    ['tps_reception_fil', 'freq_reception_fil'], ['tps_preparation', 'freq_preparation'], ['tps_conditionnement', 'freq_conditionnement'], ['tps_organisation_stock', ''],
  ], xPoidsCommandé, tarif)
  const administration = laborBlock(tarif.get('cout_horaire_administration') ?? 0, [
    ['tps_traitement_of', ''], ['tps_gestion_commande', ''], ['tps_gestion_expedition', ''],
  ], xPoidsCommandé, tarif)

  const laborInfo = (b: { total: number }) => `${num(b.total)} € / ${num(xPoidsCommandé)} kg`
  const mainOeuvreRows: CoutRow[] = [
    { key: 'bonnetier', label: 'Bonnetier', eurPerKg: bonnetier.perKg, info: laborInfo(bonnetier) },
    { key: 'regleur', label: 'Régleur', eurPerKg: regleur.perKg, info: laborInfo(regleur) },
    { key: 'visiteur', label: 'Visiteur', eurPerKg: visiteur.perKg, info: laborInfo(visiteur) },
    { key: 'magasinier', label: 'Magasinier', eurPerKg: magasinier.perKg, info: laborInfo(magasinier) },
    { key: 'administration', label: 'Administration', eurPerKg: administration.perKg, info: laborInfo(administration) },
  ]

  // costPerKg — EXACT original return expression (same operands, same order)
  // so the scalar/line price are bit-identical to the pre-refactor code.
  const costPerKg = (
    FraisStructure
    + xCoutAmortissement
    + xCoutChangementAiguilles
    + xCoutConsoElec
    + bonnetier.perKg
    + regleur.perKg
    + visiteur.perKg
    + magasinier.perKg
    + administration.perKg
  )
  const salePrice = costPerKg > 0 ? costPerKg / (1 - TRM_MARGIN) : 0
  const { retainedPrice, retainedFrom } = retain(costPerKg, floor, baseRole)

  return {
    computable: true,
    IDref_ecru,
    qty: xPoidsCommandé,
    inputs: { gxNbToursKg, gxMinParKg, nbAiguilles, prodAnnuel, jaugeCode: codes.Jauge, diametreCode: codes.diametre },
    sections: [
      { key: 'structure', label: 'Frais de structure', rows: structureRows, subtotalPerKg: FraisStructure },
      { key: 'production', label: 'Frais de production', rows: productionRows, subtotalPerKg: xCoutAmortissement + xCoutChangementAiguilles + xCoutConsoElec },
      { key: 'main_oeuvre', label: "Main d'œuvre", rows: mainOeuvreRows, subtotalPerKg: bonnetier.perKg + regleur.perKg + visiteur.perKg + magasinier.perKg + administration.perKg },
    ],
    costPerKg,
    salePrice,
    floor,
    retainedPrice,
    baseRole,
    retainedFrom,
  }
}

/** Production cost per kg of écru (scalar). Thin wrapper over the breakdown so
 *  the two can never diverge. Returns 0 when not computable (floor wins). */
export async function prixDeRevientTRM(
  IDref_ecru: number,
  xPoidsCommandé: number,
): Promise<number> {
  const detail = await prixDeRevientTRMDetail(IDref_ecru, xPoidsCommandé)
  return detail.costPerKg
}

/** Final tricoteur line prix per the legacy WLanguage at line-save time:
 *
 *    moPrixMargé = PrixDeRevientTRM(IDref_ecru, qty) / (1 - 0.30)
 *    line.prix   = (moPrixMargé > ref_ecru.prix) ? moPrixMargé : ref_ecru.prix
 *
 *  Applied to every line with `type=1` (tricoteur), regardless of which
 *  knitter — the legacy gate is on the line's type, not the sous-traitant
 *  identity. External tricoteurs get TRM's cost model as a starting
 *  reference; the user can override manually after creation.
 *  Rounded to 2 decimals (Arrondi(moPrix, 2)). Thin wrapper over the breakdown
 *  (`retainedPrice` carries the same max/round/margin math).
 *
 *  Stays on the legacy `'price-floor'` rule — this is the ETM → TRM transfer
 *  price and must keep matching the WinDev app that still writes those lines.
 *  The native TRM client-order suggestion deliberately uses `'cost-floor'`
 *  instead; see `TrmBaseRole`. */
export async function trmLinePrix(
  IDref_ecru: number,
  xPoidsCommandé: number,
): Promise<number> {
  const detail = await prixDeRevientTRMDetail(IDref_ecru, xPoidsCommandé)
  return detail.retainedPrice
}
