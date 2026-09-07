#!/usr/bin/env node
// Deploy the MPS API (mps-api.service on 10.10.2.163) from the ETM main checkout:
//
//   node scripts/deploy/deploy-api.mjs [--dry-run] [--allow-orphans]
//
//   1. guard    ETM main checkout clean, on master, at origin/master
//   2. orphans  every file in prod's src/scripts must exist in the repo — it is pruned
//               before the extract, and on 2026-08-25 it held a 196-line guard that
//               existed nowhere else. Refuses; rescue the file into the repo first.
//   3. deps     prod's package.json vs ours (minus workspace: refs): identical → no
//               npm install; different → the new package.json ships and npm install runs
//   4. env      prod's .env vs our .env.production: must be identical (the .env on the
//               host is the secret store; this script never overwrites it)
//   5. tarball  src/ minus *.test.ts → upload
//   6. host     backup → rm -rf src/scripts → extract → [npm install] → restart →
//               wait for /api/health to say "MPS API" → journal scan (HY090 = the
//               accented-literal footgun that only fails on the Linux bridge)
//   7. smoke    every client through its own nginx: mpsng, trm, atelier, trs
//   8. stamp    DEPLOYED_SHA — last, its own call, only after 6 and 7
//
// One restart blips EVERY client (ETM, TRM, atelier, TRS) — which is why step 7
// checks all of them and why an src/scripts-only change should not come through here
// (preflight.mjs says so; run the script on the host by hand instead).
// --dry-run stops after step 5's tarball (nothing leaves this machine).
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  API_HOST, ETM, assertReachable, die, git, guardTree, httpCode, ok, red, remote,
  remoteScript, scp, short, stagingDir, step,
} from './lib.mjs'

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const allowOrphans = argv.includes('--allow-orphans')
const apiDir = path.join(ETM, 'apps', 'api')
const REMOTE = '/home/debian/mps_api'

// 1. guard
step('guard — the API builds from ' + ETM)
const sha = guardTree(ETM, 'ETM checkout')
assertReachable(API_HOST)

// 2. orphans in prod's src/scripts
step('orphans — prod src/scripts vs repo')
const prodScripts = (remote(API_HOST, `ls -1 ${REMOTE}/src/scripts 2>/dev/null`) || '').split('\n').filter(Boolean)
const localScripts = new Set(fs.readdirSync(path.join(apiDir, 'src', 'scripts')))
const orphans = prodScripts.filter((f) => !localScripts.has(f))
if (orphans.length && !allowOrphans) {
  die(`prod has ${orphans.length} file(s) under src/scripts that are in no commit — they would be deleted:\n    ${orphans.join('\n    ')}\n  Rescue them into apps/api/src/scripts (scp them down) or rerun with --allow-orphans to drop them.`)
}
ok(orphans.length ? `${orphans.length} orphan(s) will be dropped (--allow-orphans)` : `no orphans (${prodScripts.length} scripts on prod)`)

// 3. dependencies
step('deps — prod package.json vs ours')
const local = JSON.parse(fs.readFileSync(path.join(apiDir, 'package.json'), 'utf8'))
// prod is a standalone copy: workspace: refs cannot resolve outside the monorepo
for (const k of ['dependencies', 'devDependencies']) {
  for (const [n, v] of Object.entries(local[k] || {})) if (String(v).startsWith('workspace:')) delete local[k][n]
}
const prodPkgText = remote(API_HOST, `cat ${REMOTE}/package.json`)
if (prodPkgText === null) die('cannot read prod package.json')
const prodPkg = JSON.parse(prodPkgText)
const depsKey = (p) => JSON.stringify([p.dependencies, p.devDependencies, p.overrides])
const depsChanged = depsKey(prodPkg) !== depsKey(local)
if (depsChanged) console.log('  dependencies differ → package.json ships and `npm install` runs on the host')
else ok('dependencies identical → no npm install')

// 4. env — never overwritten from here, only compared
step('env — prod .env vs .env.production')
const localEnv = fs.readFileSync(path.join(apiDir, '.env.production'), 'utf8').replace(/\r/g, '').trim()
const prodEnv = (remote(API_HOST, `cat ${REMOTE}/.env`) || '').replace(/\r/g, '').trim()
if (localEnv !== prodEnv) {
  const keys = (s) => new Set(s.split('\n').map((l) => l.split('=')[0]).filter((k) => k && !k.startsWith('#')))
  const lk = keys(localEnv), pk = keys(prodEnv)
  const onlyLocal = [...lk].filter((k) => !pk.has(k)), onlyProd = [...pk].filter((k) => !lk.has(k))
  die(`prod .env differs from apps/api/.env.production (keys only here: ${onlyLocal.join(', ') || '-'}; only on prod: ${onlyProd.join(', ') || '-'}; or a value changed).\n  Reconcile by hand — this script never writes the host's .env.`)
}
ok('.env identical to .env.production')

// 5. tarball
step('tarball — src/ (tests excluded)' + (depsChanged ? ' + package.json' : ''))
const stage = path.join(stagingDir(), 'mps_api_pkg')
fs.rmSync(stage, { recursive: true, force: true })
fs.mkdirSync(stage, { recursive: true })
fs.cpSync(path.join(apiDir, 'src'), path.join(stage, 'src'), {
  recursive: true, filter: (p) => !/\.test\.tsx?$/.test(p),
})
if (depsChanged) fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(local, null, 2) + '\n')
const tarball = path.join(stagingDir(), 'mps_api_src.tar.gz')
fs.rmSync(tarball, { force: true })
const t = spawnSync('tar', ['czf', tarball, '-C', stage, '.'], { stdio: 'inherit' })
if (t.status !== 0) die('tar failed')
ok(`${tarball} (${(fs.statSync(tarball).size / 1024 / 1024).toFixed(1)} MB)`)

if (dryRun) { ok(`dry run — API ${short(sha)} is ready to ship; nothing uploaded, no restart`); process.exit(0) }

// 6. upload, extract, restart, health, journal
step(`deploy → ${API_HOST}:${REMOTE} (restart blips every client)`)
scp(tarball, API_HOST, '/home/debian/mps_api_src.tar.gz')
const r = remoteScript(API_HOST, `
cd ${REMOTE}
tar czf ../mps_api_backup.tar.gz src/ package.json
rm -rf src/scripts
tar xzf ../mps_api_src.tar.gz
${depsChanged ? 'npm install 2>&1 | tail -3' : ''}
sudo systemctl restart mps-api
for i in $(seq 1 30); do
  sleep 1
  if curl -s -m 2 http://localhost:8081/api/health | grep -q '"app":"MPS API"'; then echo "health OK after \${i}s"; break; fi
  if [ "$i" = 30 ]; then echo "health NOT answering after 30s"; sudo journalctl -u mps-api --since '2 min ago' --no-pager | tail -30; exit 4; fi
done
sudo systemctl is-active mps-api
echo "journal errors (HY090/Error) since restart: $(sudo journalctl -u mps-api --since '2 min ago' --no-pager | grep -c 'HY090\\|Error' || true)"
`)
if (r.code !== 0) die(`deploy failed on the host (exit ${r.code}) — stamp NOT written.\n  Rollback: ssh ${API_HOST} 'cd ${REMOTE} && tar xzf ../mps_api_backup.tar.gz && sudo systemctl restart mps-api'`)

// 7. smoke every client through its own proxy (a failure here is nginx-side if health passed)
step('smoke — every client through its nginx')
const probes = [
  ['https://mpsng.malterre/api/fournisseurs', ['200']],
  ['https://trm.malterre/api/auth/users', ['200']],
  ['https://atelier.malterre/api/health', ['200']],
  ['https://trs.malterre/api/trs/atelier', ['200']],
]
let bad = 0
for (const [url, want] of probes) {
  const code = httpCode(url)
  if (want.includes(code)) ok(`${code} ${url}`)
  else { bad++; console.log('  ' + red('✘') + ` ${code} ${url}`) }
}
if (bad) die(`${bad} client(s) not answering through nginx — stamp NOT written; the service is up (health passed), look at the proxy side`)

// 8. stamp — last, its own call
step('stamp')
git(ETM, ['fetch', '-q', 'origin'])
const tip = git(ETM, ['rev-parse', 'origin/master'])
if (tip !== sha) console.log(`  ⚠ origin/master moved to ${short(tip)} during the deploy; stamping what was SHIPPED (${short(sha)}) — rerun to ship the new tip`)
const st = remoteScript(API_HOST, `echo ${sha} > ${REMOTE}/DEPLOYED_SHA && cat ${REMOTE}/DEPLOYED_SHA`, { quiet: true })
if (st.code !== 0 || st.out.trim() !== sha) die(`stamp failed: ${st.out}`)
ok(`MPS API ${short(sha)} live — stamped ${REMOTE}/DEPLOYED_SHA`)
console.log('  Owed one-off scripts (seed-*/fix-* landed in this range) are listed by preflight.mjs — run them on the host, then restart again if they write data/*.json.')
