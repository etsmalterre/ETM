import { describe, expect, it } from 'vitest'
import { apportMesures, mesurer } from '../competences.js'
import type { AgentRun, Evaluation } from '../store.js'
import { pointsBl, pointsDuRun, referenceBl } from './competences-flux.js'
import type { Saisie } from './saisies.js'

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

describe('what a BL run is about', () => {
  it('is its lot once resolved, else the bordereau as printed, else nothing', () => {
    expect(referenceBl(run({ resultat: { resolution: { lot: 'MA109675' }, extraction: { numero_bordereau: '109675A' } } }))).toBe('Lot MA109675')
    expect(referenceBl(run({ resultat: { resolution: null, extraction: { numero_bordereau: '109675A' } } }))).toBe('BL 109675A')
    expect(referenceBl(run({ statut: 'erreur', resultat: {} }))).toBeNull()
  })
})

describe('the points of a Délais / Contrôles run, one by one', () => {
  const saisie = (o: Partial<Saisie>): Saisie => ({
    id: 1, agent: 'bl-ennoblisseur', competence: 'controles', version: 2, runId: 'r', messageId: null, threadId: null,
    creeLe: '2026-11-10T14:00:00Z', mode: 'observation', decision: 'saisie', idsousTraitant: 3, idcommande: 9132, idligne: 7, idsuivilot: 0,
    champ: 'mesures_sst', valeurAvant: null, proposition: null, ecrit: false, explication: '', citation: '', statut: 'validee',
    valeurFinale: null, commentaire: null, douteJustifie: null, douteCommentaire: null, revuPar: null, revuLe: null, ...o,
  })
  const lots = new Map([[41, 'MA109581']])

  it('a lot read is named as the reading printed it, and carries its own token', () => {
    const r = run({ competence: 'controles', resultat: { controles: [
      { lot: '109579', lotEtm: 'MA109579', saisieId: 1 },
      { lot: '109580', lotEtm: null, saisieId: 2 },
    ] } })
    const points = pointsDuRun(r, [saisie({ id: 1, idsuivilot: 40 }), saisie({ id: 2, idsuivilot: 0, statut: 'corrigee' })], lots)
    expect(points).toMatchObject([
      { id: 1, quoi: 'Lot MA109579', statut: 'validee', apport: { fiabilite: { plus: 1, moins: 0, attente: 0 } } },
      { id: 2, quoi: 'Lot 109580', statut: 'corrigee', apport: { fiabilite: { plus: 0, moins: 1, attente: 0 } } },
    ])
  })

  it('a value the reading missed is a point too, named by its lot', () => {
    const r = run({ competence: 'controles', resultat: { controles: [] } })
    expect(pointsDuRun(r, [saisie({ id: 5, decision: 'rien', statut: 'omission', idsuivilot: 41 })], lots))
      .toMatchObject([{ id: 5, quoi: 'Lot MA109581', decision: 'rien', statut: 'omission', apport: { fiabilite: { moins: 1 } } }])
    // A lot that is gone keeps its row.
    expect(pointsDuRun(r, [saisie({ id: 6, statut: 'omission', idsuivilot: 99 })], lots)[0].quoi).toBe('Lot ?')
  })

  it('a délai is named by its order, with the article; a « rien » on the whole reply by the mail', () => {
    const r = run({ competence: 'delais', resultat: { delais: [{ commande: '9132', article: 'JERSEY 160 · NOIR', saisieId: 1 }, { commande: '9133', article: '', saisieId: undefined }] } })
    const points = pointsDuRun(r, [
      saisie({ id: 1, competence: 'delais', champ: 'date_livraison', mode: 'supervise', decision: 'aide', statut: 'a_revoir' }),
      saisie({ id: 2, competence: 'delais', champ: 'date_livraison', mode: 'observation', statut: 'omission', decision: 'rien', idcommande: 9140 }),
      saisie({ id: 3, competence: 'delais', champ: null, mode: 'supervise', decision: 'rien', statut: 'a_revoir', idcommande: 0, idligne: 0 }),
    ], lots)
    expect(points.map((p) => [p.quoi, p.detail])).toEqual([['Commande 9132', 'JERSEY 160 · NOIR'], ['Commande 9140', undefined], ['Mail', undefined]])
    // Supervisé, an aide waiting: it asked, and whether asking was right is not judged yet.
    expect(points[0].apport).toEqual({ fiabilite: { plus: 0, moins: 0, attente: 0 }, autonomie: { plus: 0, moins: 1, attente: 0 }, discernement: { plus: 0, moins: 0, attente: 1 } })
  })
})
