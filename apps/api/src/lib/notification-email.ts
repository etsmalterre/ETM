// Branded HTML template for MPS notification emails (lib/notify.ts).
//
// Same two render targets as the signature template, for the same reasons:
//   - outgoing emails: the logo travels as a `cid:` inline MIME part
//   - previews: the logo is a data: URI so the file opens with no network
// Markup is email-client-safe — tables, inline styles, no <style> block, no
// external assets. Border-radius degrades gracefully to square corners in
// Outlook, which is fine.
//
// Every notification renders BOTH parts from one structured content object, so
// the text/plain alternative can never drift from the HTML.

import {
  signatureLogoInlineImage,
  signatureLogoDataUri,
  SIGNATURE_LOGO_CID,
  type InlineImage,
} from './signature-template.js'

// Brand palette — CLAUDE.md §Branding. Hex is unavoidable here: email clients
// have no access to the app's CSS variables.
const NAVY = '#143D6B'
const GOLD = '#F2B80A'
const TEXT = '#1F2937'
const MUTED = '#6B7280'
const BORDER = '#E5E7EB'
const PAGE_BG = '#F4F5F7'
const AMBER_BG = '#FEF3C7'
const AMBER_TEXT = '#92400E'
const AMBER_BORDER = '#FCD34D'

const FONT = 'Arial,Helvetica,sans-serif'

export interface NotificationRow {
  label: string
  value: string
}

export interface NotificationEmailContent {
  /** Headline in the coloured band, e.g. "Coloris ajouté". */
  title: string
  /** 'info' = gold accent (something happened), 'alert' = amber (action needed). */
  tone: 'info' | 'alert'
  /** Lead sentence. `**bold**` is honoured in both parts. */
  intro: string
  /** Label / value detail rows. */
  rows: NotificationRow[]
  /** Optional quoted block, e.g. the requester's note. */
  note?: { label: string; value: string } | null
  /** Optional closing line, emphasised in a tinted box. */
  callout?: string | null
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const BOLD_RE = /\*\*([^*]+)\*\*/g

/** Escape, then turn `**bold**` into <strong>. */
function inline(s: string): string {
  return esc(s).replace(BOLD_RE, '<strong>$1</strong>')
}

function stripBold(s: string): string {
  return s.replace(BOLD_RE, '$1')
}

/** The plain-text alternative — same content, no markup. */
function renderText(c: NotificationEmailContent): string {
  const lines = ['Bonjour,', '', stripBold(c.intro), '']
  for (const r of c.rows) lines.push(`${r.label} : ${r.value}`)
  if (c.note && c.note.value.trim()) lines.push('', `${c.note.label} : ${c.note.value.trim()}`)
  if (c.callout) lines.push('', stripBold(c.callout))
  lines.push(
    '',
    '---',
    'Notification automatique MPS - ETS Malterre',
    'Pour ne plus recevoir cet email : Paramètres > Utilisateurs > Notifications.',
  )
  return lines.join('\n')
}

function renderHtml(c: NotificationEmailContent, logoSrc: string): string {
  const accent = c.tone === 'alert' ? AMBER_BORDER : GOLD

  const rows = c.rows
    .map(
      (r, i) =>
        '<tr>' +
        `<td style="padding:${i === 0 ? '0' : '10px'} 16px 10px 0;vertical-align:top;white-space:nowrap;` +
        `font-family:${FONT};font-size:12px;line-height:1.4;color:${MUTED};` +
        `${i === 0 ? '' : `border-top:1px solid ${BORDER};`}">${esc(r.label)}</td>` +
        `<td style="padding:${i === 0 ? '0' : '10px'} 0 10px 0;vertical-align:top;` +
        `font-family:${FONT};font-size:14px;line-height:1.4;color:${TEXT};font-weight:bold;` +
        `${i === 0 ? '' : `border-top:1px solid ${BORDER};`}">${esc(r.value)}</td>` +
        '</tr>',
    )
    .join('')

  const noteBlock =
    c.note && c.note.value.trim()
      ? `<tr><td style="padding:20px 28px 0 28px;">` +
        `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">` +
        `<tr><td style="border-left:3px solid ${GOLD};background-color:${PAGE_BG};padding:12px 14px;">` +
        `<div style="font-family:${FONT};font-size:11px;line-height:1.4;color:${MUTED};` +
        `text-transform:uppercase;letter-spacing:0.4px;font-weight:bold;">${esc(c.note.label)}</div>` +
        `<div style="font-family:${FONT};font-size:14px;line-height:1.5;color:${TEXT};margin-top:5px;">` +
        `${esc(c.note.value.trim())}</div>` +
        `</td></tr></table></td></tr>`
      : ''

  const calloutBlock = c.callout
    ? `<tr><td style="padding:20px 28px 0 28px;">` +
      `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">` +
      `<tr><td style="background-color:${AMBER_BG};border:1px solid ${AMBER_BORDER};border-radius:6px;padding:12px 14px;` +
      `font-family:${FONT};font-size:13px;line-height:1.5;color:${AMBER_TEXT};font-weight:bold;">` +
      `${inline(c.callout)}</td></tr></table></td></tr>`
    : ''

  return (
    `<table cellpadding="0" cellspacing="0" border="0" width="100%" ` +
    `style="border-collapse:collapse;background-color:${PAGE_BG};margin:0;padding:0;">` +
    `<tr><td align="center" style="padding:24px 12px;">` +

    // ── Card ──
    `<table cellpadding="0" cellspacing="0" border="0" width="600" ` +
    `style="border-collapse:collapse;width:100%;max-width:600px;background-color:#FFFFFF;` +
    `border:1px solid ${BORDER};border-radius:10px;overflow:hidden;">` +

    // Header band: navy, gold "M" badge, MPS wordmark
    `<tr><td style="background-color:${NAVY};padding:18px 28px;">` +
    `<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">` +
    `<tr>` +
    `<td style="padding:0 14px 0 0;vertical-align:middle;">` +
    `<img src="${logoSrc}" width="36" height="36" alt="Malterre" ` +
    `style="display:block;width:36px;height:36px;border:0;"></td>` +
    `<td style="vertical-align:middle;font-family:${FONT};">` +
    `<div style="font-size:16px;line-height:1.2;font-weight:bold;color:#FFFFFF;letter-spacing:0.5px;">MPS</div>` +
    `<div style="font-size:11px;line-height:1.3;color:${GOLD};letter-spacing:0.6px;">ETS MALTERRE</div>` +
    `</td></tr></table></td></tr>` +

    // Accent rule under the header (2px, like the PDF documents' gold rules)
    `<tr><td style="background-color:${accent};font-size:0;line-height:0;height:3px;">&nbsp;</td></tr>` +

    // Title + intro
    `<tr><td style="padding:26px 28px 0 28px;font-family:${FONT};">` +
    `<div style="font-size:20px;line-height:1.3;font-weight:bold;color:${NAVY};">${esc(c.title)}</div>` +
    `<div style="font-size:14px;line-height:1.6;color:${TEXT};margin-top:10px;">${inline(c.intro)}</div>` +
    `</td></tr>` +

    // Detail rows
    `<tr><td style="padding:20px 28px 0 28px;">` +
    `<table cellpadding="0" cellspacing="0" border="0" width="100%" ` +
    `style="border-collapse:collapse;">${rows}</table></td></tr>` +

    noteBlock +
    calloutBlock +

    // Footer
    `<tr><td style="padding:24px 28px 22px 28px;">` +
    `<div style="border-top:1px solid ${BORDER};padding-top:14px;font-family:${FONT};` +
    `font-size:11px;line-height:1.6;color:${MUTED};">` +
    `Notification automatique envoyée par <strong style="color:${NAVY};">MPS</strong> - ETS Malterre.<br>` +
    `Pour ne plus la recevoir : Paramètres &gt; Utilisateurs &gt; Notifications.` +
    `</div></td></tr>` +

    `</table></td></tr></table>`
  )
}

export interface RenderedNotificationEmail {
  html: string
  text: string
  inlineImages: InlineImage[]
}

/** Render a notification for sending: logo as a `cid:` inline part. */
export function renderNotificationEmail(c: NotificationEmailContent): RenderedNotificationEmail {
  return {
    html: renderHtml(c, `cid:${SIGNATURE_LOGO_CID}`),
    text: renderText(c),
    inlineImages: [signatureLogoInlineImage()],
  }
}

/** Render a notification for offline preview: logo as a data: URI, so the
 *  resulting .html file opens standalone in a browser. Used by
 *  scripts/dump-notification-emails.ts. */
export function renderNotificationEmailPreview(c: NotificationEmailContent): string {
  return renderHtml(c, signatureLogoDataUri())
}
