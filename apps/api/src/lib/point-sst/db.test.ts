import { describe, expect, it } from 'vitest'
import { fusionner, type PointLigne } from './db.js'
import type { LignePoint } from './regles.js'

const calc = (cle: string, p: Partial<LignePoint> = {}): LignePoint => ({
  section: 1, cle, idcommande: 9000, idligne: 1, commande: '9000', reference: '029A', coloris: 'marine', datePrevue: '2026-10-12', commentaire: '', pourquoi: 'r', ...p,
})

const stockee = (id: number, cle: string | null, p: Partial<PointLigne> = {}): PointLigne => ({
  id, section: 1, ordre: 0, origine: 'auto', cle, idcommande: 9000, idligne: 1, commande: '9000', reference: '029A', coloris: 'marine',
  datePrevue: '2026-10-12', commentaire: '', pourquoi: 'r', auto: null, modifiee: false, retiree: false, retour: null, modifieLe: null, modifiePar: null, ...p,
})

describe('fusionner (« Actualiser »)', () => {
  it('new rule lines are inserted, untouched ones follow the data', () => {
    const r = fusionner([stockee(1, 'a')], [calc('a', { commentaire: 'solde' }), calc('b')])
    expect(r.inserer.map((l) => l.cle)).toEqual(['b'])
    expect(r.mettreAJour).toEqual([{ id: 1, l: expect.objectContaining({ commentaire: 'solde' }) }])
    expect(r.supprimer).toEqual([])
  })

  it('an edited, removed or commented line keeps the person’s version', () => {
    const r = fusionner(
      [stockee(1, 'a', { modifiee: true }), stockee(2, 'b', { retiree: true }), stockee(3, 'c', { retour: { id: 'x', texte: 't', par: null } })],
      [calc('a'), calc('b'), calc('c')],
    )
    expect(r.mettreAJour).toEqual([])
    expect(r.rafraichirAuto.map((x) => x.id)).toEqual([1, 2, 3])
  })

  it('a line the rules dropped goes, unless the person touched it; manual lines are never touched', () => {
    const r = fusionner(
      [stockee(1, 'a'), stockee(2, 'b', { modifiee: true }), stockee(3, null, { origine: 'manuel' })],
      [],
    )
    expect(r.supprimer).toEqual([1])
  })
})
