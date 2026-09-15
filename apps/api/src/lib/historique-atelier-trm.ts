// Historique — the pure rules of the atelier PWA's « Historique » screen
// (legacy FEN_Historique, régleur build `Android\gen\Compile`, 2026-05-25).
//
// Kept out of routes/atelier.ts so the numbers can be unit-tested without a
// database and so the ERP's Production tab (routes/of-trm.ts, whose per-piece
// % is a documented approximation) can adopt the recovered formula later.
//
// Legacy, verbatim (ZR_Prod initialisation):
//
//   reqParam: select * from ref_ecru_machine
//             where IDref_ecru = {pIDRefEcru} AND IDmachine = {pIDMachine}
//   si reqParam.nb_chutes = 0 ou reqParam.trs_10kg_chute = 0 alors
//       duDuréePieceMini.Minute = 0
//   sinon
//       xTrsPar10Kgs = reqParam.trs_10kg_chute / reqParam.nb_chutes
//       xKgParTour   = 10 / xTrsPar10Kgs
//       xKgParMin    = 20 * xKgParTour          // 20 tours par minute, en dur
//       duDuréePieceMini.Minute = ref_ecru.poids / xKgParMin
//
//   POUR TOUTE req (piece_production, order by IDpiece_production desc)
//       SI DateHeureValide(date_debut) ET DateHeureValide(date_fin) ALORS
//           d = date_fin − date_debut
//           xProductivité = d.EnMinutes = 0 ? 0 : duDuréePieceMini.EnMinutes / d.EnMinutes
//           sDurée = Arrondi(d.EnMinutes, 0) + " min"
//       SI xProductivité < 0.7 ALORS CouleurProd = RougeClair
//       SI xProductivité > 1.2 ALORS xProductivité = 1.2 ; CouleurProd = RougeClair
//       AjouteLigne(IDpiece_production, i, "Pièce N° " + i, sDurée, xProductivité, CouleurProd)
//       i--                                     // i starts at NbEnr(): a POSITION, not `numero`
//
// ⚠️ NOT the counter formula (`compteurFor` in routes/atelier.ts) and NOT the
// ERP's `vitesse`-based estimate: three different numbers off the same two
// `ref_ecru_machine` columns. Do not unify them.
//
// ⚠️ The legacy takes `ref_ecru.poids`, not `ordre_fabrication.poids_piece`
// (the poste's counter took the opposite choice, for a stated reason). The
// route passes the reference weight and falls back to the OF's only when the
// reference has none — the phone must print the same % as the Android app
// still in service next to it.

/** Theoretical minutes for one piece, or null when the sheet cannot say
 *  (no `ref_ecru_machine` row, a zero divisor, no weight). The legacy stores 0
 *  minutes in that case and every piece then reads 0 % red; null lets the
 *  screen show « — » instead of a wall of red on an un-sheeted reference. */
export function dureeMinimalePiece(
  trs10kgChute: number,
  nbChutes: number,
  poidsPiece: number,
): number | null {
  if (!(trs10kgChute > 0) || !(nbChutes > 0) || !(poidsPiece > 0)) return null
  const toursPar10Kg = trs10kgChute / nbChutes
  const kgParTour = 10 / toursPar10Kg
  const kgParMin = 20 * kgParTour
  return poidsPiece / kgParMin
}

/** The productivity cap: above it the legacy clamps the value AND paints it
 *  red — a piece knitted "too fast" is a wrong timestamp, not a good piece. */
export const PRODUCTIVITE_MAX = 1.2
/** Below it the piece is red. */
export const PRODUCTIVITE_MIN = 0.7

export interface ProductivitePiece {
  /** Rounded percentage, capped at 120. */
  pct: number
  /** The legacy's RougeClair: under 70 % or over the cap. */
  alerte: boolean
}

/** Productivity of one finished piece. `null` when the piece is not finished
 *  (no end stamp, or an end before its start) or when no minimum applies —
 *  the legacy shows an empty duration and a 0 gauge for those. */
export function productivitePiece(
  dureeMiniMin: number | null,
  dureeMin: number | null,
): ProductivitePiece | null {
  if (dureeMiniMin === null || dureeMin === null) return null
  if (!(dureeMin > 0)) return null
  let ratio = dureeMiniMin / dureeMin
  let alerte = ratio < PRODUCTIVITE_MIN
  if (ratio > PRODUCTIVITE_MAX) {
    ratio = PRODUCTIVITE_MAX
    alerte = true
  }
  return { pct: Math.round(ratio * 100), alerte }
}

/** Whole minutes between two stamps — `Arrondi(d.EnMinutes, 0)` — or null when
 *  either is missing or the end is not after the start. */
export function dureeMinutes(debutMs: number | null, finMs: number | null): number | null {
  if (debutMs === null || finMs === null) return null
  if (finMs <= debutMs) return null
  return Math.round((finMs - debutMs) / 60000)
}
