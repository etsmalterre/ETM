import { describe, expect, it } from 'vitest'
import { estimerRouleaux } from './rouleaux-estimes.js'

describe('estimerRouleaux', () => {
  it('sizes a Ml roll as écru weight × rendement, like the Fiche tarif', () => {
    // 20 kg × 1.5 Ml/kg = 30 Ml per roll → 761.6 Ml ≈ 25.4 rolls
    expect(estimerRouleaux(761.6, 3, { poids: 20, rendement: 1.5, ref_ecru: '119' }))
      .toEqual({ nb: 25.4, taille: 30, poids_rouleau: 20, rendement: 1.5, ref_ecru: '119' })
  })

  it('sizes a Kg line on the écru weight alone', () => {
    expect(estimerRouleaux(457.3, 1, { poids: 20, rendement: 1.5, ref_ecru: '119' })?.nb).toBe(22.9)
  })

  it('gives no estimate where the Fiche tarif prices nothing', () => {
    expect(estimerRouleaux(100, 3, { poids: 0, rendement: 1.5, ref_ecru: null })).toBeNull()
    expect(estimerRouleaux(100, 3, { poids: 20, rendement: 0, ref_ecru: null })).toBeNull()
    expect(estimerRouleaux(100, 3, undefined)).toBeNull()
    expect(estimerRouleaux(0, 3, { poids: 20, rendement: 1.5, ref_ecru: null })).toBeNull()
  })
})
