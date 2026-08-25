// Guard for Clients › Gestion › Marchandise « Reprendre des pièces »
// (POST /api/clients/:id/marchandise/retour-stock).
//
//   pnpm --filter @mps/api exec tsx src/scripts/check-retour-marchandise.ts
//   pnpm --filter @mps/api exec tsx src/scripts/check-retour-marchandise.ts --repair
//   pnpm --filter @mps/api exec tsx src/scripts/check-retour-marchandise.ts --roundtrip
//
// Point HFSQL_CONNECTION_STRING at the target server (prod HFSQL is 10.10.20.2,
// dev localhost is a separate copy).
//
// WHY THIS EXISTS — ticket #1086, « J'ai fait un retour de 3 pièces facturées,
// et elles n'apparaissent dans aucun stock. » The route used to clear only
// `IDligne_expedition`, but a returned roll has to clear THREE things before it
// is actually reachable again, because three different predicates gate it:
//
//   Finis › Stock (stock-fini.ts, "Masquer les rouleaux expédiés"):
//       IDligne_expedition = 0 AND IDetat_stock_fini <> 4
//   available-rolls pool of any client line (commandes-client.ts):
//       IDligne_commande_client = 0 AND IDligne_expedition = 0
//                              AND IDetat_stock_fini <> 4
//   Clients › Gestion › Marchandise:
//       INNER JOIN on the expedition line — so the roll leaves this tab the
//       moment IDligne_expedition hits 0, whether or not it landed anywhere.
//
// État 4 ("Expédié") is stamped by the legacy WinDev expedition routine on
// virtually every shipped roll, so leaving it set put returned rolls in a hole
// with no screen at all. This script asserts the invariant on every roll that
// carries the route's own « Récupéré chez … » trace, and --repair fixes any
// that were returned before the fix shipped.
import dotenv from 'dotenv'
const env = process.env.NODE_ENV || 'development'
dotenv.config({ path: `.env.${env}` })
dotenv.config({ path: '.env' })
import { query, fixEncoding, closeConnection } from '../lib/hfsql-auto.js'

const REPAIR = process.argv.includes('--repair')
const ROUNDTRIP = process.argv.includes('--roundtrip')
const ETAT_EXPEDIE = 4
const ETAT_VALIDE = 3
// Tolerant of ODBC accent mangling (é → U+FFFD) — never match the accented
// literal in SQL, it corrupts the Linux bridge.
const TRACE_RE = /R.?cup.?r.? chez /i

const n = (v: unknown) => Number(v) || 0
const s = (v: unknown) => (v ?? '').toString().replace(/\u0000/g, '').trim()

/**
 * --roundtrip: take one real shipped roll, apply exactly what the route now
 * writes, assert it becomes visible in Finis › Stock AND offerable to a client
 * line, then restore its original values. Reversible; the observation column is
 * never touched so there is nothing accent-shaped to put back.
 */
async function roundtrip(): Promise<number> {
  console.log('\n── round-trip on one real shipped roll ──')
  const pick = await query<Record<string, unknown>>(
    `SELECT TOP 1 IDstock_fini, numero, IDref_fini, IDColoris, IDetat_stock_fini,
            IDligne_expedition, IDligne_commande_client, IDcommande_donation
     FROM stock_fini
     WHERE IDligne_expedition > 0 AND IDetat_stock_fini = ${ETAT_EXPEDIE}
       AND IDligne_commande_client > 0
     ORDER BY IDstock_fini DESC`,
  )
  if (pick.length === 0) { console.log('  (no candidate roll — skipped)'); return 0 }
  const r = pick[0]
  const id = n(r.IDstock_fini)
  const before = {
    etat: n(r.IDetat_stock_fini),
    le: n(r.IDligne_expedition),
    lcc: n(r.IDligne_commande_client),
  }
  console.log(`  roll ${s(r.numero)} (id ${id}) before: état=${before.etat} ligne_exp=${before.le} ligne_cmd=${before.lcc}`)

  // The two predicates the screens actually use, replayed as SQL against this
  // one roll — not re-implemented in JS, so a change to either is caught here.
  const visibleInStock = async () =>
    (await query<{ nb: number }>(
      `SELECT COUNT(*) AS nb FROM stock_fini WHERE IDstock_fini = ${id}
         AND (IDligne_expedition IS NULL OR IDligne_expedition = 0)
         AND (IDetat_stock_fini IS NULL OR IDetat_stock_fini <> 4)`,
    ))[0]
  const offerableToALine = async () =>
    (await query<{ nb: number }>(
      `SELECT COUNT(*) AS nb FROM stock_fini WHERE IDstock_fini = ${id}
         AND (IDligne_commande_client IS NULL OR IDligne_commande_client = 0)
         AND (IDcommande_donation IS NULL OR IDcommande_donation = 0)
         AND (IDligne_expedition IS NULL OR IDligne_expedition = 0)
         AND (IDetat_stock_fini IS NULL OR IDetat_stock_fini <> 4)`,
    ))[0]

  let bad = 0
  const assertState = async (phase: string, wantStock: boolean, wantPool: boolean) => {
    const inStock = n((await visibleInStock()).nb) > 0
    const inPool = n((await offerableToALine()).nb) > 0
    const ok = inStock === wantStock && inPool === wantPool
    console.log(`  ${ok ? '✓' : '✗'} ${phase}: Finis › Stock=${inStock} (want ${wantStock}), pool disponible=${inPool} (want ${wantPool})`)
    if (!ok) bad++
  }

  await assertState('before return', false, false)
  try {
    await query(
      `UPDATE stock_fini SET IDligne_expedition = 0, IDligne_commande_client = 0,
              IDetat_stock_fini = ${ETAT_VALIDE} WHERE IDstock_fini = ${id}`,
    )
    await assertState('after return ', true, true)
  } finally {
    await query(
      `UPDATE stock_fini SET IDligne_expedition = ${before.le},
              IDligne_commande_client = ${before.lcc},
              IDetat_stock_fini = ${before.etat} WHERE IDstock_fini = ${id}`,
    )
    const back = await query<Record<string, unknown>>(
      `SELECT IDetat_stock_fini, IDligne_expedition, IDligne_commande_client
       FROM stock_fini WHERE IDstock_fini = ${id}`,
    )
    const okBack = n(back[0]?.IDetat_stock_fini) === before.etat
      && n(back[0]?.IDligne_expedition) === before.le
      && n(back[0]?.IDligne_commande_client) === before.lcc
    console.log(`  ${okBack ? '✓' : '✗'} restored to état=${before.etat} ligne_exp=${before.le} ligne_cmd=${before.lcc}`)
    if (!okBack) bad++
  }
  return bad
}

async function main() {
  console.log(`\nDB: ${(process.env.HFSQL_CONNECTION_STRING ?? '(default localhost)').replace(/PWD=[^;]*/i, 'PWD=***')}`)
  console.log(`mode: ${REPAIR ? 'REPAIR (writes)' : ROUNDTRIP ? 'AUDIT + round-trip (writes, then restored)' : 'AUDIT (read-only)'}
`)
  let problems = 0

  // Rolls carrying the route's trace. ' chez ' is ASCII, so the LIKE is safe on
  // both platforms; the accented part is matched in JS after fixEncoding.
  const raw = await query<Record<string, unknown>>(
    `SELECT IDstock_fini, numero, lot, observations, IDetat_stock_fini,
            IDligne_expedition, IDligne_commande_client
     FROM stock_fini WHERE observations LIKE '% chez %'`,
  )
  const fixed = await fixEncoding(raw, 'stock_fini', 'IDstock_fini', ['observations'])
  const returned = (fixed as Record<string, unknown>[]).filter((r) => TRACE_RE.test(s(r.observations)))
  console.log(`rolls carrying a « Récupéré chez … » trace: ${returned.length}`)

  const broken = returned.filter(
    (r) => n(r.IDetat_stock_fini) === ETAT_EXPEDIE || n(r.IDligne_expedition) > 0 || n(r.IDligne_commande_client) > 0,
  )
  if (broken.length === 0) {
    console.log('  ✓ every returned roll is visible in Finis › Stock and free to re-allocate')
  } else {
    console.log(`  ✗ ${broken.length} returned roll(s) unreachable from any stock screen:`)
    for (const r of broken) {
      const why: string[] = []
      if (n(r.IDetat_stock_fini) === ETAT_EXPEDIE) why.push('état 4 Expédié → hidden in Finis › Stock')
      if (n(r.IDligne_expedition) > 0) why.push(`still on expedition line ${n(r.IDligne_expedition)}`)
      if (n(r.IDligne_commande_client) > 0) why.push(`still reserved to commande line ${n(r.IDligne_commande_client)}`)
      console.log(`     ${s(r.numero).padEnd(12)} id=${n(r.IDstock_fini)} — ${why.join('; ')}`)
    }
    problems += broken.length
  }

  // Population check: the état-4 stamp this whole guard is about.
  const shipped = await query<{ etat: number; nb: number }>(
    `SELECT IDetat_stock_fini AS etat, COUNT(*) AS nb FROM stock_fini
     WHERE IDligne_expedition > 0 GROUP BY IDetat_stock_fini`,
  )
  const total = shipped.reduce((a, r) => a + n(r.nb), 0)
  const at4 = n(shipped.find((r) => n(r.etat) === ETAT_EXPEDIE)?.nb)
  console.log(`\nrolls on a shipment line: ${total}, of which état 4 "Expédié": ${at4}`)
  if (total > 0 && at4 / total < 0.5) {
    console.log('  ! état 4 is no longer the norm for shipped rolls — re-read the route comment before trusting it')
  } else {
    console.log('  ✓ état 4 is the norm for shipped rolls, so the route must clear it')
  }

  if (REPAIR && broken.length > 0) {
    console.log('\nrepairing…')
    for (const r of broken) {
      const id = n(r.IDstock_fini)
      if (!(id > 0)) continue
      // ASCII columns only — no accent hazard, plain named UPDATE. Observations
      // are deliberately left untouched: the trace is the audit record.
      const sets = ['IDligne_expedition = 0', 'IDligne_commande_client = 0']
      if (n(r.IDetat_stock_fini) === ETAT_EXPEDIE) sets.push(`IDetat_stock_fini = ${ETAT_VALIDE}`)
      await query(`UPDATE stock_fini SET ${sets.join(', ')} WHERE IDstock_fini = ${id}`)
      console.log(`  ✓ ${s(r.numero)} (id ${id}) → ${sets.join(', ')}`)
    }
    problems = 0
  } else if (broken.length > 0) {
    console.log('\nrun again with --repair to fix them.')
  }

  if (ROUNDTRIP) problems += await roundtrip()

  console.log(problems === 0 ? '\nOK\n' : `\n${problems} problem(s)\n`)
  await closeConnection()
  process.exit(problems === 0 ? 0 : 1)
}
main().catch(async (e) => { console.error(e); await closeConnection(); process.exit(1) })
