import { describe, expect, it } from 'vitest'
import { etatPeriodique, etatRouloir, indexKg, kgDepuis, monthsSince, pireEtat } from './maintenance-trm.js'

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
