import { describe, expect, it } from 'vitest'
import { lotsNonSoumissibles, type RouleauFini } from './soumission-lots-bloques.js'

const roll = (p: Partial<RouleauFini>): RouleauFini => ({
  lot: 'MA1', lcc: 0, donation: 0, metrage: 10, lccEcru: 0, ...p,
})
const cde = (lcc: number) => (lcc === 12856 ? { numero: 3762, client_nom: 'Le slip Francais' } : null)

describe('lotsNonSoumissibles', () => {
  it('reports a lot whose rolls are reserved to no client line, with the écru trace (#1302)', () => {
    const out = lotsNonSoumissibles(
      [roll({ lot: 'MA109374', lccEcru: 12856, metrage: 73.2 }), roll({ lot: 'MA109374', lccEcru: 12856, metrage: 74.9 })],
      new Set(['MA109373']),
      cde,
    )
    expect(out).toEqual([{
      lot: 'MA109374', raison: 'non_reserve', nb_rolls: 2, total_metrage: 148.1,
      reservation_ecru: { numero: 3762, client_nom: 'Le slip Francais' },
      commande_client: null,
    }])
  })

  it('never reports a lot the picker already offers, even partly free', () => {
    const out = lotsNonSoumissibles(
      [roll({ lot: 'MA1', lcc: 12856 }), roll({ lot: 'MA1' })],
      new Set(['MA1']),
      cde,
    )
    expect(out).toEqual([])
  })

  it('a reserved lot left out of the offer = the client asks no soumission', () => {
    const out = lotsNonSoumissibles([roll({ lot: 'MA2', lcc: 12856 })], new Set(), cde)
    expect(out[0]).toMatchObject({ raison: 'sans_soumission', commande_client: { numero: 3762 } })
  })

  it('ignores donated rolls and empty lots', () => {
    const out = lotsNonSoumissibles(
      [roll({ lot: 'MA3', donation: 5 }), roll({ lot: '  ' }), roll({ lot: null })],
      new Set(),
      cde,
    )
    expect(out).toEqual([])
  })

  it('no écru trace = reservation_ecru null', () => {
    const out = lotsNonSoumissibles([roll({ lot: 'MA4' })], new Set(), cde)
    expect(out[0]).toMatchObject({ raison: 'non_reserve', reservation_ecru: null })
  })
})
