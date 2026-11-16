import { describe, expect, it } from 'vitest'
import { refusReponseAttendue, reponseProposee, urgenceOuverte, type FaitUrgence } from './urgence-sst.js'
import { urgenceAvecDemande, urgenceDemandeeCommande } from './sst-tricotage.js'

const fait = (type: FaitUrgence['type'], jour: string, reponseAttendue: string | null, p: Partial<FaitUrgence> = {}): FaitUrgence => ({
  type, le: `${jour}T10:00`, jour, reponseAttendue, dateSouhaitee: null, note: null, par: 'Vincent Malterre', ...p,
})

describe('urgence demandée à un sous-traitant', () => {
  // Monday 16/11/2026: asked, answer expected Wednesday 18/11.
  const demande = fait('demande', '2026-11-16', '2026-11-18')

  it('never asked = none', () => {
    expect(urgenceOuverte([], false, '2026-11-16')).toBeNull()
  })

  it('waits until the day the answer is expected, that day included', () => {
    expect(urgenceOuverte([demande], false, '2026-11-16')).toMatchObject({ demandeeLe: '2026-11-16', reponseAttendue: '2026-11-18', relances: 0, aRelancer: false })
    expect(urgenceOuverte([demande], false, '2026-11-18')!.aRelancer).toBe(false)
  })

  it('is ours to chase from the day after', () => {
    expect(urgenceOuverte([demande], false, '2026-11-19')!.aRelancer).toBe(true)
  })

  it('a relance gives a new date and keeps the day it was first asked', () => {
    const u = urgenceOuverte([demande, fait('relance', '2026-11-19', '2026-11-20', { note: 'rappel atelier' })], false, '2026-11-19')!
    expect(u).toMatchObject({ demandeeLe: '2026-11-16', reponseAttendue: '2026-11-20', relances: 1, note: 'rappel atelier', aRelancer: false })
  })

  it('the délai given on the line closes it', () => {
    expect(urgenceOuverte([demande], true, '2026-11-17')).toBeNull()
  })

  it('given up = none, and a later ask opens a new one', () => {
    const levee = fait('levee', '2026-11-17', null)
    expect(urgenceOuverte([demande, levee], false, '2026-11-17')).toBeNull()
    expect(urgenceOuverte([demande, levee, fait('demande', '2026-11-23', '2026-11-24')], false, '2026-11-23'))
      .toMatchObject({ demandeeLe: '2026-11-23', reponseAttendue: '2026-11-24', relances: 0 })
  })

  it('keeps the date asked for of the latest ask that named one', () => {
    const u = urgenceOuverte([
      fait('demande', '2026-11-16', '2026-11-18', { dateSouhaitee: '2026-11-25' }),
      fait('relance', '2026-11-19', '2026-11-20'),
    ], false, '2026-11-19')!
    expect(u.dateSouhaitee).toBe('2026-11-25')
  })
})

describe('jour où la réponse est attendue', () => {
  it('proposes 2 working days, over the weekend', () => {
    expect(reponseProposee('2026-11-16')).toBe('2026-11-18')
    expect(reponseProposee('2026-11-19')).toBe('2026-11-23')
  })

  it('today at the earliest, 5 working days at the latest', () => {
    expect(refusReponseAttendue('2026-11-16', '2026-11-16')).toBeNull()
    expect(refusReponseAttendue('2026-11-23', '2026-11-16')).toBeNull()
    expect(refusReponseAttendue('2026-11-13', '2026-11-16')).toMatch(/passé/)
    expect(refusReponseAttendue('2026-11-24', '2026-11-16')).toMatch(/5 jours ouvrés/)
    expect(refusReponseAttendue('', '2026-11-16')).toMatch(/Indiquez/)
  })
})

describe('urgence sur la carte de la commande de tricotage', () => {
  it('one line to chase makes the order to chase', () => {
    expect(urgenceDemandeeCommande([])).toBeNull()
    expect(urgenceDemandeeCommande([{ aRelancer: false }])).toBe('attente')
    expect(urgenceDemandeeCommande([{ aRelancer: false }, { aRelancer: true }])).toBe('a_relancer')
  })

  it('an urgency to chase is red whatever the délai rule says', () => {
    expect(urgenceAvecDemande(null, 'en_tricotage', 'a_relancer', false)).toBe('late')
    expect(urgenceAvecDemande('soon', 'attente_delai', 'a_relancer', true)).toBe('late')
  })

  it('« Attente délai » is not red while the urgency asked on every line without a délai awaits its answer', () => {
    // The délai was due (red by the 1-working-day rule), but the knitter was asked again: waiting.
    expect(urgenceAvecDemande('late', 'attente_delai', 'attente', true)).toBeNull()
    // A line nobody asked about keeps the order on the délai chase.
    expect(urgenceAvecDemande('late', 'attente_delai', 'attente', false)).toBe('late')
    // No urgency: the délai rule alone.
    expect(urgenceAvecDemande('late', 'attente_delai', null, false)).toBe('late')
    // Outside « Attente délai » an awaited urgency changes nothing (another line's délai may be late).
    expect(urgenceAvecDemande('late', 'en_tricotage', 'attente', true)).toBe('late')
  })
})
