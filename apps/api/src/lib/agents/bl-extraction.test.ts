import { describe, expect, it } from 'vitest'
import { composantsDe, controlerExtraction, estBloquant, fusionnerPages, lotDuBordereau, normaliserExtraction } from './bl-extraction.js'

// Shapes taken from the 2026-09-22 benchmark (real MATEL BLs from ged).
const bl109152 = {
  numero_commande: '8964',
  numero_bordereau: '109152 A',
  ligne: 1,
  pieces: [
    { numero_piece: '3505/14', poids: 21.6, metrage: 109.8, observations: '3 défauts' },
    { numero_piece: '3505/15', poids: 21.5, metrage: 105.5, observations: 'Tirelles, 4 défauts' },
    { numero_piece: '3505/16', poids: 21.6, metrage: 108.9, observations: '1 trou' },
    { numero_piece: '3505/17', poids: 21.5, metrage: 110.2, observations: '4 défauts, 1 tache, 1 trou' },
  ],
  nombre_pieces: 4,
  poids_total: 86.2,
  metrage_total: 434.4,
}

describe('composantsDe', () => {
  it('keeps a single piece', () => expect(composantsDe('3505/14')).toEqual(['3505/14']))
  it('splits a merged roll', () => expect(composantsDe('3510/11+3510/2')).toEqual(['3510/11', '3510/2']))
  it('expands the shorthand on the previous OF', () => {
    expect(composantsDe('3067/17+3')).toEqual(['3067/17', '3067/3'])
    expect(composantsDe('3067/8+3377/16+3532/1')).toEqual(['3067/8', '3377/16', '3532/1'])
  })
  it('keeps a cut suffix', () => expect(composantsDe('3499/4-1')).toEqual(['3499/4-1']))
})

describe('normaliserExtraction', () => {
  it('strips spaces from the bordereau and uppercases it', () => {
    expect(normaliserExtraction(bl109152).numero_bordereau).toBe('109152A')
  })
  it('accepts French decimal strings (the n8n prompt returned "19,30")', () => {
    const e = normaliserExtraction({ ...bl109152, pieces: [{ numero_piece: '1/1', poids: '19,30', metrage: '68,80', observations: '' }] })
    expect(e.pieces[0].poids).toBe(19.3)
    expect(e.pieces[0].metrage).toBe(68.8)
  })
  it('writes the expanded merged numero', () => {
    const e = normaliserExtraction({ ...bl109152, pieces: [{ numero_piece: '3532/2+3', poids: 20.6, metrage: 58, observations: '' }] })
    expect(e.pieces[0].numero_piece).toBe('3532/2+3532/3')
  })
  it('never throws on garbage', () => {
    expect(normaliserExtraction(null).pieces).toEqual([])
  })
})

describe('lotDuBordereau', () => {
  it('drops the letter like the n8n workflow', () => expect(lotDuBordereau('109152A')).toBe('MA109152'))
  it('handles the older layout without a letter', () => expect(lotDuBordereau('108914')).toBe('MA108914'))
  it('returns empty on an unreadable number', () => expect(lotDuBordereau('')).toBe(''))
})

describe('controlerExtraction', () => {
  it('passes a clean BL', () => {
    expect(controlerExtraction(normaliserExtraction(bl109152))).toEqual([])
  })
  it('blocks the OCR misread « SS69 » (ged 10572)', () => {
    const cs = controlerExtraction(normaliserExtraction({ ...bl109152, numero_commande: 'SS69' }))
    expect(cs.map((c) => c.code)).toContain('commande_format')
    expect(estBloquant(cs)).toBe(true)
  })
  it('blocks a garbled piece number (« 349/01+349/05 » is well-formed, « 3496/l » is not)', () => {
    const cs = controlerExtraction(normaliserExtraction({ ...bl109152, pieces: [{ ...bl109152.pieces[0], numero_piece: '3496/l' }] }))
    expect(cs.map((c) => c.code)).toContain('piece_format')
  })
  it('blocks when the weights do not add up to the printed total', () => {
    const cs = controlerExtraction(normaliserExtraction({ ...bl109152, poids_total: 90 }))
    expect(cs.map((c) => c.code)).toEqual(['total_poids'])
  })
  it('only warns when the BL announces another piece count (ged 10713: « Nbre roules 10 », 11 rows)', () => {
    const cs = controlerExtraction(normaliserExtraction({ ...bl109152, nombre_pieces: 3 }))
    expect(cs.map((c) => c.code)).toEqual(['total_nombre'])
    expect(estBloquant(cs)).toBe(false)
  })
  it('warns when no total is printed', () => {
    const cs = controlerExtraction(normaliserExtraction({ ...bl109152, nombre_pieces: null, poids_total: null, metrage_total: null }))
    expect(cs.map((c) => c.code)).toEqual(['totaux_absents'])
  })
  it('blocks a piece listed twice, also inside a merged roll', () => {
    const cs = controlerExtraction(
      normaliserExtraction({
        ...bl109152,
        poids_total: null,
        metrage_total: null,
        pieces: [bl109152.pieces[0], { ...bl109152.pieces[1], numero_piece: '3505/15+3505/14' }],
      }),
    )
    expect(cs.map((c) => c.code)).toContain('piece_double')
  })
})

describe('controlerExtraction — piece cut by the dyer (ged 10058, BL 107841A)', () => {
  const coupe = {
    ...bl109152,
    nombre_pieces: 2,
    poids_total: 21.1,
    metrage_total: 105,
    pieces: [
      { numero_piece: '3351/18', poids: 0, metrage: 40, observations: 'Client' },
      { numero_piece: '3351/18', poids: 21.1, metrage: 65, observations: 'Tirelles, 1 FC, 1 tache' },
    ],
  }
  it('only warns', () => {
    const cs = controlerExtraction(normaliserExtraction(coupe))
    expect(cs.map((c) => c.code)).toEqual(['piece_coupee'])
    expect(estBloquant(cs)).toBe(false)
  })
  it('still blocks an unweighed piece that is not a cut', () => {
    const cs = controlerExtraction(normaliserExtraction({ ...coupe, poids_total: null, metrage_total: null, pieces: [coupe.pieces[0]] }))
    expect(cs.map((c) => c.code)).toContain('piece_poids')
  })
  it('still blocks the same number printed twice with two weights', () => {
    const cs = controlerExtraction(
      normaliserExtraction({ ...coupe, poids_total: null, metrage_total: null, pieces: [coupe.pieces[1], coupe.pieces[1]] }),
    )
    expect(cs.map((c) => c.code)).toContain('piece_double')
  })
})

describe('fusionnerPages', () => {
  // ged 10620 + 10621: one BL scanned as two attachments, totals on page 2 only.
  const page1 = normaliserExtraction({
    ...bl109152,
    pieces: bl109152.pieces.slice(0, 3),
    nombre_pieces: null,
    poids_total: null,
    metrage_total: null,
  })
  const page2 = normaliserExtraction({ ...bl109152, pieces: bl109152.pieces.slice(3) })
  it('joins the pages of the same bordereau and keeps the printed totals', () => {
    const [m, ...rest] = fusionnerPages([page1, page2])
    expect(rest).toEqual([])
    expect(m.pieces).toHaveLength(4)
    expect(m.poids_total).toBe(86.2)
    expect(controlerExtraction(m)).toEqual([])
  })
  it('keeps different bordereaux apart', () => {
    const other = normaliserExtraction({ ...bl109152, numero_bordereau: '109153A' })
    expect(fusionnerPages([page1, other])).toHaveLength(2)
  })
})
