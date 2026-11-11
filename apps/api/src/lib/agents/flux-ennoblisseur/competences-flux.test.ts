import { describe, expect, it } from 'vitest'
import { apportMesures, mesurer } from '../competences.js'
import type { AgentRun, Evaluation } from '../store.js'
import { pointsBl } from './competences-flux.js'

const par = { id: 1, nom: 'Pilote' }
const run = (o: Partial<AgentRun>): AgentRun => ({
  id: 'r', slug: 'bl-ennoblisseur', createdAt: '2026-11-03T10:00:00Z', source: 'triage', mode: 'actif', fichiers: [], version: 4, model: '',
  statut: 'ecrit', resultat: {}, resume: '', coutUsd: 0, dureeMs: 0, ...o,
})
const note = (n: Evaluation['note']): Evaluation => ({ note: n, commentaire: '', par, le: '2026-11-04T15:00:00Z' })
const verifie = { statutAvant: 'a_verifier' as const, commentaire: '', par, le: '2026-11-04T15:04:00Z' }

describe('the BL point of a run in service', () => {
  it('a BL written is a saisie: its score is the fiabilité', () => {
    expect(pointsBl([run({})])).toMatchObject([{ decision: 'saisie', statut: 'a_revoir' }])
    expect(pointsBl([run({ evaluation: note('reussite') })])).toMatchObject([{ decision: 'saisie', statut: 'validee' }])
    expect(pointsBl([run({ evaluation: note('echec') })])).toMatchObject([{ decision: 'saisie', statut: 'corrigee' }])
  })

  it('a BL left to a person is an aide: the score a pilot gives it says whether asking was right', () => {
    // Blocked on a roll printed twice, the person had it cut: asking was right.
    expect(pointsBl([run({ statut: 'verifie', verification: verifie, evaluation: note('reussite') })]))
      .toMatchObject([{ decision: 'aide', statut: 'resolue', douteJustifie: true }])
    // Blocked on « 9040+9045 » while everything could be resolved: it could decide alone.
    expect(pointsBl([run({ statut: 'verifie', verification: verifie, evaluation: note('echec') })]))
      .toMatchObject([{ decision: 'aide', statut: 'resolue', douteJustifie: false }])
    // Scored before anyone marked it « vérifié »: judged all the same.
    expect(pointsBl([run({ statut: 'a_verifier', evaluation: note('reussite') })]))
      .toMatchObject([{ decision: 'aide', statut: 'resolue', douteJustifie: true }])
  })

  it('an aide nobody scored still waits, even once handled by hand', () => {
    expect(pointsBl([run({ statut: 'a_verifier' })])).toMatchObject([{ decision: 'aide', statut: 'a_revoir', douteJustifie: null }])
    expect(pointsBl([run({ statut: 'verifie', verification: verifie })])).toMatchObject([{ decision: 'aide', statut: 'a_revoir', douteJustifie: null }])
  })

  it('an error checked by hand, a duplicate, an ignored mail and a PDF test are no point', () => {
    expect(pointsBl([
      run({ statut: 'verifie', verification: { ...verifie, statutAvant: 'erreur' } }),
      run({ statut: 'deja_importe' }),
      run({ statut: 'ignore' }),
      run({ statut: 'erreur' }),
      run({ source: 'essai_manuel' }),
    ])).toEqual([])
  })

  it('the discernement counts the scored requests only, never the unscored ones as justified', () => {
    const points = pointsBl([
      run({ statut: 'verifie', verification: verifie, evaluation: note('reussite') }),
      run({ statut: 'verifie', verification: verifie, evaluation: note('echec') }),
      run({ statut: 'verifie', verification: verifie }),
      run({ evaluation: note('reussite') }),
    ])
    const m = mesurer(points)
    expect(m.discernement).toMatchObject({ num: 1, den: 2 })
    expect(m.fiabilite).toMatchObject({ num: 1, den: 1 })
    expect(m.autonomie).toMatchObject({ num: 1, den: 4 })
    expect(m.aRevoir).toBe(1)
  })

  it('one run brings one point to the measures that apply to it', () => {
    const z = { plus: 0, moins: 0, attente: 0 }
    // It asked and was right to: nothing on the fiabilité, −1 autonomie, +1 discernement.
    expect(apportMesures(pointsBl([run({ statut: 'verifie', verification: verifie, evaluation: note('reussite') })])))
      .toEqual({ fiabilite: z, autonomie: { ...z, moins: 1 }, discernement: { ...z, plus: 1 } })
    // It asked, nobody judged yet.
    expect(apportMesures(pointsBl([run({ statut: 'a_verifier' })])))
      .toEqual({ fiabilite: z, autonomie: { ...z, moins: 1 }, discernement: { ...z, attente: 1 } })
    // It acted and was corrected at the réception.
    expect(apportMesures(pointsBl([run({ evaluation: note('echec') })])))
      .toEqual({ fiabilite: { ...z, moins: 1 }, autonomie: { ...z, plus: 1 }, discernement: z })
  })
})
