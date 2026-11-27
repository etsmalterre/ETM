import { describe, expect, it } from 'vitest'
import { compterLieux, lieuxTries, nomLieu, refusLieux } from './lieu-expedition.js'

const NOMS = new Map<number, string>([[9, 'MATEL'], [12, 'Société Bontemps']])
const lieux = (...paires: [number, number][]) => new Map<number, number>(paires)

describe('a place and its name', () => {
  it('magasin 0 is the factory, « Malterre »', () => {
    expect(nomLieu(0, NOMS)).toBe('Malterre')
    expect(nomLieu(9, NOMS)).toBe('MATEL')
    expect(nomLieu(77, NOMS)).toBe('magasin 77')
  })

  it('an empty magasin counts at the factory', () => {
    expect(compterLieux([9, 9, 0, null, undefined, '9'])).toEqual(lieux([9, 3], [0, 3]))
  })

  it('lists the fullest place first', () => {
    expect(lieuxTries(lieux([0, 2], [9, 32]), NOMS)).toEqual([
      { id: 9, nom: 'MATEL', rouleaux: 32 },
      { id: 0, nom: 'Malterre', rouleaux: 2 },
    ])
  })
})

describe('one avis, one place', () => {
  it('lets rolls of one place go, on a new avis or on theirs', () => {
    expect(refusLieux(lieux(), lieux([9, 34]), NOMS)).toBeNull()
    expect(refusLieux(lieux([9, 32]), lieux([9, 1]), NOMS)).toBeNull()
    expect(refusLieux(lieux([0, 2]), lieux(), NOMS)).toBeNull()
    expect(refusLieux(lieux(), lieux(), NOMS)).toBeNull()
  })

  it('refuses a new avis whose rolls sit in two places, and names them (avis 12548)', () => {
    const refus = refusLieux(lieux(), lieux([9, 32], [0, 2]), NOMS)
    expect(refus?.error).toBe('lieux_multiples')
    expect(refus?.message).toBe(
      'Ces rouleaux ne sont pas au même endroit (MATEL × 32, Malterre × 2) : faites une expédition par lieu.',
    )
  })

  it('refuses a roll that is not where the avis leaves from', () => {
    expect(refusLieux(lieux([9, 32]), lieux([0, 1]), NOMS)?.message).toBe(
      "Ce rouleau est chez Malterre, l'expédition part de chez MATEL : faites une expédition par lieu.",
    )
    expect(refusLieux(lieux([0, 2]), lieux([9, 1], [12, 2], [0, 1]), NOMS)?.message).toBe(
      "L'expédition part de chez Malterre, ces rouleaux sont ailleurs (Société Bontemps × 2, MATEL × 1) : faites une expédition par lieu.",
    )
  })

  it('an avis already mixed takes nothing more', () => {
    expect(refusLieux(lieux([9, 4], [0, 3]), lieux([9, 1]), NOMS)?.message).toContain('MATEL × 5, Malterre × 3')
  })
})
