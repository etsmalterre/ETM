import { describe, expect, it } from 'vitest'
import { mailRelanceClient, type LotARelancer } from './soumission-lot.js'

const lot = (p: Partial<LotARelancer> = {}): LotARelancer => ({
  lot: 'MA110123', nature: 'coloris', soumisLe: '2026-11-16', relances: [], recu: false,
  reference: '119B', coloris: 'Noir', designation: 'JERSEY BIO 160', refCommandeClient: 'PO-4521', ...p,
})

describe('the relance mail to the client (Vincent 2026-11-27)', () => {
  it('names the lot, the client’s own reference, the day it was submitted and what waits', () => {
    const m = mailRelanceClient(lot())
    expect(m.subject).toBe('Relance - Soumission coloris MA110123 - 119B - Noir · PO-4521')
    expect(m.body).toContain('Nous vous avons soumis le coloris du lot MA110123 pour la référence JERSEY BIO 160 (coloris Noir) le 16/11/2026 et n’avons pas encore reçu votre réponse.')
    expect(m.body).toContain('Réf commande client : PO-4521')
    expect(m.body).toContain('Le lot attend votre accord chez notre ennoblisseur pour être terminé : la livraison de votre commande dépend de votre réponse.')
  })
  it('a second relance says so', () => {
    expect(mailRelanceClient(lot({ relances: ['2026-11-24'] })).body)
      .toContain('le 16/11/2026 et, malgré notre relance du 24/11/2026, nous n’avons pas encore reçu votre réponse.')
  })
  it('the stabilités of received rolls: they wait to be shipped; without a designation, Malterre’s reference', () => {
    const m = mailRelanceClient(lot({ nature: 'stabilites', recu: true, designation: '', refCommandeClient: '' }))
    expect(m.subject).toBe('Relance - Soumission lot MA110123 - 119B - Noir')
    expect(m.body).toContain('Nous vous avons soumis les stabilités du lot MA110123 pour la référence 119B (coloris Noir) le 16/11/2026')
    expect(m.body).toContain('Le lot attend votre accord pour être expédié')
    expect(m.body).not.toContain('Réf commande client')
  })
})
