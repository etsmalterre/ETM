/**
 * HTTP guard for the ticket widget's follow-up opt-in (LIVA tracker
 * `bugs.follow_up` — "email me on every status change") and, since widget
 * v1.3.0, for reporting WITHOUT a mapped email.
 *
 *   API_BASE=http://localhost:8083/api pnpm --filter @mps/api exec tsx src/scripts/check-tickets-follow.ts
 *
 * Two sessions are exercised: `USER_WITH_EMAIL` (default 1, must have an
 * address in data/user-emails.json — on a fresh worktree copy the file from
 * the main checkout) and `USER_WITHOUT_EMAIL` (default 10, the `Visitage`
 * compte-poste, which must NOT have one).
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
 *    well-formed id that does not belong to the caller, and with the
 *    no-email user's ticket read as the other user.
 *  - An account without an email still reports (v1.3.0): 201 under a synthetic
 *    `.invalid` identity, `follow_up` forced off whatever the client sent, the
 *    station hint appended to the account name, `PATCH /follow` refused, and
 *    `GET /reporter` saying `can_follow: false` so the widget hides the
 *    controls. Before 1.3.0 that account got a 400 and could not report at all.
 *  - The hint is ignored for an account WITH an email — otherwise any client
 *    could rename its tickets' reporter.
 *
 * It creates two real tickets on whatever tracker `ISSUE_TRACKER_URL` points
 * at, titled `[CHECK]`, and leaves them — the public API has no delete. Point
 * the dev API at a local tracker before running, or expect test tickets on the
 * board (and the new-ticket notification mail that goes with each).
 */
import crypto from 'node:crypto'

const SECRET = process.env.AUTH_COOKIE_SECRET ?? '0374c694f2c73619437d02a53ac73efdc3b7f11c10e2eb8760e771e12681589c'
const API = process.env.API_BASE ?? 'http://localhost:8080/api'
// Which mount to exercise: `tickets` (ETM web) or `tickets-trm` (TRM web).
const MOUNT = process.env.TICKETS_MOUNT ?? 'tickets-trm'
const USER_WITH_EMAIL = Number(process.env.USER_WITH_EMAIL ?? 1)
const USER_WITHOUT_EMAIL = Number(process.env.USER_WITHOUT_EMAIL ?? 10)

const b64url = (b: Buffer) => b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
const sign = (id: number) => `${id}.${b64url(crypto.createHmac('sha256', SECRET).update(String(id)).digest())}`
const cookieFor = (id: number) => `mps_uid=${sign(id)}; mps_uid_admin=${sign(id)}`

async function api(path: string, init: RequestInit = {}, as = USER_WITH_EMAIL): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API}/${MOUNT}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Cookie: cookieFor(as), ...(init.headers ?? {}) },
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

let failures = 0
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  OK   ${label}`)
  else { failures++; console.error(`  FAIL ${label}${detail !== undefined ? ` - ${JSON.stringify(detail)}` : ''}`) }
}

async function withEmail(): Promise<void> {
  console.log(`\n-- user ${USER_WITH_EMAIL} (mapped email)`)

  const who = await api('/reporter')
  check('GET /reporter says the account can follow', who.status === 200 && who.json?.can_follow === true, who.json)
  if (who.status === 200 && who.json?.can_follow !== true) {
    console.error(`     user ${USER_WITH_EMAIL} has no email in data/user-emails.json - set USER_WITH_EMAIL or copy the file from the main checkout`)
  }

  const created = await api('', {
    method: 'POST',
    body: JSON.stringify({
      title: '[CHECK] follow-up opt-in',
      description: 'Automated guard - check-tickets-follow.ts. Safe to close.',
      severity: 'cosmetique',
      category: 'bug',
      context: 'check-tickets-follow.ts',
      follow_up: true,
      // Must be ignored: this account's identity is its session.
      reporter_name: 'Spoofed Name',
    }),
  })
  check('POST / creates the ticket', created.status === 201, { status: created.status, body: created.json })
  if (created.status !== 201) { console.error('\nCannot continue without a ticket.'); process.exit(1) }

  const id: string = created.json.id
  console.log(`  ticket ${created.json.number} (${id})`)

  check('follow_up survives the create payload', created.json.follow_up === true, created.json.follow_up)
  check('the station hint is ignored for an account with an email',
    typeof created.json.reporter_name === 'string' && !created.json.reporter_name.includes('Spoofed'),
    created.json.reporter_name)
  check('the reporter email is the mapped one, not a synthetic address',
    typeof created.json.reporter_email === 'string' && !created.json.reporter_email.endsWith('.invalid'),
    created.json.reporter_email)

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
}

async function withoutEmail(): Promise<void> {
  const as = USER_WITHOUT_EMAIL
  console.log(`\n-- user ${as} (no mapped email)`)

  const who = await api('/reporter', {}, as)
  check('GET /reporter answers 200 with can_follow: false', who.status === 200 && who.json?.can_follow === false, who.json)
  check('GET /reporter never returns the email', who.status === 200 && !('email' in (who.json ?? {})), who.json)
  const accountName: string = who.json?.name ?? ''

  const created = await api('', {
    method: 'POST',
    body: JSON.stringify({
      title: '[CHECK] report without an email',
      description: 'Automated guard - check-tickets-follow.ts. Safe to close.',
      severity: 'cosmetique',
      category: 'bug',
      context: 'check-tickets-follow.ts',
      follow_up: true, // must be forced off
      reporter_name: 'Guard Visiteuse',
    }),
  }, as)
  check('POST / creates the ticket (no 400 any more)', created.status === 201, { status: created.status, body: created.json })
  if (created.status !== 201) return

  const id: string = created.json.id
  console.log(`  ticket ${created.json.number} (${id})`)

  check('the identity is a synthetic .invalid address',
    typeof created.json.reporter_email === 'string' && /^utilisateur-\d+@.+\.invalid$/.test(created.json.reporter_email),
    created.json.reporter_email)
  check('follow_up is forced off whatever the client sent', created.json.follow_up === false, created.json.follow_up)
  check('the station hint is appended to the account name',
    created.json.reporter_name === `Guard Visiteuse (${accountName})`,
    { got: created.json.reporter_name, account: accountName })

  const mine = await api(`/${id}`, {}, as)
  check('GET /:id as the reporter', mine.status === 200, mine.status)
  const theirs = await api(`/${id}`)
  check('GET /:id as another user 404s', theirs.status === 404, theirs.status)

  const follow = await api(`/${id}/follow`, { method: 'PATCH', body: JSON.stringify({ follow_up: true }) }, as)
  check('PATCH /:id/follow is refused (400 no_reporter_email)',
    follow.status === 400 && follow.json?.error === 'no_reporter_email', { status: follow.status, body: follow.json })

  const list = await api('?per_page=100', {}, as)
  const row = (list.json?.items ?? []).find((t: any) => t.id === id)
  check('the ticket is listed under the synthetic identity', !!row && row.follow_up === false, row)
}

async function main(): Promise<void> {
  console.log(`Ticket follow-up guard - ${API}/${MOUNT}`)
  await withEmail()
  await withoutEmail()
  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
