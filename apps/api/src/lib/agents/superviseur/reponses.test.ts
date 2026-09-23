import { describe, expect, it } from 'vitest'
import type { EnteteMessage } from './boites.js'
import { construireAnnuaire, conversationsSansReponse, heuresOuvrees, identifierClient } from './reponses.js'
import { estNomTransporteur, sansCitation } from './mails.js'

describe('estNomTransporteur', () => {
  const tr = ['DB SCHENKER Internationale Lille', 'KUEHNE+NAGEL', 'UPS', 'DPD']
  it('recognises a carrier registered as a client, not a customer with a similar word', () => {
    expect(estNomTransporteur('SCHENKER', tr)).toBe(true)
    expect(estNomTransporteur('Kuehne Nagel', tr)).toBe(true)
    expect(estNomTransporteur('THUASNE', tr)).toBe(false)
    expect(estNomTransporteur('UPSILON', tr)).toBe(false) // short names never match on a fragment
  })
})

const annuaire = construireAnnuaire(
  [
    { mail: 'achat@thuasne.fr', idClient: 1, nomClient: 'THUASNE' },
    { mail: 'marie@gmail.com', idClient: 2, nomClient: 'Marie Couture' },
    { mail: 'contact@matel.fr', idClient: 3, nomClient: 'MATEL (aussi client)' },
  ],
  ['mct.celine@matel.fr'], // MATEL is a dyer: its domain is never a client
)

let n = 0
const H = 3_600_000
const LUNDI_9H = Date.parse('2026-09-21T07:00:00Z')
const m = (o: Partial<EnteteMessage>): EnteteMessage => ({
  boite: 'contact@etsmalterre.com', id: `m${++n}`, threadId: 't1', messageId: `id${n}@x`, inReplyTo: '', references: [],
  de: 'achat@thuasne.fr', deNom: '', a: ['contact@etsmalterre.com'], cc: [], sujet: 'Commande', date: LUNDI_9H,
  envoye: false, automatique: false, ...o,
})

describe('identifierClient', () => {
  it('matches the exact address, the company domain, never a webmail domain nor a supplier', () => {
    expect(identifierClient('achat@thuasne.fr', annuaire)?.nom).toBe('THUASNE')
    expect(identifierClient('compta@thuasne.fr', annuaire)?.nom).toBe('THUASNE')
    expect(identifierClient('marie@gmail.com', annuaire)?.nom).toBe('Marie Couture')
    expect(identifierClient('paul@gmail.com', annuaire)).toBeNull()
    expect(identifierClient('contact@matel.fr', annuaire)).toBeNull()
  })
})

describe('heuresOuvrees', () => {
  it('skips the weekend', () => {
    const vendredi18h = Date.parse('2026-09-25T16:00:00Z')
    // Fri 16:00Z → Mon 16:00Z: 8 h of Friday + 16 h of Monday, the weekend counts nothing.
    expect(heuresOuvrees(vendredi18h, vendredi18h + 72 * H)).toBe(24)
    expect(heuresOuvrees(LUNDI_9H, LUNDI_9H + 30 * H)).toBe(30)
  })
})

describe('conversationsSansReponse', () => {
  const now = LUNDI_9H + 50 * H
  const depuis = LUNDI_9H - 14 * 24 * H

  it('flags a client message nobody answered', () => {
    const r = conversationsSansReponse([m({})], annuaire, now, depuis)
    expect(r).toHaveLength(1)
    expect(r[0].client.nom).toBe('THUASNE')
    expect(Math.round(r[0].heuresAttente)).toBe(50)
  })

  it('counts an answer written from ANOTHER mailbox (Laetitia answering contact@)', () => {
    const q = m({ messageId: 'q@thuasne' })
    const rep = m({ boite: 'l.tellier@etsmalterre.com', threadId: 'autre', messageId: 'r@ets', inReplyTo: 'q@thuasne', references: ['q@thuasne'],
      de: 'l.tellier@etsmalterre.com', a: ['achat@thuasne.fr'], envoye: true, date: LUNDI_9H + 2 * H })
    expect(conversationsSansReponse([q, rep], annuaire, now, depuis)).toHaveLength(0)
  })

  it('counts a new mail to the same person as an answer', () => {
    const q = m({})
    const nouveau = m({ threadId: 't2', de: 'contact@etsmalterre.com', a: ['achat@thuasne.fr'], envoye: true, date: LUNDI_9H + H })
    expect(conversationsSansReponse([q, nouveau], annuaire, now, depuis)).toHaveLength(0)
  })

  it('waits again when the client writes after our answer', () => {
    const q = m({ messageId: 'q@t' })
    const rep = m({ messageId: 'r@e', references: ['q@t'], inReplyTo: 'q@t', de: 'contact@etsmalterre.com', a: ['achat@thuasne.fr'], envoye: true, date: LUNDI_9H + H })
    const relance = m({ messageId: 'q2@t', references: ['q@t', 'r@e'], inReplyTo: 'r@e', date: LUNDI_9H + 5 * H })
    const r = conversationsSansReponse([q, rep, relance], annuaire, now, depuis)
    expect(r).toHaveLength(1)
    expect(r[0].dernier.messageId).toBe('q2@t')
  })

  it('ignores machines, unknown senders, suppliers and stale messages', () => {
    expect(conversationsSansReponse([m({ automatique: true })], annuaire, now, depuis)).toHaveLength(0)
    expect(conversationsSansReponse([m({ de: 'x@inconnu.fr' })], annuaire, now, depuis)).toHaveLength(0)
    expect(conversationsSansReponse([m({ de: 'contact@matel.fr' })], annuaire, now, depuis)).toHaveLength(0)
    expect(conversationsSansReponse([m({ date: depuis - H })], annuaire, now, depuis)).toHaveLength(0)
  })

  it('counts a mail received twice (contact@ + cc) once', () => {
    const a = m({ messageId: 'x@t' })
    const b = m({ messageId: 'x@t', boite: 'l.tellier@etsmalterre.com', threadId: 'tb' })
    const r = conversationsSansReponse([a, b], annuaire, now, depuis)
    expect(r).toHaveLength(1)
    expect(r[0].boites.sort()).toEqual(['contact@etsmalterre.com', 'l.tellier@etsmalterre.com'])
  })
})

describe('sansCitation', () => {
  it('drops the quoted history of a reply', () => {
    const t = 'Bonjour,\nOui c’est bon pour jeudi.\n\nLe lun. 21 sept. 2026 à 09:12, Paul <p@x.fr> a écrit :\n> ancienne question\n> encore'
    expect(sansCitation(t)).toBe('Bonjour,\nOui c’est bon pour jeudi.')
  })
})
