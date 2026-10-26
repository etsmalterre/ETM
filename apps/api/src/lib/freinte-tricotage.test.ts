import { describe, it, expect } from 'vitest'
import {
  mesurerGroupes, freinteMesuree, defautsFreinte, resoudreFreinte, filPourEcru, ecruPourFil, groupeDeMatiere, mediane, besoinFil,
  FREINTE_REPLI, type MesureFreinte,
} from './freinte-tricotage.js'

const lot = (id: number, stockInitial: number, o: Partial<{ stock: number; termine: boolean }> = {}) =>
  ({ id, lot: `L${id}`, stockInitial, stock: 0, termine: true, ...o })
const of = (id: number, sortie: number, ecru = 1, date = '2025-03-01') => ({ id, ecru, date, sortie })

describe('mesurerGroupes', () => {
  it('balances a lot against the écru its OF made', () => {
    const [g] = mesurerGroupes([lot(1, 645)], [of(10, 634.5)], [{ lot: 1, of: 10 }])
    expect(g.ecrus).toEqual([1])
    expect(g.mesure.taux).toBeCloseTo(1 - 634.5 / 645, 4)
    expect(g.mesure.valide).toBe(true)
  })

  it('closes the group over lots shared by OFs and OFs fed by several lots', () => {
    // OF 10 knits lots 1 + 2, lot 2 also feeds OF 11: one group of 2 lots and 2 OFs.
    const out = mesurerGroupes(
      [lot(1, 500), lot(2, 500)], [of(10, 600), of(11, 370)],
      [{ lot: 1, of: 10 }, { lot: 2, of: 10 }, { lot: 2, of: 11 }],
    )
    expect(out).toHaveLength(1)
    expect(out[0].mesure.entree).toBe(1000)
    expect(out[0].mesure.sortie).toBe(970)
    expect(out[0].mesure.taux).toBeCloseTo(0.03, 4)
  })

  it('waits for every lot of the group to be archived', () => {
    expect(mesurerGroupes([lot(1, 500), lot(2, 500, { termine: false })], [of(10, 900)],
      [{ lot: 1, of: 10 }, { lot: 2, of: 10 }])).toEqual([])
  })

  it('takes what stayed on an archived lot out of the yarn in, never a negative stock', () => {
    const [a] = mesurerGroupes([lot(1, 1000, { stock: 400 })], [of(10, 582)], [{ lot: 1, of: 10 }])
    expect(a.mesure.entree).toBe(600)
    const [b] = mesurerGroupes([lot(1, 1000, { stock: -20 })], [of(10, 970)], [{ lot: 1, of: 10 }])
    expect(b.mesure.entree).toBe(1000)
  })

  it('flags data errors and old measures as not valid', () => {
    const [bad] = mesurerGroupes([lot(1, 2)], [of(10, 452)], [{ lot: 1, of: 10 }])
    expect(bad.mesure.valide).toBe(false)
    const [old] = mesurerGroupes([lot(1, 100)], [of(10, 97, 1, '2022-06-01')], [{ lot: 1, of: 10 }])
    expect(old.mesure.valide).toBe(false)
  })

  it('credits only the écrus that made a real share of the group', () => {
    const [g] = mesurerGroupes([lot(1, 1000)], [of(10, 900, 1), of(11, 70, 2)], [{ lot: 1, of: 10 }, { lot: 1, of: 11 }])
    expect(g.ecrus).toEqual([1])
  })
})

const m = (taux: number, date: string, valide = true): MesureFreinte =>
  ({ date, entree: 100, sortie: 100 * (1 - taux), taux, lots: [], ofs: [], valide })

describe('freinteMesuree', () => {
  it('needs three valid measures', () => {
    expect(freinteMesuree([m(0.02, '2025-01-01'), m(0.03, '2025-02-01'), m(0.5, '2025-03-01', false)]).taux).toBeNull()
  })
  it('is the median of the ten latest', () => {
    const xs = Array.from({ length: 12 }, (_, i) => m(i < 2 ? 0.2 : 0.02 + i * 0.001, `2025-${String(i + 1).padStart(2, '0')}-01`))
    // the two oldest (20 %) fall out of the last ten
    expect(freinteMesuree(xs).taux).toBeCloseTo(mediane(xs.slice(2).map((x) => x.taux)), 4)
    expect(freinteMesuree(xs).nb).toBe(12)
  })
})

describe('resoudreFreinte', () => {
  const defauts = defautsFreinte([
    { groupe: 'coton', taux: 0.02 }, { groupe: 'coton', taux: 0.025 }, { groupe: 'coton', taux: 0.022 },
    { groupe: 'lin_chanvre', taux: 0.07 },
  ])
  const trois = [m(0.03, '2025-01-01'), m(0.04, '2025-02-01'), m(0.035, '2025-03-01')]

  it('forced beats measured beats default', () => {
    expect(resoudreFreinte({ forcee: 0.05, mesures: trois, groupe: 'coton', defauts })).toMatchObject({ taux: 0.05, source: 'forcee', mesuree: 0.035 })
    expect(resoudreFreinte({ forcee: null, mesures: trois, groupe: 'coton', defauts })).toMatchObject({ taux: 0.035, source: 'mesuree' })
    expect(resoudreFreinte({ forcee: null, mesures: [], groupe: 'coton', defauts })).toMatchObject({ taux: 0.022, source: 'defaut', defautGlobal: false, defautNbRefs: 3 })
  })
  it('falls back to all measured écrus when the matière has too few', () => {
    expect(resoudreFreinte({ forcee: null, mesures: [], groupe: 'lin_chanvre', defauts })).toMatchObject({ source: 'defaut', defautGlobal: true, defautNbRefs: 4 })
  })
  it('uses the last resort when nothing is measured', () => {
    expect(resoudreFreinte({ forcee: null, mesures: [], groupe: null, defauts: defautsFreinte([]) }).taux).toBe(FREINTE_REPLI)
  })
})

describe('conversions', () => {
  it('turns écru into yarn and back', () => {
    expect(filPourEcru(600, 0.03)).toBeCloseTo(618.56, 2)
    expect(ecruPourFil(filPourEcru(600, 0.03), 0.03)).toBeCloseTo(600, 6)
    expect(filPourEcru(600, 0)).toBe(600)
  })
  it('adds the safety margin and rounds the need up to 10 kg', () => {
    // 3911 040A: 600 kg écru, freinte 2.96 % → 618.3 → 649.2 → 650
    expect(besoinFil(600, 0.0296)).toMatchObject({ besoin: 650 })
    expect(besoinFil(600, 0.0296).fil).toBeCloseTo(618.30, 2)
    expect(besoinFil(600, 0.0296).avecMarge).toBeCloseTo(649.22, 2)
    // a 45 % yarn of the same line
    expect(besoinFil(600, 0.0296, 0.45).besoin).toBe(300)
    // an exact multiple stays put, nothing to make = nothing to order
    expect(besoinFil(200 / 1.05, 0).besoin).toBe(200)
    expect(besoinFil(0, 0.03).besoin).toBe(0)
  })
  it('groups matières', () => {
    expect(groupeDeMatiere('coton bio')).toBe('coton')
    expect(groupeDeMatiere('polyester recyclé')).toBe('synthetique')
    expect(groupeDeMatiere('elasthanne')).toBe('synthetique')
    expect(groupeDeMatiere('lin')).toBe('lin_chanvre')
    expect(groupeDeMatiere('Viscose')).toBe('autre')
  })
})
