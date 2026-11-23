import { describe, expect, it } from 'vitest'
import { nomsDestinataires } from './destinataires-etude-coloris.js'
import { buildClientAddress, type SoumissionPdfData } from './pdf/SoumissionPdf.js'

describe('nomsDestinataires', () => {
  it('reads « Prénom Nom », in the order given', () => {
    expect(nomsDestinataires([
      { prenom: 'Marine', nom: 'LAUZET' },
      { prenom: 'Florence', nom: 'Perdreau' },
    ])).toEqual(['Marine LAUZET', 'Florence Perdreau'])
  })

  it('keeps a contact that has only one of the two', () => {
    expect(nomsDestinataires([{ prenom: null, nom: ' Achats ' }, { prenom: 'Léa', nom: '' }])).toEqual(['Achats', 'Léa'])
  })

  it('drops a contact without a name and a double', () => {
    expect(nomsDestinataires([
      { prenom: ' ', nom: null },
      { prenom: 'Marine', nom: 'Lauzet' },
      { prenom: 'marine', nom: 'LAUZET' },
    ])).toEqual(['Marine Lauzet'])
  })
})

// The sheet's « À l'attention de » block (#1388): the people ticked « Soumission
// étude coloris » as its strong line, above the client's address.
describe('soumission étude coloris — bloc « À l’attention de »', () => {
  const base: SoumissionPdfData = {
    numero: '4521',
    dateDocument: '23 novembre 2026',
    clientNom: 'Le Slip Français',
    clientAdresse: { nom: 'Le Slip Français', adresse1: '12 rue X', adresse2: null, adresse3: null, cp: '75002', ville: 'Paris', pays: 'France' },
    refFini: '104A',
    codeClient: '0593 LILAS',
    codeMalterre: '1202 0593 lilas 63710',
    sampleNumbers: [1, 2],
  }

  it('prints the people above the address', () => {
    const bloc = buildClientAddress({ ...base, destinataires: ['Marine LAUZET', 'Florence Perdreau'] })
    expect(bloc.name).toBe('Marine LAUZET, Florence Perdreau')
    expect(bloc.lines).toEqual(['Le Slip Français', '12 rue X', '75002 Paris', 'France'])
  })

  it('does not print twice a person already typed in the address', () => {
    const adresse = { ...base.clientAdresse!, adresse1: 'Judy SUBRYAN', adresse2: '6 rue du Paradis' }
    const bloc = buildClientAddress({ ...base, clientAdresse: adresse, destinataires: ['Judy Subryan'] })
    expect(bloc.name).toBe('Judy Subryan')
    expect(bloc.lines).toEqual(['Le Slip Français', '6 rue du Paradis', '75002 Paris', 'France'])
    // Nobody ticked: the address is printed as typed.
    expect(buildClientAddress({ ...base, clientAdresse: adresse }).lines).toContain('Judy SUBRYAN')
  })

  it('nobody ticked: the address alone, as before', () => {
    const bloc = buildClientAddress(base)
    expect(bloc.name).toBe('')
    expect(bloc.lines[0]).toBe('Le Slip Français')
  })

  it('a client without an address still names the company under the person', () => {
    const bloc = buildClientAddress({ ...base, clientAdresse: null, destinataires: ['Marine LAUZET'] })
    expect(bloc.name).toBe('Marine LAUZET')
    expect(bloc.lines).toEqual(['Le Slip Français'])
  })
})
