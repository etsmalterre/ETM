import { describe, expect, it } from 'vitest'
import {
  familleOfTypeSst,
  jaugeTricotage,
  phaseTricotage,
  urgenceTricotage,
  type CommandeTricotage,
  type LigneTricotage,
} from './sst-tricotage.js'

function ligne(over: Partial<LigneTricotage> = {}): LigneTricotage {
  return {
    id: 1, type: 1, quantite: 200, date_livraison: '', rang_statut: 0,
    fil_affecte: true, a_un_of: false, kg_tricote: 0, kg_livre: 0, ...over,
  }
}

function trm(lignes: LigneTricotage[], over: Partial<CommandeTricotage> = {}): CommandeTricotage {
  return { est_soldee: false, trm: true, trm_soldee: false, lignes, ...over }
}

const TODAY = new Date(2026, 9, 6) // Tue 2026-10-06
const NO_RELANCE = { date_notif: '', bon_envoye_le: '' }

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

describe('jaugeTricotage', () => {
  it('sums kg over circulaire lines only', () => {
    expect(jaugeTricotage(trm([
      ligne({ quantite: 200, kg_tricote: 150.04, kg_livre: 100 }),
      ligne({ id: 2, type: 4, quantite: 105, kg_tricote: 0 }),
    ]))).toEqual({ kg_commande: 200, kg_tricote: 150, kg_livre: 100 })
  })
})

describe('urgenceTricotage', () => {
  const at = (date_livraison: string, over: Partial<LigneTricotage> = {}) => {
    const c = trm([ligne({ date_livraison, a_un_of: true, ...over })])
    return urgenceTricotage(c, phaseTricotage(c), NO_RELANCE, TODAY)
  }
  it('red on the day and after, amber within 3 days, nothing later', () => {
    expect(at('20261005')).toBe('late')
    expect(at('20261006')).toBe('late')
    expect(at('20261009')).toBe('soon')
    expect(at('20261010')).toBeNull()
  })
  it('a line without a date raises nothing', () => {
    expect(at('')).toBeNull()
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
    expect(urgenceTricotage(c, 'trm_soldee', NO_RELANCE, TODAY)).toBeNull()
  })
  it('attente délai follows the relance date, else bon + 3 working days', () => {
    const c = trm([ligne({ rang_statut: 1 })], { trm: false })
    expect(urgenceTricotage(c, 'attente_delai', { date_notif: '20261006', bon_envoye_le: '' }, TODAY)).toBe('late')
    expect(urgenceTricotage(c, 'attente_delai', { date_notif: '20261007', bon_envoye_le: '' }, TODAY)).toBe('soon')
    // Sent Fri 2026-10-02 → relance Wed 2026-10-07 → amber on Tue.
    expect(urgenceTricotage(c, 'attente_delai', { date_notif: '', bon_envoye_le: '20261002' }, TODAY)).toBe('soon')
    expect(urgenceTricotage(c, 'attente_delai', NO_RELANCE, TODAY)).toBeNull()
  })
})
