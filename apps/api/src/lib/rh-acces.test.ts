import { describe, expect, it } from 'vitest'
import { personneRh } from './rh-acces.js'

describe('qui est qui pour RH (identité, pas accès)', () => {
  it('keeps the historical keys of Vincent and Isabelle, whatever the case or the PC row', () => {
    expect(personneRh({ prenom: 'Vincent', nom: 'Malterre' })?.cle).toBe('vincent')
    expect(personneRh({ prenom: ' isabelle ', nom: 'MALTERRE' })?.cle).toBe('isabelle')
  })

  it('gives anyone else a u- key that can never take a historical one', () => {
    expect(personneRh({ prenom: 'Laetitia', nom: 'Tellier' })?.cle).toBe('u-laetitia-tellier')
    expect(personneRh({ prenom: 'Isabelle', nom: null })?.cle).toBe('u-isabelle')
    expect(personneRh({ prenom: 'Vincent', nom: 'Roux' })?.cle).toBe('u-vincent-roux')
  })

  it('folds accents and never puts a dot in a key', () => {
    expect(personneRh({ prenom: 'Pierre-Emmanuel', nom: 'Lefèvre' })?.cle).toBe('u-pierre-emmanuel-lefevre')
    expect(personneRh({ prenom: 'J.', nom: 'Dupont' })?.cle).not.toContain('.')
    expect(personneRh({ prenom: '  ', nom: null })).toBeNull()
  })
})
