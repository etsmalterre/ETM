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
  it('a reference shipped « dès la réception » (#1351) has no control step ahead', () => {
    // Écru reserved: the dyer alone, then the reserve (15 j → 24/11, + 8 j → 04/12; with the control: 11/12).
    const d = delaiAuPlusTot(base({ ecru: 1000, sansControle: true }))!
    expect(d.etapes.map((x) => x.libelle)).toEqual(['Ennoblissement', 'Réserve Malterre'])
    expect(d.date).toBe('20261204')
    // Nothing reserved: the whole chain without the control.
    expect(delaiAuPlusTot(base({ sansControle: true }))!.etapes.map((x) => x.libelle)).toEqual(['Fil', 'Tricotage', 'Ennoblissement', 'Réserve Malterre'])
    // Écru at the dyer on a launched order, order « En cours »: ready on the dyer's délai (order 3905).
    const lance = delaiAuPlusTot(base({
      ecru: 1000, sansControle: true, enCours: true,
      ecruChezEnnoblisseur: [{ quantite: 1000, partenaire: 'MATEL', delai: '20261201' }],
    }))!
    expect(lance.etapes.map((x) => x.libelle)).toEqual(['Ennoblissement'])
    expect(lance.date).toBe('20261201')
    // Rolls of that reference that still cannot ship (reprise, attente décision) keep their control step.
    expect(delaiAuPlusTot(base({ fini: 1000, finiEnControle: 1000, finiRecuLe: '20261029', sansControle: true }))!.etapes[0].libelle).toBe('Contrôle qualité')
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
  it('yarn on a supplier order: its date, its delay on its engagement, « if it delivers today » once past', () => {
    // Mundifios promised 13/11, pushed to 27/11: 10 working days late, the line reads from the 27th.
    const d = delaiAuPlusTot(base({ fil: 1000, filAttenduLe: '20261127', filCommande: { partenaire: 'Mundifios', delai: '20261127', engagement: '20261113' } }))!
    expect(d.etapes[0]).toMatchObject({ libelle: 'Fil', au: '20261127', partenaire: 'Mundifios', engagement: '20261113', retard: 10 })
    expect(d.etapes[1]).toMatchObject({ libelle: 'Tricotage', du: '20261127' })
    // Same end date as the plain reading of filAttenduLe.
    expect(d.date).toBe(delaiAuPlusTot(base({ fil: 1000, filAttenduLe: '20261127' }))!.date)
    // On time: no delay printed.
    expect(delaiAuPlusTot(base({ fil: 1000, filCommande: { partenaire: 'Mundifios', delai: '20261127', engagement: '20261127' } }))!.etapes[0].retard).toBeUndefined()
    // Past its date: the yarn arrives today at best, the step is flagged.
    const tard = delaiAuPlusTot(base({ fil: 1000, filAttenduLe: '20261030', filCommande: { partenaire: 'Mundifios', delai: '20261030', engagement: '20261030' } }))!
    expect(tard.etapes[0]).toMatchObject({ libelle: 'Fil', au: '20261102', depasse: true, jours: 0 })
    expect(tard.date).toBe(delaiAuPlusTot(base({ fil: 1000, filAttenduLe: '20261030' }))!.date)
    // No date given: the yarn estimate.
    expect(delaiAuPlusTot(base({ fil: 1000, filCommande: { partenaire: 'Mundifios', delai: null } }))!.etapes[0]).toMatchObject({ libelle: 'Fil', estime: true, jours: 20 })
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
  it('plan: the knitter gets its standard alone, the whole margin is écru waiting before the dyeing', () => {
    // Vincent 2026-11-16: a knitting order names no date, so no margin is handed to the knitter.
    const d10 = delaiAuPlusTot(base({ tricotage: 1000, dateRetenue: apres({ tricotage: 1000 }, 10) }))!
    const finTricot = d10.etapes.find((x) => x.libelle === 'Tricotage')!.au
    expect(d10.plan).toMatchObject({ marge: 10, attenteEcru: 10 })
    expect(d10.plan!.ennoblirLe).toBe(ajouterJoursOuvres(finTricot, 10))
    expect(d10.plan).not.toHaveProperty('tricotage')
  })
  it('plan: écru reserved, the whole margin waits before the dyeing', () => {
    const p = delaiAuPlusTot(base({ ecru: 1000, dateRetenue: apres({ ecru: 1000 }, 10) }))!.plan!
    expect(p).toMatchObject({ marge: 10, attenteEcru: 10, ennoblirLe: '20261117' }) // 02/11 + 10 working days, 11/11 off
  })
  it('no plan at the earliest date', () => {
    expect(delaiAuPlusTot(base({ ecru: 1000, dateRetenue: apres({ ecru: 1000 }, 0) }))!.plan).toBeNull()
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
    it('a délai pushed back carries its delay on the engagement (LIVA #1364: « retard MATEL 3 j »)', () => {
      const d = delaiAuPlusTot(base({ ecru: 1000, enCours: true, ecruChezEnnoblisseur: [{ quantite: 1000, partenaire: 'MATEL', delai: '20261113', engagement: '20261110' }] }))!
      expect(d.etapes[0]).toMatchObject({ engagement: '20261110', retard: 2 }) // 11/11 off
      const atemps = delaiAuPlusTot(base({ ecru: 1000, enCours: true, ecruChezEnnoblisseur: [{ quantite: 1000, partenaire: 'MATEL', delai: '20261110', engagement: '20261110' }] }))!
      expect(atemps.etapes[0].retard).toBeUndefined()
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
    it('knitting launched without a délai: the standard as an estimate, carrying the urgency asked', () => {
      const urgence = { demandeeLe: '20261102', reponseAttendue: '20261104', aRelancer: false }
      const sans = delaiAuPlusTot(base({ tricotage: 1000, enCours: true, tricotageLance: { partenaire: 'Tricotage Malterre', delai: null } }))!
      const avec = delaiAuPlusTot(base({ tricotage: 1000, enCours: true, tricotageLance: { partenaire: 'Tricotage Malterre', delai: null, urgence } }))!
      expect(sans.etapes[0]).toMatchObject({ libelle: 'Tricotage', estime: true })
      expect(sans.etapes[0].urgence).toBeUndefined()
      expect(avec.etapes[0]).toMatchObject({ libelle: 'Tricotage', estime: true, urgence })
      // Asking changes nothing to the estimate: nobody promised better yet.
      expect(avec.date).toBe(sans.date)
      // Asked on a délai already given (« can you go faster? »): the step keeps that délai and carries
      // the urgency. Which urgency still awaits is the caller's to say (lib/urgence-sst.ts).
      const donne = delaiAuPlusTot(base({ tricotage: 1000, enCours: true, tricotageLance: { partenaire: 'Tricotage Malterre', delai: '20261106', urgence } }))!
      expect(donne.etapes[0]).toMatchObject({ au: '20261106', delai: '20261106', urgence })
      expect(donne.etapes[0].estime).toBeUndefined()
    })
    it('préparation keeps the reserve', () => {
      const d = delaiAuPlusTot(base({ ecru: 1000, ecruChezEnnoblisseur: [{ quantite: 1000, partenaire: 'MATEL', delai: '20261110' }] }))!
      expect(d.etapes.at(-1)!.libelle).toBe('Réserve Malterre')
    })
  })
})
