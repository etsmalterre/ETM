import { describe, expect, it } from 'vitest'
import { delaiControle, demandesParPhase, etapeLabo, horsTolerance, type LaboRow } from './tirelle-labo.js'

const TOUT = { laize: true, poids: true, stabilites: true, vrillage: true }
const labo = (p: Partial<LaboRow> = {}): LaboRow => ({
  termine_le: null, a_jeter_depuis: null, a_jeter_motif: null, a_jeter_casier: null, ...p,
})
const TOUT_MANQUE = ['laize', 'poids', 'stabilités', 'vrillage', 'coloris']

describe('etapeLabo', () => {
  it('a received lot starts « avant lavage »', () => {
    expect(etapeLabo({ demandees: TOUT, colorisDu: true, manque: TOUT_MANQUE, labo: null })).toBe('avant_lavage')
  })

  it('moves to « après lavage » on its own once laize, poids and coloris are given', () => {
    expect(etapeLabo({ demandees: TOUT, colorisDu: true, manque: ['stabilités', 'vrillage'], labo: null })).toBe('apres_lavage')
  })

  it('a missing coloris verdict alone keeps the lot before the wash (MA109452, 2026-10)', () => {
    expect(etapeLabo({ demandees: TOUT, colorisDu: true, manque: ['coloris'], labo: null })).toBe('avant_lavage')
  })

  it('waits « après lavage » even with every measure given, until marked done', () => {
    expect(etapeLabo({ demandees: TOUT, colorisDu: true, manque: [], labo: labo() })).toBe('apres_lavage')
    expect(etapeLabo({ demandees: TOUT, colorisDu: true, manque: [], labo: labo({ termine_le: '2026-11-03T11:00:00Z' }) })).toBeNull()
  })

  it('a reference asking nothing before the wash goes straight to « après lavage »', () => {
    const d = { laize: false, poids: false, stabilites: true, vrillage: false }
    expect(etapeLabo({ demandees: d, colorisDu: false, manque: ['stabilités'], labo: null })).toBe('apres_lavage')
  })

  it('a reprise wins over everything: throw away first', () => {
    const l = labo({ a_jeter_depuis: '2026-11-03T12:00:00Z', termine_le: '2026-11-01T12:00:00Z' })
    expect(etapeLabo({ demandees: TOUT, colorisDu: true, manque: TOUT_MANQUE, labo: l })).toBe('a_jeter')
  })
})

describe('demandesParPhase', () => {
  it('laize, poids and coloris on the round; stabilités and vrillage on the square', () => {
    expect(demandesParPhase(TOUT, true)).toEqual({ rond: ['laize', 'poids', 'coloris'], carre: ['stabilités', 'vrillage'] })
    expect(demandesParPhase(TOUT, false).rond).toEqual(['laize', 'poids'])
  })
})

describe('horsTolerance', () => {
  const t = { laize: { min: 150, max: 160 }, poids: { min: 200, max: 220 }, stabh: -5, stabl: -3, vrillageMax: 5 }
  it('reads the fiche bounds, the retrait référentiel and the vrillage max', () => {
    const h = horsTolerance({ laize: 162, poids: 210, stabh: -6, stabl: -2, vrillage: 5, coloris: 'ecart' }, t)
    expect(h).toEqual({ laize: true, poids: false, stabh: true, stabl: false, vrillage: false, coloris: true })
  })
  it('says nothing about what is not measured', () => {
    const h = horsTolerance({ laize: 0, poids: 0, stabh: null, stabl: null, vrillage: null, coloris: null }, t)
    expect(h).toEqual({ laize: null, poids: null, stabh: null, stabl: null, vrillage: null, coloris: null })
  })
  it('0 / 0 is an ultra-stable matter, within tolerance (#1358)', () => {
    const h = horsTolerance({ laize: 155, poids: 210, stabh: 0, stabl: 0, vrillage: 0, coloris: null }, t)
    expect(h).toMatchObject({ stabh: false, stabl: false, vrillage: false })
  })
})

describe('delaiControle', () => {
  // Mon 2026-11-02 + 5 working days = Mon 2026-11-09 (Wed 11/11 is a holiday, not in the window).
  it('is due 5 working days after the reception, blue before', () => {
    expect(delaiControle('2026-11-02', '2026-11-04')).toEqual({ echeance: '2026-11-09', joursDepuis: 2, restants: 3, rouge: false })
  })
  it('turns red on the due day itself', () => {
    expect(delaiControle('2026-11-02', '2026-11-09')).toMatchObject({ restants: 0, rouge: true })
  })
  it('counts the working days late, holidays excluded', () => {
    // Due Mon 09/11; Thu 12/11 is 2 working days later (11/11 is a holiday).
    expect(delaiControle('2026-11-02', '2026-11-12')).toMatchObject({ joursDepuis: 10, restants: -2, rouge: true })
  })
  it('skips weekends', () => {
    // Fri 2026-11-06 + 5 working days = Fri 13/11 (holiday 11/11 skipped → Mon 16/11).
    expect(delaiControle('2026-11-06', '2026-11-06')?.echeance).toBe('2026-11-16')
  })
  it('has nothing without a reception', () => {
    expect(delaiControle(null, '2026-11-09')).toBeNull()
  })
})
