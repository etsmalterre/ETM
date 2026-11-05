// Flux Ennoblisseur › Délais and Contrôles — a dyer's reply to our
// « Point du JJ/MM » (claude_doc/agents_autonomie.md §0 and §7).
//
// One mail → one run per skill exercised (`competence: 'delais' | 'controles'`).
// Since v2 (2026-11-05) the model reads, the code checks (lecture.ts): each
// skill has its own prompt version (AgentState.promptsCompetences), the model
// reads the whole reply whatever the partner, and the code keeps the last word.
//
// Délais: each order the Point asked gets one point — a saisie (the délai read
// for sure, proposed or written on the line), an aide (Tricobot asks, with what
// it would have written) or nothing (no answer, or the line already says it).
// A reply that answers the Point but gives no délai while the Point asked some
// is ONE « rien » for the mail: a person confirms nothing was missed.
//
// Contrôles: the measures the reply gives per lot, matched to their lot
// (suivilot), written dyer side the same way (supervisé proposes, autonomie draws).
//
// `deciderDelais` / `deciderControles` read and decide WITHOUT writing: the run
// and the replay of a draft prompt (rejeu.ts) share them.
//
// A skill in « observation » (mode essai, Vincent 2026-11-05) writes nothing and
// shows nothing, but records each point in saisie_agent (mode and statut
// 'observation'): the value a person types afterwards on the line or the lot
// judges it (saisies.ts comparerObservations), so the skill arrives in
// supervisé with measures already.

import type { Sql } from 'postgres'
import { mpsPg } from '../../mps-pg.js'
import { query } from '../../hfsql-auto.js'
import { sansCitation, type MessageComplet } from '../../gmail-reader.js'
import { isLineDone, STATUT_ATTENTE_DELAI } from '../../sst-shared.js'
import { ajouterRun, nouvelIdRun, type AgentRun, type AgentVersion, type Auteur, type RunSource, type RunStatut } from '../store.js'
import type { ModeCompetence } from '../competences.js'
import { estReponsePoint, jourDuPoint, sections, type ControleLu, type QuestionDelai } from './reponse-point.js'
import { lireControlesIa, lireDelaisIa, messageLecture, verifierControles, verifierDelais } from './lecture.js'
import { aDesMesures, ecrireDelai, ecrireMesures, enregistrerSaisie, lireEtatLigne, lireMesuresLot, texteMesures, TRICOBOT, type EtatLigne, type MesuresSst } from './saisies.js'

/** Beyond this many days, a délai is checked by a person. */
export const DELAI_MAX_J = 180

export interface PointDelai {
  commande: string
  idcommande: number
  idligne: number
  article: string
  /** The passage of the reply that answers this order ('' = none). */
  reponse: string
  /** The answer names the order; false = one answer for several orders. */
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
  /** The mail body without its quoted history (« Voir le mail »), what the model read. */
  texte: string
  /** MATEL's numbered sections, for display only (the model reads `texte`). */
  sections: Record<string, string[]>
  /** The mail's date (the replay reads « s N » against it). Absent before 2026-11-05. */
  dateMail?: string
  delais?: PointDelai[]
  controles?: ControleRapproche[]
}

const jourParis = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date())
const plusJours = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)
const jjmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`
const versIso = (d: string) => (/^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null)
const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']
const jourSemaine = (iso: string) => JOURS[new Date(`${iso}T12:00:00Z`).getUTCDay()]

/** The Point sent that day to that dyer, or null. */
export async function pointDuJour(idsst: number, jour: string, sql: Sql = mpsPg()): Promise<number | null> {
  const [p] = await sql<{ id: number }[]>`
    SELECT idpoint_sst AS id FROM point_sst WHERE idsous_traitant = ${idsst} AND jour = ${jour}::date AND statut = 'envoye'`
  return p ? Number(p.id) : null
}

/** The §5 questions of a Point. */
export async function questionsDuPoint(idpoint: number, sql: Sql = mpsPg()): Promise<QuestionDelai[]> {
  const lignes = await sql<{ commande: string; cmd: number; lig: number; reference: string; coloris: string }[]>`
    SELECT commande, idcommande_sous_traitant AS cmd, idligne_commande_sous_traitant AS lig, reference, coloris
    FROM point_sst_ligne WHERE idpoint_sst = ${idpoint} AND section = 5 AND NOT retiree
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
  return questions
}

/** The §2 lines of a Point (what we asked controls for): the order lines, and what the model is told. */
async function demandesControles(idpoint: number | null, sql: Sql): Promise<{ lignes: Set<number>; demandes: Array<{ commande: string; article: string }> }> {
  if (!idpoint) return { lignes: new Set(), demandes: [] }
  const rows = await sql<{ lig: number; commande: string; reference: string; coloris: string; commentaire: string }[]>`
    SELECT idligne_commande_sous_traitant AS lig, commande, reference, coloris, commentaire FROM point_sst_ligne
    WHERE idpoint_sst = ${idpoint} AND section = 2 AND NOT retiree ORDER BY ordre`
  return {
    lignes: new Set(rows.map((r) => Number(r.lig)).filter((x) => x > 0)),
    demandes: rows.map((r) => ({
      commande: String(r.commande ?? '').trim() || '(sans commande)',
      article: [r.reference, r.coloris, r.commentaire].map((x) => String(x ?? '').trim()).filter(Boolean).join(' - '),
    })),
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

/** What both skills read: the reply, its date, the Point it answers. */
export interface EntreeFlux {
  texte: string
  dateMail: string
  jourPoint: string | null
  idpoint: number | null
}

/** Délais: read with the skill's prompt, checked, decided. Writes nothing. */
export async function deciderDelais(e: EntreeFlux, prompt: Pick<AgentVersion, 'model' | 'prompt'>, aujourdhui = jourParis()): Promise<{ points: PointDelai[]; rien: boolean; usd: number }> {
  const questions = e.idpoint ? await questionsDuPoint(e.idpoint) : []
  const { lecture, usd } = await lireDelaisIa(prompt, messageLecture({
    dateMail: e.dateMail, jourPoint: e.jourPoint, quoi: 'délai', texte: e.texte,
    demandes: [...new Map(questions.map((q) => [q.commande, { commande: q.commande, article: q.article }])).values()],
  }))
  const points: PointDelai[] = []
  for (const v of verifierDelais(questions, lecture, e.texte, e.dateMail)) {
    const q = v.question
    const p: PointDelai = { commande: v.commande, idcommande: q?.idcommande ?? 0, idligne: q?.idligne ?? 0, article: q?.article ?? '', reponse: v.texte, nommee: v.nommee, decision: 'aucune', delai: null, explication: '' }
    if (!v.texte && q) { p.explication = lecture.commandes.length ? 'Pas de réponse pour cette commande.' : ''; points.push(p); continue }
    if (!e.idpoint) {
      p.decision = 'aide'; p.delai = v.delai
      p.explication = `Point du ${e.jourPoint ? jjmm(e.jourPoint) : '?'} introuvable : je ne sais pas à quelle commande s’applique « ${v.texte} ».`
      points.push(p); continue
    }
    if (v.doute) { p.decision = 'aide'; p.delai = v.delai; p.explication = v.doute; points.push(p); continue }
    if (!q!.idligne) { p.decision = 'aide'; p.delai = v.delai; p.explication = `Aucune ligne de la commande ${q!.commande} n’attend de délai.`; points.push(p); continue }
    const etat = await lireEtatLigne(q!.idligne)
    p.delai = v.delai
    const d = doute(v.delai!, etat, aujourdhui)
    if (d) { p.decision = 'aide'; p.explication = d }
    else if (etat && etat.sstatut !== STATUT_ATTENTE_DELAI && versIso(etat.dateLivraison) === v.delai) p.explication = 'La ligne porte déjà ce délai.'
    else { p.decision = 'saisie'; p.explication = `« ${v.texte} » : ${jourSemaine(v.delai!)} ${jjmm(v.delai!)}.` }
    points.push(p)
  }
  // A reply to the Point (the model says so) that answers none of its délais:
  // ONE « rien » for the mail. A conversation in the thread answers nothing: no point.
  const rien = !!e.idpoint && questions.length > 0 && lecture.repondAuPoint && !points.some((p) => p.reponse)
  return { points, rien, usd }
}

/** Contrôles: read with the skill's prompt, checked, matched to their lot. Writes nothing. */
export async function deciderControles(e: EntreeFlux, prompt: Pick<AgentVersion, 'model' | 'prompt'>, sql: Sql = mpsPg()): Promise<{ controles: ControleRapproche[]; usd: number }> {
  const { lignes: demandees, demandes } = await demandesControles(e.idpoint, sql)
  const { lots, usd } = await lireControlesIa(prompt, messageLecture({ dateMail: e.dateMail, jourPoint: e.jourPoint, quoi: 'contrôles', texte: e.texte, demandes }))
  const out: ControleRapproche[] = []
  for (const c of verifierControles(lots, e.texte)) {
    // « 109516 » is MA109516: the number alone, never inside a longer one.
    const [l] = c.lot ? await sql<{ idsuivilot: number; lot: string; cmd: number; lig: number; etat: number }[]>`
      SELECT idsuivilot, lot::text AS lot, COALESCE(idcommande_sous_traitant, 0) AS cmd, COALESCE(idligne_commande_sous_traitant, 0) AS lig,
             COALESCE(idetatlot, 0) AS etat
      FROM suivilot WHERE lot::text ~* ${'(^|[^0-9])' + c.lot + '([^0-9]|$)'} ORDER BY idsuivilot DESC LIMIT 1` : []
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
    // A validated (3) or shipped (4) lot is closed: its controls are history, never rewritten.
    if (l && (Number(l.etat) === 3 || Number(l.etat) === 4)) r.explication = 'Le lot est déjà validé : je n’y touche pas.'
    else if (c.doute) { r.decision = 'aide'; r.explication = c.doute }
    else if (!lu) r.explication = 'Pas encore de mesures : annoncées plus tard.'
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
  return { controles: out, usd }
}

// ── A mail → runs ────────────────────────────────────────

export interface ContexteFlux {
  /** Effective mode of each skill for this mail (agent mode essai = essai). */
  delais: ModeCompetence
  controles: ModeCompetence
  /** Each skill's active prompt version (AgentState.promptsCompetences). */
  promptDelais: AgentVersion
  promptControles: AgentVersion
  /** Drawn for this execution (Délais in autonomie): done alone. */
  tirerSeul: () => Promise<boolean>
  /** Same for the Contrôles skill. */
  tirerSeulControles: () => Promise<boolean>
  source: RunSource
  lancePar: Auteur | null
  slug: string
  idsousTraitant: number | null
}

type Base = Omit<AgentRun, 'statut' | 'resultat' | 'resume' | 'coutUsd' | 'dureeMs'>

/** One mail of a dyer: the Délais and Contrôles runs it gives (none when it
 *  is not a reply to a Point, or both skills are off). Runs are stored. */
export async function traiterReponsePoint(m: MessageComplet, ctx: ContexteFlux): Promise<AgentRun[]> {
  if (!estReponsePoint(m.sujet) || !ctx.idsousTraitant) return []
  if (ctx.delais === 'off' && ctx.controles === 'off') return []
  const t0 = Date.now()
  const sql = mpsPg()
  const texte = sansCitation(m.texte)
  const jour = jourDuPoint(m.sujet, m.date)
  const idpoint = jour ? await pointDuJour(ctx.idsousTraitant, jour, sql) : null
  const message = { id: m.id, threadId: m.threadId, de: m.de, sujet: m.sujet, date: m.date }
  const base = (competence: string, v: AgentVersion, mode: ModeCompetence): Base => ({
    id: nouvelIdRun(), slug: ctx.slug, createdAt: new Date().toISOString(), source: ctx.source,
    mode: (mode === 'essai' ? 'essai' : 'actif') as AgentRun['mode'], lancePar: ctx.lancePar, message, fichiers: [],
    version: v.version, model: v.model, competence,
  })
  const entree: EntreeFlux = { texte, dateMail: m.date, jourPoint: jour, idpoint }
  const commun: ResultatFlux = { jourPoint: jour, idpoint, texte, dateMail: m.date, sections: Object.fromEntries([...sections(texte)].map(([k, v]) => [String(k), v])) }
  const runs: AgentRun[] = []
  const enErreur = (b: Base, quoi: string, e: unknown): AgentRun => ({
    ...b, statut: 'erreur', erreur: e instanceof Error ? e.message : String(e), resultat: { ...commun },
    resume: `${quoi} · Point du ${jour ? jjmm(jour) : '?'} · lecture impossible`, coutUsd: 0, dureeMs: Date.now() - t0,
  })

  if (ctx.delais !== 'off') {
    const b = base('delais', ctx.promptDelais, ctx.delais)
    try { runs.push(await delais(m, ctx, await deciderDelais(entree, ctx.promptDelais), commun, b, t0)) }
    catch (e) { runs.push(enErreur(b, 'Délais', e)) }
  }
  if (ctx.controles !== 'off') {
    const b = base('controles', ctx.promptControles, ctx.controles)
    try {
      const d = await deciderControles(entree, ctx.promptControles, sql)
      // No lot in the reply: no run (a reply without controls is the usual case).
      if (d.controles.length) runs.push(await controles(m, ctx, d, commun, b, t0, sql))
    } catch (e) { runs.push(enErreur(b, 'Contrôles', e)) }
  }
  for (const r of runs) await ajouterRun(r)
  return runs
}

async function delais(
  m: MessageComplet,
  ctx: ContexteFlux,
  d: { points: PointDelai[]; rien: boolean; usd: number },
  commun: ResultatFlux,
  b: Base,
  t0: number,
): Promise<AgentRun> {
  const { points, rien } = d
  // What is written, and how (doctrine §2: supervisé proposes; autonomie draws).
  const mode = ctx.delais
  const ecrit = mode === 'supervise' || mode === 'autonomie'
  const observation = mode === 'essai'
  const aSaisir = points.filter((p) => p.decision === 'saisie')
  const seul = ecrit && mode === 'autonomie' && aSaisir.length > 0 ? await ctx.tirerSeul() : false
  let erreur: string | undefined
  if (observation) {
    // Recorded, invisible: the délai a person types on the line will judge each point.
    try {
      for (const p of points) {
        if (p.decision === 'aucune' || !p.idligne) continue
        const avant = await lireEtatLigne(p.idligne)
        p.saisieId = await enregistrerSaisie({
          agent: b.slug, competence: 'delais', version: b.version, runId: b.id, messageId: m.id, threadId: m.threadId,
          mode: 'observation', decision: p.decision, idsousTraitant: ctx.idsousTraitant ?? 0,
          idcommande: p.idcommande, idligne: p.idligne, champ: 'date_livraison',
          valeurAvant: avant ? versIso(avant.dateLivraison) : null, etatAvant: null,
          proposition: p.delai, ecrit: false, explication: p.explication, citation: p.reponse,
        })
      }
    } catch (e) {
      erreur = e instanceof Error ? e.message : String(e)
    }
  }
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
          agent: b.slug, competence: 'delais', version: b.version, runId: b.id, messageId: m.id, threadId: m.threadId,
          mode: seul ? 'autonome' : 'supervise', decision: p.decision, idsousTraitant: ctx.idsousTraitant ?? 0,
          idcommande: p.idcommande, idligne: p.idligne, champ: 'date_livraison',
          valeurAvant: avantLigne ? versIso(avantLigne.dateLivraison) : null, etatAvant: etatAvant as unknown as Record<string, unknown> | null,
          proposition: p.delai, ecrit: p.decision === 'saisie' && seul, explication: p.explication, citation: p.reponse,
        })
      }
      if (rien) {
        const n = points.length
        await enregistrerSaisie({
          agent: b.slug, competence: 'delais', version: b.version, runId: b.id, messageId: m.id, threadId: m.threadId,
          mode: 'supervise', decision: 'rien', idsousTraitant: ctx.idsousTraitant ?? 0, idcommande: 0, idligne: 0, champ: null,
          valeurAvant: null, etatAvant: null, proposition: null, ecrit: false,
          explication: `Le Point du ${jjmm(commun.jourPoint!)} demandait ${n} délai${n > 1 ? 's' : ''} ; la réponse n’en donne aucun.`,
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
    !ecrit ? '(observation)' : null,
  ].filter(Boolean).join(' · ')
  return { ...b, statut, erreur, resultat: { ...commun, delais: points } as unknown as Record<string, unknown>, resume, coutUsd: d.usd, dureeMs: Date.now() - t0 }
}

async function controles(
  m: MessageComplet,
  ctx: ContexteFlux,
  d: { controles: ControleRapproche[]; usd: number },
  commun: ResultatFlux,
  b: Base,
  t0: number,
  sql: Sql,
): Promise<AgentRun> {
  const out = d.controles
  // Written as in the Délais skill: supervisé proposes, autonomie draws (doctrine §2).
  const mode = ctx.controles
  const ecrit = mode === 'supervise' || mode === 'autonomie'
  const seul = ecrit && mode === 'autonomie' && out.some((r) => r.decision === 'saisie') ? await ctx.tirerSeulControles() : false
  let erreur: string | undefined
  if (mode === 'essai') {
    // Observation: recorded, invisible; the measures a person types on Suivi lots will judge each lot.
    try {
      for (const r of out) {
        if (r.decision === 'aucune' || !r.idsuivilot) continue
        r.saisieId = await enregistrerSaisie({
          agent: b.slug, competence: 'controles', version: b.version, runId: b.id, messageId: m.id, threadId: m.threadId,
          mode: 'observation', decision: r.decision as 'saisie' | 'aide', idsousTraitant: ctx.idsousTraitant ?? 0,
          idcommande: r.idcommande ?? 0, idligne: r.idligne ?? 0, idsuivilot: r.idsuivilot, champ: 'mesures_sst',
          valeurAvant: r.actuel ? texteMesures(r.actuel) : null, etatAvant: null,
          proposition: r.decision === 'aide' || !r.mesures
            ? JSON.stringify({ laize: r.laize, poids: r.poids, stabH: r.stabH, stabL: r.stabL, vrillage: r.vrillage })
            : texteMesures(r.mesures),
          ecrit: false, explication: r.explication, citation: r.texte,
        })
      }
    } catch (e) {
      erreur = e instanceof Error ? e.message : String(e)
    }
  }
  if (ecrit) {
    try {
      for (const r of out) {
        if (r.decision === 'aucune') continue
        // A saisie without measures cannot happen; an aide without (an unreadable line) is still asked.
        if (!r.mesures && r.decision === 'saisie') continue
        // Supervisé proposes; only a point done alone writes now (doctrine §2).
        const avant = r.decision === 'saisie' && r.idsuivilot && seul ? await ecrireMesures(r.idsuivilot, r.mesures!, sql) : null
        r.saisieId = await enregistrerSaisie({
          agent: b.slug, competence: 'controles', version: b.version, runId: b.id, messageId: m.id, threadId: m.threadId,
          mode: seul ? 'autonome' : 'supervise', decision: r.decision as 'saisie' | 'aide', idsousTraitant: ctx.idsousTraitant ?? 0,
          idcommande: r.idcommande ?? 0, idligne: r.idligne ?? 0, idsuivilot: r.idsuivilot ?? 0, champ: 'mesures_sst',
          valeurAvant: avant ? texteMesures(avant) : (r.actuel ? texteMesures(r.actuel) : null),
          etatAvant: avant as unknown as Record<string, unknown> | null,
          // An aide proposes only what was read: what was not stays null (« ? »).
          proposition: r.decision === 'aide' || !r.mesures
            ? JSON.stringify({ laize: r.laize, poids: r.poids, stabH: r.stabH, stabL: r.stabL, vrillage: r.vrillage })
            : texteMesures(r.mesures),
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
    ...b, statut, erreur,
    resultat: { ...commun, controles: out } as unknown as Record<string, unknown>,
    resume: [
      `Contrôles · Point du ${commun.jourPoint ? jjmm(commun.jourPoint) : '?'}`,
      nS ? `${nS} lot${nS > 1 ? 's' : ''} ${ecrit ? 'saisi' : 'lu'}${nS > 1 ? 's' : ''}${seul ? ' seul' : ''}` : null,
      nA ? `${nA} à trancher` : null,
      !nS && !nA ? 'rien à saisir' : null,
      !ecrit ? '(observation)' : null,
    ].filter(Boolean).join(' · '),
    coutUsd: d.usd, dureeMs: Date.now() - t0,
  }
}
