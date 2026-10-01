// Pure rules of TRM Atelier › Maintenance (routes/maintenance-trm.ts).
//
// « Kg tricotés depuis » (Mickaël, 2026-10-01): every per-métier maintenance
// item — the rouloir, the six garniture items, the periodic entretiens —
// shows how many kilos the métier has knitted since that item was last done.
// One measure for all of them: the WEIGHED rolls (stock_ecru.poids) of the
// métier's OFs, entered strictly after the day of the maintenance (a roll
// weighed on the day itself may predate the work). It replaced the legacy
// rouloir rule (Σ ordre_fabrication.quantite of finished OFs created after the
// visit), which skipped the running OF and counted planned, not knitted, kilos
// — on mps_dev the two agree within ~10 % on most métiers.

export type MaintenanceEtat = 'due' | 'proche' | 'ok' | 'inconnu'

/** Share of an interval past which an item turns amber (list liseré, meters). */
export const RATIO_PROCHE = 2 / 3

export function round2(x: number): number {
  return Math.round((Number(x) || 0) * 100) / 100
}

/** Whole months elapsed between a 'YYYYMMDD' date and `today`, floored at 0. */
export function monthsSince(hf: string | null, today: Date = new Date()): number | null {
  if (!hf || !/^\d{8}$/.test(hf)) return null
  const y = Number(hf.slice(0, 4))
  const m = Number(hf.slice(4, 6))
  const d = Number(hf.slice(6, 8))
  let months = (today.getFullYear() - y) * 12 + (today.getMonth() + 1 - m)
  if (today.getDate() < d) months -= 1
  return Math.max(0, months)
}

/** State of a periodic item (frequency in months). Ratio unbounded on purpose:
 *  the screen says the overshoot in words. */
export function etatPeriodique(
  mois: number | null,
  frequenceMois: number,
): { ratio: number | null; etat: MaintenanceEtat } {
  if (mois === null || frequenceMois <= 0) return { ratio: null, etat: 'inconnu' }
  const ratio = round2(mois / frequenceMois)
  return { ratio, etat: ratio >= 1 ? 'due' : ratio >= RATIO_PROCHE ? 'proche' : 'ok' }
}

/** Rouloir state from its kg ratio. No visit recorded = meaningless counter. */
export function etatRouloir(ratio: number, hasVisite: boolean): 'due' | 'proche' | 'ok' {
  if (!hasVisite) return 'ok'
  if (ratio >= 1) return 'due'
  if (ratio >= RATIO_PROCHE) return 'proche'
  return 'ok'
}

const RANG: Record<MaintenanceEtat, number> = { due: 3, proche: 2, ok: 1, inconnu: 0 }

/** The worst of several states — a métier's list liseré. */
export function pireEtat(etats: MaintenanceEtat[]): MaintenanceEtat {
  let worst: MaintenanceEtat = 'ok'
  for (const e of etats) if (RANG[e] > RANG[worst]) worst = e
  return worst
}

/** One métier's knitted kilos per day, ready for « kg since D » lookups. */
export interface KgIndex {
  /** 'YYYYMMDD', ascending, unique. */
  jours: string[]
  /** suffix[i] = Σ kg of jours[i..]. */
  suffix: number[]
}

export function indexKg(rows: { jour: string; kg: number }[]): KgIndex {
  const byDay = new Map<string, number>()
  for (const r of rows) {
    if (!/^\d{8}$/.test(r.jour)) continue
    byDay.set(r.jour, (byDay.get(r.jour) ?? 0) + (Number(r.kg) || 0))
  }
  const jours = [...byDay.keys()].sort()
  const suffix = new Array<number>(jours.length)
  let acc = 0
  for (let i = jours.length - 1; i >= 0; i--) {
    acc += byDay.get(jours[i]) ?? 0
    suffix[i] = acc
  }
  return { jours, suffix }
}

/** Kg knitted strictly after day `date` ('YYYYMMDD'); null when no date. */
export function kgDepuis(index: KgIndex | undefined, date: string | null): number | null {
  if (!date || !/^\d{8}$/.test(date)) return null
  if (!index || index.jours.length === 0) return 0
  // First day > date (binary search).
  let lo = 0
  let hi = index.jours.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (index.jours[mid] <= date) lo = mid + 1
    else hi = mid
  }
  return lo < index.jours.length ? round2(index.suffix[lo]) : 0
}
