import { describe, expect, it } from 'vitest'
import { delaiTexte, evaluerAffectationFil, evaluerCouverture, evaluerEnnoblissement, evaluerFil, joursAvant } from './regles.js'

const today = new Date(2026, 8, 23) // Wed 23/09/2026

describe('joursAvant', () => {
  it('counts days from today, null on a non-date', () => {
    expect(joursAvant('20260930', today)).toBe(7)
    expect(joursAvant('20260923', today)).toBe(0)
    expect(joursAvant('20260912', today)).toBe(-11)
    expect(joursAvant('', today)).toBeNull()
    expect(joursAvant(null, today)).toBeNull()
  })
  it('writes the délai for a human', () => {
    expect(delaiTexte('20260930', 7)).toBe('le 30/09 (dans 7 j)')
    expect(delaiTexte('20260912', -11)).toBe('le 12/09 (dépassé de 11 j)')
  })
})

describe('evaluerCouverture', () => {
  const l = (o: Partial<Parameters<typeof evaluerCouverture>[0]>) =>
    evaluerCouverture({ quantite: 1000, unite: 3, affecte: 0, expedie: 0, dateLivraison: '20260930', ...o }, today)

  it('flags an uncovered line due within 21 days, urgent within 7', () => {
    expect(l({})).toEqual({ gravite: 'urgent', jours: 7, manque: 1000 })
    expect(l({ dateLivraison: '20261010' })?.gravite).toBe('attention')
    expect(l({ dateLivraison: '20261020' })).toBeNull() // beyond the horizon
  })
  it('accepts a line covered at 90 %, or shipped', () => {
    expect(l({ affecte: 900 })).toBeNull()
    expect(l({ affecte: 899 })?.manque).toBe(101)
    expect(l({ expedie: 980 })).toBeNull()
  })
  it('ignores stale délais, lines without délai, and units other than Kg / Ml', () => {
    expect(l({ dateLivraison: '20260901' })?.gravite).toBe('urgent') // 22 days late: still actionable
    expect(l({ dateLivraison: '20260801' })).toBeNull() // 53 days late: stale
    expect(l({ dateLivraison: '' })).toBeNull()
    expect(l({ unite: 4 })).toBeNull()
  })
})

describe('evaluerEnnoblissement', () => {
  it('flags écru not sent to the dyer when the délai is within 30 days', () => {
    expect(evaluerEnnoblissement(120, '20261010', today)).toEqual({ gravite: 'attention', jours: 17 })
    expect(evaluerEnnoblissement(120, '20261001', today)?.gravite).toBe('urgent')
    expect(evaluerEnnoblissement(120, '20261130', today)).toBeNull()
    expect(evaluerEnnoblissement(0, '20261001', today)).toBeNull()
  })
})

describe('evaluerFil', () => {
  it('tolerates rounding, flags a real deficit', () => {
    expect(evaluerFil(-0.7)).toBeNull()
    expect(evaluerFil(12)).toBeNull()
    expect(evaluerFil(-20)).toEqual({ gravite: 'attention', manque: 20 })
    expect(evaluerFil(-80)?.gravite).toBe('urgent')
  })
})

describe('evaluerAffectationFil', () => {
  it('gives the office a day after the order', () => {
    expect(evaluerAffectationFil(1, '20260923', today)).toBeNull()
    expect(evaluerAffectationFil(1, '20260922', today)).toBe('attention')
    expect(evaluerAffectationFil(0, '20260901', today)).toBeNull()
    expect(evaluerAffectationFil(2, '', today)).toBe('attention')
  })
})
