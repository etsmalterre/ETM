// Show every active worktree slot, whether its servers are alive, and how far
// each branch is ahead/behind origin/master.
//   node scripts/worktree/status.mjs
import fs from 'node:fs'
import {
  SLOTS, PROJECTS, getProject, slotKey, entryProject,
  readRegistry, isPortInUse, pidAlive, aheadBehind, reapPending,
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

console.log('Active worktrees:')
const stale = []
for (const k of keys) {
  const s = reg.slots[k]
  const proj = getProject(entryProject(s, k))
  const hasApi = proj.hasApi
  const exists = fs.existsSync(s.worktree)
  const apiAlive = hasApi && pidAlive(s.apiPid)
  const webAlive = pidAlive(s.webPid)
  const webServing = await isPortInUse(s.webPort)
  const ab = exists ? aheadBehind(s.worktree) : { ahead: 0, behind: 0 }
  const health = webServing ? 'UP' : (apiAlive || webAlive) ? 'PARTIAL' : 'DOWN'
  console.log(`\n  [${k}] ${s.feature}  [${proj.label}]   ${health}`)
  console.log(`    branch   ${s.branch}   (+${ab.ahead} ahead / -${ab.behind} behind origin/master)`)
  console.log(`    worktree ${s.worktree}${exists ? '' : '   ⚠ MISSING ON DISK'}`)
  if (hasApi) {
    console.log(`    API      http://localhost:${s.apiPort}  pid ${s.apiPid} ${apiAlive ? 'alive' : 'dead'}`)
  } else {
    console.log(`    API      → http://localhost:${s.apiTarget} (ETM, shared)`)
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
if (stale.length) {
  console.log(`\n⚠ Stale entries (servers dead or worktree gone): ${stale.join(', ')}.`)
  console.log(`  Clean each with:  node scripts/worktree/down.mjs <slot-or-feature>`)
}
if (swept.stillBlocked.length) {
  console.log(`\n⏳ Pending removal (dir still open in a terminal — close it, then it auto-cleans):`)
  for (const e of swept.stillBlocked) console.log(`  ${e.worktree}`)
}
