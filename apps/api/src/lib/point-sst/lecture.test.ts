import { describe, expect, it } from 'vitest'
import { rangerLot } from './lecture.js'
import { SANS_SOUMISSION, type LotFait } from '../cycle-ennoblissement.js'

const lot = (p: Partial<LotFait>): LotFait => ({
  lot: 'MA109001', idsuivilot: 1, idligne: 1, etat: 1, reception: '2026-10-20', mesuresTeinturier: false, tirelleMesuree: false,
  coloris: SANS_SOUMISSION, stabilites: SANS_SOUMISSION, ...p,
})
const vide = () => ({ lotsSansControle: [], lotsAControler: [], lotsEnReprise: [], repriseTeinture: false, lotsColorisSoumis: [], lotsColorisValide: [], lotsReteinture: [] }) as Parameters<typeof rangerLot>[0]
const range = (l: LotFait) => { const r = vide(); rangerLot(r, l, '2026-09-06'); return r }

describe('rangerLot (the Suivi lots step decides)', () => {
  it('received without the dyer measures → §2; with them → ours to control; too old → nothing', () => {
    expect(range(lot({})).lotsSansControle).toEqual(['MA109001'])
    expect(range(lot({ mesuresTeinturier: true })).lotsAControler).toEqual(['MA109001'])
    expect(range(lot({ reception: '2026-08-01' }))).toEqual(vide())
  })
  it('validated → nothing; reprise (état 2 or open) → reprise, its nature kept', () => {
    expect(range(lot({ etat: 3 }))).toEqual(vide())
    expect(range(lot({ etat: 2 })).lotsEnReprise).toEqual(['MA109001'])
    const r = range(lot({ repriseOuverte: true, repriseNature: 'teinture' }))
    expect([r.lotsEnReprise, r.repriseTeinture]).toEqual([['MA109001'], true])
  })
  it('a lot not received yet, through its coloris soumission', () => {
    const envoyee = { requise: true, envoyeeLe: '2026-10-15', reponse: null }
    const reponse = (accepte: boolean) => ({ ...envoyee, reponse: { accepte, commentaire: '', le: '2026-10-16 10:00:00.000' } })
    expect(range(lot({ reception: null, coloris: envoyee })).lotsColorisSoumis).toEqual(['MA109001'])
    expect(range(lot({ reception: null, coloris: reponse(true) })).lotsColorisValide).toEqual(['MA109001'])
    expect(range(lot({ reception: null, coloris: reponse(true), okRamerLe: '2026-10-16' })).lotsColorisValide).toEqual(['MA109001'])
    expect(range(lot({ reception: null, coloris: reponse(false) })).lotsReteinture).toEqual(['MA109001'])
    // not received, nothing submitted: the dyer's lot, nothing for the point
    expect(range(lot({ reception: null }))).toEqual(vide())
  })
})
