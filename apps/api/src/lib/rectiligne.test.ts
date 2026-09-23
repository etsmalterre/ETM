import { describe, it, expect } from 'vitest'
import {
  nextRectiligneReference,
  duplicateReference,
  pctFromStored,
  pctToStored,
  montagesOf,
  nextMontage,
  montageReadyForColoris,
  formatGuideComposition,
  archiveRewrite,
  normalizeRefRectiligne,
} from './rectiligne.js'

// The 33 prod references on 2026-09-23 (a sample keeps the shape).
const PROD = ['R001', 'R002', 'R002 triple', 'R003-33', 'R003-S', 'R004-40', 'R005', 'R006-38', 'R007', 'R008-40', 'R009-48', 'R010-36', 'R010-38']

describe('nextRectiligneReference', () => {
  it('continues the R### series past the size variants (legacy regex stopped at R007)', () => {
    expect(nextRectiligneReference(PROD)).toBe('R011')
  })
  it('starts at R001 on an empty catalog', () => {
    expect(nextRectiligneReference([])).toBe('R001')
  })
  it('never returns a name already taken, case-insensitively', () => {
    expect(nextRectiligneReference(['R001', 'r002'])).toBe('R003')
    expect(nextRectiligneReference(['R001-40', 'r002'])).toBe('R003')
  })
})

describe('duplicateReference', () => {
  it('suffixes « (copie) », then numbers', () => {
    expect(duplicateReference('R006-38', PROD)).toBe('R006-38 (copie)')
    expect(duplicateReference('R006-38', [...PROD, 'r006-38 (COPIE)'])).toBe('R006-38 (copie 2)')
  })
})

describe('pourcentage — stored 0–1, shown in percent', () => {
  it('round-trips the prod values', () => {
    expect(pctFromStored(0.9950000047683716)).toBe(99.5)
    expect(pctFromStored(0.004999999888241291)).toBe(0.5)
    expect(pctToStored(99.5)).toBe(0.995)
    expect(pctToStored(0.5)).toBe(0.005)
  })
})

describe('montages', () => {
  it('lists distinct montages and appends MAX+1', () => {
    const g = [{ montage: 1 }, { montage: 1 }, { montage: 3 }]
    expect(montagesOf(g)).toEqual([1, 3])
    expect(nextMontage(g)).toBe(4)
    expect(nextMontage([])).toBe(1)
  })
  it('refuses a coloris while a guide has no yarn (legacy rule)', () => {
    expect(montageReadyForColoris([{ IDref_fil: 10 }, { IDref_fil: 157 }])).toBe(true)
    expect(montageReadyForColoris([{ IDref_fil: 10 }, { IDref_fil: 0 }])).toBe(false)
    expect(montageReadyForColoris([])).toBe(false)
  })
})

describe('formatGuideComposition', () => {
  it('prints each guide with its count, yarn, colour and share', () => {
    expect(formatGuideComposition([
      { nb_fil: 3, pct: 99.5, fil: '1/28 COTON PEIGNE BIO Z', colori: 'marine53586' },
      { nb_fil: 1, pct: 0.5, fil: 'Thermofusible', colori: 'Noir' },
    ])).toBe('3 fils 1/28 COTON PEIGNE BIO Z marine53586 99,5 % + 1 fil Thermofusible Noir 0,5 %')
  })
  it('skips a guide without yarn and a missing colour', () => {
    expect(formatGuideComposition([
      { nb_fil: 2, pct: 100, fil: 'LIN', colori: '' },
      { nb_fil: 1, pct: 0, fil: '', colori: '' },
    ])).toBe('2 fils LIN 100 %')
  })
})

describe('archive rewrite (Linux positional INSERT)', () => {
  // Runtime SELECT * key order on the dev server, 2026-09-23 — the Linux
  // bridge truncates archivé, here as its garbage-suffixed form.
  const row = {
    IDref_rectiligne: 17, reference: 'R006-38', archivx: 0, programme: '006', nb_aiguilles: 220,
    prix: 0.8, designation: 'col 38x9 cm BIO', unite: 4, commentaire: "3 fils\r\nl'été", nb_guide_fil: 0,
  }
  it('keeps the row order and flips only the archive slot', () => {
    expect(archiveRewrite(row, 1)).toEqual([
      '17', "'R006-38'", '1', "'006'", '220', '0.8', "'col 38x9 cm BIO'", '4', "x'332066696c730d0a6c27e974e9'", '0',
    ])
  })
  it('refuses when the archive column cannot be found', () => {
    const { archivx: _drop, ...noArchive } = row
    expect(() => archiveRewrite(noArchive, 1)).toThrow(/archiv/)
  })
  it('reads the flag by prefix, whatever the driver made of the name', () => {
    expect(normalizeRefRectiligne({ ...row, archivx: 1 }).archive).toBe(1)
    const { archivx: _drop, ...windowsRow } = row
    expect(normalizeRefRectiligne({ ...windowsRow, archivé: 1 }).archive).toBe(1)
  })
})
