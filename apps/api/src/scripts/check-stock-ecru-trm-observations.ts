/**
 * HTTP guard for PATCH /api/stock/ecru-trm/:id — the one write of Tombé
 * Métier > Stock (the roll's observations, key edit_stock_ecru, LIVA #1108).
 *
 *   API_BASE=http://localhost:8085/api pnpm --filter @mps/api exec tsx src/scripts/check-stock-ecru-trm-observations.ts
 *
 * What is worth guarding here:
 *   • the round-trip of an ACCENTED value through sqlText and back through the
 *     screen's own GET (the visiteuse writes « ouvrir dans la maille, côté
 *     lisière ») — restored to the stored text afterwards;
 *   • the partition: an ETM roll (IDsociete = 1) is refused with 404, and so is
 *     a roll that does not exist;
 *   • the whitelist: a body carrying `poids` or `second_choix` is refused with
 *     400 rather than silently ignored;
 *   • the key: without edit_stock_ecru (and without admin) the route 403s.
 *
 * Writes a scratch value on ONE TRM roll and puts it back — the dev database
 * is a stale copy of prod, same assumption as every other check script here.
 * Never run it against the production API.
 */
import crypto from 'node:crypto'
import { query, closeConnection } from '../lib/hfsql-auto.js'

const SECRET = process.env.AUTH_COOKIE_SECRET ?? '0374c694f2c73619437d02a53ac73efdc3b7f11c10e2eb8760e771e12681589c'
const API = process.env.API_BASE ?? 'http://localhost:8080/api'
// A shared-table user that is NOT an effective admin and holds no TRM grant —
// the Visitage poste account (IDutilisateur 10), which the catalog's whole
// point is to keep read-only until an admin ticks the key.
const NON_ADMIN_USER = Number(process.env.NON_ADMIN_USER ?? 10)

const b64url = (b: Buffer) => b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const sign = (id: number) => `${id}.${b64url(crypto.createHmac('sha256', SECRET).update(String(id)).digest())}`
const ADMIN_COOKIE = `mps_uid=${sign(1)}; mps_uid_admin=${sign(1)}`
const USER_COOKIE = `mps_uid=${sign(NON_ADMIN_USER)}`

async function api(path: string, init: RequestInit = {}, cookie = ADMIN_COOKIE): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Cookie: cookie, ...(init.headers ?? {}) },
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  OK   ${label}`)
  else { failures++; console.error(`  FAIL ${label}${detail !== undefined ? ` - ${JSON.stringify(detail)}` : ''}`) }
}

const n = (v: unknown) => (v == null ? 0 : Number(v) || 0)
const patch = (id: number | string, body: unknown, cookie?: string) =>
  api(`/stock/ecru-trm/${id}`, { method: 'PATCH', body: JSON.stringify(body) }, cookie)

async function main() {
  console.log(`PATCH /stock/ecru-trm/:id against ${API}\n`)

  // The list the screen opens on — its first row is our scratch roll.
  const list = await api('/stock/ecru-trm?statut=tous')
  check('GET /stock/ecru-trm -> 200', list.status === 200, list.status)
  const target = (list.json ?? [])[0]
  check('the list carries TRM rolls', !!target, list.json?.length)
  const theirs = await query<{ IDstock_ecru: number }>(
    'SELECT TOP 1 IDstock_ecru FROM stock_ecru WHERE IDsociete = 1 ORDER BY IDstock_ecru DESC',
  )
  const foreignId = n(theirs[0]?.IDstock_ecru)
  check('an ETM roll exists to test the partition with', foreignId > 0, foreignId)
  if (!target) { process.exitCode = 1; return }
  const id = n(target.IDstock_ecru)
  const before = String(target.observations ?? '')

  console.log('\nguards')
  const anon = await patch(id, { observations: 'x' }, '')
  check('no cookie -> 401', anon.status === 401, anon.status)
  const user = await patch(id, { observations: 'x' }, USER_COOKIE)
  check(`user ${NON_ADMIN_USER} without edit_stock_ecru -> 403`, user.status === 403, user.status)
  const foreign = await patch(foreignId, { observations: 'x' })
  check(`ETM roll ${foreignId} -> 404 (partition guard)`, foreign.status === 404, foreign.status)
  const missing = await patch(999999999, { observations: 'x' })
  check('unknown id -> 404', missing.status === 404, missing.status)
  const extra = await patch(id, { observations: 'x', poids: 1 })
  check('body with poids -> 400 (whitelist is strict)', extra.status === 400, extra.status)
  const wrongType = await patch(id, { observations: 12 })
  check('non-string observations -> 400', wrongType.status === 400, wrongType.status)

  console.log('\nround-trip (accented value, then restored)')
  // Accents and a degree sign: Latin-1, expected back intact. NOT an em-dash
  // and NOT a curly apostrophe — sqlText folds the typographic dashes and
  // quotes to their ASCII twins on purpose (a Latin-1 byte for the rest of the
  // text is worth more than a « ’ » nobody types on the poste), so one of
  // those here would read as a failure that is not one.
  const probe = `Ouvrir dans la maille, côté lisière, à l'envers - sondage n°${Date.now() % 10000}`
  const put = await patch(id, { observations: `  ${probe}  ` })
  check(`PATCH roll ${id} -> 200`, put.status === 200, put.json)
  check('the response echoes the trimmed value', put.json?.observations === probe, put.json?.observations)
  const detail = await api(`/stock/ecru-trm/${id}`)
  check('GET detail -> 200', detail.status === 200, detail.status)
  check('GET detail reads the accented value back intact', String(detail.json?.observations ?? '') === probe, detail.json?.observations)
  const again = await api('/stock/ecru-trm?statut=tous')
  const row = (again.json ?? []).find((r: any) => n(r.IDstock_ecru) === id)
  check('GET list reads it back too (the table column)', String(row?.observations ?? '') === probe, row?.observations)

  const restore = await patch(id, { observations: before })
  check('restored the original observations', restore.status === 200, restore.status)
  const after = await api(`/stock/ecru-trm/${id}`)
  check('the roll reads as before', String(after.json?.observations ?? '').trim() === before.trim(), after.json?.observations)

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
  process.exitCode = failures === 0 ? 0 : 1
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(() => closeConnection())
