/**
 * HTTP guard for PATCH /api/stock/ecru-trm/:id — the one write of Tombé
 * Métier > Stock: the roll's observations (key edit_stock_ecru, LIVA #1108)
 * and its choix (key edit_choix_stock_ecru, LIVA #1150).
 *
 *   API_BASE=http://localhost:8085/api pnpm --filter @mps/api exec tsx src/scripts/check-stock-ecru-trm-observations.ts
 *
 * What is worth guarding here:
 *   • the round-trip of an ACCENTED value through sqlText and back through the
 *     screen's own GET (the visiteuse writes « ouvrir dans la maille, côté
 *     lisière ») — restored to the stored text afterwards;
 *   • the partition: an ETM roll (IDsociete = 1) is refused with 404, and so is
 *     a roll that does not exist;
 *   • the whitelist: a body carrying `poids`, or an empty one, is refused with
 *     400 rather than silently ignored;
 *   • the keys: without edit_stock_ecru (and without admin) `observations`
 *     403s; without edit_choix_stock_ecru `second_choix` 403s — per field;
 *   • the choix flip: the flag moves, the reservation follows (0 on a
 *     déclassé, the OF's line on a re-promoted roll), the number does NOT
 *     move, an evenement_piece row is written, a same-value PATCH is a no-op,
 *     and a shipped roll is refused with 409 rouleau_expedie.
 *
 * Writes scratch values on ONE TRM roll and puts everything back (observations,
 * flag, line — by SQL — and the two event rows are deleted) — the dev database
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
  const empty = await patch(id, {})
  check('empty body -> 400', empty.status === 400, empty.status)
  const wrongType = await patch(id, { observations: 12 })
  check('non-string observations -> 400', wrongType.status === 400, wrongType.status)
  const choixNoKey = await patch(id, { second_choix: true }, USER_COOKIE)
  check(`user ${NON_ADMIN_USER} without edit_choix_stock_ecru -> 403`, choixNoKey.status === 403, choixNoKey.status)
  check('…and the 403 names the choix key', /edit_choix_stock_ecru/.test(String(choixNoKey.json?.error)), choixNoKey.json)

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

  console.log('\nchoix (flip both ways on a roll in stock, then restored by SQL)')
  // The list only serves rolls in stock (IDligne_expedition_TRM = 0), so
  // `target` qualifies. Snapshot flag, line and number straight from the table.
  const snap = (
    await query<Record<string, unknown>>(
      `SELECT IDstock_ecru, IDordre_fabrication, second_choix, num_piece_OF, IDLigne_Commande_TRM, IDligne_expedition_TRM
       FROM stock_ecru WHERE IDstock_ecru = ${id}`,
    )
  )[0]
  const wasSecond = n(snap.second_choix) === 1
  const lineBefore = n(snap.IDLigne_Commande_TRM)
  const numBefore = n(snap.num_piece_OF)
  const ofId = n(snap.IDordre_fabrication)
  const ofLine = ofId > 0
    ? n((await query<Record<string, unknown>>(`SELECT IDligne_commande_client FROM ordre_fabrication WHERE IDordre_fabrication = ${ofId}`))[0]?.IDligne_commande_client)
    : 0
  const countEvents = async () =>
    n((await query<{ c: number }>(`SELECT COUNT(*) AS c FROM evenement_piece WHERE IDstock_ecru = ${id} AND evenement LIKE 'Passage en %'`))[0]?.c)
  const eventsBefore = await countEvents()

  const same = await patch(id, { second_choix: wasSecond })
  check('same value -> 200, choix_change false', same.status === 200 && same.json?.choix_change === false, same.json)
  check('same value writes no event', (await countEvents()) === eventsBefore)

  const flip = await patch(id, { second_choix: !wasSecond })
  check(`flip roll ${id} to ${wasSecond ? '1er' : '2nd'} choix -> 200`, flip.status === 200, flip.json)
  check('the response says choix_change', flip.json?.choix_change === true, flip.json)
  check('the response carries the new flag', n(flip.json?.second_choix) === (wasSecond ? 0 : 1), flip.json)
  const expectedLine = wasSecond ? ofLine : 0
  check(`the reservation follows (line ${expectedLine})`, n(flip.json?.IDLigne_Commande_TRM) === expectedLine, flip.json)
  const mid = (await query<Record<string, unknown>>(`SELECT IDstock_ecru, second_choix, num_piece_OF, IDLigne_Commande_TRM FROM stock_ecru WHERE IDstock_ecru = ${id}`))[0]
  check('the table carries the new flag', n(mid.second_choix) === (wasSecond ? 0 : 1), mid)
  check('the table carries the new line', n(mid.IDLigne_Commande_TRM) === expectedLine, mid)
  check('num_piece_OF did NOT move', n(mid.num_piece_OF) === numBefore, mid)
  check('one event written', (await countEvents()) === eventsBefore + 1)
  const detailMid = await api(`/stock/ecru-trm/${id}`)
  check('GET detail shows the new flag', n(detailMid.json?.second_choix) === (wasSecond ? 0 : 1), detailMid.json?.second_choix)

  const back = await patch(id, { second_choix: wasSecond, observations: before })
  check('flip back (with observations in the same body) -> 200', back.status === 200 && back.json?.choix_change === true, back.json)
  check('two events written in total', (await countEvents()) === eventsBefore + 2)

  // Restore by SQL: the flip back re-derives the line from the OF, which is
  // not necessarily what the roll carried (a manual affectation), and the
  // scratch events must not stay in the timeline.
  await query(`UPDATE stock_ecru SET second_choix = ${wasSecond ? 1 : 0}, IDLigne_Commande_TRM = ${lineBefore} WHERE IDstock_ecru = ${id}`)
  await query(`DELETE FROM evenement_piece WHERE IDstock_ecru = ${id} AND evenement LIKE 'Passage en %'`)
  const end = (await query<Record<string, unknown>>(`SELECT IDstock_ecru, second_choix, IDLigne_Commande_TRM FROM stock_ecru WHERE IDstock_ecru = ${id}`))[0]
  check('restored flag and line', n(end.second_choix) === (wasSecond ? 1 : 0) && n(end.IDLigne_Commande_TRM) === lineBefore, end)
  check('scratch events deleted', (await countEvents()) === 0)

  const shipped = await query<{ IDstock_ecru: number }>(
    'SELECT TOP 1 IDstock_ecru FROM stock_ecru WHERE IDsociete = 2 AND IDligne_expedition_TRM > 0 ORDER BY IDstock_ecru DESC',
  )
  const shippedId = n(shipped[0]?.IDstock_ecru)
  check('a shipped TRM roll exists to test the lock with', shippedId > 0, shippedId)
  if (shippedId > 0) {
    const flag = n((await query<Record<string, unknown>>(`SELECT IDstock_ecru, second_choix FROM stock_ecru WHERE IDstock_ecru = ${shippedId}`))[0]?.second_choix) === 1
    const locked = await patch(shippedId, { second_choix: !flag })
    check(`shipped roll ${shippedId} -> 409 rouleau_expedie`, locked.status === 409 && locked.json?.error === 'rouleau_expedie', locked.json)
  }

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
  process.exitCode = failures === 0 ? 0 : 1
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1 })
  .finally(() => closeConnection())
