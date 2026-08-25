/**
 * Guard for TRM's screen-access manifest.
 *
 *   pnpm --filter @mps/api exec tsx src/scripts/check-screen-access-trm.ts
 *   pnpm --filter @mps/api exec tsx src/scripts/check-screen-access-trm.ts --nav <path>
 *
 * `lib/screen-keys-trm.ts` mirrors TRM's `apps/web/src/config/navigation.ts`.
 * The TRM web builds its nav filters and the admin tree from `mainNavigation`
 * directly, so the UI can't drift — but the API's copy is what validates stored
 * keys and what the seed script hands out, so a menu or screen added to the nav
 * and not here would be unstorable (silently dropped by
 * PUT /permissions-trm/users/:id).
 *
 * The nav file lives in the SIBLING TRM repo (`../TRM` next to this checkout —
 * the same invariant the `@etm` import alias depends on). When the TRM change
 * is still on a feature branch in a TRM worktree, point at it explicitly:
 *   … check-screen-access-trm.ts --nav C:/dev/etsmalterre/TRM-<feature>/apps/web/src/config/navigation.ts
 *
 * (a relative --nav resolves from the cwd, which pnpm --filter sets to the repo
 * root, so an absolute path is the safe form.)
 *
 * Parses navigation.ts textually — importing it would pull JSX/TSX icons into a
 * node script. Read-only, no DB.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  TRM_SCREEN_MENUS,
  trmMenuAccessKey,
  trmScreenHideKey,
  isTrmScreenAccessKey,
} from '../lib/screen-keys-trm.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** ETM/apps/api/src/scripts → C:/dev/etsmalterre → TRM/apps/web/src/config */
const DEFAULT_NAV_FILE = path.resolve(
  __dirname,
  '../../../../../TRM/apps/web/src/config/navigation.ts',
)

function navFilePath(): string {
  const i = process.argv.indexOf('--nav')
  if (i >= 0 && process.argv[i + 1]) return path.resolve(process.cwd(), process.argv[i + 1])
  return DEFAULT_NAV_FILE
}

/** Pull `mainNavigation`'s menu ids and their submenu hrefs out of the source. */
function parseNav(src: string): Array<{ id: string; href: string; screens: string[] }> {
  const start = src.indexOf('export const mainNavigation')
  if (start < 0) throw new Error('mainNavigation not found in navigation.ts')
  // The array ends at the closing bracket of the declaration; getActiveMenu
  // follows it, so cut there.
  const end = src.indexOf('export function getActiveMenu', start)
  const block = src.slice(start, end < 0 ? undefined : end)

  const out: Array<{ id: string; href: string; screens: string[] }> = []
  // Each menu object starts with `id: '<x>'` and carries a top-level
  // `href: '/<x>'` before its submenus array.
  const menuRe = /id:\s*'([^']+)',[\s\S]*?href:\s*'([^']+)',\s*submenus:\s*\[([\s\S]*?)\],\s*\}/g
  let m: RegExpExecArray | null
  while ((m = menuRe.exec(block)) !== null) {
    const [, id, href, submenusBlock] = m
    const screens = [...submenusBlock.matchAll(/href:\s*'([^']+)'/g)].map((s) => s[1])
    out.push({ id, href, screens })
  }
  return out
}

function main() {
  let problems = 0
  const fail = (msg: string) => { console.log(`  ✗ ${msg}`); problems++ }
  const ok = (msg: string) => console.log(`  ✓ ${msg}`)

  const navFile = navFilePath()
  console.log(`nav: ${navFile}`)
  const nav = parseNav(fs.readFileSync(navFile, 'utf8'))
  console.log(`navigation.ts: ${nav.length} menu(s)`)
  console.log(`screen-keys-trm.ts: ${TRM_SCREEN_MENUS.length} menu(s)\n`)

  if (nav.length === 0) fail('parsing navigation.ts yielded no menu — the regex is stale')

  const byId = new Map(TRM_SCREEN_MENUS.map((m) => [m.id, m]))
  for (const navMenu of nav) {
    const mine = byId.get(navMenu.id)
    if (!mine) {
      fail(`menu '${navMenu.id}' est dans navigation.ts mais absent de screen-keys-trm.ts`)
      continue
    }
    if (mine.href !== navMenu.href) {
      fail(`menu '${navMenu.id}': href ${mine.href} ≠ ${navMenu.href}`)
    }
    const mineHrefs = mine.screens.map((s) => s.href)
    for (const href of navMenu.screens) {
      if (!mineHrefs.includes(href)) fail(`écran ${href} absent de screen-keys-trm.ts`)
    }
    for (const href of mineHrefs) {
      if (!navMenu.screens.includes(href)) fail(`écran ${href} n'existe plus dans navigation.ts`)
    }
    byId.delete(navMenu.id)
  }
  for (const orphan of byId.keys()) {
    fail(`menu '${orphan}' est dans screen-keys-trm.ts mais absent de navigation.ts`)
  }
  if (problems === 0) ok('les deux manifestes concordent (menus + écrans)')

  // Key derivation must agree with the web's copy of the same two one-liners.
  const samples: Array<[string, string]> = [
    [trmMenuAccessKey('/tombe-metier'), 'screen_tombe_metier'],
    [trmScreenHideKey('/clients/facturation'), 'hide_clients_facturation'],
    [trmScreenHideKey('/rapports/etat-stock-fil'), 'hide_rapports_etat_stock_fil'],
  ]
  for (const [got, want] of samples) {
    if (got === want) ok(`clé ${want}`)
    else fail(`clé attendue ${want}, obtenue ${got}`)
  }

  // Every derived key must be storable, or PUT would drop it silently.
  for (const m of TRM_SCREEN_MENUS) {
    if (!isTrmScreenAccessKey(trmMenuAccessKey(m.href))) fail(`clé menu non valide: ${m.href}`)
    for (const s of m.screens) {
      if (!isTrmScreenAccessKey(trmScreenHideKey(s.href))) fail(`clé écran non valide: ${s.href}`)
    }
  }

  console.log(problems === 0 ? '\nOK' : `\n${problems} problème(s)`)
  process.exitCode = problems === 0 ? 0 : 1
}

main()
