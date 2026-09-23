import { query } from './hfsql-auto.js'

/** Batched accent repair for a flat list: one CONVERT(...) WHERE pk IN (...) per
 *  source column, only for the ids whose value actually contains U+FFFD. Avoids
 *  the per-row N+1 that fixEncoding would do (a storm on the Linux bridge for a
 *  ~600-row list). All `fields` must be ASCII-named columns. */
export async function batchRepair<T extends Record<string, unknown>>(
  rows: T[],
  table: string,
  idField: string,
  fields: string[],
): Promise<T[]> {
  const idsByField: Record<string, Set<number>> = {}
  let any = false
  for (const f of fields) idsByField[f] = new Set<number>()
  for (const row of rows) {
    const id = Number(row[idField])
    if (!Number.isInteger(id)) continue
    for (const f of fields) {
      const v = row[f]
      if (typeof v === 'string' && v.includes('�')) {
        idsByField[f].add(id)
        any = true
      }
    }
  }
  if (!any) return rows
  const valueByField: Record<string, Map<number, string>> = {}
  for (const f of fields) {
    valueByField[f] = new Map<number, string>()
    const ids = idsByField[f]
    if (ids.size === 0) continue
    try {
      const r = await query<{ id: number; v: unknown }>(
        `SELECT ${idField} AS id, CONVERT(${f} USING 'UTF-8') AS v FROM ${table} WHERE ${idField} IN (${Array.from(ids).join(',')})`,
      )
      for (const rec of r) {
        if (rec.v == null) continue
        valueByField[f].set(
          Number(rec.id),
          rec.v instanceof ArrayBuffer ? Buffer.from(rec.v).toString('utf8') : String(rec.v),
        )
      }
    } catch {
      /* keep originals on failure */
    }
  }
  return rows.map((row) => {
    const id = Number(row[idField])
    let fixed: T | null = null
    for (const f of fields) {
      const v = row[f]
      if (typeof v === 'string' && v.includes('�')) {
        const nv = valueByField[f].get(id)
        if (nv != null) {
          if (!fixed) fixed = { ...row }
          ;(fixed as Record<string, unknown>)[f] = nv
        }
      }
    }
    return fixed ?? row
  })
}
