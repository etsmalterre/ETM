import { describe, it, expect } from 'vitest'
import {
  lireSaisieVrillage, VrillageInvalide, vrillageConforme, verdictLot, verdictLigne, vrillagesDesObservations,
  type VrillagesLot,
} from './vrillage.js'

const lot = (p: Partial<VrillagesLot>): VrillagesLot => ({ colonnesSst: null, rangsSst: null, colonnesTirelle: null, rangsTirelle: null, ...p })

describe('lireSaisieVrillage', () => {
  it('empty = not measured, 0 is a measure', () => {
    expect(lireSaisieVrillage('vrillage_colonnes_tirelle', '')).toBeNull()
    expect(lireSaisieVrillage('vrillage_colonnes_tirelle', null)).toBeNull()
    expect(lireSaisieVrillage('vrillage_colonnes_tirelle', '0')).toBe(0)
    expect(lireSaisieVrillage('vrillage_colonnes_tirelle', '4,5')).toBe(4.5)
    expect(lireSaisieVrillage('vrillage_colonnes_tirelle', '5 %')).toBe(5)
  })
  it('refuses a negative or absurd value', () => {
    expect(() => lireSaisieVrillage('vrillage_rangs_sst', '-2')).toThrow(VrillageInvalide)
    expect(() => lireSaisieVrillage('vrillage_rangs_sst', '150')).toThrow(VrillageInvalide)
    expect(() => lireSaisieVrillage('vrillage_rangs_sst', 'abc')).toThrow(VrillageInvalide)
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

describe('verdictLot', () => {
  it('needs our tirelle measure', () => {
    expect(verdictLot(lot({}))).toBe('non_controle')
    expect(verdictLot(lot({ colonnesSst: 4 }))).toBe('non_controle')
    expect(verdictLot(lot({ colonnesTirelle: 5 }))).toBe('conforme')
    expect(verdictLot(lot({ rangsTirelle: 0 }))).toBe('conforme')
  })
  it('any side out of tolerance is non conforme', () => {
    expect(verdictLot(lot({ colonnesSst: 7 }))).toBe('non_conforme')
    expect(verdictLot(lot({ colonnesTirelle: 3, rangsTirelle: 6 }))).toBe('non_conforme')
  })
})

describe('verdictLigne', () => {
  it('one bad lot spoils the line, all good lots make it conforme', () => {
    expect(verdictLigne([])).toBe('non_controle')
    expect(verdictLigne([lot({ colonnesTirelle: 3 }), lot({ colonnesTirelle: 5 })])).toBe('conforme')
    expect(verdictLigne([lot({ colonnesTirelle: 3 }), lot({})])).toBe('non_controle')
    expect(verdictLigne([lot({ colonnesTirelle: 3 }), lot({ colonnesTirelle: 8 })])).toBe('non_conforme')
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
