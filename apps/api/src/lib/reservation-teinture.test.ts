import { describe, it, expect, vi, beforeEach } from 'vitest'

// No DB in unit tests: the stock / client-line lookups and the « already
// dyed » probe are mocked. Data shaped on the LIVA #1261 case (2026-10-05):
// dyer line 9038 of order 9065 = 329B (ref_fini 1744) in 0804 noir (5242);
// order 3874 line 13169 = 329D (1746) écru/écru (1551); order 3891 line
// 13224 = 329B noir, the line the pieces were meant for.
const queryMock = vi.fn()
const consumedMock = vi.fn()
vi.mock('./hfsql-auto.js', () => ({ query: (...a: unknown[]) => queryMock(...a) }))
vi.mock('./fini-sources.js', () => ({ consumedEcruIds: (...a: unknown[]) => consumedMock(...a) }))

const { reservationFitsDyeLine, misfitMessage, findReservationMisfits, ecruStillAtDyer } = await import('./reservation-teinture.js')

const NOIR = { ref: 1744, coloris: 5242 }
const PIECES = [
  { IDstock_ecru: 56099, numero: '3530/3', IDligne_commande_client: 13169 },
  { IDstock_ecru: 57011, numero: '3560/13', IDligne_commande_client: 13169 },
  { IDstock_ecru: 57020, numero: '3560/15', IDligne_commande_client: 13224 },
]
const LINES = [
  { IDligne_commande_client: 13169, IDcommande_client: 7182, type_kind: 2, IDreference: 1746, IDcolori: 1551 },
  { IDligne_commande_client: 13224, IDcommande_client: 7213, type_kind: 2, IDreference: 1744, IDcolori: 5242 },
]
const ORDERS = [{ IDcommande_client: 7182, numero: 3874 }, { IDcommande_client: 7213, numero: 3891 }]

beforeEach(() => {
  queryMock.mockReset()
  consumedMock.mockReset()
  consumedMock.mockResolvedValue(new Set())
  queryMock.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM stock_ecru')) {
      const ids = (sql.match(/IN \(([^)]*)\)/)?.[1] ?? '').split(',').map(Number)
      return PIECES.filter((p) => ids.includes(p.IDstock_ecru))
    }
    if (sql.includes('FROM ligne_commande_client')) return LINES
    if (sql.includes('FROM commande_client')) return ORDERS
    return []
  })
})

describe('reservationFitsDyeLine', () => {
  it('accepts a fini line of the same reference and coloris', () => {
    expect(reservationFitsDyeLine({ type: 2, ref: 1744, coloris: 5242 }, NOIR)).toBe(true)
  })
  it('refuses another reference — the 329D écru/écru line under a 329B noir dye', () => {
    expect(reservationFitsDyeLine({ type: 2, ref: 1746, coloris: 1551 }, NOIR)).toBe(false)
  })
  it('refuses the same reference in another coloris', () => {
    expect(reservationFitsDyeLine({ type: 2, ref: 1744, coloris: 5247 }, NOIR)).toBe(false)
  })
  it('refuses an écru client line: the piece leaves the dyer as a fini', () => {
    expect(reservationFitsDyeLine({ type: 1, ref: 1744, coloris: 5242 }, NOIR)).toBe(false)
  })
  it('lets a missing coloris on either side pass (lines older than #1215)', () => {
    expect(reservationFitsDyeLine({ type: 2, ref: 1744, coloris: 0 }, NOIR)).toBe(true)
    expect(reservationFitsDyeLine({ type: 2, ref: 1744, coloris: 5242 }, { ref: 1744, coloris: 0 })).toBe(true)
  })
})

describe('findReservationMisfits', () => {
  it('names the pieces promised to order 3874 and lets the 3891 one through', async () => {
    const misfits = await findReservationMisfits([56099, 57011, 57020], NOIR)
    expect(misfits).toEqual([
      { stockEcruId: 56099, numero: '3530/3', commandeNumero: '3874' },
      { stockEcruId: 57011, numero: '3560/13', commandeNumero: '3874' },
    ])
  })
  it('ignores a piece already dyed — its pointers are history', async () => {
    consumedMock.mockResolvedValue(new Set([56099, 57011]))
    expect(await findReservationMisfits([56099, 57011, 57020], NOIR)).toEqual([])
  })
  it('asks nothing for an empty list', async () => {
    expect(await findReservationMisfits([], NOIR)).toEqual([])
    expect(queryMock).not.toHaveBeenCalled()
  })
})

describe('misfitMessage', () => {
  it('groups the pieces by client order', () => {
    expect(misfitMessage([
      { stockEcruId: 1, numero: '3530/3', commandeNumero: '3874' },
      { stockEcruId: 2, numero: '3560/13', commandeNumero: '3874' },
    ], 'Affectation refusée')).toBe(
      'Affectation refusée : les pièces 3530/3, 3560/13 (commande client 3874) sont réservées '
      + 'pour une autre référence ou un autre coloris. Retirez d’abord la réservation client.',
    )
  })
  it('speaks in the singular for one piece', () => {
    expect(misfitMessage([{ stockEcruId: 1, numero: '3530/3', commandeNumero: '3874' }], 'X'))
      .toContain('la pièce 3530/3 (commande client 3874) est réservée')
  })
})

describe('ecruStillAtDyer', () => {
  it('keeps the pieces on a dyer line that are not dyed yet', async () => {
    queryMock.mockResolvedValue([{ IDstock_ecru: 56099 }, { IDstock_ecru: 57011 }])
    consumedMock.mockResolvedValue(new Set([57011]))
    expect(await ecruStillAtDyer([56099, 57011, 1])).toEqual([56099])
  })
})
