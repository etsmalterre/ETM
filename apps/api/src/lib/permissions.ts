// JSON-file-backed per-user permissions store with module-load cache.
//
// ⚠️ TODO migration (after the data migration phase is complete):
// Replace this JSON file backend with a real database table — see the
// "Future migration" section at the end of the per-user permissions plan.
// The public API of this module (loadPermissions / getUserPermissions /
// setUserPermissions / userHasPermission) is intentionally storage-agnostic
// so the swap should only touch the internals of this file.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isKnownPermissionKey, type PermissionKey } from './permission-keys.js'
import { isScreenAccessKey } from './screen-keys.js'

/** A key as stored: either an action key from the catalog, or a screen-access
 *  key (menu grant / screen hide — see screen-keys.ts). Both live flat in the
 *  same per-user array. */
export type StoredKey = string

/** Storable = in the action catalog OR a valid screen-access key. */
function isStorableKey(k: string): boolean {
  return isKnownPermissionKey(k) || isScreenAccessKey(k)
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_DIR = path.resolve(__dirname, '../../data')
const FILE_PATH = path.join(DATA_DIR, 'permissions.json')

interface PermissionsFile {
  version: 1
  /** keyed by IDutilisateur as a string (JSON object keys must be strings) */
  users: Record<string, StoredKey[]>
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
      throw new Error('permissions.json: invalid shape')
    }
    cache = parsed
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      // First boot — file doesn't exist yet. Start empty.
      cache = { version: 1, users: {} }
    } else {
      console.error('Failed to load permissions.json:', err)
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

/** Returns the list of permission keys granted to a user (empty if none).
 *  Does NOT apply the admin bypass — call userHasPermission for that. */
export async function getUserPermissions(userId: number): Promise<StoredKey[]> {
  const file = await loadPermissions()
  const list = file.users[String(userId)]
  return list ? [...list] : []
}

/** Overwrite a user's permission list. Validates that every key is known
 *  before persisting. Empty array clears all permissions for the user. */
export async function setUserPermissions(
  userId: number,
  keys: readonly StoredKey[],
): Promise<void> {
  // Defence in depth: filter out any keys that are neither in the action
  // catalog nor a valid screen-access key.
  const valid = keys.filter((k) => isStorableKey(k))
  // Dedupe while preserving order.
  const seen = new Set<string>()
  const cleaned: StoredKey[] = []
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

/** Check whether a user is allowed to perform a gated action. Admins always
 *  pass — they bypass the stored list entirely. */
export async function userHasPermission(
  userId: number,
  isAdmin: boolean,
  key: PermissionKey,
): Promise<boolean> {
  if (isAdmin) return true
  const granted = await getUserPermissions(userId)
  return granted.includes(key)
}

/** Read all stored permissions (used by the admin /users endpoint). */
export async function getAllPermissions(): Promise<Record<number, StoredKey[]>> {
  const file = await loadPermissions()
  const out: Record<number, StoredKey[]> = {}
  for (const [k, v] of Object.entries(file.users)) {
    const id = Number(k)
    if (Number.isFinite(id)) out[id] = [...v]
  }
  return out
}
