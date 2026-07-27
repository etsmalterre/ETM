// Notification dispatcher — resolves the subscribers of an event and emails
// each of them via the existing Gmail domain-wide-delegation helper.
//
// ── Hard rule: notifying must never break the thing that triggered it ──
// notify() NEVER throws. Every failure (no key file, Gmail down, no mapped
// address, HFSQL hiccup while building the body) is caught and logged, and the
// caller gets a count back. Call sites that don't need the count should fire it
// after res.json() with `void notify(...)` so the round-trip isn't waiting on
// an external HTTP call.

import { sendMail } from './gmail.js'
import { getAllUserEmails } from './user-emails.js'
import { subscribersOf } from './notifications.js'
import { renderNotificationEmail, type NotificationEmailContent } from './notification-email.js'
import type { NotificationKey } from './notification-keys.js'

export interface NotifyResult {
  /** Subscribers with a usable email address — the number we attempted. */
  subscribers: number
  /** Sends that actually succeeded. */
  notified: number
}

export interface NotifyOptions {
  subject: string
  /** Structured content — rendered into the branded HTML template AND its
   *  plain-text twin by lib/notification-email.ts. */
  content: NotificationEmailContent
  /** The user whose action triggered the event. When they have a mapped email
   *  the notification is sent as them, so the recipient can just hit reply. */
  actingUserId?: number
  /** Display name of the acting user, used in the From header. */
  actingUserName?: string
}

/** Send a notification to every subscriber of `key`. Resolves to how many
 *  subscribers were addressable and how many sends succeeded. Never rejects. */
export async function notify(key: NotificationKey, opts: NotifyOptions): Promise<NotifyResult> {
  const result: NotifyResult = { subscribers: 0, notified: 0 }
  try {
    const ids = await subscribersOf(key)
    if (ids.length === 0) return result

    const emails = await getAllUserEmails()
    const recipients = ids.map((id) => emails[id]).filter((e): e is string => !!e)
    if (recipients.length === 0) {
      // Subscribed but unreachable — the admin UI flags this case, but log it
      // too so a silently-undelivered notification is diagnosable.
      console.warn(`notify(${key}): ${ids.length} subscriber(s) have no mapped email address`)
      return result
    }
    result.subscribers = recipients.length

    const senderEmail = opts.actingUserId !== undefined ? emails[opts.actingUserId] ?? null : null
    const rendered = renderNotificationEmail(opts.content)

    // One send per recipient rather than one send with N recipients: when the
    // acting user has no mailbox to impersonate we fall back to the recipient's
    // own address, which differs per recipient.
    for (const to of recipients) {
      const from = senderEmail ?? to
      const fromName = senderEmail && opts.actingUserName
        ? `${opts.actingUserName} - ETS Malterre`
        : 'MPS - Notification'
      try {
        await sendMail({
          from,
          fromName,
          to: [to],
          subject: opts.subject,
          body: rendered.text,
          bodyHtml: rendered.html,
          inlineImages: rendered.inlineImages,
          // System notification — never append the sender's commercial signature.
          signatureHtml: null,
        })
        result.notified++
      } catch (err) {
        console.error(`notify(${key}): send to ${to} failed:`, err)
      }
    }
  } catch (err) {
    console.error(`notify(${key}) failed:`, err)
  }
  return result
}
