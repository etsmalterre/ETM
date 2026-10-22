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

describe('relance due (what turns the card red)', () => {
  // 9117: bon 19/10, échéance 22/10, MATEL asked in the Point sent 22/10.
  const p9117 = faits({ demandeLe: '2026-10-19', relances: [{ jour: '2026-10-22', canal: 'point', par: null, note: null }] })
  it('a relance gives the dyer 2 working days', () => {
    expect(relanceDue(p9117)).toBe('2026-10-26')
    expect(urgenceCommande(etatCommande(commande(p9117)), '2026-10-22')).toBeNull()
    expect(urgenceCommande(etatCommande(commande(p9117)), '2026-10-23')).toBe('soon')
    expect(urgenceCommande(etatCommande(commande(p9117)), '2026-10-26')).toBe('late')
  })
  it('no relance: red from the échéance', () => {
    const f = faits({ demandeLe: '2026-10-19' })
    expect(relanceDue(f)).toBe('2026-10-22')
    expect(urgenceCommande(etatCommande(commande(f)), '2026-10-22')).toBe('late')
  })
  it('a relance before the échéance does not bring it forward', () => {
    expect(relanceDue(faits({ demandeLe: '2026-10-19', relances: [{ jour: '2026-10-19', canal: 'telephone', par: null, note: null }] }))).toBe('2026-10-22')
  })
  it('a relance older than the bon (a re-sent order) is ignored', () => {
    expect(relanceDue(faits({ demandeLe: '2026-10-19', relances: [{ jour: '2026-10-10', canal: 'point', par: null, note: null }] }))).toBe('2026-10-22')
  })
  it('a report moves both the Point and the card', () => {
    const f = faits({ demandeLe: '2026-10-19', relances: [{ jour: '2026-10-22', canal: 'point', par: null, note: null }], reports: [{ le: '2026-10-22T15:00', echeance: '2026-11-02', motif: 'Fil pas encore reçu', imputable: 'malterre', par: 'PE' }] })
    expect(echeanceDelai(f)).toBe('2026-11-02')
    expect(relanceDue(f)).toBe('2026-11-02')
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
