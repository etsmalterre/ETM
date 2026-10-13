import { describe, it, expect } from 'vitest'
import { badgeSummary, formatEuro, formatNombre, nomExpediteur, verdictLigne } from './format'
import type { Conversation, Message } from './types'

const message = (over: Partial<Message> = {}): Message => ({
  id: 'a', threadId: 'a', de: '', sujet: '', date: '2026-10-13T11:21:26.000Z', triage: null, bl: [], factures: [], ...over,
})
const conv = (messages: Message[]): Conversation => ({
  boite: 'contact@etsmalterre.com', suivie: true, messages,
  categories: [{ cle: 'bl_ennoblisseur', libelle: 'BL ennoblisseur', description: '', agent: 'bl-ennoblisseur' }],
  droits: { corrigerTriage: false, piloter: false, factures: false },
})

describe('badgeSummary', () => {
  it('is null when Tricobot never saw the conversation', () => {
    expect(badgeSummary(conv([]))).toBeNull()
  })

  it('names the category and the BL of the last message', () => {
    const triage = { categories: ['bl_ennoblisseur'], statut: 'trie' } as Message['triage']
    const bl = { bordereau: '109484A', statut: 'ecrit' } as Message['bl'][number]
    expect(badgeSummary(conv([message({ triage, bl: [bl] })]))).toEqual({ text: 'BL ennoblisseur · BL 109484A', attention: false })
  })

  it('asks for attention while a BL or an open invoice waits for a person', () => {
    const bl = { bordereau: null, statut: 'a_verifier' } as Message['bl'][number]
    expect(badgeSummary(conv([message({ bl: [bl] })]))?.attention).toBe(true)
    const close = { numero: 'FA1', statut: 'a_verifier', traitement: 'validee' } as Message['factures'][number]
    expect(badgeSummary(conv([message({ factures: [close] })]))).toEqual({ text: 'facture FA1', attention: false })
  })
})

describe('formatting', () => {
  it('formats French numbers with plain spaces', () => {
    expect(formatEuro(3276.48)).toBe('3 276,48 €')
    expect(formatNombre(19.8, 'kg')).toBe('19,8 kg')
  })

  it('keeps the display name of a sender', () => {
    expect(nomExpediteur('"Céline FERNANDES" <mct.celine@mateltextiles.fr>')).toBe('Céline FERNANDES')
    expect(nomExpediteur('<contact@bontemps.fr>')).toBe('contact@bontemps.fr')
  })

  it('names an invoice line verdict like the Factures screen', () => {
    expect(verdictLigne({ verdict: 'ecart', nature: 'non_verifie' }).label).toBe('Non vérifié')
    expect(verdictLigne({ verdict: 'ecart', nature: 'reel' }).tone).toBe('bad')
  })
})
