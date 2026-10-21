import { describe, expect, it } from 'vitest'
import { anneeDe, statsClient, type StatsLigne } from './stats-client.js'

const l = (p: Partial<StatsLigne>): StatsLigne => ({
  IDcommande_client: 1, date_commande: '20250115', type_kind: 2, IDreference: 10, ref: 'MOL 200', quantite: 100, unite: 3, ...p,
})

describe('anneeDe', () => {
  it('reads HFSQL and ISO shapes', () => {
    expect(anneeDe('20250115')).toBe(2025)
    expect(anneeDe('2024-03-01T00:00:00Z')).toBe(2024)
  })
  it('refuses empty or absurd dates', () => {
    expect(anneeDe(null)).toBeNull()
    expect(anneeDe('')).toBeNull()
    expect(anneeDe('00000000')).toBeNull()
  })
})

describe('statsClient', () => {
  it('sums quantities and counts distinct orders per year', () => {
    const s = statsClient([
      l({ IDcommande_client: 1, quantite: 100 }),
      l({ IDcommande_client: 1, quantite: 50 }), // second coloris, same order
      l({ IDcommande_client: 2, quantite: 300, date_commande: '20250601' }),
      l({ IDcommande_client: 3, quantite: 200, date_commande: '20230201' }),
    ])
    expect(s.annees).toEqual([2023, 2024, 2025])
    expect(s.references).toHaveLength(1)
    const r = s.references[0]
    expect(r.parAnnee[2025]).toEqual({ quantite: 450, commandes: 2 })
    expect(r.parAnnee[2023]).toEqual({ quantite: 200, commandes: 1 })
    expect(r.parAnnee[2024]).toBeUndefined()
    expect(r.total).toEqual({ quantite: 650, commandes: 3 })
  })

  it('never sums two units of the same reference', () => {
    const s = statsClient([l({ unite: 3 }), l({ unite: 1, IDcommande_client: 2 })])
    expect(s.references).toHaveLength(2)
  })

  it('keeps a fini and an écru with the same id apart', () => {
    const s = statsClient([l({ type_kind: 2 }), l({ type_kind: 1, unite: 1 })])
    expect(s.references.map((r) => r.type_kind).sort()).toEqual([1, 2])
  })

  it('lists what is bought now first', () => {
    const s = statsClient([
      l({ IDreference: 1, ref: 'Ancienne', quantite: 9000, date_commande: '20220101' }),
      l({ IDreference: 2, ref: 'Petite', quantite: 10, date_commande: '20260101', IDcommande_client: 2 }),
      l({ IDreference: 3, ref: 'Grosse', quantite: 500, date_commande: '20260301', IDcommande_client: 3 }),
    ])
    expect(s.references.map((r) => r.ref)).toEqual(['Grosse', 'Petite', 'Ancienne'])
  })

  it('drops undated lines and returns no years for no data', () => {
    expect(statsClient([l({ date_commande: null })])).toEqual({ annees: [], references: [] })
  })
})
