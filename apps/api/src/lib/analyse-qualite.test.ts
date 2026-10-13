import { describe, expect, it } from 'vitest'
import { analyserLot, type LotBrut } from './analyse-qualite.js'

// Lot MA107648 (dev, 2026-02): 160 cm / 107 g/m² measured by the dyer.
function lot(over: Partial<LotBrut> = {}): LotBrut {
  return {
    idsuivilot: 1, date: '20260210', lot: 'MA107648', reference: 'REF', coloris: 'NOIR',
    idsous_traitant: 3, sous_traitant: 'MATEL', idcommande_sous_traitant: 9,
    laize_demandee: 162, poids_demande: 110, rendement_demande: 4.88216,
    stabh_demandee: -5, stabl_demandee: -5,
    laize_sst: 160, poids_sst: 107, rendement_sst: 4.953, stabh_sst: -4, stabl_sst: -6,
    laize_tirelle: 161, poids_tirelle: 0, stabh_tirelle: 0, stabl_tirelle: -3,
    rendement_pieces: 4.95,
    fiche_laize_min: 158, fiche_laize_max: 166, fiche_poids_min: 104, fiche_poids_max: 116,
    fiche_stab_hauteur: -5, fiche_stab_largeur: -5, fiche_freinte: 0.14, fiche_rendement: 4.88,
    ...over,
  }
}

describe('analyserLot', () => {
  it('gives each control its écart to the référentiel, in the measure unit', () => {
    const a = analyserLot(lot())
    expect(a.mesures.laize).toMatchObject({ ref: 162, sst: 160, interne: 161, ecart_sst: -2, ecart_interne: -1 })
    expect(a.mesures.poids).toMatchObject({ ref: 110, sst: 107, ecart_sst: -3, interne: null, ecart_interne: null })
  })

  it('flags a value outside the fiche tolerance', () => {
    const a = analyserLot(lot({ laize_sst: 157, poids_sst: 117 }))
    expect(a.mesures.laize.hors_sst).toBe(true)
    expect(a.mesures.laize.hors_interne).toBe(false)
    expect(a.mesures.poids.hors_sst).toBe(true)
  })

  it('treats a retrait below the référentiel as out (shrinkage is negative)', () => {
    const a = analyserLot(lot())
    expect(a.mesures.stabh).toMatchObject({ ref: -5, sst: -4, ecart_sst: 1, hors_sst: false })
    expect(a.mesures.stabl).toMatchObject({ sst: -6, ecart_sst: -1, hors_sst: true })
  })

  it('reads a 0 retrait as measured only when the control was done', () => {
    const a = analyserLot(lot())
    // Tirelle laize filled → its 0 retrait H is a real 0.
    expect(a.mesures.stabh.interne).toBe(0)
    const b = analyserLot(lot({ laize_tirelle: 0, poids_tirelle: 0 }))
    expect(b.mesures.stabh.interne).toBeNull()
    expect(b.mesures.stabl.interne).toBeNull()
  })

  it('takes the fiche retraits when the lot has none (lots of 2026-05 → 09)', () => {
    const a = analyserLot(lot({ stabh_demandee: 0, stabl_demandee: 0, fiche_stab_hauteur: -4, fiche_stab_largeur: -6 }))
    expect(a.ref_retraits_fiche).toBe(true)
    expect(a.mesures.stabh.ref).toBe(-4)
    expect(a.mesures.stabl.ref).toBe(-6)
  })

  it('recomputes the SST rendement from the pieces when it was not stored', () => {
    const a = analyserLot(lot({ rendement_sst: 0, rendement_pieces: 4.9512 }))
    expect(a.rendement_sst_calcule).toBe(true)
    expect(a.mesures.rendement.sst).toBe(4.951)
    expect(a.mesures.rendement.ecart_sst).toBe(0.069)
    const b = analyserLot(lot({ rendement_sst: 0, rendement_pieces: null }))
    expect(b.mesures.rendement.sst).toBeNull()
  })

  it('has no tolerance verdict when the fiche has no bounds', () => {
    const a = analyserLot(lot({ fiche_laize_min: 0, fiche_laize_max: 0 }))
    expect(a.mesures.laize.hors_sst).toBeNull()
  })
})
