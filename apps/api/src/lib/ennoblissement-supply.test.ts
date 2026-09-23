import { describe, expect, it } from 'vitest'
import { ECRU_CONSUMED_ERROR, ennoSupplyBuckets, liveEcruRolls, type EnnoEcruRow } from './ennoblissement-supply.js'

// LIVA #1188 — « Quantité affectée sur commandes clients » (order 3762, line
// 12851, 029A marine, rendement 3,54839). Prod on 2026-09-23: sst line 8944
// (order 8970) carried 23 écru rolls reserved to 12851, 12 of them already
// dyed (871,5 Ml) and shipped as fini rolls against line 12849; sst line 8965
// (order 8991) carried 49 live rolls (3 503,7 Ml) reserved to 12851 and 7
// reserved to 12853. The gauge read 4 298,9; the tab 1 666,7 + 3 503,7.

const RDT = 3.54839
const LINE = 12851
const ml = (kg: number) => Math.round(kg * RDT * 10) / 10

function rolls(): EnnoEcruRow[] {
  const out: EnnoEcruRow[] = []
  let id = 1
  // sst line 8944: 23 rolls reserved to 12851 — ids 1..12 dyed (871,5 Ml
  // between them), 13..23 still écru (795,2 Ml)
  for (let i = 0; i < 12; i++) out.push({ id: id++, lid: 8944, lcc: LINE, don: 0, poids: 871.5 / RDT / 12 })
  for (let i = 0; i < 11; i++) out.push({ id: id++, lid: 8944, lcc: LINE, don: 0, poids: 795.2 / RDT / 11 })
  // sst line 8965: 49 rolls reserved to 12851 (ids 24..72), 7 to 12853 (73..79)
  for (let i = 0; i < 49; i++) out.push({ id: id++, lid: 8965, lcc: LINE, don: 0, poids: 3503.7 / RDT / 49 })
  for (let i = 0; i < 7; i++) out.push({ id: id++, lid: 8965, lcc: 12853, don: 0, poids: 500.3 / RDT / 7 })
  return out
}
const DYED = new Set(Array.from({ length: 12 }, (_, i) => i + 1))

describe('ennoSupplyBuckets', () => {
  it('reproduces the #1188 tab figures when nothing is excluded', () => {
    const b = ennoSupplyBuckets(rolls(), LINE, new Set())
    expect(ml(b.affKg.get(8944)!)).toBe(1666.7)
    expect(ml(b.affKg.get(8965)!)).toBe(3503.7)
    expect(b.consumedRolls).toBe(0)
  })

  it('drops the dyed rolls so that Σ « Affecté » equals the gauge', () => {
    const b = ennoSupplyBuckets(rolls(), LINE, DYED)
    expect(b.consumedRolls).toBe(12)
    const total = ml((b.affKg.get(8944) ?? 0) + (b.affKg.get(8965) ?? 0))
    // 1 666,7 − 871,5 + 3 503,7 = the gauge's 4 298,9
    expect(total).toBe(4298.9)
    expect(ml(b.affKg.get(8944)!)).toBe(795.2)
  })

  it('a roll reserved to another client line counts in neither column', () => {
    const b = ennoSupplyBuckets(rolls(), LINE, new Set())
    expect(b.dispoKg.get(8965)).toBeUndefined()
    expect(b.affKg.get(8965)).toBeCloseTo(3503.7 / RDT, 5)
  })

  it('a free roll is disponible unless it is dyed or donated', () => {
    const rows: EnnoEcruRow[] = [
      { id: 1, lid: 8918, lcc: 0, don: 0, poids: 20 },
      { id: 2, lid: 8918, lcc: 0, don: 0, poids: 20 }, // dyed
      { id: 3, lid: 8918, lcc: 0, don: 2071, poids: 20 }, // donation
    ]
    const b = ennoSupplyBuckets(rows, LINE, new Set([2]))
    expect(b.dispoKg.get(8918)).toBe(20)
    expect(b.affKg.size).toBe(0)
    expect(b.consumedRolls).toBe(1)
  })

  it('never counts a dyed roll as affecté even when reserved to the line', () => {
    const rows: EnnoEcruRow[] = [{ id: 7, lid: 8944, lcc: LINE, don: 0, poids: 20 }]
    const b = ennoSupplyBuckets(rows, LINE, new Set([7]))
    expect(b.affKg.size).toBe(0)
    expect(b.dispoKg.size).toBe(0)
  })
})

describe('liveEcruRolls', () => {
  it('filters consumed ids and tolerates string ids from the driver', () => {
    const rows = [{ IDstock_ecru: 1 }, { IDstock_ecru: '2' }, { IDstock_ecru: 3 }]
    expect(liveEcruRolls(rows, new Set([2])).map((r) => Number(r.IDstock_ecru))).toEqual([1, 3])
  })
})

describe('ECRU_CONSUMED_ERROR', () => {
  it('is the 409 body of the link route', () => {
    expect(ECRU_CONSUMED_ERROR.error).toBe('piece_teinte')
    expect(ECRU_CONSUMED_ERROR.message).toMatch(/teinte/)
  })
})
