import { describe, expect, it } from 'vitest'
import {
  ETAT_FINI_EXPEDIE,
  ETAT_FINI_VALIDE,
  DONATION_FINI_STRANDED_WHERE,
  attachDonationSql,
  detachDonationSql,
  planDonationSet,
  repairStrandedDonationSql,
} from './donation-pieces.js'

// LIVA #1154 — « Donation ne sortent pas des stocks » : order 3868 had six
// fini rolls attached (3041/4 among them) still in état 3, so Finis › Stock
// kept listing them. Attaching to a donation IS the stock exit.

describe('planDonationSet', () => {
  it('diffs the wanted set against the current one', () => {
    expect(planDonationSet([1, 2, 3], [2, 3, 4])).toEqual({ toAdd: [4], toRemove: [1] })
  })
  it('ignores junk ids and duplicates', () => {
    expect(planDonationSet([1, 0, -5, NaN as unknown as number], [1, 1, 2, 2.5])).toEqual({ toAdd: [2], toRemove: [] })
  })
  it('empties the set when nothing is wanted', () => {
    expect(planDonationSet([7, 8], [])).toEqual({ toAdd: [], toRemove: [7, 8] })
  })
})

describe('attachDonationSql — fini', () => {
  it('stamps état 4 « Expédié » together with the FK (the legacy FEN_Ligne_Donation rule)', () => {
    const sql = attachDonationSql('fini', 7174, [40983, 46324])
    expect(sql).toHaveLength(1)
    expect(sql[0]).toBe(
      `UPDATE stock_fini SET IDcommande_donation = 7174, IDetat_stock_fini = ${ETAT_FINI_EXPEDIE} WHERE IDstock_fini IN (40983,46324)`,
    )
  })
  it('never writes IDligne_expedition — a donation has no avis', () => {
    for (const s of attachDonationSql('fini', 7174, [1])) expect(s).not.toMatch(/IDligne_expedition/)
  })
  it('is a no-op without ids or without a valid commande', () => {
    expect(attachDonationSql('fini', 7174, [])).toEqual([])
    expect(attachDonationSql('fini', 7174, [0, -1])).toEqual([])
    expect(attachDonationSql('fini', 0, [1])).toEqual([])
    expect(attachDonationSql('fini', NaN, [1])).toEqual([])
  })
})

describe('attachDonationSql — écru', () => {
  it('writes the FK only: écru has no état, the TM stock filters on IDcommande_donation', () => {
    const sql = attachDonationSql('ecru', 7174, [43528])
    expect(sql).toEqual(['UPDATE stock_ecru SET IDcommande_donation = 7174 WHERE IDstock_ecru IN (43528)'])
    expect(sql[0]).not.toMatch(/IDetat_stock_fini/)
  })
})

describe('detachDonationSql — fini', () => {
  it('restores état 3 on état-4 rolls FIRST, then clears the FK on the rest (unshipFiniRolls order)', () => {
    const sql = detachDonationSql('fini', 7174, [40983])
    expect(sql).toEqual([
      `UPDATE stock_fini SET IDcommande_donation = 0, IDetat_stock_fini = ${ETAT_FINI_VALIDE} WHERE IDstock_fini IN (40983) AND IDcommande_donation = 7174 AND IDetat_stock_fini = ${ETAT_FINI_EXPEDIE}`,
      'UPDATE stock_fini SET IDcommande_donation = 0 WHERE IDstock_fini IN (40983) AND IDcommande_donation = 7174',
    ])
  })
  it('keeps another état: only état 4 is rolled back to 3', () => {
    const [restore, release] = detachDonationSql('fini', 7174, [1])
    expect(restore).toMatch(new RegExp(`AND IDetat_stock_fini = ${ETAT_FINI_EXPEDIE}$`))
    expect(release).not.toMatch(/IDetat_stock_fini/)
  })
  it('is always scoped on the commande — a roll re-claimed by another donation is never stolen', () => {
    for (const s of detachDonationSql('fini', 7174, [1, 2])) expect(s).toMatch(/IDcommande_donation = 7174/)
  })
  it('covers the whole commande when ids are omitted (DELETE /commandes-client/:id)', () => {
    const sql = detachDonationSql('fini', 7174)
    expect(sql).toEqual([
      `UPDATE stock_fini SET IDcommande_donation = 0, IDetat_stock_fini = ${ETAT_FINI_VALIDE} WHERE IDcommande_donation = 7174 AND IDetat_stock_fini = ${ETAT_FINI_EXPEDIE}`,
      'UPDATE stock_fini SET IDcommande_donation = 0 WHERE IDcommande_donation = 7174',
    ])
    for (const s of sql) expect(s).not.toMatch(/IN \(/)
  })
  it('is a no-op on an empty id list (explicit) or an invalid commande', () => {
    expect(detachDonationSql('fini', 7174, [])).toEqual([])
    expect(detachDonationSql('fini', 0)).toEqual([])
  })
})

describe('detachDonationSql — écru', () => {
  it('clears the FK only, scoped on the commande', () => {
    expect(detachDonationSql('ecru', 7174, [43528])).toEqual([
      'UPDATE stock_ecru SET IDcommande_donation = 0 WHERE IDstock_ecru IN (43528) AND IDcommande_donation = 7174',
    ])
    expect(detachDonationSql('ecru', 7174)).toEqual([
      'UPDATE stock_ecru SET IDcommande_donation = 0 WHERE IDcommande_donation = 7174',
    ])
  })
})

describe('attach → detach round trip', () => {
  it('leaves a fini roll exactly as it was (état 3, no donation)', () => {
    // Simulate the three writes on one row.
    const row = { IDcommande_donation: 0, IDetat_stock_fini: ETAT_FINI_VALIDE }
    const apply = (sql: string) => {
      const set = /SET (.+?) WHERE (.+)$/.exec(sql)!
      const where = set[2]
      const wantsEtat4 = /IDetat_stock_fini = 4$/.test(where)
      const wantsDon = /IDcommande_donation = (\d+)/.exec(where)
      if (wantsEtat4 && row.IDetat_stock_fini !== ETAT_FINI_EXPEDIE) return
      if (wantsDon && row.IDcommande_donation !== Number(wantsDon[1])) return
      for (const part of set[1].split(', ')) {
        const [k, v] = part.split(' = ')
        ;(row as Record<string, number>)[k] = Number(v)
      }
    }
    for (const s of attachDonationSql('fini', 7174, [40983])) apply(s)
    expect(row).toEqual({ IDcommande_donation: 7174, IDetat_stock_fini: ETAT_FINI_EXPEDIE })
    for (const s of detachDonationSql('fini', 7174, [40983])) apply(s)
    expect(row).toEqual({ IDcommande_donation: 0, IDetat_stock_fini: ETAT_FINI_VALIDE })
  })
})

describe('repair of rolls attached before the fix', () => {
  it('targets donation fini rolls never shipped and still in état 3, nothing else', () => {
    expect(DONATION_FINI_STRANDED_WHERE).toBe(
      `IDcommande_donation > 0 AND (IDligne_expedition IS NULL OR IDligne_expedition = 0) AND IDetat_stock_fini = ${ETAT_FINI_VALIDE}`,
    )
    expect(repairStrandedDonationSql()).toBe(
      `UPDATE stock_fini SET IDetat_stock_fini = ${ETAT_FINI_EXPEDIE} WHERE ${DONATION_FINI_STRANDED_WHERE}`,
    )
  })
})
