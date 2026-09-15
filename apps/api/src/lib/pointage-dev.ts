/**
 * Dev convenience: no enrolment for the pointage tablet on a LOCAL setup.
 *
 * In production the tablet must be enrolled (routes/pointage.ts): without it
 * any phone on the factory wifi could clock a colleague in, or read everyone's
 * hours. On a developer's machine that gate only gets in the way (every new
 * browser, every new worktree — its `data/appareils-atelier.json` starts
 * empty — would need a code from the ERP), so the routes accept any browser as
 * the pointeuse when BOTH hold:
 *   - NODE_ENV is not 'production';
 *   - the `pointage` connection is a localhost server — the production API
 *     talks to the HFSQL server on the network, so this cannot switch on
 *     there even with NODE_ENV unset, nor for a local API pointed at prod.
 * `POINTAGE_DEV_ENROLEMENT=1` restores the enrolment gate, to work on that flow.
 *
 * Deliberately NOT the atelier PWA's rule (« pas de contournement côté API »):
 * an atelier write carries a person the phone speaks for, the pointeuse has no
 * identity of its own to fake.
 */
import { pointageConnectionString } from './hfsql-pointage.js'

export function estServeurLocal(connectionString: string): boolean {
  return /(?:^|;)\s*Server Name\s*=\s*(localhost|127\.0\.0\.1)\s*(;|$)/i.test(connectionString)
}

export function enrolementContourne(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === 'production') return false
  if (env.POINTAGE_DEV_ENROLEMENT === '1') return false
  return estServeurLocal(pointageConnectionString(env))
}
