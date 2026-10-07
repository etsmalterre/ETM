import { describe, expect, it } from 'vitest'
import { analyserConsommation, MARGE_SEMAINES, MOIS_HISTORIQUE } from './fil-consommation.js'

// 2026-10-07: the running month is October; the 12 complete months are
// October 2025 → September 2026 (365 days).
const TODAY = new Date(2026, 9, 7)

function months(from: [number, number], count: number, kg: number): Map<string, number> {
  const m = new Map<string, number>()
  for (let i = 0; i < count; i++) {
    const d = new Date(from[0], from[1] - 1 + i, 1)
    m.set(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, kg)
  }
  return m
}

describe('analyserConsommation', () => {
  it('measures the rate on complete months only and ignores the running one', () => {
    const parMois = months([2025, 10], 12, 100) // Oct 2025 → Sep 2026, 100 kg each
    parMois.set('2026-10', 5000) // running month — must not move the rate
    const a = analyserConsommation({ parMois, aujourdhui: TODAY, disponible: 600, stockMini: 0, delaiSemaines: 0 })
    expect(a.kg_semaine_12m).toBeCloseTo((1200 / 365) * 7, 6)
    expect(a.kg_semaine_3m).toBeCloseTo((300 / (31 + 31 + 30)) * 7, 6) // Jul, Aug, Sep
    expect(a.mensuel).toHaveLength(MOIS_HISTORIQUE)
    expect(a.mensuel.at(-1)).toEqual({ mois: '2026-10', kg: 5000, partiel: true })
    expect(a.mensuel[0].mois).toBe('2024-11')
    expect(a.statut).toBe('sans_mini')
    expect(a.mini_suggere).toBeNull() // no délai → no suggestion
  })

  it('turns délai + marge into a suggested minimum, rounded up to 10 kg', () => {
    const parMois = months([2025, 10], 12, 100)
    const a = analyserConsommation({ parMois, aujourdhui: TODAY, disponible: 600, stockMini: 0, delaiSemaines: 12 })
    const rate = (1200 / 365) * 7 // ≈ 23.01 kg/week
    expect(a.mini_suggere).toBe(Math.ceil((rate * (12 + MARGE_SEMAINES)) / 10) * 10) // 368.2 → 370
    expect(a.mini_suggere).toBe(370)
  })

  it('dates the order and the run-out from the available stock', () => {
    const parMois = months([2025, 10], 12, 100)
    const rate = (1200 / 365) * 7
    const a = analyserConsommation({ parMois, aujourdhui: TODAY, disponible: 600, stockMini: 300, delaiSemaines: 0 })
    expect(a.semaines_couvertes).toBeCloseTo(600 / rate, 6)
    expect(a.semaines_mini).toBeCloseTo(300 / rate, 6)
    expect(a.semaines_avant_mini).toBeCloseTo(300 / rate, 6)
    // 300 kg at 1200 kg / 365 days = 91.25 days → 91 days after 7 Oct = 6 Jan 2027
    expect(a.date_commande).toBe('2027-01-06')
    expect(a.date_rupture).toBe('2027-04-08') // 182.5 days → 183
    expect(a.statut).toBe('ok')
  })

  it('flags « commander » at or under the minimum and « bientot » within the margin', () => {
    const parMois = months([2025, 10], 12, 100)
    const under = analyserConsommation({ parMois, aujourdhui: TODAY, disponible: 163.7, stockMini: 180, delaiSemaines: 0 })
    expect(under.statut).toBe('commander')
    expect(under.semaines_avant_mini).toBe(0)
    expect(under.date_commande).toBe('2026-10-07') // today
    const soon = analyserConsommation({ parMois, aujourdhui: TODAY, disponible: 250, stockMini: 180, delaiSemaines: 0 })
    expect(soon.statut).toBe('bientot') // 70 kg ≈ 3 weeks ≤ marge
  })

  it('has no dates when nothing was consumed', () => {
    const a = analyserConsommation({ parMois: new Map(), aujourdhui: TODAY, disponible: 50, stockMini: 20, delaiSemaines: 8 })
    expect(a.kg_semaine_12m).toBe(0)
    expect(a.semaines_couvertes).toBeNull()
    expect(a.date_rupture).toBeNull()
    expect(a.date_commande).toBeNull()
    expect(a.mini_suggere).toBeNull()
    expect(a.statut).toBe('ok')
  })

  it('counts a negative available stock as zero weeks of cover', () => {
    const parMois = months([2025, 10], 12, 100)
    const a = analyserConsommation({ parMois, aujourdhui: TODAY, disponible: -40, stockMini: 100, delaiSemaines: 0 })
    expect(a.semaines_couvertes).toBe(0)
    expect(a.statut).toBe('commander')
  })
})
