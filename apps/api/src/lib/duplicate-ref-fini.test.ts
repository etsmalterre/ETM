import { describe, it, expect } from 'vitest'
import { cloneRefFiniRow, refFiniColumnName } from './duplicate-ref-fini.js'

// LIVA #1186 — the clone is a positional INSERT on Linux, so the literals must
// come out in the source row's own key order with every override in its slot.
// Key shapes: Windows returns accented names verbatim; Linux truncates them at
// the accent and appends a garbage byte (lib/accented-keys.ts, #1177).
const NUL = String.fromCharCode(0)

function row(accent: (base: string, rest: string) => string): Record<string, unknown> {
  const r: Record<string, unknown> = {}
  r.IDref_ecru = 92n
  r.IDref_fini = 1893n
  r.reference = '061D'
  r.designation = 'Côte 2/1 coton bio élasthanne'
  r.rendement = 2.429149866104126
  r[accent('dateCr', 'éation')] = '20260324'
  r.dateModification = '2026-03-24 14:43:34.804'
  r.IDcolori_ecru = 208n
  r.avec_teinture = 1
  r[accent('archiv', 'é')] = 1
  r[accent('catalogue_priv', 'é')] = 1
  r.associee = '0'
  r.observation_technique = null
  r.temp_lavage = 30
  return r
}
const windows = row((b, rest) => b + rest)
const linux = row((b) => b + NUL)
const O = { newId: 1900, reference: '061D (copie)', today: '20260923', now: '20260923101500' }

describe('cloneRefFiniRow (#1186)', () => {
  for (const [name, src] of [['Windows', windows], ['Linux', linux]] as const) {
    it(`keeps the row's key order and applies every override — ${name}`, () => {
      const { literals } = cloneRefFiniRow(src, O)
      expect(literals).toEqual([
        '92',                   // IDref_ecru — copied
        '1900',                 // IDref_fini — new PK
        "'061D (copie)'",       // reference
        "x'43f4746520322f3120636f746f6e2062696f20e96c61737468616e6e65'", // designation, Latin-1 hex
        '2.429149866104126',    // REAL copied as-is
        "'20260923'",           // dateCréation → today
        "'20260923101500'",     // dateModification → now
        '208',                  // IDcolori_ecru — the reason for a whole-row copy
        '1',                    // avec_teinture — idem
        '0',                    // archivé → a copy is never archived
        '1',                    // catalogue_privé — copied
        "'0'",                  // associee is text
        "''",                   // null text
        '30',
      ])
    })
  }

  it('names the accented columns correctly for the Windows named INSERT', () => {
    expect(cloneRefFiniRow(linux, O).columns).toContain('catalogue_privé')
    expect(refFiniColumnName('dateCr' + NUL)).toBe('dateCréation')
    expect(refFiniColumnName('archiv?')).toBe('archivé')
    expect(refFiniColumnName('temp_lavage')).toBe('temp_lavage')
  })

  it('refuses when a column it must override is missing', () => {
    const { reference: _drop, ...noRef } = windows
    expect(() => cloneRefFiniRow(noRef, O)).toThrow(/reference/)
  })

  it('refuses text in a numeric slot rather than writing 0', () => {
    expect(() => cloneRefFiniRow({ ...windows, temp_lavage: 'abc' }, O)).toThrow(/temp_lavage/)
  })
})
