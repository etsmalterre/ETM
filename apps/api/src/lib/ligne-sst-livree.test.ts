import { describe, expect, it } from 'vitest'
import { ecruToutRevenu, jourDe, ligneLivreeLe } from './ligne-sst-livree.js'

describe('ligne sst livrée', () => {
  it('every écru handed over came back: delivered on the latest reception (9113, 10 of 10 on 30/10)', () => {
    expect(ligneLivreeLe(10, 10, ['20261029', '20261030'])).toBe('20261030')
  })
  it('a piece still at the dyer: not delivered, whatever the metrage', () => {
    expect(ligneLivreeLe(10, 9, ['20261030'])).toBeNull()
  })
  it('nothing handed over: never delivered by this rule', () => {
    expect(ecruToutRevenu(0, 0)).toBe(false)
  })
  it('reads both driver shapes', () => {
    expect(jourDe('2026-10-30 14:02:11.123')).toBe('20261030')
    expect(jourDe('20261030140211')).toBe('20261030')
    expect(jourDe(null)).toBe('')
    expect(jourDe('0000-00-00')).toBe('')
  })
})
