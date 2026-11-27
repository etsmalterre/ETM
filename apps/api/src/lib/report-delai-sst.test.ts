import { describe, expect, it } from 'vitest'
import { aujourdhuiParisYmd, dateDeReference, estUneAvanceAnnoncee, estUneAvanceDelai, estUnReportDelai, lireReport, retardDelai } from './report-delai-sst.js'

describe('report de délai sous-traitant (LIVA #1364)', () => {
  it('the first date and an earlier one are free; a later one is a report', () => {
    expect(estUnReportDelai('', '', '20261110')).toBe(false)
    expect(estUnReportDelai('20261110', '20261110', '20261105')).toBe(false)
    expect(estUnReportDelai('20261110', '20261110', '20261110')).toBe(false)
    expect(estUnReportDelai('20261110', '20261105', '20261112')).toBe(true)
    expect(estUnReportDelai('20261110', '', '2026-11-12')).toBe(true)
  })
  it('an advance is accepted when announced ahead: the new date is still to come (order 9161, 2026-11-27)', () => {
    // MATEL confirms the 11/12 instead of the 17/12, on 27/11.
    expect(estUneAvanceDelai('20261217', '20261217', '20261211')).toBe(true)
    expect(estUneAvanceAnnoncee('20261211', '20261127')).toBe(true)
    expect(estUneAvanceAnnoncee('2026-11-28', '20261127')).toBe(true)
    // Today or past = a delivery read back into the délai: still refused.
    expect(estUneAvanceAnnoncee('20261127', '20261127')).toBe(false)
    expect(estUneAvanceAnnoncee('20261120', '20261127')).toBe(false)
    expect(estUneAvanceAnnoncee('', '20261127')).toBe(false)
  })
  it('today is read in Paris', () => {
    expect(aujourdhuiParisYmd(new Date('2026-11-27T23:30:00Z'))).toBe('20261128')
    expect(aujourdhuiParisYmd(new Date('2026-07-01T21:59:00Z'))).toBe('20260701')
  })
  it('bringing a given délai earlier is an advance; the first date and clearing are not', () => {
    expect(estUneAvanceDelai('20261118', '20261118', '20261110')).toBe(true)
    expect(estUneAvanceDelai('', '20261118', '20261110')).toBe(true)
    expect(estUneAvanceDelai('', '', '20261110')).toBe(false)
    expect(estUneAvanceDelai('20261118', '20261118', '')).toBe(false)
    expect(estUneAvanceDelai('20261118', '20261118', '20261118')).toBe(false)
    expect(estUneAvanceDelai('20261118', '20261118', '20261120')).toBe(false)
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
    // The client since 2026-11-11 (a late coloris answer); anything else is unknown.
    expect(lireReport({ motif: 'x', imputable: 'client' })).toEqual({ motif: 'x', imputable: 'client' })
    expect(lireReport({ motif: 'x', imputable: 'partenaire' })).toBeNull()
    expect(lireReport(undefined)).toBeNull()
  })
})
