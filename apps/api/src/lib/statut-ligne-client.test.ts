import { describe, expect, it } from 'vitest'
import { statutLigneClient, type FaitsLigneClient } from './statut-ligne-client.js'

const base: FaitsLigneClient = {
  quantite: 500, soldee: false, expedie: 0, pret: 0, nbPret: 0, nbControle: 0,
  nbChezEnnoblisseur: 0, nbCommandesEnnoblisseur: 0, soumisClient: false, kgTricotage: 0,
}
const etat = (f: Partial<FaitsLigneClient>) => statutLigneClient({ ...base, ...f }, 'Ml').etat

describe('statutLigneClient', () => {
  it('reads a closed order as soldée whatever shipped', () => {
    expect(etat({ soldee: true })).toBe('soldee')
    expect(etat({ soldee: true, expedie: 500 })).toBe('soldee')
  })
  it('counts a line shipped from 90 % (« soldé » typed at 92 % on 3881)', () => {
    expect(etat({ expedie: 449 })).not.toBe('expediee')
    expect(etat({ expedie: 450 })).toBe('expediee')
    expect(etat({ expedie: 450, nbControle: 3 })).toBe('expediee')
  })
  it('is prête à expédier when shipped + validated rolls reach the threshold', () => {
    expect(etat({ pret: 460, nbPret: 12 })).toBe('pae')
    expect(etat({ expedie: 250, pret: 210, nbPret: 5, nbChezEnnoblisseur: 4 })).toBe('pae')
  })
  it('is chez l’ennoblisseur while the rest is at the dyer, rolls in control included', () => {
    expect(etat({ nbControle: 10 })).toBe('ennoblisseur')
    expect(etat({ nbChezEnnoblisseur: 8, kgTricotage: 200 })).toBe('ennoblisseur')
    expect(etat({ nbCommandesEnnoblisseur: 1 })).toBe('ennoblisseur')
    expect(etat({ soumisClient: true })).toBe('ennoblisseur')
    expect(etat({ pret: 100, nbPret: 3, nbControle: 2 })).toBe('ennoblisseur')
  })
  it('is en tricotage on planned knitting alone', () => {
    expect(etat({ kgTricotage: 300 })).toBe('tricotage')
  })
  it('falls back to prête when rolls are ready but nothing else is launched', () => {
    expect(etat({ pret: 100, nbPret: 3 })).toBe('pae')
  })
  it('is à lancer with no fact', () => {
    expect(etat({})).toBe('a_lancer')
    expect(etat({ expedie: 100 })).toBe('a_lancer')
  })
  it('gives the shipped share and the proofs', () => {
    const s = statutLigneClient({ ...base, expedie: 250, nbControle: 2, pret: 0 }, 'Ml')
    expect(s.part).toBe(0.5)
    expect(s.preuves).toEqual(['250 Ml expédiés sur 500', '2 rouleaux en contrôle chez l’ennoblisseur'])
    expect(statutLigneClient({ ...base, quantite: 0 }, 'Ml').part).toBeNull()
  })
})
