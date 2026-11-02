import { describe, it, expect } from 'vitest'
import { memeArticle, raisonRefus } from './enno-autres-lignes.js'

// Agape 3858 + 3892 (2026-11-02): both fini lines of 228/122 - 2005 DTM Black Lace 61735/2.
const BLACK_LACE = { ref: 228, coloris: 61735 }

describe('memeArticle', () => {
  it('takes a fini line of the same reference and coloris', () => {
    expect(memeArticle({ type: 2, ...BLACK_LACE }, BLACK_LACE)).toBe(true)
  })
  it('refuses another coloris, another reference, an écru line', () => {
    expect(memeArticle({ type: 2, ref: 228, coloris: 1 }, BLACK_LACE)).toBe(false)
    expect(memeArticle({ type: 2, ref: 229, coloris: 61735 }, BLACK_LACE)).toBe(false)
    expect(memeArticle({ type: 1, ...BLACK_LACE }, BLACK_LACE)).toBe(false)
  })
  it('refuses a line still waiting for its étude coloris (no coloris)', () => {
    expect(memeArticle({ type: 2, ref: 228, coloris: 0 }, BLACK_LACE)).toBe(false)
  })
})

describe('raisonRefus', () => {
  it('lets a validated, open order of the same article send its pieces', () => {
    expect(raisonRefus({ memeArticle: true, enPreparation: false, soldee: false })).toBeNull()
  })
  it('says why otherwise', () => {
    expect(raisonRefus({ memeArticle: false, enPreparation: false, soldee: false })).toBe('réservée pour un autre article')
    expect(raisonRefus({ memeArticle: true, enPreparation: true, soldee: false })).toBe('commande en préparation')
    expect(raisonRefus({ memeArticle: true, enPreparation: false, soldee: true })).toBe('commande soldée')
  })
})
