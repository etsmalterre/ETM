import { describe, expect, it } from 'vitest'
import { analyserJournee, horaireDe, HORAIRE_JOURNEE, dureeTexte, arrondiMinute, joursCouverts, prenomAffiche } from './rapport-pointage.js'
import { contenuBilanHeures, contenuRapportPointage, soldeTexte, toneSolde } from './rapport-pointage-email.js'
import { msHeureParis, type LigneHoraire } from './pointage-etat.js'

// 21 September 2026 (a Monday), Paris wall clock.
const ms = (h: number, mi: number, s = 0) => msHeureParis(2026, 9, 21, h, mi, s)
const sec = (h: number, mi: number, s = 0) => Math.floor(ms(h, mi, s) / 1000)
const heure = (hm: string) => ms(+hm.slice(0, 2), +hm.slice(3, 5))
let id = 0
function ligne(debut: number, fin = 0, p1: [number, number] = [0, 0], p2: [number, number] = [0, 0]): LigneHoraire {
  return { id: ++id, idSalarie: 1, jour: '20260921', debut, fin, debut_pause1: p1[0], fin_pause1: p1[1], debut_pause2: p2[0], fin_pause2: p2[1] }
}
const sal = (prenom: string) => ({ id: prenom.length, prenom, nom: '' })

describe('arrondiMinute — the n8n rounding', () => {
  it('rounds up from 31 s, down below', () => {
    expect(arrondiMinute(sec(8, 19, 30))).toBe(ms(8, 19))
    expect(arrondiMinute(sec(8, 19, 31))).toBe(ms(8, 20))
    expect(arrondiMinute(0)).toBeNull()
  })
})

describe('shift worker (in the planning)', () => {
  const prevu = { debut: ms(5, 0), fin: ms(12, 0) }

  it('a clean shift with its 20 min pause raises nothing (Marie, 21/09)', () => {
    const r = analyserJournee(sal('Marie'), [ligne(sec(4, 54, 1), sec(12, 0, 53), [sec(9, 54, 14), sec(10, 13, 32)])], prevu, heure)
    expect(r.regime).toBe('equipe')
    expect(r.alertes).toEqual([])
    expect(r.pauseMin).toBe(20)
  })

  it('tolerates 5 min late, flags 6', () => {
    expect(analyserJournee(sal('A'), [ligne(sec(5, 5), sec(12, 0))], prevu, heure).alertes).toEqual([])
    const r = analyserJournee(sal('A'), [ligne(sec(5, 6), sec(12, 0))], prevu, heure)
    expect(r.rouge.debut).toBe(true)
    expect(r.alertes[0]).toBe('arrivée 05:06 au lieu de 05:00 (6 min de retard)')
  })

  it('flags leaving more than 5 min early', () => {
    const r = analyserJournee(sal('A'), [ligne(sec(5, 0), sec(11, 50))], prevu, heure)
    expect(r.rouge.fin).toBe(true)
    expect(r.alertes).toEqual(['départ 11:50 au lieu de 12:00 (10 min plus tôt)'])
  })

  it('flags pauses over 20 min, the gap between two lines counting as pause', () => {
    const r = analyserJournee(sal('A'), [ligne(sec(5, 0), sec(9, 0)), ligne(sec(9, 25), sec(12, 0))], prevu, heure)
    expect(r.pauses).toEqual([{ debut: ms(9, 0), fin: ms(9, 25) }])
    expect(r.rouge.pause).toBe(true)
  })

  it('an open shift is « fin de poste non pointée » (Daunovan, 21/09)', () => {
    const r = analyserJournee(sal('Daunovan'), [ligne(sec(5, 50, 29))], { debut: ms(6, 0), fin: ms(13, 0) }, heure)
    expect(r.alertes).toEqual(['fin de poste non pointée'])
    expect(r.rouge.fin).toBe(true)
  })

  it('planned but never clocked', () => {
    const r = analyserJournee(sal('A'), [], prevu, heure)
    expect(r.debut).toBeNull()
    expect(r.alertes).toEqual(['aucun pointage'])
  })
})

describe('day worker (not in the planning), expected 09:00-12:00 / 14:00-18:00', () => {
  it('a clean day with a clocked lunch raises nothing, the lunch is not a pause', () => {
    const r = analyserJournee(sal('Mickael'), [ligne(sec(8, 56), sec(11, 58)), ligne(sec(13, 56), sec(17, 57))], null, heure)
    expect(r.regime).toBe('journee')
    expect(r.alertes).toEqual([])
    expect(r.pauses).toEqual([])
    expect(r.pauseMin).toBe(0)
    expect(r.repas).toEqual([{ debut: ms(11, 58), fin: ms(13, 56) }])
    expect(r.rouge.repas).toBe(false)
  })

  it('Olivier is judged on his 08:30-12:00 / 14:00-17:30 schedule: leaving at 17:30 is in order (21/09)', () => {
    const lignes = [ligne(sec(8, 19, 51), sec(12, 0)), ligne(sec(13, 50, 32), sec(17, 30, 15))]
    expect(analyserJournee(sal('Olivier'), lignes, null, heure, horaireDe(5)).alertes).toEqual([])
    expect(analyserJournee(sal('Olivier'), lignes, null, heure, horaireDe(5)).rouge.fin).toBe(false)
    // an unlisted salarié keeps 09-12 / 14-18
    expect(horaireDe(999)).toEqual(HORAIRE_JOURNEE)
    expect(analyserJournee(sal('X'), [ligne(sec(9, 0), sec(12, 0)), ligne(sec(14, 0), sec(17, 30))], null, heure, horaireDe(999)).alertes)
      .toEqual(['départ 17:30 au lieu de 18:00 (30 min plus tôt)'])
  })

  it('en poste = first in to last out, minus pauses and lunch; null while open', () => {
    const n = analyserJournee(sal('Nicolas'), [ligne(sec(8, 50), sec(11, 58)), ligne(sec(14, 6), sec(18, 8))], null, heure, horaireDe(1))
    expect(n.enPosteMin).toBe(7 * 60 + 10)
    const m = analyserJournee(sal('Marie'), [ligne(sec(4, 54, 1), sec(12, 0, 53), [sec(9, 54, 14), sec(10, 13, 32)])], { debut: ms(5, 0), fin: ms(12, 0) }, heure)
    expect(m.enPosteMin).toBe(7 * 60 + 7 - m.pauseMin)
    expect(analyserJournee(sal('A'), [ligne(sec(9, 0))], null, heure).enPosteMin).toBeNull()
  })

  it('a late return turns the lunch red (Nicolas, 22/09)', () => {
    const r = analyserJournee(sal('Nicolas'), [ligne(sec(8, 50), sec(12, 4)), ligne(sec(14, 6), sec(18, 8))], null, heure)
    expect(r.repas).toEqual([{ debut: ms(12, 4), fin: ms(14, 6) }])
    expect(r.rouge.repas).toBe(true)
  })

  it('a forgotten lunch clock-out is flagged (Olivier, 21/09), and so is leaving at 17:30', () => {
    const r = analyserJournee(sal('Olivier'), [ligne(sec(8, 19, 51)), ligne(sec(13, 50, 32), sec(17, 30, 15))], null, heure)
    expect(r.alertes).toEqual(['sortie non pointée entre 08:20 et 13:51', 'départ 17:30 au lieu de 18:00 (30 min plus tôt)'])
  })

  it('one line across noon means the lunch was never clocked', () => {
    const r = analyserJournee(sal('A'), [ligne(sec(9, 0), sec(18, 0))], null, heure)
    expect(r.alertes).toEqual(['pause de midi non pointée'])
  })

  it('late in the morning and late back from lunch, with the tolerance', () => {
    const r = analyserJournee(sal('A'), [ligne(sec(9, 5), sec(12, 0)), ligne(sec(14, 10), sec(18, 0))], null, heure)
    expect(r.alertes).toEqual(['reprise 14:10 au lieu de 14:00 (10 min de retard)'])
    const r2 = analyserJournee(sal('A'), [ligne(sec(9, 20), sec(12, 0)), ligne(sec(14, 0), sec(18, 0))], null, heure)
    expect(r2.alertes).toEqual(['arrivée 09:20 au lieu de 09:00 (20 min de retard)'])
  })
})

describe('joursCouverts', () => {
  it('the day before, and Friday to Sunday on a Monday', () => {
    expect(joursCouverts('20260922', 2)).toEqual(['20260921'])
    expect(joursCouverts('20260921', 1)).toEqual(['20260918', '20260919', '20260920'])
    expect(joursCouverts('20260301', 7)).toEqual(['20260228'])
  })
})

describe('email content', () => {
  it('no email for a day nobody clocked', () => {
    expect(contenuRapportPointage([{ jour: '20260920', lignes: [] }])).toBeNull()
  })

  it('names the day and counts what to check, with no em or en dash anywhere', () => {
    const l = analyserJournee(sal('Daunovan'), [ligne(sec(5, 50))], { debut: ms(6, 0), fin: ms(13, 0) }, heure)
    const r = contenuRapportPointage([{ jour: '20260921', lignes: [l] }])!
    expect(r.subject).toBe('Rapport de pointage - Lundi 21 septembre')
    expect(r.content.intro).toContain('1 pointage à vérifier')
    const all = JSON.stringify(r)
    expect(all).not.toMatch(/[—–]/)
  })

  it('shows the lunch in the pause columns and in the pause total, and no unsubscribe line', () => {
    const l = analyserJournee(sal('Nicolas'), [ligne(sec(8, 50), sec(12, 4)), ligne(sec(14, 6), sec(18, 8))], null, heure)
    const r = contenuRapportPointage([{ jour: '20260922', lignes: [l] }])!
    const table = r.content.sections!.at(-1)!
    expect(table.html).toContain('12:04 - 14:06')
    expect(table.text).toContain('midi 12:04 - 14:06')
    expect(l.pauseMin).toBe(0)
    expect(table.text).toContain('pauses 2 h 02')
    expect(table.text).toContain('en poste 7 h 16')
    expect(table.html).toContain('En poste')
    // a late return is a pause problem: the total turns red with the lunch pill
    expect(table.html).toMatch(/color:#B91C1C;white-space:nowrap;">2 h 02/)
    expect(table.html).toContain('2 h 02')
    expect(r.content.footerNote).toBe('')
  })

  it('balances: thresholds, sign and ranking', () => {
    expect(toneSolde(300)).toBe('vert')
    expect(toneSolde(301)).toBe('orange')
    expect(toneSolde(-601)).toBe('rouge')
    expect(soldeTexte(1005)).toBe('+16:45')
    expect(soldeTexte(-150)).toBe('−2:30')
    const r = contenuBilanHeures([{ prenom: 'Nicolas', soldeMin: 15 }, { prenom: 'Angelique', soldeMin: 2070 }], { numero: 38, lundi: '20260914', samedi: '20260919' })!
    expect(r.subject).toBe('Bilan des heures annualisées - Semaine 38')
    expect(r.content.sections![0].text.split('\n')[0]).toMatch(/^Angelique/)
  })
})

describe('dureeTexte', () => {
  it('minutes under an hour, hours and minutes from one', () => {
    expect(dureeTexte(20)).toBe('20 min')
    expect(dureeTexte(59)).toBe('59 min')
    expect(dureeTexte(60)).toBe('1 h 00')
    expect(dureeTexte(128)).toBe('2 h 08')
  })
})

describe('prenomAffiche', () => {
  it('writes capitals as a name', () => {
    expect(prenomAffiche('DAUNOVAN')).toBe('Daunovan')
    expect(prenomAffiche('JEAN-MARC')).toBe('Jean-Marc')
    expect(prenomAffiche('ÉLODIE')).toBe('Élodie')
  })
})
