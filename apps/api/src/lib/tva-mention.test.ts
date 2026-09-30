import { describe, it, expect } from 'vitest'
import { mentionTva, zoneTva, texteMentionClient, MENTION_UE, MENTION_EXPORT } from './tva-mention.js'

describe('zoneTva', () => {
  it('reads the free-typed adresse.pays spellings', () => {
    expect(zoneTva('France')).toBe('france')
    expect(zoneTva('FRANCE ')).toBe('france')
    expect(zoneTva('')).toBe('france')
    expect(zoneTva(null)).toBe('france')
    expect(zoneTva('-1')).toBe('france')
    expect(zoneTva('Monaco')).toBe('france')
    expect(zoneTva('Belgique ')).toBe('ue')
    expect(zoneTva('Pays-Bas ')).toBe('ue')
    expect(zoneTva('Grèce')).toBe('ue')
    expect(zoneTva('Germany')).toBe('ue')
    expect(zoneTva('MAROC')).toBe('hors_ue')
    expect(zoneTva('Suisse ')).toBe('hors_ue')
    expect(zoneTva('Royaume-Uni ')).toBe('hors_ue')
    expect(zoneTva('Guyane francaise')).toBe('hors_ue')
  })
})

describe('mentionTva', () => {
  const franchise = { code: 'franchise_275' as const, texte: '' }

  it('prints nothing on a document that carries VAT', () => {
    expect(mentionTva({ tvaRate: 20, pays: 'Belgique', client: franchise })).toBeNull()
  })

  it('picks the article from the billing country', () => {
    expect(mentionTva({ tvaRate: 0, pays: 'Portugal', client: null })).toBe(MENTION_UE)
    expect(mentionTva({ tvaRate: 0, pays: 'TUNISIE', client: null })).toBe(MENTION_EXPORT)
  })

  it('a foreign country wins over a stored French choice', () => {
    expect(mentionTva({ tvaRate: 0, pays: 'Maroc', client: franchise })).toBe(MENTION_EXPORT)
  })

  it('a French client prints its chosen mention, or nothing', () => {
    expect(mentionTva({ tvaRate: 0, pays: 'France', client: franchise }))
      .toBe('Vente en franchise de TVA, article 275 du CGI')
    expect(mentionTva({ tvaRate: 0, pays: 'France', client: { code: 'autre', texte: '  Texte libre ' } }))
      .toBe('Texte libre')
    expect(mentionTva({ tvaRate: 0, pays: 'France', client: { code: 'autre', texte: ' ' } })).toBeNull()
    expect(mentionTva({ tvaRate: 0, pays: 'France', client: null })).toBeNull()
  })
})

describe('texteMentionClient', () => {
  it('a preset prints its current wording, not the text stored with it', () => {
    expect(texteMentionClient({ code: 'autoliquidation_dechets', texte: 'ancien libellé' }))
      .toBe('Autoliquidation, article 283-2 sexies du CGI')
  })
})
