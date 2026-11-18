import { describe, expect, it } from 'vitest'
import { raisonCommandeSst, tricobotAttend, type FaitsRaisonSst } from './raison-commande-sst.js'

const f = (over: Partial<FaitsRaisonSst> = {}): FaitsRaisonSst => ({ phase: 'en_traitement', tricoteur: false, ...over })

describe('raisonCommandeSst', () => {
  it('a neutral card prints nothing', () => {
    expect(raisonCommandeSst(f(), null)).toBeNull()
  })

  it('Tricobot waiting comes first, whatever the step', () => {
    expect(raisonCommandeSst(f({ phase: 'attente_delai' }), 'late', { aValider: 0, aide: 1 })).toBe('Tricobot demande ton avis')
    expect(raisonCommandeSst(f(), 'late', { aValider: 1, aide: 0, bl: 1 })).toBe('Tricobot : réception à valider')
    expect(raisonCommandeSst(f(), 'late', { aValider: 1, aide: 0, bl: 0 })).toBe('Tricobot : délai à valider')
    expect(raisonCommandeSst(f(), 'late', { aValider: 2, aide: 1, bl: 1 })).toBe('Tricobot : délais à valider')
  })

  it('Tricobot having written alone is not a wait', () => {
    expect(tricobotAttend({ aValider: 0, aide: 0 })).toBe(false)
    expect(raisonCommandeSst(f(), null, { aValider: 0, aide: 0 })).toBeNull()
  })

  it('an urgency to chase names the partner, even on a card the délai rule leaves neutral', () => {
    expect(raisonCommandeSst(f({ urgenceDemandee: 'a_relancer', tricoteur: true }), null)).toBe('Urgence demandée : relancer le tricoteur')
    expect(raisonCommandeSst(f({ urgenceDemandee: 'a_relancer' }), 'late')).toBe('Urgence demandée : relancer l’ennoblisseur')
    // Awaited: nothing to do yet.
    expect(raisonCommandeSst(f({ urgenceDemandee: 'attente' }), null)).toBeNull()
  })

  it('each step says its action', () => {
    expect(raisonCommandeSst(f({ phase: 'attente_delai' }), 'late')).toBe('Délai à relancer')
    expect(raisonCommandeSst(f({ phase: 'attente_delai' }), 'soon')).toBe('Délai à relancer demain')
    expect(raisonCommandeSst(f({ phase: 'non_envoye' }), 'late')).toBe('Bon de commande à envoyer')
    expect(raisonCommandeSst(f({ phase: 'a_cloturer' }), 'late')).toBe('Commande à clôturer')
    expect(raisonCommandeSst(f({ phase: 'fil_a_affecter' }), 'late')).toBe('Fil à affecter')
    expect(raisonCommandeSst(f({ phase: 'a_lancer' }), 'late')).toBe('À lancer')
    expect(raisonCommandeSst(f({ phase: 'a_lancer' }), 'soon')).toBe('À lancer bientôt')
  })

  it('in treatment: the chase date first, else the earliest délai', () => {
    expect(raisonCommandeSst(f({ relance: '2026-11-12', earliestDelivery: '20261120' }), 'late')).toBe('Délai du 12/11 dépassé')
    expect(raisonCommandeSst(f({ earliestDelivery: '20261120' }), 'soon')).toBe('Délai le 20/11 : s’assurer du départ')
    expect(raisonCommandeSst(f(), 'late')).toBe('Sans délai : le demander')
    expect(raisonCommandeSst(f(), 'soon')).toBeNull()
  })

  it('a coloris soumission at the client: the client is the one to chase', () => {
    expect(raisonCommandeSst(f({ main: 'client', relance: '2026-11-12' }), 'late')).toBe('Réponse coloris : relancer le client')
    expect(raisonCommandeSst(f({ main: 'client' }), 'soon')).toBe('Réponse coloris : dernier jour demain')
  })
})
