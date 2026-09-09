// Shared plumbing for the deploy scripts (preflight, deploy-api, deploy-web).
//
// The one rule that matters here: a REMOTE COMMAND IS NEVER BUILT BY STRING
// CONCATENATION WITH SHELL VARIABLES IN IT. It is a plain bash script fed to
// `ssh host 'bash -s'` on stdin. On 2026-09-07 a hand-typed
//   wsl bash -c "ssh … 'D=/x; cp -a $D $D.bak && tar … -C $D/; echo SHA > STAMP'"
// lost `$D` in the double quoting, the `&&` chain stopped before tar, and the
// `;`-separated stamp was written anyway — prod's DEPLOYED_SHA claimed a bundle
// that was never extracted. Nothing in that line could report the lie. With
// stdin there is nothing to escape, and the caller decides what runs after a
// failure (here: nothing — the stamp is written by a SEPARATE call, only after
// the served bundle has been verified).
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const API_HOST = 'debian@10.10.20.3'
export const WEB_HOST = 'debian@10.10.20.4'

// Resolve the MAIN checkouts, never a worktree (this file may live in one).
const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export function mainCheckout(start) {
  try {
    const common = execFileSync('git', ['-C', start, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8' }).trim()
    return path.dirname(common)
  } catch { return start }
}
export const ETM = mainCheckout(here)
export const TRM = path.resolve(ETM, '..', 'TRM')

export const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()
export const git = (repo, args) => { try { return sh('git', ['-C', repo, ...args]) } catch { return '' } }

export const short = (s) => (s && s !== 'none' ? s.slice(0, 7) : String(s))
export const red = (s) => `\u001b[31m${s}\u001b[0m`
export const green = (s) => `\u001b[32m${s}\u001b[0m`
export const yellow = (s) => `\u001b[33m${s}\u001b[0m`
export function die(msg, code = 1) { console.error(red('\u2718 ') + msg); process.exit(code) }
export const ok = (s) => console.log(green('\u2713 ') + s)
export const step = (s) => console.log('\n' + yellow('\u2192 ') + s)

// ── Transport ──────────────────────────────────────────────────────────────
// The key lives Windows-side on the laptop (user malte), WSL-side on the factory
// PC (user vince). Pick by file test, never by a failed probe.
const WIN_KEY = path.join(os.homedir(), '.ssh', 'claude_deploy', 'claude_deploy')
export const useWin = fs.existsSync(WIN_KEY)
const WIN_SSH = 'C:\\Windows\\System32\\OpenSSH\\ssh.exe'
const WIN_SCP = 'C:\\Windows\\System32\\OpenSSH\\scp.exe'
const WIN_OPTS = ['-F', 'none', '-i', WIN_KEY, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new']
const WSL_OPTS = '-i /home/vincent/.ssh/claude_deploy/claude_deploy -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no'

// C:\Users\x\… → /mnt/c/Users/x/… (WSL scp can only read /mnt/c paths).
export const winToWsl = (p) => {
  const abs = path.resolve(p).replace(/\\/g, '/')
  const m = abs.match(/^([A-Za-z]):\/(.*)$/)
  return m ? `/mnt/${m[1].toLowerCase()}/${m[2]}` : abs
}

// Run a bash SCRIPT (multi-line text) on the host. Returns { code, out }.
// `set -e` is prepended so the first failing line ends the script — the caller
// never gets a "success" with half the steps skipped.
export function remoteScript(host, script, { quiet = false } = {}) {
  const body = 'set -euo pipefail\n' + script
  const r = useWin
    ? spawnSync(WIN_SSH, [...WIN_OPTS, host, 'bash -s'], { input: body, encoding: 'utf8' })
    : spawnSync('wsl', ['bash', '-c', `ssh ${WSL_OPTS} ${host} 'bash -s'`], { input: body, encoding: 'utf8' })
  const out = ((r.stdout || '') + (r.stderr || '')).trim()
  if (!quiet && out) console.log(out.split('\n').map((l) => '    ' + l).join('\n'))
  return { code: r.status ?? 1, out }
}
// One-liner convenience: returns stdout or null on failure.
export function remote(host, cmd) {
  const r = remoteScript(host, cmd, { quiet: true })
  return r.code === 0 ? r.out : null
}
export function scp(localPath, host, remotePath) {
  if (useWin) {
    sh(WIN_SCP, [...WIN_OPTS.filter((o) => o !== '-F' && o !== 'none'), localPath, `${host}:${remotePath}`])
  } else {
    sh('wsl', ['bash', '-c', `scp ${WSL_OPTS} ${winToWsl(localPath)} ${host}:${remotePath}`])
  }
}
export function assertReachable(host) {
  const h = remote(host, 'hostname')
  if (h === null) die(`cannot reach ${host} — off the factory LAN/VPN, or the claude_deploy key is not enabled (Permission denied = ask the user to enable it).`, 2)
  return h
}

// ── HTTP probes (curl -sk: hosts are https with a private CA) ─────────────
export function httpCode(url) {
  try { return sh('curl', ['-sk', '-m', '20', '-o', os.devNull, '-w', '%{http_code}', url]) } catch { return '000' }
}
export function httpBody(url) {
  try { return sh('curl', ['-sk', '-m', '60', url], { maxBuffer: 64 * 1024 * 1024 }) } catch { return '' }
}

// ── Tree guard: the build reads THIS tree, the stamp names origin/master ───
export function guardTree(repo, label) {
  git(repo, ['fetch', '-q', 'origin'])
  const dirty = git(repo, ['status', '--porcelain'])
  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const behind = Number(git(repo, ['rev-list', '--count', 'HEAD..origin/master']) || 0)
  const ahead = Number(git(repo, ['rev-list', '--count', 'origin/master..HEAD']) || 0)
  if (branch !== 'master') die(`${label} (${repo}) is on "${branch}", not master`)
  if (dirty) die(`${label} tree is DIRTY (${dirty.split('\n').length} file(s)) — the build would bake in uncommitted work`)
  if (ahead) die(`${label} master has ${ahead} local commit(s) not on origin/master — push them first`)
  if (behind) die(`${label} is ${behind} commit(s) BEHIND origin/master. Fix: git -C ${repo} merge --ff-only origin/master`)
  const sha = git(repo, ['rev-parse', 'HEAD'])
  ok(`${label} clean on master at origin/master (${short(sha)})`)
  return sha
}

// Staging dir for tarballs: must be Windows-visible (WSL scp reads /mnt/c only).
export function stagingDir() {
  const d = path.join(os.tmpdir(), 'mps-deploy')
  fs.mkdirSync(d, { recursive: true })
  return d
}

// GNU tar (git-bash's /usr/bin/tar, first on PATH under the Bash tool) reads
// "C:\…" as a REMOTE HOST and dies with "Cannot connect to C: resolve failed".
// Windows ships bsdtar in System32; pin it. Returns { status } like spawnSync.
export function tarCreate(tarball, cwd) {
  // Doubled backslashes: '\W' / '\S' are silently dropped by JS and '\t' is a TAB.
  const exe = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar'
  return spawnSync(exe, ['czf', tarball, '-C', cwd, '.'], { stdio: 'inherit' })
}
