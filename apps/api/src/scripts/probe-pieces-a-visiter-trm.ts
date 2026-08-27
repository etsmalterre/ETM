/**
 * Read-only parity probe for the « Pièces à visiter » dashboard widget
 * (legacy FI_PiecesAVisiter.wdw → routes/dashboard-trm.ts).
 *
 *   cd apps/api && pnpm exec tsx src/scripts/probe-pieces-a-visiter-trm.ts
 *   PROBE_WINDOW_DAYS=400 …   (widen on the stale dev snapshot, which holds no
 *                              piece finished in the last 24 h)
 *
 * Re-runnable against prod after an /etm_deploy — it only reads. That matters
 * more here than usual: the widget's reader deliberately does NOT reproduce the
 * legacy's SQL shape (a LEFT JOIN anti-join, plus SUBSTR on the driver's own
 * DATETIME rendering), because neither travels between the Windows ODBC driver
 * and the Linux bridge. This script runs the legacy SQL and the helper side by
 * side and asserts they answer the same question.
 *
 * §1  the legacy query, verbatim, against the live driver
 * §2  awaitingPieces() (lib/production-trm.ts) over the same window
 * §3  set parity, inside the scan depth
 * §4  the anti-join gap: « a stock_ecru row exists » vs « date_saisie IS NULL »
 * §5  équipe: the parsed hour vs the legacy SUBSTR(date_fin,9,2)
 * §6  the colour ladder on the backlog in window, for eyeballing
 */
import { query, closeConnection } from '../lib/hfsql-auto.js'
import { awaitingPieces, PIECE_SCAN_DEPTH } from '../lib/production-trm.js'

const IS_WINDOWS = process.platform === 'win32'

/** The window the widget uses in prod. Widened via the env var only so a stale
 *  dev snapshot still has rows to compare — parity is what is measured here,
 *  not the cutoff. */
const WINDOW_DAYS = Number(process.env.PROBE_WINDOW_DAYS ?? '1') || 1

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  OK   ${label}`)
  else { failures++; console.error(`  FAIL ${label} — ${JSON.stringify(detail ?? null)}`) }
}

const n = (v: unknown) => (v == null ? 0 : Number(v) || 0)

type Equipe = 'Matin' | 'Après-Midi' | 'Nuit'
/** The endpoint's rule, restated locally so the probe measures the RULE against
 *  the database rather than re-importing the thing under test. */
function equipeAt(ms: number): Equipe {
  const h = new Date(ms).getHours()
  if (h >= 5 && h < 13) return 'Matin'
  if (h >= 13 && h < 21) return 'Après-Midi'
  return 'Nuit'
}

async function main() {
  console.log(`« Pièces à visiter » parity — driver ${IS_WINDOWS ? 'Windows ODBC' : 'Linux bridge'}, window ${WINDOW_DAYS} d\n`)

  // ── §1 the legacy query, verbatim ──────────────────────
  console.log('§1 legacy SQL (FI_PiecesAVisiter.ReqRestant)')
  let legacy: Array<Record<string, unknown>> = []
  let legacyRan = true
  try {
    legacy = await query<Record<string, unknown>>(
      `SELECT piece_production.IDpiece_production, machine.emplacement,
              piece_production.numero, piece_production.date_fin
       FROM piece_production
       LEFT JOIN ordre_fabrication ON ordre_fabrication.IDordre_fabrication = piece_production.IDordre_fabrication
       LEFT JOIN machine ON machine.IDmachine = ordre_fabrication.IDmachine
       LEFT JOIN stock_ecru ON stock_ecru.IDpiece_production = piece_production.IDpiece_production
       WHERE stock_ecru.date_saisie IS NULL
         AND piece_production.date_fin > DATEADD(DAY,-${WINDOW_DAYS},SYSDATE)
       ORDER BY piece_production.date_fin ASC`,
    )
    console.log(`  ${legacy.length} rows`)
  } catch (err) {
    legacyRan = false
    // Not a failure: that this shape does not travel is precisely why the
    // helper exists. Report which driver refused it.
    console.log(`  legacy SQL refused by this driver: ${(err as Error).message.slice(0, 160)}`)
  }

  // ── §2 the helper, same window ─────────────────────────
  console.log('\n§2 awaitingPieces() over the same window')
  const since = Date.now() - WINDOW_DAYS * 86_400_000
  const ours = (await awaitingPieces())
    .filter((p) => (p.date_fin_ms ?? 0) > since)
    .sort((a, b) => (a.date_fin_ms ?? 0) - (b.date_fin_ms ?? 0))
  console.log(`  ${ours.length} rows`)

  // ── §3 set parity ──────────────────────────────────────
  console.log('\n§3 set parity')
  if (!legacyRan) {
    console.log('  skipped — the legacy SQL does not run on this driver (that is the finding)')
  } else {
    // Compare inside the scan depth only. awaitingPieces sweeps the last
    // PIECE_SCAN_DEPTH ids (≈ five months of production); the legacy query has
    // no such floor, so a widened PROBE_WINDOW_DAYS reaches pieces the helper
    // deliberately never looks at. That is a documented cutoff, not a
    // disagreement — at the widget's real 24 h window the two ranges coincide.
    const top = await query<{ m: number | null }>('SELECT MAX(IDpiece_production) AS m FROM piece_production')
    const floor = Math.max(0, n(top[0]?.m) - PIECE_SCAN_DEPTH)
    const all = legacy.map((r) => n(r.IDpiece_production))
    const clipped = all.filter((id) => id < floor)
    const theirs = new Set(all.filter((id) => id >= floor))
    const mine = new Set(ours.map((p) => p.id))
    const onlyLegacy = [...theirs].filter((id) => !mine.has(id))
    const onlyOurs = [...mine].filter((id) => !theirs.has(id))
    check(`same population inside the scan depth (${mine.size} vs ${theirs.size})`,
      onlyLegacy.length === 0 && onlyOurs.length === 0,
      { onlyLegacy: onlyLegacy.slice(0, 20), onlyOurs: onlyOurs.slice(0, 20) })
    console.log(`  ${clipped.length} older piece(s) below the id floor ${floor} — outside PIECE_SCAN_DEPTH by design`)
  }

  // ── §4 the anti-join gap ───────────────────────────────
  // The helper treats "a stock_ecru row exists" as visited; the legacy tests
  // date_saisie IS NULL. A roll inserted with an empty date_saisie would make
  // the two disagree — and would pin its piece on the widget forever.
  console.log('\n§4 anti-join: rolls carrying no date_saisie')
  const blanks = await query<{ c: number }>(
    'SELECT COUNT(*) AS c FROM stock_ecru WHERE date_saisie IS NULL AND IDpiece_production > 0',
  )
  const nBlank = n(blanks[0]?.c)
  check(`no roll has a null date_saisie (${nBlank})`, nBlank === 0, { nBlank })

  // ── §5 équipe ──────────────────────────────────────────
  console.log('\n§5 équipe (parsed hour vs the legacy SUBSTR(date_fin,9,2))')
  const sample = ours.slice(0, 8)
  if (sample.length === 0) console.log('  (no rows in window — widen with PROBE_WINDOW_DAYS)')
  let parsedOk = 0
  let substrIsHour = 0
  for (const p of sample) {
    const raws = await query<Record<string, unknown>>(
      `SELECT date_fin FROM piece_production WHERE IDpiece_production = ${p.id}`,
    )
    const raw = String(raws[0]?.date_fin ?? '')
    const substr = raw.slice(8, 10)
    const ms = p.date_fin_ms as number
    const heure = new Date(ms).getHours()
    // The hour as this driver actually rendered it, whichever shape that is.
    const m = raw.match(/^\d{4}-\d{2}-\d{2}[ T](\d{2})/) ?? raw.match(/^\d{8}(\d{2})/)
    if (m && Number(m[1]) === heure) parsedOk++
    if (substr === String(heure).padStart(2, '0')) substrIsHour++
    console.log(`  #${p.id}  raw="${raw}"  substr(9,2)="${substr}"  heure=${heure}  → ${equipeAt(ms)}`)
  }
  check(`parseDtMs recovers the rendered hour (${parsedOk}/${sample.length})`, parsedOk === sample.length)
  // WinDev's own DATETIME is the compact "AAAAMMJJHHMMSS", where positions
  // 9-10 really are the hour — which is why the legacy window labels the
  // équipe correctly. A driver rendering 'YYYY-MM-DD HH:MM:SS' puts the DAY
  // there instead, and the same CASE would label every piece by day-of-month.
  // Hence the widget derives the équipe from the parsed hour. This line only
  // records which shape this driver speaks; it is never a failure.
  console.log(`  SUBSTR(9,2) is the hour on this driver: ${substrIsHour}/${sample.length}`
    + (sample.length > 0 && substrIsHour === sample.length
      ? ' (compact WinDev shape)'
      : ' — the legacy CASE would be wrong here'))

  // ── §6 the colour ladder ───────────────────────────────
  console.log('\n§6 colour ladder on the backlog in window (3 h rouge / 2 h orange)')
  const now = Date.now()
  const tally = { rouge: 0, orange: 0, vert: 0 }
  for (const p of ours) {
    const h = (now - (p.date_fin_ms as number)) / 3_600_000
    if (h >= 3) tally.rouge++
    else if (h >= 2) tally.orange++
    else tally.vert++
  }
  console.log(`  rouge ${tally.rouge}  orange ${tally.orange}  vert ${tally.vert}`)

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
  process.exitCode = failures === 0 ? 0 : 1
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(() => closeConnection())
