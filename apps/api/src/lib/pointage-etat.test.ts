import { describe, expect, it } from 'vitest'
import {
  POSTE_OUVERT_MAX_S,
  dtParis,
  etatPointage,
  jourParis,
  jourPrecedent,
  parseDtParisMs,
  pausesS,
  semaineIso,
  texteMessage,
  type LigneHoraire,
} from './pointage-etat.js'

const T = 1_789_473_494 // 2026-09-15 14:38:14 UTC
const ligne = (over: Partial<LigneHoraire> = {}): LigneHoraire => ({
  id: 1, idSalarie: 5, jour: '20260915',
  debut: T, debut_pause1: 0, fin_pause1: 0, debut_pause2: 0, fin_pause2: 0, fin: 0,
  ...over,
})
const actions = (l: LigneHoraire | null, now = T + 60) => etatPointage(l, now).actions.map((a) => [a.action, a.colonnes.join('+')])

describe('etatPointage — the FEN_PointageSalarié button table', () => {
  it('no open line: one button, Début du travail', () => {
    const e = etatPointage(null, T)
    expect(e.statut).toBe('hors_poste')
    expect(e.actions.map((a) => a.libelle)).toEqual(['Début du travail'])
  })

  it('walks the two pauses, then offers only Fin du travail', () => {
    expect(actions(ligne())).toEqual([['debut_pause', 'debut_pause1'], ['fin_travail', 'fin']])
    expect(actions(ligne({ debut_pause1: T + 10 }))).toEqual([['fin_pause', 'fin_pause1'], ['fin_pause_fin_travail', 'fin_pause1+fin']])
    expect(actions(ligne({ debut_pause1: T + 10, fin_pause1: T + 20 }))).toEqual([['debut_pause', 'debut_pause2'], ['fin_travail', 'fin']])
    expect(actions(ligne({ debut_pause1: T + 10, fin_pause1: T + 20, debut_pause2: T + 30 }))).toEqual([['fin_pause', 'fin_pause2'], ['fin_pause_fin_travail', 'fin_pause2+fin']])
    expect(actions(ligne({ debut_pause1: T + 10, fin_pause1: T + 20, debut_pause2: T + 30, fin_pause2: T + 40 }))).toEqual([['fin_travail', 'fin']])
  })

  it('logs en_poste 1 when work resumes, 0 when it stops', () => {
    const en = (l: LigneHoraire | null) => etatPointage(l, T + 60).actions.map((a) => a.enPoste)
    expect(en(null)).toEqual([1])
    expect(en(ligne())).toEqual([0, 0])
    expect(en(ligne({ debut_pause1: T + 10 }))).toEqual([1, 0])
  })

  it('reports the pause status', () => {
    expect(etatPointage(ligne({ debut_pause1: T + 10 }), T + 60).statut).toBe('en_pause')
    expect(etatPointage(ligne(), T + 60).statut).toBe('au_travail')
  })

  it('a night shift is continued; a line older than the limit is not', () => {
    expect(etatPointage(ligne(), T + 8 * 3600).ligne?.id).toBe(1)
    const vieux = etatPointage(ligne(), T + POSTE_OUVERT_MAX_S + 1)
    expect(vieux.ligne).toBeNull()
    expect(vieux.nonFermee?.id).toBe(1)
    expect(vieux.actions.map((a) => [a.action, a.libelle])).toEqual([['debut_travail', 'Commencer aujourd’hui']])
  })
})

describe('pausesS', () => {
  it('sums finished pauses and runs a current one up to now', () => {
    expect(pausesS(ligne({ debut_pause1: T, fin_pause1: T + 600 }), T + 9999)).toBe(600)
    expect(pausesS(ligne({ debut_pause1: T, fin_pause1: T + 600, debut_pause2: T + 1000 }), T + 1300)).toBe(900)
  })
})

describe('Europe/Paris clock', () => {
  it('formats the HFSQL literals in Paris time, summer and winter', () => {
    const ete = Date.UTC(2026, 8, 15, 14, 26, 40)
    expect(jourParis(ete)).toBe('20260915')
    expect(dtParis(ete)).toBe('20260915162640')
    expect(dtParis(Date.UTC(2026, 0, 15, 23, 30, 0))).toBe('20260116003000')
  })

  it('reads back both driver shapes to the same instant', () => {
    const ete = Date.UTC(2026, 8, 15, 14, 26, 40)
    expect(parseDtParisMs('2026-09-15 16:26:40.000')).toBe(ete)
    expect(parseDtParisMs('20260915162640')).toBe(ete)
    expect(parseDtParisMs(null)).toBeNull()
    expect(parseDtParisMs('00000000000000')).toBeNull()
  })

  it('round-trips across the autumn DST change', () => {
    const t = Date.UTC(2026, 9, 25, 3, 15, 0) // 04:15 CET, after the switch
    expect(parseDtParisMs(dtParis(t))).toBe(t)
  })

  it('steps back a day across a month', () => {
    expect(jourPrecedent('20260301')).toBe('20260228')
  })
})

describe('semaineIso', () => {
  it('numbers weeks the ISO way (2026 has 53)', () => {
    expect(semaineIso(Date.UTC(2026, 8, 15, 12))).toEqual({ annee: 2026, numero: 38 })
    expect(semaineIso(Date.UTC(2026, 11, 31, 12))).toEqual({ annee: 2026, numero: 53 })
    expect(semaineIso(Date.UTC(2027, 0, 1, 12))).toEqual({ annee: 2026, numero: 53 })
    expect(semaineIso(Date.UTC(2027, 0, 4, 12))).toEqual({ annee: 2027, numero: 1 })
  })
})

describe('texteMessage', () => {
  it('turns Admin Pointage HTML into plain lines', () => {
    expect(texteMessage('\r\n<BODY bgColor=#fdfdfd><P><FONT color=red>Réunion&nbsp;à 14h</FONT></P><P>Merci &amp; bonne journée</P></BODY>'))
      .toBe('Réunion à 14h\nMerci & bonne journée')
    expect(texteMessage(null)).toBe('')
  })
})
