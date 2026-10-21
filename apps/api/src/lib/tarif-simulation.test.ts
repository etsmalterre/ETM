import { describe, it, expect } from 'vitest'
import { gainPct, rendementDepuisMesures, sourceSimulation } from './tarif-simulation.js'
import { achatDepuisPrixBase, prixAvecGestion, prixBaseDepuisAchat } from './fil-frais-gestion.js'
import { assembleTarifFini, priceTrancheLibre, type TarifFiniInputs } from './pricing-fini-tarif.js'
import { detailFilSimulation } from './pricing-ref-tarif.js'

describe('sourceSimulation', () => {
  it('a reference wins, then a sample, else libre', () => {
    expect(sourceSimulation({ idref_fini: 12, idref_echantillon: 3 })).toBe('reference')
    expect(sourceSimulation({ idref_fini: 0, idref_echantillon: 3 })).toBe('echantillon')
    expect(sourceSimulation({ idref_fini: null, idref_echantillon: null })).toBe('libre')
  })
})

describe('rendementDepuisMesures', () => {
  it('160 cm at 200 g/m² gives 3,125 Ml/Kg', () => {
    expect(rendementDepuisMesures(160, 200)).toBe(3.125)
  })
  it('a missing measure gives 0', () => {
    expect(rendementDepuisMesures(0, 200)).toBe(0)
    expect(rendementDepuisMesures(160, 0)).toBe(0)
  })
})

describe('gainPct', () => {
  it('is the drop in percent of the baseline', () => {
    expect(gainPct(10, 9)).toBe(10)
    expect(gainPct(8, 8.4)).toBe(-5)
  })
  it('no baseline, no gain', () => {
    expect(gainPct(null, 9)).toBeNull()
    expect(gainPct(0, 9)).toBeNull()
  })
})

describe('frais de gestion fil', () => {
  it('base price = offer × 1,05, to the centime', () => {
    expect(prixBaseDepuisAchat(3.77)).toBe(3.96)
  })
  it('a base price round-trips through the purchase price', () => {
    for (const p of [3.96, 4.15, 28.7, 6.83, 0.01]) {
      expect(prixAvecGestion(achatDepuisPrixBase(p), 5)).toBe(p)
    }
  })
  it('a simulation line splits its €/Kg into purchase + gestion', () => {
    const [l] = detailFilSimulation(
      [{ IDasso_fil_tarif: 1, IDref_fil: 1, ref_label: 'COTON', IDcolori_fil: 0, colori_label: null, pourcentage: 50, prix_achat: 4 }],
      5,
    )
    expect(l.valueKg).toBe(2.1)
    expect(l.gestionKg).toBe(0.1)
    expect(l.label).toBe('50% de COTON à 4,20 €')
  })
})

/** A 20 Kg roll, rendement 3,8 (MATEL ×1,03), one Lavage (285, in the MATEL
 *  set) at 1 €/Kg and a dye at 4 €/Kg, flat bands. */
function inputs(extra: Partial<TarifFiniInputs> = {}): TarifFiniInputs {
  const band = (prix: number) => [{ IDtraitement: 0, IDteinture: 0, quantite_mini: 0, quantite_maxi: 100000, prix }]
  return {
    IDref_fini: 1,
    IDcoloris: 1,
    avecTeinture: 1,
    rendement: 3.8,
    ref_ecru: { IDref_ecru: 1, reference: '081A', poids: 20, prix: 2 },
    detailFil: [{ label: 'fil', valueKg: 4 }],
    treatments: [{ IDtraitement: 285, designation: 'Lavage' }],
    bandsByTreatment: new Map([[285, band(1)]]),
    dye: { IDteinture: 7, label: 'Tous coloris', gots: false, prixGots: 0, bands: band(4) },
    ...extra,
  }
}

describe('assembleTarifFini — levers', () => {
  it('the catalogue applies MATEL to the dye and the Lavage', () => {
    const t = assembleTarifFini(inputs()).tranches[1]
    expect(t.moTraitements).toBe(1.08) // 1 × 1,03 × 1,05
    expect(t.moTeinte).toBe(4.33) // 4 × 1,03 × 1,05
  })
  it('a manual multiplier replaces MATEL on every line', () => {
    const t = assembleTarifFini(inputs({ leviers: { multiplicateurManuel: 0 } })).tranches[1]
    expect(t.moTraitements).toBe(1.05)
    expect(t.moTeinte).toBe(4.2)
  })
  it('the ennoblissement adjustment moves every dyer price', () => {
    const t = assembleTarifFini(inputs({ leviers: { multiplicateurManuel: 0, ajustEnnoblissementPct: -10 } })).tranches[1]
    expect(t.moTeinte).toBe(3.78) // 4 × 0,9 × 1,05
  })
  it('GOTS adds its supplement to the dye', () => {
    const dye = { ...inputs().dye!, gots: true, prixGots: 0.5 }
    const t = assembleTarifFini(inputs({ dye, leviers: { multiplicateurManuel: 0 } })).tranches[1]
    expect(t.moTeinte).toBe(4.7)
  })
  it('flat shipping adds €/Kg after the margin', () => {
    const pct = assembleTarifFini(inputs()).tranches[1]
    const kg = assembleTarifFini(inputs({ leviers: { port: { mode: 'kg', pct: 0, fixe: 0.3 } } })).tranches[1]
    expect(kg.tauxFraisDePort).toBe(0)
    expect(kg.moPortAuKg).toBe(0.3)
    expect(kg.moPrixDeVenteAuKg).toBe(Math.round((pct.moRevient / (1 - pct.rCoeff) + 0.3) * 100) / 100)
  })
  it('the 30-roll tranche keeps 3 % shipping whatever the rate', () => {
    const t = assembleTarifFini(inputs({ leviers: { port: { mode: 'pct', pct: 8, fixe: 0 } } })).tranches
    expect(t[1].tauxFraisDePort).toBe(0.08)
    expect(t[8].tauxFraisDePort).toBe(0.03)
  })
})

describe('priceTrancheLibre', () => {
  it('solves the margin back from a target price', () => {
    const inp = inputs()
    const t = priceTrancheLibre(inp, { poids: 200, prix_cible_ml: 5 })!
    expect(t.moPrixDeVenteAuMl).toBe(5)
  })
  it('a target under cost clamps the margin at 0', () => {
    const t = priceTrancheLibre(inputs(), { poids: 200, prix_cible_ml: 0.5 })!
    expect(t.rCoeff).toBe(0)
  })
})
