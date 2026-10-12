import { describe, expect, it } from 'vitest'
import {
  cleLot,
  etapeLot,
  etatCommande,
  etatLot,
  plusJoursOuvres,
  urgenceCommande,
  type CommandeFait,
  type LotFait,
} from './cycle-ennoblissement.js'

function lot(p: Partial<LotFait> = {}): LotFait {
  return {
    lot: 'MA109377', idsuivilot: 1, etat: 1, reception: '2026-10-08',
    mesuresTeinturier: false, tirelleMesuree: false, soumissionRequise: false, soumisLe: null, ...p,
  }
}

function commande(p: Partial<CommandeFait> = {}): CommandeFait {
  return {
    est_soldee: false, rangStatut: 2, relanceDelai: null, bonEnvoyeLe: '2026-09-14',
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
    expect(etapeLot(lot({ etat: 5, mesuresTeinturier: true, soumisLe: '2026-10-08' }))).toBe('soumis')
  })
  it('controlled: à soumettre when the client asks it for this reference, else à valider', () => {
    expect(etapeLot(lot({ mesuresTeinturier: true, tirelleMesuree: true, soumissionRequise: true }))).toBe('a_soumettre')
    expect(etapeLot(lot({ mesuresTeinturier: true, tirelleMesuree: true }))).toBe('a_valider')
    // Laëtitia measured the tirelle without the dyer's measures (5965, 09/10)
    expect(etapeLot(lot({ tirelleMesuree: true }))).toBe('a_valider')
  })
  it('the lot state wins: reprise, validated (« ok à ramer » after a soumission), shipped', () => {
    expect(etapeLot(lot({ etat: 2, soumisLe: '2026-10-01' }))).toBe('en_reprise')
    expect(etapeLot(lot({ etat: 3, soumisLe: '2026-10-01' }))).toBe('valide')
    expect(etapeLot(lot({ etat: 4 }))).toBe('expedie')
  })
  it('an open reprise (lib/reprises.ts) puts the lot at the dyer, whatever the old état', () => {
    expect(etapeLot(lot({ etat: 1, tirelleMesuree: true, repriseOuverte: true }))).toBe('en_reprise')
    expect(etatLot(lot({ repriseOuverte: true, reprises: 2 })).reprises).toBe(2)
  })
  it('attente de décision without a soumission is ours to decide', () => {
    expect(etapeLot(lot({ etat: 5, mesuresTeinturier: true }))).toBe('a_valider')
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
    expect(etatLot(lot({ soumisLe: '2026-10-09' }))).toMatchObject({ main: 'client', relance: '2026-10-16' })
  })
  it('reprise: the dyer gives the date in the point, nothing computed', () => {
    expect(etatLot(lot({ etat: 2 }))).toMatchObject({ main: 'teinturier', relance: null })
  })
})

describe('etatCommande', () => {
  it('before any lot: à envoyer, attente délai (relance, else bon + 3 working days), en teinture (the délai)', () => {
    expect(etatCommande(commande({ rangStatut: 0 })).etape).toBe('non_envoye')
    expect(etatCommande(commande({ rangStatut: 1, relanceDelai: '2026-10-12' }))).toMatchObject({ etape: 'attente_delai', main: 'teinturier', relance: '2026-10-12' })
    expect(etatCommande(commande({ rangStatut: 1, bonEnvoyeLe: '2026-10-09' })).relance).toBe('2026-10-14')
    expect(etatCommande(commande())).toMatchObject({ etape: 'en_teinture', main: 'teinturier', relance: '2026-10-20' })
  })
  it('en réception: the earliest chase among the open lots (9016: soumis + ACP)', () => {
    const e = etatCommande(commande({
      lots: [
        lot({ lot: 'MA109328', etat: 5, mesuresTeinturier: true, soumisLe: '2026-10-08' }),
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

describe('helpers', () => {
  it('working days skip the weekend', () => {
    expect(plusJoursOuvres('2026-10-09', 1)).toBe('2026-10-12')
    expect(plusJoursOuvres('2026-10-07', 3)).toBe('2026-10-12')
  })
  it('urgency: red on the chase day, amber the working day before', () => {
    const e = etatCommande(commande({ rangStatut: 1, relanceDelai: '2026-10-12' }))
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
