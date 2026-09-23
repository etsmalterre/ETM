import { describe, expect, it } from 'vitest'
import { ADRESSE_A_DEFINIR, isAdresseADefinir, withAdresseADefinir } from './adresse-a-definir.js'

describe('adresse « À définir »', () => {
  it('recognises the legacy placeholder row only', () => {
    expect(isAdresseADefinir(795)).toBe(true)
    expect(isAdresseADefinir('795')).toBe(true)
    expect(isAdresseADefinir(0)).toBe(false)
    expect(isAdresseADefinir(1318)).toBe(false) // a fournisseur's own « a définir » row
    expect(isAdresseADefinir(null)).toBe(false)
  })

  it('replaces the stored dashes with one clean label', () => {
    const stored = { IDadresse: ADRESSE_A_DEFINIR, nom: 'A Définir', adresse1: '-', adresse2: '-', adresse3: '-', cp: '-', ville: '-', pays: '-' }
    expect(withAdresseADefinir(stored)).toEqual({
      IDadresse: 795, nom: 'À définir', adresse1: null, adresse2: null, adresse3: null, cp: null, ville: null, pays: null, a_definir: true,
    })
  })

  it('leaves a real address and null untouched', () => {
    const real = { IDadresse: 253, nom: 'NEOBULLE', ville: 'ST BONNET' }
    expect(withAdresseADefinir(real)).toBe(real)
    expect(withAdresseADefinir(null)).toBeNull()
  })
})
