import { describe, expect, it } from 'vitest'
import {
  SaisieInvalide,
  appliquerSaisie,
  epochDepuisHeure,
  heureDe,
  loginNormalise,
  periodeValide,
  presenceMin,
  verifierOrdre,
} from './pointage-admin.js'
import { msHeureParis } from './pointage-etat.js'

const s = (y: number, mo: number, d: number, h: number, mi: number) => Math.floor(msHeureParis(y, mo, d, h, mi) / 1000)
const vide = { debut: 0, debut_pause1: 0, fin_pause1: 0, debut_pause2: 0, fin_pause2: 0, fin: 0 }

describe('epochDepuisHeure — the legacy after-midnight rule', () => {
  it('places the start on the row date, whatever the hour', () => {
    expect(epochDepuisHeure('20260921', '21:00', 'debut', null)).toBe(s(2026, 9, 21, 21, 0))
    expect(epochDepuisHeure('20260921', '00:30', 'debut', null)).toBe(s(2026, 9, 21, 0, 30))
  })

  it('an hour strictly after the start stays on the same day', () => {
    expect(epochDepuisHeure('20260921', '12:30', 'fin', '08:00')).toBe(s(2026, 9, 21, 12, 30))
    expect(epochDepuisHeure('20260921', '08:01', 'debut_pause1', '08:00')).toBe(s(2026, 9, 21, 8, 1))
  })

  it('an hour at or before the start goes to the next day (night shift)', () => {
    expect(epochDepuisHeure('20260921', '05:00', 'fin', '21:00')).toBe(s(2026, 9, 22, 5, 0))
    // equal to the start: the legacy's strict `>` sends it to the next day too
    expect(epochDepuisHeure('20260921', '21:00', 'fin', '21:00')).toBe(s(2026, 9, 22, 21, 0))
  })

  it('crosses a month end and a DST change', () => {
    expect(epochDepuisHeure('20260930', '02:00', 'fin', '22:00')).toBe(s(2026, 10, 1, 2, 0))
    // 2026-10-25: clocks go back at 03:00 → 02:00 in Paris; 22:00 → 05:00 is 8 h wall clock, 9 h real
    const debut = epochDepuisHeure('20261024', '22:00', 'debut', null)
    const fin = epochDepuisHeure('20261024', '05:00', 'fin', '22:00')
    expect((fin - debut) / 3600).toBe(8)
  })

  it('refuses a malformed hour', () => {
    expect(() => epochDepuisHeure('20260921', '8h30', 'fin', '08:00')).toThrow(SaisieInvalide)
    expect(() => epochDepuisHeure('20260921', '24:00', 'fin', '08:00')).toThrow(SaisieInvalide)
  })
})

describe('appliquerSaisie — a correction over an existing line', () => {
  const ligne = {
    debut: s(2026, 9, 21, 8, 0),
    debut_pause1: s(2026, 9, 21, 10, 0),
    fin_pause1: s(2026, 9, 21, 10, 15),
    debut_pause2: 0,
    fin_pause2: 0,
    fin: 0,
  }

  it('closes a forgotten shift: only `fin` changes', () => {
    const out = appliquerSaisie('20260921', ligne, { fin: '16:30' })
    expect(out).toEqual({ ...ligne, fin: s(2026, 9, 21, 16, 30) })
  })

  it('clears a stamp with null', () => {
    const out = appliquerSaisie('20260921', ligne, { debut_pause1: null, fin_pause1: null })
    expect(out.debut_pause1).toBe(0)
    expect(out.fin_pause1).toBe(0)
  })

  it('never lets the start be emptied (legacy message)', () => {
    expect(() => appliquerSaisie('20260921', ligne, { debut: null })).toThrow(/début à vide/)
    expect(() => appliquerSaisie('20260921', null, { fin: '16:00' })).toThrow(/début à vide/)
  })

  it('creates a night shift from scratch', () => {
    const out = appliquerSaisie('20260921', null, { debut: '21:00', debut_pause1: '01:00', fin_pause1: '01:20', fin: '05:00' })
    expect(out.debut).toBe(s(2026, 9, 21, 21, 0))
    expect(out.debut_pause1).toBe(s(2026, 9, 22, 1, 0))
    expect(out.fin).toBe(s(2026, 9, 22, 5, 0))
  })

  it('refuses stamps out of order, naming the culprit (assumed delta over the legacy)', () => {
    expect(() => appliquerSaisie('20260921', null, { debut: '08:00', debut_pause1: '10:00', fin_pause1: '09:50' }))
      .toThrow(/fin de la pause 1 \(09:50\) est avant le début de la pause 1 \(10:00\)/)
    expect(() => appliquerSaisie('20260921', null, { debut: '08:00', fin_pause1: '10:00' })).toThrow(/pause 1 a une fin mais pas de début/)
    expect(() => appliquerSaisie('20260921', null, { debut: '08:00', debut_pause1: '10:00', debut_pause2: '11:00' }))
      .toThrow(/pause 2 commence alors que la pause 1/)
  })

  it('refuses to close a shift while a pause is still running', () => {
    const enPause = { ...ligne, fin_pause1: 0 }
    expect(() => appliquerSaisie('20260921', enPause, { fin: '16:30' })).toThrow(/fermé alors que la pause 1/)
    expect(() => appliquerSaisie('20260921', enPause, { fin: '16:30', fin_pause1: '10:20' })).not.toThrow()
  })

  it('a moved start re-places nothing else: the other stamps are absolute', () => {
    const out = appliquerSaisie('20260921', ligne, { debut: '07:30' })
    expect(out.debut).toBe(s(2026, 9, 21, 7, 30))
    expect(out.debut_pause1).toBe(ligne.debut_pause1)
  })
})

describe('verifierOrdre / presenceMin / heureDe', () => {
  it('accepts the empty tail of an open shift', () => {
    expect(() => verifierOrdre({ ...vide, debut: 10 })).not.toThrow()
  })
  it('presence is gross, pauses not deducted, null while open', () => {
    expect(presenceMin({ debut: s(2026, 9, 21, 8, 0), fin: s(2026, 9, 21, 16, 45) })).toBe(525)
    expect(presenceMin({ debut: s(2026, 9, 21, 8, 0), fin: 0 })).toBeNull()
  })
  it('formats Paris wall clock', () => {
    expect(heureDe(s(2026, 9, 21, 8, 2))).toBe('08:02')
    expect(heureDe(0)).toBe('')
  })
})

describe('periodeValide / loginNormalise', () => {
  it('checks the period shape and order', () => {
    expect(periodeValide('20260901', '20260930')).toEqual({ du: '20260901', au: '20260930' })
    expect(() => periodeValide('2026-09-01', '20260930')).toThrow(SaisieInvalide)
    expect(() => periodeValide('20260930', '20260901')).toThrow(/avant son début/)
  })
  it('upper-cases a 1–3 character login', () => {
    expect(loginNormalise(' mb ')).toBe('MB')
    expect(() => loginNormalise('ABCD')).toThrow(SaisieInvalide)
    expect(() => loginNormalise('')).toThrow(SaisieInvalide)
  })
})

// ── Semaines (FEN_Contrôles + FEN_Lissage) ──
import {
  cumulJourMin,
  lissePropose,
  lundiIso,
  minutesDepuisHM,
  nbSemainesIso,
  numeroSemaineIso,
  semaineDetail,
  semaineMaxControle,
  semaineMinControle,
  typePropose,
} from './pointage-admin.js'

const paris = (y: number, mo: number, d: number, h = 12, mi = 0) => msHeureParis(y, mo, d, h, mi)

describe('ISO weeks — the numbering of lst_lissage', () => {
  it('Monday of a week (week 1 holds 4 January)', () => {
    expect(lundiIso(2026, 1)).toBe('20251229')
    expect(lundiIso(2026, 38)).toBe('20260914')
    expect(lundiIso(2026, 53)).toBe('20261228')
    expect(lundiIso(2025, 1)).toBe('20241230')
  })
  it('week counts and week of a day', () => {
    expect(nbSemainesIso(2026)).toBe(53)
    expect(nbSemainesIso(2025)).toBe(52)
    expect(numeroSemaineIso('20260922')).toBe(39)
  })
})

describe('FEN_Contrôles bounds', () => {
  it('current year: up to last week', () => {
    expect(semaineMaxControle(2026, paris(2026, 9, 22))).toBe(38)
  })
  it('past year: its last week, 31/12 in week 1 falls back to 25/12', () => {
    expect(semaineMaxControle(2025, paris(2026, 9, 22))).toBe(1 === numeroSemaineIso('20251231') ? numeroSemaineIso('20251225') : numeroSemaineIso('20251231'))
    expect(semaineMaxControle(2024, paris(2026, 9, 22))).toBe(52) // 2024-12-31 is ISO week 1 of 2025 → the week of 25/12
  })
  it('first shift bounds the start', () => {
    expect(semaineMinControle(2026, '20260406', 38)).toBe(14)
    expect(semaineMinControle(2026, '20190417', 38)).toBe(0)
    expect(semaineMinControle(2026, null, 38)).toBe(38)
    expect(semaineMinControle(2025, '20260406', 52)).toBe(52)
  })
  it('the balance week of BTN_Détail', () => {
    expect(semaineDetail(2026, paris(2026, 9, 22))).toBe(38)
    expect(semaineDetail(2026, paris(2026, 1, 1))).toBe(1)
  })
})

describe('FEN_Lissage proposals', () => {
  it('type from the first start', () => {
    expect(typePropose(Math.floor(paris(2026, 9, 21, 5, 52) / 1000))).toBe('M')
    expect(typePropose(Math.floor(paris(2026, 9, 21, 8, 50) / 1000))).toBe('J')
    expect(typePropose(Math.floor(paris(2026, 9, 21, 13, 12) / 1000))).toBe('A')
    expect(typePropose(Math.floor(paris(2026, 9, 21, 21, 0) / 1000))).toBe('N')
    expect(typePropose(null)).toBe('J')
  })
  it('floor to the quarter hour, gross line durations, HH:MM parsing', () => {
    expect(lissePropose(416)).toBe(405) // 6:56 → 6:45
    expect(lissePropose(423)).toBe(420) // 7:03 → 7:00
    const d = Math.floor(paris(2026, 9, 21, 8, 50) / 1000)
    expect(cumulJourMin([{ debut: d, fin: d + 3 * 3600 + 15 * 60 + 40 }, { debut: d + 5 * 3600, fin: d + 9 * 3600 + 2 * 60 }, { debut: d, fin: 0 }])).toBe(437)
    expect(minutesDepuisHM('07:15')).toBe(435)
    expect(minutesDepuisHM('0:45')).toBe(45)
    expect(() => minutesDepuisHM('7h15')).toThrow(SaisieInvalide)
  })
})

// ── Données paie ──
import { paieSemaine, totauxPaie } from './pointage-admin.js'

describe('paieSemaine — meals and night hours of a validated week', () => {
  const j = (type: string, totalMin: number) => ({ type, totalMin })
  it('a day meal per M/A/E day of 6 h or more, a night meal per N day, nothing for J', () => {
    const s = paieSemaine({
      numero: 38,
      jours: [j('M', 420), j('A', 420), j('E', 359), j('J', 480), j('N', 480), j('N', 300), j('J', 0)],
      cumulSemaineMin: 2459,
    })
    expect(s.paniersJour).toBe(2) // E at 5:59 does not count
    expect(s.paniersNuit).toBe(1) // the 5 h night does not count
    expect(s.nuitMin).toBe(780) // both N days' hours count as night hours
    expect(s.totalMin).toBe(2459)
  })
  it('totals over a range', () => {
    const a = paieSemaine({ numero: 1, jours: [j('M', 420), j('M', 420), j('M', 420), j('M', 420), j('M', 420), j('J', 0), j('J', 0)], cumulSemaineMin: 2100 })
    const b = paieSemaine({ numero: 2, jours: [j('N', 480), j('N', 480), j('N', 480), j('N', 480), j('N', 480), j('J', 0), j('J', 0)], cumulSemaineMin: 2400 })
    expect(totauxPaie([a, b])).toEqual({ totalMin: 4500, nuitMin: 2400, paniersJour: 5, paniersNuit: 5 })
  })
})
