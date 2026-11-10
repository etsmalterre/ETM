import { describe, expect, it } from 'vitest'
import { changeDeCatalogue, messageTeintureVerrouillee } from './teinture-ref-fini.js'

describe('changeDeCatalogue (#1365)', () => {
  it('lavage ↔ teinture moves the coloris to another catalog', () => {
    expect(changeDeCatalogue(0, 1)).toBe(true)
    expect(changeDeCatalogue(0, 2)).toBe(true)
    expect(changeDeCatalogue(1, 0)).toBe(true)
    expect(changeDeCatalogue(2, 0)).toBe(true)
  })
  it('simple ↔ double and no change stay in the same catalog', () => {
    expect(changeDeCatalogue(1, 2)).toBe(false)
    expect(changeDeCatalogue(2, 1)).toBe(false)
    expect(changeDeCatalogue(0, 0)).toBe(false)
  })
})

describe('messageTeintureVerrouillee', () => {
  it('names what holds the coloris and the refused direction', () => {
    const m = messageTeintureVerrouillee(0, [{ quoi: 'Rouleaux finis', n: 3 }, { quoi: 'Suivis de lot', n: 1 }])
    expect(m).toContain('Rouleaux finis : 3 ; Suivis de lot : 1')
    expect(m).toContain('passer en une teinture')
    expect(messageTeintureVerrouillee(1, [{ quoi: 'Coloris teints', n: 2 }])).toContain('passer en un lavage')
  })
})
