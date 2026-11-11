import { describe, expect, it } from 'vitest'
import { aideInutile, apportMesures, conseiller, crantSuivant, mesurer, nouveauBloc, tirer, type PointMesure } from './competences.js'

const p = (x: Partial<PointMesure>): PointMesure => ({ decision: 'saisie', statut: 'validee', le: '2026-11-05T10:00', ...x })

describe('the autonomy draw (doctrine §2)', () => {
  it('a block of N holds round(X % × N) slots done alone', () => {
    for (const [taux, n, seuls] of [[10, 10, 1], [25, 10, 3], [50, 4, 2], [75, 8, 6]] as const) {
      expect(nouveauBloc(taux, n).filter(Boolean)).toHaveLength(seuls)
    }
  })

  it('draws through the block, then starts a new one', () => {
    let e = { mode: 'autonomie' as const, taux: 10, fenetre: 10 }
    let seuls = 0
    for (let i = 0; i < 30; i++) {
      const t = tirer(e)
      if (t.seul) seuls++
      e = t.etat as typeof e
    }
    expect(seuls).toBe(3)
  })

  it('is random: the slot alone is not always the same', () => {
    const positions = new Set(Array.from({ length: 50 }, () => nouveauBloc(10, 10).indexOf(true)))
    expect(positions.size).toBeGreaterThan(1)
  })

  it('never alone outside autonomie', () => {
    for (const mode of ['off', 'essai', 'supervise'] as const) expect(tirer({ mode }).seul).toBe(false)
  })
})

describe('the three measures (doctrine §4)', () => {
  it('Vincent’s table: validated, corrected, aide', () => {
    const m = mesurer([
      p({ statut: 'validee' }),
      p({ statut: 'corrigee' }),
      p({ statut: 'supprimee' }),
      p({ decision: 'aide', statut: 'resolue', proposition: '2026-12-02', valeurFinale: '2026-12-09' }),
    ])
    expect(m.fiabilite).toMatchObject({ num: 1, den: 3 })
    expect(m.autonomie).toMatchObject({ num: 3, den: 4 })
    expect(m.discernement).toMatchObject({ num: 1, den: 1 })
  })

  it('an aide never counts in fiabilité', () => {
    expect(mesurer([p({ decision: 'aide', statut: 'a_revoir' })]).fiabilite.den).toBe(0)
  })

  it('« rien » is judged too, and an omission is a fiabilité échec', () => {
    const m = mesurer([p({ decision: 'rien', statut: 'validee' }), p({ decision: 'rien', statut: 'omission' })])
    expect(m.fiabilite).toMatchObject({ num: 1, den: 2 })
    expect(m.autonomie).toMatchObject({ num: 2, den: 2 })
  })

  it('an aide settled on its own proposal was not needed', () => {
    expect(aideInutile({ proposition: '2026-12-02', valeurFinale: '2026-12-02' })).toBe(true)
    expect(aideInutile({ proposition: null, valeurFinale: '2026-12-02' })).toBe(false)
    const m = mesurer([p({ decision: 'aide', statut: 'resolue', proposition: 'x', valeurFinale: 'x' })])
    expect(m.discernement).toMatchObject({ num: 0, den: 1 })
  })

  it('the person’s answer decides Discernement, not the value kept (proposal right, asking still right)', () => {
    const m = mesurer([
      p({ decision: 'aide', statut: 'resolue', proposition: 'x', valeurFinale: 'x', douteJustifie: true }),
      p({ decision: 'aide', statut: 'resolue', proposition: 'x', valeurFinale: 'y', douteJustifie: false }),
    ])
    expect(m.discernement).toMatchObject({ num: 1, den: 2 })
  })

  it('an autonomous point nobody looked at is « non revu », never a réussite', () => {
    const m = mesurer([p({ statut: 'autonome', autonome: true })])
    expect(m.nonRevus).toBe(1)
    expect(m.fiabilite.den).toBe(0)
  })
})

describe('what one execution brings to the measures', () => {
  const le = '2026-11-11T08:00:00.000Z'
  const z = { plus: 0, moins: 0, attente: 0 }
  it('counts each point for, against, or waiting', () => {
    const a = apportMesures([
      { decision: 'saisie', statut: 'validee', le },
      { decision: 'saisie', statut: 'corrigee', le },
      { decision: 'rien', statut: 'a_revoir', le },
      { decision: 'aide', statut: 'a_revoir', le },
      { decision: 'aide', statut: 'resolue', douteJustifie: true, le },
      { decision: 'aide', statut: 'resolue', douteJustifie: false, le },
    ])
    expect(a.fiabilite).toEqual({ ...z, plus: 1, moins: 1, attente: 1 })
    expect(a.autonomie).toEqual({ ...z, plus: 3, moins: 3 })
    expect(a.discernement).toEqual({ ...z, plus: 1, moins: 1, attente: 1 })
  })
  it('reads only the fiabilité in observation', () => {
    const a = apportMesures([
      { decision: 'saisie', statut: 'validee', observation: true, le },
      { decision: 'saisie', statut: 'observation', observation: true, le },
      { decision: 'aide', statut: 'resolue', douteJustifie: true, observation: true, le },
    ])
    expect(a.fiabilite).toEqual({ ...z, plus: 1, attente: 1 })
    expect(a.autonomie).toEqual(z)
    expect(a.discernement).toEqual(z)
  })
})

describe('up / down (doctrine §5)', () => {
  const juges = (n: number, ko = 0) => Array.from({ length: n }, (_, i) => p({ statut: i < ko ? 'corrigee' : 'validee', le: `2026-11-${String(1 + (i % 28)).padStart(2, '0')}` }))
  const modes = ['off', 'essai', 'supervise', 'autonomie'] as const

  it('proposes 10 % once 30 points are judged at ≥ 95 %', () => {
    expect(conseiller({ mode: 'supervise' }, modes, juges(29)).monter).toBeNull()
    expect(conseiller({ mode: 'supervise' }, modes, juges(30)).monter).toMatchObject({ mode: 'autonomie', taux: 10 })
    expect(conseiller({ mode: 'supervise' }, modes, juges(30, 2)).monter).toBeNull()
  })

  it('steps through the paliers, stops at the top and for a skill without autonomie', () => {
    expect(crantSuivant({ mode: 'autonomie', taux: 10 }, modes)).toMatchObject({ taux: 25 })
    expect(crantSuivant({ mode: 'autonomie', taux: 75 }, modes)).toBeNull()
    expect(crantSuivant({ mode: 'supervise' }, ['off', 'essai', 'supervise'])).toBeNull()
  })

  it('proposes to go down after an autonomous point was corrected', () => {
    const e = { mode: 'autonomie' as const, taux: 10, changeLe: '2026-11-01' }
    expect(conseiller(e, modes, [p({ autonome: true, statut: 'corrigee', le: '2026-11-03' })]).descendre).toBeTruthy()
    expect(conseiller(e, modes, [p({ autonome: true, statut: 'corrigee', le: '2026-10-30' })]).descendre).toBeNull()
  })
})
