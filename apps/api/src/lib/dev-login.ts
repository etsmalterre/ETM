// Dev convenience: « dev · Se connecter comme Vincent » on the login screen.
//
// Since the password login (2026-09-30) every new browser, worktree or Claude
// session on a developer's machine hits the login screen, and a session driving
// the browser must never type a real password. This route opens a session for
// the `vincent` account without one — on a developer's machine only. It is on
// when ALL of these hold, so it cannot switch on in production even if one is
// misconfigured:
//   - NODE_ENV is not 'production';
//   - the database is not the production one (`mps`) — a local API pointed at
//     prod stays password-only;
//   - the request comes straight from this machine (socket loopback, never a
//     forwarded header): the production API is only ever reached through
//     nginx on another host.
// The web button is also compiled out of production bundles (import.meta.env.DEV).

import type { Request } from 'express'

export const DEV_LOGIN_IDENTIFIANT = 'vincent'

/** Database name of a postgres:// connection string ('' when unparsable). */
export function nomBase(connectionString: string | undefined): string {
  try {
    return new URL(connectionString ?? '').pathname.replace(/^\//, '')
  } catch {
    return ''
  }
}

export function estLoopback(remoteAddress: string | undefined): boolean {
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1'
}

/** Whether the server offers the dev login at all (drives /auth/config). */
export function devLoginActif(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === 'production') return false
  const base = nomBase(env.PG_CONNECTION_STRING)
  return base !== '' && base !== 'mps'
}

/** Whether this request may use it. */
export function devLoginAutorise(req: Request, env: NodeJS.ProcessEnv = process.env): boolean {
  return devLoginActif(env) && estLoopback(req.socket.remoteAddress)
}
