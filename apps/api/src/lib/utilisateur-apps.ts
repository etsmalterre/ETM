// Which company's app an account belongs to — table `utilisateur_app`
// (migration 0004_utilisateur_app). One login for ETM and TRM, but each app
// has its own members, managed from its Paramètres › Utilisateurs:
//   • the app's gate refuses a non-member (`apps` of GET /api/auth/me,
//     AuthGate on the web);
//   • a non-member holds none of the app's rights, whatever rows are left in
//     `permission` (lib/permission-store.ts reads members only), and receives
//     none of its notification emails (lib/notifications.ts). Leaving an app
//     keeps those rows: re-joining restores them.
//
// Cached like the permission store; every write from this process drops the
// caches, a script writing from another process shows within CACHE_MS.
//
// ⚠️ Until migration 0004 is applied (`mps-migrate.ts --write`, owner role,
// a deploy step) the table does not exist: membership is then UNKNOWN (null)
// and every reader falls back to the behaviour before it — everyone in both
// apps — with an error in the log, rather than a 500 on /auth/me and on every
// permission check.

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'
import { oublierPermissions, type PermissionApp } from './permission-store.js'
import { refusAppsDuType, type TypeCompte } from './types-compte.js'

export type AppCode = PermissionApp
export const APPS: readonly AppCode[] = ['etm', 'trm']

const CACHE_MS = 30_000
let cache: { at: number; byUser: Map<number, AppCode[]> | null } | null = null

/** PostgreSQL « undefined_table »: migration 0004 not applied yet. */
export function tableAbsente(err: unknown): boolean {
  return (err as { code?: string })?.code === '42P01'
}

async function load(): Promise<Map<number, AppCode[]> | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.byUser
  let rows: { idutilisateur: number; app: AppCode }[]
  try {
    rows = await mpsPg()<{ idutilisateur: number; app: AppCode }[]>`
      SELECT idutilisateur, app FROM utilisateur_app ORDER BY idutilisateur, app`
  } catch (err) {
    if (!tableAbsente(err)) throw err
    console.error('utilisateur_app missing — apply migration 0004 (mps-migrate.ts --write); membership ignored')
    cache = { at: Date.now(), byUser: null }
    return null
  }
  const byUser = new Map<number, AppCode[]>()
  for (const r of rows) {
    const list = byUser.get(r.idutilisateur)
    if (list) list.push(r.app)
    else byUser.set(r.idutilisateur, [r.app])
  }
  cache = { at: Date.now(), byUser }
  return byUser
}

/** The apps an account belongs to (empty: none; null: membership unknown). */
export async function appsDe(userId: number): Promise<AppCode[] | null> {
  const byUser = await load()
  return byUser ? [...(byUser.get(userId) ?? [])] : null
}

/** Every account's apps, for the admin lists (null: membership unknown). */
export async function appsParUtilisateur(): Promise<Map<number, AppCode[]> | null> {
  const byUser = await load()
  return byUser ? new Map(byUser) : null
}

/** The members of one app (null: membership unknown — nobody filtered). */
export async function membres(app: AppCode): Promise<Set<number> | null> {
  const byUser = await load()
  if (!byUser) return null
  const out = new Set<number>()
  for (const [id, apps] of byUser) if (apps.includes(app)) out.add(id)
  return out
}

/** Why a membership change is refused, or null. `soiMeme`: the admin edits
 *  their own account — leaving an app from its own screen would lock them out
 *  of it mid-click. An account always keeps one app — except an 'appareils'
 *  account, which holds none (lib/types-compte.ts): to shut someone out of
 *  both, deactivate the account. */
export function refusApps(
  avant: readonly AppCode[],
  apres: readonly AppCode[],
  soiMeme: boolean,
  typeCompte: TypeCompte = 'personne',
): string | null {
  const refus = refusAppsDuType(typeCompte, apres)
  if (refus) return refus
  if (soiMeme && avant.some((a) => !apres.includes(a))) {
    return 'Vous ne pouvez pas vous retirer vous-même d’une application.'
  }
  return null
}

/** Replace an account's apps inside the caller's transaction (account
 *  creation, PATCH). The caller calls oublierApps() once it has committed —
 *  dropping the cache before the commit would let a read in between cache
 *  the old rows again. */
export async function ecrireApps(tx: Sql, userId: number, apps: readonly AppCode[]): Promise<void> {
  const list = [...new Set(apps)].filter((a) => APPS.includes(a))
  await tx`DELETE FROM utilisateur_app WHERE idutilisateur = ${userId}`
  if (list.length) {
    await tx`INSERT INTO utilisateur_app ${mpsPg()(list.map((app) => ({ idutilisateur: userId, app })))}`
  }
}

/** Drop the membership cache and every permission store's (their rows are
 *  read through the membership). */
export function oublierApps(): void {
  cache = null
  oublierPermissions()
}
