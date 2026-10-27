import { describe, it, expect, vi } from 'vitest'

// The builder is pure; the store imports the loader, which imports the driver.
vi.mock('./hfsql-auto.js', () => ({ query: vi.fn(), fixEncoding: vi.fn() }))

const {
  buildSite, buildRefInterne, clientTranches, categoriePoids, categoriePoidsThresholds, shopSafeTrancheIdx,
} = await import('./webservice-site.js')
const { applyDates, legacyStamp } = await import('./webservice-site-store.js')
const { prixFilLines } = await import('./pricing-fini-tarif.js')
const { composeMatieres } = await import('./composition-matieres.js')
type Catalog = import('./webservice-site-data.js').Catalog
type DesignationRow = import('./webservice-site-data.js').DesignationRow
type RccRow = import('./webservice-site-data.js').RccRow

const O = { publicBaseUrl: 'https://alpha.etsmalterre.com', today: '20260923' }

/** A small catalogue: one dyed reference (10, écru 100, 20 kg rolls, rendement
 *  2) with two coloris, one on a 0-weight écru (11), one client (7). */
function fakeCatalog(): Catalog {
  const band = (IDtraitement: number, IDteinture: number, prix: number) => [
    { IDtraitement, IDteinture, quantite_mini: 0, quantite_maxi: 100, prix: prix + 1 },
    { IDtraitement, IDteinture, quantite_mini: 100.01, quantite_maxi: 100000, prix },
  ]
  const refFini = new Map([
    [10, { IDref_fini: 10, IDref_ecru: 100, IDcolori_ecru: 0, reference: '001A', designation: 'Molleton', avec_teinture: 1, poids_Moy: 270, laizeHT_Moy: 175, rendement: 2, associee: '11', archive: false, modifiedMs: Date.UTC(2024, 0, 1) }],
    [11, { IDref_fini: 11, IDref_ecru: 101, IDcolori_ecru: 0, reference: '002A', designation: 'Sans poids', avec_teinture: 1, poids_Moy: 0, laizeHT_Moy: 160, rendement: 2, associee: '', archive: false, modifiedMs: 0 }],
    [12, { IDref_fini: 12, IDref_ecru: 100, IDcolori_ecru: 0, reference: '003A', designation: 'Archivée', avec_teinture: 1, poids_Moy: 100, laizeHT_Moy: 160, rendement: 2, associee: '', archive: true, modifiedMs: 0 }],
    [13, { IDref_fini: 13, IDref_ecru: 100, IDcolori_ecru: 0, reference: '004A', designation: 'Lourde', avec_teinture: 1, poids_Moy: 360, laizeHT_Moy: 160, rendement: 2, associee: '', archive: false, modifiedMs: 0 }],
  ])
  return {
    loadedAt: 0,
    refFini,
    refEcru: new Map([
      [100, { IDref_ecru: 100, reference: 'E100', designation: 'Molleton écru', poids: 20, laize: 180, poidsM2: 280, archive: false, prix: 2, IDcontexture: 8, bio: true, recycle: false }],
      [101, { IDref_ecru: 101, reference: 'E101', designation: '', poids: 0, laize: 0, poidsM2: 0, archive: false, prix: 2, IDcontexture: 8, bio: false, recycle: false }],
      [102, { IDref_ecru: 102, reference: 'E102', designation: 'Archivé', poids: 20, laize: 0, poidsM2: 0, archive: true, prix: 2, IDcontexture: 8, bio: false, recycle: false }],
    ]),
    contexture: new Map([[8, 'molleton']]),
    compositionByEcru: new Map([[100, [
      { IDcolori_ecru: 0, IDref_fil: 1, IDcolori_fil: 0, pourcentage: 62 },
      { IDcolori_ecru: 0, IDref_fil: 1, IDcolori_fil: 0, pourcentage: 38 },
    ]]]),
    refFil: new Map([[1, { reference: 'F1', prix_kg: 5 }]]),
    coloriFil: new Map(),
    assoByFil: new Map([[1, [{ matiereId: 16, frac: 0.5 }, { matiereId: 12, frac: 0.5 }]]]),
    matiereLibelle: new Map([[16, 'coton recyclé'], [12, 'polyester recyclé']]),
    traitementsByRef: new Map([[10, [{ IDtraitement: 287, designation: 'Lavage' }]], [13, [{ IDtraitement: 287, designation: 'Lavage' }]]]),
    bandsByTraitement: new Map([[287, band(287, 0, 1)]]),
    bandsByTeinture: new Map([[7, band(0, 7, 3)]]),
    teinture: new Map([[7, { label: 'TC', prixGots: 0 }]]),
    refFiniColoriByRef: new Map([
      [10, [{ id: 501, IDref_fini: 10, reference: 'Noir', IDteinture: 7, gots: false }, { id: 500, IDref_fini: 10, reference: 'Marine', IDteinture: 7, gots: false }]],
      [11, [{ id: 510, IDref_fini: 11, reference: 'Blanc', IDteinture: 7, gots: false }]],
    ]),
    refFiniColori: new Map([
      [500, { id: 500, IDref_fini: 10, reference: 'Marine', IDteinture: 7, gots: false }],
      [501, { id: 501, IDref_fini: 10, reference: 'Noir', IDteinture: 7, gots: false }],
      [510, { id: 510, IDref_fini: 11, reference: 'Blanc', IDteinture: 7, gots: false }],
    ]),
    coloriEcruByEcru: new Map([[100, [{ id: 3, IDref_ecru: 100, reference: 'ecru' }]]]),
    coloriEcru: new Map([[3, { id: 3, IDref_ecru: 100, reference: 'ecru' }]]),
    designation: new Map([
      [900, { IDdesignation_client: 900, IDclient: 7, IDref_fini: 10, IDref_ecru: 0, designation: 'MOL-7', unite: 3, associee: '0', archive: false, cache: false, filExclu: [], modifiedMs: 0 }],
      [901, { IDdesignation_client: 901, IDclient: 999, IDref_fini: 10, IDref_ecru: 0, designation: 'orphan', unite: 3, associee: '', archive: false, cache: false, filExclu: [], modifiedMs: 0 }],
      [902, { IDdesignation_client: 902, IDclient: 7, IDref_fini: 0, IDref_ecru: 100, designation: 'écru', unite: 1, associee: '', archive: false, cache: false, filExclu: [], modifiedMs: 0 }],
      [904, { IDdesignation_client: 904, IDclient: 7, IDref_fini: 0, IDref_ecru: 102, designation: 'écru archivé', unite: 1, associee: '', archive: false, cache: false, filExclu: [], modifiedMs: 0 }],
      [903, { IDdesignation_client: 903, IDclient: 7, IDref_fini: 10, IDref_ecru: 0, designation: 'hidden', unite: 3, associee: '', archive: false, cache: true, filExclu: [], modifiedMs: 0 }],
    ]),
    rccByDesignation: new Map([
      [900, [{ IDref_client_colori: 7001, IDdesignation_client: 900, IDref_fini_colori: 500, IDcolori_ecru: 0, lst_tranche: '0,1,2', contrat: 0, archive: false }]],
      [902, [{ IDref_client_colori: 7002, IDdesignation_client: 902, IDref_fini_colori: 0, IDcolori_ecru: 3, lst_tranche: '', contrat: 0, archive: false }]],
    ]),
    tranchesByRcc: new Map(),
    contratsByRcc: new Map(),
    client: new Map([[7, { IDsociete: 1 }], [8, { IDsociete: 2 }]]),
    clientEmail: new Map([[7, 'achat@example.fr']]),
    categories: [],
  }
}

const rcc = (over: Partial<RccRow> = {}): RccRow => ({
  IDref_client_colori: 7001, IDdesignation_client: 900, IDref_fini_colori: 500, IDcolori_ecru: 0,
  lst_tranche: '0,1,2', contrat: 0, archive: false, ...over,
})

describe('categoriePoids — thirds of the contexture range', () => {
  it('ignores archived references and missing weights', () => {
    const t = categoriePoidsThresholds(fakeCatalog()).get(8)
    // 270 and 360 only: the archived 100 and the 0-weight 11 are out (the
    // legacy counted 0 as the minimum).
    expect(t).toEqual({ min: 270, max: 360 })
  })
  it('puts the boundaries where the legacy query did', () => {
    const t = { min: 110, max: 260 } // thirds at 160 and 210
    expect(categoriePoids(155, t)).toBe('Léger')
    expect(categoriePoids(160, t)).toBe('Normal')
    expect(categoriePoids(210, t)).toBe('Normal')
    expect(categoriePoids(220, t)).toBe('Lourd')
  })
})

describe('shopSafeTrancheIdx — never a one-row grid above « < 1 »', () => {
  it('leaves normal grids alone', () => {
    expect(shopSafeTrancheIdx([0, 1, 2, 3, 4, 5, 6])).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(shopSafeTrancheIdx([1, 2, 3])).toEqual([1, 2, 3])
    expect(shopSafeTrancheIdx([0])).toEqual([0])
  })
  it('adds the row below a lone band', () => {
    expect(shopSafeTrancheIdx([1])).toEqual([0, 1])
    expect(shopSafeTrancheIdx([7])).toEqual([1, 7])
  })
})

describe('prixFilLines — client-supplied yarn (fil_non_facturé)', () => {
  const comp = [
    { IDref_fil: 1, IDcolori_fil: 0, pourcentage: 60 },
    { IDref_fil: 2, IDcolori_fil: 0, pourcentage: 40 },
  ]
  const yarns = new Map([[1, { reference: 'A', prix_kg: 5 }], [2, { reference: 'B', prix_kg: 10 }]])
  it('prices every yarn by default', () => {
    expect(prixFilLines(comp, yarns, new Map()).map((l) => l.valueKg)).toEqual([3, 4])
  })
  it('costs an excluded yarn nothing', () => {
    expect(prixFilLines(comp, yarns, new Map(), [2]).map((l) => l.valueKg)).toEqual([3, 0])
  })
})

describe('composeMatieres — one line per matière', () => {
  it('merges a matière across yarns (legacy printed 31 + 19)', () => {
    const c = fakeCatalog()
    const rows = c.compositionByEcru.get(100)!
    expect(composeMatieres(rows, c.assoByFil, c.matiereLibelle)).toEqual([
      { matiere: 'coton recyclé', pourcentage: 50 },
      { matiere: 'polyester recyclé', pourcentage: 50 },
    ])
  })
})

describe('Ref_Interne — the public grid', () => {
  const cat = fakeCatalog()
  const doc = buildRefInterne(cat, new Map(), cat.refFini.get(10)!, categoriePoidsThresholds(cat), O).ref_produit

  it('keeps the legacy header shape', () => {
    expect(doc.associee).toBe('')
    expect(doc.fiche_technique).toBe('https://alpha.etsmalterre.com/fichiers/documents/FT10.pdf')
    expect(doc.vertus).toEqual([{ IDVertu: 1, Label: 'Bio' }])
    expect(doc.longueur_rouleaux).toBe(40)
    expect(doc.CategoriePoids).toBe('Léger')
  })
  it('lists coloris by name with the 1, 2, 3, 4, 5, 10-roll grid', () => {
    expect(doc.coloris.map((c) => c.Nom)).toEqual(['Marine', 'Noir'])
    expect(doc.coloris[0].tranche_tarifaire.map((t) => t.nb_rouleau)).toEqual([1, 2, 3, 4, 5, 10])
    expect(doc.coloris[0].tranche_tarifaire[0]).toMatchObject({ qte_ml: 40, prix: expect.stringMatching(/^\d+\.\d{2}$/) })
  })
  it('leaves out a coloris it cannot price (roll weight 0)', () => {
    const d = buildRefInterne(cat, new Map(), cat.refFini.get(11)!, categoriePoidsThresholds(cat), O).ref_produit
    expect(d.coloris).toEqual([])
  })
})

describe('clientTranches — the client tarif modes', () => {
  const cat = fakeCatalog()
  const d = cat.designation.get(900)! as DesignationRow
  const standard = clientTranches(cat, new Map(), d, rcc(), O.today)!

  it('standard: the engine grid on lst_tranche', () => {
    expect(standard.map((t) => t.nb_rouleau)).toEqual([0, 1, 2])
    expect(Number(standard[0].prix)).toBeGreaterThan(Number(standard[2].prix))
  })
  it('fil_non_facturé lowers the price', () => {
    const noFil = clientTranches(cat, new Map(), { ...d, filExclu: [1] }, rcc(), O.today)!
    expect(Number(noFil[1].prix)).toBeLessThan(Number(standard[1].prix))
  })
  it('coefficient fixe: one margin on every tranche', () => {
    cat.tranchesByRcc.set(7001, [{ IDref_client_colori: 7001, IDcontrat_tarif: 0, nb_rouleaux: 1, coefficient: 20, prix_saisi: 0 }])
    const coef = clientTranches(cat, new Map(), d, rcc(), O.today)!
    expect(coef.map((t) => t.nb_rouleau)).toEqual([0, 1, 2])
    expect(Number(coef[0].prix)).toBeLessThan(Number(standard[0].prix))
    cat.tranchesByRcc.delete(7001)
  })
  it('active contract: the negotiated price on every tranche', () => {
    cat.tranchesByRcc.set(7001, [{ IDref_client_colori: 7001, IDcontrat_tarif: 55, nb_rouleaux: 1, coefficient: 0, prix_saisi: 6.65 }])
    cat.contratsByRcc.set(7001, [{ IDcontrat_tarif: 55, IDref_client_colori: 7001, date_debut: '20260101', date_expiration: '20261231' }])
    const c = clientTranches(cat, new Map(), d, rcc({ contrat: 1 }), O.today)!
    expect(c.map((t) => t.prix)).toEqual(['6.65', '6.65', '6.65'])
  })
  it('expired contract: not offered at all', () => {
    expect(clientTranches(cat, new Map(), d, rcc({ contrat: 1 }), '20270101')).toBeNull()
    cat.tranchesByRcc.delete(7001)
    cat.contratsByRcc.delete(7001)
  })
})

describe('clientTranches — a tombé de métier prices like the ERP (calcTarifRefEcru)', () => {
  const cat = fakeCatalog()
  const d = cat.designation.get(902)! as DesignationRow
  const r = rcc({ IDref_client_colori: 7002, IDdesignation_client: 902, IDref_fini_colori: 0, IDcolori_ecru: 3, lst_tranche: '1' })
  it('fil + tricotage ÷ margin ÷ port, per Kg', async () => {
    const { assembleTarifEcru } = await import('./pricing-fini-tarif.js')
    const ref = assembleTarifEcru({
      IDcolori_ecru: 3,
      ref_ecru: { IDref_ecru: 100, reference: 'E100', poids: 20, prix: 2 },
      detailFil: prixFilLines(cat.compositionByEcru.get(100)!, cat.refFil, cat.coloriFil),
    })
    const t = clientTranches(cat, new Map(), d, r, O.today)!
    expect(t.map((x) => x.prix)).toEqual([ref.tranches[0].moPrixDeVenteAuKg, ref.tranches[1].moPrixDeVenteAuKg].map((v) => v.toFixed(2)))
  })
  it('a contract price is kept as is (already €/Kg)', () => {
    cat.tranchesByRcc.set(7002, [{ IDref_client_colori: 7002, IDcontrat_tarif: 56, nb_rouleaux: 1, coefficient: 0, prix_saisi: 9.69 }])
    cat.contratsByRcc.set(7002, [{ IDcontrat_tarif: 56, IDref_client_colori: 7002, date_debut: '20250904', date_expiration: '20261230' }])
    expect(clientTranches(cat, new Map(), d, rcc({ ...r, contrat: 1 }), O.today)!.map((x) => x.prix)).toEqual(['9.69', '9.69'])
  })
  it('a fini sold by the Kg (#1253) takes the €/Kg column of the same grid', () => {
    const fini = cat.designation.get(900)! as DesignationRow
    const ml = clientTranches(cat, new Map(), fini, rcc(), O.today)!
    const kg = clientTranches(cat, new Map(), { ...fini, unite: 1 }, rcc(), O.today)!
    expect(Number(kg[1].prix)).toBeCloseTo(Number(ml[1].prix) * 2, 1) // rendement 2 Ml/Kg
  })
})

describe('buildSite — what the shop lists', () => {
  const site = buildSite(fakeCatalog(), O)
  it('lists live, visible designations of existing clients, tombés de métier included (#1327)', () => {
    expect([...site.refProduit.keys()]).toEqual([900, 902])
  })
  it('a fini is sold by the metre, with its roll length', () => {
    const p = site.refProduit.get(900)!.doc.ref_produit
    expect([p.type_ref, p.unite, p.longueur_rouleaux]).toEqual(['fini', 'Ml', 40])
  })
  it('a tombé de métier is sold by the Kg: écru name, knitted laize and weight, no metres, no sheet', () => {
    const p = site.refProduit.get(902)!.doc.ref_produit
    expect([p.type_ref, p.unite, p.titre, p.reference, p.laize, p.poids, p.longueur_rouleaux, p.fiche_technique])
      .toEqual(['tombe_metier', 'Kg', 'Molleton écru', 'E100', 180, 280, 0, ''])
    expect(p.coloris.map((c) => c.Nom)).toEqual(['ecru'])
    const t = p.coloris[0].tranche_tarifaire
    expect(t.length).toBeGreaterThan(0)
    for (const x of t) expect([x.qte_ml, x.qte_kg]).toEqual([0, Math.max(x.nb_rouleau, 1) * 20])
  })
  it("Ref_Client keeps every live designation's coloris", () => {
    expect(site.refColorisByClient.get(7)).toEqual([
      { IDRef: 900, IDColoris: 7001 },
      { IDRef: 902, IDColoris: 7002 },
    ])
  })
  it('ListeIDClient is ETM (société 1) only', () => {
    expect(site.clients).toEqual([{ IDClient: 7, email: 'achat@example.fr' }])
  })
  it('public list skips archived references', () => {
    expect([...site.refInterne.keys()].sort()).toEqual([10, 11, 13])
  })
})

describe('applyDates — date_modification follows the content', () => {
  const doc = (prix: string) => ({ ref_produit: { date_modification: '', prix } })
  const t1 = new Date(2026, 8, 1, 10, 0).getTime()
  const t2 = new Date(2026, 8, 23, 12, 30).getTime()

  it('dates a new document now, keeps the date while the content holds, moves it on a change', () => {
    const state = { version: 1 as const, entries: {} }
    const first = applyDates('ri', new Map([[1, { doc: doc('9.03'), sourceMs: 0 }]]), state, t1)
    expect(first.get(1)!.ref_produit.date_modification).toBe(legacyStamp(t1))
    const same = applyDates('ri', new Map([[1, { doc: doc('9.03'), sourceMs: 0 }]]), state, t2)
    expect(same.get(1)!.ref_produit.date_modification).toBe(legacyStamp(t1))
    const changed = applyDates('ri', new Map([[1, { doc: doc('9.10'), sourceMs: 0 }]]), state, t2)
    expect(changed.get(1)!.ref_produit.date_modification).toBe('202609231230')
  })
  it('never goes below the row’s own modification date', () => {
    const state = { version: 1 as const, entries: {} }
    const later = new Date(2026, 9, 1).getTime()
    const out = applyDates('rp', new Map([[1, { doc: doc('1'), sourceMs: later }]]), state, t1)
    expect(out.get(1)!.ref_produit.date_modification).toBe(legacyStamp(later))
  })
})
