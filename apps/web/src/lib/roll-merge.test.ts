import { describe, expect, it } from 'vitest'
import { mergedNumero, splitMergedNumero } from './roll-merge'

// Same cases as apps/api/src/lib/fini-sources.test.ts — the two helpers must
// print the same number for the same pieces.
describe('mergedNumero (web twin)', () => {
  it('prints the BL form when it fits', () => {
    expect(mergedNumero(['3510/11', '3510/2'])).toBe('3510/11+3510/2')
    expect(mergedNumero(['3510/11', '3524/9'])).toBe('3510/11+3524/9')
    expect(mergedNumero(['3510/1001', '3510/1002'])).toBe('3510/1001+3510/1002')
  })
  it('falls back to the compact form, then truncates', () => {
    expect(mergedNumero(['3510/11', '3510/12', '3510/13'])).toBe('3510/11+12+13')
    expect(mergedNumero(['3510/11', '3510/12', '3524/9'])).toBe('3510/11+12+3524/9')
    expect(mergedNumero(['3510/1001', '3510/1002', '3510/1003', '3510/1004', '3510/1005']).length).toBeLessThanOrEqual(20)
  })
  it('ignores blanks', () => {
    expect(mergedNumero([' 3510/11 ', '', '3510/2'])).toBe('3510/11+3510/2')
    expect(mergedNumero(['3510/11'])).toBe('3510/11')
  })
})

describe('splitMergedNumero', () => {
  it('returns the components', () => {
    expect(splitMergedNumero('3510/11+3510/2')).toEqual(['3510/11', '3510/2'])
    expect(splitMergedNumero('3510/11')).toEqual(['3510/11'])
  })
})
