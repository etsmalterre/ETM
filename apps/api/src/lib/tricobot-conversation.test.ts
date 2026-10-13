import { describe, it, expect } from 'vitest'
import type { AgentRun } from './agents/store.js'
import { agentsDeLaBoite, construireConversation, filSansDoublons, messageFil, redresser, type FacturePg, type MessageFil } from './tricobot-conversation.js'
import type { MessageComplet } from './gmail-reader.js'

const MAIL = { id: '1a134ff08898f793', threadId: '1a134ff08898f793', de: 'Céline <mct.celine@mateltextiles.fr>', sujet: 'BL 109484', date: '2026-10-13T11:21:26.000Z' }

function run(slug: string, id: string, resultat: Record<string, unknown>, extra: Partial<AgentRun> = {}): AgentRun {
  return {
    id, slug, createdAt: '2026-10-13T11:22:34.129Z', source: 'gmail', mode: 'actif', message: MAIL, fichiers: [],
    version: 1, model: 'm', statut: 'trie', resultat, resume: '', coutUsd: 0, dureeMs: 0, ...extra,
  }
}

const triage = (id: string, createdAt: string, categories: string[]) => run('triage', id, {
  expediteur: { adresse: 'mct.celine@mateltextiles.fr', organisation: { type: 'sous_traitant', id: 9, nom: 'MATEL', par: 'adresse' } },
  a: '', cc: '', piecesJointes: ['bl.pdf'], extrait: '', raison: 'Un ennoblisseur envoie un BL.',
  categoriesAgent: ['bl_ennoblisseur'], categories, sousCategories: { bl_ennoblisseur: 'MATEL' },
  transmissions: [{ categorie: 'bl_ennoblisseur', agent: 'bl-ennoblisseur', nom: 'BL Ennoblisseur', le: '', statut: 'transmis', raison: null, runs: [{ id: 'bl-1', statut: 'ecrit', resume: 'ok' }], tentatives: 1 }],
  libelles: [], erreurLibelles: null, corrections: [],
}, { createdAt })

const bl = run('bl-ennoblisseur', 'bl-1', {
  typeDocument: 'bl',
  extraction: { numero_commande: '9068', numero_bordereau: '109484A', ligne: 1, pieces: [{ numero_piece: '3589/2', composants: ['3589/2'], poids: 19.8, metrage: 44.1, observations: '' }], nombre_pieces: 1, poids_total: 19.8, metrage_total: 44.1, numero_of: '', destinataire: '' },
  resolution: { commandeId: 9068, lot: 'MA109484', pieces: [{ numero_piece: '3589/2', statut: 'ok', composants: [] }] },
  controles: [{ code: 'x', gravite: 'avertissement', message: 'Reprise non enregistrée.' }],
  ecriture: { gedId: 1, lignesEcrites: 1 },
}, { statut: 'ecrit', evaluation: { note: 'reussite', commentaire: '', par: { id: 1, nom: 'Vincent Malterre' }, le: '2026-10-13T12:25:31.749Z' } })

const ligneRun = { description: 'Thermofixation', lot: '3976', quantite: 341.3, unite: 'M2', prix_unitaire: 1.6, montant: 546.08 }
const facture = run('factures-ennoblisseur', 'fa-1', {
  extraction: { fournisseur: 'BONTEMPS', numero_facture: 'FA00000522', date_facture: '2026-07-31', total_ht: 3276.48, lignes: [ligneRun] },
  verification: { lignes: [{ ligne: ligneRun, lotEtm: 'BON3976', etm: { prixAttendu: null }, verdict: 'ecart', nature: 'non_verifie', ecartMontant: 0, controles: [{ message: 'Prix non comparés.' }] }], controles: [], statut: 'ecarts', ecartMontant: 0 },
  statutFacture: 'ecarts',
  ecriture: { idFacture: 34, numFactureEcrits: [8919] },
}, { statut: 'a_verifier', message: { ...MAIL, id: 'aaaaaaaaaaaaaaa1', date: '2026-10-14T08:00:00.000Z' } })

const autreMail = run('triage', 'tr-x', { categories: ['autre'] }, { message: { ...MAIL, id: 'bbbbbbbbbbbbbbb2', threadId: 'bbbbbbbbbbbbbbb2' } })

const runs = {
  triage: [triage('tr-old', '2026-10-13T11:00:00.000Z', ['autre']), triage('tr-new', '2026-10-13T11:22:00.000Z', ['bl_ennoblisseur']), autreMail],
  'bl-ennoblisseur': [bl],
  'factures-ennoblisseur': [facture],
}

describe('construireConversation', () => {
  it('gathers what each agent did with the conversation, oldest message first', () => {
    const c = construireConversation({ boite: 'contact@etsmalterre.com', threadId: MAIL.threadId.toUpperCase(), messageIds: [], runs, factures: [] })
    expect(c.suivie).toBe(true)
    expect(c.messages.map((m) => m.id)).toEqual([MAIL.id, 'aaaaaaaaaaaaaaa1'])
    const [m] = c.messages
    expect(m.triage?.runId).toBe('tr-new')
    expect(m.triage?.organisation).toEqual({ type: 'sous_traitant', nom: 'MATEL' })
    expect(m.triage?.cheminCorrection).toBe('/agents-ia/triage/runs/tr-new/categories')
    expect(m.bl[0]).toMatchObject({ bordereau: '109484A', lot: 'MA109484', lienCommande: '/sous-traitants/ennoblissement?commande=9068' })
    expect(m.bl[0].pieces[0]).toEqual({ numero: '3589/2', poids: 19.8, metrage: 44.1, observations: '', statut: 'ok' })
    expect(m.bl[0].evaluation).toMatchObject({ note: 'reussite', par: 'Vincent Malterre' })
  })

  it('matches a message by id when the thread is unknown', () => {
    const c = construireConversation({ boite: null, threadId: null, messageIds: ['BBBBBBBBBBBBBBB2'], runs, factures: [] })
    expect(c.messages.map((m) => m.triage?.runId)).toEqual(['tr-x'])
  })

  it('shows the invoice as stored in ETM when it is there, the run lines otherwise', () => {
    const sansPg = construireConversation({ boite: null, threadId: MAIL.threadId, messageIds: [], runs, factures: [] })
    const f0 = sansPg.messages[1].factures[0]
    expect(f0.idFacture).toBeNull()
    expect(f0.lignes[0]).toMatchObject({ id: null, lot: 'BON3976', verdict: 'ecart', nature: 'non_verifie', controles: ['Prix non comparés.'] })
    expect(f0.lien).toBe('/agents-ia/agents?agent=factures-ennoblisseur&run=fa-1')

    const pg: FacturePg = { id: 34, runId: null, messageId: null, numero: 'FA00000522', statut: 'ecarts', ecartMontant: 0, traitement: 'reclamee', traitePar: 'Isabelle', lignes: [{ ...f0.lignes[0], id: 77, verdictFinal: 'conforme', avis: null }] }
    const f = construireConversation({ boite: null, threadId: MAIL.threadId, messageIds: [], runs, factures: [pg] }).messages[1].factures[0]
    expect(f).toMatchObject({ idFacture: 34, traitement: 'reclamee', lien: '/sous-traitants/factures?facture=34' })
    expect(f.lignes[0].id).toBe(77)

    // Another copy of the database: other ids, same mail + invoice number.
    const copie = { ...pg, id: 10, messageId: 'aaaaaaaaaaaaaaa1' }
    expect(construireConversation({ boite: null, threadId: MAIL.threadId, messageIds: [], runs, factures: [copie] }).messages[1].factures[0].idFacture).toBe(10)
  })

  it('matches nothing in a mailbox no agent reads (Gmail ids are per mailbox)', () => {
    const c = construireConversation({ boite: 'isabelle@etsmalterre.com', threadId: MAIL.threadId, messageIds: [MAIL.id], runs, factures: [] })
    expect(c.suivie).toBe(false)
    expect(c.messages).toEqual([])
  })
})

describe('agentsDeLaBoite', () => {
  it('is case-insensitive', () => {
    expect([...agentsDeLaBoite('Contact@EtsMalterre.com')].sort()).toEqual(['bl-ennoblisseur', 'factures-ennoblisseur', 'triage'])
  })
})

describe('messageFil', () => {
  const mail = (de: string, texte: string): MessageComplet => ({
    id: 'm1', threadId: 't1', de, sujet: 'Re: palettes', date: '2026-10-13T09:11:00.000Z', a: '', cc: '', envoye: false, libelles: [], texte,
    piecesJointes: [{ nom: 'cdc.pdf', mimeType: 'application/pdf', attachmentId: 'x', taille: 1200 }],
  })

  it('cuts the quoted history of a reply and says so', () => {
    const reponse = ['Bonjour,', 'Cela nous va.', '', 'Le lun. 12 oct. 2026 à 17:37, Isabelle <isabelle@etsmalterre.com> a écrit :', '> Est-ce que 160 cm…'].join('\n')
    const m = messageFil(mail('Antoine <a.lecardonnel@leslipfrancais.fr>', reponse))
    expect(m).toMatchObject({ texte: 'Bonjour,\nCela nous va.', coupe: true, interne: false })
    expect(m.piecesJointes).toEqual([{ n: 0, nom: 'cdc.pdf', mimeType: 'application/pdf', taille: 1200 }])
  })

  it('puts the Malterre group on the right', () => {
    expect(messageFil(mail('Isabelle Malterre <isabelle@etsmalterre.com>', 'Merci')).interne).toBe(true)
    expect(messageFil(mail('contact@tricotage-malterre.fr', 'Ok')).interne).toBe(true)
    expect(messageFil(mail('Judy <judy@leslipfrancais.fr>', 'Ok')).coupe).toBe(false)
  })

  it('drops inline image placeholders and signature logos', () => {
    const m = messageFil({ ...mail('Isa <isabelle@etsmalterre.com>', 'Voici la photo [image: image.png] du croisé.'), piecesJointes: [{ nom: 'logo.png', mimeType: 'image/png', attachmentId: 'a', taille: 4000 }, { nom: 'palette.jpg', mimeType: 'image/jpeg', attachmentId: 'b', taille: 900000 }] })
    expect(m.texte).toBe('Voici la photo  du croisé.')
    const signature = messageFil(mail('Isa <isabelle@etsmalterre.com>', ['Belle journée', ' <https://etsmalterre.fr/>', 'Isabelle'].join(String.fromCharCode(10))))
    expect(signature.texte.split(String.fromCharCode(10))).toEqual(['Belle journée', '', 'Isabelle'])
    expect(m.piecesJointes).toEqual([{ n: 1, nom: 'palette.jpg', mimeType: 'image/jpeg', taille: 900000 }])
  })
})

describe('redresser', () => {
  it('joins the lines of a hard-wrapped sentence, keeps short lines and sentence ends', () => {
    const texte = [
      'Bonjour Antoine,',
      '',
      'Sur une prochaine livraison, nous allons donc essayer ce système afin de',
      'valider si cela convient.',
      'Dans l’idéal, si nous utilisons ce genre de cales, il faudrait qu’on trouve.',
      'Un système pour les récupérer.',
      'Belle journée',
      'Isabelle',
    ].join('\n')
    expect(redresser(texte).split('\n')).toEqual([
      'Bonjour Antoine,',
      '',
      'Sur une prochaine livraison, nous allons donc essayer ce système afin de valider si cela convient.',
      'Dans l’idéal, si nous utilisons ce genre de cales, il faudrait qu’on trouve.',
      'Un système pour les récupérer.',
      'Belle journée',
      'Isabelle',
    ])
  })
})

describe('filSansDoublons', () => {
  const m = (id: string, pieces: Array<[string, number]>): MessageFil => ({
    id, de: '', a: '', cc: '', date: '', interne: false, texte: '', coupe: false,
    piecesJointes: pieces.map(([nom, taille], n) => ({ n, nom, mimeType: 'image/png', taille })),
  })

  it('shows an attachment on the first mail carrying it only', () => {
    const fil = filSansDoublons([m('a', [['cdc.pdf', 1], ['noname', 70]]), m('b', [['noname', 70], ['photo.jpg', 9]])])
    expect(fil.map((x) => x.piecesJointes.map((p) => [p.n, p.nom]))).toEqual([[[0, 'cdc.pdf'], [1, 'noname']], [[1, 'photo.jpg']]])
  })
})
