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

export const query = _query
export const queryRaw = _queryRaw
export const queryB64Text = _queryB64Text
export const fixEncoding = _fixEncoding
export const closeConnection = _closeConnection
/** A client on its own connection (Windows) or bridge process (Linux). Connects on first query. */
export const createHfsqlClient = _createHfsqlClient
