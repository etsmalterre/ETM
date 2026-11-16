import { describe, expect, it } from 'vitest'
import { enAttenteDeReponse, joursReponseUrgence, refusDateSouhaitee, texteMailUrgence, urgenceLigne, type FaitUrgence } from './urgence-sst.js'
import { urgenceAvecDemande, urgenceDemandeeCommande } from './sst-tricotage.js'
import { estUneAvanceDelai } from './report-delai-sst.js'

const fait = (type: FaitUrgence['type'], jour: string, reponseAttendue: string | null, p: Partial<FaitUrgence> = {}): FaitUrgence => ({
  type, le: `${jour}T10:00`, jour, reponseAttendue, dateSouhaitee: null, delaiAvant: null, note: null, par: 'Vincent Malterre', ...p,
})

describe('passage en urgence d’une ligne de tricotage', () => {
  // Monday 16/11/2026, a line without a délai: asked for the 25th, answer due Tuesday 17/11.
  const demande = fait('demande', '2026-11-16', '2026-11-17', { dateSouhaitee: '2026-11-25' })

  it('never asked = none', () => {
    expect(urgenceLigne([], null, '2026-11-16')).toBeNull()
  })

  it('waits until the day the answer is expected, that day included', () => {
    expect(urgenceLigne([demande], null, '2026-11-16')).toMatchObject({
      etat: 'attente', demandeeLe: '2026-11-16', reponseAttendue: '2026-11-17', relances: 0, dateSouhaitee: '2026-11-25', delaiAvant: null,
    })
    expect(urgenceLigne([demande], null, '2026-11-17')!.etat).toBe('attente')
  })

  it('is ours to chase from the day after', () => {
    expect(urgenceLigne([demande], null, '2026-11-18')!.etat).toBe('a_relancer')
  })

  it('runs its own clock: working days since the latest ask over the days granted', () => {
    // Asked Monday 16/11, answer due Tuesday 17/11: 1 working day granted.
    expect(urgenceLigne([demande], null, '2026-11-16')).toMatchObject({ jours: 0, accordes: 1 })
    expect(urgenceLigne([demande], null, '2026-11-17')).toMatchObject({ jours: 1, accordes: 1 })
    // Friday 20/11, still nothing: 4 working days on a 1-day clock.
    expect(urgenceLigne([demande], null, '2026-11-20')).toMatchObject({ jours: 4, accordes: 1, etat: 'a_relancer' })
    // A relance on the 20th (answer due Monday 23/11) restarts it, over the weekend.
    const relance = fait('relance', '2026-11-20', '2026-11-23')
    expect(urgenceLigne([demande, relance], null, '2026-11-23')).toMatchObject({ jours: 1, accordes: 1, etat: 'attente' })
    // Another knitter gets 2 working days.
    expect(urgenceLigne([fait('demande', '2026-11-16', '2026-11-18')], null, '2026-11-17')).toMatchObject({ jours: 1, accordes: 2 })
  })

  it('a relance gives a new day and keeps the day it was first asked', () => {
    const u = urgenceLigne([demande, fait('relance', '2026-11-18', '2026-11-19', { note: 'rappel atelier', dateSouhaitee: '2026-11-26' })], null, '2026-11-18')!
    expect(u).toMatchObject({ etat: 'attente', demandeeLe: '2026-11-16', reponseAttendue: '2026-11-19', relances: 1, note: 'rappel atelier', dateSouhaitee: '2026-11-26' })
  })

  it('the délai the knitter gives answers it: the line stays « urgente », nothing is awaited', () => {
    const u = urgenceLigne([demande], '2026-11-24', '2026-11-20')!
    expect(u.etat).toBe('repondue')
    expect(enAttenteDeReponse(u)).toBe(false)
  })

  it('refused or given up = none, and a later ask opens a new one', () => {
    expect(urgenceLigne([demande, fait('refus', '2026-11-17', null)], null, '2026-11-17')).toBeNull()
    const levee = fait('levee', '2026-11-17', null)
    expect(urgenceLigne([demande, levee], null, '2026-11-17')).toBeNull()
    expect(urgenceLigne([demande, levee, fait('demande', '2026-11-23', '2026-11-24')], null, '2026-11-23'))
      .toMatchObject({ etat: 'attente', demandeeLe: '2026-11-23', reponseAttendue: '2026-11-24', relances: 0 })
  })

  describe('on a line that already has its délai (« can you go faster? »)', () => {
    // The knitter gave the 30/11; on the 18th we ask for the 25th.
    const accelerer = fait('demande', '2026-11-18', '2026-11-19', { dateSouhaitee: '2026-11-25', delaiAvant: '2026-11-30' })

    it('awaits while the délai has not moved', () => {
      expect(urgenceLigne([accelerer], '2026-11-30', '2026-11-18')!.etat).toBe('attente')
      expect(urgenceLigne([accelerer], '2026-11-30', '2026-11-20')!.etat).toBe('a_relancer')
    })

    it('a délai moved since is the answer, said by a fact or read on the line', () => {
      expect(urgenceLigne([accelerer], '2026-11-26', '2026-11-19')!.etat).toBe('repondue')
      const reponse = fait('reponse', '2026-11-19', null, { delaiAvant: '2026-11-30' })
      expect(urgenceLigne([accelerer, reponse], '2026-11-26', '2026-11-19')!.etat).toBe('repondue')
    })

    it('« the knitter cannot » ends it: the délai stands', () => {
      expect(urgenceLigne([accelerer, fait('refus', '2026-11-19', null, { delaiAvant: '2026-11-30' })], '2026-11-30', '2026-11-19')).toBeNull()
    })

    it('a second ask refused leaves the first one, which the knitter granted: the line stays « urgente »', () => {
      // Asked without a délai, TRM gave the 30/11; asked again for the 25th, TRM cannot.
      const premiere = fait('demande', '2026-11-16', '2026-11-17', { dateSouhaitee: '2026-11-27' })
      const refus = fait('refus', '2026-11-19', null, { delaiAvant: '2026-11-30' })
      expect(urgenceLigne([premiere, accelerer, refus], '2026-11-30', '2026-11-19')).toMatchObject({ etat: 'repondue', demandeeLe: '2026-11-16', dateSouhaitee: '2026-11-27' })
      // Given up instead: the mark goes, whatever was granted before.
      expect(urgenceLigne([premiere, accelerer, fait('levee', '2026-11-19', null)], '2026-11-30', '2026-11-19')).toBeNull()
    })

    it('asked again after an answer: a new urgency on the délai now in place', () => {
      const premiere = fait('demande', '2026-11-16', '2026-11-17', { dateSouhaitee: '2026-11-27' })
      // TRM answered the 30/11 (first délai), then we ask for the 25th.
      expect(urgenceLigne([premiere, accelerer], '2026-11-30', '2026-11-18')).toMatchObject({ etat: 'attente', demandeeLe: '2026-11-18', delaiAvant: '2026-11-30' })
    })

    it('the earlier délai is an « avance », refused elsewhere: only the awaited urgency lets it through', () => {
      // lib/report-delai-sst.ts refusAvanceDelai reads urgenceEnAttente; the pure half:
      expect(estUneAvanceDelai('20261130', '20261130', '20261125')).toBe(true)
      expect(enAttenteDeReponse(urgenceLigne([accelerer], '2026-11-30', '2026-11-25'))).toBe(true)
      expect(enAttenteDeReponse(urgenceLigne([accelerer], '2026-11-25', '2026-11-25'))).toBe(false)
    })
  })
})

describe('date souhaitée', () => {
  it('required, not past', () => {
    expect(refusDateSouhaitee('', null, '2026-11-16')).toMatch(/Indiquez/)
    expect(refusDateSouhaitee(null, null, '2026-11-16')).toMatch(/Indiquez/)
    expect(refusDateSouhaitee('2026-11-13', null, '2026-11-16')).toMatch(/passée/)
    expect(refusDateSouhaitee('2026-11-16', null, '2026-11-16')).toBeNull()
  })

  it('before the délai the knitter already gave', () => {
    expect(refusDateSouhaitee('2026-11-25', '2026-11-30', '2026-11-16')).toBeNull()
    expect(refusDateSouhaitee('2026-11-30', '2026-11-30', '2026-11-16')).toMatch(/avant le délai déjà donné \(30\/11\)/)
    expect(refusDateSouhaitee('2026-12-02', '2026-11-30', '2026-11-16')).toMatch(/avant le délai/)
  })
})

describe('délai de réponse du tricoteur', () => {
  it('Tricotage Malterre answers within 1 working day, another knitter within 2', () => {
    expect(joursReponseUrgence(1)).toBe(1)
    expect(joursReponseUrgence(93)).toBe(2)
  })
})

describe('urgence sur la carte de la commande de tricotage', () => {
  it('one line to chase makes the order to chase; an answered urgency asks nothing', () => {
    const u = (etat: 'attente' | 'a_relancer' | 'repondue', reponseAttendue: string) => ({ etat, reponseAttendue })
    expect(urgenceDemandeeCommande([], '2026-11-17')).toBeNull()
    expect(urgenceDemandeeCommande([u('repondue', '2026-11-10')], '2026-11-17')).toBeNull()
    expect(urgenceDemandeeCommande([u('attente', '2026-11-17'), u('repondue', '2026-11-10')], '2026-11-17')).toBe('attente')
    expect(urgenceDemandeeCommande([u('attente', '2026-11-18'), u('a_relancer', '2026-11-16')], '2026-11-17')).toBe('a_relancer')
    // The answer day decides, whatever day the line's own état was computed on.
    expect(urgenceDemandeeCommande([u('attente', '2026-11-16')], '2026-11-17')).toBe('a_relancer')
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

describe('le mail qui prévient le sous-traitant', () => {
  const base = { numero: 9120, article: 'E1732 - Noir 54507/2', dateSouhaitee: '2026-11-17', delai: '2026-11-18', demandeeLe: '2026-11-16' }
  it('demande: the date wished and the délai it gave, in the subject too', () => {
    const m = texteMailUrgence({ geste: 'demande', ...base })
    expect(m.subject).toBe('URGENT — Commande N°9120 : livraison souhaitée le 17/11/2026 — ETS Malterre')
    expect(m.body).toContain('notre commande N°9120 (E1732 - Noir 54507/2)')
    expect(m.body).toContain('Date souhaitée : 17/11/2026.')
    expect(m.body).toContain('Délai que vous nous avez donné : 18/11/2026.')
    // A line without a délai names none.
    expect(texteMailUrgence({ geste: 'demande', ...base, delai: null }).body).not.toContain('Délai que vous')
  })
  it('relance: the day it was first asked', () => {
    const m = texteMailUrgence({ geste: 'relance', ...base })
    expect(m.subject).toMatch(/^Relance — URGENT — Commande N°9120/)
    expect(m.body).toContain('notre demande d’urgence du 16/11/2026')
    expect(m.body).toContain('nous souhaitons la recevoir le 17/11/2026')
  })
  it('levée: the délai stands, or stays to give', () => {
    expect(texteMailUrgence({ geste: 'levee', ...base }).body).toContain('Votre délai du 18/11/2026 reste inchangé.')
    const sans = texteMailUrgence({ geste: 'levee', ...base, delai: null })
    expect(sans.subject).toBe('Commande N°9120 : demande d’urgence annulée — ETS Malterre')
    expect(sans.body).toContain('Merci de nous indiquer votre délai habituel.')
  })
  it('a mail sent is a fact that changes nothing to the urgency', () => {
    const demande = { type: 'demande' as const, le: '2026-11-16T10:00', jour: '2026-11-16', reponseAttendue: '2026-11-17', dateSouhaitee: '2026-11-17', delaiAvant: '2026-11-18', note: null, par: 'V' }
    const mail = { ...demande, type: 'mail' as const, reponseAttendue: null, dateSouhaitee: null }
    expect(urgenceLigne([demande, mail], '2026-11-18', '2026-11-16')).toMatchObject({ etat: 'attente', relances: 0 })
  })
})
