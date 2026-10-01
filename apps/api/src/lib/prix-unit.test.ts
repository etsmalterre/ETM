// LIVA #1253 — a client reference's selling unit decides how its prices are
// shown and how its contract prices are read: €/Kg on a tombé de métier and on
// an ennobli sold by the Kg (Sigvaris), €/Ml on any other ennobli.

import { describe, it, expect } from 'vitest'
import { prixUnitOf } from './tarif-client.js'
import { contratPriceFn } from './pricing-ligne-client.js'
import type { ContratTarifInfo } from './tarif-client.js'

describe('prixUnitOf', () => {
  it('sells a tombé de métier by the Kg, whatever its unite', () => {
    expect(prixUnitOf({ IDref_fini: 0, unite: 3 })).toBe('Kg')
    expect(prixUnitOf({ IDref_fini: 0, unite: 1 })).toBe('Kg')
  })
  it('sells an ennobli by the Ml unless it is marked Kg', () => {
    expect(prixUnitOf({ IDref_fini: 30, unite: 3 })).toBe('Ml')
    expect(prixUnitOf({ IDref_fini: 30, unite: 0 })).toBe('Ml')
    expect(prixUnitOf({ IDref_fini: 30, unite: 255 })).toBe('Ml')
    expect(prixUnitOf({ IDref_fini: 30, unite: 1 })).toBe('Kg')
  })
})

describe('contratPriceFn', () => {
  const contrat: ContratTarifInfo = {
    IDcontrat_tarif: 1, date_debut: '20260101', date_expiration: '20271231',
    tranches: [{ nb_rouleaux: 1, prix: 10 }],
  }
  const KG = 1
  const ML = 3

  it('reads the price as is when the line is in the contract unit', () => {
    expect(contratPriceFn(contrat, ML, 2.5, 'Ml')!(1)).toBe(10)
    expect(contratPriceFn(contrat, KG, 2.5, 'Kg')!(1)).toBe(10)
    // No rendement needed when no conversion happens.
    expect(contratPriceFn(contrat, KG, 0, 'Kg')!(1)).toBe(10)
  })
  it('converts through the rendement otherwise (1 kg = rendement Ml)', () => {
    expect(contratPriceFn(contrat, KG, 2.5, 'Ml')!(1)).toBe(25) // 10 €/Ml × 2,5 Ml/kg
    expect(contratPriceFn(contrat, ML, 2.5, 'Kg')!(1)).toBe(4) // 10 €/Kg ÷ 2,5 Ml/kg
  })
  it('refuses a conversion without a rendement', () => {
    expect(contratPriceFn(contrat, ML, 0, 'Kg')).toBeNull()
    expect(contratPriceFn(contrat, KG, 0, 'Ml')).toBeNull()
  })
})
