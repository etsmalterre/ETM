// Shared helpers for the worktree skills (new-feature-worktree / feature-checkpoint
// / feature-complete / worktree-status). Pure Node, no deps. Windows-first
// (taskkill for process-tree shutdown) but degrades on POSIX.
//
// Slot model (see claude_doc/worktrees.md): slot N in 1..6 →
//   API port = 8080 + N   (pnpm script `@mps/api dev:808N`)
//   Web port = 3000 + N   (pnpm script `@mps/web dev:300N`, already → API 808N)
import { execFileSync, spawn } from 'node:child_process'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

export const SLOTS = [1, 2, 3, 4, 5, 6]
export const apiPort = (n) => 8080 + n
export const webPort = (n) => 3000 + n
export const IS_WIN = process.platform === 'win32'

// ── Projects ────────────────────────────────────────────────────────────────
// Worktrees can be created for either the ETM repo (API + web) or the sibling
// TRM repo (web only — its web dev server talks to an ETM API over HTTP).
// Each project owns a disjoint port range so an NG slot and a TRM slot with the
// same number never collide:
//   ng  slot N → API 808N + web 300N   (packages @mps/api + @mps/web)
//   trm slot N → web 517N              (package @mps-trm/web, no API of its own)
// Both repos live side-by-side under the same parent dir (dirName is the folder
// basename), so a TRM worktree can be driven from the NG checkout (the sibling is
// resolved by dirName). See claude_doc/worktrees.md.
export const PROJECTS = {
  ng: {
    key: 'ng',
    label: 'ETM',
    dirName: 'ETM',
    hasApi: true,
    apiPkg: '@mps/api',
    webPkg: '@mps/web',
    apiPort: (n) => 8080 + n,
    webPort: (n) => 3000 + n,
    apiScript: (n) => `dev:${8080 + n}`,
    webScript: (n) => `dev:${3000 + n}`,
  },
  trm: {
    key: 'trm',
    label: 'TRM',
    dirName: 'TRM',
    hasApi: false,
    webPkg: '@mps-trm/web',
    webPort: (n) => 5170 + n, // 5171..5176
    webScript: (n) => `dev:${5170 + n}`,
    // TRM web has no API of its own — by default it targets the slot-0 master
    // ETM API (served via /serve-main). Overridable per worktree (up --api).
    defaultApiPort: 8080,
  },
}

export function getProject(key) {
  const p = PROJECTS[(key || 'ng').toLowerCase()]
  if (!p) throw new Error(`Unknown project "${key}". Use "ng" or "trm".`)
  return p
}

// Slot 0 is RESERVED for serving the main checkout (master) itself: API 8080 /
// web 3000. It sits outside the 1..6 feature range, so allocateSlot() never
// hands it out and a feature worktree can never collide with the running master.
// Managed by scripts/serve-main.mjs (skills /serve-main + /serve-main-down).
export const MAIN_SLOT = 0

// Every dev web origin that must be allowed by the API's CORS_ORIGIN so cookie
// auth works from any slot — NG web ports (slot-0 master + 1..6), the two legacy
// defaults, and the TRM web ports (5171..6) since a TRM worktree's web server
// calls an ETM API cross-origin. Deduped (5175 == trm slot 5).
export const DEV_WEB_ORIGINS = [
  ...new Set([
    5174,
    5175,
    webPort(MAIN_SLOT),
    ...SLOTS.map(webPort),
    ...SLOTS.map(PROJECTS.trm.webPort),
  ]),
].map((p) => `http://localhost:${p}`)

const REGISTRY = path.join(os.homedir(), '.claude', 'mps-worktrees.json')

// Registry slot keys. NG keeps bare numeric keys ("1".."6") for backward
// compatibility with entries created before TRM support; TRM entries are
// namespaced ("trm:1".."trm:6"). A bare-numeric key with no `project` field on
// its entry is therefore an NG slot.
export function slotKey(projectKey, n) {
  return projectKey === 'ng' ? String(n) : `${projectKey}:${n}`
}
export function parseSlotKey(key) {
  if (/^\d+$/.test(key)) return { project: 'ng', slot: Number(key) }
  const [proj, n] = key.split(':')
  return { project: proj, slot: Number(n) }
}
/** Project key for a registry entry, tolerant of pre-TRM entries with no field. */
export function entryProject(entry, key) {
  return entry?.project || parseSlotKey(key).project
}

export function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY, 'utf8'))
  } catch {
    return { slots: {} }
  }
}

// Atomic write: serialize to a per-PID temp file, then rename over the target.
// A concurrent reader therefore sees either the whole old file or the whole new
// one — never a half-written file (that partial-read → JSON.parse throw →
// readRegistry() falling back to {} → the fallback getting persisted is exactly
// what wiped every entry during the multi-session incident). rename can transiently
// EPERM/EBUSY on Windows if a reader (or AV) has the target open; retry briefly.
export function writeRegistry(reg) {
  fs.mkdirSync(path.dirname(REGISTRY), { recursive: true })
  const tmp = `${REGISTRY}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2))
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, REGISTRY); return }
    catch (e) {
      if ((e.code === 'EPERM' || e.code === 'EBUSY') && i < 10) { sleepSync(30); continue }
      try { fs.rmSync(tmp, { force: true }) } catch {}
      throw e
    }
  }
}

// ── Cross-process registry lock ─────────────────────────────────────────────
// The registry is shared by every worktree skill across every Claude session /
// terminal, and each mutation is a read-modify-write. Without serialization two
// sessions interleave and one clobbers the other's slots. `updateRegistry(fn)`
// takes an exclusive lockfile, RE-READS the registry fresh, applies fn, writes
// atomically, then releases — so each mutation merges with whatever landed since.
const LOCK = `${REGISTRY}.lock`
const LOCK_STALE_MS = 10_000 // a holder older than this is presumed dead → steal
const LOCK_TIMEOUT_MS = 8_000 // waited this long → steal to avoid a deadlock

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function acquireLock() {
  const start = Date.now()
  for (;;) {
    try {
      const fd = fs.openSync(LOCK, 'wx') // O_CREAT|O_EXCL: fails if held
      fs.writeSync(fd, `${process.pid} ${Date.now()}`)
      fs.closeSync(fd)
      return
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
    // Held by someone. Steal only if it looks abandoned (stale mtime) or we've
    // waited past the timeout — critical sections are sub-millisecond, so a lock
    // lingering seconds means the holder died mid-write.
    let steal = Date.now() - start > LOCK_TIMEOUT_MS
    if (!steal) {
      try { steal = Date.now() - fs.statSync(LOCK).mtimeMs > LOCK_STALE_MS } catch { /* vanished */ }
    }
    if (steal) { try { fs.rmSync(LOCK, { force: true }) } catch {} }
    else sleepSync(20)
  }
}

function releaseLock() {
  try { fs.rmSync(LOCK, { force: true }) } catch {}
}

/** Run `mutator(reg)` as an atomic read-modify-write under the registry lock.
 *  The reg passed in is read FRESH inside the lock (not a stale snapshot from
 *  before), so concurrent mutations to other slots are preserved. Returns the
 *  mutator's return value. Keep the mutator synchronous and quick — no I/O. */
export function updateRegistry(mutator) {
  acquireLock()
  try {
    const reg = readRegistry()
    const ret = mutator(reg)
    writeRegistry(reg)
    return ret
  } finally {
    releaseLock()
  }
}

// ── Deferred directory removal ─────────────────────────────────────────────
// /feature-complete runs INSIDE the feature worktree, so that session (and the
// user's terminal) holds the dir as its cwd — Windows refuses to delete it. We
// can't remove it from there no matter how many retries. Instead we queue it and
// reap it later from the main checkout (where it's no longer locked), at the
// start of any worktree skill.

export function readPending() {
  const reg = readRegistry()
  return Array.isArray(reg.pendingRemovals) ? reg.pendingRemovals : []
}

export function addPending(entry) {
  updateRegistry((reg) => {
    const list = Array.isArray(reg.pendingRemovals) ? reg.pendingRemovals : []
    if (!list.some((e) => e.worktree === entry.worktree)) list.push(entry)
    reg.pendingRemovals = list
  })
}

/** Forget any queued removal for `wt` (we are legitimately recreating that path).
 *  Returns true if an entry was dropped. */
export function dropPending(wt) {
  const target = path.resolve(wt)
  return updateRegistry((reg) => {
    const cur = Array.isArray(reg.pendingRemovals) ? reg.pendingRemovals : []
    const keep = cur.filter((e) => path.resolve(e.worktree) !== target)
    reg.pendingRemovals = keep
    return keep.length !== cur.length
  })
}

/** True if `branch` exists on origin AND is already an ancestor of origin/master
 *  — i.e. that feature name has already shipped. Local-only (no fetch). */
export function isMergedRemoteBranch(repo, branch) {
  try {
    const ref = `origin/${branch}`
    git(['-C', repo, 'rev-parse', '--verify', '--quiet', ref], repo)
    execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', ref, 'origin/master'], {
      cwd: repo, stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

/** Finish removing any worktrees whose directory was locked at completion time.
 *  Cheap to call at the start of every skill: it returns immediately when the queue
 *  is empty, and touches the network only on the rare run that actually reaps
 *  something (to delete the merged remote branch — see below).
 *  Returns { reaped: [...], stillBlocked: [...], resurrected: [...] }.
 *
 *  ⚠ A pending entry names a PATH, and worktree paths are derived from the
 *  feature name — so reusing a feature name recreates the exact same path. If a
 *  concurrent session queued `ETM-foo` for removal and someone then runs
 *  `up.mjs foo`, the stale entry matches the BRAND NEW worktree and the next
 *  worktree skill deletes live work. That happened (2026-07-30): two freshly
 *  created worktrees were destroyed by a `status.mjs` run.
 *  A pending entry may therefore only delete a directory that NO active registry
 *  slot claims. A slot claiming the path means the path was legitimately
 *  recreated, so the entry is stale — drop it without touching the disk. */
export function reapPending() {
  const list = readPending()
  if (list.length === 0) return { reaped: [], stillBlocked: [], resurrected: [] }
  // git prune/branch-delete must run in the repo the worktree belongs to. Older
  // pending entries predate the `main` field — fall back to the current repo's
  // main checkout (those are always NG, created before TRM support existed).
  const fallbackMain = mainCheckout()
  // Paths currently owned by a live slot — never reapable (see the note above).
  const claimed = new Set(
    Object.values(readRegistry().slots ?? {}).map((s) => path.resolve(s.worktree))
  )
  const reaped = []
  const stillBlocked = []
  const resurrected = []
  for (const e of list) {
    const repo = e.main || fallbackMain
    const tryGit = (args) => { try { git(['-C', repo, ...args], repo) } catch {} }
    if (claimed.has(path.resolve(e.worktree))) {
      // The name was reused and the tree is live. Forget the entry; deleting it
      // would destroy work that was never queued for removal.
      resurrected.push(e)
      continue
    }
    if (fs.existsSync(e.worktree)) {
      // A dev server still running from inside the dir holds an open handle on
      // it, so the delete can NEVER succeed until it is killed (see pidsUnder).
      killProcessesUnder(e.worktree)
      try {
        fs.rmSync(e.worktree, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
      } catch {
        // still locked (a terminal is cwd'd inside) — try again next time
      }
    }
    if (!fs.existsSync(e.worktree)) {
      tryGit(['worktree', 'prune'])
      tryGit(['branch', '-D', e.branch]) // already merged by /feature-complete
      // ...and the remote one. down.mjs deletes origin/<branch> only on its happy path;
      // on Windows the DEFERRED path is the normal case (the feature session's own
      // terminal is cwd'd inside the worktree), so without this every completed feature
      // left its remote branch behind for ever. Measured 2026-08-27: 13 dead
      // origin/feat/* branches on TRM — which is why reusing a feature name made up.mjs
      // warn that it 'already exists and is merged into origin/master', a warning that
      // reads like a mistake and is really just this leak.
      // Safe against name reuse: an entry whose path a live slot claims is treated as
      // resurrected above and never reaches here, so this can only delete the branch of
      // a worktree that is genuinely gone.
      tryGit(['push', 'origin', '--delete', e.branch])
      reaped.push(e)
    } else {
      stillBlocked.push(e)
    }
  }
  // Drop the entries we reaped AND the stale ones a live slot reclaimed —
  // re-reading under the lock so a pending entry added by another session while
  // we were reaping isn't lost.
  const doneWt = new Set([...reaped, ...resurrected].map((e) => e.worktree))
  updateRegistry((reg) => {
    const cur = Array.isArray(reg.pendingRemovals) ? reg.pendingRemovals : []
    reg.pendingRemovals = cur.filter((e) => !doneWt.has(e.worktree))
  })
  return { reaped, stillBlocked, resurrected }
}

/** Absolute path of the main checkout (the worktree holding the shared .git).
 *  Works from any worktree: --git-common-dir points at <main>/.git. */
export function mainCheckout(cwd = process.cwd()) {
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd,
    encoding: 'utf8',
  }).trim()
  return path.dirname(path.resolve(cwd, common))
}

/** Main checkout for a given project. When cwd is already that project's repo,
 *  it's mainCheckout(); otherwise the project repo is a sibling dir (same parent,
 *  named project.dirName) — which is how a TRM worktree is driven from the NG
 *  checkout. Throws if the sibling isn't a git repo. */
export function projectMainCheckout(projectKey, cwd = process.cwd()) {
  const proj = getProject(projectKey)
  const here = mainCheckout(cwd)
  if (path.basename(here).toLowerCase() === proj.dirName.toLowerCase()) return here
  const sibling = path.join(path.dirname(here), proj.dirName)
  if (!fs.existsSync(path.join(sibling, '.git'))) {
    throw new Error(
      `Cannot find the ${proj.label} checkout at ${sibling} (expected a sibling of ${here}).`,
    )
  }
  return sibling
}

function probeHost(port, host, timeoutMs) {
  return new Promise((resolve) => {
    const sock = new net.Socket()
    const done = (inUse) => { sock.destroy(); resolve(inUse) }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => done(true))
    sock.once('timeout', () => done(false))
    sock.once('error', () => done(false))
    sock.connect(port, host)
  })
}

/** True if something is listening on the port on EITHER stack. Vite binds the
 *  IPv6 localhost (::1); Express binds IPv4 (0.0.0.0) — so we must probe both,
 *  or a running vite/api looks "free" and the slot collides. */
export async function isPortInUse(port, timeoutMs = 500) {
  const [v4, v6] = await Promise.all([
    probeHost(port, '127.0.0.1', timeoutMs),
    probeHost(port, '::1', timeoutMs),
  ])
  return v4 || v6
}

/** PID of whatever is LISTENING on a port, or null if nothing/unknown. Used to
 *  adopt a dev server that is running but absent from the registry (an orphan from
 *  a crashed session, or a manual `pnpm dev`) so it stays stoppable — without it,
 *  the registry records pid null and `down` silently leaves the process running.
 *  Windows-only (Get-NetTCPConnection); returns null elsewhere, which degrades to
 *  the previous behaviour rather than breaking. */
export function pidOnPort(port) {
  if (!IS_WIN) return null
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
    ], { encoding: 'utf8' }).trim()
    const pid = Number(out)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/** Lowest free slot for a project: no registry entry for that project+slot AND
 *  the project's port(s) actually free. Projects have disjoint port ranges, so
 *  an NG slot and a TRM slot with the same number don't collide. Throws if all
 *  six of the project's slots are taken. */
export async function allocateSlot(projectKey = 'ng') {
  const proj = getProject(projectKey)
  const reg = readRegistry()
  for (const n of SLOTS) {
    if (reg.slots[slotKey(projectKey, n)]) continue
    if (proj.hasApi && (await isPortInUse(proj.apiPort(n)))) continue
    if (await isPortInUse(proj.webPort(n))) continue
    return n
  }
  throw new Error(`All 6 ${proj.label} worktree slots are in use.`)
}

/** PID still exists? (signal 0 probe — may false-positive on a recycled PID, so
 *  status.mjs cross-checks the port.) */
export function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM' // exists but not ours
  }
}

/** PIDs of every process launched from inside `dir` (matched on the command
 *  line, which is what a dev server started in a worktree always carries).
 *  Windows-only; returns [] elsewhere.
 *
 *  ⚠ Why this exists: `down.mjs` and `reapPending()` kill the pids the REGISTRY
 *  knows about. A dev server started outside the registry — a manual `pnpm dev`
 *  in the worktree, or a survivor of a killTree that lost its tree — has its CWD
 *  inside the worktree, and Windows refuses (EPERM) to delete a directory that is
 *  any process's cwd. So `rmSync` fails forever while both scripts blame "a
 *  terminal is cwd'd inside" — a diagnosis the user cannot act on, because no
 *  terminal is involved.
 *
 *  Cwd is the lock, but the command line is what we can actually query cheaply on
 *  Windows — and it is a good proxy: a dev server launched in a worktree always
 *  carries that path (turbo → cross-env → vite are all resolved under it). What
 *  this does NOT catch is a process launched from elsewhere that merely chdir'd
 *  in — a shell, an editor. Those stay the genuine "close the terminal" case. Happened to TRM-visitage (2026-08-27), where
 *  three orphan node processes (turbo → cross-env → vite on 5175) held the dir
 *  after /feature-complete, so `status.mjs` listed it "pending removal" forever
 *  and showed slot 5 free while its port was busy.
 *  Matching includes the trailing separator so `TRM-of` never matches
 *  `TRM-of-something`. Excludes both our own pid and the probe's own powershell
 *  (whose command line carries the very path we search for). */
export function pidsUnder(dir) {
  if (!IS_WIN) return []
  const withSep = path.resolve(dir) + path.sep
  const esc = (v) => v.replace(/'/g, "''")
  const back = esc(withSep)
  const fwd = esc(withSep.split(path.sep).join('/'))
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and ($_.CommandLine -like '*${back}*' -or $_.CommandLine -like '*${fwd}*') } | Select-Object -ExpandProperty ProcessId`,
    ], { encoding: 'utf8' })
    return out.split(/\r?\n/)
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid)
  } catch {
    return []
  }
}

/** Kill every process rooted in `dir` so the directory can actually be deleted.
 *  Returns the pids it killed. Safe to call when there are none. */
export function killProcessesUnder(dir) {
  const pids = pidsUnder(dir)
  for (const pid of pids) killTree(pid)
  return pids
}

/** Kill a detached dev server and its child tree (pnpm → node → vite/tsx). */
export function killTree(pid) {
  if (!pid) return
  try {
    if (IS_WIN) {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(-pid, 'SIGTERM')
    }
  } catch {
    // already dead — fine
  }
}

/** Launch `pnpm --filter <pkg> <script>` as a fully detached dev server, output
 *  → logFile (+ .err.log), and return its PID. On Windows we use Start-Process
 *  (reliable detach + redirection + a stable PID whose whole tree killTree()
 *  reaps via taskkill /T); a Node detached spawn here orphaned the real server
 *  behind a transient wrapper PID. */
/** Keep one generation of a log. Windows Start-Process TRUNCATES its redirect
 *  targets, so restarting a wedged server erases the very log that explains the
 *  wedge — and the restart is the first thing anyone does. `<name>.prev.log`
 *  survives it. */
function rotateLog(file) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) {
      fs.renameSync(file, file.replace(/\.log$/, '.prev.log'))
    }
  } catch { /* a still-open handle just means we keep the current file — never block a restart */ }
}

export function spawnDetached(cwd, pkg, script, logFile) {
  rotateLog(logFile)
  rotateLog(logFile.replace(/\.log$/, '.err.log'))
  if (IS_WIN) {
    const errFile = logFile.replace(/\.log$/, '.err.log')
    const pidFile = logFile.replace(/\.log$/, '.pid')
    try { fs.rmSync(pidFile) } catch {}
    const q = (s) => String(s).replace(/'/g, "''")
    // Start-Process can't redirect a .cmd shim's streams (pnpm is pnpm.cmd) →
    // launch cmd.exe (a real exe) with `/c pnpm …`; its pid roots the tree.
    // Write the pid to a FILE and run powershell with stdio:'ignore' — if Node
    // captured powershell's stdout pipe, the detached grandchild would leak that
    // handle and execFileSync would hang waiting for pipe-EOF.
    const inner = `pnpm --filter ${q(pkg)} ${q(script)}`
    const ps =
      `$p = Start-Process -FilePath 'cmd.exe' ` +
      `-ArgumentList '/c','${inner}' ` +
      `-WorkingDirectory '${q(cwd)}' ` +
      `-RedirectStandardOutput '${q(logFile)}' -RedirectStandardError '${q(errFile)}' ` +
      `-WindowStyle Hidden -PassThru; Set-Content -Path '${q(pidFile)}' -Value $p.Id`
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' })
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim())
    try { fs.rmSync(pidFile) } catch {}
    return pid
  }
  const out = fs.openSync(logFile, 'a')
  const child = spawn('pnpm', ['--filter', pkg, script], {
    cwd, detached: true, stdio: ['ignore', out, out],
  })
  child.unref()
  return child.pid
}

export function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

// ── Preflight + verification, shared by up.mjs and serve-main.mjs ───────────
// These exist because the two spin-up paths drifted: worktree creation grew
// dependency install / CORS wiring / health checks, while the main checkout —
// which /serve-main runs on — got none of them and failed in ways that blamed
// the wrong layer. Keep new setup steps HERE so both paths inherit them.

/**
 * A workspace with no node_modules fails as `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`
 * and an instant exit, which the port health check reports only as "NOT UP" —
 * nothing points at the missing install. Fresh clones and fresh machines hit
 * this every time, so install rather than diagnose.
 * `confirmModulesPurge=false` keeps pnpm from blocking on an interactive
 * "remove and reinstall modules dirs?" prompt in a detached/non-tty context.
 */
export function ensureDeps(dir, { label = 'checkout' } = {}) {
  const roots = [dir, path.join(dir, 'apps/api'), path.join(dir, 'apps/web')]
  const missing = roots.filter(
    (r) => fs.existsSync(r) && !fs.existsSync(path.join(r, 'node_modules'))
  )
  if (!missing.length) return false
  console.log(`Dependencies missing in ${label} — running pnpm install …`)
  execFileSync('pnpm', ['install', '--config.confirmModulesPurge=false'], {
    cwd: dir, stdio: 'inherit', shell: true,
  })
  return true
}

/**
 * Force CORS_ORIGIN to span every dev web port. The API rejects any origin not
 * listed, and a browser then fails while curl (which sends no Origin header)
 * still succeeds — so the API looks healthy from the terminal while every
 * screen shows "Impossible de charger la liste".
 * .env.development is gitignored, so a machine whose copy predates a port (the
 * main checkout's did not know about slot 0's :3000) stays broken until this
 * rewrites it.
 */
export function ensureCorsOrigin(envPath) {
  if (!fs.existsSync(envPath)) return false
  const line = `CORS_ORIGIN=${DEV_WEB_ORIGINS.join(',')}`
  const env = fs.readFileSync(envPath, 'utf8')
  const next = /^CORS_ORIGIN=.*$/m.test(env)
    ? env.replace(/^CORS_ORIGIN=.*$/m, line)
    : env.trimEnd() + `\n${line}\n`
  if (next === env) return false
  fs.writeFileSync(envPath, next)
  console.log(`Updated CORS_ORIGIN in ${envPath} (spans all dev ports).`)
  return true
}

/**
 * Readiness, not liveness. An API whose HFSQL connection is wedged answers
 * /api/health instantly while every data route hangs forever with nothing in
 * the log — indistinguishable from a healthy start if you only probe the port,
 * and an infinite loading screen in the browser. `?db=1` runs a real query.
 */
export async function probeDbHealth(port, timeoutMs = 10000) {
  try {
    const res = await fetch(`http://localhost:${port}/api/health?db=1`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await res.json().catch(() => ({}))
    if (res.ok && body.db === 'ok') return { ok: true, ms: body.dbMs }
    // An API built before ?db=1 existed answers 200 with no `db` field. That
    // is "cannot tell", not "broken" — reporting it as UNREACHABLE would make
    // this probe the very kind of lying health check it was added to kill.
    if (res.ok && body.db === undefined) {
      return { ok: false, unsupported: true, error: 'API predates ?db=1 — cannot verify' }
    }
    return { ok: false, error: body.error || `HTTP ${res.status}` }
  } catch (err) {
    return {
      ok: false,
      error: err?.name === 'TimeoutError' ? 'timed out (connection wedged?)' : err?.message ?? String(err),
    }
  }
}

/** Poll probeDbHealth until it passes — for spin-up, where the API is still
 *  booting. status.mjs asks once instead (probeDbHealth directly). */
export async function waitForDbHealth(port, ms = 60000) {
  const t0 = Date.now()
  let last = { ok: false, error: 'no response' }
  while (Date.now() - t0 < ms) {
    last = await probeDbHealth(port)
    if (last.ok || last.unsupported) return last
    await new Promise((r) => setTimeout(r, 2000))
  }
  return last
}

/**
 * Verify from the browser's point of view: the API must echo back the web
 * origin, or cookie-auth'd requests fail in the browser while every terminal
 * check passes.
 */
export async function checkCors(apiPortNum, webOrigin) {
  try {
    const res = await fetch(`http://localhost:${apiPortNum}/api/health`, {
      headers: { Origin: webOrigin },
      signal: AbortSignal.timeout(10000),
    })
    return res.headers.get('access-control-allow-origin') === webOrigin
  } catch {
    return false
  }
}

/** Print the tail of a log so a failed start shows its real cause in place. */
export function tailLog(file, n = 15) {
  for (const f of [file, file.replace(/\.log$/, '.err.log')]) {
    try {
      const lines = fs.readFileSync(f, 'utf8').trimEnd().split(/\r?\n/).filter(Boolean)
      if (!lines.length) continue
      console.log(`--- ${path.basename(f)} (last ${Math.min(n, lines.length)}) ---`)
      for (const l of lines.slice(-n)) console.log(`    ${l}`)
    } catch {}
  }
}

/** ahead/behind origin/master for a worktree, using last-fetched refs. */
export function aheadBehind(cwd) {
  try {
    const out = git(['rev-list', '--left-right', '--count', 'origin/master...HEAD'], cwd)
    const [behind, ahead] = out.split(/\s+/).map((n) => Number(n) || 0)
    return { ahead, behind }
  } catch {
    return { ahead: 0, behind: 0 }
  }
}
