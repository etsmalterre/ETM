// Atelier PWA — the régleur's tile rules (legacy FEN_Choix_Metier, configuration
// "Appli_Regleur").
//
// The régleur build of the legacy Android app lives in
// `C:\Mes Projets\MPS\Android\gen\Compile\` (dated 2026-05-25), NOT in `dbg\`
// (the bonnetier build of 2026-03-24). Its machine list adds three things to
// every active tile that the bonnetier never sees: a state icon (réglage /
// pause / marche), a stop frequency, and a second-choice ratio — and an alert
// flag combining the last two. Everything here is pure so it can be tested
// without a base; routes/atelier.ts feeds it the rows.
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
// Two readings of the legacy worth keeping in mind:
//  - The stop count subtracts the *expected* stops (a Nettoyage and a Fin de
//    pièce each stop the métier on purpose), so the frequency is the rate of
//    UNEXPLAINED stops per hour. It can go negative on paper; the legacy clamps.
//  - The second-choice ratio is by WEIGHT over the most recent rolls of the
//    (reference, coloris) pair — all OFs, all machines — stopped at the first
//    roll that carries the running total to 1 000 kg, or at 100 rolls.

export type EtatMetier = 'reglage' | 'pause' | 'marche'

/** The three tile icons of the régleur list. `demarre` / `interrompu` are the
 *  parsed-date booleans routes/atelier.ts already derives for every tile. */
export function etatMetier(demarre: boolean, interrompu: boolean): EtatMetier {
  if (!demarre) return 'reglage'
  if (interrompu) return 'pause'
  return 'marche'
}

/** Seuils du legacy — `bAlert = (pctDefaut > 0.02 ou nFreqArret > 1)`. */
export const SEUIL_PCT_DEFAUT = 0.02
export const SEUIL_FREQ_ARRET = 1

export const FENETRE_FREQ_ARRET_MS = 24 * 3600_000

/** The reference instant the stop frequency is measured from: the start of the
 *  OF, or 24 h ago when the OF is older than that. Null when the OF has not
 *  started (the legacy would compute on a blank date; the régleur list shows
 *  a réglage tile there, with no frequency). */
export function debutFenetreArrets(demarrageMs: number | null, nowMs: number): number | null {
  if (demarrageMs === null) return null
  const ref = nowMs - FENETRE_FREQ_ARRET_MS
  return demarrageMs > ref ? demarrageMs : ref
}

/** Unexplained stops per hour since `debutMs`.
 *
 *  @param arretsMs       timestamps of the métier's `evenement_machine` rows
 *                        with `etat = 0` (any window — filtered here)
 *  @param evenementsMs   timestamps of the OF's `evenement_piece` rows whose
 *                        `evenement` is 'Nettoyage' or 'Fin du tricotage'
 */
export function frequenceArret(
  debutMs: number | null,
  nowMs: number,
  arretsMs: number[],
  evenementsMs: number[],
): number {
  if (debutMs === null) return 0
  const minutes = Math.floor((nowMs - debutMs) / 60_000)
  if (minutes <= 0) return 0
  const arrets = arretsMs.filter((t) => t >= debutMs).length
  const attendus = evenementsMs.filter((t) => t >= debutMs).length
  const freq = Math.round(((arrets - attendus) * 60) / minutes)
  // `<= 0`, not `< 0`: Math.round(-0.25) is -0, which `< 0` lets through and
  // the JSON then carries as a bare 0 — harmless on the wire, wrong in a test.
  return freq <= 0 ? 0 : freq
}

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
  /** Zeroed when there is no alert, exactly as the legacy tile does. */
  pct_defaut: number
  freq_arret: number
}

export function alerteRegleur(pctDefaut: number, freqArret: number): AlerteRegleur {
  const alerte = pctDefaut > SEUIL_PCT_DEFAUT || freqArret > SEUIL_FREQ_ARRET
  return { alerte, pct_defaut: alerte ? pctDefaut : 0, freq_arret: freqArret }
}
