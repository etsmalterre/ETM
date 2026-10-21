// TRM bonnetier planning — the reads and the one write shared by
// routes/planning-atelier.ts (the Atelier › Planning screen) and the agent
// « Planning atelier » (lib/agents/planning-atelier/, LIVA #1296).
//
//   planning_bonnetier  IDplanning_bonnetier, date_debut (DATETIME), date_fin (DATETIME), IDbonnetier
//                       — one row per bonnetier per worked day; the shift is derived
//                       from the start hour, there is no équipe column.
//   desiderata          IDdesiderata, DATE (reserved word — comes back uppercased; 8-char
//                       YYYYMMDD), description, IDbonnetier, justifie, declare.

import { query, fixEncoding } from './hfsql-auto.js'

function n(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}

function rawGet(raw: Record<string, unknown>, re: RegExp): unknown {
  for (const [k, v] of Object.entries(raw)) {
    if (re.test(k)) return v
  }
  return undefined
}

/** Normalize an HFSQL DATETIME value to `{ date: 'YYYY-MM-DD', time: 'HH:MM' }`.
 *  Windows ODBC returns 'YYYY-MM-DD HH:MM:SS.mmm'; the bridge may return the
 *  compact 'YYYYMMDDHHMMSS' — accept both. */
export function splitDateTime(v: unknown): { date: string; time: string } | null {
  const s = String(v ?? '')
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
  if (!m) m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/)
  if (!m) return null
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` }
}

/** Compact HFSQL DATETIME literal from 'YYYY-MM-DD' + 'HH:MM' (verified to
 *  round-trip on the live DB). */
export function dtLiteral(date: string, time: string): string {
  return `'${date.replace(/-/g, '')}${time.replace(':', '')}00'`
}

/** Add `days` to a 'YYYY-MM-DD' string (UTC-safe, no DST drift). */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// ── Planning entries ─────────────────────────────────────

export interface PlanningEntry {
  IDplanning_bonnetier: number
  IDbonnetier: number
  date: string // YYYY-MM-DD (day of date_debut)
  debut: string // HH:MM
  fin: string // HH:MM (may belong to the next day for night shifts)
}

function normalizeEntry(raw: Record<string, unknown>): PlanningEntry | null {
  const debut = splitDateTime(raw.date_debut)
  const fin = splitDateTime(raw.date_fin)
  if (!debut || !fin) return null
  return {
    IDplanning_bonnetier: n(raw.IDplanning_bonnetier),
    IDbonnetier: n(raw.IDbonnetier),
    date: debut.date,
    debut: debut.time,
    fin: fin.time,
  }
}

export async function selectEntries(fromDate: string, toDate: string, bonnetierId?: number): Promise<PlanningEntry[]> {
  const bonnetierFilter = bonnetierId ? ` AND IDbonnetier = ${bonnetierId}` : ''
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM planning_bonnetier
     WHERE date_debut >= ${dtLiteral(fromDate, '00:00')}
       AND date_debut < ${dtLiteral(addDays(toDate, 1), '00:00')}${bonnetierFilter}`,
  )
  return rows.map(normalizeEntry).filter((e): e is PlanningEntry => e !== null)
}

/** Insert one worked day. A `fin` at or before `debut` means the shift ends on
 *  the next day (Nuit 21:00 → 05:00). Any existing entry of that bonnetier on
 *  that day is replaced — matches the legacy one-shift-per-day model. */
export async function insertEntry(bonnetierId: number, date: string, debut: string, fin: string): Promise<void> {
  await query(
    `DELETE FROM planning_bonnetier
     WHERE IDbonnetier = ${bonnetierId}
       AND date_debut >= ${dtLiteral(date, '00:00')}
       AND date_debut < ${dtLiteral(addDays(date, 1), '00:00')}`,
  )
  const finDate = fin > debut ? date : addDays(date, 1)
  await query(
    `INSERT INTO planning_bonnetier (date_debut, date_fin, IDbonnetier)
     VALUES (${dtLiteral(date, debut)}, ${dtLiteral(finDate, fin)}, ${bonnetierId})`,
  )
}

// ── Desiderata ───────────────────────────────────────────

export interface DesiderataRow {
  IDdesiderata: number
  date: string // YYYY-MM-DD
  description: string
  IDbonnetier: number
  justifie: number
  declare: number
}

export function normalizeDesiderata(raw: Record<string, unknown>): DesiderataRow {
  // `date` is a reserved word — HFSQL returns the key uppercased as `DATE`.
  const d = String(rawGet(raw, /^date$/i) ?? '')
  return {
    IDdesiderata: n(raw.IDdesiderata),
    date: d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d,
    description: String(raw.description ?? '').trim(),
    IDbonnetier: n(raw.IDbonnetier),
    justifie: n(raw.justifie),
    declare: n(raw.declare),
  }
}

/** Every desiderata (the table is small: ~100 rows since 2024). */
export async function selectDesiderata(): Promise<DesiderataRow[]> {
  const rows = await query<Record<string, unknown>>('SELECT * FROM desiderata')
  const fixed = await fixEncoding(rows, 'desiderata', 'IDdesiderata', ['description'])
  return fixed.map(normalizeDesiderata)
}
