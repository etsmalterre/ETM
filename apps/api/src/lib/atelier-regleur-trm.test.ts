import { describe, it, expect } from 'vitest'
import {
  etatMetier,
  pourcentageDefauts,
  alerteRegleur,
  SEUIL_ARRETS_PIECE,
} from './atelier-regleur-trm.js'

describe('etatMetier — the three tile icons', () => {
  it('réglage until the OF has started, whatever else is set', () => {
    expect(etatMetier(false, false)).toBe('reglage')
    expect(etatMetier(false, true)).toBe('reglage')
  })
  it('pause when interrupted, marche otherwise', () => {
    expect(etatMetier(true, true)).toBe('pause')
    expect(etatMetier(true, false)).toBe('marche')
  })
})

describe('pourcentageDefauts — second-choice weight over the recent rolls', () => {
  it('is zero with no rolls', () => {
    expect(pourcentageDefauts([])).toBe(0)
  })
  it('is the weight ratio, not the count ratio', () => {
    const rows = [
      { poids: 30, second_choix: true },
      { poids: 70, second_choix: false },
      { poids: 100, second_choix: false },
    ]
    expect(pourcentageDefauts(rows)).toBeCloseTo(0.15, 6)
  })
  it('stops after the roll that reaches 1 000 kg', () => {
    const rows = [
      ...Array.from({ length: 10 }, () => ({ poids: 100, second_choix: false })), // 1 000 kg, all good
      { poids: 100, second_choix: true }, // must not be counted
    ]
    expect(pourcentageDefauts(rows)).toBe(0)
  })
  it('includes the roll that crosses the threshold', () => {
    const rows = [
      ...Array.from({ length: 9 }, () => ({ poids: 100, second_choix: false })), // 900
      { poids: 200, second_choix: true }, // 1 100 — counted, then stop
      { poids: 100, second_choix: true },
    ]
    expect(pourcentageDefauts(rows)).toBeCloseTo(200 / 1100, 6)
  })
  it('never looks past 100 rolls', () => {
    const rows = [
      ...Array.from({ length: 100 }, () => ({ poids: 1, second_choix: false })),
      { poids: 1000, second_choix: true },
    ]
    expect(pourcentageDefauts(rows)).toBe(0)
  })
})

describe('alerteRegleur — 2 % second choice (legacy) or more than one stop per piece (tablet)', () => {
  const calme = { moyenne: 0.7, pieces: 3 }
  const aucune = { moyenne: null, pieces: 0 }

  it('alerts strictly above 2 % second choice', () => {
    expect(alerteRegleur(0.021, calme)).toEqual({ alerte: true, arrets_piece: calme })
    expect(alerteRegleur(0.02, calme)).toEqual({ alerte: false, arrets_piece: calme })
  })
  it('alerts strictly above the tablet amber step, never at it', () => {
    expect(SEUIL_ARRETS_PIECE).toBe(1)
    expect(alerteRegleur(0, { moyenne: 1.3, pieces: 3 }).alerte).toBe(true)
    expect(alerteRegleur(0, { moyenne: 1, pieces: 3 }).alerte).toBe(false)
  })
  it('is quiet without a finished piece, and keeps the number on the tile either way', () => {
    expect(alerteRegleur(0, aucune)).toEqual({ alerte: false, arrets_piece: aucune })
    expect(alerteRegleur(0.012, { moyenne: 4.7, pieces: 3 })).toEqual({
      alerte: true,
      arrets_piece: { moyenne: 4.7, pieces: 3 },
    })
  })
  it('never carries the ratio — it travels raw on every machine list, alert or not (2026-09-22)', () => {
    // The legacy zeroed the % without a bell; both roles now read it from 1 %
    // on the tile, so the alert no longer owns the figure.
    expect(alerteRegleur(0.012, calme)).not.toHaveProperty('pct_defaut')
    expect(alerteRegleur(0.05, calme)).not.toHaveProperty('pct_defaut')
  })
})
