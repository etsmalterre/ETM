// Company-wide HTML email signature template. A signature is no longer a
// pasted blob of Gmail/Outlook HTML — it is rendered from a handful of
// per-user fields (lib/user-profiles.ts) into one consistent Malterre
// layout. Two render targets share the same template:
//   - outgoing emails: the logo is referenced as `cid:` and travels inside
//     the message as an inline MIME part (instant display, no remote fetch,
//     no Gmail image-proxy latency)
//   - in-app previews: the logo is inlined as a data: URI so the sandboxed
//     preview iframe needs no network/auth
// Markup is email-client-safe: tables + inline styles only, no <style>.

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
// 240px gold rounded-square badge with the white script "M" (composed from
// the sidebar logo-small.png M over the brand gold sampled from
// logo-malterre.png). Transparent corners so it also sits cleanly on
// dark-mode email backgrounds. ~17 KB.
const LOGO_PATH = path.resolve(__dirname, '../assets/logo-m-email.png')

export interface SignatureFields {
  /** Name as shown in the signature, e.g. "Vincent Malterre" */
  displayName: string
  /** Job title, e.g. "Gérant" — optional */
  fonction: string
  /** The one phone number shown ("Tél. :"), e.g. "03 22 35 36 66" — optional */
  telFixe: string
  /** Email address shown (and linked) in the signature — optional */
  email: string
}

export const EMPTY_SIGNATURE_FIELDS: SignatureFields = {
  displayName: '',
  fonction: '',
  telFixe: '',
  email: '',
}

/** An image embedded in the outgoing message and referenced from the HTML
 *  part via `cid:` (multipart/related). Consumed by gmail.ts. */
export interface InlineImage {
  cid: string
  contentType: string
  filename: string
  content: Buffer
}

export const SIGNATURE_LOGO_CID = 'logo-malterre@etsmalterre.com'

/** True when at least one field carries content — an all-blank set of
 *  fields means "no signature". */
export function hasSignatureContent(f: SignatureFields): boolean {
  return Object.values(f).some((v) => typeof v === 'string' && v.trim() !== '')
}

let logoCache: Buffer | null = null

/** Raw bytes of the signature logo PNG (cached after first read). */
export function getSignatureLogo(): Buffer {
  if (!logoCache) logoCache = fs.readFileSync(LOGO_PATH)
  return logoCache
}

/** The logo as an inline MIME part for outgoing emails. */
export function signatureLogoInlineImage(): InlineImage {
  return {
    cid: SIGNATURE_LOGO_CID,
    contentType: 'image/png',
    filename: 'logo-malterre.png',
    content: getSignatureLogo(),
  }
}

let dataUriCache: string | null = null

/** The logo as a data: URI for in-app previews. */
export function signatureLogoDataUri(): string {
  if (!dataUriCache) {
    dataUriCache = `data:image/png;base64,${getSignatureLogo().toString('base64')}`
  }
  return dataUriCache
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Palette matches the user's approved signature design: near-black name,
// deep blue for the role line and links, brand gold for the divider bar.
const TEXT = '#111827'
const PHONE = '#374151'
const BLUE = '#2B6CB0'
const GOLD = '#F2B80A'

/** Render the signature HTML from a user's fields. `logoSrc` is either
 *  `cid:<SIGNATURE_LOGO_CID>` (outgoing email) or a data: URI (preview).
 *  Layout (per the approved design): gold "M" badge on the left, a vertical
 *  gold bar, then name (bold, near-black), fonction (bold blue, uppercased
 *  via CSS so the text/plain fallback keeps natural case), phone line,
 *  email link. */
export function renderSignatureHtml(fields: SignatureFields, logoSrc: string): string {
  const f: SignatureFields = {
    displayName: fields.displayName.trim(),
    fonction: fields.fonction.trim(),
    telFixe: fields.telFixe.trim(),
    email: fields.email.trim(),
  }

  const lines: string[] = []

  if (f.displayName) {
    lines.push(
      `<div style="font-size:16px;line-height:1.3;font-weight:bold;color:${TEXT};">${esc(f.displayName)}</div>`,
    )
  }

  if (f.fonction) {
    lines.push(
      `<div style="font-size:11px;line-height:1.5;font-weight:bold;color:${BLUE};text-transform:uppercase;letter-spacing:0.3px;">${esc(f.fonction)}</div>`,
    )
  }

  let firstContactLine = true
  const contactLine = (content: string) => {
    const marginTop = firstContactLine ? 'margin-top:6px;' : ''
    firstContactLine = false
    return `<div style="font-size:13px;line-height:1.5;${marginTop}">${content}</div>`
  }

  if (f.telFixe) {
    lines.push(contactLine(`<span style="color:${PHONE};">Tél. : ${esc(f.telFixe)}</span>`))
  }
  if (f.email) {
    lines.push(
      contactLine(
        `<a href="mailto:${esc(f.email)}" style="color:${BLUE};text-decoration:none;">${esc(f.email)}</a>`,
      ),
    )
  }

  // Sized as a footer under a 14 px message (2026-10-07, shown under the text
  // in the email dialog): 64 px logo, 16 px name — it must not outweigh the mail.
  return (
    '<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;">' +
    '<tr>' +
    '<td style="padding:0 14px 0 0;vertical-align:middle;">' +
    `<img src="${logoSrc}" width="64" height="64" alt="Malterre" style="display:block;width:64px;height:64px;border:0;">` +
    '</td>' +
    // The divider bar matches the logo height exactly (top and bottom
    // aligned), so it's a fixed-height block rather than a td border.
    '<td style="padding:0;vertical-align:middle;">' +
    `<div style="width:3px;height:64px;background-color:${GOLD};font-size:0;line-height:0;">&nbsp;</div>` +
    '</td>' +
    '<td style="padding:0 0 0 14px;vertical-align:middle;">' +
    lines.join('') +
    '</td>' +
    '</tr>' +
    '</table>'
  )
}
