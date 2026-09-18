import { describe, it, expect } from 'vitest'
import { pick } from './clients-common.js'

// LIVA #1177 — Clients › Gestion listed the 17 ARCHIVED « LF043 - <coloris> »
// designations of Simone Perele next to the standard LF043 (39 coloris). The
// `archivé` flag of designation_client was read with an exact fallback list
// (`pick(r, 'archivé', 'archiv')`): the Linux bridge returns the key
// truncated at the accent PLUS a garbage byte (`archiv?`), so nothing matched
// and every row read as active. Same footgun as #1090 (lib/accented-keys.ts).
const NUL = String.fromCharCode(0)

describe('pick — accent-mangled SELECT * keys (#1177)', () => {
  it('reads the verbatim key on Windows', () => {
    expect(pick({ archivé: 1, designation: 'x' }, 'archivé', 'archiv')).toBe(1)
  })

  it('reads the truncated key with a garbage trailing byte on Linux', () => {
    for (const mangled of ['archiv' + NUL, 'archiv?', 'archivt', 'archivi', 'ARCHIVÉ']) {
      const row: Record<string, unknown> = { IDclient: 22, designation: 'LF043 - 011 BLANC' }
      row[mangled] = 1
      expect(pick(row, 'archivé', 'archiv'), mangled).toBe(1)
    }
  })

  it('reads the exact bare stem too', () => {
    expect(pick({ archiv: 1 }, 'archivé', 'archiv')).toBe(1)
  })

  it('prefers an exact key over a prefix match', () => {
    const row: Record<string, unknown> = { cach: 0 }
    row['cach' + NUL] = 1
    expect(pick(row, 'caché', 'cach')).toBe(0)
  })

  it('returns undefined when no key starts with any candidate', () => {
    expect(pick({ IDclient: 1, associee: '' }, 'archivé', 'archiv')).toBeUndefined()
  })

  it('does not let a null value shadow a usable one', () => {
    expect(pick({ archivé: null, 'archiv?': 1 }, 'archivé', 'archiv')).toBe(1)
  })

  it('keeps the other accented designation_client flags readable', () => {
    const row = { 'cach?': 1, 'fil_non_factur?': '12,15' }
    expect(pick(row, 'caché', 'cach')).toBe(1)
    expect(pick(row, 'fil_non_facturé', 'fil_non_factur')).toBe('12,15')
  })
})
