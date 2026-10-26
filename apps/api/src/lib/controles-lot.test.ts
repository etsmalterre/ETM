import { describe, it, expect } from 'vitest'
import { controlesDeRef, mesuresManquantes, CONTROLES_PAR_DEFAUT } from './controles-lot.js'

describe('mesuresManquantes', () => {
  it('a complete control: laize, poids and one stabilité side', () => {
    expect(mesuresManquantes({ laize: 160, poids: 210, stabH: -3, stabL: 0 })).toEqual([])
    expect(mesuresManquantes({ laize: 160, poids: 210, stabH: 0, stabL: 2 })).toEqual([])
  })
  it('names what is missing, in display order', () => {
    expect(mesuresManquantes({ laize: 0, poids: 0, stabH: 0, stabL: 0 })).toEqual(['laize', 'poids', 'stabilités'])
    // The old rule (laize OR poids) passed this lot: stabilités are now due too.
    expect(mesuresManquantes({ laize: 160, poids: 210, stabH: 0, stabL: 0 })).toEqual(['stabilités'])
    expect(mesuresManquantes({ laize: 0, poids: 210, stabH: -2, stabL: -1 })).toEqual(['laize'])
  })
})

describe('controlesDeRef', () => {
  it('both asked unless explicitly 0', () => {
    expect(controlesDeRef(undefined)).toEqual(CONTROLES_PAR_DEFAUT)
    expect(controlesDeRef({})).toEqual({ ennoblisseur: true, malterre: true })
    expect(controlesDeRef({ controle_ennoblisseur: 1, controle_malterre: 1 })).toEqual({ ennoblisseur: true, malterre: true })
    expect(controlesDeRef({ controle_ennoblisseur: 0, controle_malterre: 1 })).toEqual({ ennoblisseur: false, malterre: true })
    expect(controlesDeRef({ controle_ennoblisseur: 0, controle_malterre: 0 })).toEqual({ ennoblisseur: false, malterre: false })
  })
})
