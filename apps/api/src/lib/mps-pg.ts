// Native PostgreSQL access to the `mps` database for code written after the
// cutover (2026-09-29): parameterised queries through postgres.js, lowercase
// column names, real booleans and timestamps — NOT the HFSQL-compatible
// adapter of lib/pg-backend.ts (which rewrites SQL and hands back the bridge's
// key and value shapes for the ~2 700 legacy queries).
//
// Same database and credentials (PG_CONNECTION_STRING), its own small pool.
// bigint ids come back as numbers (every id in mps fits in 2^53).

import postgres, { type Sql } from 'postgres'

let sql: Sql | null = null

export class MpsPgIndisponible extends Error {
  constructor() { super('mps-pg: PG_CONNECTION_STRING is not set') }
}

/** The pool, opened on first use (entry points load .env before any call). */
export function mpsPg(): Sql {
  if (sql) return sql
  const url = process.env.PG_CONNECTION_STRING
  if (!url) throw new MpsPgIndisponible()
  sql = postgres(url, {
    max: 3,
    idle_timeout: 60,
    connect_timeout: 10,
    onnotice: () => {},
    connection: { application_name: 'mps-api native' },
    types: {
      int8: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
    },
  })
  return sql
}

export async function closeMpsPg(): Promise<void> {
  if (sql) await sql.end()
  sql = null
}
