// Shared types + helpers for the SendEmailDialog component and its callers.
// Every email-sending screen (Fournisseurs Commandes, Entreprises, future
// sous-traitants / clients / factures...) funnels through the same component
// using the contract defined here.

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export interface EmailRecipient {
  email: string
  /** "Prénom Nom" for chip display. Optional — falls back to email. */
  name?: string
  source: 'contact' | 'manual'
  /** Set when source === 'contact'. Useful for future dedupe by id. */
  contactId?: number
}

export interface EmailDefaults {
  recipients: {
    selected: EmailRecipient[]
    suggestions: EmailRecipient[]
  }
  cc?: string[]
  /** Pre-filled blind copies. Used by the expedition BL flows to notify the
   *  sous-traitants holding the shipped rolls without exposing their
   *  addresses to the client. */
  bcc?: string[]
  subject: string
  body: string
  /** Server-driven state for the dialog's optional (tickable) attachments.
   *  When present, only the listed ids are shown and each one's initial
   *  checked state comes from `default_checked` (e.g. rapport de contrôle
   *  pre-ticked when the client's inclureRapportQualite flag is set). When
   *  absent, the dialog falls back to the caller-side `defaultChecked`. */
  optional_attachments?: Array<{ id: string; default_checked: boolean }>
}

export interface SendPayload {
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body: string
  /** When true, the server should include its own rendered PDF (e.g. the
   *  bon de commande for a commande_fil). Always false if the dialog has
   *  no pdfUrl, or if the user removed the server-PDF chip. */
  attachPdf: boolean
  /** User-uploaded files from the attachment picker. Sent to the server
   *  as base64-encoded `extra_attachments` alongside the server-rendered PDF. */
  userAttachments: File[]
  /** Checked-state of the dialog's optional server attachments, keyed by
   *  attachment id (e.g. { 'rapport-controle': true, 'info-matieres': false }).
   *  The caller maps these ids to endpoint-specific flags via postEmail's
   *  `extraBody` — they are never sent under this generic key. */
  optionalAttachments?: Record<string, boolean>
  /** Dev-only: skip the actual Gmail send, but still run every server-side
   *  side effect (envoi_email log, sstatut transitions). Used by the "Faux
   *  envoi" button in the dialog to test status transitions without spamming
   *  real recipients. The server ignores this flag unless NODE_ENV is not
   *  'production'. */
  devSkipSend?: boolean
}

/** Split a comma/semicolon/newline-separated recipient string into trimmed,
 *  non-empty entries. Does NOT validate the addresses — callers should pair
 *  with EMAIL_REGEX when needed. */
export function parseEmailList(raw: string): string[] {
  return raw
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Maximum total size (raw bytes, before base64 expansion) of user-uploaded
 *  attachments per send. Gmail's hard ceiling is 25 MB per MIME message, and
 *  base64 inflates by ~33 %, so 18 MB raw fits comfortably with room for the
 *  server PDF + body. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 18 * 1024 * 1024

/** Convert a File to a base64 string (without the `data:...` prefix). */
async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  // btoa only handles ASCII, so we walk the bytes manually for binary-safe
  // base64 encoding.
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
  }
  return btoa(binary)
}

/** POST a SendPayload to an email endpoint. Uses raw fetch (not apiFetch)
 *  because the shared helper drops the response body on non-2xx, and we need
 *  the server's French `message` field (e.g. `no_sender_email`) surfaced
 *  verbatim to the user in the dialog banner. */
export async function postEmail(
  url: string,
  payload: SendPayload,
  opts?: { includeAttachPdf?: boolean; extraBody?: Record<string, unknown> },
): Promise<void> {
  const body: Record<string, unknown> = {
    ...(opts?.extraBody ?? {}),
    to: payload.to,
    subject: payload.subject,
    body: payload.body,
  }
  if (payload.cc.length > 0) body.cc = payload.cc
  if (payload.bcc.length > 0) body.bcc = payload.bcc
  if (opts?.includeAttachPdf) body.attach_pdf = payload.attachPdf
  if (payload.devSkipSend) body.dev_skip_send = true

  if (payload.userAttachments.length > 0) {
    body.extra_attachments = await Promise.all(
      payload.userAttachments.map(async (f) => ({
        filename: f.name,
        content_base64: await fileToBase64(f),
        content_type: f.type || 'application/octet-stream',
      })),
    )
  }

  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    let message = `Erreur HTTP ${res.status}`
    try {
      const json = await res.json()
      if (typeof json?.message === 'string') message = json.message
      else if (typeof json?.error === 'string') message = json.error
    } catch {
      /* non-JSON body — keep fallback */
    }
    throw new Error(message)
  }
}

/** Format a byte count as a short human label ("2.3 MB", "420 KB"). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
