import { describe, expect, it } from 'vitest'
import {
  correspond,
  detecterProfil,
  estPieceCandidate,
  modeEffectif,
  nomGed,
  profilDe,
  reglesDe,
  requeteExpediteurs,
  sousTraitantExpediteur,
  termesExpediteurs,
} from './bl-profils.js'
import { controlerExtraction, fusionnerPages, normaliserExtraction } from './bl-extraction.js'

// Excerpts of the Mistral OCR of real documents (2026-09-28 investigation).
const OCR_MATEL = `# MATEL COULEURS TEXTILES\n93 rue de Matel\n# BORDEREAU DE LIVRAISON N° 109148 A\nClient Malterre\nCommande n° 8944\n| Tricoteur Bordereau | Numéro de pièce | Poids | Métrage |`
const OCR_BONTEMPS = `## BON DE LIVRAISON\nRéférence : 3976\n**TRICOTAGE MALTERRE**\n| Commande | N° de pièce | Poids | Métrage |\n| **Commande N°8945 du 15/07** |\n19 Chemin de l'Echelle BP 60057 59142 VILLERS OUTREAUX\nSIRET 94393448900015 – RCS DOUAI B 943934489`
const OCR_TAD_BL = `BORDEREAU DE LIVRAISON N° 344642 du 14/09/26\n| EXPEDITEUR | DESTINATAIRE |\n| SARL MALTERRE | SARL C2TEC CONTRECOLLAGES |\n| N° commande client : 8922 | OF n° : 530425 | PRODUCTION |\n| N°PIECES | *|RLE| | COLORIS/DESSIN | ECRUS | FINI | CX |`
const OCR_TAD_DISPO = `T.A.D\nSTOCK FINI A DISPOSITION\ndu 14/04/26\n| N° commande client : 8589 | OF n° : 527579 |\n| N°PIECES | POIDS ECRUS | METR. FINI |\nPROVENANCE\nBORDEREAU\n4178`
const OCR_TAD_PLAN = `T.A.D\nEDITION PLAN DE CHARGE\n| N° O.P | DATE | COMMANDE | QUAL FINIE |\n| 530425 | 090726 | 8922 | E106 |`
const OCR_TAD_INFOS = `# **INFORMATIONS A NOTRE CLIENTELE**\nLe numéro des bordereaux de livraison (6 chiffres) devra être rattaché à l'enlèvement concerné.`
// Our own avis d'expédition, sent back by MATEL in a « RE: Expédition N° » reply.
const OCR_NOTRE_AVIS = `ETS MALTERRE\nBON DE LIVRAISON N° 12204\nZI Route de Thennes 80110 MOREUIL`

describe('detecterProfil', () => {
  it('recognises each dyer’s delivery document', () => {
    expect(detecterProfil(OCR_MATEL)).toMatchObject({ profil: { cle: 'matel' }, type: 'bl' })
    expect(detecterProfil(OCR_BONTEMPS)).toMatchObject({ profil: { cle: 'bontemps' }, type: 'bl' })
    expect(detecterProfil(OCR_TAD_BL)).toMatchObject({ profil: { cle: 'tad' }, type: 'bl' })
    expect(detecterProfil(OCR_TAD_DISPO)).toMatchObject({ profil: { cle: 'tad' }, type: 'mise_a_dispo' })
  })
  it('sets aside what is no delivery document', () => {
    expect(detecterProfil(OCR_TAD_PLAN)).toBeNull()
    expect(detecterProfil(OCR_TAD_INFOS)).toBeNull()
    expect(detecterProfil(OCR_NOTRE_AVIS)).toBeNull()
    expect(detecterProfil('Palettes à récupérer mardi')).toBeNull()
  })
})

describe('lots and ged names', () => {
  const e = (o: Record<string, unknown>) => normaliserExtraction({ numero_commande: '8922', pieces: [], ...o })
  it('follows what Pierrot typed at the réception', () => {
    expect(profilDe('matel')!.lot(e({ numero_bordereau: '109152 A' }))).toBe('MA109152')
    expect(profilDe('bontemps')!.lot(e({ numero_bordereau: '3976' }))).toBe('BON3976')
    expect(profilDe('tad')!.lot(e({ numero_bordereau: '344642', numero_of: '530425' }))).toBe('TA530425')
    expect(profilDe('tad')!.lot(e({ numero_of: '' }))).toBe('')
  })
  it('names TAD’s mise à dispo apart from the BL of the same OF', () => {
    expect(nomGed('TA530425', 'bl')).toBe('TA530425')
    expect(nomGed('TA530425', 'mise_a_dispo')).toBe('TA530425-dispo')
  })
})

describe('TAD extraction', () => {
  const raw = {
    numero_commande: '8922', numero_bordereau: '344642', numero_of: '530425', ligne: null, destinataire: 'SARL C2TEC CONTRECOLLAGES',
    pieces: [
      { numero_piece: '3526/15|A', poids: 19.9, metrage: 88.3, observations: '1J 1B' },
      { numero_piece: '3526/16', poids: 19.8, metrage: 85.5, observations: '1J' },
    ],
    nombre_pieces: 2, poids_total: 39.7, metrage_total: 173.8,
  }
  it('drops the choice after the bar', () => expect(normaliserExtraction(raw).pieces[0].numero_piece).toBe('3526/15'))
  it('passes, warning that the goods went to a third party', () => {
    const cs = controlerExtraction(normaliserExtraction(raw), reglesDe(profilDe('tad')!))
    expect(cs.map((c) => [c.code, c.gravite])).toEqual([['livre_ailleurs', 'avertissement']])
  })
  it('accepts a mise à dispo without bordereau, never without OF', () => {
    const r = reglesDe(profilDe('tad')!)
    expect(controlerExtraction(normaliserExtraction({ ...raw, numero_bordereau: '', destinataire: '' }), r)).toEqual([])
    expect(controlerExtraction(normaliserExtraction({ ...raw, numero_of: '' }), r).map((c) => c.code)).toContain('of_format')
  })
  it('only warns on the weight, which it does not write (écru weight)', () => {
    const cs = controlerExtraction(normaliserExtraction({ ...raw, destinataire: '', poids_total: 50 }), reglesDe(profilDe('tad')!))
    expect(cs).toEqual([expect.objectContaining({ code: 'total_poids', gravite: 'avertissement' })])
  })
  it('checks the printed total against the 1st choice only (ged 4645)', () => {
    const e = normaliserExtraction({ ...raw, destinataire: '', metrage_total: 88.3, pieces: [raw.pieces[0], { ...raw.pieces[1], observations: '2e choix, 1J' }] })
    expect(controlerExtraction(e, reglesDe(profilDe('tad')!))).toEqual([])
  })
  it('keeps the BL and the mise à dispo of one OF apart when merging pages', () => {
    const a = normaliserExtraction(raw)
    const b = normaliserExtraction({ ...raw, numero_bordereau: '' })
    const cle = (_e: unknown, i: number) => (i === 0 ? 'tad|bl|TA530425' : 'tad|mise_a_dispo|TA530425')
    expect(fusionnerPages([a, b], cle)).toHaveLength(2)
  })
})

describe('Bontemps', () => {
  const p = profilDe('bontemps')!
  it('takes a 4-digit Référence as bordereau', () => {
    const e = normaliserExtraction({ numero_commande: '8945', numero_bordereau: '3976', pieces: [{ numero_piece: '3533/1', poids: 32.8, metrage: 56.3, observations: '' }], nombre_pieces: null, poids_total: null, metrage_total: 56.3 })
    expect(controlerExtraction(e, reglesDe(p))).toEqual([])
  })
  it('blocks a BL carrying two orders', () => {
    expect(p.controlesTexte!(`${OCR_BONTEMPS}\n| Commande N°8946 du 16/07 |`).map((c) => c.code)).toEqual(['plusieurs_commandes'])
    expect(p.controlesTexte!(OCR_BONTEMPS)).toEqual([])
  })
})

describe('modes and weights', () => {
  it('keeps a dyer being benchmarked in essai', () => {
    expect(modeEffectif('actif', { ...profilDe('bontemps')!, modeMax: 'essai' })).toBe('essai')
    expect(modeEffectif('actif', profilDe('bontemps')!)).toBe('actif')
    expect(modeEffectif('actif', profilDe('matel')!)).toBe('actif')
    expect(modeEffectif('off', profilDe('matel')!)).toBe('off')
  })
  it('writes the dyer’s weight for MATEL only', () => {
    expect(profilDe('matel')!.ecritPoids).toBe(true)
    expect(profilDe('tad')!.ecritPoids).toBe(false)
    expect(profilDe('bontemps')!.ecritPoids).toBe(false)
  })
})

describe('senders', () => {
  const contacts = [
    { mail: 'mct.celine@mateltextiles.fr', idSousTraitant: 9 },
    { mail: 'mct.gilles@mateltextiles.fr', idSousTraitant: 9 },
    { mail: 'expedition@danjoux.fr', idSousTraitant: 6 },
    { mail: 'nathalie-daussy@danjoux.fr.', idSousTraitant: 6 },
    { mail: 'bontemps.maurice@wanadoo.fr', idSousTraitant: 38 },
    { mail: 'contact@bontempsennoblissement.fr', idSousTraitant: 38 },
  ]
  it('reads a company by its domain, a public provider by the full address', () => {
    expect(termesExpediteurs(contacts.map((c) => c.mail))).toEqual([
      '@bontempsennoblissement.fr', '@danjoux.fr', '@mateltextiles.fr', 'bontemps.maurice@wanadoo.fr',
    ])
    expect(requeteExpediteurs(['@danjoux.fr', 'bontemps.maurice@wanadoo.fr'])).toBe('from:(danjoux.fr OR bontemps.maurice@wanadoo.fr)')
  })
  it('matches a From header', () => {
    expect(correspond('Perrine <mct.perrinelabo@mateltextiles.fr>', ['@mateltextiles.fr'])).toBe(true)
    expect(correspond('someone@wanadoo.fr', ['bontemps.maurice@wanadoo.fr'])).toBe(false)
    expect(sousTraitantExpediteur('"TAD" <expedition@danjoux.fr>', contacts)).toBe(6)
    expect(sousTraitantExpediteur('x@etsmalterre.com', contacts)).toBeNull()
  })
})

describe('estPieceCandidate', () => {
  it('reads the dyers’ PDFs', () => {
    expect(estPieceCandidate({ nom: '20260923125807732.pdf', mimeType: 'application/pdf' })).toBe(true)
    expect(estPieceCandidate({ nom: 'TRICOTAGE MALTERRE BL 3976.pdf', mimeType: 'application/pdf' })).toBe(true)
    expect(estPieceCandidate({ nom: 'PSP00TLD3PQSPL9.pdf', mimeType: 'application/octet-stream' })).toBe(true)
  })
  it('skips our own documents sent back, invoices and images', () => {
    expect(estPieceCandidate({ nom: 'BL-12204.pdf', mimeType: 'application/pdf' })).toBe(false)
    expect(estPieceCandidate({ nom: 'soumission-lot-MA108925.pdf', mimeType: 'application/pdf' })).toBe(false)
    expect(estPieceCandidate({ nom: 'FACTURE TRICOTAGE MALTERRE FA522.pdf', mimeType: 'application/pdf' })).toBe(false)
    expect(estPieceCandidate({ nom: 'image001.png', mimeType: 'image/png' })).toBe(false)
    expect(estPieceCandidate({ nom: 'TRICOTAGE MALTERRE BL 3963.doc', mimeType: 'application/msword' })).toBe(false)
  })
})
