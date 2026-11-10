import { describe, it, expect } from 'vitest'
import { annulablePar } from './annulation-atelier.js'

const defaut = { source: 'defaut' as const, ref_id: 50, evenement: 'Défaut', IDbonnetier: 22 }
const nettoyage = { source: 'evenement' as const, ref_id: 900, evenement: 'Nettoyage', IDbonnetier: 22 }

describe('annulablePar', () => {
  it('lets the author delete a Défaut or a Nettoyage of the open piece', () => {
    expect(annulablePar(defaut, true, null)).toBe(22)
    expect(annulablePar(nettoyage, true, null)).toBe(22)
  })
  it('never a fin de pièce, a launch, a pause', () => {
    for (const evenement of ['Fin du tricotage', 'Début du tricotage', 'Interruption OF', 'Reprise OF']) {
      expect(annulablePar({ ...nettoyage, evenement }, true, null)).toBeNull()
    }
  })
  it('never on a closed piece', () => {
    expect(annulablePar(defaut, false, null)).toBeNull()
  })
  it('only the last: an action already there at the previous deletion stays', () => {
    const avant = { max_evenement: 900, max_defaut: 49 }
    expect(annulablePar(nettoyage, true, avant)).toBeNull()
    expect(annulablePar(defaut, true, avant)).toBe(22)
    expect(annulablePar({ ...defaut, ref_id: 49 }, true, avant)).toBeNull()
    expect(annulablePar({ ...nettoyage, ref_id: 901 }, true, avant)).toBe(22)
  })
})
