import { describe, expect, it } from 'vitest'
import { CORPS_RICHE, corpsEnTexte, estCorpsRiche, htmlEmailEnTexte, nettoyerHtmlEmail } from './email-riche.js'

describe('nettoyerHtmlEmail', () => {
  it('keeps the toolbar formats and inlines the mail styles', () => {
    const html = nettoyerHtmlEmail(`${CORPS_RICHE}<h3>Titre</h3><p>Un <strong>gras</strong>, <em>italique</em>, <u>souligné</u></p><ul><li><p>point</p></li></ul>`)
    expect(html).toContain('<strong>gras</strong>')
    expect(html).toContain('<em>italique</em>')
    expect(html).toContain('<u>souligné</u>')
    expect(html).toMatch(/<h3 style="[^"]*font-size:17px/)
    expect(html).toMatch(/<ul style="[^"]*padding-left/)
    expect(html).not.toContain(CORPS_RICHE)
  })

  it('keeps a palette colour, drops any other colour or style', () => {
    expect(nettoyerHtmlEmail('<p><span style="color: #C62828">rouge</span></p>')).toContain('color:#C62828')
    const autre = nettoyerHtmlEmail('<p><span style="color: #00ff00; font-size: 40px">vert</span></p>')
    expect(autre).not.toContain('00ff00')
    expect(autre).not.toContain('font-size:40px')
    expect(autre).toContain('vert')
  })

  it('strips scripts, images, links and handlers', () => {
    const html = nettoyerHtmlEmail('<p onclick="x()">a<script>alert(1)</script><img src="http://x/y.png"><a href="http://evil">lien</a></p>')
    expect(html).not.toMatch(/script|img|onclick|href/)
    expect(html).toContain('lien')
  })
})

describe('texte', () => {
  it('turns a rich body into readable plain text', () => {
    const t = htmlEmailEnTexte(`${CORPS_RICHE}<p>Bonjour,</p><h3>Points à signaler</h3><ul><li><p>Pièce A &amp; B</p></li><li><p>Pièce C</p></li></ul><p>Cordialement</p>`)
    expect(t).toBe('Bonjour,\n\nPoints à signaler\n\n- Pièce A & B\n\n- Pièce C\n\nCordialement')
  })

  it('leaves a plain body untouched', () => {
    expect(estCorpsRiche('Bonjour')).toBe(false)
    expect(corpsEnTexte('Bonjour **toi**')).toBe('Bonjour **toi**')
  })
})
