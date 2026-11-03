// The two controls of a received dye lot (decision Vincent 2026-10-26, order
// 3885 — the fencing-piste matter 119B, which nobody measures by agreement):
//
//   Contrôle ennoblisseur  the dyer's laize, poids, stabilités and vrillage (suivilot *_sst)
//   Contrôle Malterre      our laize, poids, stabilités and vrillage on the tirelle (*_tirelle),
//                          + the coloris against the rond 0 on a dyed fini (lib/coloris-lot.ts, #1332)
//
// Since #1345 (2026-11-02, Pierrot: « nous ne faisions pas les retraits sur les
// bords côtes », lots MA109555 / MA109549 blocked) the reference says WHICH
// measures each side owes, one switch per measure and per side
// (ref_fini.controle_<cote>_laize / _poids / _stab / _vrillage, Finis › Références ›
// Informations, all on by default). A side is asked when at least one of its
// measures is: the stored controle_ennoblisseur / controle_malterre are that
// derived « any » (written by the PUT), kept for the readers that only ask
// « is this side controlled at all ». A measure asked is due: one missing keeps
// the lot from « Valider le lot » (lib/cycle-ennoblissement.ts). A measure not
// asked is never asked: not by the cycle, nor the Point to the dyer, nor a
// relance. The vrillage (lib/vrillage.ts, #1332) joined as a fourth measure the
// same day, asked everywhere by default (Vincent): until then nothing waited for it.
// Never a « nc » typed on the lot: not measuring is a decision on the
// article, taken once, not a way out of one lot.
//
// The stabilités are a pair (hauteur / largeur) stored 0 when empty, and 0 is
// also a real shrinkage: the pair counts as measured when either side is non-zero
// (prod 2026: no lot holds a genuine 0 / 0). The vrillage is NULL when not
// measured and 0 is a real one (lib/vrillage.ts).

/** suivilot measures of one side. */
export interface MesuresLot {
  laize: number
  poids: number
  stabH: number
  stabL: number
  /** NULL / absent = not measured; 0 is a measure. */
  vrillage?: number | null
  /** Malterre only: the coloris is owed (dyed fini, not the rond 0) and not given yet. */
  colorisManquant?: boolean
}

/** The measures a side can be asked, in display order. */
export const MESURES_CONTROLE = ['laize', 'poids', 'stabilites', 'vrillage'] as const
export type MesureControle = (typeof MESURES_CONTROLE)[number]
export type MesuresDemandees = Record<MesureControle, boolean>
export type CoteControle = 'ennoblisseur' | 'malterre'

/** What the reference asks (ref_fini). */
export interface ControlesRef {
  /** The side is asked = at least one of its measures is. */
  ennoblisseur: boolean
  malterre: boolean
  mesures: Record<CoteControle, MesuresDemandees>
}

const TOUTES: MesuresDemandees = { laize: true, poids: true, stabilites: true, vrillage: true }

export const CONTROLES_PAR_DEFAUT: ControlesRef = {
  ennoblisseur: true,
  malterre: true,
  mesures: { ennoblisseur: { ...TOUTES }, malterre: { ...TOUTES } },
}

/** ref_fini column of one measure of one side. */
export function colonneMesure(cote: CoteControle, mesure: MesureControle): string {
  return `controle_${cote}_${mesure === 'stabilites' ? 'stab' : mesure}`
}

/** Every per-measure column, ennoblisseur first. */
export const COLONNES_MESURES: string[] = (['ennoblisseur', 'malterre'] as const).flatMap((c) =>
  MESURES_CONTROLE.map((m) => colonneMesure(c, m)),
)

/** The measures still missing among those asked, in display order. Empty = complete. */
export function mesuresManquantes(m: MesuresLot, demandees: MesuresDemandees = TOUTES): string[] {
  const out: string[] = []
  if (demandees.laize && !(Number(m.laize) > 0)) out.push('laize')
  if (demandees.poids && !(Number(m.poids) > 0)) out.push('poids')
  if (demandees.stabilites && !(Number(m.stabH) !== 0 || Number(m.stabL) !== 0)) out.push('stabilités')
  if (demandees.vrillage && (m.vrillage == null || !Number.isFinite(Number(m.vrillage)))) out.push('vrillage')
  if (m.colorisManquant) out.push('coloris')
  return out
}

const actif = (v: unknown) => Number(v ?? 1) !== 0

/** ref_fini row → what it asks. Anything but an explicit 0 asks; a side stored
 *  0 asks none of its measures, whatever their own switches say. */
export function controlesDeRef(r: Record<string, unknown> | undefined): ControlesRef {
  if (!r) return CONTROLES_PAR_DEFAUT
  const cote = (c: CoteControle): MesuresDemandees => {
    const on = actif(r[`controle_${c}`])
    return {
      laize: on && actif(r[colonneMesure(c, 'laize')]),
      poids: on && actif(r[colonneMesure(c, 'poids')]),
      stabilites: on && actif(r[colonneMesure(c, 'stabilites')]),
      vrillage: on && actif(r[colonneMesure(c, 'vrillage')]),
    }
  }
  const mesures = { ennoblisseur: cote('ennoblisseur'), malterre: cote('malterre') }
  const auMoinsUne = (d: MesuresDemandees) => MESURES_CONTROLE.some((m) => d[m])
  return { ennoblisseur: auMoinsUne(mesures.ennoblisseur), malterre: auMoinsUne(mesures.malterre), mesures }
}

/** The side's stored « any » flag, from its three measure switches. */
export function coteDemande(d: MesuresDemandees): boolean {
  return MESURES_CONTROLE.some((m) => d[m])
}

/** French label of the measures NOT asked by a side that is asked (« stabilités »,
 *  « laize, poids »), for the neutral chip on Suivi lots. Empty = all asked. */
export function mesuresNonDemandees(d: MesuresDemandees): string[] {
  const libelle: Record<MesureControle, string> = { laize: 'laize', poids: 'poids', stabilites: 'stabilités', vrillage: 'vrillage' }
  return MESURES_CONTROLE.filter((m) => !d[m]).map((m) => libelle[m])
}
