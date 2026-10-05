import { describe, expect, it } from 'vitest'
import type { PrixBreakdown } from '../../pricing-sst.js'
import { recette } from './recette.js'

const noms = {
  traitement: (id: number) => ({ 285: 'Lavage', 287: 'Préfixation', 291: 'Rame' } as Record<number, string>)[id] ?? `traitement ${id}`,
  teinture: (id: number) => ({ 7: 'Coloration Simple Teinture', 12: 'Coloration Double Teinture' } as Record<number, string>)[id] ?? `teinture ${id}`,
}
const bd = (o: Partial<PrixBreakdown>): PrixBreakdown => ({
  IDsous_traitant: 9, xPoids: 14.3, rendement: 3, avec_teinture: 0, IDteinture: 0, matel_multiplier: 1,
  base: null, treatments: [], unpriced_treatments: [], total: 0, ...o,
})

describe('the price recipe shown on an expanded invoice line', () => {
  it('a washed écru: its treatments add up, the multiplier only on Lavage (MA109118)', () => {
    const r = recette(bd({
      treatments: [
        { IDtraitement: 287, IDtranche: 1, raw_prix: 0.93, applied_prix: 0.93, matel_applied: false },
        { IDtraitement: 285, IDtranche: 2, raw_prix: 7.61, applied_prix: 7.61, matel_applied: true },
      ],
      total: 8.54,
    }), noms, { mini: 0, maxi: 20 })
    expect(r.ingredients.map((i) => [i.libelle, i.applique, i.multiplie])).toEqual([['Préfixation', 0.93, false], ['Lavage', 7.61, true]])
    expect(r.tranche).toEqual({ poids: 14.3, mini: 0, maxi: 20 })
    expect(r.total).toBe(8.54)
  })

  it('a dyed fini: the dye scaled by the rendement multiplier, unpriced treatments named', () => {
    const r = recette(bd({
      avec_teinture: 1, IDteinture: 12, rendement: 3.8, matel_multiplier: 1.03,
      base: { kind: 'dye-only', IDtranche: 3, IDteinture: 12, raw_prix: 4.82, applied_prix: 4.9646 },
      unpriced_treatments: [291], total: 4.96,
    }), noms, { mini: 300, maxi: 500 })
    expect(r.ingredients[0]).toMatchObject({ libelle: 'Coloration Double Teinture', genre: 'teinture', brut: 4.82, multiplie: true })
    expect(r.multiplicateur).toBe(1.03)
    expect(r.bandeRendement).toEqual({ de: 3.5, a: 4 })
    expect(r.sansTarif).toEqual(['Rame'])
  })

  it('a wash-only écru billed as simple teinture says so (027B)', () => {
    const r = recette(bd({ base: { kind: 'dye-only', IDtranche: 4, IDteinture: 7, raw_prix: 6.03, applied_prix: 6.03 }, total: 6.03 }), noms, { mini: 200, maxi: 250 })
    expect(r.ingredients[0]).toMatchObject({ libelle: 'Coloration Simple Teinture (écru)', multiplie: false })
  })

  it('a combination row names every treatment it covers', () => {
    const r = recette(bd({ base: { kind: 'combination', IDtranche: 5, covered: [287, 291], raw_prix: 5.54, applied_prix: 5.54 }, total: 5.54 }), noms, { mini: null, maxi: null })
    expect(r.ingredients).toEqual([{ libelle: 'Préfixation + Rame', genre: 'combinaison', brut: 5.54, applique: 5.54, multiplie: false }])
  })
})
