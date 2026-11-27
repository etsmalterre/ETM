import { describe, expect, it } from 'vitest'
import { manqueStockDivers, messageStockInsuffisant, prisesNettes, stockDiversManquant } from './stock-divers-dispo.js'

describe('manqueStockDivers', () => {
  it('lets out what the stock holds, to the last unit', () => {
    expect(manqueStockDivers(6, 6)).toBe(0)
    expect(manqueStockDivers(6, 2.5)).toBe(0)
  })
  it('refuses beyond the stock, and says how much is missing', () => {
    expect(manqueStockDivers(0, 6)).toBe(6)
    expect(manqueStockDivers(4, 6)).toBe(2)
  })
  it('giving back is always allowed, even on an empty stock', () => {
    expect(manqueStockDivers(0, 0)).toBe(0)
    expect(manqueStockDivers(0, -3)).toBe(0)
  })
  it('a negative stock holds nothing (legacy rows): the whole quantity is missing', () => {
    expect(manqueStockDivers(-2, 3)).toBe(3)
  })
})

describe('prisesNettes', () => {
  it('adds up the moves on one article: a carton saved as it is takes nothing', () => {
    expect(prisesNettes([{ ref: 1, v1: 2, v2: 3, quantite: -5 }, { ref: 1, v1: 2, v2: 3, quantite: 5 }])).toEqual([])
  })
  it('keeps only what is taken out: an item moved to another article gives the first back', () => {
    expect(prisesNettes([{ ref: 1, v1: 0, v2: 0, quantite: -4 }, { ref: 1, v1: 7, v2: 0, quantite: 4 }]))
      .toEqual([{ ref: 1, v1: 7, v2: 0, quantite: 4 }])
  })
  it('a raised quantity takes the difference only', () => {
    expect(prisesNettes([{ ref: 1, v1: 0, v2: 0, quantite: -3 }, { ref: 1, v1: 0, v2: 0, quantite: 5 }]))
      .toEqual([{ ref: 1, v1: 0, v2: 0, quantite: 2 }])
  })
})

describe('messageStockInsuffisant', () => {
  it('names the article, what is on hand and what was asked', () => {
    expect(messageStockInsuffisant([{ libelle: 'Tissu Voltige ® · Rouge · 20 Mètres', enStock: 0, aPrendre: 6 }]))
      .toBe('Stock insuffisant pour Tissu Voltige ® · Rouge · 20 Mètres : 0 en stock, 6 à expédier.')
  })
  it('counts the other articles short of stock', () => {
    const m = messageStockInsuffisant([
      { libelle: 'A', enStock: 1, aPrendre: 2.5 }, { libelle: 'B', enStock: 0, aPrendre: 1 }, { libelle: 'C', enStock: 0, aPrendre: 1 },
    ])
    expect(m).toBe('Stock insuffisant pour A : 1 en stock, 2,5 à expédier (et 2 autres articles).')
  })
})

describe('stockDiversManquant', () => {
  it('an article without a stock row has nothing on hand', () => {
    expect(stockDiversManquant(undefined, 6)).toBe(true)
  })
  it('a line fully shipped misses nothing, whatever the stock', () => {
    expect(stockDiversManquant(0, 0)).toBe(false)
  })
  it('stock short of what is left to ship is missing; stock covering it is not', () => {
    expect(stockDiversManquant(5, 6)).toBe(true)
    expect(stockDiversManquant(6, 6)).toBe(false)
  })
})
