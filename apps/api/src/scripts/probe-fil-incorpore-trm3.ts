// READ-ONLY probe #3 — the decisive question: is the incorporated weight
// counted as consumption anywhere in the legacy ledger?
//
// All 32 incorporated lots are terminé = 1 (archivage forced stock to 0), so
// the live `stock` column can't answer it. The archivage record can:
//
//   E  freinte = stock_initial − Σ(pièces × pourcentage/100)  on those lots.
//      If the incorporation is NOT counted, the freinte should look inflated
//      by roughly the incorporated weight — and subtracting it should land the
//      lot back in a plausible 0–10 % band.
//   F  observation_freinte on those very lots — the archivist's own words.
//   G  Is the incorporated lot the SAME lot the OF knits for that fil, or a
//      second one? (a remnant used as filler vs a top-up of the running lot)
//   H  Baseline: freinte distribution on archived lots WITHOUT any
//      incorporation, so E has something to be compared against.
import 'dotenv/config'
import { query } from '../lib/hfsql-auto.js'

const n = (v: unknown) => Number(v) || 0
const f = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0 }

async function freinteOf(lotIds: number[]) {
  const out = new Map<number, { initial: number; conso: number }>()
  if (lotIds.length === 0) return out
  const lots = await query<any>(
    `SELECT IDstock_fil, stock_initial FROM stock_fil WHERE IDstock_fil IN (${lotIds.join(',')})`,
  )
  const asso = await query<any>(
    `SELECT IDstock_fil, IDordre_fabrication, pourcentage FROM asso_fil_of WHERE IDstock_fil IN (${lotIds.join(',')})`,
  )
  const ofIds = Array.from(new Set(asso.map((a) => n(a.IDordre_fabrication)).filter((x) => x > 0)))
  const poidsByOf = new Map<number, number>()
  for (let i = 0; i < ofIds.length; i += 400) {
    const chunk = ofIds.slice(i, i + 400)
    const pieces = await query<any>(
      `SELECT IDordre_fabrication, poids FROM stock_ecru WHERE IDordre_fabrication IN (${chunk.join(',')})`,
    )
    for (const p of pieces) {
      const id = n(p.IDordre_fabrication)
      poidsByOf.set(id, (poidsByOf.get(id) ?? 0) + f(p.poids))
    }
  }
  for (const l of lots) out.set(n(l.IDstock_fil), { initial: f(l.stock_initial), conso: 0 })
  for (const a of asso) {
    const id = n(a.IDstock_fil)
    const e = out.get(id)
    if (!e) continue
    e.conso += ((poidsByOf.get(n(a.IDordre_fabrication)) ?? 0) * f(a.pourcentage)) / 100
  }
  return out
}

async function main() {
  const inc = await query<any>(
    `SELECT IDordre_fabrication, IDstock_fil, poids FROM fil_incorpore ORDER BY IDfil_incorpore`,
  )
  const incByLot = new Map<number, number>()
  for (const r of inc) {
    const id = n(r.IDstock_fil)
    incByLot.set(id, (incByLot.get(id) ?? 0) + f(r.poids))
  }
  const lotIds = Array.from(incByLot.keys())

  // ── E ───────────────────────────────────────────────────
  console.log('\n═══ E · freinte des lots incorporés, avec et sans le poids incorporé ═══')
  const fr = await freinteOf(lotIds)
  const lotMeta = await query<any>(
    `SELECT IDstock_fil, lot, stock_initial FROM stock_fil WHERE IDstock_fil IN (${lotIds.join(',')})`,
  )
  const metaById = new Map<number, any>()
  for (const r of lotMeta) metaById.set(n(r.IDstock_fil), r)
  console.log('lot        | initial | conso tricot | freinte |   %   | incorp | freinte-incorp |   %')
  const pctsRaw: number[] = []
  const pctsAdj: number[] = []
  for (const id of lotIds) {
    const e = fr.get(id)
    const m = metaById.get(id)
    if (!e || !m) continue
    const freinte = e.initial - e.conso
    const incW = incByLot.get(id) ?? 0
    const pRaw = e.initial > 0 ? (freinte / e.initial) * 100 : 0
    const pAdj = e.initial > 0 ? ((freinte - incW) / e.initial) * 100 : 0
    pctsRaw.push(pRaw)
    pctsAdj.push(pAdj)
    console.log(
      `${String(m.lot ?? '').padEnd(10)} | ${f(m.stock_initial).toFixed(1).padStart(7)} | ${e.conso.toFixed(1).padStart(12)} | ${freinte.toFixed(1).padStart(7)} | ${pRaw.toFixed(1).padStart(5)} | ${incW.toFixed(0).padStart(6)} | ${(freinte - incW).toFixed(1).padStart(14)} | ${pAdj.toFixed(1).padStart(5)}`,
    )
  }
  const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN }
  console.log(`\n  médiane freinte %          : ${med(pctsRaw).toFixed(2)} %`)
  console.log(`  médiane freinte − incorp % : ${med(pctsAdj).toFixed(2)} %`)

  // ── F ───────────────────────────────────────────────────
  console.log('\n═══ F · observation_freinte écrite par l’archiviste sur ces lots ═══')
  for (const id of lotIds) {
    const rows = await query<any>(
      `SELECT observation_freinte FROM stock_fil WHERE IDstock_fil = ${id}`,
    )
    const txt = String(rows[0]?.observation_freinte ?? '').trim()
    if (txt) console.log(`  lot ${String(metaById.get(id)?.lot ?? id).padEnd(8)} : ${txt.replace(/\s+/g, ' ').slice(0, 200)}`)
  }

  // ── G ───────────────────────────────────────────────────
  console.log('\n═══ G · le lot incorporé est-il celui que l’OF tricote déjà ? ═══')
  const ofIds = Array.from(new Set(inc.map((r) => n(r.IDordre_fabrication))))
  const assoOfs = await query<any>(
    `SELECT IDordre_fabrication, IDstock_fil, IDref_fil, IDcolori_fil, pourcentage
       FROM asso_fil_of WHERE IDordre_fabrication IN (${ofIds.join(',')})`,
  )
  const lotsByOf = new Map<number, Set<number>>()
  for (const a of assoOfs) {
    const id = n(a.IDordre_fabrication)
    if (!lotsByOf.has(id)) lotsByOf.set(id, new Set())
    lotsByOf.get(id)!.add(n(a.IDstock_fil))
  }
  let same = 0, different = 0
  for (const r of inc) {
    const ofId = n(r.IDordre_fabrication)
    const isSame = lotsByOf.get(ofId)?.has(n(r.IDstock_fil)) ?? false
    if (isSame) same++; else different++
  }
  console.log(`  le lot incorporé EST déjà un lot tricoté de cet OF : ${same}`)
  console.log(`  c’est un AUTRE lot                                 : ${different}`)

  // ── H ───────────────────────────────────────────────────
  console.log('\n═══ H · baseline : freinte des lots archivés SANS incorporation ═══')
  const archived = await query<any>(
    `SELECT IDstock_fil FROM stock_fil WHERE terminé = 1 AND stock_initial > 0`,
  )
  const incSet = new Set(lotIds)
  const plain = archived.map((r) => n(r.IDstock_fil)).filter((id) => !incSet.has(id)).slice(0, 400)
  const frPlain = await freinteOf(plain)
  const metaPlain = await query<any>(
    `SELECT IDstock_fil, stock_initial FROM stock_fil WHERE IDstock_fil IN (${plain.join(',')})`,
  )
  const initPlain = new Map<number, number>()
  for (const r of metaPlain) initPlain.set(n(r.IDstock_fil), f(r.stock_initial))
  const pcts: number[] = []
  for (const [id, e] of frPlain) {
    const init = initPlain.get(id) ?? 0
    if (init <= 0 || e.conso <= 0) continue // lots never knitted say nothing
    pcts.push(((init - e.conso) / init) * 100)
  }
  pcts.sort((a, b) => a - b)
  const q = (p: number) => pcts.length ? pcts[Math.min(pcts.length - 1, Math.floor(pcts.length * p))].toFixed(1) : 'n/a'
  console.log(`  échantillon : ${pcts.length} lots archivés sans incorporation`)
  console.log(`  freinte % — p10 ${q(0.1)} · médiane ${q(0.5)} · p90 ${q(0.9)}`)

  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
