/**
 * HTTP guard for the ticket widget's follow-up opt-in (LIVA tracker
 * `bugs.follow_up` — "email me on every status change").
 *
 *   API_BASE=http://localhost:8083/api pnpm --filter @mps/api exec tsx src/scripts/check-tickets-follow.ts
 *
 * What it guards, and why each one is a real risk:
 *
 *  - `follow_up` survives the POST. The proxy validates the body with zod and
 *    drops anything it does not name, so a missing field in `submitBody` fails
 *    silently: the ticket is created, the user is told they will be kept
 *    posted, and no mail ever comes.
 *  - `PATCH /:id/follow` round-trips both ways. This is the only public write
 *    the tracker allows on an existing ticket; if the tracker is older than the
 *    route the call 404s and the widget's toggle silently snaps back.
 *  - A ticket that isn't yours 404s. The tracker API key is *company*-scoped,
 *    so without the proxy's reporter check any user of the company could
 *    subscribe themselves to a colleague's ticket. Guarded here with a
 *    well-formed id that does not belong to the caller.
 *
 * It creates a real ticket on whatever tracker `ISSUE_TRACKER_URL` points at,
 * titled `[CHECK]`, and leaves it — the public API has no delete. Point the dev
 * API at a local tracker before running, or expect a test ticket on the board
 * (and the new-ticket notification mail that goes with it).
 */
import crypto from 'node:crypto'

const SECRET = process.env.AUTH_COOKIE_SECRET ?? '0374c694f2c73619437d02a53ac73efdc3b7f11c10e2eb8760e771e12681589c'
const API = process.env.API_BASE ?? 'http://localhost:8080/api'
// Which mount to exercise: `tickets` (ETM web) or `tickets-trm` (TRM web).
const MOUNT = process.env.TICKETS_MOUNT ?? 'tickets-trm'

const b64url = (b: Buffer) => b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const sign = (id: number) => `${id}.${b64url(crypto.createHmac('sha256', SECRET).update(String(id)).digest())}`
const COOKIE = `mps_uid=${sign(1)}; mps_uid_admin=${sign(1)}`

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}/${MOUNT}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Cookie: COOKIE, ...(init.headers ?? {}) },
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  OK   ${label}`)
  else { failures++; console.error(`  FAIL ${label}${detail !== undefined ? ` - ${JSON.stringify(detail)}` : ''}`) }
}

async function main(): Promise<void> {
  console.log(`Ticket follow-up guard - ${API}/${MOUNT}\n`)

  const created = await api('', {
    method: 'POST',
    body: JSON.stringify({
      title: '[CHECK] follow-up opt-in',
      description: 'Automated guard - check-tickets-follow.ts. Safe to close.',
      severity: 'cosmetique',
      category: 'bug',
      context: 'check-tickets-follow.ts',
      follow_up: true,
    }),
  })
  check('POST / creates the ticket', created.status === 201, { status: created.status, body: created.json })
  if (created.status !== 201) { console.error('\nCannot continue without a ticket.'); process.exit(1) }

  const id: string = created.json.id
  console.log(`  ticket ${created.json.number} (${id})\n`)

  check('follow_up survives the create payload', created.json.follow_up === true, created.json.follow_up)

  const detail = await api(`/${id}`)
  check('GET /:id reports follow_up', detail.status === 200 && detail.json?.follow_up === true, {
    status: detail.status,
    follow_up: detail.json?.follow_up,
  })

  const off = await api(`/${id}/follow`, { method: 'PATCH', body: JSON.stringify({ follow_up: false }) })
  check('PATCH /:id/follow turns it off', off.status === 200 && off.json?.follow_up === false, {
    status: off.status,
    body: off.json,
  })

  const on = await api(`/${id}/follow`, { method: 'PATCH', body: JSON.stringify({ follow_up: true }) })
  check('PATCH /:id/follow turns it back on', on.status === 200 && on.json?.follow_up === true, {
    status: on.status,
    body: on.json,
  })

  const bad = await api(`/${id}/follow`, { method: 'PATCH', body: JSON.stringify({ follow_up: 'oui' }) })
  check('PATCH rejects a non-boolean', bad.status === 400, bad.status)

  // Well-formed id, not the caller's ticket -> the ownership check must 404.
  const foreign = await api('/00000000-0000-0000-0000-0000000000ff/follow', {
    method: 'PATCH',
    body: JSON.stringify({ follow_up: true }),
  })
  check("PATCH on someone else's ticket 404s", foreign.status === 404, foreign.status)

  const list = await api('?per_page=100')
  const row = (list.json?.items ?? []).find((t: any) => t.id === id)
  check('the ticket is listed with follow_up on', row?.follow_up === true, row?.follow_up)

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
