import { describe, expect, it } from 'vitest'
import { normaliserRun, separerCorrections, type AgentRun } from './store.js'

describe('separerCorrections', () => {
  it('a retour made only of field changes has no comment', () => {
    const t = '3182/25 observation « 4 défauts » → « 4 défauts - MAL UNI » ; 3182/26 poids 19,4 → 19,6'
    expect(separerCorrections(t)).toEqual({ commentaire: '', corrections: ['3182/25 observation « 4 défauts » → « 4 défauts - MAL UNI »', '3182/26 poids 19,4 → 19,6'] })
  })
  it('splits the comment from the changes', () => {
    const t = 'Je rajoute un R au lot. — 3528/1 lot MA109102 → MA109102R ; 3528/3 lot MA109102 → MA109102R'
    expect(separerCorrections(t)).toEqual({ commentaire: 'Je rajoute un R au lot.', corrections: ['3528/1 lot MA109102 → MA109102R', '3528/3 lot MA109102 → MA109102R'] })
  })
  it('keeps a comment that itself holds a dash', () => {
    const t = 'Métrage réel 77.10 — 9 m déduits — 3570/16 métrage 77.1 → 68.1 Ml'
    expect(separerCorrections(t)).toEqual({ commentaire: 'Métrage réel 77.10 — 9 m déduits', corrections: ['3570/16 métrage 77.1 → 68.1 Ml'] })
  })
  it('a plain comment stays a comment', () => {
    expect(separerCorrections('Le lot est faux → à revoir')).toEqual({ commentaire: 'Le lot est faux → à revoir', corrections: [] })
  })
  it('normaliserRun splits a stored retour and its original (avant)', () => {
    const par = { id: 4, nom: 'P' }
    const r = normaliserRun({
      id: 'x', slug: 'bl', createdAt: '', source: 'gmail', mode: 'actif', fichiers: [], version: 2, model: '', statut: 'ecrit', resultat: {}, resume: '', coutUsd: 0, dureeMs: 0,
      evaluation: { note: 'reussite', commentaire: 'ok', par, le: '', avant: { note: 'echec', commentaire: 'R — 3528/1 lot A → AR', par, le: '' } },
    } as AgentRun)
    expect(r.evaluation?.avant).toMatchObject({ commentaire: 'R', corrections: ['3528/1 lot A → AR'] })
    expect(r.evaluation?.commentaire).toBe('ok')
  })
})
