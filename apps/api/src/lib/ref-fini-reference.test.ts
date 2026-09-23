import { describe, it, expect } from 'vitest'
import { referenceCandidate, referenceKey } from './ref-fini-reference.js'

describe('referenceKey — what counts as « the same name »', () => {
  it('ignores case, accents, outer and repeated spaces', () => {
    const k = referenceKey('Nouvelle référence')
    for (const same of ['nouvelle référence', 'NOUVELLE RÉFÉRENCE', 'Nouvelle reference', '  Nouvelle   référence ']) {
      expect(referenceKey(same)).toBe(k)
    }
  })

  it('keeps genuinely different names apart', () => {
    expect(referenceKey('061D')).not.toBe(referenceKey('061D (copie)'))
    expect(referenceKey('228/122')).not.toBe(referenceKey('228/12'))
  })
})

// Unique ref_fini names (2026-09-23): the placeholder and the copy each walk a
// numbered sequence until a name is free.
describe('referenceCandidate', () => {
  it('numbers a new placeholder « Nouvelle référence », « … 2 », « … 3 »', () => {
    expect([1, 2, 3].map((n) => referenceCandidate('Nouvelle référence', n, false)))
      .toEqual(['Nouvelle référence', 'Nouvelle référence 2', 'Nouvelle référence 3'])
  })

  it('numbers a copy « X (copie) », « X (copie 2) »', () => {
    expect([1, 2].map((n) => referenceCandidate(' 061D ', n, true))).toEqual(['061D (copie)', '061D (copie 2)'])
  })
})
