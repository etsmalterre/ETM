import { describe, expect, it } from 'vitest'
import { echeanceDelai, historiqueDelai, relanceDue, type FaitsDelai } from './delai-sst.js'
import { etatCommande, urgenceCommande, type CommandeFait } from './cycle-ennoblissement.js'

function faits(p: Partial<FaitsDelai> = {}): FaitsDelai {
  return { demandeLe: null, dateNotif: null, relances: [], reports: [], reponduLe: null, ...p }
}

function commande(f: FaitsDelai): CommandeFait {
  return { est_soldee: false, rangStatut: 1, delaiFaits: f, delai: null, lots: [], ecruChezTeinturier: 0 }
}

describe('échéance du délai', () => {
  it('bon + 3 working days, else date_notif, else the latest report', () => {
    expect(echeanceDelai(faits({ demandeLe: '2026-10-19' }))).toBe('2026-10-22')
    expect(echeanceDelai(faits({ demandeLe: '2026-10-19', dateNotif: '2026-10-23' }))).toBe('2026-10-23')
    expect(echeanceDelai(faits({
      demandeLe: '2026-10-19', dateNotif: null, // a form save cleared date_notif: the report still holds
      reports: [
        { le: '2026-10-20T10:00', echeance: '2026-10-26', motif: 'a', imputable: 'malterre', par: null },
        { le: '2026-10-21T09:00', echeance: '2026-10-28', motif: 'b', imputable: 'sous_traitant', par: null },
      ],
    }))).toBe('2026-10-28')
  })
})

describe('v9: pieces already at the dyer before the bon', () => {
  it('asked the next working day (9133, bon 29/10, pieces shipped 27/08)', () => {
    expect(echeanceDelai(faits({ demandeLe: '2026-10-29', dateNotif: '2026-11-03', stockChezSst: true }))).toBe('2026-10-30')
  })
  it('Friday bon: Monday', () => {
    expect(echeanceDelai(faits({ demandeLe: '2026-10-30', stockChezSst: true }))).toBe('2026-11-02')
  })
  it('a date_notif moved by hand, or a report, still wins', () => {
    expect(echeanceDelai(faits({ demandeLe: '2026-10-29', dateNotif: '2026-11-05', stockChezSst: true }))).toBe('2026-11-05')
    expect(echeanceDelai(faits({ demandeLe: '2026-10-29', stockChezSst: true, reports: [{ le: '2026-10-29T10:00', echeance: '2026-11-04', motif: 'a', imputable: 'malterre', par: null }] }))).toBe('2026-11-04')
  })
})

describe('relance due (what turns the card red)', () => {
  // 9117: bon 19/10, échéance 22/10, MATEL asked in the Point sent 22/10.
  const p9117 = faits({ demandeLe: '2026-10-19', relances: [{ jour: '2026-10-22', canal: 'point', par: null, note: null }] })
  it('a relance gives the dyer 2 working days', () => {
    expect(relanceDue(p9117)).toBe('2026-10-26')
    expect(urgenceCommande(etatCommande(commande(p9117)), '2026-10-22')).toBeNull()
    expect(urgenceCommande(etatCommande(commande(p9117)), '2026-10-23')).toBeNull() // no amber while waiting for a délai
    expect(urgenceCommande(etatCommande(commande(p9117)), '2026-10-26')).toBe('late')
  })
  it('no relance: neutral on the échéance (the Point asks), red from the next working day (2026-11-02)', () => {
    const f = faits({ demandeLe: '2026-10-19' })
    expect(relanceDue(f)).toBe('2026-10-23')
    expect(urgenceCommande(etatCommande(commande(f)), '2026-10-22')).toBeNull()
    expect(urgenceCommande(etatCommande(commande(f)), '2026-10-23')).toBe('late')
    // 9131: bon Wed 28/10, échéance Mon 02/11, red on Tue 03/11.
    expect(relanceDue(faits({ demandeLe: '2026-10-28' }))).toBe('2026-11-03')
  })
  it('a relance before the échéance does not bring it forward', () => {
    expect(relanceDue(faits({ demandeLe: '2026-10-19', relances: [{ jour: '2026-10-19', canal: 'telephone', par: null, note: null }] }))).toBe('2026-10-23')
  })
  it('a relance older than the bon (a re-sent order) is ignored', () => {
    expect(relanceDue(faits({ demandeLe: '2026-10-19', relances: [{ jour: '2026-10-10', canal: 'point', par: null, note: null }] }))).toBe('2026-10-23')
  })
  it('a report moves both the Point and the card', () => {
    const f = faits({ demandeLe: '2026-10-19', relances: [{ jour: '2026-10-22', canal: 'point', par: null, note: null }], reports: [{ le: '2026-10-22T15:00', echeance: '2026-11-02', motif: 'Fil pas encore reçu', imputable: 'malterre', par: 'PE' }] })
    expect(echeanceDelai(f)).toBe('2026-11-02')
    expect(relanceDue(f)).toBe('2026-11-03')
  })
})

describe('public holidays (lib/jours-ouvres.ts, 2026-11-02)', () => {
  it('bon Mon 09/11: 11/11 skipped, échéance Fri 13/11 (was Thu 12/11)', () => {
    expect(echeanceDelai(faits({ demandeLe: '2026-11-09' }))).toBe('2026-11-13')
  })
  it('a date_notif seeded by the old weekend-only count is still a seed', () => {
    expect(echeanceDelai(faits({ demandeLe: '2026-11-09', dateNotif: '2026-11-12' }))).toBe('2026-11-13')
  })
  it('the day after a holiday échéance is a working day', () => {
    // bon Thu 05/11 → échéance Tue 10/11; red Thu 12/11 (11/11 is off).
    expect(relanceDue(faits({ demandeLe: '2026-11-05' }))).toBe('2026-11-12')
  })
})

describe('historique', () => {
  it('oldest first, every channel named', () => {
    const h = historiqueDelai(faits({
      demandeLe: '2026-10-19',
      relances: [{ jour: '2026-10-22', canal: 'point', par: null, note: null }, { jour: '2026-10-24', canal: 'telephone', par: 'PE', note: 'Perrine absente' }],
      reponduLe: '2026-10-27',
    }))
    expect(h.map((e) => e.type)).toEqual(['demande', 'relance', 'relance', 'delai_recu'])
    expect(h[2].texte).toBe('Relancé par téléphone — Perrine absente')
  })
})
