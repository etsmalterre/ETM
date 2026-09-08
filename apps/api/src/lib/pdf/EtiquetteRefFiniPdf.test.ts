// Content guard for the client-facing ref_fini étiquette: walks the element
// tree (never the rendered bytes — subset fonts make those glyph indices) and
// pins the legacy fields, the QR caption, the designation clamp and the wash
// temperature fallback. Layout is checked by eye on a rasterized render.
import { describe, it, expect } from 'vitest'
import { EtiquetteRefFiniPdf, echantillonUrl, clampDesignation, type EtiquetteRefFiniData } from './EtiquetteRefFiniPdf.js'
import { qrModulesPath } from './QrCode.js'

function pdfStrings(node: unknown, out: string[] = []): string[] {
  if (node == null || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const c of node) pdfStrings(c, out); return out }
  const el = node as { type?: unknown; props?: Record<string, unknown> & { children?: unknown } }
  // Function components (Etiquette, Spec, the care symbols, QrCode) are not
  // expanded by React until render — expand them by hand so the walk sees
  // what the page actually says.
  if (typeof el.type === 'function' && el.props) {
    return pdfStrings((el.type as (p: unknown) => unknown)(el.props), out)
  }
  if (el.props?.children !== undefined) pdfStrings(el.props.children, out)
  return out
}

const base: EtiquetteRefFiniData = {
  IDref_fini: 1730,
  reference: '001A',
  designation: 'Molleton coton non gratté',
  laizeHT: 150,
  poids: 182.5,
  tempLavage: 40,
}

describe('EtiquetteRefFiniPdf', () => {
  it('prints the legacy fields: réf, désignation, laize, poids, wash temp', () => {
    const s = pdfStrings(EtiquetteRefFiniPdf({ data: base }))
    expect(s).toContain('001A')
    expect(s).toContain('Molleton coton non gratté')
    expect(s).toContain('150')
    expect(s).toContain('cm')
    expect(s).toContain('182,5')
    expect(s).toContain('g/m²')
    expect(s).toContain('40')
    expect(s).toContain('P')
    // Brand is the badge alone — no website line (user decision 2026-09-08).
    expect(s).not.toContain('etsmalterre.fr')
  })

  it('always carries the QR code, captioned TARIFS', () => {
    const s = pdfStrings(EtiquetteRefFiniPdf({ data: base }))
    expect(s).toContain('TARIFS')
    expect(s).not.toContain('FICHE ÉCHANTILLON')
  })

  it('clamps an oversize designation on a word boundary, leaves the catalog max alone', () => {
    const longest = 'Molleton gr recycl 53%cot/44% pes 3%elast surteint' // 50 chars, the catalog's longest
    expect(clampDesignation(longest)).toBe(longest)
    const clamped = clampDesignation(
      'Molleton gratté cinquante pour cent coton biologique cinquante pour cent coton recyclé suradouci',
    )
    expect(clamped.length).toBeLessThanOrEqual(65)
    expect(clamped.endsWith('…')).toBe(true)
    expect(clamped).not.toMatch(/\s…$/)
    expect(clampDesignation('  deux   espaces  ')).toBe('deux espaces')
  })

  it('falls back to 30 °C when temp_lavage is missing, like the fiche technique', () => {
    expect(pdfStrings(EtiquetteRefFiniPdf({ data: { ...base, tempLavage: null } }))).toContain('30')
    expect(pdfStrings(EtiquetteRefFiniPdf({ data: { ...base, tempLavage: 0 } }))).toContain('30')
  })

  it('blanks a missing spec instead of printing "null"', () => {
    const s = pdfStrings(EtiquetteRefFiniPdf({ data: { ...base, laizeHT: null, poids: null } }))
    expect(s).toContain('—')
    expect(s.join(' ')).not.toMatch(/null|NaN|undefined/)
  })

  it('encodes the legacy échantillon URL as a compact QR', () => {
    expect(echantillonUrl(1730)).toBe('https://etsmalterre.fr/echantillon/?ID=1730')
    // Level M → version 3 (29 modules); the tag draws level H → version 5
    // (37 modules), the 30 % recovery paying for the M painted over the centre.
    expect(qrModulesPath(echantillonUrl(1730), 1).modules).toBe(29)
    const { path, modules } = qrModulesPath(echantillonUrl(1730), 1, 'H')
    expect(modules).toBe(37)
    // Finder pattern top-left: a full 7-module run on the first row, offset by the quiet zone.
    expect(path.startsWith('M1 1h7v1h-7z')).toBe(true)
  })
})
