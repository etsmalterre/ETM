import { describe, expect, it } from 'vitest'
import { ficheTechniqueEcruData, type RefEcruDetailForFiche } from './FicheTechniqueEcruPdf.js'

function detail(over: Partial<RefEcruDetailForFiche> = {}): RefEcruDetailForFiche {
  return {
    reference: ' 472 ', designation: 'Jersey coton', contexture_nom: 'Jersey', Jauge: 3, diametre: 2,
    bio: 1, recycle: 0, client_nom: null, reference_client: ' ',
    laize_tbm: 180, poids_m2_tbm: 145.5, rendement: 3.2, poids: 20, vitesse_cible: 0, ecarteur: null,
    tombe_metier: '-1', maille_ouverture: 1, ouvert_visiteuse: 0, sonneter: 1,
    lfa_tour_1: '28', lfa_tour_2: null, lfa_tour_3: '', lfa_tour_4: '30',
    poulies_1: '40', poulies_2: '41', poulies_3: null, poulies_4: null,
    commentaire: '  ', observations: 'Surveiller la laize', date_maj_ft: '20260915',
    composition_lines: [
      { IDcomposition_ecru: 10, ref_fil_reference: 'CO 30/1', pourcentage: 95, commentaire: null },
      { IDcomposition_ecru: 11, ref_fil_reference: 'EA 22', pourcentage: 5, commentaire: 'plaqué' },
    ],
    coloris: [
      { reference: 'Écru', composition: [] },
      { reference: 'Noir', composition: [{ ref_fil_reference: 'CO 30/1', colori_fil_reference: 'NOIR', pourcentage: 100 }] },
    ],
    machines: [{
      machine_nom: '1G', IDmachine: 4, repere_1: '12', repere_2: null, repere_3: null, repere_4: null, repere_5: null,
      hauteur_pl: '3', abattage: 'B', trs_10kg_chute: 410, nb_chutes: 72, compteur_saisie: 60,
    }],
    chutes: [
      { IDchute_liage: 2, num_chute: 2, IDcomposition_ecru1: 11, IDcomposition_ecru2: 0, lfa1: 0, lfa2: null },
      { IDchute_liage: 1, num_chute: 1, IDcomposition_ecru1: 10, IDcomposition_ecru2: 11, lfa1: 28.5, lfa2: 12 },
    ],
    cells: [
      { IDchute_liage: 1, num_symbole: 1, IDsymbole_liage: 1 },
      { IDchute_liage: 1, num_symbole: 3, IDsymbole_liage: 2 },
      { IDchute_liage: 2, num_symbole: 2, IDsymbole_liage: 99 },
    ],
    symboles: [{ IDsymbole_liage: 1, icone: 'front_stitch.png' }, { IDsymbole_liage: 2, icone: 'back_tuck.png' }],
    ...over,
  }
}

describe('ficheTechniqueEcruData', () => {
  it('maps the ordinals, blanks and dates the way the screen shows them', () => {
    const d = ficheTechniqueEcruData(detail())
    expect(d.reference).toBe('472')
    expect(d.jauge).toBe('18')
    expect(d.diametre).toBe('26"')
    expect(d.referenceClient).toBeNull()
    expect(d.tombeMetier).toBeNull()
    expect(d.vitesseCible).toBeNull()
    expect(d.commentaire).toBeNull()
    expect(d.dateMaj).toBe('15/09/2026')
    expect(d.lfaTour).toEqual(['28', '', '', '30'])
    expect(d.mailleOuverture && d.sonneter && !d.ouvertLarge).toBe(true)
  })

  it('orders the chutes, names their yarns and places each symbol in its column', () => {
    const { liage } = ficheTechniqueEcruData(detail())
    expect(liage.numCols).toBe(3)
    expect(liage.chutes.map((c) => c.num)).toEqual([1, 2])
    expect(liage.chutes[0]).toMatchObject({ fil1: 'CO 30/1', lfa1: 28.5, fil2: 'EA 22', lfa2: 12 })
    expect(liage.chutes[0].symboles).toEqual(['front_stitch.png', null, 'back_tuck.png'])
    // An unknown symbol id prints nothing; no second yarn = null; LFA 0 = none.
    expect(liage.chutes[1]).toMatchObject({ fil1: 'EA 22', lfa1: null, fil2: null })
    expect(liage.chutes[1].symboles).toEqual([null, null, null])
  })

  it('prints a coloris recipe only when it has its own', () => {
    const { coloris } = ficheTechniqueEcruData(detail())
    expect(coloris).toEqual([
      { reference: 'Écru', composition: null },
      { reference: 'Noir', composition: '100 % CO 30/1 NOIR' },
    ])
  })
})
