import { describe, expect, it } from 'vitest'
import { pickDefaultAdresses } from './sst-adresses.js'

describe('pickDefaultAdresses', () => {
  it('MATEL: one row flagged both ways → 24/24', () => {
    expect(pickDefaultAdresses([{ IDadresse: 24, est_defaut: 1, est_defaut_livraison: 1 }])).toEqual({ principal: 24, livraison: 24 })
  })
  it('separate principal and delivery rows', () => {
    const rows = [
      { IDadresse: 10, est_defaut: 1, est_defaut_livraison: 0 },
      { IDadresse: 11, est_defaut: 0, est_defaut_livraison: 1 },
    ]
    expect(pickDefaultAdresses(rows)).toEqual({ principal: 10, livraison: 11 })
  })
  it('no delivery flag → delivery follows the principal', () => {
    const rows = [
      { IDadresse: 5, est_defaut: 0, est_defaut_livraison: 0 },
      { IDadresse: 6, est_defaut: 1, est_defaut_livraison: 0 },
    ]
    expect(pickDefaultAdresses(rows)).toEqual({ principal: 6, livraison: 6 })
  })
  it('no flag at all → first visible row for both', () => {
    const rows = [
      { IDadresse: 7, est_defaut: 0, est_defaut_livraison: 0 },
      { IDadresse: 8, est_defaut: 0, est_defaut_livraison: 0 },
    ]
    expect(pickDefaultAdresses(rows)).toEqual({ principal: 7, livraison: 7 })
  })
  it('no address → 0/0, never throws', () => {
    expect(pickDefaultAdresses([])).toEqual({ principal: 0, livraison: 0 })
  })
})
