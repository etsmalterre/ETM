import { describe, expect, it, vi } from 'vitest'

// The module reaches the database only inside its writers: the pure part is tested here.
vi.mock('../../mps-pg.js', () => ({ mpsPg: () => { throw new Error('no database in this test') } }))
vi.mock('../../hfsql-auto.js', () => ({ query: async () => { throw new Error('no database in this test') } }))

import type { AgentRun } from '../store.js'
import type { BlExtraction } from '../bl-extraction.js'
import { CHAMP_RECEPTION, correctionsRouleau, lireReception, piecesProposees, pointDuRunBl, seulPossible, texteReception } from './reception-bl.js'

const piece = (numero: string, poids: number | null, metrage: number | null, observations = '') =>
  ({ numero_piece: numero, composants: numero.split('+'), poids, metrage, observations })

const extraction = (pieces: BlExtraction['pieces']): BlExtraction => ({
  numero_commande: '9100', numero_bordereau: '109731A', ligne: 1, pieces,
  nombre_pieces: pieces.length, poids_total: null, metrage_total: null, numero_of: '', destinataire: '',
})

const run = (statut: AgentRun['statut'], over: Partial<AgentRun> = {}, controles: Array<{ code: string; gravite: string; message: string }> = []): AgentRun => ({
  id: 'r1', slug: 'bl-ennoblisseur', createdAt: '2026-11-11T10:00:00.000Z', source: 'gmail', mode: 'actif',
  message: { id: 'm1', threadId: 't1', de: 'Céline <c@matel.fr>', sujet: 'BL', date: '2026-11-11T09:55:00.000Z' },
  fichiers: [], version: 4, model: 'mistral-small-latest', statut,
  resultat: {
    profil: 'matel', typeDocument: 'bl', pages: [],
    extraction: extraction([piece('3182/25', 18.8, 61.7), piece('3182/26', 19.1, 63.4, '1 tache')]),
    resolution: { commandeId: 9100, sousTraitantId: 9, lignes: [9072], ligneId: 9072, lot: 'MA109731', nomGed: 'MA109731', pieces: [], dejaImportees: [], gedExistant: null },
    controles, ecriture: null,
  },
  resume: '', coutUsd: 0, dureeMs: 0,
  ...over,
})

describe('the rolls of a BL as the réception receives them', () => {
  it('keeps the dyer’s weight only when the profile writes it', () => {
    const e = extraction([piece('3182/25', 18.8, 61.7)])
    expect(piecesProposees(e, true)[0]).toEqual({ numero: '3182/25', poids: 18.8, metrage: 61.7, observations: '' })
    expect(piecesProposees(e, false)[0].poids).toBeNull()
  })

  it('makes one roll of a piece printed twice (cut by the dyer): the weighed line', () => {
    const e = extraction([piece('3351/18', 0, 40, 'Client'), piece('3351/18', 21.1, 65), piece('3351/19', 20, 60)])
    expect(piecesProposees(e, true)).toEqual([
      { numero: '3351/18', poids: 21.1, metrage: 65, observations: '' },
      { numero: '3351/19', poids: 20, metrage: 60, observations: '' },
    ])
    // Whatever the order the two lines come in.
    const inverse = extraction([piece('3351/18', 21.1, 65), piece('3351/18', 0, 40, 'Client')])
    expect(piecesProposees(inverse, true)).toEqual([{ numero: '3351/18', poids: 21.1, metrage: 65, observations: '' }])
  })
})

describe('the point a BL run leaves', () => {
  it('a written BL is a saisie: the réception proposed on its line', () => {
    const p = pointDuRunBl(run('ecrit'))!
    expect(p).toMatchObject({
      competence: 'bl', champ: CHAMP_RECEPTION, mode: 'supervise', decision: 'saisie', ecrit: false,
      idcommande: 9100, idligne: 9072, idsousTraitant: 9, runId: 'r1', version: 4, messageId: 'm1',
    })
    const prop = lireReception(p.proposition)!
    expect(prop.lot).toBe('MA109731')
    expect(prop.bordereau).toBe('109731A')
    expect(prop.ennoblisseur).toBe('MATEL')
    expect(prop.pieces.map((x) => x.numero)).toEqual(['3182/25', '3182/26'])
    expect(p.explication).toContain('2 rouleaux')
  })

  it('a blocked BL is an aide: his reasons, and what he read as a proposal', () => {
    const p = pointDuRunBl(run('a_verifier', {}, [
      { code: 'total_metrage', gravite: 'bloquant', message: 'La somme des métrages (125.1 m) ne correspond pas au total imprimé (152.1 m).' },
      { code: 'totaux_absents', gravite: 'avertissement', message: 'Aucun total imprimé.' },
    ]))!
    expect(p.decision).toBe('aide')
    expect(p.explication).toBe('La somme des métrages (125.1 m) ne correspond pas au total imprimé (152.1 m).')
    expect(lireReception(p.proposition)!.pieces).toHaveLength(2)
  })

  it('leaves none in essai, on a PDF test, on a BL already imported, an error or another skill', () => {
    expect(pointDuRunBl(run('simule', { mode: 'essai' }))).toBeNull()
    expect(pointDuRunBl(run('ecrit', { source: 'essai_manuel' }))).toBeNull()
    expect(pointDuRunBl(run('deja_importe'))).toBeNull()
    expect(pointDuRunBl(run('erreur'))).toBeNull()
    expect(pointDuRunBl(run('ecrit', { competence: 'delais' }))).toBeNull()
    expect(pointDuRunBl(run('ignore', { resultat: { extraction: null } }))).toBeNull()
  })

  it('a BL he could not put on an order still leaves an aide, hung on nothing', () => {
    const r = run('a_verifier', {}, [{ code: 'commande_inconnue', gravite: 'bloquant', message: 'La commande sous-traitant n° 9999 n’existe pas.' }])
    ;(r.resultat as { resolution: unknown }).resolution = { commandeId: null, sousTraitantId: null, lignes: [], ligneId: null, lot: 'MA109731' }
    const p = pointDuRunBl(r)!
    expect(p).toMatchObject({ decision: 'aide', idcommande: 0, idligne: 0, idsousTraitant: 9 })
  })

  it('v5, an unusable order number found by the pieces: the aide hangs on that order, his proposal ready', () => {
    const r = run('a_verifier', {}, [
      { code: 'commande_format', gravite: 'bloquant', message: 'Numéro de commande illisible (« 91788 »).' },
      { code: 'commande_probable', gravite: 'bloquant', message: 'Les 2 pièces de ce BL sont toutes affectées à la commande 9100 (MATEL) : c’est probablement la sienne. Vérifiez avant de réceptionner dessus.' },
    ])
    const p = pointDuRunBl(r)!
    expect(p).toMatchObject({ decision: 'aide', mode: 'supervise', ecrit: false, idcommande: 9100, idligne: 9072 })
    expect(p.explication.split('\n')).toHaveLength(2)
    expect(lireReception(p.proposition)).toMatchObject({ lot: 'MA109731', pieces: [{ metrage: 61.7 }, { metrage: 63.4 }] })
  })

  it('v5, a BL Tricobot received alone leaves an autonomous point: written, nobody has to look', () => {
    const r = run('ecrit')
    ;(r.resultat as { ecriture: unknown }).ecriture = { gedId: 1, lignesEcrites: 2, ids: [1, 2], seul: { le: '2026-11-27T10:00:00.000Z', rouleaux: 2 } }
    const p = pointDuRunBl(r)!
    expect(p).toMatchObject({ decision: 'saisie', mode: 'autonome', ecrit: true, idcommande: 9100, idligne: 9072 })
    expect(p.explication).toContain('2 rouleaux réceptionnés sous le lot MA109731')
    // Drawn alone and handed back (a check, a réception refused): a point like any other.
    ;(r.resultat as { ecriture: unknown }).ecriture = { gedId: 1, lignesEcrites: 2, ids: [1, 2], seulRefuse: 'Un contrôle a été levé sur ce BL : il attend une personne.' }
    expect(pointDuRunBl(r)).toMatchObject({ mode: 'supervise', ecrit: false })
  })
})

describe('v5, a BL drawn « alone »: a doubt always wins over the draw', () => {
  const resolution = { commandeId: 9100, ligneId: 9072, lot: 'MA109731', reprise: null }
  it('is received alone only when not a single check was raised', () => {
    expect(seulPossible([], resolution)).toBe(true)
    expect(seulPossible([{ code: 'commentaire_entete', gravite: 'avertissement', message: 'MATEL a écrit un commentaire sur ce BL : « MAL UNI ».' }], resolution)).toBe(false)
    expect(seulPossible([{ code: 'total_poids', gravite: 'avertissement', message: '…' }], resolution)).toBe(false)
    expect(seulPossible([{ code: 'metrage_suspect', gravite: 'bloquant', message: '…' }], resolution)).toBe(false)
  })
  it('never on a reprise, nor without an order, a line and a lot', () => {
    expect(seulPossible([], { ...resolution, reprise: { idreprise: 110, rang: 1, pieces: ['3583/17'] } })).toBe(false)
    expect(seulPossible([], { ...resolution, commandeId: null })).toBe(false)
    expect(seulPossible([], { ...resolution, ligneId: null })).toBe(false)
    expect(seulPossible([], { ...resolution, lot: ' ' })).toBe(false)
    expect(seulPossible([], null)).toBe(false)
  })
})

describe('v5, a roll corrected after a réception', () => {
  const avant = { numero: '3618/1', lot: 'MA109884', poids: 21, metrage: 75.8 }
  it('says what changed, in the réception’s own words', () => {
    expect(correctionsRouleau(avant, { metrage: 70 })).toEqual(['3618/1 métrage 75,8 → 70 Ml'])
    expect(correctionsRouleau(avant, { poids: 21.4, lot: 'MA109885' })).toEqual(['3618/1 lot MA109884 → MA109885', '3618/1 poids 21 → 21,4 kg'])
    expect(correctionsRouleau(avant, { numero: '3618/11' })).toEqual(['3618/1 numéro 3618/1 → 3618/11'])
  })
  it('a field left as it is, or only a note, is no correction', () => {
    expect(correctionsRouleau(avant, { metrage: 75.8, poids: 21, lot: 'ma 109884', numero: '3618/1' })).toEqual([])
    expect(correctionsRouleau(avant, {})).toEqual([])
  })
})

describe('the proposal as text', () => {
  it('round-trips, numbers rounded to the centime', () => {
    const t = texteReception({ bordereau: '109731A', lot: 'MA109731', ennoblisseur: 'MATEL', pieces: [{ numero: '3182/25', poids: 18.80000019, metrage: 61.7, observations: '1 tache' }] })
    expect(lireReception(t)).toEqual({ bordereau: '109731A', lot: 'MA109731', ennoblisseur: 'MATEL', pieces: [{ numero: '3182/25', poids: 18.8, metrage: 61.7, observations: '1 tache' }] })
  })

  it('reads nothing from a délai or a broken text', () => {
    expect(lireReception('2026-12-02')).toBeNull()
    expect(lireReception('{oops')).toBeNull()
    expect(lireReception(null)).toBeNull()
  })
})
