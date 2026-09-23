import { describe, it, expect } from 'vitest'
import { sstLineKind, trmLineKind, isRectiligneType, partitionByKind, LINE_TYPE_RECTILIGNE } from './sst-line-kind.js'

describe('sst line kind (ligne_commande_sous_traitant.TYPE)', () => {
  it('routes each legacy type to its catalog', () => {
    expect(sstLineKind(0)).toBe('ecru')
    expect(sstLineKind(1)).toBe('ecru')
    expect(sstLineKind(2)).toBe('fini')
    expect(sstLineKind(4)).toBe('rectiligne')
  })
  it('reads driver shapes (string, null) without surprises', () => {
    expect(sstLineKind('4')).toBe('rectiligne')
    expect(sstLineKind(null)).toBe('ecru')
  })
})

describe('TRM line kind (ligne_commande_client.TYPE, IDsociete 2)', () => {
  it('type 4 is rectiligne — never « confection » read against ref_ecru', () => {
    expect(trmLineKind(4)).toBe('rectiligne')
    expect(trmLineKind(1)).toBe('ecru')
    expect(isRectiligneType(LINE_TYPE_RECTILIGNE)).toBe(true)
  })
})

describe('partitionByKind', () => {
  it('keeps rectiligne ids away from the écru/fini resolvers', () => {
    const lines = [{ id: 1, t: 1 }, { id: 2, t: 4 }, { id: 3, t: 2 }]
    const p = partitionByKind(lines, (l) => l.t)
    expect(p.rectiligne.map((l) => l.id)).toEqual([2])
    expect(p.other.map((l) => l.id)).toEqual([1, 3])
  })
})
