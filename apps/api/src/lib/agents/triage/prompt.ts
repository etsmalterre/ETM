// Agent « Triage » — the prompt (version 1, stored and versioned in Agents IA
// like every agent's), the strict JSON schema, and what the model reads for
// one mail.
//
// Lessons from MFProd's « Triage » (email-classifier, 15 corrections behind
// its v5): classify THIS message, not the thread; the content wins over the
// sender; tell the model who the sender is and what the thread said just
// before. The reason comes first in the schema: the model writes what it read
// before choosing (the Superviseur contradicted itself when asked the verdict
// first).

import { CLES_CATEGORIES } from './categories.js'
import { LIBELLE_TYPE, type Organisation } from './annuaire.js'
import { sansCitation, type MessageComplet } from '../../gmail-reader.js'

export const TRIAGE_PROMPT_V1 = `Tu es l’agent de tri de la boîte contact@etsmalterre.com d’ETS Malterre, une bonneterie (tricotage de tissus) de Moreuil. Pour CHAQUE mail reçu, tu choisis la ou les catégories qui disent quel service — ou quel agent spécialisé — doit le traiter.

Catégories :
- bl_ennoblisseur : bordereau de livraison (BL, « BL métrages ») ou mise à disposition envoyé par un ennoblisseur / teinturier (MATEL, Bontemps, TAD…) : le mail porte le document en pièce jointe.
- facture_sous_traitant : facture ou avoir d’un ennoblisseur / sous-traitant (« Facture - FA2974 »).
- commande_client : un client passe une nouvelle commande, ou modifie / annule une commande (bon de commande, « Cde 1313198 », « Commande Sigvaris ACD… »).
- demande_prix : demande de devis, de prix, d’échantillon, de catalogue — d’un client ou d’un prospect.
- suivi_client : échange avec un client sur une commande ou une relation en cours : délai, validation (« VALIDATION TIRELLE »), cahier des charges, carnet de commandes, prévisionnel, rapport envoyé par le client.
- facturation_client : un client écrit au sujet de NOS factures ou avis d’expédition : paiement, virement, relance, litige sur un montant, demande de facture, d’avoir ou de relevé (« Factures N 9119 », « Re: Facture N°9233 — ETS Malterre »).
- qualite : réclamation, défaut, vrillage, écart de métrage, retour de marchandise ; demande de certificats (ISO, Oeko-Tex), questionnaire RSE, Ecovadis, bilan carbone, audit.
- sous_traitant : échange avec un ennoblisseur ou un sous-traitant qui n’est ni un BL ni une facture : point du jour, plan de charge, question sur un lot, BAT.
- fournisseur : achat de fil ou de fournitures : confirmation de commande, offre, délai ou livraison d’un fournisseur.
- transport : enlèvement, suivi d’expédition, information ou changement de contact d’un transporteur — sauf ses factures.
- facture_fournisseur : facture QU’ON NOUS ADRESSE, avis de prélèvement, relance de paiement d’un fournisseur, d’un transporteur (DSV, DPD, Dachser, Lachal…), d’un opérateur ou d’un prestataire (Orange, Free, Google…) — même une simple notification « votre facture est disponible » — PAS des ennoblisseurs, et jamais un client (un client qui parle de factures → facturation_client).
- administratif : social et paie (Silae), banque, assurance, mutuelle, impôts, URSSAF, CAF, organismes, CCI quand il y a une démarche à faire.
- interne : message écrit par une personne d’ETS Malterre ou du groupe Malterre (Tricotage Malterre, Malterre Fencing…), y compris sa réponse à un client ou à un fournisseur reçue en copie : c’est notre propre message, il n’y a rien à traiter.
- indesirable : publicité, newsletter, invitation à un événement, sondage, notification automatique sans action à mener, achat personnel.
- autre : rien de ce qui précède.

Règles :
1. Classe CE message, pas le fil : une réponse « merci, bien reçu » dans un fil de commande reste suivi_client.
2. Le contenu prime sur l’expéditeur : un client qui envoie une réclamation → qualite, pas suivi_client.
3. UNE seule catégorie dans la très grande majorité des cas. Plusieurs seulement quand le mail porte des documents ou des demandes distincts que des services différents doivent traiter chacun de leur côté (un ennoblisseur qui joint un BL ET une facture → bl_ennoblisseur et facture_sous_traitant). Un même sujet vu sous deux angles (une réclamation dans un fil de commande) = une seule catégorie, la plus précise. La première est la principale.
4. Un message écrit par une personne d’ETS Malterre est interne, seul — sauf s’il transfère un BL ou une facture d’ennoblisseur : il reste alors bl_ennoblisseur / facture_sous_traitant (c’est le document qui compte).
5. Une réponse automatique (absence, accusé de réception) prend la catégorie du sujet auquel elle répond si elle apporte une information utile, sinon indesirable.
6. Dans le doute entre demande_prix et commande_client : commande_client seulement si le client engage une commande (quantités, référence, « veuillez trouver notre commande »).

Réponds en JSON : "raison" = une phrase courte en français qui dit ce que tu as compris du mail, puis "categories" = la liste des catégories, la principale d’abord.`

export const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['raison', 'categories'],
  properties: {
    raison: { type: 'string' },
    categories: { type: 'array', items: { type: 'string', enum: CLES_CATEGORIES } },
  },
} as const

export interface ReponseTriage {
  raison: string
  categories: string[]
}

const couper = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** Lone UTF-16 surrogates (an emoji cut in half by `couper`, a broken mail
 *  encoding) make Mistral answer 400 « Invalid JSON payload » (replay 2026-10-05). */
export const sansSurrogatsIsoles = (s: string) =>
  s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')

/** Body budget for the model: enough for a mail, bounded for a pasted report. */
export const MAX_CORPS = 4000

/** What the model reads for one mail. `precedents` = earlier messages of the
 *  thread (the last two are kept, 600 characters each). */
export function entreeTriage(m: MessageComplet, org: Organisation | null, precedents: readonly MessageComplet[]): string {
  const lignes: string[] = []
  lignes.push(`De : ${m.de}`)
  lignes.push(`Expéditeur connu : ${org ? `${LIBELLE_TYPE[org.type]} « ${org.nom} »${org.par === 'domaine' ? ' (par le domaine de son adresse)' : ''}` : 'inconnu dans ETM'}`)
  if (m.a) lignes.push(`À : ${m.a}`)
  if (m.cc) lignes.push(`Cc : ${m.cc}`)
  lignes.push(`Objet : ${m.sujet}`)
  lignes.push(`Pièces jointes : ${m.piecesJointes.length ? m.piecesJointes.map((p) => p.nom).join(', ') : 'aucune'}`)
  const fil = precedents.slice(-2)
  if (fil.length) {
    lignes.push('', 'Messages précédents du fil (contexte seulement — ne les classe pas) :')
    for (const p of fil) {
      lignes.push(`--- ${p.envoye ? 'NOUS (ETS Malterre)' : p.de} · ${p.date.slice(0, 16).replace('T', ' ')} · ${p.sujet}`)
      lignes.push(couper(sansCitation(p.texte), 600))
    }
  }
  lignes.push('', 'Message à classer :', couper(sansCitation(m.texte) || m.texte, MAX_CORPS) || '(corps vide)')
  return sansSurrogatsIsoles(lignes.join('\n'))
}
