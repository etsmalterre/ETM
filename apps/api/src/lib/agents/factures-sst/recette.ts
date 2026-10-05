// How ETM's price of a dyed lot is made, as the person checking an invoice
// reads it (Sous-traitants › Factures, expanded line — decision Vincent
// 2026-10-05): the weight band picks the tariff rows, the fabric's rendement
// picks MATEL's multiplier, then a dye (or a combination of treatments) plus
// each remaining treatment add up to the €/kg. Pure: it only turns the
// pricing engine's trace (pricing-sst.ts PrixBreakdown) into labelled
// ingredients. Tests: recette.test.ts.

import { ESAT_IDSOUS_TRAITANT, MATEL_IDSOUS_TRAITANT, SIMPLE_TEINTURE_IDTEINTURE, bandeMatel, type PrixBreakdown } from '../../pricing-sst.js'

export interface Ingredient {
  /** What it is: « Coloration Simple Teinture », « Lavage »… */
  libelle: string
  /** teinture = the base dye; combinaison = several treatments priced as one
   *  row; traitement = one treatment added on top. */
  genre: 'teinture' | 'combinaison' | 'traitement'
  /** The tariff row's price, €/kg. */
  brut: number
  /** What it adds to the price after MATEL's multiplier, €/kg. */
  applique: number
  /** True when the rendement multiplier was applied to it. */
  multiplie: boolean
}

export interface RecettePrix {
  /** The weight the band was chosen on, and the band's limits (kg). */
  tranche: { poids: number; mini: number | null; maxi: number | null }
  /** ref_fini.rendement (Ml/kg) and the multiplier it gives (1 = none). */
  rendement: number
  multiplicateur: number
  /** MATEL's rendement band the fabric falls in — (de, a] — null when the dyer
   *  applies no rendement grid (only MATEL / ESAT do). */
  bandeRendement: { de: number | null; a: number | null } | null
  ingredients: Ingredient[]
  /** Treatments of the reference no tariff row prices (they count 0 €). */
  sansTarif: string[]
  /** €/kg, rounded — the agent's « tarif ETM ». */
  total: number
}

export interface Noms {
  traitement: (id: number) => string
  teinture: (id: number) => string
}

export function recette(bd: PrixBreakdown, noms: Noms, tranche: { mini: number | null; maxi: number | null }): RecettePrix {
  const ingredients: Ingredient[] = []
  if (bd.base?.kind === 'dye-only') {
    const st = bd.base.IDteinture === SIMPLE_TEINTURE_IDTEINTURE && bd.avec_teinture === 0
    ingredients.push({
      libelle: noms.teinture(bd.base.IDteinture) + (st ? ' (écru)' : ''),
      genre: 'teinture',
      brut: bd.base.raw_prix,
      applique: bd.base.applied_prix,
      multiplie: Math.abs(bd.base.applied_prix - bd.base.raw_prix) > 1e-9,
    })
  } else if (bd.base?.kind === 'combination') {
    ingredients.push({
      libelle: bd.base.covered.map(noms.traitement).join(' + ') || 'Combinaison',
      genre: 'combinaison',
      brut: bd.base.raw_prix,
      applique: bd.base.applied_prix,
      multiplie: false,
    })
  }
  for (const t of bd.treatments) {
    ingredients.push({ libelle: noms.traitement(t.IDtraitement), genre: 'traitement', brut: t.raw_prix, applique: t.applied_prix, multiplie: t.matel_applied })
  }
  return {
    tranche: { poids: bd.xPoids, ...tranche },
    rendement: bd.rendement,
    multiplicateur: bd.matel_multiplier,
    bandeRendement: bd.IDsous_traitant === MATEL_IDSOUS_TRAITANT || bd.IDsous_traitant === ESAT_IDSOUS_TRAITANT
      ? (({ de, a }) => ({ de, a }))(bandeMatel(bd.rendement))
      : null,
    ingredients,
    sansTarif: bd.unpriced_treatments.map(noms.traitement),
    total: bd.total,
  }
}
