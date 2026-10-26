import { describe, expect, it } from 'vitest'
import {
  cleLot,
  etapeLot,
  faitSoumission,
  etatCommande,
  etatLot,
  plusJoursOuvres,
  prealablesValidation,
  urgenceCommande,
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
function soum(p: { requise?: boolean; le?: string; accepte?: boolean; commentaire?: string } = {}): SoumissionFait {
  return {
    requise: p.requise ?? true,
    envoyeeLe: p.le ?? null,
    reponse: p.accepte === undefined ? null : { accepte: p.accepte, commentaire: p.commentaire ?? '', le: `${p.le ?? '2026-10-20'} 10:00:00` },
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
      'Contrôle ennoblisseur incomplet (laize, poids, stabilités de l’ennoblisseur).',
      'Contrôle Malterre incomplet (laize, poids, stabilités de la tirelle).',
      'Soumission des stabilités à envoyer.',
      'Rapport de contrôle à envoyer à SAS LA FABRIQUE.',
    ])
    // Only what is still missing is named (lib/controles-lot.ts, 2026-10-26).
    expect(prealablesValidation(lot({ tirelleMesuree: true, manqueTeinturier: ['stabilités'] }))).toEqual([
      'Contrôle ennoblisseur incomplet (stabilités de l’ennoblisseur).',
    ])
    expect(prealablesValidation(lot({ ...controle, stabilites: soum({ le: '2026-10-20' }) }))).toEqual(['Réponse du client à la soumission des stabilités attendue.'])
    expect(prealablesValidation(lot({ ...controle, stabilites: soum({ le: '2026-10-20', accepte: true }) }))).toEqual([])
    expect(prealablesValidation(lot({ ...controle, repriseOuverte: true }))).toEqual(['Le lot est en reprise chez l’ennoblisseur.'])
    expect(prealablesValidation(lot({ ...controle, etat: 3 }))).toEqual(['Lot déjà validé.'])
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
      'Validation du coloris à transmettre à l’ennoblisseur.',
      'Lot pas encore réceptionné.',
    ])
    expect(prealablesValidation(lot(avantRame))).toEqual([
      'Réponse du client à la soumission coloris attendue.',
      'Lot pas encore réceptionné.',
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
  it('dyer: measures next working day', () => {
    expect(etatLot(lot({ reception: '2026-10-09' }))).toMatchObject({ main: 'teinturier', relance: '2026-10-12' })
  })
  it('ACL « Attente contrôle Malterre »: ours, flagged after 1 working day', () => {
    expect(etatLot(lot({ reception: '2026-10-08', mesuresTeinturier: true }))).toMatchObject({ main: 'nous', relance: '2026-10-09' })
  })
  it('client: 5 working days after the soumission', () => {
    expect(etatLot(lot({ stabilites: soum({ le: '2026-10-09' }) }))).toMatchObject({ main: 'client', relance: '2026-10-16' })
  })
  it('reprise: the dyer gives the date in the point, nothing computed', () => {
    expect(etatLot(lot({ etat: 2 }))).toMatchObject({ main: 'teinturier', relance: null })
  })
})

describe('etatCommande', () => {
  it('before any lot: à envoyer, attente délai (relance, else bon + 3 working days), en teinture (the délai)', () => {
    expect(etatCommande(commande({ rangStatut: 0 })).etape).toBe('non_envoye')
    expect(etatCommande(commande({ rangStatut: 1, delaiFaits: faitsDelai({ dateNotif: '2026-10-12' }) }))).toMatchObject({ etape: 'attente_delai', main: 'teinturier', relance: '2026-10-12' })
    expect(etatCommande(commande({ rangStatut: 1, delaiFaits: faitsDelai({ demandeLe: '2026-10-09' }) })).relance).toBe('2026-10-14')
    expect(etatCommande(commande())).toMatchObject({ etape: 'en_teinture', main: 'teinturier', relance: '2026-10-20' })
  })
  it('en réception: the earliest chase among the open lots (9016: soumis + ACP)', () => {
    const e = etatCommande(commande({
      lots: [
        lot({ lot: 'MA109328', etat: 5, mesuresTeinturier: true, stabilites: soum({ le: '2026-10-08' }) }),
        lot({ lot: 'MA109329', reception: '2026-10-09' }),
      ],
    }))
    expect(e).toMatchObject({ etape: 'en_reception', main: 'teinturier', relance: '2026-10-12' })
    expect(e.lots.map((l) => l.etape)).toEqual(['soumis', 'attente_mesures'])
  })
  it('validated lots drop out; « solde » while écru is still at the dyer', () => {
    const e = etatCommande(commande({ lots: [lot({ etat: 3 })], ecruChezTeinturier: 11 }))
    expect(e).toMatchObject({ etape: 'en_reception', main: 'teinturier', relance: '2026-10-20', solde: true, lots: [] })
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
    const l = lot({ reception: '2026-10-09' }) // relance 2026-10-12
    expect(urgenceLot(l, '2026-10-08')).toBeNull()
    expect(urgenceLot(l, '2026-10-09')).toEqual({ niveau: 'ambre', raison: 'Relancer l’ennoblisseur le 12/10' })
    expect(urgenceLot(l, '2026-10-12')).toEqual({ niveau: 'rouge', raison: 'Relancer l’ennoblisseur aujourd’hui' })
    expect(urgenceLot(l, '2026-10-14')).toEqual({ niveau: 'rouge', raison: 'Relancer l’ennoblisseur depuis le 12/10' })
  })
  it('client: 5 working days after the soumission', () => {
    expect(urgenceLot(lot({ stabilites: soum({ le: '2026-10-09' }) }), '2026-10-16')?.raison).toBe('Relancer le client aujourd’hui')
  })
  it('ours: « À traiter »', () => {
    expect(urgenceLot(lot({ mesuresTeinturier: true }), '2026-10-12')).toEqual({ niveau: 'rouge', raison: 'À traiter depuis le 09/10' })
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
    const e = etatCommande(commande({ rangStatut: 1, delaiFaits: faitsDelai({ dateNotif: '2026-10-12' }) }))
    expect(urgenceCommande(e, '2026-10-12')).toBe('late')
    expect(urgenceCommande(e, '2026-10-09')).toBe('soon')
    expect(urgenceCommande(e, '2026-10-08')).toBeNull()
  })
  it('lot keys: the digits — an old reprise suffix names the same lot (reprise is data now)', () => {
    expect(cleLot('MA109331')).toBe('109331')
    expect(cleLot('109331/s')).toBe('109331')
    expect(cleLot('MA109102R')).toBe('109102')
    expect(cleLot('MA109090 REPRIS')).toBe('109090')
  })
})
