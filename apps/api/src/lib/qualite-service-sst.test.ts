import { describe, expect, it } from 'vitest'
import { joursOuvresEntre, reponseCommande, synthese } from './qualite-service-sst.js'
import type { FaitsDelai } from './delai-sst.js'

const faits = (p: Partial<FaitsDelai> = {}): FaitsDelai => ({ demandeLe: '2026-10-19', dateNotif: null, relances: [], reports: [], reponduLe: null, ...p })

describe('qualité de service', () => {
  it('working days between two days, weekends skipped', () => {
    expect(joursOuvresEntre('2026-10-19', '2026-10-22')).toBe(3)
    expect(joursOuvresEntre('2026-10-23', '2026-10-26')).toBe(1) // Fri → Mon
    expect(joursOuvresEntre('2026-10-26', '2026-10-23')).toBe(-1)
  })
  it('9117: asked 19/10, relanced in the Point 22/10, answered 22/10 = 3 days, 1 relance', () => {
    const r = reponseCommande(9117, faits({ relances: [{ jour: '2026-10-22', canal: 'point', par: null, note: null }], reponduLe: '2026-10-22' }), false, '2026-10-22')
    expect(r).toMatchObject({ jours: 3, relances: 1, enAttente: false, neutralisee: false })
  })
  it('answered before ETM dated it: not measured; still waiting: measured so far', () => {
    expect(reponseCommande(1, faits(), false, '2026-10-22')).toBeNull()
    expect(reponseCommande(1, faits(), true, '2026-10-26')).toMatchObject({ jours: 5, enAttente: true })
  })
  it('a wait reported « de notre fait » stays out of the averages', () => {
    const neutre = reponseCommande(1, faits({ reponduLe: '2026-11-10', reports: [{ le: '2026-10-22T10:00', echeance: '2026-11-09', motif: 'fil', imputable: 'malterre', par: null }] }), false, '2026-11-10')!
    const ok = reponseCommande(2, faits({ reponduLe: '2026-10-21' }), false, '2026-11-10')!
    const s = synthese([neutre, ok], 0, [])
    expect(s.reponse).toMatchObject({ mesurees: 1, moyenneJours: 2, partDansLesTemps: 1, neutralisees: 1 })
  })
  it('respect: on time vs late lines, open late lines counted apart', () => {
    const s = synthese([], 0, [
      { idcommande: 1, idligne: 1, reference: 'A', delaiPromis: '2026-10-10', commandeLe: null, dureeJours: null, premiereReception: '2026-10-09', retard: 0, enRetardOuvert: false },
      { idcommande: 1, idligne: 2, reference: 'A', delaiPromis: '2026-10-10', commandeLe: null, dureeJours: null, premiereReception: '2026-10-14', retard: 2, enRetardOuvert: false },
      { idcommande: 2, idligne: 3, reference: 'B', delaiPromis: '2026-10-10', commandeLe: null, dureeJours: null, premiereReception: null, retard: 8, enRetardOuvert: true },
    ])
    expect(s.respect).toMatchObject({ lignes: 2, aLHeure: 1, partALHeure: 0.5, retardMoyen: 2, enRetardOuvertes: 1 })
  })
})
