import { describe, expect, it } from 'vitest'
import {
  cleLot,
  etapeLot,
  faitSoumission,
  etatCommande,
  etatLot,
  depuisEtape,
  dernierContactClient,
  relanceClientDue,
  relanceControleDue,
  joursOuvresDepuis,
  plusJoursOuvres,
  prealableAttendu,
  prealablesDetail,
  prealablesValidation,
  urgenceCommande,
  urgenceDemandeeDe,
  calendrierTraitement,
  avecTempsDesLignes,
  tempsDesLignes,
  urgenceLot,
  type CommandeFait,
  type LotFait,
  type SoumissionFait,
} from './cycle-ennoblissement.js'
import type { FaitsDelai } from './delai-sst.js'
import { natureInferee, naturesDemandees, valeurSoumettre } from './soumission-lot.js'

function lot(p: Partial<LotFait> = {}): LotFait {
  return {
    lot: 'MA109377', idsuivilot: 1, etat: 1, reception: '2026-10-08',
    mesuresTeinturier: false, tirelleMesuree: false,
    coloris: { requise: false, envoyeeLe: null, reponse: null },
    stabilites: { requise: false, envoyeeLe: null, reponse: null },
    ...p,
  }
}

/** A soumission: asked or not, sent on a day, answered or not. */
function soum(p: { requise?: boolean; le?: string; accepte?: boolean; commentaire?: string; reponseLe?: string } = {}): SoumissionFait {
  return {
    requise: p.requise ?? true,
    envoyeeLe: p.le ?? null,
    reponse: p.accepte === undefined ? null : { accepte: p.accepte, commentaire: p.commentaire ?? '', le: `${p.reponseLe ?? p.le ?? '2026-10-20'} 10:00:00` },
  }
}

function faitsDelai(p: Partial<FaitsDelai> = {}): FaitsDelai {
  return { demandeLe: null, dateNotif: null, relances: [], reports: [], reponduLe: null, ...p }
}

function commande(p: Partial<CommandeFait> = {}): CommandeFait {
  return {
    est_soldee: false, rangStatut: 2,
    delai: '2026-10-20', lots: [], ecruChezTeinturier: 0, ...p,
  }
}

describe('etapeLot: Pierre-Emmanuel’s codes, read from the data (16 lots of 2026-10-11)', () => {
  it('ACP: no dyer measure, no tirelle measure', () => {
    expect(etapeLot(lot())).toBe('attente_mesures')
  })
  it('ACL: dyer measures in, our tirelle measure not yet', () => {
    expect(etapeLot(lot({ mesuresTeinturier: true }))).toBe('attente_tirelle')
  })
  it('« lot/s »: a soumission names the lot, whatever the measures (109328: état 5, no tirelle yet)', () => {
    expect(etapeLot(lot({ etat: 5, mesuresTeinturier: true, stabilites: soum({ le: '2026-10-08' }) }))).toBe('soumis')
  })
  it('controlled: à soumettre when the client asks it for this reference, else à valider', () => {
    expect(etapeLot(lot({ mesuresTeinturier: true, tirelleMesuree: true, stabilites: soum() }))).toBe('a_soumettre')
    expect(etapeLot(lot({ mesuresTeinturier: true, tirelleMesuree: true }))).toBe('a_valider')
    // #1304: both controls are required — a tirelle measured without the
    // dyer's measures (5965, 09/10) still waits for the dyer.
    expect(etapeLot(lot({ tirelleMesuree: true }))).toBe('attente_mesures')
  })
  it('the lot state wins: reprise, validated (« coloris validé » after a soumission); the legacy « expédié » reads validated', () => {
    expect(etapeLot(lot({ etat: 2, stabilites: soum({ le: '2026-10-01' }) }))).toBe('en_reprise')
    expect(etapeLot(lot({ etat: 3, stabilites: soum({ le: '2026-10-01' }) }))).toBe('valide')
    expect(etapeLot(lot({ etat: 4 }))).toBe('valide')
  })
  it('an open reprise (lib/reprises.ts) puts the lot at the dyer, whatever the old état', () => {
    expect(etapeLot(lot({ etat: 1, tirelleMesuree: true, repriseOuverte: true }))).toBe('en_reprise')
    expect(etatLot(lot({ repriseOuverte: true, reprises: 2 })).reprises).toBe(2)
  })
  it('the legacy « attente décision » (état 5) carries no meaning of its own', () => {
    expect(etapeLot(lot({ etat: 5, mesuresTeinturier: true }))).toBe('attente_tirelle')
    expect(etapeLot(lot({ etat: 5, mesuresTeinturier: true, tirelleMesuree: true }))).toBe('a_valider')
  })
})

describe('#1304: client answer, rapport de contrôle, what blocks « Valider le lot »', () => {
  const controle = { mesuresTeinturier: true, tirelleMesuree: true }
  it('a soumission waits for the answer; accepted moves on, refused must be repris', () => {
    expect(etapeLot(lot({ ...controle, stabilites: soum({ le: '2026-10-20' }) }))).toBe('soumis')
    expect(etapeLot(lot({ ...controle, stabilites: soum({ le: '2026-10-20', accepte: true }) }))).toBe('a_valider')
    expect(etapeLot(lot({ ...controle, stabilites: soum({ le: '2026-10-20', accepte: false, commentaire: 'trop foncé' }) }))).toBe('refuse_client')
    expect(etatLot(lot({ ...controle, stabilites: soum({ le: '2026-10-20', accepte: false }) })).main).toBe('nous')
  })
  it('an owed RC comes after the soumission, before the validation', () => {
    expect(etapeLot(lot({ ...controle, rcAEnvoyer: ['LEMAHIEU'] }))).toBe('rc_a_envoyer')
    expect(etapeLot(lot({ ...controle, stabilites: soum(), rcAEnvoyer: ['LEMAHIEU'] }))).toBe('a_soumettre')
  })
  it('prealables: everything still to do, in order; empty when the lot may be validated', () => {
    expect(prealablesValidation(lot({ stabilites: soum(), rcAEnvoyer: ['SAS LA FABRIQUE'] }))).toEqual([
      'Ennoblisseur : laize, poids, stabilités',
      'Malterre : laize, poids, stabilités',
      'Soumission stabilités à envoyer',
      'Rapport de contrôle à envoyer : SAS LA FABRIQUE',
    ])
    // Only what is still missing is named (lib/controles-lot.ts, 2026-10-26).
    expect(prealablesValidation(lot({ tirelleMesuree: true, manqueTeinturier: ['stabilités'] }))).toEqual([
      'Ennoblisseur : stabilités',
    ])
    expect(prealablesValidation(lot({ ...controle, stabilites: soum({ le: '2026-10-20' }) }))).toEqual(['Réponse client : stabilités'])
    expect(prealablesValidation(lot({ ...controle, stabilites: soum({ le: '2026-10-20', accepte: true }) }))).toEqual([])
    expect(prealablesValidation(lot({ ...controle, repriseOuverte: true }))).toEqual(['En reprise chez l’ennoblisseur'])
    expect(prealablesValidation(lot({ ...controle, etat: 3 }))).toEqual(['Lot déjà validé'])
  })
})

describe('#1313: the coloris soumission, before the stenter (Agape, Simone Pérèle, Empreinte…)', () => {
  const avantRame = { reception: null, coloris: soum({ le: '2026-10-15' }) }
  it('submitted before the reception: the client answers, then « coloris validé », then the dyer rames', () => {
    expect(etapeLot(lot(avantRame))).toBe('coloris_soumis')
    expect(etapeLot(lot({ ...avantRame, coloris: soum({ le: '2026-10-15', accepte: true }) }))).toBe('ok_ramer_a_envoyer')
    expect(etapeLot(lot({ ...avantRame, coloris: soum({ le: '2026-10-15', accepte: true }), okRamerLe: '2026-10-16' }))).toBe('en_rame')
  })
  it('refused before the stenter: back to the dye (same lot), the dyer’s move', () => {
    const l = lot({ ...avantRame, coloris: soum({ le: '2026-10-15', accepte: false, commentaire: 'trop rouge' }) })
    expect(etapeLot(l)).toBe('reteinture')
    expect(etatLot(l)).toMatchObject({ main: 'teinturier', relance: null })
  })
  it('received: the coloris accepted no longer waits for an « coloris validé », the controls follow', () => {
    expect(etapeLot(lot({ coloris: soum({ le: '2026-10-01', accepte: true }) }))).toBe('attente_mesures')
    expect(etapeLot(lot({ mesuresTeinturier: true, tirelleMesuree: true, coloris: soum({ le: '2026-10-01', accepte: true }) }))).toBe('a_valider')
  })
  it('received without its coloris soumission: ours to submit; refused once received: Reprendre', () => {
    expect(etapeLot(lot({ coloris: soum() }))).toBe('coloris_a_soumettre')
    expect(etapeLot(lot({ coloris: soum({ le: '2026-10-01', accepte: false }) }))).toBe('refuse_client')
  })
  it('both asked (case 3): coloris first, stabilités after the controls', () => {
    const deux = { mesuresTeinturier: true, tirelleMesuree: true, coloris: soum({ le: '2026-10-01', accepte: true }), stabilites: soum() }
    expect(etapeLot(lot(deux))).toBe('a_soumettre')
    expect(etapeLot(lot({ ...deux, stabilites: soum({ le: '2026-10-09' }) }))).toBe('soumis')
  })
  it('a lot not received cannot be validated', () => {
    expect(prealablesValidation(lot({ ...avantRame, coloris: soum({ le: '2026-10-15', accepte: true }) }))).toEqual([
      'OK coloris à transmettre à l’ennoblisseur',
      'Lot pas encore reçu',
    ])
    expect(prealablesValidation(lot(avantRame))).toEqual([
      'Réponse client : coloris',
      'Lot pas encore reçu',
    ])
  })
  it('chase: the client 5 working days after, us the next day, the dyer 3 days after the « coloris validé »', () => {
    expect(etatLot(lot({ ...avantRame, coloris: soum({ le: '2026-10-09' }) }))).toMatchObject({ main: 'client', relance: '2026-10-16' })
    expect(etatLot(lot({ ...avantRame, coloris: soum({ le: '2026-10-09', accepte: true }) }))).toMatchObject({ main: 'nous', relance: '2026-10-12' })
    expect(etatLot(lot({ ...avantRame, coloris: soum({ le: '2026-10-09', accepte: true }), okRamerLe: '2026-10-12' }))).toMatchObject({ main: 'teinturier', relance: '2026-10-15' })
  })
})

describe('#1313: which soumission a send was, and which answer counts', () => {
  it('designation_client.soumettre is a bit set: 1 stabilités, 2 coloris', () => {
    expect(naturesDemandees(0)).toEqual([])
    expect(naturesDemandees(1)).toEqual(['stabilites'])
    expect(naturesDemandees(2)).toEqual(['coloris'])
    expect(naturesDemandees(3)).toEqual(['coloris', 'stabilites'])
    expect(valeurSoumettre(true, false)).toBe(2)
    expect(valeurSoumettre(true, true)).toBe(3)
  })
  it('history: the one the reference asks, else before the reception = coloris (prod: 109 of 109 for the 5 coloris clients)', () => {
    expect(natureInferee('2026-10-02', '2026-10-08')).toBe('coloris')
    expect(natureInferee('2026-10-02', null)).toBe('coloris')
    expect(natureInferee('2026-10-09', '2026-10-08')).toBe('stabilites')
    expect(natureInferee('2026-10-09', '2026-10-08', ['coloris'])).toBe('coloris')
    expect(natureInferee('2026-10-02', '2026-10-08', ['stabilites'])).toBe('stabilites')
  })
  it('the latest send still valid, and only an answer given after it', () => {
    const envois = [
      { nature: 'coloris' as const, jour: '2026-10-01', ts: '2026-10-01 09:00:00' },
      { nature: 'coloris' as const, jour: '2026-10-10', ts: '2026-10-10 09:00:00' },
      { nature: 'stabilites' as const, jour: '2026-10-20', ts: '2026-10-20 09:00:00' },
    ]
    const reponses = [{ nature: 'coloris' as const, accepte: false, commentaire: 'trop rouge', ts: '2026-10-05 08:00:00', par: 'Isabelle' }]
    // The refusal answered the first send; the re-dyed lot was submitted again on the 10th.
    expect(faitSoumission('coloris', true, envois, reponses, null)).toEqual({ requise: true, envoyeeLe: '2026-10-10', reponse: null })
    expect(faitSoumission('stabilites', false, envois, reponses, null).envoyeeLe).toBe('2026-10-20')
    // A stabilités soumission before the lot's return from reprise was about the old lot.
    expect(faitSoumission('stabilites', true, envois, reponses, '2026-10-21').envoyeeLe).toBeNull()
  })
})

describe('etatLot: whose move and when to chase', () => {
  it('en contrôle: the dyer measures get 5 working days from the reception (9113, 2026-11-03)', () => {
    expect(etatLot(lot({ reception: '2026-10-30' }))).toMatchObject({ main: 'teinturier', relance: '2026-11-06' })
  })
  it('ACL « Attente contrôle Malterre »: ours, same window from the reception', () => {
    expect(etatLot(lot({ reception: '2026-10-08', mesuresTeinturier: true }))).toMatchObject({ main: 'nous', relance: '2026-10-15' })
  })
  it('the whole control phase shares the window: soumission to send, RC, validation', () => {
    const fait = { reception: '2026-10-08', mesuresTeinturier: true, tirelleMesuree: true }
    expect(etatLot(lot({ ...fait, stabilites: soum({ requise: true }) }))).toMatchObject({ etape: 'a_soumettre', relance: '2026-10-15' })
    expect(etatLot(lot(fait))).toMatchObject({ etape: 'a_valider', relance: '2026-10-15' })
  })
  it('the window skips public holidays (11/11)', () => {
    expect(etatLot(lot({ reception: '2026-11-06' })).relance).toBe('2026-11-16')
  })
  it('refused by the client once received: a decision, flagged the next working day', () => {
    expect(etatLot(lot({ reception: '2026-10-08', mesuresTeinturier: true, tirelleMesuree: true, stabilites: soum({ le: '2026-10-09', accepte: false }) }))).toMatchObject({ etape: 'refuse_client', relance: '2026-10-09' })
  })
  it('client: 5 working days after the soumission', () => {
    expect(etatLot(lot({ stabilites: soum({ le: '2026-10-09' }) }))).toMatchObject({ main: 'client', relance: '2026-10-16' })
  })
  it('reprise: the dyer gives the date in the point, nothing computed', () => {
    expect(etatLot(lot({ etat: 2 }))).toMatchObject({ main: 'teinturier', relance: null })
  })
})

describe('« Relancer l’ennoblisseur »: its controls, 2 working days after each relance (Vincent 2026-11-27)', () => {
  // Received Thu 08/10: the control window ends Thu 15/10.
  const recu = (relancesControle?: string[]) => lot({ reception: '2026-10-08', ...(relancesControle ? { relancesControle } : {}) })

  it('the chase date: the end of the window, then the latest relance + 2', () => {
    expect(relanceControleDue(recu())).toBe('2026-10-15')
    expect(relanceControleDue(recu(['2026-10-16']))).toBe('2026-10-20')
    expect(relanceControleDue(recu(['2026-10-16', '2026-10-20']))).toBe('2026-10-22')
    // Chased early: the window is never shortened.
    expect(relanceControleDue(recu(['2026-10-09']))).toBe('2026-10-15')
    expect(relanceControleDue(lot({ reception: null }))).toBeNull()
  })
  it('the lot: red until we chase, calm, then red again', () => {
    expect(urgenceLot(recu(), '2026-10-16')).toEqual({ niveau: 'rouge', raison: 'Relancer l’ennoblisseur depuis le 15/10' })
    const relance = recu(['2026-10-16'])
    expect(etatLot(relance)).toMatchObject({ etape: 'attente_mesures', main: 'teinturier', relance: '2026-10-20', fenetre: { depuis: '2026-10-16', delai: 2 } })
    expect(urgenceLot(relance, '2026-10-16')).toBeNull()
    expect(urgenceLot(relance, '2026-10-19')?.niveau).toBe('ambre')
    expect(urgenceLot(relance, '2026-10-20')).toEqual({ niveau: 'rouge', raison: 'Relancer l’ennoblisseur aujourd’hui' })
    expect(urgenceLot(recu(['2026-10-16', '2026-10-20']), '2026-10-20')).toBeNull()
  })
  it('a relance inside the window leaves the gauge on the reception', () => {
    expect(etatLot(recu(['2026-10-09']))).toMatchObject({ relance: '2026-10-15', fenetre: { depuis: '2026-10-08', delai: 5 } })
  })
  it('only the dyer’s step: our own control keeps the window from the reception', () => {
    expect(etatLot(lot({ reception: '2026-10-08', mesuresTeinturier: true, relancesControle: ['2026-10-16'] })))
      .toMatchObject({ etape: 'attente_tirelle', main: 'nous', relance: '2026-10-15', fenetre: { depuis: '2026-10-08', delai: 5 } })
  })
})

describe('« Relancer le client »: 5 more working days after each relance (Vincent 2026-11-27)', () => {
  // October 2026 has no public holiday. Coloris sent Mon 12/10: the client's 5 days end Mon 19/10.
  const soumis = (relances?: string[]) => lot({ reception: null, idligne: 7, coloris: { ...soum({ requise: true, le: '2026-10-12' }), ...(relances ? { relances } : {}) } })
  const cmd = (l: LotFait) => commande({ delaiFaits: faitsDelai({ demandeLe: '2026-10-05' }), lignesOuvertes: [{ id: 7, delai: '2026-10-20' }], lots: [l], ecruChezTeinturier: 1 })

  it('the chase date: the send + 5, then the latest relance + 5', () => {
    expect(dernierContactClient(soum({ le: '2026-10-12' }))).toBe('2026-10-12')
    expect(relanceClientDue(soum({ le: '2026-10-12' }))).toBe('2026-10-19')
    expect(relanceClientDue({ envoyeeLe: '2026-10-12', relances: ['2026-10-20'] })).toBe('2026-10-27')
    expect(relanceClientDue({ envoyeeLe: '2026-10-12', relances: ['2026-10-20', '2026-10-27'] })).toBe('2026-11-03')
    expect(relanceClientDue(soum())).toBeNull()
  })
  it('the lot: red until we chase, calm for 5 working days, red again — coloris and stabilités alike', () => {
    expect(urgenceLot(soumis(), '2026-10-20')).toEqual({ niveau: 'rouge', raison: 'Relancer le client depuis le 19/10' })
    // Chased Tue 20/10: nothing to do until the day before the next chase (Tue 27/10).
    const relance = soumis(['2026-10-20'])
    expect(etatLot(relance)).toMatchObject({ etape: 'coloris_soumis', main: 'client', relance: '2026-10-27', fenetre: { depuis: '2026-10-20', delai: 5 } })
    expect(urgenceLot(relance, '2026-10-20')).toBeNull()
    expect(urgenceLot(relance, '2026-10-23')).toBeNull()
    expect(urgenceLot(relance, '2026-10-26')?.niveau).toBe('ambre')
    expect(urgenceLot(relance, '2026-10-27')).toEqual({ niveau: 'rouge', raison: 'Relancer le client aujourd’hui' })
    // …and so on after a second relance.
    expect(urgenceLot(soumis(['2026-10-20', '2026-10-27']), '2026-10-28')).toBeNull()
    // The stabilités soumission of a received lot follows the same rule.
    const stab = lot({ mesuresTeinturier: true, stabilites: { ...soum({ le: '2026-10-12' }), relances: ['2026-10-20'] } })
    expect(etatLot(stab)).toMatchObject({ etape: 'soumis', relance: '2026-10-27' })
    expect(depuisEtape(stab)).toEqual({ depuis: '2026-10-20', delai: 5 })
  })
  it('the order waits on the client the same way: its chase moves with the relance', () => {
    expect(urgenceCommande(etatCommande(cmd(soumis())), '2026-10-21')).toBe('late')
    const e = etatCommande(cmd(soumis(['2026-10-20'])))
    expect(e).toMatchObject({ etape: 'en_teinture', main: 'client', relance: '2026-10-27' })
    expect(e.traitement!.attentes).toEqual([{ lot: 'MA109377', du: '2026-10-12', au: null, relanceLe: '2026-10-20' }])
    expect(urgenceCommande(e, '2026-10-21')).toBeNull()
    expect(urgenceCommande(e, '2026-10-27')).toBe('late')
  })
  it('the client’s own delay does NOT restart: it counts from the soumission’s send, relances or not', () => {
    const sans = etatCommande(cmd(soumis()))
    const avec = etatCommande(cmd(soumis(['2026-10-20'])))
    // Wed 21/10: 7 working days since the send = 2 beyond its 5; the dyer is expected 22/10 instead of 20/10.
    for (const e of [sans, avec]) {
      expect(calendrierTraitement(e.traitement!, '2026-10-21')).toMatchObject({ retardClient: 2, resteClient: 2, sortie: '2026-10-22', attente: { depuis: '2026-10-12', jours: 7, fin: '2026-10-19' } })
    }
    // The lot « en rame » on that line is due with the same pushed day.
    expect(tempsDesLignes(cmd(soumis(['2026-10-20'])), '2026-10-21').get(7)).toEqual({ depuis: '2026-10-05', echeance: '2026-10-22' })
    // Answered Wed 28/10 after two relances: 12 working days = 7 of delay, all the client's.
    const repondu = lot({ reception: null, idligne: 7, okRamerLe: '2026-10-28', coloris: { ...soum({ requise: true, le: '2026-10-12', accepte: true, reponseLe: '2026-10-28' }), relances: ['2026-10-20', '2026-10-27'] } })
    expect(etatCommande(cmd(repondu)).traitement).toMatchObject({ retardClient: 7 })
  })
  it('faitSoumission keeps the relances of the CURRENT send only, by nature', () => {
    const envois = [
      { nature: 'coloris' as const, jour: '2026-10-01', ts: '2026-10-01 09:00:00.000' },
      { nature: 'coloris' as const, jour: '2026-10-12', ts: '2026-10-12 09:00:00.000' },
    ]
    const relances = [
      { nature: 'coloris' as const, jour: '2026-10-08', ts: '2026-10-08 10:00:00.000' }, // chased the first send
      { nature: 'coloris' as const, jour: '2026-10-27', ts: '2026-10-27 10:00:00.000' },
      { nature: 'coloris' as const, jour: '2026-10-20', ts: '2026-10-20 10:00:00.000' },
      { nature: 'stabilites' as const, jour: '2026-10-21', ts: '2026-10-21 10:00:00.000' },
    ]
    expect(faitSoumission('coloris', true, envois, [], null, relances)).toEqual({ requise: true, envoyeeLe: '2026-10-12', reponse: null, relances: ['2026-10-20', '2026-10-27'] })
    expect(faitSoumission('coloris', true, envois, [], null)).toEqual({ requise: true, envoyeeLe: '2026-10-12', reponse: null })
  })
  it('⚠️ a soumission sent AGAIN restarts the client’s clock (why a relance is never stored as a soumission)', () => {
    // Sent 12/10, sent again 20/10 without an answer: the cycle reads the latest send, the 6 days already
    // waited are lost — the client's delay on 28/10 is 1 working day instead of 7.
    const envois = [
      { nature: 'coloris' as const, jour: '2026-10-12', ts: '2026-10-12 09:00:00.000' },
      { nature: 'coloris' as const, jour: '2026-10-20', ts: '2026-10-20 09:00:00.000' },
    ]
    const renvoye = faitSoumission('coloris', true, envois, [], null)
    expect(renvoye.envoyeeLe).toBe('2026-10-20')
    const e = etatCommande(cmd(lot({ reception: null, idligne: 7, coloris: renvoye })))
    expect(calendrierTraitement(e.traitement!, '2026-10-28').retardClient).toBe(1)
    expect(calendrierTraitement(etatCommande(cmd(soumis(['2026-10-20']))).traitement!, '2026-10-28').retardClient).toBe(7)
  })
})

describe('etatCommande', () => {
  it('before any lot: à envoyer, attente délai (ours the working day after the échéance: date_notif, else bon + 3), en teinture (the délai)', () => {
    expect(etatCommande(commande({ rangStatut: 0 })).etape).toBe('non_envoye')
    expect(etatCommande(commande({ rangStatut: 1, delaiFaits: faitsDelai({ dateNotif: '2026-10-12' }) }))).toMatchObject({ etape: 'attente_delai', main: 'teinturier', relance: '2026-10-13' })
    expect(etatCommande(commande({ rangStatut: 1, delaiFaits: faitsDelai({ demandeLe: '2026-10-09' }) })).relance).toBe('2026-10-15')
    expect(etatCommande(commande())).toMatchObject({ etape: 'en_teinture', main: 'teinturier', relance: '2026-10-20' })
  })
  it('en traitement: the card runs from the bon to the earliest open délai, later lines listed (2026-11-11)', () => {
    const e = etatCommande(commande({ delaiFaits: faitsDelai({ demandeLe: '2026-10-01', reponduLe: '2026-10-03' }), delaisLignes: ['2026-10-20', '2026-10-27'] }))
    expect(e.traitement).toEqual({ depuis: '2026-10-01', delai: '2026-10-20', autres: ['2026-10-27'], attentes: [], retardClient: 0, reporteClient: 0 })
    // No délai on any open line: no card (the line asks for one).
    expect(etatCommande(commande({ delai: null })).traitement).toBeUndefined()
    // A solde still at the dyer keeps it; en contrôle without solde drops it.
    const partiel = etatCommande(commande({ lots: [lot({ etat: 5, mesuresTeinturier: true, stabilites: soum({ le: '2026-10-20' }) })], ecruChezTeinturier: 4 }))
    expect(partiel.traitement?.delai).toBe('2026-10-20')
    const tout = etatCommande(commande({ lots: [lot({ etat: 5, mesuresTeinturier: true, stabilites: soum({ le: '2026-10-20' }) })], ecruChezTeinturier: 0 }))
    expect(tout.traitement).toBeUndefined()
  })
  it('coloris at the client: the hand is the client’s for 5 working days inside the dyer’s délai (9111, 2026-11-11)', () => {
    // Bon Mon 05/10, délai Tue 20/10, coloris sent Mon 12/10, not received.
    const soumis = lot({ reception: null, idligne: 7, coloris: soum({ requise: true, le: '2026-10-12' }) })
    const c = commande({ delaiFaits: faitsDelai({ demandeLe: '2026-10-05' }), lignesOuvertes: [{ id: 7, delai: '2026-10-20' }], lots: [soumis], ecruChezTeinturier: 1 })
    const e = etatCommande(c)
    // The order waits on the client: chased once its 5 days are used, never the dyer meanwhile.
    expect(e).toMatchObject({ etape: 'en_teinture', main: 'client', relance: '2026-10-19' })
    expect(e.traitement!.attentes).toEqual([{ lot: soumis.lot, du: '2026-10-12', au: null }])
    // Wed 14/10: 5 dyer days (06→12), 2 client days (13, 14), 3 left of the client's 5 (15, 16, 19), then the délai.
    const cal = calendrierTraitement(e.traitement!, '2026-10-14')
    expect(cal.jours).toEqual(['sst', 'sst', 'sst', 'sst', 'sst', 'client', 'client', 'client_prevu', 'client_prevu', 'client_prevu', 'avenir'])
    expect(cal).toMatchObject({ attente: { depuis: '2026-10-12', jours: 2 }, retardClient: 0, sortie: '2026-10-20' })
    expect(urgenceCommande(e, '2026-10-16')).toBe('soon')
    expect(urgenceCommande(e, '2026-10-19')).toBe('late')
    // Still no answer Wed 21/10: 7 working days = 2 beyond the 5, the sortie slides by 2 — the client’s delay.
    expect(calendrierTraitement(e.traitement!, '2026-10-21')).toMatchObject({ retardClient: 2, sortie: '2026-10-22' })
  })
  it('the client answered late: its overrun pushes the dyer’s chase date, a timely answer does not', () => {
    const base = { delaiFaits: faitsDelai({ demandeLe: '2026-10-05' }), ecruChezTeinturier: 1 }
    // Sent 12/10, accepted 21/10 = 7 working days: 2 of delay, the dyer is expected 22/10 instead of 20/10.
    const tard = etatCommande(commande({ ...base, lots: [lot({ reception: null, coloris: soum({ requise: true, le: '2026-10-12', accepte: true, reponseLe: '2026-10-21' }), okRamerLe: '2026-10-21' })] }))
    expect(tard).toMatchObject({ main: 'teinturier', relance: '2026-10-22' })
    expect(tard.traitement).toMatchObject({ retardClient: 2 })
    const cal = calendrierTraitement(tard.traitement!, '2026-10-21')
    expect(cal.jours.filter((j) => j === 'client')).toHaveLength(7)
    expect(cal).toMatchObject({ attente: null, sortie: '2026-10-22' })
    // The délai already moved by a report due to the client (2 days): not pushed a second time.
    const reporte = etatCommande(commande({ ...base, delai: '2026-10-22', lignesOuvertes: [{ id: 7, delai: '2026-10-22', reporteClient: 2 }], lots: [lot({ reception: null, idligne: 7, coloris: soum({ requise: true, le: '2026-10-12', accepte: true, reponseLe: '2026-10-21' }), okRamerLe: '2026-10-21' })] }))
    expect(reporte).toMatchObject({ main: 'teinturier', relance: '2026-10-22' })
    expect(calendrierTraitement(reporte.traitement!, '2026-10-21')).toMatchObject({ retardClient: 2, resteClient: 0, sortie: '2026-10-22' })
    // Answered in 3 working days: nothing moves.
    const aTemps = etatCommande(commande({ ...base, lots: [lot({ reception: null, coloris: soum({ requise: true, le: '2026-10-12', accepte: true, reponseLe: '2026-10-15' }), okRamerLe: '2026-10-15' })] }))
    expect(aTemps).toMatchObject({ main: 'teinturier', relance: '2026-10-20' })
    // A lot of ANOTHER line waiting on the client does not hold the line the card follows.
    const autre = etatCommande(commande({ ...base, lignesOuvertes: [{ id: 7, delai: '2026-10-20' }, { id: 8, delai: '2026-10-27' }], lots: [lot({ reception: null, idligne: 8, coloris: soum({ requise: true, le: '2026-10-12' }) })] }))
    expect(autre).toMatchObject({ main: 'teinturier', relance: '2026-10-20' })
  })
  it('received, all back: en contrôle, no chase on the order, each lot keeps its own (9016: soumis + ACP; 2026-11-03)', () => {
    const e = etatCommande(commande({
      lots: [
        lot({ lot: 'MA109328', etat: 5, mesuresTeinturier: true, stabilites: soum({ le: '2026-10-08' }) }),
        lot({ lot: 'MA109329', reception: '2026-10-09' }),
      ],
    }))
    expect(e).toMatchObject({ etape: 'en_controle', main: null, relance: null })
    expect(urgenceCommande(e, '2026-10-30')).toBeNull()
    expect(e.lots.map((l) => [l.etape, l.relance])).toEqual([['soumis', '2026-10-15'], ['attente_mesures', '2026-10-16']])
  })
  it('every lot validated, écru still at the dyer: back « en traitement » on the délai (2026-11-02)', () => {
    const e = etatCommande(commande({ lots: [lot({ etat: 3 })], ecruChezTeinturier: 11 }))
    expect(e).toMatchObject({ etape: 'en_teinture', main: 'teinturier', relance: '2026-10-20', solde: true, lots: [] })
  })
  it('a lot still open: « en contrôle », écru at the dyer or not (2026-11-02)', () => {
    const tout = etatCommande(commande({ lots: [lot({ etat: 5, mesuresTeinturier: true, stabilites: soum({ le: '2026-10-20' }) })], ecruChezTeinturier: 0 }))
    expect(tout.etape).toBe('en_controle')
    const partiel = etatCommande(commande({ lots: [lot({ etat: 5, mesuresTeinturier: true, stabilites: soum({ le: '2026-10-20' }) })], ecruChezTeinturier: 4 }))
    // Écru still at the dyer: the order keeps the dyer's délai for that solde.
    expect(partiel).toMatchObject({ etape: 'en_controle', solde: true, main: 'teinturier', relance: '2026-10-20' })
  })
  it('a lot in reprise is back at the dyer: the order is « en traitement » again on its line’s délai (9061, LIVA #1377)', () => {
    // Line délai 21/10, lot received 21/10, refused by the client, sent back 16/11.
    const repris = lot({ lot: 'MA109438', idligne: 9034, etat: 2, reception: '2026-10-21', repriseOuverte: true, repriseMotif: 'Refus client : retraits non conformes (7 %)' })
    const c = commande({ delai: '2026-10-21', lignesOuvertes: [{ id: 9034, delai: '2026-10-21' }], lots: [repris] })
    const e = etatCommande(c)
    expect(e).toMatchObject({ etape: 'en_teinture', main: 'teinturier', relance: '2026-10-21', solde: false })
    expect(e.enReprise).toEqual([{ lot: 'MA109438', idligne: 9034, motif: 'Refus client : retraits non conformes (7 %)' }])
    expect(e.lots.map((l) => l.etape)).toEqual(['en_reprise'])
    // A reprise is a delay: red at once, on the délai of before.
    expect(urgenceCommande(e, '2026-11-16')).toBe('late')
    // The délai pushed after the dyer's answer: the order follows the new date, chased like any délai.
    const pousse = etatCommande({ ...c, delai: '2026-11-25', lignesOuvertes: [{ id: 9034, delai: '2026-11-25' }] })
    expect(pousse).toMatchObject({ etape: 'en_teinture', main: 'teinturier', relance: '2026-11-25' })
    expect(urgenceCommande(pousse, '2026-11-16')).toBeNull()
    expect(urgenceCommande(pousse, '2026-11-25')).toBe('late')
    // A lot « en reprise » from before 2026-10-12 (état 2, no reprise row): the same.
    const ancien = etatCommande(commande({ lots: [lot({ etat: 2 })] }))
    expect(ancien).toMatchObject({ etape: 'en_teinture', main: 'teinturier', relance: '2026-10-20' })
  })
  it('reprises alone: the délai followed is the reworked lot’s line, not an older delivered line', () => {
    const e = etatCommande(commande({
      delai: '2026-10-01',
      delaisLignes: ['2026-10-01', '2026-11-25'],
      lignesOuvertes: [{ id: 1, delai: '2026-10-01' }, { id: 2, delai: '2026-11-25' }],
      lots: [lot({ lot: 'MA1', idligne: 1, etat: 3 }), lot({ lot: 'MA2', idligne: 2, etat: 2, repriseOuverte: true })],
    }))
    expect(e).toMatchObject({ etape: 'en_teinture', relance: '2026-11-25' })
    expect(e.traitement?.delai).toBe('2026-11-25')
  })
  it('a lot in reprise beside a lot in control: « en contrôle », and the dyer’s délai for the reprise', () => {
    const e = etatCommande(commande({
      lignesOuvertes: [{ id: 7, delai: '2026-10-20' }],
      lots: [
        lot({ lot: 'MA1', idligne: 7, reception: '2026-10-19' }),
        lot({ lot: 'MA2', idligne: 7, etat: 2, reception: '2026-10-19', repriseOuverte: true }),
      ],
    }))
    expect(e).toMatchObject({ etape: 'en_controle', main: 'teinturier', relance: '2026-10-20' })
    expect(e.lots.map((l) => l.etape)).toEqual(['attente_mesures', 'en_reprise'])
  })
  it('a lot open before any reception (coloris validé, en rame): still « en traitement » on the délai (9096, 2026-11-03)', () => {
    const enRame = lot({ reception: null, coloris: soum({ requise: true, le: '2026-10-09', accepte: true }), okRamerLe: '2026-10-12' })
    const e = etatCommande(commande({ lots: [enRame], ecruChezTeinturier: 1 }))
    expect(e).toMatchObject({ etape: 'en_teinture', main: 'teinturier', relance: '2026-10-20', solde: false })
    expect(e.lots.map((l) => l.etape)).toEqual(['en_rame'])
    // The first reception opens the control phase.
    expect(etatCommande(commande({ lots: [enRame, lot({ lot: 'MA2', reception: '2026-10-21' })], ecruChezTeinturier: 1 })).etape).toBe('en_controle')
  })
  it('everything validated and back: ours to close (8565)', () => {
    expect(etatCommande(commande({ lots: [lot({ etat: 3 })] }))).toMatchObject({ etape: 'a_cloturer', main: 'nous' })
  })
  it('soldée wins', () => {
    expect(etatCommande(commande({ est_soldee: true, lots: [lot()] })).etape).toBe('terminee')
  })
})

describe('urgenceLot: the Suivi lots card colour', () => {
  it('dyer measures: red from the relance day, amber the working day before', () => {
    const l = lot({ reception: '2026-10-09' }) // relance 2026-10-16
    expect(urgenceLot(l, '2026-10-14')).toBeNull()
    expect(urgenceLot(l, '2026-10-15')).toEqual({ niveau: 'ambre', raison: 'Relancer l’ennoblisseur le 16/10' })
    expect(urgenceLot(l, '2026-10-16')).toEqual({ niveau: 'rouge', raison: 'Relancer l’ennoblisseur aujourd’hui' })
    expect(urgenceLot(l, '2026-10-19')).toEqual({ niveau: 'rouge', raison: 'Relancer l’ennoblisseur depuis le 16/10' })
  })
  it('client: 5 working days after the soumission', () => {
    expect(urgenceLot(lot({ stabilites: soum({ le: '2026-10-09' }) }), '2026-10-16')?.raison).toBe('Relancer le client aujourd’hui')
  })
  it('ours: « À traiter »', () => {
    expect(urgenceLot(lot({ mesuresTeinturier: true }), '2026-10-19')).toEqual({ niveau: 'rouge', raison: 'À traiter depuis le 15/10' })
  })
  it('reprise: no date, no colour; validated: only while a rapport de contrôle is owed', () => {
    expect(urgenceLot(lot({ etat: 2 }), '2026-10-30')).toBeNull()
    expect(urgenceLot(lot({ etat: 3 }), '2026-10-30')).toBeNull()
    expect(urgenceLot(lot({ etat: 3, rcAEnvoyer: ['SIMONE PERELE'] }), '2026-10-30')?.niveau).toBe('rouge')
  })
})

describe('helpers', () => {
  it('working days skip the weekend', () => {
    expect(plusJoursOuvres('2026-10-09', 1)).toBe('2026-10-12')
    expect(plusJoursOuvres('2026-10-07', 3)).toBe('2026-10-12')
  })
  it('urgency: red on the chase day, amber the working day before', () => {
    const e = etatCommande(commande()) // en traitement, délai 20/10
    expect(urgenceCommande(e, '2026-10-20')).toBe('late')
    expect(urgenceCommande(e, '2026-10-19')).toBe('soon')
    expect(urgenceCommande(e, '2026-10-16')).toBeNull()
  })
  it('waiting for the délai: neutral on the échéance, red the next working day, never amber (2026-11-02)', () => {
    const e = etatCommande(commande({ rangStatut: 1, delaiFaits: faitsDelai({ dateNotif: '2026-10-09' }) })) // Friday
    expect(urgenceCommande(e, '2026-10-09')).toBeNull()
    expect(urgenceCommande(e, '2026-10-12')).toBe('late')
  })
  it('lot keys: the digits — an old reprise suffix names the same lot (reprise is data now)', () => {
    expect(cleLot('MA109331')).toBe('109331')
    expect(cleLot('109331/s')).toBe('109331')
    expect(cleLot('MA109102R')).toBe('109102')
    expect(cleLot('MA109090 REPRIS')).toBe('109090')
  })
})

describe('prealableAttendu: the card leads with the step the flow waits for (2026-11-05)', () => {
  const attendu = (l: LotFait) => prealableAttendu(etapeLot(l), prealablesDetail(l))
  it('the dyer measures: the dyer’s move in front, our tirelle after', () => {
    expect(attendu(lot())).toMatchObject({ texte: 'Ennoblisseur : laize, poids, stabilités', main: 'teinturier' })
    expect(attendu(lot({ mesuresTeinturier: true }))).toMatchObject({ texte: 'Malterre : laize, poids, stabilités', main: 'nous' })
  })
  it('a soumission out waits on the client before anything else', () => {
    const l = lot({ stabilites: soum({ le: '2026-10-20' }) })
    expect(attendu(l)).toMatchObject({ texte: 'Réponse client : stabilités', main: 'client' })
  })
  it('not received, coloris accepted: ours to pass on the « coloris validé »', () => {
    const l = lot({ reception: null, coloris: soum({ le: '2026-10-15', accepte: true }) })
    expect(attendu(l)).toMatchObject({ texte: 'OK coloris à transmettre à l’ennoblisseur', main: 'nous' })
  })
  it('not received, nothing to answer: the lot itself is awaited from the dyer', () => {
    expect(attendu(lot({ reception: null }))).toMatchObject({ texte: 'Lot pas encore reçu', main: 'teinturier' })
  })
  it('every prealable belongs to a step and nothing left = null', () => {
    const controle = { mesuresTeinturier: true, tirelleMesuree: true }
    expect(attendu(lot({ ...controle, rcAEnvoyer: ['LEMAHIEU'] }))).toMatchObject({ etape: 'rc_a_envoyer', main: 'nous' })
    expect(attendu(lot(controle))).toBeNull()
  })
})

describe('depuisEtape: how long the lot has been at its step (2026-11-05)', () => {
  it('the controls count from the reception, 5 working days', () => {
    expect(depuisEtape(lot())).toEqual({ depuis: '2026-10-08', delai: 5 })
    // Thursday 08/10 → Tuesday 13/10: Fri, Mon, Tue = 3 working days.
    expect(joursOuvresDepuis('2026-10-08', '2026-10-13')).toBe(3)
  })
  it('a soumission counts from its sending, a reprise has no date', () => {
    expect(depuisEtape(lot({ stabilites: soum({ le: '2026-10-20' }) }))).toEqual({ depuis: '2026-10-20', delai: 5 })
    expect(depuisEtape(lot({ repriseOuverte: true }))).toBeNull()
  })
})

describe('« passer en urgence » chez l’ennoblisseur (lib/urgence-sst.ts, Vincent 2026-11-16)', () => {
  // The dyer was asked on the 20/10, its answer due the 22/10.
  const urgence = (etat: 'attente' | 'repondue' = 'attente') => ({ etat, reponseAttendue: '2026-10-22' })
  it('en traitement: neutral while the answer is awaited, red once it is overdue — whatever the délai says', () => {
    // Délai far away (30/10): nothing to chase on the dyeing itself.
    const e = etatCommande(commande({ delai: '2026-10-30', urgences: { lignes: [urgence()], couvreAttente: false } }))
    expect(e.etape).toBe('en_teinture')
    expect(urgenceCommande(e, '2026-10-21')).toBeNull()
    expect(urgenceCommande(e, '2026-10-22')).toBeNull() // the day itself: still expected
    expect(urgenceCommande(e, '2026-10-23')).toBe('late')
    expect(urgenceDemandeeDe(e, '2026-10-21')).toBe('attente')
    expect(urgenceDemandeeDe(e, '2026-10-23')).toBe('a_relancer')
  })
  it('an urgency awaited does not hide a délai that is late on its own', () => {
    const e = etatCommande(commande({ delai: '2026-10-20', urgences: { lignes: [urgence()], couvreAttente: false } }))
    expect(urgenceCommande(e, '2026-10-21')).toBe('late')
  })
  it('attente délai: not red while every undated line was pressed and awaits its answer', () => {
    const faits = faitsDelai({ dateNotif: '2026-10-12' }) // chase due the 13/10
    const sans = etatCommande(commande({ rangStatut: 1, delaiFaits: faits }))
    expect(urgenceCommande(sans, '2026-10-21')).toBe('late')
    const pressee = etatCommande(commande({ rangStatut: 1, delaiFaits: faits, urgences: { lignes: [urgence()], couvreAttente: true } }))
    expect(urgenceCommande(pressee, '2026-10-21')).toBeNull()
    expect(urgenceCommande(pressee, '2026-10-23')).toBe('late') // the urgency's own chase
    // A line nobody pressed keeps the order on the délai chase.
    const partielle = etatCommande(commande({ rangStatut: 1, delaiFaits: faits, urgences: { lignes: [urgence()], couvreAttente: false } }))
    expect(urgenceCommande(partielle, '2026-10-21')).toBe('late')
  })
  it('answered, or the order closed: nothing is asked any more', () => {
    const repondue = etatCommande(commande({ delai: '2026-10-30', urgences: { lignes: [urgence('repondue')], couvreAttente: false } }))
    expect(urgenceDemandeeDe(repondue, '2026-10-25')).toBeNull()
    expect(urgenceCommande(repondue, '2026-10-25')).toBeNull()
    expect(repondue.urgences?.lignes).toHaveLength(1) // the siren stays
    const close = etatCommande(commande({ est_soldee: true, urgences: { lignes: [urgence()], couvreAttente: false } }))
    expect(close.urgences).toBeUndefined()
    expect(urgenceCommande(close, '2026-10-25')).toBeNull()
  })
})

describe('a lot « en rame » is due with its line’s délai (Vincent 2026-11-26)', () => {
  // Bon de commande Monday 2026-10-05, the line due Friday 2026-10-23.
  const base = {
    delaiFaits: faitsDelai({ demandeLe: '2026-10-05' }), delai: '2026-10-23',
    lignesOuvertes: [{ id: 7, delai: '2026-10-23' }, { id: 8, delai: '2026-10-30' }],
  }
  const enRame = (p: Partial<LotFait> = {}) =>
    lot({ reception: null, idligne: 7, coloris: soum({ le: '2026-10-12', accepte: true, reponseLe: '2026-10-14' }), okRamerLe: '2026-10-14', ...p })

  it('the dyer’s time on a line runs from the bon to that line’s délai', () => {
    const temps = tempsDesLignes(commande({ ...base, lots: [enRame()] }), '2026-10-15')
    expect(temps.get(7)).toEqual({ depuis: '2026-10-05', echeance: '2026-10-23' })
    expect(temps.get(8)).toEqual({ depuis: '2026-10-05', echeance: '2026-10-30' })
  })

  it('…pushed by what the client took beyond its five days on that line’s coloris, not by another line’s', () => {
    // Asked Monday 12, answered Thursday 22: eight working days, three beyond the client’s five.
    const lent = enRame({ coloris: soum({ le: '2026-10-12', accepte: true, reponseLe: '2026-10-22' }), okRamerLe: '2026-10-22' })
    const temps = tempsDesLignes(commande({ ...base, lots: [lent] }), '2026-10-23')
    expect(temps.get(7)!.echeance).toBe(plusJoursOuvres('2026-10-23', 3))
    expect(temps.get(8)!.echeance).toBe('2026-10-30')
    // A report already put those days on the délai: not pushed twice.
    const reporte = tempsDesLignes(commande({ ...base, lignesOuvertes: [{ id: 7, delai: '2026-10-23', reporteClient: 3 }], lots: [lent] }), '2026-10-23')
    expect(reporte.get(7)!.echeance).toBe('2026-10-23')
  })

  it('the lot is chased on that day, and its window is the line’s: a BL on the last day is on time', () => {
    const c = avecTempsDesLignes(commande({ ...base, lots: [enRame()] }), '2026-10-15')
    expect(c.lots[0].tempsLigne).toEqual({ depuis: '2026-10-05', echeance: '2026-10-23' })
    expect(etatLot(c.lots[0])).toMatchObject({ etape: 'en_rame', main: 'teinturier', relance: '2026-10-23' })
    // Fourteen working days from the bon to the délai — no longer three from the « coloris validé » mail.
    expect(depuisEtape(c.lots[0])).toEqual({ depuis: '2026-10-05', delai: 14 })
  })

  it('a lot whose line carries no délai keeps the three days after the mail', () => {
    const c = avecTempsDesLignes(commande({ ...base, lots: [enRame({ idligne: 99 })] }), '2026-10-15')
    expect(c.lots[0].tempsLigne).toBeUndefined()
    expect(etatLot(c.lots[0]).relance).toBe('2026-10-19')
    expect(depuisEtape(c.lots[0])).toEqual({ depuis: '2026-10-14', delai: 3 })
  })

  it('nothing changes for the other steps of a lot', () => {
    const recu = avecTempsDesLignes(commande({ ...base, lots: [lot({ idligne: 7 })] }), '2026-10-15').lots[0]
    expect(depuisEtape(recu)).toEqual({ depuis: '2026-10-08', delai: 5 })
  })
})
