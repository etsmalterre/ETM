import { describe, expect, it } from 'vitest'
import { ajouterJoursOuvres, estOuvre, joursFeries, joursOuvresEntre } from './jours-ouvres.js'

describe('jours ouvrés (doctrine des délais §1)', () => {
  it('knows the French holidays, Easter-based ones included', () => {
    const f = joursFeries(2026)
    expect(f.has('20260406')).toBe(true) // lundi de Pâques
    expect(f.has('20260514')).toBe(true) // Ascension
    expect(f.has('20260525')).toBe(true) // lundi de Pentecôte
    expect(f.has('20260714')).toBe(true)
  })
  it('skips weekends, holidays and closures', () => {
    expect(estOuvre('20261031')).toBe(false) // samedi
    expect(estOuvre('20261111')).toBe(false) // 11 novembre
    expect(estOuvre('20260810', [{ du: '20260803', au: '20260821' }])).toBe(false)
    expect(estOuvre('20260824', [{ du: '20260803', au: '20260821' }])).toBe(true)
  })
  it('adds working days across a closure', () => {
    // Friday 31/07 + 5 working days, MATEL closed 03/08 → 21/08: Friday 28/08.
    expect(ajouterJoursOuvres('20260731', 5, [{ du: '20260803', au: '20260821' }])).toBe('20260828')
    expect(ajouterJoursOuvres('20260731', 5)).toBe('20260807')
  })
  it('counts working days between two dates, closures out', () => {
    expect(joursOuvresEntre('20260625', '20260909')).toBe(53) // 14/07 and 15/08 (a Saturday) aside
    expect(joursOuvresEntre('20260625', '20260909', [{ du: '20260803', au: '20260821' }])).toBe(38)
  })
})
