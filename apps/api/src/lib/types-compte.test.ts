import { describe, it, expect } from 'vitest'
import { enrolementsPossibles, refusAppsDuType } from './types-compte.js'

describe('enrolementsPossibles', () => {
  it('a poste enrols PCs only — never a phone carrying its screens', () => {
    expect(enrolementsPossibles('poste', ['trm'])).toEqual(['pc'])
  })

  it('an appareils account enrols phones and pointeuses, without any app', () => {
    expect(enrolementsPossibles('appareils', [])).toEqual(['atelier', 'pointeuse'])
  })

  it('a person enrols a phone only as a TRM member (régleur phones, until moved)', () => {
    expect(enrolementsPossibles('personne', ['trm'])).toEqual(['atelier', 'pointeuse'])
    expect(enrolementsPossibles('personne', ['etm'])).toEqual([])
  })
})

describe('refusAppsDuType', () => {
  it('a person or a poste keeps at least one app', () => {
    expect(refusAppsDuType('personne', [])).toMatch(/désactivez/)
    expect(refusAppsDuType('poste', [])).toMatch(/désactivez/)
    expect(refusAppsDuType('poste', ['trm'])).toBeNull()
  })

  it('an appareils account holds none', () => {
    expect(refusAppsDuType('appareils', [])).toBeNull()
    expect(refusAppsDuType('appareils', ['etm'])).toMatch(/aucune application/)
  })
})
