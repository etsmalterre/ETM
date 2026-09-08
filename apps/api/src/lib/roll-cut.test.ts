import { describe, expect, it } from 'vitest'
import { childNumero, cutBase, nextCutIndex } from './roll-cut.js'

describe('cutBase', () => {
  it('returns a plain numero unchanged', () => {
    expect(cutBase('3204/14')).toBe('3204/14')
    expect(cutBase(' 3204/14 ')).toBe('3204/14')
  })
  it('strips one trailing cut suffix', () => {
    expect(cutBase('3204/14-2')).toBe('3204/14')
    expect(cutBase('3204/14-12')).toBe('3204/14')
  })
  it('keeps a dash that is not followed by digits', () => {
    expect(cutBase('AB-X')).toBe('AB-X')
    expect(cutBase('AB-')).toBe('AB-')
  })
})

describe('nextCutIndex', () => {
  it('starts at 1 when nothing derives from the base (legacy: 3204/11 → 3204/11-1)', () => {
    expect(nextCutIndex('3204/14', [])).toBe(1)
    // The driver returns the bare base for `LIKE '<base>-%'` — it must not count.
    expect(nextCutIndex('3204/14', ['3204/14', '3204/13-2'])).toBe(1)
  })
  it('continues after the highest existing suffix (legacy MAX rule)', () => {
    expect(nextCutIndex('3204/13', ['3204/13-1', '3204/13-2'])).toBe(3)
    expect(nextCutIndex('3204/14', ['3204/14', '3204/14-2'])).toBe(3)
    expect(nextCutIndex('3204/14', ['3204/14-3', '3204/14-2'])).toBe(4)
  })
  it('ignores non-numeric tails and longer prefixes', () => {
    expect(nextCutIndex('3204/1', ['3204/14-2', '3204/1-x'])).toBe(1)
  })
  it('does not restart when cutting a piece that is itself a cut (#1135 follow-up)', () => {
    const base = cutBase('3204/14-2')
    expect(nextCutIndex(base, ['3204/14', '3204/14-2'])).toBe(3)
  })
})

describe('childNumero', () => {
  it('appends the index', () => {
    expect(childNumero('3204/14', 2)).toBe('3204/14-2')
  })
  it('trims the base, never the suffix, to fit 20 chars', () => {
    const long = 'ABCDEFGHIJKLMNOPQRSTUV'
    expect(childNumero(long, 10)).toBe('ABCDEFGHIJKLMNOPQ-10')
    expect(childNumero(long, 10)).toHaveLength(20)
  })
})
