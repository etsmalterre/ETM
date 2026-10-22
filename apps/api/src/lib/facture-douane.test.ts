import { describe, it, expect } from 'vitest'
import { blocsDouane, codeHs, finitionDe, formatCodeHs, groupeMatiere, totalDouane } from './facture-douane.js'

const coton = [{ matiere: 'coton', pourcentage: 100 }]

describe('finitionDe', () => {
  it('écru line and washed fini are « écrue »', () => {
    expect(finitionDe({ kind: 'ecru', avecTeinture: 1, coloris: 'Rouge' })).toBe('ecrue')
    expect(finitionDe({ kind: 'fini', avecTeinture: 0, coloris: 'ecru/ecru' })).toBe('ecrue')
  })
  it('a dyed coloris named « Blanc » is « blanchie » (HS: dyed white = bleached)', () => {
    expect(finitionDe({ kind: 'fini', avecTeinture: 1, coloris: '011 Blanc 61601/1' })).toBe('blanchie')
    expect(finitionDe({ kind: 'fini', avecTeinture: 2, coloris: 'BLANC OPTIQUE' })).toBe('blanchie')
  })
  it('any other dyed coloris is « teinte »', () => {
    expect(finitionDe({ kind: 'fini', avecTeinture: 1, coloris: '1703 DTM IVORY BOSELLI SILK 62190/1' })).toBe('teinte')
  })
})

describe('codeHs', () => {
  it('cotton: 21 unbleached/bleached, 22 dyed (facture 9300)', () => {
    expect(codeHs(coton, 'ecrue')).toBe('60062100')
    expect(codeHs(coton, 'blanchie')).toBe('60062100')
    expect(codeHs(coton, 'teinte')).toBe('60062200')
  })
  it('cotton variants count as cotton', () => {
    expect(codeHs([{ matiere: 'coton bio', pourcentage: 60 }, { matiere: 'coton recycl�', pourcentage: 40 }], 'teinte')).toBe('60062200')
  })
  it('5 % elastane or more → heading 6004', () => {
    expect(codeHs([{ matiere: 'coton', pourcentage: 95 }, { matiere: 'elasthanne', pourcentage: 5 }], 'teinte')).toBe('60041000')
    expect(codeHs([{ matiere: 'coton', pourcentage: 96 }, { matiere: 'elasthanne', pourcentage: 4 }], 'teinte')).toBe('60062200')
  })
  it('synthetic and artificial add up against cotton (chapters 54/55 together)', () => {
    // 45 coton vs 30 polyester + 25 viscose = 55 man-made → synthetic wins inside.
    expect(codeHs([{ matiere: 'coton', pourcentage: 45 }, { matiere: 'polyester', pourcentage: 30 }, { matiere: 'Viscose', pourcentage: 25 }], 'ecrue')).toBe('60063100')
    expect(codeHs([{ matiere: 'Viscose', pourcentage: 70 }, { matiere: 'polyamide', pourcentage: 30 }], 'teinte')).toBe('60064200')
  })
  it('a tie goes to the later heading', () => {
    expect(codeHs([{ matiere: 'coton', pourcentage: 50 }, { matiere: 'polyester', pourcentage: 50 }], 'teinte')).toBe('60063200')
    expect(codeHs([{ matiere: 'polyester', pourcentage: 50 }, { matiere: 'tencel', pourcentage: 50 }], 'teinte')).toBe('60064200')
  })
  it('wool and other fibres', () => {
    expect(codeHs([{ matiere: 'merinos', pourcentage: 100 }], 'teinte')).toBe('60061000')
    expect(codeHs([{ matiere: 'lin', pourcentage: 60 }, { matiere: 'coton', pourcentage: 40 }], 'ecrue')).toBe('60069000')
  })
  it('no composition or an unknown matière → no code', () => {
    expect(codeHs([], 'teinte')).toBeNull()
    expect(codeHs([{ matiere: 'soie', pourcentage: 100 }], 'teinte')).toBeNull()
    expect(groupeMatiere('soie')).toBeNull()
  })
})

describe('blocsDouane — facture 9300 (AGAPE, 2026-10-20)', () => {
  const pieces = [
    { avis: 12468, poids: 21.5, hs: '60062200' },
    { avis: 12468, poids: 21.4, hs: '60062200' },
    { avis: 12469, poids: 21.4, hs: '60062200' },
    { avis: 12470, poids: 20.2, hs: '60062100' },
    { avis: 12471, poids: 21.5, hs: '60062200' },
  ]
  it('gross = avis weight, net = gross − 1 kg per piece (the 900 g of avis 12471 is gone)', () => {
    const b = blocsDouane(pieces)
    expect(b.map((x) => x.avis)).toEqual([12468, 12469, 12470, 12471])
    expect(b[0].lignes).toEqual([{ hs: '60062200', pieces: 2, brut: 42.9, net: 40.9 }])
    expect(b[2].lignes).toEqual([{ hs: '60062100', pieces: 1, brut: 20.2, net: 19.2 }])
    expect(b[3].lignes).toEqual([{ hs: '60062200', pieces: 1, brut: 21.5, net: 20.5 }])
    expect(totalDouane(b)).toEqual({ pieces: 5, brut: 106, net: 101 })
  })
  it('one row per HS code inside a mixed avis', () => {
    const b = blocsDouane([{ avis: 1, poids: 10, hs: '60062200' }, { avis: 1, poids: 12, hs: '60062100' }])
    expect(b[0].lignes.map((l) => l.hs)).toEqual(['60062100', '60062200'])
  })
})

it('formatCodeHs', () => {
  expect(formatCodeHs('60062200')).toBe('6006 22 00')
})
