// Vrillage of a dyed lot (LIVA #1332, decision Vincent 2026-11-02).
//
// Measured on the tirelle by Malterre (Laetitia) and by the dyer (MATEL's
// « V = …% »), until now typed into the lot's free observations
// (« Vrillage = 5% », « M V 5 % »). ONE measure per side, « vrillage »: the
// columns of stitches drift sideways between the top and the bottom of the
// tirelle. A second « rangs » measure (0051) was dropped the same day by
// Vincent (0053): nobody measures it, one figure is what MATEL sends.
//
// A vrillage is a percentage ≥ 0, in tolerance up to VRILLAGE_MAX included,
// for every reference. NULL = not measured (0 is a real, perfect measure —
// unlike laize / poids / stab, whose 0 means empty).
//
// The link to Qualité › Actions: an action whose `controle` is 'vrillage' has
// its conformité per sst line COMPUTED from the lots' vrillage (verdictLigne),
// over the lots controlled since the action was set up — never typed.

import { mpsPg } from './mps-pg.js'
import type { Conformite } from './actions-qualite.js'

/** In tolerance up to this percentage, included. */
export const VRILLAGE_MAX = 5

/** Highest value a person may type (a typo guard, not a tolerance). */
const VRILLAGE_SAISIE_MAX = 100

export interface VrillagesLot {
  sst: number | null
  tirelle: number | null
}

export const CHAMPS_VRILLAGE = {
  vrillage_sst: 'sst',
  vrillage_tirelle: 'tirelle',
} as const satisfies Record<string, keyof VrillagesLot>

export type ChampVrillage = keyof typeof CHAMPS_VRILLAGE

export class VrillageInvalide extends Error {
  constructor(public champ: ChampVrillage, message: string) { super(message) }
}

/** A typed value → its stored number. Empty = not measured (null). Refuses a
 *  negative value: a vrillage has no direction here. */
export function lireSaisieVrillage(champ: ChampVrillage, v: unknown): number | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim().replace(',', '.').replace(/\s*%$/, '')
  if (s === '') return null
  const x = Number(s)
  if (!Number.isFinite(x)) throw new VrillageInvalide(champ, 'Le vrillage doit être un nombre.')
  if (x < 0) throw new VrillageInvalide(champ, 'Le vrillage ne peut pas être négatif.')
  if (x > VRILLAGE_SAISIE_MAX) throw new VrillageInvalide(champ, `Le vrillage ne peut pas dépasser ${VRILLAGE_SAISIE_MAX} %.`)
  return Math.round(x * 10) / 10
}

/** A stored value → number or null (numeric columns come back as strings). */
export function valeurVrillage(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const x = Number(v)
  return Number.isFinite(x) ? x : null
}

/** null = not measured. */
export function vrillageConforme(v: number | null): boolean | null {
  if (v === null) return null
  return v <= VRILLAGE_MAX
}

/** One lot under a « vrillage » action: either side out of tolerance = non
 *  conforme; the tirelle measured and in tolerance = conforme; no tirelle
 *  measure = non contrôlé — the action asks OUR control on each lot. */
export function verdictLot(v: VrillagesLot): 'conforme' | 'non_conforme' | 'non_controle' {
  if ([v.sst, v.tirelle].some((x) => x !== null && x > VRILLAGE_MAX)) return 'non_conforme'
  if (v.tirelle !== null) return 'conforme'
  return 'non_controle'
}

/** An sst line = its lots: one non conforme makes the line non conforme, every
 *  lot conforme makes it conforme, anything else is still to control. */
export function verdictLigne(lots: VrillagesLot[]): Conformite {
  const v = lots.map(verdictLot)
  if (v.includes('non_conforme')) return 'non_conforme'
  if (v.length > 0 && v.every((x) => x === 'conforme')) return 'conforme'
  return 'non_controle'
}

/** The vrillage written in a lot's observations before ETM had the fields:
 *  « Vrillage = 5% » / « Vrillage = 5 à 7% » (tirelle, the worst value kept)
 *  or « V = 6% », and « M V 5 % » / « MV 5% » / « vrillage mesuré matel : 5 % »
 *  (MATEL). A « léger vrillage » has no value. */
export function vrillagesDesObservations(texte: string): { tirelle: number | null; sst: number | null } {
  const max = (a: string, b?: string) => Math.max(Number(a.replace(',', '.')), b ? Number(b.replace(',', '.')) : -Infinity)
  const t = /vrillage\s*[=:]?\s*(\d+(?:[.,]\d+)?)\s*(?:%?\s*(?:à|a|-)\s*(\d+(?:[.,]\d+)?))?\s*%/i.exec(texte)
    ?? /(?:^|\s)V\s*=\s*(\d+(?:[.,]\d+)?)\s*%/.exec(texte)
  const s = /(?:^|[^A-Za-z])M\s?V\s*[=:]?\s*(\d+(?:[.,]\d+)?)\s*%/.exec(texte)
    ?? /vrillage\s+mesur\S*\s+matel\s*:?\s*(\d+(?:[.,]\d+)?)\s*%/i.exec(texte)
  return { tirelle: t ? max(t[1], t[2]) : null, sst: s ? max(s[1]) : null }
}

// ── Reads ────────────────────────────────────────────────

/** The two measures of one lot. */
export async function vrillagesDuLot(idsuivilot: number): Promise<VrillagesLot> {
  const [r] = await mpsPg()<Record<string, unknown>[]>`
    SELECT vrillage_sst, vrillage_tirelle
    FROM suivilot WHERE idsuivilot = ${idsuivilot}`
  return depuisLigne(r)
}

function depuisLigne(r: Record<string, unknown> | undefined): VrillagesLot {
  return {
    sst: valeurVrillage(r?.vrillage_sst),
    tirelle: valeurVrillage(r?.vrillage_tirelle),
  }
}

export async function ecrireVrillages(idsuivilot: number, v: VrillagesLot): Promise<void> {
  await mpsPg()`
    UPDATE suivilot SET vrillage_sst = ${v.sst}, vrillage_tirelle = ${v.tirelle}
    WHERE idsuivilot = ${idsuivilot}`
}

/** The actions qualité followed by a measure: id → the date they were set up
 *  ('YYYY-MM-DD'). Only 'vrillage' exists. */
export async function actionsSuiviesParVrillage(): Promise<Map<number, string>> {
  const rows = await mpsPg()<{ id: string; depuis: string | null }[]>`
    SELECT idaction_qualite AS id, to_char(date_creation, 'YYYY-MM-DD') AS depuis
    FROM action_qualite WHERE controle = 'vrillage'`
  return new Map(rows.map((r) => [Number(r.id), r.depuis ?? '0000-00-00']))
}

export interface VerdictCalcule {
  conformite: Conformite
  /** Lots counted (controlled since the action was set up). */
  lots: Array<{ lot: string; verdict: ReturnType<typeof verdictLot>; vrillage: VrillagesLot }>
}

/** Each sst line's verdict under a « vrillage » action set up on `depuis`:
 *  computed over the line's lots dated that day or later. A line with no such
 *  lot is left out — its stored verdict (if any) stays. */
export async function verdictsVrillage(ligneIds: number[], depuis: string): Promise<Map<number, VerdictCalcule>> {
  const out = new Map<number, VerdictCalcule>()
  const ids = [...new Set(ligneIds.filter((x) => x > 0))]
  if (ids.length === 0) return out
  const rows = await mpsPg()<Record<string, unknown>[]>`
    SELECT idligne_commande_sous_traitant AS ligne, trim(lot::text) AS lot,
           vrillage_sst, vrillage_tirelle
    FROM suivilot
    WHERE idligne_commande_sous_traitant = ANY(${ids}) AND date >= ${depuis}::date
    ORDER BY date, idsuivilot`
  const parLigne = new Map<number, VerdictCalcule['lots']>()
  for (const r of rows) {
    const ligne = Number(r.ligne)
    const v = depuisLigne(r)
    const arr = parLigne.get(ligne) ?? []
    arr.push({ lot: String(r.lot ?? ''), verdict: verdictLot(v), vrillage: v })
    parLigne.set(ligne, arr)
  }
  for (const [ligne, lots] of parLigne) out.set(ligne, { conformite: verdictLigne(lots.map((l) => l.vrillage)), lots })
  return out
}
