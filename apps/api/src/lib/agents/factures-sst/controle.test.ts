import { describe, expect, it } from 'vitest'
import { controlerLecture, estFactureCandidate, fournisseurDe, normaliserFacture, reconnaitreFacture, type FactureLue } from './extraction.js'
import { verifierFacture, resumerVerification, type LotEtm } from './controle.js'

const MATEL = fournisseurDe('matel')!
const BONTEMPS = fournisseurDe('bontemps')!

// Part of MATEL invoice FA2865 (2026-05-15), as read by OCR + model, and what
// ETM computed for each lot on 2026-10-02 (dev copy). Lot 108406 is the one
// Pierre-Emmanuel disputed: billed 5,64 for 5,00 (0,61 + 4,39), 133,76 €
// credited by MATEL on the next invoice.
const fa2865 = normaliserFacture({
  fournisseur: 'SAS MATEL COULEURS TEXTILES',
  type_document: 'facture',
  numero_facture: 'FA2865',
  date_facture: '15/05/2026',
  date_echeance: '29/06/2026',
  total_ht: 5683.96,
  total_ttc: 6820.75,
  lignes: [
    { description: '62906 MARINE LTP 61507/2', traitements: 'ST + OR', qualite: '180', quantite: 291.12, unite: 'Kg', lot: '108258', numero_commande: '8614', pieces: 16, prix_unitaire: 6.36, montant: 1851.52, genre: 'lot' },
    { description: '62906 MARINE LTP 61507/2', traitements: 'ST + CAL', qualite: '180 CAL', quantite: 24, unite: 'Kg', lot: '108258', numero_commande: '8614', pieces: 1, prix_unitaire: 6.92, montant: 166.08, genre: 'lot' },
    { description: '63137 MARINE 0612', traitements: 'PREF&ST&OR', qualite: '029A', quantite: 355.9, unite: 'Kg', lot: '108408', numero_commande: '8645', pieces: 18, prix_unitaire: 5.54, montant: 1971.69, genre: 'lot' },
    { description: '72498 MINT GREEN 0410', traitements: 'PREF&ST&OR', qualite: '029A', quantite: 101.1, unite: 'Kg', lot: '108457', numero_commande: '8685', pieces: 5, prix_unitaire: 8.38, montant: 847.22, genre: 'lot' },
    { description: '19998 DEBOUILLI ECRU', traitements: 'PREF+ST+OR', qualite: '284B', quantite: 209, unite: 'Kg', lot: '108406', numero_commande: '8661', pieces: 10, prix_unitaire: 5.64, montant: 1178.76, genre: 'lot' },
    { description: 'TUBES ET EMBALLAGES', traitements: '', qualite: '', quantite: 50, unite: '', lot: '', numero_commande: '', pieces: null, prix_unitaire: 3.82, montant: 191, genre: 'emballage' },
    { description: 'EXAPAQ 0-4', traitements: '', qualite: '', quantite: 9, unite: '', lot: '', numero_commande: '', pieces: null, prix_unitaire: 9.33, montant: 83.97, genre: 'transport' },
    { description: 'REMISE LOT 108406', traitements: '', qualite: '', quantite: 1, unite: '', lot: '', numero_commande: '', pieces: null, prix_unitaire: 606.28, montant: -606.28, genre: 'autre' },
  ],
})

const lot = (o: Partial<LotEtm> & Pick<LotEtm, 'lot' | 'idcommande'>): LotEtm => ({
  idsuivilot: 1, idligne: 1, idSousTraitant: 9, poids: null, pieces: null, prixAttendu: null, explicationPrix: '', tarifIncomplet: null, autresFactures: [], ...o,
})

const lotsEtm = new Map<string, LotEtm | null>([
  ['MA108258', lot({ lot: 'MA108258', idcommande: 8614, poids: 315.12, pieces: 17, prixAttendu: 7.54 })],
  ['MA108408', lot({ lot: 'MA108408', idcommande: 8645, poids: 355.9, pieces: 18, prixAttendu: 5.54 })],
  ['MA108457', lot({ lot: 'MA108457', idcommande: 8685, poids: 101.1, pieces: 5, prixAttendu: 8.37 })],
  ['MA108406', lot({ lot: 'MA108406', idcommande: 8661, poids: 209, pieces: 10, prixAttendu: 5.0, explicationPrix: 'PREF 0,61 + Débouilli 4,39' })],
])

describe('normaliserFacture', () => {
  it('turns dates to ISO, numbers to numbers, and a negative line into a remise', () => {
    expect(fa2865.date_facture).toBe('2026-05-15')
    expect(fa2865.numero_facture).toBe('FA2865')
    expect(fa2865.lignes.at(-1)!.genre).toBe('remise')
    const f = normaliserFacture({ numero_facture: ' fa 2974 ', total_ht: '22 203,41', lignes: [{ description: 'X', quantite: '1 234,5', montant: '10,00', genre: 'lot', lot: ' 108 406 ' }] })
    expect(f.numero_facture).toBe('FA2974')
    expect(f.total_ht).toBe(22203.41)
    expect(f.lignes[0].quantite).toBe(1234.5)
    expect(f.lignes[0].lot).toBe('108406')
  })

  it('drops a sub-total row with neither designation nor amount', () => {
    const f = normaliserFacture({ lignes: [{ description: '', quantite: 3605.18, montant: null, genre: 'autre' }] })
    expect(f.lignes).toHaveLength(0)
  })
})

describe('controlerLecture', () => {
  it('passes a reading whose lines add up', () => {
    expect(controlerLecture(fa2865)).toEqual([])
  })

  it('blocks when a line was misread or the total does not add up', () => {
    const mal: FactureLue = { ...fa2865, lignes: fa2865.lignes.map((l, i) => (i === 2 ? { ...l, montant: 1917.69 } : l)) }
    const cs = controlerLecture(mal)
    expect(cs.map((c) => c.code)).toEqual(['ligne_calcul', 'total'])
    expect(cs.every((c) => c.gravite === 'bloquant')).toBe(true)
  })
})

describe('verifierFacture — FA2865', () => {
  const v = verifierFacture(fa2865, MATEL, lotsEtm, controlerLecture(fa2865))

  it('finds the lot Pierre-Emmanuel disputed, and only that one', () => {
    const ecarts = v.lignes.filter((l) => l.verdict === 'ecart')
    expect(ecarts.map((l) => l.lotEtm)).toEqual(['MA108406'])
    expect(ecarts[0].ecartMontant).toBe(133.76) // what MATEL credited
    expect(ecarts[0].controles.find((c) => c.code === 'prix')!.message).toContain('PREF 0,61 + Débouilli 4,39')
    expect(v.statut).toBe('ecarts')
    expect(v.ecartMontant).toBe(133.76)
  })

  it('lets a one-centime rounding through', () => {
    expect(v.lignes[3].verdict).toBe('conforme') // 8,38 billed, 8,37 expected
  })

  it('records a price below the tariff without raising a gap, and sums a lot split on two lines', () => {
    const l108258 = v.lignes.filter((l) => l.lotEtm === 'MA108258')
    // Billed below the tariff costs us nothing: conforme, with a mention.
    expect(l108258.map((l) => l.verdict)).toEqual(['conforme', 'conforme'])
    expect(l108258[0].controles.some((c) => c.code === 'prix_inferieur')).toBe(true)
    expect(l108258[0].controles.some((c) => c.code === 'poids')).toBe(false) // 291,12 + 24 = 315,12
  })

  it('never makes a gap of packaging, transport or a remise', () => {
    expect(v.lignes.slice(5).map((l) => l.verdict)).toEqual(['info', 'info', 'info'])
    expect(v.lignes[7].controles[0].code).toBe('remise')
    expect(v.lignes[5].controles).toEqual([]) // 50 packagings for 16 + 1 + 18 + 5 + 10 pieces
    const autre = verifierFacture({ ...fa2865, lignes: fa2865.lignes.map((l, i) => (i === 5 ? { ...l, quantite: 52 } : l)) }, MATEL, lotsEtm, [])
    expect(autre.lignes[5].controles[0].code).toBe('emballage')
    expect(autre.lignes[5].verdict).toBe('info')
  })

  it('summarises', () => {
    expect(resumerVerification(v)).toBe('4 lots · 1 écart (133,76 €)')
  })
})

describe('verifierFacture — weight, unknown lot, double billing', () => {
  const une = (l: Partial<FactureLue['lignes'][number]>) =>
    normaliserFacture({ numero_facture: 'FA1', total_ht: 0, lignes: [{ description: 'X', traitements: '', qualite: '', quantite: 371.1, unite: 'Kg', lot: '108409', numero_commande: '8645', pieces: 19, prix_unitaire: 5.54, montant: 2055.89, genre: 'lot', ...l }] })

  it('counts the pieces still at the dyer in the weight (108409: 351,4 received + 19,7)', () => {
    const v = verifierFacture(une({}), MATEL, new Map([['MA108409', lot({ lot: 'MA108409', idcommande: 8645, poids: 371.1, pieces: 19, prixAttendu: 5.54 })]]), [])
    expect(v.lignes[0].verdict).toBe('conforme')
  })

  it('raises a gap on weight billed above ETM’s when ETM has every piece', () => {
    const v = verifierFacture(une({}), MATEL, new Map([['MA108409', lot({ lot: 'MA108409', idcommande: 8645, poids: 351.4, pieces: 19, prixAttendu: 5.54 })]]), [])
    expect(v.lignes[0].verdict).toBe('ecart')
    expect(v.lignes[0].ecartMontant).toBe(109.14) // 19,7 kg × 5,54
    expect(v.lignes[0].controles.map((c) => c.code)).toEqual(['poids'])
  })

  it('does not judge the weight while pieces of the lot are missing in ETM (MA109269: 1 of 21)', () => {
    const v = verifierFacture(une({}), MATEL, new Map([['MA108409', lot({ lot: 'MA108409', idcommande: 8645, poids: 351.4, pieces: 18, prixAttendu: 5.54 })]]), [])
    expect([v.lignes[0].verdict, v.lignes[0].nature]).toEqual(['ecart', 'non_verifie'])
    expect(v.lignes[0].controles.map((c) => c.code)).toEqual(['poids_incomplet'])
  })

  it('a lot ETM does not know is not rattaché, and makes the invoice « écarts »', () => {
    const v = verifierFacture(une({}), MATEL, new Map(), [])
    expect([v.lignes[0].verdict, v.lignes[0].nature]).toEqual(['ecart', 'non_verifie'])
    expect(v.statut).toBe('ecarts')
  })

  it('a lot already billed on another invoice is a gap of the whole line', () => {
    const v = verifierFacture(une({}), MATEL, new Map([['MA108409', lot({ lot: 'MA108409', idcommande: 8645, poids: 371.1, prixAttendu: 5.54, autresFactures: ['FA2860'] })]]), [])
    expect(v.lignes[0].verdict).toBe('ecart')
    expect(v.lignes[0].ecartMontant).toBe(2055.89)
  })

  it('warns when the printed order differs from the lot’s', () => {
    const v = verifierFacture(une({ numero_commande: '8646' }), MATEL, new Map([['MA108409', lot({ lot: 'MA108409', idcommande: 8645, poids: 371.1, pieces: 19, prixAttendu: 5.54 })]]), [])
    expect(v.lignes[0].controles.map((c) => c.code)).toEqual(['commande'])
    expect(v.lignes[0].verdict).toBe('conforme')
  })
})

describe('verifierFacture — a dyer whose prices are not checked', () => {
  it('Bontemps: lines tied to their order, prices not checkable → écarts « non vérifié »', () => {
    const f = normaliserFacture({ numero_facture: 'FA00000522', total_ht: 3276.48, lignes: [
      { description: 'Thermofixation', traitements: '', qualite: '', quantite: 341.3, unite: 'M2', lot: '3976', numero_commande: '8945', pieces: null, prix_unitaire: 1.6, montant: 546.08, genre: 'lot' },
      { description: 'Impression DAMIER GRIS', traitements: '', qualite: '', quantite: 341.3, unite: 'ML', lot: '3976', numero_commande: '8945', pieces: null, prix_unitaire: 8, montant: 2730.4, genre: 'lot' },
    ] })
    const v = verifierFacture(f, BONTEMPS, new Map([['BON3976', lot({ lot: 'BON3976', idcommande: 8945, idSousTraitant: 38, poids: 80 })]]), controlerLecture(f))
    expect(v.lignes.map((l) => [l.verdict, l.nature])).toEqual([['ecart', 'non_verifie'], ['ecart', 'non_verifie']])
    expect(v.lignes[0].etm?.idcommande).toBe(8945)
    expect(v.lignes[0].controles[0].code).toBe('prix_hors_tarif') // an écart always says why
    expect(v.statut).toBe('ecarts')
  })
})

describe('recognising an invoice', () => {
  it('by its OCR text, and its attachment name', () => {
    expect(reconnaitreFacture('**SAS MATEL COULEURS TEXTILES**\n|  Facture N° | Date |')?.cle).toBe('matel')
    expect(reconnaitreFacture('ennoblissement\n## Facture\n… BONTEMPS ENNOBLISSEMENT …')?.cle).toBe('bontemps')
    expect(reconnaitreFacture('MATEL COULEURS TEXTILES\nBORDEREAU DE LIVRAISON N° 109152 A\nconditions de facturation')).toBeNull()
    expect(estFactureCandidate({ nom: 'Facture - FA2974.pdf', mimeType: 'application/pdf' })).toBe(true)
    expect(estFactureCandidate({ nom: 'FACTURE TRICOTAGE MALTERRE FA522.pdf', mimeType: 'application/pdf' })).toBe(true)
    expect(estFactureCandidate({ nom: 'TRICOTAGE MALTERRE BL 3974.pdf', mimeType: 'application/pdf' })).toBe(false)
  })
})

describe('reading quirks seen on MATEL invoices (benchmark 2026-10-02)', () => {
  it('a « Remise » of the totals box read positive is a deduction (FA2854)', () => {
    const f = normaliserFacture({ lignes: [{ description: 'Remise', quantite: null, prix_unitaire: null, montant: 227, genre: 'autre', lot: '', numero_commande: '', unite: '', traitements: '', qualite: '', pieces: null }] })
    expect(f.lignes[0]).toMatchObject({ genre: 'remise', montant: -227 })
  })

  it('an offered lot is no misreading and no gap (FA2841)', () => {
    const f = normaliserFacture({ numero_facture: 'FA2841', total_ht: 0, lignes: [
      { description: 'SANS MAJORATION EN GUISE DE GESTE NOIR 0503', traitements: 'ST+G1+RSFIN+H+OR', qualite: '188B', quantite: 188, unite: 'Kg', lot: '107844', numero_commande: '8352', pieces: null, prix_unitaire: null, montant: null, genre: 'lot' },
      { description: 'NON FACTURABLE', traitements: '', qualite: '', quantite: null, unite: '', lot: '', numero_commande: '', pieces: null, prix_unitaire: null, montant: null, genre: 'autre' },
    ] })
    expect(controlerLecture(f)).toEqual([])
    const v = verifierFacture(f, MATEL, new Map(), [])
    expect(v.lignes.map((l) => l.verdict)).toEqual(['info', 'info'])
    expect(v.statut).toBe('conforme')
  })

  it('a price above an incomplete ETM tariff is an écart « non vérifié », not a real gap (MA108114: 0,68 expected)', () => {
    const f = normaliserFacture({ numero_facture: 'FA2841', total_ht: 998.31, lignes: [
      { description: 'X', traitements: 'PREF&ST&OR', qualite: '029A', quantite: 180.2, unite: 'Kg', lot: '108114', numero_commande: '8600', pieces: 9, prix_unitaire: 5.54, montant: 998.31, genre: 'lot' },
    ] })
    const v = verifierFacture(f, MATEL, new Map([['MA108114', lot({ lot: 'MA108114', idcommande: 8600, poids: 180.2, pieces: 9, prixAttendu: 0.68, tarifIncomplet: 'pas de prix de teinture pour ce coloris' })]]), [])
    expect([v.lignes[0].verdict, v.lignes[0].nature]).toEqual(['ecart', 'non_verifie'])
    expect(v.lignes[0].ecartMontant).toBe(0)
    expect(v.statut).toBe('ecarts')
  })
})

describe('price tolerance', () => {
  it('accepts up to 1 % above the tariff (FA2888: 5,59 for 5,54), not 5 % (MA108967: 18,03 for 17,12)', () => {
    const f = (pu: number) => normaliserFacture({ numero_facture: 'FA1', total_ht: 0, lignes: [{ description: 'X', traitements: '', qualite: '', quantite: 100, unite: 'Kg', lot: '1', numero_commande: '1', pieces: 5, prix_unitaire: pu, montant: pu * 100, genre: 'lot' }] })
    const lots = (attendu: number) => new Map([['MA1', lot({ lot: 'MA1', idcommande: 1, poids: 100, pieces: 5, prixAttendu: attendu })]])
    expect(verifierFacture(f(5.59), MATEL, lots(5.54), []).lignes[0].verdict).toBe('conforme')
    expect(verifierFacture(f(18.03), MATEL, lots(17.12), []).lignes[0].verdict).toBe('ecart')
  })
})

describe('invoice status', () => {
  it('conforme only when everything was checked: one lot without tariff puts the invoice in écarts (decision 2026-10-02)', () => {
    const f = normaliserFacture({ numero_facture: 'FA1', total_ht: 0, lignes: [
      { description: 'A', traitements: '', qualite: '', quantite: 100, unite: 'Kg', lot: '1', numero_commande: '1', pieces: 5, prix_unitaire: 5, montant: 500, genre: 'lot' },
      { description: 'B', traitements: '', qualite: '', quantite: 100, unite: 'Kg', lot: '2', numero_commande: '2', pieces: 5, prix_unitaire: 9, montant: 900, genre: 'lot' },
    ] })
    const lots = new Map([
      ['MA1', lot({ lot: 'MA1', idcommande: 1, poids: 100, pieces: 5, prixAttendu: 5 })],
      ['MA2', lot({ lot: 'MA2', idcommande: 2, poids: 100, pieces: 5, prixAttendu: null })],
    ])
    const v = verifierFacture(f, MATEL, lots, [])
    expect(v.lignes.map((l) => [l.verdict, l.nature])).toEqual([['conforme', null], ['ecart', 'non_verifie']])
    expect(v.statut).toBe('ecarts')
  })
})
