import { describe, it, expect } from 'vitest'
import { matchCodeSp, defaultCommandeClient, missingMesures, lotDigits } from './etiquettes-sp.js'

// A slice of the real code_sp list (dev base, 2026-09-24).
const CODES = [
  { IDcode_sp: 1, coloris: '11 BLANC' },
  { IDcode_sp: 12, coloris: '739 PEAU' },
  { IDcode_sp: 6, coloris: '740 PEAU' },
  { IDcode_sp: 52, coloris: '469 ROSE FUMÉ' },
  { IDcode_sp: 25, coloris: '300 ROSE' },
  { IDcode_sp: 36, coloris: '394 ROSE' },
]

describe('matchCodeSp', () => {
  it('matches the order line coloris by its number', () => {
    // The order line of LIVA #1200's example reads « 469 rose fumé 63424/1 ».
    expect(matchCodeSp('469 rose fumé 63424/1', CODES)).toBe(52)
    expect(matchCodeSp('739 PEAU', CODES)).toBe(12)
  })
  it('ignores leading zeros', () => {
    expect(matchCodeSp('011 BLANC', CODES)).toBe(1)
  })
  it('falls back to the folded label, and to 0 when nothing fits', () => {
    expect(matchCodeSp('ROSE FUME', [{ IDcode_sp: 9, coloris: 'Rose fumé' }])).toBe(9)
    expect(matchCodeSp('999 VERT', CODES)).toBe(0)
  })
})

describe('defaultCommandeClient', () => {
  it('drops the « Commande » prefix and upper-cases like the legacy label', () => {
    expect(defaultCommandeClient('Commande A3-57378 du 16/10/2025')).toBe('A3-57378 DU 16/10/2025')
    expect(defaultCommandeClient('Cde n° A1-58690')).toBe('A1-58690')
    expect(defaultCommandeClient('A3-57179 DU 30/07/2025')).toBe('A3-57179 DU 30/07/2025')
  })
})

describe('missingMesures', () => {
  it('lists what a roll still lacks', () => {
    expect(missingMesures(null)).toEqual(['métrage brut', 'métrage net', 'laize', 'poids'])
    expect(missingMesures({ brut: 108.7, net: 108.3, laizeCm: 162, tare: 4, poids: 20.51 })).toEqual([])
    // Tare 0 is a valid answer (no defect).
    expect(missingMesures({ brut: 106.3, net: 106.3, laizeCm: 161, tare: 0, poids: 19 })).toEqual([])
  })
  it('refuses a net length above the gross one', () => {
    expect(missingMesures({ brut: 100, net: 101, laizeCm: 160, tare: 0, poids: 19 })).toEqual(['net supérieur au brut'])
  })
})

describe('lotDigits', () => {
  it('keeps the dyer lot number', () => {
    expect(lotDigits('ma107052')).toBe('107052')
    expect(lotDigits('MA106910')).toBe('106910')
  })
})
