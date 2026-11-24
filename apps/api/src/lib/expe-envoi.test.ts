import { describe, it, expect } from 'vitest'
import { NUMERO_SUIVI_MAX, deciderSuivi, lireModifTransport, typeDoc } from './expe-envoi.js'

const AVIS = [{ kind: 'formelle', id: 12521 }, { kind: 'formelle', id: 12522 }]

describe('expe: what is written on a transport', () => {
  it('reads a carrier, a tracking number, or both', () => {
    expect(lireModifTransport({ avis: AVIS, idtransporteur: 4 })).toEqual({ avis: AVIS, idtransporteur: 4 })
    expect(lireModifTransport({ avis: AVIS, numero_suivi: 'JD0146' })).toEqual({ avis: AVIS, numero_suivi: 'JD0146' })
    expect(lireModifTransport({ avis: AVIS, idtransporteur: 0, numero_suivi: '' }))
      .toEqual({ avis: AVIS, idtransporteur: 0, numero_suivi: '' })
  })

  it('tidies the tracking number and counts an avis once', () => {
    expect(lireModifTransport({ avis: AVIS, numero_suivi: '  JD 0146 \n 0002 ' })?.numero_suivi).toBe('JD 0146 0002')
    expect(lireModifTransport({ avis: [...AVIS, AVIS[0]], idtransporteur: 4 })?.avis).toEqual(AVIS)
    // An avis and an avis divers of the same number are two documents.
    expect(lireModifTransport({ avis: [{ kind: 'formelle', id: 650 }, { kind: 'divers', id: 650 }], idtransporteur: 4 })?.avis).toHaveLength(2)
  })

  it('refuses what is not a modification', () => {
    expect(lireModifTransport(null)).toBeNull()
    expect(lireModifTransport({ avis: AVIS })).toBeNull()
    expect(lireModifTransport({ avis: [], idtransporteur: 4 })).toBeNull()
    expect(lireModifTransport({ avis: [{ kind: 'bon', id: 1 }], idtransporteur: 4 })).toBeNull()
    expect(lireModifTransport({ avis: [{ kind: 'formelle', id: 0 }], idtransporteur: 4 })).toBeNull()
    expect(lireModifTransport({ avis: AVIS, idtransporteur: -1 })).toBeNull()
    expect(lireModifTransport({ avis: AVIS, idtransporteur: 1.5 })).toBeNull()
    expect(lireModifTransport({ avis: AVIS, numero_suivi: 'x'.repeat(NUMERO_SUIVI_MAX + 1) })).toBeNull()
  })

  it('names the two documents as the envoi stores them', () => {
    expect(typeDoc('formelle')).toBe('avis')
    expect(typeDoc('divers')).toBe('avis_divers')
  })

  it('creates the envoi with the first tracking number, never for an empty one', () => {
    expect(deciderSuivi([], 'JD0146')).toEqual({ action: 'creer' })
    expect(deciderSuivi([], '')).toEqual({ action: 'rien' })
  })

  it('rewrites the number of the envoi the avis are already in, emptied or not', () => {
    expect(deciderSuivi([7, 7], 'JD0147')).toEqual({ action: 'modifier', idenvoi: 7 })
    // Only some avis are in it yet: the others join it.
    expect(deciderSuivi([7], 'JD0147')).toEqual({ action: 'modifier', idenvoi: 7 })
    expect(deciderSuivi([7], '')).toEqual({ action: 'modifier', idenvoi: 7 })
  })

  it('refuses one number for avis that left in two envois', () => {
    expect(deciderSuivi([7, 8], 'JD0147')).toEqual({ action: 'refuser' })
  })
})
