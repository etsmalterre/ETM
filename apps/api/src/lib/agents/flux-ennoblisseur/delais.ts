// Flux Ennoblisseur › Délais (and Contrôles, essai) — a dyer's reply to our
// « Point du JJ/MM » (claude_doc/agents_autonomie.md §7).
//
// One mail → one run per skill exercised (`competence: 'delais' | 'controles'`).
// Délais: each order the Point asked in §5 gets one point — a saisie (the
// délai read for sure, written on the line), an aide (Tricobot asks, with
// what it would have written) or nothing (the line already says it). A reply
// with no §5 to a Point that asked one is ONE « rien » for the mail: a person
// confirms nothing was missed. Only replies to a Point are read for now.
//
// Contrôles: §2's measures are read and matched to their lot, in essai ONLY
// (nothing written): the write to suivilot and its revue in Suivi lots come next.
//
// Every doubt comes from the code: an answer that is not a week or a date, an
// order the Point did not ask, a line already dated otherwise, a date in the
// past or more than 6 months away. The model is only asked for a PROPOSAL on
// what the code could not read — the point stays an aide.

import type { Sql } from 'postgres'
import { mpsPg } from '../../mps-pg.js'
import { query } from '../../hfsql-auto.js'
import { chatJson } from '../../mistral.js'
import { sansCitation, type MessageComplet } from '../../gmail-reader.js'
import { isLineDone, STATUT_ATTENTE_DELAI } from '../../sst-shared.js'
import { ajouterRun, nouvelIdRun, type AgentRun, type Auteur, type RunSource, type RunStatut } from '../store.js'
import type { ModeCompetence } from '../competences.js'
import { estReponsePoint, jourDuPoint, lireControles, repondreDelais, sections, type ControleLu, type QuestionDelai } from './reponse-point.js'
import { aDesMesures, ecrireDelai, ecrireMesures, enregistrerSaisie, lireEtatLigne, lireMesuresLot, texteMesures, TRICOBOT, type EtatLigne, type MesuresSst } from './saisies.js'

/** The Délais skill's behaviour version (its prompt lives here, not in the
 *  agent's Prompt tab — which is the BL's). Bump with any rule change: its
 *  measures restart. */
export const DELAIS_VERSION = 1
export const CONTROLES_VERSION = 1
export const DELAIS_MODELE = 'mistral-small-latest'

/** Beyond this many days, a délai is checked by a person. */
export const DELAI_MAX_J = 180

export interface PointDelai {
  commande: string
  idcommande: number
  idligne: number
  article: string
  /** The answer that applies to this order ('' = none). */
  reponse: string
  /** The answer names the order; false = a bare answer for all of §5. */
  nommee?: boolean
  decision: 'saisie' | 'aide' | 'aucune'
  /** 'YYYY-MM-DD': written (saisie) or proposed (aide). */
  delai: string | null
  explication: string
  saisieId?: number
}

export interface ControleRapproche extends ControleLu {
  idsuivilot: number | null
  lotEtm: string | null
  idcommande?: number
  idligne?: number
  /** The lot's order line was in the Point's §2 (« Puis-je avoir vos contrôles… »). */
  demande?: boolean
  /** The measures already on the lot, dyer side. */
  actuel: MesuresSst | null
  /** What the reply gives (null: announced later). */
  mesures?: MesuresSst | null
  decision?: 'saisie' | 'aide' | 'aucune'
  explication: string
  saisieId?: number
}

export interface ResultatFlux {
  jourPoint: string | null
  idpoint: number | null
  /** The mail body without its quoted history (« Voir le mail »). */
  texte: string
  sections: Record<string, string[]>
  delais?: PointDelai[]
  controles?: ControleRapproche[]
}

const jourParis = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date())
const plusJours = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const jjmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`
const versIso = (d: string) => (/^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null)

/** The §5 questions of the Point sent that day to that dyer. */
async function questionsDuPoint(idsst: number, jour: string, sql: Sql): Promise<{ idpoint: number; questions: QuestionDelai[] } | null> {
  const [p] = await sql<{ id: number }[]>`
    SELECT idpoint_sst AS id FROM point_sst WHERE idsous_traitant = ${idsst} AND jour = ${jour}::date AND statut = 'envoye'`
  if (!p) return null
  const lignes = await sql<{ commande: string; cmd: number; lig: number; reference: string; coloris: string }[]>`
    SELECT commande, idcommande_sous_traitant AS cmd, idligne_commande_sous_traitant AS lig, reference, coloris
    FROM point_sst_ligne WHERE idpoint_sst = ${p.id} AND section = 5 AND NOT retiree
      AND COALESCE(cle, '') NOT LIKE 'reprise:%' ORDER BY ordre`
  const questions: QuestionDelai[] = []
  for (const l of lignes) {
    const idcommande = Number(l.cmd) || Number(String(l.commande).replace(/\D/g, '')) || 0
    const article = [l.reference, l.coloris].map((x) => String(x ?? '').trim()).filter(Boolean).join(' - ')
    if (Number(l.lig) > 0) { questions.push({ commande: String(l.commande).trim(), idcommande, idligne: Number(l.lig), article }); continue }
    // A line typed by hand in the Point: every line of the order still waiting.
    if (!idcommande) { questions.push({ commande: String(l.commande).trim(), idcommande: 0, idligne: 0, article }); continue }
    // Its lines waiting for a délai; none left (answered since), every line not
    // done: the answer is then compared with the délai already there.
    const lignesCmd = await query<{ id: number; sstatut: string | null }>(
      `SELECT IDligne_commande_sous_traitant AS id, sstatut FROM ligne_commande_sous_traitant WHERE IDcommande_sous_traitant = ${idcommande}`,
    )
    const enAttente = lignesCmd.filter((x) => String(x.sstatut ?? '').trim() === STATUT_ATTENTE_DELAI)
    const visees = enAttente.length ? enAttente : lignesCmd.filter((x) => !isLineDone(x.sstatut))
    if (!visees.length) questions.push({ commande: String(idcommande), idcommande, idligne: 0, article })
    for (const x of visees) questions.push({ commande: String(idcommande), idcommande, idligne: Number(x.id), article })
  }
  return { idpoint: Number(p.id), questions }
}

/** The model's proposal for the answers the code could not read. Never decides. */
async function propositions(aLire: Array<{ commande: string; reponse: string }>, dateMail: string): Promise<{ map: Map<string, { delai: string | null; explication: string }>; usd: number }> {
  const map = new Map<string, { delai: string | null; explication: string }>()
  if (!aLire.length) return { map, usd: 0 }
  try {
    const r = await chatJson({
      model: DELAIS_MODELE,
      system: `Tu aides ETS Malterre à lire les délais que son ennoblisseur donne en réponse à son « Point du jour ». Pour chaque commande, propose la date de fin (YYYY-MM-DD) qu'une personne saisirait. Règles de la maison : « s N » = le mercredi de la semaine ISO N ; « début de semaine » = lundi, « mi-semaine » = mercredi, « fin de semaine » = vendredi ; « semaine prochaine » = la semaine qui suit la date du mail. « fini », « soldé » ou une réponse qui n'est pas un délai : date null. Si tu n'es pas sûr, date null et dis pourquoi. Le mail est du ${dateMail.slice(0, 10)}.`,
      user: aLire.map((a) => `Commande ${a.commande} : « ${a.reponse} »`).join('\n'),
      schemaName: 'propositions_delais',
      schema: {
        type: 'object', additionalProperties: false, required: ['commandes'],
        properties: {
          commandes: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false, required: ['commande', 'date', 'explication'],
              properties: { commande: { type: 'string' }, date: { type: ['string', 'null'] }, explication: { type: 'string' } },
            },
          },
        },
      },
    })
    for (const c of (r.data as { commandes?: Array<{ commande: string; date: string | null; explication: string }> }).commandes ?? []) {
      map.set(String(c.commande), { delai: c.date && /^\d{4}-\d{2}-\d{2}$/.test(c.date) ? c.date : null, explication: c.explication ?? '' })
    }
    return { map, usd: r.usd }
  } catch (e) {
    console.error('[flux-ennoblisseur] délais: proposal failed', e)
    return { map, usd: 0 }
  }
}

/** Why a délai read for sure still goes to a person, or null. */
function doute(delai: string, e: EtatLigne | null, aujourdhui: string): string | null {
  if (!e) return 'Ligne de commande introuvable.'
  if (isLineDone(e.sstatut)) return 'La ligne est terminée.'
  if (delai < aujourdhui) return `Le délai lu (${jjmm(delai)}) est déjà passé.`
  if (delai > plusJours(aujourdhui, DELAI_MAX_J)) return `Le délai lu (${jjmm(delai)}) est à plus de 6 mois.`
  const actuel = versIso(e.dateLivraison)
  if (e.sstatut !== STATUT_ATTENTE_DELAI && actuel && actuel !== delai) return `La ligne a déjà un délai au ${jjmm(actuel)}, la réponse dit le ${jjmm(delai)}.`
  return null
}

export interface ContexteFlux {
  /** Effective mode of each skill for this mail (agent mode essai = essai). */
  delais: ModeCompetence
  controles: ModeCompetence
  /** Drawn for this execution (Délais in autonomie): done alone. */
  tirerSeul: () => Promise<boolean>
  /** Same for the Contrôles skill. */
  tirerSeulControles: () => Promise<boolean>
  source: RunSource
  lancePar: Auteur | null
  slug: string
  idsousTraitant: number | null
}

/** One mail of a dyer: the Délais and Contrôles runs it gives (none when it
 *  is not a reply to a Point, or both skills are off). Runs are stored. */
export async function traiterReponsePoint(m: MessageComplet, ctx: ContexteFlux): Promise<AgentRun[]> {
  if (!estReponsePoint(m.sujet) || !ctx.idsousTraitant) return []
  if (ctx.delais === 'off' && ctx.controles === 'off') return []
  const t0 = Date.now()
  const sql = mpsPg()
  const texte = sansCitation(m.texte)
  const secs = sections(texte)
  const jour = jourDuPoint(m.sujet, m.date)
  const point = jour ? await questionsDuPoint(ctx.idsousTraitant, jour, sql) : null
  const message = { id: m.id, threadId: m.threadId, de: m.de, sujet: m.sujet, date: m.date }
  const base = (competence: string, version: number, mode: ModeCompetence) => ({
    id: nouvelIdRun(), slug: ctx.slug, createdAt: new Date().toISOString(), source: ctx.source,
    mode: (mode === 'essai' ? 'essai' : 'actif') as AgentRun['mode'], lancePar: ctx.lancePar, message, fichiers: [],
    version, model: DELAIS_MODELE, competence,
  })
  const commun: ResultatFlux = { jourPoint: jour, idpoint: point?.idpoint ?? null, texte, sections: Object.fromEntries([...secs].map(([k, v]) => [String(k), v])) }
  const runs: AgentRun[] = []

  if (ctx.delais !== 'off') runs.push(await delais(m, ctx, secs, point, commun, base('delais', DELAIS_VERSION, ctx.delais), t0))
  if (ctx.controles !== 'off' && secs.has(2)) runs.push(await controles(m, ctx, secs.get(2)!, commun, base('controles', CONTROLES_VERSION, ctx.controles), t0, sql))
  for (const r of runs) await ajouterRun(r)
  return runs
}

async function delais(
  m: MessageComplet,
  ctx: ContexteFlux,
  secs: Map<number, string[]>,
  point: { idpoint: number; questions: QuestionDelai[] } | null,
  commun: ResultatFlux,
  b: Omit<AgentRun, 'statut' | 'resultat' | 'resume' | 'coutUsd' | 'dureeMs'>,
  t0: number,
): Promise<AgentRun> {
  const aujourdhui = jourParis()
  const questions = point?.questions ?? []
  const lignes5 = secs.get(5) ?? []
  const points: PointDelai[] = []
  let usd = 0

  if (!point && lignes5.length) {
    points.push({ commande: '', idcommande: 0, idligne: 0, article: '', reponse: lignes5.join(' '), decision: 'aide', delai: null, explication: `Point du ${commun.jourPoint ? jjmm(commun.jourPoint) : '?'} introuvable : je ne sais pas à quelles commandes s’applique la réponse.` })
  }
  const reponses = repondreDelais(questions, lignes5, m.date)
  const nonLues = reponses.filter((r) => r.texte && !r.delai)
  const prop = await propositions(nonLues.map((r) => ({ commande: r.question.commande, reponse: r.texte })), m.date)
  usd += prop.usd
  for (const r of reponses) {
    const q = r.question
    const p: PointDelai = { commande: q.commande, idcommande: q.idcommande, idligne: q.idligne, article: q.article, reponse: r.texte, nommee: r.nommee, decision: 'aucune', delai: null, explication: '' }
    if (!r.texte) { p.explication = lignes5.length ? 'Pas de réponse pour cette commande.' : ''; points.push(p); continue }
    if (!q.idligne) { p.decision = 'aide'; p.explication = `Aucune ligne de la commande ${q.commande} n’attend de délai.`; points.push(p); continue }
    const etat = await lireEtatLigne(q.idligne)
    if (!r.delai) {
      const x = prop.map.get(q.commande)
      p.decision = 'aide'
      p.delai = x?.delai ?? null
      p.explication = `Je ne sais pas lire « ${r.texte} » comme un délai${x?.explication ? ` — ${x.explication}` : ''}.`
      points.push(p)
      continue
    }
    p.delai = r.delai
    const d = doute(r.delai, etat, aujourdhui)
    if (d) { p.decision = 'aide'; p.explication = d }
    else if (etat && etat.sstatut !== STATUT_ATTENTE_DELAI && versIso(etat.dateLivraison) === r.delai) { p.explication = 'La ligne porte déjà ce délai.' }
    else { p.decision = 'saisie'; p.explication = `« ${r.texte} » = mercredi ${jjmm(r.delai)} (s N = mercredi de la semaine).` }
    points.push(p)
  }

  // What is written, and how (doctrine §2: supervisé writes and waits; autonomie draws).
  const mode = ctx.delais
  const ecrit = mode === 'supervise' || mode === 'autonomie'
  const aSaisir = points.filter((p) => p.decision === 'saisie')
  const seul = ecrit && mode === 'autonomie' && aSaisir.length > 0 ? await ctx.tirerSeul() : false
  // A reply that answers the Point (numbered sections) but gives no §5 while
  // the Point asked délais: ONE « rien » for the mail, a person confirms. A mail
  // of the thread with no section at all (a conversation, 02/11 on the vrillage)
  // answers nothing: no point.
  const rien = !!point && point.questions.length > 0 && secs.size > 0 && lignes5.length === 0
  let erreur: string | undefined
  if (ecrit) {
    try {
      for (const p of points) {
        if (p.decision === 'aucune') continue
        // Supervisé: nothing is written until a person validates (doctrine §2,
        // Vincent 2026-11-05) — only a point done alone writes now.
        let etatAvant: EtatLigne | null = null
        if (p.decision === 'saisie' && seul) etatAvant = await ecrireDelai(p.idligne, p.delai!, TRICOBOT)
        const avantLigne = etatAvant ?? (p.idligne > 0 ? await lireEtatLigne(p.idligne) : null)
        p.saisieId = await enregistrerSaisie({
          agent: b.slug, competence: 'delais', version: DELAIS_VERSION, runId: b.id, messageId: m.id, threadId: m.threadId,
          mode: seul ? 'autonome' : 'supervise', decision: p.decision, idsousTraitant: ctx.idsousTraitant ?? 0,
          idcommande: p.idcommande, idligne: p.idligne, champ: 'date_livraison',
          valeurAvant: avantLigne ? versIso(avantLigne.dateLivraison) : null, etatAvant: etatAvant as unknown as Record<string, unknown> | null,
          proposition: p.delai, ecrit: p.decision === 'saisie' && seul, explication: p.explication, citation: p.reponse,
        })
      }
      if (rien) {
        await enregistrerSaisie({
          agent: b.slug, competence: 'delais', version: DELAIS_VERSION, runId: b.id, messageId: m.id, threadId: m.threadId,
          mode: 'supervise', decision: 'rien', idsousTraitant: ctx.idsousTraitant ?? 0, idcommande: 0, idligne: 0, champ: null,
          valeurAvant: null, etatAvant: null, proposition: null, ecrit: false,
          explication: `Le Point du ${jjmm(commun.jourPoint!)} demandait ${point!.questions.length} délai${point!.questions.length > 1 ? 's' : ''} ; la réponse n’en donne aucun.`,
          citation: '',
        })
      }
    } catch (e) {
      erreur = e instanceof Error ? e.message : String(e)
    }
  }
  const nS = points.filter((p) => p.decision === 'saisie').length
  const nA = points.filter((p) => p.decision === 'aide').length
  const statut: RunStatut = erreur ? 'erreur' : !ecrit ? (nS || nA ? 'simule' : 'rien_a_signaler') : nA ? 'a_verifier' : nS ? 'ecrit' : 'rien_a_signaler'
  const resume = [
    `Délais · Point du ${commun.jourPoint ? jjmm(commun.jourPoint) : '?'}`,
    nS ? `${nS} délai${nS > 1 ? 's' : ''} ${ecrit ? 'saisi' : 'lu'}${nS > 1 ? 's' : ''}${seul ? ' seul' : ''}` : null,
    nA ? `${nA} à trancher` : null,
    !nS && !nA ? (rien ? 'aucun délai dans la réponse' : 'rien à saisir') : null,
    !ecrit ? '(essai)' : null,
  ].filter(Boolean).join(' · ')
  return { ...b, statut, erreur, resultat: { ...commun, delais: points } as unknown as Record<string, unknown>, resume, coutUsd: usd, dureeMs: Date.now() - t0 }
}

/** A control line the reader doubted (a stabilité letter twice, one missing). */
const c_doute = (r: ControleRapproche) => !!r.doute

async function controles(
  m: MessageComplet,
  ctx: ContexteFlux,
  lignes: string[],
  commun: ResultatFlux,
  b: Omit<AgentRun, 'statut' | 'resultat' | 'resume' | 'coutUsd' | 'dureeMs'>,
  t0: number,
  sql: Sql,
): Promise<AgentRun> {
  const lus = lireControles(lignes)
  // The order lines the Point asked controls for (§2): said in the reasoning.
  const demandees = commun.idpoint
    ? new Set((await sql<{ lig: number }[]>`
        SELECT idligne_commande_sous_traitant AS lig FROM point_sst_ligne
        WHERE idpoint_sst = ${commun.idpoint} AND section = 2 AND NOT retiree`).map((r) => Number(r.lig)).filter((x) => x > 0))
    : new Set<number>()
  const out: ControleRapproche[] = []
  for (const c of lus) {
    // « 109516 » is MA109516: the number alone, never inside a longer one.
    const [l] = await sql<{ idsuivilot: number; lot: string; cmd: number; lig: number; etat: number }[]>`
      SELECT idsuivilot, lot::text AS lot, COALESCE(idcommande_sous_traitant, 0) AS cmd, COALESCE(idligne_commande_sous_traitant, 0) AS lig,
             COALESCE(idetatlot, 0) AS etat
      FROM suivilot WHERE lot::text ~* ${'(^|[^0-9])' + c.lot + '([^0-9]|$)'} ORDER BY idsuivilot DESC LIMIT 1`
    const actuel = l ? await lireMesuresLot(Number(l.idsuivilot), sql) : null
    const lu: MesuresSst | null = c.laize != null || c.poids != null || c.stabH != null || c.stabL != null || c.vrillage != null
      ? { laize: c.laize ?? 0, poids: c.poids ?? 0, stabH: c.stabH ?? 0, stabL: c.stabL ?? 0, vrillage: c.vrillage }
      : null
    const r: ControleRapproche = {
      ...c,
      idsuivilot: l ? Number(l.idsuivilot) : null,
      lotEtm: l?.lot ?? null,
      idcommande: l ? Number(l.cmd) : 0,
      idligne: l ? Number(l.lig) : 0,
      demande: !!l && demandees.has(Number(l.lig)),
      actuel,
      decision: 'aucune',
      explication: '',
    }
    if (!lu) r.explication = 'Pas encore de mesures : annoncées plus tard.'
    // A validated (3) or shipped (4) lot is closed: its controls are history, never rewritten.
    else if (l && (Number(l.etat) === 3 || Number(l.etat) === 4)) r.explication = 'Le lot est déjà validé : je n’y touche pas.'
    else if (c.doute) { r.decision = 'aide'; r.explication = c.doute }
    else if (!l) { r.decision = 'aide'; r.explication = `Le lot ${c.lot} n’existe pas dans Suivi lots.` }
    else if (actuel && aDesMesures(actuel) && texteMesures(actuel) !== texteMesures(lu)) {
      r.decision = 'aide'
      r.explication = `Le lot porte déjà d’autres mesures de l’ennoblisseur (laize ${actuel.laize}, poids ${actuel.poids}) : je ne les remplace pas sans toi.`
    } else if (actuel && texteMesures(actuel) === texteMesures(lu)) r.explication = 'Le lot porte déjà ces mesures.'
    else {
      r.decision = 'saisie'
      r.explication = `Laize ${lu.laize} cm, poids ${lu.poids} g/m², stabilités ${lu.stabH} / ${lu.stabL}${lu.vrillage != null ? `, vrillage ${lu.vrillage} %` : ''} : à reporter côté ennoblisseur.`
    }
    r.mesures = lu
    out.push(r)
  }

  // Written as in the Délais skill: supervisé writes and waits, autonomie draws (doctrine §2).
  const mode = ctx.controles
  const ecrit = mode === 'supervise' || mode === 'autonomie'
  const seul = ecrit && mode === 'autonomie' && out.some((r) => r.decision === 'saisie') ? await ctx.tirerSeulControles() : false
  let erreur: string | undefined
  if (ecrit) {
    try {
      for (const r of out) {
        if (r.decision === 'aucune' || !r.mesures) continue
        // Supervisé proposes; only a point done alone writes now (doctrine §2).
        const avant = r.decision === 'saisie' && r.idsuivilot && seul ? await ecrireMesures(r.idsuivilot, r.mesures, sql) : null
        r.saisieId = await enregistrerSaisie({
          agent: b.slug, competence: 'controles', version: CONTROLES_VERSION, runId: b.id, messageId: m.id, threadId: m.threadId,
          mode: seul ? 'autonome' : 'supervise', decision: r.decision as 'saisie' | 'aide', idsousTraitant: ctx.idsousTraitant ?? 0,
          idcommande: r.idcommande ?? 0, idligne: r.idligne ?? 0, idsuivilot: r.idsuivilot ?? 0, champ: 'mesures_sst',
          valeurAvant: avant ? texteMesures(avant) : (r.actuel ? texteMesures(r.actuel) : null),
          etatAvant: avant as unknown as Record<string, unknown> | null,
          // A doubtful line proposes only what it read: what it could not read stays null (« ? »).
          proposition: c_doute(r) ? JSON.stringify({ laize: r.laize, poids: r.poids, stabH: r.stabH, stabL: r.stabL, vrillage: r.vrillage }) : texteMesures(r.mesures),
          ecrit: r.decision === 'saisie' && seul, explication: r.explication, citation: r.texte,
        })
      }
    } catch (e) {
      erreur = e instanceof Error ? e.message : String(e)
    }
  }
  const nS = out.filter((r) => r.decision === 'saisie').length
  const nA = out.filter((r) => r.decision === 'aide').length
  const statut: RunStatut = erreur ? 'erreur' : !ecrit ? (nS || nA ? 'simule' : 'rien_a_signaler') : nA ? 'a_verifier' : nS ? 'ecrit' : 'rien_a_signaler'
  return {
    ...b, statut, erreur, model: '',
    resultat: { ...commun, controles: out } as unknown as Record<string, unknown>,
    resume: [
      `Contrôles · Point du ${commun.jourPoint ? jjmm(commun.jourPoint) : '?'}`,
      nS ? `${nS} lot${nS > 1 ? 's' : ''} ${ecrit ? 'saisi' : 'lu'}${nS > 1 ? 's' : ''}${seul ? ' seul' : ''}` : null,
      nA ? `${nA} à trancher` : null,
      !nS && !nA ? 'rien à saisir' : null,
      !ecrit ? '(essai)' : null,
    ].filter(Boolean).join(' · '),
    coutUsd: 0, dureeMs: Date.now() - t0,
  }
}
