// Content guard for the sample Dymo tag: walks the element tree (never the
// rendered bytes) and pins the fields, the LFA and composition shaping, the
// absence of a QR code and the printable-band layout. The look is checked on a rasterized
// render (scripts/dump-etiquette-echantillon.ts).
import { describe, it, expect } from 'vitest'
import {
  EtiquetteEchantillonPdf,
  LAYOUT,
  compositionLignes,
  lfaTours,
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
    expect(s).toContain('LFA / TOUR')
    expect(s.filter((t) => t === '7.50').length).toBe(2)
    expect(s).toContain('48 %')
    expect(s).toContain('1/60 LYOCELL')
    expect(s).not.toContain('FICHE')
  })

  it('shows a dash for what is not entered, composition included', () => {
    const s = pdfStrings(EtiquetteEchantillonPdf({ data: { ...base, contexture: null, jauge: null, lfa: [0, 0, 0, 0], composition: [] } }))
    // jauge + 4 empty tours + composition
    expect(s.filter((t) => t === '—').length).toBe(6)
    expect(s.some((t) => t.includes('%'))).toBe(false)
    expect(s).toContain('COMPOSITION')
  })

  it('prints the four LFA tours in order, « — » for an empty one, written like the reference', () => {
    expect(lfaTours([7.5, 0, 7.5, 0])).toEqual(['7.50', '—', '7.50', '—'])
    expect(lfaTours([3.35, 7.6, 5.7, 10.65])).toEqual(['3.35', '7.60', '5.70', '10.65'])
    expect(lfaTours([])).toEqual(['—', '—', '—', '—'])
  })

  it('lists every yarn on its own row, name whole, % apart', () => {
    const l = compositionLignes([
      { pourcentage: 49, fil: '1/28 COTON PEIGNE BIO Z' },
      { pourcentage: 36, fil: '1/23 LYOCELL/CHANVRE 70/30 ' },
      { pourcentage: 15.5, fil: '48 dtex PA/ELAST' },
    ])
    expect(l).toEqual([
      { pct: '49 %', fil: '1/28 COTON PEIGNE BIO Z' },
      { pct: '36 %', fil: '1/23 LYOCELL/CHANVRE 70/30' },
      { pct: '15,5 %', fil: '48 dtex PA/ELAST' },
    ])
  })

  it('cuts names to one line once the yarns fold into two columns', () => {
    const quatre = [40, 30, 20, 10].map((p) => ({ pourcentage: p, fil: '1/23 LYOCELL/CHANVRE 70/30' }))
    for (const l of compositionLignes(quatre)) expect(l.fil.length).toBeLessThanOrEqual(22)
    expect(compositionLignes(quatre.slice(0, 3))[0].fil).toBe('1/23 LYOCELL/CHANVRE 70/30')
  })

  it('centres on the physical label and keeps the text inside the printable band', () => {
    expect(LAYOUT.PAGE_PADDING_X * 2 + LAYOUT.CONTENT_WIDTH).toBeCloseTo(LAYOUT.PAGE_WIDTH, 6)
    expect(LAYOUT.PAGE_PADDING_X + LAYOUT.CONTENT_WIDTH).toBeLessThanOrEqual(LAYOUT.PRINT_LIMIT - 2)
  })
})
