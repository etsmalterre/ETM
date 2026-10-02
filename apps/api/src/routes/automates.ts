// Agents IA › Automates — /api/automates (ETM) and /api/automates-trm (TRM).
// The screen Agents IA › Automates (ETM apps/web pages/Automates.tsx, imported
// by TRM) reads and pilots the automates of lib/automates/.
//
// One route set, mounted once per app (createAutomatesRouter): each mount lists
// only its app's automates and checks its app's permission store
// (lib/agents/app-scope.ts) — the two pointage reports are TRM's, so ETM's
// mount answers 404 for them.
//
// Same guards as /api/agents-ia (helpers imported from there): reads need a
// session (the menu `screen_agents_ia` is the curtain); every write needs
// `edit_agents_ia` (the « Destinataires » switches included; preview and test
// send need the right to read the report, `abonnement.peutLire`). Mounted
// apart from /api/agents-ia so an automate slug can never shadow an agent route.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { auteur, pilote, session } from './agents-ia.js'
import { AGENT_MODES } from '../lib/agents/store.js'
import { avecScope, scopeDe, type AgentsIaScope } from '../lib/agents/app-scope.js'
import { etatSondage, lancerSondage, planificateurAgentsActif, prochainQuotidien, SondageEnCoursError, sousVerrou } from '../lib/agents/scheduler.js'
import { automateDef, automatesDe, type AutomateDef } from '../lib/automates/catalog.js'
import { cleTache, executerAutomate } from '../lib/automates/execution.js'
import { ajouterRetour, changerMode, lireEtat, lireRun, lireRuns, supprimerRetour, type AutomateRun } from '../lib/automates/store.js'
import { AbonnementRefuse, type AbonnementAutomate } from '../lib/automates/abonnement.js'
import { getUserEmail } from '../lib/user-emails.js'
import { msHeureParis } from '../lib/pointage-etat.js'

const routes: RouterType = Router()

/** The router of one app's « Agents IA › Automates » (index.ts mounts ETM's and TRM's). */
export function createAutomatesRouter(scope: AgentsIaScope): RouterType {
  return Router().use(avecScope(scope), routes)
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

function automateOu404(req: Request, res: Response): AutomateDef | null {
  const def = automateDef(req.params.slug, scopeDe(res).app)
  if (!def) res.status(404).json({ error: 'automate inconnu' })
  return def ?? null
}

/** A run without its heavy parts (snapshot, planning rows) for lists. */
function allege(r: AutomateRun) {
  const { resultat: _r, ...reste } = r
  return reste
}

async function vueAutomate(def: AutomateDef) {
  const state = await lireEtat(def.slug)
  const runs = await lireRuns(def.slug)
  const depuis7j = Date.now() - 7 * 86_400_000
  const sondage = etatSondage(cleTache(def.slug))
  const d = def.declenchement
  const prochain =
    state.mode === 'off' || !planificateurAgentsActif()
      ? null
      : d.type === 'quotidien'
        ? prochainQuotidien(d, Date.now(), state.dernierePlanification)
        : new Date((sondage.dernierSondage ? Date.parse(sondage.dernierSondage) : Date.now()) + d.intervalleMs).toISOString()
  return {
    slug: def.slug,
    nom: def.nom,
    description: def.description,
    version: def.version,
    versions: def.versions,
    declencheur: def.declencheur,
    lit: def.lit,
    ecritures: def.ecritures,
    abstention: def.abstention,
    modes: def.modes,
    aUnEtat: !!def.etat,
    aDesDestinataires: !!def.abonnement,
    mode: state.mode,
    modeChangedAt: state.modeChangedAt,
    modeChangedBy: state.modeChangedBy,
    dernierControle: state.dernierControle ?? null,
    planificateurActif: planificateurAgentsActif(),
    prochain,
    sondage,
    stats: {
      executions: runs.length,
      erreurs7j: runs.filter((r) => r.statut === 'erreur' && Date.parse(r.createdAt) >= depuis7j).length,
      derniereEcriture: runs.filter((r) => r.statut === 'applique').at(-1)?.createdAt ?? null,
      derniereErreur: runs.filter((r) => r.statut === 'erreur').at(-1) ?? null,
    },
    retoursVersion: state.retours.filter((r) => r.version === def.version).length,
  }
}

// ── reads ────────────────────────────────────────────────

routes.get('/', async (req, res) => {
  if (session(req, res) === null) return
  try {
    res.json(await Promise.all(automatesDe(scopeDe(res).app).map(vueAutomate)))
  } catch (err) {
    console.error('[automates] list failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

routes.get('/:slug', async (req, res) => {
  if (session(req, res) === null) return
  const def = automateOu404(req, res)
  if (!def) return
  try {
    res.json(await vueAutomate(def))
  } catch (err) {
    console.error('[automates] detail failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

routes.get('/:slug/runs', async (req, res) => {
  if (session(req, res) === null) return
  const def = automateOu404(req, res)
  if (!def) return
  try {
    const statut = typeof req.query.statut === 'string' ? req.query.statut : null
    const runs = (await lireRuns(def.slug)).filter((r) => !statut || r.statut === statut).reverse().slice(0, 500)
    res.json({ runs: runs.map(allege) })
  } catch (err) {
    console.error('[automates] runs failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

routes.get('/:slug/runs/:id', async (req, res) => {
  if (session(req, res) === null) return
  const def = automateOu404(req, res)
  if (!def) return
  const run = await lireRun(def.slug, req.params.id)
  if (!run) { res.status(404).json({ error: 'exécution introuvable' }); return }
  res.json({ run })
})

/** Live view of the device (read-only; logs in and out of the NVR). */
routes.get('/:slug/etat', async (req, res) => {
  if (session(req, res) === null) return
  const def = automateOu404(req, res)
  if (!def) return
  if (!def.etat) { res.status(404).json({ error: 'pas d’état en direct pour cet automate' }); return }
  try {
    res.json({ etat: await def.etat() })
  } catch (err) {
    console.error('[automates] etat failed:', message(err))
    res.status(502).json({ error: message(err) })
  }
})

routes.get('/:slug/retours', async (req, res) => {
  if (session(req, res) === null) return
  const def = automateOu404(req, res)
  if (!def) return
  const state = await lireEtat(def.slug)
  res.json({ retours: [...state.retours].reverse() })
})

// ── destinataires (automates that mail subscribers, lib/automates/abonnement.ts) ──

function abonnementOu404(def: AutomateDef, res: Response): AbonnementAutomate | null {
  if (!def.abonnement) res.status(404).json({ error: 'cet automate n’envoie pas d’e-mail' })
  return def.abonnement ?? null
}

/** `?jour=YYYYMMDD` builds the report as at 09:00 that day (replay a past morning); default = now. */
function instant(req: Request): number | null {
  const j = String(req.query.jour ?? '')
  if (!j) return Date.now()
  if (!/^\d{8}$/.test(j)) return null
  return msHeureParis(+j.slice(0, 4), +j.slice(4, 6), +j.slice(6, 8), 9, 0)
}

/** The people who may receive it, ticked or not. Names and addresses only,
 *  like a run's recipient list: no right beyond the menu. */
routes.get('/:slug/destinataires', async (req, res) => {
  const uid = session(req, res)
  if (uid === null) return
  const def = automateOu404(req, res)
  if (!def) return
  const ab = abonnementOu404(def, res)
  if (!ab) return
  try {
    res.json({ regle: ab.regle, candidats: await ab.candidats(), peutLire: await ab.peutLire(uid) })
  } catch (err) {
    console.error('[automates] destinataires failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const abonneBody = z.object({ abonne: z.boolean() })

routes.put('/:slug/destinataires/:userId', async (req, res) => {
  const uid = await pilote(req, res)
  if (uid === null) return
  const def = automateOu404(req, res)
  if (!def) return
  const ab = abonnementOu404(def, res)
  if (!ab) return
  const userId = parseInt(req.params.userId, 10)
  const parsed = abonneBody.safeParse(req.body)
  if (!Number.isInteger(userId) || userId <= 0 || !parsed.success) { res.status(400).json({ error: 'invalid body' }); return }
  try {
    await ab.changer(userId, parsed.data.abonne)
    res.json({ candidats: await ab.candidats() })
  } catch (err) {
    if (err instanceof AbonnementRefuse) { res.status(409).json({ error: err.message }); return }
    console.error('[automates] destinataire change failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** The report as it would go out — its body carries what the subscribers are
 *  allowed to read (the salariés' hours), so the caller must be allowed too. */
routes.get('/:slug/apercu', async (req, res) => {
  const uid = session(req, res)
  if (uid === null) return
  const def = automateOu404(req, res)
  if (!def) return
  const ab = abonnementOu404(def, res)
  if (!ab) return
  const t = instant(req)
  if (t === null) { res.status(400).json({ error: 'invalid jour' }); return }
  try {
    if (!(await ab.peutLire(uid))) { res.status(403).json({ error: 'permission denied' }); return }
    const r = await ab.apercu(t)
    if (!r) {
      res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:24px">Rien à envoyer à cette date : aucun e-mail ne partirait.</body>')
      return
    }
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>${r.sujet.replace(/</g, '&lt;')}</title><body style="margin:0">${r.html}</body>`)
  } catch (err) {
    console.error('[automates] apercu failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** « M’envoyer un test »: to the caller's own address only, in any env. */
routes.post('/:slug/envoyer-test', async (req, res) => {
  const uid = session(req, res)
  if (uid === null) return
  const def = automateOu404(req, res)
  if (!def) return
  const ab = abonnementOu404(def, res)
  if (!ab) return
  const t = instant(req)
  if (t === null) { res.status(400).json({ error: 'invalid jour' }); return }
  try {
    if (!(await ab.peutLire(uid))) { res.status(403).json({ error: 'Vous n’avez pas le droit de lire ce rapport.' }); return }
    const email = await getUserEmail(uid)
    if (!email) { res.status(409).json({ error: 'Votre compte n’a pas d’adresse e-mail.' }); return }
    const ok = await ab.envoyerTest(t, email)
    if (ok === null) { res.status(404).json({ error: 'Rien à envoyer aujourd’hui : aucun e-mail ne partirait.' }); return }
    if (!ok) { res.status(502).json({ error: 'L’envoi a échoué (voir le journal de l’API).' }); return }
    res.json({ envoye: email })
  } catch (err) {
    console.error('[automates] envoyer-test failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── writes ───────────────────────────────────────────────

const modeBody = z.object({ mode: z.enum(AGENT_MODES as unknown as ['off', 'essai', 'actif']) })

/** Leaving « actif » puts the device back in its fixed state once (under the
 *  automate's lock); the mode changes first so the tick cannot write again. */
routes.patch('/:slug', async (req, res) => {
  const uid = await pilote(req, res)
  if (uid === null) return
  const def = automateOu404(req, res)
  if (!def) return
  const parsed = modeBody.safeParse(req.body)
  if (!parsed.success || !def.modes[parsed.data.mode]) { res.status(400).json({ error: 'mode invalide' }); return }
  try {
    const par = await auteur(uid)
    const avant = await lireEtat(def.slug)
    await changerMode(def.slug, parsed.data.mode, par)
    let avertissement: string | null = null
    if (avant.mode === 'actif' && parsed.data.mode !== 'actif' && def.quitterActif) {
      try {
        await sousVerrou(cleTache(def.slug), () => executerAutomate(def, 'arret', par))
      } catch (err) {
        avertissement = `Mode changé, mais la remise en état a échoué : ${message(err)}`
      }
    }
    res.json({ automate: await vueAutomate(def), avertissement })
  } catch (err) {
    console.error('[automates] mode failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** « Lancer maintenant »: answers 202 at once; the screen polls GET /:slug
 *  until `sondage.dernierLancement.fin`. Off → runs as an essai (writes nothing). */
routes.post('/:slug/lancer', async (req, res) => {
  const uid = await pilote(req, res)
  if (uid === null) return
  const def = automateOu404(req, res)
  if (!def) return
  try {
    res.status(202).json({ lancement: lancerSondage(cleTache(def.slug), await auteur(uid)) })
  } catch (err) {
    if (err instanceof SondageEnCoursError) { res.status(409).json({ error: err.message }); return }
    console.error('[automates] lancer failed:', err)
    res.status(500).json({ error: message(err) })
  }
})

const retourBody = z.object({ texte: z.string().trim().min(1).max(4000), version: z.number().int().positive().optional() })

routes.post('/:slug/retours', async (req, res) => {
  const uid = await pilote(req, res)
  if (uid === null) return
  const def = automateOu404(req, res)
  if (!def) return
  const parsed = retourBody.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: 'Écrivez le retour.' }); return }
  const version = parsed.data.version ?? def.version
  if (!def.versions.some((v) => v.version === version)) { res.status(400).json({ error: 'version inconnue' }); return }
  const retour = await ajouterRetour(def.slug, { version, texte: parsed.data.texte, par: await auteur(uid) })
  res.status(201).json({ retour })
})

routes.delete('/:slug/retours/:id', async (req, res) => {
  const uid = await pilote(req, res)
  if (uid === null) return
  const def = automateOu404(req, res)
  if (!def) return
  if (!(await supprimerRetour(def.slug, req.params.id, await auteur(uid)))) {
    res.status(404).json({ error: 'Retour introuvable, ou écrit par quelqu’un d’autre.' })
    return
  }
  res.json({ ok: true })
})
