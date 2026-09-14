import { describe, expect, it } from 'vitest'
import { mergedNumero, splitMergedNumero } from './fini-sources.js'

describe('mergedNumero', () => {
  it('prints the BL form when it fits the 20-char column', () => {
    expect(mergedNumero(['3510/11', '3510/2'])).toBe('3510/11+3510/2')
    expect(mergedNumero(['3524/10', '3524/11'])).toBe('3524/10+3524/11')
    // Different bases stay fully spelled out.
    expect(mergedNumero(['3510/11', '3524/9'])).toBe('3510/11+3524/9')
    // Pairs of /1001-style numbers still fit (19 chars).
    expect(mergedNumero(['3510/1001', '3510/1002'])).toBe('3510/1001+3510/1002')
  })
  it('falls back to the compact form when the full one overflows', () => {
    // 3 pieces of the same base: full form is 22 chars → compact.
    expect(mergedNumero(['3510/11', '3510/12', '3510/13'])).toBe('3510/11+12+13')
    // Compact keeps a piece of another base fully spelled out.
    expect(mergedNumero(['3510/11', '3510/12', '3524/9'])).toBe('3510/11+12+3524/9')
  })
  it('truncates as a last resort and never exceeds the column', () => {
    const n = mergedNumero(['3510/1001', '3510/1002', '3510/1003', '3510/1004', '3510/1005'])
    expect(n.length).toBeLessThanOrEqual(20)
  })
  it('ignores blanks and trims', () => {
    expect(mergedNumero([' 3510/11 ', '', '3510/2'])).toBe('3510/11+3510/2')
    expect(mergedNumero([])).toBe('')
    expect(mergedNumero(['3510/11'])).toBe('3510/11')
  })
})

describe('splitMergedNumero', () => {
  it('returns the printed components', () => {
    expect(splitMergedNumero('3510/11+3510/2')).toEqual(['3510/11', '3510/2'])
    expect(splitMergedNumero(' 3510/11 + 3510/2 ')).toEqual(['3510/11', '3510/2'])
    expect(splitMergedNumero('3510/11')).toEqual(['3510/11'])
    expect(splitMergedNumero('')).toEqual([])
  })
})
