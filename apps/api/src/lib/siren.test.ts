import { describe, it, expect } from 'vitest'
import { normalizeSiren, isValidSiren, sirenLuhnOk, formatSiren, formatSirenForDocument } from './siren.js'

describe('normalizeSiren', () => {
  it('keeps the digits only', () => {
    expect(normalizeSiren('552 100 554')).toBe('552100554')
    expect(normalizeSiren('552.100.554')).toBe('552100554')
    expect(normalizeSiren('  552100554  ')).toBe('552100554')
  })
  it('is null-safe', () => {
    expect(normalizeSiren(null)).toBe('')
    expect(normalizeSiren(undefined)).toBe('')
  })
})

describe('isValidSiren', () => {
  it('accepts an empty value — the field is optional', () => {
    expect(isValidSiren('')).toBe(true)
    expect(isValidSiren(null)).toBe(true)
  })
  it('accepts exactly 9 digits, formatted or not', () => {
    expect(isValidSiren('552100554')).toBe(true)
    expect(isValidSiren('552 100 554')).toBe(true)
  })
  it('refuses anything else, a 14-digit SIRET included', () => {
    expect(isValidSiren('55210055')).toBe(false)
    expect(isValidSiren('5521005541')).toBe(false)
    expect(isValidSiren('55210055400013')).toBe(false)
  })
})

describe('sirenLuhnOk', () => {
  it('passes a Luhn-valid identifier', () => {
    expect(sirenLuhnOk('552100554')).toBe(true)
    expect(sirenLuhnOk('380129866')).toBe(true)
  })
  it('catches a transposition typo', () => {
    expect(sirenLuhnOk('552100545')).toBe(false)
  })
  it('is false for anything that is not 9 digits', () => {
    expect(sirenLuhnOk('')).toBe(false)
    expect(sirenLuhnOk('55210055400013')).toBe(false)
  })
})

describe('formatSiren / formatSirenForDocument (LIVA #1130)', () => {
  it('prints a full SIREN in groups of three', () => {
    expect(formatSiren('552100554')).toBe('552 100 554')
    expect(formatSiren('552 100 554')).toBe('552 100 554')
  })
  it('leaves an incomplete value as bare digits', () => {
    expect(formatSiren('55210')).toBe('55210')
    expect(formatSiren('')).toBe('')
  })
  it('gives a document a formatted SIREN or nothing at all', () => {
    expect(formatSirenForDocument('552100554')).toBe('552 100 554')
    expect(formatSirenForDocument(' 552.100.554 ')).toBe('552 100 554')
    expect(formatSirenForDocument('')).toBeNull()
    expect(formatSirenForDocument(null)).toBeNull()
    expect(formatSirenForDocument(undefined)).toBeNull()
    // A junk value must not reach the invoice half-formatted.
    expect(formatSirenForDocument('12345')).toBeNull()
  })
})
