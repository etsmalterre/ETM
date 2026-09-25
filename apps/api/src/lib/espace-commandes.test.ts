import { describe, expect, it } from 'vitest'
import { isoDate, statutCommande, statutLigne } from './espace-commandes.js'

describe('statutLigne', () => {
  it('reads nothing shipped as « à venir », including an unmeasurable line', () => {
    expect(statutLigne(800, 0)).toBe('a_venir')
    expect(statutLigne(800, null)).toBe('a_venir')
  })
  it('counts a line shipped from 95 % (rolls never add up to the exact metre)', () => {
    expect(statutLigne(800, 759)).toBe('partielle')
    expect(statutLigne(800, 760)).toBe('expediee')
    expect(statutLigne(800, 854)).toBe('expediee')
  })
})

describe('statutCommande', () => {
  it('soldée wins whatever shipped', () => {
    expect(statutCommande(true, ['a_venir'])).toBe('soldee')
  })
  it('expédiée only when every line is', () => {
    expect(statutCommande(false, ['expediee', 'expediee'])).toBe('expediee')
    expect(statutCommande(false, ['expediee', 'a_venir'])).toBe('partielle')
    expect(statutCommande(false, ['partielle'])).toBe('partielle')
    expect(statutCommande(false, ['a_venir', 'a_venir'])).toBe('en_cours')
    expect(statutCommande(false, [])).toBe('en_cours')
  })
})

describe('isoDate', () => {
  it('turns HFSQL YYYYMMDD into ISO and drops empties', () => {
    expect(isoDate('20260925')).toBe('2026-09-25')
    expect(isoDate('20260925143000')).toBe('2026-09-25')
    expect(isoDate('')).toBeNull()
    expect(isoDate('00000000')).toBeNull()
    expect(isoDate(null)).toBeNull()
  })
})
