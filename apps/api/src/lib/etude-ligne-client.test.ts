import { describe, expect, it } from 'vitest'
import { attendEtude, dateEnEtude, etatEtude, etudeUrgence, MESSAGE_DATE_EN_ETUDE, type EtudeLigne } from './etude-ligne-client.js'

const soum = (id: number, dateSoum: string, accepte = 0, dateReponse: string | null = null) => ({ id, dateSoum, dateReponse, accepte })

describe('etatEtude', () => {
  it('waits for the lab from the type received, chased at 17 j', () => {
    expect(etatEtude({ statut: 1, dateReception: '20261006' }, [], []))
      .toEqual({ attente: 'labo', depuis: '20261006', attenteDepuis: '20261006', relanceLe: '20261023', derniereRelance: null })
  })
  it('waits for the client from the latest pending soumission, chased at 21 j', () => {
    const e = etatEtude({ statut: 2, dateReception: '20260901' }, [soum(1, '20260915', 2, '20260920'), soum(2, '20261001')], [])
    expect(e.attente).toBe('client')
    expect(e.relanceLe).toBe('20261022')
  })
  it('a refused soumission (statut still 2) gives the étude back to the lab from the answer', () => {
    const e = etatEtude({ statut: 2, dateReception: '20260901' }, [soum(1, '20260915', 2, '20260920')], [])
    expect(e).toMatchObject({ attente: 'labo', depuis: '20260920', relanceLe: '20261007' })
  })
  it('a relance of the current holder restarts the clock; one of the other holder does not', () => {
    const e = etatEtude({ statut: 2, dateReception: '20260901' }, [soum(1, '20261001')],
      [{ cible: 'client', le: '20261020' }, { cible: 'labo', le: '20261021' }])
    expect(e).toMatchObject({ attente: 'client', depuis: '20261020', attenteDepuis: '20261001', relanceLe: '20261110', derniereRelance: '20261020' })
  })
  it('an older relance than the current wait is ignored', () => {
    const e = etatEtude({ statut: 1, dateReception: '20261006' }, [], [{ cible: 'labo', le: '20260901' }])
    expect(e.derniereRelance).toBe(null)
  })
  it('accepted or cancelled: nobody to chase', () => {
    expect(etatEtude({ statut: 3, dateReception: null }, [], []).attente).toBe('acceptee')
    expect(etatEtude({ statut: 2, dateReception: null }, [soum(1, '20261001', 1, '20261005')], []).attente).toBe('acceptee')
    expect(etatEtude({ statut: 4, dateReception: null }, [], []).attente).toBe('annulee')
  })
})

describe('etudeUrgence', () => {
  const etudes = new Map<number, EtudeLigne>([[7, { id: 7, libelle: 'x', attente: 'client', depuis: '20261001', attenteDepuis: '20261001', relanceLe: '20261022', derniereRelance: null }]])
  it('only for a line still without its coloris', () => {
    expect(etudeUrgence(0, 0, etudes)).toBeUndefined()
    expect(etudeUrgence(7, 5311, etudes)).toBeUndefined()
    expect(etudeUrgence(7, 0, etudes)).toEqual({ attente: 'client', relanceLe: '20261022' })
    expect(etudeUrgence(99, 0, etudes)).toEqual({ attente: 'annulee', relanceLe: null })
  })
})

describe('attendEtude', () => {
  it('a line pointing at an étude, still without its coloris', () => {
    expect(attendEtude(7, 0)).toBe(true)
    expect(attendEtude('7', null)).toBe(true)
    expect(attendEtude(7, 5311)).toBe(false)
    expect(attendEtude(0, 0)).toBe(false)
    expect(attendEtude(null, undefined)).toBe(false)
  })
})

// Order 3944 (2026-11-10): validated, the line in étude took 27/01/2027 as an engagement, then two
// reports « on attend le coloris ». A line in étude carries no date.
describe('dateEnEtude', () => {
  it('in préparation: no date, whatever was typed or left on the line', () => {
    expect(dateEnEtude({ enPreparation: true, actuelle: '', demandee: '20270127' })).toEqual({ date: '' })
    expect(dateEnEtude({ enPreparation: true, actuelle: '20270127', demandee: '20270127' })).toEqual({ date: '' })
  })
  it('validated, without a date: none may be written', () => {
    expect(dateEnEtude({ enPreparation: false, actuelle: '', demandee: '20270127' })).toEqual({ refus: MESSAGE_DATE_EN_ETUDE })
    expect(dateEnEtude({ enPreparation: false, actuelle: '', demandee: '' })).toEqual({ date: '' })
  })
  it('validated, already dated (before the rule): the ordinary rules, its date is an engagement', () => {
    expect(dateEnEtude({ enPreparation: false, actuelle: '20261110', demandee: '20270120' })).toEqual({ date: '20270120' })
    expect(dateEnEtude({ enPreparation: false, actuelle: '20261110', demandee: '20261110' })).toEqual({ date: '20261110' })
  })
})
