import { describe, expect, it } from 'vitest'
import { estFilEtm, filEtmSql, gereParEtmParDefaut, ID_CLIENT_ETS_MALTERRE } from './fil-gere-etm.js'

describe('filEtmSql', () => {
  it('keeps ETM own lots and the lots flagged for ETM', () => {
    expect(filEtmSql()).toBe('(IDclient IN (0, 1) OR gere_par_etm = 1)')
    expect(filEtmSql('sf')).toBe('(sf.IDclient IN (0, 1) OR sf.gere_par_etm = 1)')
  })
})

describe('estFilEtm', () => {
  it('own yarn is always ETM, whatever the flag', () => {
    expect(estFilEtm({ IDclient: ID_CLIENT_ETS_MALTERRE, gere_par_etm: 0 })).toBe(true)
    expect(estFilEtm({ IDclient: 0 })).toBe(true)
  })
  it('a TRM client lot is ETM only when flagged', () => {
    expect(estFilEtm({ IDclient: 14, gere_par_etm: 0 })).toBe(false) // Sofileta
    expect(estFilEtm({ idclient: 524, gere_par_etm: 1 })).toBe(true) // Sigvaris PA66
  })
})

describe('gereParEtmParDefaut', () => {
  it('follows the client list: every yarn, or the listed refs', () => {
    expect(gereParEtmParDefaut(8, 999, { tous: true, refs: [] })).toBe(true)
    expect(gereParEtmParDefaut(524, 64, { tous: false, refs: [64] })).toBe(true)
    expect(gereParEtmParDefaut(524, 65, { tous: false, refs: [64] })).toBe(false)
    expect(gereParEtmParDefaut(14, 64, { tous: false, refs: [] })).toBe(false)
  })
  it('never flags Ets Malterre own yarn (moot, stays 0)', () => {
    expect(gereParEtmParDefaut(ID_CLIENT_ETS_MALTERRE, 64, { tous: true, refs: [] })).toBe(false)
  })
})
