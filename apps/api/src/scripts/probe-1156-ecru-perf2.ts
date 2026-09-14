// Companion of probe-1156-ecru-perf.ts: alternative shapes for the two slow
// steps (base NOT EXISTS, defaut_qualite IN-list). Read-only.
import { query, closeConnection } from '../lib/hfsql-auto.js'

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now()
  const r = await fn()
  console.log(`${label.padEnd(58)} ${String(Date.now() - t).padStart(6)} ms`)
  return r
}

async function main() {
  const ids = (await query<any>(`SELECT IDstock_ecru FROM stock_ecru se WHERE se.IDsociete = 1 AND (se.IDligne_expedition_ETM = 0 OR se.IDligne_expedition_ETM IS NULL) AND (se.IDcommande_donation IS NULL OR se.IDcommande_donation = 0) AND (se.IDref_commande_affectation IS NULL OR se.IDref_commande_affectation = 0)`))
    .map((r: any) => Number(r.IDstock_ecru)).filter((x: number) => x > 0)
  console.log(`loose ids: ${ids.length}`)

  // Defects — shipped shape: one IN list of quoted ids.
  const inAll = ids.map((x) => `'${x}'`).join(',')
  await timed('D1 defaut IN (<all ids>) [shipped]', () =>
    query<any>(`SELECT IDdefaut_qualite, reference, description, type_defaut, taille_cm, nombre FROM defaut_qualite WHERE Type_Reference = 2 AND reference IN (${inAll})`))
  // Chunked.
  for (const size of [50, 200]) {
    await timed(`D2 defaut IN chunks of ${size}`, async () => {
      let n = 0
      for (let i = 0; i < ids.length; i += size) {
        const chunk = ids.slice(i, i + size).map((x) => `'${x}'`).join(',')
        n += (await query<any>(`SELECT IDdefaut_qualite, reference, description, type_defaut, taille_cm, nombre FROM defaut_qualite WHERE Type_Reference = 2 AND reference IN (${chunk})`)).length
      }
      return n
    })
  }
  // Whole écru defect population, filtered in JS.
  const all = await timed('D3 defaut WHERE Type_Reference = 2 (all rows)', () =>
    query<any>(`SELECT IDdefaut_qualite, reference, description, type_defaut, taille_cm, nombre FROM defaut_qualite WHERE Type_Reference = 2`))
  console.log(`   rows: ${all.length}`)
  // Only the id columns, then details for the hits.
  const idsOnly = await timed('D4 defaut SELECT IDdefaut_qualite, reference WHERE Type_Reference = 2', () =>
    query<any>(`SELECT IDdefaut_qualite, reference FROM defaut_qualite WHERE Type_Reference = 2`))
  const want = new Set(ids.map(String))
  const hits = idsOnly.filter((d: any) => want.has(String(d.reference ?? '').trim())).map((d: any) => Number(d.IDdefaut_qualite))
  await timed(`D4b details for ${hits.length} hits by PK IN`, () =>
    query<any>(`SELECT IDdefaut_qualite, reference, description, type_defaut, taille_cm, nombre FROM defaut_qualite WHERE IDdefaut_qualite IN (${hits.join(',')})`))
  // Batched CONVERT for the accented ones (instead of per-row fixEncoding).
  await timed(`D5 batched CONVERT on ${hits.length} hits`, () =>
    query<any>(`SELECT IDdefaut_qualite AS id, CONVERT(type_defaut USING 'UTF-8') AS t, CONVERT(description USING 'UTF-8') AS d FROM defaut_qualite WHERE IDdefaut_qualite IN (${hits.join(',')})`))
  // Is `reference` indexed? A single equality lookup vs a range.
  await timed('D6 single reference = lookup', () =>
    query<any>(`SELECT IDdefaut_qualite FROM defaut_qualite WHERE Type_Reference = 2 AND reference = '${ids[0]}'`))

  // Base query — join-free variant + NOT IN alternative.
  const NE = 'NOT EXISTS (SELECT 1 FROM stock_fini sf WHERE sf.IDstock_ecru = se.IDstock_ecru)'
  const W = `se.IDsociete = 1 AND (se.IDligne_expedition_ETM = 0 OR se.IDligne_expedition_ETM IS NULL) AND (se.IDcommande_donation IS NULL OR se.IDcommande_donation = 0) AND (se.IDref_commande_affectation IS NULL OR se.IDref_commande_affectation = 0)`
  await timed('B1 stock_ecru only (no joins) + NOT EXISTS', () =>
    query<any>(`SELECT se.IDstock_ecru FROM stock_ecru se WHERE ${W} AND ${NE}`))
  await timed('B2 stock_ecru only (no joins), no NOT EXISTS', () =>
    query<any>(`SELECT se.IDstock_ecru FROM stock_ecru se WHERE ${W}`))
  await timed('B3 LEFT JOIN stock_fini ... IS NULL', () =>
    query<any>(`SELECT se.IDstock_ecru FROM stock_ecru se LEFT JOIN stock_fini sf ON sf.IDstock_ecru = se.IDstock_ecru WHERE ${W} AND sf.IDstock_fini IS NULL`).then((r) => { console.log(`   rows: ${r.length}`); return r }))
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => closeConnection())
