import { describe, expect, it } from 'vitest'
import { delaiAuPlusTot, type EntreeDelai } from './delai-au-plus-tot.js'
import { STANDARDS_DEFAUT } from './delais-standards.js'
import { ajouterJoursOuvres } from './jours-ouvres.js'

const base = (p: Partial<EntreeDelai>): EntreeDelai => ({
  kind: 'fini', quantite: 1000, fini: 0, ecru: 0, tricotage: 0, fil: 0, filAttenduLe: null, kgParUnite: 1 / 3.5,
  aujourdhui: '20261102', // a Monday
  tricoteur: { standards: STANDARDS_DEFAUT, fermetures: [] },
  ennoblisseur: { standards: STANDARDS_DEFAUT, fermetures: [] },
  ...p,
})

describe('délai au plus tôt (doctrine des délais §5 ter)', () => {
  it('nothing reserved: yarn estimate + knitter + dyer + reserve', () => {
    const d = delaiAuPlusTot(base({}))!
    expect(d.sansMatiere).toBe(true)
    expect(d.etapes.map((x) => x.libelle)).toEqual(['Fil', 'Tricotage', 'Ennoblissement', 'Réserve Malterre'])
    expect(d.date).toBe('20270112') // 20 + 5 (286 kg ≤ 500) + 15 + 8 working days, 11/11, 25/12, 01/01 off
  })
  it('all écru reserved: dyer + reserve only', () => {
    const d = delaiAuPlusTot(base({ ecru: 1000 }))!
    expect(d.sansMatiere).toBe(false)
    expect(d.etapes.map((x) => x.libelle)).toEqual(['Ennoblissement', 'Réserve Malterre'])
    expect(d.date).toBe('20261204') // 15 j → 24/11 (11/11 off), + 8 j → 04/12
  })
  it('all fini rolls: ready today, no reserve', () => {
    expect(delaiAuPlusTot(base({ fini: 1000 }))).toEqual({ date: '20261102', etapes: [], sansMatiere: false })
  })
  it('the slowest portion decides; yarn on order starts at its date', () => {
    const d = delaiAuPlusTot(base({ ecru: 500, fil: 500, filAttenduLe: '20261116' }))!
    expect(d.etapes[0]).toMatchObject({ libelle: 'Fil', au: '20261116' })
    expect(d.etapes.map((x) => x.libelle)).toEqual(['Fil', 'Tricotage', 'Ennoblissement', 'Réserve Malterre'])
  })
  it('an écru line has no dyer step', () => {
    const d = delaiAuPlusTot(base({ kind: 'ecru', kgParUnite: 1, tricotage: 1000 }))!
    expect(d.etapes.map((x) => x.libelle)).toEqual(['Tricotage', 'Réserve Malterre'])
    expect(d.etapes[0].jours).toBe(10) // 1 000 kg: second band
  })
  it("a dyer's closure pushes the date", () => {
    const sans = delaiAuPlusTot(base({ ecru: 1000 }))!
    const avec = delaiAuPlusTot(base({ ecru: 1000, ennoblisseur: { standards: STANDARDS_DEFAUT, fermetures: [{ du: '20261109', au: '20261113' }] } }))!
    expect(avec.date > sans.date).toBe(true)
  })
  it('unknown kg conversion reads the longest knitter band', () => {
    const d = delaiAuPlusTot(base({ kgParUnite: null, tricotage: 1000 }))!
    expect(d.etapes[0]).toMatchObject({ libelle: 'Tricotage', jours: 15 })
  })
  // A date retained N working days after the earliest one.
  const apres = (p: Partial<EntreeDelai>, n: number) => ajouterJoursOuvres(delaiAuPlusTot(base(p))!.date, n)
  it('plan: the knitter takes the margin first, up to 20 working days', () => {
    const p10 = delaiAuPlusTot(base({ tricotage: 1000, dateRetenue: apres({ tricotage: 1000 }, 10) }))!.plan!
    expect(p10).toMatchObject({ marge: 10, attenteEcru: 0, tricotage: { standard: 5, marge: 10, jours: 15 } }) // 286 kg: first band
    expect(p10.ennoblirLe).toBe(p10.tricotage!.fin)
    const p30 = delaiAuPlusTot(base({ tricotage: 1000, dateRetenue: apres({ tricotage: 1000 }, 30) }))!.plan!
    expect(p30).toMatchObject({ marge: 30, attenteEcru: 10, tricotage: { marge: 20, jours: 25 } })
    expect(p30.ennoblirLe! > p30.tricotage!.fin).toBe(true)
  })
  it('plan: écru reserved, the whole margin waits before the dyeing', () => {
    const p = delaiAuPlusTot(base({ ecru: 1000, dateRetenue: apres({ ecru: 1000 }, 10) }))!.plan!
    expect(p).toMatchObject({ marge: 10, tricotage: null, attenteEcru: 10, ennoblirLe: '20261117' }) // 02/11 + 10 working days, 11/11 off
  })
  it('no plan at the earliest date', () => {
    expect(delaiAuPlusTot(base({ ecru: 1000, dateRetenue: apres({ ecru: 1000 }, 0) }))!.plan).toBeNull()
  })
  it('the knitter is asked its standard + its share of the margin, from today', () => {
    expect(delaiAuPlusTot(base({ tricotage: 1000 }))!.tricotageDemande).toEqual({ jours: 5, date: '20261109' })
    const d = delaiAuPlusTot(base({ tricotage: 1000, dateRetenue: apres({ tricotage: 1000 }, 10) }))!
    expect(d.tricotageDemande).toEqual({ jours: 15, date: '20261124' }) // 02/11 + 15 working days, 11/11 off
    expect(delaiAuPlusTot(base({ ecru: 1000 }))!.tricotageDemande).toBeNull()
  })
})
