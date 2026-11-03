import { describe, it, expect } from 'vitest'
import { lireSaisieVrillage, VrillageInvalide, vrillageConforme, vrillagesDesObservations } from './vrillage.js'

describe('lireSaisieVrillage', () => {
  it('empty = not measured, 0 is a measure', () => {
    expect(lireSaisieVrillage('vrillage_tirelle', '')).toBeNull()
    expect(lireSaisieVrillage('vrillage_tirelle', null)).toBeNull()
    expect(lireSaisieVrillage('vrillage_tirelle', '0')).toBe(0)
    expect(lireSaisieVrillage('vrillage_tirelle', '4,5')).toBe(4.5)
    expect(lireSaisieVrillage('vrillage_tirelle', '5 %')).toBe(5)
  })
  it('refuses a negative or absurd value', () => {
    expect(() => lireSaisieVrillage('vrillage_sst', '-2')).toThrow(VrillageInvalide)
    expect(() => lireSaisieVrillage('vrillage_sst', '150')).toThrow(VrillageInvalide)
    expect(() => lireSaisieVrillage('vrillage_sst', 'abc')).toThrow(VrillageInvalide)
  })
})

describe('tolerance', () => {
  it('5 % included', () => {
    expect(vrillageConforme(5)).toBe(true)
    expect(vrillageConforme(5.1)).toBe(false)
    expect(vrillageConforme(0)).toBe(true)
    expect(vrillageConforme(null)).toBeNull()
  })
})

describe('vrillagesDesObservations (prod texts, 2026-10)', () => {
  it('reads both habits', () => {
    expect(vrillagesDesObservations('Léger roulottage\nVrillage = 5%\nM V 5 %')).toEqual({ tirelle: 5, sst: 5 })
    expect(vrillagesDesObservations('MV 5%\nLéger roulottage\nVrillage = 5%')).toEqual({ tirelle: 5, sst: 5 })
    expect(vrillagesDesObservations('M V 4%')).toEqual({ tirelle: null, sst: 4 })
    expect(vrillagesDesObservations('Vrillage = 19%')).toEqual({ tirelle: 19, sst: null })
  })
  it('reads the older 2026 wording', () => {
    expect(vrillagesDesObservations('vrillage mesuré matel : 5 %\nLéger roulottage\nV = 8%')).toEqual({ tirelle: 8, sst: 5 })
    expect(vrillagesDesObservations('Très léger vrillage')).toEqual({ tirelle: null, sst: null })
  })
  it('keeps the worst value of a range', () => {
    expect(vrillagesDesObservations('Vrillage = 5 à 7%').tirelle).toBe(7)
    expect(vrillagesDesObservations('Vrillage = 11 à 14%').tirelle).toBe(14)
    expect(vrillagesDesObservations('Léger roulottage\nVrillage = 8 à 10%\nM V 4 %')).toEqual({ tirelle: 10, sst: 4 })
  })
  it('ignores other percentages', () => {
    expect(vrillagesDesObservations('Traces?\nVrillage = 6%\n19.4%     13.1%')).toEqual({ tirelle: 6, sst: null })
    expect(vrillagesDesObservations('Pli marchand')).toEqual({ tirelle: null, sst: null })
  })
})
