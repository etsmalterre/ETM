// JSON-file-backed per-user TRM permissions store with module-load cache.
//
// Same shape and same TODO-migration destiny as lib/permissions.ts, but a
// SEPARATE file (data/permissions-trm.json) on purpose: both apps' admin
// screens save a user's grants by replacing the whole array filtered to
// their own catalog, so a shared file would have ETM's Paramètres screen
// silently strip every TRM grant on save (and vice-versa). Two files, two
// catalogs, zero cross-talk. When the JSON stores move to a real DB table,
// merge the two behind an `app` column.
//
// Unlike ETM's store there is no screen-access axis here (yet) — TRM's
// Écrans tab doesn't exist, so only catalog keys are storable.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isKnownTrmPermissionKey, type TrmPermissionKey } from './permission-keys-trm.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_DIR = path.resolve(__dirname, '../../data')
const FILE_PATH = path.join(DATA_DIR, 'permissions-trm.json')

interface PermissionsFile {
  version: 1
  /** keyed by IDutilisateur as a string (JSON object keys must be strings) */
  users: Record<string, string[]>
}

const EMPTY: PermissionsFile = { version: 1, users: {} }

let cache: PermissionsFile | null = null

/** Load the permissions file from disk, creating an empty one if missing.
 *  Result is cached in memory; subsequent reads are O(1). */
async function loadPermissions(): Promise<PermissionsFile> {
  if (cache !== null) return cache
  try {
    const raw = await fs.readFile(FILE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as PermissionsFile
    if (typeof parsed !== 'object' || parsed === null || parsed.version !== 1 || typeof parsed.users !== 'object') {
      throw new Error('permissions-trm.json: invalid shape')
    }
    cache = parsed
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      // First boot — file doesn't exist yet. Start empty.
      cache = { version: 1, users: {} }
    } else {
      console.error('Failed to load permissions-trm.json:', err)
      cache = { ...EMPTY }
    }
  }
  return cache
}

/** Persist the permissions file to disk, atomically (write to .tmp, rename). */
async function savePermissions(file: PermissionsFile): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true })
  const tmp = `${FILE_PATH}.tmp`
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), 'utf8')
  await fs.rename(tmp, FILE_PATH)
  cache = file
}

/** Returns the list of TRM permission keys granted to a user (empty if none).
 *  Does NOT apply the admin bypass — call trmUserHasPermission for that. */
export async function getTrmUserPermissions(userId: number): Promise<string[]> {
  const file = await loadPermissions()
  const list = file.users[String(userId)]
  return list ? [...list] : []
}

/** Overwrite a user's TRM permission list. Validates that every key is in the
 *  TRM catalog before persisting. Empty array clears all grants for the user. */
export async function setTrmUserPermissions(
  userId: number,
  keys: readonly string[],
): Promise<void> {
  // Defence in depth: drop keys the catalog doesn't know (the route filters too).
  const valid = keys.filter((k) => isKnownTrmPermissionKey(k))
  // Dedupe while preserving order.
  const seen = new Set<string>()
  const cleaned: string[] = []
  for (const k of valid) {
    if (seen.has(k)) continue
    seen.add(k)
    cleaned.push(k)
  }
  const file = await loadPermissions()
  const next: PermissionsFile = {
    ...file,
    users: { ...file.users, [String(userId)]: cleaned },
  }
  await savePermissions(next)
}

/** Check whether a user is allowed to perform a gated TRM action. Admins
 *  always pass — they bypass the stored list entirely. */
export async function trmUserHasPermission(
  userId: number,
  isAdmin: boolean,
  key: TrmPermissionKey,
): Promise<boolean> {
  if (isAdmin) return true
  const granted = await getTrmUserPermissions(userId)
  return granted.includes(key)
}

/** Read all stored TRM permissions (used by the admin /users endpoint). */
export async function getAllTrmPermissions(): Promise<Record<number, string[]>> {
  const file = await loadPermissions()
  const out: Record<number, string[]> = {}
  for (const [k, v] of Object.entries(file.users)) {
    const id = Number(k)
    if (Number.isFinite(id)) out[id] = [...v]
  }
  return out
}
