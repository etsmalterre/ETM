// JSON-file-backed per-user email-notification subscription store.
//
// ⚠️ TODO migration (after the data migration phase is complete):
// Replace this JSON file backend with a real database table, like permissions.
// The public API of this module is storage-agnostic so the swap should only
// touch the internals of this file.
//
// Mirrors lib/permissions.ts structure, with one deliberate difference: there
// is NO admin bypass. Subscriptions are opt-in — see notification-keys.ts.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { isKnownNotificationKey, type NotificationKey } from './notification-keys.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_DIR = path.resolve(__dirname, '../../data')
const FILE_PATH = path.join(DATA_DIR, 'notifications.json')

interface NotificationsFile {
  version: 1
  /** keyed by IDutilisateur as a string (JSON object keys must be strings) */
  users: Record<string, NotificationKey[]>
}

const EMPTY: NotificationsFile = { version: 1, users: {} }

let cache: NotificationsFile | null = null

/** Load the notifications file from disk, creating an empty one if missing.
 *  Result is cached in memory; subsequent reads are O(1). */
async function loadNotifications(): Promise<NotificationsFile> {
  if (cache !== null) return cache
  try {
    const raw = await fs.readFile(FILE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as NotificationsFile
    if (typeof parsed !== 'object' || parsed === null || parsed.version !== 1 || typeof parsed.users !== 'object') {
      throw new Error('notifications.json: invalid shape')
    }
    cache = parsed
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      // First boot — file doesn't exist yet. Start empty.
      cache = { version: 1, users: {} }
    } else {
      console.error('Failed to load notifications.json:', err)
      cache = { ...EMPTY }
    }
  }
  return cache
}

/** Persist the notifications file to disk, atomically (write to .tmp, rename). */
async function saveNotifications(file: NotificationsFile): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true })
  const tmp = `${FILE_PATH}.tmp`
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), 'utf8')
  await fs.rename(tmp, FILE_PATH)
  cache = file
}

/** Returns the notification keys a user is subscribed to (empty if none). */
export async function getUserNotifications(userId: number): Promise<NotificationKey[]> {
  const file = await loadNotifications()
  const list = file.users[String(userId)]
  return list ? [...list] : []
}

/** Overwrite a user's subscription list. Validates that every key is known
 *  before persisting. Empty array unsubscribes the user from everything. */
export async function setUserNotifications(
  userId: number,
  keys: readonly NotificationKey[],
): Promise<void> {
  const valid = keys.filter((k) => isKnownNotificationKey(k))
  const seen = new Set<string>()
  const cleaned: NotificationKey[] = []
  for (const k of valid) {
    if (seen.has(k)) continue
    seen.add(k)
    cleaned.push(k)
  }
  const file = await loadNotifications()
  await saveNotifications({ ...file, users: { ...file.users, [String(userId)]: cleaned } })
}

/** Read all stored subscriptions (used by the admin /users endpoint). */
export async function getAllNotifications(): Promise<Record<number, NotificationKey[]>> {
  const file = await loadNotifications()
  const out: Record<number, NotificationKey[]> = {}
  for (const [k, v] of Object.entries(file.users)) {
    const id = Number(k)
    if (Number.isFinite(id)) out[id] = [...v]
  }
  return out
}

/** IDutilisateur of every user subscribed to a notification key. */
export async function subscribersOf(key: NotificationKey): Promise<number[]> {
  const file = await loadNotifications()
  const out: number[] = []
  for (const [k, v] of Object.entries(file.users)) {
    const id = Number(k)
    if (Number.isFinite(id) && v.includes(key)) out.push(id)
  }
  return out
}
