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

/** v4 (2026-10-14), after Vincent reread the 45 reports sent so far: v3
 *  raised about one point an hour, but only 5 or 6 of its 28 were worth a
 *  look, and the rest were not readable (« Incohérences… » in 18 titles out
 *  of 28, the fact and the risk mixed in one paragraph, « [m6] » and internal
 *  ids). A point is now two facts that contradict each other, each with its
 *  hour and source (the code drops a point whose facts cite no hour of the
 *  data), the risk and the one check to make. The new false positives are
 *  listed under « jamais un point »: a shortfall or a defect reported to a
 *  supplier, measures entered then mailed to the dyer, a delivery in several
 *  parts, an earlier step that is simply outside the hour. */
export const PROMPT_V4 = `Tu prépares le compte rendu de l'activité d'un salarié d'ETS Malterre (fabricant textile : tricotage, bonneterie, Moreuil) pour Vincent Malterre, le dirigeant. Le rapport part environ toutes les heures et ne couvre que la période indiquée : ce qui s'est passé avant n'y est pas, et son absence ne prouve rien.
On te donne : ses connexions, ses actions dans les logiciels ETM (ETS Malterre) et TRM (Tricotage Malterre) telles que le serveur les a enregistrées, déjà écrites en clair avec les numéros affichés à l'écran, les signaux relevés par le code, et ses mails envoyés et reçus (extraits). Les mails marqués [contexte] viennent de Vincent Malterre ou de Malterre Intelligence : ils servent à comprendre, ils ne fondent jamais un point.

Réponds uniquement avec le JSON demandé :
- synthese : 2 à 5 phrases en français : sur quoi il a travaillé (clients, commandes, sous-traitants, lots…), les faits marquants. Factuel, neutre, sans jugement.
- etm : les grandes lignes de son travail dans ETM, une phrase courte par sujet (« Réception du lot MA109328 : 12 rouleaux »), 8 au plus. Liste vide s'il n'a rien fait dans ETM.
- trm : idem pour TRM.
- mails : une entrée par mail fourni (ref = la référence [mN] donnée), résumé neutre en une phrase.
- points : 0 à 3 points que Vincent doit vérifier. Presque toujours aucun.

Un point, c'est DEUX faits de la période qui ne peuvent pas être vrais ensemble, et une erreur probable qui en découle. Chaque point a :
- constat : une phrase simple qui dit ce qui ne va pas, avec le numéro concerné (« Le prix du fil 160 ELASTHANNE dans ETM n'est pas celui de l'offre »). N'emploie jamais les mots « incohérence » ni « incohérent ».
- fait_1 et fait_2 : chacun commence par l'heure (HH:MM) puis dit où (« ETM, Fils › Références » ou « mail envoyé à Filmatech ») et ce qu'il contient, chiffre ou texte cité. Deux faits différents : pas deux fois le même enregistrement.
- risque : sur qui l'erreur retombe si elle est réelle : "client", "fournisseur", "stock", "facturation" ou "interne".
- a_verifier : le geste précis pour trancher, une phrase (« Ouvrir Fils › Commandes N° 721 et comparer le prix de la ligne à l'offre »).

Ce qui mérite un point (seulement si deux faits de la période le montrent) :
- un prix, une quantité, une date, un coloris ou un numéro de pièce qui diffère entre ce qu'il écrit à un client ou un fournisseur et ce qu'il saisit dans ETM ;
- un document envoyé (avis d'expédition, confirmation, FNC, bon de commande) qui contredit une autre saisie ou un mail de la période ;
- une erreur que le client ou le fournisseur a dû signaler lui-même ;
- une commande laissée vide ou une suppression de quelque chose déjà envoyé à un client ;
- un mail grossier, insultant ou méprisant.

Ce qui n'est JAMAIS un point :
- Signaler un manque, un défaut, une non-conformité ou un écart à un fournisseur, un sous-traitant, au tricotage ou à un client : c'est son travail. Saisir des mesures hors tolérance puis l'écrire au teinturier, ouvrir une FNC, noter des défauts à la réception : c'est le contrôle qualité qui fonctionne.
- Une étape absente de la période (une affectation, une validation, une commande antérieure) : elle a pu être faite avant. Une donnée qui n'est pas fournie (un poids, un prix, une date) ne contredit rien.
- Une expédition ou une réception en plusieurs fois, plusieurs lignes qui font un total, créer puis modifier, enregistrer plusieurs fois, retirer une ligne du point sous-traitant, libérer une réservation, désaffecter, remplacer un document envoyé.
- Une ancienne date sur une vieille commande, un numéro écrit avec ou sans préfixe (MA109377 et ACL 109377 sont le même lot), une majuscule, une faute de frappe, une note interne qui diffère de la description.
- Le ton amical ou familier, un 👍, un mail pas encore répondu, un délai ou un accord donné par mail sans trace dans ETM (ETM n'a pas d'endroit pour ça).
- Ce que disent les mails [contexte] (Vincent le sait déjà), un ticket envoyé au développement, la vie personnelle, une adresse mail personnelle, le volume, les horaires, les pauses, une action refusée par ETM (elle est déjà dans les signaux du code).

Règles :
- N'invente rien et ne suppose rien. Si tu ne peux pas citer deux faits précis de la période, il n'y a pas de point. « À vérifier si c'est bien fait » sans fait contraire n'est pas un point.
- Les actions listées SONT ce qui est enregistré dans ETM/TRM. Reprends les numéros tels qu'ils sont écrits ; ne cite jamais un identifiant technique (« ID 949 », « ligne 995 »), ni les références [mN] : cite l'heure, l'interlocuteur et l'objet du mail.
- En cas de doute, pas de point. Une heure de travail normal donne une liste vide : c'est le cas attendu.`

/** v4's points: two dated facts, the risk, the check (prompt.ts PROMPT_V4). */
export const RAPPORT_SCHEMA_V4 = {
  type: 'object',
  additionalProperties: false,
  required: ['synthese', 'etm', 'trm', 'mails', 'points'],
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
    points: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['constat', 'fait_1', 'fait_2', 'risque', 'a_verifier'],
        properties: {
          constat: { type: 'string' },
          fait_1: { type: 'string' },
          fait_2: { type: 'string' },
          risque: { type: 'string', enum: ['client', 'fournisseur', 'stock', 'facturation', 'interne'] },
          a_verifier: { type: 'string' },
        },
      },
    },
  },
} as const

/** A prompt written for the v4 schema (two facts per point); an older
 *  published prompt keeps the v1-v3 schema until v4 is published. */
export const estPromptV4 = (prompt: string) => prompt.includes('fait_1')

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
  /** v1-v3 prompts. */
  alertes?: Signal[]
  /** v4 prompt. */
  points?: PointIa[]
}

export type Risque = 'client' | 'fournisseur' | 'stock' | 'facturation' | 'interne'

/** A point of attention as the e-mail shows it. A v1-v3 alert becomes one
 *  with its title as constat, its detail as fait_1 and nothing else. */
export interface PointIa {
  constat: string
  fait_1: string
  fait_2: string
  risque: Risque | null
  a_verifier: string
}

/** « [m6] » is the model's handle on a mail; the reader never sees it. */
const sansRefMail = (s: string) => s.replace(/\s*\[m\d+\]/g, '').trim()

/** First « HH:MM » (or « HHhMM ») of a text, as « HH:MM ». */
export function premiereHeure(s: string): string | null {
  const m = /\b(\d{1,2})\s*[:h]\s*(\d{2})\b/.exec(s)
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null
}

export interface PointEcarte {
  point: PointIa
  raison: string
}

/** The code's filter on the model's points (v4): each fact must open on an
 *  hour the data holds, one of them must be the salarié's own (an action or
 *  a mail not marked [contexte]), and the two facts must differ. A point the
 *  model could not anchor is dropped, never shown — kept in the run counts. */
export function filtrerPoints(
  points: readonly PointIa[],
  heures: { propres: ReadonlySet<string>; contexte: ReadonlySet<string> },
): { gardes: PointIa[]; ecartes: PointEcarte[] } {
  const gardes: PointIa[] = []
  const ecartes: PointEcarte[] = []
  for (const brut of points) {
    const p: PointIa = {
      constat: sansRefMail(brut.constat),
      fait_1: sansRefMail(brut.fait_1),
      fait_2: sansRefMail(brut.fait_2),
      risque: brut.risque,
      a_verifier: sansRefMail(brut.a_verifier),
    }
    const h = [premiereHeure(p.fait_1), premiereHeure(p.fait_2)]
    const connue = (x: string | null) => !!x && (heures.propres.has(x) || heures.contexte.has(x))
    let raison: string | null = null
    if (!p.constat || !p.fait_1 || !p.fait_2) raison = 'point incomplet'
    else if (!h.every(connue)) raison = 'un fait ne cite aucune heure de la période'
    else if (!h.some((x) => !!x && heures.propres.has(x))) raison = 'les deux faits viennent des mails [contexte]'
    else if (p.fait_1.toLowerCase() === p.fait_2.toLowerCase()) raison = 'deux fois le même fait'
    if (raison) ecartes.push({ point: p, raison })
    else gardes.push(p)
  }
  return { gardes, ecartes }
}

/** A v1-v3 alert in the v4 shape: not filtered (no facts to check). */
export const pointDAlerte = (a: Signal): PointIa => ({ constat: sansRefMail(a.titre), fait_1: sansRefMail(a.detail), fait_2: '', risque: null, a_verifier: '' })

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
  /** From Vincent Malterre or Malterre Intelligence: read for context, never
   *  the ground of a point. */
  contexte?: boolean
}

/** Received from Vincent (ETM or Malterre Fencing) or Malterre Intelligence
 *  (release notes, tickets): he already knows what they say. */
export const estMailContexte = (m: { envoye: boolean; de: string }) =>
  !m.envoye && (/^vincent@/i.test(m.de) || /@malterre-intelligence\.com$/i.test(m.de))

/** « "20261012" » in a raw body → « "12/10/2026" »: read raw, the model took
 *  a correct date for a wrong one (2026-10-12). */
export const datesLisibles = (s: string) => s.replace(/"(20\d{2})(\d{2})(\d{2})"/g, '"$3/$2/$1"')

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
    const extra = [a.ecran ? `page ${a.ecran}` : '', a.corps ? `données ${datesLisibles(a.corps)}` : '', a.erreur ? `message « ${a.erreur} »` : '']
      .filter(Boolean)
      .join(' — ')
    lignes.push(`- ${a.heure} [${a.app}] ${a.menu} : ${a.action} → ${a.resultat}${extra ? ` (${extra})` : ''}`)
  }
  if (e.actions.length > MAX_ACTIONS) lignes.push(`- … et ${e.actions.length - MAX_ACTIONS} autres actions`)
  lignes.push('', `Signaux du code (${e.signaux.length}) :`, ...(e.signaux.length ? e.signaux.map((s) => `- ${s.titre} : ${s.detail}`) : ['- aucun']), '')
  lignes.push(`Mails (${e.mails.length}) :`)
  if (!e.mails.length) lignes.push('- aucun')
  for (const m of e.mails) {
    lignes.push(`[${m.ref}]${m.contexte ? ' [contexte]' : ''} ${m.heure} ${m.sens} ${m.sens === 'envoyé' ? 'à' : 'de'} ${m.correspondant} — « ${m.sujet} »`)
    lignes.push(couper(m.extrait.replace(/\n{3,}/g, '\n\n'), MAX_EXTRAIT), '')
  }
  return sansSurrogatsIsoles(lignes.join('\n'))
}
