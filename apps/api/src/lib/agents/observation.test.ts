import { describe, expect, it } from 'vitest'
import { conseiller, mesurer, type PointMesure } from './competences.js'
import { aComparer, ecartsAuStock } from './bl-observation.js'
import { pointsBl } from './flux-ennoblisseur/competences-flux.js'
import type { AgentRun } from './store.js'

const p = (o: Partial<PointMesure>): PointMesure => ({ decision: 'saisie', statut: 'observation', le: '2026-11-01T10:00:00Z', observation: true, ...o })

describe('observation (2026-11-05)', () => {
  it('counts points waiting for a comparison apart, and judged ones like any other', () => {
    const m = mesurer([p({}), p({ statut: 'validee' }), p({ statut: 'corrigee' }), p({ decision: 'aide', statut: 'resolue', douteJustifie: true })])
    expect(m.enObservation).toBe(1)
    expect(m.compares).toBe(3)
    expect(m.aRevoir).toBe(0)
    expect(m.fiabilite).toMatchObject({ num: 1, den: 2 })
    expect(m.discernement).toMatchObject({ num: 1, den: 1 })
  })
  it('proposes supervisé from observation at 90 % on 30 compared points', () => {
    const juges = (ok: number, ko: number) => [
      ...Array.from({ length: ok }, (_, i) => p({ statut: 'validee', le: `2026-11-01T10:${String(i).padStart(2, '0')}:00Z` })),
      ...Array.from({ length: ko }, () => p({ statut: 'corrigee' })),
    ]
    expect(conseiller({ mode: 'essai' }, ['off', 'essai', 'supervise'], juges(27, 3)).monter).toMatchObject({ mode: 'supervise' })
    expect(conseiller({ mode: 'essai' }, ['off', 'essai', 'supervise'], juges(26, 4)).monter).toBeNull()
    expect(conseiller({ mode: 'essai' }, ['off', 'essai', 'supervise'], juges(20, 0)).monter).toBeNull()
  })
})

describe('BL in observation', () => {
  const pieces = [{ numero_piece: '3546/1', poids: 21.4, metrage: 108, observations: '' }, { numero_piece: '3546/2', poids: 20, metrage: 104.5, observations: 'Tache' }]
  it('compares the reading with the rolls received, a cut roll read whole', () => {
    const stock = [
      { numero: '3546/1', poids: 11.4, metrage: 58, observation_sst: '' },
      { numero: '3546/1-1', poids: 10, metrage: 50, observation_sst: '' },
      { numero: '3546/2', poids: 20, metrage: 104.5, observation_sst: 'tache' },
    ]
    expect(ecartsAuStock(pieces, stock)).toEqual({ nbEcarts: 0, recues: 2 })
    expect(ecartsAuStock(pieces, [{ numero: '3546/1', poids: 24.1, metrage: 108, observation_sst: '' }])).toEqual({ nbEcarts: 1, recues: 1 })
  })
  const run = (o: Partial<AgentRun>): AgentRun => ({
    id: 'r', slug: 'bl-ennoblisseur', createdAt: '2026-11-04T10:00:00Z', source: 'triage', mode: 'essai', fichiers: [], version: 1, model: '',
    statut: 'simule', resultat: {}, resume: '', coutUsd: 0, dureeMs: 0, ...o,
  })
  it('only runs read in observation are compared, once', () => {
    const t = Date.parse('2026-11-05T10:00:00Z')
    expect(aComparer(run({}), t)).toBe(true)
    expect(aComparer(run({ source: 'essai_manuel' }), t)).toBe(false)
    expect(aComparer(run({ mode: 'actif' }), t)).toBe(false)
    expect(aComparer(run({ observation: { statut: 'validee', ecarts: 0, douteJustifie: null, le: '' } }), t)).toBe(false)
  })
  it('a BL read in observation is a point: pending, then judged', () => {
    expect(pointsBl([run({})])).toMatchObject([{ decision: 'saisie', statut: 'observation', observation: true }])
    expect(pointsBl([run({ statut: 'a_verifier', observation: { statut: 'resolue', ecarts: 2, douteJustifie: true, le: '' } })]))
      .toMatchObject([{ decision: 'aide', statut: 'resolue', douteJustifie: true }])
  })
})
