import { describe, it, expect } from 'vitest'
import { aggregateClientsForRef } from './clients-ref-fini.js'

const names = new Map<number, string>([
  [10, 'Le Slip Français'],
  [20, 'Balibaris'],
])

describe('aggregateClientsForRef — « Clients » tab of a ref fini (#1155)', () => {
  it('groups lines by client with distinct order count, Ml and Kg sums', () => {
    const rows = aggregateClientsForRef(
      [
        { IDcommande_client: 1, quantite: 100, unite: 3 },
        { IDcommande_client: 1, quantite: 50, unite: 3 },
        { IDcommande_client: 2, quantite: 12.5, unite: 1 },
        { IDcommande_client: 3, quantite: 30, unite: 3 },
      ],
      [
        { IDcommande_client: 1, IDclient: 10, numero: 3001, date_commande: '20260101' },
        { IDcommande_client: 2, IDclient: 10, numero: 3050, date_commande: '20260301' },
        { IDcommande_client: 3, IDclient: 20, numero: 3020, date_commande: '20260201' },
      ],
      names,
    )
    expect(rows).toHaveLength(2)
    const slip = rows.find((r) => r.IDclient === 10)!
    expect(slip.nom).toBe('Le Slip Français')
    expect(slip.nb_commandes).toBe(2)
    expect(slip.nb_lignes).toBe(3)
    expect(slip.metrage).toBeCloseTo(150, 6)
    expect(slip.poids).toBeCloseTo(12.5, 6)
    expect(slip.derniere_date).toBe('20260301')
    expect(slip.dernier_numero).toBe(3050)
  })

  it('sorts by volume, highest first — Ml before Kg, then by name', () => {
    const rows = aggregateClientsForRef(
      [
        { IDcommande_client: 1, quantite: 500, unite: 3 },
        { IDcommande_client: 2, quantite: 20, unite: 3 },
        { IDcommande_client: 3, quantite: 900, unite: 1 },
      ],
      [
        { IDcommande_client: 1, IDclient: 10, numero: 1, date_commande: '20250101' },
        { IDcommande_client: 2, IDclient: 20, numero: 2, date_commande: '20260101' },
        { IDcommande_client: 3, IDclient: 30, numero: 3, date_commande: '20260201' },
      ],
      names,
    )
    // The Kg-only client (900 Kg) ranks after every Ml buyer, however recent.
    expect(rows.map((r) => r.IDclient)).toEqual([10, 20, 30])
  })

  it('drops lines whose order header is outside the scope', () => {
    // The header set is the partition filter: a line pointing at a TRM order
    // (not returned by the IDsociete = 1 query) must not surface.
    const rows = aggregateClientsForRef(
      [
        { IDcommande_client: 1, quantite: 1, unite: 3 },
        { IDcommande_client: 99, quantite: 1000, unite: 3 },
      ],
      [{ IDcommande_client: 1, IDclient: 10, numero: 1, date_commande: '20260101' }],
      names,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].metrage).toBe(1)
  })

  it('never lets an empty date beat a real one, and falls back to a placeholder name', () => {
    const rows = aggregateClientsForRef(
      [
        { IDcommande_client: 1, quantite: 1, unite: 3 },
        { IDcommande_client: 2, quantite: 1, unite: 3 },
      ],
      [
        { IDcommande_client: 1, IDclient: 77, numero: 5, date_commande: '20260101' },
        { IDcommande_client: 2, IDclient: 77, numero: 9, date_commande: '' },
      ],
      names,
    )
    expect(rows[0].nom).toBe('Client #77')
    expect(rows[0].derniere_date).toBe('20260101')
    expect(rows[0].dernier_numero).toBe(5)
  })
})
