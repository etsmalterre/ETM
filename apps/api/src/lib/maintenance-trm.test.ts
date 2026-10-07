import { describe, expect, it } from 'vitest'
import { etatPeriodique, etatRouloir, indexKg, kgDepuis, kgParPeriode, monthsSince, pireEtat } from './maintenance-trm.js'

describe('kgDepuis', () => {
  const idx = indexKg([
    { jour: '20260901', kg: 10 },
    { jour: '20260901', kg: 5 },
    { jour: '20260905', kg: 20 },
    { jour: '20260910', kg: 30 },
    { jour: 'bogus', kg: 99 },
  ])

  it('counts days strictly after the maintenance day', () => {
    expect(kgDepuis(idx, '20260901')).toBe(50)
    expect(kgDepuis(idx, '20260831')).toBe(65)
    expect(kgDepuis(idx, '20260904')).toBe(50)
    expect(kgDepuis(idx, '20260905')).toBe(30)
    expect(kgDepuis(idx, '20260910')).toBe(0)
  })

  it('null without a date, 0 without production', () => {
    expect(kgDepuis(idx, null)).toBeNull()
    expect(kgDepuis(undefined, '20260101')).toBe(0)
    expect(kgDepuis(indexKg([]), '20260101')).toBe(0)
  })
})

describe('periodic state', () => {
  const today = new Date(2026, 9, 1) // 1 Oct 2026

  it('months elapsed, floored by the day of month', () => {
    expect(monthsSince('20260701', today)).toBe(3)
    expect(monthsSince('20260702', today)).toBe(2)
    expect(monthsSince('20261015', today)).toBe(0)
    expect(monthsSince(null, today)).toBeNull()
  })

  it('due at the frequency, amber from 2/3', () => {
    expect(etatPeriodique(3, 3).etat).toBe('due')
    expect(etatPeriodique(2, 3).etat).toBe('proche')
    expect(etatPeriodique(1, 3).etat).toBe('ok')
    expect(etatPeriodique(null, 3).etat).toBe('inconnu')
    expect(etatPeriodique(5, 0).etat).toBe('inconnu')
  })

  it('rouloir is never due without a visit', () => {
    expect(etatRouloir(2, false)).toBe('ok')
    expect(etatRouloir(1, true)).toBe('due')
  })

  it('worst state wins, unknown never raises it', () => {
    expect(pireEtat(['ok', 'inconnu'])).toBe('ok')
    expect(pireEtat(['ok', 'proche', 'due'])).toBe('due')
    expect(pireEtat([])).toBe('ok')
  })
})

describe('kgParPeriode', () => {
  const idx = indexKg([
    { jour: '20260901', kg: 10 },
    { jour: '20260905', kg: 20 },
    { jour: '20260910', kg: 30 },
  ])

  it('gives each entry the kg up to the next one, the newest its running total', () => {
    // Newest first: done on 09-05, then 08-31.
    expect(kgParPeriode(idx, [{ date: '20260905' }, { date: '20260831' }])).toEqual([30, 30])
  })

  it('counts a roll weighed on the next entry day in the earlier period', () => {
    expect(kgParPeriode(idx, [{ date: '20260910' }, { date: '20260901' }])).toEqual([0, 50])
  })

  it('gives 0 to two entries on the same day', () => {
    expect(kgParPeriode(idx, [{ date: '20260905' }, { date: '20260905' }])).toEqual([30, 0])
  })

  it('handles a métier without rolls and an empty history', () => {
    expect(kgParPeriode(undefined, [{ date: '20260905' }])).toEqual([0])
    expect(kgParPeriode(idx, [])).toEqual([])
  })
})
