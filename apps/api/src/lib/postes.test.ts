import { describe, expect, it } from 'vitest'
import { annulerCodePoste, codesPosteEnAttente, consommerCodePoste, genererCodePoste } from './postes.js'

describe('postes — pending PC codes', () => {
  it('lists an account’s pending codes, never another’s', () => {
    const a = genererCodePoste(10, 'PC visitage', 1)
    genererCodePoste(14, 'PC atelier', 1)
    expect(codesPosteEnAttente(10)).toEqual([{ code: a.code, libelle: 'PC visitage', expire: a.expire }])
    annulerCodePoste(10, a.code)
  })

  it('cancels only a code of the named account', () => {
    const c = genererCodePoste(10, 'PC', 1)
    expect(annulerCodePoste(14, c.code)).toBe(false)
    expect(annulerCodePoste(10, c.code)).toBe(true)
    expect(consommerCodePoste(c.code)).toBeNull()
  })

  it('a consumed code is no longer pending', () => {
    const c = genererCodePoste(21, 'PC', 1)
    expect(consommerCodePoste(c.code)).toEqual({ idutilisateur: 21, libelle: 'PC' })
    expect(codesPosteEnAttente(21)).toEqual([])
  })
})
