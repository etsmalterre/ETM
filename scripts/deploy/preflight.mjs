#!/usr/bin/env node
// One command answering "what does a deploy need right now?" — for the whole MPS
// platform, not one app. READ-ONLY: it never writes a server or a repo.
//
//   node scripts/deploy/preflight.mjs
//
// It exists because this diagnosis was hand-run five times on 2026-08-27 and is
// where every mistake happened: a stale memory of "already deployed", a route
// gate that goes green while prod runs an OLDER handler of the same router, a
// local dist rebuilt from master PLUS an uncommitted edit, and a seed script a
// landed feature still owed on the prod host.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve the MAIN checkouts, never a worktree: this script may itself live in one,
// and 'is the tree clean' is a question about the tree a deploy would build from.
// --git-common-dir points at the shared .git even from inside a worktree.
const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
function mainCheckout(start) {
  try {
    const common = execFileSync('git', ['-C', start, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8' }).trim()
    return path.dirname(common) // <repo>/.git -> <repo>
  } catch { return start }
}
const ETM = mainCheckout(here)
const TRM = path.resolve(ETM, '..', 'TRM')
const API_HOST = 'debian@10.10.2.163'
const WEB_HOST = 'debian@10.10.2.165'

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const git = (repo, args) => { try { return sh('git', ['-C', repo, ...args]) } catch { return '' } }

// Transport: the key lives Windows-side on the laptop, WSL-side on the factory PC.
const WIN_KEY = path.join(os.homedir(), '.ssh', 'claude_deploy', 'claude_deploy')
const useWin = fs.existsSync(WIN_KEY)
const WOPTS = '-i /home/vincent/.ssh/claude_deploy/claude_deploy -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no'
function remote(host, cmd) {
  try {
    if (useWin) {
      return sh('C:\Windows\System32\OpenSSH\ssh.exe',
        ['-F', 'none', '-i', WIN_KEY, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes',
         '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', host, cmd])
    }
    // Never nest $(…) inside this — it silently yields the fallback branch.
    return sh('wsl', ['bash', '-c', `ssh ${WOPTS} ${host} '${cmd}'`])
  } catch { return null }
}

const out = []
const say = (s = '') => out.push(s)
let blockers = 0, actions = 0
const BLOCK = (s) => { blockers++; say('  \u001b[31m\u2718\u001b[0m ' + s) }
const TODO  = (s) => { actions++;  say('  \u001b[33m\u2192\u001b[0m ' + s) }
const OK    = (s) => say('  \u001b[32m\u2713\u001b[0m ' + s)

for (const [name, repo] of [['ETM', ETM], ['TRM', TRM]]) git(repo, ['fetch', '-q', 'origin'])

const stamps = {
  api: remote(API_HOST, 'cat /home/debian/mps_api/DEPLOYED_SHA 2>/dev/null || echo none'),
  trmWeb: remote(WEB_HOST, 'cat /home/debian/mps_trm/DEPLOYED_SHA 2>/dev/null || echo none'),
  etmWeb: remote(WEB_HOST, 'cat /home/debian/mps_erp/DEPLOYED_SHA 2>/dev/null || echo none'),
}
if (Object.values(stamps).every((v) => v === null)) {
  console.error('Cannot reach the servers. Off the factory LAN/VPN, or the claude_deploy key is not enabled.')
  console.error('This check fails closed: an unreachable host is never a silent pass.')
  process.exit(2)
}

const heads = { ETM: git(ETM, ['rev-parse', 'origin/master']), TRM: git(TRM, ['rev-parse', 'origin/master']) }
const short = (s) => (s && s !== 'none' ? s.slice(0, 7) : String(s))

say('\n\u2500\u2500 MPS platform \u2500 what is live \u2500\u2500')
say(`  MPS API   ${short(stamps.api)}   (ETM master ${short(heads.ETM)})`)
say(`  TRM web   ${short(stamps.trmWeb)}   (TRM master ${short(heads.TRM)})`)
say(`  ETM web   ${short(stamps.etmWeb)}   (ETM master ${short(heads.ETM)})`)

const rangeFiles = (repo, from, pathspec) => {
  if (!from || from === 'none') return ['<unknown stamp — treat as behind>']
  const o = git(repo, ['diff', '--name-only', `${from}..origin/master`, '--', pathspec])
  return o ? o.split('\n').filter(Boolean) : []
}

say('\n\u2500\u2500 What needs deploying \u2500\u2500')

// 1. MPS API
const apiFiles = rangeFiles(ETM, stamps.api, 'apps/api')
const apiRuntime = apiFiles.filter((f) => !f.startsWith('apps/api/src/scripts/'))
if (apiFiles.length === 0) OK('MPS API is current')
else if (apiRuntime.length === 0) {
  TODO(`MPS API: only src/scripts/** changed (${apiFiles.length} file(s)) — do NOT restart the service.`)
  say('       Run the script by hand on the host instead; a restart blips every client.')
} else {
  TODO(`MPS API is BEHIND — ${apiRuntime.length} runtime file(s). Deploy it FIRST (/etm_deploy).`)
  apiRuntime.slice(0, 6).forEach((f) => say(`       ${f}`))
  say('       \u26a0 A sub-route added to an already-mounted router passes check-api-routes.mjs')
  say('         while prod serves the OLD handler. Only this SHA diff catches that.')
}

// 2. the two web bundles
for (const [label, repo, stamp] of [['TRM web', TRM, stamps.trmWeb], ['ETM web', ETM, stamps.etmWeb]]) {
  const f = rangeFiles(repo, stamp, 'apps/web')
  if (f.length === 0) OK(`${label} is current (no apps/web change since its stamp)`)
  else TODO(`${label} is BEHIND — ${f.length} file(s) under apps/web`)
}

// 3. clean trees — a dist built from master PLUS an uncommitted edit ships unreviewed code
say('\n\u2500\u2500 Working trees \u2500\u2500')
for (const [name, repo] of [['ETM', ETM], ['TRM', TRM]]) {
  const dirty = git(repo, ['status', '--porcelain'])
  const branch = git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch !== 'master') BLOCK(`${name} main checkout (${repo}) is on "${branch}", not master`)
  else if (dirty) BLOCK(`${name} tree is DIRTY (${dirty.split('\n').length} file(s)) — build would bake in uncommitted work`)
  else OK(`${name} clean on master`)
}

// 4. owed one-off prod scripts (heuristic — the gates compare code, never state)
say('\n\u2500\u2500 Prod state the gates cannot see \u2500\u2500')
const perms = remote(API_HOST, 'cat /home/debian/mps_api/data/permissions-trm.json 2>/dev/null | tr -d "\n" | head -c 200000')
if (perms === null) say('  (could not read permissions-trm.json)')
else {
  for (const [key, fix] of [['edit_of', 'seed-edit-of-trm.ts --write'], ['screen_', 'seed-screen-access-trm.ts --write']]) {
    const n = (perms.match(new RegExp(key, 'g')) || []).length
    if (n === 0) BLOCK(`no "${key}" grant in permissions-trm.json — run ${fix} on the API host`)
    else OK(`${key} present (${n} grant${n > 1 ? 's' : ''})`)
  }
}

say('')
say(blockers ? `\u001b[31m${blockers} blocker(s)\u001b[0m and ${actions} action(s).`
             : actions ? `No blockers. ${actions} deploy action(s) — MPS API first, then the web bundles.`
                       : 'Everything is current. Nothing to deploy.')
say('')
console.log(out.join('\n'))
process.exit(blockers ? 1 : 0)
