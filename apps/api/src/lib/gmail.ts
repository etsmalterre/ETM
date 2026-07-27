// Gmail send helper — uses Google domain-wide delegation to impersonate any
// @etsmalterre.com user via a single service account. One caller → one JWT
// client cached per impersonated subject.
//
// Env vars (read lazily — dotenv.config() runs in index.ts, and ESM import
// hoisting means we cannot read process.env at module load time):
//   GOOGLE_SERVICE_ACCOUNT_KEY_FILE — absolute path to the service account
//     JSON key file. The service account must have domain-wide delegation
//     enabled in GCP, AND its client ID must be authorised in the Google
//     Workspace Admin Console for scope
//     https://www.googleapis.com/auth/gmail.send.
//
// Production / dev: drop the JSON file outside the repo (it's gitignored via
// the .env pattern but you should still keep the raw key out of version
// control), and point the env var at it. The service account itself has no
// mailbox — every call must specify the `impersonate` email.

import * as fs from 'node:fs'
import { google } from 'googleapis'
import { getSignatureForEmail } from './user-profiles.js'
import type { InlineImage } from './signature-template.js'

type JwtClient = InstanceType<typeof google.auth.JWT>

const SCOPES = ['https://www.googleapis.com/auth/gmail.send']

/** One JWT client per impersonated user, keyed by email. The JWT itself
 *  caches its access token internally, so re-using the instance avoids a
 *  fresh OAuth round-trip on every send. */
const clientCache = new Map<string, JwtClient>()

interface KeyFile {
  client_email: string
  private_key: string
}

let cachedKeyFile: KeyFile | null = null

function loadKeyFile(): KeyFile {
  if (cachedKeyFile) return cachedKeyFile
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE
  if (!keyPath) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_KEY_FILE env var is not set — cannot send emails via Gmail API',
    )
  }
  const raw = fs.readFileSync(keyPath, 'utf8')
  const parsed = JSON.parse(raw) as KeyFile
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error(
      `Service account key file at ${keyPath} is missing client_email or private_key`,
    )
  }
  cachedKeyFile = parsed
  return parsed
}

function getClientForSubject(impersonate: string): JwtClient {
  const existing = clientCache.get(impersonate)
  if (existing) return existing
  const key = loadKeyFile()
  const client = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: SCOPES,
    subject: impersonate,
  })
  clientCache.set(impersonate, client)
  return client
}

// ── MIME message building ────────────────────────────────

export interface SendMailAttachment {
  filename: string
  content: Buffer
  /** MIME type, e.g. 'application/pdf' */
  contentType: string
}

export interface SendMailOptions {
  /** Email address to impersonate (must be on the delegated domain). */
  from: string
  /** Display name shown next to the From address. Optional. */
  fromName?: string
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  /** Body text. Line breaks are preserved. Supports lightweight `**bold**`
   *  markup: the HTML part renders it as <strong>, the plain-text part
   *  strips the markers. */
  body: string
  /** Pre-rendered HTML for the text/html alternative. When set it replaces the
   *  auto-generated HTML and `body` is used only for the text/plain part — the
   *  two must therefore say the same thing. Used by the branded notification
   *  template; ordinary user-composed mails leave it undefined. */
  bodyHtml?: string
  attachments?: SendMailAttachment[]
  /** Sender's HTML signature, appended after the body in both MIME parts.
   *  When undefined, sendMail() resolves it from the `from` address via the
   *  user-profiles store; pass null to explicitly send without a signature. */
  signatureHtml?: string | null
  /** Images the signature references via `cid:` (e.g. the company logo).
   *  Embedded as a multipart/related section so they display instantly with
   *  no remote fetch. Ignored when the signature is absent. Resolved by
   *  sendMail() together with signatureHtml when both are undefined. */
  inlineImages?: InlineImage[]
}

// ── Body rendering (plain + HTML alternative) ────────────

const BOLD_RE = /\*\*([^*]+)\*\*/g

/** Plain-text part: body with `**bold**` markers stripped. */
function bodyToPlain(body: string): string {
  return body.replace(BOLD_RE, '$1')
}

/** Crude HTML → plain-text conversion for the signature in the text/plain
 *  alternative: block-level closers become newlines, tags are stripped,
 *  common entities decoded, blank lines collapsed. */
export function signatureToPlain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|table|h[1-6]|li)>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** HTML part: escaped body, `**bold**` → <strong>, newlines → <br>. Wrapped
 *  in a minimal styled div so rendering stays close to the plain default. */
function bodyToHtml(body: string): string {
  const html = escapeHtml(body)
    .replace(BOLD_RE, '<strong>$1</strong>')
    .replace(/\r?\n/g, '<br>\r\n')
  return (
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#222222;">' +
    html +
    '</div>'
  )
}

/** Encode a header value using MIME "encoded-word" (RFC 2047) when it
 *  contains any non-ASCII character, so accented names / subjects survive
 *  transport. Simple base64-UTF8 encoding — Gmail renders this natively. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value
  const b64 = Buffer.from(value, 'utf8').toString('base64')
  return `=?UTF-8?B?${b64}?=`
}

function formatFrom(email: string, name?: string): string {
  if (!name) return email
  return `${encodeHeader(name)} <${email}>`
}

/** Base64-encode in 76-char lines (RFC 2045). */
function base64Lines(content: Buffer): string {
  const b64 = content.toString('base64')
  return b64.match(/.{1,76}/g)?.join('\r\n') ?? b64
}

/** Build a RFC 2822 MIME message as a single Buffer. The body is always a
 *  multipart/alternative pair (text/plain + text/html) so `**bold**` markup
 *  renders; signature inline images (cid:) wrap it in multipart/related;
 *  with attachments everything nests inside a multipart/mixed envelope. */
export function buildMimeMessage(opts: SendMailOptions): Buffer {
  const boundary = `----=_MPS_${Date.now()}_${Math.random().toString(36).slice(2)}`
  const altBoundary = `${boundary}_alt`
  const relBoundary = `${boundary}_rel`
  const hasAttachments = (opts.attachments?.length ?? 0) > 0
  const crlf = '\r\n'

  const headers: string[] = []
  headers.push(`From: ${formatFrom(opts.from, opts.fromName)}`)
  headers.push(`To: ${opts.to.join(', ')}`)
  if (opts.cc && opts.cc.length > 0) headers.push(`Cc: ${opts.cc.join(', ')}`)
  if (opts.bcc && opts.bcc.length > 0) headers.push(`Bcc: ${opts.bcc.join(', ')}`)
  headers.push(`Subject: ${encodeHeader(opts.subject)}`)
  headers.push('MIME-Version: 1.0')

  // Sender's signature: raw HTML appended after the escaped body div (it is
  // trusted admin-entered markup), converted to text for the plain part.
  const sig = opts.signatureHtml?.trim() ? opts.signatureHtml : null
  const plainBody =
    bodyToPlain(opts.body) + (sig ? `${crlf}${crlf}${signatureToPlain(sig)}` : '')
  const htmlBody =
    (opts.bodyHtml ?? bodyToHtml(opts.body)) +
    (sig ? `<br><br>${crlf}<div class="mps-signature">${sig}</div>` : '')

  const altPart =
    `--${altBoundary}${crlf}` +
    `Content-Type: text/plain; charset="UTF-8"${crlf}` +
    `Content-Transfer-Encoding: 8bit${crlf}${crlf}` +
    plainBody + crlf +
    `--${altBoundary}${crlf}` +
    `Content-Type: text/html; charset="UTF-8"${crlf}` +
    `Content-Transfer-Encoding: 8bit${crlf}${crlf}` +
    htmlBody + crlf +
    `--${altBoundary}--${crlf}`

  // Whatever the caller passed: `cid:` images may be referenced by the
  // signature OR by a pre-rendered bodyHtml (the notification template's logo).
  // The signature-resolution path above already leaves this empty when it
  // found no signature to render.
  const inlineImages = opts.inlineImages ?? []

  // Body section: the alternative pair, wrapped in multipart/related when
  // inline (cid:) images are present.
  let bodyContentType: string
  let bodyPart: string
  if (inlineImages.length > 0) {
    bodyContentType = `multipart/related; boundary="${relBoundary}"; type="multipart/alternative"`
    bodyPart =
      `--${relBoundary}${crlf}` +
      `Content-Type: multipart/alternative; boundary="${altBoundary}"${crlf}${crlf}` +
      altPart +
      inlineImages
        .map(
          (img) =>
            `--${relBoundary}${crlf}` +
            `Content-Type: ${img.contentType}; name="${img.filename}"${crlf}` +
            `Content-Transfer-Encoding: base64${crlf}` +
            `Content-ID: <${img.cid}>${crlf}` +
            `Content-Disposition: inline; filename="${img.filename}"${crlf}${crlf}` +
            base64Lines(img.content) + crlf,
        )
        .join('') +
      `--${relBoundary}--${crlf}`
  } else {
    bodyContentType = `multipart/alternative; boundary="${altBoundary}"`
    bodyPart = altPart
  }

  if (!hasAttachments) {
    headers.push(`Content-Type: ${bodyContentType}`)
    return Buffer.from(headers.join(crlf) + crlf + crlf + bodyPart, 'utf8')
  }

  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`)

  const parts: (string | Buffer)[] = []
  parts.push(headers.join(crlf) + crlf + crlf)

  // Body part — alternative (or related) section nested inside the mixed envelope
  parts.push(`--${boundary}${crlf}`)
  parts.push(`Content-Type: ${bodyContentType}${crlf}${crlf}`)
  parts.push(bodyPart)

  // Attachment parts
  for (const att of opts.attachments!) {
    parts.push(`--${boundary}${crlf}`)
    parts.push(`Content-Type: ${att.contentType}; name="${att.filename}"${crlf}`)
    parts.push(`Content-Transfer-Encoding: base64${crlf}`)
    parts.push(`Content-Disposition: attachment; filename="${att.filename}"${crlf}${crlf}`)
    parts.push(base64Lines(att.content) + crlf)
  }

  parts.push(`--${boundary}--${crlf}`)

  return Buffer.concat(
    parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'utf8') : p)),
  )
}

// ── Public send function ─────────────────────────────────

/** Send an email via the Gmail API, impersonating `opts.from`. Returns the
 *  Gmail message ID on success. Throws on auth/send failure — the caller
 *  should map that to a 5xx response. */
export async function sendMail(opts: SendMailOptions): Promise<string> {
  if (!opts.to || opts.to.length === 0) {
    throw new Error('At least one recipient required')
  }

  // Resolve the sender's signature from the user-profiles store unless the
  // caller passed one explicitly (null = explicitly none). Every send route
  // sets `from` via getUserEmail(req.userId), so the address identifies the
  // sending user; no match / no signature → null → message unchanged.
  let signatureHtml = opts.signatureHtml
  let inlineImages = opts.inlineImages
  if (signatureHtml === undefined) {
    const resolved = await getSignatureForEmail(opts.from)
    signatureHtml = resolved?.html ?? null
    inlineImages = resolved?.inlineImages
  }

  const client = getClientForSubject(opts.from)
  const mime = buildMimeMessage({ ...opts, signatureHtml, inlineImages })

  // Gmail expects the raw message base64url-encoded (not plain base64).
  const raw = mime
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

  const gmail = google.gmail({ version: 'v1', auth: client })
  const result = await gmail.users.messages.send({
    userId: 'me', // 'me' resolves to the impersonated subject
    requestBody: { raw },
  })

  return result.data.id ?? ''
}
