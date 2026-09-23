import { describe, expect, it } from 'vitest'
import { normRef, rapprocher, uniteEtm, type CommandeEtm, type CommandeExtraite } from './rapprochement.js'

const ext = (o: Partial<CommandeExtraite> = {}): CommandeExtraite => ({
  type_message: 'nouvelle_commande',
  numero_commande_client: 'A3-58281',
  lignes: [{ designation: 'Jersey coton', reference_client: 'EDF85', coloris: 'Cacao', quantite: 404, unite: 'ml', prix_unitaire: 6.38, delai: '' }],
  ...o,
})
const cmd = (o: Partial<CommandeEtm> = {}): CommandeEtm => ({
  id: 6880, numero: 3685, dateCommande: '20260323', refClient: 'Commande A3-58281 DU 23/03/2026',
  societe: 1, ouverte: false, lignes: [{ quantite: 404, unite: 3, prix: 6.38 }], ...o,
})
// Mail of 23/03: dateMin = 16/03 (quantity match), dateEntree = 21/03 (any order entered).
const D = { dateMin: '20260316', dateEntree: '20260321' }

describe('normRef / uniteEtm', () => {
  it('normalises references and units', () => {
    expect(normRef('a3 - 58281')).toBe('A358281')
    expect(normRef('Élan-12')).toBe('ELAN12')
    expect(uniteEtm('mètres')).toBe(3)
    expect(uniteEtm('ML')).toBe(3)
    expect(uniteEtm('kg')).toBe(1)
    expect(uniteEtm('pièces')).toBe(4)
    expect(uniteEtm('boîtes')).toBeNull()
  })
})

describe('rapprocher', () => {
  it('finds the order by the client order number and reports no difference', () => {
    expect(rapprocher(ext(), D, [cmd()])).toMatchObject({ statut: 'trouvee', par: 'numero', ecarts: [] })
  })

  it('finds it by OUR number when the client replies to our confirmation (LEMAHIEU N°3871)', () => {
    const r = rapprocher(ext({ numero_commande_client: '3685' }), D, [cmd({ refClient: 'autre texte' })])
    expect(r).toMatchObject({ statut: 'trouvee', par: 'numero' })
  })

  it('reports quantity and price differences, once each', () => {
    const r = rapprocher(ext({ lignes: [...ext().lignes, ...ext().lignes] }), D, [cmd({ lignes: [{ quantite: 300, unite: 3, prix: 5.9 }] })])
    expect(r.statut).toBe('trouvee')
    if (r.statut === 'trouvee') {
      expect(r.ecarts).toHaveLength(2)
      expect(r.ecarts[0]).toMatch(/808 Ml commandée, 300 Ml saisie/)
      expect(r.ecarts[1]).toMatch(/prix 6,38 € \(EDF85\) absent de la commande saisie \(5,90 €\)/)
    }
  })

  it('matches pieces on quantity (Unicycle « 5 pièces » = N°3863, 5 U)', () => {
    const r = rapprocher(
      ext({ numero_commande_client: 'WEB026224', lignes: [{ designation: 'ATS24', reference_client: '', coloris: '', quantite: 5, unite: 'pièce', prix_unitaire: null, delai: '' }] }),
      D,
      [cmd({ refClient: 'BC991444 du 03/09/26', dateCommande: '20260324', lignes: [{ quantite: 5, unite: 4, prix: 104.16 }] })],
    )
    expect(r).toMatchObject({ statut: 'trouvee', par: 'quantite', ecarts: [] })
  })

  it('an order entered since the mail counts, with the quantity as an écart (Atelier Bulle)', () => {
    const r = rapprocher(ext({ numero_commande_client: '', lignes: [{ ...ext().lignes[0], quantite: 200, unite: 'kg', prix_unitaire: null }] }), D,
      [cmd({ refClient: 'Mails du 22/09', dateCommande: '20260322', lignes: [{ quantite: 200, unite: 1, prix: 9.69 }, { quantite: 200, unite: 1, prix: 9.69 }] })])
    expect(r).toMatchObject({ statut: 'trouvee', par: 'date' })
    if (r.statut === 'trouvee') expect(r.ecarts).toEqual(['quantité 200 kg commandée, 400 kg saisie'])
  })

  it('recognises a call-off on a still-open framework order (Idylle N°3807)', () => {
    const idylle = cmd({ id: 7, numero: 3807, dateCommande: '20260630', refClient: 'BDC8FOUR8260116', ouverte: true,
      lignes: [{ quantite: 105, unite: 3, prix: 8.95 }, { quantite: 105, unite: 3, prix: 8.95 }] })
    const r = rapprocher(ext({ numero_commande_client: '', lignes: [{ ...ext().lignes[0], quantite: 100, unite: 'mètres', prix_unitaire: 8.95 }] }),
      { dateMin: '20260903', dateEntree: '20260908' }, [idylle])
    expect(r).toMatchObject({ statut: 'trouvee', par: 'ouverte', ecarts: [] })
    // …but not when that order is soldée.
    expect(rapprocher(ext({ numero_commande_client: '', lignes: [{ ...ext().lignes[0], quantite: 100, unite: 'mètres', prix_unitaire: 8.95 }] }),
      { dateMin: '20260903', dateEntree: '20260908' }, [{ ...idylle, ouverte: false }])).toEqual({ statut: 'absente' })
  })

  it('never takes an older order of the client for this one', () => {
    const r = rapprocher(ext({ numero_commande_client: 'ZZ999' }), D, [cmd({ refClient: 'autre', dateCommande: '20260301', lignes: [{ quantite: 50, unite: 3, prix: 1 }] })])
    expect(r).toEqual({ statut: 'absente' })
  })

  it('does not call a missing price on the PO a price mismatch', () => {
    const r = rapprocher(ext({ lignes: [{ designation: 'x', reference_client: '', coloris: '', quantite: 404, unite: 'm', prix_unitaire: null, delai: '' }] }), D, [cmd()])
    expect(r).toMatchObject({ statut: 'trouvee', ecarts: [] })
  })
})
