// Rich-text bodies from the email dialog (SendEmailDialog's editor).
//
// The dialog sends `body` as HTML behind a marker comment instead of plain
// text. One marker, decoded in ONE place (sendMail → gmail.ts), so the ~20
// routes that pass `body` straight to sendMail need no change. A route that
// STORES the body as text (a réclamation history…) calls corpsEnTexte().
//
// What a person may style is deliberately short — bold, italic, underline,
// lists, a « titre » size and four colours — so every Malterre mail looks
// alike in Outlook and Gmail. Anything else (pasted Word HTML, scripts,
// images, fonts, sizes) is stripped here, server side: never trust the browser.

import sanitizeHtml from 'sanitize-html'

/** Marker the web dialog puts in front of an HTML body. */
export const CORPS_RICHE = '<!--mps:html-->'

/** The palette the toolbar offers — any other colour is dropped. Same values
 *  as RICH_COLORS in apps/web/src/components/email/RichEmailEditor.tsx. */
export const COULEURS_EMAIL = ['#143d6b', '#c62828', '#b26a00'] as const

export function estCorpsRiche(body: string): boolean {
  return body.startsWith(CORPS_RICHE)
}

const COULEUR_RE = new RegExp(`^(${COULEURS_EMAIL.join('|')})$`, 'i')

// Inline styles, because mail clients ignore <style> blocks.
const STYLE_P = 'margin:0 0 10px 0;'
const STYLE_TITRE = 'margin:14px 0 6px 0;font-size:17px;font-weight:bold;line-height:1.3;'
const STYLE_LISTE = 'margin:0 0 10px 0;padding-left:22px;'

/** Clean HTML for the text/html part (without the marker). */
export function nettoyerHtmlEmail(html: string): string {
  return sanitizeHtml(html.replace(CORPS_RICHE, ''), {
    allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'h3', 'span'],
    allowedAttributes: { span: ['style'], p: ['style'], h3: ['style'], ul: ['style'], ol: ['style'] },
    allowedStyles: { span: { color: [COULEUR_RE] } },
    transformTags: {
      b: 'strong',
      i: 'em',
      h1: 'h3',
      h2: 'h3',
      h4: 'h3',
      p: () => ({ tagName: 'p', attribs: { style: STYLE_P } }),
      h3: () => ({ tagName: 'h3', attribs: { style: STYLE_TITRE } }),
      ul: () => ({ tagName: 'ul', attribs: { style: STYLE_LISTE } }),
      ol: () => ({ tagName: 'ol', attribs: { style: STYLE_LISTE } }),
    },
    // A span left without its colour carries nothing: unwrap it.
    exclusiveFilter: (frame) => frame.tag === 'span' && !frame.attribs.style && !frame.text.trim(),
  })
}

/** The text/plain alternative of a rich body: paragraphs and titles on their
 *  own lines, list items as « - ». */
export function htmlEmailEnTexte(html: string): string {
  return html
    .replace(CORPS_RICHE, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/(li)>/gi, '\n')
    .replace(/<\/(p|h[1-6]|ul|ol|div)>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A body as plain text, whatever the dialog sent — for routes that keep it. */
export function corpsEnTexte(body: string): string {
  return estCorpsRiche(body) ? htmlEmailEnTexte(body) : body
}
