import { describe, it, expect, vi, beforeEach } from 'vitest'

// No base in unit tests: `loadRefEcruMachineCodes` reads through this mock.
const queryMock = vi.fn()
vi.mock('./hfsql-auto.js', () => ({
  query: (...args: unknown[]) => queryMock(...args),
}))

const { retain, NbAiguilles, coutOperation, loadRefEcruMachineCodes } = await import('./pricing-trm.js')

beforeEach(() => queryMock.mockReset())

// One rule — the legacy one: max(cost / 0,7, base), the base retained flat
// when it wins. Real numbers probed from société 2 on 2026-08-26. The
// cost-floor variant (max(cost, base) / 0,7) the native TRM suggestion used
// between 2026-08-26 and 2026-09-11 is gone: pinning these protects both the
// intercompany transfer price and the suggestion from being repriced.
describe('retain — the base is a floor on the sale price', () => {
  it('keeps the base flat when it wins', () => {
    // ref 4 @500 kg: the ETM → TRM sous-traitance line really is stored at 2,07
    // €, the bare base with no markup.
    expect(retain(1.4025, 2.07)).toEqual({ retainedPrice: 2.07, retainedFrom: 'base' })
    // ref 180 @2 000 kg — LIVA #1151: 2,30 € is the fiche's base, not a margin.
    expect(retain(1.1994, 2.30)).toEqual({ retainedPrice: 2.3, retainedFrom: 'base' })
  })

  it('takes the marged cost when it beats the base, and says so', () => {
    // Cost between base × 0,7 and base: the price is cost / 0,7 and the
    // provenance must follow (LIVA #1151 — it said 'base' while carrying 2,43 €).
    expect(retain(1.70, 1.84)).toEqual({ retainedPrice: 2.43, retainedFrom: 'revient' })
    // ref 350 (« 005 ») @100 kg — cost 2,0158 vs base 2,0125: 2,88 €.
    expect(retain(2.0158, 2.0125)).toEqual({ retainedPrice: 2.88, retainedFrom: 'revient' })
    // ref 328 @10 kg — cost far above the base.
    expect(retain(5.7468, 2.3)).toEqual({ retainedPrice: 8.21, retainedFrom: 'revient' })
  })

  it('falls back to the bare base when the cost is not computable', () => {
    // No ref_ecru_machine rows → costPerKg 0: the legacy rule suggests the base.
    expect(retain(0, 2.3)).toEqual({ retainedPrice: 2.3, retainedFrom: 'base' })
  })

  it('never returns a negative price from bad inputs', () => {
    expect(retain(-5, -3).retainedPrice).toBe(0)
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

describe('loadRefEcruMachineCodes', () => {
  it('reads diamètre however the driver spells the key', async () => {
    // Windows keeps the accent; the Linux bridge truncates it and appends a
    // garbage byte that changes between calls. Every shape must yield 3 —
    // the hardcoded fallback that stood here read 0 in production.
    for (const key of ['diamètre', 'diamtre', 'diamtx', 'diam']) {
      queryMock.mockResolvedValueOnce([{ IDref_ecru: 192, Jauge: 4, [key]: 3 }])
      expect(await loadRefEcruMachineCodes(192)).toEqual({ Jauge: 4, diametre: 3 })
    }
  })

  it('returns zeros for an unknown reference', async () => {
    queryMock.mockResolvedValueOnce([])
    expect(await loadRefEcruMachineCodes(999999)).toEqual({ Jauge: 0, diametre: 0 })
    expect(await loadRefEcruMachineCodes(0)).toEqual({ Jauge: 0, diametre: 0 })
  })
})
