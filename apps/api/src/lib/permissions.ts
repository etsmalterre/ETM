// Per-user ETM permissions — action keys and screen-access keys — stored in
// the PostgreSQL table `permission` (app = 'etm') through lib/permission-store.ts.
// Was data/permissions.json until 2026-09-30.

import { isKnownPermissionKey, type PermissionKey } from './permission-keys.js'
import { isScreenAccessKey, menuAccessKey, screenHideKey } from './screen-keys.js'
import { createPermissionStore } from './permission-store.js'

/** A key as stored: either an action key from the catalog, or a screen-access
 *  key (menu grant / screen hide — see screen-keys.ts). Both live flat in the
 *  same per-user set. */
export type StoredKey = string

/** Storable = in the action catalog OR a valid screen-access key. */
function isStorableKey(k: string): boolean {
  return isKnownPermissionKey(k) || isScreenAccessKey(k)
}

const store = createPermissionStore('etm', isStorableKey)

/** Returns the list of permission keys granted to a user (empty if none).
 *  Does NOT apply the admin bypass — call userHasPermission for that. */
export async function getUserPermissions(userId: number): Promise<StoredKey[]> {
  return store.get(userId)
}

/** Overwrite a user's permission list. Keys neither in the action catalog nor
 *  valid screen-access keys are dropped. Empty array clears the user. */
export async function setUserPermissions(userId: number, keys: readonly StoredKey[]): Promise<void> {
  await store.set(userId, keys)
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

/** Whether a user may open a screen: holds its menu's grant (`screen_<menu>`)
 *  and not its hide key. Admins always pass. The Écrans axis is a UI curtain
 *  everywhere EXCEPT a route that deliberately makes it its guard — Paramètres
 *  › Outils (routes/import-sage.ts), where seeing the screen is the right. */
export async function userCanOpenScreen(
  userId: number,
  isAdmin: boolean,
  menuHref: string,
  screenHref: string,
): Promise<boolean> {
  if (isAdmin) return true
  const granted = new Set(await getUserPermissions(userId))
  return granted.has(menuAccessKey(menuHref)) && !granted.has(screenHideKey(screenHref))
}

/** Read all stored permissions (used by the admin /users endpoint). */
export async function getAllPermissions(): Promise<Record<number, StoredKey[]>> {
  return store.all()
}
