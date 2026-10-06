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
        required: ['ref', 'resume', 'sans_reponse'],
        properties: { ref: { type: 'string' }, resume: { type: 'string' }, sans_reponse: { type: 'boolean' } },
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
  mails: Array<{ ref: string; resume: string; sans_reponse: boolean }>
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
