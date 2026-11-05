import { describe, it, expect } from 'vitest'
import { equipeRealisation, peutAnnuler, trierTaches, niveauTache, seuilAmbre, ageJours, DELAI_ANNULATION_MS, EQUIPE_MAX } from './taches-atelier.js'

const J = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

describe('equipeRealisation', () => {
  it('puts the declarer first and keeps each coéquipier once', () => {
    expect(equipeRealisation(4, [7, 4, 7, 9])).toEqual([4, 7, 9])
  })
  it('drops invalid ids', () => {
    expect(equipeRealisation(4, [0, -2, 1.5, 3])).toEqual([4, 3])
  })
  it('refuses an impossible team', () => {
    const many = Array.from({ length: EQUIPE_MAX }, (_, i) => i + 10)
    expect(equipeRealisation(1, many)).toBeNull()
  })
})

describe('peutAnnuler', () => {
  const r = { declare_par: 4, fait_le_ms: 1_000_000 }
  it('lets the declarer cancel within the delay', () => {
    expect(peutAnnuler(r, 4, 1_000_000 + DELAI_ANNULATION_MS - 1)).toBe(true)
  })
  it('refuses after the delay', () => {
    expect(peutAnnuler(r, 4, 1_000_000 + DELAI_ANNULATION_MS)).toBe(false)
  })
  it('refuses a coéquipier or anyone else', () => {
    expect(peutAnnuler(r, 7, 1_000_001)).toBe(false)
  })
})

describe('trierTaches', () => {
  it('never done first, then oldest réalisation first', () => {
    const out = trierTaches([
      { libelle: 'Sols', derniere_ms: 300 },
      { libelle: 'Vitres', derniere_ms: null },
      { libelle: 'Toiles', derniere_ms: 100 },
      { libelle: 'Bacs', derniere_ms: null },
    ])
    expect(out.map((t) => t.libelle)).toEqual(['Bacs', 'Vitres', 'Toiles', 'Sols'])
  })
})

describe('niveauTache', () => {
  it('30 days: green below 27, amber from 27, red from 30 (Vincent 2026-11-05)', () => {
    expect(seuilAmbre(30)).toBe(27)
    expect(niveauTache(30, NOW - 26 * J, NOW)).toBe('vert')
    expect(niveauTache(30, NOW - 27 * J, NOW)).toBe('ambre')
    expect(niveauTache(30, NOW - 29 * J - 1000, NOW)).toBe('ambre')
    expect(niveauTache(30, NOW - 30 * J, NOW)).toBe('rouge')
  })
  it('amber starts at least one day before the frequency', () => {
    expect(seuilAmbre(7)).toBe(6)
    expect(seuilAmbre(1)).toBe(0)
    expect(niveauTache(1, NOW - 1000, NOW)).toBe('ambre')
  })
  it('never done with a frequency = due', () => {
    expect(niveauTache(30, null, NOW)).toBe('rouge')
  })
  it('no frequency = no colour', () => {
    expect(niveauTache(null, NOW - 100 * J, NOW)).toBeNull()
    expect(niveauTache(null, null, NOW)).toBeNull()
  })
  it('counts whole 24 h days', () => {
    expect(ageJours(NOW - 12 * J - 5, NOW)).toBe(12)
    expect(ageJours(null, NOW)).toBeNull()
  })
})

describe('trierTaches with colours', () => {
  it('red, then amber, then the rest by age', () => {
    const out = trierTaches([
      { libelle: 'Vert', derniere_ms: 1, niveau: 'vert' as const },
      { libelle: 'Sans', derniere_ms: null, niveau: null },
      { libelle: 'Ambre', derniere_ms: 500, niveau: 'ambre' as const },
      { libelle: 'Rouge', derniere_ms: 900, niveau: 'rouge' as const },
    ])
    expect(out.map((t) => t.libelle)).toEqual(['Rouge', 'Ambre', 'Sans', 'Vert'])
  })
})
