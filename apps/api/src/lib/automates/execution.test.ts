import { describe, expect, it, vi } from 'vitest'

vi.mock('./catalog.js', () => ({ AUTOMATES: [] }))
const { aGarder } = await import('./execution.js')

describe('aGarder — which runs an hourly automate keeps', () => {
  it('always keeps a person’s launch and the leaving-actif run', () => {
    expect(aGarder({ source: 'manuel', statut: 'inchange' }, undefined)).toBe(true)
    expect(aGarder({ source: 'arret', statut: 'inchange' }, undefined)).toBe(true)
  })

  it('keeps every write and every error of the tick', () => {
    expect(aGarder({ source: 'planifie', statut: 'applique' }, undefined)).toBe(true)
    expect(aGarder({ source: 'planifie', statut: 'erreur' }, undefined)).toBe(true)
  })

  it('drops an hourly « nothing to change »', () => {
    expect(aGarder({ source: 'planifie', statut: 'inchange' }, undefined)).toBe(false)
  })

  it('keeps every run of a daily automate, « nothing sent » included', () => {
    expect(aGarder({ source: 'planifie', statut: 'inchange' }, undefined, true)).toBe(true)
    expect(aGarder({ source: 'planifie', statut: 'simule', empreinte: 'a' }, { empreinte: 'a' }, true)).toBe(true)
  })

  it('keeps an hourly essai proposal once, until it changes', () => {
    expect(aGarder({ source: 'planifie', statut: 'simule', empreinte: 'a' }, undefined)).toBe(true)
    expect(aGarder({ source: 'planifie', statut: 'simule', empreinte: 'a' }, { empreinte: 'a' })).toBe(false)
    expect(aGarder({ source: 'planifie', statut: 'simule', empreinte: 'b' }, { empreinte: 'a' })).toBe(true)
  })
})
