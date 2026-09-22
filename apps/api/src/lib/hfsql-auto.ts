import { platform } from 'os'
import type { HfsqlClient } from './hfsql.js'

export type { HfsqlClient } from './hfsql.js'

/**
 * Auto-selects the correct HFSQL driver:
 * - Windows: uses `odbc` npm package (unixODBC-compatible HFSQL ODBC driver)
 * - Linux: uses `hfsql_bridge` C child process (iODBC-compatible HFSQL ODBC driver)
 *
 * Both modules export the same interface: query(), fixEncoding(), closeConnection()
 * on the main database, plus a factory for a client on another connection
 * string (`createHfsqlClient`, used by lib/hfsql-pointage.ts).
 */

// No params argument on QueryFn — `?` placeholders do not work on HFSQL.
type QueryFn = <T = Record<string, unknown>>(sql: string) => Promise<T[]>
type QueryRawFn = (sql: string) => Promise<Record<string, unknown>[]>
type QueryB64TextFn = <T = Record<string, unknown>>(sql: string) => Promise<T[]>
type FixEncodingFn = <T extends object>(rows: T[], table: string, idField: string, textFields: string[]) => Promise<T[]>
type CloseConnectionFn = () => Promise<void>
type CreateClientFn = (connectionString: string) => HfsqlClient

let _query: QueryFn
let _queryRaw: QueryRawFn
let _queryB64Text: QueryB64TextFn
let _fixEncoding: FixEncodingFn
let _closeConnection: CloseConnectionFn
let _createHfsqlClient: CreateClientFn

if (platform() === 'linux') {
  const mod = await import('./hfsql-bridge.js')
  _query = mod.query
  _queryRaw = mod.queryRaw
  _queryB64Text = mod.queryB64Text
  _fixEncoding = mod.fixEncoding
  _closeConnection = mod.closeConnection
  _createHfsqlClient = mod.createBridgeClient
} else {
  const mod = await import('./hfsql.js')
  _query = mod.query
  _queryRaw = mod.queryRaw
  _queryB64Text = mod.queryB64Text
  _fixEncoding = mod.fixEncoding
  _closeConnection = mod.closeConnection
  _createHfsqlClient = mod.createOdbcClient
}

// PostgreSQL migration, step 3 (lib/pg-backend.ts, sibling repo windev_migration).
// Opt-in only: without DB_BACKEND=pg every environment keeps its HFSQL driver.
// ⚠️ Decided at CALL time, never at import: entry points load their .env with
// dotenv in their module body, which ESM runs AFTER every static import — a
// check up here saw DB_BACKEND unset and silently stayed on HFSQL.
// pg-backend opens nothing until its first query.
const pg = await import('./pg-backend.js')
const usePg = () => process.env.DB_BACKEND === 'pg'

export const query: QueryFn = (sql) => (usePg() ? pg.query(sql) : _query(sql))
export const queryRaw: QueryRawFn = (sql) => (usePg() ? pg.queryRaw(sql) : _queryRaw(sql))
export const queryB64Text: QueryB64TextFn = (sql) => (usePg() ? pg.queryB64Text(sql) : _queryB64Text(sql))
export const fixEncoding: FixEncodingFn = (rows, table, idField, textFields) =>
  (usePg() ? pg.fixEncoding : _fixEncoding)(rows, table, idField, textFields)
export const closeConnection: CloseConnectionFn = () => (usePg() ? pg.closeConnection() : _closeConnection())
/** A client on its own connection (Windows), bridge process (Linux) or PostgreSQL
 *  pool (DB_BACKEND=pg). Connects on first query. Callers create it lazily
 *  (lib/hfsql-pointage.ts), i.e. after the environment is loaded. */
export const createHfsqlClient: CreateClientFn = (cs) => (usePg() ? pg.createPgClient(cs) : _createHfsqlClient(cs))

/** Which database this process talks to, for /api/health and the logs. */
export const dbBackend = (): 'pg' | 'hfsql' => (usePg() ? 'pg' : 'hfsql')
