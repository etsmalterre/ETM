import { describe, it, expect } from 'vitest'
import {
  REGIMES, intervallesRegime, construireCalendrier, avancer, minutesOuvrees, prochainOuvert,
  mesurerRendements, planifier, resteAPlanifier, dureeMinutes, DUREE_INCONNUE_MIN,
  HEURE, MINUTE, type Aptitude, type Calendrier,
} from './planning-prod-trm.js'

// Local-time helper: d(2026, 10, 5, 5) = Monday 5 October 2026, 05:00.
const d = (y: number, mo: number, day: number, h = 0, mi = 0) => new Date(y, mo - 1, day, h, mi).getTime()

describe('régimes', () => {
  it('3×8 runs Monday 5 h → Saturday 5 h, nothing on the weekend', () => {
    const w = intervallesRegime(REGIMES['3x8'].semaine, d(2026, 10, 5), d(2026, 10, 12))
    expect(w).toEqual([{ debut: d(2026, 10, 5, 5), fin: d(2026, 10, 10, 5) }])
  })

  it('2×8 is 5–21 and 2×7 is 6–20, Monday to Friday', () => {
    const w8 = intervallesRegime(REGIMES['2x8'].semaine, d(2026, 10, 5), d(2026, 10, 6))
    expect(w8).toEqual([{ debut: d(2026, 10, 5, 5), fin: d(2026, 10, 5, 21) }])
    const w7 = intervallesRegime(REGIMES['2x7'].semaine, d(2026, 10, 9), d(2026, 10, 12))
    expect(w7).toEqual([{ debut: d(2026, 10, 9, 6), fin: d(2026, 10, 9, 20) }])
  })

  it('a night window that began the day before covers the start instant', () => {
    // Tuesday 02:00 under 3×8 is inside Monday's 05:00 → Tuesday 05:00.
    const w = intervallesRegime(REGIMES['3x8'].semaine, d(2026, 10, 6, 2), d(2026, 10, 6, 6))
    expect(w).toEqual([{ debut: d(2026, 10, 6, 2), fin: d(2026, 10, 6, 6) }])
  })
})

describe('construireCalendrier', () => {
  const postes = [
    // Thursday 1 and Friday 2 October booked 5–21 (2 teams), then nothing.
    { debut: d(2026, 10, 1, 5), fin: d(2026, 10, 1, 13) },
    { debut: d(2026, 10, 1, 13), fin: d(2026, 10, 1, 21) },
    { debut: d(2026, 10, 2, 5), fin: d(2026, 10, 2, 21) },
  ]

  it('uses the bonnetier planning while it is filled, then the régime', () => {
    const cal = construireCalendrier({ maintenant: d(2026, 10, 1, 10), postes, semaine: REGIMES['3x8'].semaine, jours: 10 })
    expect(cal.reelJusqua).toBe(d(2026, 10, 3))
    // Real: today 10–21, Friday 5–21. Potential: from Monday 5 h, 3×8.
    expect(cal.ouvert[0]).toEqual({ debut: d(2026, 10, 1, 10), fin: d(2026, 10, 1, 21) })
    expect(cal.ouvert[1]).toEqual({ debut: d(2026, 10, 2, 5), fin: d(2026, 10, 2, 21) })
    expect(cal.ouvert[2]).toEqual({ debut: d(2026, 10, 5, 5), fin: d(2026, 10, 10, 5) })
  })

  it('a day with no booking inside the real span is a day off', () => {
    const trou = [postes[0], { debut: d(2026, 10, 5, 5), fin: d(2026, 10, 5, 21) }]
    const cal = construireCalendrier({ maintenant: d(2026, 10, 1, 6), postes: trou, semaine: REGIMES['3x8'].semaine, jours: 10 })
    expect(minutesOuvrees(cal.ouvert, d(2026, 10, 2), d(2026, 10, 3))).toBe(0)
  })

  it('caps the real span at 21 days', () => {
    const loin = [{ debut: d(2026, 12, 1, 5), fin: d(2026, 12, 1, 21) }]
    const cal = construireCalendrier({ maintenant: d(2026, 10, 1, 6), postes: loin, semaine: REGIMES['3x8'].semaine, jours: 60 })
    expect(cal.reelJusqua).toBe(d(2026, 10, 22))
  })

  it('with nothing booked ahead, everything is potential', () => {
    const cal = construireCalendrier({ maintenant: d(2026, 10, 1, 6), postes: [], semaine: REGIMES['2x8'].semaine, jours: 2 })
    expect(cal.reelJusqua).toBe(d(2026, 10, 1, 6))
    expect(cal.ouvert[0]).toEqual({ debut: d(2026, 10, 1, 6), fin: d(2026, 10, 1, 21) })
  })
})

describe('avancer', () => {
  const ouvert = [
    { debut: d(2026, 10, 5, 5), fin: d(2026, 10, 5, 21) },
    { debut: d(2026, 10, 6, 5), fin: d(2026, 10, 6, 21) },
  ]
  it('skips the closed hours', () => {
    // 10 worked hours from Monday 15:00 = 6 h Monday + 4 h Tuesday → 09:00.
    expect(avancer(ouvert, d(2026, 10, 5, 15), 600)).toBe(d(2026, 10, 6, 9))
  })
  it('a start in closed time waits for the next window', () => {
    expect(prochainOuvert(ouvert, d(2026, 10, 5, 23))).toBe(d(2026, 10, 6, 5))
    expect(avancer(ouvert, d(2026, 10, 5, 23), 60)).toBe(d(2026, 10, 6, 6))
  })
  it('null past the calendar', () => {
    expect(avancer(ouvert, d(2026, 10, 5, 5), 40 * 60)).toBeNull()
  })
})

describe('dureeMinutes', () => {
  it('is the legacy tours formula over the rendement', () => {
    // 100 kg, 600 tours / 10 kg, 20 tr/min, rendement 0,5 → 100/10 × 600 / 20 / 0,5 = 600 min.
    expect(dureeMinutes(100, { tours10kg: 600, vitesse: 20 }, 0.5)).toEqual({ minutes: 600, approx: false })
  })
  it('falls back loudly when a factor is missing', () => {
    expect(dureeMinutes(100, null, 0.5)).toEqual({ minutes: DUREE_INCONNUE_MIN, approx: true })
    expect(dureeMinutes(100, { tours10kg: 600, vitesse: 0 }, 0.5).approx).toBe(true)
  })
})

describe('mesurerRendements', () => {
  const ouvert = [{ debut: d(2026, 9, 1), fin: d(2026, 9, 30) }] // all worked
  const ech = (idmachine: number, theoriques: number, heures: number, jour: number) =>
    ({ idmachine, kg: 100, theoriques, debut: d(2026, 9, jour, 0), fin: d(2026, 9, jour, 0) + heures * HEURE })

  it('takes the median ratio per métier and the parc median as fallback', () => {
    const r = mesurerRendements([
      ech(1, 300, 10, 1), ech(1, 300, 10, 2), ech(1, 240, 10, 3), // 0.5, 0.5, 0.4 → 0.5
      ech(2, 300, 10, 4), // one sample only → parc
    ], ouvert)
    expect(r.parMachine.get(1)).toEqual({ valeur: 0.5, source: 'mesure', echantillons: 3 })
    expect(r.parMachine.has(2)).toBe(false)
    expect(r.parc.valeur).toBe(0.5)
  })

  it('measures against worked time only', () => {
    // 10 h elapsed but only 5 h worked → 300 min / 300 min = 1.
    const demi = [{ debut: d(2026, 9, 1, 0), fin: d(2026, 9, 1, 5) }]
    const r = mesurerRendements([ech(1, 300, 10, 1), ech(1, 300, 10, 1), ech(1, 300, 10, 1)], demi)
    expect(r.parMachine.get(1)?.valeur).toBe(1)
  })

  it('bounds the value', () => {
    const r = mesurerRendements([ech(1, 10, 10, 1), ech(1, 10, 10, 2), ech(1, 10, 10, 3)], ouvert)
    expect(r.parMachine.get(1)?.valeur).toBe(0.15)
  })
})

describe('planifier', () => {
  // Continuous calendar so durations read directly.
  const t0 = d(2026, 10, 5, 0)
  const cal: Calendrier = { ouvert: [{ debut: t0, fin: t0 + 100 * 24 * HEURE }], depuis: t0, jusqua: t0 + 100 * 24 * HEURE, reelJusqua: t0 }
  // 60 min per 10 kg at rendement 1: tours10kg 600, vitesse 10.
  const apt: Aptitude = { tours10kg: 600, vitesse: 10 }
  const machines = [{ id: 1, rendement: 1 }, { id: 2, rendement: 0.5 }]

  it('chains the running OF, the queue, then the lines', () => {
    const { segments } = planifier({
      calendrier: cal, machines,
      ofs: [
        { id: 11, idmachine: 1, actif: false, priorite: 3, resteKg: 10, ligneId: 101, aptitude: apt },
        { id: 10, idmachine: 1, actif: true, priorite: 1, resteKg: 20, ligneId: 100, aptitude: apt },
      ],
      lignes: [{ ligneId: 200, resteKg: 10, delai: null, aptitudes: new Map([[1, apt]]), epingle: null }],
    })
    expect(segments.map((s) => [s.type, s.id, (s.debut - t0) / MINUTE, (s.fin - t0) / MINUTE])).toEqual([
      ['of', 10, 0, 120], ['of', 11, 120, 180], ['ligne', 200, 180, 240],
    ])
  })

  it('an automatic line goes where it ends first; a slower métier stretches it', () => {
    const both = new Map([[1, apt], [2, apt]])
    const { segments } = planifier({
      calendrier: cal, machines,
      ofs: [{ id: 10, idmachine: 1, actif: true, priorite: 1, resteKg: 100, ligneId: 100, aptitude: apt }], // métier 1 busy 600 min
      lignes: [{ ligneId: 200, resteKg: 10, delai: null, aptitudes: both, epingle: null }],
    })
    const l = segments.find((s) => s.type === 'ligne')!
    expect(l.idmachine).toBe(2)
    expect((l.fin - l.debut) / MINUTE).toBe(120) // rendement 0,5 doubles the 60 min
  })

  it('serves the earliest délai first and pinned lines before automatic ones', () => {
    const only1 = new Map([[1, apt]])
    const { segments } = planifier({
      calendrier: cal, machines, ofs: [],
      lignes: [
        { ligneId: 300, resteKg: 10, delai: d(2026, 12, 1), aptitudes: only1, epingle: null },
        { ligneId: 301, resteKg: 10, delai: d(2026, 11, 1), aptitudes: only1, epingle: null },
        { ligneId: 302, resteKg: 10, delai: null, aptitudes: only1, epingle: { idmachine: 1, rang: 2 } },
        { ligneId: 303, resteKg: 10, delai: null, aptitudes: only1, epingle: { idmachine: 1, rang: 1 } },
      ],
    })
    expect(segments.map((s) => s.id)).toEqual([303, 302, 301, 300])
    expect(segments.filter((s) => s.epingle).map((s) => s.id)).toEqual([303, 302])
  })

  it('a pin on a métier that no longer fits falls back to automatic; no fitting métier → non planifiable', () => {
    const { segments, nonPlanifiables } = planifier({
      calendrier: cal, machines, ofs: [],
      lignes: [
        { ligneId: 400, resteKg: 10, delai: null, aptitudes: new Map([[2, apt]]), epingle: { idmachine: 1, rang: 1 } },
        { ligneId: 401, resteKg: 10, delai: null, aptitudes: new Map([[9, apt]]), epingle: null },
      ],
    })
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ id: 400, idmachine: 2, epingle: false })
    expect(nonPlanifiables).toEqual([401])
  })
})

describe('resteAPlanifier', () => {
  it('ignores rounding between the line and its OFs', () => {
    expect(resteAPlanifier(300, 299.5)).toBe(0)
    expect(resteAPlanifier(1000, 985)).toBe(0) // under 2 %
    expect(resteAPlanifier(1000, 600)).toBe(400)
  })
})
