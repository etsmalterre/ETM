// The ERP screen's additions to lib/trs-trm.ts (Production › TRS): shift
// navigation, the timeline segments, the deductible breakdown, the four KPI
// cards, the pointage-based roster and the FI_TRS colour ladders. Same
// fixture as trs-trm.test.ts — a Matin shift, minutes past 05:00.
import { describe, it, expect } from 'vitest'
import {
  calculerTrs,
  equipeDepuisLiteral,
  equipePrecedente,
  equipeSuivante,
  kpiEquipe,
  presenceEquipe,
  segmentsMachine,
  teinteArretsParHeure,
  teinteTrsFiTrs,
  teinteVitesseFiTrs,
  type Equipe,
  type TrsEntree,
} from './trs-trm.js'

const T0 = new Date(2026, 7, 28, 5, 0, 0, 0).getTime()
const min = (m: number) => T0 + m * 60_000
const MATIN: Equipe = { nom: 'Matin', debutMs: min(0), finMs: min(8 * 60) }

function entree(over: Partial<TrsEntree>): TrsEntree {
  return {
    equipe: MATIN,
    nowMs: min(4 * 60), // 09:00
    etatInitial: 1,
    evenements: [],
    fenetres: [{ debutMs: min(-600), finMs: null }],
    evenementsPiece: [],
    ...over,
  }
}

describe('equipePrecedente / equipeSuivante / equipeDepuisLiteral', () => {
  it('steps 8 h on the 5 / 13 / 21 grid, across midnight', () => {
    const prev = equipePrecedente(MATIN)
    expect(prev.nom).toBe('Nuit')
    expect(new Date(prev.debutMs).getDate()).toBe(27)
    expect(prev.finMs).toBe(MATIN.debutMs)
    const next = equipeSuivante(MATIN)
    expect(next.nom).toBe('Après-Midi')
    expect(next.debutMs).toBe(MATIN.finMs)
    expect(equipeSuivante(equipeSuivante(MATIN)).nom).toBe('Nuit')
    expect(equipePrecedente(equipeSuivante(MATIN))).toEqual(MATIN)
  })
  it('only accepts a literal that is exactly a shift start', () => {
    expect(equipeDepuisLiteral('20260828050000')).toEqual(MATIN)
    expect(equipeDepuisLiteral('20260828210000')?.nom).toBe('Nuit')
    expect(equipeDepuisLiteral('20260828053000')).toBeNull()
    expect(equipeDepuisLiteral('20260828060000')).toBeNull()
    expect(equipeDepuisLiteral('2026-08-28 05:00:00')).toBeNull()
    expect(equipeDepuisLiteral('')).toBeNull()
  })
})

describe('segmentsMachine', () => {
  it('opens with the pre-shift state and closes the last period at now', () => {
    const s = segmentsMachine(entree({ evenements: [{ atMs: min(60), etat: 0 }, { atMs: min(70), etat: 1 }] }))
    expect(s).toEqual([
      { debutMs: min(0), finMs: min(60), etat: 1, ouvertParEvenement: false },
      { debutMs: min(60), finMs: min(70), etat: 0, ouvertParEvenement: true },
      { debutMs: min(70), finMs: min(240), etat: 1, ouvertParEvenement: true },
    ])
  })
  it('is bounded to the shift end once it is over, and drops zero-length periods', () => {
    const s = segmentsMachine(
      entree({ nowMs: min(600), evenements: [{ atMs: min(0), etat: 0 }, { atMs: min(500), etat: 1 }] }),
    )
    expect(s).toEqual([{ debutMs: min(0), finMs: min(480), etat: 0, ouvertParEvenement: true }])
  })
  it('agrees with calculerTrs on the running time', () => {
    const e = entree({
      evenements: [{ atMs: min(30), etat: 0 }, { atMs: min(90), etat: 1 }, { atMs: min(200), etat: 0 }],
    })
    const marche = segmentsMachine(e)
      .filter((s) => s.etat === 1)
      .reduce((t, s) => t + (s.finMs - s.debutMs) / 1000, 0)
    expect(calculerTrs(e).tempsMarcheS).toBe(Math.round(marche))
  })
})

describe('calculerTrs.detail', () => {
  it('itemises what was deducted', () => {
    const r = calculerTrs(
      entree({
        evenements: [
          { atMs: min(60), etat: 0 },
          { atMs: min(62), etat: 1 },
          { atMs: min(100), etat: 0 },
          { atMs: min(100.5), etat: 1 },
        ],
        evenementsPiece: [
          { atMs: min(60), type: 'nettoyage', numero: 2, lycra: false },
          { atMs: min(100), type: 'debut_piece', numero: 3, lycra: true },
          { atMs: min(120), type: 'debut_piece', numero: 1, lycra: false },
        ],
      }),
    )
    expect(r.detail).toEqual({
      arretsDeduits: 2,
      arretsDeduitsS: 90,
      nettoyages: 1,
      nettoyagesS: 180,
      finsPiece: 1,
      finsPieceS: 480,
      evenementsPiece: 3,
      lycra: true,
    })
    expect(r.deductibleS).toBe(90 + 180 + 480)
  })
})

describe('kpiEquipe — the four cards of MAJAffichageAtelier', () => {
  const pieces = [
    { id: 1, poidsNominal: 20, finMs: min(0), visiteeMs: min(30) }, // exactly at debut → out (]debut, fin])
    { id: 2, poidsNominal: 20, finMs: min(10), visiteeMs: min(30) },
    { id: 3, poidsNominal: 10, finMs: min(100), visiteeMs: null },
    { id: 4, poidsNominal: 20, finMs: min(200), visiteeMs: min(500) }, // weighed after the shift end
    { id: 5, poidsNominal: 20, finMs: min(480), visiteeMs: null }, // exactly at fin → in
    { id: 6, poidsNominal: 20, finMs: min(481), visiteeMs: null },
  ]
  const rouleaux = [
    { id: 11, poids: 19.5, secondChoix: false, saisieMs: min(30) },
    { id: 12, poids: 4, secondChoix: true, saisieMs: min(120) },
    { id: 13, poids: 20, secondChoix: false, saisieMs: min(0) }, // at debut → out
    { id: 14, poids: 20, secondChoix: false, saisieMs: min(500) }, // after fin → out
  ]
  it('counts and sums inside ]debut, fin] on both populations', () => {
    const k = kpiEquipe(pieces, rouleaux, MATIN, min(240))
    expect(k.production).toEqual({ pieces: 4, kg: 70, kgParHeure: 17.5 })
    expect(k.visitage).toEqual({ pieces: 2, kg: 23.5, kgParHeure: 5.9 })
    expect(k.secondChoix).toEqual({ pieces: 1, kg: 4, pct: 17.02 })
    expect(k.nonVisitees).toEqual({ pieces: 3, heureFin: 13 })
  })
  it('rates over the whole shift once it is over, and has no rate before any time elapsed', () => {
    expect(kpiEquipe(pieces, rouleaux, MATIN, min(600)).production.kgParHeure).toBe(8.8)
    expect(kpiEquipe(pieces, rouleaux, MATIN, min(0)).production.kgParHeure).toBeNull()
  })
  it('has no second-choice rate without a weighing', () => {
    expect(kpiEquipe(pieces, [], MATIN, min(240)).secondChoix.pct).toBeNull()
  })
})

describe('presenceEquipe — ZR_Equipe from pointage', () => {
  const pt = (bonnetierId: number, m: number, enPoste: boolean) => ({ bonnetierId, atMs: min(m), enPoste })
  it('opens from the last pointage before the shift and closes at the evaluation end', () => {
    const p = presenceEquipe([pt(1, -300, true), pt(1, -290, false), pt(1, -10, true)], min(0), min(240))
    expect(p.rows).toEqual([
      { bonnetierId: 1, intervalles: [{ debutMs: min(0), finMs: min(240) }], pauses: [], dureeS: 240 * 60 },
    ])
    expect(p.totalS).toBe(240 * 60)
  })
  it('turns an out / in pair into a pause and sums the rest', () => {
    const p = presenceEquipe([pt(2, 50, true), pt(2, 68, false), pt(2, 86, true), pt(2, 476, false)], min(0), min(480))
    expect(p.rows[0].intervalles).toEqual([
      { debutMs: min(50), finMs: min(68) },
      { debutMs: min(86), finMs: min(476) },
    ])
    expect(p.rows[0].pauses).toEqual([{ debutMs: min(68), finMs: min(86) }])
    expect(p.rows[0].dureeS).toBe((18 + 390) * 60)
  })
  it('ignores duplicate states, rows after the end, and people with no presence', () => {
    const p = presenceEquipe(
      [pt(3, 10, true), pt(3, 12, true), pt(3, 300, false), pt(3, 490, true), pt(4, -100, false), pt(5, 600, true)],
      min(0),
      min(480),
    )
    expect(p.rows.map((r) => r.bonnetierId)).toEqual([3])
    expect(p.rows[0].intervalles).toEqual([{ debutMs: min(10), finMs: min(300) }])
    expect(p.rows[0].pauses).toEqual([])
  })
  it('orders the rows by first arrival', () => {
    const p = presenceEquipe([pt(9, 60, true), pt(4, 30, true)], min(0), min(480))
    expect(p.rows.map((r) => r.bonnetierId)).toEqual([4, 9])
  })
})

describe('the FI_TRS colour ladders', () => {
  it('vitesse: < 20 rouge, < 25 ambre', () => {
    expect(teinteVitesseFiTrs(19)).toBe('rouge')
    expect(teinteVitesseFiTrs(20)).toBe('ambre')
    expect(teinteVitesseFiTrs(24)).toBe('ambre')
    expect(teinteVitesseFiTrs(25)).toBe('vert')
  })
  it('arrêts / h: 0–1 vert, 2 ambre, beyond rouge', () => {
    expect(teinteArretsParHeure(0)).toBe('vert')
    expect(teinteArretsParHeure(1)).toBe('vert')
    expect(teinteArretsParHeure(2)).toBe('ambre')
    expect(teinteArretsParHeure(3)).toBe('rouge')
  })
  it('TRS: ≤ 0,8 rouge, ≤ 0,9 ambre — the two real literals of the compile cache', () => {
    expect(teinteTrsFiTrs(0.8)).toBe('rouge')
    expect(teinteTrsFiTrs(0.81)).toBe('ambre')
    expect(teinteTrsFiTrs(0.9)).toBe('ambre')
    expect(teinteTrsFiTrs(0.91)).toBe('vert')
    expect(teinteTrsFiTrs(1.15)).toBe('vert')
  })
})
