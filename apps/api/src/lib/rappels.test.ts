import { describe, expect, it } from 'vitest'
import { aujourdhuiIso, dateValide, estEchu, OBSERVATION_MAX, rappelEnRetard, refusRappel } from './rappels.js'
import { lienObjet, TYPES_OBJET } from './rappels-objets.js'

describe('refusRappel', () => {
  const today = '2026-11-18'

  it('accepts today and any later day', () => {
    expect(refusRappel({ echeance: '2026-11-18', observation: 'Rappeler le client' }, today)).toBeNull()
    expect(refusRappel({ echeance: '2027-05-04', observation: 'Lemahieu reprend la matière' }, today)).toBeNull()
  })

  it('refuses a past date: a reminder is for later', () => {
    expect(refusRappel({ echeance: '2026-11-17' }, today)?.code).toBe('date_passee')
  })

  it('refuses a missing or impossible date', () => {
    expect(refusRappel({ echeance: '' }, today)?.code).toBe('date_invalide')
    expect(refusRappel({ echeance: '2027-02-30' }, today)?.code).toBe('date_invalide')
    expect(refusRappel({ echeance: '04/05/2027' }, today)?.code).toBe('date_invalide')
  })

  it('needs an observation: what to do on the day', () => {
    expect(refusRappel({ observation: '   ' }, today)?.code).toBe('observation_requise')
    expect(refusRappel({ observation: 'x'.repeat(OBSERVATION_MAX + 1) }, today)?.code).toBe('observation_longue')
  })

  it('checks only what is given (a « Repousser » sends the date alone)', () => {
    expect(refusRappel({ echeance: '2026-12-01' }, today)).toBeNull()
    expect(refusRappel({}, today)).toBeNull()
  })
})

describe('estEchu / rappelEnRetard', () => {
  const r = (echeance: string, fait_le: string | null = null) => ({ echeance, fait_le })

  it('is due from its date, the day itself included', () => {
    expect(estEchu(r('2026-11-19'), '2026-11-18')).toBe(false)
    expect(estEchu(r('2026-11-18'), '2026-11-18')).toBe(true)
    expect(estEchu(r('2026-11-10'), '2026-11-18')).toBe(true)
  })

  it('a done reminder is never due', () => {
    expect(estEchu(r('2026-11-10', '2026-11-12'), '2026-11-18')).toBe(false)
  })

  it('is late once left more than 2 working days after its date', () => {
    // Due Monday 16/11: late from Thursday 19/11.
    expect(rappelEnRetard(r('2026-11-16'), '2026-11-18')).toBe(false)
    expect(rappelEnRetard(r('2026-11-16'), '2026-11-19')).toBe(true)
    expect(rappelEnRetard(r('2026-11-16', '2026-11-17'), '2026-11-19')).toBe(false)
  })
})

describe('dates', () => {
  it('reads the Paris day', () => {
    expect(aujourdhuiIso(new Date('2026-11-17T23:30:00Z'))).toBe('2026-11-18')
  })
  it('knows a real day from an impossible one', () => {
    expect(dateValide('2028-02-29')).toBe(true)
    expect(dateValide('2027-02-29')).toBe(false)
    expect(dateValide(20270504)).toBe(false)
  })
})

describe('lienObjet', () => {
  it('opens every type on its screen, with the object named in the URL', () => {
    for (const t of TYPES_OBJET) expect(lienObjet(t, 42)).toMatch(/^\/[a-z-]+\/[a-z-]+\?[a-z]+=42/)
  })
})
