import { describe, expect, it } from 'vitest'
import { comparer, dedoublonner, memoireVide, type Memoire } from './constats.js'
import { appliquerSuivi, type IndexAvis } from './avis.js'
import { quotidienDu, prochainQuotidien } from '../scheduler.js'
import type { Constat, Gravite } from './types.js'

const c = (id: string, gravite: Gravite = 'attention', controle = 'test'): Constat => ({
  cle: `${controle}:${id}`,
  controle,
  domaine: 'commandes_client',
  gravite,
  titre: `Commande ${id}`,
  message: 'à voir',
  lien: `/clients/commandes?id=${id}`,
})

const J1 = '2026-09-21T17:00:00.000Z'
const J2 = '2026-09-22T17:00:00.000Z'

describe('comparer', () => {
  it('marks everything new on an empty memory', () => {
    const r = comparer(memoireVide(), [c('1'), c('2')], J1)
    expect(r.constats.map((x) => x.etat)).toEqual(['nouveau', 'nouveau'])
    expect(Object.keys(r.memoire.ouverts)).toHaveLength(2)
    expect(r.fermes).toEqual([])
  })

  it('keeps a finding seen yesterday as « ouvert » with its first date', () => {
    const m = comparer(memoireVide(), [c('1')], J1).memoire
    const r = comparer(m, [c('1')], J2)
    expect(r.constats[0].etat).toBe('ouvert')
    expect(r.constats[0].depuis).toBe(J1)
    expect(r.memoire.ouverts['test:1'].vuLe).toBe(J2)
  })

  it('flags a finding whose gravity rose as « aggrave »', () => {
    const m = comparer(memoireVide(), [c('1', 'attention')], J1).memoire
    expect(comparer(m, [c('1', 'urgent')], J2).constats[0].etat).toBe('aggrave')
    // …but not one whose gravity dropped.
    const m2 = comparer(memoireVide(), [c('1', 'urgent')], J1).memoire
    expect(comparer(m2, [c('1', 'attention')], J2).constats[0].etat).toBe('ouvert')
  })

  it('closes a finding no check returns any more', () => {
    const m = comparer(memoireVide(), [c('1'), c('2')], J1).memoire
    const r = comparer(m, [c('1')], J2)
    expect(r.fermes.map((f) => f.constat.cle)).toEqual(['test:2'])
    expect(r.memoire.ouverts['test:2']).toBeUndefined()
  })

  it('never closes the findings of a check that failed this run', () => {
    const m = comparer(memoireVide(), [c('1', 'attention', 'a'), c('2', 'attention', 'b')], J1).memoire
    const r = comparer(m, [], J2, new Set(['a']))
    expect(r.fermes.map((f) => f.constat.cle)).toEqual(['b:2'])
    expect(r.memoire.ouverts['a:1'].depuis).toBe(J1)
  })

  it('sorts new before open, urgent before attention', () => {
    const m: Memoire = comparer(memoireVide(), [c('old', 'urgent')], J1).memoire
    const r = comparer(m, [c('old', 'urgent'), c('a', 'attention'), c('u', 'urgent')], J2)
    expect(r.constats.map((x) => x.cle)).toEqual(['test:u', 'test:a', 'test:old'])
  })
})

describe('dedoublonner', () => {
  it('keeps the gravest of two findings with the same key', () => {
    expect(dedoublonner([c('1', 'attention'), c('1', 'urgent'), c('1', 'info')]).map((x) => x.gravite)).toEqual(['urgent'])
  })
})

describe('appliquerSuivi', () => {
  const par = { id: 7, nom: 'Isabelle' }
  const avis = (note: 'reussite' | 'partielle' | 'echec', commentaire = ''): IndexAvis[string] =>
    ({ note, commentaire, par, le: J1, runId: 'r1', titre: 't' })

  it('sets aside the points scored « échec » and keeps the others, with their score', () => {
    const r = comparer(memoireVide(), [c('1'), c('2'), c('3'), c('4')], J2)
    const { listes, ecartes } = appliquerSuivi(r.constats, {
      'test:1': avis('echec', 'Déjà livré, fausse alerte'),
      'test:2': avis('partielle', 'Bon point, mauvaise quantité'),
      'test:3': avis('reussite'),
    })
    expect(ecartes.map((x) => x.cle)).toEqual(['test:1'])
    expect(ecartes[0].avis?.commentaire).toBe('Déjà livré, fausse alerte')
    expect(listes.map((x) => [x.cle, x.avis?.note ?? null])).toEqual([
      ['test:2', 'partielle'],
      ['test:3', 'reussite'],
      ['test:4', null],
    ])
  })

  it('never carries the bookkeeping fields onto the report', () => {
    const r = comparer(memoireVide(), [c('1')], J2)
    const { listes } = appliquerSuivi(r.constats, { 'test:1': avis('reussite') })
    expect(listes[0].avis).toEqual({ note: 'reussite', commentaire: '', par, le: J1 })
  })

  it('moves a point resolved by hand to « résolus », even one scored échec', () => {
    const r = comparer(memoireVide(), [c('1'), c('2')], J2)
    const res = { commentaire: 'PE l’a eu au téléphone', par, le: J1, runId: 'r1', titre: 't' }
    const { listes, ecartes, resolus } = appliquerSuivi(r.constats, { 'test:1': avis('echec', 'x') }, { 'test:1': res })
    expect(resolus.map((x) => x.cle)).toEqual(['test:1'])
    expect(resolus[0].resolution).toEqual({ commentaire: 'PE l’a eu au téléphone', par, le: J1 })
    expect(resolus[0].avis?.note).toBe('echec')
    expect(ecartes).toEqual([])
    expect(listes.map((x) => x.cle)).toEqual(['test:2'])
  })

  it('drops a score or a resolution once the problem changed (client wrote again)', () => {
    const r = comparer(memoireVide(), [{ ...c('1'), empreinte: 'msg-2' }], J2)
    const res = { commentaire: 'réglé', par, le: J1, runId: 'r1', titre: 't', empreinte: 'msg-1' }
    const { listes, resolus } = appliquerSuivi(r.constats, { 'test:1': { ...avis('echec', 'x'), empreinte: 'msg-1' } }, { 'test:1': res })
    expect(resolus).toEqual([])
    expect(listes.map((x) => [x.cle, x.avis ?? null])).toEqual([['test:1', null]])
  })
})

describe('comparer — empreinte', () => {
  it('raises the point again as « nouveau » when its empreinte changed', () => {
    const m = comparer(memoireVide(), [{ ...c('1'), empreinte: 'msg-1' }], J1).memoire
    const meme = comparer(m, [{ ...c('1'), empreinte: 'msg-1' }], J2).constats[0]
    expect([meme.etat, meme.depuis]).toEqual(['ouvert', J1])
    const autre = comparer(m, [{ ...c('1'), empreinte: 'msg-2' }], J2).constats[0]
    expect([autre.etat, autre.depuis]).toEqual(['nouveau', J2])
  })
})

describe('quotidienDu (19:00 Paris, weekdays)', () => {
  const d = { type: 'quotidien' as const, heure: 19, jours: [1, 2, 3, 4, 5] }
  // 2026-09-23 is a Wednesday; Paris = UTC+2 in September.
  const mer = (hhmm: string) => Date.parse(`2026-09-23T${hhmm}:00+02:00`)

  it('is due from 19:00 Paris, once', () => {
    expect(quotidienDu(d, mer('18:59'), null)).toBe(false)
    expect(quotidienDu(d, mer('19:00'), null)).toBe(true)
    expect(quotidienDu(d, mer('19:00'), '20260923')).toBe(false)
    expect(quotidienDu(d, mer('22:30'), '20260922')).toBe(true) // catch-up after a restart
  })

  it('is never due on a weekend', () => {
    expect(quotidienDu(d, Date.parse('2026-09-26T19:30:00+02:00'), null)).toBe(false) // Saturday
  })

  it('announces the next run', () => {
    expect(prochainQuotidien(d, mer('10:00'), null)).toBe('2026-09-23T17:00:00.000Z')
    expect(prochainQuotidien(d, mer('20:00'), '20260923')).toBe('2026-09-24T17:00:00.000Z')
    // Friday evening, done → Monday.
    expect(prochainQuotidien(d, Date.parse('2026-09-25T20:00:00+02:00'), '20260925')).toBe('2026-09-28T17:00:00.000Z')
  })
})
