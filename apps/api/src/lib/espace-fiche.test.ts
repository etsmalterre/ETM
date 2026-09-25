import { describe, expect, it } from 'vitest'
import { adressesFiche, contactsFiche } from './espace-fiche.js'

const adresse = (o: Record<string, unknown>) => ({
  IDadresse: 1, nom: 'Atelier', adresse1: '1 rue X', adresse2: '', adresse3: '', cp: '59100', ville: 'Roubaix', pays: 'France',
  est_visible: 1, est_defaut: 0, est_defaut_facturation: 0, est_defaut_livraison: 0, commentaire: 'note interne', ...o,
})

describe('adressesFiche', () => {
  it('drops hidden rows, the « à définir » placeholders and empty rows', () => {
    const out = adressesFiche([
      adresse({ IDadresse: 1, est_visible: 0 }),
      adresse({ IDadresse: 2, nom: 'a définir', adresse1: '', ville: '' }),
      adresse({ IDadresse: 795 }),
      adresse({ IDadresse: 3, adresse1: '', ville: '' }),
      adresse({ IDadresse: 4 }),
    ])
    expect(out.map((a) => a.IDadresse)).toEqual([4])
  })
  it('puts billing first, then delivery, and never carries the comment', () => {
    const out = adressesFiche([
      adresse({ IDadresse: 1, nom: 'B' }),
      adresse({ IDadresse: 2, nom: 'C', est_defaut_livraison: 1 }),
      adresse({ IDadresse: 3, nom: 'D', est_defaut_facturation: 1 }),
    ])
    expect(out.map((a) => a.IDadresse)).toEqual([3, 2, 1])
    expect(out[0]).not.toHaveProperty('commentaire')
    expect(out[0].facturation).toBe(true)
  })
})

describe('contactsFiche', () => {
  it('keeps visible, named contacts, the main one first, e-mail lowercased', () => {
    const out = contactsFiche([
      { IDcontact: 1, prenom: 'Zoé', nom: 'Martin', mail: 'Z@X.FR', tel: '', est_visible: 1, est_defaut: 0, envoi_facture: 1 },
      { IDcontact: 2, prenom: 'Luc', nom: 'Blanc', mail: '', tel: '06', est_visible: 1, est_defaut: 1 },
      { IDcontact: 3, prenom: '', nom: '', mail: '', tel: '', est_visible: 1, est_defaut: 0 },
      { IDcontact: 4, prenom: 'Old', nom: 'One', mail: 'o@x.fr', tel: '', est_visible: 0, est_defaut: 0 },
    ])
    expect(out.map((c) => c.IDcontact)).toEqual([2, 1])
    expect(out[1].email).toBe('z@x.fr')
    expect(out[1].recoit).toEqual({ commandes: false, bl: false, factures: true })
  })
})
