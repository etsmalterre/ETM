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

/** Message ids matching a Gmail search, newest first (at most `max`). */
export async function listerMessages(mailbox: string, q: string, max = 50): Promise<string[]> {
  const r = await client(mailbox).users.messages.list({ userId: 'me', q, maxResults: max })
  return (r.data.messages ?? []).map((m) => m.id!).filter(Boolean)
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

export async function lirePieceJointe(mailbox: string, messageId: string, attachmentId: string): Promise<Buffer> {
  const r = await client(mailbox).users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId })
  return Buffer.from(r.data.data ?? '', 'base64url')
}

const libelles = new Map<string, string>()

/** Id of a user label, created on first use. */
export async function assurerLibelle(mailbox: string, nom: string): Promise<string> {
  const k = `${mailbox}|${nom}`
  const cached = libelles.get(k)
  if (cached) return cached
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
