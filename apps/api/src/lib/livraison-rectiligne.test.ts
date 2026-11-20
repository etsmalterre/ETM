import { describe, expect, it } from 'vitest'
import { arrondiQuantite, libelleQuantite, ligneLivree, normaliserLivraison, resteALivrer } from './livraison-rectiligne.js'

// Commande TRM 2925 (LIVA #1381): 7 lignes de cols et de bandes.
const LIGNES = [
  { IDligne_commande_client: 101, type_kind: 4 }, // R006-38 blanc, 26 U
  { IDligne_commande_client: 102, type_kind: 4 }, // R006-46 blanc, 26 U
  { IDligne_commande_client: 103, type_kind: 4 }, // R002 blanc, 170 U
  { IDligne_commande_client: 104, type_kind: 1 }, // a roll line on the same order
]

describe('resteALivrer / ligneLivree', () => {
  it('nothing delivered: everything remains', () => {
    expect(resteALivrer(149, 0)).toBe(149)
    expect(ligneLivree(149, 0)).toBe(false)
  })
  it('a partial delivery leaves the difference', () => {
    expect(resteALivrer(149, 26)).toBe(123)
    expect(ligneLivree(149, 26)).toBe(false)
  })
  it('the line is delivered at the ordered quantity, and stays so above it', () => {
    expect(ligneLivree(26, 26)).toBe(true)
    expect(ligneLivree(26, 28)).toBe(true)
    expect(resteALivrer(26, 28)).toBe(0)
  })
  it('a line ordered at 0 is never delivered', () => {
    expect(ligneLivree(0, 0)).toBe(false)
    expect(ligneLivree(0, 5)).toBe(false)
  })
  it('float noise does not leave a phantom remainder (R005 is sold by the Kg)', () => {
    expect(resteALivrer(12.3, 12.1 + 0.2)).toBe(0)
    expect(ligneLivree(12.3, 12.1 + 0.2)).toBe(true)
    expect(arrondiQuantite('abc')).toBe(0)
  })
})

describe('normaliserLivraison', () => {
  it('keeps the lines with a quantity, in the order of the order', () => {
    const r = normaliserLivraison(
      [{ IDligne_commande_client: 103, quantite: 50 }, { IDligne_commande_client: 101, quantite: 26 }],
      LIGNES,
    )
    expect(r).toEqual({
      ok: true,
      lignes: [{ IDligne_commande_client: 101, quantite: 26 }, { IDligne_commande_client: 103, quantite: 50 }],
    })
  })
  it('drops empty and negative entries, adds up a line asked twice', () => {
    const r = normaliserLivraison(
      [
        { IDligne_commande_client: 101, quantite: 10 },
        { IDligne_commande_client: 102, quantite: 0 },
        { IDligne_commande_client: 103, quantite: -4 },
        { IDligne_commande_client: 101, quantite: 16 },
      ],
      LIGNES,
    )
    expect(r).toEqual({ ok: true, lignes: [{ IDligne_commande_client: 101, quantite: 26 }] })
  })
  it('refuses a delivery with no quantity at all', () => {
    const r = normaliserLivraison([{ IDligne_commande_client: 101, quantite: 0 }], LIGNES)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('livraison_vide')
  })
  it('refuses a line of another order', () => {
    const r = normaliserLivraison([{ IDligne_commande_client: 999, quantite: 3 }], LIGNES)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('ligne_inconnue')
  })
  it('refuses a roll line: rolls leave from the Affectation tab, weighed', () => {
    const r = normaliserLivraison([{ IDligne_commande_client: 104, quantite: 3 }], LIGNES)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('ligne_non_rectiligne')
  })
  it('accepts more than the remainder: the batch decides, not the order', () => {
    const r = normaliserLivraison([{ IDligne_commande_client: 101, quantite: 30 }], LIGNES)
    expect(r.ok).toBe(true)
  })
})

describe('libelleQuantite', () => {
  it('counts pieces, singular and plural', () => {
    expect(libelleQuantite(1, 4)).toBe('1 pièce')
    expect(libelleQuantite(26, 4)).toBe('26 pièces')
    expect(libelleQuantite(1490, 4)).toBe('1 490 pièces')
  })
  it('a reference sold by weight reads in Kg', () => {
    expect(libelleQuantite(12.5, 1)).toBe('12,5 Kg')
  })
})
