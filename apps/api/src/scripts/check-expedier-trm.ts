/**
 * HTTP guard for « Expédier » from Clients › Commandes (TRM) — LIVA #1109.
 *
 *   API_BASE=http://localhost:808N/api pnpm exec tsx src/scripts/check-expedier-trm.ts
 *
 * Picks an open TRM order line of Ets Malterre with at least two unshipped
 * rolls, ships two of them through POST /commandes-trm/:id/lignes/:l/expedier,
 * checks what the legacy writes (one avis, one ligne_expedition, rolls stamped
 * `trm<n°>` and flipped to société 1), then deletes the avis through
 * DELETE /expeditions-trm/:id and checks the rolls came back to TRM untouched.
 *
 * It CREATES an avis and deletes it again — the dev database is a stale
 * snapshot of prod, same scratch-write assumption as the other check scripts.
 * ⚠️ NEVER point it at the production API.
 */
import crypto from 'node:crypto'
import { query, closeConnection } from '../lib/hfsql-auto.js'

const SECRET = process.env.AUTH_COOKIE_SECRET ?? '0374c694f2c73619437d02a53ac73efdc3b7f11c10e2eb8760e771e12681589c'
const API = process.env.API_BASE ?? 'http://localhost:8080/api'
if (/trm\.malterre|10\.10\.2\./.test(API)) { console.error('Refusing to run against a production host.'); process.exit(2) }

const b64url = (b: Buffer) => b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const sign = (id: number) => `${id}.${b64url(crypto.createHmac('sha256', SECRET).update(String(id)).digest())}`
const COOKIE = `mps_uid=${sign(1)}; mps_uid_admin=${sign(1)}`

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  OK   ${label}`)
  else { failures++; console.error(`  FAIL ${label}${detail !== undefined ? ` - ${JSON.stringify(detail)}` : ''}`) }
}

async function api(path: string, init: RequestInit = {}, auth = true): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Cookie: COOKIE } : {}), ...(init.headers ?? {}) },
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

interface Roll { IDstock_ecru: number; IDsociete: number; lot: string | null; IDligne_expedition_TRM: number }
async function rolls(ids: number[]): Promise<Roll[]> {
  return query<Roll>(`SELECT IDstock_ecru, IDsociete, lot, IDligne_expedition_TRM FROM stock_ecru WHERE IDstock_ecru IN (${ids.join(',')})`)
}

/** An open société-2 order of Ets Malterre (client 1) with a line holding ≥ 2
 *  unshipped TRM rolls. */
async function pickLine(): Promise<{ commande: number; ligne: number; ids: number[] } | null> {
  const cmds = await query<{ IDcommande_client: number }>(
    `SELECT IDcommande_client FROM commande_client WHERE IDsociete = 2 AND est_soldee = 0 AND IDclient = 1 ORDER BY IDcommande_client DESC`,
  )
  for (const c of cmds) {
    const lines = await query<{ IDligne_commande_client: number }>(
      `SELECT IDligne_commande_client FROM ligne_commande_client WHERE IDcommande_client = ${Number(c.IDcommande_client)}`,
    )
    for (const l of lines) {
      const free = await query<{ IDstock_ecru: number }>(
        `SELECT IDstock_ecru FROM stock_ecru WHERE IDLigne_Commande_TRM = ${Number(l.IDligne_commande_client)} AND IDsociete = 2 AND IDligne_expedition_TRM = 0 ORDER BY IDstock_ecru`,
      )
      if (free.length >= 2) {
        return { commande: Number(c.IDcommande_client), ligne: Number(l.IDligne_commande_client), ids: free.slice(0, 2).map((r) => Number(r.IDstock_ecru)) }
      }
    }
  }
  return null
}

async function main() {
  console.log(`API ${API}`)
  const pick = await pickLine()
  if (!pick) { console.error('No open Ets Malterre line with 2 free rolls on this base — nothing to check.'); process.exit(1) }
  console.log(`commande ${pick.commande} · ligne ${pick.ligne} · rolls ${pick.ids.join(', ')}`)
  const base = `/commandes-trm/${pick.commande}/lignes/${pick.ligne}`

  console.log('\n1. Guards')
  const noAuth = await api(`${base}/expedier`, { method: 'POST', body: JSON.stringify({ stockIds: pick.ids }) }, false)
  check('POST without cookie → 401', noAuth.status === 401, noAuth)
  const empty = await api(`${base}/expedier`, { method: 'POST', body: JSON.stringify({ stockIds: [] }) })
  check('POST with empty selection → 400', empty.status === 400, empty)

  console.log('\n2. Ship two rolls')
  const before = await api(`${base}/pieces`)
  const freeBefore = (before.json?.pieces ?? []).filter((p: any) => !p.expedie).length
  const ship = await api(`${base}/expedier`, { method: 'POST', body: JSON.stringify({ stockIds: pick.ids }) })
  check('POST expedier → 201', ship.status === 201, ship)
  const expId = Number(ship.json?.IDexpedition) || 0
  check('response names the avis and 2 shipped', expId > 0 && ship.json?.shipped === 2 && ship.json?.ignored === 0, ship.json)
  if (expId <= 0) { await closeConnection(); process.exit(1) }

  const after = await rolls(pick.ids)
  check('both rolls stamped lot trm<n°>', after.every((r) => (r.lot ?? '').trim() === `trm${expId}`), after)
  check('both rolls handed to société 1 (client Ets Malterre)', after.every((r) => Number(r.IDsociete) === 1), after)
  check('both rolls on a ligne_expedition', after.every((r) => Number(r.IDligne_expedition_TRM) > 0), after)
  const le = await query<{ IDligne_expedition: number; IDligne_commande_client: number }>(
    `SELECT IDligne_expedition, IDligne_commande_client FROM ligne_expedition WHERE IDexpedition = ${expId}`,
  )
  check('exactly one ligne_expedition, on this line', le.length === 1 && Number(le[0].IDligne_commande_client) === pick.ligne, le)

  const pieces = await api(`${base}/pieces`)
  const freeAfter = (pieces.json?.pieces ?? []).filter((p: any) => !p.expedie).length
  check('Affectation tab shows 2 fewer unshipped rolls', freeAfter === freeBefore - 2, { freeBefore, freeAfter })
  const exps = await api(`/commandes-trm/${pick.commande}/expeditions`)
  const mine = (exps.json?.expeditions ?? []).find((e: any) => e.id === expId)
  check('Expédition tab lists the new avis with 2 rolls', !!mine && mine.rolls?.length === 2, mine)
  const detail = await api(`/expeditions-trm/${expId}`)
  check('Clients › Expéditions opens it', detail.status === 200, detail.status)

  const again = await api(`${base}/expedier`, { method: 'POST', body: JSON.stringify({ stockIds: pick.ids }) })
  check('shipping the same rolls again → 400 aucune_piece_expediable', again.status === 400 && again.json?.error === 'aucune_piece_expediable', again)

  console.log('\n3. Delete the avis — rolls come back')
  const del = await api(`/expeditions-trm/${expId}`, { method: 'DELETE' })
  check('DELETE avis → 200', del.status === 200, del)
  const back = await rolls(pick.ids)
  check('rolls back to société 2, lot cleared, unshipped',
    back.every((r) => Number(r.IDsociete) === 2 && !(r.lot ?? '').trim() && Number(r.IDligne_expedition_TRM) === 0), back)
  const gone = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM expedition WHERE IDexpedition = ${expId}`)
  check('avis row gone', Number(gone[0]?.n) === 0)

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
  await closeConnection()
  process.exit(failures === 0 ? 0 : 1)
}

main().catch(async (e) => { console.error(e); await closeConnection(); process.exit(1) })
