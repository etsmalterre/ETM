import { describe, expect, it } from 'vitest'
import { finiNonValideRefus, isFiniExpediable } from './fini-expediable.js'

describe('isFiniExpediable (#1235)', () => {
  it('only « Validé » ships', () => {
    expect(isFiniExpediable(3)).toBe(true)
    expect(isFiniExpediable('3')).toBe(true)
    for (const etat of [1, 2, 4, 5, 0, null, undefined]) expect(isFiniExpediable(etat)).toBe(false)
  })

  it('names the refused rolls', () => {
    expect(finiNonValideRefus(['3528/12']).message).toContain("3528/12 ne l'est pas")
    expect(finiNonValideRefus(['3528/12', '3528/11']).message).toContain('3528/12, 3528/11 ne le sont pas')
    expect(finiNonValideRefus(['x']).error).toBe('rouleau_non_valide')
  })
})
