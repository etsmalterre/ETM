import { describe, expect, it } from 'vitest'
import { commandesParAnnee, correctionInventaire, normaliserLibelle, repartirSortie } from './fournitures-trm.js'

describe('normaliserLibelle', () => {
  it('trims and collapses whitespace, keeps the case', () => {
    expect(normaliserLibelle('  Vota LS   83.41  G003 ')).toBe('Vota LS 83.41 G003')
    expect(normaliserLibelle('Vo\t65.48\nG011')).toBe('Vo 65.48 G011')
    expect(normaliserLibelle('SAN SF126.52 G001')).toBe('SAN SF126.52 G001')
  })
})

describe('repartirSortie', () => {
  const GROZ = 1
  const SAMSUNG = 2

  it('takes from the constructeur own stock first', () => {
    expect(repartirSortie([{ constructeur: GROZ, stock: 500 }, { constructeur: null, stock: 300 }], GROZ, 250)).toEqual([
      { constructeur: GROZ, quantite: 250 },
    ])
  })

  it('then from the unsplit stock', () => {
    expect(repartirSortie([{ constructeur: GROZ, stock: 100 }, { constructeur: null, stock: 300 }], GROZ, 250)).toEqual([
      { constructeur: GROZ, quantite: 100 },
      { constructeur: null, quantite: 150 },
    ])
  })

  it('takes everything from the unsplit stock when the constructeur has none', () => {
    expect(repartirSortie([{ constructeur: null, stock: 300 }], SAMSUNG, 250)).toEqual([
      { constructeur: null, quantite: 250 },
    ])
  })

  it('never refuses: the shortfall goes negative on the constructeur', () => {
    expect(repartirSortie([{ constructeur: GROZ, stock: 50 }, { constructeur: null, stock: 100 }], GROZ, 250)).toEqual([
      { constructeur: GROZ, quantite: 150 },
      { constructeur: null, quantite: 100 },
    ])
    expect(repartirSortie([], GROZ, 250)).toEqual([{ constructeur: GROZ, quantite: 250 }])
  })

  it('ignores negative buckets as available stock', () => {
    expect(repartirSortie([{ constructeur: GROZ, stock: -20 }, { constructeur: null, stock: -5 }], GROZ, 10)).toEqual([
      { constructeur: GROZ, quantite: 10 },
    ])
  })

  it('without a constructeur, takes from the unsplit stock', () => {
    expect(repartirSortie([{ constructeur: GROZ, stock: 500 }], null, 80)).toEqual([{ constructeur: null, quantite: 80 }])
  })

  it('takes nothing for a zero or negative quantity', () => {
    expect(repartirSortie([{ constructeur: GROZ, stock: 500 }], GROZ, 0)).toEqual([])
  })
})

describe('correctionInventaire', () => {
  it('is counted minus current', () => {
    expect(correctionInventaire(300, 250)).toBe(-50)
    expect(correctionInventaire(-40, 0)).toBe(40)
    expect(correctionInventaire(120, 120)).toBe(0)
  })
})

describe('commandesParAnnee', () => {
  it('sums the entries per calendar year, ignoring other movements', () => {
    expect(
      commandesParAnnee([
        { type: 'entree', quantite: 250, date: '2025-12-31' },
        { type: 'entree', quantite: 500, date: '2025-03-01' },
        { type: 'entree', quantite: 250, date: '2026-03-20' },
        { type: 'sortie', quantite: -250, date: '2026-04-01' },
        { type: 'inventaire', quantite: 40, date: '2026-10-07' },
      ]),
    ).toEqual({ '2025': 750, '2026': 250 })
  })
})
