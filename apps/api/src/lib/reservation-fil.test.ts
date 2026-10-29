import { describe, it, expect } from 'vitest'
import { etatReservation, compteDansReserve, attendLeFil, repartirSurLot, ligneRecue, plafondReservation } from './reservation-fil.js'

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

describe('plafondReservation', () => {
  it('lets a line hold its need + 10 % (a whole 660 kg order for 650 kg)', () => {
    expect(plafondReservation(650)).toBe(715)
    expect(plafondReservation(0)).toBe(0)
  })
})
