import { describe, it, expect } from 'vitest'
import { clesRequises, groupesModifies } from './ref-fini-droits.js'

const stocke = {
  reference: 'MOLLETON 300', designation: 'Molleton', observations: 'ligne 1\r\nligne 2',
  responsable: null, en_developpement: 0,
  IDref_ecru: 12, rendement: 2.1234, poids_Moy: 300, poids_Min: null,
  controle_sst_stab: 1, controle_ennoblisseur: 1, controle_malterre: 1,
}

describe('groupesModifies', () => {
  it('a form sent back unchanged changes nothing', () => {
    // What the fiche sends: LF line ends, '' for null text, null for an empty number, booleans.
    expect(groupesModifies(stocke, {
      reference: 'MOLLETON 300', designation: 'Molleton ', observations: 'ligne 1\nligne 2',
      responsable: '', en_developpement: false,
      IDref_ecru: 12, rendement: 2.1234, poids_Moy: 300, poids_Min: null,
      controle_sst_stab: true, controle_ennoblisseur: true, controle_malterre: true,
    })).toEqual([])
  })
  it('names each group that really changed', () => {
    expect(groupesModifies(stocke, { designation: 'Molleton gratté' })).toEqual(['general'])
    expect(groupesModifies(stocke, { poids_Min: 290 })).toEqual(['specifications'])
    expect(groupesModifies(stocke, { controle_sst_stab: false })).toEqual(['specifications'])
    expect(groupesModifies(stocke, { controle_malterre: false })).toEqual(['controles'])
    expect(groupesModifies(stocke, { en_developpement: true, IDref_ecru: 13 })).toEqual(['general', 'specifications'])
  })
  it('a field left out is not a change', () => {
    expect(groupesModifies(stocke, { reference: 'MOLLETON 300' })).toEqual([])
  })
})

describe('clesRequises', () => {
  it('always the parent, then each group key', () => {
    expect(clesRequises([])).toEqual(['edit_ref_fini'])
    expect(clesRequises(['general', 'controles'])).toEqual(['edit_ref_fini', 'edit_ref_fini_controles'])
  })
})
