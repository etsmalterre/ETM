// Guard for the 2026-08-26 fix: the rapport de freinte must count the
// incorporated weight as consumption, not as loss.
//
// Read-only, and it goes through computeBilan's own source of truth (the two
// tables) rather than the HTTP layer, so it can run against prod after an
// /etm_deploy. It prints every lot that carries an incorporation, with the
// freinte the old formula reported and the one the new formula reports.
import 'dotenv/config'
import { query } from '../lib/hfsql-auto.js'

const n = (v: unknown) => Number(v) || 0
const f = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : 0 }

async function main() {
  const inc = await query<any>(
    `SELECT IDordre_fabrication, IDstock_fil, poids FROM fil_incorpore`,
  )
  if (inc.length === 0) { console.log('Aucune incorporation au registre — rien à vérifier.'); process.exit(0) }
  const lotIds = Array.from(new Set(inc.map((r) => n(r.IDstock_fil))))
  const incByLot = new Map<number, number>()
  for (const r of inc) incByLot.set(n(r.IDstock_fil), (incByLot.get(n(r.IDstock_fil)) ?? 0) + f(r.poids))

  const lots = await query<any>(
    `SELECT IDstock_fil, lot, stock_initial FROM stock_fil WHERE IDstock_fil IN (${lotIds.join(',')})`,
  )
  const asso = await query<any>(
    `SELECT IDstock_fil, IDordre_fabrication, pourcentage FROM asso_fil_of WHERE IDstock_fil IN (${lotIds.join(',')})`,
  )
  const ofIds = Array.from(new Set(asso.map((a) => n(a.IDordre_fabrication)).filter((x) => x > 0)))
  const poidsByOf = new Map<number, number>()
  for (let i = 0; i < ofIds.length; i += 400) {
    const pieces = await query<any>(
      `SELECT IDordre_fabrication, poids FROM stock_ecru WHERE IDordre_fabrication IN (${ofIds.slice(i, i + 400).join(',')})`,
    )
    for (const p of pieces) poidsByOf.set(n(p.IDordre_fabrication), (poidsByOf.get(n(p.IDordre_fabrication)) ?? 0) + f(p.poids))
  }
  const produitByLot = new Map<number, number>()
  for (const a of asso) {
    const id = n(a.IDstock_fil)
    produitByLot.set(id, (produitByLot.get(id) ?? 0) + ((poidsByOf.get(n(a.IDordre_fabrication)) ?? 0) * f(a.pourcentage)) / 100)
  }

  console.log('lot        | initiale | tricoté  | incorporé | freinte AVANT |  %    | freinte APRÈS |  %')
  let improved = 0, worse = 0
  const before: number[] = [], after: number[] = []
  for (const l of lots) {
    const id = n(l.IDstock_fil)
    const init = f(l.stock_initial)
    const produit = produitByLot.get(id) ?? 0
    const incW = incByLot.get(id) ?? 0
    const fa = init - produit
    const fb = init - produit - incW
    const pa = init > 0 ? (fa / init) * 100 : 0
    const pb = init > 0 ? (fb / init) * 100 : 0
    before.push(Math.abs(pa)); after.push(Math.abs(pb))
    if (Math.abs(pb) < Math.abs(pa)) improved++; else worse++
    console.log(
      `${String(l.lot ?? '').padEnd(10)} | ${init.toFixed(1).padStart(8)} | ${produit.toFixed(1).padStart(8)} | ${incW.toFixed(1).padStart(9)} | ${fa.toFixed(1).padStart(13)} | ${pa.toFixed(1).padStart(5)} | ${fb.toFixed(1).padStart(13)} | ${pb.toFixed(1).padStart(5)}`,
    )
  }
  const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN }
  console.log(`\nlots concernés : ${lots.length}`)
  console.log(`  |freinte %| médiane AVANT : ${med(before).toFixed(2)} %`)
  console.log(`  |freinte %| médiane APRÈS : ${med(after).toFixed(2)} %`)
  console.log(`  rapprochés de zéro : ${improved} · éloignés : ${worse}`)
  console.log(worse > improved
    ? '\n⚠ La correction dégrade plus de lots qu’elle n’en améliore — à revoir.'
    : '\n✓ La correction rapproche la majorité des lots d’une freinte plausible.')
  process.exit(0)
}

main().catch((e) => { console.error(e); process.exit(1) })
