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
  it('nothing reserved: yarn estimate + knitter + dyer + control + reserve', () => {
    const d = delaiAuPlusTot(base({}))!
    expect(d.sansMatiere).toBe(true)
    expect(d.etapes.map((x) => x.libelle)).toEqual(['Fil', 'Tricotage', 'Ennoblissement', 'Contrôle qualité', 'Réserve Malterre'])
    expect(d.date).toBe('20270119') // 20 + 5 (286 kg ≤ 500) + 15 + 5 control + 8 working days, 11/11, 25/12, 01/01 off
  })
  it('all écru reserved: dyer + control + reserve only', () => {
    const d = delaiAuPlusTot(base({ ecru: 1000 }))!
    expect(d.sansMatiere).toBe(false)
    expect(d.etapes.map((x) => x.libelle)).toEqual(['Ennoblissement', 'Contrôle qualité', 'Réserve Malterre'])
    expect(d.date).toBe('20261211') // 15 j → 24/11 (11/11 off), + 5 j control → 01/12, + 8 j → 11/12
  })
  it('matter covering 90 % of the line serves it: the rest is ignored', () => {
    const d = delaiAuPlusTot(base({ ecru: 995 }))!
    expect(d.sansMatiere).toBe(false)
    expect(d.etapes.map((x) => x.libelle)).toEqual(['Ennoblissement', 'Contrôle qualité', 'Réserve Malterre'])
    expect(delaiAuPlusTot(base({ ecru: 899 }))!.sansMatiere).toBe(true)
  })
  it('all fini rolls validated: ready today, no reserve', () => {
    expect(delaiAuPlusTot(base({ fini: 1000 }))).toEqual({ date: '20261102', etapes: [], sansMatiere: false })
  })
  it('fini rolls not validated: the rest of the control from their entry, then the reserve', () => {
    const d = delaiAuPlusTot(base({ fini: 1000, finiEnControle: 1000, finiRecuLe: '20261029' }))!
    expect(d.etapes.map((x) => x.libelle)).toEqual(['Contrôle qualité', 'Réserve Malterre'])
    expect(d.etapes[0]).toMatchObject({ du: '20261029', au: '20261105' }) // 29/10 + 5 working days (no 01/11 effect: Sunday)
    // A control past its standard ends today at best.
    expect(delaiAuPlusTot(base({ fini: 1000, finiEnControle: 1000, finiRecuLe: '20261001' }))!.etapes[0].au).toBe('20261102')
    // Unknown entry: counted from today.
    expect(delaiAuPlusTot(base({ fini: 1000, finiEnControle: 1000, finiRecuLe: null }))!.etapes[0]).toMatchObject({ du: '20261102', au: '20261109' })
    // Validated rolls covering the line win over the ones still in control.
    expect(delaiAuPlusTot(base({ fini: 1000, finiEnControle: 50 }))!.etapes).toEqual([])
  })
  it('the slowest portion decides; yarn on order starts at its date', () => {
    const d = delaiAuPlusTot(base({ ecru: 500, fil: 500, filAttenduLe: '20261116' }))!
    expect(d.etapes[0]).toMatchObject({ libelle: 'Fil', au: '20261116' })
    expect(d.etapes.map((x) => x.libelle)).toEqual(['Fil', 'Tricotage', 'Ennoblissement', 'Contrôle qualité', 'Réserve Malterre'])
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
  describe('en cours (Vincent 2026-11-02): no reserve, partners on their délai', () => {
    it('écru at a dyer: its délai, then the control, no reserve', () => {
      const d = delaiAuPlusTot(base({ ecru: 1000, enCours: true, ecruChezEnnoblisseur: [{ quantite: 1000, partenaire: 'MATEL', delai: '20261110' }] }))!
      expect(d.etapes.map((x) => x.libelle)).toEqual(['Ennoblissement', 'Contrôle qualité'])
      expect(d.etapes[0]).toMatchObject({ partenaire: 'MATEL', delai: '20261110', au: '20261110', depasse: false })
      expect(d.date).toBe('20261118') // 10/11 + 5 working days, 11/11 off
    })
    it('a délai past: the dyer delivers today at best (3895 THUASNE, MATEL 30/10)', () => {
      const d = delaiAuPlusTot(base({ ecru: 1000, enCours: true, ecruChezEnnoblisseur: [{ quantite: 1000, partenaire: 'MATEL', delai: '20261030' }] }))!
      expect(d.etapes[0]).toMatchObject({ libelle: 'Ennoblissement', au: '20261102', depasse: true, jours: 0 })
      expect(d.date).toBe('20261109')
    })
    it('a dyer order without délai: its standard from today, estimated', () => {
      const d = delaiAuPlusTot(base({ ecru: 1000, enCours: true, ecruChezEnnoblisseur: [{ quantite: 1000, partenaire: 'MATEL', delai: null }] }))!
      expect(d.etapes[0]).toMatchObject({ estime: true, jours: 15, au: '20261124' })
    })
    it('écru not at a dyer yet keeps the standard; the slowest portion decides', () => {
      const d = delaiAuPlusTot(base({ ecru: 1000, enCours: true, ecruChezEnnoblisseur: [{ quantite: 500, partenaire: 'MATEL', delai: '20261030' }] }))!
      expect(d.etapes[0]).toMatchObject({ libelle: 'Ennoblissement', au: '20261124' })
      expect(d.etapes[0].partenaire).toBeUndefined()
    })
    it('knitting launched: its délai, then the dyer standard and the control', () => {
      const d = delaiAuPlusTot(base({ tricotage: 1000, enCours: true, tricotageLance: { partenaire: 'Tricotage Malterre', delai: '20261106' } }))!
      expect(d.etapes.map((x) => x.libelle)).toEqual(['Tricotage', 'Ennoblissement', 'Contrôle qualité'])
      expect(d.etapes[0]).toMatchObject({ au: '20261106', partenaire: 'Tricotage Malterre' })
    })
    it('préparation keeps the reserve', () => {
      const d = delaiAuPlusTot(base({ ecru: 1000, ecruChezEnnoblisseur: [{ quantite: 1000, partenaire: 'MATEL', delai: '20261110' }] }))!
      expect(d.etapes.at(-1)!.libelle).toBe('Réserve Malterre')
    })
  })
})
