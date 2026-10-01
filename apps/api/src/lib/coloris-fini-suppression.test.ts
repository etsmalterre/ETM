import { describe, it, expect } from 'vitest'
import { libelleAcceptation, messageUsages } from './coloris-fini-suppression.js'

describe('libelleAcceptation', () => {
  const lab = '0505 violet lilas 14-3710-TCX 63794'

  it('appends the sample on a first acceptance', () => {
    expect(libelleAcceptation(lab, '1', false)).toBe(`${lab}/1`)
  })

  it('replaces the earlier sample on a re-acceptance — never « /1/2 »', () => {
    expect(libelleAcceptation(`${lab}/1`, '2', true)).toBe(`${lab}/2`)
  })

  it('is idempotent on the same sample', () => {
    expect(libelleAcceptation(`${lab}/2`, '2', true)).toBe(`${lab}/2`)
    expect(libelleAcceptation(`${lab}/2`, '2', false)).toBe(`${lab}/2`)
  })

  it('leaves a hand-picked coloris label alone (not an earlier acceptance)', () => {
    expect(libelleAcceptation('Bleu nuit 12/3', '1', false)).toBe('Bleu nuit 12/3/1')
  })
})

describe('messageUsages', () => {
  it('lists each holder with its examples and marks a truncated list', () => {
    const m = messageUsages([
      { quoi: 'Rouleaux finis', n: 7, exemples: ['3510', '3511', '3512', '3513', '3514'] },
      { quoi: 'Études coloris', n: 1, exemples: ['Lilas /2'] },
    ])
    expect(m).toContain('Rouleaux finis : 7 (3510, 3511, 3512, 3513, 3514…)')
    expect(m).toContain('Études coloris : 1 (Lilas /2)')
    expect(m).toContain('ne peut pas être supprimé')
  })

  it('omits the brackets when there is no example', () => {
    expect(messageUsages([{ quoi: 'Gammes de coloris', n: 2, exemples: [] }])).toContain('Gammes de coloris : 2.')
  })
})
