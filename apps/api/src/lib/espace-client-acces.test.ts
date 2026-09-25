import { describe, expect, it } from 'vitest'
import { accesEffectifs, emailValide, normaliserEmail, type AccesRow, type ClientErp, type ContactErp } from './espace-client-acces.js'

const contact = (IDcontact: number, IDclient: number, mail: string, visible = true): ContactErp =>
  ({ IDcontact, IDclient, nom: `Nom${IDcontact}`, prenom: '', mail, visible })
const client = (IDclient: number, visible = true, societe = 1): ClientErp => ({ IDclient, nom: `Client ${IDclient}`, visible, societe })
const row = (idcontact: number, idclient: number, jour: number, actif = true): AccesRow =>
  ({ idcontact, idclient, actif, modifie_le: new Date(2026, 8, jour) })

describe('accesEffectifs', () => {
  const clients = new Map([[1, client(1)], [2, client(2)], [3, client(3, false)], [4, client(4, true, 2)]])

  it('keeps an active row of a visible contact with an e-mail, lowercased', () => {
    const contacts = new Map([[10, contact(10, 1, ' Achats@Client.FR ')]])
    expect(accesEffectifs([row(10, 1, 1)], contacts, clients)).toEqual([
      { idcontact: 10, idclient: 1, client: 'Client 1', email: 'achats@client.fr', prenom: '', nom: 'Nom10' },
    ])
  })

  it('drops what the ERP no longer backs', () => {
    const contacts = new Map([
      [11, contact(11, 1, 'a@b.fr', false)], // contact hidden
      [12, contact(12, 2, 'c@d.fr')],        // contact moved to another client
      [13, contact(13, 3, 'e@f.fr')],        // client hidden
      [14, contact(14, 4, 'g@h.fr')],        // TRM client
      [15, contact(15, 1, 'pas-un-email')],  // no valid e-mail
    ])
    const rows = [row(11, 1, 1), row(12, 1, 1), row(13, 3, 1), row(14, 4, 1), row(15, 1, 1), row(16, 1, 1), row(10, 1, 1, false)]
    expect(accesEffectifs(rows, contacts, clients)).toEqual([])
  })

  it('gives a shared e-mail to the oldest grant only', () => {
    const contacts = new Map([[20, contact(20, 1, 'x@y.fr')], [21, contact(21, 2, 'X@y.fr')]])
    const out = accesEffectifs([row(21, 2, 5), row(20, 1, 2)], contacts, clients)
    expect(out.map((a) => a.idcontact)).toEqual([20])
  })
})

describe('e-mail', () => {
  it('normalises and validates', () => {
    expect(normaliserEmail('  A@B.Fr ')).toBe('a@b.fr')
    expect(emailValide('a@b.fr')).toBe(true)
    expect(emailValide('a@b')).toBe(false)
    expect(emailValide('')).toBe(false)
  })
})
