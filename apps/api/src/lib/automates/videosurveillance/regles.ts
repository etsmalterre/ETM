// Vidéosurveillance — the pure rules (tested in regles.test.ts).
//
// The factory is « occupied » while a TRM atelier shift is planned
// (planning_bonnetier), widened by MARGE_MS on both sides — people arrive
// before and leave after their shift. The atelier is THE constraint: the
// offices never work without it (Vincent, 2026-09-28), so no ETM data.
// Every other hour is « closed » and the NVR pushes motion alerts.
//
// The NVR schedule is a repeating WEEK (168 hour slots, reolink.ts), not dated:
// the automate rewrites it every hour for the next 168 hours, so each slot
// always describes the next occurrence of that hour.
//
// ⚠️ An ISO week of the horizon with NO planning row at all is uncertain (not
// planned yet, or a holiday nobody entered): its slots take the fixed schedule
// the NVR had before the automate, Fri 18:00 → Mon 05:00 (read on the NVR 2026-09-28).

import { HEURES_SEMAINE, indexHeure } from '../../reolink.js'
import { partiesParis } from '../../pointage-etat.js'

export const MARGE_MS = 60 * 60_000
const HEURE_MS = 60 * 60_000

export interface Poste {
  debutMs: number
  finMs: number
}

const jourIso = (y: number, mo: number, d: number) => new Date(Date.UTC(y, mo - 1, d)).getUTCDay() || 7

/** The fixed schedule of before the automate: Fri 18:00 → Mon 05:00. */
export function tableFixe(): string {
  const t = Array<string>(HEURES_SEMAINE).fill('0')
  for (let h = 0; h < 24; h++) {
    if (h >= 18) t[indexHeure(5, h)] = '1'
    t[indexHeure(6, h)] = '1'
    t[indexHeure(7, h)] = '1'
    if (h < 5) t[indexHeure(1, h)] = '1'
  }
  return t.join('')
}

/** `YYYY-MM-DD` of the Monday of the ISO week (Paris) holding `ms`. */
export function lundiParis(ms: number): string {
  const p = partiesParis(ms)
  const j = jourIso(p.y, p.mo, p.d)
  const t = new Date(Date.UTC(p.y, p.mo - 1, p.d) - (j - 1) * 86_400_000)
  return t.toISOString().slice(0, 10)
}

export interface Cible {
  /** 168 chars, NVR day order: '1' = push on (closed). */
  table: string
  /** Mondays (`YYYY-MM-DD`) of the horizon's weeks with no planning row. */
  semainesNonPlanifiees: string[]
}

/** The motion table the planning asks for, from the current hour for 168 hours. */
export function calculerCible(postes: readonly Poste[], nowMs: number): Cible {
  const fixe = tableFixe()
  const table = fixe.split('')
  const semainesPlanifiees = new Set(postes.map((p) => lundiParis(p.debutMs)))
  const nonPlanifiees = new Set<string>()
  const depart = Math.floor(nowMs / HEURE_MS) * HEURE_MS
  // A DST day: the autumn's repeated hour writes its slot twice (the later
  // wins), the spring's missing hour keeps the fixed value.
  for (let i = 0; i < HEURES_SEMAINE; i++) {
    const t = depart + i * HEURE_MS
    const p = partiesParis(t)
    const idx = indexHeure(jourIso(p.y, p.mo, p.d), p.h)
    const lundi = lundiParis(t)
    if (!semainesPlanifiees.has(lundi)) {
      nonPlanifiees.add(lundi)
      table[idx] = fixe[idx]
      continue
    }
    const occupe = postes.some((s) => s.debutMs - MARGE_MS < t + HEURE_MS && s.finMs + MARGE_MS > t)
    table[idx] = occupe ? '0' : '1'
  }
  return { table: table.join(''), semainesNonPlanifiees: [...nonPlanifiees].sort() }
}

type PushLu = { enable: number; scheduleEnable: number; schedule: { table: Record<string, string> } }

/** Push switched off by a person (Reolink app on a phone — a spider web in
 *  front of a lens…): the automate never turns it back on and leaves the
 *  camera as it is until someone switches it on again (v2, Retour of 2026-09-28). */
export const coupeeALaMain = (push: PushLu): boolean => push.enable === 0

/** Nothing to write on this channel: already at the target, or switched off by a person. */
export function conforme(push: PushLu, cible: string): boolean {
  return coupeeALaMain(push) || (push.scheduleEnable === 1 && push.schedule.table.MD === cible)
}
