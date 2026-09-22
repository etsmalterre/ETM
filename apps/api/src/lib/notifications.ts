// JSON-file-backed per-user email-notification subscription store.
//
// ⚠️ TODO migration (after the data migration phase is complete):
// Replace this JSON file backend with a real database table, like permissions.
// The public API of this module is storage-agnostic so the swap should only
// touch the internals of this file.
//
// Mirrors lib/permissions.ts structure, with one deliberate difference: there
// is NO admin bypass. Subscriptions are opt-in — see notification-keys.ts.
//
// One store per app, like the permissions: ETM's (data/notifications.json,
// catalog lib/notification-keys.ts) and TRM's (data/notifications-trm.json,
// catalog lib/notification-keys-trm.ts), built by the same factory so the two
// can never drift. The module-level exports below are ETM's store.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isKnownNotificationKey, type NotificationKey } from './notification-keys.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_DIR = path.resolve(__dirname, '../../data')

interface NotificationsFile<K extends string> {
  version: 1
  /** keyed by IDutilisateur as a string (JSON object keys must be strings) */
  users: Record<string, K[]>
}

export interface NotificationStore<K extends string> {
  /** The notification keys a user is subscribed to (empty if none). */
  getUserNotifications(userId: number): Promise<K[]>
  /** Overwrite a user's subscription list; unknown keys are dropped, duplicates
   *  collapsed. Empty array unsubscribes the user from everything. */
  setUserNotifications(userId: number, keys: readonly K[]): Promise<void>
  /** Every stored subscription (used by the admin /users endpoint). */
  getAllNotifications(): Promise<Record<number, K[]>>
  /** IDutilisateur of every user subscribed to a key. */
  subscribersOf(key: K): Promise<number[]>
}

export function createNotificationStore<K extends string>(
  fileName: string,
  isKnown: (k: string) => k is K,
): NotificationStore<K> {
  const filePath = path.join(DATA_DIR, fileName)
  let cache: NotificationsFile<K> | null = null

  /** Load the file from disk, starting empty if it is missing. Cached in
   *  memory; subsequent reads are O(1). */
  async function load(): Promise<NotificationsFile<K>> {
    if (cache !== null) return cache
    try {
      const raw = await fs.readFile(filePath, 'utf8')
      const parsed = JSON.parse(raw) as NotificationsFile<K>
      if (typeof parsed !== 'object' || parsed === null || parsed.version !== 1 || typeof parsed.users !== 'object') {
        throw new Error(`${fileName}: invalid shape`)
      }
      cache = parsed
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== 'ENOENT') console.error(`Failed to load ${fileName}:`, err)
      // First boot (file doesn't exist yet) or unreadable file: start empty.
      cache = { version: 1, users: {} }
    }
    return cache
  }

  /** Persist atomically (write to .tmp, rename). */
  async function save(file: NotificationsFile<K>): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true })
    const tmp = `${filePath}.tmp`
    await fs.writeFile(tmp, JSON.stringify(file, null, 2), 'utf8')
    await fs.rename(tmp, filePath)
    cache = file
  }

  return {
    async getUserNotifications(userId) {
      const list = (await load()).users[String(userId)]
      return list ? [...list] : []
    },
    async setUserNotifications(userId, keys) {
      const cleaned = [...new Set(keys.filter((k) => isKnown(k)))]
      const file = await load()
      await save({ ...file, users: { ...file.users, [String(userId)]: cleaned } })
    },
    async getAllNotifications() {
      const out: Record<number, K[]> = {}
      for (const [k, v] of Object.entries((await load()).users)) {
        const id = Number(k)
        if (Number.isFinite(id)) out[id] = [...v]
      }
      return out
    },
    async subscribersOf(key) {
      const out: number[] = []
      for (const [k, v] of Object.entries((await load()).users)) {
        const id = Number(k)
        if (Number.isFinite(id) && v.includes(key)) out.push(id)
      }
      return out
    },
  }
}

// ── ETM's store ──────────────────────────────────────────

const etmStore = createNotificationStore<NotificationKey>('notifications.json', isKnownNotificationKey)

export const getUserNotifications = etmStore.getUserNotifications
export const setUserNotifications = etmStore.setUserNotifications
export const getAllNotifications = etmStore.getAllNotifications
export const subscribersOf = etmStore.subscribersOf
