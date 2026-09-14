// Grouped rolls (LIVA #1149): the ennoblisseur sometimes joins two (or more)
// écru pieces into ONE dyed roll — small pieces sewn end to end to avoid
// seams, white rolls for printing. The BL then prints `3510/11+3510/2`, one
// weight, one length, and both tags stay on the physical roll.
//
// `stock_fini.IDstock_ecru` holds a single écru, and "this écru has been
// consumed" is read everywhere as "a stock_fini row points at it" — so a merged
// roll pointing only at its first piece would leave the other piece "in stock
// at the dyer", double-counted in the client gauge and receivable a second
// time. This module owns the link table that records EVERY component of a
// merged roll:
//
//   stock_fini_source (IDstock_fini_source, IDstock_fini, IDstock_ecru)
//
// Conventions:
//   - A NON-merged roll has no rows here — `stock_fini.IDstock_ecru` is its
//     only source, as it always was. A merged roll has one row PER component,
//     the first component included, and keeps `IDstock_ecru` = first component
//     so every existing reader (and the legacy WinDev app) still resolves it.
//   - "Consumed écru" = `stock_fini.IDstock_ecru` ∪ `stock_fini_source.IDstock_ecru`.
//     Use `consumedEcruIds()` / `allConsumedEcruIds()`; never re-implement the
//     union at a call site.
//   - ⚠️ The table is installed by copying `apps/api/hfsql/stock_fini_source.{fic,ndx}`
//     into the HFSQL server's database folder, then restarting the API (a
//     connection lists the database's files when it opens). `CREATE TABLE`
//     through ODBC is NOT a deploy step (probed 2026-09-14, hfsql_odbc.md
//     § Footguns): it writes a local .fic in the process cwd, usable only by
//     the creating connection — every other connection answers « Fichier de
//     données stock_fini_source inconnu ». That local file is exactly what was
//     copied to the server. This module never creates anything: it PROBES the
//     table (`probeFiniSourceTable`) and, until it exists, every reader answers
//     "no merged roll" — exactly the previous behaviour — and the writer
//     refuses with `FiniSourceUnavailableError` (the reception route turns it
//     into a 503 and the dialog hides « Fusionner »).
//   - Driver limits on a table outside the query planner's comfort zone: a
//     correlated `NOT EXISTS (SELECT 1 FROM stock_fini_source …)` and
//     `NOT IN (SELECT …)` are refused (the same NOT EXISTS on stock_fini is
//     fine). So: flat lookups + JS sets only, never a subquery on this table.
//     It is tiny (a few dozen rows a year), so a full read is cheap.
//   - The merged numero is what the dyer prints on the BL and on the tags:
//     `3510/11+3510/2` (see `mergedNumero`). A later cut appends `-N` as usual.

import { query } from './hfsql-auto.js'
import { NUMERO_MAX_LEN } from './roll-cut.js'

export const FINI_SOURCE_TABLE = 'stock_fini_source'

/** Columns of the table to declare in the analysis (all 8-byte integers,
 *  `IDstock_fini_source` = primary key, no auto-id needed — the API writes
 *  `max + 1` like every other insert). */
export const FINI_SOURCE_COLUMNS = ['IDstock_fini_source', 'IDstock_fini', 'IDstock_ecru'] as const

/** Thrown by the writer while the table is not on the server. */
export class FiniSourceUnavailableError extends Error {
  constructor() {
    super(`La table ${FINI_SOURCE_TABLE} n'existe pas sur le serveur HFSQL : la fusion de pièces est désactivée.`)
    this.name = 'FiniSourceUnavailableError'
  }
}

/** Joins the component numeros the way the dyer prints them: `A+B`. Falls back
 *  to the compact `base/N+M` form (second piece reduced to what follows the
 *  `/` when it shares the first piece's base) when the full form does not fit
 *  the 20-char `numero` column, then truncates as a last resort. */
export function mergedNumero(numeros: readonly string[]): string {
  const parts = numeros.map((n) => (n ?? '').trim()).filter((n) => n.length > 0)
  if (parts.length === 0) return ''
  const full = parts.join('+')
  if (full.length <= NUMERO_MAX_LEN) return full
  const [first, ...rest] = parts
  const slash = first.lastIndexOf('/')
  const base = slash > 0 ? first.slice(0, slash + 1) : ''
  const compact = [
    first,
    ...rest.map((p) => (base && p.startsWith(base) ? p.slice(base.length) : p)),
  ].join('+')
  if (compact.length <= NUMERO_MAX_LEN) return compact
  return compact.slice(0, NUMERO_MAX_LEN)
}

/** Split a merged numero back into its printed components. A plain numero
 *  yields itself. Used to match Tricobot's `num_piece` against écru numeros. */
export function splitMergedNumero(numero: string): string[] {
  return (numero ?? '').split('+').map((s) => s.trim()).filter((s) => s.length > 0)
}

// Availability cache. A successful probe is final for the process; a failed
// one is retried at most once a minute so a table pushed to the server while
// the API runs is picked up without a restart, and a missing table costs one
// failing SELECT per minute, not one per request.
let available: boolean | null = null
let lastFailedProbe = 0
const REPROBE_MS = 60_000

/** Is `stock_fini_source` readable on this server? Never creates it. */
export async function probeFiniSourceTable(): Promise<boolean> {
  if (available === true) return true
  if (available === false && Date.now() - lastFailedProbe < REPROBE_MS) return false
  try {
    await query(`SELECT TOP 1 IDstock_fini_source FROM ${FINI_SOURCE_TABLE}`)
    available = true
  } catch {
    available = false
    lastFailedProbe = Date.now()
  }
  return available
}

/** Test seam — forget the cached probe result. */
export function resetFiniSourceProbe(): void {
  available = null
  lastFailedProbe = 0
}

const CHUNK = 200

function chunks<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function ids(arr: readonly (number | null | undefined)[]): number[] {
  return Array.from(new Set(arr.map((x) => Number(x) || 0).filter((x) => x > 0)))
}

/** Every écru id of `ecruIds` that has been consumed into a fini roll — by
 *  `stock_fini.IDstock_ecru` OR as a component of a merged roll. */
export async function consumedEcruIds(ecruIds: readonly number[]): Promise<Set<number>> {
  const out = new Set<number>()
  const list = ids(ecruIds)
  const withMerged = await probeFiniSourceTable()
  for (const part of chunks(list, CHUNK)) {
    const inList = part.join(',')
    const [direct, merged] = await Promise.all([
      query<{ IDstock_ecru: number }>(`SELECT IDstock_ecru FROM stock_fini WHERE IDstock_ecru IN (${inList})`),
      withMerged
        ? query<{ IDstock_ecru: number }>(`SELECT IDstock_ecru FROM ${FINI_SOURCE_TABLE} WHERE IDstock_ecru IN (${inList})`)
        : Promise.resolve([] as Array<{ IDstock_ecru: number }>),
    ])
    for (const r of direct) out.add(Number(r.IDstock_ecru))
    for (const r of merged) out.add(Number(r.IDstock_ecru))
  }
  return out
}

/** The whole set of consumed écru ids (both sources), for full-history scans
 *  such as Rapports. ~45 k single-column rows from stock_fini + the tiny link
 *  table — cheaper than chunked IN lists over 20 k+ ids (see rapports.ts). */
export async function allConsumedEcruIds(): Promise<Set<number>> {
  const out = new Set<number>()
  const [direct, merged] = await Promise.all([
    query<{ IDstock_ecru: number }>(`SELECT IDstock_ecru FROM stock_fini WHERE IDstock_ecru > 0`),
    mergedComponentEcruIds(),
  ])
  for (const r of direct) out.add(Number(r.IDstock_ecru))
  for (const id of merged) out.add(id)
  return out
}

/** Every écru id that is a component of SOME merged roll. For list routes whose
 *  SQL already excludes écru with a `stock_fini` child through NOT EXISTS: the
 *  link table cannot join that predicate (driver limit), so the caller drops
 *  these ids in JS. Empty while the table is not on the server. */
export async function mergedComponentEcruIds(): Promise<Set<number>> {
  if (!(await probeFiniSourceTable())) return new Set()
  const rows = await query<{ IDstock_ecru: number }>(`SELECT IDstock_ecru FROM ${FINI_SOURCE_TABLE}`)
  return new Set(rows.map((r) => Number(r.IDstock_ecru)).filter((x) => x > 0))
}

/** Component écru ids of each fini in `finiIds`, in insertion (PK) order. Only
 *  merged rolls have an entry. */
export async function loadFiniSources(finiIds: readonly number[]): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>()
  if (!(await probeFiniSourceTable())) return out
  const list = ids(finiIds)
  for (const part of chunks(list, CHUNK)) {
    const rows = await query<{ IDstock_fini_source: number; IDstock_fini: number; IDstock_ecru: number }>(
      `SELECT IDstock_fini_source, IDstock_fini, IDstock_ecru FROM ${FINI_SOURCE_TABLE}
       WHERE IDstock_fini IN (${part.join(',')}) ORDER BY IDstock_fini_source`,
    )
    for (const r of rows) {
      const f = Number(r.IDstock_fini)
      const arr = out.get(f) ?? []
      arr.push(Number(r.IDstock_ecru))
      out.set(f, arr)
    }
  }
  return out
}

/** Fini ids that hold each écru of `ecruIds` as a merged component. */
export async function finiIdsByComponentEcru(ecruIds: readonly number[]): Promise<Map<number, number[]>> {
  const out = new Map<number, number[]>()
  if (!(await probeFiniSourceTable())) return out
  const list = ids(ecruIds)
  for (const part of chunks(list, CHUNK)) {
    const rows = await query<{ IDstock_fini: number; IDstock_ecru: number }>(
      `SELECT IDstock_fini, IDstock_ecru FROM ${FINI_SOURCE_TABLE} WHERE IDstock_ecru IN (${part.join(',')})`,
    )
    for (const r of rows) {
      const e = Number(r.IDstock_ecru)
      const arr = out.get(e) ?? []
      arr.push(Number(r.IDstock_fini))
      out.set(e, arr)
    }
  }
  return out
}

/** Record the components of a merged roll. `ecruIds` is the full ordered list,
 *  first component included. A single-component list writes nothing (a plain
 *  roll has no link rows). Manual `max+1` PK like every other insert. */
export async function insertFiniSources(finiId: number, ecruIds: readonly number[]): Promise<void> {
  const list = ids(ecruIds)
  if (!(finiId > 0) || list.length < 2) return
  if (!(await probeFiniSourceTable())) throw new FiniSourceUnavailableError()
  const maxRows = await query<{ m: number | null }>(`SELECT MAX(IDstock_fini_source) AS m FROM ${FINI_SOURCE_TABLE}`)
  let next = (Number(maxRows[0]?.m) || 0) + 1
  for (const ecruId of list) {
    await query(
      `INSERT INTO ${FINI_SOURCE_TABLE} (IDstock_fini_source, IDstock_fini, IDstock_ecru) VALUES (${next}, ${finiId}, ${ecruId})`,
    )
    next += 1
  }
}

/** Drop the link rows of the given fini rolls — call it wherever a
 *  `DELETE FROM stock_fini` happens. */
export async function deleteFiniSources(finiIds: readonly number[]): Promise<void> {
  const list = ids(finiIds)
  if (list.length === 0) return
  if (!(await probeFiniSourceTable())) return
  await query(`DELETE FROM ${FINI_SOURCE_TABLE} WHERE IDstock_fini IN (${list.join(',')})`)
}

/** A cut-off piece of a merged roll is still made of the same écru pieces:
 *  copy the parent's component rows onto the child. */
export async function copyFiniSources(fromFiniId: number, toFiniId: number): Promise<void> {
  const src = await loadFiniSources([fromFiniId])
  const comps = src.get(fromFiniId) ?? []
  if (comps.length > 0) await insertFiniSources(toFiniId, comps)
}
