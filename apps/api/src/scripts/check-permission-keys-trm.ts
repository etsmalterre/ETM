/**
 * Guard for TRM's ACTION-key catalog — the sibling of check-screen-access-trm.ts.
 *
 *   pnpm --filter @mps/api exec tsx src/scripts/check-permission-keys-trm.ts
 *   pnpm --filter @mps/api exec tsx src/scripts/check-permission-keys-trm.ts --web <path to TRM apps/web/src>
 *
 * WHY THIS EXISTS
 * ---------------
 * TRM screens gate their buttons with `useHasPermission('<key>')`, which reads
 * `/api/permissions-trm/me` — TRM's store, filtered to TRM's catalog. A key the
 * screen names but `permission-keys-trm.ts` does not declare fails SILENTLY and
 * unrecoverably:
 *
 *   • Paramètres > Utilisateurs renders no toggle for it (the tab is built from
 *     GET /permissions-trm/keys, i.e. the catalog);
 *   • setTrmUserPermissions() drops it as unknown if it ever arrives anyway;
 *   • /permissions-trm/me therefore never reports it;
 *   • → the button is invisible to every non-admin, with no way for an admin to
 *     grant it. It LOOKS like a deliberate restriction, not a bug.
 *
 * That is exactly what happened to six keys — `create_stock_fil`,
 * `edit_factures`, `edit_client_info`, `delete_client`, `crud_client_contacts`,
 * `crud_client_adresses` — which were declared only in ETM's catalog while TRM's
 * Fils > Stock, Clients > Facturation and Clients > Gestion screens used them.
 * Fils > Stock's « Nouveau lot » was unreachable for the visitage poste, and
 * the symptom (« Olivier ne peut pas créer un lot ») read as a permission that
 * simply had not been granted yet.
 *
 * This script closes the loop the other way round from check-screen-access-trm:
 * there the API manifest mirrors the web's nav; here the web's key literals must
 * all exist in the API's catalog.
 *
 * The TRM web lives in the SIBLING repo (`../TRM`). For work still on a feature
 * branch in a TRM worktree, point at it explicitly:
 *   … check-permission-keys-trm.ts --web C:/dev/etsmalterre/TRM-<feature>/apps/web/src
 *
 * Parses the .tsx textually (importing it would pull React in). Read-only, no DB.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TRM_PERMISSION_KEYS, isKnownTrmPermissionKey } from '../lib/permission-keys-trm.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
/** ETM/apps/api/src/scripts → C:/dev/etsmalterre → TRM/apps/web/src */
const DEFAULT_WEB_SRC = path.resolve(__dirname, '../../../../../TRM/apps/web/src')

function webSrcPath(): string {
  const i = process.argv.indexOf('--web')
  if (i >= 0 && process.argv[i + 1]) return path.resolve(process.cwd(), process.argv[i + 1])
  return DEFAULT_WEB_SRC
}

/** Every .ts/.tsx under a directory, skipping node_modules and test files. */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p)
    }
  }
  walk(dir)
  return out
}

/** `useHasPermission('x')` string literals — the only form the screens use. */
const USE_RE = /\buseHasPermission\(\s*'([a-z0-9_]+)'\s*\)/g
/** `permission: 'x'` in config/navigation.ts (SubMenuItem.permission). */
const NAV_RE = /\bpermission:\s*'([a-z0-9_]+)'/g

function main(): void {
  const webSrc = webSrcPath()
  let problems = 0
  const fail = (msg: string) => { console.log(`  ✗ ${msg}`); problems++ }
  const ok = (msg: string) => console.log(`  ✓ ${msg}`)

  if (!fs.existsSync(webSrc)) {
    console.error(`TRM web src introuvable: ${webSrc}\nUtiliser --web <chemin absolu vers TRM/apps/web/src>`)
    process.exitCode = 1
    return
  }

  console.log(`web: ${webSrc}`)
  console.log(`permission-keys-trm.ts: ${TRM_PERMISSION_KEYS.length} clé(s)\n`)

  // ── 1. Every key the web names must be in the catalog ──
  const used = new Map<string, string[]>() // key → files
  for (const file of sourceFiles(webSrc)) {
    const text = fs.readFileSync(file, 'utf8')
    const rel = path.relative(webSrc, file).split(path.sep).join('/')
    for (const re of [USE_RE, NAV_RE]) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        // Screen-access keys live on the other axis and are read through
        // hasRaw(); they are validated by check-screen-access-trm.ts.
        if (m[1].startsWith('screen_') || m[1].startsWith('hide_')) continue
        const list = used.get(m[1]) ?? []
        if (!list.includes(rel)) list.push(rel)
        used.set(m[1], list)
      }
    }
  }

  console.log(`1. Clés utilisées par le web (${used.size})`)
  for (const [key, files] of [...used].sort()) {
    if (isKnownTrmPermissionKey(key)) ok(`${key} — ${files.join(', ')}`)
    else fail(`${key} est utilisé par ${files.join(', ')} mais absent de TRM_PERMISSION_KEYS — le bouton est invisible pour tout non-admin et aucun admin ne peut l'accorder`)
  }

  // ── 2. Catalog entries nothing consumes (informational) ──
  // Widget keys are read by the dashboard registry, not by useHasPermission,
  // so they are expected here — the list is a hint, never a failure.
  console.log('\n2. Clés du catalogue qu\'aucun useHasPermission ne nomme (informatif)')
  const orphans = TRM_PERMISSION_KEYS.filter((k) => !used.has(k.key) && !k.key.startsWith('dashboard_'))
  if (orphans.length === 0) ok('aucune')
  else for (const k of orphans) console.log(`  · ${k.key} (${k.category}) — gardée côté API seulement ?`)

  // ── 3. Every catalog entry is well-formed ──
  //
  // Widened view of the `as const` catalog. Read through TRM_PERMISSION_KEYS
  // directly, `!k.label` narrows the entry to `never` (every label is a
  // non-empty string LITERAL, so the falsy branch is statically unreachable)
  // and the checks below stop compiling. The runtime check still earns its
  // keep: the catalog is also the wire payload of GET /permissions-trm/keys.
  console.log('\n3. Forme du catalogue')
  interface CatalogEntry { key: string; label: string; description: string; category: string; parent?: string }
  const catalog: readonly CatalogEntry[] = TRM_PERMISSION_KEYS
  const seen = new Set<string>()
  for (const k of catalog) {
    if (seen.has(k.key)) fail(`clé dupliquée: ${k.key}`)
    seen.add(k.key)
    if (!k.label || !k.description || !k.category) fail(`${k.key}: label / description / category manquant`)
    if (k.parent && !isKnownTrmPermissionKey(k.parent)) {
      fail(`${k.key}: parent inconnu « ${k.parent} »`)
    }
  }
  if (problems === 0) ok(`${TRM_PERMISSION_KEYS.length} clé(s) bien formée(s)`)

  console.log(problems === 0 ? '\nOK' : `\n${problems} problème(s)`)
  process.exitCode = problems === 0 ? 0 : 1
}

main()
