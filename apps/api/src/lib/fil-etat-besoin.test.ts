// LIVA #1139 — the prod figures of 2026-09-10 for 1/60 COTON PEIGNE BIO Z écru
// (ref 5 / coloris 317), pinned so « Besoin » can never count a knitted kilo
// twice again.
import { describe, it, expect } from 'vitest'
import { computeBesoin } from './fil-etat-besoin.js'

// asso_fil_lignecmdsst rows of this fil on the 5 open commandes the widget
// listed (8972 and 8884 were still open on 09/09).
const asso = [
  { ligne: 8946, commande_sst: 8972, lot: '10553', quantite: 3760 },
  { ligne: 8858, commande_sst: 8884, lot: '10547', quantite: 3304 },
  { ligne: 8979, commande_sst: 9005, lot: '10553', quantite: 2820 },
  { ligne: 8972, commande_sst: 8998, lot: '10553', quantite: 990 },
  { ligne: 8978, commande_sst: 9004, lot: '10553', quantite: 462 },
]
const mirrors = [
  { IDligne_commande_client: 13071, IDligne_commande_ETM: 8946 },
  { IDligne_commande_client: 12973, IDligne_commande_ETM: 8858 },
  { IDligne_commande_client: 13129, IDligne_commande_ETM: 8979 },
  { IDligne_commande_client: 13117, IDligne_commande_ETM: 8972 },
  { IDligne_commande_client: 13127, IDligne_commande_ETM: 8978 },
]
const ofs = [
  { IDordre_fabrication: 3554, IDligne_commande_client: 13071 },
  { IDordre_fabrication: 3555, IDligne_commande_client: 13071 },
  { IDordre_fabrication: 3565, IDligne_commande_client: 13071 },
  { IDordre_fabrication: 3566, IDligne_commande_client: 13071 },
  { IDordre_fabrication: 3534, IDligne_commande_client: 12973 },
  { IDordre_fabrication: 3535, IDligne_commande_client: 12973 },
  { IDordre_fabrication: 3536, IDligne_commande_client: 12973 },
  { IDordre_fabrication: 3570, IDligne_commande_client: 13129 },
  { IDordre_fabrication: 3571, IDligne_commande_client: 13129 },
  { IDordre_fabrication: 3572, IDligne_commande_client: 13129 },
  { IDordre_fabrication: 3560, IDligne_commande_client: 13117 },
  { IDordre_fabrication: 3568, IDligne_commande_client: 13127 },
]
// Σ stock_ecru.poids per OF, as one row each (the route passes the pieces).
const pieces = [
  { IDordre_fabrication: 3554, poids: 1611 },
  { IDordre_fabrication: 3555, poids: 1517.2 },
  { IDordre_fabrication: 3565, poids: 506.2 },
  { IDordre_fabrication: 3566, poids: 411.5 },
  { IDordre_fabrication: 3534, poids: 1271.6 },
  { IDordre_fabrication: 3535, poids: 1369.5 },
  { IDordre_fabrication: 3536, poids: 259.4 },
  { IDordre_fabrication: 3570, poids: 627.9 },
  { IDordre_fabrication: 3571, poids: 733.4 },
  { IDordre_fabrication: 3572, poids: 716.6 },
  { IDordre_fabrication: 3560, poids: 1414.74 },
]
// asso_fil_of share of THIS fil (the 6 % elasthanne rows are already filtered out).
const ofFil = [
  ...[3554, 3555, 3565, 3566, 3534, 3535, 3536, 3570, 3571, 3572].map((o) => ({ IDordre_fabrication: o, pourcentage: 94 })),
  { IDordre_fabrication: 3560, pourcentage: 66 },
  { IDordre_fabrication: 3568, pourcentage: 66 },
]

describe('computeBesoin (#1139)', () => {
  const out = computeBesoin({ asso, mirrors, ofs, pieces, ofFil })
  const row = (cmd: number) => out.rows.find((r) => r.commande_sst === cmd)!

  it('deducts what the OFs already knitted, clamped at zero', () => {
    // 8972: 4 045.9 kg × 94 % = 3 803 > 3 760 reserved → nothing left to need.
    expect(row(8972).produit).toBe(3803.1)
    expect(row(8972).kg).toBe(0)
    // 8884: 2 900.5 kg × 94 % = 2 726.5 knitted for 3 304 reserved → 577.5 still
    // needed. The lot (10547) is at stock 0, which does NOT cancel the need:
    // the rest has to come from another lot of the same fil.
    expect(row(8884).produit).toBe(2726.5)
    expect(row(8884).kg).toBe(577.5)
    // 8998: 990 − 1 414.74 × 66 %.
    expect(row(8998).produit).toBe(933.7)
    expect(row(8998).kg).toBe(56.3)
    // 9005: 2 820 − 2 077.9 × 94 %.
    expect(row(9005).kg).toBe(866.8)
    // 9004: OF created, nothing knitted.
    expect(row(9004).produit).toBe(0)
    expect(row(9004).kg).toBe(462)
  })

  it('totals: 11 336 reserved, ~1 963 still needed (the widget said 11 336)', () => {
    expect(out.reserve).toBe(11336)
    expect(out.besoin).toBe(1962.6)
    expect(out.besoin).toBe(out.rows.reduce((s, r) => s + r.kg, 0))
  })

  it('keeps an external tricoteur line whole (no mirror → untracked)', () => {
    const ext = computeBesoin({
      asso: [{ ligne: 1, commande_sst: 42, lot: 'L1', quantite: 500 }],
      mirrors: [], ofs: [], pieces: [], ofFil: [],
    })
    expect(ext.rows[0]).toMatchObject({ suivi: false, produit: 0, kg: 500 })
  })

  it('merges the lots of one line and sums their reservations', () => {
    const two = computeBesoin({
      asso: [
        { ligne: 7, commande_sst: 9, lot: 'A', quantite: 100 },
        { ligne: 7, commande_sst: 9, lot: 'B', quantite: 50 },
      ],
      mirrors: [{ IDligne_commande_client: 70, IDligne_commande_ETM: 7 }],
      ofs: [{ IDordre_fabrication: 700, IDligne_commande_client: 70 }],
      pieces: [{ IDordre_fabrication: 700, poids: 100 }],
      // Both lots feed the OF → their shares add up.
      ofFil: [{ IDordre_fabrication: 700, pourcentage: 60 }, { IDordre_fabrication: 700, pourcentage: 30 }],
    })
    expect(two.rows).toHaveLength(1)
    expect(two.rows[0]).toMatchObject({ lot: 'A, B', reserve: 150, produit: 90, kg: 60, suivi: true })
  })

  it('sorts the biggest remaining need first', () => {
    expect(out.rows.map((r) => r.commande_sst).slice(0, 2)).toEqual([9005, 8884])
  })
})
