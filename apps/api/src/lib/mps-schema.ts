// Schema changes of the `mps` PostgreSQL database, since the cutover
// (2026-09-29: WinDev and HFSQL retired, PostgreSQL is the only database, its
// schema is ours to change).
//
// Append-only, like lib/espace-client-acces.ts: never edit a shipped
// migration, add the next one. Each entry runs once, in order, inside one
// transaction with its bookkeeping row in `schema_migration`.
//
// NOT applied by the API at startup: the API's production role (mps_api_prod)
// reads and writes rows but owns no table, so it cannot ALTER them — on
// purpose. `scripts/mps-migrate.ts` applies them with the owner's connection
// (MPS_PG_OWNER_URL, or PG_CONNECTION_STRING in dev where `mps_dev` owns its
// copy), as a deploy step BEFORE the new API starts.
//
// ⚠️ A table created here must also be granted to the API role in the same
// migration (`GRANT … TO mps_api_prod` — guarded by `grantApi()` so the dev
// copy, which has no such role, runs the same text).

import type { Sql } from 'postgres'

export interface Migration {
  /** Stable, unique, never renamed — it is the bookkeeping key. */
  name: string
  sql: string
}

/** GRANT to the production API role when it exists (dev copies have none). */
export function grantApi(privileges: string, objects: string): string {
  return `DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mps_api_prod') THEN
    GRANT ${privileges} ON ${objects} TO mps_api_prod;
  END IF;
END $$;`
}

export const MIGRATIONS: Migration[] = []

export interface MigrationStatus {
  applied: string[]
  pending: string[]
  /** Applied in the database but absent from MIGRATIONS — a renamed or deleted entry. */
  unknown: string[]
}

async function ensureTable(s: Sql): Promise<void> {
  await s`CREATE TABLE IF NOT EXISTS schema_migration (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`
}

export async function migrationStatus(s: Sql, list: Migration[] = MIGRATIONS): Promise<MigrationStatus> {
  await ensureTable(s)
  const rows = await s<{ name: string }[]>`SELECT name FROM schema_migration`
  const done = new Set(rows.map((r) => r.name))
  const known = new Set(list.map((m) => m.name))
  return {
    applied: list.filter((m) => done.has(m.name)).map((m) => m.name),
    pending: list.filter((m) => !done.has(m.name)).map((m) => m.name),
    unknown: [...done].filter((n) => !known.has(n)),
  }
}

/** Applies every pending migration, each in its own transaction. Returns the names applied. */
export async function applyMigrations(s: Sql, list: Migration[] = MIGRATIONS): Promise<string[]> {
  const names = list.map((m) => m.name)
  if (new Set(names).size !== names.length) throw new Error('mps-schema: duplicate migration name')
  await ensureTable(s)
  const applied: string[] = []
  for (const m of list) {
    const done = await s.begin(async (t) => {
      const tx = t as unknown as Sql // postgres.js typing: TransactionSql loses its call signatures
      await tx`LOCK TABLE schema_migration IN EXCLUSIVE MODE`
      const [row] = await tx`SELECT 1 FROM schema_migration WHERE name = ${m.name}`
      if (row) return false
      await tx.unsafe(m.sql)
      await tx`INSERT INTO schema_migration (name) VALUES (${m.name})`
      return true
    })
    if (done) applied.push(m.name)
  }
  return applied
}
