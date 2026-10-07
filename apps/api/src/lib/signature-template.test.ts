import { describe, it, expect } from 'vitest'
import {
  renderSignatureHtml,
  hasSignatureContent,
  EMPTY_SIGNATURE_FIELDS,
  type SignatureFields,
} from './signature-template.js'
import { signatureToPlain } from './gmail.js'

const FULL: SignatureFields = {
  displayName: 'Vincent Malterre',
  fonction: 'Gérant',
  telFixe: '03 22 35 36 66',
  email: 'vincent@etsmalterre.com',
}

describe('hasSignatureContent', () => {
  it('is false for all-blank fields', () => {
    expect(hasSignatureContent(EMPTY_SIGNATURE_FIELDS)).toBe(false)
    expect(hasSignatureContent({ ...EMPTY_SIGNATURE_FIELDS, telFixe: '  ' })).toBe(false)
  })

  it('is true when any field carries content', () => {
    expect(hasSignatureContent({ ...EMPTY_SIGNATURE_FIELDS, displayName: 'X' })).toBe(true)
  })
})

describe('renderSignatureHtml', () => {
  it('renders every provided field', () => {
    const html = renderSignatureHtml(FULL, 'cid:logo@test')
    expect(html).toContain('Vincent Malterre')
    // Role line keeps natural case in the markup — uppercasing is CSS-only
    // so the text/plain fallback stays readable. Fonction only, no company
    // name suffix.
    expect(html).toContain('Gérant')
    expect(html).not.toContain('ETS Malterre')
    expect(html).toContain('text-transform:uppercase')
    expect(html).toContain('Tél. : 03 22 35 36 66')
    expect(html).toContain('mailto:vincent@etsmalterre.com')
    expect(html).toContain('src="cid:logo@test"')
    // Vertical gold divider between logo and text, same height as the logo
    expect(html).toContain('width:3px;height:64px;background-color:#F2B80A')
  })

  it('omits empty optional lines', () => {
    const html = renderSignatureHtml(
      { ...EMPTY_SIGNATURE_FIELDS, displayName: 'Jean Dupont' },
      'cid:x',
    )
    expect(html).toContain('Jean Dupont')
    expect(html).not.toContain('Tél.')
    expect(html).not.toContain('mailto:')
  })

  it('escapes HTML in user-entered fields', () => {
    const html = renderSignatureHtml(
      { ...FULL, displayName: 'A <script>alert(1)</script>' },
      'cid:x',
    )
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('produces a usable text/plain fallback through signatureToPlain', () => {
    const plain = signatureToPlain(renderSignatureHtml(FULL, 'cid:x'))
    expect(plain).toContain('Vincent Malterre')
    expect(plain).toContain('Tél. : 03 22 35 36 66')
    expect(plain).toContain('vincent@etsmalterre.com')
    expect(plain).not.toContain('<')
  })
})
