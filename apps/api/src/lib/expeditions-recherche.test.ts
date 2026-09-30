import { describe, it, expect } from 'vitest'
import { likeContient, normRecherche } from './expeditions-recherche.js'

describe('expeditions-recherche', () => {
  it('takes the user\'s LIKE wildcards literally', () => {
    expect(likeContient('1177')).toBe('%1177%')
    expect(likeContient('50%')).toBe('%50\\%%')
    expect(likeContient('a_b\\c')).toBe('%a\\_b\\\\c%')
  })

  it('matches names without case or accents', () => {
    expect(normRecherche('  Société Générale ')).toBe('societe generale')
    expect(normRecherche('SOCIÉTÉ')).toBe(normRecherche('societe'))
  })
})
