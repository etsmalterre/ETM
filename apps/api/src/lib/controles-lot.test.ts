import { describe, it, expect } from 'vitest'
import { controlesDeRef, mesuresManquantes, CONTROLES_PAR_DEFAUT } from './controles-lot.js'

describe('mesuresManquantes', () => {
  it('the coloris joins the Malterre control when owed (#1332)', () => {
    expect(mesuresManquantes({ laize: 160, poids: 210, stabH: -3, stabL: 0, vrillage: 2, colorisManquant: true })).toEqual(['coloris'])
    expect(mesuresManquantes({ laize: 160, poids: 210, stabH: -3, stabL: 0, vrillage: 2, colorisManquant: false })).toEqual([])
  })
  it('a complete control: laize, poids and one stabilité side', () => {
    expect(mesuresManquantes({ laize: 160, poids: 210, stabH: -3, stabL: 0, vrillage: 2 })).toEqual([])
    expect(mesuresManquantes({ laize: 160, poids: 210, stabH: 0, stabL: 2, vrillage: 2 })).toEqual([])
  })
  it('names what is missing, in display order', () => {
    expect(mesuresManquantes({ laize: 0, poids: 0, stabH: null, stabL: null, vrillage: 2 })).toEqual(['laize', 'poids', 'stabilités'])
    // The old rule (laize OR poids) passed this lot: stabilités are now due too.
    expect(mesuresManquantes({ laize: 160, poids: 210, stabH: null, stabL: null, vrillage: 2 })).toEqual(['stabilités'])
    expect(mesuresManquantes({ laize: 0, poids: 210, stabH: -2, stabL: -1, vrillage: 2 })).toEqual(['laize'])
  })
  it('0 / 0 is an ultra-stable matter, a real measure (#1358); one side missing is not measured', () => {
    expect(mesuresManquantes({ laize: 160, poids: 210, stabH: 0, stabL: 0, vrillage: 2 })).toEqual([])
    expect(mesuresManquantes({ laize: 160, poids: 210, stabH: 0, stabL: null, vrillage: 2 })).toEqual(['stabilités'])
  })
})

describe('mesuresManquantes with what the reference asks (#1345)', () => {
  const sansStabs = { laize: true, poids: true, stabilites: false, vrillage: true }
  it('a bord côte without stabs at Malterre: laize + poids complete the control', () => {
    expect(mesuresManquantes({ laize: 163, poids: 418, stabH: 0, stabL: 0, vrillage: 2 }, sansStabs)).toEqual([])
    expect(mesuresManquantes({ laize: 0, poids: 418, stabH: 0, stabL: 0, vrillage: 2 }, sansStabs)).toEqual(['laize'])
  })
  it('the coloris stays due whatever the measures', () => {
    expect(mesuresManquantes({ laize: 163, poids: 418, stabH: 0, stabL: 0, vrillage: 2, colorisManquant: true }, sansStabs)).toEqual(['coloris'])
  })
})

describe('vrillage (#1345)', () => {
  const base = { laize: 160, poids: 210, stabH: -3, stabL: 0 }
  it('NULL is not measured, 0 is a measure', () => {
    expect(mesuresManquantes({ ...base, vrillage: null })).toEqual(['vrillage'])
    expect(mesuresManquantes(base)).toEqual(['vrillage'])
    expect(mesuresManquantes({ ...base, vrillage: 0 })).toEqual([])
  })
  it('not asked: never missing', () => {
    expect(mesuresManquantes({ ...base, vrillage: null }, { laize: true, poids: true, stabilites: true, vrillage: false })).toEqual([])
  })
})

describe('controlesDeRef', () => {
  const tout = { laize: true, poids: true, stabilites: true, vrillage: true }
  const rien = { laize: false, poids: false, stabilites: false, vrillage: false }
  it('everything asked unless explicitly 0', () => {
    expect(controlesDeRef(undefined)).toEqual(CONTROLES_PAR_DEFAUT)
    expect(controlesDeRef({})).toEqual(CONTROLES_PAR_DEFAUT)
    expect(controlesDeRef({ controle_ennoblisseur: 1, controle_malterre: 1 })).toEqual(CONTROLES_PAR_DEFAUT)
  })
  it('a side stored 0 asks none of its measures', () => {
    const c = controlesDeRef({ controle_ennoblisseur: 0, controle_malterre: 1, controle_ennoblisseur_stab: 1 })
    expect(c.ennoblisseur).toBe(false)
    expect(c.mesures.ennoblisseur).toEqual(rien)
    expect(c.malterre).toBe(true)
    expect(c.mesures.malterre).toEqual(tout)
  })
  it('one measure off: the side stays asked, without it', () => {
    const c = controlesDeRef({ controle_ennoblisseur: 1, controle_malterre: 1, controle_malterre_stab: 0 })
    expect(c.malterre).toBe(true)
    expect(c.mesures.malterre).toEqual({ laize: true, poids: true, stabilites: false, vrillage: true })
    expect(c.mesures.ennoblisseur).toEqual(tout)
  })
  it('every measure off = the side is not asked', () => {
    const c = controlesDeRef({ controle_malterre: 1, controle_malterre_laize: 0, controle_malterre_poids: 0, controle_malterre_stab: 0, controle_malterre_vrillage: 0 })
    expect(c.malterre).toBe(false)
  })
})
