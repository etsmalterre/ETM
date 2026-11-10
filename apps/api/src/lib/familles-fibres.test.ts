import { describe, it, expect } from 'vitest'
import { signatureFamilles, libelleSignature, type PartMatiere } from './familles-fibres.js'
import { teintureParDefaut } from './coloris-reprise.js'

const p = (matiere: string, famille: PartMatiere['famille'], part: number): PartMatiere => ({ matiere, famille, part })

describe('signatureFamilles (LIVA #1359)', () => {
  it('cotton combed and open-end are the same family', () => {
    const a = signatureFamilles([p('coton', 'vegetale', 1)])
    const b = signatureFamilles([p('coton bio', 'vegetale', 0.5), p('lin', 'vegetale', 0.5)])
    expect(a).toMatchObject({ connue: true, cle: 'vegetale' })
    expect(b).toMatchObject({ connue: true, cle: 'vegetale' })
  })

  it('élasthanne never counts, whatever its share', () => {
    expect(signatureFamilles([p('coton', 'vegetale', 0.8), p('elasthanne', 'elasthanne', 0.2)]))
      .toMatchObject({ connue: true, cle: 'vegetale' })
  })

  it('a fibre under 10 % does not count, 10 % does', () => {
    expect(signatureFamilles([p('coton', 'vegetale', 0.95), p('polyester', 'polyester', 0.05)]))
      .toMatchObject({ cle: 'vegetale' })
    expect(signatureFamilles([p('coton', 'vegetale', 0.9), p('polyester', 'polyester', 0.1)]))
      .toMatchObject({ cle: 'vegetale+polyester' })
  })

  it('shares are relative to the whole écru, not to 1', () => {
    // Yarn shares × matière fractions arrive as raw products (here sum = 40).
    expect(signatureFamilles([p('coton', 'vegetale', 36), p('cuivre', 'metallique', 4)]))
      .toMatchObject({ cle: 'vegetale+metallique' })
  })

  it('cotton and viscose differ', () => {
    const coton = signatureFamilles([p('coton', 'vegetale', 1)])
    const viscose = signatureFamilles([p('Viscose', 'artificielle', 1)])
    expect(coton.connue && viscose.connue && coton.cle !== viscose.cle).toBe(true)
  })

  it('an unclassified matière that counts makes the signature unknown', () => {
    expect(signatureFamilles([p('coton', 'vegetale', 0.7), p('nickel', null, 0.3)]))
      .toEqual({ connue: false, raison: 'matiere_non_classee', matieres: ['nickel'] })
    // …but not when it is a trace.
    expect(signatureFamilles([p('coton', 'vegetale', 0.97), p('nickel', null, 0.03)]))
      .toMatchObject({ connue: true, cle: 'vegetale' })
  })

  it('no composition = unknown', () => {
    expect(signatureFamilles([])).toMatchObject({ connue: false, raison: 'sans_composition' })
    expect(signatureFamilles([p('elasthanne', 'elasthanne', 1)])).toMatchObject({ connue: false, raison: 'sans_composition' })
  })

  it('labels follow the fixed family order', () => {
    const s = signatureFamilles([p('polyester', 'polyester', 0.4), p('coton', 'vegetale', 0.6)])
    expect(libelleSignature(s)).toBe('Fibres végétales + Polyester')
  })
})

describe('teintureParDefaut', () => {
  it('follows the target reference, like an accepted étude', () => {
    expect(teintureParDefaut(1)).toBe(7)
    expect(teintureParDefaut(2)).toBe(5)
    expect(teintureParDefaut(0)).toBe(0)
  })
})
