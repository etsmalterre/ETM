/**
 * Guard for the screen-access manifest.
 *
 *   pnpm --filter @mps/api exec tsx src/scripts/check-screen-access.ts
 *
 * `lib/screen-keys.ts` mirrors `apps/web/src/config/navigation.ts`. The web
 * builds its nav filters and the admin tree from `mainNavigation` directly, so
 * the UI can't drift — but the API's copy is what validates stored keys and
 * what the seed script hands out, so a menu or screen added to the nav and not
 * here would be unstorable (silently dropped by PUT /permissions/users/:id).
 *
 * Parses the web's navigation.ts textually — importing it would pull JSX/TSX
 * icons into a node script. Read-only, no DB.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCREEN_MENUS, menuAccessKey, screenHideKey, isScreenAccessKey } from '../lib/screen-keys.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const NAV_FILE = path.resolve(__dirname, '../../../web/src/config/navigation.ts')

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

  const nav = parseNav(fs.readFileSync(NAV_FILE, 'utf8'))
  console.log(`navigation.ts: ${nav.length} menu(s)`)
  console.log(`screen-keys.ts: ${SCREEN_MENUS.length} menu(s)\n`)

  if (nav.length === 0) fail('parsing navigation.ts yielded no menu — the regex is stale')

  const byId = new Map(SCREEN_MENUS.map((m) => [m.id, m]))
  for (const navMenu of nav) {
    const mine = byId.get(navMenu.id)
    if (!mine) {
      fail(`menu '${navMenu.id}' est dans navigation.ts mais absent de screen-keys.ts`)
      continue
    }
    if (mine.href !== navMenu.href) {
      fail(`menu '${navMenu.id}': href ${mine.href} ≠ ${navMenu.href}`)
    }
    const mineHrefs = mine.screens.map((s) => s.href)
    for (const href of navMenu.screens) {
      if (!mineHrefs.includes(href)) fail(`écran ${href} absent de screen-keys.ts`)
    }
    for (const href of mineHrefs) {
      if (!navMenu.screens.includes(href)) fail(`écran ${href} n'existe plus dans navigation.ts`)
    }
    byId.delete(navMenu.id)
  }
  for (const orphan of byId.keys()) {
    fail(`menu '${orphan}' est dans screen-keys.ts mais absent de navigation.ts`)
  }
  if (problems === 0) ok('les deux manifestes concordent (menus + écrans)')

  // Key derivation must agree with the web's copy of the same two one-liners.
  const samples: Array<[string, string]> = [
    [menuAccessKey('/sous-traitants'), 'screen_sous_traitants'],
    [screenHideKey('/clients/facturation'), 'hide_clients_facturation'],
    [screenHideKey('/finis/etudes-coloris'), 'hide_finis_etudes_coloris'],
  ]
  for (const [got, want] of samples) {
    if (got === want) ok(`clé ${want}`)
    else fail(`clé attendue ${want}, obtenue ${got}`)
  }

  // Every derived key must be storable, or PUT would drop it silently.
  for (const m of SCREEN_MENUS) {
    if (!isScreenAccessKey(menuAccessKey(m.href))) fail(`clé menu non valide: ${m.href}`)
    for (const s of m.screens) {
      if (!isScreenAccessKey(screenHideKey(s.href))) fail(`clé écran non valide: ${s.href}`)
    }
  }

  console.log(problems === 0 ? '\nOK' : `\n${problems} problème(s)`)
  process.exitCode = problems === 0 ? 0 : 1
}

main()
