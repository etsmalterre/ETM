import { describe, expect, it } from 'vitest'
import { normaliserLot } from './reprises.js'

describe('normaliserLot', () => {
  it('glues the dyer’s letters to the number, upper case (« MA 109401 » typed on 2026-10-12)', () => {
    expect(normaliserLot('MA 109401')).toBe('MA109401')
    expect(normaliserLot(' ma109401 ')).toBe('MA109401')
    expect(normaliserLot('bon 3976')).toBe('BON3976')
    expect(normaliserLot('TA531487')).toBe('TA531487')
  })
  it('leaves anything else as typed', () => {
    expect(normaliserLot('MA107895 ET 107887')).toBe('MA107895 ET 107887')
    expect(normaliserLot('trm1234')).toBe('trm1234')
    expect(normaliserLot('')).toBe('')
  })
  it('keeps a reprise suffix visible to the guard', () => {
    expect(normaliserLot('ma 109102r')).toBe('MA109102R')
  })
})
