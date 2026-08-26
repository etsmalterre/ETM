import { describe, it, expect } from 'vitest'
import { BAREMES_PRIME, baremePour } from './bareme-prime-trm.js'

// The prime is a sum over a whole semester × one rate, so the barème is keyed
// on the semester's `debut`. These tests pin the two things that matter: past
// semesters must keep the rates they were actually paid at, and the revision
// must land exactly on the 15/06/2026 boundary — not a day either side.
describe('baremePour', () => {
  it('prices every semester up to S1 2026 at the legacy rates', () => {
    for (const debut of ['2019-06-15', '2023-12-15', '2025-06-15', '2025-12-15']) {
      const b = baremePour(debut)
      expect(b.premierChoix, debut).toBe(0.05)
      expect(b.secondChoix, debut).toBe(-0.2)
    }
  })

  it('applies the 2026 revision from S2 2026 onward', () => {
    for (const debut of ['2026-06-15', '2026-12-15', '2027-06-15']) {
      const b = baremePour(debut)
      expect(b.premierChoix, debut).toBe(0.055)
      expect(b.secondChoix, debut).toBe(-0.4)
    }
  })

  it('switches exactly on 2026-06-15, not a day either side', () => {
    // S1 2026 runs 15/12/2025 → 15/06/2026 and keeps the old barème; the new
    // one starts with the semester that BEGINS on the pivot.
    expect(baremePour('2025-12-15').premierChoix).toBe(0.05)
    expect(baremePour('2026-06-15').premierChoix).toBe(0.055)
  })

  it('leaves retour client alone — the tile is dead (always 0)', () => {
    for (const b of BAREMES_PRIME) expect(b.retourClient).toBe(-0.6)
  })

  it('never returns undefined, even before the first barème', () => {
    expect(baremePour('1970-01-01')).toBe(BAREMES_PRIME[0])
  })

  it('keeps the table sorted and on semester boundaries (15/06 or 15/12)', () => {
    // baremePour breaks out of its loop on the first future entry, so an
    // out-of-order table would silently resolve wrong. And a `from` that is not
    // a semester boundary would split a semester the sums cannot split.
    const froms = BAREMES_PRIME.map((b) => b.from)
    expect([...froms].sort()).toEqual(froms)
    for (const f of froms.slice(1)) expect(f.slice(5)).toMatch(/^(06-15|12-15)$/)
  })
})
