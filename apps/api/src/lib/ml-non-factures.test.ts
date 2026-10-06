import { describe, expect, it } from 'vitest'
import {
  mentionNonFactures,
  metrageCompatible,
  mlNonFacturesModifiable,
  partFacturee,
  quantiteFacturee,
  validerSaisie,
} from './ml-non-factures.js'

// The real case: 3560/70, 38 m of which 10 stained (BL MATEL 109379A).
const p3560 = { numero: '3560/70', poids: 14, metrage: 38, ml_non_factures: 10, ml_non_factures_motif: 'Taches bleues sur les 10 premiers mètres' }
const sain = { numero: '3560/71', poids: 15.2, metrage: 40.5, ml_non_factures: 0, ml_non_factures_motif: null }

describe('quantiteFacturee', () => {
  it('bills metrage − Ml non facturés on a Ml line', () => {
    expect(partFacturee(p3560, 'metrage')).toBe(28)
    expect(quantiteFacturee([p3560, sain], 'metrage')).toBe(68.5)
  })

  it('leaves a roll without gesture untouched (old rows: column absent → 0)', () => {
    expect(quantiteFacturee([{ poids: 10, metrage: 25.37 }], 'metrage')).toBe(25.37)
    expect(quantiteFacturee([{ poids: 10.12, metrage: 25 }], 'poids')).toBe(10.12)
  })

  it('deducts the same share of the weight on a Kg line', () => {
    // 14 Kg × 10 / 38 = 3,684… → 3,68 Kg not billed
    expect(partFacturee(p3560, 'poids')).toBe(10.32)
    expect(quantiteFacturee([p3560, sain], 'poids')).toBe(25.52)
  })

  it('never bills a negative part, even from a bad row', () => {
    expect(partFacturee({ poids: 5, metrage: 10, ml_non_factures: 12 }, 'metrage')).toBe(0)
    expect(partFacturee({ poids: 5, metrage: 10, ml_non_factures: 12 }, 'poids')).toBe(0)
    expect(partFacturee({ poids: 5, metrage: 10, ml_non_factures: -3 }, 'metrage')).toBe(10)
  })
})

describe('mentionNonFactures', () => {
  it('prints one line per roll with a gesture', () => {
    expect(mentionNonFactures([p3560, sain], 'metrage')).toEqual([
      'dont 10 Ml non facturés — pièce 3560/70 : Taches bleues sur les 10 premiers mètres',
    ])
  })

  it('gives the Kg equivalent on a Kg line, French decimals', () => {
    expect(mentionNonFactures([{ ...p3560, ml_non_factures: 10.5, ml_non_factures_motif: 'taches' }], 'poids')).toEqual([
      'dont 10,5 Ml (≈ 3,87 Kg) non facturés — pièce 3560/70 : taches',
    ])
  })

  it('is empty when nothing is withheld', () => {
    expect(mentionNonFactures([sain], 'metrage')).toEqual([])
  })
})

describe('mlNonFacturesModifiable', () => {
  it('allows a roll not yet invoiced, shipped or not', () => {
    expect(mlNonFacturesModifiable({ facture: false, idcommande_donation: 0 })).toEqual({ ok: true })
  })

  it('refuses a roll on an invoice (provisional or definitive): an avoir then', () => {
    const v = mlNonFacturesModifiable({ facture: true, idcommande_donation: 0 })
    expect(v).toMatchObject({ ok: false, raison: 'facture' })
    if (!v.ok) expect(v.message).toContain('avoir')
  })

  it('refuses a donated roll', () => {
    expect(mlNonFacturesModifiable({ facture: false, idcommande_donation: 12 })).toMatchObject({ ok: false, raison: 'donne' })
  })
})

describe('validerSaisie', () => {
  it('accepts a value up to the roll length, with a motif', () => {
    expect(validerSaisie(10, ' taches ', 38)).toEqual({ ok: true, ml: 10, motif: 'taches' })
    expect(validerSaisie('38', 'tout le rouleau', 38)).toEqual({ ok: true, ml: 38, motif: 'tout le rouleau' })
    expect(validerSaisie('2,5', 'maille', 38)).toEqual({ ok: true, ml: 2.5, motif: 'maille' })
  })

  it('requires a motif for a positive value', () => {
    expect(validerSaisie(10, '  ', 38)).toMatchObject({ ok: false })
  })

  it('clears the motif with a zero', () => {
    expect(validerSaisie(0, 'taches', 38)).toEqual({ ok: true, ml: 0, motif: null })
  })

  it('refuses more than the roll, a negative or a non-number', () => {
    expect(validerSaisie(39, 'x', 38)).toMatchObject({ ok: false })
    expect(validerSaisie(-1, 'x', 38)).toMatchObject({ ok: false })
    expect(validerSaisie('abc', 'x', 38)).toMatchObject({ ok: false })
    expect(validerSaisie('', 'x', 38)).toMatchObject({ ok: false })
  })
})

describe('metrageCompatible', () => {
  it('keeps a new length at or above the non-billed Ml', () => {
    expect(metrageCompatible(28, 10)).toBe(true)
    expect(metrageCompatible(10, 10)).toBe(true)
    expect(metrageCompatible(9.99, 10)).toBe(false)
    expect(metrageCompatible(5, 0)).toBe(true)
  })
})
