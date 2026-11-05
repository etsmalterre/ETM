import { describe, expect, it } from 'vitest'
import { citationDansMail, relireDelai, verifierControles, verifierDelais, type ControleIa, type DelaiLu } from './lecture.js'
import type { QuestionDelai } from './reponse-point.js'

// MATEL's reply to the Point of 02/11/2026 (shortened).
const REPONSE = `Bonjour,

2)lot 109516     laize = 155cm     poids = 163g/m²     stabs     h = -3     l = -3     V = 4%
Résultats lot 109669 demain

3) cde 9087 finie
Cde 9086 fin de semaine

5) s 49

Cordialement.`
const DATE = '2026-11-02T09:12:00.000Z'

const q = (commande: string, idligne = Number(commande) * 10): QuestionDelai => ({ commande, idcommande: Number(commande), idligne, article: 'JERSEY' })
const lu = (o: Partial<DelaiLu>): DelaiLu => ({ commande: '9086', citation: 's 49', nommee: false, date: '2026-12-02', certain: true, raison: '', ...o })

describe('citationDansMail', () => {
  it('finds a passage whatever the spacing, case and accents', () => {
    expect(citationDansMail('Cde 9086 fin de semaine', REPONSE)).toBe(true)
    expect(citationDansMail('cde  9086   FIN de semaine', REPONSE)).toBe(true)
    expect(citationDansMail('resultats lot 109669 demain', REPONSE)).toBe(true)
  })
  it('refuses a passage the mail does not hold, or none', () => {
    expect(citationDansMail('s 50', REPONSE)).toBe(false)
    expect(citationDansMail('', REPONSE)).toBe(false)
  })
})

describe('relireDelai', () => {
  it('reads the sure forms, with or without the order named', () => {
    expect(relireDelai('s 49', DATE)).toBe('2026-12-02')
    expect(relireDelai('5) s 49', DATE)).toBe('2026-12-02')
    expect(relireDelai('cde 9086 s 49', DATE)).toBe('2026-12-02')
    expect(relireDelai('le reste s 50', DATE)).toBe('2026-12-09')
  })
  it('leaves the other forms to the model', () => {
    expect(relireDelai('Cde 9086 fin de semaine', DATE)).toBeNull()
  })
})

describe('verifierDelais', () => {
  it('keeps a sure reading the code agrees with', () => {
    const [v] = verifierDelais([q('9086')], { repondAuPoint: true, commandes: [lu({})] }, REPONSE, DATE)
    expect(v).toMatchObject({ commande: '9086', texte: 's 49', delai: '2026-12-02', doute: null })
  })
  it('the right not to know: certain false is a doubt, with the best guess kept', () => {
    const [v] = verifierDelais([q('9086')], { repondAuPoint: true, commandes: [lu({ citation: 'Cde 9086 fin de semaine', date: '2026-11-06', certain: false, raison: 'Quelle semaine ?' })] }, REPONSE, DATE)
    expect(v.doute).toBe('Quelle semaine ?')
    expect(v.delai).toBe('2026-11-06')
  })
  it('a passage not in the mail is a doubt', () => {
    const [v] = verifierDelais([q('9086')], { repondAuPoint: true, commandes: [lu({ citation: 's 50', date: '2026-12-09' })] }, REPONSE, DATE)
    expect(v.doute).toMatch(/ne retrouve pas « s 50 »/)
  })
  it('a code reading that disagrees is a doubt, proposing the code’s date', () => {
    const [v] = verifierDelais([q('9086')], { repondAuPoint: true, commandes: [lu({ date: '2026-12-04' })] }, REPONSE, DATE)
    expect(v.delai).toBe('2026-12-02')
    expect(v.doute).toMatch(/02\/12, pas le 04\/12/)
  })
  it('certain but no date (« finie ») is a doubt', () => {
    const [v] = verifierDelais([q('9087')], { repondAuPoint: true, commandes: [lu({ commande: '9087', citation: 'cde 9087 finie', date: null })] }, REPONSE, DATE)
    expect(v.doute).toMatch(/ne lis pas de date/)
  })
  it('an order without answer gets no reading, an order not asked is an aide at the end', () => {
    const vs = verifierDelais([q('9086'), q('9090')], { repondAuPoint: true, commandes: [lu({}), lu({ commande: '9087', citation: 'cde 9087 finie', date: null })] }, REPONSE, DATE)
    expect(vs.map((v) => [v.commande, v.texte, !!v.question])).toEqual([['9086', 's 49', true], ['9090', '', true], ['9087', 'cde 9087 finie', false]])
    expect(vs[2].doute).toMatch(/pas demandée/)
  })
  it('every line of one order gets the same reading', () => {
    const vs = verifierDelais([q('9086', 1), q('9086', 2)], { repondAuPoint: true, commandes: [lu({})] }, REPONSE, DATE)
    expect(vs.map((v) => [v.question?.idligne, v.delai])).toEqual([[1, '2026-12-02'], [2, '2026-12-02']])
  })
})

const lot = (o: Partial<ControleIa>): ControleIa => ({
  lot: '109516', citation: 'lot 109516     laize = 155cm     poids = 163g/m²     stabs     h = -3     l = -3     V = 4%',
  laize: 155, poids: 163, stabH: -3, stabL: -3, vrillage: 4, plusTard: false, certain: true, raison: '', ...o,
})

describe('verifierControles', () => {
  it('keeps a reading the code agrees with', () => {
    const [c] = verifierControles([lot({})], REPONSE)
    expect(c).toMatchObject({ lot: '109516', laize: 155, poids: 163, stabH: -3, stabL: -3, vrillage: 4 })
    expect(c.doute).toBeUndefined()
  })
  it('a measure the code reads otherwise is a doubt', () => {
    const [c] = verifierControles([lot({ laize: 158 })], REPONSE)
    expect(c.doute).toMatch(/laize 155 \(lu 158\)/)
  })
  it('a lot announced for later carries no measure and no doubt', () => {
    const [c] = verifierControles([lot({ lot: '109669', citation: 'Résultats lot 109669 demain', laize: null, poids: null, stabH: null, stabL: null, vrillage: null, plusTard: true })], REPONSE)
    expect(c).toMatchObject({ lot: '109669', laize: null })
    expect(c.doute).toBeUndefined()
  })
  it('the code’s own doubt on a MATEL line wins (« h » twice)', () => {
    const texte = '2) lot 109516 laize = 155 poids = 163 stabs h = -3 h = -2'
    const [c] = verifierControles([lot({ citation: 'lot 109516 laize = 155 poids = 163 stabs h = -3 h = -2', vrillage: null, stabL: -2 })], texte)
    expect(c.doute).toMatch(/deux fois/)
  })
  it('certain false, an unreadable lot, a passage not in the mail: doubts', () => {
    expect(verifierControles([lot({ certain: false, raison: 'Poids illisible.' })], REPONSE)[0].doute).toBe('Poids illisible.')
    expect(verifierControles([lot({ lot: 'MA' })], REPONSE)[0].doute).toMatch(/numéro de lot/)
    expect(verifierControles([lot({ citation: 'lot 109516 laize 999' })], REPONSE)[0].doute).toMatch(/ne retrouve pas/)
  })
  it('« MA109516 » is lot 109516', () => {
    expect(verifierControles([lot({ lot: 'MA109516' })], REPONSE)[0].lot).toBe('109516')
  })
})
