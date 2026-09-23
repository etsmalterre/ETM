import { describe, expect, it } from 'vitest'
import { sstDeleteBlocker } from './sst-delete.js'

describe('sstDeleteBlocker', () => {
  it('no mirror (external sst) → deletable', () => {
    expect(sstDeleteBlocker(null)).toBeNull()
  })
  it('untouched mirror (#1184: empty order 9050) → deletable', () => {
    expect(sstDeleteBlocker({ est_soldee: 0, ofCount: 0, rollCount: 0 })).toBeNull()
  })
  it('an OF on a mirror line blocks', () => {
    expect(sstDeleteBlocker({ est_soldee: 0, ofCount: 1, rollCount: 0 })?.error).toBe('trm_production_started')
  })
  it('a knitted roll blocks even without an OF row', () => {
    expect(sstDeleteBlocker({ est_soldee: 0, ofCount: 0, rollCount: 3 })?.error).toBe('trm_production_started')
  })
  it('a mirror soldée by TRM blocks first', () => {
    expect(sstDeleteBlocker({ est_soldee: 1, ofCount: 2, rollCount: 0 })?.error).toBe('trm_soldee')
  })
  it('every blocker carries a French message for the dialog', () => {
    const cases = [
      { est_soldee: 1, ofCount: 0, rollCount: 0 },
      { est_soldee: 0, ofCount: 1, rollCount: 0 },
      { est_soldee: 0, ofCount: 0, rollCount: 1 },
    ]
    for (const c of cases) expect(sstDeleteBlocker(c)?.message).toMatch(/Tricotage Malterre/)
  })
})
