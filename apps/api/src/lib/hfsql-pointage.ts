/**
 * The legacy `pointage` HFSQL database — the second database the MPS API talks to.
 *
 * It is not a schema inside `mps`: the WinDev pointeuse and Admin Pointage keep
 * the time clock in their own database (`lst_salarie`, `lst_horaire`,
 * `lst_pointage`, `hors_prod`, `lst_message`, `lst_lissage`, `lst_prev`,
 * `lst_info_sal_annee`) on the SAME server and with the SAME credentials as
 * `mps` (verified on prod 2026-09-15). So by default its connection string is
 * the main one with `Database=pointage`; HFSQL_POINTAGE_CONNECTION_STRING
 * overrides it when a deployment ever splits the two.
 *
 * ⚠️ Absent from a fresh dev HFSQL server (the dev base is a copy of `mps`
 * only): build it with `src/scripts/copy-pointage-prod-to-dev.ts --write`.
 * ⚠️ The dev `mps` database ALSO carries old `lst_horaire` / `lst_salarie` /
 * `hors_prod` / `pointage` files — a query sent through the default client
 * instead of this one reads those, silently. Always `pointageDb`.
 *
 * Design of the pointage PWA that reads and writes it: ~/.claude/plans/pointage-pwa.md.
 */
import { createHfsqlClient, type HfsqlClient } from './hfsql-auto.js'

export const POINTAGE_DATABASE = 'pointage'

// Same fallback as lib/hfsql.ts, so an unset environment points both clients
// at the same local server.
const DEFAULT_MAIN_CONNECTION_STRING =
  'DRIVER={HFSQL};Server Name=localhost;Server Port=4900;Database=MPS;UID=Admin;PWD=;'

/** `connectionString` with its `Database=` replaced (or appended). */
export function withDatabase(connectionString: string, database: string): string {
  const key = /((?:^|;)\s*Database\s*=)[^;]*/i
  if (key.test(connectionString)) return connectionString.replace(key, `$1${database}`)
  const base = connectionString.trim()
  return `${base}${base === '' || base.endsWith(';') ? '' : ';'}Database=${database};`
}

export function pointageConnectionString(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.HFSQL_POINTAGE_CONNECTION_STRING?.trim()
  if (explicit) return explicit
  return withDatabase(env.HFSQL_CONNECTION_STRING?.trim() || DEFAULT_MAIN_CONNECTION_STRING, POINTAGE_DATABASE)
}

// Created on first use rather than at import: scripts that load their .env
// with dotenv run that call AFTER their static imports have been evaluated.
let client: HfsqlClient | null = null
function db(): HfsqlClient {
  client ??= createHfsqlClient(pointageConnectionString())
  return client
}

export const pointageDb: HfsqlClient = {
  query: <T = Record<string, unknown>>(sql: string) => db().query<T>(sql),
  queryRaw: (sql) => db().queryRaw(sql),
  queryB64Text: <T = Record<string, unknown>>(sql: string) => db().queryB64Text<T>(sql),
  fixEncoding: (rows, table, idField, textFields) => db().fixEncoding(rows, table, idField, textFields),
  closeConnection: async () => {
    if (client) await client.closeConnection()
  },
}
