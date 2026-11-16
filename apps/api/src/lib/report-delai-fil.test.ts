import { describe, expect, it } from 'vitest'
import { ecritureDelaiFil, lireReportFil, retardFil } from './report-delai-fil.js'

const TODAY = '20261116'
const ligne = (date_livraison: string | null, date_delai: string | null, donne_le: string | null = null) => ({ date_livraison, date_delai, donne_le })

describe('ecritureDelaiFil', () => {
  it('the first date is the engagement', () => {
    expect(ecritureDelaiFil(ligne(null, null), '2026-12-08', TODAY)).toEqual({ type: 'engagement', date: '20261208' })
  })

  it('a later date is a report from the current date', () => {
    expect(ecritureDelaiFil(ligne('20261113', '20261113'), '20261127', TODAY)).toEqual({ type: 'report', ancien: '20261113', date: '20261127' })
    // a second report starts from the date already pushed, not from the engagement
    expect(ecritureDelaiFil(ligne('20261127', '20261113'), '20261204', TODAY)).toEqual({ type: 'report', ancien: '20261127', date: '20261204' })
  })

  it('an earlier date is free and leaves the engagement', () => {
    expect(ecritureDelaiFil(ligne('20261127', '20261113'), '20261120', TODAY)).toEqual({ type: 'avance', date: '20261120' })
  })

  it('the day the engagement is given, a correction is the engagement', () => {
    expect(ecritureDelaiFil(ligne('20261208', '20261208', TODAY), '20261218', TODAY)).toEqual({ type: 'engagement', date: '20261218' })
    expect(ecritureDelaiFil(ligne('20261208', '20261208', '20261115'), '20261218', TODAY).type).toBe('report')
  })

  it('same date or no date: nothing', () => {
    expect(ecritureDelaiFil(ligne('20261113', '20261113'), '20261113', TODAY)).toEqual({ type: 'inchange' })
    expect(ecritureDelaiFil(ligne('20261113', '20261113'), '', TODAY)).toEqual({ type: 'inchange' })
  })

  it('a line whose date was cleared keeps its engagement', () => {
    expect(ecritureDelaiFil(ligne(null, '20261113'), '20261120', TODAY)).toEqual({ type: 'report', ancien: '20261113', date: '20261120' })
  })
})

describe('retardFil', () => {
  it('counts working days behind the engagement, never negative', () => {
    expect(retardFil('20261113', '20261120')).toBe(5) // Friday → next Friday
    expect(retardFil('20261113', '20261113')).toBe(0)
    expect(retardFil('20261113', '20261110')).toBe(0)
    expect(retardFil(null, '20261110')).toBe(0)
  })
})

describe('lireReportFil', () => {
  it('needs a motif and a known imputable', () => {
    expect(lireReportFil({ motif: ' Filature en retard ', imputable: 'fournisseur' })).toEqual({ motif: 'Filature en retard', imputable: 'fournisseur' })
    expect(lireReportFil({ motif: '', imputable: 'fournisseur' })).toBeNull()
    expect(lireReportFil({ motif: 'x', imputable: 'client' })).toBeNull()
    expect(lireReportFil(undefined)).toBeNull()
  })
})
