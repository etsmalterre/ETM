// Per-user permission keys, one store per app, in the PostgreSQL table
// `permission` (migration 0001_comptes_utilisateurs). Replaces
// data/permissions.json and data/permissions-trm.json (2026-09-30); the public
// functions of lib/permissions.ts and lib/permissions-trm.ts are unchanged.
//
// Every request checks keys, so the whole table (a few hundred rows) is cached
// in memory: dropped on every write from this process and after CACHE_MS, so
// a script writing from another process shows up within that delay.

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'

export type PermissionApp = 'etm' | 'trm'

export interface PermissionStore {
  get(userId: number): Promise<string[]>
  /** Replace a user's keys. Unstorable keys dropped, duplicates collapsed. */
  set(userId: number, keys: readonly string[]): Promise<void>
  all(): Promise<Record<number, string[]>>
}

const CACHE_MS = 30_000

/** Every store's cache reset, for a membership change (lib/utilisateur-apps.ts). */
const oublis: Array<() => void> = []
export function oublierPermissions(): void {
  for (const f of oublis) f()
}

export function createPermissionStore(app: PermissionApp, isStorable: (k: string) => boolean): PermissionStore {
  let cache: { at: number; byUser: Map<number, string[]> } | null = null
  oublis.push(() => { cache = null })

  // Members of the app only (table utilisateur_app): an account that left the
  // app keeps its rows — re-joining restores them — but holds none of them.
  async function load(): Promise<Map<number, string[]>> {
    if (cache && Date.now() - cache.at < CACHE_MS) return cache.byUser
    const sql = mpsPg()
    const rows = await sql<{ idutilisateur: number; cle: string }[]>`
      SELECT p.idutilisateur, p.cle FROM permission p
      JOIN utilisateur_app m ON m.idutilisateur = p.idutilisateur AND m.app = p.app
      WHERE p.app = ${app} ORDER BY p.idutilisateur, p.cle`.catch((err: unknown) => {
      // Migration 0004 not applied yet: every row, as before membership.
      if ((err as { code?: string })?.code !== '42P01') throw err
      return sql<{ idutilisateur: number; cle: string }[]>`
        SELECT idutilisateur, cle FROM permission WHERE app = ${app} ORDER BY idutilisateur, cle`
    })
    const byUser = new Map<number, string[]>()
    for (const r of rows) {
      const list = byUser.get(r.idutilisateur)
      if (list) list.push(r.cle)
      else byUser.set(r.idutilisateur, [r.cle])
    }
    cache = { at: Date.now(), byUser }
    return byUser
  }

  return {
    async get(userId) {
      return [...((await load()).get(userId) ?? [])]
    },
    async set(userId, keys) {
      const cleaned = [...new Set(keys.filter(isStorable))]
      const sql = mpsPg()
      await sql.begin(async (t) => {
        const tx = t as unknown as Sql // postgres.js typing: TransactionSql loses its call signatures
        await tx`DELETE FROM permission WHERE idutilisateur = ${userId} AND app = ${app}`
        if (cleaned.length) {
          await tx`INSERT INTO permission ${sql(cleaned.map((cle) => ({ idutilisateur: userId, app, cle })))}`
        }
      })
      cache = null
    },
    async all() {
      const out: Record<number, string[]> = {}
      for (const [id, keys] of await load()) out[id] = [...keys]
      return out
    },
  }
}
