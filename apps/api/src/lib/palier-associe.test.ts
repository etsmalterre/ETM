import { describe, it, expect } from 'vitest'
import { colorisKey } from './palier-associe.js'
import { parseAssocieeCsv } from './refs-associees.js'
import { geom, pickTrancheIndex, rollSizeFor } from './roll-geometry.js'

describe('colorisKey — pairs a côte with its molleton by colour (LIVA #1217)', () => {
  it('ignores the dyer lab number that differs between two refs dyed the same colour', () => {
    // Lemahieu, order 3891: 329B molleton vs 027A côte.
    expect(colorisKey('0804 noir OTV 63763/2')).toBe(colorisKey('0804 noir OTV 63764/2'))
    expect(colorisKey('2212 rouge bdx 19-1521 tcx 63658/1')).toBe(colorisKey('2212 rouge bdx 19-1521 tcx 63659/2'))
  })
  it('ignores case, accents, spacing and the « (m) » marker', () => {
    expect(colorisKey('0806 Marine Malterre 1401 (m)')).toBe(colorisKey('0806 Marine Malterre 1401(m)'))
    expect(colorisKey('2212 vert forêt')).toBe(colorisKey('2212 VERT  FORET'))
  })
  it('keeps different colours apart', () => {
    expect(colorisKey('2212 rouge bdx 19-1521 tcx 63658/1')).not.toBe(colorisKey('2212 vert forêt 19-0417 tcx 63656/2'))
    expect(colorisKey('0806 Blanc Malterre')).not.toBe(colorisKey('0806 noir malterre'))
  })
  it('is empty for an empty name, which never pairs', () => {
    expect(colorisKey('')).toBe('')
    expect(colorisKey(null)).toBe('')
  })
})

describe('parseAssocieeCsv — the legacy ref_fini.associee CSV', () => {
  it('drops the leading 0, empty items, duplicates and the ref itself', () => {
    expect(parseAssocieeCsv('0,,1498')).toEqual([1498])
    expect(parseAssocieeCsv('0,1769, 274,1769,1744', 1744)).toEqual([1769, 274])
    expect(parseAssocieeCsv('')).toEqual([])
    expect(parseAssocieeCsv(null)).toEqual([])
  })
})

describe('roll geometry', () => {
  it('sizes a roll in Ml with a rounded rendement, in Kg with the écru weight', () => {
    expect(rollSizeFor(3, 20, 2.4000000953)).toBeCloseTo(48)
    expect(rollSizeFor(1, 20, 2.4)).toBe(20)
    expect(rollSizeFor(3, 20, 0)).toBe(0)
  })
  it('puts 570 Ml of 57 Ml rolls in the 10-roll band', () => {
    const { nRolls } = geom(570, 57)
    expect(nRolls).toBe(10)
    expect(pickTrancheIndex(nRolls)).toBe(6)
  })
  it('reads less than a roll as the métrage band', () => {
    expect(pickTrancheIndex(0)).toBe(0)
    expect(pickTrancheIndex(14)).toBe(6)
    expect(pickTrancheIndex(30)).toBe(8)
  })
})
