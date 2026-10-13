// Qualité › Analyse (LIVA #1289) — the history of every validated lot of a
// fini reference: référentiel vs the dyer's control (« SST ») vs ours (the
// tirelle, « Interne »), with the écart of each control to the référentiel.
// Port of the legacy FI_Analyse_Qualite_ETM (query recovered from its compile
// cache: suivilot WHERE IDetatLot = 3, ordered by date desc).
//
// Rules the legacy did not have, and why:
//  - Référentiel retraits: suivilot.stabX_demandée is 0 on the lots created
//    between 2026-05 and 2026-09-30 (the Linux bridge could not write accented
//    columns) — the fiche's stab_hauteur / stab_largeur stands in, flagged.
//  - Rendement SST: stored only until 2026-06; the legacy value was the lot's
//    Σ metrage / Σ poids over its fini pieces (checked on 10 lots, 2026-10-13),
//    so it is recomputed from the pieces when the column is 0.
//  - A control « was done » when its laize or poids is filled: only then is a
//    0 retrait a real 0 (no shrinkage) instead of « not measured ».
//  - Tolerances come from the CURRENT fiche (same as Suivi lots): laize and
//    poids within [min, max], retrait ≥ the référentiel (shrinkage is negative),
//    rendement within the bounds of lib suivi-lots (gxRendementMini/Maxi).

import { mpsPg } from './mps-pg.js'

/** One raw row of the analysis query (numbers already coerced). */
export interface LotBrut {
  idsuivilot: number
  date: string | null
  lot: string
  reference: string
  coloris: string
  idsous_traitant: number
  sous_traitant: string
  idcommande_sous_traitant: number
  laize_demandee: number
  poids_demande: number
  rendement_demande: number
  stabh_demandee: number
  stabl_demandee: number
  laize_sst: number
  poids_sst: number
  rendement_sst: number
  stabh_sst: number
  stabl_sst: number
  laize_tirelle: number
  poids_tirelle: number
  stabh_tirelle: number
  stabl_tirelle: number
  /** Σ metrage / Σ poids of the lot's fini pieces (null without pieces). */
  rendement_pieces: number | null
  // Current fiche of the reference.
  fiche_laize_min: number
  fiche_laize_max: number
  fiche_poids_min: number
  fiche_poids_max: number
  fiche_stab_hauteur: number
  fiche_stab_largeur: number
  fiche_freinte: number
  fiche_rendement: number
}

export type Mesure = 'laize' | 'poids' | 'rendement' | 'stabh' | 'stabl'
export const MESURES: Mesure[] = ['laize', 'poids', 'rendement', 'stabh', 'stabl']

/** One measure of one lot: référentiel, the two controls, their écarts. */
export interface ValeursMesure {
  ref: number | null
  sst: number | null
  interne: number | null
  ecart_sst: number | null
  ecart_interne: number | null
  /** true = out of tolerance, false = within, null = no tolerance / no value. */
  hors_sst: boolean | null
  hors_interne: boolean | null
}

export interface LotAnalyse {
  idsuivilot: number
  date: string | null
  lot: string
  reference: string
  coloris: string
  idsous_traitant: number
  sous_traitant: string
  idcommande_sous_traitant: number
  /** The retraits' référentiel came from the fiche (lot had none). */
  ref_retraits_fiche: boolean
  /** The SST rendement was recomputed from the pieces. */
  rendement_sst_calcule: boolean
  mesures: Record<Mesure, ValeursMesure>
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d

/** Écart in the measure's unit, rounded so float noise never shows. */
function ecart(mesure: number | null, ref: number | null, decimales: number): number | null {
  if (mesure == null || ref == null) return null
  return round(mesure - ref, decimales)
}

/** Inside [min, max]; a 0 bound is « not set » (HFSQL zero-fill). */
function horsBornes(v: number | null, min: number, max: number): boolean | null {
  if (v == null || (min <= 0 && max <= 0)) return null
  return (min > 0 && v < min) || (max > 0 && v > max)
}

/** Shrinkage is negative: a retrait passes when it is ≥ the référentiel. */
function horsRetrait(v: number | null, ref: number | null): boolean | null {
  if (v == null || ref == null || ref === 0) return null
  return v < ref
}

/** The rendement bounds of Suivi lots (legacy gxRendementMini / Maxi). */
export function bornesRendement(b: LotBrut): { min: number; max: number } {
  const rd = b.rendement_demande
  let min = 0
  let max = 0
  if (rd > 0 && b.fiche_rendement > 0) {
    if (b.fiche_poids_max > 0 && b.fiche_laize_max > 0)
      min = (rd * ((1 - b.fiche_freinte) / ((b.fiche_poids_max * b.fiche_laize_max) / 100000))) / b.fiche_rendement
    if (b.fiche_poids_min > 0 && b.fiche_laize_min > 0)
      max = (rd * ((1 - b.fiche_freinte) / ((b.fiche_poids_min * b.fiche_laize_min) / 100000))) / b.fiche_rendement
  }
  return { min, max }
}

const pos = (v: number): number | null => (v > 0 ? v : null)

export function analyserLot(b: LotBrut): LotAnalyse {
  const controleSst = b.laize_sst > 0 || b.poids_sst > 0
  const controleInterne = b.laize_tirelle > 0 || b.poids_tirelle > 0

  const refRetraitsFiche =
    b.stabh_demandee === 0 && b.stabl_demandee === 0 &&
    (b.fiche_stab_hauteur !== 0 || b.fiche_stab_largeur !== 0)
  const refStabH = refRetraitsFiche ? b.fiche_stab_hauteur : b.stabh_demandee
  const refStabL = refRetraitsFiche ? b.fiche_stab_largeur : b.stabl_demandee
  // A référentiel retrait of 0 is « none » (no lot or fiche states 0 %).
  const refH = refStabH !== 0 ? refStabH : null
  const refL = refStabL !== 0 ? refStabL : null

  const rendementSstCalcule = !(b.rendement_sst > 0) && b.rendement_pieces != null && b.rendement_pieces > 0
  const rdtSst = b.rendement_sst > 0 ? round(b.rendement_sst, 3) : rendementSstCalcule ? round(b.rendement_pieces!, 3) : null
  const rdtRef = pos(b.rendement_demande) != null ? round(b.rendement_demande, 3) : null
  const rdtBornes = bornesRendement(b)

  const laize: ValeursMesure = {
    ref: pos(b.laize_demandee),
    sst: pos(b.laize_sst),
    interne: pos(b.laize_tirelle),
    ecart_sst: ecart(pos(b.laize_sst), pos(b.laize_demandee), 1),
    ecart_interne: ecart(pos(b.laize_tirelle), pos(b.laize_demandee), 1),
    hors_sst: horsBornes(pos(b.laize_sst), b.fiche_laize_min, b.fiche_laize_max),
    hors_interne: horsBornes(pos(b.laize_tirelle), b.fiche_laize_min, b.fiche_laize_max),
  }
  const poids: ValeursMesure = {
    ref: pos(b.poids_demande) != null ? round(b.poids_demande, 1) : null,
    sst: pos(b.poids_sst),
    interne: pos(b.poids_tirelle),
    ecart_sst: ecart(pos(b.poids_sst), pos(b.poids_demande), 1),
    ecart_interne: ecart(pos(b.poids_tirelle), pos(b.poids_demande), 1),
    hors_sst: horsBornes(pos(b.poids_sst), b.fiche_poids_min, b.fiche_poids_max),
    hors_interne: horsBornes(pos(b.poids_tirelle), b.fiche_poids_min, b.fiche_poids_max),
  }
  const rendement: ValeursMesure = {
    ref: rdtRef,
    sst: rdtSst,
    // Never filled by the legacy (1 lot in 5 512) — kept for symmetry.
    interne: null,
    ecart_sst: ecart(rdtSst, rdtRef, 3),
    ecart_interne: null,
    hors_sst: horsBornes(rdtSst, rdtBornes.min, rdtBornes.max),
    hors_interne: null,
  }
  const retrait = (ref: number | null, sstVal: number, intVal: number): ValeursMesure => {
    const sst = controleSst ? sstVal : null
    const interne = controleInterne ? intVal : null
    return {
      ref,
      sst,
      interne,
      ecart_sst: ecart(sst, ref, 1),
      ecart_interne: ecart(interne, ref, 1),
      hors_sst: horsRetrait(sst, ref),
      hors_interne: horsRetrait(interne, ref),
    }
  }

  return {
    idsuivilot: b.idsuivilot,
    date: b.date,
    lot: b.lot,
    reference: b.reference,
    coloris: b.coloris,
    idsous_traitant: b.idsous_traitant,
    sous_traitant: b.sous_traitant,
    idcommande_sous_traitant: b.idcommande_sous_traitant,
    ref_retraits_fiche: refRetraitsFiche,
    rendement_sst_calcule: rendementSstCalcule,
    mesures: {
      laize,
      poids,
      rendement,
      stabh: retrait(refH, b.stabh_sst, b.stabh_tirelle),
      stabl: retrait(refL, b.stabl_sst, b.stabl_tirelle),
    },
  }
}

/** Every validated lot (IDetatLot = 3), newest first — the legacy's scope. */
export async function chargerLotsAnalyse(): Promise<LotAnalyse[]> {
  const sql = mpsPg()
  const rows = await sql<Record<string, unknown>[]>`
    WITH pieces AS (
      SELECT idref_commande_source AS ligne, lot::text AS lot,
             SUM(metrage)::float8 AS metrage, SUM(poids)::float8 AS poids
      FROM stock_fini
      WHERE idref_commande_source > 0
      GROUP BY 1, 2
    )
    SELECT s.idsuivilot,
           to_char(s.date, 'YYYYMMDD') AS date,
           COALESCE(s.lot::text, '') AS lot,
           COALESCE(rf.reference::text, '') AS reference,
           COALESCE(CASE WHEN rf.avec_teinture <> 0 THEN rfc.reference::text ELSE ce.reference::text END, '') AS coloris,
           COALESCE(NULLIF(c.idsous_traitant, 0), s.idsous_traitant, 0) AS idsous_traitant,
           COALESCE(st.nom::text, '') AS sous_traitant,
           COALESCE(s.idcommande_sous_traitant, 0) AS idcommande_sous_traitant,
           COALESCE(s.laize_demandee, 0)::float8 AS laize_demandee,
           COALESCE(s.poids_demande, 0)::float8 AS poids_demande,
           COALESCE(s.rendement_demande, 0)::float8 AS rendement_demande,
           COALESCE(s.stabh_demandee, 0)::float8 AS stabh_demandee,
           COALESCE(s.stabl_demandee, 0)::float8 AS stabl_demandee,
           COALESCE(s.laize_sst, 0)::float8 AS laize_sst,
           COALESCE(s.poids_sst, 0)::float8 AS poids_sst,
           COALESCE(s.rendement_sst, 0)::float8 AS rendement_sst,
           COALESCE(s.stabh_sst, 0)::float8 AS stabh_sst,
           COALESCE(s.stabl_sst, 0)::float8 AS stabl_sst,
           COALESCE(s.laize_tirelle, 0)::float8 AS laize_tirelle,
           COALESCE(s.poids_tirelle, 0)::float8 AS poids_tirelle,
           COALESCE(s.stabh_tirelle, 0)::float8 AS stabh_tirelle,
           COALESCE(s.stabl_tirelle, 0)::float8 AS stabl_tirelle,
           CASE WHEN p.poids > 0 THEN p.metrage / p.poids END AS rendement_pieces,
           COALESCE(rf.laizeht_min, 0)::float8 AS fiche_laize_min,
           COALESCE(rf.laizeht_max, 0)::float8 AS fiche_laize_max,
           COALESCE(rf.poids_min, 0)::float8 AS fiche_poids_min,
           COALESCE(rf.poids_max, 0)::float8 AS fiche_poids_max,
           COALESCE(rf.stab_hauteur, 0)::float8 AS fiche_stab_hauteur,
           COALESCE(rf.stab_largeur, 0)::float8 AS fiche_stab_largeur,
           COALESCE(rf.freinte, 0)::float8 AS fiche_freinte,
           COALESCE(rf.rendement, 0)::float8 AS fiche_rendement
    FROM suivilot s
    LEFT JOIN commande_sous_traitant c ON c.idcommande_sous_traitant = s.idcommande_sous_traitant
    LEFT JOIN sous_traitant st ON st.idsous_traitant = COALESCE(NULLIF(c.idsous_traitant, 0), s.idsous_traitant)
    LEFT JOIN ref_fini rf ON rf.idref_fini = s.idref_fini
    LEFT JOIN ref_fini_colori rfc ON rfc.idref_fini_colori = s.idref_fini_colori
    LEFT JOIN colori_ecru ce ON ce.idcolori_ecru = s.idcoloris
    LEFT JOIN pieces p ON p.ligne = s.idligne_commande_sous_traitant AND p.lot = s.lot::text
    WHERE s.idetatlot = 3
    ORDER BY s.date DESC NULLS LAST, s.idsuivilot DESC`
  return rows.map((r) => analyserLot(versLotBrut(r)))
}

function versLotBrut(r: Record<string, unknown>): LotBrut {
  const num = (k: string) => {
    const v = Number(r[k])
    return Number.isFinite(v) ? v : 0
  }
  const str = (k: string) => String(r[k] ?? '').trim()
  return {
    idsuivilot: num('idsuivilot'),
    date: r.date ? String(r.date) : null,
    lot: str('lot'),
    reference: str('reference'),
    coloris: str('coloris'),
    idsous_traitant: num('idsous_traitant'),
    sous_traitant: str('sous_traitant'),
    idcommande_sous_traitant: num('idcommande_sous_traitant'),
    laize_demandee: num('laize_demandee'),
    poids_demande: num('poids_demande'),
    rendement_demande: num('rendement_demande'),
    stabh_demandee: num('stabh_demandee'),
    stabl_demandee: num('stabl_demandee'),
    laize_sst: num('laize_sst'),
    poids_sst: num('poids_sst'),
    rendement_sst: num('rendement_sst'),
    stabh_sst: num('stabh_sst'),
    stabl_sst: num('stabl_sst'),
    laize_tirelle: num('laize_tirelle'),
    poids_tirelle: num('poids_tirelle'),
    stabh_tirelle: num('stabh_tirelle'),
    stabl_tirelle: num('stabl_tirelle'),
    rendement_pieces: r.rendement_pieces == null ? null : num('rendement_pieces'),
    fiche_laize_min: num('fiche_laize_min'),
    fiche_laize_max: num('fiche_laize_max'),
    fiche_poids_min: num('fiche_poids_min'),
    fiche_poids_max: num('fiche_poids_max'),
    fiche_stab_hauteur: num('fiche_stab_hauteur'),
    fiche_stab_largeur: num('fiche_stab_largeur'),
    fiche_freinte: num('fiche_freinte'),
    fiche_rendement: num('fiche_rendement'),
  }
}
