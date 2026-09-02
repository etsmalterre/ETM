/**
 * HTTP guard for the manual stock correction of Fils > Stock (TRM):
 * PUT /api/stock/fil-trm/:id/stock, behind `edit_stock_fil`.
 *
 *   API_BASE=http://localhost:8082/api pnpm --filter @mps/api exec tsx src/scripts/check-stock-fil-edit-trm.ts
 *
 * Exercises the route against the dev API and puts the lot back:
 *   - PUT without edit_stock_fil          → 403 (the key is its own gate, not
 *                                            create_stock_fil's)
 *   - PUT with a negative / missing value → 400
 *   - PUT on an archived lot              → 409 lot_archive
 *   - PUT on an unknown id                → 404
 *   - PUT round-trip on a live lot: `stock` takes the value, `stock_initial`
 *     is untouched (the freinte base must not move), `dernier_pointage` is
 *     stamped today, then the row is restored and re-read from HFSQL.
 *
 * The dev database is a stale copy of prod — safe for scratch writes, same
 * assumption as every other check script here.
 */
import crypto from 'node:crypto'
import { query, closeConnection } from '../lib/hfsql-auto.js'

const SECRET = process.env.AUTH_COOKIE_SECRET ?? '0374c694f2c73619437d02a53ac73efdc3b7f11c10e2eb8760e771e12681589c'
const API = process.env.API_BASE ?? 'http://localhost:8082/api'
const IS_WINDOWS = process.platform === 'win32'

/** A user id that is NOT the admin and holds no TRM permission. It does not
 *  exist in `utilisateur`, which is the point: the gate must refuse before it
 *  looks anything up. */
const NOBODY_ID = 999_999

const b64url = (b: Buffer) => b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const sign = (id: number) => `${id}.${b64url(crypto.createHmac('sha256', SECRET).update(String(id)).digest())}`
const ADMIN_COOKIE = `mps_uid=${sign(1)}; mps_uid_admin=${sign(1)}`
const NOBODY_COOKIE = `mps_uid=${sign(NOBODY_ID)}`

async function api(
  path: string,
  init: RequestInit = {},
  cookie: string = ADMIN_COOKIE,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(init.headers ?? {}) },
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  OK   ${label}`)
  else {
    failures++
    console.error(`  FAIL ${label}${detail !== undefined ? ` - ${JSON.stringify(detail)}` : ''}`)
  }
}

const n = (v: unknown) => (v == null ? 0 : Number(v) || 0)
const digits = (v: unknown) => String(v ?? '').replace(/[^0-9]/g, '').slice(0, 8)
const today = (() => {
  const d = new Date()
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
})()

interface Raw { stock: number; stock_initial: number; dernier_pointage: string }

/** The three columns straight from HFSQL, so the restore is verified against
 *  the base and not against the API's own echo. All three are ASCII-named and
 *  none is a memo, so the same named select works on both drivers. */
async function readRaw(id: number): Promise<Raw | null> {
  const rows = await query<Record<string, unknown>>(
    `SELECT stock, stock_initial, dernier_pointage FROM stock_fil WHERE IDstock_fil = ${id}`,
  )
  const r = rows[0]
  if (!r) return null
  return { stock: n(r.stock), stock_initial: n(r.stock_initial), dernier_pointage: digits(r.dernier_pointage) }
}

/** One live lot and one archived lot. The accented flag cannot be named on
 *  the Linux bridge, so there the split is done in JS on a `SELECT *`. */
async function pickLots(): Promise<{ live: number; archived: number }> {
  if (IS_WINDOWS) {
    const live = await query<{ IDstock_fil: number }>(
      `SELECT TOP 1 IDstock_fil FROM stock_fil WHERE terminé = 0 AND stock > 0 ORDER BY IDstock_fil DESC`,
    )
    const archived = await query<{ IDstock_fil: number }>(
      `SELECT TOP 1 IDstock_fil FROM stock_fil WHERE terminé = 1 ORDER BY IDstock_fil DESC`,
    )
    return { live: n(live[0]?.IDstock_fil), archived: n(archived[0]?.IDstock_fil) }
  }
  const rows = await query<Record<string, unknown>>(`SELECT * FROM stock_fil`)
  const termineKey = (r: Record<string, unknown>) => Object.keys(r).find((k) => /^termin/i.test(k)) ?? ''
  let live = 0
  let archived = 0
  for (const r of rows) {
    const id = n(r.IDstock_fil)
    const t = n(r[termineKey(r)])
    if (t === 0 && n(r.stock) > 0 && id > live) live = id
    if (t === 1 && id > archived) archived = id
  }
  return { live, archived }
}

async function main() {
  console.log(`PUT /stock/fil-trm/:id/stock against ${API}\n`)

  const { live, archived } = await pickLots()
  if (!live) {
    console.error('  FAIL no live lot with stock > 0 to test with')
    process.exitCode = 1
    return
  }
  console.log(`  scratch lot: #${live}${archived ? `, archived lot: #${archived}` : ''}`)

  // ── Gate and validation ──────────────────────────────
  console.log('\ngate')
  const denied = await api(`/stock/fil-trm/${live}/stock`, { method: 'PUT', body: JSON.stringify({ stock: 1 }) }, NOBODY_COOKIE)
  check('without edit_stock_fil → 403', denied.status === 403, denied.status)
  check('…and the refusal names the key', String(denied.json?.error ?? '').includes('edit_stock_fil'), denied.json)

  console.log('\nvalidation')
  const negative = await api(`/stock/fil-trm/${live}/stock`, { method: 'PUT', body: JSON.stringify({ stock: -1 }) })
  check('negative stock → 400', negative.status === 400, negative.status)
  const missing = await api(`/stock/fil-trm/${live}/stock`, { method: 'PUT', body: JSON.stringify({}) })
  check('missing stock → 400', missing.status === 400, missing.status)
  const text = await api(`/stock/fil-trm/${live}/stock`, { method: 'PUT', body: JSON.stringify({ stock: 'douze' }) })
  check('non-numeric stock → 400', text.status === 400, text.status)
  const unknown = await api(`/stock/fil-trm/999999999/stock`, { method: 'PUT', body: JSON.stringify({ stock: 1 }) })
  check('unknown lot → 404', unknown.status === 404, unknown.status)
  if (archived) {
    const frozen = await api(`/stock/fil-trm/${archived}/stock`, { method: 'PUT', body: JSON.stringify({ stock: 1 }) })
    check('archived lot → 409 lot_archive', frozen.status === 409 && frozen.json?.error === 'lot_archive', frozen)
  }

  // ── Round-trip ───────────────────────────────────────
  console.log('\nround-trip')
  const before = await readRaw(live)
  if (!before) {
    console.error('  FAIL could not read the scratch lot')
    process.exitCode = 1
    return
  }
  const target = Math.round((before.stock + 1.25) * 1000) / 1000
  const put = await api(`/stock/fil-trm/${live}/stock`, { method: 'PUT', body: JSON.stringify({ stock: target }) })
  check('PUT with the right → 200', put.status === 200, put)
  check('the echo carries the new stock', Math.abs(n(put.json?.stock) - target) < 0.01, put.json?.stock)
  const after = await readRaw(live)
  check('HFSQL holds the new stock', !!after && Math.abs(after.stock - target) < 0.01, after)
  check('stock_initial untouched', !!after && after.stock_initial === before.stock_initial, { before, after })
  check(`dernier_pointage stamped ${today}`, !!after && after.dernier_pointage === today, after?.dernier_pointage)
  check('the value is accepted as a string too', (await api(`/stock/fil-trm/${live}/stock`, { method: 'PUT', body: JSON.stringify({ stock: String(target) }) })).status === 200)

  // ── Restore, straight in HFSQL (the route stamps today, the original date
  //    must come back as it was) ────────────────────────
  const pointage = before.dernier_pointage ? `'${before.dernier_pointage}'` : 'NULL'
  await query(`UPDATE stock_fil SET stock = ${before.stock}, dernier_pointage = ${pointage} WHERE IDstock_fil = ${live}`)
  const restored = await readRaw(live)
  check(
    'restored as found',
    !!restored &&
      Math.abs(restored.stock - before.stock) < 0.001 &&
      restored.dernier_pointage === before.dernier_pointage,
    { before, restored },
  )

  console.log(failures === 0 ? '\nALL OK' : `\n${failures} FAILURE(S)`)
  if (failures > 0) process.exitCode = 1
  await closeConnection()
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
