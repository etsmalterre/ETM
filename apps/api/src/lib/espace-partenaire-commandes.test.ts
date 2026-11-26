import { describe, expect, it } from 'vitest'
import { SANS_SOUMISSION, type EtapeLot, type LotFait } from './cycle-ennoblissement.js'
import {
  article, debutDouzeMois, etapeCommandePartenaire, etapeLignePartenaire, etapeLotPartenaire, lotsVus, LOT_A_VOUS,
  deuxMoisAvant, fenetre, fenetreCommande, fenetreLot, LOT_MESURABLE, mesuresDuLot, mesuresMalterre, sansMouvementDepuis, tolerancesRef,
  respectCommande, libelleDefaut,
} from './espace-partenaire-commandes.js'
import { CONTROLES_PAR_DEFAUT, type ControlesRef } from './controles-lot.js'

describe('the partner’s time at a step', () => {
  // Monday 2026-11-23 … Friday 2026-11-27, no public holiday that week.
  it('counts working days, and is up on the échéance or the working day after, by the step', () => {
    expect(fenetre('2026-11-23', '2026-11-26', '2026-11-24', false)).toEqual({ depuis: '2026-11-23', echeance: '2026-11-26', jours: 3, ecoules: 1, depassee: false })
    // A délai to give: nothing to do on the échéance itself, red the working day after.
    expect(fenetre('2026-11-23', '2026-11-26', '2026-11-26', false).depassee).toBe(false)
    expect(fenetre('2026-11-23', '2026-11-26', '2026-11-27', false).depassee).toBe(true)
    // A lot's window, a délai of treatment: red on the day itself.
    expect(fenetre('2026-11-23', '2026-11-26', '2026-11-26', true).depassee).toBe(true)
    // The weekend is not counted.
    expect(fenetre('2026-11-20', '2026-11-25', '2026-11-23', true)).toMatchObject({ jours: 3, ecoules: 1 })
  })
  it('an order: three working days to give its délai, then its own délai — nothing while Malterre works', () => {
    expect(fenetreCommande('delai_a_donner', null, '2026-11-23', '2026-11-24')).toMatchObject({ depuis: '2026-11-23', echeance: '2026-11-26', jours: 3, depassee: false })
    // The day ETM expects the answer wins (Malterre pushed it, or the pieces were already at the dyer).
    const delai = { demandeLe: '2026-11-23', echeance: '2026-11-24', derniereRelance: null, historique: [] }
    expect(fenetreCommande('delai_a_donner', { delai }, '2026-11-23', '2026-11-25')).toMatchObject({ echeance: '2026-11-24', jours: 1, depassee: true })
    const traitement = { depuis: '2026-11-02', delai: '2026-11-25', autres: [], attentes: [], retardClient: 0, reporteClient: 0 }
    expect(fenetreCommande('en_traitement', { traitement }, '2026-11-02', '2026-11-24')).toMatchObject({ depuis: '2026-11-02', echeance: '2026-11-25', depassee: false })
    expect(fenetreCommande('en_traitement', { traitement }, '2026-11-02', '2026-11-25')!.depassee).toBe(true)
    // What the client took beyond its five days on a coloris is not the dyer's: its délai is pushed by it.
    const avecClient = { ...traitement, attentes: [{ lot: 'MA1', du: '2026-11-09', au: '2026-11-18' }], retardClient: 2 }
    expect(fenetreCommande('en_traitement', { traitement: avecClient }, '2026-11-02', '2026-11-25')).toMatchObject({ echeance: '2026-11-27', depassee: false })
    expect(fenetreCommande('en_traitement', {}, '2026-11-02', '2026-11-25')).toBeNull()
    expect(fenetreCommande('en_controle', { traitement }, '2026-11-02', '2026-11-25')).toBeNull()
    expect(fenetreCommande('terminee', { traitement }, '2026-11-02', '2026-11-25')).toBeNull()
  })
  it('a lot: its line’s délai after the coloris validé and for a reprise, five days after the reception for its controls', () => {
    const lot = (p: Partial<LotFait>): LotFait => ({
      lot: 'MA1', idsuivilot: 1, etat: 1, reception: null, mesuresTeinturier: false, tirelleMesuree: false,
      coloris: SANS_SOUMISSION, stabilites: SANS_SOUMISSION, ...p,
    })
    // A lot to finish is due with its line's délai, counted from the bon de commande, as its order is.
    const temps = { depuis: '2026-11-02', echeance: '2026-11-27' }
    expect(fenetreLot(lot({ okRamerLe: '2026-11-23', tempsLigne: temps }), 'coloris_valide', '2026-11-24')).toMatchObject({ depuis: '2026-11-02', echeance: '2026-11-27', depassee: false })
    expect(fenetreLot(lot({ okRamerLe: '2026-11-23', tempsLigne: temps }), 'coloris_valide', '2026-11-27')!.depassee).toBe(true)
    // Only a line without a délai keeps the three days after the mail.
    expect(fenetreLot(lot({ okRamerLe: '2026-11-23' }), 'coloris_valide', '2026-11-24')).toMatchObject({ echeance: '2026-11-26', jours: 3, ecoules: 1, depassee: false })
    expect(fenetreLot(lot({ reception: '2026-11-18' }), 'mesures_a_transmettre', '2026-11-25')).toMatchObject({ echeance: '2026-11-25', jours: 5, ecoules: 5, depassee: true })
    // A lot back for a reprise is due with its line's délai too (usually pushed back with the reprise).
    expect(fenetreLot(lot({ reception: '2026-11-18', tempsLigne: temps }), 'en_reprise', '2026-11-25')).toMatchObject({ depuis: '2026-11-02', echeance: '2026-11-27', depassee: false })
    expect(fenetreLot(lot({ reception: '2026-11-18', tempsLigne: { depuis: '2026-11-02', echeance: '2026-11-20' } }), 'en_reprise', '2026-11-25')!.depassee).toBe(true)
    expect(fenetreLot(lot({ reception: '2026-11-18' }), 'en_reprise', '2026-11-25')).toBeNull()
    expect(fenetreLot(lot({ reception: '2026-11-18' }), 'coloris_refuse', '2026-11-25')).toBeNull()
    // Malterre's own time on the lot is never told.
    expect(fenetreLot(lot({ reception: '2026-11-18' }), 'en_controle', '2026-11-25')).toBeNull()
    expect(fenetreLot(lot({ reception: '2026-11-18' }), 'coloris_soumis', '2026-11-25')).toBeNull()
  })
})

describe('the lot’s page', () => {
  it('the list of lots goes two months back, to the same day', () => {
    expect(deuxMoisAvant('2026-11-26')).toBe('2026-09-26')
    expect(deuxMoisAvant('2026-01-15')).toBe('2025-11-15')
    // A day the earlier month does not have: its last one.
    expect(deuxMoisAvant('2026-04-30')).toBe('2026-02-28')
    expect(deuxMoisAvant('2026-08-31')).toBe('2026-06-30')
  })
  it('Malterre’s own measures: those asked of IT, same tolerances, the allongement by the fiche', () => {
    const bornes = { laizeMin: 150, laizeMax: 160, poidsMin: 145, poidsMax: 155, stabHauteur: -5, stabLargeur: -5, allongementHMin: 50, allongementHMax: 0, allongementLMin: 80, allongementLMax: 120 }
    const v = { laize: 156, poids: 0, stabH: -3, stabL: -1, vrillage: 7, allongementH: 60, allongementL: null }
    // By default everything but the allongement.
    expect(mesuresMalterre(v, bornes).map((m) => [m.cle, m.valeur, m.min, m.max])).toEqual([
      ['laize', 156, 150, 160], ['poids', null, 145, 155], ['stabH', -3, -5, 5], ['stabL', -1, -5, 5], ['vrillage', 7, null, 5],
    ])
    const avecAllongement: ControlesRef = { ...CONTROLES_PAR_DEFAUT, mesures: { ...CONTROLES_PAR_DEFAUT.mesures, malterre: { ...CONTROLES_PAR_DEFAUT.mesures.malterre, allongement: true } } }
    expect(mesuresMalterre(v, bornes, avecAllongement).slice(5)).toEqual([
      { cle: 'allongementH', valeur: 60, min: 50, max: null }, { cle: 'allongementL', valeur: null, min: 80, max: 120 },
    ])
    expect(mesuresMalterre(v, bornes, { ...CONTROLES_PAR_DEFAUT, malterre: false })).toEqual([])
  })
})

describe('the partner’s control of a lot', () => {
  const bornes = { laizeMin: 150, laizeMax: 160, poidsMin: 0, poidsMax: 165, stabHauteur: -5, stabLargeur: 0 }
  it('the tolerances are those of Suivi lots', () => {
    expect(tolerancesRef(bornes)).toEqual({
      laize: { min: 150, max: 160 },
      // A bound of 0 is « not set ».
      poids: { min: null, max: 165 },
      // One figure, a symmetric band; none = no tolerance.
      stabH: { min: -5, max: 5 },
      stabL: { min: null, max: null },
      // The same for every reference.
      vrillage: { min: null, max: 5 },
    })
    expect(tolerancesRef(undefined).laize).toEqual({ min: null, max: null })
  })
  it('only the measures the reference asks, 0 being « not measured » for a laize or a poids only', () => {
    const valeurs = { laize: 154, poids: 0, stabH: 0, stabL: null, vrillage: null }
    expect(mesuresDuLot(valeurs, bornes).map((m) => [m.cle, m.valeur])).toEqual([['laize', 154], ['poids', null], ['stabH', 0], ['stabL', null], ['vrillage', null]])
    const sansStab: ControlesRef = { ...CONTROLES_PAR_DEFAUT, mesures: { ...CONTROLES_PAR_DEFAUT.mesures, ennoblisseur: { ...CONTROLES_PAR_DEFAUT.mesures.ennoblisseur, stabilites: false, vrillage: false } } }
    expect(mesuresDuLot(valeurs, bornes, sansStab).map((m) => m.cle)).toEqual(['laize', 'poids'])
    expect(mesuresDuLot(valeurs, bornes, { ...CONTROLES_PAR_DEFAUT, ennoblisseur: false })).toEqual([])
  })
  it('measured once the partner finishes the lot, never before the stenter nor once validated', () => {
    expect([...LOT_MESURABLE].sort()).toEqual(['coloris_valide', 'en_controle', 'en_reprise', 'mesures_a_transmettre'])
  })
})

describe('a visitage defect as the partner reads it', () => {
  const d = (type_defaut: string | null, description: string | null, taille_cm = 0, nombre = 0) => libelleDefaut({ type_defaut, description, taille_cm, nombre })
  it('the tablet’s description, else the type with its count or its length', () => {
    expect(d('Maille', 'Maille 1m - 3m', 200)).toBe('Maille 1m - 3m')
    expect(d('Autre Barrure', 'Autre Barrure  Moins de 50 cm', 25)).toBe('Autre Barrure Moins de 50 cm')
    expect(d('Trou', 'Trou', 0, 2)).toBe('Trou ×2')
    expect(d('Trou', null, 0, 1)).toBe('Trou')
    expect(d('Maille', null, 25)).toBe('Maille 25 cm')
    expect(d('Démaillage', 'Démaillage', 0, 1)).toBe('Démaillage')
  })
  it('never somebody’s free text: only the type is told', () => {
    expect(d('Autre', 'voir avec le client X', 0, 1)).toBe('Autre')
    expect(d(null, 'tache près de la lisière', 0, 0)).toBe('Défaut')
  })
})

describe('the délai kept or not', () => {
  it('judges the first promise against the first lot, signed, in working days', () => {
    expect(respectCommande([{ promis: '2026-12-02', recu: '2026-11-25' }])).toEqual({ promis: '2026-12-02', recuLe: '2026-11-25', ecartJours: -5 })
    expect(respectCommande([{ promis: '2026-11-19', recu: '2026-11-25' }])?.ecartJours).toBe(4)
    expect(respectCommande([{ promis: '2026-11-25', recu: '2026-11-25' }])?.ecartJours).toBe(0)
  })
  it('the line the most late speaks for the order; nothing without a promise and a lot', () => {
    expect(respectCommande([{ promis: '2026-12-02', recu: '2026-11-25' }, { promis: '2026-11-19', recu: '2026-11-25' }, { promis: null, recu: '2026-11-25' }]))
      .toEqual({ promis: '2026-11-19', recuLe: '2026-11-25', ecartJours: 4 })
    expect(respectCommande([{ promis: '2026-11-19', recu: null }, { promis: null, recu: '2026-11-25' }])).toBeNull()
    expect(respectCommande([])).toBeNull()
  })
})

describe('twelve sliding months', () => {
  it('the window opens the first day of the month, the current one included', () => {
    expect(debutDouzeMois('2026-11-24')).toBe('2025-12-01')
    expect(debutDouzeMois('2026-12-31')).toBe('2026-01-01')
    expect(debutDouzeMois('2027-01-01')).toBe('2026-02-01')
  })
  it('an order moves while its bon de commande or a lot of it is in the window', () => {
    const depuis = '2025-12-01'
    // Sent in the window.
    expect(sansMouvementDepuis('2025-12-01', false, depuis)).toBe(false)
    // Sent before, a lot came back since: « Qualité de service » shows that line, its order must open.
    expect(sansMouvementDepuis('2025-10-20', true, depuis)).toBe(false)
    // Sent before, nothing since: out once finished.
    expect(sansMouvementDepuis('2025-11-30', false, depuis)).toBe(true)
    expect(sansMouvementDepuis(null, false, depuis)).toBe(true)
  })
})

describe('etapeCommandePartenaire', () => {
  it('never shows an order whose bon de commande is not sent', () => {
    expect(etapeCommandePartenaire({ etape: 'non_envoye', solde: false })).toBeNull()
  })
  it('reads ETM’s wait for the délai as the partner’s move', () => {
    expect(etapeCommandePartenaire({ etape: 'attente_delai', solde: false })).toBe('delai_a_donner')
  })
  it('en traitement — the délai is still asked while a line to deliver has none', () => {
    expect(etapeCommandePartenaire({ etape: 'en_teinture', solde: false })).toBe('en_traitement')
    expect(etapeCommandePartenaire({ etape: 'en_teinture', solde: false }, true)).toBe('delai_a_donner')
  })
  it('en contrôle only once everything came back: a solde or a reprise is matter at the partner', () => {
    expect(etapeCommandePartenaire({ etape: 'en_controle', solde: false })).toBe('en_controle')
    expect(etapeCommandePartenaire({ etape: 'en_controle', solde: true })).toBe('en_traitement')
    expect(etapeCommandePartenaire({ etape: 'en_controle', solde: false, enReprise: [{ lot: 'MA1', idligne: 1, motif: null }] })).toBe('en_traitement')
    expect(etapeCommandePartenaire({ etape: 'en_controle', solde: true }, true)).toBe('delai_a_donner')
  })
  it('« à clôturer » is Malterre’s bookkeeping: the partner’s work is finished', () => {
    expect(etapeCommandePartenaire({ etape: 'a_cloturer', solde: false })).toBe('terminee')
    expect(etapeCommandePartenaire({ etape: 'terminee', solde: false })).toBe('terminee')
  })
})

describe('etapeLotPartenaire', () => {
  it('before the reception: the coloris and whose move it is', () => {
    expect(etapeLotPartenaire('coloris_soumis', false, false)).toBe('coloris_soumis')
    // The client said yes, Malterre has not passed it on yet: not ahead of Malterre.
    expect(etapeLotPartenaire('ok_ramer_a_envoyer', false, false)).toBe('coloris_soumis')
    expect(etapeLotPartenaire('en_rame', false, false)).toBe('coloris_valide')
    expect(etapeLotPartenaire('reteinture', false, false)).toBe('coloris_refuse')
    // A lot row without anything asked: nothing to tell.
    expect(etapeLotPartenaire('attente_mesures', false, false)).toBeNull()
  })
  it('received: its measures first, then one step for all of Malterre’s work', () => {
    expect(etapeLotPartenaire('attente_mesures', true, false)).toBe('mesures_a_transmettre')
    // Malterre's own steps do not hide measures still awaited…
    expect(etapeLotPartenaire('coloris_a_soumettre', true, false)).toBe('mesures_a_transmettre')
    expect(etapeLotPartenaire('soumis', true, false)).toBe('mesures_a_transmettre')
    // …and read « en contrôle » once they are in.
    const malterre: EtapeLot[] = ['coloris_a_soumettre', 'attente_tirelle', 'a_soumettre', 'soumis', 'rc_a_envoyer', 'a_valider', 'coloris_soumis']
    for (const e of malterre) expect(etapeLotPartenaire(e, true, true)).toBe('en_controle')
    // Refused by the client: Malterre decides (a reprise then shows as such), measures or not.
    expect(etapeLotPartenaire('refuse_client', true, false)).toBe('en_controle')
  })
  it('reprise and validation read the same on both sides', () => {
    expect(etapeLotPartenaire('en_reprise', true, true)).toBe('en_reprise')
    expect(etapeLotPartenaire('valide', true, true)).toBe('valide')
  })
  it('the partner’s moves are the four the portal lists', () => {
    expect([...LOT_A_VOUS].sort()).toEqual(['coloris_refuse', 'coloris_valide', 'en_reprise', 'mesures_a_transmettre'])
  })
})

describe('etapeLignePartenaire', () => {
  it('délai à donner › en traitement › livrée', () => {
    expect(etapeLignePartenaire(false, null)).toBe('delai_a_donner')
    expect(etapeLignePartenaire(false, '2026-12-02')).toBe('en_traitement')
    expect(etapeLignePartenaire(true, '2026-12-02')).toBe('livree')
    expect(etapeLignePartenaire(true, null)).toBe('livree')
  })
})

describe('lotsVus', () => {
  const lot = (p: Partial<LotFait>): LotFait => ({
    lot: 'MA110001', idsuivilot: 1, idligne: 10, etat: 1, reception: '2026-11-19',
    mesuresTeinturier: false, tirelleMesuree: false, coloris: SANS_SOUMISSION, stabilites: SANS_SOUMISSION, ...p,
  })

  it('places each lot on its line with the partner’s step, sorted', () => {
    const vus = lotsVus([
      lot({ lot: 'MA110002', idligne: 11, etat: 3 }),
      lot({ lot: 'MA110001', idligne: 10 }),
    ], [10, 11], false)
    expect(vus.map((l) => [l.fait.lot, l.idLigne, l.etape])).toEqual([['MA110001', 10, 'mesures_a_transmettre'], ['MA110002', 11, 'valide']])
  })
  it('a lot in reprise keeps its reason for the caller', () => {
    const [vu] = lotsVus([lot({ etat: 2, repriseOuverte: true, repriseMotif: 'mal uni' })], [10], false)
    expect(vu.etape).toBe('en_reprise')
    expect(vu.fait.repriseMotif).toBe('mal uni')
  })
  it('a lot known only from an old soumission mail goes on the order’s only line, else nowhere', () => {
    const ancien = lot({ idligne: 0, idsuivilot: 0, reception: null, coloris: { requise: true, envoyeeLe: '2026-11-10', reponse: null } })
    expect(lotsVus([ancien], [10], false).map((l) => [l.idLigne, l.etape])).toEqual([[10, 'coloris_soumis']])
    expect(lotsVus([ancien], [10, 11], false)).toEqual([])
  })
  it('a closed order shows its received lots validated and nothing else', () => {
    const vus = lotsVus([lot({}), lot({ lot: 'MA110003', reception: null, coloris: { requise: true, envoyeeLe: '2026-11-10', reponse: null } })], [10], true)
    expect(vus.map((l) => [l.fait.lot, l.etape])).toEqual([['MA110001', 'valide']])
  })
})

describe('article', () => {
  it('reads « REF - coloris »', () => {
    expect(article('029A', ' 0912 NOIR ')).toBe('029A - 0912 NOIR')
    expect(article('186D', '')).toBe('186D')
  })
})
