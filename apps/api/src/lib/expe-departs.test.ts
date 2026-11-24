import { describe, it, expect } from 'vitest'
import { ADRESSE_A_DEFINIR } from './adresse-a-definir.js'
import {
  JOURS_PAR_DEFAUT, LIEU_INCONNU, LIEU_USINE, departDivers, departsDesAvis, destinationDe, lieuDe, lireJours,
  trierDeparts, type AvisBrut,
} from './expe-departs.js'

const avis = (id: number, plus: Partial<AvisBrut> = {}): AvisBrut => ({
  id, date: '2026-11-20', idadresse: 12, idclient: 7, est_facture: 0, commande_numero: 4521, client: ' Lemahieu ',
  idtransporteur: null, transporteur: null, idenvoi: null, numero_suivi: null, adr_nom: 'Lemahieu', adr_adresse1: '12 rue du Fil', adr_adresse2: null, adr_adresse3: null,
  adr_cp: '59280', adr_ville: 'Armentières', adr_pays: 'FRANCE', envoye_le: null, destinataires: 0, ...plus,
})
const rouleaux = (idexpedition: number, idmagasin: number, magasin: string | null, nb = 3) =>
  ({ idexpedition, idmagasin, magasin, nb, poids: 20.5 * nb, metrage: 100 * nb })

describe('expe departures', () => {
  it('reads the window as whole days, bounded', () => {
    expect(lireJours(undefined)).toBe(JOURS_PAR_DEFAUT)
    expect(lireJours('abc')).toBe(JOURS_PAR_DEFAUT)
    expect(lireJours('0')).toBe(JOURS_PAR_DEFAUT)
    expect(lireJours('7')).toBe(7)
    expect(lireJours('9999')).toBe(365)
  })

  it('names the place the rolls sit in: the factory for magasin 0', () => {
    expect(lieuDe(0, null)).toEqual(LIEU_USINE)
    expect(lieuDe(9, 'MATEL ')).toEqual({ id: 9, nom: 'MATEL' })
    expect(lieuDe(92, null)).toEqual({ id: 92, nom: 'Magasin 92' })
  })

  it('gives one pickup per avis when its rolls sit in one place', () => {
    const d = departsDesAvis([avis(100)], [rouleaux(100, 9, 'MATEL')])
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({
      cle: 'formelle-100', kind: 'formelle', id: 100, idclient: 7, client: 'Lemahieu', commande_numero: 4521,
      idadresse: 12, lieu: { id: 9, nom: 'MATEL' }, nb_colis: 3, poids: 61.5, metrage: 300, facture: false,
    })
  })

  it('gives two pickups when the rolls of one avis sit in two places', () => {
    const d = departsDesAvis([avis(100)], [rouleaux(100, 9, 'MATEL', 2), rouleaux(100, 0, null, 1)])
    expect(d.map((x) => x.cle)).toEqual(['formelle-100-9', 'formelle-100-0'])
    expect(d.map((x) => x.lieu.nom)).toEqual(['MATEL', 'Usine'])
    expect(d.map((x) => x.nb_colis)).toEqual([2, 1])
  })

  it('keeps an avis without rolls, with no known place', () => {
    const d = departsDesAvis([avis(100)], [])
    expect(d).toHaveLength(1)
    expect(d[0].lieu).toEqual(LIEU_INCONNU)
    expect(d[0].nb_colis).toBe(0)
  })

  it('carries the first e-mail of the avis, to the second', () => {
    const d = departsDesAvis([avis(100, { envoye_le: '2026-11-20 11:01:56.129', destinataires: 3 })], [])
    expect(d[0].envoye_le).toBe('2026-11-20 11:01:56')
    expect(d[0].destinataires).toBe(3)
    expect(departsDesAvis([avis(101)], [])[0].envoye_le).toBeNull()
  })

  it('flags the placeholder address and unifies the country spelling', () => {
    expect(destinationDe(avis(1))).toEqual({
      nom: 'Lemahieu', adresse1: '12 rue du Fil', adresse2: '', adresse3: '', cp: '59280', ville: 'Armentières',
      pays: 'France', a_definir: false,
    })
    expect(destinationDe(avis(1, { idadresse: ADRESSE_A_DEFINIR, adr_nom: 'A Définir', adr_ville: '-' })))
      .toMatchObject({ nom: 'À définir', ville: '', a_definir: true })
    expect(destinationDe(avis(1, { idadresse: 0 }))).toBeNull()
  })

  it('reads an avis divers as cartons leaving the factory, under its free-text client when it has no other', () => {
    const d = departDivers({ ...avis(652, { idclient: 0, client: null }), ref_client: ' Salon Texworld ', nb: 2 })
    expect(d).toMatchObject({ cle: 'divers-652', kind: 'divers', client: 'Salon Texworld', lieu: LIEU_USINE, nb_colis: 2, poids: 0 })
  })

  it('carries the carrier of the avis and the envoi it was recorded in', () => {
    const [seul] = departsDesAvis([avis(100)], [])
    expect(seul).toMatchObject({ idtransporteur: 0, transporteur: '', idenvoi: null, numero_suivi: '' })
    const [parti] = departsDesAvis([avis(101, { idtransporteur: 4, transporteur: ' DPD ', idenvoi: 7, numero_suivi: ' JD0146 ' })], [])
    expect(parti).toMatchObject({ idtransporteur: 4, transporteur: 'DPD', idenvoi: 7, numero_suivi: 'JD0146' })
  })

  it('sorts the most recent first, then by number', () => {
    const d = trierDeparts(departsDesAvis(
      [avis(100, { date: '2026-11-18' }), avis(102, { date: '2026-11-20' }), avis(101, { date: '2026-11-20' })],
      [],
    ))
    expect(d.map((x) => x.id)).toEqual([102, 101, 100])
  })
})
