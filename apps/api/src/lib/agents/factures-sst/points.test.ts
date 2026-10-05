import { describe, expect, it } from 'vitest'
import type { AgentRun, Evaluation } from '../store.js'
import { bilanFacture, clePoint, pointsFacture, scoreFactures } from './points.js'

const ligne = (lotEtm: string, verdict: string, genre = 'lot', nature: string | null = verdict === 'ecart' ? 'reel' : null) => ({
  lotEtm, verdict, nature, ecartMontant: 0, controles: [], etm: null,
  ligne: { description: lotEtm || 'EMBALLAGE', quantite: 1, unite: 'Kg', prix_unitaire: 1, montant: 1, genre },
})

const run = (id: string, lignes: ReturnType<typeof ligne>[], avisPoints: Record<string, Evaluation> = {}, bloquant = false): AgentRun => ({
  id, slug: 'factures-ennoblisseur', createdAt: '2026-10-02T10:00:00Z', source: 'gmail', mode: 'essai', fichiers: [],
  version: 1, model: 'm', statut: 'simule', resume: '', coutUsd: 0, dureeMs: 0, avisPoints,
  resultat: {
    extraction: { numero_facture: 'FA2938' },
    verification: { lignes, controles: bloquant ? [{ code: 'total', gravite: 'bloquant', message: 'total faux' }] : [], statut: 'ecarts', ecartMontant: 0 },
  } as unknown as Record<string, unknown>,
})

const avis = (note: Evaluation['note'], le = '2026-10-02T11:00:00Z'): Evaluation => ({ note, commentaire: note === 'reussite' ? '' : 'x', par: { id: 1, nom: 'P' }, le })

describe('points of an invoice run', () => {
  const lignes = [ligne('MA108967', 'ecart'), ligne('MA108983', 'conforme'), ligne('MA109407', 'ecart'), ligne('', 'info', 'emballage')]

  it('one point per lot line, raised = what the agent flagged; packaging is no point', () => {
    const ps = pointsFacture(run('a', lignes))
    expect(ps.map((p) => [p.cle, p.souleve])).toEqual([
      [clePoint('FA2938', 0, 'MA108967'), true],
      [clePoint('FA2938', 1, 'MA108983'), false],
      [clePoint('FA2938', 2, 'MA109407'), true],
    ])
  })

  it('an écart the agent could not check is not « à évaluer »', () => {
    expect(pointsFacture(run('a', [ligne('MA1', 'ecart', 'lot', 'non_verifie')]))[0].souleve).toBe(false)
  })

  it('the bilan counts raised lines, plus a conforme line someone scored (a missed gap)', () => {
    expect(bilanFacture(run('a', lignes))).toMatchObject({ points: 2, aEvaluer: 2 })
    const r = run('a', lignes, { [clePoint('FA2938', 0, 'MA108967')]: avis('reussite'), [clePoint('FA2938', 1, 'MA108983')]: avis('echec') })
    expect(bilanFacture(r)).toMatchObject({ points: 3, evalues: 2, reussite: 1, echec: 1, aEvaluer: 1 })
  })

  it('the version score keeps the latest score of the same invoice re-read', () => {
    const k = clePoint('FA2938', 0, 'MA108967')
    const s = scoreFactures([
      run('essai', [lignes[0]], { [k]: avis('echec', '2026-10-02T09:00:00Z') }),
      run('actif', [lignes[0]], { [k]: avis('reussite', '2026-10-03T09:00:00Z') }),
    ])
    expect(s).toMatchObject({ points: 1, reussite: 1, echec: 0, precision: 1 })
  })
})
