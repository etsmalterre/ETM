import { describe, it, expect } from 'vitest'
import { etatReservation, compteDansReserve, attendLeFil, repartirSurLot, ligneRecue, planReservation } from './reservation-fil.js'

const r = (o: Partial<{ liberee_le: Date | null; idligne_commande_sous_traitant: number; idasso_fil_lignecmdsst: number; idstock_fil: number }>) => ({
  liberee_le: null, idligne_commande_sous_traitant: 0, idasso_fil_lignecmdsst: 0, idstock_fil: 0, ...o,
})

describe('etatReservation', () => {
  it('reads the life of a reservation from its columns', () => {
    expect(etatReservation(r({}))).toBe('commande')
    expect(etatReservation(r({ idstock_fil: 7 }))).toBe('lot')
    expect(etatReservation(r({ idligne_commande_sous_traitant: 9, idstock_fil: 7, idasso_fil_lignecmdsst: 3 }))).toBe('consommee')
    expect(etatReservation(r({ liberee_le: new Date(), idstock_fil: 7 }))).toBe('liberee')
  })

  it('never counts a kilo twice in « Réservé »: a consumed one is counted through its asso row', () => {
    expect(compteDansReserve('commande')).toBe(true)
    expect(compteDansReserve('lot')).toBe(true)
    expect(compteDansReserve('consommee')).toBe(false)
    expect(compteDansReserve('liberee')).toBe(false)
  })

  it('waits for the yarn only while it is not on a lot', () => {
    expect(attendLeFil('commande')).toBe(true)
    expect(attendLeFil('lot')).toBe(false)
  })
})

describe('repartirSurLot', () => {
  it('serves the earliest client délai first, no délai last', () => {
    const parts = repartirSurLot([
      { id: 1, quantite: 300, delai: null },
      { id: 2, quantite: 300, delai: '20270129' },
      { id: 3, quantite: 300, delai: '20261211' },
    ], 700)
    expect(parts).toEqual([
      { id: 3, kg: 300, reste: 0 },
      { id: 2, kg: 300, reste: 0 },
      { id: 1, kg: 100, reste: 200 },
    ])
  })

  it('a lot smaller than the reservation covers part of it, the rest keeps waiting (3911: 660 kg in two deliveries)', () => {
    expect(repartirSurLot([{ id: 5, quantite: 600, delai: '20261211' }], 360)).toEqual([{ id: 5, kg: 360, reste: 240 }])
    expect(repartirSurLot([{ id: 6, quantite: 240, delai: '20261211' }], 300)).toEqual([{ id: 6, kg: 240, reste: 0 }])
  })

  it('an empty lot serves nobody', () => {
    expect(repartirSurLot([{ id: 1, quantite: 10, delai: null }], 0)).toEqual([])
  })
})

describe('ligneRecue', () => {
  it('reads received from 95 % of the ordered weight, more is accepted', () => {
    expect(ligneRecue(660, 627)).toBe(true)
    expect(ligneRecue(660, 626.9)).toBe(false)
    expect(ligneRecue(660, 680)).toBe(true)
    expect(ligneRecue(0, 10)).toBe(false)
  })
})

describe('planReservation', () => {
  it('takes the stock first, oldest lot first, then supplier orders by arrival date', () => {
    const plan = planReservation(500, [
      { kind: 'commande', id: 721, dispo: 1000, date: '20261210' },
      { kind: 'commande', id: 700, dispo: 100, date: '20261105' },
      { kind: 'lot', id: 2, dispo: 150, date: '20260901' },
      { kind: 'lot', id: 1, dispo: 100, date: '20260105' },
    ])
    expect(plan.prises).toEqual([
      { kind: 'lot', id: 1, kg: 100 },
      { kind: 'lot', id: 2, kg: 150 },
      { kind: 'commande', id: 700, kg: 100 },
      { kind: 'commande', id: 721, kg: 150 },
    ])
    expect(plan.reste).toBe(0)
  })

  it('says what nothing can cover (3874: 685 kg needed, 197 kg anywhere)', () => {
    const plan = planReservation(685.43, [{ kind: 'lot', id: 1, dispo: 197.3, date: '20260101' }])
    expect(plan.prises).toEqual([{ kind: 'lot', id: 1, kg: 197.3 }])
    expect(plan.reste).toBe(488.13)
  })

  it('a supplier order without a date is served last', () => {
    const plan = planReservation(10, [{ kind: 'commande', id: 1, dispo: 50, date: null }, { kind: 'commande', id: 2, dispo: 50, date: '20270101' }])
    expect(plan.prises).toEqual([{ kind: 'commande', id: 2, kg: 10 }])
  })
})
