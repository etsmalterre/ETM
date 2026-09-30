// Dev helper: prints a signed `mps_uid` cookie value for an id — to test how
// the API treats a browser still holding an old cookie (e.g. a merged per-PC
// id). Uses the dev AUTH_COOKIE_SECRET; refuses to run in production.
//
//   npx tsx src/scripts/sign-cookie-dev.ts 18
import '../load-env.js'
import { signUserId } from '../lib/auth.js'

if (process.env.NODE_ENV === 'production') throw new Error('dev only')
const id = parseInt(process.argv[2] ?? '', 10)
if (!Number.isInteger(id) || id <= 0) throw new Error('usage: sign-cookie-dev.ts <IDutilisateur>')
console.log(signUserId(id))
