// Tâches d'atelier — the general jobs of the factory the bonnetiers do when few
// métiers run (cobwebs in the stock, the workshop floors…). Decision Vincent
// 2026-11-05. Tables: migration 0061 (`tache_atelier`, `…_realisation`,
// `…_participant`); routes: routes/atelier-taches.ts (`/api/atelier/taches`).
//
// The rules, all here:
//   - a task is a STANDING item: « Fait » adds a dated réalisation, the task
//     stays on the list — they recur, and a list that empties itself would be
//     re-typed every week;
//   - the list is sorted red, amber, then the OLDEST last réalisation first
//     (never done = top), so the neglected job rises by itself;
//   - a réalisation = the server's hour + its team: whoever declares it is in
//     the team by right, plus the coéquipiers he ticks (any live bonnetier,
//     régleurs included);
//   - only the declarer may cancel it, within DELAI_ANNULATION_MS (a wrong tap),
//     then it is history;
//   - only a régleur creates / edits / removes a task; « Supprimer » archives,
//     the réalisations stay;
//   - hour only, no duration. In-app only, no ERP screen yet;
//   - an optional frequency in days (régleur, migration 0062) colours the
//     « il y a N j » tag: red from F, amber from F − 10 %, green below
//     (`niveauTache`, Vincent 2026-11-05); without one the tag stays grey.

export const DELAI_ANNULATION_MS = 10 * 60 * 1000
export const LIBELLE_MAX = 120
export const DESCRIPTION_MAX = 1000
export const EQUIPE_MAX = 12

/** The team of a réalisation: the declarer first, then each coéquipier once.
 *  Unknown or archived ids are dropped by the caller (it holds the directory);
 *  returns null when the team is larger than any real job. */
export function equipeRealisation(declarant: number, coequipiers: number[]): number[] | null {
  const out = [declarant]
  for (const id of coequipiers) if (Number.isInteger(id) && id > 0 && !out.includes(id)) out.push(id)
  return out.length > EQUIPE_MAX ? null : out
}

export function annulableJusqua(faitLeMs: number): number {
  return faitLeMs + DELAI_ANNULATION_MS
}

export function peutAnnuler(r: { declare_par: number; fait_le_ms: number }, idBonnetier: number, nowMs: number): boolean {
  return r.declare_par === idBonnetier && nowMs < annulableJusqua(r.fait_le_ms)
}

export const FREQUENCE_MAX = 365
const JOUR_MS = 24 * 60 * 60 * 1000

/** Whole days since the last réalisation (24 h periods, like the phone's
 *  « il y a N j »); null when never done. */
export function ageJours(derniereMs: number | null, nowMs: number): number | null {
  return derniereMs === null ? null : Math.max(0, Math.floor((nowMs - derniereMs) / JOUR_MS))
}

/** First day of amber: the frequency minus 10 %, at least one day before it
 *  (30 → 27, 7 → 6). */
export function seuilAmbre(frequence: number): number {
  return frequence - Math.max(1, Math.ceil(frequence * 0.1))
}

export type NiveauTache = 'rouge' | 'ambre' | 'vert'

/** The tag colour (decision Vincent 2026-11-05). Red = due: to do now. Amber =
 *  due within 10 % of the frequency: can be done now, ahead. Green = done
 *  recently enough. No frequency = no colour (null). A task with a frequency
 *  that was never done is due. */
export function niveauTache(frequence: number | null, derniereMs: number | null, nowMs: number): NiveauTache | null {
  if (!frequence || frequence <= 0) return null
  const age = ageJours(derniereMs, nowMs)
  if (age === null || age >= frequence) return 'rouge'
  if (age >= seuilAmbre(frequence)) return 'ambre'
  return 'vert'
}

const RANG: Record<NiveauTache, number> = { rouge: 0, ambre: 1, vert: 2 }

/** Red, then amber, then everything else; inside a group never done first (by
 *  name), then the oldest last réalisation first. */
export function trierTaches<T extends { libelle: string; derniere_ms: number | null; niveau?: NiveauTache | null }>(
  taches: T[],
): T[] {
  const rang = (t: T) => (t.niveau === 'rouge' || t.niveau === 'ambre' ? RANG[t.niveau] : 2)
  return [...taches].sort((a, b) => {
    const r = rang(a) - rang(b)
    if (r !== 0) return r
    if (a.derniere_ms === null && b.derniere_ms === null) return a.libelle.localeCompare(b.libelle, 'fr')
    if (a.derniere_ms === null) return -1
    if (b.derniere_ms === null) return 1
    return a.derniere_ms - b.derniere_ms || a.libelle.localeCompare(b.libelle, 'fr')
  })
}
