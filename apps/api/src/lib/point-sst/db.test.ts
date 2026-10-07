import { describe, expect, it } from 'vitest'
import { fusionner, pourquoiDe, reprendreRetraits, type PointLigne } from './db.js'
import type { LignePoint } from './regles.js'

const calc = (cle: string, p: Partial<LignePoint> = {}): LignePoint => ({
  section: 1, cle, idcommande: 9000, idligne: 1, commande: '9000', reference: '029A', coloris: 'marine', datePrevue: '2026-10-12', commentaire: '', pourquoi: 'r', ...p,
})

const stockee = (id: number, cle: string | null, p: Partial<PointLigne> = {}): PointLigne => ({
  id, section: 1, ordre: 0, origine: 'auto', cle, idcommande: 9000, idligne: 1, commande: '9000', reference: '029A', coloris: 'marine',
  datePrevue: '2026-10-12', commentaire: '', pourquoi: 'r', auto: null, modifiee: false, retiree: false, retour: null, modifieLe: null, modifiePar: null, ...p,
})

const AUTO = { commande: '9000', reference: '029A', coloris: 'marine', datePrevue: '2026-10-12', commentaire: '' }

describe('fusionner (« Actualiser »)', () => {
  it('new rule lines are inserted, untouched ones follow the data', () => {
    const r = fusionner([stockee(1, 'a')], [calc('a', { commentaire: 'solde' }), calc('b')])
    expect(r.inserer.map((l) => l.cle)).toEqual(['b'])
    expect(r.mettreAJour).toEqual([{ id: 1, l: expect.objectContaining({ commentaire: 'solde' }) }])
    expect(r.supprimer).toEqual([])
  })

  it('an edited, removed, restored or commented line keeps the person’s version', () => {
    const r = fusionner(
      [
        stockee(1, 'a', { modifiee: true, modifiePar: 'PE' }),
        stockee(2, 'b', { retiree: true, modifiePar: 'PE' }),
        stockee(3, 'c', { retour: { id: 'x', texte: 't', par: null } }),
        stockee(4, 'd', { modifiePar: 'PE' }), // « Rétablir » on a carried removal
      ],
      [calc('a'), calc('b'), calc('c'), calc('d', { reprise: { jour: '2026-10-07', par: 'PE', texte: '' } })],
    )
    expect(r.mettreAJour).toEqual([])
    expect(r.rafraichirAuto.map((x) => x.id)).toEqual([1, 2, 3, 4])
  })

  it('a line removed only by the carry follows the rules: new facts bring it back, a dropped one goes', () => {
    const r = fusionner([stockee(1, 'a', { retiree: true }), stockee(2, 'b', { retiree: true })], [calc('a')])
    expect(r.mettreAJour).toEqual([{ id: 1, l: expect.objectContaining({ cle: 'a' }) }])
    expect(r.supprimer).toEqual([2])
  })

  it('a line the rules dropped goes, unless the person touched it; manual lines are never touched', () => {
    const r = fusionner(
      [stockee(1, 'a'), stockee(2, 'b', { modifiee: true }), stockee(3, null, { origine: 'manuel' })],
      [],
    )
    expect(r.supprimer).toEqual([1])
  })
})

describe('reprendreRetraits (v3 — a removal is carried while the facts stay the same)', () => {
  const hier = (lignes: PointLigne[]) => ({ jour: '2026-10-07', lignes })

  it('a line a person removed yesterday is born removed, with who and why', () => {
    const [l] = reprendreRetraits([calc('reprise:8964', { section: 5 })], hier([
      stockee(1, 'reprise:8964', { section: 5, auto: AUTO, retiree: true, modifiePar: 'Pierre-Emmanuel Roux', retour: { id: 'x', texte: 'on attend la décision du client', par: null } }),
    ]))
    expect(l.reprise).toEqual({ jour: '2026-10-07', par: 'Pierre-Emmanuel Roux', texte: 'on attend la décision du client' })
    expect(pourquoiDe(l)).toContain('Retirée le 07/10 par Pierre-Emmanuel Roux : « on attend la décision du client »')
  })

  it('new facts (another lot, a moved date) bring the line back', () => {
    const p = hier([stockee(1, 'a', { auto: AUTO, retiree: true, modifiePar: 'PE' })])
    expect(reprendreRetraits([calc('a', { datePrevue: '2026-10-13' })], p)[0].reprise).toBeUndefined()
    expect(reprendreRetraits([calc('a', { commentaire: '109400' })], p)[0].reprise).toBeUndefined()
  })

  it('a carried removal carries on, keeping the original day and reason', () => {
    const avant = { jour: '2026-10-07', par: 'PE', texte: 'pourquoi' }
    const [l] = reprendreRetraits([calc('a')], { jour: '2026-10-08', lignes: [stockee(1, 'a', { auto: { ...AUTO, reprise: avant } as never, retiree: true })] })
    expect(l.reprise).toEqual(avant)
  })

  it('a line kept, restored or never there yesterday is not removed', () => {
    const p = hier([
      stockee(1, 'a', { auto: AUTO }),
      stockee(2, 'b', { auto: { ...AUTO, reprise: { jour: '2026-10-06', par: 'PE', texte: '' } } as never, modifiePar: 'PE' }),
    ])
    expect(reprendreRetraits([calc('a'), calc('b'), calc('c')], p).map((l) => l.reprise)).toEqual([undefined, undefined, undefined])
  })
})
