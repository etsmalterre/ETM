import { describe, it, expect } from 'vitest'
import {
  calculerTrs,
  equipeCourante,
  etatCourant,
  fenetresProduction,
  toHfsqlDt,
  type Equipe,
  type TrsEntree,
  arretsParPiece,
  ARRETS_PIECES,
} from './trs-trm.js'

// A Matin shift on a fixed day, everything expressed as minutes past 05:00.
const T0 = new Date(2026, 7, 28, 5, 0, 0, 0).getTime()
const min = (m: number) => T0 + m * 60_000
const MATIN: Equipe = { nom: 'Matin', debutMs: min(0), finMs: min(8 * 60) }

function entree(over: Partial<TrsEntree>): TrsEntree {
  return {
    equipe: MATIN,
    nowMs: min(4 * 60), // 09:00
    etatInitial: 1,
    evenements: [],
    fenetres: [{ debutMs: min(-600), finMs: null }], // an OF running since yesterday
    evenementsPiece: [],
    ...over,
  }
}

describe('equipeCourante', () => {
  const d = (h: number, m = 0) => new Date(2026, 7, 28, h, m).getTime()
  it('uses the legacy boundaries 5 / 13 / 21', () => {
    expect(equipeCourante(d(5)).nom).toBe('Matin')
    expect(equipeCourante(d(12, 59)).nom).toBe('Matin')
    expect(equipeCourante(d(13)).nom).toBe('Après-Midi')
    expect(equipeCourante(d(20, 59)).nom).toBe('Après-Midi')
    expect(equipeCourante(d(21)).nom).toBe('Nuit')
    expect(equipeCourante(d(4, 59)).nom).toBe('Nuit')
  })
  it('makes the night shift straddle midnight in both directions', () => {
    const soir = equipeCourante(d(23))
    expect(new Date(soir.debutMs).getHours()).toBe(21)
    expect(new Date(soir.finMs).getDate()).toBe(29)
    const matin = equipeCourante(d(2))
    expect(new Date(matin.debutMs).getDate()).toBe(27)
    expect(new Date(matin.finMs).getHours()).toBe(5)
  })
  it('formats HFSQL literals in local time', () => {
    expect(toHfsqlDt(d(5))).toBe('20260828050000')
  })
})

describe('fenetresProduction', () => {
  it('clips to the shift and merges overlapping OF windows', () => {
    const p = fenetresProduction(
      [
        { debutMs: min(-60), finMs: min(120) },
        { debutMs: min(100), finMs: min(200) },
        { debutMs: min(300), finMs: null },
      ],
      min(0),
      min(240),
    )
    expect(p).toEqual([{ debutMs: min(0), finMs: min(200) }])
  })
  it("is the legacy comment's own example: 2 h + 3 h = 5 h", () => {
    // Shift 13:00 → 21:00, one OF ends at 15:00, another starts at 18:00.
    const p = fenetresProduction(
      [
        { debutMs: min(-300), finMs: min(120) },
        { debutMs: min(300), finMs: null },
      ],
      min(0),
      min(480),
    )
    const total = p.reduce((s, w) => s + (w.finMs - w.debutMs), 0) / 3_600_000
    expect(total).toBe(5)
  })
})

describe('calculerTrs', () => {
  it('is 100 % for a métier that ran the whole shift without a transition', () => {
    const r = calculerTrs(entree({}))
    expect(r.tempsProdS).toBe(4 * 3600)
    expect(r.tempsMarcheS).toBe(4 * 3600)
    expect(r.arrets).toBe(0)
    expect(r.trs).toBe(1)
    expect(r.enProduction).toBe(true)
  })

  it('has no TRS and is not in production without an OF', () => {
    const r = calculerTrs(entree({ fenetres: [] }))
    expect(r.tempsProdS).toBe(0)
    expect(r.trs).toBeNull()
    expect(r.enProduction).toBe(false)
  })

  it('deducts at most 60 s of intervention per stop and counts the stop', () => {
    // Stopped 06:00 → 06:10, then running.
    const r = calculerTrs(
      entree({
        evenements: [
          { atMs: min(60), etat: 0 },
          { atMs: min(70), etat: 1 },
        ],
      }),
    )
    expect(r.tempsMarcheS).toBe(4 * 3600 - 600)
    expect(r.deductibleS).toBe(60)
    expect(r.arrets).toBe(1)
    // 4 h of production, 1 arrêt → 0.25/h rounds to 0
    expect(r.arretsParHeure).toBe(0)
    expect(r.trs).toBeCloseTo((4 * 3600 - 600) / (4 * 3600 - 60), 6)
  })

  it('takes the whole stop when it is shorter than a minute', () => {
    const r = calculerTrs(
      entree({
        evenements: [
          { atMs: min(60), etat: 0 },
          { atMs: min(60) + 20_000, etat: 1 },
        ],
      }),
    )
    expect(r.deductibleS).toBe(20)
  })

  it('does not count a stop that was already in progress at shift start', () => {
    const r = calculerTrs(
      entree({
        etatInitial: 0,
        evenements: [{ atMs: min(30), etat: 1 }],
      }),
    )
    expect(r.arrets).toBe(0)
    expect(r.deductibleS).toBe(0)
    expect(r.tempsMarcheS).toBe(4 * 3600 - 1800)
  })

  it('only counts running time and stops inside the OF windows', () => {
    // OF starts at 07:00; the métier ran idle before that and stopped once at 06:00.
    const r = calculerTrs(
      entree({
        fenetres: [{ debutMs: min(120), finMs: null }],
        evenements: [
          { atMs: min(60), etat: 0 },
          { atMs: min(65), etat: 1 },
          { atMs: min(180), etat: 0 },
          { atMs: min(190), etat: 1 },
        ],
      }),
    )
    expect(r.tempsProdS).toBe(2 * 3600)
    expect(r.tempsMarcheS).toBe(2 * 3600 - 600)
    expect(r.arrets).toBe(1)
  })

  it('applies the flat allowances and nets one arrêt per piece event', () => {
    // Two stops: a 3-minute cleaning at 06:00 and a 5-minute piece end at 07:00.
    const r = calculerTrs(
      entree({
        evenements: [
          { atMs: min(60), etat: 0 },
          { atMs: min(63), etat: 1 },
          { atMs: min(120), etat: 0 },
          { atMs: min(125), etat: 1 },
        ],
        evenementsPiece: [
          { atMs: min(61), type: 'nettoyage', numero: 3, lycra: false },
          { atMs: min(122), type: 'debut_piece', numero: 4, lycra: false },
        ],
      }),
    )
    // 60 + 60 of intervention, + 3 min cleaning, + 5 min piece end
    expect(r.deductibleS).toBe(120 + 180 + 300)
    expect(r.arrets).toBe(0)
    // The allowances (10 min) exceed the 8 minutes actually lost → TRS above 100 %.
    expect(r.trs!).toBeGreaterThan(1)
  })

  it('uses the lycra allowances when the OF carries élasthanne', () => {
    const r = calculerTrs(
      entree({
        evenementsPiece: [
          { atMs: min(61), type: 'nettoyage', numero: 3, lycra: true },
          { atMs: min(122), type: 'debut_piece', numero: 4, lycra: true },
        ],
      }),
    )
    expect(r.deductibleS).toBe(360 + 480)
  })

  it('gives no allowance to the first piece of an OF (the launch), but still nets its arrêt', () => {
    const r = calculerTrs(
      entree({
        evenements: [
          { atMs: min(60), etat: 0 },
          { atMs: min(64), etat: 1 },
        ],
        evenementsPiece: [{ atMs: min(61), type: 'debut_piece', numero: 1, lycra: false }],
      }),
    )
    expect(r.deductibleS).toBe(60)
    expect(r.arrets).toBe(0)
  })

  it('never reports a negative arrêt count', () => {
    const r = calculerTrs(
      entree({
        evenementsPiece: [
          { atMs: min(61), type: 'nettoyage', numero: 2, lycra: false },
          { atMs: min(70), type: 'nettoyage', numero: 2, lycra: false },
        ],
      }),
    )
    expect(r.arrets).toBe(0)
  })

  it('infers the opening state from the first event when nothing precedes the shift', () => {
    const r = calculerTrs(
      entree({
        etatInitial: null,
        evenements: [{ atMs: min(120), etat: 0 }],
      }),
    )
    // Running 05:00 → 07:00 (inverse of the first event), stopped since.
    expect(r.tempsMarcheS).toBe(2 * 3600)
  })

  it('stops evaluating at the shift end once it is over', () => {
    const r = calculerTrs(entree({ nowMs: min(10 * 60) }))
    expect(r.tempsProdS).toBe(8 * 3600)
  })
})

describe('etatCourant', () => {
  it('prefers the latest shift event, then the pre-shift state', () => {
    expect(
      etatCourant(
        [
          { atMs: min(10), etat: 0 },
          { atMs: min(20), etat: 1 },
        ],
        { etat: 0, atMs: min(-100) },
      ),
    ).toEqual({ etat: 1, depuisMs: min(20) })
    expect(etatCourant([], { etat: 0, atMs: min(-100) })).toEqual({ etat: 0, depuisMs: min(-100) })
    expect(etatCourant([], null)).toEqual({ etat: null, depuisMs: null })
  })
})

describe('arretsParPiece — the tablet’s NombreArrets, averaged over the last finished pieces', () => {
  const H = 3_600_000
  const piece = (id: number, debutH: number, finH: number, evenementsNormaux = 0) => ({
    id,
    debutMs: T0 + debutH * H,
    finMs: T0 + finH * H,
    evenementsNormaux,
  })
  const at = (h: number) => T0 + h * H

  it('is null with no finished piece', () => {
    expect(arretsParPiece([], [at(1)])).toEqual({ moyenne: null, pieces: 0 })
  })

  it('counts the stops strictly inside each piece, minus its declared events, floored at 0', () => {
    const pieces = [piece(1, 0, 4, 1), piece(2, 4, 8, 3)]
    // piece 1: stops at 1 h, 2 h; 4 h is the boundary, excluded → 2 − 1 = 1
    // piece 2: stop at 5 h → 1 − 3 → 0
    const stops = [at(1), at(2), at(4), at(5)]
    expect(arretsParPiece(pieces, stops)).toEqual({ moyenne: 0.5, pieces: 2 })
  })

  it('keeps the last ARRETS_PIECES pieces by id, whatever the input order', () => {
    expect(ARRETS_PIECES).toBe(3)
    const pieces = [piece(4, 12, 16), piece(1, 0, 4), piece(3, 8, 12), piece(2, 4, 8)]
    // piece 1 carries 10 stops and must be dropped; pieces 2, 3, 4 carry 1, 2, 3.
    const stops = [
      ...Array.from({ length: 10 }, (_, i) => at(0.1 * (i + 1))),
      at(5),
      at(9), at(10),
      at(13), at(14), at(15),
    ]
    expect(arretsParPiece(pieces, stops)).toEqual({ moyenne: 2, pieces: 3 })
  })

  it('rounds the mean to one decimal', () => {
    const pieces = [piece(1, 0, 4), piece(2, 4, 8), piece(3, 8, 12)]
    expect(arretsParPiece(pieces, [at(1), at(5)])).toEqual({ moyenne: 0.7, pieces: 3 })
  })
})
