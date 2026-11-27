import { describe, expect, it } from 'vitest'
import { mailRelanceEnnoblisseur, type LotControleARelancer } from './relance-controle.js'

function lot(p: Partial<LotControleARelancer> = {}): LotControleARelancer {
  return { lot: 'TA532112', recuLe: '2026-11-17', relances: [], manque: ['laize', 'poids', 'stabilités'], reference: '180B', coloris: 'ecru', commande: 9098, ...p }
}

describe('« Relancer l’ennoblisseur »: the mail as it opens (Vincent 2026-11-27)', () => {
  it('names the lot, its article, our order, the reception and what is missing', () => {
    const m = mailRelanceEnnoblisseur(lot())
    expect(m.subject).toBe('Relance - Contrôles du lot TA532112 - 180B - ecru')
    expect(m.body).toContain('Nous avons reçu le lot TA532112 (180B - ecru, notre commande 9098) le 17/11/2026 et n’avons pas encore vos contrôles : laize, poids et stabilités.')
  })
  it('a second relance says so', () => {
    expect(mailRelanceEnnoblisseur(lot({ relances: ['2026-11-27'] })).body)
      .toContain('le 17/11/2026 et, malgré notre relance du 27/11/2026, nous n’avons pas encore vos contrôles')
  })
  it('degrades without an article, an order or a list of measures', () => {
    const m = mailRelanceEnnoblisseur(lot({ reference: '', coloris: '', commande: 0, manque: [] }))
    expect(m.subject).toBe('Relance - Contrôles du lot TA532112')
    expect(m.body).toContain('Nous avons reçu le lot TA532112 le 17/11/2026 et n’avons pas encore vos contrôles.')
    expect(mailRelanceEnnoblisseur(lot({ manque: ['vrillage'] })).body).toContain('vos contrôles : vrillage.')
  })
})
