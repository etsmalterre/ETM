// The rendement of a dyed lot's rolls (Ml per kg) and the band it is judged by — the legacy's
// gxRendementMini / gxRendementMaxi, read by Qualité › Suivi lots (routes/suivi-lots.ts) and by the espace
// partenaire's lot page (lib/espace-partenaire-commandes.ts). One formula, two readers.
//
// A roll's rendement = its metrage / its poids. The band comes from the lot's rendement asked
// (suivilot.rendement_demande) scaled by the reference's own tolerances: the mini from its heaviest, widest
// fabric (poids max × laize max → fewest metres per kilo), the maxi from its lightest, narrowest. Without the
// reference's figures both bounds are the rendement asked itself; with no rendement asked there is no band.

export interface RefRendement {
  poidsMin: number
  poidsMax: number
  laizeMin: number
  laizeMax: number
  /** ref_fini.freinte, a ratio. */
  freinte: number
  /** ref_fini.rendement, the reference's nominal Ml / kg. */
  rendement: number
}

export interface BornesRendement { mini: number; maxi: number }

/** The band a roll's rendement must fall in, bounds included; null when nothing is asked. */
export function bornesRendement(rendementDemande: number, ref: RefRendement): BornesRendement | null {
  let mini = rendementDemande
  let maxi = rendementDemande
  if (ref.poidsMax > 0 && ref.laizeMax > 0 && ref.rendement > 0) {
    const nominal = (1 - ref.freinte) / ((ref.poidsMax * ref.laizeMax) / 100000)
    mini = (rendementDemande * nominal) / ref.rendement
  }
  if (ref.poidsMin > 0 && ref.laizeMin > 0 && ref.rendement > 0) {
    const nominal = (1 - ref.freinte) / ((ref.poidsMin * ref.laizeMin) / 100000)
    maxi = (rendementDemande * nominal) / ref.rendement
  }
  return mini > 0 || maxi > 0 ? { mini, maxi } : null
}

/** Ml per kg; null for a roll without a weight. */
export function rendementPiece(metrage: number, poids: number): number | null {
  return poids > 0 ? metrage / poids : null
}

/** In the band, out of it, or null when there is nothing to judge. */
export function rendementConforme(rdt: number | null, bornes: BornesRendement | null): boolean | null {
  return rdt == null || !bornes ? null : rdt >= bornes.mini && rdt <= bornes.maxi
}
