// Stop a feature worktree's dev servers (and optionally remove the worktree +
// branch). Frees the slot in the registry.
//   node scripts/worktree/down.mjs <feature|slot> [--remove]
//
// Without --remove: kill servers, free the slot, LEAVE the worktree + branch on
//   disk (pause work).  With --remove: also remove the worktree and delete the
//   branch (used by /feature-complete after a merge). If the directory is locked
//   (a terminal is cwd'd inside it — the usual case when run from the feature
//   session), the dir/branch removal is DEFERRED to a pending queue and reaped
//   later from the main checkout by any worktree skill (see lib.reapPending).
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import {
  killTree, killProcessesUnder, pidsUnder, mainCheckout, readRegistry, updateRegistry,
  addPending, reapPending, entryProject,
} from './lib.mjs'

/** Synchronous sleep (no async in this short script). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// Opportunistically finish any previously-deferred removals first.
const swept = reapPending()
if (swept.reaped.length) {
  console.log(`Reaped leftover worktree dir(s): ${swept.reaped.map((e) => e.feature).join(', ')}`)
}

const target = (process.argv[2] || '').trim()
const remove = process.argv.includes('--remove')
if (!target) {
  console.error('Usage: node scripts/worktree/down.mjs <feature|slot> [--remove]')
  console.error('  slot may be a bare number (NG) or "trm:N" — feature name is unambiguous.')
  process.exit(1)
}

const reg = readRegistry()
// Find the slot by exact registry key ("1", "trm:1") or by feature name.
let slotKey = null
if (reg.slots[target]) {
  slotKey = target
} else {
  slotKey = Object.keys(reg.slots).find((k) => reg.slots[k].feature === target) ?? null
}
if (!slotKey) {
  const active = Object.entries(reg.slots)
    .map(([k, s]) => `${s.feature} (${k})`).join(', ') || '(none)'
  console.error(`No registry entry for "${target}". Active: ${active}`)
  process.exit(1)
}
const entry = reg.slots[slotKey]

console.log(`Stopping servers for slot ${slotKey} (${entry.feature}) …`)
killTree(entry.apiPid)
killTree(entry.webPid)

// Free the slot immediately (ports/registry) regardless of the dir outcome.
updateRegistry((r) => { delete r.slots[slotKey] })

if (remove) {
  // git ops must run in the repo the worktree belongs to (NG or TRM). Older
  // entries have no `main` field — they're always NG (created pre-TRM support).
  const main = entry.main || mainCheckout()
  const tryGit = (args, label) => {
    try {
      execFileSync('git', ['-C', main, ...args], { stdio: 'inherit' })
    } catch {
      console.warn(`WARN: ${label} failed (continuing).`)
    }
  }
  console.log(`Removing worktree ${entry.worktree} …`)
  // Kill anything else still running from inside the worktree — a manual
  // `pnpm dev`, or a survivor of the killTree above. The registry only knows the
  // pids IT started, and any stray one holds the dir open forever (see pidsUnder).
  const strays = killProcessesUnder(entry.worktree)
  if (strays.length) {
    console.log(`Killed ${strays.length} stray process(es) running from the worktree: ${strays.join(', ')}`)
  }
  // Let the OS release the just-killed processes' handles, then try to delete
  // the directory (Node's rmSync retries EBUSY/ENOTEMPTY on Windows).
  sleepSync(1500)
  let removed = false
  if (fs.existsSync(entry.worktree)) {
    try {
      fs.rmSync(entry.worktree, { recursive: true, force: true, maxRetries: 10, retryDelay: 400 })
    } catch { /* still locked */ }
    removed = !fs.existsSync(entry.worktree)
  } else {
    removed = true
  }

  if (removed) {
    tryGit(['worktree', 'prune'], 'worktree prune')
    tryGit(['branch', '-D', entry.branch], 'local branch delete')
    tryGit(['push', 'origin', '--delete', entry.branch], 'remote branch delete')
    console.log(`Slot ${slotKey} freed. Worktree + branch removed.`)
  } else {
    // Locked by a terminal cwd'd inside (the usual feature-session case). Defer.
    addPending({
      worktree: entry.worktree, branch: entry.branch, feature: entry.feature,
      project: entryProject(entry, slotKey), main,
    })
    console.log(`Slot ${slotKey} freed. Servers stopped and merge is done.`)
    console.log(`NOTE: ${entry.worktree} can't be deleted yet — this session (or a`)
    console.log(`      terminal) is cwd'd inside it. Nothing is left running.`)
    console.log(`      It will be removed automatically the next time you run any worktree`)
    console.log(`      skill from ${main} (or run: node scripts/worktree/reap.mjs there).`)
  }
} else {
  console.log(`Slot ${slotKey} freed. Worktree kept on disk.`)
}
