import { describe, expect, it } from 'vitest'
import { comparer, dedoublonner, doitEnvoyer, memoireVide, type Memoire } from './constats.js'
import { construireMail } from './email.js'
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

describe('doitEnvoyer', () => {
  it('mails only on something new that is not mere info', () => {
    const m = comparer(memoireVide(), [c('1')], J1).memoire
    expect(doitEnvoyer(comparer(m, [c('1')], J2).constats)).toBe(false) // nothing new
    expect(doitEnvoyer(comparer(m, [c('1'), c('2', 'info')], J2).constats)).toBe(false) // new but info
    expect(doitEnvoyer(comparer(m, [c('1'), c('3')], J2).constats)).toBe(true)
    expect(doitEnvoyer(comparer(m, [c('1', 'urgent')], J2).constats)).toBe(true) // aggravated
  })
})

describe('construireMail', () => {
  it('counts only the new points in the subject and leaves info out', () => {
    const m = comparer(memoireVide(), [c('old')], J1).memoire
    const r = comparer(m, [c('old'), c('n1', 'urgent'), c('n2'), c('i', 'info')], J2)
    const mail = construireMail(r.constats, 0, Date.parse(J2), '/agents-ia/agents?agent=superviseur&run=x')
    expect(mail.sujet).toMatch(/^Superviseur — 2 points à voir/)
    const text = mail.contenu.sections!.map((s) => s.text).join('\n')
    expect(text).toContain('URGENT')
    expect(text).toContain('TOUJOURS OUVERT')
    expect(text).not.toContain('Commande i ')
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
