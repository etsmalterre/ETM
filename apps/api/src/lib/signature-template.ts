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
// deep blue for the role line and links. The divider is a light grey since
// 2026-10-07: the gold logo beside it already carries the brand colour.
const TEXT = '#111827'
const PHONE = '#374151'
const BLUE = '#2B6CB0'
const DIVIDER = '#D1D5DB'

/** Render the signature HTML from a user's fields. `logoSrc` is either
 *  `cid:<SIGNATURE_LOGO_CID>` (outgoing email) or a data: URI (preview).
 *  Layout (per the approved design): gold "M" badge on the left, a vertical
 *  grey bar, then name (bold, near-black), fonction (bold blue, uppercased
 *  via CSS so the text/plain fallback keeps natural case), phone line,
 *  email link. */
export function renderSignatureHtml(fields: SignatureFields, logoSrc: string): string {
  const f: SignatureFields = {
    displayName: fields.displayName.trim(),
    fonction: fields.fonction.trim(),
    telFixe: fields.telFixe.trim(),
    email: fields.email.trim(),
  }

  // Every line has a fixed PIXEL height (with mso-line-height-rule for
  // Outlook), so the text block's height is known here and the logo and the
  // divider are sized to it: top and bottom aligned whichever lines a person
  // filled in (decision Vincent 2026-10-07 — sized as a footer under a 14 px
  // message, it must not outweigh the mail).
  const LH_NOM = 20
  const LH_FONCTION = 16
  const LH_CONTACT = 18
  const ECART_CONTACT = 4
  const ligne = (lh: number, style: string, contenu: string, margeHaut = 0) =>
    `<div style="${style}line-height:${lh}px;mso-line-height-rule:exactly;${margeHaut ? `margin-top:${margeHaut}px;` : ''}">${contenu}</div>`

  const lines: string[] = []
  let hauteur = 0

  if (f.displayName) {
    lines.push(ligne(LH_NOM, `font-size:16px;font-weight:bold;color:${TEXT};`, esc(f.displayName)))
    hauteur += LH_NOM
  }

  if (f.fonction) {
    lines.push(ligne(LH_FONCTION, `font-size:11px;font-weight:bold;color:${BLUE};text-transform:uppercase;letter-spacing:0.3px;`, esc(f.fonction)))
    hauteur += LH_FONCTION
  }

  let firstContactLine = true
  const contactLine = (content: string) => {
    // A small gap separates the contact lines from the name block — only when
    // there is a name block above.
    const marge = firstContactLine && lines.length > 0 ? ECART_CONTACT : 0
    firstContactLine = false
    hauteur += LH_CONTACT + marge
    return ligne(LH_CONTACT, 'font-size:13px;', content, marge)
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

  // Logo and divider exactly as tall as the text (never below 40 px, so a
  // one-line signature keeps a readable logo).
  const h = Math.max(hauteur, 40)
  return (
    '<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;">' +
    '<tr>' +
    '<td style="padding:0 12px 0 0;vertical-align:middle;">' +
    `<img src="${logoSrc}" width="${h}" height="${h}" alt="Malterre" style="display:block;width:${h}px;height:${h}px;border:0;">` +
    '</td>' +
    // A fixed-height block rather than a td border, so it matches the logo.
    '<td style="padding:0;vertical-align:middle;">' +
    `<div style="width:2px;height:${h}px;background-color:${DIVIDER};font-size:0;line-height:0;">&nbsp;</div>` +
    '</td>' +
    '<td style="padding:0 0 0 12px;vertical-align:middle;">' +
    lines.join('') +
    '</td>' +
    '</tr>' +
    '</table>'
  )
}
