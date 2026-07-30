// Serve the MAIN checkout (master) on its reserved slot 0: API 8080 / web 3000.
// Slot 0 sits outside the 1..6 feature range (see lib.MAIN_SLOT), so a feature
// worktree can never collide with the running master and there's no per-run
// "which port?" decision.
//
//   node scripts/worktree/serve-main.mjs          # bring master up (detached)
//   node scripts/worktree/serve-main.mjs down      # stop it
//   node scripts/worktree/serve-main.mjs status     # report
//
// State lives under reg.main in the shared registry (~/.claude/mps-worktrees.json),
// kept separate from reg.slots so worktree-status and allocateSlot ignore it.
import fs from 'node:fs'
import path from 'node:path'
import {
  MAIN_SLOT, apiPort, webPort, isPortInUse, spawnDetached, killTree,
  mainCheckout, readRegistry, updateRegistry, git, pidAlive, pidOnPort,
  ensureDeps, ensureCorsOrigin, waitForDbHealth, checkCors, tailLog,
} from './lib.mjs'

const API_PORT = apiPort(MAIN_SLOT) // 8080
const WEB_PORT = webPort(MAIN_SLOT) // 3000
const cmd = (process.argv[2] || 'up').trim()

const main = mainCheckout()
const logDir = path.join(main, '.dev-logs')
const apiLog = path.join(logDir, 'main-api.log')
const webLog = path.join(logDir, 'main-web.log')

function currentBranch() {
  try { return git(['-C', main, 'rev-parse', '--abbrev-ref', 'HEAD'], main) } catch { return '?' }
}

async function waitFor(port, label, ms = 90000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await isPortInUse(port)) return true
    await new Promise((r) => setTimeout(r, 1000))
  }
  console.warn(`WARN: ${label} on ${port} did NOT come up within ${ms / 1000}s.`)
  return false
}

function reportLine(label, port, pid, up) {
  console.log(`  ${label.padEnd(4)}: http://localhost:${port}   pid ${pid ?? '?'}   ${up ? 'UP' : 'NOT UP'}`)
}

async function down({ quiet } = {}) {
  const m = readRegistry().main
  if (m) {
    killTree(m.apiPid)
    killTree(m.webPid)
    updateRegistry((reg) => { delete reg.main })
    if (!quiet) console.log('Stopped master (slot 0). API 8080 / web 3000 freed.')
  } else if (!quiet) {
    console.log('No registered master server. Nothing to stop.')
  }
}

async function status() {
  const reg = readRegistry()
  const m = reg.main
  const apiUp = await isPortInUse(API_PORT)
  const webUp = await isPortInUse(WEB_PORT)
  console.log('──────────────────────────────────────────')
  console.log(`Slot 0  main (${currentBranch()})`)
  console.log(`  Checkout : ${main}`)
  reportLine('API', API_PORT, m?.apiPid, apiUp)
  reportLine('Web', WEB_PORT, m?.webPid, webUp)
  if (m && !pidAlive(m.apiPid) && !pidAlive(m.webPid) && !apiUp && !webUp) {
    console.log('  (registry has a stale entry — run `down` to clear it)')
  }
  console.log('──────────────────────────────────────────')
}

async function up() {
  // Slot 0 is routinely HALF up: one side dies (or is killed) while the other keeps
  // its port. A plain "either port in use → bail" check reports that as "already
  // serving" and can never repair it — which is how the API every TRM worktree
  // depends on stayed down while :3000 looked healthy. So: bring up only the side
  // that is actually missing, and never restart the survivor (it may belong to
  // another session). An unregistered survivor gets adopted by its listening PID so
  // `down` can still stop it.
  let apiUp = await isPortInUse(API_PORT)
  let webUp = await isPortInUse(WEB_PORT)
  if (apiUp && webUp) {
    console.log('Master already appears to be serving on slot 0:')
    await status()
    return
  }
  const partial = apiUp || webUp
  // Clear any stale registry entry from a previous crash — but only when slot 0 is
  // fully down: down() kills both pids, which would take the survivor with it.
  if (!partial) await down({ quiet: true })

  // Preflight. The main checkout gets no `up.mjs` treatment (no install, no env
  // wiring), so on a fresh machine it is the one tree that starts broken.
  ensureDeps(main, { label: 'main checkout' })
  ensureCorsOrigin(path.join(main, 'apps/api/.env.development'))

  fs.mkdirSync(logDir, { recursive: true })
  if (partial) {
    console.log(`Slot 0 is half up (API ${apiUp ? 'UP' : 'down'} / web ${webUp ? 'UP' : 'down'}) — starting the missing side only …`)
  } else {
    console.log(`Serving main checkout (${currentBranch()}) on slot 0 — API 8080 / web 3000 …`)
  }
  const prev = readRegistry().main
  const adopt = (port, pid) => (pidAlive(pid) ? pid : pidOnPort(port))
  const apiPid = apiUp
    ? adopt(API_PORT, prev?.apiPid)
    : spawnDetached(main, '@mps/api', `dev:${API_PORT}`, apiLog)
  const webPid = webUp
    ? adopt(WEB_PORT, prev?.webPid)
    : spawnDetached(main, '@mps/web', `dev:${WEB_PORT}`, webLog)

  updateRegistry((reg) => {
    reg.main = {
      branch: currentBranch(), apiPid, webPid, api: API_PORT, web: WEB_PORT,
      startedAt: partial ? prev?.startedAt ?? new Date().toISOString() : new Date().toISOString(),
    }
  })

  if (!apiUp) apiUp = await waitFor(API_PORT, 'API')
  if (!webUp) webUp = await waitFor(WEB_PORT, 'Web')
  // Beyond "the port is open": can the API reach HFSQL, and will the browser's
  // origin be accepted? Both fail invisibly to a port check.
  const db = apiUp ? await waitForDbHealth(API_PORT) : null
  const corsOk = apiUp ? await checkCors(API_PORT, `http://localhost:${WEB_PORT}`) : false

  console.log('──────────────────────────────────────────')
  console.log(`Slot 0  main (${currentBranch()})`)
  console.log(`  Checkout : ${main}`)
  reportLine('API', API_PORT, apiPid, apiUp)
  if (db) {
    const verdict = db.ok ? `OK (${db.ms}ms)` : db.unsupported ? `not checked (${db.error})` : `UNREACHABLE — ${db.error}`
    console.log(`  HFSQL   : ${verdict}`)
  }
  if (apiUp) console.log(`  CORS    : ${corsOk ? `accepts http://localhost:${WEB_PORT}` : `REJECTS http://localhost:${WEB_PORT} — the browser will fail`}`)
  reportLine('Web', WEB_PORT, webPid, webUp)
  console.log(`  Logs     : ${apiLog}`)
  console.log(`             ${webLog}`)
  console.log('──────────────────────────────────────────')
  if (!apiUp) tailLog(apiLog)
  if (!webUp) tailLog(webLog)
  if (!apiUp || !webUp) process.exitCode = 1
  if (db && !db.ok && !db.unsupported) {
    console.log('The API is listening but cannot reach HFSQL — every data screen will hang.')
    process.exitCode = 1
  }
  if (apiUp && !corsOk) {
    console.log(`CORS_ORIGIN in apps/api/.env.development does not allow http://localhost:${WEB_PORT}.`)
    process.exitCode = 1
  }
}

if (cmd === 'down' || cmd === 'stop') await down()
else if (cmd === 'status') await status()
else await up()
