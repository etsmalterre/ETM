import { describe, it, expect } from 'vitest'
import {
  etatMetier,
  debutFenetreArrets,
  frequenceArret,
  pourcentageDefauts,
  alerteRegleur,
  FENETRE_FREQ_ARRET_MS,
} from './atelier-regleur-trm.js'

const H = 3600_000
const NOW = Date.parse('2026-09-08T10:00:00')

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

describe('debutFenetreArrets — 24 h or since the OF started', () => {
  it('is null for an OF that has not started', () => {
    expect(debutFenetreArrets(null, NOW)).toBeNull()
  })
  it('is 24 h ago for an OF older than a day', () => {
    expect(debutFenetreArrets(NOW - 3 * 24 * H, NOW)).toBe(NOW - FENETRE_FREQ_ARRET_MS)
  })
  it('is the OF start when it started less than a day ago', () => {
    expect(debutFenetreArrets(NOW - 5 * H, NOW)).toBe(NOW - 5 * H)
  })
})

describe('frequenceArret — unexplained stops per hour', () => {
  const debut = NOW - 4 * H
  it('counts only stops inside the window', () => {
    const arrets = [NOW - 5 * H, NOW - 3 * H, NOW - 2 * H, NOW - 1 * H, NOW - 0.5 * H]
    // 4 stops in 4 h, nothing expected → 1 / h
    expect(frequenceArret(debut, NOW, arrets, [])).toBe(1)
  })
  it('subtracts the stops a Nettoyage or a Fin de pièce explains', () => {
    const arrets = [NOW - 3 * H, NOW - 2 * H, NOW - 1 * H, NOW - 0.5 * H]
    const attendus = [NOW - 2 * H, NOW - 0.5 * H]
    // (4 − 2) × 60 / 240 = 0.5 → rounds to 1 (Arrondi rounds half up)
    expect(frequenceArret(debut, NOW, arrets, attendus)).toBe(1)
    const attendusPlus = [...attendus, NOW - 1 * H]
    // (4 − 3) × 60 / 240 = 0.25 → 0
    expect(frequenceArret(debut, NOW, arrets, attendusPlus)).toBe(0)
  })
  it('clamps at zero when more stops were expected than seen', () => {
    expect(frequenceArret(debut, NOW, [NOW - H], [NOW - 2 * H, NOW - H])).toBe(0)
  })
  it('is zero on an empty or not-started window', () => {
    expect(frequenceArret(null, NOW, [NOW - H], [])).toBe(0)
    expect(frequenceArret(NOW, NOW, [NOW], [])).toBe(0)
    expect(frequenceArret(NOW - 30_000, NOW, [NOW - 10_000], [])).toBe(0) // < 1 min
  })
  it('matches the legacy arithmetic on a busy métier', () => {
    // 20 h window, 41 stops, 11 expected → 30 × 60 / 1200 = 1.5 → 2
    const debutLong = NOW - 20 * H
    const arrets = Array.from({ length: 41 }, (_, i) => debutLong + i * 1_000_000)
    const attendus = Array.from({ length: 11 }, (_, i) => debutLong + i * 2_000_000)
    expect(frequenceArret(debutLong, NOW, arrets, attendus)).toBe(2)
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

describe('alerteRegleur — the legacy thresholds', () => {
  it('alerts above 2 % second choice, and zeroes the ratio when quiet', () => {
    expect(alerteRegleur(0.021, 0)).toEqual({ alerte: true, pct_defaut: 0.021, freq_arret: 0 })
    expect(alerteRegleur(0.02, 0)).toEqual({ alerte: false, pct_defaut: 0, freq_arret: 0 })
  })
  it('alerts above one unexplained stop per hour', () => {
    expect(alerteRegleur(0, 2)).toEqual({ alerte: true, pct_defaut: 0, freq_arret: 2 })
    expect(alerteRegleur(0, 1)).toEqual({ alerte: false, pct_defaut: 0, freq_arret: 1 })
  })
})
