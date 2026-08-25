/**
 * Guard for the stock valuation (`lib/valorisation-stock.ts`).
 *
 *   NODE_ENV=production node --import tsx src/scripts/check-valorisation-stock.ts
 *   pnpm --filter @mps/api exec tsx src/scripts/check-valorisation-stock.ts
 *
 * WHAT IT ASSERTS
 *
 *  1. Internal consistency — the totals really are the sum of the buckets, and
 *     provision / taux are derived from them rather than computed twice.
 *  2. The devaluation rule is actually applied: each bucket's net equals its
 *     gross times (1 − taux), with the taux printed on the legacy inventory
 *     (2ᵉ choix −90 %, <1 an 0 %, 1-2 ans −50 %, >2 ans −90 %).
 *  3. The age buckets are NOT degenerate. This is the regression that matters:
 *     `date_saisie` is a timestamp string, so a strict `/^\d{8}$/` parser
 *     (`sst-shared.dateDigits`) silently returns '' for every row, every
 *     comparison loses, and the whole stock lands in "plus de 2 ans" at a flat
 *     90 % provision — which looks like a plausible figure, not like a bug.
 *     Shipped that way for one run on 2026-08-25; caught because the taux was
 *     EXACTLY 90,0 %.
 *  4. The population is the one the legacy query selects
 *     (`IDligne_expedition = 0 AND IDetat_stock_fini = 3`), cross-checked with
 *     an independent count straight from the table.
 *
 * It does NOT pin absolute euros: the valuation describes the stock held right
 * now, so every figure legitimately moves day to day. The printed 31/12/2025
 * inventory it was reverse-engineered against (21 039 kg / 283 526 € brut) can
 * never be replayed — the query reads current-state columns.
 */
import dotenv from 'dotenv'
dotenv.config({ path: `.env.${process.env.NODE_ENV ?? 'development'}` })
dotenv.config({ path: '.env' })

const { query, closeConnection } = await import('../lib/hfsql-auto.js')
const { valoriserStockFini } = await import('../lib/valorisation-stock.js')

const eur = (v: number) => Math.round(v).toLocaleString('fr-FR')
/** Rounding tolerance in euros — the amounts travel as REAL columns. */
const EPS = 0.5

let failures = 0
function check(ok: boolean, label: string, detail = '') {
  if (ok) { console.log(`  ✓ ${label}`); return }
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  failures++
}

async function main() {
  const v = await valoriserStockFini()
  console.log(`Valorisation du stock fini au ${v.date}`)
  console.log(`  ${v.rouleaux} rouleaux · ${eur(v.poids)} kg`)
  console.log(`  brut ${eur(v.brut)} €  net ${eur(v.net)} €  provision ${eur(v.provision)} €` +
    `  taux ${v.taux_provision == null ? '—' : (v.taux_provision * 100).toFixed(1) + ' %'}`)
  for (const b of v.buckets) {
    console.log(`    ${b.label.padEnd(16)} ${String(b.rouleaux).padStart(5)} rlx  ` +
      `${eur(b.poids).padStart(8)} kg  brut ${eur(b.brut).padStart(10)}  net ${eur(b.net).padStart(10)}`)
  }
  console.log('')

  // 1. Totals are the sum of the buckets.
  const sum = (k: 'rouleaux' | 'poids' | 'brut' | 'net') => v.buckets.reduce((t, b) => t + b[k], 0)
  check(sum('rouleaux') === v.rouleaux, 'rouleaux = somme des tranches', `${sum('rouleaux')} vs ${v.rouleaux}`)
  check(Math.abs(sum('poids') - v.poids) < EPS, 'poids = somme des tranches')
  check(Math.abs(sum('brut') - v.brut) < EPS, 'brut = somme des tranches')
  check(Math.abs(sum('net') - v.net) < EPS, 'net = somme des tranches')
  check(Math.abs(v.provision - (v.brut - v.net)) < EPS, 'provision = brut − net')
  if (v.brut > 0) {
    const attendu = (v.brut - v.net) / v.brut
    check(v.taux_provision != null && Math.abs(v.taux_provision - attendu) < 1e-9, 'taux = provision / brut')
  }

  // 2. The devaluation rate is really applied, per bucket.
  const TAUX: Record<string, number> = {
    second_choix: 0.9, moins_1_an: 0, de_1_a_2_ans: 0.5, plus_2_ans: 0.9,
  }
  for (const b of v.buckets) {
    check(b.taux === TAUX[b.key], `${b.label} : taux ${b.taux} attendu ${TAUX[b.key]}`)
    check(Math.abs(b.net - b.brut * (1 - b.taux)) < EPS,
      `${b.label} : net = brut × (1 − ${b.taux})`, `${eur(b.net)} vs ${eur(b.brut * (1 - b.taux))}`)
  }

  // 3. Buckets must not be degenerate — the timestamp-parsing regression.
  if (v.rouleaux > 0) {
    const nonVides = v.buckets.filter((b) => b.rouleaux > 0).length
    check(nonVides > 1,
      'la répartition par ancienneté est réelle (> 1 tranche peuplée)',
      nonVides === 1
        ? `tout le stock est dans « ${v.buckets.find((b) => b.rouleaux > 0)?.label} » — date_saisie mal parsée ?`
        : 'aucune tranche peuplée')
    const tousVieux = v.buckets.find((b) => b.key === 'plus_2_ans')?.rouleaux === v.rouleaux
    check(!tousVieux, 'tous les rouleaux ne sont pas « plus de 2 ans »')
  }

  // 4. Population matches the legacy predicate, counted independently.
  const rows = await query<Record<string, unknown>>(
    `SELECT IDstock_fini, IDstock_ecru FROM stock_fini
     WHERE IDligne_expedition = 0 AND IDetat_stock_fini = 3`,
  )
  const ecru = await query<Record<string, unknown>>(`SELECT IDstock_ecru FROM stock_ecru`)
  const known = new Set(ecru.map((r) => Number(r.IDstock_ecru) || 0))
  // The valuation skips rolls whose écru parent is missing (no weight to value).
  const attendu = rows.filter((r) => known.has(Number(r.IDstock_ecru) || 0)).length
  check(attendu === v.rouleaux, 'population = IDligne_expedition 0 + état 3 (parent écru connu)',
    `SQL ${attendu} vs valorisation ${v.rouleaux}`)
  const orphelins = rows.length - attendu
  if (orphelins > 0) console.log(`  · ${orphelins} rouleau(x) sans parent écru, exclus de part et d'autre`)
  if (v.pieces_incompletes > 0) {
    console.log(`  · ${v.pieces_incompletes} pièce(s) sans prix d'achat fil — valeur sous-estimée (drapeau filNull)`)
  }

  console.log(failures === 0 ? '\n✓ OK' : `\n✗ ${failures} échec(s)`)
  if (failures) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => closeConnection())
