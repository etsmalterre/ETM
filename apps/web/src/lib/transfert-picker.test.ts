import { describe, expect, it } from 'vitest'
import { clickSelection, pruneSelection, queuedSummary } from './transfert-picker'

describe('pruneSelection (LIVA #1120)', () => {
  it('drops every ticked id that the tab no longer displays', () => {
    // 58 rolls ticked under search A, then the search narrows to 13 other rows.
    const ticked = new Set(Array.from({ length: 58 }, (_, i) => 1000 + i))
    const visible = Array.from({ length: 13 }, (_, i) => 5000 + i)
    expect(pruneSelection(ticked, visible).size).toBe(0)
  })

  it('keeps the ids still on screen, and only those', () => {
    const ticked = new Set([1, 2, 3, 4])
    expect([...pruneSelection(ticked, [2, 4, 9])]).toEqual([2, 4])
  })

  it('returns the same Set instance when nothing has to go (no re-render)', () => {
    const ticked = new Set([7, 8])
    expect(pruneSelection(ticked, [8, 7, 6])).toBe(ticked)
  })

  it('empties the selection while a new search is loading (no rows visible)', () => {
    expect(pruneSelection(new Set([1]), []).size).toBe(0)
  })
})

describe('queuedSummary', () => {
  const kg = (v: number) => v.toFixed(1).replace('.', ',')
  it('reads plainly when only the active tab contributes', () => {
    expect(queuedSummary({ count: 4, poids: 81.5 }, [{ label: 'Fini', count: 0, poids: 0 }], kg))
      .toBe('4 à ajouter (81,5 kg)')
  })
  it('names the other tab when rolls are ticked there', () => {
    expect(queuedSummary({ count: 13, poids: 260 }, [{ label: 'Fini', count: 2, poids: 30 }], kg))
      .toBe('15 à ajouter (290,0 kg), dont 2 sur Fini')
  })
})

describe('clickSelection (LIVA #1390, mps_designer §44)', () => {
  const ids = [10, 11, 12, 13, 14]

  it('a plain click toggles the row and becomes the anchor', () => {
    const r = clickSelection(new Set(), ids, null, 12, false)
    expect([...r.selected]).toEqual([12])
    expect(r.anchor).toBe(12)
    expect(clickSelection(r.selected, ids, r.anchor, 12, false).selected.size).toBe(0)
  })

  it('Shift+click ticks the whole range from the anchor, in either direction', () => {
    expect([...clickSelection(new Set([11]), ids, 11, 14, true).selected].sort()).toEqual([11, 12, 13, 14])
    expect([...clickSelection(new Set([14]), ids, 14, 11, true).selected].sort()).toEqual([11, 12, 13, 14])
  })

  it('Shift+click keeps the anchor, so the range can be widened then narrowed', () => {
    expect(clickSelection(new Set([11]), ids, 11, 14, true).anchor).toBe(11)
  })

  it('Shift+click on a ticked end unticks the range', () => {
    const r = clickSelection(new Set([11, 12, 13, 14]), ids, 11, 13, true)
    expect([...r.selected]).toEqual([14])
  })

  it('the range runs over the given ids only: a row that is not selectable is never swept in', () => {
    // 12 is on the bon already: it is not in the selectable list.
    const r = clickSelection(new Set([10]), [10, 11, 13, 14], 10, 13, true)
    expect([...r.selected].sort()).toEqual([10, 11, 13])
  })

  it('an anchor that left the list makes Shift+click a plain click', () => {
    const r = clickSelection(new Set(), ids, 99, 13, true)
    expect([...r.selected]).toEqual([13])
    expect(r.anchor).toBe(13)
  })
})
