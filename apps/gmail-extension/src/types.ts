// Shapes of GET /api/tricobot/conversation (apps/api/src/lib/tricobot-conversation.ts).

export type RunStatut =
  | 'ecrit' | 'simule' | 'a_verifier' | 'verifie' | 'deja_importe' | 'ignore' | 'erreur' | 'trie'
  | 'points_a_voir' | 'rien_a_signaler' | 'mail_envoye'

export type Mode = 'off' | 'essai' | 'actif'

export interface Avis {
  note: 'reussite' | 'echec'
  commentaire: string
  par: string
  le: string
}

export interface Triage {
  runId: string
  statut: RunStatut
  mode: Mode
  erreur: string | null
  categories: string[]
  categoriesAgent: string[]
  sousCategories: Record<string, string | null>
  raison: string
  organisation: { type: string; nom: string } | null
  piecesJointes: string[]
  transmissions: Array<{
    agent: string
    nom: string
    statut: 'transmis' | 'deja_traite' | 'non_transmis' | 'erreur'
    raison: string | null
    runs: Array<{ id: string; statut: string; resume: string }>
  }>
  corrections: Array<{ avant: string[]; apres: string[]; commentaire: string; par: string; le: string }>
  cheminCorrection: string
  lien: string
}

export interface Bl {
  runId: string
  statut: RunStatut
  mode: Mode
  resume: string
  erreur: string | null
  typeDocument: string | null
  bordereau: string | null
  commande: string | null
  lot: string | null
  pieces: Array<{ numero: string; poids: number | null; metrage: number | null; observations: string; statut: string | null }>
  totaux: { pieces: number | null; poids: number | null; metrage: number | null } | null
  controles: Array<{ gravite: string; message: string }>
  evaluation: Avis | null
  verification: { commentaire: string; par: string; le: string } | null
  cheminEvaluation: string
  cheminVerifie: string
  lien: string
  lienCommande: string | null
}

export interface LigneFacture {
  id: number | null
  designation: string
  lot: string
  quantite: number | null
  unite: string
  prixUnitaire: number | null
  montant: number | null
  prixAttendu: number | null
  verdict: 'conforme' | 'ecart' | 'info'
  nature: 'reel' | 'non_verifie' | null
  ecartMontant: number
  controles: string[]
  verdictFinal: 'conforme' | 'ecart' | null
  avis: Avis | null
}

export interface Facture {
  runId: string
  statut: RunStatut
  mode: Mode
  resume: string
  erreur: string | null
  idFacture: number | null
  numero: string | null
  fournisseur: string | null
  date: string | null
  totalHt: number | null
  statutFacture: 'conforme' | 'ecarts' | null
  ecartMontant: number
  traitement: string | null
  traitePar: string | null
  controles: string[]
  lignes: LigneFacture[]
  lien: string
  lienRun: string
}

export interface Message {
  id: string
  threadId: string
  de: string
  sujet: string
  date: string
  triage: Triage | null
  bl: Bl[]
  factures: Facture[]
}

export interface Categorie {
  cle: string
  libelle: string
  description: string
  agent: string | null
}

export interface Conversation {
  boite: string | null
  suivie: boolean
  messages: Message[]
  categories: Categorie[]
  droits: { corrigerTriage: boolean; piloter: boolean; factures: boolean }
}

/** What the content script saw in Gmail for the open conversation. */
export interface GmailContext {
  /** The Gmail account of the tab (contact@…, isabelle@…), when readable. */
  mailbox: string | null
  threadId: string | null
  messageIds: string[]
  subject: string | null
}

/** GET /api/tricobot/fil — one mail of the thread, as a chat bubble. */
export interface MessageFil {
  id: string
  de: string
  a: string
  cc: string
  date: string
  /** Sent by someone of the Malterre group: the bubble goes to the right. */
  interne: boolean
  texte: string
  /** The quoted history of a reply was cut (the full mail stays in Gmail). */
  coupe: boolean
  piecesJointes: Array<{ n: number; nom: string; mimeType: string; taille: number }>
}
