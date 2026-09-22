import { describe, it, expect } from 'vitest'
import { normalizePays } from './pays.js'

describe('normalizePays', () => {
  it('drops the legacy sentinels and blanks', () => {
    expect(normalizePays('')).toBe('')
    expect(normalizePays('   ')).toBe('')
    expect(normalizePays('-1')).toBe('')
    expect(normalizePays(null)).toBe('')
    expect(normalizePays(undefined)).toBe('')
  })

  it('trims and collapses whitespace', () => {
    expect(normalizePays('Belgique ')).toBe('Belgique')
    expect(normalizePays('  Pays-Bas  ')).toBe('Pays-Bas')
  })

  it('re-cases an all-upper or all-lower value word by word', () => {
    expect(normalizePays('FRANCE')).toBe('France')
    expect(normalizePays('france')).toBe('France')
    expect(normalizePays('ILE MAURICE')).toBe('Ile Maurice')
    expect(normalizePays('PAYS-BAS')).toBe('Pays-Bas')
    expect(normalizePays('ÉTATS-UNIS')).toBe('États-Unis')
  })

  it('keeps a mixed-case value as typed', () => {
    expect(normalizePays('États-Unis')).toBe('États-Unis')
    expect(normalizePays('Grèce')).toBe('Grèce')
    expect(normalizePays('Royaume-Uni')).toBe('Royaume-Uni')
  })
})
