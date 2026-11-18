import { describe, expect, it } from 'vitest'
import { ageArchive, lireBoite } from './boites'

describe('lireBoite', () => {
  it('reads a box whatever its case and spaces, nothing else', () => {
    expect(lireBoite('b 3')).toBe('B3')
    expect(lireBoite('Carton')).toBeNull()
    expect(lireBoite('A1 et A3')).toBeNull()
    expect(lireBoite(null)).toBeNull()
  })
})

describe('ageArchive', () => {
  const le = (iso: string) => new Date(`${iso}T12:00:00`)

  it('counts whole months', () => {
    expect(ageArchive('2026-01-20', le('2026-11-18'))).toBe('9 mois')
    expect(ageArchive('2026-01-20', le('2026-11-20'))).toBe('10 mois')
  })

  it('days under a month', () => {
    expect(ageArchive('2026-11-06', le('2026-11-18'))).toBe('12 jours')
    expect(ageArchive('2026-11-17', le('2026-11-18'))).toBe('1 jour')
  })

  it('years then months', () => {
    expect(ageArchive('2025-09-18', le('2026-11-18'))).toBe('1 an et 2 mois')
    expect(ageArchive('2024-11-18', le('2026-11-18'))).toBe('2 ans')
  })
})
