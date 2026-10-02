import { describe, expect, it } from 'vitest'
import { ECRU_EN_STOCK, ECRU_EN_TRAITEMENT, etatEcruChezSst } from './ecru-etat-sst.js'

describe('etatEcruChezSst', () => {
  it('open line of an order at this sst = en traitement, with the order number', () => {
    expect(etatEcruChezSst(6, { IDcommande_sous_traitant: 8973, sstatut: 'En_Cours' }, 6))
      .toEqual({ etat_libelle: ECRU_EN_TRAITEMENT, commande_sst: 8973 })
  })

  it('no line = en stock', () => {
    expect(etatEcruChezSst(6, undefined, undefined)).toEqual({ etat_libelle: ECRU_EN_STOCK, commande_sst: null })
  })

  it('finished line = en stock (mangled accent too)', () => {
    expect(etatEcruChezSst(6, { IDcommande_sous_traitant: 1, sstatut: 'Terminé' }, 6).etat_libelle).toBe(ECRU_EN_STOCK)
    expect(etatEcruChezSst(6, { IDcommande_sous_traitant: 1, sstatut: 'Termin�' }, 6).etat_libelle).toBe(ECRU_EN_STOCK)
  })

  it('order placed with another sous-traitant = en stock', () => {
    expect(etatEcruChezSst(6, { IDcommande_sous_traitant: 1, sstatut: 'En_Cours' }, 9).etat_libelle).toBe(ECRU_EN_STOCK)
  })
})
