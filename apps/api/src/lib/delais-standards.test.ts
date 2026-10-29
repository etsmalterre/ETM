import { describe, expect, it } from 'vitest'
import { refusStandards, STANDARDS_DEFAUT, tricotageJours } from './delais-standards.js'

describe('delais-standards (doctrine des délais §2)', () => {
  it('reads the knitter band by kg, bounds included', () => {
    expect(tricotageJours(STANDARDS_DEFAUT, 200)).toBe(5)
    expect(tricotageJours(STANDARDS_DEFAUT, 500)).toBe(5)
    expect(tricotageJours(STANDARDS_DEFAUT, 501)).toBe(10)
    expect(tricotageJours(STANDARDS_DEFAUT, 1000)).toBe(10)
    expect(tricotageJours(STANDARDS_DEFAUT, 1500)).toBe(15)
  })
  it('refuses bands out of order and non-positive values', () => {
    expect(refusStandards(STANDARDS_DEFAUT)).toBeNull()
    expect(refusStandards({ ...STANDARDS_DEFAUT, tricot_seuil2_kg: 400 })).toMatch(/second seuil/)
    expect(refusStandards({ ...STANDARDS_DEFAUT, ennoblissement_jours: 0 })).toMatch(/positive/)
  })
})
