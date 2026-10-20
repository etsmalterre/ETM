// Which weight band of a dyer's tariff (`tranche_tarif_ennoblissement`) a
// weight falls in: the ONE rule for every price read from those bands
// (LIVA #1301, decision Vincent 2026-10-20).
//
// Bands are typed in whole kilos with a one-kilo step between them: 221–240,
// 241–260, … 281–300, 301 et plus. A band « 221–240 » covers 221,00 to
// 240,99 kg: the weight is truncated to the kilo, as the legacy did and as
// MATEL bills (20,3 kg in 16–20, 60,61 in 41–60, 120,7 in 101–120: 7 invoiced
// lots priced to the cent, 2026). The old test `mini <= poids <= maxi` left
// 240,7 kg and 300,2 kg in no band: the agent Factures Ennoblisseur read
// « pas de tarif » / « tarif incomplet » and an sst line auto-price lost its
// dye. Only MATEL's lots of 300,x kg were billed in « 301 et plus »: they now
// read as billed below the tariff, which is no gap.

/** The whole kilo a weight is banded at: rounded to the gram first, so a
 *  float sum like 240,99999999 stays 241, then truncated. */
export function kgTranche(poids: number): number {
  return Math.floor(Math.round(poids * 1000) / 1000)
}

/** True when the band [mini, maxi] (whole kilos) covers `poids`. */
export function dansTranche(b: { quantite_mini: number; quantite_maxi: number }, poids: number): boolean {
  const kg = kgTranche(poids)
  return Number(b.quantite_mini) <= kg && Number(b.quantite_maxi) >= kg
}

/** Price of the band covering `poids`, 0 when none does: the legacy treats
 *  an unpriced treatment as free, and several really are (Vaporisage, Rame). */
export function prixTranche(bands: readonly { quantite_mini: number; quantite_maxi: number; prix: number }[], poids: number): number {
  const b = bands.find((x) => dansTranche(x, poids))
  return b ? Number(b.prix) || 0 : 0
}
