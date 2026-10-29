import { describe, expect, it } from 'vitest'
import { ecartsAuStock } from './bl-ecarts-stock'

const piece = (numero_piece: string, poids: number, metrage: number, observations = '') => ({ numero_piece, poids, metrage, observations })
const roll = (numero: string, poids: number, metrage: number, observation_sst = '') => ({ numero, poids, metrage, observation_sst })

describe('ecartsAuStock', () => {
  it('flags the weight typed at the réception (BL 109486A, 3576/18)', () => {
    const r = ecartsAuStock([piece('3576/17', 18.1, 32), piece('3576/18', 18.1, 15)], [roll('3576/17', 18.1, 32), roll('3576/18', 10.1, 15)])
    expect(r.recues).toBe(2)
    expect(r.nbEcarts).toBe(1)
    expect(r.ecarts.get('3576/18')).toEqual({ poids: '10,10' })
  })

  it('flags an observation the BL had and the stock lost', () => {
    const r = ecartsAuStock([piece('3576/11', 20, 31, '1 salissure')], [roll('3576/11', 20, 31)])
    expect(r.ecarts.get('3576/11')).toEqual({ observation: '(vide)' })
  })

  it('ignores case and spacing on observations, and float noise on numbers', () => {
    const r = ecartsAuStock([piece('1/1', 20.3, 72.8, '1 Tache,  1 TB')], [roll('1/1', 20.30001, 72.8, '1 tache, 1 TB')])
    expect(r.nbEcarts).toBe(0)
  })

  it('folds a roll cut after the réception back into its piece', () => {
    const r = ecartsAuStock([piece('3500/4', 20, 70)], [roll('3500/4', 12, 42), roll('3500/4-1', 8, 28)])
    expect(r.nbEcarts).toBe(0)
  })

  it('keeps a dyer split listed on the BL as its own piece', () => {
    const r = ecartsAuStock([piece('3500/4-1', 10, 35), piece('3500/4-2', 10, 35)], [roll('3500/4-1', 10, 35), roll('3500/4-2', 10, 35)])
    expect(r.recues).toBe(2)
    expect(r.nbEcarts).toBe(0)
  })

  it('counts a piece not yet received as absent, not as a gap', () => {
    const r = ecartsAuStock([piece('1/1', 20, 70), piece('1/2', 20, 70)], [roll('1/1', 20, 70)])
    expect(r.recues).toBe(1)
    expect(r.nbEcarts).toBe(0)
  })
})
