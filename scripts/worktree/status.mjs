// Show every active worktree slot, whether its servers are alive, and how far
// each branch is ahead/behind origin/master.
//   node scripts/worktree/status.mjs
import fs from 'node:fs'
import {
  SLOTS, PROJECTS, getProject, slotKey, entryProject,
  readRegistry, isPortInUse, pidAlive, aheadBehind, reapPending, probeDbHealth,
} from './lib.mjs'

// Sweep any leftover dirs from earlier completions that are now unlocked.
const swept = reapPending()
if (swept.reaped.length) {
  console.log(`Reaped leftover worktree dir(s): ${swept.reaped.map((e) => e.feature).join(', ')}\n`)
}

const reg = readRegistry()
const keys = Object.keys(reg.slots).sort()

if (keys.length === 0) {
  console.log('No active worktrees. All slots free (6 per project: ETM + TRM).')
  if (swept.stillBlocked.length) {
    console.log(`\n⏳ Pending removal (dir still open in a terminal — close it, then it auto-cleans):`)
    for (const e of swept.stillBlocked) console.log(`  ${e.worktree}`)
  }
  process.exit(0)
}

// Readiness, not liveness: an API whose HFSQL connection is wedged keeps its
// port open and its pid alive, so this screen said "UP" while every data route
// timed out and the browser span forever. Probe the DB the same way up.mjs
// does. Run the probes in PARALLEL — a wedged API takes seconds to answer and
// several slots can be wedged at once.
const dbProbes = Object.fromEntries(await Promise.all(keys.map(async (k) => {
  const s = reg.slots[k]
  const proj = getProject(entryProject(s, k))
  // A TRM slot has no API of its own: probe the ETM API it borrows, or its
  // wedge would be reported by nobody (that API may be /serve-main, which
  // holds no slot at all).
  const port = proj.hasApi ? s.apiPort : s.apiTarget
  if (proj.hasApi && !pidAlive(s.apiPid)) return [k, null]
  return [k, await probeDbHealth(port)]
})))

console.log('Active worktrees:')
const stale = []
const degraded = []
for (const k of keys) {
  const s = reg.slots[k]
  const proj = getProject(entryProject(s, k))
  const hasApi = proj.hasApi
  const exists = fs.existsSync(s.worktree)
  const apiAlive = hasApi && pidAlive(s.apiPid)
  const webAlive = pidAlive(s.webPid)
  const webServing = await isPortInUse(s.webPort)
  const ab = exists ? aheadBehind(s.worktree) : { ahead: 0, behind: 0 }
  const db = dbProbes[k]
  const dbBad = !!db && !db.ok && !db.unsupported
  if (dbBad) degraded.push({ feature: s.feature, shared: !hasApi, port: hasApi ? s.apiPort : s.apiTarget })
  const health = dbBad ? 'DEGRADED' : webServing ? 'UP' : (apiAlive || webAlive) ? 'PARTIAL' : 'DOWN'
  console.log(`\n  [${k}] ${s.feature}  [${proj.label}]   ${health}`)
  console.log(`    branch   ${s.branch}   (+${ab.ahead} ahead / -${ab.behind} behind origin/master)`)
  console.log(`    worktree ${s.worktree}${exists ? '' : '   ⚠ MISSING ON DISK'}`)
  if (hasApi) {
    console.log(`    API      http://localhost:${s.apiPort}  pid ${s.apiPid} ${apiAlive ? 'alive' : 'dead'}`)
  } else {
    console.log(`    API      → http://localhost:${s.apiTarget} (ETM, shared)`)
  }
  if (db) {
    const verdict = db.ok ? `OK (${db.ms}ms)`
      : db.unsupported ? `not checked (${db.error})`
      : `UNREACHABLE — ${db.error}`
    console.log(`    HFSQL    ${verdict}`)
  }
  console.log(`    Web      http://localhost:${s.webPort}  pid ${s.webPid} ${webAlive ? 'alive' : 'dead'}${webServing ? ' (serving)' : ''}`)
  const deadServers = hasApi ? (!apiAlive && !webAlive) : !webAlive
  if (!exists || (deadServers && !webServing)) stale.push(k)
}

// Free slots per project (disjoint port ranges → reported separately).
for (const proj of Object.values(PROJECTS)) {
  const free = SLOTS.filter((n) => !reg.slots[slotKey(proj.key, n)])
  const fmt = (n) => proj.hasApi
    ? `${n} (API ${proj.apiPort(n)}/Web ${proj.webPort(n)})`
    : `${n} (Web ${proj.webPort(n)})`
  console.log(`\nFree ${proj.label} slots: ${free.length ? free.map(fmt).join(', ') : 'none'}`)
}
if (degraded.length) {
  console.log(`\n⚠ DEGRADED — data is unreachable, so the browser loads forever on every data screen`)
  console.log(`  while /api/health still answers 200 instantly. Do NOT debug the feature code first.`)
  const own = degraded.filter((d) => !d.shared)
  const shared = degraded.filter((d) => d.shared)
  for (const d of own) {
    console.log(`\n  ${d.feature}: its own API on :${d.port} cannot reach HFSQL.`)
    console.log(`    Data routes 500 after exactly 15s (the HFSQL connect timeout); .dev-logs/api.err.log`)
    console.log(`    says "HFSQL connect timed out". Usual cause: a burst of API file edits — every save`)
    console.log(`    restarts tsx watch and the killed process leaves its ODBC connection dangling.`)
    console.log(`    Fix:  node scripts/worktree/up.mjs ${d.feature} --restart`)
  }
  for (const d of shared) {
    console.log(`\n  ${d.feature}: borrows the ETM API on :${d.port}, which is not answering.`)
    console.log(`    Start the ETM worktree that owns :${d.port} (or /serve-main for the master API).`)
  }
}
if (stale.length) {
  console.log(`\n⚠ Stale entries (servers dead or worktree gone): ${stale.join(', ')}.`)
  console.log(`  Clean each with:  node scripts/worktree/down.mjs <slot-or-feature>`)
}
if (swept.stillBlocked.length) {
  console.log(`\n⏳ Pending removal (dir still open in a terminal — close it, then it auto-cleans):`)
  for (const e of swept.stillBlocked) console.log(`  ${e.worktree}`)
}
