import { describe, expect, it } from 'vitest'
import { groupFormelle, type FormelleCandidate, type FormelleClient, type FormelleCommande } from './facturation-groupes.js'

// The Agape shape (LIVA #1117): client 234 bills to Temara (428) on every
// commande, ships some of them to C2TEC in France (858).
const clients = new Map<number, FormelleClient>([
  [234, { interne: 0 }],
  [1, { interne: 1 }], // Ets Malterre itself
  [500, { interne: 0 }],
])
const cmds = new Map<number, FormelleCommande>([
  [7026, { IDclient: 234, IDadresse_facturation: 428, donation: 0 }],
  [6984, { IDclient: 234, IDadresse_facturation: 428, donation: 0 }],
  [6901, { IDclient: 234, IDadresse_facturation: 428, donation: 0 }],
  [9001, { IDclient: 234, IDadresse_facturation: 428, donation: 1 }],
  [9002, { IDclient: 1, IDadresse_facturation: 0, donation: 0 }],
  [9003, { IDclient: 500, IDadresse_facturation: 0, donation: 0 }],
  [9004, { IDclient: 500, IDadresse_facturation: 1200, donation: 0 }],
])

function c(id: number, cmdId: number, adrLivraison: number): FormelleCandidate {
  return { id, cmdId, adrLivraison }
}

describe('groupFormelle', () => {
  it('splits one client by delivery address — the #1117 rule', () => {
    const r = groupFormelle([c(11924, 7026, 858), c(11925, 6984, 428), c(11926, 6901, 858)], cmds, clients)
    expect(r.groups).toHaveLength(2)
    const c2tec = r.groups.find((g) => g.adrLivraison === 858)!
    const temara = r.groups.find((g) => g.adrLivraison === 428)!
    expect(c2tec.expeditions.map((e) => e.id)).toEqual([11924, 11926])
    expect(temara.expeditions.map((e) => e.id)).toEqual([11925])
    expect(c2tec.adrFacturation).toBe(428)
    expect(r.multiAdresses).toEqual(new Set([234]))
  })

  it('keeps a client on ONE proforma when every avis went to the same address', () => {
    const r = groupFormelle([c(2, 7026, 858), c(1, 6901, 858)], cmds, clients)
    expect(r.groups).toHaveLength(1)
    // Ordered by expedition id, whatever the input order.
    expect(r.groups[0].expeditions.map((e) => e.id)).toEqual([1, 2])
    expect(r.multiAdresses.size).toBe(0)
  })

  it("splits on the commande's billing address too — the legacy GenererFacturesETM key", () => {
    const r = groupFormelle([c(1, 9003, 700), c(2, 9004, 700)], cmds, clients)
    expect(r.groups.map((g) => g.adrFacturation)).toEqual([0, 1200])
    expect(r.multiAdresses).toEqual(new Set([500]))
  })

  it('skips donations, internes and detached avis, counting each', () => {
    const r = groupFormelle([c(1, 9001, 428), c(2, 9002, 5), c(3, 0, 5), c(4, 424242, 5)], cmds, clients)
    expect(r.groups).toHaveLength(0)
    expect(r.skippedDonation).toBe(1)
    expect(r.skippedInterne).toBe(1)
    expect(r.skippedVide).toBe(2)
  })

  it('treats a missing delivery address as one bucket, not one per avis', () => {
    const r = groupFormelle([c(1, 7026, 0), c(2, 6984, 0)], cmds, clients)
    expect(r.groups).toHaveLength(1)
    expect(r.groups[0].adrLivraison).toBe(0)
  })
})
