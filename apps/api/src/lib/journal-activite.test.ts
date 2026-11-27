import { describe, expect, it } from 'vitest'
import { diffLignes, messageErreur, resumerCorps } from './journal-activite.js'

describe('diffLignes', () => {
  it('keeps only the columns that moved, dates as YYYY-MM-DD', () => {
    const avant = { idligne: 9076, date_livraison: null, date_delai: null, sstatut: 'Attente_Delai', quantite: 1055.03, prix: 9.13 }
    const apres = { idligne: 9076, date_livraison: new Date('2026-11-10T00:00:00Z'), date_delai: new Date('2026-11-10T00:00:00Z'), sstatut: 'En_Cours', quantite: 1055.03, prix: 9.13 }
    expect(diffLignes(avant, apres)).toEqual({
      date_livraison: [null, '2026-11-10'],
      date_delai: [null, '2026-11-10'],
      sstatut: ['Attente_Delai', 'En_Cours'],
    })
  })

  it('{} when the save changed nothing — not null, which means « not known »', () => {
    expect(diffLignes({ a: 1, d: new Date('2026-10-13T00:00:00Z') }, { a: 1, d: new Date('2026-10-13T00:00:00Z') })).toEqual({})
  })
})

describe('journal', () => {
  it('masks secrets, shortens files and long texts', () => {
    const s = resumerCorps({ password: 'x', prix: 5.2, pdf: 'A'.repeat(4000), note: 'n'.repeat(300) })!
    const o = JSON.parse(s)
    expect(o.password).toBe('[masqué]')
    expect(o.prix).toBe(5.2)
    expect(o.pdf).toMatch(/^\[fichier \d+ Ko\]$/)
    expect(o.note).toContain('[300 car.]')
    expect(resumerCorps({})).toBeNull()
  })
  it('reads the error message of an answer', () => {
    expect(messageErreur({ error: 'contrat_expire', message: 'Contrat expiré' })).toBe('Contrat expiré')
    expect(messageErreur(null)).toBeNull()
  })
})
