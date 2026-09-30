// Auth routes — password login over server-side sessions (2026-09-30, plan
// ~/.claude/plans/user-management.md). One router, used by ETM and TRM (the
// session cookie is shared across *.intra.etsmalterre.com in production).
//
//   GET    /api/auth/config        — what the login screen offers (public)
//   POST   /api/auth/login         — { identifiant, motDePasse } → session cookie
//                                    ({ IDutilisateur } only while AUTH_PICKER=1)
//   POST   /api/auth/poste         — { code } → enrols this PC as a station account
//   GET    /api/auth/me            — current user (401 when none)
//   POST   /api/auth/logout        — ends this session
//   POST   /api/auth/mot-de-passe  — { actuel, nouveau } → change own password
//   GET    /api/auth/users         — accounts list (admins; everyone while AUTH_PICKER=1)
//   POST   /api/auth/voir-comme    — { IDutilisateur | null } admin « Voir comme »
//   GET    /api/auth/sessions      — own live sessions
//   DELETE /api/auth/sessions/:ref — end one of them
//
// Identifiant = `utilisateur.identifiant` OR the email, case-insensitive.
// Every attempt is journaled (table `connexion`); repeated failures slow the
// login down (lib/login-throttle.ts), they never lock an account.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { mpsPg } from '../lib/mps-pg.js'
import {
  SESSION_COOKIE_NAME,
  clearSessionCookie,
  clientIp,
  pickerActif,
  sessionCookieOptions,
} from '../lib/auth.js'
import {
  creerSession,
  definirVoirComme,
  listerSessions,
  revoquerParRef,
  revoquerSession,
  revoquerSessionsDe,
  type TypeSession,
} from '../lib/sessions.js'
import { hacherMotDePasse, motDePasseRefuse, verifierMotDePasse } from '../lib/passwords.js'
import { attenteConnexion, journaliserConnexion } from '../lib/login-throttle.js'
import { consommerCodePoste } from '../lib/postes.js'
import { APPS, appsDe, appsParUtilisateur } from '../lib/utilisateur-apps.js'

export const authRouter: RouterType = Router()

interface Compte {
  idutilisateur: number
  prenom: string | null
  nom: string | null
  idexpediteur: number | null
  identifiant: string | null
  email: string | null
  type_compte: 'personne' | 'poste'
  est_admin: boolean
  actif: boolean
  doit_changer_mdp: boolean
  password_hash: string | null
}

async function compte(id: number): Promise<Compte | null> {
  const [c] = await mpsPg()<Compte[]>`
    SELECT idutilisateur, prenom, nom, idexpediteur, identifiant, email, type_compte,
           est_admin, actif, doit_changer_mdp, password_hash
    FROM utilisateur WHERE idutilisateur = ${id}`
  return c ?? null
}

/** The shape the web apps read (CurrentUser): legacy keys kept. */
function publicUser(c: Compte) {
  return {
    IDutilisateur: c.idutilisateur,
    prenom: c.prenom,
    nom: c.nom,
    IDexpediteur: c.idexpediteur,
    identifiant: c.identifiant,
    email: c.email,
    typeCompte: c.type_compte,
  }
}

async function ouvrirSession(req: Request, res: Response, c: Compte, type: TypeSession = 'navigateur', libelle: string | null = null): Promise<void> {
  const jeton = await creerSession({
    idutilisateur: c.idutilisateur,
    type,
    libelle,
    ip: clientIp(req),
    userAgent: req.headers['user-agent'] ?? null,
  })
  res.cookie(SESSION_COOKIE_NAME, jeton, sessionCookieOptions(type))
}

// ── GET /config ──────────────────────────────────────────────
authRouter.get('/config', (_req, res) => {
  res.json({ picker: pickerActif() })
})

// ── POST /login ──────────────────────────────────────────────
const loginBody = z.union([
  z.object({ identifiant: z.string().trim().min(1).max(200), motDePasse: z.string().min(1).max(200) }),
  z.object({ IDutilisateur: z.number().int().positive() }),
])

const REFUS = 'Identifiant ou mot de passe incorrect.'

// Hashed once: an unknown identifiant still pays one scrypt, so the answer's
// timing does not tell which identifiants exist.
const hashFactice = hacherMotDePasse('compte-inexistant')

authRouter.post('/login', async (req: Request, res: Response) => {
  const parsed = loginBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', message: 'Identifiant et mot de passe requis.' })
    return
  }
  const ip = clientIp(req)
  try {
    // Name picker — only while the transition flag is on.
    if ('IDutilisateur' in parsed.data) {
      if (!pickerActif()) {
        res.status(410).json({ error: 'picker_desactive', message: 'Connectez-vous avec votre identifiant et votre mot de passe.' })
        return
      }
      const c = await compte(parsed.data.IDutilisateur)
      if (!c || !c.actif) { res.status(404).json({ error: 'user not found' }); return }
      await journaliserConnexion({ identifiant: `#${c.idutilisateur}`, idutilisateur: c.idutilisateur, ip, succes: true, motif: 'picker' })
      await ouvrirSession(req, res, c)
      res.json({ ...publicUser(c), isAdmin: c.est_admin, doitChangerMdp: false })
      return
    }

    const { identifiant, motDePasse } = parsed.data
    const attente = await attenteConnexion(identifiant, ip)
    if (attente > 0) {
      const minutes = Math.ceil(attente / 60_000)
      res.set('Retry-After', String(Math.ceil(attente / 1000)))
      res.status(429).json({
        error: 'trop_de_tentatives',
        message: `Trop de tentatives. Réessayez dans ${minutes} minute${minutes > 1 ? 's' : ''}.`,
      })
      return
    }
    const [c] = await mpsPg()<Compte[]>`
      SELECT idutilisateur, prenom, nom, idexpediteur, identifiant, email, type_compte,
             est_admin, actif, doit_changer_mdp, password_hash
      FROM utilisateur WHERE identifiant = ${identifiant} OR email = ${identifiant}
      LIMIT 1`
    const ok = !!c && c.actif && c.type_compte === 'personne' &&
      (await verifierMotDePasse(motDePasse, c.password_hash ?? (await hashFactice))) && !!c.password_hash
    if (!c) await verifierMotDePasse(motDePasse, await hashFactice)
    await journaliserConnexion({
      identifiant,
      idutilisateur: c?.idutilisateur ?? null,
      ip,
      succes: ok,
      motif: ok ? undefined : !c ? 'inconnu' : !c.actif ? 'inactif' : c.type_compte !== 'personne' ? 'poste' : !c.password_hash ? 'sans_mdp' : 'mdp',
    })
    if (!ok) {
      res.status(401).json({ error: 'identifiants_invalides', message: REFUS })
      return
    }
    await mpsPg()`UPDATE utilisateur SET derniere_connexion = now() WHERE idutilisateur = ${c.idutilisateur}`
    await ouvrirSession(req, res, c)
    res.json({ ...publicUser(c), isAdmin: c.est_admin, doitChangerMdp: c.doit_changer_mdp })
  } catch (err) {
    console.error('Error in /auth/login:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /poste — enrol this PC as a station account ─────────
authRouter.post('/poste', async (req: Request, res: Response) => {
  const code = typeof req.body?.code === 'string' ? req.body.code.replace(/\s/g, '') : ''
  const ip = clientIp(req)
  try {
    const attente = await attenteConnexion('poste', ip)
    if (attente > 0) {
      res.status(429).json({ error: 'trop_de_tentatives', message: 'Trop de tentatives. Réessayez plus tard.' })
      return
    }
    const cible = /^\d{6}$/.test(code) ? consommerCodePoste(code) : null
    const c = cible ? await compte(cible.idutilisateur) : null
    const ok = !!c && c.actif && c.type_compte === 'poste'
    await journaliserConnexion({ identifiant: 'poste', idutilisateur: c?.idutilisateur ?? null, ip, succes: ok, motif: ok ? 'enrolement' : 'code' })
    if (!ok || !c || !cible) {
      res.status(401).json({ error: 'code_invalide', message: 'Code invalide ou expiré.' })
      return
    }
    await ouvrirSession(req, res, c, 'poste', cible.libelle)
    res.json({ ...publicUser(c), isAdmin: false, doitChangerMdp: false })
  } catch (err) {
    console.error('Error in /auth/poste:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /me ──────────────────────────────────────────────────
authRouter.get('/me', async (req: Request, res: Response) => {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return
  }
  try {
    const c = await compte(req.userId)
    if (!c) {
      clearSessionCookie(res)
      res.status(401).json({ error: 'user no longer exists' })
      return
    }
    const s = req.session
    const proprietaire = s?.voirComme ? await compte(s.idutilisateur) : null
    res.json({
      ...publicUser(c),
      // Session admin: stays true while an admin looks through someone
      // else, so the header keeps the way back (canSwitchUser()).
      isAdmin: req.adminId !== undefined,
      doitChangerMdp: s ? s.doitChangerMdp && !s.voirComme : false,
      sessionType: s?.type ?? null,
      // The apps this account belongs to: each app's gate refuses a
      // non-member (lib/utilisateur-apps.ts). While an admin « voit comme »,
      // those of the account looked through.
      // Absent while membership is unknown (migration 0004 pending): the gate lets through.
      apps: (await appsDe(c.idutilisateur)) ?? undefined,
      voirComme: proprietaire
        ? { IDutilisateur: proprietaire.idutilisateur, prenom: proprietaire.prenom, nom: proprietaire.nom }
        : null,
    })
  } catch (err) {
    console.error('Error fetching /auth/me:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /logout ─────────────────────────────────────────────
authRouter.post('/logout', async (req: Request, res: Response) => {
  try {
    if (req.session) await revoquerSession(req.session.id)
  } catch (err) {
    console.error('Error in /auth/logout:', err)
  }
  clearSessionCookie(res)
  res.json({ ok: true })
})

// ── POST /mot-de-passe — change own password ─────────────────
const mdpBody = z.object({ actuel: z.string().max(200), nouveau: z.string().max(200) })

authRouter.post('/mot-de-passe', async (req: Request, res: Response) => {
  const s = req.session
  if (!s || s.type !== 'navigateur') {
    res.status(401).json({ error: 'not authenticated' })
    return
  }
  const parsed = mdpBody.safeParse(req.body)
  if (!parsed.success) { res.status(400).json({ error: 'Validation failed' }); return }
  const { actuel, nouveau } = parsed.data
  const refus = motDePasseRefuse(nouveau)
  if (refus) { res.status(400).json({ error: 'mot_de_passe_refuse', message: refus }); return }
  try {
    // Always the session OWNER's password, never the account seen through « Voir comme ».
    const c = await compte(s.idutilisateur)
    if (!c) { res.status(401).json({ error: 'not authenticated' }); return }
    if (c.password_hash && !(await verifierMotDePasse(actuel, c.password_hash))) {
      await journaliserConnexion({ identifiant: c.identifiant ?? `#${c.idutilisateur}`, idutilisateur: c.idutilisateur, ip: clientIp(req), succes: false, motif: 'changement_mdp' })
      res.status(403).json({ error: 'mot_de_passe_actuel', message: 'Le mot de passe actuel est incorrect.' })
      return
    }
    if (actuel && actuel === nouveau) {
      res.status(400).json({ error: 'mot_de_passe_refuse', message: 'Le nouveau mot de passe doit être différent de l’actuel.' })
      return
    }
    await mpsPg()`
      UPDATE utilisateur SET password_hash = ${await hacherMotDePasse(nouveau)},
        doit_changer_mdp = false, mdp_modifie_le = now()
      WHERE idutilisateur = ${c.idutilisateur}`
    // Other browsers logged in with the old password are logged out.
    await revoquerSessionsDe(c.idutilisateur, s.id)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error in /auth/mot-de-passe:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /users — accounts list (admin « Voir comme », picker) ─
authRouter.get('/users', async (req: Request, res: Response) => {
  if (!pickerActif() && !req.session?.estAdmin) {
    res.status(403).json({ error: 'admin access required' })
    return
  }
  try {
    const rows = await mpsPg()<{ idutilisateur: number; prenom: string | null; nom: string | null; type_compte: string }[]>`
      SELECT idutilisateur, prenom, nom, type_compte FROM utilisateur WHERE actif ORDER BY idutilisateur`
    const apps = await appsParUtilisateur()
    const payload = rows
      .map((r) => ({
        IDutilisateur: r.idutilisateur,
        prenom: r.prenom,
        nom: r.nom,
        typeCompte: r.type_compte,
        apps: apps ? apps.get(r.idutilisateur) ?? [] : APPS,
        // Kept for the picker's role labels (UserPicker ROLE_LABELS).
        roleHint: r.type_compte === 'poste' ? (r.prenom ?? '').toLowerCase() : null,
      }))
      .sort((a, b) => (a.nom ?? '').localeCompare(b.nom ?? '', 'fr') || (a.prenom ?? '').localeCompare(b.prenom ?? '', 'fr'))
    res.json(payload)
  } catch (err) {
    console.error('Error fetching /auth/users:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── POST /voir-comme — admin sees the app as another account ─
authRouter.post('/voir-comme', async (req: Request, res: Response) => {
  const s = req.session
  if (!s?.estAdmin) {
    res.status(403).json({ error: 'admin access required' })
    return
  }
  const raw = req.body?.IDutilisateur
  const cible = raw === null || raw === s.idutilisateur ? null : Number(raw)
  if (cible !== null && (!Number.isInteger(cible) || cible <= 0)) {
    res.status(400).json({ error: 'invalid id' })
    return
  }
  try {
    if (cible !== null) {
      const c = await compte(cible)
      if (!c || !c.actif) { res.status(404).json({ error: 'user not found' }); return }
    }
    await definirVoirComme(s.id, cible)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error in /auth/voir-comme:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /sessions, DELETE /sessions/:ref — own sessions ──────
authRouter.get('/sessions', async (req: Request, res: Response) => {
  const s = req.session
  if (!s) { res.status(401).json({ error: 'not authenticated' }); return }
  try {
    const list = await listerSessions(s.idutilisateur)
    res.json(list.map((x) => ({ ...x, courante: s.id.startsWith(x.ref) })))
  } catch (err) {
    console.error('Error in /auth/sessions:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

authRouter.delete('/sessions/:ref', async (req: Request, res: Response) => {
  const s = req.session
  if (!s) { res.status(401).json({ error: 'not authenticated' }); return }
  try {
    const ok = await revoquerParRef(s.idutilisateur, String(req.params.ref))
    if (!ok) { res.status(404).json({ error: 'session not found' }); return }
    if (s.id.startsWith(String(req.params.ref))) clearSessionCookie(res)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting session:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
