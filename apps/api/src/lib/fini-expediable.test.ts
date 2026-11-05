import { describe, expect, it } from 'vitest'
import { FINI_EXPEDIABLE_SQL, finiNonValideRefus, isFiniExpediable } from './fini-expediable.js'

describe('isFiniExpediable (#1235)', () => {
  it('only « Validé » ships', () => {
    expect(isFiniExpediable(3, false)).toBe(true)
    expect(isFiniExpediable('3', false)).toBe(true)
    for (const etat of [1, 2, 4, 5, 0, null, undefined]) expect(isFiniExpediable(etat, false)).toBe(false)
  })

  it('names the refused rolls', () => {
    expect(finiNonValideRefus(['3528/12']).message).toContain("3528/12 ne l'est pas")
    expect(finiNonValideRefus(['3528/12', '3528/11']).message).toContain('3528/12, 3528/11 ne le sont pas')
    expect(finiNonValideRefus(['x']).error).toBe('rouleau_non_valide')
  })
})

describe('« Expédier dès la réception » (#1351)', () => {
  it('lets an « En Contrôle » roll ship, never a reprise or a pending decision', () => {
    expect(isFiniExpediable(1, true)).toBe(true)
    expect(isFiniExpediable(3, true)).toBe(true)
    for (const etat of [2, 4, 5, 0, null]) expect(isFiniExpediable(etat, true)).toBe(false)
  })

  it('the SQL guard says the same', () => {
    expect(FINI_EXPEDIABLE_SQL).toContain('IDetat_stock_fini = 3')
    expect(FINI_EXPEDIABLE_SQL).toContain('IDetat_stock_fini = 1')
    expect(FINI_EXPEDIABLE_SQL).toContain('expedier_des_reception = 1')
  })
})
