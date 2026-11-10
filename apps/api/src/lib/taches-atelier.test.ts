import { describe, it, expect } from 'vitest'
import { equipeRealisation, peutAnnuler, trierTaches, niveauTache, seuilAmbre, ageJours, DELAI_ANNULATION_MS, EQUIPE_MAX } from './taches-atelier.js'

const J = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

describe('equipeRealisation', () => {
  it('puts the declarer first and keeps each coéquipier once', () => {
    expect(equipeRealisation(4, [7, 4, 7, 9])).toEqual([4, 7, 9])
  })
  it('drops invalid ids', () => {
    expect(equipeRealisation(4, [0, -2, 1.5, 3])).toEqual([4, 3])
  })
  it('refuses an impossible team', () => {
    const many = Array.from({ length: EQUIPE_MAX }, (_, i) => i + 10)
    expect(equipeRealisation(1, many)).toBeNull()
  })
})

describe('peutAnnuler', () => {
  const r = { declare_par: 4, fait_le_ms: 1_000_000 }
  it('lets the declarer cancel within the delay', () => {
    expect(peutAnnuler(r, 4, 1_000_000 + DELAI_ANNULATION_MS - 1)).toBe(true)
  })
  it('refuses after the delay', () => {
    expect(peutAnnuler(r, 4, 1_000_000 + DELAI_ANNULATION_MS)).toBe(false)
  })
  it('refuses a coéquipier or anyone else', () => {
    expect(peutAnnuler(r, 7, 1_000_001)).toBe(false)
  })
})

describe('trierTaches', () => {
  it('never done first, then oldest réalisation first', () => {
    const out = trierTaches([
      { libelle: 'Sols', derniere_ms: 300 },
      { libelle: 'Vitres', derniere_ms: null },
      { libelle: 'Toiles', derniere_ms: 100 },
      { libelle: 'Bacs', derniere_ms: null },
    ])
    expect(out.map((t) => t.libelle)).toEqual(['Bacs', 'Vitres', 'Toiles', 'Sols'])
  })
})

describe('niveauTache', () => {
  it('30 days: green below 27, amber from 27, red from 30 (Vincent 2026-11-05)', () => {
    expect(seuilAmbre(30)).toBe(27)
    expect(niveauTache(30, NOW - 26 * J, NOW)).toBe('vert')
    expect(niveauTache(30, NOW - 27 * J, NOW)).toBe('ambre')
    expect(niveauTache(30, NOW - 29 * J - 1000, NOW)).toBe('ambre')
    expect(niveauTache(30, NOW - 30 * J, NOW)).toBe('rouge')
  })
  it('amber starts at least one day before the frequency', () => {
    expect(seuilAmbre(7)).toBe(6)
    expect(seuilAmbre(1)).toBe(0)
    expect(niveauTache(1, NOW - 1000, NOW)).toBe('ambre')
  })
  it('never done with a frequency = due', () => {
    expect(niveauTache(30, null, NOW)).toBe('rouge')
  })
  it('no frequency = no colour', () => {
    expect(niveauTache(null, NOW - 100 * J, NOW)).toBeNull()
    expect(niveauTache(null, null, NOW)).toBeNull()
  })
  it('counts whole 24 h days', () => {
    expect(ageJours(NOW - 12 * J - 5, NOW)).toBe(12)
    expect(ageJours(null, NOW)).toBeNull()
  })
})

describe('trierTaches with colours', () => {
  it('red, then amber, then the rest by age', () => {
    const out = trierTaches([
      { libelle: 'Vert', derniere_ms: 1, niveau: 'vert' as const },
      { libelle: 'Sans', derniere_ms: null, niveau: null },
      { libelle: 'Ambre', derniere_ms: 500, niveau: 'ambre' as const },
      { libelle: 'Rouge', derniere_ms: 900, niveau: 'rouge' as const },
    ])
    expect(out.map((t) => t.libelle)).toEqual(['Rouge', 'Ambre', 'Sans', 'Vert'])
  })
})

import {
  actionsPonctuelle,
  aujourdhuiParis,
  doitTraiterRouge,
  echeanceACreation,
  echeanceValide,
  motifValide,
  niveauPonctuelle,
  plusJours,
  ponctuelleVisible,
  MOTIFS_REPORT,
  VUE_CLOTUREE_JOURS,
  type Ponctuelle,
} from './taches-atelier.js'

const BONNETIER = { id: 4, regleur: false }
const AUTRE_BONNETIER = { id: 5, regleur: false }
const REGLEUR = { id: 9, regleur: true }

describe('ponctuelles', () => {
  const pourRegleurs: Ponctuelle = { groupe: 'regleurs', cree_par: 4, echeance: null, cloture: null }
  const pourBonnetiers: Ponctuelle = { groupe: 'bonnetiers', cree_par: 9, echeance: '2026-11-12', cloture: null }

  it('Paris day and calendar arithmetic', () => {
    // 2026-11-10 23:30 UTC is already the 11th in Paris.
    expect(aujourdhuiParis(Date.UTC(2026, 10, 10, 23, 30))).toBe('2026-11-11')
    expect(plusJours('2026-12-30', 3)).toBe('2027-01-02')
  })

  it('an undated request to the régleurs is red for the régleurs only', () => {
    expect(niveauPonctuelle(pourRegleurs, REGLEUR, '2026-11-10')).toBe('rouge')
    // Its creator is waiting: neutral.
    expect(niveauPonctuelle(pourRegleurs, BONNETIER, '2026-11-10')).toBeNull()
  })

  it('a dated request turns red the day after its due date, for its group', () => {
    expect(niveauPonctuelle(pourBonnetiers, AUTRE_BONNETIER, '2026-11-12')).toBeNull()
    expect(niveauPonctuelle(pourBonnetiers, AUTRE_BONNETIER, '2026-11-13')).toBe('rouge')
    expect(niveauPonctuelle(pourBonnetiers, REGLEUR, '2026-11-20')).toBeNull()
    expect(niveauPonctuelle({ ...pourBonnetiers, cloture: 'faite' }, AUTRE_BONNETIER, '2026-11-20')).toBeNull()
  })

  it('whoever sets the date is the only one who moves it', () => {
    // To the régleurs: the régleurs date, postpone, abandon; the sender nothing.
    expect(actionsPonctuelle(pourRegleurs, REGLEUR)).toEqual(['echeance', 'fait', 'abandonner'])
    expect(actionsPonctuelle({ ...pourRegleurs, echeance: '2026-11-14' }, REGLEUR)).toEqual([
      'fait',
      'reporter',
      'abandonner',
    ])
    expect(actionsPonctuelle(pourRegleurs, BONNETIER)).toEqual([])
    expect(actionsPonctuelle({ ...pourRegleurs, echeance: '2026-11-14' }, BONNETIER)).toEqual([])
    // To the bonnetiers, from a régleur: he keeps every action, the others do it.
    expect(actionsPonctuelle(pourBonnetiers, REGLEUR)).toEqual(['fait', 'reporter', 'abandonner', 'modifier'])
    expect(actionsPonctuelle(pourBonnetiers, AUTRE_BONNETIER)).toEqual(['fait'])
    // To the bonnetiers, from a bonnetier: he moves it, another only does it.
    const deBonnetier = { ...pourBonnetiers, cree_par: 4 }
    expect(actionsPonctuelle(deBonnetier, BONNETIER)).toEqual(['fait', 'reporter', 'abandonner', 'modifier'])
    expect(actionsPonctuelle(deBonnetier, AUTRE_BONNETIER)).toEqual(['fait'])
    expect(actionsPonctuelle({ ...pourBonnetiers, cloture: 'abandonnee' }, REGLEUR)).toEqual([])
  })

  it('only who can move a red task gets the imposed sheet', () => {
    expect(doitTraiterRouge(['fait'])).toBe(false)
    expect(doitTraiterRouge(['fait', 'reporter', 'abandonner'])).toBe(true)
    expect(doitTraiterRouge(['echeance', 'fait', 'abandonner'])).toBe(true)
  })

  it('a bonnetier never dates a request to the régleurs', () => {
    expect(echeanceACreation(BONNETIER, 'regleurs')).toBe('interdite')
    expect(echeanceACreation(BONNETIER, 'bonnetiers')).toBe('requise')
    expect(echeanceACreation(REGLEUR, 'bonnetiers')).toBe('requise')
    expect(echeanceACreation(REGLEUR, 'regleurs')).toBe('requise')
  })

  it('a due date is between today and 30 days', () => {
    expect(echeanceValide('2026-11-10', '2026-11-10')).toBe(true)
    expect(echeanceValide('2026-12-10', '2026-11-10')).toBe(true)
    expect(echeanceValide('2026-12-11', '2026-11-10')).toBe(false)
    expect(echeanceValide('2026-11-09', '2026-11-10')).toBe(false)
    expect(echeanceValide('2026-02-30', '2026-02-01')).toBe(false)
    expect(echeanceValide('demain', '2026-11-10')).toBe(false)
  })

  it('« autre » needs a text', () => {
    expect(motifValide('temps', '', MOTIFS_REPORT)).toBe(true)
    expect(motifValide('autre', '  ', MOTIFS_REPORT)).toBe(false)
    expect(motifValide('autre', 'la pompe', MOTIFS_REPORT)).toBe(true)
    expect(motifValide('toString', '', MOTIFS_REPORT)).toBe(false)
  })

  it('done leaves every list; abandoned stays a week on the creator list', () => {
    const abandonnee = { ...pourRegleurs, cloture: 'abandonnee' as const, cloturee_le_ms: NOW - J }
    expect(ponctuelleVisible(abandonnee, BONNETIER, NOW)).toBe(true)
    expect(ponctuelleVisible(abandonnee, REGLEUR, NOW)).toBe(false)
    expect(ponctuelleVisible({ ...abandonnee, cloturee_le_ms: NOW - VUE_CLOTUREE_JOURS * J }, BONNETIER, NOW)).toBe(
      false,
    )
    const faite = { ...pourRegleurs, cloture: 'faite' as const, cloturee_le_ms: NOW - 1000 }
    expect(ponctuelleVisible(faite, BONNETIER, NOW)).toBe(false)
    expect(ponctuelleVisible(faite, REGLEUR, NOW)).toBe(false)
    expect(ponctuelleVisible({ ...pourRegleurs, cloturee_le_ms: null }, REGLEUR, NOW)).toBe(true)
    expect(ponctuelleVisible({ ...pourRegleurs, cloturee_le_ms: null }, AUTRE_BONNETIER, NOW)).toBe(false)
  })
})
