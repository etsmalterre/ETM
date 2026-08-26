import { describe, it, expect } from 'vitest'
import { retain, NbAiguilles, coutOperation } from './pricing-trm.js'

// The two rules coincide whenever the base is at or below the cost of revient,
// and diverge sharply above it — which is the common case (on the 51 refs used
// by native TRM client orders they differ on 40 at 100 kg). These numbers are
// real ones probed from société 2 on 2026-08-26.
describe('retain — which role ref_ecru.prix plays', () => {
  it("keeps the base flat when it wins under 'price-floor' (the legacy rule)", () => {
    // ref 4 @500 kg: the ETM → TRM sous-traitance line really is stored at 2,07
    // €, the bare base with no markup. Pinning this protects the intercompany
    // transfer price from being silently repriced.
    expect(retain(1.4025, 2.07, 'price-floor')).toEqual({ retainedPrice: 2.07, retainedFrom: 'base' })
    expect(retain(1.1994, 2.30, 'price-floor')).toEqual({ retainedPrice: 2.3, retainedFrom: 'base' })
  })

  it("marks the base up when it wins under 'cost-floor' (TRM client orders)", () => {
    expect(retain(1.4025, 2.07, 'cost-floor')).toEqual({ retainedPrice: 2.96, retainedFrom: 'base' })
    expect(retain(1.1994, 2.30, 'cost-floor')).toEqual({ retainedPrice: 3.29, retainedFrom: 'base' })
  })

  it('agrees on both rules when the cost of revient wins', () => {
    // ref 350 (« 005 ») @100 kg — cost 2,0158 vs base 2,0125, the case that
    // exposed the legacy/PWA gap: 2,88 € either way.
    for (const role of ['price-floor', 'cost-floor'] as const) {
      expect(retain(2.0158, 2.0125, role)).toEqual({ retainedPrice: 2.88, retainedFrom: 'revient' })
    }
    // ref 328 @10 kg — cost far above the base.
    for (const role of ['price-floor', 'cost-floor'] as const) {
      expect(retain(5.7468, 2.3, role)).toEqual({ retainedPrice: 8.21, retainedFrom: 'revient' })
    }
  })

  it('falls back to the base alone when the cost is not computable', () => {
    // No ref_ecru_machine rows → costPerKg 0. The legacy rule suggests the bare
    // base; the cost-floor rule still applies TRM's margin to it.
    expect(retain(0, 2.3, 'price-floor')).toEqual({ retainedPrice: 2.3, retainedFrom: 'base' })
    expect(retain(0, 2.3, 'cost-floor')).toEqual({ retainedPrice: 3.29, retainedFrom: 'base' })
  })

  it('never returns a negative price from bad inputs', () => {
    expect(retain(-5, -3, 'price-floor').retainedPrice).toBe(0)
    expect(retain(-5, -3, 'cost-floor').retainedPrice).toBe(0)
  })
})

describe('NbAiguilles', () => {
  it('maps the (Jauge, diamètre) codes to actual values', () => {
    expect(NbAiguilles(4, 3)).toBe(Math.round(Math.PI * 30 * 20)) // J20, 30"
    expect(NbAiguilles(5, 2)).toBe(Math.round(Math.PI * 26 * 28)) // J28, 26"
  })

  it('returns 0 for unknown codes, as the legacy does', () => {
    expect(NbAiguilles(0, 0)).toBe(0)
    expect(NbAiguilles(9, 9)).toBe(0)
  })
})

describe('coutOperation', () => {
  const tarif = new Map<string, number>([['tps', 6], ['freq', 100]])

  it('amortizes a task over the ordered weight, rounding operations up', () => {
    // 250 kg / 100 kg per op = 3 ops (ceil) × 6 min × (60 €/h / 60) = 18 €
    expect(coutOperation('tps', 'freq', 60, 250, tarif)).toBeCloseTo(18, 10)
  })

  it('treats an empty freq key as a single one-off operation', () => {
    expect(coutOperation('tps', '', 60, 250, tarif)).toBeCloseTo(6, 10)
  })

  it('treats a non-positive frequency as a single operation rather than dividing by zero', () => {
    expect(coutOperation('tps', 'absent', 60, 250, tarif)).toBeCloseTo(6, 10)
  })
})
