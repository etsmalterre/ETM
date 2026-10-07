import { describe, expect, it } from 'vitest'
import { delaiTexte, evaluerConfirmation, evaluerRetard, joursOuvresDepuis, messageRetard, raisonRetard, evaluerPalierSuivant, raisonPalierSuivant, evaluerAffectationFil, evaluerCouverture, evaluerEnnoblissement, evaluerFil, joursAvant, raisonCouverture, raisonEnnoblissement, horsPortee, adresseConnue, listeEnvois, BOITE_LECTRICE_DELAI_H } from './regles.js'

const today = new Date(2026, 8, 23) // Wed 23/09/2026

describe('joursAvant', () => {
  it('counts days from today, null on a non-date', () => {
    expect(joursAvant('20260930', today)).toBe(7)
    expect(joursAvant('20260923', today)).toBe(0)
    expect(joursAvant('20260912', today)).toBe(-11)
    expect(joursAvant('', today)).toBeNull()
    expect(joursAvant(null, today)).toBeNull()
  })
  it('writes the délai for a human', () => {
    expect(delaiTexte('20260930', 7)).toBe('le 30/09 (dans 7 j)')
    expect(delaiTexte('20260912', -11)).toBe('le 12/09 (dépassé de 11 j)')
  })
})

describe('evaluerCouverture', () => {
  const l = (o: Partial<Parameters<typeof evaluerCouverture>[0]>) =>
    evaluerCouverture({ quantite: 1000, unite: 3, affecte: 0, expedie: 0, dateLivraison: '20260930', ...o }, today)

  it('flags an uncovered line due within 21 days, urgent within 7', () => {
    expect(l({})).toEqual({ gravite: 'urgent', jours: 7, manque: 1000 })
    expect(l({ dateLivraison: '20261010' })?.gravite).toBe('attention')
    expect(l({ dateLivraison: '20261020' })).toBeNull() // beyond the horizon
  })
  it('accepts a line covered at 90 %, or shipped', () => {
    expect(l({ affecte: 900 })).toBeNull()
    expect(l({ affecte: 899 })?.manque).toBe(101)
    expect(l({ expedie: 980 })).toBeNull()
  })
  it('ignores stale délais, lines without délai, and units other than Kg / Ml', () => {
    expect(l({ dateLivraison: '20260901' })?.gravite).toBe('urgent') // 22 days late: still actionable
    expect(l({ dateLivraison: '20260801' })).toBeNull() // 53 days late: stale
    expect(l({ dateLivraison: '' })).toBeNull()
    expect(l({ unite: 4 })).toBeNull()
  })
})

describe('evaluerEnnoblissement', () => {
  it('flags écru not sent to the dyer when the délai is within 30 days', () => {
    expect(evaluerEnnoblissement(120, '20261010', today)).toEqual({ gravite: 'attention', jours: 17 })
    expect(evaluerEnnoblissement(120, '20261001', today)?.gravite).toBe('urgent')
    expect(evaluerEnnoblissement(120, '20261130', today)).toBeNull()
    expect(evaluerEnnoblissement(0, '20261001', today)).toBeNull()
  })
})

describe('evaluerFil', () => {
  it('tolerates rounding, flags a real deficit', () => {
    expect(evaluerFil(-0.7)).toBeNull()
    expect(evaluerFil(12)).toBeNull()
    expect(evaluerFil(-20)).toEqual({ gravite: 'attention', manque: 20 })
    expect(evaluerFil(-80)?.gravite).toBe('urgent')
  })
})

describe('evaluerAffectationFil', () => {
  it('gives the office a day after the order', () => {
    expect(evaluerAffectationFil(1, '20260923', today)).toBeNull()
    expect(evaluerAffectationFil(1, '20260922', today)).toBe('attention')
    expect(evaluerAffectationFil(0, '20260901', today)).toBeNull()
    expect(evaluerAffectationFil(2, '', today)).toBe('attention')
  })
})

describe('raisonCouverture / raisonEnnoblissement (why a point closed)', () => {
  const l = (o: Partial<Parameters<typeof raisonCouverture>[0]>) =>
    raisonCouverture({ quantite: 1000, unite: 3, affecte: 0, expedie: 0, dateLivraison: '20260930', ...o }, today)

  it('says what changed, in the rule’s own order', () => {
    expect(l({ expedie: 990 })).toBe('Ligne expédiée : 990 Ml sur 1 000 Ml.')
    expect(l({ affecte: 950 })).toBe('Ligne couverte : 950 Ml affectés sur 1 000 Ml commandés.')
    expect(l({ dateLivraison: '20261031' })).toBe('Délai reporté au 31/10, au-delà des 21 jours surveillés.')
    expect(l({ dateLivraison: '20260801' })).toMatch(/^Délai dépassé depuis plus de 30 jours/)
  })

  it('ennoblissement: écru sent, or délai moved', () => {
    expect(raisonEnnoblissement(0, '20260930', today)).toMatch(/parti en teinture/)
    expect(raisonEnnoblissement(12, '20261130', today)).toBe('Délai reporté au 30/11, au-delà des 30 jours surveillés.')
  })
})

describe('v2 — horsPortee (Isabelle’s scores on v1)', () => {
  const isa = 'isabelle@etsmalterre.com'
  const nico = ['n.antonino@etsmalterre.com']
  const conv = (o: Partial<Parameters<typeof horsPortee>[0]>) =>
    horsPortee({ boites: ['contact@etsmalterre.com'], destinataires: ['contact@etsmalterre.com'], participants: [], heuresAttente: 30, ...o }, isa, nico)

  it('drops Nicolas’s threads without Isabelle in copy (the JVC4 cams, échec)', () => {
    expect(conv({ boites: nico, destinataires: nico, participants: ['x@pltextiles.be', ...nico] }))
      .toBe('Échange dans la boîte de n.antonino sans isabelle en copie : hors rapport.')
    expect(conv({ boites: nico, participants: ['x@pltextiles.be', isa], heuresAttente: 200 })).toBeNull()
  })

  it('waits 5 working days on mail that reached Isabelle (Promethee 1 j, Slip Français 4 j: échecs; WECAMECA 6 j kept)', () => {
    expect(conv({ boites: ['contact@etsmalterre.com', isa], heuresAttente: 24 })).toMatch(/^Dans la boîte de isabelle depuis 1 jour ouvré/)
    expect(conv({ boites: [isa], heuresAttente: 4 * 24 })).not.toBeNull()
    expect(conv({ boites: [isa], heuresAttente: BOITE_LECTRICE_DELAI_H + 24 })).toBeNull()
    expect(conv({ destinataires: [isa], heuresAttente: 30 })).not.toBeNull() // in To, received through another box
  })

  it('leaves the other mailboxes alone (Lapsuss in pierre-emmanuel’s, réussite)', () => {
    expect(conv({ boites: ['pierre-emmanuel@etsmalterre.com'], heuresAttente: 5 * 24 })).toBeNull()
  })
})

describe('v2 — adresseConnue', () => {
  // Seenel on prod 2026-09-25: the Tourcoing addresses were entered before the report said « mettre à jour ».
  const seenel = [
    { nom: 'Seenel Imaging SAS', cp: '59100', ville: 'AMIEROUBAIXNS' },
    { nom: 'Seenel Imaging', cp: '59200', ville: 'Tourcoing' },
  ]
  it('finds the announced address by postcode + town', () => {
    expect(adresseConnue({ cp: '59200', ville: 'TOURCOING' }, seenel)?.nom).toBe('Seenel Imaging')
    expect(adresseConnue({ cp: '59 200', ville: '' }, seenel)?.nom).toBe('Seenel Imaging')
  })
  it('is not fooled by another town or a missing postcode', () => {
    expect(adresseConnue({ cp: '59200', ville: 'Lille' }, seenel)).toBeNull()
    expect(adresseConnue({ cp: '', ville: 'Tourcoing' }, seenel)).toBeNull()
  })
  it('accepts a town HFSQL mangled (lost byte)', () => {
    expect(adresseConnue({ cp: '7340', ville: 'Pâturage' }, [{ cp: '7340', ville: 'P�turage-Colfontaine' }])).not.toBeNull()
  })
})

describe('v2 — listeEnvois', () => {
  it('lists each day + address once, oldest first (Idylle avoir N°9240)', () => {
    const d = (iso: string, adresse: string) => ({ date: Date.parse(iso), adresse, libelle: 'Avoir N°9240' })
    expect(listeEnvois([
      d('2026-09-21T13:14:21Z', 'comptabilite@idylle.fr'),
      d('2026-09-18T14:11:49Z', 'vmousnier@idylle.fr'),
      d('2026-09-21T13:08:25Z', 'comptabilite@idylle.fr'),
    ])).toBe('le 18/09 (vmousnier@idylle.fr), le 21/09 (comptabilite@idylle.fr)')
  })
})

describe('evaluerPalierSuivant', () => {
  // N°3707, 10/04: 141 Ml at 14,51 €, 4 rolls = 154,4 Ml at 12,20 €.
  const ligne = {
    quantite: 141, prixSaisi: 14.51, prix: 14.51, nearNextTranche: true,
    nextTrancheRolls: 4, nextTrancheQty: 154.4, nextTrancheGapQty: 13.4, nextTranchePrix: 12.2,
  }

  it('reports a line within reach of a cheaper band, with both totals', () => {
    const p = evaluerPalierSuivant(ligne)!
    expect(p.prixActuel).toBe(14.51)
    expect(p.baisse).toBeCloseTo(0.159, 3)
    expect(p.totalActuel).toBe(2045.91)
    expect(p.totalPalier).toBe(1883.68)
  })

  it('stays silent when the typed price is already the next band’s (611 Ml at the 612 Ml price)', () => {
    expect(evaluerPalierSuivant({ ...ligne, prixSaisi: 12.2 })).toBeNull()
    expect(raisonPalierSuivant({ ...ligne, prixSaisi: 12.2 }, 'Ml')).toBe('Prix déjà au tarif du palier 4 rouleaux (12,20 €).')
  })

  it('stays silent outside the screen’s 15 % zone, and says how far the band is', () => {
    const loin = { ...ligne, nearNextTranche: false, nextTrancheGapQty: 96.2 }
    expect(evaluerPalierSuivant(loin)).toBeNull()
    expect(raisonPalierSuivant(loin, 'Ml')).toBe('Palier suivant (4 rouleaux) à 96 Ml de plus : trop loin pour le proposer.')
  })

  it('uses the grid price when none was typed', () => {
    expect(evaluerPalierSuivant({ ...ligne, prixSaisi: 0 })?.prixActuel).toBe(14.51)
  })
})

describe('evaluerPalierSuivant — rounding', () => {
  it('ignores a drop under 3 % (611 Ml at 8,75 € vs 612 Ml at 8,68 €)', () => {
    const l = { quantite: 611, prixSaisi: 8.75, prix: 10.34, nearNextTranche: true, nextTrancheRolls: 15, nextTrancheQty: 612, nextTrancheGapQty: 1, nextTranchePrix: 8.68 }
    expect(evaluerPalierSuivant(l)).toBeNull()
    expect(raisonPalierSuivant(l, 'Ml')).toBe('Palier 15 rouleaux à 8,68 € : moins de 3 % de baisse, pas la peine de le proposer.')
  })
})

describe('evaluerRetard', () => {
  // today = Wed 23/09/2026
  const l = { quantite: 500, unite: 3, affecte: 480, expedie: 0, dateLivraison: '20260918', pret: 480, piecesPretes: 6 }

  it('reports a covered line past its délai and not shipped, urgent from 7 days late', () => {
    expect(evaluerRetard(l, today)).toEqual({ gravite: 'attention', joursRetard: 5, pret: true })
    expect(evaluerRetard({ ...l, dateLivraison: '20260910' }, today)).toEqual({ gravite: 'urgent', joursRetard: 13, pret: true })
  })

  it('says what is ready, or that the line waits for production', () => {
    expect(messageRetard(l, true)).toBe('rien d’expédié sur 500 Ml ; 480 Ml prêts (6 pièces) à expédier, ou prévenir le client.')
    const enTeinture = { ...l, pret: 0, piecesPretes: 0 }
    expect(evaluerRetard(enTeinture, today)?.pret).toBe(false)
    expect(messageRetard(enTeinture, false)).toMatch(/rien de prêt — la ligne attend la production ou la teinture : prévenir le client/)
  })

  it('leaves an uncovered late line to couverture, never two points on one line', () => {
    expect(evaluerRetard({ ...l, affecte: 100 }, today)).toBeNull()
    expect(raisonRetard({ ...l, affecte: 100 }, today)).toMatch(/Pièces à affecter/)
  })

  it('stays silent on a short delivery: all that was assigned left (AGAPE N°3792)', () => {
    const agape = { quantite: 214, unite: 3, affecte: 208, expedie: 208, dateLivraison: '20260918', pret: 0, piecesPretes: 0 }
    expect(evaluerRetard(agape, today)).toBeNull()
    expect(raisonRetard(agape, today)).toBe('Tout ce qui était affecté est parti (208 Ml sur 214 Ml) : reliquat sans pièce.')
  })

  it('stays silent when shipped, not yet due, or late beyond 30 days (stale délai)', () => {
    expect(evaluerRetard({ ...l, expedie: 495 }, today)).toBeNull()
    expect(evaluerRetard({ ...l, dateLivraison: '20260923' }, today)).toBeNull()
    expect(evaluerRetard({ ...l, dateLivraison: '20260801' }, today)).toBeNull()
    expect(raisonRetard({ ...l, dateLivraison: '20260801' }, today)).toMatch(/plus de 30 jours/)
  })
})

describe('evaluerConfirmation', () => {
  it('counts working days only', () => {
    expect(joursOuvresDepuis('20260923', today)).toBe(0)
    expect(joursOuvresDepuis('20260919', today)).toBe(3) // Sat → Mon, Tue, Wed
    expect(joursOuvresDepuis('20260918', today)).toBe(3) // Fri → same
  })

  it('raises after 2 working days, urgent from 5', () => {
    expect(evaluerConfirmation('20260922', today)).toBeNull()
    expect(evaluerConfirmation('20260921', today)).toEqual({ gravite: 'attention', jours: 2 })
    expect(evaluerConfirmation('20260916', today)).toEqual({ gravite: 'urgent', jours: 5 })
  })
})
