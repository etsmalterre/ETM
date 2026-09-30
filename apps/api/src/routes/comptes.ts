// Account administration (Paramètres › Utilisateurs › Compte) — effective
// admin only. Password login since 2026-09-30 (plan
// ~/.claude/plans/user-management.md). No account is ever deleted: a person
// who leaves is DEACTIVATED (sessions revoked, login refused, history kept).
//
//   GET    /api/comptes                        — every account, with its `apps` (each app's screen lists its members)
//   POST   /api/comptes                        — create { prenom, nom, identifiant, email?, typeCompte, apps }
//   PATCH  /api/comptes/:id                    — { prenom?, nom?, identifiant?, email?, actif?, estAdmin?, apps? }
//   POST   /api/comptes/:id/mot-de-passe       — { motDePasse? , doitChanger? } → { motDePasse } shown once
//   DELETE /api/comptes/:id/mot-de-passe       — no password any more (and every session ends)
//   GET    /api/comptes/:id/sessions           — live sessions
//   DELETE /api/comptes/:id/sessions[/:ref]    — end one / all
//   POST   /api/comptes/:id/code-poste         — { libelle } → one-time code enrolling a PC (station account)
//   GET    /api/comptes/:id/connexions         — last login attempts

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import type { Sql } from 'postgres'
import { z } from 'zod'
import { mpsPg } from '../lib/mps-pg.js'
import { requireAdmin } from '../lib/auth.js'
import { genererMotDePasse, hacherMotDePasse, motDePasseRefuse } from '../lib/passwords.js'
import { listerSessions, revoquerParRef, revoquerSessionsDe } from '../lib/sessions.js'
import { genererCodePoste } from '../lib/postes.js'
import { APPS, appsDe, appsParUtilisateur, ecrireApps, oublierApps, refusApps, type AppCode } from '../lib/utilisateur-apps.js'

export const comptesRouter: RouterType = Router()

interface LigneCompte {
  idutilisateur: number
  prenom: string | null
  nom: string | null
  identifiant: string | null
  email: string | null
  type_compte: 'personne' | 'poste'
  est_admin: boolean
  actif: boolean
  a_mot_de_passe: boolean
  doit_changer_mdp: boolean
  mdp_modifie_le: Date | null
  derniere_connexion: Date | null
  sessions: number
}

const iso = (d: Date | null) => d?.toISOString() ?? null

/** `apps` null = membership unknown (migration 0004 pending): both apps. */
function versJson(r: LigneCompte, apps: Map<number, AppCode[]> | null) {
  return {
    IDutilisateur: r.idutilisateur,
    prenom: r.prenom,
    nom: r.nom,
    identifiant: r.identifiant,
    email: r.email,
    typeCompte: r.type_compte,
    estAdmin: r.est_admin,
    actif: r.actif,
    aMotDePasse: r.a_mot_de_passe,
    doitChangerMdp: r.doit_changer_mdp,
    mdpModifieLe: iso(r.mdp_modifie_le),
    derniereConnexion: iso(r.derniere_connexion),
    sessions: r.sessions,
    apps: apps ? apps.get(r.idutilisateur) ?? [] : APPS,
  }
}

/** One account as JSON, or null when it does not exist. */
async function unCompte(id: number) {
  const [c] = await lister(id)
  return c ? versJson(c, await appsParUtilisateur()) : null
}

async function lister(id?: number): Promise<LigneCompte[]> {
  const sql = mpsPg()
  return sql<LigneCompte[]>`
    SELECT u.idutilisateur, u.prenom, u.nom, u.identifiant, u.email, u.type_compte, u.est_admin,
           u.actif, u.password_hash IS NOT NULL AS a_mot_de_passe, u.doit_changer_mdp,
           u.mdp_modifie_le, u.derniere_connexion,
           (SELECT count(*)::int FROM session s WHERE s.idutilisateur = u.idutilisateur
              AND s.revoque_le IS NULL AND (s.expire_le IS NULL OR s.expire_le > now())) AS sessions
    FROM utilisateur u
    ${id !== undefined ? sql`WHERE u.idutilisateur = ${id}` : sql``}
    ORDER BY u.actif DESC, u.nom NULLS LAST, u.prenom`
}

function idParam(req: Request, res: Response): number | null {
  const id = parseInt(String(req.params.id), 10)
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'invalid id' })
    return null
  }
  return id
}

/** Postgres unique violation → the French message for the field. */
function conflit(err: unknown, res: Response): boolean {
  const e = err as { code?: string; constraint_name?: string }
  if (e.code !== '23505') return false
  const champ = e.constraint_name?.includes('email') ? 'Cette adresse e-mail' : 'Cet identifiant'
  res.status(409).json({ error: 'deja_utilise', message: `${champ} est déjà utilisé par un autre compte.` })
  return true
}

const identifiantSchema = z.string().trim().toLowerCase()
  .regex(/^[a-z0-9][a-z0-9._-]{1,39}$/, 'Identifiant : 2 à 40 caractères, lettres minuscules, chiffres, . _ -')
const emailSchema = z.string().trim().toLowerCase().max(200)
  .refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Adresse e-mail invalide')

// ── GET / ────────────────────────────────────────────────────
comptesRouter.get('/', async (req, res) => {
  if (!requireAdmin(req, res)) return
  try {
    const apps = await appsParUtilisateur()
    res.json((await lister()).map((c) => versJson(c, apps)))
  } catch (err) {
    console.error('Error listing comptes:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST / ───────────────────────────────────────────────────
const creerBody = z.object({
  prenom: z.string().trim().min(1).max(60),
  nom: z.string().trim().max(60).default(''),
  identifiant: identifiantSchema,
  email: emailSchema.default(''),
  typeCompte: z.enum(['personne', 'poste']).default('personne'),
  /** The app whose screen creates it — never implicit. */
  apps: z.array(z.enum(APPS as [AppCode, ...AppCode[]])).min(1),
})

comptesRouter.post('/', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const parsed = creerBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', message: parsed.error.issues[0]?.message })
    return
  }
  const b = parsed.data
  try {
    const sql = mpsPg()
    const id = await sql.begin(async (t) => {
      const tx = t as unknown as Sql // postgres.js typing: TransactionSql loses its call signatures
      const [row] = await tx<{ idutilisateur: number }[]>`
        INSERT INTO utilisateur (prenom, nom, identifiant, email, type_compte, idexpediteur)
        VALUES (${b.prenom}, ${b.nom || null}, ${b.identifiant}, ${b.email || null}, ${b.typeCompte}, 0)
        RETURNING idutilisateur`
      await ecrireApps(tx, row.idutilisateur, b.apps)
      return row.idutilisateur
    })
    oublierApps()
    res.status(201).json(await unCompte(id))
  } catch (err) {
    if (conflit(err, res)) return
    console.error('Error creating compte:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PATCH /:id ───────────────────────────────────────────────
const patchBody = z.object({
  prenom: z.string().trim().min(1).max(60).optional(),
  nom: z.string().trim().max(60).optional(),
  identifiant: identifiantSchema.optional(),
  email: emailSchema.optional(),
  actif: z.boolean().optional(),
  estAdmin: z.boolean().optional(),
  /** The whole set: joining or leaving an app (Compte panel « Applications »). */
  apps: z.array(z.enum(APPS as [AppCode, ...AppCode[]])).optional(),
})

comptesRouter.patch('/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const id = idParam(req, res)
  if (id === null) return
  const parsed = patchBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', message: parsed.error.issues[0]?.message })
    return
  }
  const b = parsed.data
  if (id === req.userId && (b.actif === false || b.estAdmin === false)) {
    res.status(409).json({ error: 'soi_meme', message: 'Vous ne pouvez pas retirer vos propres droits d’administrateur ni désactiver votre compte.' })
    return
  }
  const sets: Record<string, unknown> = {}
  if (b.prenom !== undefined) sets.prenom = b.prenom
  if (b.nom !== undefined) sets.nom = b.nom || null
  if (b.identifiant !== undefined) sets.identifiant = b.identifiant
  if (b.email !== undefined) sets.email = b.email || null
  if (b.actif !== undefined) sets.actif = b.actif
  if (b.estAdmin !== undefined) sets.est_admin = b.estAdmin
  try {
    if (b.apps !== undefined) {
      const refus = refusApps((await appsDe(id)) ?? APPS, b.apps, id === req.userId)
      if (refus) { res.status(409).json({ error: 'apps_refusees', message: refus }); return }
    }
    const sql = mpsPg()
    const trouve = await sql.begin(async (t) => {
      const tx = t as unknown as Sql
      const [existe] = await tx`SELECT 1 FROM utilisateur WHERE idutilisateur = ${id} FOR UPDATE`
      if (!existe) return false
      if (Object.keys(sets).length) await tx`UPDATE utilisateur SET ${sql(sets)} WHERE idutilisateur = ${id}`
      if (b.apps !== undefined) await ecrireApps(tx, id, b.apps)
      return true
    })
    if (b.apps !== undefined) oublierApps()
    if (!trouve) { res.status(404).json({ error: 'not found' }); return }
    if (b.actif === false) await revoquerSessionsDe(id)
    const c = await unCompte(id)
    if (!c) { res.status(404).json({ error: 'not found' }); return }
    res.json(c)
  } catch (err) {
    if (conflit(err, res)) return
    console.error('Error updating compte:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /:id/mot-de-passe ───────────────────────────────────
const mdpBody = z.object({
  motDePasse: z.string().max(200).optional(),
  doitChanger: z.boolean().default(false),
})

comptesRouter.post('/:id/mot-de-passe', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const id = idParam(req, res)
  if (id === null) return
  const parsed = mdpBody.safeParse(req.body ?? {})
  if (!parsed.success) { res.status(400).json({ error: 'Validation failed' }); return }
  const motDePasse = parsed.data.motDePasse?.length ? parsed.data.motDePasse : genererMotDePasse()
  const refus = motDePasseRefuse(motDePasse)
  if (refus) { res.status(400).json({ error: 'mot_de_passe_refuse', message: refus }); return }
  try {
    const rows = await mpsPg()`
      UPDATE utilisateur SET password_hash = ${await hacherMotDePasse(motDePasse)},
        doit_changer_mdp = ${parsed.data.doitChanger}, mdp_modifie_le = now()
      WHERE idutilisateur = ${id} AND type_compte = 'personne'
      RETURNING idutilisateur`
    if (!rows.length) {
      res.status(404).json({ error: 'not found', message: 'Compte introuvable, ou compte de poste (sans mot de passe).' })
      return
    }
    // A reset ends every session of the account — except the admin's own
    // current one when they set their own password.
    await revoquerSessionsDe(id, id === req.session?.idutilisateur ? req.session.id : undefined)
    res.json({ motDePasse })
  } catch (err) {
    console.error('Error setting password:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

comptesRouter.delete('/:id/mot-de-passe', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const id = idParam(req, res)
  if (id === null) return
  if (id === req.userId) {
    res.status(409).json({ error: 'soi_meme', message: 'Vous ne pouvez pas retirer votre propre mot de passe.' })
    return
  }
  try {
    await mpsPg()`UPDATE utilisateur SET password_hash = NULL, doit_changer_mdp = false, mdp_modifie_le = now() WHERE idutilisateur = ${id}`
    await revoquerSessionsDe(id)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error removing password:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Sessions ─────────────────────────────────────────────────
comptesRouter.get('/:id/sessions', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const id = idParam(req, res)
  if (id === null) return
  try {
    const list = await listerSessions(id)
    res.json(list.map((x) => ({ ...x, courante: !!req.session?.id.startsWith(x.ref) })))
  } catch (err) {
    console.error('Error listing sessions:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

comptesRouter.delete('/:id/sessions', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const id = idParam(req, res)
  if (id === null) return
  try {
    const n = await revoquerSessionsDe(id, req.session?.idutilisateur === id ? req.session.id : undefined)
    res.json({ revoquees: n })
  } catch (err) {
    console.error('Error revoking sessions:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

comptesRouter.delete('/:id/sessions/:ref', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const id = idParam(req, res)
  if (id === null) return
  try {
    const ok = await revoquerParRef(id, String(req.params.ref))
    if (!ok) { res.status(404).json({ error: 'session not found' }); return }
    res.json({ ok: true })
  } catch (err) {
    console.error('Error revoking session:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /:id/code-poste ─────────────────────────────────────
comptesRouter.post('/:id/code-poste', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const id = idParam(req, res)
  if (id === null) return
  const libelle = typeof req.body?.libelle === 'string' ? req.body.libelle.trim().slice(0, 80) : ''
  if (!libelle) {
    res.status(400).json({ error: 'libelle_requis', message: 'Donnez un nom au poste (ex. « PC visitage »).' })
    return
  }
  try {
    const [c] = await lister(id)
    if (!c || c.type_compte !== 'poste' || !c.actif) {
      res.status(409).json({ error: 'pas_un_poste', message: 'Seul un compte de poste actif peut être enrôlé sur un PC.' })
      return
    }
    res.json(genererCodePoste(id, libelle, req.userId!))
  } catch (err) {
    console.error('Error generating poste code:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /:id/connexions ──────────────────────────────────────
comptesRouter.get('/:id/connexions', async (req, res) => {
  if (!requireAdmin(req, res)) return
  const id = idParam(req, res)
  if (id === null) return
  try {
    const rows = await mpsPg()<{ le: Date; identifiant: string; ip: string | null; succes: boolean; motif: string | null }[]>`
      SELECT le, identifiant, ip, succes, motif FROM connexion
      WHERE idutilisateur = ${id} ORDER BY le DESC LIMIT 30`
    res.json(rows.map((r) => ({ ...r, le: r.le.toISOString() })))
  } catch (err) {
    console.error('Error listing connexions:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
