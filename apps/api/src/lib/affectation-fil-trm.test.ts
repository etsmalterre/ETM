// LIVA #1159 — the affectation gate on OF launch, on the prod figures of
// 2026-09-14: sst 9032 (ref 029, 94 % coton peigné bio / 6 % élasthanne) was
// launched on three OFs with no affectation at all.
import { describe, it, expect } from 'vitest'
import { isPairAffected, missingAffectations } from './affectation-fil-trm.js'

const composition9032 = [
  { IDref_fil: 5, IDcolori_fil: 317 },  // 1/60 COTON PEIGNE BIO Z écru, lot 10553
  { IDref_fil: 8, IDcolori_fil: 338 },  // 22 ELASTHANNE écru, lot 10379
]
const lot10553 = { IDstock_fil: 1820, IDref_fil: 5, IDcolori_fil: 317, lot: '10553', quantite: 2820 }
const lot10379 = { IDstock_fil: 1646, IDref_fil: 8, IDcolori_fil: 338, lot: '10379', quantite: 180 }

describe('missingAffectations (#1159)', () => {
  it('names every fil of the composition when nothing is affected — sst 9032 as found on prod', () => {
    expect(missingAffectations(composition9032, [])).toEqual(composition9032)
  })

  it('names only the fil left out — coton affected, élasthanne forgotten', () => {
    expect(missingAffectations(composition9032, [lot10553])).toEqual([{ IDref_fil: 8, IDcolori_fil: 338 }])
  })

  it('passes once every fil has a lot — sst 9005 as found on prod', () => {
    expect(missingAffectations(composition9032, [lot10553, lot10379])).toEqual([])
  })

  it('is about the fil, not the lot: another lot of the same fil is fine', () => {
    const lot10547 = { ...lot10553, IDstock_fil: 1700, lot: '10547' }
    expect(missingAffectations(composition9032, [lot10547, lot10379])).toEqual([])
  })

  it('a coloris of the fil other than the affected one is a different fil', () => {
    const autreColoris = { ...lot10379, IDcolori_fil: 900 }
    expect(missingAffectations(composition9032, [lot10553, autreColoris])).toEqual([{ IDref_fil: 8, IDcolori_fil: 338 }])
  })

  it('a composition row without coloris (older refs) accepts any coloris of the fil', () => {
    expect(isPairAffected({ IDref_fil: 8, IDcolori_fil: 0 }, [lot10379])).toBe(true)
  })

  it('reports a pair once even when two feeding positions carry it', () => {
    const doubled = [composition9032[0], composition9032[0], composition9032[1]]
    expect(missingAffectations(doubled, [])).toHaveLength(2)
  })
})
