import { describe, expect, it } from 'vitest'
import {
  DELAI_RELANCE_JOURS,
  ajouterJours,
  aujourdhuiParis,
  joursAvant,
  urgenceRelance,
  compositionComplete,
  fractionVersPourcent,
  lfaTexte,
  numeroEchantillon,
  ordinalValide,
  pourcentVersFraction,
  refusCreationReference,
  statutEchantillon,
  estSuivi,
  ficheSurReference,
  lfaNombre,
  nomFiniRetenu,
  refusEssaiIndustriel,
  situationPiece,
} from './echantillons.js'

describe('statutEchantillon', () => {
  it('en cours, archivé, devenu référence', () => {
    expect(statutEchantillon({ archive: 0, idref_ecru: 0 })).toBe('en_cours')
    expect(statutEchantillon({ archive: 1, idref_ecru: 0 })).toBe('archive')
    expect(statutEchantillon({ archive: null, idref_ecru: null })).toBe('en_cours')
  })
  it('a passage wins over the archive flag it also sets', () => {
    expect(statutEchantillon({ archive: 1, idref_ecru: 426 })).toBe('reference')
    expect(statutEchantillon({ archive: 0, idref_ecru: 426 })).toBe('reference')
  })
})

describe('numeroEchantillon', () => {
  it('pads to three digits behind an E', () => {
    expect(numeroEchantillon(55)).toBe('E055')
    expect(numeroEchantillon(7)).toBe('E007')
    expect(numeroEchantillon(1234)).toBe('E1234')
  })
})

describe('fraction ↔ pourcentage', () => {
  it('reads the legacy fractions as percentages', () => {
    expect(fractionVersPourcent(0.94)).toBe(94)
    expect(fractionVersPourcent(0.06)).toBe(6)
    expect(fractionVersPourcent(1)).toBe(100)
    expect(fractionVersPourcent(null)).toBe(0)
  })
  it('round-trips', () => {
    for (const p of [94, 6, 100, 33.333, 2.5]) expect(fractionVersPourcent(pourcentVersFraction(p))).toBe(p)
  })
})

describe('compositionComplete', () => {
  it('empty is allowed, otherwise exactly 100 %', () => {
    expect(compositionComplete([])).toBe(true)
    expect(compositionComplete([94, 6])).toBe(true)
    expect(compositionComplete([94])).toBe(false)
    expect(compositionComplete([0])).toBe(false)
    expect(compositionComplete([33.333, 33.333, 33.334])).toBe(true)
  })
})

describe('lfaTexte', () => {
  it('writes the legacy « 7.50 » shape, empty for 0', () => {
    expect(lfaTexte(7.5)).toBe('7.50')
    expect(lfaTexte(10.65)).toBe('10.65')
    expect(lfaTexte(0)).toBe('')
    expect(lfaTexte(null)).toBe('')
  })
})

describe('ordinalValide', () => {
  it('drops the legacy 65535 / -1 sentinels', () => {
    expect(ordinalValide(4, 5)).toBe(4)
    expect(ordinalValide(65535, 5)).toBe(0)
    expect(ordinalValide(-1, 5)).toBe(0)
    expect(ordinalValide(null, 3)).toBe(0)
  })
})

describe('refusCreationReference', () => {
  it('only an open sample with an empty or complete composition', () => {
    expect(refusCreationReference({ archive: 0, idref_ecru: 0 }, [94, 6])).toBeNull()
    expect(refusCreationReference({ archive: 0, idref_ecru: 0 }, [])).toBeNull()
    expect(refusCreationReference({ archive: 0, idref_ecru: 0 }, [95])).toBe('composition_incomplete')
    expect(refusCreationReference({ archive: 1, idref_ecru: 0 }, [100])).toBe('archive')
    expect(refusCreationReference({ archive: 1, idref_ecru: 461 }, [100])).toBe('deja_reference')
  })
})

describe('urgenceRelance', () => {
  const ouvert = (date_relance: string | null) => ({ statut: 'en_cours' as const, date_relance })
  it('red from the relance date on', () => {
    expect(urgenceRelance(ouvert('2026-10-21'), '2026-10-21')).toEqual({ urgence: 'retard', jours: 0 })
    expect(urgenceRelance(ouvert('2026-10-18'), '2026-10-21')).toEqual({ urgence: 'retard', jours: -3 })
  })
  it('amber within the 7 days before, nothing earlier', () => {
    expect(urgenceRelance(ouvert('2026-10-28'), '2026-10-21')).toEqual({ urgence: 'bientot', jours: 7 })
    expect(urgenceRelance(ouvert('2026-10-22'), '2026-10-21').urgence).toBe('bientot')
    expect(urgenceRelance(ouvert('2026-10-29'), '2026-10-21')).toEqual({ urgence: null, jours: 8 })
  })
  it('never on a kept or archived sample, nor without a date', () => {
    expect(urgenceRelance({ statut: 'archive', date_relance: '2026-01-01' }, '2026-10-21').urgence).toBeNull()
    expect(urgenceRelance({ statut: 'reference', date_relance: '2026-01-01' }, '2026-10-21').urgence).toBeNull()
    expect(urgenceRelance(ouvert(null), '2026-10-21')).toEqual({ urgence: null, jours: null })
  })
})

describe('dates', () => {
  it('adds days across months and years', () => {
    expect(ajouterJours('2026-10-21', DELAI_RELANCE_JOURS)).toBe('2026-11-20')
    expect(ajouterJours('2026-12-20', 30)).toBe('2027-01-19')
  })
  it('counts days across a DST change without drift', () => {
    expect(joursAvant('2026-10-26', '2026-10-24')).toBe(2)
  })
  it("today is the factory's day, not UTC's", () => {
    // 23:30 UTC on Oct 21 is already Oct 22 in Paris (UTC+2).
    expect(aujourdhuiParis(new Date('2026-10-21T23:30:00Z'))).toBe('2026-10-22')
  })
})

// ── Industrial trial (LIVA #1370) ──

describe('statutEchantillon — essai industriel', () => {
  it('a linked reference still flagged essai is the industrial trial, not a passage', () => {
    expect(statutEchantillon({ archive: 0, idref_ecru: 540, ref_essai: 1 })).toBe('essai')
    expect(statutEchantillon({ archive: 0, idref_ecru: 540, ref_essai: 0 })).toBe('reference')
  })
  it('an abandoned trial is archived, and keeps its link', () => {
    expect(statutEchantillon({ archive: 1, idref_ecru: 540, ref_essai: 1 })).toBe('archive')
  })
  it('the flag means nothing without a link', () => {
    expect(statutEchantillon({ archive: 0, idref_ecru: 0, ref_essai: 1 })).toBe('en_cours')
  })
  it('followed = laboratory or industrial trial', () => {
    expect(estSuivi('en_cours')).toBe(true)
    expect(estSuivi('essai')).toBe(true)
    expect(estSuivi('reference')).toBe(false)
    expect(estSuivi('archive')).toBe(false)
  })
  it('a followed industrial trial is relanced like a laboratory one', () => {
    expect(urgenceRelance({ statut: 'essai', date_relance: '2026-11-10' }, '2026-11-16').urgence).toBe('retard')
    expect(urgenceRelance({ statut: 'reference', date_relance: '2026-11-10' }, '2026-11-16').urgence).toBeNull()
  })
})

describe('ficheSurReference', () => {
  it('the sheet lives on the reference while that one is an essai, archived or not', () => {
    expect(ficheSurReference({ idref_ecru: 540, ref_essai: 1 })).toBe(true)
    expect(ficheSurReference({ idref_ecru: 545, ref_essai: 0 })).toBe(false)
    expect(ficheSurReference({ idref_ecru: 0, ref_essai: null })).toBe(false)
  })
})

describe('refusEssaiIndustriel', () => {
  it('only a laboratory sample with a whole composition starts a trial', () => {
    expect(refusEssaiIndustriel({ archive: 0, idref_ecru: 0 }, [64, 30, 6])).toBeNull()
    expect(refusEssaiIndustriel({ archive: 0, idref_ecru: 0 }, [])).toBeNull()
    expect(refusEssaiIndustriel({ archive: 0, idref_ecru: 0 }, [64, 30])).toBe('composition_incomplete')
    expect(refusEssaiIndustriel({ archive: 1, idref_ecru: 0 }, [100])).toBe('archive')
    expect(refusEssaiIndustriel({ archive: 0, idref_ecru: 540, ref_essai: 1 }, [100])).toBe('deja_essai')
    expect(refusEssaiIndustriel({ archive: 1, idref_ecru: 545, ref_essai: 0 }, [100])).toBe('deja_reference')
  })
  it("a sample at its trial can be retained, on the reference's composition", () => {
    expect(refusCreationReference({ archive: 0, idref_ecru: 540, ref_essai: 1 }, [65, 30, 5])).toBeNull()
    expect(refusCreationReference({ archive: 0, idref_ecru: 540, ref_essai: 1 }, [65, 30])).toBe('composition_incomplete')
    expect(refusCreationReference({ archive: 1, idref_ecru: 540, ref_essai: 1 }, [100])).toBe('archive')
  })
})

describe('lfaNombre', () => {
  it("reads the reference's text LFA back", () => {
    expect(lfaNombre('7.50')).toBe(7.5)
    expect(lfaNombre('7,5')).toBe(7.5)
    expect(lfaNombre('')).toBe(0)
    expect(lfaNombre(null)).toBe(0)
    expect(lfaNombre(' ')).toBe(0)
    expect(lfaNombre('abc')).toBe(0)
  })
  it('round-trips with lfaTexte', () => {
    expect(lfaNombre(lfaTexte(8.3))).toBe(8.3)
  })
})

describe('nomFiniRetenu', () => {
  it('a fini named after the provisional reference follows it', () => {
    expect(nomFiniRetenu('E055', '104', 'E055A')).toBe('104A')
    expect(nomFiniRetenu('E055', '104', 'e055a')).toBe('104a')
    expect(nomFiniRetenu('E055', '104', 'E055 lavé')).toBe('104 lavé')
    expect(nomFiniRetenu('E055', '104', ' E055B ')).toBe('104B')
  })
  it('any other name is left alone', () => {
    expect(nomFiniRetenu('E055', '104', 'ech 55')).toBeNull()
    expect(nomFiniRetenu('E055', '104', 'E0551')).toBeNull()
    expect(nomFiniRetenu('E055', '104', '029A')).toBeNull()
    expect(nomFiniRetenu('', '104', 'E055A')).toBeNull()
    expect(nomFiniRetenu('E055', ' ', 'E055A')).toBeNull()
  })
})

describe('situationPiece', () => {
  const base = { idsociete: 1, magasin_nom: null, expediee: false, donnee: false, ennoblisseur: null, fini: null }
  it('in stock at the factory or at a sous-traitant', () => {
    expect(situationPiece(base)).toEqual({ libelle: 'En stock · Malterre', enStock: true })
    expect(situationPiece({ ...base, magasin_nom: 'MATEL' })).toEqual({ libelle: 'En stock · MATEL', enStock: true })
  })
  it('still at the knitter before TRM ships it', () => {
    expect(situationPiece({ ...base, idsociete: 2 })).toEqual({ libelle: 'Chez Tricotage Malterre', enStock: true })
  })
  it('on a dyer order: still ours', () => {
    expect(situationPiece({ ...base, magasin_nom: 'MATEL', ennoblisseur: { nom: 'MATEL', commande: 9071 } }))
      .toEqual({ libelle: 'En ennoblissement chez MATEL (commande 9071)', enStock: true })
  })
  it('dyed, given or shipped: no longer an écru in stock — the fini wins', () => {
    expect(situationPiece({ ...base, ennoblisseur: { nom: 'MATEL', commande: 9071 }, fini: { lot: 'MA109612', reference: 'E055A' } }))
      .toEqual({ libelle: 'Ennoblie (E055A · lot MA109612)', enStock: false })
    expect(situationPiece({ ...base, fini: { lot: null, reference: null } })).toEqual({ libelle: 'Ennoblie', enStock: false })
    expect(situationPiece({ ...base, donnee: true }).enStock).toBe(false)
    expect(situationPiece({ ...base, expediee: true })).toEqual({ libelle: 'Expédiée', enStock: false })
  })
})
