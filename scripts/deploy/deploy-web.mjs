#!/usr/bin/env node
// Deploy ONE web bundle of the MPS platform, end to end, in the only safe order:
//
//   node scripts/deploy/deploy-web.mjs --app <etm|trm|atelier|trs> [--dry-run] [--skip-build]
//
//   1. guard   the app's main checkout is clean, on master, at origin/master
//   2. build   `pnpm --filter <pkg> build` with VITE_API_URL=/api set IN THE CHILD ENV
//              (no shell in between, so git-bash cannot mangle it into
//              C:/Program Files/Git/api — Footgun A — and it cannot be unset — Footgun B)
//   3. verify  the dist: no dev fallback, no mangled path, `="/api"` present, the
//              app's own version string baked in
//   4. upload  tarball → extract OVER the dist (never wipe: open tabs still lazy-load
//              old chunks) → sweep hashed assets untouched for 14 days
//   5. verify  the SERVED bundle through nginx: same greps on what a browser gets
//   6. stamp   DEPLOYED_SHA — written LAST, by its own call, only after step 5
//
// Why a script: on 2026-09-07 the hand-typed upload lost a shell variable inside
// wsl bash -c "ssh … '…'", the extract never ran, and the stamp was written anyway.
// preflight.mjs then read prod as current while it served the previous build.
// --dry-run stops after step 3 (nothing leaves this machine).
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  ETM, TRM, WEB_HOST, assertReachable, die, git, guardTree, httpBody, httpCode, ok,
  remoteScript, scp, short, stagingDir, step, tarCreate,
} from './lib.mjs'

// THE table. A per-app difference is a row, never a fork. preflight.mjs has the
// same rows (its WEB_TIERS) — add an app to both in the same commit.
const APPS = {
  etm:     { repo: ETM, pkg: '@mps/web',         src: 'apps/web',     dir: 'mps_erp',     host: 'etm.intra.etsmalterre.com',   versionFrom: 'root' },
  trm:     { repo: TRM, pkg: '@mps-trm/web',     src: 'apps/web',     dir: 'mps_trm',     host: 'trm.intra.etsmalterre.com',     versionFrom: 'root' },
  atelier: { repo: TRM, pkg: '@mps-trm/atelier', src: 'apps/atelier', dir: 'mps_atelier', host: 'atelier.intra.etsmalterre.com', versionFrom: 'app' },
  trs:     { repo: TRM, pkg: '@mps-trm/trs',     src: 'apps/trs',     dir: 'mps_trs',     host: 'trs.intra.etsmalterre.com',     versionFrom: 'app' },
}

const argv = process.argv.slice(2)
const flag = (f) => { const i = argv.indexOf(f); if (i === -1) return false; argv.splice(i, 1); return true }
const dryRun = flag('--dry-run')
const skipBuild = flag('--skip-build')
const appIdx = argv.indexOf('--app')
const appKey = appIdx !== -1 ? argv[appIdx + 1] : argv[0]
const app = APPS[appKey]
if (!app) die(`usage: deploy-web.mjs --app <${Object.keys(APPS).join('|')}> [--dry-run] [--skip-build]`)

const label = `${appKey} web`
const appDir = path.join(app.repo, app.src)
const dist = path.join(appDir, 'dist')
const remoteDist = `/home/debian/${app.dir}/dist`
const stampFile = `/home/debian/${app.dir}/DEPLOYED_SHA`
const version = JSON.parse(fs.readFileSync(
  path.join(app.versionFrom === 'root' ? app.repo : appDir, 'package.json'), 'utf8')).version

// 1. guard
step(`guard — ${label} builds from ${app.repo}`)
const sha = guardTree(app.repo, `${appKey} checkout`)
if (appKey === 'trm') {
  // TRM's web imports shared screens from the ETM checkout via the @etm alias.
  guardTree(ETM, 'ETM checkout (shared screens)')
}
if (!dryRun) assertReachable(WEB_HOST)

// 2. build — env goes straight to the child, no shell, no MSYS path conversion
if (!skipBuild) {
  step(`build — pnpm --filter ${app.pkg} build (VITE_API_URL=/api, version ${version})`)
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  const inst = spawnSync(pnpm, ['install'], { cwd: app.repo, stdio: 'inherit', shell: process.platform === 'win32' })
  if (inst.status !== 0) die('pnpm install failed')
  const r = spawnSync(pnpm, ['--filter', app.pkg, 'build'], {
    cwd: app.repo, stdio: 'inherit', shell: process.platform === 'win32',
    env: { ...process.env, VITE_API_URL: '/api' },
  })
  if (r.status !== 0) die('build failed')
} else step('build — skipped (--skip-build), verifying the dist that is there')

// 3. verify the dist — negative AND positive, over EVERY index chunk
step('verify the built bundle')
const assets = path.join(dist, 'assets')
const chunks = fs.existsSync(assets) ? fs.readdirSync(assets).filter((f) => /^index-.*\.js$/.test(f)) : []
if (chunks.length === 0) die(`no index-*.js in ${assets} — did the build run?`)
function checkBundle(read, where) {
  let hasApi = false, hasVersion = false
  for (const c of chunks) {
    const js = read(c)
    if (js === null) continue
    if (/localhost:\d+\/api/.test(js)) die(`${where} ${c} bakes a dev API fallback (Footgun B: VITE_API_URL unset)`)
    if (js.includes('Program Files/Git/api')) die(`${where} ${c} bakes "C:/Program Files/Git/api" (Footgun A: git-bash mangling)`)
    if (js.includes('="/api"')) hasApi = true
    if (js.includes(`"${version}"`)) hasVersion = true
  }
  if (!hasApi) die(`${where}: no index chunk carries ="/api" — the API base is wrong, do NOT deploy`)
  // An app that declares __APP_VERSION__ but never renders it (atelier, as of
  // 2026-09-07) has the string tree-shaken away: only assert it where it is used.
  if (!hasVersion && rendersVersion) die(`${where}: version "${version}" not found in any index chunk — built from the wrong tree?`)
  ok(`${where}: API base /api, ${hasVersion ? `version ${version}` : `version not rendered by this app (${version} in package.json)`}, no dev fallback, no mangled path (${chunks.length} index chunk(s))`)
}
const rendersVersion = (() => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : /\.(tsx?|jsx?)$/.test(e.name) && !e.name.endsWith('.d.ts') ? [path.join(d, e.name)] : [])
  return walk(path.join(appDir, 'src')).some((f) => fs.readFileSync(f, 'utf8').includes('__APP_VERSION__'))
})()
checkBundle((c) => fs.readFileSync(path.join(assets, c), 'utf8'), 'local dist')

if (dryRun) { ok(`dry run — ${label} ${short(sha)} v${version} is ready to ship; nothing uploaded`); process.exit(0) }

// 4. upload + extract over
step(`upload → ${WEB_HOST}:${remoteDist}`)
const tarball = path.join(stagingDir(), `${appKey}_web_dist.tar.gz`)
fs.rmSync(tarball, { force: true })
const t = tarCreate(tarball, dist)
if (t.status !== 0) die('tar failed')
scp(tarball, WEB_HOST, `/home/debian/${appKey}_web_dist.tar.gz`)
const ex = remoteScript(WEB_HOST, `
D=${remoteDist}
test -d "$D" || { echo "no such dist dir: $D"; exit 3; }
rm -rf "$D.bak" && cp -a "$D" "$D.bak"
tar xzf /home/debian/${appKey}_web_dist.tar.gz -C "$D/"
find "$D/assets" -type f -mtime +14 -delete
echo "extracted; rollback point: $D.bak"
`)
if (ex.code !== 0) die(`extract failed on the host (exit ${ex.code}) — stamp NOT written; ${remoteDist}.bak is the previous build`)

// 5. verify what nginx actually serves — the browser's view, not the tarball's
step(`verify the served bundle — https://${app.host}/`)
const html = httpBody(`https://${app.host}/`)
const served = (html.match(/assets\/index-[^"']+\.js/g) || []).map((p) => p.replace('assets/', ''))
if (served.length === 0) die(`https://${app.host}/ returned no index chunk (HTTP ${httpCode(`https://${app.host}/`)})`)
const missing = served.filter((c) => !chunks.includes(c))
if (missing.length) die(`served index.html references ${missing.join(', ')} which this build did not produce — the extract did not land`)
checkBundle((c) => (served.includes(c) ? httpBody(`https://${app.host}/assets/${c}`) : null), 'served bundle')

// 6. stamp — LAST, its own call. Re-read origin/master: a landing during the build
// would make the stamp lie (2026-08-25: feat/prime merged mid-deploy).
step('stamp')
git(app.repo, ['fetch', '-q', 'origin'])
const tip = git(app.repo, ['rev-parse', 'origin/master'])
if (tip !== sha) console.log(`  \u26a0 origin/master moved to ${short(tip)} during the deploy; stamping what was SHIPPED (${short(sha)}) — rerun to ship the new tip`)
const st = remoteScript(WEB_HOST, `echo ${sha} > ${stampFile} && cat ${stampFile}`, { quiet: true })
if (st.code !== 0 || st.out.trim() !== sha) die(`stamp failed: ${st.out}`)
ok(`${label} ${short(sha)} v${version} live on https://${app.host}/ — stamped ${stampFile}`)
console.log('  Users may need « Actualiser l\'application » / Ctrl+Shift+R to pick up the new bundle.')
