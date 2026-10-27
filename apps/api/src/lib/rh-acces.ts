// Who may open the RH menu.
//
// RH lives in the Console Administration (2026-10-27), so two gates stand in
// front of it, each enforced server-side:
//
//   1. console membership (`exigerConsole`, lib/console-acces.ts, mounted on
//      /rh in index.ts): a non-member gets 404 before reaching this file;
//   2. the RH menu of the Écrans axis (`screen_rh`, never handed out by the
//      seed scripts): every /rh route checks it (peutOuvrirRh).
//
// Until 2026-10-27 a third lock asked for a personal « code RH », then the
// account password again (cookie `mps_rh`, 12 h). It dated from the name
// picker, when anyone could log in as anyone; with password login (2026-09-30)
// and the console gate it only re-asked the password the session already
// proved, so it was removed (decision Vincent 2026-10-27). The `rh.code_acces`
// table stays, unused, like every append-only migration of lib/rh-store.ts.

import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { query } from './hfsql-auto.js'
import { isEffectiveAdmin } from './auth.js'
import { getUserPermissions } from './permissions.js'
import { menuAccessKey, screenHideKey } from './screen-keys.js'

export interface PersonneRh {
  /** Stable key stored in the database (journal) — one per PERSON,
   *  not per `utilisateur` row (Isabelle has home + bureau, one key). */
  cle: string
  label: string
}

/** The two people who held RH before it joined the Écrans axis: their keys
 *  stay what the database already stores their journal under. */
const CLES_HISTORIQUES = [
  { cle: 'vincent', prenom: 'vincent', nom: 'malterre', label: 'Vincent Malterre' },
  { cle: 'isabelle', prenom: 'isabelle', nom: 'malterre', label: 'Isabelle Malterre' },
] as const

const ascii = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

/** Who a `utilisateur` row is for RH — identity only, access is peutOuvrirRh.
 *  Keyed by name so every PC row of a person shares one key. Any other
 *  person gets `u-<prénom>-<nom>`: the `u-` prefix can never collide with a
 *  historical key. */
export function personneRh(u: { prenom?: string | null; nom?: string | null }): PersonneRh | null {
  const prenom = (u.prenom ?? '').trim()
  const nom = (u.nom ?? '').trim()
  const p = prenom.toLowerCase()
  const n = nom.toLowerCase()
  const hist = CLES_HISTORIQUES.find((x) => x.prenom === p && x.nom === n)
  if (hist) return { cle: hist.cle, label: hist.label }
  const slug = ascii(`${prenom} ${nom}`)
  if (!slug) return null
  return { cle: `u-${slug}`, label: `${prenom} ${nom}`.trim() }
}

export const RH_MENU = '/rh'
export const RH_ECRANS = ['/rh/employes', '/rh/charge'] as const

/** The first lock: the RH menu granted in Écrans (admins always pass) with at
 *  least one of its screens left visible — hiding both is revoking the menu,
 *  the same rule the navigation applies. Read on every request, never cached:
 *  a withdrawal takes effect at once. */
export async function peutOuvrirRh(userId: number | undefined, admin: boolean): Promise<boolean> {
  if (!userId) return false
  if (admin) return true
  const granted = new Set(await getUserPermissions(userId))
  return granted.has(menuAccessKey(RH_MENU)) && RH_ECRANS.some((s) => !granted.has(screenHideKey(s)))
}

// ── Who is the current user (cached: one HFSQL read per user per 5 min) ──

const CACHE_MS = 5 * 60_000
const cache = new Map<number, { at: number; personne: PersonneRh | null }>()

export async function personneRhDeUtilisateur(userId: number | undefined): Promise<PersonneRh | null> {
  if (!userId) return null
  const hit = cache.get(userId)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.personne
  const rows = await query<{ prenom: string | null; nom: string | null }>(
    `SELECT prenom, nom FROM utilisateur WHERE IDutilisateur = ${Number(userId)}`,
  )
  const personne = rows[0] ? personneRh(rows[0]) : null
  cache.set(userId, { at: Date.now(), personne })
  return personne
}

/** The RH person behind this request, or null when they may not open RH. */
export async function personneRhAutorisee(req: Request): Promise<PersonneRh | null> {
  if (!(await peutOuvrirRh(req.userId, isEffectiveAdmin(req)))) return null
  return personneRhDeUtilisateur(req.userId)
}

// ── Route guard ──────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      /** Set by requireRh(): the RH person behind the request (journal key). */
      personneRh?: PersonneRh
    }
  }
}

/** 404 for anyone without the RH menu in Écrans (it does not exist for them). */
export function requireRh(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    personneRhAutorisee(req)
      .then((personne) => {
        if (!personne) {
          res.status(404).json({ error: 'Not found' })
          return
        }
        req.personneRh = personne
        next()
      })
      .catch(next)
  }
}
