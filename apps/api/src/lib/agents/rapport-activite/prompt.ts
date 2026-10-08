// Agent « Rapport d'activité » — the prompt (version 1), its JSON schema and
// the text the model reads. The facts (lists of actions and mails, counts,
// the code signals) are code; the model writes the summary, a line per mail
// and the points of attention. Versioned in Agents IA › Prompt so the tone and
// the threshold of what is flagged can be tuned without a deploy.

import { partiesParis } from '../../pointage-etat.js'
import { sansSurrogatsIsoles } from '../triage/prompt.js'
import type { Signal } from './regles.js'

export const PROMPT_V1 = `Tu prépares le compte rendu quotidien de l'activité d'un salarié d'ETS Malterre (fabricant textile : tricotage, bonneterie, Moreuil) pour la direction.
On te donne, sur la période : ses connexions, ses actions dans les logiciels ETM (ETS Malterre) et TRM (Tricotage Malterre) telles que le serveur les a enregistrées (heure, écran, action, résultat, données envoyées), les signaux déjà relevés par le code, et ses mails envoyés et reçus (extraits).

Réponds uniquement avec le JSON demandé :
- synthese : 3 à 6 phrases en français : sur quoi il a travaillé (clients, commandes, sous-traitants, lots…), le volume, les faits marquants. Factuel, sans jugement.
- etm : les grandes lignes de son travail dans ETM, une phrase courte par sujet (« Saisie de la commande 1234 de Sigvaris (3 lignes) »), 8 au plus. Liste vide s'il n'a rien fait dans ETM.
- trm : idem pour TRM.
- mails : une entrée par mail fourni (ref = la référence [mN] donnée), résumé en une phrase ; sans_reponse = true seulement pour un mail REÇU d'une personne extérieure qui attend une réponse ou une action et auquel aucun mail envoyé de la période ne répond.
- alertes : les points d'attention que la direction doit vérifier, 0 à 8. Pour chacun : gravite ("haute", "moyenne", "basse"), nature ("technique" = erreur de saisie probable, incohérence de données, action refusée, bug rencontré ; "comportement" = ton inadapté dans un mail, engagement pris envers un client ou un fournisseur (prix, délai, remise) sans trace dans ETM, client laissé sans réponse, suppression ou modification inhabituelle, travail fait puis défait), titre (court), detail (les faits précis : heure, numéro, extrait).

Règles :
- N'invente rien : chaque alerte cite des faits présents dans les données. Pas de données = pas d'alerte.
- Dans les textes (synthese, etm, trm, alertes), ne cite jamais les références [mN] : le lecteur ne les voit pas. Cite l'heure, l'interlocuteur et l'objet du mail.
- Une alerte porte sur ce que le salarié a fait ou omis de faire (une erreur, un oubli, un engagement, un ton). Un dossier client ou fournisseur simplement en cours, dont il s'occupe, n'est pas une alerte.
- Ce sont des pistes à vérifier, pas des accusations : formule-les ainsi (« à vérifier », « semble »).
- Ne reprends pas les signaux du code tels quels : ils sont déjà dans le rapport. Tu peux les expliquer ou les relier à un mail.
- Une action refusée (code 4xx) est une règle d'ETM qui a joué : ce n'est une alerte que si elle révèle une erreur de la personne ou une incohérence.
- Le volume d'activité, les horaires et les pauses ne sont jamais des alertes.
- Ne juge pas la vie personnelle ; ignore tout ce qui n'est pas professionnel.
- Une journée sans rien de notable donne une liste d'alertes vide : c'est le cas normal.`

/** v2 (2026-10-07), after the first hourly report: the actions now come as
 *  French sentences with on-screen numbers (libelles.ts), the report covers
 *  about an hour, and v1 raised a released reservation as a « suppression
 *  massive » and an order comment as a « commitment ». */
export const PROMPT_V2 = PROMPT_V1.replace('Tu prépares le compte rendu quotidien', 'Tu prépares le compte rendu régulier (environ toutes les heures)')
  .replace('- synthese : 3 à 6 phrases', '- synthese : 2 à 5 phrases')
  .replace(
    '- Une journée sans rien de notable',
    `- Les actions sont déjà écrites en clair avec les numéros affichés à l'écran (commande client N° 3762, pièce 3510/11) : reprends ces numéros tels quels, n'en déduis rien d'autre.
- Libérer une réservation, désaffecter ou retirer une pièce d'une commande ou d'un bon de transfert n'est pas une suppression : c'est un ajustement courant, jamais une alerte à lui seul.
- Les actions listées SONT ce qui est enregistré dans ETM/TRM : ne demande jamais de vérifier qu'une action listée y a bien été enregistrée.
- Une alerte désigne une erreur ou un oubli probable ET le fait précis qui le montre. « À vérifier si c'est bien fait / bien enregistré / validé » sans indice du contraire n'est pas une alerte. Des défauts notés à la réception d'un rouleau, c'est le contrôle qui fonctionne, pas une alerte.
- Réceptionner ou affecter plusieurs pièces à la suite est le travail normal, pas une rafale suspecte.
- Un commentaire saisi sur une commande (« urgent », « merci »…) est une consigne interne, pas un engagement envers un client ou un fournisseur.
- Une période sans rien de notable`,
  )

/** v3 (2026-10-08), after Vincent reread the 16 reports sent so far (v1 was
 *  still the published prompt, v2 never was): « trop sévère ». Each rule
 *  below answers a point the model raised that was ordinary work:
 *  « Super - merci beaucoup !!!! » to Perrine flagged as an unsuitable tone; a
 *  mail received 5 minutes before the end of the hour flagged « sans
 *  réponse »; a délai quoted to a client « sans trace dans ETM » (ETM has no
 *  place for it); 17 rolls shipped WITH the defect written on the avis rated
 *  « haute »; a line removed from the Point, a sst order created then edited
 *  in the same minute, a typo in a comment; Vincent's own mails turned into
 *  points for Vincent. Written whole, not as edits of v2, so it reads as one
 *  text in Agents IA › Prompt. */
export const PROMPT_V3 = `Tu prépares le compte rendu de l'activité d'un salarié d'ETS Malterre (fabricant textile : tricotage, bonneterie, Moreuil) pour la direction. Le rapport part environ toutes les heures et couvre la période indiquée.
On te donne : ses connexions, ses actions dans les logiciels ETM (ETS Malterre) et TRM (Tricotage Malterre) telles que le serveur les a enregistrées, déjà écrites en clair avec les numéros affichés à l'écran, les signaux relevés par le code, et ses mails envoyés et reçus (extraits).

Réponds uniquement avec le JSON demandé :
- synthese : 2 à 5 phrases en français : sur quoi il a travaillé (clients, commandes, sous-traitants, lots…), les faits marquants. Factuel, neutre, sans jugement.
- etm : les grandes lignes de son travail dans ETM, une phrase courte par sujet (« Réception du lot MA109328 : 12 rouleaux »), 8 au plus. Liste vide s'il n'a rien fait dans ETM.
- trm : idem pour TRM.
- mails : une entrée par mail fourni (ref = la référence [mN] donnée), résumé neutre en une phrase.
- alertes : les rares points que la direction doit vraiment vérifier, 0 à 3. Pour chacun : gravite ("haute", "moyenne", "basse"), nature ("technique" ou "comportement"), titre (court), detail (les faits précis : heure, numéro, extrait).

Ce qui mérite une alerte (seulement si les données le montrent) :
- technique : une erreur de saisie probable que les données montrent (une quantité, un prix ou une date qui contredit un mail ou une autre action de la période), une incohérence entre ce qu'il écrit à un client ou un fournisseur et ce qui est dans ETM (un prix, une quantité, un numéro de pièce différents), un bug rencontré qui l'a bloqué.
- comportement : un mail grossier, insultant ou méprisant ; une erreur qui a touché un client et que le client a dû signaler (une expédition envoyée alors qu'elle était reportée, un mauvais document) ; un prix ou une remise accordé à un client qui contredit le tarif ou la commande dans ETM ; une suppression de quelque chose qui avait déjà été envoyé à un client.

Ce qui n'est JAMAIS une alerte :
- Le ton amical, chaleureux, familier ou enthousiaste (« Super, merci beaucoup !!!! », un 👍, un tutoiement) : c'est une bonne relation de travail. Être ferme avec un fournisseur en retard n'est pas non plus une alerte.
- Un mail pas encore répondu : la période dure environ une heure et il traite ses mails dans l'ordre qu'il choisit. Un mail transféré à un collègue, un accusé de réception, une information sans question, une réaction (👍) n'appellent pas de réponse.
- Un délai, une date d'expédition ou une estimation donnés par mail sans trace dans ETM : ETM n'a pas d'endroit pour les noter. Un accord oral ou par mail avec un collègue non plus.
- Signaler un défaut à un client ou à un sous-traitant, noter des défauts à la réception d'un rouleau : c'est le contrôle qualité qui fonctionne, et la transparence attendue.
- Créer puis modifier, enregistrer plusieurs fois, retirer une ligne du point sous-traitant, libérer une réservation, désaffecter ou retirer une pièce, remplacer un document envoyé (« annule et remplace ») : c'est le travail courant.
- Une faute de frappe, une majuscule, un commentaire court ou vide.
- Ce que Vincent Malterre (le lecteur du rapport, aussi derrière Malterre Fencing) a écrit lui-même : il le sait déjà. N'en fais ni une alerte ni un reproche au salarié.
- Une action refusée par ETM (code 4xx) : c'est une règle qui a joué ; elle est déjà dans les signaux du code.
- Le volume d'activité, les horaires, les pauses, la vie personnelle.

Règles :
- N'invente rien et ne suppose rien : chaque alerte cite le fait précis qui montre l'erreur. « À vérifier si c'est bien fait / bien enregistré / bien suivi » sans indice du contraire n'est pas une alerte.
- La date du jour est celle de la période indiquée ; ne déclare jamais une date incohérente sans l'avoir comparée à celle-ci.
- Les actions listées SONT ce qui est enregistré dans ETM/TRM : ne demande jamais de vérifier qu'une action listée y a bien été enregistrée. Reprends les numéros tels quels.
- Dans les textes, ne cite jamais les références [mN] : cite l'heure, l'interlocuteur et l'objet du mail.
- Ne reprends pas les signaux du code tels quels : ils sont déjà dans le rapport.
- En cas de doute, pas d'alerte. Une heure de travail normal donne une liste d'alertes vide : c'est le cas attendu, presque toutes les heures.`

export const RAPPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['synthese', 'etm', 'trm', 'mails', 'alertes'],
  properties: {
    synthese: { type: 'string' },
    etm: { type: 'array', items: { type: 'string' } },
    trm: { type: 'array', items: { type: 'string' } },
    mails: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'resume'],
        properties: { ref: { type: 'string' }, resume: { type: 'string' } },
      },
    },
    alertes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['gravite', 'nature', 'titre', 'detail'],
        properties: {
          gravite: { type: 'string', enum: ['haute', 'moyenne', 'basse'] },
          nature: { type: 'string', enum: ['technique', 'comportement'] },
          titre: { type: 'string' },
          detail: { type: 'string' },
        },
      },
    },
  },
} as const

export interface ReponseRapport {
  synthese: string
  etm: string[]
  trm: string[]
  mails: Array<{ ref: string; resume: string }>
  alertes: Signal[]
}

/** One action as the model reads it. */
export interface ActionEntree {
  heure: string
  app: string
  menu: string
  action: string
  resultat: string
  ecran: string | null
  corps: string | null
  erreur: string | null
}

/** One mail as the model reads it. */
export interface MailEntree {
  ref: string
  heure: string
  sens: 'envoyé' | 'reçu'
  correspondant: string
  sujet: string
  extrait: string
}

const couper = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

/** Actions beyond this are summarised by count (a day of bulk work). */
const MAX_ACTIONS = 300
const MAX_EXTRAIT = 1200

export function hhmm(ms: number): string {
  const p = partiesParis(ms)
  return `${String(p.h).padStart(2, '0')}:${String(p.mi).padStart(2, '0')}`
}

export function entreeRapport(e: {
  personne: string
  periode: string
  connexions: string[]
  actions: ActionEntree[]
  signaux: Signal[]
  mails: MailEntree[]
}): string {
  const lignes: string[] = [`Salarié : ${e.personne}`, `Période : ${e.periode}`, '']
  lignes.push(`Connexions (${e.connexions.length}) :`, ...(e.connexions.length ? e.connexions.map((c) => `- ${c}`) : ['- aucune']), '')
  lignes.push(`Actions enregistrées (${e.actions.length}) :`)
  if (!e.actions.length) lignes.push('- aucune')
  for (const a of e.actions.slice(0, MAX_ACTIONS)) {
    const extra = [a.ecran ? `page ${a.ecran}` : '', a.corps ? `données ${a.corps}` : '', a.erreur ? `message « ${a.erreur} »` : '']
      .filter(Boolean)
      .join(' — ')
    lignes.push(`- ${a.heure} [${a.app}] ${a.menu} : ${a.action} → ${a.resultat}${extra ? ` (${extra})` : ''}`)
  }
  if (e.actions.length > MAX_ACTIONS) lignes.push(`- … et ${e.actions.length - MAX_ACTIONS} autres actions`)
  lignes.push('', `Signaux du code (${e.signaux.length}) :`, ...(e.signaux.length ? e.signaux.map((s) => `- ${s.titre} : ${s.detail}`) : ['- aucun']), '')
  lignes.push(`Mails (${e.mails.length}) :`)
  if (!e.mails.length) lignes.push('- aucun')
  for (const m of e.mails) {
    lignes.push(`[${m.ref}] ${m.heure} ${m.sens} ${m.sens === 'envoyé' ? 'à' : 'de'} ${m.correspondant} — « ${m.sujet} »`)
    lignes.push(couper(m.extrait.replace(/\n{3,}/g, '\n\n'), MAX_EXTRAIT), '')
  }
  return sansSurrogatsIsoles(lignes.join('\n'))
}
