import { describe, it, expect } from 'vitest'
import { readCol } from './accented-keys.js'

describe('readCol: one accented column, three backends', () => {
  it('reads the verbatim name (Windows driver)', () => {
    expect(readCol({ 'terminé': 1 }, 'terminé')).toBe(1)
    expect(readCol({ DATE: '20260928' }, 'date')).toBe('20260928')
  })

  it('reads the unaccented lowercase name (PostgreSQL)', () => {
    expect(readCol({ termine: 1, defaut_qualite: 'stab' }, 'terminé')).toBe(1)
    expect(readCol({ idsocietefnc: 3 }, 'IDSociétéFNC')).toBe(3)
  })

  it('reads the Linux truncation, with or without its garbage (measured on prod 2026-09-28)', () => {
    expect(readCol({ termin: 1 }, 'terminé')).toBe(1)
    expect(readCol({ terminl: 1 }, 'terminé')).toBe(1)
    expect(readCol({ defaut_qualiti: 'stab' }, 'defaut_qualité')).toBe('stab')
  })

  it('refuses an ambiguous or too short prefix', () => {
    // résolution cuts to « r »: never guess among reference / reponseFNC.
    expect(readCol({ rDsuivilot: 'x', reference: 'y' }, 'résolution')).toBeUndefined()
    expect(readCol({ terminl: 1, terminx: 0 }, 'terminé')).toBeUndefined()
  })
})
