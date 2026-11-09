// LIVA #1355 — a tombé de métier sold by the metre to a few historical clients:
// « Vente au mètre » + its own rendement on the fiche; every Ml figure is kg × rendement.

import { describe, it, expect } from 'vitest'
import { ecruEnMl, rendementVenteEcru, metrageEcruVendu } from './unite-ecru.js'
import { prixUnitOf } from './tarif-client.js'
import { assembleTarifEcru } from './pricing-fini-tarif.js'

describe('rendementVenteEcru', () => {
  it('is 0 while the switch is off, whatever the rendement', () => {
    expect(rendementVenteEcru({ vente_au_metre: 0, rendement_metre: 2.4 })).toBe(0)
    expect(rendementVenteEcru({ vente_au_metre: null, rendement_metre: 2.4 })).toBe(0)
  })
  it('is the rendement, to the hundredth, once on', () => {
    expect(rendementVenteEcru({ vente_au_metre: 1, rendement_metre: 2.4000000953 })).toBe(2.4)
    expect(rendementVenteEcru({ vente_au_metre: true, rendement_metre: 3.5 })).toBe(3.5)
  })
  it('is 0 when on without a rendement', () => {
    expect(rendementVenteEcru({ vente_au_metre: 1, rendement_metre: 0 })).toBe(0)
  })
})

describe('metrageEcruVendu', () => {
  it('bills weight × rendement, to the centimetre', () => {
    expect(metrageEcruVendu(20.15, 2.4)).toBe(48.36)
    expect(metrageEcruVendu('19,9', 2)).toBe(0) // not a number → 0
  })
  it('is 0 without a rendement', () => {
    expect(metrageEcruVendu(20, 0)).toBe(0)
  })
})

describe('ecruEnMl', () => {
  it('flags an écru line in Ml only', () => {
    expect(ecruEnMl(1, 3)).toBe(true)
    expect(ecruEnMl(1, 1)).toBe(false)
    expect(ecruEnMl(2, 3)).toBe(false)
  })
})

describe('prixUnitOf on an écru', () => {
  it('stays Kg on a Ml designation of an écru not sold by the metre', () => {
    expect(prixUnitOf({ IDref_fini: 0, unite: 3 })).toBe('Kg')
    expect(prixUnitOf({ IDref_fini: 0, unite: 3, ecruAuMetre: false })).toBe('Kg')
  })
  it('is Ml on a Ml designation of an écru sold by the metre', () => {
    expect(prixUnitOf({ IDref_fini: 0, unite: 3, ecruAuMetre: true })).toBe('Ml')
  })
  it('stays Kg on a Kg (or unset) designation, even sold by the metre', () => {
    expect(prixUnitOf({ IDref_fini: 0, unite: 1, ecruAuMetre: true })).toBe('Kg')
    expect(prixUnitOf({ IDref_fini: 0, unite: 0, ecruAuMetre: true })).toBe('Kg')
  })
})

describe('assembleTarifEcru with a sale rendement', () => {
  const base = {
    IDcolori_ecru: 1,
    detailFil: [{ label: 'fil', valueKg: 4.2 }],
  }
  it('prices per Ml = per kg ÷ rendement (before port), quantities in Ml', () => {
    const t = assembleTarifEcru({ ...base, ref_ecru: { IDref_ecru: 299, reference: '224', poids: 20, prix: 1.96, rendement_vente: 2 } })
    expect(t.rendement).toBe(2)
    const r = t.tranches[1] // 1 rouleau
    expect(r.qte_kg).toBe(20)
    expect(r.qte_ml).toBe(40)
    // € per Ml ≈ € per kg / 2 (both rounded to the centime separately)
    expect(Math.abs(r.moPrixDeVenteAuMl - r.moPrixDeVenteAuKg / 2)).toBeLessThanOrEqual(0.01)
    expect(r.moPrixDeVenteAuMl).toBeGreaterThan(0)
  })
  it('has no Ml figure without one (sold by the kg)', () => {
    const t = assembleTarifEcru({ ...base, ref_ecru: { IDref_ecru: 299, reference: '224', poids: 20, prix: 1.96 } })
    expect(t.rendement).toBe(0)
    expect(t.tranches[1].moPrixDeVenteAuMl).toBe(0)
    expect(t.tranches[1].qte_ml).toBe(0)
  })
})
