import { describe, it, expect } from 'vitest'
import { grouperAffectations } from './affectations-sst.js'

const clients = new Map([
  [10, { IDcommande_client: 1, numero: '5120', IDclient: 7, nom: 'SIMONE PERELE' }],
  [11, { IDcommande_client: 2, numero: '5098', IDclient: 7, nom: 'SIMONE PERELE' }],
  [20, { IDcommande_client: 3, numero: '5130', IDclient: 8, nom: 'LISE CHARMEL' }],
])
const piece = (lcc: number, poids: number, donation = false) => ({ idligneCommandeClient: lcc, donation, poids, metrage: 0 })

describe('grouperAffectations', () => {
  it('groups by client, then don, then stock — biggest client first', () => {
    const out = grouperAffectations(
      [piece(20, 30), piece(10, 25), piece(11, 25), piece(0, 12), piece(99, 5), piece(10, 3, true)],
      clients,
    )
    expect(out.map((a) => [a.kind, a.nom, a.pieces, a.poids])).toEqual([
      ['client', 'SIMONE PERELE', 2, 50],
      ['client', 'LISE CHARMEL', 1, 30],
      ['don', 'Don', 1, 3],
      // an unknown client line (deleted) counts as stock
      ['stock', 'Stock', 2, 17],
    ])
    expect(out[0].commandes.map((c) => c.numero)).toEqual(['5098', '5120'])
  })

  it('returns nothing for no piece', () => {
    expect(grouperAffectations([], clients)).toEqual([])
  })
})
