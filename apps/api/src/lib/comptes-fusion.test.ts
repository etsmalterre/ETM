import { describe, expect, it } from 'vitest'
import { carteFusion, fusionnerCles, planFusion } from './comptes-fusion.js'

// The production table on 2026-09-30.
const PROD = [
  { idutilisateur: 1, prenom: 'Vincent', nom: 'Malterre' },
  { idutilisateur: 2, prenom: 'Isabelle', nom: 'Malterre' },
  { idutilisateur: 4, prenom: 'Pierre-Emmanuel', nom: 'Roux' },
  { idutilisateur: 10, prenom: 'Visitage', nom: null },
  { idutilisateur: 11, prenom: 'Nicolas', nom: 'Antonino' },
  { idutilisateur: 12, prenom: 'Laetitia', nom: 'Tellier' },
  { idutilisateur: 13, prenom: 'Pierre-Emmanuel', nom: 'Roux' },
  { idutilisateur: 14, prenom: 'Regleur', nom: null },
  { idutilisateur: 15, prenom: 'Laetitia', nom: 'Tellier' },
  { idutilisateur: 18, prenom: 'Vincent', nom: 'Malterre' },
  { idutilisateur: 20, prenom: 'Isabelle', nom: 'Malterre' },
  { idutilisateur: 21, prenom: 'Mickaël', nom: 'Grivelet' },
]

describe('planFusion', () => {
  const plans = planFusion(PROD)

  it('keeps one account per person, on the lowest id', () => {
    expect(plans.map((p) => [p.idutilisateur, p.anciens])).toEqual([
      [1, [18]], [2, [20]], [4, [13]], [10, []], [11, []], [12, [15]], [14, []], [21, []],
    ])
    expect([...carteFusion(plans)]).toEqual([[18, 1], [20, 2], [13, 4], [15, 12]])
  })

  it('derives identifiers from the first name, without accents', () => {
    expect(Object.fromEntries(plans.map((p) => [p.idutilisateur, p.identifiant]))).toEqual({
      1: 'vincent', 2: 'isabelle', 4: 'pierre-emmanuel', 10: 'visitage',
      11: 'nicolas', 12: 'laetitia', 14: 'regleur', 21: 'mickael',
    })
  })

  it('makes rows without a last name station accounts', () => {
    expect(plans.filter((p) => p.typeCompte === 'poste').map((p) => p.idutilisateur)).toEqual([10, 14])
  })

  it('falls back to prenom.nom when two people share a first name', () => {
    const p = planFusion([
      { idutilisateur: 1, prenom: 'Marie', nom: 'Dupont' },
      { idutilisateur: 2, prenom: 'Marie', nom: 'Durand' },
    ])
    expect(p.map((x) => x.identifiant)).toEqual(['marie', 'marie.durand'])
  })

  it('groups names case- and accent-insensitively', () => {
    const p = planFusion([
      { idutilisateur: 5, prenom: 'Éloïse', nom: 'X' },
      { idutilisateur: 3, prenom: 'eloise ', nom: 'x' },
    ])
    expect(p).toHaveLength(1)
    expect(p[0].idutilisateur).toBe(3)
    expect(p[0].anciens).toEqual([5])
  })
})

describe('fusionnerCles', () => {
  it('unions every grant', () => {
    expect(fusionnerCles([['a', 'screen_x'], ['b', 'screen_x']])).toEqual(['a', 'b', 'screen_x'])
  })

  it('keeps a hide key only when every screen-granting row hid it', () => {
    expect(fusionnerCles([
      ['screen_clients', 'hide_clients_facturation'],
      ['screen_clients'],
    ])).toEqual(['screen_clients'])
    expect(fusionnerCles([
      ['screen_clients', 'hide_clients_facturation'],
      ['screen_clients', 'hide_clients_facturation'],
    ])).toEqual(['hide_clients_facturation', 'screen_clients'])
  })

  it('ignores rows that grant no screen when deciding hides', () => {
    expect(fusionnerCles([
      ['screen_clients', 'hide_clients_facturation'],
      ['dashboard_ca'],
    ])).toEqual(['dashboard_ca', 'hide_clients_facturation', 'screen_clients'])
  })
})
