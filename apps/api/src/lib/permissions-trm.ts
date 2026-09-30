// Per-user TRM permissions — action keys (permission-keys-trm.ts) and
// screen-access keys (screen-keys-trm.ts) — stored in the PostgreSQL table
// `permission` with app = 'trm' (lib/permission-store.ts). Was
// data/permissions-trm.json until 2026-09-30.
//
// Kept apart from ETM's keys by the `app` column, on purpose: both apps'
// admin screens save a user's grants by replacing the whole set filtered to
// their own catalog, so one shared set would have ETM's Paramètres screen
// silently strip every TRM grant on save (and vice-versa).

import { isKnownTrmPermissionKey, type TrmPermissionKey } from './permission-keys-trm.js'
import { isTrmScreenAccessKey, trmMenuAccessKey, trmScreenHideKey } from './screen-keys-trm.js'
import { createPermissionStore } from './permission-store.js'

/** Storable = in the TRM action catalog OR a valid TRM screen-access key. */
function isStorableTrmKey(k: string): boolean {
  return isKnownTrmPermissionKey(k) || isTrmScreenAccessKey(k)
}

const store = createPermissionStore('trm', isStorableTrmKey)

export async function getTrmUserPermissions(userId: number): Promise<string[]> {
  return store.get(userId)
}

/** Overwrite a user's TRM permission list. Unstorable keys dropped. Empty
 *  array clears all grants for the user. */
export async function setTrmUserPermissions(userId: number, keys: readonly string[]): Promise<void> {
  await store.set(userId, keys)
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

/** Whether a user holds the grant of a TRM menu (`screen_<menu>`). Admins
 *  always pass. A menu grant is a UI curtain everywhere EXCEPT where a route
 *  deliberately makes it its guard — the Pointage menu (routes/pointage-admin.ts,
 *  LIVA #1196), where having the menu means having all of it. */
export async function trmUserHasMenu(
  userId: number,
  isAdmin: boolean,
  menuHref: string,
): Promise<boolean> {
  if (isAdmin) return true
  const granted = await getTrmUserPermissions(userId)
  return granted.includes(trmMenuAccessKey(menuHref))
}

/** Whether a user may open a TRM screen: holds its menu's grant and not its
 *  hide key. Admins always pass. Same exception as trmUserHasMenu, one level
 *  down — Paramètres › Outils (routes/import-sage.ts). */
export async function trmUserCanOpenScreen(
  userId: number,
  isAdmin: boolean,
  menuHref: string,
  screenHref: string,
): Promise<boolean> {
  if (isAdmin) return true
  const granted = new Set(await getTrmUserPermissions(userId))
  return granted.has(trmMenuAccessKey(menuHref)) && !granted.has(trmScreenHideKey(screenHref))
}

/** Read all stored TRM permissions (used by the admin /users endpoint). */
export async function getAllTrmPermissions(): Promise<Record<number, string[]>> {
  return store.all()
}
