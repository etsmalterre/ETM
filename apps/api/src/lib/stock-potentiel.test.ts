import { describe, expect, it } from 'vitest'
import {
  calculerStockPotentiel,
  kgTricotable,
  recetteColoris,
  type CompositionRow,
  type StockPotentielInput,
} from './stock-potentiel.js'

const compo = (c: Partial<CompositionRow>): CompositionRow => ({
  idref_ecru: 29, idcolori_ecru: 1, idref_fil: 10, idcolori_fil: 100, pourcentage: 100, ...c,
})

function input(over: Partial<StockPotentielInput> = {}): StockPotentielInput {
  return {
    refsFini: [
      { idref_fini: 1, reference: '029A', designation: 'jersey teint', idref_ecru: 29, rendement: 3, avec_teinture: 1, grammage: 160, contexture: 'jersey', bio: false, recycle: false },
      { idref_fini: 2, reference: '029L', designation: 'jersey lavé', idref_ecru: 29, rendement: 2, avec_teinture: 0, grammage: null, contexture: null, bio: false, recycle: false },
    ],
    refsEcru: new Map([[29, '029']]),
    colorisEcru: [
      { idcolori_ecru: 1, idref_ecru: 29, reference: 'ecru' },
      { idcolori_ecru: 2, idref_ecru: 29, reference: 'gris8985' },
    ],
    colorisFini: new Map([[50, 'marine']]),
    finisLibres: [],
    ecruLibre: [],
    compositions: [],
    filLibre: new Map(),
    filLabel: new Map(),
    ...over,
  }
}

describe('kgTricotable', () => {
  it('is limited by the yarn that runs out first, positions of one yarn summed', () => {
    const r = kgTricotable(
      [compo({ idref_fil: 10, pourcentage: 45 }), compo({ idref_fil: 10, pourcentage: 45 }), compo({ idref_fil: 11, idcolori_fil: 101, pourcentage: 10 })],
      new Map([['10:100', 900], ['11:101', 50]]),
    )
    // coton 900 / 0.9 = 1000 kg, élasthanne 50 / 0.1 = 500 kg → 500
    expect(r).toEqual({ kg: 500, limite: '11:101' })
  })

  it('a missing yarn knits nothing', () => {
    expect(kgTricotable([compo({})], new Map())?.kg).toBe(0)
  })

  it('no recipe → null', () => {
    expect(kgTricotable([], new Map())).toBeNull()
  })
})

describe('recetteColoris', () => {
  it('prefers the coloris recipe (#1205)', () => {
    const rows = [compo({ idcolori_ecru: 0, idref_fil: 99, idcolori_fil: 0 }), compo({ idcolori_ecru: 1 })]
    expect(recetteColoris(rows, 29, 1)).toEqual([rows[1]])
  })

  it('falls back to the reference recipe only when it names yarn colours', () => {
    expect(recetteColoris([compo({ idcolori_ecru: 0, idcolori_fil: 0 })], 29, 1)).toEqual([])
    const coloured = compo({ idcolori_ecru: 0, idcolori_fil: 100 })
    expect(recetteColoris([coloured], 29, 1)).toEqual([coloured])
  })
})

describe('calculerStockPotentiel', () => {
  it('groups free fini rolls per reference and coloris, coloris catalog by avec_teinture', () => {
    const lignes = calculerStockPotentiel(input({
      finisLibres: [
        { idref_fini: 1, idcoloris: 50, poids: 20, metrage: 60, etat: 3, second_choix: false },
        { idref_fini: 1, idcoloris: 50, poids: 10, metrage: 30, etat: 3, second_choix: false },
        { idref_fini: 2, idcoloris: 2, poids: 5, metrage: 10, etat: 3, second_choix: false },
      ],
    }))
    expect(lignes).toEqual(expect.arrayContaining([
      expect.objectContaining({ statut: 'dispo', reference: '029A', coloris: 'marine', poids: 30, metrage: 90, pieces: 2 }),
      expect.objectContaining({ statut: 'dispo', reference: '029L', coloris: 'gris8985', poids: 5, metrage: 10, pieces: 1 }),
    ]))
  })

  it('only validé rolls are Dispo; the others are À valider per état; 2nd choice is its own line', () => {
    const lignes = calculerStockPotentiel(input({
      finisLibres: [
        { idref_fini: 1, idcoloris: 50, poids: 20, metrage: 60, etat: 3, second_choix: false },
        { idref_fini: 1, idcoloris: 50, poids: 10, metrage: 30, etat: 3, second_choix: true },
        { idref_fini: 1, idcoloris: 50, poids: 10, metrage: 30, etat: 1, second_choix: false },
        { idref_fini: 1, idcoloris: 50, poids: 10, metrage: 30, etat: 2, second_choix: false },
      ],
    }))
    expect(lignes).toHaveLength(3)
    expect(lignes).toEqual(expect.arrayContaining([
      expect.objectContaining({ statut: 'dispo', second_choix: false, pieces: 1, idcoloris: 50 }),
      expect.objectContaining({ statut: 'dispo', second_choix: true, pieces: 1 }),
      expect.objectContaining({ statut: 'a_valider', pieces: 2, repartition: { 'en contrôle': 1, 'en reprise': 1 } }),
    ]))
  })

  it('counts the 2nd-choice écru pieces of an À ennoblir line', () => {
    const [l] = calculerStockPotentiel(input({
      refsFini: [{ idref_fini: 1, reference: '029A', designation: null, idref_ecru: 29, rendement: 3, avec_teinture: 1, grammage: null, contexture: null, bio: false, recycle: false }],
      ecruLibre: [
        { idref_ecru: 29, idcolori_ecru: 1, poids: 20, second_choix: true },
        { idref_ecru: 29, idcolori_ecru: 1, poids: 20, second_choix: false },
      ],
    }))
    expect(l).toEqual(expect.objectContaining({ statut: 'a_ennoblir', pieces: 2, repartition: { '2e choix': 1 }, idcoloris: null }))
  })

  it('a dyed fini takes only the natural écru, any coloris; a wash-only one each écru coloris', () => {
    const lignes = calculerStockPotentiel(input({
      ecruLibre: [
        { idref_ecru: 29, idcolori_ecru: 1, poids: 100, second_choix: false },
        { idref_ecru: 29, idcolori_ecru: 2, poids: 40, second_choix: false },
      ],
    })).filter((l) => l.statut === 'a_ennoblir')
    expect(lignes).toHaveLength(3)
    expect(lignes).toEqual(expect.arrayContaining([
      expect.objectContaining({ reference: '029A', tous_coloris: true, poids: 100, metrage: 300, pieces: 1, ecru: '029 · ecru' }),
      expect.objectContaining({ reference: '029L', coloris: 'ecru', poids: 100, metrage: 200 }),
      expect.objectContaining({ reference: '029L', coloris: 'gris8985', poids: 40, metrage: 80 }),
    ]))
  })

  it('the same écru shows on every fini it can become — lines are « jusqu’à », not additive', () => {
    const lignes = calculerStockPotentiel(input({ ecruLibre: [{ idref_ecru: 29, idcolori_ecru: 1, poids: 100, second_choix: false }] }))
    expect(lignes.filter((l) => l.statut === 'a_ennoblir').map((l) => l.reference).sort()).toEqual(['029A', '029L'])
  })

  it('knits from free yarn and names the limiting yarn', () => {
    const lignes = calculerStockPotentiel(input({
      compositions: [compo({ idcolori_ecru: 1, pourcentage: 100 })],
      filLibre: new Map([['10:100', 250]]),
      filLabel: new Map([['10:100', 'coton 30/1 ecru']]),
    })).filter((l) => l.statut === 'a_tricoter')
    expect(lignes).toEqual(expect.arrayContaining([
      expect.objectContaining({ reference: '029A', tous_coloris: true, poids: 250, metrage: 750, limite: 'coton 30/1 ecru', pieces: null }),
      expect.objectContaining({ reference: '029L', coloris: 'ecru', poids: 250, metrage: 500 }),
    ]))
  })

  it('no rendement → kg only; nothing below 0.1 kg', () => {
    const lignes = calculerStockPotentiel(input({
      refsFini: [{ idref_fini: 1, reference: '029A', designation: null, idref_ecru: 29, rendement: 0, avec_teinture: 1, grammage: null, contexture: null, bio: false, recycle: false }],
      ecruLibre: [{ idref_ecru: 29, idcolori_ecru: 1, poids: 12, second_choix: false }],
      compositions: [compo({})],
      filLibre: new Map([['10:100', 0.04]]),
    }))
    expect(lignes).toEqual([expect.objectContaining({ statut: 'a_ennoblir', poids: 12, metrage: null })])
  })
})
