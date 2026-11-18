import { describe, expect, it } from 'vitest'
import { aujourdhuiParis, enRetard, joursRouges, planSynchronisation, type TacheRelevee } from './registre.js'

const t = (cle: string, raison = 'à lancer'): TacheRelevee => ({ cle, titre: `Commande ${cle}`, raison, lien: null })

describe('enRetard: more than 2 working days red', () => {
  it('red since Monday is late from Thursday', () => {
    // 2026-11-16 is a Monday.
    expect(enRetard('20261116', '20261116')).toBe(false)
    expect(enRetard('20261116', '20261117')).toBe(false)
    expect(enRetard('20261116', '20261118')).toBe(false)
    expect(enRetard('20261116', '20261119')).toBe(true)
  })

  it('a weekend does not count', () => {
    // Red since Thursday 19/11: Friday and Monday are the two days, late on Tuesday 24/11.
    expect(joursRouges('20261119', '20261123')).toBe(2)
    expect(enRetard('20261119', '20261123')).toBe(false)
    expect(enRetard('20261119', '20261124')).toBe(true)
  })

  it('a public holiday does not count', () => {
    // Red since Monday 09/11/2026; Wednesday 11/11 is a holiday: late on Friday 13/11, not Thursday.
    expect(enRetard('20261109', '20261112')).toBe(false)
    expect(enRetard('20261109', '20261113')).toBe(true)
  })

  it('never negative when the clock is behind', () => {
    expect(joursRouges('20261118', '20261117')).toBe(0)
  })
})

describe('planSynchronisation', () => {
  it('keeps a known key, enters a new one, closes a key no longer red', () => {
    const plan = planSynchronisation(['1', '2'], [t('2', 'à expédier'), t('3')])
    expect(plan.gardees.map((x) => x.cle)).toEqual(['2'])
    expect(plan.gardees[0].raison).toBe('à expédier')
    expect(plan.nouvelles.map((x) => x.cle)).toEqual(['3'])
    expect(plan.closes).toEqual(['1'])
  })

  it('an empty relevé closes the whole family', () => {
    expect(planSynchronisation(['1', '2'], []).closes).toEqual(['1', '2'])
  })

  it('counts a duplicate key once', () => {
    const plan = planSynchronisation([], [t('7'), t('7', 'autre')])
    expect(plan.nouvelles).toHaveLength(1)
    expect(plan.nouvelles[0].raison).toBe('à lancer')
  })
})

describe('aujourdhuiParis', () => {
  it('reads the Paris day, not the UTC one', () => {
    // 23:30 UTC on 17/11 is already 18/11 in Paris.
    expect(aujourdhuiParis(new Date('2026-11-17T23:30:00Z'))).toBe('20261118')
  })
})
