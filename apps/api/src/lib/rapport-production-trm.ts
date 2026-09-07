// Pure helpers of the TRM « Rapport de production » widget (LIVA #1132) —
// the aggregation and the date literal, kept out of routes/dashboard-trm.ts so
// they can be pinned by a test without a database. The route's header carries
// the recovered legacy SQL and the deltas; this file only computes.

/** Widest range served, in days. Beyond that the roll read stops being a
 *  dashboard query (a year of TRM ≈ 8 000 rolls — fine; ten would not be). */
export const RAPPORT_PRODUCTION_MAX_DAYS = 400

/** `YYYY-MM-DDTHH:mm[:ss]` (the browser's datetime-local shape, local time)
 *  → the compact 14-char HFSQL DATETIME literal both drivers accept in a
 *  WHERE (prime-trm's dtMidnight, planning-atelier's dtLiteral). `end` pads
 *  the seconds to 59 so `au` is inclusive, like the legacy's trailing `999`. */
export function dtLocalToHfsql(v: string, end: boolean): string | null {
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (!m) return null
  const sec = m[6] ?? (end ? '59' : '00')
  return `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}${sec}`
}

export interface RollRow {
  IDordre_fabrication: number
  IDref_ecru: number
  poids: number
  second_choix: number
}

export interface Bucket { kg: number; rouleaux: number }

export interface RapportProductionAgg {
  total_kg: number
  rouleaux: number
  second_choix_kg: number
  second_choix_rouleaux: number
  /** Keyed by métier id (0 when the OF has none). */
  par_machine: Map<number, Bucket>
  /** Keyed by ref_ecru id. */
  par_reference: Map<number, Bucket>
}

const r2 = (x: number) => Math.round(x * 100) / 100

/** Sums the rolls of the period under the two optional filters (0 = none),
 *  which COMPOSE — the legacy applied one or the other. `machineOf` maps an
 *  OF id to its métier id. Both splits are of the same filtered rows, so a
 *  métier's row in `par_machine` is exactly the total the reference split
 *  shows once that métier is the filter. */
export function aggregateRapportProduction(
  rows: readonly RollRow[],
  machineOf: ReadonlyMap<number, number>,
  filtres: { machine: number; ref: number },
): RapportProductionAgg {
  const parMachine = new Map<number, Bucket>()
  const parRef = new Map<number, Bucket>()
  let total = 0
  let rouleaux = 0
  let second = 0
  let secondN = 0
  for (const r of rows) {
    const machine = machineOf.get(r.IDordre_fabrication) ?? 0
    if (filtres.machine > 0 && machine !== filtres.machine) continue
    if (filtres.ref > 0 && r.IDref_ecru !== filtres.ref) continue
    const kg = Number(r.poids) || 0
    total += kg
    rouleaux += 1
    if (r.second_choix === 1) {
      second += kg
      secondN += 1
    }
    const m = parMachine.get(machine) ?? { kg: 0, rouleaux: 0 }
    m.kg += kg
    m.rouleaux += 1
    parMachine.set(machine, m)
    const f = parRef.get(r.IDref_ecru) ?? { kg: 0, rouleaux: 0 }
    f.kg += kg
    f.rouleaux += 1
    parRef.set(r.IDref_ecru, f)
  }
  for (const b of parMachine.values()) b.kg = r2(b.kg)
  for (const b of parRef.values()) b.kg = r2(b.kg)
  return {
    total_kg: r2(total),
    rouleaux,
    second_choix_kg: r2(second),
    second_choix_rouleaux: secondN,
    par_machine: parMachine,
    par_reference: parRef,
  }
}

export interface RapportProductionLigne {
  id: number
  label: string
  kg: number
  rouleaux: number
}

/** Heaviest first, label as tiebreak — the order the widget shows. */
export function toLignes(buckets: ReadonlyMap<number, Bucket>, names: ReadonlyMap<number, string>): RapportProductionLigne[] {
  return [...buckets.entries()]
    .map(([id, v]) => ({ id, label: names.get(id) ?? `#${id}`, kg: v.kg, rouleaux: v.rouleaux }))
    .sort((a, b) => b.kg - a.kg || a.label.localeCompare(b.label, 'fr'))
}
