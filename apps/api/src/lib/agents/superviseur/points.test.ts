import { describe, expect, it } from 'vitest'
import type { AgentRun } from '../store.js'
import type { ConstatRun } from './constats.js'
import { estTraite, noteDuTraitement, rapportCourant, TraitementInvalide } from './points.js'

const par = { id: 1, nom: 'Isabelle' }

const c = (id: string, extra: Partial<ConstatRun> = {}): ConstatRun => ({
  cle: `test:${id}`, controle: 'test', domaine: 'mails', gravite: 'attention', titre: `Point ${id}`,
  message: 'm', lien: null, etat: 'nouveau', depuis: '2026-09-28T03:00:00.000Z', ...extra,
})

const run = (id: string, createdAt: string, extra: Partial<AgentRun> = {}): AgentRun => ({
  id, slug: 'superviseur', createdAt, source: 'planifie', mode: 'actif', fichiers: [], version: 1, model: 'x',
  statut: 'points_a_voir', resultat: { constats: [c('1')] }, resume: '', coutUsd: 0, dureeMs: 0, ...extra,
})

describe('rapportCourant', () => {
  it('reads the latest scheduled report, never a later manual preview', () => {
    const r = rapportCourant([
      run('a', '2026-09-27T03:00:00Z'),
      run('b', '2026-09-28T03:00:00Z'),
      run('c', '2026-09-28T13:00:00Z', { source: 'manuel' }),
    ])
    expect(r?.id).toBe('b')
  })

  it('skips failed runs, and falls back to any report when none is scheduled (dev)', () => {
    expect(rapportCourant([
      run('a', '2026-09-27T03:00:00Z'),
      run('b', '2026-09-28T03:00:00Z', { statut: 'erreur', resultat: {} }),
    ])?.id).toBe('a')
    expect(rapportCourant([run('m', '2026-09-28T13:00:00Z', { source: 'manuel' })])?.id).toBe('m')
    expect(rapportCourant([])).toBeNull()
  })
})

describe('estTraite', () => {
  const r = run('b', '2026-09-28T03:00:00Z')
  const le = '2026-09-28T08:00:00Z'

  it('a point nobody handled stays in the queue — a plain réussite score is not a handling', () => {
    expect(estTraite(c('1'), r, {}, {})).toBe(false)
    expect(estTraite(c('1'), r, { 'test:1': { note: 'reussite', commentaire: '', par, le, runId: 'b', titre: 't' } }, {})).toBe(false)
  })

  it('traité (a résolu) or fausse alerte (an échec) takes it out, on this report or a later one', () => {
    expect(estTraite(c('1'), { ...r, resolutionsPoints: { 'test:1': { commentaire: '', par, le } } }, {}, {})).toBe(true)
    expect(estTraite(c('1'), { ...r, avisPoints: { 'test:1': { note: 'echec', commentaire: 'faux', par, le } } }, {}, {})).toBe(true)
    expect(estTraite(c('1'), r, {}, { 'test:1': { commentaire: '', par, le, runId: 'z', titre: 't' } })).toBe(true)
    expect(estTraite(c('1'), r, { 'test:1': { note: 'echec', commentaire: 'x', par, le, runId: 'z', titre: 't' } }, {})).toBe(true)
  })

  it('comes back when the problem changed (the client wrote again)', () => {
    const res = { 'test:1': { commentaire: '', par, le, runId: 'z', titre: 't', empreinte: 'msg-1' } }
    expect(estTraite(c('1', { empreinte: 'msg-2' }), r, {}, res)).toBe(false)
    expect(estTraite(c('1', { empreinte: 'msg-1' }), r, {}, res)).toBe(true)
  })
})

describe('noteDuTraitement', () => {
  it('traité = réussite with no comment; « pouvait être mieux » = partielle; fausse alerte = échec', () => {
    expect(noteDuTraitement('traite', false, '')).toBe('reussite')
    expect(noteDuTraitement('traite', true, 'mauvais client')).toBe('partielle')
    expect(noteDuTraitement('fausse_alerte', false, 'déjà réglé')).toBe('echec')
  })

  it('only what can be improved needs a comment — and then it is required', () => {
    expect(() => noteDuTraitement('traite', true, '  ')).toThrow(TraitementInvalide)
    expect(() => noteDuTraitement('fausse_alerte', false, '')).toThrow(TraitementInvalide)
  })
})
