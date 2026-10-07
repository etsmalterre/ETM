import { describe, expect, it } from 'vitest'
import { paragraphePointsASignaler, pointsASignaler, POINTS_A_SIGNALER_TITRE } from './bl-points-a-signaler.js'

describe('pointsASignaler', () => {
  it('lists nothing for an ordinary shipment', () => {
    expect(pointsASignaler({
      afficheObservations: true,
      observationBl: '  ',
      rouleaux: [{ numero: '3560/1', observations: ' ', metrage: 40, ml_non_factures: 0 }],
    })).toEqual([])
  })

  it('keeps roll observations internal when the BL does not show them', () => {
    expect(pointsASignaler({
      afficheObservations: false,
      observationBl: null,
      rouleaux: [{ numero: '3560/1', observations: 'trou à 12 m', metrage: 40 }],
    })).toEqual([])
  })

  it('always lists the Ml non facturés, with their motif', () => {
    expect(pointsASignaler({
      afficheObservations: false,
      observationBl: null,
      rouleaux: [{ numero: '3560/70', observations: 'interne', metrage: 38, ml_non_factures: 10, ml_non_factures_motif: 'taches bleues' }],
    })).toEqual(['Pièce 3560/70 : 10 Ml non facturés (taches bleues)'])
  })

  it('merges observation and Ml non facturés on one line, BL observation first, rolls in numero order', () => {
    expect(pointsASignaler({
      afficheObservations: true,
      observationBl: 'Livraison partielle,\nsolde semaine prochaine',
      rouleaux: [
        { numero: '3560/10', observations: 'barre à 5 m', metrage: 40 },
        { numero: '3560/9', observations: 'taches', metrage: 30, ml_non_factures: 7.5, ml_non_factures_motif: '' },
      ],
    })).toEqual([
      'Livraison partielle, solde semaine prochaine',
      'Pièce 3560/9 : taches — 7,5 Ml non facturés',
      'Pièce 3560/10 : barre à 5 m',
    ])
  })

  it('never claims more Ml non facturés than the roll length', () => {
    expect(pointsASignaler({
      afficheObservations: false,
      observationBl: null,
      rouleaux: [{ numero: 'A', observations: null, metrage: 20, ml_non_factures: 25 }],
    })).toEqual(['Pièce A : 20 Ml non facturés'])
  })
})

describe('paragraphePointsASignaler', () => {
  it('is empty without points and carries the heading otherwise', () => {
    expect(paragraphePointsASignaler([])).toBe('')
    const p = paragraphePointsASignaler(['Pièce A : x'])
    expect(p).toContain(POINTS_A_SIGNALER_TITRE)
    expect(p).toContain('- Pièce A : x')
  })
})
