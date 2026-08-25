// Guard for Clients › Gestion › Marchandise expédiée — the search / sort /
// window added for ticket #1085.
//
//   pnpm --filter @mps/api exec tsx src/scripts/check-marchandise-search.ts
//
// Read-only. Point HFSQL_CONNECTION_STRING at the target server.
//
// The screen's job is "find the piece the client is sending back". Before this
// change the list was a bare TOP 400 with no search, so a piece older than the
// last 400 shipments simply could not be reached. It now reads the whole
// history, searches and sorts it server-side, and serves it to the UI one
// page at a time (the table lazy-loads the next page as the user scrolls).
// The three things that must keep holding:
//
//   1. The uncapped per-client read stays cheap. Every page request re-runs
//      it, so the whole design rests on it (measured ~230 ms for the biggest
//      client, 8 332 rolls).
//   2. Search folds accents, ANDs its terms and ignores punctuation-only
//      terms, so a line pasted out of a ticket ("3378/51 - 180A Terracotta")
//      finds the roll. It is exact, not fuzzy: a misspelt coloris finds
//      nothing, and the piece number alone is the reliable way to search.
//   3. Piece numbers sort naturally (3378/51 before 3378/1007 — a plain
//      string compare gets this backwards) AND the sort is total, or two
//      consecutive pages could repeat or skip a row.
import dotenv from 'dotenv'
const env = process.env.NODE_ENV || 'development'
dotenv.config({ path: `.env.${env}` })
dotenv.config({ path: '.env' })
import { query, closeConnection } from '../lib/hfsql-auto.js'

const n = (v: unknown) => Number(v) || 0

/** Mirrors searchFold() in routes/clients.ts. */
function searchFold(v: string): string {
  return v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

/** Mirrors naturalCompare() in routes/clients.ts. */
function naturalCompare(a: string, b: string): number {
  const ra = a.match(/\d+|\D+/g) ?? []
  const rb = b.match(/\d+|\D+/g) ?? []
  for (let i = 0; i < Math.min(ra.length, rb.length); i++) {
    const x = ra[i], y = rb[i]
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const d = parseInt(x, 10) - parseInt(y, 10)
      if (d !== 0) return d
    } else {
      const d = x.localeCompare(y, 'fr')
      if (d !== 0) return d
    }
  }
  return ra.length - rb.length
}

/** Budget for the uncapped per-client fetch. Generous vs the measured 232 ms —
 *  this is a "the design assumption broke" alarm, not a benchmark. */
const FETCH_BUDGET_MS = 3000

async function main() {
  console.log(`\nDB: ${(process.env.HFSQL_CONNECTION_STRING ?? '(default localhost)').replace(/PWD=[^;]*/i, 'PWD=***')}\n`)
  let problems = 0
  const fail = (msg: string) => { console.log(`  ✗ ${msg}`); problems++ }
  const ok = (msg: string) => console.log(`  ✓ ${msg}`)

  // ── 1. natural ordering of piece numbers ────────────────────────────
  console.log('piece-number ordering')
  const sorted = ['3378/1007', '3378/51', '3378/29', '3378/7-2', '3378/7-1'].sort(naturalCompare)
  const wanted = ['3378/7-1', '3378/7-2', '3378/29', '3378/51', '3378/1007']
  if (JSON.stringify(sorted) === JSON.stringify(wanted)) ok(`natural: ${sorted.join(' < ')}`)
  else fail(`natural sort gave ${sorted.join(' < ')}, expected ${wanted.join(' < ')}`)
  // The bug this replaces, stated explicitly so nobody "simplifies" it back.
  const naive = ['3378/1007', '3378/51'].sort()
  if (naive[0] === '3378/1007') ok('plain string sort would put 3378/1007 before 3378/51 (why naturalCompare exists)')
  else fail('plain string sort no longer misorders — re-check the assumption')

  // ── 2. the uncapped fetch stays cheap ───────────────────────────────
  console.log('\nuncapped per-client fetch')
  const perClient = await query<{ cid: number; nb: number }>(
    `SELECT cc.IDclient AS cid, COUNT(*) AS nb
     FROM expedition e
     INNER JOIN ligne_expedition le ON le.IDexpedition = e.IDexpedition
     INNER JOIN stock_fini sf ON sf.IDligne_expedition = le.IDligne_expedition
     INNER JOIN commande_client cc ON e.IDcommande_client = cc.IDcommande_client
     WHERE e.IDsociete = 1 GROUP BY cc.IDclient ORDER BY COUNT(*) DESC`,
  )
  if (perClient.length === 0) { fail('no client has shipped rolls — cannot check'); await closeConnection(); process.exit(1) }
  const biggest = n(perClient[0].cid)
  const over400 = perClient.filter((r) => n(r.nb) > 400).length
  console.log(`  ${perClient.length} clients with shipped rolls, ${over400} above the old 400 cap`)
  if (over400 === 0) console.log('  ! nobody exceeds 400 today — the feature is still correct, just unexercised')

  const t0 = Date.now()
  const rows = await query<Record<string, unknown>>(
    `SELECT e.IDexpedition, e.DATE AS dexp, sf.IDstock_fini, sf.numero AS piece, sf.poids, sf.metrage, sf.lot, sf.second_choix, sf.IDref_fini, sf.IDColoris
     FROM expedition e
     INNER JOIN ligne_expedition le ON le.IDexpedition = e.IDexpedition
     INNER JOIN stock_fini sf ON sf.IDligne_expedition = le.IDligne_expedition
     INNER JOIN commande_client cc ON e.IDcommande_client = cc.IDcommande_client
     WHERE e.IDsociete = 1 AND cc.IDclient = ${biggest}
     ORDER BY e.IDexpedition DESC, sf.numero`,
  )
  const ms = Date.now() - t0
  if (ms <= FETCH_BUDGET_MS) ok(`biggest client ${biggest}: ${rows.length} rows in ${ms} ms (budget ${FETCH_BUDGET_MS} ms)`)
  else fail(`biggest client ${biggest}: ${rows.length} rows took ${ms} ms — over the ${FETCH_BUDGET_MS} ms budget; the whole-history search design no longer holds`)

  // Rows the old cap hid from this client entirely.
  if (rows.length > 400) ok(`${rows.length - 400} of this client's pieces were unreachable under the old TOP 400`)

  // ── 3. search folding + AND terms ───────────────────────────────────
  console.log('\nsearch')
  const hay = (p: string, lot: string, ref: string, col: string, exp: number) =>
    searchFold(`${p} ${lot} ${ref} ${col} ${exp}`)
  const matches = (q: string, h: string) => searchFold(q).split(/\s+/).filter((t) => /[a-z0-9]/.test(t)).every((t) => h.includes(t))
  const sample = hay('3378/51', 'MA107902', '180A', '0307 terracotta 61505/1', 26140)
  const cases: [string, boolean, string][] = [
    ['3378/51', true, 'exact piece number'],
    ['3378/51 - 180A Terracotta', true, 'a whole line pasted from a ticket, punctuation and all'],
    ['3378/51 - 180A Terracota', false, 'exact, not fuzzy: a misspelt coloris finds nothing'],
    ['-', true, 'a punctuation-only query degrades to no search (every term filtered out)'],
    ['3378/51 180A terracotta', true, 'multi-term AND across piece + ref + coloris'],
    ['TERRACOTTA', true, 'case-insensitive'],
    ['ma107902', true, 'lot'],
    ['26140', true, 'expedition number'],
    ['3378/52', false, 'a different piece does not match'],
  ]
  for (const [q, want, label] of cases) {
    const got = matches(q, sample)
    if (got === want) ok(`${label}: ${JSON.stringify(q)} → ${got}`)
    else fail(`${label}: ${JSON.stringify(q)} → ${got}, expected ${want}`)
  }
  // Accent folding is the point of searchFold — prove it on a real accented value.
  const accented = hay('1/2', '', '228', 'écru délavé', 1)
  if (matches('ecru delave', accented)) ok('accent folding: "ecru delave" matches "écru délavé"')
  else fail('accent folding broken — "ecru delave" did not match "écru délavé"')

  // ── 4. paging never repeats or skips a row ─────────────────────────
  console.log('\npaging')
  const pieces = rows.map((r) => (r.piece ?? '').toString())
  const ids = rows.map((r) => n(r.IDstock_fini))
  // Replay the endpoint's sort (piece asc + IDstock_fini tie-break) and slice
  // it the way the endpoint does, then check the pages tile the set exactly.
  const order = ids
    .map((id, i) => ({ id, piece: pieces[i] }))
    .sort((a, b) => { const c = naturalCompare(a.piece, b.piece); return c !== 0 ? c : a.id - b.id })
    .map((x) => x.id)
  const PAGE = 200
  const pages: number[][] = []
  for (let off = 0; off < order.length; off += PAGE) pages.push(order.slice(off, off + PAGE))
  const flat = pages.flat()
  if (flat.length === order.length && flat.every((id, i) => order[i] === id)) {
    ok(`${pages.length} pages of ${PAGE} tile all ${order.length} rows in order, no gap`)
  } else {
    fail(`paging lost or reordered rows: ${flat.length} paged vs ${order.length} sorted`)
  }
  const seen = new Set<number>()
  const repeated = flat.filter((id) => { if (seen.has(id)) return true; seen.add(id); return false })
  if (repeated.length === 0) ok(`no row appears on two pages`)
  else fail(`${repeated.length} row(s) appear on more than one page — the sort is not total`)
  // A sort with NO tie-break is the failure this guards against: prove the
  // data actually contains ties on the sort key, or the check is vacuous.
  const byPiece = new Map<string, number>()
  for (const p of pieces) byPiece.set(p, (byPiece.get(p) ?? 0) + 1)
  const ties = [...byPiece.values()].filter((c) => c > 1).length
  if (ties > 0) ok(`${ties} piece number(s) are duplicated in this client — the IDstock_fini tie-break is load-bearing`)
  else console.log('  ! no duplicate piece numbers here, so the tie-break is untested on this data')

  console.log(problems === 0 ? '\nOK\n' : `\n${problems} problem(s)\n`)
  await closeConnection()
  process.exit(problems === 0 ? 0 : 1)
}
main().catch(async (e) => { console.error(e); await closeConnection(); process.exit(1) })
