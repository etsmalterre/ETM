import { describe, it, expect } from 'vitest'
import { engagementParLot, lireRepartition, planArbitrage, type CibleArbitrage, type PieceTricotage } from './engagement-tricotage.js'
import type { AllocationRepartition } from './repartition-tricotage.js'

const a = (lcc: number, poids: number, delai = '', toute = false): AllocationRepartition => ({ lcc, poids, toute, delai })
const piece = (id: number, poids: number, o: Partial<PieceTricotage> = {}): PieceTricotage => ({ id, poids, lcc: 0, livree: true, don: false, ...o })

describe('engagementParLot', () => {
  // Order 9147: 2 645 kg of 029 (94 % 1/60 bio, 6 % élasthanne), 1 046 kg knitted, freinte 9,66 %.
  const paires = [{ refFil: 5, coloriFil: 317, pourcentage: 94 }, { refFil: 8, coloriFil: 338, pourcentage: 6 }]

  it('holds what is left to knit, in yarn, never the plan of the day the yarn was affected', () => {
    const e = engagementParLot({
      reste: 1599, freinte: 0.0966, paires,
      lots: [
        { lot: 1835, refFil: 5, coloriFil: 317, plan: 2752.19, of: 0, asso: 1 },
        { lot: 1646, refFil: 8, coloriFil: 338, plan: 175.67, of: 0, asso: 1 },
      ],
    })
    expect(e.get(1835)).toBeCloseTo(1663.8, 0)
    expect(e.get(1646)).toBeCloseTo(106.2, 0)
  })

  it('holds nothing once everything is knitted', () => {
    expect(engagementParLot({ reste: 0, freinte: 0.03, paires, lots: [{ lot: 1, refFil: 5, coloriFil: 317, plan: 500, of: 0, asso: 1 }] }).size).toBe(0)
  })

  it('two lots of one yarn: the open OFs weigh the split, else the asso plan', () => {
    const lots = [
      { lot: 1, refFil: 5, coloriFil: 317, plan: 300, of: 0, asso: 1 },
      { lot: 2, refFil: 5, coloriFil: 317, plan: 100, of: 0, asso: 1 },
    ]
    const parPlan = engagementParLot({ reste: 100, freinte: 0, paires: [paires[0]], lots })
    expect(parPlan.get(1)).toBeCloseTo(70.5, 1)
    expect(parPlan.get(2)).toBeCloseTo(23.5, 1)
    const parOf = engagementParLot({ reste: 100, freinte: 0, paires: [paires[0]], lots: [{ ...lots[0], of: 0, asso: 1 }, { ...lots[1], of: 50 }] })
    expect(parOf.get(1)).toBeUndefined()
    expect(parOf.get(2)).toBeCloseTo(94, 1)
  })
})

describe('lireRepartition', () => {
  it('order 9147: 335 kg of its pieces went to another order, the lines counting on it all are short', () => {
    const r = lireRepartition({
      quantite: 2645,
      allocations: [a(13352, 564, '20270208'), a(13353, 1128, '20270215'), a(13354, 846, '20270222'), a(13355, 107, '20270301', true)],
      pieces: [
        piece(1, 62.2, { lcc: 13352 }),
        piece(2, 335.5, { lcc: 13429 }),
        piece(3, 648.3, { livree: false }),
      ],
    })
    expect(r.chezTricoteur).toBeCloseTo(648.3, 1)
    expect(r.aVenir).toBeCloseTo(2247.3, 1)
    expect(r.parts.map((p) => p.lcc)).toEqual([13352, 13353, 13354, 13355])
    expect(r.parts[0]).toMatchObject({ reserve: 564, recu: 62.2, reste: 501.8 })
    expect(r.autres).toEqual([{ lcc: 13429, don: false, recu: 335.5 }])
    expect(r.stock).toEqual({ recu: 0, aVenir: 0 })
    expect(r.surPromesse).toBeCloseTo(335.5, 1)
  })

  it('what no line claims is for the stock: delivered and free, and still to come', () => {
    const r = lireRepartition({
      quantite: 300,
      allocations: [a(1, 100, '20261201')],
      pieces: [piece(1, 30), piece(2, 30), piece(3, 30), piece(4, 30), piece(5, 30), piece(6, 30, { don: true })],
    })
    // Line 1 takes pieces until it holds 100 kg (4 pieces, 120 kg); the 5th is free, the 6th given away.
    expect(r.parts[0]).toMatchObject({ reserve: 100, recu: 120, reste: 0 })
    expect(r.stock).toEqual({ recu: 30, aVenir: 120 })
    expect(r.autres).toEqual([{ lcc: 0, don: true, recu: 30 }])
    expect(r.surPromesse).toBe(0)
  })
})

describe('planArbitrage', () => {
  const cible = (o: Partial<CibleArbitrage> = {}): CibleArbitrage => ({
    lsst: 9136, commande: 9147, quantite: 2645, reste: 1599, pct: 94, freinte: 0, engage: 1503,
    stockAVenir: 0, parts: [{ lcc: 1, delai: '20270208', reste: 500 }, { lcc: 2, delai: '20270301', reste: 107 }, { lcc: 3, delai: '20270222', reste: 800 }],
    ...o,
  })

  it('the order knits less; the latest délai loses first', () => {
    const r = planArbitrage(188, [cible()])
    expect(r.ok).toBe(true)
    // 188 kg of yarn at 94 % = 200 kg of écru.
    expect(r.effets[0]).toMatchObject({ deQuantite: 2645, aQuantite: 2445, stock: 0 })
    expect(r.effets[0].lignes).toEqual([{ lcc: 2, perd: 107 }, { lcc: 3, perd: 93 }])
    expect(r.effets[0].fil).toBeCloseTo(188, 1)
  })

  it('what was knitted for the stock goes before any client line', () => {
    const r = planArbitrage(94, [cible({ stockAVenir: 150 })])
    expect(r.effets[0]).toMatchObject({ aQuantite: 2545, stock: 100, lignes: [] })
  })

  it('a line without a délai is not promised: it loses before a dated one', () => {
    const r = planArbitrage(47, [cible({ parts: [{ lcc: 1, delai: '20270208', reste: 500 }, { lcc: 9, delai: '', reste: 500 }] })])
    expect(r.effets[0].lignes).toEqual([{ lcc: 9, perd: 50 }])
  })

  it('never more than the order still has to knit', () => {
    const r = planArbitrage(500, [cible({ reste: 100, engage: 94 })])
    expect(r.ok).toBe(false)
    expect(r.libere).toBeCloseTo(94, 1)
    expect(r.effets[0].aQuantite).toBe(2545)
  })

  it('the freinte counts: yarn given back = écru not knitted ÷ (1 − freinte)', () => {
    const r = planArbitrage(100, [cible({ freinte: 0.1, engage: 1670, stockAVenir: 500 })])
    // 100 kg ÷ 94 % × 0,9 = 95,75 kg of écru.
    expect(r.effets[0].aQuantite).toBeCloseTo(2549.25, 1)
    expect(r.effets[0].fil).toBeGreaterThanOrEqual(100)
  })
})

describe('planArbitrage, the yarn changes hands inside the order', () => {
  it('the order keeps its quantity: only the other lines lose, latest délai first', () => {
    const r = planArbitrage(94, [{
      lsst: 1, commande: 10, quantite: 1000, reste: 300, pct: 94, freinte: 0, engage: 282, stockAVenir: 0, garde: true,
      parts: [{ lcc: 1, delai: '20270101', reste: 200 }, { lcc: 2, delai: '20270301', reste: 100 }],
    }])
    expect(r.ok).toBe(true)
    expect(r.effets[0]).toMatchObject({ deQuantite: 1000, aQuantite: 1000, interne: true, lignes: [{ lcc: 2, perd: 100 }] })
  })
})
