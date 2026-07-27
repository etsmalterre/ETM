import { describe, it, expect } from 'vitest'
import { buildMimeMessage, signatureToPlain, type SendMailOptions } from './gmail.js'

const baseOpts: SendMailOptions = {
  from: 'vincent@etsmalterre.com',
  to: ['dest@example.com'],
  subject: 'Test',
  body: 'Bonjour,\nvoici le **document**.',
}

const SIG = '<p>Vincent Malterre<br>ETS Malterre &amp; Cie</p>'

describe('buildMimeMessage signature handling', () => {
  it('appends the signature to the HTML part and its text form to the plain part', () => {
    const mime = buildMimeMessage({ ...baseOpts, signatureHtml: SIG }).toString('utf8')
    expect(mime).toContain('<div class="mps-signature">' + SIG + '</div>')
    expect(mime).toContain('Vincent Malterre\nETS Malterre & Cie')
  })

  it('keeps the message unchanged when signature is null or undefined', () => {
    const withNull = buildMimeMessage({ ...baseOpts, signatureHtml: null }).toString('utf8')
    const without = buildMimeMessage(baseOpts).toString('utf8')
    for (const mime of [withNull, without]) {
      expect(mime).not.toContain('mps-signature')
    }
  })

  it('treats a whitespace-only signature as absent', () => {
    const mime = buildMimeMessage({ ...baseOpts, signatureHtml: '   \n ' }).toString('utf8')
    expect(mime).not.toContain('mps-signature')
  })

  it('keeps **bold** rendering intact with a signature present', () => {
    const mime = buildMimeMessage({ ...baseOpts, signatureHtml: SIG }).toString('utf8')
    expect(mime).toContain('<strong>document</strong>')
  })
})

describe('buildMimeMessage inline images (cid:)', () => {
  const LOGO = {
    cid: 'logo-malterre@etsmalterre.com',
    contentType: 'image/png',
    filename: 'logo-malterre.png',
    content: Buffer.from('fake-png-bytes'),
  }

  it('wraps the alternative pair in multipart/related and embeds the image', () => {
    const mime = buildMimeMessage({
      ...baseOpts,
      signatureHtml: SIG,
      inlineImages: [LOGO],
    }).toString('utf8')
    expect(mime).toContain('multipart/related')
    expect(mime).toContain('type="multipart/alternative"')
    expect(mime).toContain('Content-ID: <logo-malterre@etsmalterre.com>')
    expect(mime).toContain('Content-Disposition: inline; filename="logo-malterre.png"')
    expect(mime).toContain(LOGO.content.toString('base64'))
  })

  it('nests related inside mixed when attachments are present', () => {
    const mime = buildMimeMessage({
      ...baseOpts,
      signatureHtml: SIG,
      inlineImages: [LOGO],
      attachments: [
        { filename: 'doc.pdf', content: Buffer.from('%PDF-fake'), contentType: 'application/pdf' },
      ],
    }).toString('utf8')
    expect(mime).toContain('multipart/mixed')
    expect(mime).toContain('multipart/related')
    expect(mime).toContain('Content-ID: <logo-malterre@etsmalterre.com>')
    expect(mime).toContain('Content-Disposition: attachment; filename="doc.pdf"')
  })

  it('embeds inline images without a signature (notification template logo)', () => {
    // The notification template renders its own branded bodyHtml that
    // references the logo by cid: — there is no signature to carry it.
    const mime = buildMimeMessage({
      ...baseOpts,
      signatureHtml: null,
      bodyHtml: '<div><img src="cid:logo-malterre@etsmalterre.com"></div>',
      inlineImages: [LOGO],
    }).toString('utf8')
    expect(mime).toContain('multipart/related')
    expect(mime).toContain('Content-ID: <logo-malterre@etsmalterre.com>')
  })

  it('embeds no related section when the caller passes no inline images', () => {
    const mime = buildMimeMessage({ ...baseOpts, signatureHtml: null }).toString('utf8')
    expect(mime).not.toContain('multipart/related')
    expect(mime).not.toContain('Content-ID:')
  })
})

describe('buildMimeMessage bodyHtml', () => {
  it('replaces the generated HTML part but keeps body as the plain part', () => {
    const mime = buildMimeMessage({
      ...baseOpts,
      body: 'Texte brut **gras**',
      bodyHtml: '<table><tr><td>Rendu HTML</td></tr></table>',
      signatureHtml: null,
    }).toString('utf8')
    // text/plain keeps the caller's text, with the bold markers stripped
    expect(mime).toContain('Texte brut gras')
    // text/html is the pre-rendered markup, NOT the auto-generated <div>
    expect(mime).toContain('<table><tr><td>Rendu HTML</td></tr></table>')
    expect(mime).not.toContain('<strong>gras</strong>')
  })
})

describe('signatureToPlain', () => {
  it('converts block tags to newlines, strips the rest, decodes entities', () => {
    expect(signatureToPlain('<div>Ligne 1</div><div>A &amp; B&nbsp;&lt;ok&gt;</div>'))
      .toBe('Ligne 1\nA & B <ok>')
  })

  it('drops style blocks and collapses blank lines', () => {
    const html = '<style>p { color: red; }</style><p>Nom</p><p></p><p></p><p>Tel</p>'
    expect(signatureToPlain(html)).toBe('Nom\n\nTel')
  })
})
