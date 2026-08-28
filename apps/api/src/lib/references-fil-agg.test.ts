import { describe, it, expect } from 'vitest'
import { aggregateStockFilRows, resteALivrer, type CommandeLine } from './references-fil-agg.js'

// The Linux bridge truncates `terminé` at the accent and appends a
// non-deterministic garbage byte, so the key differs from one query to the
// next. Windows returns it verbatim (and the route aliases it to `termine`).
const TERMINE_KEYS = ['terminé', 'termine', 'termin', 'termint', 'termini', 'terminZ']

describe('aggregateStockFilRows — « Stock actuel »', () => {
  it.each(TERMINE_KEYS)('excludes finished lots whatever shape the flag key takes (%s)', (key) => {
    const rows = [
      { IDcolori_fil: 802, stock: 473.2, [key]: 0 },
      { IDcolori_fil: 802, stock: -186.1, [key]: 1 },
      { IDcolori_fil: 802, stock: -71.3, [key]: 1 },
      { IDcolori_fil: 802, stock: 0, [key]: 1 },
    ]
    const agg = aggregateStockFilRows(rows)
    // This is ticket #1090: reading the flag by a hardcoded name missed every
    // mangled key, so the card summed all four lots (215.8 kg / 4 lots).
    expect(agg.totalKg).toBeCloseTo(473.2, 6)
    expect(agg.lots).toBe(1)
  })

  it('counts unaffected lots in the totals but not in any variante', () => {
    const agg = aggregateStockFilRows([
      { IDcolori_fil: 0, stock: 100, terminé: 0 },
      { IDcolori_fil: 802, stock: 50, terminé: 0 },
    ])
    expect(agg.totalKg).toBe(150)
    expect(agg.lots).toBe(2)
    expect(agg.perVariante.get(802)).toEqual({ total_kg: 50, lots: 1 })
    expect(agg.perVariante.has(0)).toBe(false)
  })

  it('keeps a negative active lot visible — it is a data error, not noise', () => {
    const agg = aggregateStockFilRows([{ IDcolori_fil: 802, stock: -40, terminé: 0 }])
    expect(agg.totalKg).toBe(-40)
    expect(agg.lots).toBe(1)
  })

  it('is empty, not NaN, when the reference has no stock rows', () => {
    expect(aggregateStockFilRows([])).toEqual({ totalKg: 0, lots: 0, perVariante: new Map() })
  })
})

describe('resteALivrer — « En commande »', () => {
  // Real shape of ref_fil 85 (730 PES/CU), the reference quoted on #1090.
  const lines: CommandeLine[] = [
    { IDref_fil_commande: 926, quantite: 800, etat_ligne: 0, etat: 0 }, // nothing received
    { IDref_fil_commande: 842, quantite: 800, etat_ligne: 0, etat: 0 }, // nothing received
    { IDref_fil_commande: 841, quantite: 800, etat_ligne: 0, etat: 0 }, // over-delivered 828
    { IDref_fil_commande: 798, quantite: 800, etat_ligne: 0, etat: 1 }, // commande closed, 491 short
    { IDref_fil_commande: 619, quantite: 600, etat_ligne: 1, etat: 0 }, // line closed, 23 short
  ]
  const recu = new Map([[841, 828], [798, 491], [619, 577]])

  it('counts only what is still awaited on open lines of open commandes', () => {
    // Before the fix this was Σ quantite over the whole history = 3 800 kg.
    expect(resteALivrer(lines, recu)).toEqual({ kg: 1600, lignes: 2 })
  })

  it('never lets an over-delivered line offset a genuine shortfall elsewhere', () => {
    const two: CommandeLine[] = [
      { IDref_fil_commande: 1, quantite: 100, etat_ligne: 0, etat: 0 },
      { IDref_fil_commande: 2, quantite: 100, etat_ligne: 0, etat: 0 },
    ]
    expect(resteALivrer(two, new Map([[1, 500]]))).toEqual({ kg: 100, lignes: 1 })
  })

  it('treats a line with no linked lot as fully outstanding', () => {
    const one: CommandeLine[] = [{ IDref_fil_commande: 7, quantite: 250, etat_ligne: 0, etat: 0 }]
    expect(resteALivrer(one, new Map())).toEqual({ kg: 250, lignes: 1 })
  })

  it('is zero once every line is closed', () => {
    const closed = lines.map((l) => ({ ...l, etat_ligne: 1 }))
    expect(resteALivrer(closed, recu)).toEqual({ kg: 0, lignes: 0 })
  })
})
