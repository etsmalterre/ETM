import { describe, expect, it } from 'vitest'
import { estReponsePoint, jourDuPoint, lireControles, lireDelai, mercrediSemaineIso, repondreDelais, sections } from './reponse-point.js'

// MATEL's reply to the Point of 02/11/2026 (contact@, signature shortened).
const REPONSE_0211 = `Bonjour,

2)lot 109516     laize = 155cm     poids = 163g/m²     stabs     h = -3     l = -3     V = 4%
Résultats lot 109669 demain

3) On peut soumettre le lot 109627 ardoise 412 cde 9108
cde 9087 finie
Cde 9086 fin de semaine
Cdes 9074-9081 demain ou mercredi

4) ce jour ou demain

5) s 49

Cordialement.
Perrine LEONARD
Matel Couleurs Textiles`

const q = (commande: string) => ({ commande, idcommande: +commande, idligne: +commande - 10, article: '049A - noir' })

describe('a reply to the Point', () => {
  it('recognises the subject and the Point’s day', () => {
    expect(estReponsePoint('RE: Point du 05/11')).toBe(true)
    expect(estReponsePoint('RE: RE: point du 02/11/26')).toBe(true)
    expect(estReponsePoint('Point du 05/11')).toBe(false)
    expect(estReponsePoint('BL métrages 109235 Qualité 029a')).toBe(false)
    expect(jourDuPoint('RE: Point du 05/11', '2026-11-05T13:16:31Z')).toBe('2026-11-05')
    expect(jourDuPoint('RE: Point du 30/12', '2027-01-02T09:00:00Z')).toBe('2026-12-30')
  })

  it('splits the answer by section and cuts the signature', () => {
    const s = sections(REPONSE_0211)
    expect([...s.keys()]).toEqual([2, 3, 4, 5])
    expect(s.get(5)).toEqual(['s 49'])
    expect(s.get(2)).toHaveLength(2)
  })
})

describe('reading a délai', () => {
  it('« s N » is the Wednesday of ISO week N (PE: s 47 of 23/10 → 18/11)', () => {
    expect(mercrediSemaineIso(2026, 47)).toBe('2026-11-18')
    expect(lireDelai('s 47', '2026-10-23T10:59:46Z')).toBe('2026-11-18')
    expect(lireDelai('S49', '2026-11-02T13:16:09Z')).toBe('2026-12-02')
    expect(lireDelai('semaine 49', '2026-11-02')).toBe('2026-12-02')
  })

  it('a week of early next year answered in December is next year’s', () => {
    expect(lireDelai('s 2', '2026-12-10')).toBe(mercrediSemaineIso(2027, 2))
  })

  it('reads a plain date, and nothing else', () => {
    expect(lireDelai('02/12', '2026-11-05')).toBe('2026-12-02')
    expect(lireDelai('15/01', '2026-12-10')).toBe('2027-01-15')
    for (const t of ['lundi ou mardi', 'fin de semaine', 'début de semaine prochaine car c’est la même machine', 'fini']) {
      expect(lireDelai(t, '2026-11-05')).toBeNull()
    }
  })
})

describe('§5: which answer is for which order', () => {
  it('a bare answer is for every order the Point asked (02/11: 5 orders, « s 49 »)', () => {
    const r = repondreDelais(['9132', '9131', '9130', '9129', '9128'].map(q), ['s 49'], '2026-11-02')
    expect(r.map((x) => x.delai)).toEqual(Array(5).fill('2026-12-02'))
  })

  it('a line naming orders answers those, the bare line the others', () => {
    const r = repondreDelais([q('9086'), q('9087'), q('9090')], ['cde 9086 s 50', 'Cdes 9087-9090 s 49'], '2026-11-02')
    expect(r.map((x) => x.delai)).toEqual(['2026-12-09', '2026-12-02', '2026-12-02'])
  })

  it('« Le reste s 44 » answers every order not named (01/10)', () => {
    const r = repondreDelais([q('9067'), q('9070')], ['cdes 9067-9068  s42', 'Le reste s 44'], '2026-10-01')
    expect(r.map((x) => x.delai)).toEqual(['2026-10-14', '2026-10-28'])
  })

  it('an answer the code cannot read keeps its text and no délai', () => {
    const [r] = repondreDelais([q('9121')], ['lundi ou mardi'], '2026-10-30')
    expect(r).toMatchObject({ texte: 'lundi ou mardi', delai: null })
  })

  it('no answer for an order = empty text', () => {
    const [r] = repondreDelais([q('9121')], ['cde 9122 s 49'], '2026-10-30')
    expect(r.texte).toBe('')
  })
})

describe('§2: the dyer’s controls', () => {
  it('reads laize, poids, stabilités and vrillage per lot', () => {
    const c = lireControles(sections(REPONSE_0211).get(2)!)
    expect(c[0]).toMatchObject({ lot: '109516', laize: 155, poids: 163, stabH: -3, stabL: -3, vrillage: 4 })
    // « Résultats lot 109669 demain »: the lot, no measure yet.
    expect(c[1]).toMatchObject({ lot: '109669', laize: null, poids: null, vrillage: null })
  })

  it('a stabilité letter written twice (15/10: « stabs l = -6 l = -5 ») is a doubt, never a 0', () => {
    const [c] = lireControles(['lot 109271     laize = 173cm     poids = 248g/m²     stabs     l = -6     l = -5'])
    expect(c.doute).toMatch(/deux fois/)
    const [d] = lireControles(['lot 109271 laize = 173cm poids = 248g/m² stabs l = -5'])
    expect(d.doute).toMatch(/hauteur/)
    const [e] = lireControles(['lot 109516 laize = 155cm poids = 163g/m² stabs h = -3 l = -3 V = 4%'])
    expect(e.doute).toBeUndefined()
  })

  it('« laize utile », no vrillage, a zero stabilité', () => {
    const [c] = lireControles(['lot 109555     laize utile = 163cm     poids = 418g/m²     stabs     h = -3     l = 0'])
    expect(c).toMatchObject({ laize: 163, poids: 418, stabH: -3, stabL: 0, vrillage: null })
  })
})
