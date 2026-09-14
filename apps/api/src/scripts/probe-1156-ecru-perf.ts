// Timing probe for GET /api/stock/ecru (Tombé Métier › Stock list) — read-only.
// Reproduces each step of the route with a stopwatch so the slow one is named,
// not guessed. Run: pnpm --filter @mps/api exec tsx src/scripts/probe-1156-ecru-perf.ts
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { repairAliased } from '../routes/stock-fini.js'
import { resolveClientReservations, fetchDefectsByEcru } from '../routes/stock-ecru.js'

const SELECT = `se.IDstock_ecru, se.IDref_ecru, se.IDcolori_ecru, se.IDmagasin, se.IDordre_fabrication, se.IDref_commande_source, se.IDref_commande_affectation, se.IDligne_commande_client, se.poids, se.metrage, se.lot, se.numero, se.observations, se.visiteur, se.second_choix, se.date_saisie, re.reference AS ref_ecru, ce.reference AS coloris_reference, st.nom AS magasin_nom`
const JOINS = `FROM stock_ecru se LEFT JOIN ref_ecru re ON se.IDref_ecru = re.IDref_ecru LEFT JOIN colori_ecru ce ON se.IDcolori_ecru = ce.IDcolori_ecru LEFT JOIN sous_traitant st ON se.IDmagasin = st.IDsous_traitant`
const BASE = [
  'se.IDsociete = 1',
  '(se.IDligne_expedition_ETM = 0 OR se.IDligne_expedition_ETM IS NULL)',
  '(se.IDcommande_donation IS NULL OR se.IDcommande_donation = 0)',
  '(se.IDref_commande_affectation IS NULL OR se.IDref_commande_affectation = 0)',
]
const NOT_EXISTS = 'NOT EXISTS (SELECT 1 FROM stock_fini sf WHERE sf.IDstock_ecru = se.IDstock_ecru)'

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now()
  const r = await fn()
  console.log(`${label.padEnd(58)} ${String(Date.now() - t).padStart(6)} ms`)
  return r
}

async function main() {
  const statut = process.argv[2] ?? 'disponible'
  const where = [...BASE]
  if (statut === 'tous') where.pop()
  if (statut === 'teinture') { where.pop(); where.push('se.IDref_commande_affectation > 0') }

  // 1. Base query, as shipped (with the correlated NOT EXISTS).
  const full = await timed(`1a base SELECT with NOT EXISTS (${statut})`, () =>
    query<any>(`SELECT ${SELECT} ${JOINS} WHERE ${[...where, NOT_EXISTS].join(' AND ')} ORDER BY se.date_saisie DESC, se.IDstock_ecru DESC`))
  console.log(`   rows: ${full.length}`)

  // 1b. Same without the NOT EXISTS — how much does the correlated subquery cost?
  const loose = await timed(`1b base SELECT without NOT EXISTS`, () =>
    query<any>(`SELECT ${SELECT} ${JOINS} WHERE ${where.join(' AND ')} ORDER BY se.date_saisie DESC, se.IDstock_ecru DESC`))
  console.log(`   rows: ${loose.length}`)

  // 1c. Alternative: fetch the consumed ids flat and exclude in JS.
  const consumed = await timed(`1c flat SELECT of stock_fini.IDstock_ecru (all)`, () =>
    query<any>(`SELECT IDstock_ecru FROM stock_fini WHERE IDstock_ecru > 0`))
  console.log(`   consumed ids: ${consumed.length}`)

  // 1d. Alternative: NOT EXISTS restricted to the loose ids (IN list).
  const looseIds = loose.map((r: any) => Number(r.IDstock_ecru)).filter((x: number) => x > 0)
  const consumedAmong = await timed(`1d SELECT stock_fini.IDstock_ecru IN (<loose ids>)`, () =>
    query<any>(`SELECT IDstock_ecru FROM stock_fini WHERE IDstock_ecru IN (${looseIds.join(',')})`))
  console.log(`   consumed among loose: ${consumedAmong.length}`)

  // 1e. No ORDER BY — is the sort the cost?
  await timed(`1e base SELECT with NOT EXISTS, no ORDER BY`, () =>
    query<any>(`SELECT ${SELECT} ${JOINS} WHERE ${[...where, NOT_EXISTS].join(' AND ')}`))

  // 2. Accent repairs (4 batched queries on stock_ecru + 3 joined tables).
  let fixed = await timed('2a repairAliased stock_ecru (numero/lot/obs/visiteur)', () =>
    repairAliased(full, 'stock_ecru', 'IDstock_ecru', { numero: 'numero', lot: 'lot', observations: 'observations', visiteur: 'visiteur' }))
  const corrupted = full.filter((r: any) => ['numero', 'lot', 'observations', 'visiteur'].some((k) => typeof r[k] === 'string' && r[k].includes('�'))).length
  console.log(`   rows needing repair: ${corrupted}`)
  fixed = await timed('2b repairAliased ref_ecru', () => repairAliased(fixed, 'ref_ecru', 'IDref_ecru', { ref_ecru: 'reference' }))
  fixed = await timed('2c repairAliased colori_ecru', () => repairAliased(fixed, 'colori_ecru', 'IDcolori_ecru', { coloris_reference: 'reference' }))
  fixed = await timed('2d repairAliased sous_traitant', () => repairAliased(fixed, 'sous_traitant', 'IDmagasin', { magasin_nom: 'nom' }, 'IDsous_traitant'))

  // 3. Client reservation chain.
  const lccIds = fixed.map((r: any) => Number(r.IDligne_commande_client) || 0)
  const resv = await timed('3  resolveClientReservations', () => resolveClientReservations(lccIds))
  console.log(`   distinct lcc ids: ${new Set(lccIds.filter((x) => x > 0)).size}, resolved: ${resv.size}`)

  // 4. Défauts.
  const ecruIds = fixed.map((r: any) => Number(r.IDstock_ecru) || 0)
  const defects = await timed('4a fetchDefectsByEcru (as shipped)', () => fetchDefectsByEcru(ecruIds))
  let nDef = 0, nAcc = 0
  for (const arr of defects.values()) for (const d of arr) { nDef++; if (/[^\x00-\x7f]/.test(`${d.type_defaut ?? ''}${d.description ?? ''}`)) nAcc++ }
  console.log(`   rolls with defects: ${defects.size}, defect rows: ${nDef}, with non-ASCII text: ${nAcc}`)
  const inList = ecruIds.filter((x) => x > 0).map((x) => `'${x}'`).join(',')
  const rawDef = await timed('4b raw defaut_qualite SELECT (no fixEncoding)', () =>
    query<any>(`SELECT IDdefaut_qualite, reference, description, type_defaut, taille_cm, nombre FROM defaut_qualite WHERE Type_Reference = 2 AND reference IN (${inList})`))
  const corruptedDef = rawDef.filter((d: any) => ['description', 'type_defaut'].some((k) => typeof d[k] === 'string' && d[k].includes('�'))).length
  console.log(`   raw defect rows: ${rawDef.length}, with U+FFFD (per-row CONVERT each): ${corruptedDef}`)
  await timed('4c defaut_qualite full-table count(Type_Reference=2)', () =>
    query<any>(`SELECT COUNT(*) AS n FROM defaut_qualite WHERE Type_Reference = 2`)).then((r) => console.log(`   total écru defect rows in table: ${r[0]?.n ?? r[0]?.N}`))
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => closeConnection())
