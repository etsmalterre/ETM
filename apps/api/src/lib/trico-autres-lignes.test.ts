import { describe, it, expect } from 'vitest'
import { memeTricot, ordreAutresLignes, raisonRefusTricot, type AutreLigneTricot } from './trico-autres-lignes.js'

const ligne = (o: Partial<AutreLigneTricot> & { ligneId: number }): AutreLigneTricot => ({
  commandeId: 1, numero: '3957', client_nom: 'Client', article: '186A - noir', delai: '20270111', ecru_kg: 22.2, lots: [],
  meme_commande: false, raison: null, ...o,
})

describe('memeTricot: the same knit is the same écru and écru coloris, not the same fini', () => {
  it('two dyed coloris of one reference are one knit (order 3957)', () => {
    expect(memeTricot({ ecru: 249, coloris: 995 }, { ecru: 249, coloris: 995 })).toBe(true)
  })
  it('another écru coloris, another écru, or no coloris is not', () => {
    expect(memeTricot({ ecru: 249, coloris: 995 }, { ecru: 249, coloris: 996 })).toBe(false)
    expect(memeTricot({ ecru: 249, coloris: 995 }, { ecru: 133, coloris: 995 })).toBe(false)
    expect(memeTricot({ ecru: 249, coloris: 0 }, { ecru: 249, coloris: 0 })).toBe(false)
  })
})

describe('raisonRefusTricot: a line joins only when it could launch itself', () => {
  const ok = { memeEcru: true, enPreparation: false, soldee: false, manquants: [] as string[] }
  it('a validated line with all its yarn at the knitter joins', () => {
    expect(raisonRefusTricot(ok)).toBeNull()
  })
  it('says why otherwise, the first reason that holds', () => {
    expect(raisonRefusTricot({ ...ok, memeEcru: false })).toBe('réservé pour un autre tricot')
    expect(raisonRefusTricot({ ...ok, soldee: true })).toBe('commande soldée')
    expect(raisonRefusTricot({ ...ok, enPreparation: true })).toBe('commande en préparation')
    expect(raisonRefusTricot({ ...ok, manquants: ['ELASTHANNE 22 - blanc'] })).toBe('fil incomplet chez ce tricoteur : manque ELASTHANNE 22 - blanc')
  })
})

describe('ordreAutresLignes', () => {
  it('the lines of the same client order first, then the earliest délai', () => {
    const l = [
      ligne({ ligneId: 1, delai: '20261201' }),
      ligne({ ligneId: 2, delai: '20270301', meme_commande: true }),
      ligne({ ligneId: 3, delai: '' }),
      ligne({ ligneId: 4, delai: '20270111', meme_commande: true }),
    ]
    expect([...l].sort(ordreAutresLignes).map((x) => x.ligneId)).toEqual([4, 2, 1, 3])
  })
})
