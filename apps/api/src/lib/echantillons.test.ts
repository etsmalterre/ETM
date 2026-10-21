import { describe, expect, it } from 'vitest'
import {
  compositionComplete,
  fractionVersPourcent,
  lfaTexte,
  numeroEchantillon,
  ordinalValide,
  pourcentVersFraction,
  refusCreationReference,
  statutEchantillon,
} from './echantillons.js'

describe('statutEchantillon', () => {
  it('en cours, archivé, devenu référence', () => {
    expect(statutEchantillon({ archive: 0, idref_ecru: 0 })).toBe('en_cours')
    expect(statutEchantillon({ archive: 1, idref_ecru: 0 })).toBe('archive')
    expect(statutEchantillon({ archive: null, idref_ecru: null })).toBe('en_cours')
  })
  it('a passage wins over the archive flag it also sets', () => {
    expect(statutEchantillon({ archive: 1, idref_ecru: 426 })).toBe('reference')
    expect(statutEchantillon({ archive: 0, idref_ecru: 426 })).toBe('reference')
  })
})

describe('numeroEchantillon', () => {
  it('pads to three digits behind an E', () => {
    expect(numeroEchantillon(55)).toBe('E055')
    expect(numeroEchantillon(7)).toBe('E007')
    expect(numeroEchantillon(1234)).toBe('E1234')
  })
})

describe('fraction ↔ pourcentage', () => {
  it('reads the legacy fractions as percentages', () => {
    expect(fractionVersPourcent(0.94)).toBe(94)
    expect(fractionVersPourcent(0.06)).toBe(6)
    expect(fractionVersPourcent(1)).toBe(100)
    expect(fractionVersPourcent(null)).toBe(0)
  })
  it('round-trips', () => {
    for (const p of [94, 6, 100, 33.333, 2.5]) expect(fractionVersPourcent(pourcentVersFraction(p))).toBe(p)
  })
})

describe('compositionComplete', () => {
  it('empty is allowed, otherwise exactly 100 %', () => {
    expect(compositionComplete([])).toBe(true)
    expect(compositionComplete([94, 6])).toBe(true)
    expect(compositionComplete([94])).toBe(false)
    expect(compositionComplete([0])).toBe(false)
    expect(compositionComplete([33.333, 33.333, 33.334])).toBe(true)
  })
})

describe('lfaTexte', () => {
  it('writes the legacy « 7.50 » shape, empty for 0', () => {
    expect(lfaTexte(7.5)).toBe('7.50')
    expect(lfaTexte(10.65)).toBe('10.65')
    expect(lfaTexte(0)).toBe('')
    expect(lfaTexte(null)).toBe('')
  })
})

describe('ordinalValide', () => {
  it('drops the legacy 65535 / -1 sentinels', () => {
    expect(ordinalValide(4, 5)).toBe(4)
    expect(ordinalValide(65535, 5)).toBe(0)
    expect(ordinalValide(-1, 5)).toBe(0)
    expect(ordinalValide(null, 3)).toBe(0)
  })
})

describe('refusCreationReference', () => {
  it('only an open sample with an empty or complete composition', () => {
    expect(refusCreationReference({ archive: 0, idref_ecru: 0 }, [94, 6])).toBeNull()
    expect(refusCreationReference({ archive: 0, idref_ecru: 0 }, [])).toBeNull()
    expect(refusCreationReference({ archive: 0, idref_ecru: 0 }, [95])).toBe('composition_incomplete')
    expect(refusCreationReference({ archive: 1, idref_ecru: 0 }, [100])).toBe('archive')
    expect(refusCreationReference({ archive: 1, idref_ecru: 461 }, [100])).toBe('deja_reference')
  })
})
