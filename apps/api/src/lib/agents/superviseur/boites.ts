// Agent « Superviseur » — READ-ONLY access to the factory mailboxes.
//
// ⚠️ Scope `gmail.readonly`, own client cache — never the `gmail.modify`
// client of lib/gmail-reader.ts (BL Ennoblisseur's, which labels mail). The
// Superviseur reads people's own mailboxes; the token it holds must not be
// able to change them. Needs gmail.readonly authorised for the service
// account's client ID in Google Admin (Sécurité › Contrôle des API ›
// Délégation au niveau du domaine); without it every call answers
// `unauthorized_client`, turned into a readable message by boiteErreur().

import * as fs from 'node:fs'
import { google, type gmail_v1 } from 'googleapis'

type JwtClient = InstanceType<typeof google.auth.JWT>

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly']
const clients = new Map<string, JwtClient>()

function client(boite: string): gmail_v1.Gmail {
  let auth = clients.get(boite)
  if (!auth) {
    const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE
    if (!keyPath) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_FILE is not set')
    const key = JSON.parse(fs.readFileSync(keyPath, 'utf8')) as { client_email: string; private_key: string }
    auth = new google.auth.JWT({ email: key.client_email, key: key.private_key, scopes: SCOPES, subject: boite })
    clients.set(boite, auth)
  }
  return google.gmail({ version: 'v1', auth })
}

/** A readable French message for the errors an admin can fix. */
export function boiteErreur(boite: string, err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/unauthorized_client|insufficient|scope/i.test(msg)) {
    return `Lecture de ${boite} refusée : ajouter le droit « gmail.readonly » au compte de service dans Google Admin (délégation au niveau du domaine).`
  }
  if (/invalid_grant|not found|Invalid email/i.test(msg)) return `Boîte ${boite} introuvable dans Google Workspace.`
  return `${boite} : ${msg}`
}

export async function profil(boite: string): Promise<{ email: string; messages: number; fils: number }> {
  const r = await client(boite).users.getProfile({ userId: 'me' })
  return { email: r.data.emailAddress ?? boite, messages: r.data.messagesTotal ?? 0, fils: r.data.threadsTotal ?? 0 }
}

/** Thread ids matching a Gmail search, newest first (at most `max`, paged). */
export async function listerFils(boite: string, q: string, max = 200): Promise<string[]> {
  const out: string[] = []
  let pageToken: string | undefined
  do {
    const r = await client(boite).users.threads.list({ userId: 'me', q, maxResults: Math.min(100, max - out.length), pageToken })
    for (const t of r.data.threads ?? []) if (t.id) out.push(t.id)
    pageToken = r.data.nextPageToken ?? undefined
  } while (pageToken && out.length < max)
  return out
}

export interface MessageFil {
  id: string
  de: string
  a: string
  cc: string
  sujet: string
  /** ISO, from internalDate. */
  date: string
  /** Sent from this mailbox (Gmail SENT label). */
  envoye: boolean
  /** Plain text of the body (text/plain part, else stripped text/html), truncated. */
  texte: string
  piecesJointes: Array<{ nom: string; mimeType: string; attachmentId: string; taille: number }>
}

function b64(s: string | null | undefined): string {
  return s ? Buffer.from(s, 'base64url').toString('utf8') : ''
}

function htmlVersTexte(html: string): string {
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

function parcourir(part: gmail_v1.Schema$MessagePart | undefined, acc: { plain: string; html: string; pjs: MessageFil['piecesJointes'] }): void {
  if (!part) return
  if (part.filename && part.body?.attachmentId) {
    acc.pjs.push({ nom: part.filename, mimeType: part.mimeType ?? 'application/octet-stream', attachmentId: part.body.attachmentId, taille: part.body.size ?? 0 })
  } else if (part.mimeType === 'text/plain' && !acc.plain) acc.plain = b64(part.body?.data)
  else if (part.mimeType === 'text/html' && !acc.html) acc.html = b64(part.body?.data)
  for (const p of part.parts ?? []) parcourir(p, acc)
}

/** Every message of a thread, oldest first. `maxTexte` truncates each body. */
export async function lireFil(boite: string, threadId: string, maxTexte = 4000): Promise<MessageFil[]> {
  const r = await client(boite).users.threads.get({ userId: 'me', id: threadId, format: 'full' })
  return (r.data.messages ?? []).map((m) => {
    const headers = m.payload?.headers ?? []
    const h = (n: string) => headers.find((x) => x.name?.toLowerCase() === n)?.value ?? ''
    const acc = { plain: '', html: '', pjs: [] as MessageFil['piecesJointes'] }
    parcourir(m.payload, acc)
    const texte = (acc.plain || htmlVersTexte(acc.html)).trim()
    return {
      id: m.id ?? '',
      de: h('from'),
      a: h('to'),
      cc: h('cc'),
      sujet: h('subject'),
      date: new Date(Number(m.internalDate ?? 0)).toISOString(),
      envoye: (m.labelIds ?? []).includes('SENT'),
      texte: texte.length > maxTexte ? `${texte.slice(0, maxTexte)}…` : texte,
      piecesJointes: acc.pjs,
    }
  })
}

/** One full message: body text (not truncated) and attachments. */
export async function lireMessage(boite: string, id: string): Promise<{ texte: string; piecesJointes: MessageFil['piecesJointes'] }> {
  const r = await client(boite).users.messages.get({ userId: 'me', id, format: 'full' })
  const acc = { plain: '', html: '', pjs: [] as MessageFil['piecesJointes'] }
  parcourir(r.data.payload, acc)
  return { texte: (acc.plain || htmlVersTexte(acc.html)).trim(), piecesJointes: acc.pjs }
}

/** Message ids matching a Gmail search, newest first (at most `max`, paged). */
export async function listerMessages(boite: string, q: string, max = 5000): Promise<string[]> {
  const out: string[] = []
  let pageToken: string | undefined
  do {
    const r = await client(boite).users.messages.list({ userId: 'me', q, maxResults: Math.min(500, max - out.length), pageToken })
    for (const m of r.data.messages ?? []) if (m.id) out.push(m.id)
    pageToken = r.data.nextPageToken ?? undefined
  } while (pageToken && out.length < max)
  return out
}

/** Headers only — enough to know who wrote to whom and what answers what. */
export interface EnteteMessage {
  boite: string
  id: string
  threadId: string
  /** RFC 5322 Message-ID, without angle brackets, lowercased. */
  messageId: string
  inReplyTo: string
  references: string[]
  /** Sender address, lowercased. */
  de: string
  deNom: string
  a: string[]
  cc: string[]
  sujet: string
  /** ms, from internalDate. */
  date: number
  envoye: boolean
  /** List-Unsubscribe / Auto-Submitted / Precedence bulk — a machine wrote it. */
  automatique: boolean
}

const ENTETES = ['From', 'To', 'Cc', 'Subject', 'Message-ID', 'In-Reply-To', 'References', 'List-Unsubscribe', 'Auto-Submitted', 'Precedence']

const ids = (v: string) => (v.match(/<[^>]+>/g) ?? []).map((x) => x.slice(1, -1).trim().toLowerCase())
export function adresses(v: string): string[] {
  return (v.match(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []).map((x) => x.toLowerCase())
}

export async function lireEntete(boite: string, id: string): Promise<EnteteMessage> {
  const r = await client(boite).users.messages.get({ userId: 'me', id, format: 'metadata', metadataHeaders: ENTETES })
  const headers = r.data.payload?.headers ?? []
  const h = (n: string) => headers.find((x) => x.name?.toLowerCase() === n.toLowerCase())?.value ?? ''
  const from = h('From')
  return {
    boite,
    id,
    threadId: r.data.threadId ?? '',
    messageId: ids(h('Message-ID'))[0] ?? '',
    inReplyTo: ids(h('In-Reply-To'))[0] ?? '',
    references: ids(h('References')),
    de: adresses(from)[0] ?? '',
    deNom: from.replace(/<[^>]*>/, '').replace(/"/g, '').trim(),
    a: adresses(h('To')),
    cc: adresses(h('Cc')),
    sujet: h('Subject'),
    date: Number(r.data.internalDate ?? 0),
    envoye: (r.data.labelIds ?? []).includes('SENT'),
    automatique: !!h('List-Unsubscribe') || /auto-(generated|replied)/i.test(h('Auto-Submitted')) || /bulk|list|junk/i.test(h('Precedence')),
  }
}

/** Every message of a mailbox since `depuisMs` (received AND sent), headers only.
 *  Chats, spam and trash excluded. `parallele` concurrent gets. */
export async function collecterEntetes(boite: string, depuisMs: number, parallele = 8): Promise<EnteteMessage[]> {
  const q = `after:${Math.floor(depuisMs / 1000)} -in:chats -in:spam -in:trash`
  const idsMsg = await listerMessages(boite, q)
  const out: EnteteMessage[] = []
  let i = 0
  const worker = async () => {
    while (i < idsMsg.length) {
      const id = idsMsg[i++]
      try {
        out.push(await lireEntete(boite, id))
      } catch (err) {
        // Deleted between the list and the get (a busy mailbox): skip it.
        if ((err as { code?: number }).code === 404 || /not found/i.test(String((err as Error)?.message))) continue
        throw err
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallele, idsMsg.length) }, worker))
  return out.sort((x, y) => x.date - y.date)
}

export async function lirePieceJointe(boite: string, messageId: string, attachmentId: string): Promise<Buffer> {
  const r = await client(boite).users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId })
  return Buffer.from(r.data.data ?? '', 'base64url')
}
