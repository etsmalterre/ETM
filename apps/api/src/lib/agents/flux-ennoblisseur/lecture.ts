// Flux Ennoblisseur › Délais and Contrôles: the model reads, the code checks
// (claude_doc/agents_autonomie.md §0, decided with Vincent 2026-11-05).
//
// Each skill has its own prompt (versioned in AgentState.promptsCompetences,
// published from Agents IA › Prompt): it tells the model what we expect from a
// dyer's reply to our « Point du JJ/MM » and the right not to know. The model
// reads ANY reply, whatever the partner or its layout, and returns a JSON
// schema. The code then checks what does not depend on the format:
//   - the passage quoted must be in the mail (else: aide);
//   - « certain: false » is an aide, never a saisie;
//   - a form the code reads for sure (« s 49 », « 02/12 », MATEL's « laize = »
//     line) is read again by the code, and a disagreement is an aide;
//   - the rules of the line or the lot (delais.ts: past date, > 6 months, a
//     line dated otherwise, an order not asked, a lot unknown or validated).
// The pure checks are tested (lecture.test.ts); the model call is not.

import { chatJson } from '../../mistral.js'
import type { VersionInitiale } from '../store.js'
import { commandesNommees, lireControles, lireDelai, type ControleLu, type QuestionDelai } from './reponse-point.js'

export const LECTURE_MODELE = 'mistral-small-latest'

// ── Prompts (v2, 2026-11-05) ─────────────────────────────

const DROIT_DE_NE_PAS_SAVOIR = `Tu as toujours le droit de ne pas savoir. Si la réponse est ambiguë, incomplète, ou si tu hésites entre deux lectures, mets « certain » à false et dis pourquoi dans « raison » ; donne quand même ta meilleure valeur si tu en as une, sinon null. Ne devine jamais : une personne tranchera, et c'est comme ça que tu apprends. Demander n'est pas une faute.`

export const PROMPT_DELAIS = `Tu es Tricobot, l'assistant d'ETS Malterre (bonneterie). Tu lis la réponse d'un ennoblisseur (teinturier, apprêteur) à notre mail « Point du JJ/MM », dans lequel nous lui demandions entre autres le délai de certaines commandes.

Ce qu'on attend de toi : pour chaque commande dont la réponse donne un délai, la date à laquelle l'ennoblisseur nous dit que la commande sera finie, telle qu'une personne de chez nous la saisirait.

Règles de la maison :
- « s N », « S49 », « sem 49 », « semaine 49 » = le MERCREDI de la semaine ISO N, de l'année qui place cette date au plus tôt une semaine avant le mail.
- « début de semaine » = lundi, « mi-semaine » = mercredi, « fin de semaine » = vendredi ; « semaine prochaine » = la semaine qui suit la date du mail.
- Une date « 02/12 » = le 2 décembre, de l'année qui la place après le mail.
- Une réponse qui ne nomme aucune commande (« 5) s 49 ») vaut pour toutes les commandes demandées qui ne sont pas nommées ailleurs. « Le reste s 50 » vaut pour celles qui ne sont pas nommées.
- MATEL répond section par section, dans l'ordre de notre Point : « 5) » porte les délais, « 2) » les contrôles, « 3) » et « 4) » l'avancement. Seuls les délais t'intéressent ici. Un autre ennoblisseur peut répondre autrement (en phrases, en tableau, commande par commande) : lis-le comme une personne le ferait.
- « fini », « soldé », « parti », « livré » ne sont pas des délais.

${DROIT_DE_NE_PAS_SAVOIR}

Pour chaque commande :
- commande : son numéro, tel que nous l'avons demandé (ou tel qu'écrit si nous ne l'avions pas demandée) ;
- citation : le passage exact de la réponse qui donne ce délai, recopié mot pour mot, sans le corriger ;
- nommee : true si ce passage nomme la commande, false s'il vaut pour plusieurs commandes sans les nommer ;
- date : AAAA-MM-JJ, ou null ;
- certain et raison : voir plus haut (raison peut rester vide quand tu es sûr).
repond_au_point : true si le mail répond à notre Point (même sans donner de délai), false si c'est une simple conversation.
N'inclus pas une commande dont la réponse ne parle pas.`

export const PROMPT_CONTROLES = `Tu es Tricobot, l'assistant d'ETS Malterre (bonneterie). Tu lis la réponse d'un ennoblisseur (teinturier, apprêteur) à notre mail « Point du JJ/MM », dans lequel nous lui demandions entre autres ses contrôles (mesures) sur certains lots.

Ce qu'on attend de toi : pour chaque lot dont la réponse donne des mesures, ces mesures, telles que l'ennoblisseur les a faites :
- laize : en cm (« laize = 156cm », « laize utile 156 ») ;
- poids : en g/m² ;
- stabH : la stabilité dimensionnelle en hauteur (en longueur), en %, avec son signe (« h = -3 » donne -3) ;
- stabL : la stabilité en largeur, en %, avec son signe (« l = -3 ») ;
- vrillage : en % (« V = 4% »), null s'il n'est pas donné (0 est une mesure).
Le lot : son numéro tel qu'écrit, chiffres seuls (« lot 109579 », « MA109579 » donnent 109579).

MATEL écrit une ligne par lot, en section 2 : « lot 109579 laize = 156cm poids = 166g/m² stabs h = -3 l = -3 V = 4% ». Un autre ennoblisseur peut l'écrire autrement : lis-le comme une personne le ferait.
Un lot annoncé pour plus tard (« résultats lot 109669 demain ») : plus_tard = true, toutes les mesures à null.

${DROIT_DE_NE_PAS_SAVOIR} Par exemple « h = » écrit deux fois et pas de « l = » : tu ne sais pas laquelle est la largeur, certain = false.

Pour chaque lot : lot, citation (le passage exact de la réponse, mot pour mot), laize, poids, stabH, stabL, vrillage, plus_tard, certain, raison.
N'inclus pas un lot dont la réponse ne donne ni mesure ni annonce.`

/** v1 = the reading by regular expressions (MATEL only, 2026-11-04), kept in
 *  the history so its runs and saisies keep their number; v2 = the model reads. */
export const DELAIS_VERSIONS_LIVREES: readonly VersionInitiale[] = [
  { model: LECTURE_MODELE, prompt: '(Lecture par le code : expressions régulières sur la section 5 de MATEL. Le modèle ne faisait que proposer une date quand le code ne lisait pas la réponse.)', note: 'Version d’origine : lecture par le code, MATEL seulement.' },
  { model: LECTURE_MODELE, prompt: PROMPT_DELAIS, note: 'Le modèle lit toute la réponse, quel que soit l’ennoblisseur ; le code vérifie la citation, relit les « s N » et les dates, et garde ses règles sur la ligne.' },
]
export const CONTROLES_VERSIONS_LIVREES: readonly VersionInitiale[] = [
  { model: '', prompt: '(Lecture par le code : expressions régulières sur la section 2 de MATEL, sans modèle.)', note: 'Version d’origine : lecture par le code, MATEL seulement.' },
  { model: LECTURE_MODELE, prompt: PROMPT_CONTROLES, note: 'Le modèle lit les mesures de toute réponse, quel que soit l’ennoblisseur ; le code vérifie la citation et relit les lignes de la forme MATEL.' },
]

// ── What the model returns ───────────────────────────────

export interface DelaiLu {
  commande: string
  citation: string
  nommee: boolean
  date: string | null
  certain: boolean
  raison: string
}
export interface LectureDelais { repondAuPoint: boolean; commandes: DelaiLu[] }

export interface ControleIa {
  lot: string
  citation: string
  laize: number | null
  poids: number | null
  stabH: number | null
  stabL: number | null
  vrillage: number | null
  plusTard: boolean
  certain: boolean
  raison: string
}

const nombreOuNull = { type: ['number', 'null'] }
const SCHEMA_DELAIS = {
  type: 'object', additionalProperties: false, required: ['repond_au_point', 'commandes'],
  properties: {
    repond_au_point: { type: 'boolean' },
    commandes: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['commande', 'citation', 'nommee', 'date', 'certain', 'raison'],
        properties: {
          commande: { type: 'string' }, citation: { type: 'string' }, nommee: { type: 'boolean' },
          date: { type: ['string', 'null'] }, certain: { type: 'boolean' }, raison: { type: 'string' },
        },
      },
    },
  },
}
const SCHEMA_CONTROLES = {
  type: 'object', additionalProperties: false, required: ['lots'],
  properties: {
    lots: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['lot', 'citation', 'laize', 'poids', 'stabH', 'stabL', 'vrillage', 'plus_tard', 'certain', 'raison'],
        properties: {
          lot: { type: 'string' }, citation: { type: 'string' },
          laize: nombreOuNull, poids: nombreOuNull, stabH: nombreOuNull, stabL: nombreOuNull, vrillage: nombreOuNull,
          plus_tard: { type: 'boolean' }, certain: { type: 'boolean' }, raison: { type: 'string' },
        },
      },
    },
  },
}

const jjmmaaaa = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`

/** The data the code gives the model with the prompt: the mail's date, what the Point asked, the reply. */
export function messageLecture(o: { dateMail: string; jourPoint: string | null; demandes: Array<{ commande: string; article: string }>; quoi: 'délai' | 'contrôles'; texte: string }): string {
  const point = o.jourPoint ? `notre Point du ${jjmmaaaa(o.jourPoint)}` : 'notre Point (introuvable chez nous)'
  const demandes = o.demandes.length
    ? o.demandes.map((d) => `- ${d.commande}${d.article ? ` (${d.article})` : ''}`).join('\n')
    : '(aucune)'
  return `Date du mail : ${jjmmaaaa(o.dateMail.slice(0, 10))}\n\nDans ${point}, nous demandions ${o.quoi === 'délai' ? 'le délai de ces commandes' : 'les contrôles de ces commandes ou lots'} :\n${demandes}\n\nRéponse de l'ennoblisseur :\n<<<\n${o.texte}\n>>>`
}

export async function lireDelaisIa(prompt: { model: string; prompt: string }, user: string): Promise<{ lecture: LectureDelais; usd: number }> {
  const r = await chatJson({ model: prompt.model || LECTURE_MODELE, system: prompt.prompt, user, schemaName: 'delais_reponse_point', schema: SCHEMA_DELAIS })
  const d = r.data as { repond_au_point?: boolean; commandes?: Array<Partial<DelaiLu>> }
  return {
    usd: r.usd,
    lecture: {
      repondAuPoint: !!d.repond_au_point,
      commandes: (d.commandes ?? []).map((c) => ({
        commande: String(c.commande ?? '').trim(),
        citation: String(c.citation ?? '').trim(),
        nommee: !!c.nommee,
        date: typeof c.date === 'string' ? c.date : null,
        certain: c.certain !== false,
        raison: String(c.raison ?? '').trim(),
      })).filter((c) => c.commande || c.citation),
    },
  }
}

export async function lireControlesIa(prompt: { model: string; prompt: string }, user: string): Promise<{ lots: ControleIa[]; usd: number }> {
  const r = await chatJson({ model: prompt.model || LECTURE_MODELE, system: prompt.prompt, user, schemaName: 'controles_reponse_point', schema: SCHEMA_CONTROLES })
  const d = r.data as { lots?: Array<Record<string, unknown>> }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    usd: r.usd,
    lots: (d.lots ?? []).map((l) => ({
      lot: String(l.lot ?? '').trim(),
      citation: String(l.citation ?? '').trim(),
      laize: num(l.laize), poids: num(l.poids), stabH: num(l.stabH), stabL: num(l.stabL), vrillage: num(l.vrillage),
      plusTard: !!l.plus_tard,
      certain: l.certain !== false,
      raison: String(l.raison ?? '').trim(),
    })),
  }
}

// ── The code checks (pure) ───────────────────────────────

const plier = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[«»"“”‘’']/g, '').replace(/\s+/g, ' ').trim()

/** The passage the model quotes is in the mail (case, accents, quotes and spacing aside). */
export const citationDansMail = (citation: string, texte: string) => !!citation.trim() && plier(texte).includes(plier(citation))

const chiffres = (s: string) => s.replace(/\D/g, '')
const jjmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

/** A délai the code reads for sure in a quoted passage (« s 49 », « cde 9086 s 49 », « 5) 02/12 »), else null. */
export function relireDelai(citation: string, dateMail: string): string | null {
  const t = citation.trim().replace(/^[1-6]\s*\)\s*/, '').replace(/^(?:pour\s+)?le\s+reste\s*:?\s*/i, '')
  const { commandes, reste } = commandesNommees(t)
  return lireDelai(commandes.length ? reste : t, dateMail)
}

/** One point of the Délais skill once checked: the question it answers (null =
 *  an order the Point did not ask), what was read, and the code's doubt. */
export interface DelaiVerifie {
  question: QuestionDelai | null
  commande: string
  /** The passage quoted ('' = no answer for this order). */
  texte: string
  nommee: boolean
  /** 'YYYY-MM-DD': read for sure, or proposed with the doubt. */
  delai: string | null
  /** Why a person must look (null = the reading holds; the line's rules come after). */
  doute: string | null
}

/** Each question of the Point with what the model read for it, checked. Orders
 *  the model read that the Point did not ask come last, always an aide. Pure. */
export function verifierDelais(questions: readonly QuestionDelai[], lecture: LectureDelais, texte: string, dateMail: string): DelaiVerifie[] {
  const parCommande = new Map<string, DelaiLu>()
  for (const c of lecture.commandes) if (chiffres(c.commande)) parCommande.set(chiffres(c.commande), c)
  const verifier = (lu: DelaiLu, question: QuestionDelai | null): DelaiVerifie => {
    const date = lu.date && /^\d{4}-\d{2}-\d{2}$/.test(lu.date) && !Number.isNaN(Date.parse(lu.date)) ? lu.date : null
    const v: DelaiVerifie = { question, commande: question?.commande ?? lu.commande, texte: lu.citation, nommee: lu.nommee, delai: date, doute: null }
    if (!question) { v.doute = `La commande ${lu.commande} n’était pas demandée dans ce Point.`; return v }
    if (!citationDansMail(lu.citation, texte)) { v.doute = `Je ne retrouve pas « ${lu.citation || '(rien)'} » dans le mail.`; return v }
    if (!lu.certain) { v.doute = lu.raison || 'Je ne suis pas sûr de ma lecture.'; return v }
    if (!date) { v.doute = lu.raison || `Je ne lis pas de date dans « ${lu.citation} ».`; return v }
    const code = relireDelai(lu.citation, dateMail)
    if (code && code !== date) { v.delai = code; v.doute = `Je lis « ${lu.citation} » comme le ${jjmm(code)}, pas le ${jjmm(date)} : vérifie.` }
    return v
  }
  const out: DelaiVerifie[] = questions.map((q) => {
    const lu = parCommande.get(chiffres(q.commande))
    return lu ? verifier(lu, q) : { question: q, commande: q.commande, texte: '', nommee: false, delai: null, doute: null }
  })
  const demandees = new Set(questions.map((q) => chiffres(q.commande)))
  for (const [k, lu] of parCommande) if (!demandees.has(k)) out.push(verifier(lu, null))
  return out
}

/** Each lot the model read, checked, in the shape the rest of the skill
 *  matches to suivilot (ControleLu: `doute` = a person must look). Pure. */
export function verifierControles(lots: readonly ControleIa[], texte: string): ControleLu[] {
  const out: ControleLu[] = []
  for (const l of lots) {
    const lot = chiffres(l.lot)
    const c: ControleLu = {
      lot,
      laize: l.plusTard ? null : l.laize,
      poids: l.plusTard ? null : l.poids,
      stabH: l.plusTard ? null : l.stabH,
      stabL: l.plusTard ? null : l.stabL,
      vrillage: l.plusTard ? null : l.vrillage,
      texte: l.citation,
    }
    const doute = (() => {
      if (lot.length < 5 || lot.length > 7) return `Je ne lis pas de numéro de lot dans « ${l.lot || l.citation} ».`
      if (!citationDansMail(l.citation, texte)) return `Je ne retrouve pas « ${l.citation || '(rien)'} » dans le mail.`
      if (!l.certain) return l.raison || 'Je ne suis pas sûr de ma lecture.'
      if (l.plusTard) return null
      // MATEL's line, read again by the code: its own doubt, or a disagreement.
      const code = lireControles([l.citation]).find((x) => x.lot === lot)
      if (!code) return null
      if (code.doute) return code.doute
      const ecarts = (['laize', 'poids', 'stabH', 'stabL', 'vrillage'] as const)
        .filter((k) => code[k] != null && code[k] !== c[k])
        .map((k) => `${LIBELLE_MESURE[k]} ${code[k]} (lu ${c[k] ?? '?'})`)
      return ecarts.length ? `Je relis la ligne autrement : ${ecarts.join(', ')}.` : null
    })()
    if (doute) c.doute = doute
    out.push(c)
  }
  return out
}

const LIBELLE_MESURE = { laize: 'laize', poids: 'poids', stabH: 'stabilité h', stabL: 'stabilité l', vrillage: 'vrillage' } as const
