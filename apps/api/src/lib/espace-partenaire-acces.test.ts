import { describe, expect, it } from 'vitest'
import {
  accesPartenairesEffectifs, refusAcces,
  type AccesPartenaireRow, type ContactPartenaire, type PartenaireErp,
} from './espace-partenaire-acces.js'

const contact = (IDcontact: number, IDsous_traitant: number, mail: string, visible = true): ContactPartenaire =>
  ({ IDcontact, IDsous_traitant, nom: `Nom${IDcontact}`, prenom: '', mail, visible })
const partenaire = (IDsous_traitant: number, visible = true): PartenaireErp =>
  ({ IDsous_traitant, nom: `Teinturerie ${IDsous_traitant}`, visible })
const row = (idcontact: number, idsous_traitant: number, jour: number, actif = true): AccesPartenaireRow =>
  ({ idcontact, idsous_traitant, actif, modifie_le: new Date(2026, 10, jour) })

describe('accesPartenairesEffectifs', () => {
  const partenaires = new Map([[9, partenaire(9)], [6, partenaire(6)], [7, partenaire(7, false)]])

  it('keeps an active row of a visible contact with an e-mail, lowercased, under its sous-traitant', () => {
    const contacts = new Map([[10, contact(10, 9, ' Labo@Teinturerie.FR ')]])
    expect(accesPartenairesEffectifs([row(10, 9, 1)], contacts, partenaires)).toEqual([
      { idcontact: 10, IDsous_traitant: 9, partenaire: 'Teinturerie 9', email: 'labo@teinturerie.fr', prenom: '', nom: 'Nom10' },
    ])
  })

  it('drops what the ERP no longer backs', () => {
    const contacts = new Map([
      [11, contact(11, 9, 'a@b.fr', false)], // contact hidden
      [12, contact(12, 6, 'c@d.fr')],        // contact moved to another sous-traitant
      [13, contact(13, 7, 'e@f.fr')],        // sous-traitant inactive
      [14, contact(14, 0, 'g@h.fr')],        // no longer a sous-traitant's contact
      [15, contact(15, 9, 'pas-un-email')],  // no valid e-mail
    ])
    // 16: contact deleted; 10: access removed.
    const rows = [row(11, 9, 1), row(12, 9, 1), row(13, 7, 1), row(14, 9, 1), row(15, 9, 1), row(16, 9, 1), row(10, 9, 1, false)]
    expect(accesPartenairesEffectifs(rows, contacts, partenaires)).toEqual([])
  })

  it('gives a shared e-mail to the oldest grant only', () => {
    const contacts = new Map([[20, contact(20, 9, 'x@y.fr')], [21, contact(21, 6, 'X@y.fr')]])
    const out = accesPartenairesEffectifs([row(21, 6, 5), row(20, 9, 2)], contacts, partenaires)
    expect(out.map((a) => a.idcontact)).toEqual([20])
  })
})

describe('refusAcces', () => {
  it('accepts a visible contact with an e-mail at a visible sous-traitant, dyer or not', () => {
    expect(refusAcces(contact(1, 9, 'a@b.fr'), 9, partenaire(9))).toBeNull()
  })
  it('names what is missing, the contact first', () => {
    expect(refusAcces(undefined, 9, partenaire(9))).toMatch(/introuvable/)
    expect(refusAcces(contact(1, 6, 'a@b.fr'), 9, partenaire(9))).toMatch(/introuvable pour ce sous-traitant/)
    expect(refusAcces(contact(1, 9, 'a@b.fr', false), 9, partenaire(9))).toMatch(/masqué/)
    expect(refusAcces(contact(1, 9, ''), 9, partenaire(9))).toMatch(/e-mail/)
    expect(refusAcces(contact(1, 9, 'a@b.fr'), 9, partenaire(9, false))).toMatch(/inactif/)
    expect(refusAcces(contact(1, 9, 'a@b.fr'), 9, undefined)).toMatch(/introuvable/)
  })
})
