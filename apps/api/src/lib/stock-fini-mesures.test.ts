import { describe, expect, it } from 'vitest'
import { mesuresModifiables, MESURES_AGE_MIN_JOURS } from './stock-fini-mesures.js'

const NOW = new Date(2026, 8, 30, 10, 0, 0).getTime() // 30/09/2026
const enStock = { idetat_stock_fini: 3, idligne_expedition: 0, idcommande_donation: 0 }

describe('mesuresModifiables (LIVA #1245)', () => {
  it('allows an old roll in stock', () => {
    expect(mesuresModifiables({ ...enStock, date_saisie: '20250115' }, NOW)).toEqual({ ok: true })
  })

  it('refuses a roll received less than 60 days ago, naming the day it opens', () => {
    const v = mesuresModifiables({ ...enStock, date_saisie: '20260915' }, NOW)
    expect(v).toMatchObject({ ok: false, raison: 'trop_recent', disponible_le: '2026-11-14' })
    if (!v.ok) expect(v.message).toContain('14/11/2026')
  })

  it('opens exactly 60 days after reception', () => {
    const recu = new Date(2026, 7, 1) // 01/08/2026
    const le60 = new Date(2026, 7, 1 + MESURES_AGE_MIN_JOURS).getTime() // 30/09/2026 00:00
    expect(mesuresModifiables({ ...enStock, date_saisie: recu }, le60 - 1).ok).toBe(false)
    expect(mesuresModifiables({ ...enStock, date_saisie: recu }, le60).ok).toBe(true)
  })

  it('reads every date shape the drivers return', () => {
    for (const d of ['20250115', '2025-01-15', '2025-01-15 08:30:00', '20250115083000', new Date(2025, 0, 15)]) {
      expect(mesuresModifiables({ ...enStock, date_saisie: d }, NOW).ok).toBe(true)
    }
  })

  it('refuses when the reception date is unknown', () => {
    for (const d of [null, '', '00000000']) {
      expect(mesuresModifiables({ ...enStock, date_saisie: d }, NOW)).toMatchObject({ ok: false, raison: 'date_inconnue' })
    }
  })

  it('refuses a shipped roll on either of the two facts', () => {
    expect(mesuresModifiables({ ...enStock, idligne_expedition: 42, date_saisie: '20240101' }, NOW)).toMatchObject({ raison: 'expedie' })
    expect(mesuresModifiables({ ...enStock, idetat_stock_fini: 4, date_saisie: '20240101' }, NOW)).toMatchObject({ raison: 'expedie' })
  })

  it('refuses a donated roll', () => {
    expect(mesuresModifiables({ ...enStock, idcommande_donation: 7, date_saisie: '20240101' }, NOW)).toMatchObject({ raison: 'donne' })
  })
})
