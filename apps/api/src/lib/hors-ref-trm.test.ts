import { describe, expect, it } from 'vitest'
import { estHorsRef } from './hors-ref-trm.js'

describe('estHorsRef', () => {
  const pairs = new Set(['10:3', '12:0'])

  it('flags a yarn the reference does not list', () => {
    expect(estHorsRef(pairs, 10, 4)).toBe(true)
    expect(estHorsRef(pairs, 99, 3)).toBe(true)
  })

  it('leaves a listed yarn alone', () => {
    expect(estHorsRef(pairs, 10, 3)).toBe(false)
    expect(estHorsRef(pairs, 12, 0)).toBe(false)
  })

  it('never flags anything when the reference declares no composition', () => {
    expect(estHorsRef(new Set(), 10, 4)).toBe(false)
  })
})
