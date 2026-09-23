// Agent « Superviseur » — label lookups for findings: one flat `IN` query per
// table + fixEncoding (never a JOIN + CONVERT). Same query shapes as the
// routes that already read these tables (commandes-client.ts, of-trm.ts).

import { query, fixEncoding } from '../../../hfsql-auto.js'

const TABLES = {
  client: { id: 'IDclient', col: 'nom' },
  ref_fini: { id: 'IDref_fini', col: 'reference' },
  ref_ecru: { id: 'IDref_ecru', col: 'reference' },
  ref_fil: { id: 'IDref_fil', col: 'reference' },
  colori_fil: { id: 'IDcolori_fil', col: 'reference' },
  sous_traitant: { id: 'IDsous_traitant', col: 'nom' },
  transporteur: { id: 'IDtransporteur', col: 'nom' },
} as const

export type TableNom = keyof typeof TABLES

/** id → trimmed label, chunked by 200 ids. Missing ids are simply absent. */
export async function noms(table: TableNom, ids: Iterable<number>): Promise<Map<number, string>> {
  const { id, col } = TABLES[table]
  const out = new Map<number, string>()
  const list = [...new Set([...ids].filter((x) => x > 0))]
  for (let i = 0; i < list.length; i += 200) {
    const rows = await query<Record<string, unknown>>(
      `SELECT ${id}, ${col} FROM ${table} WHERE ${id} IN (${list.slice(i, i + 200).join(',')})`,
    )
    for (const r of await fixEncoding(rows, table, id, [col])) out.set(Number(r[id]), String(r[col] ?? '').trim())
  }
  return out
}
