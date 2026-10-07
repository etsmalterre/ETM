import { describe, expect, it } from 'vitest'
import type { AgentRun } from '../store.js'
import type { ConstatRun } from './constats.js'
import { bilanRun, notesDuBilan, scorePoints } from './score.js'

const par = { id: 1, nom: 'Isabelle' }
const point = (cle: string, extra: Partial<ConstatRun> = {}): ConstatRun => ({
  cle, controle: 'couverture', domaine: 'commandes_client', gravite: 'attention', titre: cle, message: '', lien: null,
  etat: 'nouveau', depuis: '2026-09-23T05:00:00.000Z', ...extra,
})
const run = (id: string, constats: ConstatRun[], extra: Partial<AgentRun> = {}, ecartes: ConstatRun[] = []): AgentRun => ({
  id, slug: 'superviseur', createdAt: '2026-09-23T05:00:00.000Z', source: 'planifie', mode: 'actif', fichiers: [],
  version: 1, model: 'mistral-small-latest', statut: 'points_a_voir', resume: '', coutUsd: 0, dureeMs: 0,
  resultat: { constats, ecartes, fermes: [], controles: [], memoireMiseAJour: true },
  ...extra,
})
const avis = (note: 'reussite' | 'echec', le = '2026-09-23T08:00:00.000Z') => ({ note, commentaire: '', par, le })

describe('bilanRun', () => {
  it('counts the points of one report by their score', () => {
    const r = run('r1', [point('a'), point('b'), point('c'), point('d')], {
      avisPoints: { a: avis('reussite'), b: avis('echec'), c: avis('echec') },
    })
    expect(bilanRun(r)).toEqual({ points: 4, evalues: 3, reussite: 1, echec: 2, aEvaluer: 1 })
  })

  it('takes a score carried from an earlier report as given', () => {
    const r = run('r2', [point('a', { etat: 'ouvert', avis: avis('reussite') }), point('b')])
    expect(bilanRun(r)).toMatchObject({ evalues: 1, reussite: 1, aEvaluer: 1 })
  })

  it('is null for a run without findings, empty for a clean report', () => {
    expect(bilanRun(run('r3', [], { resultat: {} }))).toBeNull()
    expect(bilanRun(run('r4', []))).toEqual({ points: 0, evalues: 0, reussite: 0, echec: 0, aEvaluer: 0 })
  })
})

describe('notesDuBilan', () => {
  it('lists the notes present and a_evaluer while a point is unscored', () => {
    expect([...notesDuBilan({ points: 3, evalues: 2, reussite: 1, echec: 1, aEvaluer: 1 })].sort())
      .toEqual(['a_evaluer', 'echec', 'reussite'])
    expect(notesDuBilan(null).size).toBe(0)
  })
})

describe('scorePoints', () => {
  it('scores each distinct finding once, by its latest avis', () => {
    const lundi = run('r1', [point('a'), point('b')], { avisPoints: { a: avis('echec', '2026-09-21T08:00:00.000Z') } })
    const mardi = run('r2', [point('a', { etat: 'ouvert' }), point('c')], { avisPoints: { a: avis('reussite', '2026-09-22T08:00:00.000Z') } })
    const s = scorePoints([lundi, mardi])
    expect(s).toEqual({ points: 3, evalues: 1, reussite: 1, echec: 0, aEvaluer: 2, precision: 1 })
  })

  it('counts a point set aside as the false alarm it is', () => {
    const r = run('r1', [point('a', { avis: avis('reussite') })], {}, [point('b', { avis: avis('echec') })])
    expect(scorePoints([r])).toMatchObject({ points: 2, evalues: 2, reussite: 1, echec: 1, precision: 0.5 })
  })

  it('reads an old « partielle » carried on a point as échec', () => {
    const r = run('r1', [point('a', { avis: { ...avis('reussite'), note: 'partielle' as never } }), point('b', { avis: avis('reussite') })])
    const s = scorePoints([r])
    expect(s).toEqual({ points: 2, evalues: 2, reussite: 1, echec: 1, aEvaluer: 0, precision: 0.5 })
    expect(s.reussite + s.echec + s.aEvaluer).toBe(s.points)
  })

  it('counts a point closed with nobody correcting it as a réussite', () => {
    const lundi = run('r1', [point('a'), point('b'), point('c')])
    const mardi = run('r2', [point('c', { etat: 'ouvert' })], {
      createdAt: '2026-09-24T05:00:00.000Z',
      resultat: {
        constats: [point('c', { etat: 'ouvert' })], ecartes: [], controles: [], memoireMiseAJour: true,
        fermes: [{ cle: 'a', titre: 'a', domaine: 'commandes_client', depuis: '2026-09-23T05:00:00.000Z', raison: 'Ligne couverte.' }],
      },
    })
    expect(scorePoints([lundi, mardi])).toEqual({ points: 3, evalues: 1, reussite: 1, echec: 0, aEvaluer: 2, precision: 1 })
  })

  it('keeps a correction given before the point closed', () => {
    const lundi = run('r1', [point('a')], { avisPoints: { a: avis('echec') } })
    const mardi = run('r2', [], {
      createdAt: '2026-09-24T05:00:00.000Z',
      resultat: { constats: [], ecartes: [], controles: [], memoireMiseAJour: true,
        fermes: [{ cle: 'a', titre: 'a', domaine: 'commandes_client', depuis: '2026-09-23T05:00:00.000Z' }] },
    })
    expect(scorePoints([lundi, mardi])).toMatchObject({ points: 1, echec: 1, reussite: 0 })
  })

  it('counts a point a person marked résolu without a score as a réussite', () => {
    const r = run('r1', [point('a'), point('b')], { resolutionsPoints: { a: { commentaire: 'fait', par, le: '2026-09-23T08:00:00.000Z' } } })
    expect(scorePoints([r])).toMatchObject({ points: 2, reussite: 1, aEvaluer: 1 })
  })

  it('does not settle a point on a manual preview', () => {
    const apercu = run('r1', [], {
      source: 'manuel',
      resultat: { constats: [], ecartes: [], controles: [], memoireMiseAJour: false,
        fermes: [{ cle: 'a', titre: 'a', domaine: 'commandes_client', depuis: '2026-09-23T05:00:00.000Z' }] },
    })
    expect(scorePoints([run('r0', [point('a')]), apercu])).toMatchObject({ points: 1, aEvaluer: 1, reussite: 0 })
  })

  it('leaves the points raised by the previous version to that version', () => {
    const v1 = point('v1', { depuis: '2026-09-20T05:00:00.000Z', etat: 'ouvert', avis: avis('reussite', '2026-09-21T08:00:00.000Z') })
    const r = run('r1', [v1, point('v2')], {
      resultat: { constats: [v1, point('v2')], ecartes: [], controles: [], memoireMiseAJour: true,
        fermes: [{ cle: 'v1-bis', titre: '', domaine: 'mails', depuis: '2026-09-19T05:00:00.000Z' }] },
    })
    expect(scorePoints([r])).toEqual({ points: 1, evalues: 0, reussite: 0, echec: 0, aEvaluer: 1, precision: null })
  })

  it('has no précision before anyone scores', () => {
    expect(scorePoints([run('r1', [point('a')])]).precision).toBeNull()
    expect(scorePoints([]).points).toBe(0)
  })
})
