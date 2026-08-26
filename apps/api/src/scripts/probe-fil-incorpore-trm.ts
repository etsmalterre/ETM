// READ-ONLY probe — how does the legacy actually consume an "incorporé" lot,
// and what does "Ajouter un fil" really produce in asso_fil_of?
//
// Ran 2026-08-26 to settle the régleur's account of the two buttons against
// the ledger. Follow-ups, each self-contained and read-only:
//   probe-fil-incorpore-trm2.ts  A-D  stock reconciliation, 2-lot vs position,
//                                     variations by year, which fils
//   probe-fil-incorpore-trm3.ts  E-H  freinte with/without the incorporated Kg
//   probe-fil-incorpore-trm4.ts  I-J  real columns + the consigne au bonnetier
//
// Questions this answers, all against the live ledger:
//   Q1  fil_incorpore: shape, volume, which lots, which OFs.
//   Q2  Is the incorporated weight taken off stock_fil.stock at all? (compare
//       stock_initial - stock against Σ poids incorporé, on lots that are used
//       ONLY as incorporation — no asso_fil_of row — so nothing else moves them)
//   Q3  WHEN does it move: at OF creation, at the first piece, at the last
//       piece, at archivage? (dernier_mouvement vs the OF's piece dates)
//   Q4  asso_fil_of: does one OF ever serve the same (fil, coloris) from two
//       DIFFERENT lots? (= the régleur's "spread over several lots")
//   Q5  asso_fil_of: does one OF ever carry a (fil, coloris) that the ref's
//       composition_ecru does not list? (= the "variation" for internal stock)
import 'dotenv/config'
import { query } from '../lib/hfsql-auto.js'

const n = (v: unknown) => Number(v) || 0
const f = (v: unknown) => {
  const x = Number(v)
  return Number.isFinite(x) ? x : 0
}
const kg = (x: number) => `${x.toFixed(2)} Kg`

async function main() {
  // ── Q1 ──────────────────────────────────────────────────
  console.log('\n═══ Q1 · fil_incorpore, shape and volume ═══')
  const inc = await query<any>(
    `SELECT IDfil_incorpore, IDordre_fabrication, IDstock_fil, poids FROM fil_incorpore ORDER BY IDfil_incorpore`,
  )
  console.log(`rows: ${inc.length}`)
  console.log('sample:', inc.slice(0, 5))
  const ofsWithInc = new Set(inc.map((r) => n(r.IDordre_fabrication)))
  const lotsInc = new Set(inc.map((r) => n(r.IDstock_fil)))
  console.log(`distinct OFs: ${ofsWithInc.size} · distinct lots: ${lotsInc.size}`)
  const poidsVals = inc.map((r) => f(r.poids))
  console.log(
    `poids: min ${Math.min(...poidsVals)} · max ${Math.max(...poidsVals)} · zéro ${poidsVals.filter((x) => x === 0).length}`,
  )

  if (inc.length === 0) { process.exit(0) }

  // ── Q2 ──────────────────────────────────────────────────
  console.log('\n═══ Q2 · is the incorporated weight deducted from stock_fil? ═══')
  const lotIds = Array.from(lotsInc)
  const assoOnLots = await query<any>(
    `SELECT IDstock_fil, IDordre_fabrication, pourcentage FROM asso_fil_of WHERE IDstock_fil IN (${lotIds.join(',')})`,
  )
  const knitted = new Set(assoOnLots.map((a) => n(a.IDstock_fil)))
  const pureInc = lotIds.filter((id) => !knitted.has(id))
  console.log(`lots incorporés: ${lotIds.length} · dont JAMAIS tricotés (asso_fil_of vide): ${pureInc.length}`)

  // stock_fil holds memo-binary columns → never SELECT *. Name the scalars.
  const lotRows = await query<any>(
    `SELECT IDstock_fil, stock, stock_initial, lot, dernier_mouvement, date_entree
       FROM stock_fil WHERE IDstock_fil IN (${lotIds.join(',')})`,
  )
  const byLot = new Map<number, any>()
  for (const r of lotRows) byLot.set(n(r.IDstock_fil), r)
  const termine = await query<any>(
    `SELECT IDstock_fil FROM stock_fil WHERE IDstock_fil IN (${lotIds.join(',')}) AND terminé = 1`,
  )
  const isTermine = new Set(termine.map((r) => n(r.IDstock_fil)))

  const incByLot = new Map<number, number>()
  for (const r of inc) {
    const id = n(r.IDstock_fil)
    incByLot.set(id, (incByLot.get(id) ?? 0) + f(r.poids))
  }

  console.log('\n-- lots utilisés UNIQUEMENT en incorporation --')
  console.log('lot        | initial |  stock  | Σ incorp | initial-stock | terminé | verdict')
  let deducted = 0
  let untouched = 0
  for (const id of pureInc.slice(0, 30)) {
    const r = byLot.get(id)
    if (!r) continue
    const init = f(r.stock_initial)
    const st = f(r.stock)
    const sum = incByLot.get(id) ?? 0
    const delta = init - st
    const t = isTermine.has(id)
    // archivage forces stock = 0, so a terminé lot tells us nothing about
    // whether the incorporation itself moved the stock.
    const verdict = t
      ? 'archivé (stock forcé à 0)'
      : Math.abs(delta - sum) < 0.01
        ? '≈ DÉDUIT'
        : delta === 0
          ? 'INTACT (rien déduit)'
          : `autre écart (${delta.toFixed(2)})`
    if (!t) { if (Math.abs(delta - sum) < 0.01 && sum > 0) deducted++; else if (delta === 0) untouched++ }
    console.log(
      `${String(r.lot ?? '').padEnd(10)} | ${init.toFixed(1).padStart(7)} | ${st.toFixed(1).padStart(7)} | ${sum.toFixed(1).padStart(8)} | ${delta.toFixed(1).padStart(13)} | ${t ? '  oui  ' : '  non  '} | ${verdict}`,
    )
  }
  console.log(`\nsur les lots NON archivés : déduits ${deducted} · intacts ${untouched}`)

  // ── Q3 ──────────────────────────────────────────────────
  console.log('\n═══ Q3 · quand le mouvement a-t-il lieu ? ═══')
  const ofIds = Array.from(ofsWithInc)
  const ofRows = await query<any>(
    `SELECT IDordre_fabrication, date_creation, est_termine, IDmachine
       FROM ordre_fabrication WHERE IDordre_fabrication IN (${ofIds.join(',')})`,
  )
  const ofById = new Map<number, any>()
  for (const r of ofRows) ofById.set(n(r.IDordre_fabrication), r)
  const pieces = await query<any>(
    `SELECT IDordre_fabrication, date_saisie, poids FROM stock_ecru
       WHERE IDordre_fabrication IN (${ofIds.join(',')})`,
  )
  const spanByOf = new Map<number, { first: string; last: string; nb: number; poids: number }>()
  for (const p of pieces) {
    const id = n(p.IDordre_fabrication)
    const d = String(p.date_saisie ?? '')
    const cur = spanByOf.get(id) ?? { first: d, last: d, nb: 0, poids: 0 }
    if (d && d < cur.first) cur.first = d
    if (d && d > cur.last) cur.last = d
    cur.nb += 1
    cur.poids += f(p.poids)
    spanByOf.set(id, cur)
  }
  console.log('OF    | créé le  | 1re pièce        | dern. pièce      | nb | lot incorp | dern_mouvement du lot')
  for (const r of inc.slice(0, 30)) {
    const ofId = n(r.IDordre_fabrication)
    const of = ofById.get(ofId)
    const sp = spanByOf.get(ofId)
    const lot = byLot.get(n(r.IDstock_fil))
    console.log(
      `${String(ofId).padEnd(5)} | ${String(of?.date_creation ?? '—').padEnd(8)} | ${String(sp?.first ?? '—').padEnd(16)} | ${String(sp?.last ?? '—').padEnd(16)} | ${String(sp?.nb ?? 0).padStart(2)} | ${String(lot?.lot ?? '—').padEnd(10)} | ${String(lot?.dernier_mouvement ?? '—')}`,
    )
  }

  // ── Q4 ──────────────────────────────────────────────────
  console.log('\n═══ Q4 · un OF sert-il le même (fil, coloris) depuis DEUX lots ? ═══')
  const asso = await query<any>(
    `SELECT IDordre_fabrication, IDref_fil, IDcolori_fil, IDstock_fil, pourcentage FROM asso_fil_of`,
  )
  console.log(`asso_fil_of rows: ${asso.length}`)
  const groups = new Map<string, any[]>()
  for (const a of asso) {
    const k = `${n(a.IDordre_fabrication)}|${n(a.IDref_fil)}|${n(a.IDcolori_fil)}`
    const g = groups.get(k) ?? []
    g.push(a)
    groups.set(k, g)
  }
  let dupSameLot = 0
  let dupDiffLot = 0
  const diffLotSamples: string[] = []
  for (const [k, g] of groups) {
    if (g.length < 2) continue
    const lots = new Set(g.map((a) => n(a.IDstock_fil)))
    if (lots.size > 1) {
      dupDiffLot++
      if (diffLotSamples.length < 12) {
        diffLotSamples.push(
          `OF ${k.split('|')[0]} · fil ${k.split('|')[1]}/${k.split('|')[2]} · lots [${Array.from(lots).join(', ')}] · % [${g.map((a) => f(a.pourcentage)).join(', ')}]`,
        )
      }
    } else dupSameLot++
  }
  console.log(`groupes (OF, fil, coloris) à 2+ lignes : ${dupSameLot + dupDiffLot}`)
  console.log(`  · même lot sur toutes les lignes  : ${dupSameLot}  (= position d'alimentation dupliquée)`)
  console.log(`  · lots DIFFÉRENTS                 : ${dupDiffLot}  (= consommation répartie sur plusieurs lots)`)
  for (const s of diffLotSamples) console.log('    ' + s)

  // ── Q5 ──────────────────────────────────────────────────
  console.log('\n═══ Q5 · un OF porte-t-il un fil absent de la composition de la réf ? ═══')
  const ofAll = await query<any>(
    `SELECT IDordre_fabrication, IDref_ecru, IDcolori_ecru FROM ordre_fabrication`,
  )
  const refOfOf = new Map<number, number>()
  for (const o of ofAll) refOfOf.set(n(o.IDordre_fabrication), n(o.IDref_ecru))
  const compo = await query<any>(
    `SELECT IDref_ecru, IDref_fil, IDcolori_fil, pourcentage FROM composition_ecru`,
  )
  const compoPairs = new Map<number, Set<string>>()
  const compoCount = new Map<string, number>()
  for (const c of compo) {
    const ref = n(c.IDref_ecru)
    const key = `${n(c.IDref_fil)}|${n(c.IDcolori_fil)}`
    if (!compoPairs.has(ref)) compoPairs.set(ref, new Set())
    compoPairs.get(ref)!.add(key)
    const ck = `${ref}|${key}`
    compoCount.set(ck, (compoCount.get(ck) ?? 0) + 1)
  }
  let extraFil = 0
  let extraPositions = 0
  const ofsSeenExtra = new Set<number>()
  const extraSamples: string[] = []
  const assoCount = new Map<string, number>()
  for (const a of asso) {
    const ofId = n(a.IDordre_fabrication)
    const ref = refOfOf.get(ofId) ?? 0
    const key = `${n(a.IDref_fil)}|${n(a.IDcolori_fil)}`
    assoCount.set(`${ofId}|${key}`, (assoCount.get(`${ofId}|${key}`) ?? 0) + 1)
    const set = compoPairs.get(ref)
    if (ref > 0 && set && !set.has(key)) {
      extraFil++
      ofsSeenExtra.add(ofId)
      if (extraSamples.length < 12) extraSamples.push(`OF ${ofId} (réf écru ${ref}) · fil ${key} à ${f(a.pourcentage)} %`)
    }
  }
  // more feeding positions on the OF than the reference declares
  for (const [k, cnt] of assoCount) {
    const [ofId, refFil, colFil] = k.split('|').map(Number)
    const ref = refOfOf.get(ofId) ?? 0
    const declared = compoCount.get(`${ref}|${refFil}|${colFil}`) ?? 0
    if (declared > 0 && cnt > declared) extraPositions++
  }
  console.log(`lignes asso_fil_of dont le (fil, coloris) n'est PAS dans composition_ecru : ${extraFil}`)
  console.log(`  sur ${ofsSeenExtra.size} OF distincts (total OF : ${ofAll.length})`)
  for (const s of extraSamples) console.log('    ' + s)
  console.log(`couples (OF, fil, coloris) portant PLUS de lignes que la réf n'en déclare : ${extraPositions}`)

  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
