import { describe, it, expect } from 'vitest'
import { dansTranche, kgTranche, prixTranche } from './tranche-poids.js'

// MATEL « Coloration Simple Teinture » bands, as in the tariff (#1301).
const bandes = [
  { quantite_mini: 0, quantite_maxi: 15, prix: 17.83 },
  { quantite_mini: 16, quantite_maxi: 20, prix: 15.42 },
  { quantite_mini: 221, quantite_maxi: 240, prix: 5.78 },
  { quantite_mini: 241, quantite_maxi: 260, prix: 5.3 },
  { quantite_mini: 281, quantite_maxi: 300, prix: 4.92 },
  { quantite_mini: 301, quantite_maxi: 999999, prix: 4.82 },
]

describe('tranche-poids', () => {
  it('a weight between two bands stays in the lower one, as MATEL bills (#1301)', () => {
    expect(prixTranche(bandes, 240.7)).toBe(5.78)
    expect(prixTranche(bandes, 300.2)).toBe(4.92)
    expect(prixTranche(bandes, 20.3)).toBe(15.42)
    expect(prixTranche(bandes, 240.99)).toBe(5.78)
  })

  it('the band starts on its whole kilo', () => {
    expect(prixTranche(bandes, 241)).toBe(5.3)
    expect(prixTranche(bandes, 301)).toBe(4.82)
    expect(prixTranche(bandes, 16)).toBe(15.42)
  })

  it('a float sum just below a whole kilo is rounded to the gram first', () => {
    expect(kgTranche(240.9999999999)).toBe(241)
    expect(dansTranche(bandes[3], 0.1 + 0.2 + 240.7)).toBe(true)
  })

  it('small weights land in the first band, no band = 0', () => {
    expect(prixTranche(bandes, 0.4)).toBe(17.83)
    expect(prixTranche(bandes, 15.8)).toBe(17.83)
    expect(prixTranche(bandes, 100)).toBe(0)
  })
})
