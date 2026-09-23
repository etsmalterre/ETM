import { describe, expect, it } from 'vitest'
import { normaliserRun, type AgentRun } from './store.js'

const par = { id: 1, nom: 'Vincent Malterre' }
const run = (extra: Partial<AgentRun>): AgentRun => ({
  id: 'r1', slug: 'bl-ennoblisseur', createdAt: '2026-09-22T10:00:00.000Z', source: 'gmail', mode: 'actif',
  fichiers: [], version: 1, model: 'mistral-small-latest', statut: 'ecrit', resultat: {}, resume: '', coutUsd: 0, dureeMs: 0,
  ...extra,
})

describe('normaliserRun (thumbs / « échouée » before 2026-09-23)', () => {
  it('reads a legacy verdict as an evaluation and drops it', () => {
    const correct = normaliserRun(run({ verdict: { valeur: 'correct', commentaire: '', par, le: 'x' } }))
    expect(correct.evaluation).toEqual({ note: 'reussite', commentaire: '', par, le: 'x', retrait: null })
    expect(correct.verdict).toBeUndefined()
    const incorrect = normaliserRun(run({ verdict: { valeur: 'incorrect', commentaire: 'lot faux', par, le: 'y' } }))
    expect(incorrect.evaluation?.note).toBe('echec')
    expect(incorrect.evaluation?.retrait).toBeNull() // a legacy « incorrect » removed nothing
  })

  it('never overrides an evaluation already given', () => {
    const e = { note: 'partielle' as const, commentaire: 'poids', par, le: 'z' }
    expect(normaliserRun(run({ evaluation: e, verdict: { valeur: 'correct', commentaire: '', par, le: 'x' } })).evaluation).toEqual(e)
  })

  it('leaves an unscored run « à évaluer »', () => {
    expect(normaliserRun(run({})).evaluation).toBeUndefined()
  })
})
