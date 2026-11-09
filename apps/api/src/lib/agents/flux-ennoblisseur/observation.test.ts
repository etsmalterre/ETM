import { describe, expect, it } from 'vitest'
import { contexteAvant, rapprocher, type SaisieHumaine } from './observation.js'
import type { Saisie } from './saisies.js'

const personne = { id: 7, nom: 'Pierre-Emmanuel' }

const humaine = (o: Partial<SaisieHumaine> & Pick<SaisieHumaine, 'id' | 'valeur' | 'le'>): SaisieHumaine => ({
  competence: 'delais', idsousTraitant: 1, idcommande: 9132, idligne: 0, idsuivilot: 0, avant: null, par: personne, ...o,
})

type PointLu = Pick<Saisie, 'id' | 'decision' | 'proposition' | 'idligne' | 'idsuivilot' | 'statut'>
const point = (o: Partial<PointLu> & Pick<PointLu, 'id'>): PointLu => ({
  decision: 'saisie', proposition: '2026-12-02', idligne: 0, idsuivilot: 0, statut: 'observation', ...o,
})

describe('observation driven by people (2026-11-09)', () => {
  it('judges each point by the FIRST value typed on its line, and explains the retypes too', () => {
    const r = rapprocher('delais', [point({ id: 1, idligne: 11 })], [
      humaine({ id: 100, idligne: 11, valeur: '2026-12-09', le: '2026-11-10T09:00:00Z' }),
      humaine({ id: 101, idligne: 11, valeur: '2026-12-02', le: '2026-11-10T08:00:00Z' }),
    ], new Set([11]))
    expect(r.jugements).toHaveLength(1)
    expect(r.jugements[0].humaine.id).toBe(101)
    expect(r.omissions).toEqual([])
    expect(r.rattachees.sort()).toEqual([100, 101])
  })

  it('a value on a line the mail was about, with no point of the reading, is an omission', () => {
    const r = rapprocher('delais', [point({ id: 1, idligne: 11 })], [
      humaine({ id: 100, idligne: 11, valeur: '2026-12-02', le: '2026-11-10T08:00:00Z' }),
      humaine({ id: 200, idligne: 22, valeur: '2026-12-16', le: '2026-11-10T08:05:00Z' }),
    ], new Set([11, 22]))
    expect(r.omissions.map((h) => h.id)).toEqual([200])
    expect(r.rattachees.sort()).toEqual([100, 200])
  })

  it('a value on a line the mail was NOT about stays free (another mail, or hors de portée)', () => {
    const r = rapprocher('delais', [point({ id: 1, idligne: 11 })], [
      humaine({ id: 300, idligne: 33, valeur: '2026-12-16', le: '2026-11-10T08:05:00Z' }),
    ], new Set([11]))
    expect(r.jugements).toEqual([])
    expect(r.omissions).toEqual([])
    expect(r.rattachees).toEqual([])
  })

  it('a point already judged (in real time) is not judged twice, its value is still explained', () => {
    const r = rapprocher('delais', [point({ id: 1, idligne: 11, statut: 'validee' })], [
      humaine({ id: 100, idligne: 11, valeur: '2026-12-02', le: '2026-11-10T08:00:00Z' }),
    ], new Set([11]))
    expect(r.jugements).toEqual([])
    expect(r.rattachees).toEqual([100])
  })

  it('contrôles are matched by lot', () => {
    const r = rapprocher('controles', [point({ id: 1, idligne: 11, idsuivilot: 5, proposition: '{}' })], [
      humaine({ id: 100, competence: 'controles', idligne: 11, idsuivilot: 5, valeur: '{}', le: '2026-11-10T08:00:00Z' }),
      humaine({ id: 101, competence: 'controles', idligne: 11, idsuivilot: 6, valeur: '{}', le: '2026-11-10T08:00:00Z' }),
    ], new Set([5, 6]))
    expect(r.jugements.map((j) => j.humaine.id)).toEqual([100])
    expect(r.omissions.map((h) => h.id)).toEqual([101])
  })

  it('reads the mail against each line as it was before the first value typed, « today » = the mail’s day in Paris', () => {
    const c = contexteAvant('2026-11-09T23:30:00Z', [
      humaine({ id: 2, idligne: 11, valeur: '2026-12-09', le: '2026-11-10T10:00:00Z', avant: { idcommande: 9132, dateLivraison: '20261202', dateDelai: '', sstatut: 'En_Cours' } }),
      humaine({ id: 1, idligne: 11, valeur: '2026-12-02', le: '2026-11-10T08:00:00Z', avant: { idcommande: 9132, dateLivraison: '', dateDelai: '', sstatut: 'Attente_Delai' } }),
      humaine({ id: 3, competence: 'controles', idsuivilot: 5, valeur: '{}', le: '2026-11-10T08:00:00Z', avant: null }),
    ])
    expect(c.aujourdhui).toBe('2026-11-10')
    expect(c.etats['11'].sstatut).toBe('Attente_Delai')
    expect(c.lots).toEqual({ '5': null })
  })
})
