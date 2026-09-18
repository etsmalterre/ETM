import { describe, expect, it } from 'vitest'
import { handoverSets, releaseSets } from './trm-handover.js'

// LIVA #1172 — « Doublons de pièces ». The legacy « Expédier » stamped the ETM
// sst line on every roll AND reset IDmagasin to the factory; the API stamps the
// line and leaves the magasin alone.

describe('handoverSets', () => {
  it('stamps the ETM sst line on a mirror line shipped to Ets Malterre (3568/7 → line 8978)', () => {
    expect(handoverSets({ expId: 12325, leId: 26813, toEtm: true, etmLineId: 8978 })).toEqual([
      'IDligne_expedition_TRM = 26813',
      "lot = 'trm12325'",
      'IDsociete = 1',
      'IDref_commande_source = 8978',
    ])
  })
  it('leaves the source line alone on a TRM-native line', () => {
    const sets = handoverSets({ expId: 12330, leId: 26818, toEtm: true, etmLineId: 0 })
    expect(sets.some((s) => s.startsWith('IDref_commande_source'))).toBe(false)
  })
  it('does not change owner when the client is not Ets Malterre', () => {
    const sets = handoverSets({ expId: 12400, leId: 27000, toEtm: false, etmLineId: 0 })
    expect(sets).toEqual(['IDligne_expedition_TRM = 27000', "lot = 'trm12400'"])
  })
  it('never touches IDmagasin — the magasin is moved by Transferts only', () => {
    for (const o of [
      { expId: 1, leId: 2, toEtm: true, etmLineId: 3 },
      { expId: 1, leId: 2, toEtm: false, etmLineId: 0 },
    ]) {
      for (const s of handoverSets(o)) expect(s).not.toMatch(/IDmagasin/i)
    }
  })
})

describe('releaseSets', () => {
  it('undoes every column the handover wrote, magasin excepted', () => {
    const sets = releaseSets()
    expect(sets).toContain('IDref_commande_source = 0')
    expect(sets).toContain('IDsociete = 2')
    expect(sets).toContain("lot = ''")
    for (const s of sets) expect(s).not.toMatch(/IDmagasin/i)
  })
})
