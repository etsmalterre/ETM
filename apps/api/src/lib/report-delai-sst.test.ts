import { describe, expect, it } from 'vitest'
import { dateDeReference, estUnReportDelai, lireReport, retardDelai } from './report-delai-sst.js'

describe('report de délai sous-traitant (LIVA #1364)', () => {
  it('the first date and an earlier one are free; a later one is a report', () => {
    expect(estUnReportDelai('', '', '20261110')).toBe(false)
    expect(estUnReportDelai('20261110', '20261110', '20261105')).toBe(false)
    expect(estUnReportDelai('20261110', '20261110', '20261110')).toBe(false)
    expect(estUnReportDelai('20261110', '20261105', '20261112')).toBe(true)
    expect(estUnReportDelai('20261110', '', '2026-11-12')).toBe(true)
  })
  it('a cleared date is compared with the engagement', () => {
    expect(dateDeReference('', '20261110')).toBe('20261110')
    expect(estUnReportDelai('', '20261110', '20261120')).toBe(true)
    expect(estUnReportDelai('20261110', '20261110', '')).toBe(false)
  })
  it('the delay is in working days, public holidays and closures skipped', () => {
    expect(retardDelai('20261110', '20261113')).toBe(2) // 11/11 off
    expect(retardDelai('20261110', '20261105')).toBe(0)
    expect(retardDelai('', '20261105')).toBeNull()
    expect(retardDelai('20261110', '20261117', [{ du: '20261116', au: '20261116' }])).toBe(3)
  })
  it('a report needs a motif and a known imputable', () => {
    expect(lireReport({ motif: ' retard teinture ', imputable: 'sous_traitant' })).toEqual({ motif: 'retard teinture', imputable: 'sous_traitant' })
    expect(lireReport({ motif: '', imputable: 'malterre' })).toBeNull()
    expect(lireReport({ motif: 'x', imputable: 'client' })).toBeNull()
    expect(lireReport(undefined)).toBeNull()
  })
})
