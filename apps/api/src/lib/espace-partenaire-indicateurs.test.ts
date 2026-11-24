import { describe, expect, it } from 'vitest'
import { debutDouzeMois, ligneService } from './espace-partenaire-indicateurs.js'
import { ecartDelai, type LigneRespect } from './qualite-service-sst.js'

describe('qualité de service du partenaire', () => {
  it('twelve sliding months, the current one included', () => {
    expect(debutDouzeMois('2026-11-24')).toBe('2025-12-01')
    expect(debutDouzeMois('2026-12-31')).toBe('2026-01-01')
    expect(debutDouzeMois('2027-01-01')).toBe('2026-02-01')
  })

  it('the gap is signed where ETM’s retard is clamped at 0', () => {
    // Promised Friday 20/11, received Wednesday 18/11: two working days early.
    expect(ecartDelai('2026-11-20', '2026-11-18')).toEqual({ retard: 0, ecart: -2 })
    expect(ecartDelai('2026-11-20', '2026-11-20')).toEqual({ retard: 0, ecart: 0 })
    // Received the Tuesday after: two working days late, the weekend out.
    expect(ecartDelai('2026-11-20', '2026-11-24')).toEqual({ retard: 2, ecart: 2 })
    // The partner's closure is no delay: closed Monday 23/11, received Tuesday 24/11 = one day.
    expect(ecartDelai('2026-11-20', '2026-11-24', [{ du: '20261123', au: '20261123' }])).toEqual({ retard: 1, ecart: 1 })
  })

  it('maps an ETM line to the portal’s, article « REF - coloris »', () => {
    const l: LigneRespect = {
      idcommande: 9146, idligne: 9135, reference: '029A', delaiPromis: '2026-12-04', commandeLe: '2026-11-05',
      dureeJours: 12, premiereReception: '2026-11-24', retard: 0, ecart: -8, enRetardOuvert: false,
    }
    expect(ligneService(l, '029A - 0612 marine')).toEqual({
      idCommande: 9146, idLigne: 9135, article: '029A - 0612 marine', commandeLe: '2026-11-05',
      delaiPromis: '2026-12-04', recuLe: '2026-11-24', dureeJours: 12, ecartJours: -8,
    })
    // An open line past its promise: nothing received, late so far.
    expect(ligneService({ ...l, premiereReception: null, retard: 3, ecart: 3, enRetardOuvert: true }, '')).toMatchObject({ article: '029A', recuLe: null, ecartJours: 3 })
  })
})
