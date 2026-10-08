import { describe, expect, it } from 'vitest'
import { filterRowsByTags, foldSearchText, matchTags, type SearchTagDef } from './SmartSearchInput'

// Shaped like the Clients › Commandes tags: urgence + « at least one line has the status ».
interface Row { id: number; urgence: 'rouge' | 'ambre' | null; etats: string[] }

const rows: Row[] = [
  { id: 1, urgence: 'rouge', etats: ['a_lancer', 'pae'] },
  { id: 2, urgence: 'ambre', etats: ['expediee'] },
  { id: 3, urgence: null, etats: ['pae', 'expediee'] },
  { id: 4, urgence: 'rouge', etats: ['expediee'] },
]

function tag(key: string, label: string, predicate: (r: Row) => boolean): SearchTagDef<Row> {
  return { key, label, renderPill: () => null, count: rows.filter(predicate).length, predicate }
}

const tags = [
  tag('urgence:rouge', 'À faire', (r) => r.urgence === 'rouge'),
  tag('urgence:ambre', 'Bientôt', (r) => r.urgence === 'ambre'),
  tag('etat:a_lancer', 'À lancer', (r) => r.etats.includes('a_lancer')),
  tag('etat:ennoblisseur', 'Chez l’ennoblisseur', (r) => r.etats.includes('ennoblisseur')),
  tag('etat:pae', 'Prête à expédier', (r) => r.etats.includes('pae')),
  tag('etat:expediee', 'Expédiée', (r) => r.etats.includes('expediee')),
]

const ids = (rs: Row[]) => rs.map((r) => r.id)

describe('matchTags', () => {
  it('lists every tag on an empty term', () => {
    expect(matchTags(tags, '  ')).toHaveLength(tags.length)
  })
  it('ignores accents and case: « exp » finds « Prête à expédier » and « Expédiée »', () => {
    expect(matchTags(tags, 'exp').map((t) => t.key)).toEqual(['etat:pae', 'etat:expediee'])
    expect(matchTags(tags, 'EXPÉ').map((t) => t.key)).toEqual(['etat:pae', 'etat:expediee'])
  })
  it('matches inside the label', () => {
    expect(matchTags(tags, 'lancer').map((t) => t.key)).toEqual(['etat:a_lancer'])
    expect(matchTags(tags, 'a faire').map((t) => t.key)).toEqual(['urgence:rouge'])
  })
  it('folds accents', () => {
    expect(foldSearchText('Chez l’Ennoblisseur Prête')).toBe('chez l’ennoblisseur prete')
  })
})

describe('filterRowsByTags', () => {
  it('no active tag keeps every row', () => {
    expect(filterRowsByTags(rows, [], tags)).toBe(rows)
  })
  it('one tag keeps the rows carrying it (any line)', () => {
    expect(ids(filterRowsByTags(rows, ['etat:pae'], tags))).toEqual([1, 3])
  })
  it('tags combine with AND', () => {
    expect(ids(filterRowsByTags(rows, ['urgence:rouge', 'etat:expediee'], tags))).toEqual([4])
    expect(ids(filterRowsByTags(rows, ['urgence:rouge', 'urgence:ambre'], tags))).toEqual([])
  })
  it('an unknown key filters nothing', () => {
    expect(ids(filterRowsByTags(rows, ['nope'], tags))).toEqual([1, 2, 3, 4])
  })
})
