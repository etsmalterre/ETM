import { describe, expect, it } from 'vitest'
import { besoinsParStade } from './besoin-stades.js'

describe('besoinsParStade', () => {
  it('a fini line asks écru only for what its fini rolls leave, and yarn only for what the écru leaves', () => {
    const s = besoinsParStade({ kind: 'fini', quantite: 1000, fini: 400, ecru: 350, tricotage: 100 })
    expect(s.fini).toEqual({ besoin: 1000, couvert: 400, reste: 600 })
    expect(s.ecru).toEqual({ besoin: 600, couvert: 450, reste: 150, pieces: 350, tricotage: 100 })
    expect(s.aTricoter).toBe(150)
  })
  it('a stage holding more than its need asks nothing further down, never a negative need', () => {
    const s = besoinsParStade({ kind: 'fini', quantite: 330, fini: 0, ecru: 360, tricotage: 0 })
    expect(s.ecru.reste).toBe(0)
    expect(s.aTricoter).toBe(0)
    expect(besoinsParStade({ kind: 'fini', quantite: 330, fini: 400, ecru: 0, tricotage: 0 }).ecru.besoin).toBe(0)
  })
  it('an écru line has no fini stage: its écru need is its quantity', () => {
    const s = besoinsParStade({ kind: 'ecru', quantite: 110.8, fini: 99, ecru: 20, tricotage: 0 })
    expect(s.fini).toBeNull()
    expect(s.ecru.besoin).toBe(110.8)
    expect(s.aTricoter).toBe(90.8)
  })
  it('Thuasne 3923: nothing reserved, the whole line is to knit', () => {
    expect(besoinsParStade({ kind: 'fini', quantite: 330, fini: 0, ecru: 0, tricotage: 0 }).aTricoter).toBe(330)
  })
  it('a rest under 0.5 % of the line is rounding, not matter to find', () => {
    // 142 Ml knitted as 40,0 kg (141,9 Ml): 0,1 Ml left is nothing to reserve.
    expect(besoinsParStade({ kind: 'fini', quantite: 142, fini: 0, ecru: 0, tricotage: 141.9 }).aTricoter).toBe(0)
    expect(besoinsParStade({ kind: 'fini', quantite: 142, fini: 0, ecru: 0, tricotage: 140 }).aTricoter).toBe(2)
  })
})
