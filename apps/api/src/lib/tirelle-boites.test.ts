import { describe, expect, it } from 'vitest'
import { BOITES, debutArchive, correspond, lireBoite, termesRecherche, type EtatBoite } from './tirelle-boites.js'

describe('the shelf', () => {
  it('holds 48 boxes, A1 to F8', () => {
    expect(BOITES).toHaveLength(48)
    expect(BOITES[0]).toBe('A1')
    expect(BOITES[8]).toBe('B1')
    expect(BOITES[47]).toBe('F8')
  })

  it('reads a typed box whatever its case and spaces', () => {
    expect(lireBoite('b3')).toBe('B3')
    expect(lireBoite(' A 1 ')).toBe('A1')
    expect(lireBoite('F8')).toBe('F8')
  })

  it('what was typed before the boxes is not a box (we start from zero, 2026-11-18)', () => {
    for (const v of ['Carton', 'Etagère', '0', '', 'G1', 'A9', 'A0', 'A12', 'AA', '12', null, undefined, 3]) {
      expect(lireBoite(v)).toBeNull()
    }
  })
})

describe('the search', () => {
  const lot = { lot: 'MA109539', reference: '027A', coloris: '0804 noir OTV 63764/2' }

  it('finds a lot by its number, its reference or its coloris', () => {
    expect(correspond(lot, termesRecherche('109539'))).toBe(true)
    expect(correspond(lot, termesRecherche('027a'))).toBe(true)
    expect(correspond(lot, termesRecherche('NOIR'))).toBe(true)
    expect(correspond(lot, termesRecherche('bleu'))).toBe(false)
  })

  it('every word must be found, each in any of the three', () => {
    expect(correspond(lot, termesRecherche('027A noir'))).toBe(true)
    expect(correspond(lot, termesRecherche('027A bleu'))).toBe(false)
  })

  it('ignores accents and case', () => {
    const ecru = { lot: 'TA532110', reference: '180B', coloris: 'Écru' }
    expect(correspond(ecru, termesRecherche('ecru'))).toBe(true)
    expect(correspond({ ...ecru, coloris: 'ecru' }, termesRecherche('ÉCRU'))).toBe(true)
  })

  it('an empty search matches nothing', () => {
    expect(correspond(lot, termesRecherche('   '))).toBe(false)
  })
})

describe('debutArchive', () => {
  const b = (boite: string, n: number, du: string | null): EtatBoite => ({ boite, n, du, au: du })

  it('is the reception of the oldest lot still in a box', () => {
    expect(debutArchive([b('A1', 12, '2026-03-02'), b('A2', 9, '2026-01-20'), b('A3', 0, null)])).toBe('2026-01-20')
  })

  it('none while every box is empty', () => {
    expect(debutArchive([b('A1', 0, null)])).toBeNull()
  })
})
