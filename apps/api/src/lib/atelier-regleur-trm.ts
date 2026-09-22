// Atelier PWA — the régleur's tile rules (legacy FEN_Choix_Metier, configuration
// "Appli_Regleur").
//
// The régleur build of the legacy Android app lives in
// `C:\Mes Projets\MPS\Android\gen\Compile\` (dated 2026-05-25), NOT in `dbg\`
// (the bonnetier build of 2026-03-24). Its machine list adds three things to
// every active tile that the bonnetier never sees: a state icon (réglage /
// pause / marche), a stop figure on a bell, and a second-choice ratio — and an
// alert flag combining the last two. Everything here is pure so it can be
// tested without a base; routes/atelier.ts feeds it the rows.
//
// Legacy, verbatim (FEN_Choix_Metier.ZR_Machine init + local procedures):
//
//   si pas DateValide(reqMachine.demarrage_prod) alors imgEtat = "reglage1.png"
//   sinon si DateValide(reqMachine.arret_prod)   alors imgEtat = "pause1.png"
//   sinon                                              imgEtat = "play1.png"
//
//   nFreqArret = FrequenceArret(IDordre_fabrication)
//   pctDefaut  = PourcentageDefauts()
//   bAlert     = (pctDefaut > 0.02 ou nFreqArret > 1)
//   SI bAlert = Faux ALORS pctDefaut = 0
//
//   // Donne la fréquence d'arret par heure sur les dernieres 24H ou depuis le
//   // debut de l'OF si inferieur a 24H
//   procédure FrequenceArret(nIDOrdreFabrication)
//     dhDateRef = DateHeureSys() - 24 h
//     si ordre_fabrication.demarrage_prod > dhDateRef alors dhDateRef = demarrage_prod
//     reqArrets          = count(evenement_machine) where IDmachine = … and date >= dhDateRef and etat = 0
//     reqEvenementPiece  = count(evenement_piece join piece_production on OF)
//                          where date >= dhDateRef and evenement in ('Nettoyage','Fin du tricotage')
//     duInterval = DateHeureDifférence(dhDateRef, DateSys)
//     si duInterval.EnMinutes = 0 renvoyer 0
//     FreqArret = Arrondi((reqArrets.total - reqEvenementPiece.total) * 60 / duInterval.EnMinutes)
//     si FreqArret < 0 alors FreqArret = 0
//
//   procédure PourcentageDefauts()
//     reqSecondChoix = SELECT top 100 date_saisie, poids, second_choix FROM stock_ecru
//                      WHERE IDref_ecru = … AND IDcolori_ecru = … ORDER BY date_saisie DESC
//     POUR TOUTE reqSecondChoix
//       xPoidsTotal += poids ; SI second_choix ALORS xPoidsSecondChoix += poids
//       SI xPoidsTotal >= 1000 ALORS SORTIR
//     renvoyer xPoidsSecondChoix / xPoidsTotal   (0 quand xPoidsTotal = 0)
//
// ⚠️ The bell number is NOT ported as written — the legacy's is a bug.
// `FrequenceArret` divides 24 h of stops by `DateHeureDifférence(dhDateRef,
// DateSys)`, and `DateSys` is the system DATE: the interval runs from the
// window start to TODAY'S MIDNIGHT while both counts run up to now. At 17:37
// that inflates the hourly rate ×3.8, just before midnight it explodes, and
// an OF started today gets a negative interval, hence no bell at all. Checked
// on prod on 2026-09-14: every tile of the Android app (4 / 4 / 2 / 3 / 6 /
// nothing) reproduces from the honest counts once divided by the minutes to
// midnight; the honest hourly rate reads "1" on every métier and tells the
// régleur nothing.
//
// Decision (user, 2026-09-14): the bell carries the TRS tablet's number
// instead — the mean of unexplained stops PER PIECE over the last
// ARRETS_PIECES finished pieces of the active OF (`arretsParPiece()` in
// trs-trm.ts, read by lib/arrets-par-piece-trm.ts for both callers). It is
// what the régleurs learned to read the legacy bell as ("about 4 stops per
// roll"), it is the number already on the wall, and it does not depend on
// the time of day. Alert threshold = above 1 stop per piece, the tablet's own
// amber step (apps/trs lib/affichage.ts `teinteArrets`). The second-choice
// ratio and its 2 % alert threshold are the legacy's, unchanged.
//
// ⚠️ The legacy's "zeroed without alert" rule is NOT kept (2026-09-22). The
// régleur tile used to blank the % unless the bell was on; Vincent wants BOTH
// roles to see the second-choice ratio as soon as it passes 1 %, bell or not —
// a bonnetier who reads « 1,5 % » on their tile knits more carefully. So the
// ratio travels raw on every machine list (`of.pct_defaut`, no `?regleur=1`
// needed — routes/atelier.ts `pctDefautDesOfs`), and the tile alone decides
// from which figure it shows the pill (ChoixMetier.tsx `SEUIL_PCT_DEFAUT`,
// 1 %). The red frame fires at the legacy's 2 % for both roles
// (`of.alerte_defaut`, `alerteDefaut`); the régleur's `alerte` adds the stops.
//
// One reading of the legacy worth keeping in mind: the second-choice ratio is
// by WEIGHT over the most recent rolls of the (reference, coloris) pair — all
// OFs, all machines — stopped at the first roll that carries the running total
// to 1 000 kg, or at 100 rolls.

import type { ArretsParPiece } from './trs-trm.js'

export type EtatMetier = 'reglage' | 'pause' | 'marche'

/** The three tile icons of the régleur list. `demarre` / `interrompu` are the
 *  parsed-date booleans routes/atelier.ts already derives for every tile. */
export function etatMetier(demarre: boolean, interrompu: boolean): EtatMetier {
  if (!demarre) return 'reglage'
  if (interrompu) return 'pause'
  return 'marche'
}

/** Legacy threshold — `bAlert = (pctDefaut > 0.02 ou …)`. */
export const SEUIL_PCT_DEFAUT = 0.02
/** Above this many unexplained stops per piece the bell lights up — the TRS
 *  tablet's amber step (`teinteArrets`: ≤ 1 green, ≤ 3 amber, more red). */
export const SEUIL_ARRETS_PIECE = 1

export interface RouleauPoids {
  poids: number
  second_choix: boolean
}

/** Second-choice weight ratio over the most recent rolls (already ordered by
 *  `date_saisie DESC`, at most 100), stopping once 1 000 kg have been seen. */
export function pourcentageDefauts(rouleaux: RouleauPoids[]): number {
  let total = 0
  let second = 0
  for (const r of rouleaux.slice(0, 100)) {
    total += r.poids
    if (r.second_choix) second += r.poids
    if (total >= 1000) break
  }
  return total > 0 ? second / total : 0
}

export interface AlerteRegleur {
  alerte: boolean
  /** The TRS tablet's `arretsParPiece` for the OF — `moyenne` null until the
   *  OF has a finished piece. Never zeroed: the bell number is informative
   *  on its own, only its colour follows the alert. */
  arrets_piece: ArretsParPiece
}

/** The second-choice half of the alert, on its own: the red frame of the tile
 *  for BOTH roles (Vincent, 2026-09-22 — one trigger, the legacy's 2 %). Sent
 *  as `of.alerte_defaut` on every machine list; the régleur's `alerte` adds
 *  the stops. */
export function alerteDefaut(pctDefaut: number): boolean {
  return pctDefaut > SEUIL_PCT_DEFAUT
}

/** The régleur's alert. `pctDefaut` is the raw ratio the machine list already
 *  carries for everyone (`of.pct_defaut`): an input here, never an output. */
export function alerteRegleur(pctDefaut: number, arrets: ArretsParPiece): AlerteRegleur {
  const tropDArrets = arrets.moyenne !== null && arrets.moyenne > SEUIL_ARRETS_PIECE
  const alerte = alerteDefaut(pctDefaut) || tropDArrets
  return { alerte, arrets_piece: arrets }
}
