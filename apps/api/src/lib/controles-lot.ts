// The two controls of a received dye lot (decision Vincent 2026-10-26, order
// 3885 — the fencing-piste matter 119B, which nobody measures by agreement):
//
//   Contrôle ennoblisseur  the dyer's laize, poids AND stabilités (suivilot *_sst)
//   Contrôle Malterre      our laize, poids AND stabilités on the tirelle (*_tirelle)
//
// Each one is switched per finished reference (ref_fini.controle_ennoblisseur /
// controle_malterre, Finis › Références › Informations, both on by default).
// A control asked is due IN FULL: one missing measure keeps the lot from
// « Valider le lot » (lib/cycle-ennoblissement.ts). A control switched off is
// never asked — not by the cycle, nor the Point to the dyer, nor a relance.
//
// The stabilités are a pair (hauteur / largeur) stored 0 when empty, and 0 is
// also a real shrinkage: the pair counts as measured when either side is non-zero
// (prod 2026: no lot holds a genuine 0 / 0).

/** suivilot measures of one side. */
export interface MesuresLot {
  laize: number
  poids: number
  stabH: number
  stabL: number
}

/** What the reference asks (ref_fini). Absent = both asked, the default. */
export interface ControlesRef {
  ennoblisseur: boolean
  malterre: boolean
}

export const CONTROLES_PAR_DEFAUT: ControlesRef = { ennoblisseur: true, malterre: true }

/** The measures still missing for a control asked, in display order. Empty = complete. */
export function mesuresManquantes(m: MesuresLot): string[] {
  const out: string[] = []
  if (!(Number(m.laize) > 0)) out.push('laize')
  if (!(Number(m.poids) > 0)) out.push('poids')
  if (!(Number(m.stabH) !== 0 || Number(m.stabL) !== 0)) out.push('stabilités')
  return out
}

/** ref_fini row → what it asks. Anything but an explicit 0 asks the control. */
export function controlesDeRef(r: { controle_ennoblisseur?: unknown; controle_malterre?: unknown } | undefined): ControlesRef {
  if (!r) return CONTROLES_PAR_DEFAUT
  return { ennoblisseur: Number(r.controle_ennoblisseur ?? 1) !== 0, malterre: Number(r.controle_malterre ?? 1) !== 0 }
}
