import { describe, it, expect } from 'vitest'
import { planLancement, lotsParDefaut, filNonReserve, ecruCouvertParReservation, avecLignesJointes, lotsDeLigneJointe, type LotLibre } from './lancement-tricotage.js'

const lot = (o: Partial<LotLibre> & { id: number }): LotLibre => ({
  refFil: 1, coloriFil: 10, lot: `L${o.id}`, dateEntree: '20260101', idRefFilCommande: 0, magasin: 1, fournisseur: 0, stockInitial: 0,
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

// LIVA #1398, order 3957: two lines of 186A (two dyed coloris) knitted in the same écru 186 - écru,
// one knitting order for both. Yarn 10 on one lot for both lines; yarn 93 on a lot end (line 1) and
// on a second lot (both lines). Freinte left at 0 to keep the figures readable.
describe('one knitting order for several client lines (LIVA #1398)', () => {
  const p3957 = [{ refFil: 10, coloriFil: 320, pourcentage: 70 }, { refFil: 93, coloriFil: 903, pourcentage: 30 }]
  const lots = [
    lot({ id: 1809, refFil: 10, coloriFil: 320, libre: 440, reserveLigne: 71, reserveJointes: [{ ligne: 13476, kg: 15 }] }),
    lot({ id: 1649, refFil: 93, coloriFil: 903, libre: 17.35, reserveLigne: 17.35, dateEntree: '20250101' }),
    lot({ id: 1685, refFil: 93, coloriFil: 903, libre: 547, reserveLigne: 20.65, reserveJointes: [{ ligne: 13476, kg: 8 }] }),
  ]

  it('what a joining line holds counts as reserved to the launch, another line’s yarn does not', () => {
    const vus = avecLignesJointes(lots, [13476])
    expect(vus.map((l) => l.reserveLigne)).toEqual([86, 17.35, 28.65])
    expect(avecLignesJointes(lots, [999]).map((l) => l.reserveLigne)).toEqual([71, 17.35, 20.65])
  })

  it('a joining line’s part is what ITS yarn makes, the scarcest yarn deciding', () => {
    // 15 kg of yarn 10 make 21,42 kg of écru, 8 kg of yarn 93 make 26,66: the first decides
    expect(ecruCouvertParReservation({ paires: p3957, lots: lotsDeLigneJointe(lots, 13476) })).toBe(21.42)
    expect(ecruCouvertParReservation({ paires: p3957, lots: lotsDeLigneJointe(lots, 999) })).toBe(0)
  })

  it('the order takes every kg reserved to both lines, lot by lot', () => {
    // line 1: 101,4 kg; line 2: 21,42 kg
    const plan = planLancement({ totalKg: 122.82, paires: p3957, lots: avecLignesJointes(lots, [13476]), choisis: [1809, 1649, 1685], emporterReserve: true })
    expect(plan.ok).toBe(true)
    expect(plan.entrees).toEqual([
      { lot: 1809, refFil: 10, coloriFil: 320, kg: 86 },
      { lot: 1649, refFil: 93, coloriFil: 903, kg: 17.35 },
      { lot: 1685, refFil: 93, coloriFil: 903, kg: 28.65 },
    ])
  })

  it('two lines holding the same yarn on two lots: each lot gives what is reserved on it', () => {
    // Before, the oldest reserved lot took the whole need and the second line's yarn stayed at home.
    const deux = [
      lot({ id: 1, libre: 500, reserveLigne: 60, dateEntree: '20250101' }),
      lot({ id: 2, libre: 300, reserveLigne: 0, reserveJointes: [{ ligne: 7, kg: 40 }], dateEntree: '20260101' }),
    ]
    const plan = planLancement({ totalKg: 100, paires: [paires[0]], lots: avecLignesJointes(deux, [7]), choisis: [1, 2], emporterReserve: true })
    expect(plan.entrees).toEqual([
      { lot: 1, refFil: 1, coloriFil: 10, kg: 60 },
      { lot: 2, refFil: 1, coloriFil: 10, kg: 40 },
    ])
  })

  it('on top of the reservations, the stock part fills from the order of service', () => {
    const deux = [
      lot({ id: 1, libre: 500, reserveLigne: 60, dateEntree: '20250101' }),
      lot({ id: 2, libre: 300, reserveLigne: 40, dateEntree: '20260101' }),
    ]
    // 94 kg reserved yarn asked + 47 for the stock: the oldest reserved lot gives the rest
    const plan = planLancement({ totalKg: 150, paires: [paires[0]], lots: deux, choisis: [1, 2], emporterReserve: true })
    expect(plan.entrees).toEqual([
      { lot: 1, refFil: 1, coloriFil: 10, kg: 101 },
      { lot: 2, refFil: 1, coloriFil: 10, kg: 40 },
    ])
  })

  it('the default ticks every lot holding a reservation of the launch, even once the need is covered', () => {
    const deux = [
      lot({ id: 1, libre: 500, reserveLigne: 60, dateEntree: '20250101' }),
      lot({ id: 2, libre: 300, reserveLigne: 40, dateEntree: '20260101' }),
      lot({ id: 3, libre: 900, dateEntree: '20240101' }),
    ]
    expect(lotsParDefaut(deux, 94)).toEqual([1, 2])
  })
})
