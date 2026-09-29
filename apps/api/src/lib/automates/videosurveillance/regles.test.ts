import { describe, expect, it } from 'vitest'
import { calculerCible, conforme, coupeeALaMain, lundiParis, tableFixe, type Poste } from './regles.js'
import { indexHeure, plagesLisibles, semaineDepuisLundi } from '../../reolink.js'
import { msHeureParis } from '../../pointage-etat.js'

const h = (jour: string, heure: number, mi = 0) => msHeureParis(+jour.slice(0, 4), +jour.slice(5, 7), +jour.slice(8, 10), heure, mi)
const poste = (jour: string, debut: number, finJour: string, fin: number): Poste => ({ debutMs: h(jour, debut), finMs: h(finJour, fin) })

// Week of Monday 2026-10-05 … Sunday 2026-10-11, next week from 2026-10-12.
const semaineType: Poste[] = [
  poste('2026-10-05', 5, '2026-10-05', 13),
  poste('2026-10-05', 13, '2026-10-05', 21),
  poste('2026-10-06', 5, '2026-10-06', 13),
  poste('2026-10-06', 21, '2026-10-07', 5), // one night shift, Tue → Wed
  // next week planned too (one shift is enough to count as planned)
  poste('2026-10-12', 5, '2026-10-12', 13),
]

describe('tableFixe', () => {
  it('is the NVR schedule of before the automate: Fri 18h → Mon 05h', () => {
    expect(plagesLisibles(tableFixe())).toEqual(['ven. 18h → lun. 05h'])
  })
})

describe('plagesLisibles', () => {
  it('reads a table Monday first, with the Sunday → Monday run kept whole', () => {
    const t = Array(168).fill('0')
    t[indexHeure(3, 10)] = '1'
    t[indexHeure(3, 11)] = '1'
    for (let x = 22; x < 24; x++) t[indexHeure(7, x)] = '1'
    for (let x = 0; x < 3; x++) t[indexHeure(1, x)] = '1'
    expect(plagesLisibles(t.join(''))).toEqual(['mer. 10h → mer. 12h', 'dim. 22h → lun. 03h'])
  })

  it('handles empty and full tables', () => {
    expect(plagesLisibles('0'.repeat(168))).toEqual([])
    expect(plagesLisibles('1'.repeat(168))).toEqual(['toute la semaine'])
  })
})

describe('lundiParis', () => {
  it('gives the Monday of the ISO week, Sunday included', () => {
    expect(lundiParis(h('2026-10-11', 23, 30))).toBe('2026-10-05')
    expect(lundiParis(h('2026-10-12', 0, 30))).toBe('2026-10-12')
  })
})

describe('calculerCible', () => {
  const now = h('2026-10-05', 0, 20) // Monday 00:20

  it('disarms shifts with one hour of margin, arms the rest', () => {
    const { table, semainesNonPlanifiees } = calculerCible(semaineType, now)
    expect(semainesNonPlanifiees).toEqual([])
    const lin = semaineDepuisLundi(table)
    // Monday: shifts 05–21 → off 04–22 (22h is off: the shift ends at 21 + 1 h margin)
    expect(lin.slice(0, 24)).toBe('1111' + '0'.repeat(18) + '11')
    // Tuesday: 05–13 then the night shift 21 → Wed 05, armed in the 14h–20h gap;
    // armed from Wed 06h through the weekend up to Monday's first shift.
    expect(plagesLisibles(table)).toEqual(['lun. 22h → mar. 04h', 'mar. 14h → mar. 20h', 'mer. 06h → lun. 04h'])
  })

  it('an hour touched by the margin is occupied, even partly', () => {
    const { table } = calculerCible([poste('2026-10-05', 5, '2026-10-05', 13), poste('2026-10-12', 5, '2026-10-12', 6)], now)
    // shift 05:00 → margin from 04:00; hour 04 occupied, hour 03 armed
    expect(table[indexHeure(1, 3)]).toBe('1')
    expect(table[indexHeure(1, 4)]).toBe('0')
    expect(table[indexHeure(1, 13)]).toBe('0')
    expect(table[indexHeure(1, 14)]).toBe('1')
  })

  it('a week without any planning row takes the fixed schedule', () => {
    const seulementCetteSemaine = semaineType.slice(0, 4)
    const now2 = h('2026-10-08', 15) // Thursday: the horizon runs into next week
    const { table, semainesNonPlanifiees } = calculerCible(seulementCetteSemaine, now2)
    expect(semainesNonPlanifiees).toEqual(['2026-10-12'])
    const fixe = tableFixe()
    // Next week's Monday–Thursday 14h come from the fixed schedule…
    expect(table[indexHeure(1, 3)]).toBe(fixe[indexHeure(1, 3)])
    expect(table[indexHeure(1, 10)]).toBe('0')
    // …while this week's Friday–Sunday, planned-but-empty, are armed all day.
    expect(table[indexHeure(5, 10)]).toBe('1')
    expect(table[indexHeure(6, 10)]).toBe('1')
  })

  it('nothing planned at all → exactly the fixed schedule', () => {
    const { table, semainesNonPlanifiees } = calculerCible([], now)
    expect(table).toBe(tableFixe())
    expect(semainesNonPlanifiees).toEqual(['2026-10-05'])
  })

  it('the autumn DST day keeps 168 valid slots', () => {
    const dst = h('2026-10-25', 0) // Sunday, 03:00 → 02:00
    const { table } = calculerCible([poste('2026-10-26', 5, '2026-10-26', 13), poste('2026-10-19', 5, '2026-10-19', 13)], dst)
    expect(table).toMatch(/^[01]{168}$/)
    expect(table[indexHeure(7, 2)]).toBe('1')
    expect(table[indexHeure(1, 6)]).toBe('0')
  })
})

describe('conforme — push switched off by hand (v2)', () => {
  const cible = tableFixe()
  const autre = '0'.repeat(168)
  const push = (enable: number, scheduleEnable: number, md: string) => ({ enable, scheduleEnable, schedule: { table: { MD: md, AI_PEOPLE: autre } } })

  it('a channel switched off by a person is never written, whatever its schedule', () => {
    expect(coupeeALaMain(push(0, 1, autre))).toBe(true)
    expect(conforme(push(0, 1, autre), cible)).toBe(true)
    expect(conforme(push(0, 0, autre), cible)).toBe(true)
  })

  it('a channel switched on gets the target schedule', () => {
    expect(conforme(push(1, 1, cible), cible)).toBe(true)
    expect(conforme(push(1, 1, autre), cible)).toBe(false)
    expect(conforme(push(1, 0, cible), cible)).toBe(false)
  })
})
