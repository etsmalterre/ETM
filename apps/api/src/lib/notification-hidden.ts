// JSON-file-backed per-user store of HIDDEN notifications for the tableau de
// bord "Notifications" widget (the eye button on each card).
//
// ⚠️ Not to be confused with lib/notifications.ts, which stores per-user
// subscriptions to *email* notifications. Different feature, different store:
//   • notifications.ts  → "email me when a coloris is added"
//   • this file         → "stop showing me THIS alert card on my dashboard"
//
// ── Why per user, and why not in HFSQL ──
// Legacy stored the flag on the notification row itself (`notifutilisateur.
// visible = 0`), which is GLOBAL — one person hiding a card hid it for
// everyone. MPS_NG computes the notification list live instead of persisting
// rows (see lib/abonnements.ts), so there is no row to carry the flag, and the
// hiding is scoped to the user who asked for it.
//
// ⚠️ TODO migration (after the data migration phase is complete):
// Replace this JSON file backend with a real database table, like permissions.
// The public API of this module is storage-agnostic so the swap should only
// touch the internals of this file.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_DIR = path.resolve(__dirname, '../../data')
const FILE_PATH = path.join(DATA_DIR, 'notification-hidden.json')

/** Hard cap per user. Hiding is a manual gesture on individual cards, so a
 *  user legitimately has tens of these, not thousands — the cap only stops a
 *  scripted client from growing the file without bound. */
export const MAX_HIDDEN_PER_USER = 2000

interface HiddenFile {
  version: 1
  /** keyed by IDutilisateur as a string (JSON object keys must be strings) */
  users: Record<string, string[]>
}

const EMPTY: HiddenFile = { version: 1, users: {} }

let cache: HiddenFile | null = null

async function loadHidden(): Promise<HiddenFile> {
  if (cache !== null) return cache
  try {
    const raw = await fs.readFile(FILE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as HiddenFile
    if (
      typeof parsed !== 'object' || parsed === null ||
      parsed.version !== 1 || typeof parsed.users !== 'object'
    ) {
      throw new Error('notification-hidden.json: invalid shape')
    }
    cache = parsed
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      // First boot — file doesn't exist yet. Start empty.
      cache = { version: 1, users: {} }
    } else {
      console.error('Failed to load notification-hidden.json:', err)
      cache = { ...EMPTY }
    }
  }
  return cache
}

/** Persist atomically (write to .tmp, rename). */
async function saveHidden(file: HiddenFile): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true })
  const tmp = `${FILE_PATH}.tmp`
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), 'utf8')
  await fs.rename(tmp, FILE_PATH)
  cache = file
}

/** The notification keys this user has hidden (empty when none). */
export async function getUserHidden(userId: number): Promise<string[]> {
  const file = await loadHidden()
  const list = file.users[String(userId)]
  return list ? [...list] : []
}

/** Overwrite a user's hidden set. An empty list drops the entry entirely. */
export async function setUserHidden(userId: number, keys: readonly string[]): Promise<void> {
  const cleaned = Array.from(new Set(keys.map((k) => k.trim()).filter(Boolean)))
    .slice(0, MAX_HIDDEN_PER_USER)
  const file = await loadHidden()
  const nextUsers = { ...file.users }
  if (cleaned.length === 0) {
    delete nextUsers[String(userId)]
  } else {
    nextUsers[String(userId)] = cleaned
  }
  await saveHidden({ ...file, users: nextUsers })
}

/** Hide or re-show one notification. Returns the resulting set. */
export async function toggleUserHidden(
  userId: number,
  key: string,
  hidden: boolean,
): Promise<string[]> {
  const current = new Set(await getUserHidden(userId))
  if (hidden) current.add(key)
  else current.delete(key)
  const next = Array.from(current)
  await setUserHidden(userId, next)
  return next
}
