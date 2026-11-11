import { describe, expect, it } from 'vitest'
import {
  cleLot,
  etapeLot,
  faitSoumission,
  etatCommande,
  etatLot,
  depuisEtape,
  joursOuvresDepuis,
  plusJoursOuvres,
  prealableAttendu,
  prealablesDetail,
  prealablesValidation,
  urgenceCommande,
  calendrierTraitement,
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
    const repris = etatCommande(commande({ lots: [lot({ etat: 2 })], ecruChezTeinturier: 0 }))
    expect(repris).toMatchObject({ etape: 'en_controle', main: null, relance: null })
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
