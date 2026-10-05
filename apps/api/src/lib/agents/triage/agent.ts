// Agent « Triage » — the top agent of contact@etsmalterre.com (decision
// Vincent 2026-10-05, inspired by MFProd's email-classifier). Every mail the
// mailbox receives is given one or more categories (categories.ts) by
// Mistral, labelled in Gmail under ETM/, and handed to the agent behind its
// category (transmission.ts: BL Ennoblisseur, Factures Ennoblisseur).
//
// Pipeline per mail: the whole thread (lireFil — the two messages before give
// context) → the sender's company from ETM's contacts (annuaire.ts) → one
// chatJson call with the categories as a strict enum (prompt.ts) → in
// « actif »: hand-off, then the Gmail labels (the sub-category of a BL or an
// invoice is the dyer the agent behind recognised).
//
// ⚠️ Scored « correct by default »: nobody confirms a triage. A person
// corrects the categories in Agents IA › Exécutions (correction.ts — the
// Triage's work IS the triage, so it is corrected there, by exception to
// « feedback where the work is done »), with why = échec. A correction hands
// the mail to the agent of a new category (MFProd's gap: it never did).
//
// What is read: received mail only (never what contact@ sent), from
// `startedAt` and at most the last 7 days — the listing is paged, so a burst
// never pushes a mail out of reach (MFProd looked at the latest 50). A mail
// whose triage fails is retried on the next polls, 3 times at most.
//
// Mode « essai » classifies and stores the run, and writes nothing: no
// label, no hand-off.

import { chatJson } from '../../mistral.js'
import {
  ajouterLibelle,
  assurerLibelle,
  lireFil,
  listerTousMessages,
  retirerLibelle,
  type MessageComplet,
} from '../../gmail-reader.js'
import {
  ajouterRun,
  lireRuns,
  modifierRun,
  nouvelIdRun,
  type AgentMode,
  type AgentRun,
  type AgentState,
  type AgentVersion,
  type Auteur,
  type RunSource,
  type VersionInitiale,
} from '../store.js'
import { TRIAGE_BOITE, TRIAGE_SLUG } from './constantes.js'
import { categorie, libelleGmail, normaliserCategories, type Categorie } from './categories.js'
import { adresseDe, annuaire, identifier, type Organisation } from './annuaire.js'
import { entreeTriage, TRIAGE_PROMPT_V1, TRIAGE_SCHEMA, type ReponseTriage } from './prompt.js'
import { DESTINATAIRES, sousCategorie, transmettre, type Destinataire, type Transmission } from './transmission.js'

export { TRIAGE_SLUG, TRIAGE_BOITE }

export const TRIAGE_VERSION_INITIALE: VersionInitiale = {
  model: 'mistral-small-latest',
  prompt: TRIAGE_PROMPT_V1,
  note: 'Version initiale — 14 catégories, calibrées sur une semaine de contact@ (29/09 – 05/10/2026).',
}

/** A new mail older than this is never triaged (the agent was off, or it is a backfill). */
const FENETRE_MS = 7 * 86_400_000
/** Mails triaged per poll, oldest first (the rest waits for the next minute). */
const MAX_PAR_RELEVE = 25
/** A triage or a hand-off that fails is retried this many times in all. */
const MAX_TENTATIVES = 3

export interface CorrectionTriage {
  avant: string[]
  apres: string[]
  commentaire: string
  par: Auteur
  le: string
}

/** What a Triage run stores in `resultat` (read by the web screen). The mail
 *  body is NOT stored (it stays in Gmail, GET /runs/:id/mail reads it). */
export interface ResultatTriage {
  expediteur: { adresse: string; organisation: Organisation | null }
  a: string
  cc: string
  piecesJointes: string[]
  /** The first lines of the body, for the list's tooltip. */
  extrait: string
  raison: string
  /** What the model chose. */
  categoriesAgent: string[]
  /** What stands (the model's, or a person's correction). */
  categories: string[]
  sousCategories: Record<string, string | null>
  transmissions: Transmission[]
  /** Gmail label names applied (actif only). */
  libelles: string[]
  erreurLibelles: string | null
  corrections: CorrectionTriage[]
}

export const resultatTriage = (r: AgentRun) => r.resultat as unknown as ResultatTriage

const libellesCategories = (cles: readonly string[]) => cles.map((c) => categorie(c)?.libelle ?? c)

export function resumeTriage(res: Pick<ResultatTriage, 'categories' | 'sousCategories'>, sujet: string): string {
  const cats = res.categories.map((c) => {
    const sc = res.sousCategories[c]
    return `${categorie(c)?.libelle ?? c}${sc ? ` (${sc})` : ''}`
  })
  return `${cats.join(' + ')} — ${sujet || '(sans objet)'}`
}

// ── Gmail labels ─────────────────────────────────────────

/** Set the mail's ETM/ labels to `voulus`: add the missing ones, remove those
 *  of the previous triage that no longer stand. Best effort: returns the
 *  labels now on the mail and the error, if any. */
async function poserLibelles(messageId: string, voulus: readonly string[], avant: readonly string[]): Promise<{ libelles: string[]; erreur: string | null }> {
  try {
    for (const nom of avant.filter((x) => !voulus.includes(x))) await retirerLibelle(TRIAGE_BOITE, messageId, await assurerLibelle(TRIAGE_BOITE, nom))
    for (const nom of voulus.filter((x) => !avant.includes(x))) await ajouterLibelle(TRIAGE_BOITE, messageId, await assurerLibelle(TRIAGE_BOITE, nom))
    return { libelles: [...voulus], erreur: null }
  } catch (err) {
    const erreur = err instanceof Error ? err.message : String(err)
    console.error(`[agents] triage: labels failed for ${messageId}:`, erreur)
    return { libelles: [...avant], erreur }
  }
}

/** Labels, sub-categories and hand-offs of a set of categories on one mail.
 *  Hands over only the categories not handed yet (`deja`). */
async function appliquer(
  cles: readonly string[],
  messageId: string,
  org: Organisation | null,
  deja: readonly Transmission[],
  par: Auteur | null,
  message: MessageComplet | undefined,
  destinataires: Record<string, Destinataire>,
): Promise<{ transmissions: Transmission[]; sousCategories: Record<string, string | null> }> {
  const transmissions: Transmission[] = []
  const cats = cles.map(categorie).filter((c): c is Categorie => !!c)
  for (const c of cats) {
    if (!c.cible) continue
    const fait = deja.some((t) => t.agent === c.cible && (t.statut === 'transmis' || t.statut === 'deja_traite'))
    if (!fait) transmissions.push(await transmettre(c, messageId, par, message, destinataires))
  }
  const toutes = [...deja, ...transmissions]
  const sousCategories: Record<string, string | null> = {}
  for (const c of cats) sousCategories[c.cle] = await sousCategorie(c, org, toutes, destinataires)
  return { transmissions, sousCategories }
}

// ── One mail ─────────────────────────────────────────────

export interface ContexteTriage {
  mode: AgentMode
  version: AgentVersion
  source: RunSource
  lancePar: Auteur | null
  /** Replay: the run is returned, never stored, nothing written (mode must be essai). */
  simulation?: boolean
  destinataires?: Record<string, Destinataire>
}

/** Triage one message of the mailbox. Throws when Gmail or Mistral fails (the
 *  poll records an « erreur » run). */
export async function trierMessage(messageId: string, threadId: string, ctx: ContexteTriage): Promise<AgentRun> {
  if (ctx.simulation && ctx.mode === 'actif') throw new Error('simulation en mode actif')
  const t0 = Date.now()
  const fil = await lireFil(TRIAGE_BOITE, threadId)
  const i = fil.findIndex((x) => x.id === messageId)
  if (i < 0) throw new Error(`message ${messageId} introuvable dans son fil`)
  const m = fil[i]
  const org = identifier(m.de, await annuaire())
  const r = await chatJson({
    model: ctx.version.model,
    system: ctx.version.prompt,
    user: entreeTriage(m, org, fil.slice(0, i)),
    schemaName: 'triage_mail',
    schema: TRIAGE_SCHEMA,
  })
  const rep = r.data as Partial<ReponseTriage>
  const categories = normaliserCategories(rep.categories ?? [])
  const res: ResultatTriage = {
    expediteur: { adresse: adresseDe(m.de), organisation: org },
    a: m.a,
    cc: m.cc,
    piecesJointes: m.piecesJointes.map((p) => p.nom),
    extrait: m.texte.replace(/\s+/g, ' ').slice(0, 300),
    raison: String(rep.raison ?? '').trim(),
    categoriesAgent: categories,
    categories,
    sousCategories: {},
    transmissions: [],
    libelles: [],
    erreurLibelles: null,
    corrections: [],
  }
  const id = nouvelIdRun()
  const destinataires = ctx.destinataires ?? DESTINATAIRES
  if (ctx.mode === 'actif') {
    const a = await appliquer(categories, m.id, org, [], ctx.lancePar, m, destinataires)
    res.transmissions = a.transmissions
    res.sousCategories = a.sousCategories
    const l = await poserLibelles(m.id, categories.map((c) => libelleGmail(categorie(c)!, a.sousCategories[c])), [])
    res.libelles = l.libelles
    res.erreurLibelles = l.erreur
  } else {
    // essai: the sub-category from the sender only (no agent read the PDF).
    for (const c of categories) res.sousCategories[c] = await sousCategorie(categorie(c)!, org, [], destinataires)
  }
  const run: AgentRun = {
    id,
    slug: TRIAGE_SLUG,
    createdAt: new Date().toISOString(),
    source: ctx.source,
    mode: ctx.mode,
    lancePar: ctx.lancePar,
    message: { id: m.id, threadId: m.threadId, de: m.de, sujet: m.sujet, date: m.date },
    fichiers: [],
    version: ctx.version.version,
    model: ctx.version.model,
    statut: 'trie',
    resultat: res as unknown as Record<string, unknown>,
    resume: resumeTriage(res, m.sujet),
    coutUsd: r.usd,
    dureeMs: Date.now() - t0,
  }
  if (!ctx.simulation) await ajouterRun(run)
  return run
}

// ── Mailbox polling ──────────────────────────────────────

/** The mails a poll must (still) triage: not triaged yet, or only failed
 *  fewer than MAX_TENTATIVES times. Pure (tests). */
export function aTrier(ids: ReadonlyArray<{ id: string; threadId: string }>, runs: readonly AgentRun[]): Array<{ id: string; threadId: string }> {
  const echecs = new Map<string, number>()
  const faits = new Set<string>()
  for (const r of runs) {
    const mid = r.message?.id
    if (!mid) continue
    if (r.statut === 'erreur') echecs.set(mid, (echecs.get(mid) ?? 0) + 1)
    else faits.add(mid)
  }
  return ids.filter((x) => !faits.has(x.id) && (echecs.get(x.id) ?? 0) < MAX_TENTATIVES)
}

/** Read the mailbox: every new received mail since the agent started (7 days
 *  at most), oldest first, MAX_PAR_RELEVE per poll. */
export async function sonderBoite(state: AgentState, version: AgentVersion, lancePar: Auteur | null = null): Promise<AgentRun[]> {
  if (state.mode === 'off' || !state.startedAt) return []
  const depuis = Math.max(new Date(state.startedAt).getTime(), Date.now() - FENETRE_MS)
  const q = `after:${Math.floor(depuis / 1000)} -in:sent -in:drafts -in:chats -in:spam -in:trash`
  const liste = await listerTousMessages(TRIAGE_BOITE, q, 2000)
  const nouveaux = aTrier(liste, await lireRuns(TRIAGE_SLUG)).reverse().slice(0, MAX_PAR_RELEVE)
  const runs: AgentRun[] = []
  for (const x of nouveaux) {
    try {
      runs.push(await trierMessage(x.id, x.threadId, { mode: state.mode, version, source: 'gmail', lancePar }))
    } catch (err) {
      const erreur = err instanceof Error ? err.message : String(err)
      console.error(`[agents] triage: ${x.id} failed:`, erreur)
      const run: AgentRun = {
        id: nouvelIdRun(), slug: TRIAGE_SLUG, createdAt: new Date().toISOString(), source: 'gmail', mode: state.mode, lancePar,
        message: { id: x.id, threadId: x.threadId, de: '', sujet: '', date: '' }, fichiers: [], version: version.version, model: version.model,
        statut: 'erreur', erreur, resultat: {}, resume: `Tri impossible : ${erreur.slice(0, 200)}`, coutUsd: 0, dureeMs: 0,
      }
      await ajouterRun(run)
      runs.push(run)
    }
  }
  if (state.mode === 'actif') await relancer(lancePar)
  return runs
}

/** Hand-offs that failed (the agent behind crashed, Gmail timed out) are
 *  retried on the next polls, for 3 days, MAX_TENTATIVES times in all. */
async function relancer(par: Auteur | null, destinataires: Record<string, Destinataire> = DESTINATAIRES): Promise<void> {
  const limite = Date.now() - 3 * 86_400_000
  const runs = (await lireRuns(TRIAGE_SLUG)).filter((r) => r.mode === 'actif' && Date.parse(r.createdAt) > limite
    && resultatTriage(r).transmissions?.some((t) => t.statut === 'erreur' && t.tentatives < MAX_TENTATIVES))
  for (const r of runs) {
    const res = resultatTriage(r)
    const nouvelles: Transmission[] = []
    for (const t of res.transmissions) {
      const c = categorie(t.categorie)
      if (t.statut !== 'erreur' || t.tentatives >= MAX_TENTATIVES || !c || !res.categories.includes(c.cle)) { nouvelles.push(t); continue }
      nouvelles.push(await transmettre(c, r.message!.id, par, undefined, destinataires, t.tentatives + 1))
    }
    const sousCategories: Record<string, string | null> = {}
    for (const cle of res.categories) sousCategories[cle] = await sousCategorie(categorie(cle)!, res.expediteur.organisation, nouvelles, destinataires)
    const l = await poserLibelles(r.message!.id, res.categories.map((c) => libelleGmail(categorie(c)!, sousCategories[c])), res.libelles)
    await modifierRun(TRIAGE_SLUG, r.id, (x) => {
      const y = resultatTriage(x)
      y.transmissions = nouvelles
      y.sousCategories = sousCategories
      y.libelles = l.libelles
      y.erreurLibelles = l.erreur
      x.resume = resumeTriage(y, x.message?.sujet ?? '')
    })
  }
}

// ── Correction ───────────────────────────────────────────

export class CorrectionInvalide extends Error {}

const memes = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x))

/** A person changes a run's categories (Agents IA › Exécutions). The new
 *  categories stand, the Gmail labels follow, and a new category's agent
 *  gets the mail (an « actif » run only). The score: échec with why — back to
 *  the model's own categories = the correction is withdrawn (no score).
 *  What an agent already did for a category now removed is NOT undone: the
 *  answer lists it (`dejaTraites`) for the person to handle there. */
export async function corrigerTriage(
  runId: string,
  cles: readonly string[],
  commentaire: string,
  par: Auteur,
  destinataires: Record<string, Destinataire> = DESTINATAIRES,
): Promise<{ run: AgentRun; dejaTraites: Transmission[] } | null> {
  const avant = (await lireRuns(TRIAGE_SLUG)).find((r) => r.id === runId)
  if (!avant) return null
  if (avant.statut !== 'trie') throw new CorrectionInvalide('Seul un mail trié se corrige.')
  const res = resultatTriage(avant)
  const apres = normaliserCategories(cles)
  if (memes(apres, res.categories)) throw new CorrectionInvalide('Ce sont déjà ses catégories.')
  const retour = memes(apres, res.categoriesAgent)
  if (!retour && !commentaire.trim()) throw new CorrectionInvalide('Une correction de Tricobot se donne avec un pourquoi.')
  const messageId = avant.message!.id
  const org = res.expediteur.organisation

  let transmissions: Transmission[] = []
  let sousCategories: Record<string, string | null>
  let libelles = res.libelles
  let erreurLibelles = res.erreurLibelles
  if (avant.mode === 'actif') {
    const a = await appliquer(apres, messageId, org, res.transmissions, par, undefined, destinataires)
    transmissions = a.transmissions
    sousCategories = a.sousCategories
    const l = await poserLibelles(messageId, apres.map((c) => libelleGmail(categorie(c)!, sousCategories[c])), res.libelles)
    libelles = l.libelles
    erreurLibelles = l.erreur
  } else {
    sousCategories = {}
    for (const c of apres) sousCategories[c] = await sousCategorie(categorie(c)!, org, res.transmissions, destinataires)
  }
  const dejaTraites = res.transmissions.filter((t) => t.statut === 'transmis' && !apres.includes(t.categorie))
  const le = new Date().toISOString()
  const run = await modifierRun(TRIAGE_SLUG, runId, (x) => {
    const y = resultatTriage(x)
    y.corrections = [...(y.corrections ?? []), { avant: y.categories, apres, commentaire: commentaire.trim(), par, le }]
    y.categories = apres
    y.sousCategories = sousCategories
    y.transmissions = [...y.transmissions, ...transmissions]
    y.libelles = libelles
    y.erreurLibelles = erreurLibelles
    x.resume = resumeTriage(y, x.message?.sujet ?? '')
    // The score lives on the run (lib/agents/retours.ts shape): binary, the
    // why is what the next prompt version is written from.
    x.evaluation = retour ? null : { note: 'echec', commentaire: commentaire.trim(), par, le }
  })
  if (!run) return null
  console.log(`[agents] triage: run ${runId} corrected by ${par.nom}: ${libellesCategories(res.categories).join(' + ')} → ${libellesCategories(apres).join(' + ')}`)
  return { run, dejaTraites }
}
