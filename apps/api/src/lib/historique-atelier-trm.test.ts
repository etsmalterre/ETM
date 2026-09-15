import { describe, it, expect } from 'vitest'
import {
  dureeMinimalePiece,
  productivitePiece,
  dureeMinutes,
  PRODUCTIVITE_MAX,
} from './historique-atelier-trm.js'

describe('dureeMinimalePiece — the legacy 20-tours-per-minute minimum', () => {
  it('reproduces the WLanguage arithmetic', () => {
    // trs_10kg_chute = 800, nb_chutes = 4 → 200 tours / 10 kg → 0.05 kg/tour
    // → 1 kg/min at 20 tours/min → a 100 kg piece takes 100 min.
    expect(dureeMinimalePiece(800, 4, 100)).toBeCloseTo(100, 6)
    // 20 kg piece on the same sheet: 20 min.
    expect(dureeMinimalePiece(800, 4, 20)).toBeCloseTo(20, 6)
  })
  it('is null when the sheet cannot say (the legacy stores 0 min)', () => {
    expect(dureeMinimalePiece(0, 4, 100)).toBeNull()
    expect(dureeMinimalePiece(800, 0, 100)).toBeNull()
    expect(dureeMinimalePiece(800, 4, 0)).toBeNull()
  })
})

describe('productivitePiece — the % and its colour', () => {
  it('is the minimum over the real duration, rounded', () => {
    expect(productivitePiece(100, 122)).toEqual({ pct: 82, alerte: false })
    expect(productivitePiece(100, 104)).toEqual({ pct: 96, alerte: false })
    expect(productivitePiece(100, 100)).toEqual({ pct: 100, alerte: false })
  })
  it('paints red under 70 %', () => {
    expect(productivitePiece(100, 630)).toEqual({ pct: 16, alerte: true })
    expect(productivitePiece(100, 142)).toEqual({ pct: 70, alerte: false })
    // 100 / 143 rounds to 70 % but the ratio is 0.699: the colour reads the raw ratio.
    expect(productivitePiece(100, 143)).toEqual({ pct: 70, alerte: true })
    expect(productivitePiece(100, 144)).toEqual({ pct: 69, alerte: true })
  })
  it('caps at 120 % and paints that red too (a too-fast piece is a bad stamp)', () => {
    expect(productivitePiece(100, 50)).toEqual({ pct: PRODUCTIVITE_MAX * 100, alerte: true })
    expect(productivitePiece(100, 84)).toEqual({ pct: 119, alerte: false })
  })
  it('is null for an unfinished piece or an un-sheeted reference', () => {
    expect(productivitePiece(100, null)).toBeNull()
    expect(productivitePiece(null, 120)).toBeNull()
    expect(productivitePiece(100, 0)).toBeNull()
  })
})

describe('dureeMinutes — Arrondi(d.EnMinutes, 0)', () => {
  it('rounds to the nearest whole minute', () => {
    const t0 = Date.UTC(2026, 8, 15, 8, 3, 50)
    expect(dureeMinutes(t0, t0 + 122 * 60000)).toBe(122)
    expect(dureeMinutes(t0, t0 + 121 * 60000 + 31 * 1000)).toBe(122)
    expect(dureeMinutes(t0, t0 + 121 * 60000 + 29 * 1000)).toBe(121)
  })
  it('is null without both stamps or with an end before the start', () => {
    expect(dureeMinutes(null, 1)).toBeNull()
    expect(dureeMinutes(1, null)).toBeNull()
    expect(dureeMinutes(10, 10)).toBeNull()
    expect(dureeMinutes(10, 5)).toBeNull()
  })
})
