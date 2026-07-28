// JSON-file-backed per-user profile store (email-signature fields + photo
// metadata) with module-load cache. Photos themselves live on disk under
// data/user-photos/<IDutilisateur>.<ext> — only { ext, updatedAt } goes in
// the JSON file, so the store stays small enough to rewrite atomically.
//
// Signatures are structured fields rendered through lib/signature-template.ts.
// Entries written before that switch may still carry a legacy `signatureHtml`
// blob (pasted Gmail/Outlook HTML) — it keeps working for sends/previews
// until fields are saved for that user, which supersedes it.
//
// ⚠️ TODO migration (after the data migration phase is complete):
// Replace this JSON file backend with real database storage. The public API
// of this module is storage-agnostic so the swap should only touch the
// internals of this file.
//
// Mirrors lib/user-emails.ts structure.

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAllUserEmails } from './user-emails.js'
import { getDefaultSignatureFields } from './signature-defaults.js'
import {
  hasSignatureContent,
  renderSignatureHtml,
  signatureLogoInlineImage,
  SIGNATURE_LOGO_CID,
  type SignatureFields,
  type InlineImage,
} from './signature-template.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const DATA_DIR = path.resolve(__dirname, '../../data')
const FILE_PATH = path.join(DATA_DIR, 'user-profiles.json')
const PHOTOS_DIR = path.join(DATA_DIR, 'user-photos')

export type PhotoExt = 'jpg' | 'png' | 'webp' | 'gif'

interface UserProfileEntry {
  /** Structured signature fields (current format) */
  signature?: SignatureFields
  /** Legacy pasted HTML — honored only while no structured fields exist */
  signatureHtml?: string
  photo?: { ext: PhotoExt; updatedAt: number }
}

interface UserProfilesFile {
  version: 1
  /** keyed by IDutilisateur as a string (JSON object keys must be strings) */
  users: Record<string, UserProfileEntry>
}

export interface UserProfile {
  signature: SignatureFields | null
  /** Legacy pasted HTML, present only when no structured fields are stored */
  legacySignatureHtml: string | null
  photo: { ext: PhotoExt; updatedAt: number } | null
}

const EMPTY: UserProfilesFile = { version: 1, users: {} }

let cache: UserProfilesFile | null = null

/** Load the user-profiles file from disk, creating an empty one if missing.
 *  Result is cached in memory; subsequent reads are O(1). */
async function loadUserProfiles(): Promise<UserProfilesFile> {
  if (cache !== null) return cache
  try {
    const raw = await fs.readFile(FILE_PATH, 'utf8')
    const parsed = JSON.parse(raw) as UserProfilesFile
    if (typeof parsed !== 'object' || parsed === null || parsed.version !== 1 || typeof parsed.users !== 'object') {
      throw new Error('user-profiles.json: invalid shape')
    }
    cache = parsed
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') {
      cache = { version: 1, users: {} }
    } else {
      console.error('Failed to load user-profiles.json:', err)
      cache = { ...EMPTY }
    }
  }
  return cache
}

/** Persist the user-profiles file to disk, atomically (write to .tmp, rename). */
async function saveUserProfiles(file: UserProfilesFile): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true })
  const tmp = `${FILE_PATH}.tmp`
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), 'utf8')
  await fs.rename(tmp, FILE_PATH)
  cache = file
}

function normalizeFields(f: SignatureFields | undefined): SignatureFields | null {
  if (!f) return null
  const clean: SignatureFields = {
    displayName: (f.displayName ?? '').trim(),
    fonction: (f.fonction ?? '').trim(),
    telFixe: (f.telFixe ?? '').trim(),
    email: (f.email ?? '').trim(),
  }
  return hasSignatureContent(clean) ? clean : null
}

function normalizeEntry(entry: UserProfileEntry | undefined): UserProfile {
  const signature = normalizeFields(entry?.signature)
  const legacy = entry?.signatureHtml
  return {
    signature,
    legacySignatureHtml: !signature && legacy && legacy.trim() ? legacy : null,
    photo: entry?.photo ?? null,
  }
}

/** Returns the stored profile (signature + photo metadata) for a user. */
export async function getUserProfile(userId: number): Promise<UserProfile> {
  const file = await loadUserProfiles()
  return normalizeEntry(file.users[String(userId)])
}

/** Overwrite a user's signature fields. All-blank fields clear the
 *  signature entirely. Saving fields also drops any legacy pasted HTML —
 *  the structured fields supersede it. */
export async function setUserSignature(userId: number, fields: SignatureFields): Promise<void> {
  const file = await loadUserProfiles()
  const key = String(userId)
  const nextUsers = { ...file.users }
  const entry: UserProfileEntry = { ...nextUsers[key] }
  const clean = normalizeFields(fields)
  delete entry.signatureHtml
  if (clean) {
    entry.signature = clean
  } else {
    delete entry.signature
  }
  if (entry.signature === undefined && entry.photo === undefined) {
    delete nextUsers[key]
  } else {
    nextUsers[key] = entry
  }
  await saveUserProfiles({ ...file, users: nextUsers })
}

/** Store a user's photo on disk and record its metadata. Replaces any
 *  previous photo (deleting the old file when the extension changed). */
export async function setUserPhoto(
  userId: number,
  buffer: Buffer,
  ext: PhotoExt,
): Promise<{ updatedAt: number }> {
  const file = await loadUserProfiles()
  const key = String(userId)
  const previous = file.users[key]?.photo

  await fs.mkdir(PHOTOS_DIR, { recursive: true })
  await fs.writeFile(path.join(PHOTOS_DIR, `${userId}.${ext}`), buffer)
  if (previous && previous.ext !== ext) {
    await fs.unlink(path.join(PHOTOS_DIR, `${userId}.${previous.ext}`)).catch(() => {})
  }

  const updatedAt = Date.now()
  const nextUsers = { ...file.users }
  nextUsers[key] = { ...nextUsers[key], photo: { ext, updatedAt } }
  await saveUserProfiles({ ...file, users: nextUsers })
  return { updatedAt }
}

/** Delete a user's photo (file + metadata). No-op when none exists. */
export async function clearUserPhoto(userId: number): Promise<void> {
  const file = await loadUserProfiles()
  const key = String(userId)
  const previous = file.users[key]?.photo
  if (previous) {
    await fs.unlink(path.join(PHOTOS_DIR, `${userId}.${previous.ext}`)).catch(() => {})
  }
  const nextUsers = { ...file.users }
  const entry: UserProfileEntry = { ...nextUsers[key] }
  delete entry.photo
  if (entry.signature === undefined && entry.signatureHtml === undefined) {
    delete nextUsers[key]
  } else {
    nextUsers[key] = entry
  }
  await saveUserProfiles({ ...file, users: nextUsers })
}

/** Absolute path + metadata of a user's photo file, or null when none. */
export async function getUserPhotoPath(
  userId: number,
): Promise<{ path: string; ext: PhotoExt; updatedAt: number } | null> {
  const profile = await getUserProfile(userId)
  if (!profile.photo) return null
  return {
    path: path.join(PHOTOS_DIR, `${userId}.${profile.photo.ext}`),
    ext: profile.photo.ext,
    updatedAt: profile.photo.updatedAt,
  }
}

/** Read all stored profiles (used by the admin /users endpoint). */
export async function getAllUserProfiles(): Promise<Record<number, UserProfile>> {
  const file = await loadUserProfiles()
  const out: Record<number, UserProfile> = {}
  for (const [k, entry] of Object.entries(file.users)) {
    const id = Number(k)
    if (Number.isFinite(id)) out[id] = normalizeEntry(entry)
  }
  return out
}

export interface EffectiveSignature {
  /** Rendered template fields — null when the signature is legacy pasted HTML. */
  fields: SignatureFields | null
  /** Legacy pasted HTML, when that is what the user has. */
  legacyHtml: string | null
  /** True when nothing was stored for this user and the fields were derived
   *  from their identity (see lib/signature-defaults.ts). */
  isDefault: boolean
}

/** The signature that actually goes out for a user, in precedence order:
 *  stored fields → legacy pasted HTML → fields derived from their identity.
 *  Returns null only when even the derived fallback has nothing to say
 *  (no name on the utilisateur row and no email address configured). */
export async function getEffectiveSignature(userId: number): Promise<EffectiveSignature | null> {
  const profile = await getUserProfile(userId)
  if (profile.signature) return { fields: profile.signature, legacyHtml: null, isDefault: false }
  if (profile.legacySignatureHtml) return { fields: null, legacyHtml: profile.legacySignatureHtml, isDefault: false }
  const fallback = await getDefaultSignatureFields(userId)
  if (!fallback) return null
  return { fields: fallback, legacyHtml: null, isDefault: true }
}

export interface ResolvedSignature {
  html: string
  /** Images referenced from `html` via cid: — embedded by gmail.ts as a
   *  multipart/related section. Empty for legacy pasted-HTML signatures. */
  inlineImages: InlineImage[]
}

/** Reverse lookup: the signature of the user whose stored email address
 *  matches `email` (case-insensitive), or null. Used by lib/gmail.ts to
 *  append the sender's signature without touching any send call site.
 *  Structured fields render through the company template with the logo as
 *  an inline cid: image; legacy pasted HTML is passed through as-is. */
export async function getSignatureForEmail(email: string): Promise<ResolvedSignature | null> {
  const target = email.trim().toLowerCase()
  if (!target) return null
  const allEmails = await getAllUserEmails()
  for (const [idStr, addr] of Object.entries(allEmails)) {
    if (addr.trim().toLowerCase() === target) {
      const effective = await getEffectiveSignature(Number(idStr))
      if (!effective) return null
      if (effective.fields) {
        return {
          html: renderSignatureHtml(effective.fields, `cid:${SIGNATURE_LOGO_CID}`),
          inlineImages: [signatureLogoInlineImage()],
        }
      }
      return { html: effective.legacyHtml ?? '', inlineImages: [] }
    }
  }
  return null
}
