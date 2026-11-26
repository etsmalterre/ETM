import { describe, expect, it } from 'vitest'
import { lireSaisieDelai, lireSaisieEntier, lireSaisieMesures, RefusSaisie } from './espace-partenaire-saisies.js'

const code = (fn: () => unknown) => {
  try { fn() } catch (e) { return e instanceof RefusSaisie ? e.code : 'autre' }
  return null
}

describe('the délai a partner types', () => {
  const jour = '2026-11-26'
  it('a real date, from today, at most six months ahead', () => {
    expect(lireSaisieDelai('2026-11-26', jour)).toBe('2026-11-26')
    expect(lireSaisieDelai(' 2026-12-15 ', jour)).toBe('2026-12-15')
    expect(code(() => lireSaisieDelai('2026-11-25', jour))).toBe('delai_passe')
    expect(code(() => lireSaisieDelai('2027-06-01', jour))).toBe('delai_lointain')
  })
  it('refuses what is not a date', () => {
    for (const v of ['', '15/12/2026', '2026-02-30', '2026-13-01', null, 20261215]) expect(code(() => lireSaisieDelai(v, jour))).toBe('delai_invalide')
  })
})

describe('the measures a partner types', () => {
  const avant = { laize: 154, poids: 0, stabH: -3, stabL: null, vrillage: null }
  const toutes = ['laize', 'poids', 'stabH', 'stabL', 'vrillage'] as const
  it('a laize or a poids is a whole number, empty = not measured', () => {
    expect(lireSaisieEntier('152,6', 'La laize', 400, 'cm')).toBe(153)
    expect(lireSaisieEntier('', 'La laize', 400, 'cm')).toBe(0)
    expect(lireSaisieEntier(null, 'La laize', 400, 'cm')).toBe(0)
    expect(code(() => lireSaisieEntier('0', 'La laize', 400, 'cm'))).toBe('mesure_invalide')
    expect(code(() => lireSaisieEntier('1520', 'La laize', 400, 'cm'))).toBe('mesure_invalide')
    expect(code(() => lireSaisieEntier('large', 'La laize', 400, 'cm'))).toBe('mesure_invalide')
  })
  it('a measure left out keeps its value, an empty one erases it', () => {
    expect(lireSaisieMesures({ poids: '166' }, avant, toutes)).toEqual({ ...avant, poids: 166 })
    expect(lireSaisieMesures({ laize: '', stabH: '' }, avant, toutes)).toEqual({ ...avant, laize: 0, stabH: null })
  })
  it('a stabilité of 0 and a vrillage of 0 are measures', () => {
    expect(lireSaisieMesures({ stabL: '0', vrillage: 0 }, avant, toutes)).toEqual({ ...avant, stabL: 0, vrillage: 0 })
    expect(lireSaisieMesures({ vrillage: '4,25 %' }, avant, toutes).vrillage).toBe(4.3)
  })
  it('only the measures the reference asks are read', () => {
    expect(lireSaisieMesures({ laize: 150, stabH: -9, vrillage: 2 }, avant, ['laize', 'poids'])).toEqual({ ...avant, laize: 150 })
  })
  it('the typo guards of Suivi lots apply', () => {
    expect(code(() => lireSaisieMesures({ stabH: 75 }, avant, toutes))).toBe('mesure_invalide')
    expect(code(() => lireSaisieMesures({ vrillage: -1 }, avant, toutes))).toBe('mesure_invalide')
  })
})
