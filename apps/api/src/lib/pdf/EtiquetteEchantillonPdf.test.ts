// Content guard for the sample Dymo tag: walks the element tree (never the
// rendered bytes) and pins the fields, the LFA and composition shaping, the QR
// absence and the printable-band layout. The look is checked on a rasterized
// render (scripts/dump-etiquette-echantillon.ts).
import { describe, it, expect } from 'vitest'
import {
  EtiquetteEchantillonPdf,
  LAYOUT,
  compositionTexte,
  lfaCellule,
  type EtiquetteEchantillonData,
} from './EtiquetteEchantillonPdf.js'

function pdfStrings(node: unknown, out: string[] = []): string[] {
  if (node == null || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const c of node) pdfStrings(c, out); return out }
  const el = node as { type?: unknown; props?: Record<string, unknown> & { children?: unknown } }
  if (typeof el.type === 'function' && el.props) {
    return pdfStrings((el.type as (p: unknown) => unknown)(el.props), out)
  }
  if (el.props?.children !== undefined) pdfStrings(el.props.children, out)
  return out
}

const base: EtiquetteEchantillonData = {
  IDref_echantillon: 55,
  numero: 'E055',
  contexture: 'jersey vanisé',
  jauge: '28',
  diametre: '30"',
  lfa: [7.5, 0, 7.5, 0],
  composition: [
    { pourcentage: 48, fil: '1/60 LYOCELL' },
    { pourcentage: 47, fil: '78/68/2 PA66 Z' },
    { pourcentage: 5, fil: '22 ELASTHANNE' },
  ],
}

describe('EtiquetteEchantillonPdf', () => {
  it('prints the number, contexture, jauge, Ø, LFA and composition', () => {
    const s = pdfStrings(EtiquetteEchantillonPdf({ data: base }))
    expect(s).toContain('E055')
    expect(s).toContain('jersey vanisé')
    expect(s).toContain('28')
    expect(s).toContain('30"')
    expect(s).toContain('7,50')
    expect(s.some((t) => t.includes('48 % 1/60 LYOCELL'))).toBe(true)
    expect(s).not.toContain('FICHE')
  })

  it('shows a dash for what is not entered, and no composition line when empty', () => {
    const s = pdfStrings(EtiquetteEchantillonPdf({ data: { ...base, contexture: null, jauge: null, lfa: [0, 0, 0, 0], composition: [] } }))
    expect(s.filter((t) => t === '—').length).toBe(2)
    expect(s.some((t) => t.includes('%'))).toBe(false)
  })

  it('prints the LFA once when the tours repeat it, all distinct values otherwise', () => {
    expect(lfaCellule([7.5, 0, 7.5, 0])).toBe('7,50')
    expect(lfaCellule([3.35, 7.6, 5.7, 7.6])).toBe('3,35 / 7,6 / 5,7')
    expect(lfaCellule([0, 0, 0, 0])).toBe('')
  })

  it('clamps a long composition on a word, never splitting « 36 % » from its yarn', () => {
    const t = compositionTexte([
      { pourcentage: 49, fil: '1/28 COTON PEIGNE BIO Z' },
      { pourcentage: 36, fil: '78/68/2 PA66 Z' },
      { pourcentage: 15, fil: '48 dtex ELASTHANNE ROICA' },
    ])
    expect(t.length).toBeLessThanOrEqual(80)
    expect(t.endsWith('…')).toBe(true)
    expect(t).toContain('36 % 78/68/2')
  })

  it('centres on the physical label and keeps the logo inside the printable band', () => {
    expect(LAYOUT.PAGE_PADDING_X * 2 + LAYOUT.CONTENT_WIDTH).toBeCloseTo(LAYOUT.PAGE_WIDTH, 6)
    expect(LAYOUT.PAGE_PADDING_X + LAYOUT.CONTENT_WIDTH).toBeLessThanOrEqual(LAYOUT.PRINT_LIMIT - 2)
  })
})
