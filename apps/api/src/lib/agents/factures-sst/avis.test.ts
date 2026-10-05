import { describe, expect, it } from 'vitest'
import { ActionInvalide, decider, parDefaut } from './avis.js'

describe('a person’s decision on an invoice line', () => {
  it('a conforme line: confirmed is a réussite, a missed gap an échec with a comment', () => {
    expect(decider('conforme', null, 'conforme')).toEqual({ verdictFinal: 'conforme', note: 'reussite', commentaireRequis: false })
    expect(decider('conforme', null, 'ecart')).toEqual({ verdictFinal: 'ecart', note: 'echec', commentaireRequis: true })
    expect(() => decider('conforme', null, 'corriger')).toThrow(ActionInvalide)
  })

  it('a real gap: kept is a réussite; a false alarm or a wrong cause is an échec', () => {
    expect(decider('ecart', 'reel', 'ecart')).toEqual({ verdictFinal: 'ecart', note: 'reussite', commentaireRequis: false })
    expect(decider('ecart', 'reel', 'conforme')).toEqual({ verdictFinal: 'conforme', note: 'echec', commentaireRequis: true })
    expect(decider('ecart', 'reel', 'corriger')).toEqual({ verdictFinal: 'ecart', note: 'echec', commentaireRequis: true })
  })

  it('a gap the agent could not check: kept is a réussite, found fine is no score, a wrong reason an échec', () => {
    expect(decider('ecart', 'non_verifie', 'ecart')).toEqual({ verdictFinal: 'ecart', note: 'reussite', commentaireRequis: false })
    expect(decider('ecart', 'non_verifie', 'conforme')).toEqual({ verdictFinal: 'conforme', note: null, commentaireRequis: true })
    expect(decider('ecart', 'non_verifie', 'corriger')).toEqual({ verdictFinal: 'ecart', note: 'echec', commentaireRequis: true })
  })

  it('on closing, untouched lines follow the agent — an écart it could not check included', () => {
    expect(parDefaut('conforme', null)).toMatchObject({ verdictFinal: 'conforme', note: 'reussite' })
    expect(parDefaut('ecart', 'reel')).toMatchObject({ verdictFinal: 'ecart', note: 'reussite' })
    expect(parDefaut('ecart', 'non_verifie')).toMatchObject({ verdictFinal: 'ecart', note: 'reussite' })
    expect(parDefaut('info', null)).toBe('sans_objet')
    expect(() => decider('info', null, 'ecart')).toThrow(ActionInvalide)
  })
})
