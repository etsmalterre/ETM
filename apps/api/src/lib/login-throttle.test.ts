import { describe, expect, it } from 'vitest'
import { WINDOW_MS, attenteAvantEssai } from './login-throttle.js'

describe('attenteAvantEssai', () => {
  const now = 1_000_000_000

  it('allows while under the limit', () => {
    expect(attenteAvantEssai([now - 1000, now - 2000], 5, now)).toBe(0)
  })

  it('waits until the oldest counted failure leaves the window', () => {
    const echecs = [now - 1, now - 2, now - 3, now - 4, now - 60_000]
    expect(attenteAvantEssai(echecs, 5, now)).toBe(WINDOW_MS - 60_000)
  })

  it('never locks for good: the wait ends', () => {
    const echecs = [0, 0, 0, 0, 0].map((_, i) => now - WINDOW_MS - i)
    expect(attenteAvantEssai(echecs, 5, now)).toBe(0)
  })
})
