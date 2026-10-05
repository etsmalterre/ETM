// Gmail READ side — list a mailbox, fetch messages and their attachments, and
// label them. Same service account + domain-wide delegation as lib/gmail.ts
// (send), but a separate scope and client cache.
//
// ⚠️ Needs https://www.googleapis.com/auth/gmail.modify authorised for the
// service account's client ID in Google Admin (Sécurité › Contrôle des API ›
// Délégation au niveau du domaine) — next to the gmail.send it already has.
// Without it every call answers `unauthorized_client`, which gmailLectureErreur()
// turns into a readable message for the Agents IA screen.
//
// Used by the « Agents IA » (lib/agents/*) — first reader: BL Ennoblisseur, mailbox
// contact@etsmalterre.com (the one n8n polled).

import * as fs from 'node:fs'
import { google, type gmail_v1 } from 'googleapis'

type JwtClient = InstanceType<typeof google.auth.JWT>

const SCOPES = ['https://www.googleapis.com/auth/gmail.modify']
const clients = new Map<string, JwtClient>()

function client(mailbox: string): gmail_v1.Gmail {
  let auth = clients.get(mailbox)
  if (!auth) {
    const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE
    if (!keyPath) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_FILE is not set')
    const key = JSON.parse(fs.readFileSync(keyPath, 'utf8')) as { client_email: string; private_key: string }
    auth = new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes: SCOPES, subject: mailbox })
    clients.set(mailbox, auth)
  }
  return google.gmail({ version: 'v1', auth })
}

/** A readable French message for the errors an admin can fix. */
export function gmailLectureErreur(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/unauthorized_client|insufficient|scope/i.test(msg)) {
    return 'Lecture de la boîte mail refusée : ajouter le droit « gmail.modify » au compte de service dans Google Admin (délégation au niveau du domaine).'
  }
  return msg
}

export interface PieceJointeInfo {
  nom: string
  mimeType: string
  attachmentId: string
  taille: number
}

export interface MessageInfo {
  id: string
  threadId: string
  de: string
  sujet: string
  /** ISO date from internalDate (when Gmail received it). */
  date: string
  piecesJointes: PieceJointeInfo[]
}

/** A message with its body and recipients (the Triage reads the whole thread). */
export interface MessageComplet extends MessageInfo {
  a: string
  cc: string
  /** Sent from this mailbox (Gmail SENT label). */
  envoye: boolean
  /** Gmail label ids on the message. */
  libelles: string[]
  /** Plain text of the body (text/plain part, else stripped text/html). */
  texte: string
}

/** Message ids matching a Gmail search, newest first (at most `max`). */
export async function listerMessages(mailbox: string, q: string, max = 50): Promise<string[]> {
  const r = await client(mailbox).users.messages.list({ userId: 'me', q, maxResults: max })
  return (r.data.messages ?? []).map((m) => m.id!).filter(Boolean)
}

const b64 = (s: string | null | undefined): string => (s ? Buffer.from(s, 'base64url').toString('utf8') : '')

/** A mail's HTML body as plain text (also used by the Superviseur's boites.ts). */
export function htmlVersTexte(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim()
}

/** Drop the quoted history a reply carries (it is in the earlier messages). */
export function sansCitation(texte: string): string {
  const out: string[] = []
  for (const l of texte.split(/\r?\n/)) {
    if (/^\s*(Le .{3,120} a écrit\s*:|On .{3,120} wrote\s*:|-{2,}\s*(Original|Message d'origine|Forwarded)|De\s*:\s|From\s*:\s|_{8,})/i.test(l)) break
    if (/^\s*>/.test(l)) continue
    out.push(l)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

function corps(part: gmail_v1.Schema$MessagePart | undefined, acc: { plain: string; html: string }): void {
  if (!part) return
  if (!part.filename && part.mimeType === 'text/plain' && !acc.plain) acc.plain = b64(part.body?.data)
  else if (!part.filename && part.mimeType === 'text/html' && !acc.html) acc.html = b64(part.body?.data)
  for (const p of part.parts ?? []) corps(p, acc)
}

function collecter(part: gmail_v1.Schema$MessagePart | undefined, out: PieceJointeInfo[]): void {
  if (!part) return
  if (part.filename && part.body?.attachmentId) {
    out.push({
      nom: part.filename,
      mimeType: part.mimeType ?? 'application/octet-stream',
      attachmentId: part.body.attachmentId,
      taille: part.body.size ?? 0,
    })
  }
  for (const p of part.parts ?? []) collecter(p, out)
}

export async function lireMessage(mailbox: string, id: string): Promise<MessageInfo> {
  const r = await client(mailbox).users.messages.get({ userId: 'me', id, format: 'full' })
  const headers = r.data.payload?.headers ?? []
  const h = (n: string) => headers.find((x) => x.name?.toLowerCase() === n)?.value ?? ''
  const piecesJointes: PieceJointeInfo[] = []
  collecter(r.data.payload, piecesJointes)
  return {
    id,
    threadId: r.data.threadId ?? '',
    de: h('from'),
    sujet: h('subject'),
    date: new Date(Number(r.data.internalDate ?? 0)).toISOString(),
    piecesJointes,
  }
}

function complet(m: gmail_v1.Schema$Message): MessageComplet {
  const headers = m.payload?.headers ?? []
  const h = (n: string) => headers.find((x) => x.name?.toLowerCase() === n)?.value ?? ''
  const piecesJointes: PieceJointeInfo[] = []
  collecter(m.payload, piecesJointes)
  const acc = { plain: '', html: '' }
  corps(m.payload, acc)
  return {
    id: m.id ?? '',
    threadId: m.threadId ?? '',
    de: h('from'),
    a: h('to'),
    cc: h('cc'),
    sujet: h('subject'),
    date: new Date(Number(m.internalDate ?? 0)).toISOString(),
    envoye: (m.labelIds ?? []).includes('SENT'),
    libelles: m.labelIds ?? [],
    texte: (acc.plain || htmlVersTexte(acc.html)).trim(),
    piecesJointes,
  }
}

/** Every message of a thread with its body, oldest first. */
export async function lireFil(mailbox: string, threadId: string): Promise<MessageComplet[]> {
  const r = await client(mailbox).users.threads.get({ userId: 'me', id: threadId, format: 'full' })
  return (r.data.messages ?? []).map(complet)
}

/** Messages matching a Gmail search, newest first, paged (at most `max`). */
export async function listerTousMessages(mailbox: string, q: string, max = 1000): Promise<Array<{ id: string; threadId: string }>> {
  const out: Array<{ id: string; threadId: string }> = []
  let pageToken: string | undefined
  do {
    const r = await client(mailbox).users.messages.list({ userId: 'me', q, maxResults: Math.min(500, max - out.length), pageToken })
    for (const m of r.data.messages ?? []) if (m.id) out.push({ id: m.id, threadId: m.threadId ?? '' })
    pageToken = r.data.nextPageToken ?? undefined
  } while (pageToken && out.length < max)
  return out
}

export async function lirePieceJointe(mailbox: string, messageId: string, attachmentId: string): Promise<Buffer> {
  const r = await client(mailbox).users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId })
  return Buffer.from(r.data.data ?? '', 'base64url')
}

const libelles = new Map<string, string>()

/** Id of a user label, created on first use. A nested name (« ETM/Transport »)
 *  creates its parents first, so Gmail shows it under them. */
export async function assurerLibelle(mailbox: string, nom: string): Promise<string> {
  const k = `${mailbox}|${nom}`
  const cached = libelles.get(k)
  if (cached) return cached
  if (nom.includes('/')) await assurerLibelle(mailbox, nom.slice(0, nom.lastIndexOf('/')))
  const g = client(mailbox)
  const list = await g.users.labels.list({ userId: 'me' })
  let id = list.data.labels?.find((l) => l.name === nom)?.id ?? null
  if (!id) {
    const created = await g.users.labels.create({
      userId: 'me',
      requestBody: { name: nom, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
    })
    id = created.data.id ?? null
  }
  if (!id) throw new Error(`libellé Gmail « ${nom} » introuvable`)
  libelles.set(k, id)
  return id
}

export async function ajouterLibelle(mailbox: string, messageId: string, labelId: string): Promise<void> {
  await client(mailbox).users.messages.modify({ userId: 'me', id: messageId, requestBody: { addLabelIds: [labelId] } })
}

export async function retirerLibelle(mailbox: string, messageId: string, labelId: string): Promise<void> {
  await client(mailbox).users.messages.modify({ userId: 'me', id: messageId, requestBody: { removeLabelIds: [labelId] } })
}
