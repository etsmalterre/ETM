// Content guard for the écru (tombé-métier) Dymo tag: walks the element tree
// (never the rendered bytes — subset fonts make those glyph indices) and pins
// the legacy fields, the DÉCLASSÉ marker, and the one rule a thermal label
// lives by — black ink or bare paper, nothing in between. Layout is checked
// by eye on a rasterized render (`GET /visitage-trm/etiquettes?demo=3`).
import type React from 'react'
import { describe, it, expect } from 'vitest'
import { EtiquetteEcruPdf, styles, INK, PAPER, fmtPoids, fmtDate, type EtiquetteEcruData } from './EtiquetteEcruPdf.js'

function pdfStrings(node: unknown, out: string[] = []): string[] {
  if (node == null || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const c of node) pdfStrings(c, out); return out }
  const el = node as { type?: unknown; props?: Record<string, unknown> & { children?: unknown } }
  // Function components (Etiquette) are not expanded by React until render —
  // expand them by hand so the walk sees what the page actually says.
  if (typeof el.type === 'function' && el.props) {
    return pdfStrings((el.type as (p: unknown) => unknown)(el.props), out)
  }
  if (el.props?.children !== undefined) pdfStrings(el.props.children, out)
  return out
}

function pages(doc: React.ReactElement): unknown[] {
  const c = (doc.props as { children?: unknown }).children
  return Array.isArray(c) ? c : [c]
}

const base: EtiquetteEcruData = {
  numero: '3417/71',
  poids: 19.8,
  metier: '3E',
  ref: '029',
  coloris: 'ecru',
  date_ms: new Date(2026, 8, 11, 13, 14, 51).getTime(),
  second_choix: 0,
}

describe('EtiquetteEcruPdf', () => {
  it('prints the legacy fields: métier, n°, poids in Kg, réf · coloris, date', () => {
    const s = pdfStrings(EtiquetteEcruPdf({ data: [base] }))
    expect(s).toContain('3E')
    expect(s).toContain('3417/71')
    expect(s).toContain('19,80')
    expect(s).toContain('Kg')
    expect(s).toContain('029 · ecru')
    expect(s).toContain('11/09/2026 13:14:51')
    expect(s).not.toContain('DÉCLASSÉ')
  })

  it('marks a déclassé roll, and only a déclassé roll', () => {
    expect(pdfStrings(EtiquetteEcruPdf({ data: [{ ...base, second_choix: 1 }] }))).toContain('DÉCLASSÉ')
  })

  it('renders one page per roll', () => {
    expect(pages(EtiquetteEcruPdf({ data: [base, { ...base, numero: '3417/72' }] }))).toHaveLength(2)
  })

  it('uses black ink and bare paper only — a Dymo is a thermal printer', () => {
    const colours = new Set<string>()
    for (const style of Object.values(styles) as Record<string, unknown>[]) {
      for (const [k, v] of Object.entries(style)) {
        if (/color$/i.test(k) && typeof v === 'string') colours.add(v.toUpperCase())
      }
    }
    expect([...colours].sort()).toEqual([INK, PAPER].sort())
  })

  it('formats like the legacy: %5,2f with a French comma, JJ/MM/AAAA HH:mm:SS', () => {
    expect(fmtPoids(20.05)).toBe('20,05')
    expect(fmtPoids(12)).toBe('12,00')
    expect(fmtPoids(Number.NaN)).toBe('')
    expect(fmtDate(new Date(2026, 0, 5, 7, 3, 9).getTime())).toBe('05/01/2026 07:03:09')
    expect(fmtDate(null)).toBe('')
  })

  it('blanks a missing coloris instead of printing a dangling separator', () => {
    const s = pdfStrings(EtiquetteEcruPdf({ data: [{ ...base, coloris: '' }] }))
    expect(s).toContain('029')
    expect(s.some((x) => x.includes('·'))).toBe(false)
  })
})
