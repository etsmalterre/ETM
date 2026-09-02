// Create a feature worktree on a free slot and spin up its dev server(s).
//   node scripts/worktree/up.mjs <feature-name> [ng|trm] [--api <port>] [--restart]
//
// --restart reuses an EXISTING worktree + slot instead of creating anything:
// it kills whatever is still alive, respawns the dev server(s) on the slot's
// recorded ports and refreshes the PIDs. Use it when a tree's servers died (or
// wedged) but the work in it is untouched — the create path deliberately
// aborts on an existing dir, which otherwise leaves hand-rolled spawn scripts
// as the only way back up.
//
// <feature-name> is kebab-case; it yields branch `feat/<name>` and worktree
// `<repo>-<name>` beside the repo (repo = ETM for ng, TRM for trm).
// Project defaults to `ng`. Idempotency is intentionally NOT assumed — if the
// branch or dir already exists the script aborts so you don't clobber work.
//
// ng  → API on 808N + web on 300N (packages @mps/api + @mps/web), CORS spanning
//       all dev ports, secrets copied.
// trm → web only on 517N (package @mps-trm/web). TRM web has no API of its own;
//       it targets the slot-0 master ETM API (8080) by default, or the port
//       given by --api (e.g. an NG worktree's 808N). Requires that API running.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import {
  allocateSlot, getProject, projectMainCheckout, slotKey, updateRegistry,
  spawnDetached, isPortInUse, DEV_WEB_ORIGINS, git, reapPending, PROJECTS, mainCheckout,
  readRegistry, entryProject, parseSlotKey, pidAlive, killTree, dropPending, isMergedRemoteBranch,
  waitForDbHealth, checkCors, probeApiIdentity, resolveMainApiPort, tailLog, ensureDeps, ensureCorsOrigin,
} from './lib.mjs'

// Default project = the repo this script is invoked from (so `up.mjs <feature>`
// makes a TRM worktree when run from the TRM checkout, an NG one from ETM),
// overridable by the positional arg. Falls back to ng if the repo is unrecognized.
function detectDefaultProject() {
  try {
    const base = path.basename(mainCheckout()).toLowerCase()
    const hit = Object.values(PROJECTS).find((p) => p.dirName.toLowerCase() === base)
    return hit ? hit.key : 'ng'
  } catch {
    return 'ng'
  }
}

// Sweep any leftover dirs from earlier completions that are now unlocked.
const swept = reapPending()
if (swept.reaped.length) {
  console.log(`Reaped leftover worktree dir(s): ${swept.reaped.map((e) => e.feature).join(', ')}`)
}
if (swept.resurrected?.length) {
  console.log(`Kept ${swept.resurrected.map((e) => e.feature).join(', ')} — a live slot owns that path (feature name reused).`)
}

// ── Args: <feature> [ng|trm] [--api <port>] ─────────────────────────────────
const argv = process.argv.slice(2)
const restartIdx = argv.indexOf('--restart')
const isRestart = restartIdx !== -1
if (isRestart) argv.splice(restartIdx, 1)
const apiIdx = argv.indexOf('--api')
let apiOverride = null
if (apiIdx !== -1) {
  apiOverride = parseInt(argv[apiIdx + 1], 10)
  if (!Number.isInteger(apiOverride)) {
    console.error('--api needs a port number, e.g. --api 8081')
    process.exit(1)
  }
  argv.splice(apiIdx, 2)
}
const feature = (argv[0] || '').trim()
const projectKey = (argv[1] || detectDefaultProject()).trim().toLowerCase()
if (!/^[a-z0-9][a-z0-9-]*$/.test(feature)) {
  console.error('Usage: node scripts/worktree/up.mjs <feature-name> [ng|trm] [--api <port>] [--restart]  (feature kebab-case)')
  process.exit(1)
}
if (projectKey !== 'ng' && projectKey !== 'trm') {
  console.error(`Unknown project "${projectKey}". Use "ng" or "trm".`)
  process.exit(1)
}
const proj = getProject(projectKey)
if (apiOverride && proj.hasApi) {
  console.warn(`NOTE: --api is ignored for ${proj.label} (it runs its own API on 808N).`)
}

const main = projectMainCheckout(projectKey)
const branch = `feat/${feature}`
const wt = path.join(path.dirname(main), `${proj.dirName}-${feature}`)

// Guards: don't clobber an existing branch or directory (create path only —
// --restart *requires* them to exist).
if (!isRestart) {
  if (fs.existsSync(wt)) {
    console.error(`Worktree dir already exists: ${wt}`)
    console.error(`  To bring its dev servers back up: node scripts/worktree/up.mjs ${feature} ${projectKey} --restart`)
    process.exit(1)
  }
  const branches = git(['-C', main, 'branch', '--list', branch], main)
  if (branches) { console.error(`Branch already exists: ${branch}`); process.exit(1) }
}

console.log(`Project  : ${proj.label}`)

let slot
let api
let web

// Web-only project without --api: don't assume the default port IS the MPS API.
// Probe it, then the documented fallbacks, and take the first that answers
// `"app": "MPS API"`. Says so when it deviates, so the summary line is no surprise.
async function pickMainApi(preferred) {
  const r = await resolveMainApiPort(preferred, proj.defaultApiPort)
  if (r.port !== preferred) {
    const first = r.tried[0].identity
    const why = first.reason === 'foreign' ? `held by another app ("${first.app}")` : 'nothing listening'
    console.log(`MPS API is not on :${preferred} (${why}) — using :${r.port}, where it answers.`)
  }
  return r.port
}

if (isRestart) {
  // Reuse the recorded slot/ports so the tree comes back exactly where it was
  // (its .env files already point at those ports, and the URL the user has open
  // keeps working). No fetch, no install, no env rewrite — the tree is intact.
  if (!fs.existsSync(wt)) {
    console.error(`No worktree at ${wt} — nothing to restart. Drop --restart to create it.`)
    process.exit(1)
  }
  const reg = readRegistry()
  const hit = Object.entries(reg.slots ?? {}).find(
    ([key, e]) => entryProject(e, key) === projectKey && e.feature === feature
  )
  if (!hit) {
    console.error(`No registry entry for ${proj.label} feature "${feature}" — can't tell which slot it owns.`)
    console.error(`  Run: node scripts/worktree/status.mjs   (then down.mjs <name> and re-create if it's gone)`)
    process.exit(1)
  }
  const [key, entry] = hit
  slot = parseSlotKey(key).slot
  api = proj.hasApi ? proj.apiPort(slot) : (apiOverride || entry.apiTarget || proj.defaultApiPort)
  if (!proj.hasApi && !apiOverride) api = await pickMainApi(api)
  web = proj.webPort(slot)

  // Kill anything still alive on the slot first, so we never end up with two
  // dev servers fighting over the same port (a wedged API is still "alive").
  for (const pid of [entry.apiPid, entry.webPid]) {
    if (pid && pidAlive(pid)) {
      console.log(`Killing existing pid ${pid} …`)
      killTree(pid)
    }
  }

  // With our pids dead, the slot's ports MUST be free. If one is still open, a
  // FOREIGN process owns it (seen live 2026-07-24: a global node sweep killed
  // every MPS server, then the LIVA issue tracker took port 3000). Spawning
  // anyway is worse than useless — the post-spawn "UP" check is port-based and
  // can't tell whose port it is, so it would report a dead server as UP. Abort
  // and name the owner instead. (TRM slots skip the API port — it belongs to
  // the NG master API and SHOULD be in use.)
  await new Promise((r) => setTimeout(r, 700)) // let killed trees release their sockets
  const portsToGuard = [...(proj.hasApi ? [['API', api]] : []), ['Web', web]]
  for (const [portLabel, port] of portsToGuard) {
    if (await isPortInUse(port)) {
      console.error(`${portLabel} port ${port} is STILL in use after killing this slot's pids — a foreign process owns it.`)
      console.error(`  Identify it:  powershell "Get-Process -Id (Get-NetTCPConnection -LocalPort ${port} -State Listen).OwningProcess | Select-Object Id,ProcessName,Path"`)
      console.error('  Kill or relocate that process, then re-run with --restart.')
      process.exit(1)
    }
  }
  console.log(`Restarting slot ${slot} → ${proj.hasApi ? `API ${api}, ` : ''}Web ${web}`)
} else {
  console.log(`Fetching origin in ${main} …`)
  execFileSync('git', ['-C', main, 'fetch', 'origin'], { stdio: 'inherit' })

  slot = await allocateSlot(projectKey)
  api = proj.hasApi ? proj.apiPort(slot) : (apiOverride || proj.defaultApiPort)
  if (!proj.hasApi && !apiOverride) api = await pickMainApi(api)
  web = proj.webPort(slot)
  if (proj.hasApi) console.log(`Slot ${slot} → API ${api}, Web ${web}`)
  else console.log(`Slot ${slot} → Web ${web} (targets ETM API on ${api})`)

  // Reusing a feature name rebuilds the exact same path, so a pending removal
  // queued for the OLD tree of that name would match this brand-new one and the
  // next worktree skill would delete it (see reapPending's note). We are
  // deliberately (re)creating this path, so that entry is void — drop it now
  // rather than relying on the slot being registered before the next reap runs.
  const voided = dropPending(wt)
  if (voided) {
    console.log(`Cleared a stale pending removal for ${wt} (feature name reused).`)
  }
  // A name whose branch is already merged usually means the feature shipped and
  // this is an accidental reuse — worth saying out loud, but not fatal (picking
  // the same name for follow-up work is legitimate).
  if (isMergedRemoteBranch(main, branch)) {
    console.log(`NOTE: origin/${branch} already exists and is merged into origin/master.`)
    console.log(`      "${feature}" looks like a feature that already shipped. Continuing on a`)
    console.log(`      fresh branch off origin/master — use a new name if that wasn't intended.`)
  }

  console.log(`Creating worktree ${wt} on ${branch} …`)
  execFileSync('git', ['-C', main, 'worktree', 'add', wt, '-b', branch, 'origin/master'], {
    stdio: 'inherit',
  })

  console.log('Installing dependencies (pnpm install) …')
  execFileSync('pnpm', ['install'], { cwd: wt, stdio: 'inherit', shell: true })
}

if (isRestart) {
  // env/secrets are already in place from the original create — but repair the
  // two things that rot: deps (a pruned/ineffective node_modules) and a
  // CORS_ORIGIN written before a port existed. Both fail confusingly at runtime.
  ensureDeps(wt, { label: `${feature} worktree` })
  if (proj.hasApi) ensureCorsOrigin(path.join(wt, 'apps/api/.env.development'))
  else {
    // Web-only project: `--api 808N --restart` is the documented way to repoint
    // a TRM worktree at a paired NG worktree's API (CLAUDE.md § paired-worktree
    // rule). VITE_API_URL lives in .env.development.local, which the create
    // branch below writes — so without this the restart printed the NEW port in
    // its summary while the browser kept calling the OLD one, and every new
    // endpoint 404'd with no visible clue. Rewrite it from the resolved port.
    const envLocal = path.join(wt, 'apps/web/.env.development.local')
    const next = `VITE_API_URL=http://localhost:${api}/api\nVITE_WORKTREE_LABEL=${feature}\n`
    const prev = fs.existsSync(envLocal) ? fs.readFileSync(envLocal, 'utf8') : ''
    if (prev !== next) {
      fs.writeFileSync(envLocal, next)
      console.log(`Rewrote apps/web/.env.development.local (API → :${api}).`)
    }
  }
} else if (proj.hasApi) {
  // Copy gitignored dev config the new worktree needs, and force a CORS_ORIGIN
  // that allows every dev slot so cookie auth works regardless of which slot we
  // got (spans NG + TRM web ports — see DEV_WEB_ORIGINS).
  const srcEnv = path.join(main, 'apps/api/.env.development')
  const dstEnv = path.join(wt, 'apps/api/.env.development')
  if (fs.existsSync(srcEnv)) {
    let env = fs.readFileSync(srcEnv, 'utf8')
    const corsLine = `CORS_ORIGIN=${DEV_WEB_ORIGINS.join(',')}`
    env = /^CORS_ORIGIN=.*$/m.test(env)
      ? env.replace(/^CORS_ORIGIN=.*$/m, corsLine)
      : env.trimEnd() + `\n${corsLine}\n`
    fs.writeFileSync(dstEnv, env)
    console.log('Wrote apps/api/.env.development (CORS spans all dev ports).')
  } else {
    console.warn('WARN: main checkout has no apps/api/.env.development to copy.')
  }
  // Label the web dev server's browser tab with the branch so parallel worktree
  // tabs are distinguishable. Vite reads .env.development.local (gitignored); the
  // app prefixes document.title from VITE_WORKTREE_LABEL in dev (see main.tsx).
  fs.writeFileSync(
    path.join(wt, 'apps/web/.env.development.local'),
    `VITE_WORKTREE_LABEL=${feature}\n`,
  )
  console.log(`Wrote apps/web/.env.development.local (tab label "${feature}").`)

  // Secrets (Google service-account key) for email/PDF — copy if present.
  const srcSecrets = path.join(main, 'apps/api/secrets')
  if (fs.existsSync(srcSecrets)) {
    fs.cpSync(srcSecrets, path.join(wt, 'apps/api/secrets'), { recursive: true })
    console.log('Copied apps/api/secrets/.')
  }
} else {
  // TRM: web-only. Point VITE_API_URL at the chosen ETM API and label the tab.
  // The dev:517N scripts don't bake VITE_API_URL, so this .env value wins.
  fs.writeFileSync(
    path.join(wt, 'apps/web/.env.development.local'),
    `VITE_API_URL=http://localhost:${api}/api\nVITE_WORKTREE_LABEL=${feature}\n`,
  )
  console.log(`Wrote apps/web/.env.development.local (API → :${api}, tab label "${feature}").`)
}

const logDir = path.join(wt, '.dev-logs')
fs.mkdirSync(logDir, { recursive: true })
const apiLog = path.join(logDir, 'api.log')
const webLog = path.join(logDir, 'web.log')

console.log('Starting dev server(s) (detached) …')
const apiPid = proj.hasApi ? spawnDetached(wt, proj.apiPkg, proj.apiScript(slot), apiLog) : null
const webPid = spawnDetached(wt, proj.webPkg, proj.webScript(slot), webLog)

updateRegistry((reg) => {
  const prev = reg.slots[slotKey(projectKey, slot)] ?? {}
  reg.slots[slotKey(projectKey, slot)] = {
    project: projectKey, feature, branch, worktree: wt.replace(/\\/g, '/'),
    main: main.replace(/\\/g, '/'),
    apiPort: proj.hasApi ? api : null, apiTarget: proj.hasApi ? null : api,
    webPort: web, apiPid, webPid,
    logDir: logDir.replace(/\\/g, '/'),
    createdAt: (isRestart && prev.createdAt) || new Date().toISOString(),
    ...(isRestart ? { restartedAt: new Date().toISOString() } : {}),
  }
})

// Health check: wait for the web port to accept connections (vite is quick; the
// API tsx-watch a few seconds). 90s ceiling so a broken start fails loudly.
async function waitFor(port, ms = 90000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await isPortInUse(port)) return true
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}
// A web-only project targets an API it did not start: "port in use" only proves
// SOMETHING listens there. Ask it who it is — see probeApiIdentity in lib.mjs.
const apiIdentity = proj.hasApi ? null : await probeApiIdentity(api)
const apiForeign = apiIdentity ? apiIdentity.reason === 'foreign' : false
const apiUp = proj.hasApi ? await waitFor(api) : apiIdentity.ok
const webUp = await waitFor(web)
// Readiness beyond "port is open" — see waitForDbHealth/checkCors in lib.mjs.
const dbCheck = proj.hasApi && apiUp ? await waitForDbHealth(api) : null
const corsOk = apiUp ? await checkCors(api, `http://localhost:${web}`) : false

console.log('\n──────────────────────────────────────────')
console.log(`Slot ${slot}  ${feature}  [${proj.label}]`)
console.log(`  Worktree : ${wt}`)
console.log(`  Branch   : ${branch}`)
if (proj.hasApi) {
  console.log(`  API      : http://localhost:${api}   pid ${apiPid}  ${apiUp ? 'UP' : 'NOT UP (check log)'}`)
} else {
  const verdict = apiUp ? `MPS API ${apiIdentity.version ?? ''}`.trim()
    : apiForeign ? `NOT the MPS API — port held by "${apiIdentity.app}"`
    : 'NOT reachable; run /serve-main'
  console.log(`  API      : http://localhost:${api}   (${verdict})`)
}
if (dbCheck) {
  const verdict = dbCheck.ok ? `OK (${dbCheck.ms}ms)`
    : dbCheck.unsupported ? `not checked (${dbCheck.error})`
    : `UNREACHABLE — ${dbCheck.error}`
  console.log(`  HFSQL    : ${verdict}`)
}
if (apiUp) {
  console.log(`  CORS     : ${corsOk ? `accepts http://localhost:${web}` : `REJECTS http://localhost:${web} — the browser will fail`}`)
}
console.log(`  Web      : http://localhost:${web}   pid ${webPid}  ${webUp ? 'UP' : 'NOT UP (check log)'}`)
console.log(`  Logs     : ${apiLog}`)
console.log(`             ${webLog}`)
console.log('──────────────────────────────────────────')
if (proj.hasApi && !apiUp) tailLog(apiLog)
if (!webUp) tailLog(webLog)
if (!webUp || (proj.hasApi && !apiUp)) {
  console.log('A server did not come up in time — cause above.')
  process.exitCode = 2
}
if (apiUp && !corsOk) {
  console.log(`The API rejects http://localhost:${web}: fix CORS_ORIGIN in apps/api/.env.development.`)
  process.exitCode = 2
}
if (dbCheck && !dbCheck.ok && !dbCheck.unsupported) {
  console.log('The API is listening but cannot reach HFSQL, so every data screen will hang.')
  console.log('Check the HFSQL service (localhost:4900) and HFSQL_CONNECTION_STRING, then:')
  console.log(`  node scripts/worktree/up.mjs ${feature} ${projectKey} --restart`)
  process.exitCode = 2
}
if (!proj.hasApi && apiForeign) {
  console.log(`Port :${api} is held by ANOTHER app ("${apiIdentity.app}"), not the MPS API — every`)
  console.log(`screen will fail on cookie auth even though the port answers. Do not kill it;`)
  console.log(`start the MPS API on a free port outside 8080–8086 and repoint this worktree:`)
  console.log(`  cd C:/dev/etsmalterre/ETM/apps/api && $env:PORT='8087'; pnpm dev`)
  console.log(`  node scripts/worktree/up.mjs ${feature} --api 8087 --restart`)
  process.exitCode = 2
} else if (!proj.hasApi && !apiUp) {
  console.log(`NOTE: the MPS API on :${api} isn't reachable. TRM web will 404 its API`)
  console.log(`      calls until you start it (e.g. /serve-main for the master on :8080).`)
}
