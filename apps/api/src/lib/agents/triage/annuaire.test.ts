import { describe, expect, it } from 'vitest'
import { identifier, type EntreeAnnuaire } from './annuaire.js'

const annuaire: EntreeAnnuaire[] = [
  { mail: 'mct.celine@mateltextiles.fr', type: 'sous_traitant', id: 9, nom: 'MATEL' },
  { mail: 'judy.subryan@leslipfrancais.fr', type: 'client', id: 120, nom: 'LE SLIP FRANCAIS' },
  { mail: 'bontemps.maurice@wanadoo.fr', type: 'sous_traitant', id: 38, nom: 'BONTEMPS' },
  { mail: 'jean@wanadoo.fr', type: 'client', id: 5, nom: 'DUPONT' },
  { mail: 'achat@double.fr', type: 'client', id: 1, nom: 'A' },
  { mail: 'compta@double.fr', type: 'client', id: 2, nom: 'B' },
  { mail: 'expe@both.fr', type: 'client', id: 7, nom: 'CLIENT BOTH' },
  { mail: 'expe@both.fr', type: 'fournisseur', id: 3, nom: 'FOURN BOTH' },
]

describe('identifier (who wrote, from ETM contacts)', () => {
  it('finds a contact by its exact address', () => {
    expect(identifier('Judy <judy.subryan@leslipfrancais.fr>', annuaire)).toMatchObject({ type: 'client', nom: 'LE SLIP FRANCAIS', par: 'adresse' })
  })
  it('a new address of a known company domain is that company', () => {
    expect(identifier('mct.renaud@mateltextiles.fr', annuaire)).toMatchObject({ type: 'sous_traitant', id: 9, par: 'domaine' })
  })
  it('never by a public provider’s domain', () => {
    expect(identifier('autre@wanadoo.fr', annuaire)).toBeNull()
    expect(identifier('bontemps.maurice@wanadoo.fr', annuaire)).toMatchObject({ id: 38, par: 'adresse' })
  })
  it('a domain shared by two companies says nothing', () => {
    expect(identifier('x@double.fr', annuaire)).toBeNull()
  })
  it('the group’s own domains are internal', () => {
    expect(identifier('Isabelle <isabelle@etsmalterre.com>', annuaire)).toMatchObject({ type: 'interne' })
    expect(identifier('v@malterrefencing.fr', annuaire)).toMatchObject({ type: 'interne' })
  })
  it('an address on two fiches: the supplier side wins over the client side', () => {
    expect(identifier('expe@both.fr', annuaire)).toMatchObject({ type: 'fournisseur', id: 3 })
  })
  it('unknown', () => {
    expect(identifier('noreply@orange.com', annuaire)).toBeNull()
  })
})
