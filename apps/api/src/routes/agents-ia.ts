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
  activerVersion,
  changerMode,
  lireEtat,
  lireFichier,
  lireRun,
  lireRuns,
  modifierRun,
  publierVersion,
  versionActive,
  type AgentRun,
  type AgentState,
  type Auteur,
} from '../lib/agents/store.js'
import { etatSondage, sonder, SondageEnCoursError } from '../lib/agents/scheduler.js'
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

function agentOu404(req: Request, res: Response): AgentDef | null {
  const def = agentDef(req.params.slug)
  if (!def) res.status(404).json({ error: 'agent inconnu' })
  return def ?? null
}

function statistiques(runs: AgentRun[], state: AgentState) {
  // Stats cover the active version only (MFProd rule): a new prompt starts a new score.
  const actifs = runs.filter((r) => r.version === state.activeVersion && r.source !== 'essai_manuel')
  const parStatut: Record<string, number> = {}
  for (const r of actifs) parStatut[r.statut] = (parStatut[r.statut] ?? 0) + 1
  const juges = actifs.filter((r) => r.verdict)
  return {
    total: actifs.length,
    parStatut,
    verdicts: { correct: juges.filter((r) => r.verdict!.valeur === 'correct').length, incorrect: juges.filter((r) => r.verdict!.valeur === 'incorrect').length },
    coutUsd: actifs.reduce((s, r) => s + (r.coutUsd || 0), 0),
    dernierRun: runs.length ? runs[runs.length - 1].createdAt : null,
  }
}

/** A run without the heavy parts (OCR text) for lists. */
function allege(r: AgentRun) {
  const { resultat, ...rest } = r
  const res = resultat as { extraction?: { pieces?: unknown[]; numero_bordereau?: string; numero_commande?: string } }
  return {
    ...rest,
    bordereau: res.extraction?.numero_bordereau ?? null,
    commande: res.extraction?.numero_commande ?? null,
    nbPieces: res.extraction?.pieces?.length ?? null,
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
    mode: state.mode,
    startedAt: state.startedAt,
    modeChangedAt: state.modeChangedAt,
    modeChangedBy: state.modeChangedBy,
    versionActive: { version: v.version, model: v.model },
    stats: statistiques(runs, state),
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
    const runs = (await lireRuns(def.slug)).filter((r) => !statut || statut.includes(r.statut)).reverse()
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

const verdictBody = z.object({
  valeur: z.enum(['correct', 'incorrect']).nullable(),
  commentaire: z.string().trim().max(1000).default(''),
})

agentsIaRouter.put('/:slug/runs/:id/verdict', async (req, res) => {
  const uid = await pilote(req, res)
  if (uid === null) return
  const def = agentOu404(req, res)
  if (!def) return
  const p = verdictBody.safeParse(req.body)
  if (!p.success) { res.status(400).json({ error: 'verdict invalide' }); return }
  const par = await auteur(uid)
  const r = await modifierRun(def.slug, req.params.id, (run) => {
    run.verdict = p.data.valeur ? { valeur: p.data.valeur, commentaire: p.data.commentaire, par, le: new Date().toISOString() } : null
  })
  if (!r) { res.status(404).json({ error: 'exécution introuvable' }); return }
  res.json(r)
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
    const runs = await sonder(def.slug, await auteur(uid))
    res.json({ runs: runs.map(allege) })
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
