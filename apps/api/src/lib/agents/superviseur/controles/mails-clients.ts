// Agent « Superviseur » — « every client gets an answer ». A conversation whose
// last word is a client's, unanswered for 24 working hours in any of the four
// mailboxes (reponses.ts), goes to Mistral, which says whether it actually
// calls for an answer (a « merci » does not). Urgent from 48 working hours, or
// when Mistral reads it as urgent (unhappy client, blocked delivery).
//
// If any mailbox cannot be read the whole check fails (its open findings stay
// open): an answer sitting in the unreadable mailbox would otherwise surface
// as a false « sans réponse ».

import type { Constat, Controle } from '../types.js'
import { appelleReponse, chargerAnnuaire, entetesDuRun, FENETRE_JOURS, trier } from '../mails.js'
import { conversationsSansReponse } from '../reponses.js'
import { evaluerAttente, REPONSE_ATTENTION_H } from './regles.js'

const court = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const prenomBoite = (b: string) => b.split('@')[0]

export const controleClientsSansReponse: Controle = {
  id: 'client_sans_reponse',
  domaine: 'mails',
  libelle: 'Client sans réponse',
  description:
    `Conversation d’un client (adresse ou domaine d’un contact client, hors fournisseurs et sous-traitants) dont le dernier message attend depuis 24 h ouvrées sans réponse de l’une des boîtes lues, et que Mistral juge appeler une réponse. Urgent à 48 h ouvrées ou si le client est mécontent / bloqué. Fenêtre : ${FENETRE_JOURS} jours.`,
  async executer(ctx) {
    const [{ entetes, erreurs }, annuaire] = await Promise.all([entetesDuRun(ctx.nowMs), chargerAnnuaire()])
    if (erreurs.length) throw new Error(`boîte(s) illisible(s) — ${erreurs.join(' ; ')}`)
    const attente = conversationsSansReponse(entetes, annuaire, ctx.nowMs, ctx.nowMs - FENETRE_JOURS * 86_400_000)
      .filter((c) => c.heuresAttente >= REPONSE_ATTENTION_H)
    const tris = await trier(
      attente.map((c) => ({ cle: c.dernier.messageId || c.cle, boite: c.dernier.boite, threadId: c.dernier.threadId })),
      ctx.version,
      ctx.nowMs,
      ctx.cout,
    )
    const out: Constat[] = []
    for (const c of attente) {
      const tri = tris.get(c.dernier.messageId || c.cle)
      if (!tri) continue
      const erreur = 'erreur' in tri
      if (!erreur && !appelleReponse(tri)) continue
      const jours = Math.floor(c.heuresAttente / 24)
      const quand = `sans réponse depuis ${jours} jour${jours > 1 ? 's' : ''} ouvré${jours > 1 ? 's' : ''} (${c.boites.map(prenomBoite).join(', ')})`
      out.push({
        cle: `client_sans_reponse:${c.cle}`,
        controle: 'client_sans_reponse',
        domaine: 'mails',
        gravite: evaluerAttente(c.heuresAttente, erreur ? 'normale' : tri.urgence),
        titre: `${c.client.nom} — « ${court(c.dernier.sujet || '(sans objet)')} »`,
        message: erreur
          ? `Message de ${c.dernier.de} ${quand}. Lecture IA impossible, à vérifier.`
          : `${tri.resume} ${quand[0].toUpperCase()}${quand.slice(1)}.${tri.action_attendue ? ` À faire : ${tri.action_attendue}` : ''}`,
        lien: null,
      })
    }
    return out
  },
}
