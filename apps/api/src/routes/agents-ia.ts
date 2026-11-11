// « Agents IA » — /api/agents-ia (ETM) and /api/agents-ia-trm (TRM). The
// screen Agents IA › Agents (ETM apps/web pages/AgentsIa.tsx, imported by TRM)
// reads and pilots the agents of lib/agents/.
//
// One route set, mounted once per app (createAgentsIaRouter): each mount lists
// only its app's agents and checks its app's permission store
// (lib/agents/app-scope.ts) — an agent of the other app answers 404.
//
// Reads need a session only (the menu `screen_agents_ia` is the curtain);
// every write needs `edit_agents_ia`, checked here — there is no global auth
// middleware, an unguarded route is anonymous.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { query, queryRaw, fixEncoding } from '../lib/hfsql-auto.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { agentDef, agentsDe, type AgentDef } from '../lib/agents/catalog.js'
import { avecScope, scopeDe, type AgentsIaScope, type DroitIa } from '../lib/agents/app-scope.js'
import {
  AGENT_MODES,
  activerVersion,
  changerMode,
  changerOption,
  optionDe,
  lireEtat,
  lireFichier,
  lireRun,
  lireRuns,
  modifierRun,
  estPublie,
  publierVersion,
  versionActive,
  type AgentMode,
  type AgentRun,
  type AgentState,
  type Auteur,
  type Evaluation,
  type Note,
} from '../lib/agents/store.js'
import { etatSondage, lancerSondage, prochainQuotidien, SondageEnCoursError } from '../lib/agents/scheduler.js'
import { SUPERVISEUR_SLUG, type ResultatSuperviseur } from '../lib/agents/superviseur/superviseur.js'
import { notesDuBilan } from '../lib/agents/superviseur/score.js'
import { formerTricobot, traiterPoint, TraitementInvalide } from '../lib/agents/superviseur/points.js'
import { lireHistorique, versionDesPoints } from '../lib/agents/superviseur/historique.js'
import { CHAT_MODELS } from '../lib/mistral.js'
import { gmailLectureErreur, lireFil, lirePieceJointe } from '../lib/gmail-reader.js'
import { corrigerTriage, CorrectionInvalide, TRIAGE_BOITE, TRIAGE_SLUG } from '../lib/agents/triage/agent.js'
import { CATEGORIES } from '../lib/agents/triage/categories.js'
import { BL_ENNOBLISSEUR_SLUG, etiqueterVerifie } from '../lib/agents/bl-ennoblisseur.js'
import { rouleauxEnStock, type RouleauEnStock } from '../lib/agents/bl-ennoblisseur-db.js'
import { comparerObservationsBl } from '../lib/agents/bl-observation.js'
import { bilanObservation, bilanObservationBl, type BilanObservation } from '../lib/agents/flux-ennoblisseur/observation.js'
import { DESTINATAIRES } from '../lib/agents/triage/transmission.js'
import { relaisTriage } from '../lib/agents/triage/relais.js'
import { apportMesures, conseiller, libelleEtat, mesurer, MODES_COMPETENCE, FENETRE_DEFAUT, type ModeCompetence } from '../lib/agents/competences.js'
import { activerVersionCompetence, changerModeCompetence, etatCompetence, modePlafonne, noteBinaire, publierVersionCompetence, reglerCycle } from '../lib/agents/store.js'
import { competenceDuRun, pointsBl, versionsDeCompetence } from '../lib/agents/flux-ennoblisseur/competences-flux.js'
import { mailsDuFlux } from '../lib/agents/flux-ennoblisseur/mails.js'
import { NOTE_MAX } from '../lib/agents/notes-courtes.js'
import { pointDe, saisiesDeCompetence, saisiesDeRuns, type Saisie } from '../lib/agents/flux-ennoblisseur/saisies.js'
import { rejouer, REJEU_MAX } from '../lib/agents/flux-ennoblisseur/rejeu.js'
import type { ResultatFlux } from '../lib/agents/flux-ennoblisseur/delais.js'

const routes: RouterType = Router()

/** The router of one app's « Agents IA › Agents » (index.ts mounts ETM's and TRM's). */
export function createAgentsIaRouter(scope: AgentsIaScope): RouterType {
  return Router().use(avecScope(scope), routes)
}

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } })

// ── helpers ──────────────────────────────────────────────

/** Also used by routes/automates.ts (Agents IA › Automates). */
export async function auteur(userId: number): Promise<Auteur> {
  try {
    const rows = await query<Record<string, unknown>>(
      `SELECT IDutilisateur, prenom, nom FROM utilisateur WHERE IDutilisateur = ${Math.trunc(userId)}`,
    )
    const fixed = await fixEncoding(rows, 'utilisateur', 'IDutilisateur', ['prenom', 'nom'])
    const nom = [fixed[0]?.prenom, fixed[0]?.nom].map((v) => String(v ?? '').trim()).filter(Boolean).join(' ')
    return { id: userId, nom: nom || `Utilisateur #${userId}` }
  } catch {
    return { id: userId, nom: `Utilisateur #${userId}` }
  }
}

/** 401 without a session. */
export function session(req: Request, res: Response): number | null {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return null
  }
  return req.userId
}

/** Whether the caller holds a right in the store of the mount's app. */
function aLeDroit(req: Request, res: Response, id: number, droit: DroitIa): Promise<boolean> {
  return scopeDe(res).aLeDroit(id, isEffectiveAdmin(req), droit)
}

/** 401 / 403 unless the caller may pilot agents (and automates). */
export async function pilote(req: Request, res: Response): Promise<number | null> {
  const id = session(req, res)
  if (id === null) return null
  if (!(await aLeDroit(req, res, id, 'edit_agents_ia'))) {
    res.status(403).json({ error: 'permission denied: edit_agents_ia' })
    return null
  }
  return id
}

/** 401 / 403 unless the caller may handle points from the Notifications
 *  widget: the scoring right, or the widget with its Superviseur
 *  sub-permission (dashboard_notifications + dashboard_notif_superviseur). */
async function traiteurPoints(req: Request, res: Response): Promise<number | null> {
  const id = session(req, res)
  if (id === null) return null
  const [evalue, widget, sousDroit] = await Promise.all([
    aLeDroit(req, res, id, 'evaluer_agents_ia'),
    aLeDroit(req, res, id, 'dashboard_notifications'),
    aLeDroit(req, res, id, 'dashboard_notif_superviseur'),
  ])
  if (!evalue && !(widget && sousDroit)) {
    res.status(403).json({ error: 'permission denied: dashboard_notif_superviseur' })
    return null
  }
  return id
}

/** The mode shown and accepted: an agent that does not offer « essai » (it
 *  would change nothing — Superviseur) runs the same in it as in « actif »,
 *  so a state left in essai from before reads as actif. */
function modeAffiche(def: AgentDef, mode: AgentMode): AgentMode {
  return mode === 'off' || def.modes[mode] ? mode : 'actif'
}

function agentOu404(req: Request, res: Response): AgentDef | null {
  const def = agentDef(req.params.slug, scopeDe(res).app)
  if (!def) res.status(404).json({ error: 'agent inconnu' })
  return def ?? null
}

/** True for a run of the version in service — of its skill, for an agent whose
 *  skills have their own prompt (Flux Ennoblisseur › Délais, Contrôles). */
function enService(def: AgentDef, state: AgentState): (r: AgentRun) => boolean {
  if (!def.competences?.length) return (r) => r.version === state.activeVersion
  const actives = new Map(def.competences.map((c) => [c.cle, versionsDeCompetence(c, state).activeVersion]))
  return (r) => r.version === actives.get(competenceDuRun(r))
}

function statistiques(def: AgentDef, runs: AgentRun[], state: AgentState) {
  // Stats cover the active version only (MFProd rule): a new prompt starts a new score.
  const courant = enService(def, state)
  const actifs = runs.filter((r) => courant(r) && r.source !== 'essai_manuel')
  const parStatut: Record<string, number> = {}
  for (const r of actifs) parStatut[r.statut] = (parStatut[r.statut] ?? 0) + 1
  const note = (n: Note) => actifs.filter((r) => r.evaluation?.note === n).length
  // Correct by default (Triage): an uncorrected run is a réussite, never « à évaluer ».
  const evalues = def.confianceParDefaut ? actifs.filter((r) => r.statut !== 'erreur') : actifs
  return {
    total: actifs.length,
    parStatut,
    evaluations: def.confianceParDefaut
      ? { reussite: evalues.length - note('echec'), echec: note('echec'), aEvaluer: 0 }
      : {
          reussite: note('reussite'),
          echec: note('echec'),
          aEvaluer: actifs.filter((r) => !r.evaluation).length,
        },
    /** Point-scored agents (Superviseur): the score of every finding the
     *  version raised — the number a prompt version is judged on. */
    points: def.points ? def.points.score(actifs) : null,
    coutUsd: actifs.reduce((s, r) => s + (r.coutUsd || 0), 0),
    dernierRun: runs.length ? runs[runs.length - 1].createdAt : null,
    dernierControle: dernierControle(runs),
  }
}

/** Daily agents: how the last SCHEDULED run went — the only place a failed
 *  morning shows since the Superviseur's points list replaced its reports
 *  (2026-10-06). A run can succeed while some of its checks failed. */
function dernierControle(runs: AgentRun[]) {
  const r = [...runs].reverse().find((x) => x.source === 'planifie')
  if (!r) return null
  const controles = (r.resultat as { controles?: Array<{ libelle: string; erreur: string | null }> } | null)?.controles ?? []
  return {
    le: r.createdAt,
    erreur: r.statut === 'erreur' ? (r.erreur ?? 'Erreur inconnue') : null,
    controlesEnErreur: controles.filter((c) => c.erreur).map((c) => ({ libelle: c.libelle, erreur: c.erreur as string })),
  }
}

/** Délais / Contrôles: where a run's points stand (saisie_agent). */
function jugementDuRun(ss: readonly Saisie[]) {
  return {
    aRevoir: ss.filter((s) => s.statut === 'a_revoir').length,
    autonomes: ss.filter((s) => s.statut === 'autonome').length,
    valides: ss.filter((s) => s.statut === 'validee' || (s.statut === 'resolue' && s.douteJustifie !== false)).length,
    corriges: ss.filter((s) => s.statut === 'corrigee' || s.statut === 'supprimee' || s.statut === 'omission').length,
    // An aide a person said was not worth asking.
    inutiles: ss.filter((s) => s.statut === 'resolue' && s.douteJustifie === false).length,
  }
}

/** A run of an agent with skills: what its own points bring to the three measures
 *  (doctrine §4), for the runs list and the run dialog. The BL's point is read on
 *  the run itself; a Délais / Contrôles run needs its saisies (`ss`), without
 *  them nothing is said. An agent without skills: nothing. */
function apportDuRun(def: AgentDef, r: AgentRun, ss?: readonly Saisie[]) {
  const c = def.competences?.find((x) => x.cle === competenceDuRun(r))
  if (!c) return {}
  if (c.cle === 'bl') return { apport: apportMesures(pointsBl([r])) }
  return ss ? { apport: apportMesures(ss.map(pointDe)) } : {}
}

/** Délais / Contrôles: the list's three columns (Point du, points, à trancher). */
function colonnesFlux(r: AgentRun) {
  if (r.competence !== 'delais' && r.competence !== 'controles') return {}
  const res = r.resultat as Partial<ResultatFlux>
  const points: Array<{ decision?: string; reponse?: string }> = r.competence === 'delais'
    ? (res.delais ?? []).filter((p) => p.reponse)
    : (res.controles ?? [])
  return {
    jourPoint: res.jourPoint ?? null,
    nbSaisies: points.filter((p) => p.decision === 'saisie').length,
    nbAides: points.filter((p) => p.decision === 'aide').length,
    nbLus: points.length,
  }
}

/** A run without the heavy parts (OCR text, findings) for lists. */
function allege(r: AgentRun) {
  const { resultat, avisPoints: _avis, resolutionsPoints: _res, ...rest } = r
  const res = resultat as { extraction?: { pieces?: unknown[]; numero_bordereau?: string; numero_commande?: string } }
  const sup = resultat as Partial<ResultatSuperviseur>
  // Factures Ennoblisseur: the same three columns carry the invoice number, its gaps and its lots.
  const fac = resultat as { extraction?: { numero_facture?: string }; verification?: { lignes?: Array<{ verdict: string; lotEtm: string }> } | null }
  const lignesFac = fac.verification?.lignes
  return {
    ...rest,
    bordereau: res.extraction?.numero_bordereau ?? fac.extraction?.numero_facture ?? null,
    commande: res.extraction?.numero_commande
      ?? (lignesFac ? String(lignesFac.filter((l) => l.verdict === 'ecart' || l.verdict === 'non_rapproche').length) : null),
    nbPieces: res.extraction?.pieces?.length ?? (lignesFac ? new Set(lignesFac.filter((l) => l.lotEtm).map((l) => l.lotEtm)).size : null),
    // Superviseur
    nbNouveaux: sup.constats ? sup.constats.filter((c) => c.etat !== 'ouvert').length : null,
    nbOuverts: sup.constats ? sup.constats.filter((c) => c.etat === 'ouvert').length : null,
    nbFermes: sup.fermes ? sup.fermes.length : null,
    nbEcartes: sup.ecartes ? sup.ecartes.length : null,
    /** How the report's points stand (scored on it, or carried from earlier). */
    bilan: agentDef(r.slug)?.points?.bilan(r) ?? null,
    // Triage: categories, sender, hand-offs.
    ...(agentDef(r.slug)?.ligne?.(r) ?? {}),
    ...colonnesFlux(r),
  }
}

async function vueAgent(def: AgentDef) {
  // BL read in observation: compared with the réception once the lot is in stock (throttled, never throws).
  if (def.slug === BL_ENNOBLISSEUR_SLUG) void comparerObservationsBl(def.slug)
  const [state, runs] = await Promise.all([lireEtat(def.slug, def.versionInitiale), lireRuns(def.slug)])
  const v = versionActive(state)
  // An agent the Triage hands mail to: where its mail comes from right now.
  const relais = def.slug in DESTINATAIRES ? await relaisTriage() : null
  return {
    relais,
    slug: def.slug,
    nom: def.nom,
    /** The agent whose group shows it (« Factures » under « Flux Ennoblisseur »); null = on its own. */
    groupe: def.groupe ?? null,
    description: def.description,
    declencheur: def.declencheur,
    ecritures: def.ecritures,
    abstention: def.abstention,
    declenchement: def.declenchement,
    evaluation: { reussite: def.evaluation.reussite, echec: def.evaluation.echec },
    guideNotation: def.evaluation.guide,
    pointsEvaluables: def.pointsEvaluables,
    modes: def.modes,
    peutTester: !!def.traiter,
    controles: def.controles ?? [],
    options: (def.options ?? []).map((o) => ({ ...o, valeur: optionDe(state, o.cle, o.defaut) })),
    prochaineExecution:
      def.declenchement.type === 'quotidien' && state.mode !== 'off'
        ? prochainQuotidien(def.declenchement, Date.now(), state.dernierePlanification)
        : null,
    mode: modeAffiche(def, state.mode),
    startedAt: state.startedAt,
    modeChangedAt: state.modeChangedAt,
    modeChangedBy: state.modeChangedBy,
    versionActive: { version: v.version, model: v.model },
    stats: statistiques(def, runs, state),
    sondage: etatSondage(def.slug),
    competences: await vueCompetences(def, runs, state),
  }
}

/** A skill in observation, as the Score shows it (flux-ennoblisseur/observation.ts). */
function bilanDeCompetence(cle: string, runs: AgentRun[], version: number | null): Promise<BilanObservation> | BilanObservation {
  return cle === 'bl' ? bilanObservationBl(runs, version) : bilanObservation(cle as 'delais' | 'controles', version)
}

/** Each skill: its mode, its three measures on the version it runs, and
 *  whether to propose going up or down (claude_doc/agents_autonomie.md). */
async function vueCompetences(def: AgentDef, runs: AgentRun[], state: AgentState) {
  if (!def.competences) return []
  return Promise.all(def.competences.map(async (c) => {
    const stocke = etatCompetence(state, c.cle, c.defaut)
    // The mode as it runs (a state from before 2026-11-05 may still be capped by the agent's).
    const etat = { ...stocke, mode: modePlafonne(state.mode, stocke.mode) }
    const prompts = versionsDeCompetence(c, state)
    // Its runs on the version in service: the list's « N à vérifier » under the group card.
    const enService = runs.filter((r) => competenceDuRun(r) === c.cle && r.version === prompts.activeVersion && r.source !== 'essai_manuel')
    let points: Awaited<ReturnType<typeof c.points>> = []
    let erreur: string | null = null
    let observation: BilanObservation | null = null
    try {
      points = await c.points(runs, def.slug, prompts.activeVersion)
      // In observation the Score shows executions, the comparison with people and the gaps (2026-11-09).
      if (etat.mode === 'essai') observation = await bilanDeCompetence(c.cle, runs, prompts.activeVersion)
    } catch (e) { erreur = e instanceof Error ? e.message : String(e) }
    const livre = c.versionsLivrees?.[c.versionsLivrees.length - 1]
    return {
      cle: c.cle,
      nom: c.nom,
      description: c.description,
      modes: c.modes,
      mode: etat.mode,
      taux: etat.taux ?? null,
      fenetre: etat.fenetre ?? null,
      libelle: libelleEtat(etat),
      changeLe: etat.changeLe ?? null,
      changePar: etat.changePar ?? null,
      version: prompts.activeVersion,
      /** The skill runs on the agent's own prompt (the BL): its versions are the agent's. */
      promptAgent: !c.versionsLivrees,
      /** Its active version's model (« Mistral Small »), for the list and the header. */
      model: prompts.versions.find((v) => v.version === prompts.activeVersion)?.model ?? '',
      runs: { total: enService.length, aVerifier: enService.filter((r) => r.statut === 'a_verifier').length, erreurs: enService.filter((r) => r.statut === 'erreur').length },
      activeVersion: prompts.activeVersion,
      versions: [...prompts.versions].reverse(),
      /** A prompt shipped with the code that no stored version of the skill carries yet. */
      promptLivre: livre && !estPublie(livre, prompts.versions) ? livre : null,
      mesures: mesurer(points),
      // In observation, going up is read on the observation points only (a version may have run supervisé before).
      conseil: conseiller(etat, c.modes, etat.mode === 'essai' ? points.filter((p) => p.observation) : points),
      observation,
      erreur,
    }
  }))
}

// ── agents ───────────────────────────────────────────────

routes.get('/', async (req, res) => {
  if (session(req, res) === null) return
  try {
    res.json(await Promise.all(agentsDe(scopeDe(res).app).map(vueAgent)))
  } catch (err) {
    console.error('[agents-ia] list failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

routes.get('/:slug', async (req, res) => {
  if (session(req, res) === null) return
  const def = agentOu404(req, res)
  if (!def) return
  try {
    const state = await lireEtat(def.slug, def.versionInitiale)
    res.json({
      ...(await vueAgent(def)),
      activeVersion: state.activeVersion,
      versions: [...state.versions].reverse(),
      // The prompts one version reads with, when there are several (the BL: one per dyer).
      promptsSpecialises: def.promptsSpecialises ?? [],
      // The shipped prompt, until a stored version carries it.
      promptLivre: def.promptLivre && !estPublie(def.promptLivre, state.versions) ? def.promptLivre : null,
      modeles: def.modeles.map((m) => ({ id: m, label: CHAT_MODELS[m]?.label ?? m })),
    })
  } catch (err) {
    console.error('[agents-ia] detail failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const modeBody = z.object({ mode: z.enum(AGENT_MODES as [string, ...string[]]) })

routes.patch('/:slug', async (req, res) => {
  const uid = await pilote(req, res)
  if (uid === null) return
  const def = agentOu404(req, res)
  if (!def) return
  const p = modeBody.safeParse(req.body)
  if (!p.success) { res.status(400).json({ error: 'mode invalide' }); return }
  if (!def.modes[p.data.mode as AgentMode]) { res.status(400).json({ error: 'mode non proposé pour cet agent' }); return }
  // One switch per skill (2026-11-05): an agent with skills has no mode of its own.
  if (def.competences?.length) { res.status(400).json({ error: 'Le mode se règle compétence par compétence.' }); return }
  try {
    await changerMode(def.slug, def.versionInitiale, p.data.mode as AgentState['mode'], await auteur(uid))
    res.json(await vueAgent(def))
  } catch (err) {
    console.error('[agents-ia] mode failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const competenceBody = z.object({
  mode: z.enum(MODES_COMPETENCE as [ModeCompetence, ...ModeCompetence[]]),
  taux: z.number().int().min(1).max(99).optional(),
  fenetre: z.number().int().min(2).max(100).optional(),
})

/** A skill's mode (piloting right, like the agent's). « autonomie » needs its share. */
routes.patch('/:slug/competences/:cle', async (req, res) => {
  const uid = await pilote(req, res)
  if (uid === null) return
  const def = agentOu404(req, res)
  if (!def) return
  const c = def.competences?.find((x) => x.cle === req.params.cle)
  if (!c) { res.status(404).json({ error: 'compétence inconnue' }); return }
  const p = competenceBody.safeParse(req.body)
  if (!p.success) { res.status(400).json({ error: 'mode invalide' }); return }
  if (!c.modes.includes(p.data.mode)) { res.status(400).json({ error: 'mode non proposé pour cette compétence' }); return }
  if (p.data.mode === 'autonomie' && !p.data.taux) { res.status(400).json({ error: 'taux_requis', message: 'Indiquez la part des exécutions faites seules.' }); return }
  try {
    const defauts = Object.fromEntries((def.competences ?? []).map((x) => [x.cle, x.defaut]))
    await changerModeCompetence(def.slug, def.versionInitiale, c.cle, { mode: p.data.mode, taux: p.data.taux, fenetre: p.data.fenetre ?? FENETRE_DEFAUT }, await auteur(uid), defauts)
    res.json(await vueAgent(def))
  } catch (err) {
    console.error('[agents-ia] competence mode failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const cycleBody = z.object({ taux: z.number().int().min(1).max(99), fenetre: z.number().int().min(2).max(100) })

/** A skill's autonomy cycle (share done alone, block size), set whatever its mode (piloting right). */
routes.patch('/:slug/competences/:cle/cycle', async (req, res) => {
  const uid = await pilote(req, res)
  if (uid === null) return
  const def = agentOu404(req, res)
  if (!def) return
  const c = def.competences?.find((x) => x.cle === req.params.cle)
  if (!c) { res.status(404).json({ error: 'compétence inconnue' }); return }
  if (!c.modes.includes('autonomie')) { res.status(400).json({ error: 'Cette compétence ne propose pas d’autonomie.' }); return }
  const p = cycleBody.safeParse(req.body)
  if (!p.success) { res.status(400).json({ error: 'cycle invalide' }); return }
  try {
    await reglerCycle(def.slug, def.versionInitiale, c.cle, c.defaut, p.data)
    res.json(await vueAgent(def))
  } catch (err) {
    console.error('[agents-ia] competence cycle failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

function competenceOu404(def: AgentDef, req: Request, res: Response) {
  const c = def.competences?.find((x) => x.cle === req.params.cle)
  if (!c) res.status(404).json({ error: 'compétence inconnue' })
  return c ?? null
}

/** An agent with skills, seen above them (Vincent 2026-11-11): the mails it received,
 *  newest first, and where each one went (which skills, with their runs), waits, or why
 *  it went nowhere. ?limit= (default 300). */
routes.get('/:slug/mails', async (req, res) => {
  if (session(req, res) === null) return
  const def = agentOu404(req, res)
  if (!def) return
  if (!def.competences?.length) { res.status(404).json({ error: 'cet agent n’a pas de compétences' }); return }
  try {
    // The agents of its group read the same mailbox on their own: their runs are columns too.
    const membres = await Promise.all(agentsDe(scopeDe(res).app).filter((a) => a.groupe === def.slug).map(async (a) => ({
      slug: a.slug, runs: await lireRuns(a.slug), titre: a.titreRun ?? ((r: AgentRun) => r.resume),
    })))
    const mails = mailsDuFlux(await lireRuns(def.slug), def.competences.map((c) => c.cle), membres)
    const limit = Math.min(1000, Math.max(1, parseInt(String(req.query.limit ?? '300'), 10) || 300))
    res.json({ total: mails.length, mails: mails.slice(0, limit) })
  } catch (err) {
    console.error('[agents-ia] mails failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** A skill's three measures on one version (?version=N, « tout » = every
 *  version; default the one in service): the Score tab's version picker. */
routes.get('/:slug/competences/:cle/mesures', async (req, res) => {
  if (session(req, res) === null) return
  const def = agentOu404(req, res)
  if (!def) return
  const c = competenceOu404(def, req, res)
  if (!c) return
  try {
    const [state, runs] = await Promise.all([lireEtat(def.slug, def.versionInitiale), lireRuns(def.slug)])
    const tout = req.query.version === 'tout'
    const version = tout ? null : parseInt(String(req.query.version ?? ''), 10) || versionsDeCompetence(c, state).activeVersion
    const etat = etatCompetence(state, c.cle, c.defaut)
    const observation = modePlafonne(state.mode, etat.mode) === 'essai' ? await bilanDeCompetence(c.cle, runs, version) : null
    res.json({ cle: c.cle, version, mesures: mesurer(await c.points(runs, def.slug, version)), observation })
  } catch (err) {
    console.error('[agents-ia] competence measures failed:', err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' })
  }
})

/** A new prompt version of a skill that has its own (piloting right). It becomes
 *  the one in service at once and its measures restart, like the agent's. */
routes.post('/:slug/competences/:cle/versions', async (req, res) => {
  const uid = await pilote(req, res)
  if (uid === null) return
  const def = agentOu404(req, res)
  if (!def) return
  const c = competenceOu404(def, req, res)
  if (!c) return
  if (!c.versionsLivrees) { res.status(400).json({ error: 'Cette compétence suit le prompt de l’agent.' }); return }
  const p = versionBody.safeParse(req.body)
  if (!p.success) { res.status(400).json({ error: 'Validation failed', details: p.error.issues }); return }
  if (!def.modeles.includes(p.data.model)) { res.status(400).json({ error: 'modèle non autorisé pour cet agent' }); return }
  try {
    const s = await publierVersionCompetence(def.slug, def.versionInitiale, c.cle, c.versionsLivrees, p.data, await auteur(uid))
    res.status(201).json({ activeVersion: s.promptsCompetences?.[c.cle]?.activeVersion ?? null })
  } catch (err) {
    console.error('[agents-ia] competence publish failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

routes.post('/:slug/competences/:cle/versions/:version/activer', async (req, res) => {
  const uid = await pilote(req, res)
  if (uid === null) return
  const def = agentOu404(req, res)
  if (!def) return
  const c = competenceOu404(def, req, res)
  if (!c) return
  if (!c.versionsLivrees) { res.status(400).json({ error: 'Cette compétence suit le prompt de l’agent.' }); return }
  try {
    const s = await activerVersionCompetence(def.slug, def.versionInitiale, c.cle, c.versionsLivrees, parseInt(req.params.version, 10))
    res.json({ activeVersion: s.promptsCompetences?.[c.cle]?.activeVersion ?? null })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'version invalide' })
  }
})

const rejeuBody = z.object({
  model: z.string().min(1),
  prompt: z.string().trim().min(20).max(30_000),
  limite: z.number().int().min(1).max(REJEU_MAX).default(10),
})

/** Replay a draft prompt of Délais / Contrôles on the skill's last executions,
 *  writing nothing (doctrine §0): what the draft changes, and whether it reads
 *  what people kept. Piloting right, like publishing. */
routes.post('/:slug/competences/:cle/rejouer', async (req, res) => {
  const uid = await pilote(req, res)
  if (uid === null) return
  const def = agentOu404(req, res)
  if (!def) return
  const c = competenceOu404(def, req, res)
  if (!c) return
  if (c.cle !== 'delais' && c.cle !== 'controles') { res.status(400).json({ error: 'Le rejeu ne concerne que Délais et Contrôles : pour le BL, « Tester un PDF ».' }); return }
  const p = rejeuBody.safeParse(req.body)
  if (!p.success) { res.status(400).json({ error: 'Validation failed', details: p.error.issues }); return }
  if (!def.modeles.includes(p.data.model)) { res.status(400).json({ error: 'modèle non autorisé pour cet agent' }); return }
  try {
    const runs = (await lireRuns(def.slug))
      .filter((r) => competenceDuRun(r) === c.cle && r.statut !== 'erreur')
      .reverse()
      .slice(0, p.data.limite)
    res.json(await rejouer(c.cle, runs, { model: p.data.model, prompt: p.data.prompt }))
  } catch (err) {
    console.error('[agents-ia] replay failed:', err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' })
  }
})

const optionBody = z.object({ cle: z.string().min(1).max(100), valeur: z.boolean() })

/** Switch one of the agent's options (piloting right, like the mode). */
routes.patch('/:slug/options', async (req, res) => {
  const uid = await pilote(req, res)
  if (uid === null) return
  const def = agentOu404(req, res)
  if (!def) return
  const p = optionBody.safeParse(req.body)
  if (!p.success || !(def.options ?? []).some((o) => o.cle === p.data.cle)) { res.status(400).json({ error: 'option inconnue' }); return }
  try {
    await changerOption(def.slug, def.versionInitiale, p.data.cle, p.data.valeur)
    console.log(`[agents-ia] ${def.slug}: option ${p.data.cle} = ${p.data.valeur} by user ${uid}`)
    res.json(await vueAgent(def))
  } catch (err) {
    console.error('[agents-ia] option failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── prompt versions ──────────────────────────────────────

const versionBody = z.object({
  model: z.string().min(1),
  prompt: z.string().trim().min(20).max(30_000),
  // One or two short sentences: what changes for the people who use the agent (notes-courtes.ts).
  note: z.string().trim().max(NOTE_MAX, `La note est trop longue : une ou deux phrases courtes (${NOTE_MAX} caractères au plus).`).default(''),
  /** The version's specialised prompts, by key (catalog.ts `promptsSpecialises`). */
  promptsProfils: z.record(z.string().trim().min(20).max(30_000)).optional(),
})

routes.post('/:slug/versions', async (req, res) => {
  const uid = await pilote(req, res)
  if (uid === null) return
  const def = agentOu404(req, res)
  if (!def) return
  const p = versionBody.safeParse(req.body)
  if (!p.success) { res.status(400).json({ error: 'Validation failed', details: p.error.issues }); return }
  if (!def.modeles.includes(p.data.model)) { res.status(400).json({ error: 'modèle non autorisé pour cet agent' }); return }
  // Only the keys the agent reads with, never the one that is the version's own `prompt`.
  const cles = new Set((def.promptsSpecialises ?? []).filter((x) => x.defaut !== null).map((x) => x.cle))
  const inconnue = Object.keys(p.data.promptsProfils ?? {}).find((c) => !cles.has(c))
  if (inconnue) { res.status(400).json({ error: `prompt « ${inconnue} » inconnu pour cet agent` }); return }
  try {
    const s = await publierVersion(def.slug, def.versionInitiale, p.data, await auteur(uid))
    res.status(201).json({ activeVersion: s.activeVersion })
  } catch (err) {
    console.error('[agents-ia] publish failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

routes.post('/:slug/versions/:version/activer', async (req, res) => {
  const uid = await pilote(req, res)
  if (uid === null) return
  const def = agentOu404(req, res)
  if (!def) return
  const v = parseInt(req.params.version, 10)
  try {
    const s = await activerVersion(def.slug, def.versionInitiale, v)
    res.json({ activeVersion: s.activeVersion })
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'version invalide' })
  }
})

// ── runs ─────────────────────────────────────────────────

routes.get('/:slug/runs', async (req, res) => {
  if (session(req, res) === null) return
  const def = agentOu404(req, res)
  if (!def) return
  try {
    const statut = typeof req.query.statut === 'string' && req.query.statut ? req.query.statut.split(',') : null
    // ?sans=ignore — the « Toutes » tab leaves out the mails that held no document to read.
    const sans = typeof req.query.sans === 'string' && req.query.sans ? req.query.sans.split(',') : []
    // ?note=echec — any of reussite / echec, or a_evaluer
    // for the runs nobody scored. A point-scored agent (Superviseur) is read
    // through its points: a report matches when one of its points does.
    const notes = typeof req.query.note === 'string' && req.query.note ? req.query.note.split(',') : null
    const notesDuRun = (r: AgentRun): Set<string> =>
      def.points ? notesDuBilan(def.points.bilan(r)) : new Set([r.evaluation ? r.evaluation.note : 'a_evaluer'])
    const parNote = (r: AgentRun) => !notes || notes.some((n) => notesDuRun(r).has(n))
    // Triage: ?categorie=qualite — the runs whose categories (as they stand) include it.
    const cat = typeof req.query.categorie === 'string' && req.query.categorie ? req.query.categorie : null
    const parCategorie = (r: AgentRun) => !cat || ((r.resultat as { categories?: string[] }).categories ?? []).includes(cat)
    // ?version=3 — the runs of one prompt version (the Exécutions tab opens on the active one).
    const version = parseInt(String(req.query.version ?? ''), 10) || null
    // ?competence=delais — the runs of one skill (its versions are its own).
    const competence = typeof req.query.competence === 'string' && req.query.competence ? req.query.competence : null
    const parCompetence = (r: AgentRun) => !competence || !def.competences?.length || competenceDuRun(r) === competence
    const runs = (await lireRuns(def.slug))
      .filter((r) => (!version || r.version === version) && parCompetence(r) && (!statut || statut.includes(r.statut)) && !sans.includes(r.statut) && parNote(r) && parCategorie(r))
      .reverse()
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit ?? '200'), 10) || 200))
    const page = runs.slice(0, limit)
    // Délais / Contrôles: how a person judged each run's points (saisie_agent), one read for the page.
    const parPoints = page.filter((r) => r.competence === 'delais' || r.competence === 'controles')
    const saisies = parPoints.length ? await saisiesDeRuns(parPoints.map((r) => r.id)).catch(() => [] as Saisie[]) : []
    // `notes`: the scores ?note= matches on, so the screen can filter its tags without a round trip.
    res.json({ total: runs.length, runs: page.map((r) => {
      const ss = saisies.filter((x) => x.runId === r.id)
      return { ...allege(r), notes: [...notesDuRun(r)], ...(r.competence === 'delais' || r.competence === 'controles' ? { jugement: jugementDuRun(ss) } : {}), ...apportDuRun(def, r, ss) }
    }) })
  } catch (err) {
    console.error('[agents-ia] runs failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

routes.get('/:slug/runs/:id', async (req, res) => {
  if (session(req, res) === null) return
  const def = agentOu404(req, res)
  if (!def) return
  const r = await lireRun(def.slug, req.params.id)
  if (!r) { res.status(404).json({ error: 'exécution introuvable' }); return }
  // A BL: the rolls of its lot as they stand in stock, so the dialog shows what
  // the réception kept, whether or not Tricobot pre-filled it. Best effort.
  let enStock: RouleauEnStock[] | null = null
  const resolution = def.slug === BL_ENNOBLISSEUR_SLUG ? (r.resultat as { resolution?: { ligneId?: number | null; lot?: string } | null }).resolution : null
  if (resolution?.ligneId && resolution.lot) {
    enStock = await rouleauxEnStock(resolution.ligneId, resolution.lot).catch((err) => {
      console.error('[agents-ia] rouleaux en stock failed:', err)
      return null
    })
  }
  // Délais / Contrôles: each point as a person judged it (where the work is done, Sous-traitants / Qualité).
  const saisies = r.competence === 'delais' || r.competence === 'controles'
    ? await saisiesDeRuns([r.id]).catch((err) => { console.error('[agents-ia] saisies of run failed:', err); return null })
    : null
  res.json({ ...r, ...(enStock ? { enStock } : {}), ...(saisies ? { saisies } : {}), ...apportDuRun(def, r, saisies ?? undefined) })
})

routes.get('/:slug/runs/:id/fichiers/:n', async (req, res) => {
  if (session(req, res) === null) return
  const def = agentOu404(req, res)
  if (!def) return
  const r = await lireRun(def.slug, req.params.id)
  const f = r?.fichiers[parseInt(req.params.n, 10)]
  const buf = f ? await lireFichier(f.fichier) : null
  if (!buf) { res.status(404).json({ error: 'fichier introuvable' }); return }
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f!.nom)}"`)
  // Shown in the run dialog's iframe (web and API on different origins).
  res.removeHeader('X-Frame-Options')
  res.removeHeader('Content-Security-Policy')
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  res.send(buf)
})

/** Re-run the stored PDFs with the ACTIVE version. Writes only when the agent
 *  is « actif » (e.g. after the affectation was fixed); otherwise a dry run. */
routes.post('/:slug/runs/:id/retraiter', async (req, res) => {
  const uid = await pilote(req, res)
  if (uid === null) return
  const def = agentOu404(req, res)
  if (!def) return
  try {
    const r = await lireRun(def.slug, req.params.id)
    if (!r) { res.status(404).json({ error: 'exécution introuvable' }); return }
    const pdfs: Array<{ nom: string; contenu: Buffer }> = []
    for (const f of r.fichiers) {
      const b = await lireFichier(f.fichier)
      if (b) pdfs.push({ nom: f.nom, contenu: b })
    }
    if (!pdfs.length) { res.status(409).json({ error: 'aucun PDF conservé pour cette exécution' }); return }
    if (!def.traiter) { res.status(409).json({ error: 'cet agent ne lit pas de PDF' }); return }
    const state = await lireEtat(def.slug, def.versionInitiale)
    const runs = await def.traiter(pdfs, {
      mode: state.mode === 'actif' ? 'actif' : 'essai',
      version: versionActive(state),
      source: 'retraitement',
      message: r.message ?? null,
      lancePar: await auteur(uid),
      retraiteDe: r.id,
    })
    res.json({ runs: runs.map(allege) })
  } catch (err) {
    console.error('[agents-ia] retraiter failed:', err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' })
  }
})

// ── Dev notes ────────────────────────────────────────────
// A pilot's note on a run, for the next version of the agent: listed in the
// version's « Retours » and in the « Nouvelle version » dialog. Never a score.

const noteDevBody = z.object({ commentaire: z.string().trim().min(1).max(2000) })

routes.post('/:slug/runs/:id/notes-dev', async (req, res) => {
  const uid = await pilote(req, res)
  if (uid === null) return
  const def = agentOu404(req, res)
  if (!def) return
  const p = noteDevBody.safeParse(req.body)
  if (!p.success) { res.status(400).json({ error: 'note vide' }); return }
  const note = { commentaire: p.data.commentaire, par: await auteur(uid), le: new Date().toISOString() }
  const r = await modifierRun(def.slug, req.params.id, (x) => { x.notesDev = [...(x.notesDev ?? []), note] })
  if (!r) { res.status(404).json({ error: 'exécution introuvable' }); return }
  res.json({ ...r, ...apportDuRun(def, r) })
})

/** Remove one note, identified by its timestamp. */
routes.delete('/:slug/runs/:id/notes-dev/:le', async (req, res) => {
  const uid = await pilote(req, res)
  if (uid === null) return
  const def = agentOu404(req, res)
  if (!def) return
  const r = await modifierRun(def.slug, req.params.id, (x) => { x.notesDev = (x.notesDev ?? []).filter((n) => n.le !== req.params.le) })
  if (!r) { res.status(404).json({ error: 'exécution introuvable' }); return }
  res.json({ ...r, ...apportDuRun(def, r) })
})

// ── Score correction (BL Ennoblisseur) ───────────────────
// A pilot corrects a run's score from the run dialog (decision Vincent
// 2026-10-12): e.g. an échec given when the roll had been bent to bill less,
// fixed since through « Ml non facturés ». The one carve-out from « scored where
// the work is done »: only agents scored per run (no `points`), never the
// Triage (its correction re-dispatches). The replaced score is kept in `avant`.
// The why is required (Vincent 2026-11-11): a score a pilot sets or changes
// always says why, kept on the score itself (read by the Retours tab).

const evaluationBody = z.object({
  note: z.enum(['reussite', 'echec']),
  commentaire: z.string().trim().min(1).max(2000),
})

routes.put('/:slug/runs/:id/evaluation', async (req, res) => {
  const uid = await pilote(req, res)
  if (uid === null) return
  const def = agentOu404(req, res)
  if (!def) return
  if (def.points || def.slug === TRIAGE_SLUG) { res.status(409).json({ error: 'cet agent est noté là où le travail est fait' }); return }
  const p = evaluationBody.safeParse(req.body)
  if (!p.success) {
    const sansPourquoi = p.error.issues.some((i) => i.path[0] === 'commentaire')
    res.status(400).json({ error: sansPourquoi ? 'un commentaire est obligatoire pour changer un score' : 'note invalide' })
    return
  }
  const par = await auteur(uid)
  const r = await modifierRun(def.slug, req.params.id, (x) => {
    const prec = x.evaluation ?? null
    // Correcting a correction keeps the person's original score, not ours.
    const avant = prec ? (prec.avant ?? (({ avant: _a, ...rest }) => rest)(prec)) : null
    x.evaluation = { note: p.data.note, commentaire: p.data.commentaire, par, le: new Date().toISOString(), avant }
  })
  if (!r) { res.status(404).json({ error: 'exécution introuvable' }); return }
  res.json({ ...r, ...apportDuRun(def, r) })
})

// ── « Vérifié » ──────────────────────────────────────────
// A pilot checked an « à vérifier » / « erreur » run (handled by hand, e.g. the
// rolls received manually): statut → 'verifie', the original kept in
// `verification`. Not a score. BL: the mail moves to the « traité » label.

const verifieBody = z.object({ commentaire: z.string().trim().max(2000).default('') })

routes.post('/:slug/runs/:id/verifie', async (req, res) => {
  const uid = await pilote(req, res)
  if (uid === null) return
  const def = agentOu404(req, res)
  if (!def) return
  const p = verifieBody.safeParse(req.body ?? {})
  if (!p.success) { res.status(400).json({ error: 'commentaire invalide' }); return }
  const par = await auteur(uid)
  let refus: string | null = null
  const r = await modifierRun(def.slug, req.params.id, (x) => {
    if (x.statut !== 'a_verifier' && x.statut !== 'erreur') { refus = 'seule une exécution « à vérifier » ou en erreur se marque vérifiée'; return }
    x.verification = { statutAvant: x.statut, commentaire: p.data.commentaire, par, le: new Date().toISOString() }
    x.statut = 'verifie'
  })
  if (!r) { res.status(404).json({ error: 'exécution introuvable' }); return }
  if (refus) { res.status(409).json({ error: refus }); return }
  if (def.slug === BL_ENNOBLISSEUR_SLUG && r.message?.id && r.mode === 'actif') await etiqueterVerifie(r.message.id)
  res.json({ ...r, ...apportDuRun(def, r) })
})

// ── Triage ───────────────────────────────────────────────
// The Triage's work IS the triage, so it is corrected here (decision Vincent
// 2026-10-05) — the one agent scored from Agents IA. Correct by default: a
// correction is an échec with why (lib/agents/triage/agent.ts corrigerTriage).

function triageOu409(def: AgentDef, res: Response): boolean {
  if (def.slug === TRIAGE_SLUG) return true
  res.status(409).json({ error: 'réservé à l’agent Triage' })
  return false
}

/** The categories, in order, with the agent behind each (the screen's picker and chips). */
routes.get('/:slug/categories', async (req, res) => {
  if (session(req, res) === null) return
  const def = agentOu404(req, res)
  if (!def || !triageOu409(def, res)) return
  res.json(CATEGORIES.map((c) => ({ ...c, cibleNom: c.cible ? agentDef(c.cible)?.nom ?? c.cible : null })))
})

/** The mail of a Triage run and its thread, read live from Gmail (the run
 *  stores no body). Bodies cut at 20 000 characters. */
routes.get('/:slug/runs/:id/mail', async (req, res) => {
  if (session(req, res) === null) return
  const def = agentOu404(req, res)
  if (!def || !triageOu409(def, res)) return
  const r = await lireRun(def.slug, req.params.id)
  if (!r?.message?.threadId) { res.status(404).json({ error: 'exécution introuvable' }); return }
  try {
    const fil = await lireFil(TRIAGE_BOITE, r.message.threadId)
    res.json({
      messageId: r.message.id,
      messages: fil.map((m) => ({
        id: m.id, de: m.de, a: m.a, cc: m.cc, sujet: m.sujet, date: m.date, envoye: m.envoye,
        texte: m.texte.length > 20_000 ? `${m.texte.slice(0, 20_000)}…` : m.texte,
        piecesJointes: m.piecesJointes.map((p, n) => ({ n, nom: p.nom, mimeType: p.mimeType, taille: p.taille })),
      })),
    })
  } catch (err) {
    console.error('[agents-ia] triage mail failed:', err)
    res.status(502).json({ error: gmailLectureErreur(err) })
  }
})

/** One attachment of a message of the run's thread, streamed from Gmail. */
routes.get('/:slug/runs/:id/mail/:messageId/pieces/:n', async (req, res) => {
  if (session(req, res) === null) return
  const def = agentOu404(req, res)
  if (!def || !triageOu409(def, res)) return
  const r = await lireRun(def.slug, req.params.id)
  if (!r?.message?.threadId) { res.status(404).json({ error: 'exécution introuvable' }); return }
  try {
    // Only a message of THIS run's thread: the route never reads the mailbox at large.
    const m = (await lireFil(TRIAGE_BOITE, r.message.threadId)).find((x) => x.id === req.params.messageId)
    const p = m?.piecesJointes[parseInt(req.params.n, 10)]
    if (!m || !p) { res.status(404).json({ error: 'pièce jointe introuvable' }); return }
    const buf = await lirePieceJointe(TRIAGE_BOITE, m.id, p.attachmentId)
    res.setHeader('Content-Type', p.mimeType || 'application/octet-stream')
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(p.nom)}"`)
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buf)
  } catch (err) {
    console.error('[agents-ia] triage attachment failed:', err)
    res.status(502).json({ error: gmailLectureErreur(err) })
  }
})

const categoriesBody = z.object({
  categories: z.array(z.string().min(1).max(60)).min(1).max(CATEGORIES.length),
  commentaire: z.string().trim().max(2000).default(''),
})

/** 401 / 403 unless the caller may correct the Triage: a pilot, or the
 *  holder of `corriger_triage` (who handles contact@ without piloting). */
async function correcteurTriage(req: Request, res: Response): Promise<number | null> {
  const id = session(req, res)
  if (id === null) return null
  const [pilot, correcteur] = await Promise.all([aLeDroit(req, res, id, 'edit_agents_ia'), aLeDroit(req, res, id, 'corriger_triage')])
  if (!pilot && !correcteur) {
    res.status(403).json({ error: 'permission denied: corriger_triage' })
    return null
  }
  return id
}

/** Correct a run's categories (pilot or `corriger_triage`). The labels
 *  move, a new category's agent gets the mail; the answer lists what an
 *  agent already did for a category now removed (never undone). */
routes.put('/:slug/runs/:id/categories', async (req, res) => {
  const uid = await correcteurTriage(req, res)
  if (uid === null) return
  const def = agentOu404(req, res)
  if (!def || !triageOu409(def, res)) return
  const p = categoriesBody.safeParse(req.body)
  if (!p.success || p.data.categories.some((c) => !CATEGORIES.some((x) => x.cle === c))) { res.status(400).json({ error: 'catégories invalides' }); return }
  try {
    const r = await corrigerTriage(req.params.id, p.data.categories, p.data.commentaire, await auteur(uid))
    if (!r) { res.status(404).json({ error: 'exécution introuvable' }); return }
    res.json({ run: r.run, dejaTraites: r.dejaTraites })
  } catch (err) {
    if (err instanceof CorrectionInvalide) { res.status(400).json({ error: err.message }); return }
    console.error('[agents-ia] triage correction failed:', err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' })
  }
})

// ── scores ───────────────────────────────────────────────
// Agents IA never scores (decision Vincent 2026-10-02): every score is given
// where the work is done, as « Tricobot » feedback — réussite by silence,
// échec with a why (lib/agents/retours.ts). BL Ennoblisseur: at the réception
// of the rolls (routes/tricobot.ts); Superviseur: the dashboard widget
// (below); Factures Ennoblisseur: Sous-traitants › Factures. This screen only
// shows the scores — except the Triage, corrected here (« Triage » above).

// A point is never scored here: Agents IA is the admin side. The Superviseur's
// points are handled from the dashboard widget (PUT /:slug/points/traitement),
// an invoice's lines on Sous-traitants › Factures (routes/factures-sst.ts).

const traitementBody = z.object({
  /** Omitted = the current report (an undo from the history). */
  runId: z.string().min(1).max(100).nullable().default(null),
  cle: z.string().min(1).max(500),
  /** null undoes the handling. « fausse_alerte » is what « Former Tricobot ›
   *  N'aurait pas dû remonter » writes: the widget goes through /tricobot. */
  issue: z.enum(['traite', 'fausse_alerte']).nullable(),
  /** « traite »: optional word on how it was handled. */
  commentaire: z.string().trim().max(2000).default(''),
})

/** Settle one point from the Notifications widget (« Traité »), or undo a
 *  handling from its history (lib/agents/superviseur/points.ts). The scoring
 *  right, or the widget's Superviseur sub-permission (traiteurPoints). */
routes.put('/:slug/points/traitement', async (req, res) => {
  const uid = await traiteurPoints(req, res)
  if (uid === null) return
  const def = agentOu404(req, res)
  if (!def) return
  if (def.slug !== SUPERVISEUR_SLUG) { res.status(409).json({ error: 'cet agent ne produit pas de points à traiter' }); return }
  const p = traitementBody.safeParse(req.body)
  if (!p.success) { res.status(400).json({ error: 'traitement invalide' }); return }
  const { runId, cle, issue, commentaire } = p.data
  try {
    const t = await traiterPoint(runId, cle, issue, commentaire, await auteur(uid))
    if (t === undefined) { res.status(404).json({ error: 'point introuvable dans ce rapport' }); return }
    res.json({ traitement: t })
  } catch (err) {
    if (err instanceof TraitementInvalide) { res.status(400).json({ error: err.message }); return }
    console.error('[agents-ia] traitement point failed:', err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' })
  }
})

const formationBody = z.object({
  cle: z.string().min(1).max(500),
  /** The occurrence (`depuis` of the point): open or already closed. */
  depuis: z.string().min(1).max(40),
  type: z.enum(['pas_a_remonter', 'a_savoir']),
  commentaire: z.string().trim().min(1).max(2000),
})

/** « Former Tricobot » on one point, from the widget or its history, open or
 *  closed (LIVA #1272): « n'aurait pas dû remonter » (échec, leaves the queue)
 *  or « tu pouvais aller chercher plus loin » (a lesson, no score). Same guard as above. */
routes.post('/:slug/points/tricobot', async (req, res) => {
  const uid = await traiteurPoints(req, res)
  if (uid === null) return
  const def = agentOu404(req, res)
  if (!def) return
  if (def.slug !== SUPERVISEUR_SLUG) { res.status(409).json({ error: 'cet agent ne produit pas de points à traiter' }); return }
  const p = formationBody.safeParse(req.body)
  if (!p.success) { res.status(400).json({ error: 'Dites quelque chose à Tricobot : c’est ce qui sert à le former.' }); return }
  const { cle, depuis, type, commentaire } = p.data
  try {
    if (!(await formerTricobot(cle, depuis, type, commentaire, await auteur(uid)))) {
      res.status(404).json({ error: 'point introuvable' }); return
    }
    res.json({ ok: true })
  } catch (err) {
    if (err instanceof TraitementInvalide) { res.status(400).json({ error: err.message }); return }
    console.error('[agents-ia] former tricobot failed:', err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' })
  }
})

/** Every point the agent raised, open or closed, and how it was handled —
 *  the widget's « Historique » and the agent's « Points » tab in Agents IA,
 *  each with the prompt version that raised it (the tab's version picker).
 *  Readable by any session, like the runs that carry the same points. */
routes.get('/:slug/points/historique', async (req, res) => {
  if (session(req, res) === null) return
  const def = agentOu404(req, res)
  if (!def) return
  if (def.slug !== SUPERVISEUR_SLUG) { res.json({ points: [] }); return }
  try {
    const [points, runs] = await Promise.all([lireHistorique(), lireRuns(def.slug)])
    res.json({ points: versionDesPoints(points.slice(0, 500), runs) })
  } catch (err) {
    console.error('[agents-ia] historique points failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** Every comment given on a version — what the next prompt is written from. */
routes.get('/:slug/retours', async (req, res) => {
  if (session(req, res) === null) return
  const def = agentOu404(req, res)
  if (!def) return
  try {
    const state = await lireEtat(def.slug, def.versionInitiale)
    // ?competence=delais — one skill's retours, on its own versions.
    const competence = typeof req.query.competence === 'string' && req.query.competence
      ? def.competences?.find((c) => c.cle === req.query.competence) ?? null
      : null
    if (competence?.versionsLivrees) { res.json(await retoursCompetence(def.slug, competence.cle, versionsDeCompetence(competence, state), req.query.version)); return }
    const versionsAgent = competence ? versionsDeCompetence(competence, state) : { activeVersion: state.activeVersion, versions: state.versions }
    const version = parseInt(String(req.query.version ?? ''), 10) || versionsAgent.activeVersion
    const retours: Array<{
      runId: string; runLe: string; source: AgentRun['source']; portee: 'execution' | 'point'
      titre: string | null; note: Note; commentaire: string; corrections?: string[]; par: Auteur; le: string; retrait: string | null
      /** BL: what the agent read and the rolls of the lot as they stand in stock, when the
       *  retour itself names no field (see below). */
      stock?: { pieces: unknown[]; enStock: RouleauEnStock[] }
    }> = []
    /** BL retours to complete with the stock (Vincent 2026-11-11): an échec, or a comment,
     *  that names no field changed at the réception (a score a pilot gave, rolls received by
     *  hand). The card then shows what the stock holds against what was read, as the run's
     *  dialog does, so the change is read without opening it. */
    const aCompleter: Array<{ retour: (typeof retours)[number]; ligneId: number; lot: string; pieces: unknown[] }> = []
    /** Points marked résolu by hand — what ETM and the mailboxes could not see. */
    const resolutions: Array<{ runId: string; runLe: string; titre: string; commentaire: string; par: Auteur; le: string }> = []
    /** « Former Tricobot › Tu pouvais aller chercher plus loin »: no score, read like the comments. */
    const lecons: Array<{ runId: string; runLe: string; titre: string; commentaire: string; par: Auteur; le: string }> = []
    /** Pilots' notes on runs, for the next version (POST /:slug/runs/:id/notes-dev). */
    const notesDev: Array<{ runId: string; runLe: string; titre: string; commentaire: string; par: Auteur; le: string }> = []
    for (const r of await lireRuns(def.slug)) {
      if (r.version !== version) continue
      if (competence && competenceDuRun(r) !== competence.cle) continue
      const base = { runId: r.id, runLe: r.createdAt, source: r.source }
      if (r.evaluation) {
        const retour: (typeof retours)[number] = { ...base, portee: 'execution', titre: r.resume, ...r.evaluation, retrait: r.evaluation.retrait ?? null }
        retours.push(retour)
        const e = r.evaluation
        const bl = r.resultat as { extraction?: { pieces?: unknown[] }; resolution?: { ligneId?: number | null; lot?: string } | null }
        const sansChamp = !e.corrections?.length && !e.avant?.corrections?.length
        if (def.slug === BL_ENNOBLISSEUR_SLUG && sansChamp && (noteBinaire(e.note) === 'echec' || e.commentaire)
          && bl.resolution?.ligneId && bl.resolution.lot && bl.extraction?.pieces?.length) {
          aCompleter.push({ retour, ligneId: bl.resolution.ligneId, lot: bl.resolution.lot, pieces: bl.extraction.pieces })
        }
      }
      const titres = new Map((def.points?.duRun(r) ?? []).map((p) => [p.cle, p.titre]))
      // A plain « Traité » (dashboard widget) is a réussite with no comment and
      // a résolu with no explanation: nothing to learn from, left out.
      for (const [cle, a] of Object.entries(r.avisPoints ?? {})) {
        if (!a.commentaire) continue
        retours.push({ ...base, portee: 'point', titre: titres.get(cle) ?? cle, ...a, retrait: null })
      }
      for (const [cle, x] of Object.entries(r.resolutionsPoints ?? {})) {
        if (!x.commentaire || x.commentaire === r.avisPoints?.[cle]?.commentaire) continue
        resolutions.push({ runId: r.id, runLe: r.createdAt, titre: titres.get(cle) ?? cle, ...x })
      }
      for (const [cle, xs] of Object.entries(r.leconsPoints ?? {})) {
        for (const x of xs) lecons.push({ runId: r.id, runLe: r.createdAt, titre: titres.get(cle) ?? cle, ...x })
      }
      for (const x of r.lecons ?? []) lecons.push({ runId: r.id, runLe: r.createdAt, titre: r.resume, ...x })
      for (const x of r.notesDev ?? []) notesDev.push({ runId: r.id, runLe: r.createdAt, titre: r.resume, ...x })
    }
    // Best effort, a handful of reads (the échecs of one version): a failed one leaves its card as it was.
    await Promise.all(aCompleter.map(async (x) => {
      const enStock = await rouleauxEnStock(x.ligneId, x.lot).catch((err) => {
        console.error('[agents-ia] retours: rouleaux en stock failed:', err)
        return null
      })
      if (enStock?.length) x.retour.stock = { pieces: x.pieces, enStock }
    }))
    retours.sort((a, b) => b.le.localeCompare(a.le))
    resolutions.sort((a, b) => b.le.localeCompare(a.le))
    lecons.sort((a, b) => b.le.localeCompare(a.le))
    notesDev.sort((a, b) => b.le.localeCompare(a.le))
    res.json({ version, versions: versionsAgent.versions.map((v) => v.version).reverse(), retours, resolutions, lecons, notesDev })
  } catch (err) {
    console.error('[agents-ia] retours failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** Délais / Contrôles: their retours are the gestures on their points
 *  (saisie_agent), given where the work is done — a correction or a deletion
 *  with its why, a validation with a word, an aide settled with « tu pouvais
 *  décider seul, parce que… » — plus the pilots' notes on the runs. */
async function retoursCompetence(slug: string, cle: string, prompts: { activeVersion: number; versions: Array<{ version: number }> }, v: unknown) {
  const version = parseInt(String(v ?? ''), 10) || prompts.activeVersion
  const [saisies, runs] = await Promise.all([saisiesDeCompetence(slug, cle, version), lireRuns(slug)])
  const parId = new Map(runs.map((r) => [r.id, r]))
  const quoi = (s: Saisie) => (s.champ === 'mesures_sst' ? `Lot ${s.idsuivilot || '?'}` : s.idcommande ? `Commande ${s.idcommande}` : 'Mail')
  const valeur = (x: string | null) => {
    if (!x) return '(rien)'
    if (/^\d{4}-\d{2}-\d{2}$/.test(x)) return `${x.slice(8, 10)}/${x.slice(5, 7)}`
    try { const m = JSON.parse(x) as Record<string, number | null>; return `laize ${m.laize ?? '?'}, poids ${m.poids ?? '?'}, h ${m.stabH ?? '?'}, l ${m.stabL ?? '?'}${m.vrillage != null ? `, V ${m.vrillage} %` : ''}` } catch { return x }
  }
  const par = (s: Saisie): Auteur => ({ id: 0, nom: s.revuPar ?? 'Quelqu’un' })
  const base = (s: Saisie) => ({ runId: s.runId, runLe: parId.get(s.runId)?.createdAt ?? s.creeLe, source: parId.get(s.runId)?.source ?? 'gmail' })
  const retours: Array<Record<string, unknown>> = []
  const lecons: Array<Record<string, unknown>> = []
  const resolutions: Array<Record<string, unknown>> = []
  for (const s of saisies) {
    const le = s.revuLe ?? s.creeLe
    if (s.statut === 'corrigee' || s.statut === 'supprimee' || s.statut === 'omission') {
      const titre = s.statut === 'corrigee' ? `${quoi(s)} · ${valeur(s.proposition)} corrigé en ${valeur(s.valeurFinale)}`
        : s.statut === 'supprimee' ? `${quoi(s)} · ${valeur(s.proposition)} supprimé`
        : `${quoi(s)} · « rien » : il y avait quelque chose`
      retours.push({ ...base(s), portee: 'point', titre, note: 'echec', commentaire: s.commentaire ?? '', par: par(s), le, retrait: null })
    } else if (s.statut === 'validee' && s.commentaire) {
      retours.push({ ...base(s), portee: 'point', titre: `${quoi(s)} · ${valeur(s.proposition)}`, note: 'reussite', commentaire: s.commentaire, par: par(s), le, retrait: null })
    } else if (s.statut === 'resolue') {
      // « Tu pouvais décider seul, parce que… »: what the next prompt learns to decide alone from.
      if (s.douteJustifie === false && s.douteCommentaire) lecons.push({ runId: s.runId, runLe: base(s).runLe, titre: `${quoi(s)} · « ${s.citation} » (il pouvait décider seul)`, commentaire: s.douteCommentaire, par: par(s), le })
      if (s.commentaire) resolutions.push({ runId: s.runId, runLe: base(s).runLe, titre: `${quoi(s)} · tranché : ${valeur(s.valeurFinale)}`, commentaire: s.commentaire, par: par(s), le })
    }
  }
  const notesDev: Array<Record<string, unknown>> = []
  for (const r of runs) {
    if (r.competence !== cle || r.version !== version) continue
    for (const x of r.notesDev ?? []) notesDev.push({ runId: r.id, runLe: r.createdAt, titre: r.resume, ...x })
  }
  const parDate = (a: Record<string, unknown>, b: Record<string, unknown>) => String(b.le).localeCompare(String(a.le))
  return {
    version,
    versions: prompts.versions.map((x) => x.version).reverse(),
    retours: retours.sort(parDate), resolutions: resolutions.sort(parDate), lecons: lecons.sort(parDate), notesDev: notesDev.sort(parDate),
  }
}

// ── actions ──────────────────────────────────────────────

routes.post('/:slug/sonder', async (req, res) => {
  const uid = await pilote(req, res)
  if (uid === null) return
  const def = agentOu404(req, res)
  if (!def) return
  try {
    const state = await lireEtat(def.slug, def.versionInitiale)
    if (state.mode === 'off') { res.status(409).json({ error: 'L’agent est à l’arrêt : passez-le en essai ou en service d’abord.' }); return }
    if (def.declenchement.type === 'ecran') { res.status(409).json({ error: `Cet agent se lance depuis ${def.declenchement.ecran}.` }); return }
    // Answer at once: a run can outlast the proxy timeout. The screen polls
    // GET /:slug until `sondage.dernierLancement.fin` is set.
    const lancement = lancerSondage(def.slug, await auteur(uid))
    res.status(202).json({ lancement })
  } catch (err) {
    if (err instanceof SondageEnCoursError) { res.status(409).json({ error: err.message }); return }
    console.error('[agents-ia] sonder failed:', err)
    res.status(502).json({ error: gmailLectureErreur(err) })
  }
})

/** Manual test on one PDF — uploaded, or taken from an sst order's ged
 *  (`idged`). Always a dry run: never writes, whatever the agent's mode. */
routes.post('/:slug/essai', upload.single('fichier'), async (req, res) => {
  const uid = await pilote(req, res)
  if (uid === null) return
  const def = agentOu404(req, res)
  if (!def) return
  if (!def.traiter) { res.status(409).json({ error: 'cet agent ne lit pas de PDF' }); return }
  try {
    let pdf: { nom: string; contenu: Buffer } | null = null
    if (req.file?.buffer?.length) {
      pdf = { nom: req.file.originalname || 'bl.pdf', contenu: req.file.buffer }
    } else {
      const idged = parseInt(String(req.body?.idged ?? ''), 10)
      if (!Number.isFinite(idged)) { res.status(400).json({ error: 'fichier ou idged requis' }); return }
      const rows = await queryRaw(`SELECT fichier FROM ged WHERE IDged = ${idged}`)
      const f = rows[0]?.fichier
      const buf = f instanceof ArrayBuffer ? Buffer.from(f) : Buffer.isBuffer(f) ? f : null
      if (!buf || buf.subarray(0, 4).toString() !== '%PDF') { res.status(404).json({ error: 'aucun PDF dans ce document' }); return }
      pdf = { nom: `ged-${idged}.pdf`, contenu: buf }
    }
    if (pdf.contenu.subarray(0, 4).toString() !== '%PDF') { res.status(400).json({ error: 'le fichier n’est pas un PDF' }); return }
    const state = await lireEtat(def.slug, def.versionInitiale)
    const runs = await def.traiter([pdf], {
      mode: 'essai',
      version: versionActive(state),
      source: 'essai_manuel',
      lancePar: await auteur(uid),
    })
    res.json({ runs: runs.map(allege) })
  } catch (err) {
    console.error('[agents-ia] essai failed:', err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' })
  }
})

// ── costs ────────────────────────────────────────────────

routes.get('/:slug/couts', async (req, res) => {
  if (session(req, res) === null) return
  const def = agentOu404(req, res)
  if (!def) return
  const jours = Math.min(365, Math.max(1, parseInt(String(req.query.jours ?? '30'), 10) || 30))
  const debut = Date.now() - jours * 86_400_000
  const parJour = new Map<string, { jour: string; coutUsd: number; runs: number }>()
  for (let i = jours - 1; i >= 0; i--) {
    const jour = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10)
    parJour.set(jour, { jour, coutUsd: 0, runs: 0 })
  }
  let total = 0
  let n = 0
  // ?competence=delais — one skill's costs (Flux Ennoblisseur: each skill is shown as an agent).
  const competence = typeof req.query.competence === 'string' && req.query.competence && def.competences?.length ? req.query.competence : null
  for (const r of await lireRuns(def.slug)) {
    const t = new Date(r.createdAt).getTime()
    if (t < debut) continue
    if (competence && competenceDuRun(r) !== competence) continue
    const d = parJour.get(r.createdAt.slice(0, 10))
    if (d) { d.coutUsd += r.coutUsd || 0; d.runs++ }
    total += r.coutUsd || 0
    n++
  }
  res.json({ jours, totalUsd: total, runs: n, moyenneUsd: n ? total / n : 0, parJour: [...parJour.values()] })
})
