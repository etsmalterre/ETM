// A tombé de métier is sold by the kg (LIVA #1144) and has no rendement any more: ref_ecru.rendement
// is retired (decision Vincent 2026-10-26, lib/freinte-tricotage.ts) — in knitting one speaks of
// yarn in and matter out, in kg; the Ml becomes the unit at the stenter (ref_fini.rendement).
// Only 5 écru lines were ever written in Ml, all soldées.

/** Line types (ligne_commande_client / ligne_devis_etm `type`): 1 = écru. Unit 3 = Ml. */
export function ecruEnMl(type: unknown, unite: unknown): boolean {
  return Number(type) === 1 && Number(unite) === 3
}

export const MESSAGE_ECRU_EN_ML = 'Un tombé de métier se vend au kilo : choisissez l’unité Kg.'
