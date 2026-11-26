import { describe, expect, it } from 'vitest'
import { SANS_SOUMISSION, type EtapeLot, type LotFait } from './cycle-ennoblissement.js'
import {
  article, debutDouzeMois, etapeCommandePartenaire, etapeLignePartenaire, etapeLotPartenaire, lotsVus, LOT_A_VOUS,
  deuxMoisAvant, LOT_MESURABLE, mesuresDuLot, mesuresMalterre, sansMouvementDepuis, tolerancesRef,
} from './espace-partenaire-commandes.js'
import { CONTROLES_PAR_DEFAUT, type ControlesRef } from './controles-lot.js'

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
