import { describe, it, expect } from 'vitest'
import { grouperRouleaux, libelleArticle, lignesDetail, lireLieu, type LigneBrute, type RouleauBrut } from './expe-pieces.js'

const ligne = (idligne_expedition: number, plus: Partial<LigneBrute> = {}): LigneBrute => ({
  idligne_expedition, ref_label: '1731', colori_reference: 'Noir 54507', ...plus,
})
const rouleau = (id: number, idligne_expedition: number, plus: Partial<RouleauBrut> = {}): RouleauBrut => ({
  id, idligne_expedition, idmagasin: 9, kind: 'fini', numero: String(id), lot: '109825', poids: 20.5, metrage: 100,
  coloris_reference: 'Noir 54507', second_choix: false, ...plus,
})

describe('expe pieces of an avis', () => {
  it('reads the place asked: a magasin id, 0 for the factory, null when none', () => {
    expect(lireLieu(undefined)).toBeNull()
    expect(lireLieu('')).toBeNull()
    expect(lireLieu('abc')).toBeNull()
    expect(lireLieu('-1')).toBeNull()
    expect(lireLieu('0')).toBe(0)
    expect(lireLieu('9')).toBe(9)
  })

  it('files the rolls under their line, in the order of the lines, with the totals', () => {
    const lignes = grouperRouleaux(
      [ligne(1), ligne(2, { ref_label: '138A' })],
      [rouleau(12, 2), rouleau(10, 1), rouleau(11, 1)],
    )
    expect(lignes.map((l) => l.idligne_expedition)).toEqual([1, 2])
    expect(lignes[0].rouleaux.map((r) => r.id)).toEqual([10, 11])
    expect(lignes[0]).toMatchObject({ ref_label: '1731', poids: 41, metrage: 200 })
    expect(lignes[1]).toMatchObject({ ref_label: '138A', poids: 20.5, metrage: 100 })
    // What a roll says on screen, not where it was read from.
    expect(lignes[0].rouleaux[0]).not.toHaveProperty('idmagasin')
    expect(lignes[0].rouleaux[0]).not.toHaveProperty('idligne_expedition')
  })

  it('sorts the rolls by number, as numbers', () => {
    const [l] = grouperRouleaux([ligne(1)], [
      rouleau(3, 1, { numero: '100' }), rouleau(2, 1, { numero: '9' }), rouleau(1, 1, { numero: null }),
    ])
    expect(l.rouleaux.map((r) => r.numero)).toEqual([null, '9', '100'])
  })

  it('leaves out a line without any roll', () => {
    expect(grouperRouleaux([ligne(1), ligne(2)], [rouleau(10, 1)]).map((l) => l.idligne_expedition)).toEqual([1])
    expect(grouperRouleaux([ligne(1)], [])).toEqual([])
  })

  it('keeps only the rolls sitting at the place of the transport', () => {
    const rouleaux = [rouleau(10, 1, { idmagasin: 9 }), rouleau(11, 1, { idmagasin: 0 }), rouleau(12, 2, { idmagasin: 0 })]
    const chezMatel = grouperRouleaux([ligne(1), ligne(2)], rouleaux, 9)
    expect(chezMatel.map((l) => l.rouleaux.map((r) => r.id))).toEqual([[10]])
    const usine = grouperRouleaux([ligne(1), ligne(2)], rouleaux, 0)
    expect(usine.map((l) => l.rouleaux.map((r) => r.id))).toEqual([[11], [12]])
    expect(grouperRouleaux([ligne(1), ligne(2)], rouleaux).flatMap((l) => l.rouleaux)).toHaveLength(3)
  })

  it('splits the free text of a carton into its lines', () => {
    expect(lignesDetail('Carton 1\r\n\r\n 60 x 40 x 40 \n12 kg')).toEqual(['Carton 1', '60 x 40 x 40', '12 kg'])
    expect(lignesDetail(null)).toEqual([])
  })

  it('names an article by the text typed on it, else by the catalogue', () => {
    expect(libelleArticle(' Bord-côte spécial ', 'Bord-côte', 4)).toBe('Bord-côte spécial')
    expect(libelleArticle('', 'Bord-côte', 4)).toBe('Bord-côte')
    expect(libelleArticle(null, null, 4)).toBe('Réf #4')
  })
})
