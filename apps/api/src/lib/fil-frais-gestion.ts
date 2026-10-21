// The « frais de gestion » on yarn purchases (Vincent, 2026-10-21, LIVA #1298).
//
// Every yarn ETS Malterre buys carries 5 % of admin cost: Pierrot asks the
// suppliers for offers, keeps one, and the yarn's base price
// (`ref_fil.prix_kg` / `colori_fil.prix_kg`) is that offer × 1.05. The base
// price therefore already INCLUDES the 5 % — nothing in the legacy data says
// so. This module is the one place that knows it, so every screen can show
// the split (purchase price + gestion) instead of a single opaque figure.
//
// Not to be confused with the « +5 % (carton, plastiques …) » packaging
// majoration on ennoblissement lines (pricing-fini-tarif.ts) — same number,
// unrelated cost.

/** The rate, in percent. */
export const FRAIS_GESTION_FIL_PCT = 5

function round4(v: number): number {
  return Math.round(v * 10000) / 10000
}

/** Base €/Kg from a purchase price: what « Retenir l'offre » writes. Rounded
 *  to the centime, like every price typed in Fils › Références. */
export function prixBaseDepuisAchat(achat: number, tauxPct: number = FRAIS_GESTION_FIL_PCT): number {
  return Math.round((Number(achat) || 0) * (1 + tauxPct / 100) * 100) / 100
}

/** Purchase €/Kg hidden in a base price (the inverse of the rule above). */
export function achatDepuisPrixBase(prix: number, tauxPct: number = FRAIS_GESTION_FIL_PCT): number {
  return (Number(prix) || 0) / (1 + tauxPct / 100)
}

/** €/Kg of a simulation line: its purchase price plus the gestion lever.
 *  Rounded to 4 decimals so 3.77142857 × 1.05 lands back on 3.96 exactly and
 *  a simulation copied from a reference reproduces the reference's price. */
export function prixAvecGestion(achat: number, tauxPct: number): number {
  return round4((Number(achat) || 0) * (1 + (Number(tauxPct) || 0) / 100))
}
