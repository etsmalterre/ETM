// Agent « Superviseur » — « every client gets an answer ». A conversation whose
// last word is a client's, unanswered for 24 working hours in any of the
// mailboxes (reponses.ts), goes to Mistral, which says whether it actually
// calls for an answer (a « merci » does not). Urgent from 48 working hours, or
// when Mistral reads it as urgent (unhappy client, blocked delivery).
//
// v2 (2026-09-25, from Isabelle's scores on v1) checks before raising a point:
//   1. scope, before Mistral — Nicolas's threads without Isabelle in copy, and
//      fresh mail in Isabelle's own inbox, are not hers to see (horsPortee);
//   2. ETM already answered — a document ETM emailed to someone on the
//      conversation after the client's message is an answer the mailboxes do
//      not show as one (envoi_email);
//   3. after Mistral — a « technique » thread is the workshop's; a requested
//      document already emailed from ETM, or an announced address already in
//      ETM, is done (or, sent before the request, downgraded to « info » with
//      the dates).
//
// If any mailbox cannot be read the whole check fails (its open findings stay
// open): an answer sitting in the unreadable mailbox would otherwise surface
// as a false « sans réponse ».

import type { Constat, Controle, Gravite } from '../types.js'
import { appelleReponse, chargerAnnuaire, entetesDuRun, FENETRE_JOURS, trier } from '../mails.js'
import { conversationsSansReponse, estInterne, leA } from '../reponses.js'
import { BOITES_SUR_COPIE, SUPERVISEUR_LECTRICE } from '../boites-liste.js'
import { adressesClient, envoisDesDocuments, envoisDuRun } from '../verifications-etm.js'
import { adresseConnue, evaluerAttente, horsPortee, listeEnvois, REPONSE_ATTENTION_H } from './regles.js'

const court = (s: string, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
const prenomBoite = (b: string) => b.split('@')[0]

export const controleClientsSansReponse: Controle = {
  id: 'client_sans_reponse',
  domaine: 'mails',
  libelle: 'Client sans réponse',
  description:
    `Conversation d’un client (adresse ou domaine d’un contact client, hors fournisseurs et sous-traitants) dont le dernier message attend depuis 24 h ouvrées sans réponse de l’une des boîtes lues ni envoi de document depuis ETM, et que Mistral juge appeler une réponse du bureau (jamais un échange technique). Hors rapport : la boîte de Nicolas sans Isabelle en copie, et la boîte d’Isabelle avant 5 jours ouvrés. Un document réclamé déjà envoyé depuis ETM, ou une adresse annoncée déjà saisie, ne fait pas un point. Urgent à 48 h ouvrées ou si le client est mécontent / bloqué. Fenêtre : ${FENETRE_JOURS} jours.`,
  raisonAbsent: 'La conversation n’apparaît plus dans les boîtes lues (archivée, supprimée ou sortie de la fenêtre).',
  async executer(ctx) {
    const depuisMs = ctx.nowMs - FENETRE_JOURS * 86_400_000
    const [{ entetes, erreurs }, annuaire, envois] = await Promise.all([entetesDuRun(ctx.nowMs), chargerAnnuaire(), envoisDuRun(ctx.nowMs, depuisMs)])
    if (erreurs.length) throw new Error(`boîte(s) illisible(s) — ${erreurs.join(' ; ')}`)
    const cle = (conv: string) => `client_sans_reponse:${conv}`
    const attente = conversationsSansReponse(entetes, annuaire, ctx.nowMs, depuisMs, (conv, t) => ctx.raison(cle(conv), t))
      .filter((c) => {
        if (c.heuresAttente < REPONSE_ATTENTION_H) {
          ctx.raison(cle(c.cle), `Le client a réécrit ${leA(c.dernier.date)} : le délai de réponse n’est pas encore écoulé.`)
          return false
        }
        const hors = horsPortee(
          { boites: c.boites, destinataires: [...c.dernier.a, ...c.dernier.cc].map((x) => x.toLowerCase()), participants: c.participants, heuresAttente: c.heuresAttente },
          SUPERVISEUR_LECTRICE,
          BOITES_SUR_COPIE,
        )
        if (hors) { ctx.raison(cle(c.cle), hors); return false }
        return true
      })
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
      if (!erreur && !appelleReponse(tri)) {
        ctx.raison(cle(c.cle), tri.categorie === 'technique'
          ? `Échange technique (atelier), hors rapport : ${tri.resume}`
          : `Dernier message ${leA(c.dernier.date)} lu par l’IA comme n’attendant plus de réponse : ${tri.resume}`)
        continue
      }
      let gravite: Gravite = evaluerAttente(c.heuresAttente, erreur ? 'normale' : tri.urgence)
      const notes: string[] = []
      if (!erreur) {
        // ETM emailed, after the client's message, a document the client cites
        // — only a CITED one: a routine invoice to the same accountant does not
        // answer a billing dispute (THUASNE, replay of 2026-09-25).
        const cites = new Set((tri.numeros_cites ?? []).map((n) => n.replace(/\D/g, '')).filter(Boolean))
        const externes = new Set(c.participants.filter((x) => !estInterne(x)))
        const repEtm = envois.filter((e) => e.date > c.dernier.date && externes.has(e.adresse) && cites.has(e.libelle.replace(/^.*N°/, '')))
        if (repEtm.length) {
          ctx.raison(cle(c.cle), `Envoyé depuis ETM après ce message : ${[...new Set(repEtm.map((e) => e.libelle))].join(', ')} ${listeEnvois(repEtm)}.`)
          continue
        }
        // A requested document ETM already emailed.
        const docs = (tri.documents_demandes ?? []).filter((d) => /\d/.test(d.numero))
        if (docs.length) {
          const deja = await envoisDesDocuments(docs)
          const apres = deja.filter((e) => e.date > c.dernier.date)
          if (apres.length) {
            ctx.raison(cle(c.cle), `Document réclamé envoyé depuis ETM après ce message : ${[...new Set(apres.map((e) => e.libelle))].join(', ')} ${listeEnvois(apres)}.`)
            continue
          }
          if (deja.length) {
            gravite = 'info'
            notes.push(`Déjà envoyé depuis ETM avant sa demande : ${[...new Set(deja.map((e) => e.libelle))].join(', ')} ${listeEnvois(deja)} — vérifier qu’il l’a bien reçu.`)
          }
        }
        // An announced address already entered.
        const adr = tri.changement_adresse
        if (adr?.cp.trim()) {
          const connue = adresseConnue(adr, await adressesClient(c.client.idClient))
          if (connue) {
            ctx.raison(cle(c.cle), `Nouvelle adresse déjà dans ETM : ${[connue.nom, connue.cp, connue.ville].filter(Boolean).join(' ')}.`)
            continue
          }
          notes.push(`Adresse ${adr.cp} ${adr.ville} pas encore dans ETM.`)
        }
      }
      const jours = Math.floor(c.heuresAttente / 24)
      const quand = `sans réponse depuis ${jours} jour${jours > 1 ? 's' : ''} ouvré${jours > 1 ? 's' : ''} (${c.boites.map(prenomBoite).join(', ')})`
      out.push({
        cle: cle(c.cle),
        // A new client message in the same conversation is a new request.
        empreinte: c.dernier.messageId || String(c.dernier.date),
        controle: 'client_sans_reponse',
        domaine: 'mails',
        gravite,
        titre: `${c.client.nom} — « ${court(c.dernier.sujet || '(sans objet)')} »`,
        message: erreur
          ? `Message de ${c.dernier.de} ${quand}. Lecture IA impossible, à vérifier.`
          : [`${tri.resume} ${quand[0].toUpperCase()}${quand.slice(1)}.`, tri.action_attendue ? `À faire : ${tri.action_attendue}` : '', ...notes].filter(Boolean).join(' '),
        lien: null,
      })
    }
    return out
  },
}
