import { describe, expect, it } from 'vitest'
import { refusLotSuffixe, suffixeReprise } from './reprises.js'

describe('suffixeReprise', () => {
  it('reads the canonical R', () => {
    expect(suffixeReprise('MA109102R')).toEqual({ base: 'MA109102', rang: 1, canonique: true })
  })
  it('reads the prod variants (2026-10-12 census)', () => {
    expect(suffixeReprise('ma100941r')).toEqual({ base: 'MA100941', rang: 1, canonique: false })
    expect(suffixeReprise('Ma107641R')?.base).toBe('MA107641')
    expect(suffixeReprise('97699R')).toEqual({ base: '97699', rang: 1, canonique: false })
    expect(suffixeReprise('MA106799-R')?.base).toBe('MA106799')
    expect(suffixeReprise('MA96212 REPRIS')).toEqual({ base: 'MA96212', rang: 1, canonique: false })
    expect(suffixeReprise('Ma77897repris')?.base).toBe('MA77897')
    expect(suffixeReprise('MA104376R1')?.rang).toBe(1)
    expect(suffixeReprise('MA104848R2')).toEqual({ base: 'MA104848', rang: 2, canonique: false })
    expect(suffixeReprise('MA104374R3')?.rang).toBe(3)
    expect(suffixeReprise('MA107825TER')).toEqual({ base: 'MA107825', rang: 3, canonique: false })
    expect(suffixeReprise('MA106117BR2')).toEqual({ base: 'MA106117B', rang: 2, canonique: false })
  })
  it('leaves letters, plain lots and free text alone', () => {
    for (const l of ['MA109102', 'MA102828B', 'MA 109402B', 'MA105228A', 'MA104164TUB', 'MA107895 ET 107887', 'MA107971 - SURTEINTU', 'BON3976', 'TA530425', '']) {
      expect(suffixeReprise(l)).toBeNull()
    }
  })
})

describe('refusLotSuffixe', () => {
  it('refuses a newly typed R', () => {
    expect(refusLotSuffixe('MA109102R', 'MA109102')).toMatch(/MA109102/)
    expect(refusLotSuffixe('MA109102R')).not.toBeNull()
  })
  it('lets the dyer number and an unchanged old lot pass', () => {
    expect(refusLotSuffixe('MA109102', 'MA109102R')).toBeNull()
    expect(refusLotSuffixe('MA109102R', 'MA109102R')).toBeNull()
    expect(refusLotSuffixe('MA 109402B', 'ma19402')).toBeNull()
  })
})
