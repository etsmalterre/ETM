// Gmail web → Gmail API ids.
//
// An open conversation exposes the API-compatible ids two ways:
//   - hex "legacy" ids: h2[data-legacy-thread-id], [data-legacy-message-id]
//   - decimal ids: [data-thread-perm-id="thread-f:<dec>"], [data-message-id="#msg-f:<dec>"]
// The API id is the hex form of the decimal one. Legacy attributes are read
// first; the decimal ones are a fallback should Gmail drop them.

const HEX_ID = /^[0-9a-f]{6,32}$/i
const DEC_ID = /(?:thread|msg)-f:(\d{6,25})$/

/** "#msg-f:1781234567890123456" / "thread-f:…" → hex API id, or null. */
export function hexFromPermId(value: string | null | undefined): string | null {
  const m = value?.match(DEC_ID)
  if (!m) return null
  try {
    return BigInt(m[1]).toString(16)
  } catch {
    return null
  }
}

export function normaliseHex(value: string | null | undefined): string | null {
  const v = value?.trim()
  return v && HEX_ID.test(v) ? v.toLowerCase() : null
}

export interface RawIdAttrs {
  legacy?: string | null
  perm?: string | null
}

export function resolveId(attrs: RawIdAttrs): string | null {
  return normaliseHex(attrs.legacy) ?? hexFromPermId(attrs.perm)
}

/** Unique ids in DOM order. */
export function resolveIds(list: RawIdAttrs[]): string[] {
  const out: string[] = []
  for (const attrs of list) {
    const id = resolveId(attrs)
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

/**
 * Read the open conversation from the Gmail DOM. Returns null in list views:
 * only a conversation view has the subject h2 carrying the thread id.
 */
export function readConversation(doc: Document): { threadId: string | null; messageIds: string[]; subject: string | null } | null {
  const main = doc.querySelector('[role="main"]') ?? doc
  const subjectEl = main.querySelector<HTMLElement>('h2[data-legacy-thread-id], h2[data-thread-perm-id]')
  if (!subjectEl) return null

  const threadId = resolveId({
    legacy: subjectEl.getAttribute('data-legacy-thread-id'),
    perm: subjectEl.getAttribute('data-thread-perm-id'),
  })
  const messageIds = resolveIds(
    [...main.querySelectorAll<HTMLElement>('[data-legacy-message-id], [data-message-id]')].map(el => ({
      legacy: el.getAttribute('data-legacy-message-id'),
      perm: el.getAttribute('data-message-id'),
    })),
  )
  if (!threadId && messageIds.length === 0) return null
  return { threadId, messageIds, subject: subjectEl.textContent?.trim() || null }
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g

/**
 * The Gmail account open in the tab. Agents read given mailboxes, and Gmail
 * ids are per mailbox, so the API needs it. The tab title ends with it
 * (« <subject> - contact@etsmalterre.com - Ets Malterre Mail »): the LAST
 * address of the title, since a subject may hold one too. Fallback: the
 * account button (« Compte Google : Nom (adresse) »).
 */
export function readMailbox(doc: Document): string | null {
  const fromTitle = doc.title.match(EMAIL)
  if (fromTitle) return fromTitle[fromTitle.length - 1].toLowerCase()
  const account = doc.querySelector('a[aria-label*="@"][href*="accounts.google.com"]')?.getAttribute('aria-label')
  const fromAccount = account?.match(EMAIL)
  return fromAccount ? fromAccount[fromAccount.length - 1].toLowerCase() : null
}
