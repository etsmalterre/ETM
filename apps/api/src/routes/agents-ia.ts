// « Agents IA » — /api/agents-ia. The screen Agents IA › Agents (apps/web
// pages/agents-ia/AgentsIa.tsx) reads and pilots the agents of lib/agents/.
//
// Reads need a session only (the menu `screen_agents_ia` is the curtain);
// every write needs `edit_agents_ia`, checked here — there is no global auth
// middleware, an unguarded route is anonymous.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import multer from 'multer'
import { z } from 'zod'
import { query, queryRaw, fixEncoding } from '../lib/hfsql-auto.js'
import { userHasPermission } from '../lib/permissions.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { AGENTS, agentDef, type AgentDef } from '../lib/agents/catalog.js'
import {
  AGENT_MODES,
  NOTES,
  activerVersion,
  changerMode,
  lireEtat,
  lireFichier,
  lireRun,
  lireRuns,
  modifierRun,
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
import type { ResultatSuperviseur } from '../lib/agents/superviseur/superviseur.js'
import { enregistrerAvis, enregistrerResolution, lireAvis, lireResolutions } from '../lib/agents/superviseur/avis.js'
import { bilanRun, notesDuBilan, scorePoints } from '../lib/agents/superviseur/score.js'
import { CHAT_MODELS } from '../lib/mistral.js'
import { gmailLectureErreur } from '../lib/gmail-reader.js'

export const agentsIaRouter: RouterType = Router()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } })

// ── helpers ──────────────────────────────────────────────

async function auteur(userId: number): Promise<Auteur> {
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
function session(req: Request, res: Response): number | null {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return null
  }
  return req.userId
}

/** 401 / 403 unless the caller may pilot agents. */
async function pilote(req: Request, res: Response): Promise<number | null> {
  const id = session(req, res)
  if (id === null) return null
  if (!(await userHasPermission(id, isEffectiveAdmin(req), 'edit_agents_ia'))) {
    res.status(403).json({ error: 'permission denied: edit_agents_ia' })
    return null
  }
  return id
}

/** 401 / 403 unless the caller may score runs (a right separate from piloting). */
async function evaluateur(req: Request, res: Response): Promise<number | null> {
  const id = session(req, res)
  if (id === null) return null
  if (!(await userHasPermission(id, isEffectiveAdmin(req), 'evaluer_agents_ia'))) {
    res.status(403).json({ error: 'permission denied: evaluer_agents_ia' })
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
  const def = agentDef(req.params.slug)
  if (!def) res.status(404).json({ error: 'agent inconnu' })
  return def ?? null
}

function statistiques(def: AgentDef, runs: AgentRun[], state: AgentState) {
  // Stats cover the active version only (MFProd rule): a new prompt starts a new score.
  const actifs = runs.filter((r) => r.version === state.activeVersion && r.source !== 'essai_manuel')
  const parStatut: Record<string, number> = {}
  for (const r of actifs) parStatut[r.statut] = (parStatut[r.statut] ?? 0) + 1
  const note = (n: Note) => actifs.filter((r) => r.evaluation?.note === n).length
  return {
    total: actifs.length,
    parStatut,
    evaluations: {
      reussite: note('reussite'),
      partielle: note('partielle'),
      echec: note('echec'),
      aEvaluer: actifs.filter((r) => !r.evaluation).length,
    },
    /** Point-scored agents (Superviseur): the score of every finding the
     *  version raised — the number a prompt version is judged on. */
    points: def.pointsEvaluables ? scorePoints(actifs) : null,
    coutUsd: actifs.reduce((s, r) => s + (r.coutUsd || 0), 0),
    dernierRun: runs.length ? runs[runs.length - 1].createdAt : null,
  }
}

/** A run without the heavy parts (OCR text, findings) for lists. */
function allege(r: AgentRun) {
  const { resultat, avisPoints: _avis, resolutionsPoints: _res, ...rest } = r
  const res = resultat as { extraction?: { pieces?: unknown[]; numero_bordereau?: string; numero_commande?: string } }
  const sup = resultat as Partial<ResultatSuperviseur>
  return {
    ...rest,
    bordereau: res.extraction?.numero_bordereau ?? null,
    commande: res.extraction?.numero_commande ?? null,
    nbPieces: res.extraction?.pieces?.length ?? null,
    // Superviseur
    nbNouveaux: sup.constats ? sup.constats.filter((c) => c.etat !== 'ouvert').length : null,
    nbOuverts: sup.constats ? sup.constats.filter((c) => c.etat === 'ouvert').length : null,
    nbFermes: sup.fermes ? sup.fermes.length + (sup.resolus?.length ?? 0) : null,
    nbEcartes: sup.ecartes ? sup.ecartes.length : null,
    /** How the report's points stand (scored on it, or carried from earlier). */
    bilan: bilanRun(r),
  }
}

async function vueAgent(def: AgentDef) {
  const [state, runs] = await Promise.all([lireEtat(def.slug, def.versionInitiale), lireRuns(def.slug)])
  const v = versionActive(state)
  return {
    slug: def.slug,
    nom: def.nom,
    description: def.description,
    declencheur: def.declencheur,
    ecritures: def.ecritures,
    abstention: def.abstention,
    declenchement: def.declenchement,
    evaluation: { reussite: def.evaluation.reussite, partielle: def.evaluation.partielle, echec: def.evaluation.echec },
    guideNotation: def.evaluation.guide,
    pointsEvaluables: def.pointsEvaluables,
    modes: def.modes,
    peutTester: !!def.traiter,
    controles: def.controles ?? [],
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
  }
}

// ── agents ───────────────────────────────────────────────

agentsIaRouter.get('/', async (req, res) => {
  if (session(req, res) === null) return
  try {
    res.json(await Promise.all(AGENTS.map(vueAgent)))
  } catch (err) {
    console.error('[agents-ia] list failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

agentsIaRouter.get('/:slug', async (req, res) => {
  if (session(req, res) === null) return
  const def = agentOu404(req, res)
  if (!def) return
  try {
    const state = await lireEtat(def.slug, def.versionInitiale)
    res.json({
      ...(await vueAgent(def)),
      activeVersion: state.activeVersion,
      versions: [...state.versions].reverse(),
      // The shipped prompt, until a stored version carries it.
      promptLivre: def.promptLivre && !state.versions.some((x) => x.prompt.trim() === def.promptLivre!.prompt.trim()) ? def.promptLivre : null,
      modeles: def.modeles.map((m) => ({ id: m, label: CHAT_MODELS[m]?.label ?? m })),
    })
  } catch (err) {
    console.error('[agents-ia] detail failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const modeBody = z.object({ mode: z.enum(AGENT_MODES as [string, ...string[]]) })

agentsIaRouter.patch('/:slug', async (req, res) => {
  const uid = await pilote(req, res)
  if (uid === null) return
  const def = agentOu404(req, res)
  if (!def) return
  const p = modeBody.safeParse(req.body)
  if (!p.success) { res.status(400).json({ error: 'mode invalide' }); return }
  if (!def.modes[p.data.mode as AgentMode]) { res.status(400).json({ error: 'mode non proposé pour cet agent' }); return }
  try {
    await changerMode(def.slug, def.versionInitiale, p.data.mode as AgentState['mode'], await auteur(uid))
    res.json(await vueAgent(def))
  } catch (err) {
    console.error('[agents-ia] mode failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── prompt versions ──────────────────────────────────────

const versionBody = z.object({
  model: z.string().min(1),
  prompt: z.string().trim().min(20).max(30_000),
  note: z.string().trim().max(500).default(''),
})

agentsIaRouter.post('/:slug/versions', async (req, res) => {
  const uid = await pilote(req, res)
  if (uid === null) return
  const def = agentOu404(req, res)
  if (!def) return
  const p = versionBody.safeParse(req.body)
  if (!p.success) { res.status(400).json({ error: 'Validation failed', details: p.error.issues }); return }
  if (!def.modeles.includes(p.data.model)) { res.status(400).json({ error: 'modèle non autorisé pour cet agent' }); return }
  try {
    const s = await publierVersion(def.slug, def.versionInitiale, p.data, await auteur(uid))
    res.status(201).json({ activeVersion: s.activeVersion })
  } catch (err) {
    console.error('[agents-ia] publish failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

agentsIaRouter.post('/:slug/versions/:version/activer', async (req, res) => {
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

agentsIaRouter.get('/:slug/runs', async (req, res) => {
  if (session(req, res) === null) return
  const def = agentOu404(req, res)
  if (!def) return
  try {
    const statut = typeof req.query.statut === 'string' && req.query.statut ? req.query.statut.split(',') : null
    // ?note=partielle,echec — any of reussite / partielle / echec, or a_evaluer
    // for the runs nobody scored. A point-scored agent (Superviseur) is read
    // through its points: a report matches when one of its points does.
    const notes = typeof req.query.note === 'string' && req.query.note ? req.query.note.split(',') : null
    const notesDuRun = (r: AgentRun): Set<string> =>
      def.pointsEvaluables ? notesDuBilan(bilanRun(r)) : new Set([r.evaluation ? r.evaluation.note : 'a_evaluer'])
    const parNote = (r: AgentRun) => !notes || notes.some((n) => notesDuRun(r).has(n))
    const runs = (await lireRuns(def.slug))
      .filter((r) => (!statut || statut.includes(r.statut)) && parNote(r))
      .reverse()
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit ?? '200'), 10) || 200))
    res.json({ total: runs.length, runs: runs.slice(0, limit).map(allege) })
  } catch (err) {
    console.error('[agents-ia] runs failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

agentsIaRouter.get('/:slug/runs/:id', async (req, res) => {
  if (session(req, res) === null) return
  const def = agentOu404(req, res)
  if (!def) return
  const r = await lireRun(def.slug, req.params.id)
  if (!r) { res.status(404).json({ error: 'exécution introuvable' }); return }
  res.json(r)
})

agentsIaRouter.get('/:slug/runs/:id/fichiers/:n', async (req, res) => {
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
agentsIaRouter.post('/:slug/runs/:id/retraiter', async (req, res) => {
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

// ── scores ───────────────────────────────────────────────
// Every score is réussite / partielle / échec. Only réussite goes without a
// comment — the comment is what the next prompt version is written from.
// WHAT is scored depends on the agent: a run (BL Ennoblisseur — one run, one
// BL; an échec takes back its pre-filled pieces, AgentDef.evaluation.retirer)
// or each point of the run (Superviseur — the report is the morning's batch,
// never scored as a whole; superviseur/score.ts).

const evaluationBody = z.object({
  note: z.enum(NOTES as [Note, ...Note[]]).nullable(),
  commentaire: z.string().trim().max(2000).default(''),
})

const COMMENTAIRE_REQUIS = 'Expliquez en commentaire ce qui n’allait pas : c’est ce qui sert à améliorer l’agent.'

agentsIaRouter.put('/:slug/runs/:id/evaluation', async (req, res) => {
  const uid = await evaluateur(req, res)
  if (uid === null) return
  const def = agentOu404(req, res)
  if (!def) return
  if (def.pointsEvaluables) { res.status(409).json({ error: 'cet agent s’évalue point par point, pas par rapport' }); return }
  const p = evaluationBody.safeParse(req.body)
  if (!p.success) { res.status(400).json({ error: 'évaluation invalide' }); return }
  const { note, commentaire } = p.data
  if (note && note !== 'reussite' && !commentaire) { res.status(400).json({ error: COMMENTAIRE_REQUIS }); return }
  try {
    const avant = await lireRun(def.slug, req.params.id)
    if (!avant) { res.status(404).json({ error: 'exécution introuvable' }); return }
    // A removal happens once and is never undone: re-scoring keeps its record.
    let retrait = avant.evaluation?.retrait ?? null
    if (note === 'echec' && def.evaluation.retirer) retrait = (await def.evaluation.retirer(avant)) ?? retrait
    const par = await auteur(uid)
    const r = await modifierRun(def.slug, req.params.id, (run) => {
      // Carries what retirer() recorded (BL: ecriture.retire), which also
      // survives clearing the score.
      run.resultat = avant.resultat
      run.evaluation = note ? { note, commentaire, par, le: new Date().toISOString(), retrait } : null
    })
    if (!r) { res.status(404).json({ error: 'exécution introuvable' }); return }
    res.json(r)
  } catch (err) {
    console.error('[agents-ia] evaluation failed:', err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' })
  }
})

const avisPointBody = evaluationBody.extend({ cle: z.string().min(1).max(500) })

/** Score one point of a Superviseur report. Kept on the run (feedback for the
 *  next version) and in the Superviseur's index, so the next reports set a
 *  point scored « échec » aside (lib/agents/superviseur/avis.ts). */
agentsIaRouter.put('/:slug/runs/:id/points', async (req, res) => {
  const uid = await evaluateur(req, res)
  if (uid === null) return
  const def = agentOu404(req, res)
  if (!def) return
  if (!def.pointsEvaluables) { res.status(409).json({ error: 'cet agent ne produit pas de points à évaluer' }); return }
  const p = avisPointBody.safeParse(req.body)
  if (!p.success) { res.status(400).json({ error: 'évaluation invalide' }); return }
  const { cle, note, commentaire } = p.data
  if (note && note !== 'reussite' && !commentaire) { res.status(400).json({ error: COMMENTAIRE_REQUIS }); return }
  try {
    const run = await lireRun(def.slug, req.params.id)
    if (!run) { res.status(404).json({ error: 'exécution introuvable' }); return }
    const sup = run.resultat as Partial<ResultatSuperviseur>
    const point = [...(sup.constats ?? []), ...(sup.ecartes ?? [])].find((c) => c.cle === cle)
    if (!point) { res.status(404).json({ error: 'point introuvable dans ce rapport' }); return }
    const avis: Evaluation | null = note ? { note, commentaire, par: await auteur(uid), le: new Date().toISOString() } : null
    const r = await modifierRun(def.slug, run.id, (x) => {
      const points = { ...(x.avisPoints ?? {}) }
      if (avis) points[cle] = avis
      else delete points[cle]
      x.avisPoints = points
    })
    // Clearing a score from an old report must not wipe a newer one.
    const index = await lireAvis()
    if (avis) await enregistrerAvis(cle, { ...avis, runId: run.id, titre: point.titre, empreinte: point.empreinte })
    else if (!index[cle] || index[cle].runId === run.id) await enregistrerAvis(cle, null)
    res.json(r)
  } catch (err) {
    console.error('[agents-ia] avis point failed:', err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' })
  }
})

const resolutionBody = z.object({
  cle: z.string().min(1).max(500),
  /** Why it is resolved; null undoes the résolu. */
  commentaire: z.string().trim().max(2000).nullable(),
})

/** Mark one point of a Superviseur report résolu, with why — what ETM and the
 *  mailboxes cannot see (a phone call, an agreement with the client). Kept on
 *  the run (feedback for the next version) and in the Superviseur's index, so
 *  the next reports list it under « Résolus » while the check still returns it
 *  (lib/agents/superviseur/avis.ts). Same right as scoring a point. */
agentsIaRouter.put('/:slug/runs/:id/points/resolution', async (req, res) => {
  const uid = await evaluateur(req, res)
  if (uid === null) return
  const def = agentOu404(req, res)
  if (!def) return
  if (!def.pointsEvaluables) { res.status(409).json({ error: 'cet agent ne produit pas de points à résoudre' }); return }
  const p = resolutionBody.safeParse(req.body)
  if (!p.success) { res.status(400).json({ error: 'résolution invalide' }); return }
  const { cle, commentaire } = p.data
  if (commentaire !== null && !commentaire) { res.status(400).json({ error: 'Expliquez pourquoi le point est résolu.' }); return }
  try {
    const run = await lireRun(def.slug, req.params.id)
    if (!run) { res.status(404).json({ error: 'exécution introuvable' }); return }
    const sup = run.resultat as Partial<ResultatSuperviseur>
    const carries = (sup.resolus ?? []).find((c) => c.cle === cle)
    const point = [...(sup.constats ?? []), ...(sup.ecartes ?? [])].find((c) => c.cle === cle) ?? carries
    if (!point) { res.status(404).json({ error: 'point introuvable dans ce rapport' }); return }
    const resolution = commentaire ? { commentaire, par: await auteur(uid), le: new Date().toISOString() } : null
    const r = await modifierRun(def.slug, run.id, (x) => {
      const points = { ...(x.resolutionsPoints ?? {}) }
      if (resolution) points[cle] = resolution
      else delete points[cle]
      x.resolutionsPoints = points
    })
    // Undoing on an old report must not wipe a newer résolu — unless this
    // report shows the point as résolu carried from earlier (that IS the one).
    const index = await lireResolutions()
    if (resolution) await enregistrerResolution(cle, { ...resolution, runId: run.id, titre: point.titre, empreinte: point.empreinte })
    else if (!index[cle] || index[cle].runId === run.id || carries) await enregistrerResolution(cle, null)
    res.json(r)
  } catch (err) {
    console.error('[agents-ia] resolution point failed:', err)
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal server error' })
  }
})

/** Every comment given on a version — what the next prompt is written from. */
agentsIaRouter.get('/:slug/retours', async (req, res) => {
  if (session(req, res) === null) return
  const def = agentOu404(req, res)
  if (!def) return
  try {
    const state = await lireEtat(def.slug, def.versionInitiale)
    const version = parseInt(String(req.query.version ?? ''), 10) || state.activeVersion
    const retours: Array<{
      runId: string; runLe: string; source: AgentRun['source']; portee: 'execution' | 'point'
      titre: string | null; note: Note; commentaire: string; par: Auteur; le: string; retrait: string | null
    }> = []
    /** Points marked résolu by hand — what ETM and the mailboxes could not see. */
    const resolutions: Array<{ runId: string; runLe: string; titre: string; commentaire: string; par: Auteur; le: string }> = []
    for (const r of await lireRuns(def.slug)) {
      if (r.version !== version) continue
      const base = { runId: r.id, runLe: r.createdAt, source: r.source }
      if (r.evaluation) retours.push({ ...base, portee: 'execution', titre: r.resume, ...r.evaluation, retrait: r.evaluation.retrait ?? null })
      const sup = r.resultat as Partial<ResultatSuperviseur>
      const titres = new Map([...(sup.constats ?? []), ...(sup.ecartes ?? []), ...(sup.resolus ?? [])].map((c) => [c.cle, c.titre]))
      for (const [cle, a] of Object.entries(r.avisPoints ?? {})) {
        retours.push({ ...base, portee: 'point', titre: titres.get(cle) ?? cle, ...a, retrait: null })
      }
      for (const [cle, x] of Object.entries(r.resolutionsPoints ?? {})) {
        resolutions.push({ runId: r.id, runLe: r.createdAt, titre: titres.get(cle) ?? cle, ...x })
      }
    }
    retours.sort((a, b) => b.le.localeCompare(a.le))
    resolutions.sort((a, b) => b.le.localeCompare(a.le))
    res.json({ version, versions: state.versions.map((v) => v.version).reverse(), retours, resolutions })
  } catch (err) {
    console.error('[agents-ia] retours failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── actions ──────────────────────────────────────────────

agentsIaRouter.post('/:slug/sonder', async (req, res) => {
  const uid = await pilote(req, res)
  if (uid === null) return
  const def = agentOu404(req, res)
  if (!def) return
  try {
    const state = await lireEtat(def.slug, def.versionInitiale)
    if (state.mode === 'off') { res.status(409).json({ error: 'L’agent est à l’arrêt : passez-le en essai ou en service d’abord.' }); return }
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
agentsIaRouter.post('/:slug/essai', upload.single('fichier'), async (req, res) => {
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

agentsIaRouter.get('/:slug/couts', async (req, res) => {
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
  for (const r of await lireRuns(def.slug)) {
    const t = new Date(r.createdAt).getTime()
    if (t < debut) continue
    const d = parJour.get(r.createdAt.slice(0, 10))
    if (d) { d.coutUsd += r.coutUsd || 0; d.runs++ }
    total += r.coutUsd || 0
    n++
  }
  res.json({ jours, totalUsd: total, runs: n, moyenneUsd: n ? total / n : 0, parJour: [...parJour.values()] })
})
