import { describe, expect, it } from 'vitest'
import { etapeEtude, urgenceEtude } from './etude-etape.js'

const soum = (id: number, dateSoum: string, accepte = 0, dateReponse: string | null = null) => ({ id, dateSoum, dateReponse, accepte })

describe('urgenceEtude', () => {
  it('is red from the relance day, never before', () => {
    expect(urgenceEtude({ attente: 'labo', relanceLe: '20261126' }, '2026-11-25')).toBeNull()
    expect(urgenceEtude({ attente: 'labo', relanceLe: '20261126' }, '2026-11-26')).toEqual({ niveau: 'rouge', raison: 'Relancer l’ennoblisseur' })
    expect(urgenceEtude({ attente: 'client', relanceLe: '20261126' }, '2026-11-27')).toEqual({ niveau: 'rouge', raison: 'Relancer le client' })
  })
  it('asks nothing once accepted or cancelled, nor without a date', () => {
    expect(urgenceEtude({ attente: 'acceptee', relanceLe: null }, '2026-11-27')).toBeNull()
    expect(urgenceEtude({ attente: 'annulee', relanceLe: null }, '2026-11-27')).toBeNull()
    expect(urgenceEtude({ attente: 'labo', relanceLe: null }, '2026-11-27')).toBeNull()
  })
})

describe('etapeEtude', () => {
  it('the lab holds it from the type received: red once its 17 days are gone', () => {
    // Étude 1411 « 2411 paprika », type received on 2026-11-09, no soumission.
    const e = etapeEtude({ statut: 1, dateReception: '20261109' }, [], [], '2026-11-27')
    expect(e).toMatchObject({ attente: 'labo', origine: 'reception', depuis: '2026-11-09', relances: 0, derniereRelance: null })
    expect(e.fenetre).toMatchObject({ depuis: '2026-11-09', echeance: '2026-11-26', depassee: true })
    expect(e.urgence?.raison).toBe('Relancer l’ennoblisseur')
  })
  it('a relance of the lab restarts its clock and calms the étude', () => {
    const e = etapeEtude({ statut: 1, dateReception: '20261109' }, [], [{ cible: 'labo', le: '20261127' }], '2026-11-27')
    expect(e).toMatchObject({ depuis: '2026-11-09', relances: 1, derniereRelance: '2026-11-27', urgence: null })
    expect(e.fenetre).toMatchObject({ depuis: '2026-11-27', echeance: '2026-12-14', ecoules: 0, depassee: false })
  })
  it('the client holds it from the soumission sent', () => {
    const e = etapeEtude({ statut: 2, dateReception: '20261001' }, [soum(1, '20261120')], [], '2026-11-27')
    expect(e).toMatchObject({ attente: 'client', origine: 'soumission', depuis: '2026-11-20', urgence: null })
    expect(e.fenetre?.echeance).toBe('2026-12-11')
  })
  it('a refused soumission gives it back to the lab, from the day of the refusal', () => {
    const e = etapeEtude({ statut: 2, dateReception: '20261001' }, [soum(1, '20261015', 2, '20261020')], [{ cible: 'client', le: '20261018' }], '2026-11-27')
    expect(e).toMatchObject({ attente: 'labo', origine: 'refus', depuis: '2026-10-20', relances: 0 })
    expect(e.urgence?.raison).toBe('Relancer l’ennoblisseur')
  })
  it('accepted: the day of the yes; cancelled: nothing', () => {
    expect(etapeEtude({ statut: 3, dateReception: '20261001' }, [soum(1, '20261015', 1, '20261020')], [], '2026-11-27'))
      .toMatchObject({ attente: 'acceptee', accepteeLe: '2026-10-20', fenetre: null, urgence: null })
    expect(etapeEtude({ statut: 4, dateReception: '20261001' }, [], [], '2026-11-27'))
      .toMatchObject({ attente: 'annulee', fenetre: null, urgence: null })
  })
})
