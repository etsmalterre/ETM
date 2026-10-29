import { describe, it, expect } from 'vitest'
import { planLancement, lotsParDefaut, filNonReserve, ecruCouvertParReservation, type LotLibre } from './lancement-tricotage.js'

const lot = (o: Partial<LotLibre> & { id: number }): LotLibre => ({
  refFil: 1, coloriFil: 10, lot: `L${o.id}`, dateEntree: '20260101', idRefFilCommande: 0, magasin: 1, fournisseur: 0,
  stock: 0, libre: 0, reserveLigne: 0, ...o,
})

// 029A / violet: 94 % coton bio 1/60 + 6 % élasthanne 22 (commande 3902, 28,2 kg)
const paires = [{ refFil: 1, coloriFil: 10, pourcentage: 94 }, { refFil: 2, coloriFil: 20, pourcentage: 6 }]

describe('planLancement', () => {
  it('from a client line, takes every kg reserved to it, safety margin included (3928)', () => {
    // 142 Ml = 40 kg of écru at 2,8 %: 38,7 kg of cotton and 2,47 of elastane needed; 41 and 3 reserved.
    const lots = [lot({ id: 1, libre: 41, reserveLigne: 41 }), lot({ id: 2, refFil: 2, coloriFil: 20, libre: 3, reserveLigne: 3 })]
    const plan = planLancement({ totalKg: 40, paires, lots, choisis: [1, 2], freinte: 0.028, emporterReserve: true })
    expect(plan.entrees.map((e) => e.kg)).toEqual([41, 3])
    expect(planLancement({ totalKg: 40, paires, lots, choisis: [1, 2], freinte: 0.028 }).entrees.map((e) => e.kg)).toEqual([38.68, 2.47])
  })
  it('covers every yarn from the chosen lots, the oldest lot first', () => {
    const lots = [
      lot({ id: 1, libre: 20, dateEntree: '20260301' }),
      lot({ id: 2, libre: 500, dateEntree: '20260105' }),
      lot({ id: 3, refFil: 2, coloriFil: 20, libre: 300 }),
    ]
    const plan = planLancement({ totalKg: 100, paires, lots, choisis: [1, 2, 3] })
    expect(plan.ok).toBe(true)
    expect(plan.entrees).toEqual([
      { lot: 2, refFil: 1, coloriFil: 10, kg: 94 },
      { lot: 3, refFil: 2, coloriFil: 20, kg: 6 },
    ])
  })

  it('takes the client line’s own reservation before an older lot', () => {
    const lots = [lot({ id: 1, libre: 500, dateEntree: '20250101' }), lot({ id: 2, libre: 60, reserveLigne: 60, dateEntree: '20260901' })]
    const plan = planLancement({ totalKg: 100, paires: [paires[0]], lots, choisis: [1, 2] })
    expect(plan.entrees).toEqual([
      { lot: 2, refFil: 1, coloriFil: 10, kg: 60 },
      { lot: 1, refFil: 1, coloriFil: 10, kg: 34 },
    ])
  })

  it('refuses a launch whose yarn is not all there: no lot for the élasthanne', () => {
    const plan = planLancement({ totalKg: 28.2, paires, lots: [lot({ id: 1, libre: 1648.1 })], choisis: [1] })
    expect(plan.ok).toBe(false)
    expect(plan.manques).toEqual([{ refFil: 2, coloriFil: 20, besoin: 1.69, couvert: 0 }])
  })

  it('refuses when the chosen lots hold less than the need', () => {
    const plan = planLancement({ totalKg: 100, paires: [paires[0]], lots: [lot({ id: 1, libre: 50 })], choisis: [1] })
    expect(plan.manques).toEqual([{ refFil: 1, coloriFil: 10, besoin: 94, couvert: 50 }])
  })

  it('refuses a chosen lot outside the composition or unknown at this knitter', () => {
    const plan = planLancement({ totalKg: 10, paires: [paires[0]], lots: [lot({ id: 1, libre: 50 }), lot({ id: 2, refFil: 9, libre: 50 })], choisis: [1, 2, 77] })
    expect(plan.ok).toBe(false)
    expect(plan.horsComposition).toEqual([2, 77])
  })

  it('a composition without yarn launches nothing', () => {
    expect(planLancement({ totalKg: 10, paires: [], lots: [], choisis: [] }).ok).toBe(false)
  })
})

describe('lotsParDefaut', () => {
  it('ticks the reservation first, then the oldest lots until the need is covered', () => {
    const lots = [
      lot({ id: 1, libre: 40, dateEntree: '20250101' }),
      lot({ id: 2, libre: 30, dateEntree: '20250601' }),
      lot({ id: 3, libre: 10, reserveLigne: 10, dateEntree: '20260901' }),
      lot({ id: 4, libre: 0, dateEntree: '20240101' }),
    ]
    expect(lotsParDefaut(lots, 45)).toEqual([3, 1])
    expect(lotsParDefaut(lots, 500)).toEqual([3, 1, 2])
  })
})

describe('filNonReserve: the line part of a launch takes reserved yarn only (2026-10-28)', () => {
  const paires = [{ refFil: 1, coloriFil: 0, pourcentage: 90 }, { refFil: 2, coloriFil: 0, pourcentage: 10 }]
  it('a part covered by the line’s reservations goes; a free lot does not count for the line', () => {
    const lots = [
      lot({ id: 1, refFil: 1, coloriFil: 0, libre: 700, reserveLigne: 110 }),
      lot({ id: 2, refFil: 2, coloriFil: 0, libre: 250, reserveLigne: 20 }),
    ]
    expect(filNonReserve({ affecteKg: 110.8, paires, lots })).toEqual([])
    // élasthanne: nothing reserved, 700 kg of free coton does not help
    const sansElasthanne = [lots[0], lot({ id: 2, refFil: 2, coloriFil: 0, libre: 250, reserveLigne: 0 })]
    expect(filNonReserve({ affecteKg: 50, paires, lots: sansElasthanne }).map((m) => m.refFil)).toEqual([2])
  })
  it('the écru the reservations cover: the scarcest yarn, after the freinte', () => {
    const lots = [lot({ id: 1, refFil: 1, coloriFil: 0, libre: 700, reserveLigne: 90 }), lot({ id: 2, refFil: 2, coloriFil: 0, libre: 50, reserveLigne: 5 })]
    expect(ecruCouvertParReservation({ paires, lots })).toBe(50)
    expect(ecruCouvertParReservation({ paires, lots, freinte: 0.1 })).toBe(45)
    expect(ecruCouvertParReservation({ paires, lots: [] })).toBe(0)
  })
})
