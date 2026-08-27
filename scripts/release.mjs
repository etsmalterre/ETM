#!/usr/bin/env node
// Bump the ROOT package.json version, commit it as `chore(release): X.Y.Z`, push.
//
// Why this exists as a script and not an inline `node -e` in the deploy skill:
// on 2026-08-27 a compound Bash call had `cd`'d into the sibling repo, so the
// inline bump read the WRONG package.json and would have rewritten ETM's version
// (0.2.4 -> 0.0.4) and pushed it. Only an ad-hoc "expected current version"
// assertion caught it. This script resolves the repo root from its OWN location
// (import.meta.url), so the caller's cwd cannot point it at another repo — the
// class of bug is gone rather than guarded against.
//
//   node scripts/release.mjs 0.0.5            # bump, commit, push
//   node scripts/release.mjs 0.0.5 --dry-run  # show what it would do
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PKG = path.join(ROOT, 'package.json')
const dry = process.argv.includes('--dry-run')
const next = process.argv.slice(2).find((a) => !a.startsWith('-'))

const die = (m) => { console.error('ERROR: ' + m); process.exit(1) }
const git = (args) => execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' }).trim()

if (!next) die('usage: node scripts/release.mjs <version> [--dry-run]')
if (!/^\d+\.\d+\.\d+$/.test(next)) die(`"${next}" is not a bare X.Y.Z version (no leading v)`)

const raw = fs.readFileSync(PKG, 'utf8')
const pkg = JSON.parse(raw)
const cur = pkg.version

console.log(`repo    : ${ROOT}`)
console.log(`package : ${pkg.name}`)
console.log(`version : ${cur} -> ${next}`)

// The two apps ship independently and their numbers are unrelated (TRM started
// its own count at 0.0.1 while ETM was at 0.2.4). Never "align" them; a bump that
// goes backwards or sideways is the signature of pointing at the wrong repo.
const cmp = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}
if (cmp(next, cur) <= 0) die(`${next} is not ahead of the current ${cur} — wrong repo, or a typo`)

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
if (branch !== 'master') die(`on branch "${branch}" — a release is cut from master`)
const dirty = git(['status', '--porcelain'])
if (dirty) die(`working tree is not clean:\n${dirty}\nCommit or stash first — a release must describe a known tree.`)
git(['fetch', '-q', 'origin'])
const behind = git(['rev-list', '--count', 'HEAD..origin/master'])
if (behind !== '0') die(`local master is ${behind} commit(s) behind origin/master — pull first`)

if (dry) { console.log('\n--dry-run: nothing written.'); process.exit(0) }

fs.writeFileSync(PKG, raw.replace(`"version": "${cur}"`, `"version": "${next}"`))
if (JSON.parse(fs.readFileSync(PKG, 'utf8')).version !== next) die('rewrite failed — version string not found verbatim')
git(['add', 'package.json'])
execFileSync('git', ['-C', ROOT, 'commit', '-q', '-m', `chore(release): ${next}`], { stdio: 'inherit' })
git(['push', '-q', 'origin', 'master'])
console.log(`\nReleased ${next} — ${git(['log', '--oneline', '-1'])}`)
console.log('The build bakes this in as __APP_VERSION__, so build AFTER this, never before.')
