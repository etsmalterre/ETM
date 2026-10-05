import { describe, expect, it } from 'vitest'
import { estPublie, normaliserRun, type AgentRun } from './store.js'

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
    const e = { note: 'echec' as const, commentaire: 'poids', par, le: 'z' }
    expect(normaliserRun(run({ evaluation: e, verdict: { valeur: 'correct', commentaire: '', par, le: 'x' } })).evaluation).toEqual(e)
  })

  it('reads an old « partielle » as an échec (binary scale since 2026-10-02)', () => {
    const old = { note: 'partielle', commentaire: 'poids', par, le: 'z' } as unknown as import('./store.js').Evaluation
    const r = normaliserRun(run({ evaluation: old, avisPoints: { k: old } }))
    expect(r.evaluation?.note).toBe('echec')
    expect(r.avisPoints?.k.note).toBe('echec')
  })

  it('leaves an unscored run « à évaluer »', () => {
    expect(normaliserRun(run({})).evaluation).toBeUndefined()
  })
})

describe('estPublie (the Prompt tab offers a shipped version until then)', () => {
  const livre = { model: 'mistral-small-latest', prompt: 'P1', note: 'Version 2 — comportement' }
  it('needs the same prompt AND note — a behaviour change may keep the prompt (BL v2)', () => {
    expect(estPublie(livre, [{ prompt: 'P1', note: 'Version initiale' }])).toBe(false)
    expect(estPublie(livre, [{ prompt: 'P1 ', note: 'Version initiale' }, { prompt: 'P1', note: 'Version 2 — comportement ' }])).toBe(true)
  })
  it('a new prompt is not published by an old version of the same note', () => {
    expect(estPublie(livre, [{ prompt: 'P0', note: 'Version 2 — comportement' }])).toBe(false)
  })
})
