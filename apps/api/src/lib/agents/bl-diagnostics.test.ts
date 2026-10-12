import { describe, expect, it } from 'vitest'
import {
  aUnCaractereDe,
  candidatProbable,
  commandesImprimees,
  controlesAilleurs,
  listeCommandes,
  messageIntrouvables,
  messagePlusieursCommandes,
  poidsCoherent,
  type ArticleLigne,
} from './bl-diagnostics.js'

// Real cases of the v2 feedback (prod data, 2026-10-12).
const L9013: ArticleLigne = { ligne: 9013, commande: 9040, idSousTraitant: 9, reference: 1746, coloris: 1551 }
const L9018: ArticleLigne = { ligne: 9018, commande: 9045, idSousTraitant: 9, reference: 1746, coloris: 1551 }
const L9017: ArticleLigne = { ligne: 9017, commande: 9044, idSousTraitant: 9, reference: 639, coloris: 2801 }

describe('commandesImprimees', () => {
  it('reads one order or several joined by « + » (BL 109402A)', () => {
    expect(commandesImprimees('9045')).toEqual([9045])
    expect(commandesImprimees('9040+9045')).toEqual([9040, 9045])
    expect(commandesImprimees(' 9040 + 9045 ')).toEqual([9040, 9045])
  })
  it('refuses anything else', () => {
    expect(commandesImprimees('SS69')).toBeNull()
    expect(commandesImprimees('9040+')).toBeNull()
    expect(commandesImprimees('')).toBeNull()
  })
})

describe('typo on a piece number (BL 109400A, cde 9044)', () => {
  // Écrus of line 9017 still awaited; 3572/49 is printed on the BL, so excluded upstream.
  const candidats = [{ numero: '3572/50', poids: 20.8 }, { numero: '3572/51', poids: 20.8 }]
  it('finds 3572/50 for 3570/50 and 3572/51 for 3570/51', () => {
    expect(candidatProbable('3570/50', 20.8, candidats)?.numero).toBe('3572/50')
    expect(candidatProbable('3570/51', 20.8, candidats)?.numero).toBe('3572/51')
  })
  it('only one character apart, same piece suffix', () => {
    expect(aUnCaractereDe('3570/50', '3572/50')).toBe(true)
    expect(aUnCaractereDe('3570/50', '3572/51')).toBe(false)
    expect(aUnCaractereDe('3570/50', '3582/50')).toBe(false)
    expect(aUnCaractereDe('3570/50', '35700/50')).toBe(false)
    expect(aUnCaractereDe('3570/50', '3570/50')).toBe(false)
  })
  it('never guesses between two candidates, nor on an incoherent weight', () => {
    expect(candidatProbable('3570/50', 20.8, [...candidats, { numero: '3571/50', poids: 20.5 }])).toBeNull()
    expect(candidatProbable('3570/50', 11, candidats)).toBeNull()
    expect(poidsCoherent(0, 20.8)).toBe(true)
  })
  it('names the probable piece and says it is never replaced alone', () => {
    const m = messageIntrouvables([
      { numero: '3570/50', probable: { numero: '3572/50', poids: 20.8 } },
      { numero: '3599/1', probable: null },
    ], 9044)
    expect(m).toBe('Pièces introuvables dans le stock : 3570/50 (probablement 3572/50 : affectée à la commande 9044, pas encore reçue, 20,8 kg), 3599/1. Vérifiez le BL avec l’ennoblisseur : le numéro n’est jamais remplacé sans vous.')
    expect(messageIntrouvables([{ numero: '3599/1', probable: null }], 9044)).toBe('Pièce introuvable dans le stock : 3599/1.')
  })
})

describe('controlesAilleurs', () => {
  const pieces109401 = Array.from({ length: 12 }, (_, i) => ({ numero: `3568/${10 + i}`, ligne: 9013, commande: 9040 }))
  it('BL 109401A: « Commande n° 9045 », all 12 pieces on 9040, same article → probably misnumbered', () => {
    const cs = controlesAilleurs(pieces109401, 12, 9045, { imprimee: [L9018], autres: [L9013] })
    expect(cs).toHaveLength(1)
    expect(cs[0].code).toBe('pieces_autre_ligne')
    expect(cs[0].message).toBe('BL probablement mal numéroté : commande 9045 imprimée, mais ses 12 pièce(s) sont toutes sur la commande 9040 (même ennoblisseur, même référence, même coloris). Vérifiez avec l’ennoblisseur avant de réceptionner sur la 9040.')
  })
  it('names the other order when only some pieces are there, or the article differs', () => {
    const une = controlesAilleurs([pieces109401[0]], 12, 9045, { imprimee: [L9018], autres: [L9013] })
    expect(une[0].message).toBe('Pièce(s) affectée(s) à une autre commande : 3568/10 → commande 9040.')
    const autreArticle = controlesAilleurs(pieces109401, 12, 9045, { imprimee: [L9017], autres: [L9013] })
    expect(autreArticle[0].message).toMatch(/^Pièce\(s\) affectée\(s\) à une autre commande : 3568\/10, .* → commande 9040\.$/)
  })
  it('3560/3 (cde 9013, 06/10): affected to no order is its own case, not « another order »', () => {
    const cs = controlesAilleurs([{ numero: '3560/3', ligne: 0, commande: 0 }], 15, 9013, { imprimee: [], autres: [] })
    expect(cs).toEqual([{
      code: 'pieces_non_affectees',
      message: 'Pièce non affectée à la commande 9013 (ni à aucune autre) : 3560/3 — affectez-la avant la réception.',
    }])
  })
})

describe('BL common to several orders (109402A)', () => {
  it('says which piece goes where, under the same lot', () => {
    const m = messagePlusieursCommandes([9040, 9045], [
      { commande: 9040, pieces: ['3568/22', '3568/23', '3568/24', '3568/25', '3568/26', '3568/27', '3568/28', '3568/8', '3568/9'] },
      { commande: 9045, pieces: ['3568/5', '3568/29', '3568/30', '3568/31'] },
    ], 'MA109402')
    expect(m).toBe('BL commun aux commandes 9040 et 9045 : 9 pièces sur la 9040 (3568/22, 3568/23, 3568/24, 3568/25, 3568/26, 3568/27, 3568/28, 3568/8, 3568/9) ; 4 pièces sur la 9045 (3568/5, 3568/29, 3568/30, 3568/31). À réceptionner à la main, commande par commande, avec le même lot MA109402.')
  })
  it('lists orders in words', () => {
    expect(listeCommandes([9045, 9040])).toBe('9040 et 9045')
    expect(listeCommandes([9045, 9040, 9041])).toBe('9040, 9041 et 9045')
  })
})
