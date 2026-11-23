// Per-user Expe permissions: action keys (permission-keys-expe.ts) and
// screen-access keys (screen-keys-expe.ts), stored in the PostgreSQL table
// `permission` with app = 'expe' (lib/permission-store.ts, migration
// 0084_app_expe). Mirror of lib/permissions-trm.ts.
//
// Kept apart from the ERPs' keys by the `app` column, on purpose: each admin
// screen saves a user's grants by replacing the whole set filtered to its own
// catalog, so one shared set would let one app strip another's grants on save.

import { isKnownExpePermissionKey, type ExpePermissionKey } from './permission-keys-expe.js'
import { expeMenuAccessKey, expeScreenHideKey, isExpeScreenAccessKey } from './screen-keys-expe.js'
import { createPermissionStore } from './permission-store.js'

/** Storable = in the Expe action catalog OR a valid Expe screen-access key. */
export function isStorableExpeKey(k: string): boolean {
  return isKnownExpePermissionKey(k) || isExpeScreenAccessKey(k)
}

const store = createPermissionStore('expe', isStorableExpeKey)

export async function getExpeUserPermissions(userId: number): Promise<string[]> {
  return store.get(userId)
}

/** Overwrite a user's Expe permission list. Unstorable keys dropped. An empty
 *  array clears every grant of the user. */
export async function setExpeUserPermissions(userId: number, keys: readonly string[]): Promise<void> {
  await store.set(userId, keys)
}

/** Whether a user may perform a gated Expe action. Admins always pass. */
export async function expeUserHasPermission(
  userId: number,
  isAdmin: boolean,
  key: ExpePermissionKey,
): Promise<boolean> {
  if (isAdmin) return true
  const granted = await getExpeUserPermissions(userId)
  return granted.includes(key)
}

/** Whether a user may open an Expe screen: holds its menu's grant and not its
 *  hide key. Admins always pass. A UI curtain, unless a route deliberately
 *  makes it its guard. */
export async function expeUserCanOpenScreen(
  userId: number,
  isAdmin: boolean,
  menuHref: string,
  screenHref: string,
): Promise<boolean> {
  if (isAdmin) return true
  const granted = new Set(await getExpeUserPermissions(userId))
  return granted.has(expeMenuAccessKey(menuHref)) && !granted.has(expeScreenHideKey(screenHref))
}

/** Read all stored Expe permissions (used by the admin /users endpoint). */
export async function getAllExpePermissions(): Promise<Record<number, string[]>> {
  return store.all()
}
