import { describe, expect, it } from 'vitest'
import type { FaitsDelai } from './delai-sst.js'
import {
  etapeTricotage,
  faitsDelaiTricotage,
  familleOfTypeSst,
  phaseTricotage,
  urgenceTricotage,
  type CommandeTricotage,
  type LigneTricotage,
} from './sst-tricotage.js'

/** A line with its délai (20/11) unless told otherwise. */
function ligne(over: Partial<LigneTricotage> = {}): LigneTricotage {
  return {
    id: 1, type: 1, quantite: 200, date_livraison: '20261120', rang_statut: 0,
    fil_affecte: true, a_un_of: false, kg_tricote: 0, kg_livre: 0, ...over,
  }
}

function trm(lignes: LigneTricotage[], over: Partial<CommandeTricotage> = {}): CommandeTricotage {
  return { est_soldee: false, trm: true, trm_soldee: false, lignes, ...over }
}

const TODAY = new Date(2026, 9, 6) // Tue 2026-10-06
const faits = (over: Partial<FaitsDelai> = {}): FaitsDelai => ({ demandeLe: null, dateNotif: null, relances: [], reports: [], reponduLe: null, ...over })

describe('familleOfTypeSst', () => {
  it('tricoteur → tricotage, everything else → ennoblissement', () => {
    expect(familleOfTypeSst(1)).toBe('tricotage')
    expect(familleOfTypeSst(2)).toBe('ennoblissement')
    expect(familleOfTypeSst(0)).toBe('ennoblissement')
    expect(familleOfTypeSst(null)).toBe('ennoblissement')
  })
})

describe('phaseTricotage: Tricotage Malterre', () => {
  it('soldée wins over everything, then soldée par TRM', () => {
    expect(phaseTricotage(trm([ligne()], { est_soldee: true, trm_soldee: true }))).toBe('terminee')
    expect(phaseTricotage(trm([ligne({ a_un_of: true })], { trm_soldee: true }))).toBe('trm_soldee')
  })

  it('a circulaire line without yarn blocks TRM: fil à affecter', () => {
    expect(phaseTricotage(trm([ligne(), ligne({ id: 2, fil_affecte: false })]))).toBe('fil_a_affecter')
  })

  it('every line has its yarn and no OF yet: à lancer', () => {
    expect(phaseTricotage(trm([ligne(), ligne({ id: 2 })]))).toBe('a_lancer')
  })

  it('one OF is enough for en tricotage, even if another line still lacks yarn', () => {
    expect(phaseTricotage(trm([ligne({ a_un_of: true }), ligne({ id: 2, fil_affecte: false })]))).toBe('en_tricotage')
  })

  it('a rectiligne-only order never gets an OF: en tricotage until soldée', () => {
    expect(phaseTricotage(trm([ligne({ type: 4, fil_affecte: false })]))).toBe('en_tricotage')
  })

  it('ignores the line sstatut (never moved on a TRM order)', () => {
    expect(phaseTricotage(trm([ligne({ rang_statut: 0, a_un_of: true })]))).toBe('en_tricotage')
  })

  it('an empty order is ETM\'s move', () => {
    expect(phaseTricotage(trm([]))).toBe('fil_a_affecter')
  })

  it('a line without a délai: attente délai, launched or not', () => {
    expect(phaseTricotage(trm([ligne({ date_livraison: '' })]))).toBe('attente_delai')
    expect(phaseTricotage(trm([ligne({ date_livraison: '', a_un_of: true })]))).toBe('attente_delai')
    expect(phaseTricotage(trm([ligne({ a_un_of: true }), ligne({ id: 2, date_livraison: '' })]))).toBe('attente_delai')
    // Cols / bandes owe their délai too.
    expect(phaseTricotage(trm([ligne({ type: 4, date_livraison: '' })]))).toBe('attente_delai')
  })

  it('the yarn comes first: nothing launched and a line without yarn stays ours', () => {
    expect(phaseTricotage(trm([ligne({ date_livraison: '', fil_affecte: false })]))).toBe('fil_a_affecter')
  })

  it('a delivered line owes no délai any more', () => {
    expect(phaseTricotage(trm([ligne({ date_livraison: '', a_un_of: true, kg_livre: 200 }), ligne({ id: 2, a_un_of: true })]))).toBe('en_tricotage')
  })
})

describe('phaseTricotage: external knitter', () => {
  const ext = (lignes: LigneTricotage[]) => trm(lignes, { trm: false })
  it('follows the bon de commande chain', () => {
    expect(phaseTricotage(ext([ligne({ rang_statut: 0 })]))).toBe('non_envoye')
    expect(phaseTricotage(ext([ligne({ rang_statut: 1 })]))).toBe('attente_delai')
    expect(phaseTricotage(ext([ligne({ rang_statut: 2 })]))).toBe('en_tricotage')
  })
  it('a received roll means knitting started', () => {
    expect(phaseTricotage(ext([ligne({ rang_statut: 1, kg_tricote: 20 })]))).toBe('en_tricotage')
  })
  it('never asks for yarn', () => {
    expect(phaseTricotage(ext([ligne({ fil_affecte: false })]))).toBe('non_envoye')
  })
})

describe('etapeTricotage', () => {
  const etape = (c: CommandeTricotage, f?: FaitsDelai) => {
    const phase = phaseTricotage(c)
    return etapeTricotage(c, phase, phase === 'attente_delai' ? faitsDelaiTricotage(c, f) : null, [], TODAY)
  }

  it('counts the circulaire lines by where they stand, even under « en tricotage »', () => {
    const e = etape(trm([
      ligne({ a_un_of: true, kg_livre: 190 }),
      ligne({ id: 2, a_un_of: true, kg_tricote: 50 }),
      ligne({ id: 3 }),
      ligne({ id: 4, fil_affecte: false }),
      ligne({ id: 5, type: 4, fil_affecte: false }),
    ]))
    expect(e.lignes).toEqual({ livrees: 1, en_tricotage: 1, a_lancer: 1, sans_fil: 1 })
  })

  it('an external knitter has no yarn nor OF to follow', () => {
    const e = etape(trm([ligne({ rang_statut: 2, fil_affecte: false })], { trm: false }))
    expect(e.lignes).toEqual({ livrees: 0, en_tricotage: 1, a_lancer: 0, sans_fil: 0 })
  })

  it('the délai is the earliest line not yet delivered, in working days', () => {
    const e = etape(trm([
      ligne({ a_un_of: true, date_livraison: '20261001', kg_livre: 200 }),
      ligne({ id: 2, a_un_of: true, date_livraison: '20261013' }),
      ligne({ id: 3, a_un_of: true, date_livraison: '20261020' }),
    ]))
    // Tue 06/10 → Tue 13/10: 5 working days.
    expect(e).toMatchObject({ delai: '2026-10-13', joursRestants: 5, autres: ['2026-10-20'] })
  })

  it('a past délai counts its late working days, the knitter’s closures aside', () => {
    const c = trm([ligne({ a_un_of: true, date_livraison: '20261001' })])
    expect(etape(c).joursRestants).toBe(-3)
    expect(etapeTricotage(c, 'en_tricotage', null, [{ du: '20261002', au: '20261002' }], TODAY).joursRestants).toBe(-2)
  })

  it('no délai yet: no date at all — the order asks none (Vincent 2026-11-16), an urgency is read on its line', () => {
    const e = etape(trm([ligne({ date_livraison: '' })]))
    expect(e).toMatchObject({ delai: null, joursRestants: null })
    expect(e).not.toHaveProperty('demande')
  })

  it('the knitter’s time runs from the order', () => {
    const attente = etape(trm([ligne()], { date_commande: '20261001' }))
    expect(attente).toMatchObject({ depuis: '2026-10-01', joursDepuis: 3, joursTotal: 0, joursEcoules: 0 })
  })

  it('en tricotage: one segment per working day from the order to the délai', () => {
    // Ordered Thu 01/10, due Tue 13/10: 8 working days, 3 behind us on Tue 06/10.
    const c = trm([ligne({ a_un_of: true, date_livraison: '20261013' })], { date_commande: '20261001' })
    expect(etape(c)).toMatchObject({ joursTotal: 8, joursEcoules: 3, joursRestants: 5 })
    // Past its délai: every segment is behind us, the delay is the figure's.
    const tard = trm([ligne({ a_un_of: true, date_livraison: '20261005' })], { date_commande: '20261001' })
    expect(etape(tard)).toMatchObject({ joursTotal: 2, joursEcoules: 2, joursRestants: -1 })
    // No délai, or no order date: nothing to draw.
    expect(etape(trm([ligne({ a_un_of: true, date_livraison: '' })], { date_commande: '20261001' })).joursTotal).toBe(0)
    expect(etape(trm([ligne({ a_un_of: true, date_livraison: '20261013' })])).joursTotal).toBe(0)
  })

  it('attente délai at Tricotage Malterre: asked by the order, due one working day later', () => {
    // Ordered Mon 05/10: délai due Tue 06/10, ours to chase from Wed 07/10.
    const e = etape(trm([ligne({ date_livraison: '' })], { date_commande: '20261005' }))
    expect(e).toMatchObject({ depuis: '2026-10-05', joursDepuis: 1, relance: '2026-10-07' })
    expect(e.question).toMatchObject({ demandeLe: '2026-10-05', echeance: '2026-10-06', joursDepuisDemande: 1, joursAccordes: 1, derniereRelance: null })
    // Vincent's example: ordered 16/11/2026, a délai is due on the 17th.
    const c = trm([ligne({ date_livraison: '' })], { date_commande: '20261116' })
    const v = etapeTricotage(c, 'attente_delai', faitsDelaiTricotage(c, undefined), [], new Date(2026, 10, 16))
    expect(v.question?.echeance).toBe('2026-11-17')
    expect(v.relance).toBe('2026-11-18')
  })

  it('attente délai at Tricotage Malterre: a relance gives two more working days, a report moves the échéance', () => {
    const c = trm([ligne({ date_livraison: '' })], { date_commande: '20261001' })
    const relance = etape(c, faits({ relances: [{ jour: '2026-10-06', canal: 'telephone', par: 'Isabelle', note: null }] }))
    expect(relance.relance).toBe('2026-10-08')
    expect(relance.question?.derniereRelance).toEqual({ jour: '2026-10-06', canal: 'telephone' })
    const report = etape(c, faits({ reports: [{ le: '2026-10-05T10:00', echeance: '2026-10-12', motif: 'planning TRM', imputable: 'sous_traitant', par: 'Isabelle' }] }))
    expect(report.question?.echeance).toBe('2026-10-12')
    expect(report.relance).toBe('2026-10-13')
  })

  it('attente délai at an external knitter: since the bon de commande, the dyers’ 3 working days', () => {
    const c = trm([ligne({ rang_statut: 1, date_livraison: '' })], { trm: false, date_commande: '20260928' })
    // Bon sent Fri 02/10: due Wed 07/10, ours to chase from Thu 08/10.
    const e = etape(c, faits({ demandeLe: '2026-10-02' }))
    expect(e).toMatchObject({ depuis: '2026-10-02', joursDepuis: 2, relance: '2026-10-08' })
    expect(e.question).toMatchObject({ echeance: '2026-10-07', joursAccordes: 3 })
  })

  it('no question outside attente délai', () => {
    expect(etape(trm([ligne({ a_un_of: true })])).question).toBeNull()
  })

  it('soldée par TRM: nothing left to wait for', () => {
    const c = trm([ligne({ a_un_of: true, date_livraison: '20260901' })], { trm_soldee: true })
    expect(etape(c)).toMatchObject({ delai: null, joursRestants: null, depuis: null })
  })
})

describe('urgenceTricotage', () => {
  const at = (date_livraison: string, over: Partial<LigneTricotage> = {}) => {
    const c = trm([ligne({ date_livraison, a_un_of: true, ...over })])
    return urgenceTricotage(c, phaseTricotage(c), null, TODAY)
  }
  it('red on the day and after, amber within 3 days, nothing later', () => {
    expect(at('20261005')).toBe('late')
    expect(at('20261006')).toBe('late')
    expect(at('20261009')).toBe('soon')
    expect(at('20261010')).toBeNull()
  })
  it('a delivered line (≥ 90 % shipped) is no longer late', () => {
    expect(at('20261001', { kg_livre: 180 })).toBeNull()
    expect(at('20261001', { kg_livre: 170 })).toBe('late')
  })
  it('knitted but not shipped is still late', () => {
    expect(at('20261001', { kg_tricote: 200 })).toBe('late')
  })
  it('a rectiligne line stays due until soldée', () => {
    expect(at('20261001', { type: 4 })).toBe('late')
  })
  it('soldée par TRM is never late', () => {
    const c = trm([ligne({ date_livraison: '20260901' })], { trm_soldee: true })
    expect(urgenceTricotage(c, 'trm_soldee', null, TODAY)).toBeNull()
  })
  it('attente délai: red from the chase day, never amber, nothing without a chase day', () => {
    const c = trm([ligne({ date_livraison: '' })])
    expect(urgenceTricotage(c, 'attente_delai', '2026-10-05', TODAY)).toBe('late')
    expect(urgenceTricotage(c, 'attente_delai', '2026-10-06', TODAY)).toBe('late')
    expect(urgenceTricotage(c, 'attente_delai', '2026-10-07', TODAY)).toBeNull()
    expect(urgenceTricotage(c, 'attente_delai', null, TODAY)).toBeNull()
  })

  it('attente délai ignores the dates of the other lines', () => {
    const c = trm([ligne({ date_livraison: '20261001', a_un_of: true }), ligne({ id: 2, date_livraison: '' })])
    expect(urgenceTricotage(c, phaseTricotage(c), '2026-10-09', TODAY)).toBeNull()
  })
})
