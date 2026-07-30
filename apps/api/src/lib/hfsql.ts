import odbc from 'odbc'
import { utimes } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const CONNECTION_STRING =
  process.env.HFSQL_CONNECTION_STRING ||
  'DRIVER={HFSQL};Server Name=localhost;Server Port=4900;Database=MPS;UID=Admin;PWD=;'

let connectionPromise: Promise<odbc.Connection> | null = null

/**
 * Hard ceiling on a single connect attempt. The driver's own `loginTimeout` is
 * only a hint and has been observed not to fire: `odbc.connect()` then hangs
 * forever, and because the pending promise is cached every later query awaits
 * it too — the process serves /api/health fine while every DB route hangs with
 * no error logged, until it's killed by hand. Racing the connect against this
 * timeout and clearing the cache lets the next request retry instead, matching
 * the self-healing respawn the Linux bridge already does.
 */
const CONNECT_TIMEOUT_MS = Number(process.env.HFSQL_CONNECT_TIMEOUT_MS) || 15000

// ── Wedged-driver self-restart (dev only) ──────────────
// Observed 2026-07-22: once one native odbc.connect() hangs, clearing the JS
// cache does NOT recover the process — every retry also times out while a
// fresh process connects in <1s. The wedge lives in process-wide native driver
// state, so the only real cure is a process restart. tsx watch does NOT
// respawn an exited process (verified: it waits for a file change), so
// process.exit() would leave the API down; instead we touch the watched entry
// file, which makes tsx watch restart the whole process with fresh driver
// state. No-op outside NODE_ENV=development (prod runs the Linux bridge,
// which has its own respawn logic).
// ⚠ Do NOT rely on this as the cure during development. Both counters below are
// module state, so a tsx-watch restart zeroes them — and the usual trigger for
// the wedge is a *burst of file saves*, where each save restarts the process
// before the counter can reach WEDGE_RESTART_AFTER. Observed 2026-07-30: the
// API stayed wedged for minutes after an edit burst and only a manual
// `up.mjs <feature> --restart` fixed it. `status.mjs` now reports the slot
// DEGRADED so it is at least diagnosed in one command; see
// claude_doc/worktrees.md § "The browser loads forever".
const WEDGE_RESTART_AFTER = 2
const WEDGE_RESTART_MIN_INTERVAL_MS = 60_000
let consecutiveConnectTimeouts = 0
let lastWedgeRestartAt = 0

function maybeSelfRestartOnWedge(): void {
  if (process.env.NODE_ENV !== 'development') return
  if (consecutiveConnectTimeouts < WEDGE_RESTART_AFTER) return
  const now = Date.now()
  if (now - lastWedgeRestartAt < WEDGE_RESTART_MIN_INTERVAL_MS) return
  lastWedgeRestartAt = now
  const entry = fileURLToPath(new URL('../index.ts', import.meta.url))
  const t = new Date()
  utimes(entry, t, t).then(
    () =>
      console.error(
        `[hfsql] ${consecutiveConnectTimeouts} consecutive connect timeouts — native driver looks wedged; touched ${entry} to trigger a tsx-watch process restart`,
      ),
    (err) => console.error('[hfsql] wedge self-restart failed to touch entry file:', err?.message ?? err),
  )
}

export function getConnection(): Promise<odbc.Connection> {
  if (!connectionPromise) {
    const attempt = odbc.connect({
      connectionString: CONNECTION_STRING,
      loginTimeout: 10,
    })
    let timer: NodeJS.Timeout
    connectionPromise = Promise.race([
      attempt,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`HFSQL connect timed out after ${CONNECT_TIMEOUT_MS}ms`)),
          CONNECT_TIMEOUT_MS
        )
      }),
    ]).finally(() => clearTimeout(timer)) as Promise<odbc.Connection>

    connectionPromise.then(() => {
      consecutiveConnectTimeouts = 0
    }).catch((err) => {
      console.error('[hfsql] connect failed, will retry on next query:', err?.message ?? err)
      connectionPromise = null
      // If the hung connect ever does resolve, close the orphan so the driver
      // doesn't leak a session we no longer reference.
      attempt.then((conn) => conn.close().catch(() => {})).catch(() => {})
      // Only timeouts indicate the wedged-native-state failure mode; a fast
      // refusal (server down, bad credentials) errors immediately and must not
      // trigger restarts.
      if (err instanceof Error && err.message.startsWith('HFSQL connect timed out')) {
        consecutiveConnectTimeouts++
        maybeSelfRestartOnWedge()
      } else {
        consecutiveConnectTimeouts = 0
      }
    })
  }
  return connectionPromise
}

/** Decode ArrayBuffer from CONVERT() to UTF-8 string */
function decodeValue(value: unknown): unknown {
  if (value instanceof ArrayBuffer) {
    const str = Buffer.from(value).toString('utf8')
    return str === '' ? null : str
  }
  return value
}

/** Clean HFSQL quirks: ArrayBuffer → string, \x00 memo → null, BigInt → number, U+FFFD → kept for now */
function cleanRow<T>(row: Record<string, unknown>): T {
  const cleaned: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    const decoded = decodeValue(value)
    if (typeof decoded === 'string' && (decoded === '\x00' || decoded.charCodeAt(0) === 0)) {
      cleaned[key] = null
    } else if (typeof decoded === 'bigint') {
      cleaned[key] = Number(decoded)
    } else {
      cleaned[key] = decoded
    }
  }
  return cleaned as T
}

/** Run a SQL query against HFSQL via ODBC.
 *  No params argument on purpose: `?` placeholders do not work on HFSQL
 *  (CLAUDE.md rule) — build the SQL with esc()/parseInt/hex literals. */
export async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  const conn = await getConnection()
  const rows = await conn.query(sql)
  return (rows as Record<string, unknown>[]).map((row) => cleanRow<T>(row))
}

/**
 * Windows counterpart of the Linux bridge's queryB64Text. The base64-text trick
 * is a Linux-only workaround (the iODBC driver can't CONVERT accented-named
 * columns); on Windows the odbc driver path handles encoding via fixEncoding, so
 * this is a plain passthrough. The prospects route only calls queryB64Text on
 * Linux — this export exists so hfsql-auto can wire it uniformly.
 */
export async function queryB64Text<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  return query<T>(sql)
}

/**
 * Fix encoding for text/memo fields that contain U+FFFD replacement characters.
 * HFSQL ODBC driver corrupts accented chars; CONVERT(field USING 'UTF-8') fixes them.
 * This does per-row CONVERT queries only for rows that actually have broken encoding.
 */
export async function fixEncoding<T extends object>(
  rows: T[],
  table: string,
  idField: string,
  textFields: string[]
): Promise<T[]> {
  const conn = await getConnection()
  const result: T[] = []

  for (const row of rows) {
    const r = row as Record<string, unknown>
    const needsFix = textFields.some((f) => {
      const val = r[f]
      return typeof val === 'string' && val.includes('\ufffd')
    })

    if (!needsFix) {
      result.push(row)
      continue
    }

    const idNum = Number(r[idField])
    const fixed = { ...row } as T
    // Guard: a non-finite id would emit `WHERE col = NaN`, which HFSQL rejects as
    // an unknown identifier. On the Linux bridge that is classed as "connection
    // lost" and triggers a respawn storm against the shared HFSQL server. Skip the
    // CONVERT and keep the original (a leftover U+FFFD glyph is purely cosmetic).
    if (!Number.isInteger(idNum)) {
      result.push(fixed)
      continue
    }
    const fixedRec = fixed as Record<string, unknown>
    for (const field of textFields) {
      const orig = r[field]
      if (typeof orig === 'string' && orig.includes('\ufffd')) {
        try {
          const qRes = await conn.query<Record<string, unknown>>(
            `SELECT CONVERT(${field} USING 'UTF-8') as v FROM ${table} WHERE ${idField} = ${idNum}`
          )
          if (qRes.length > 0 && qRes[0].v != null) {
            const val = qRes[0].v
            fixedRec[field] =
              val instanceof ArrayBuffer ? Buffer.from(val).toString('utf8') : val
          }
        } catch {
          // keep original value if CONVERT fails
        }
      }
    }
    result.push(fixed)
  }

  return result
}

/** Run a SQL query and return raw rows without cleanRow (preserves ArrayBuffer for binary blobs) */
export async function queryRaw(sql: string): Promise<Record<string, unknown>[]> {
  const conn = await getConnection()
  const rows = await conn.query(sql)
  return rows as Record<string, unknown>[]
}

export async function closeConnection(): Promise<void> {
  if (connectionPromise) {
    try {
      const conn = await connectionPromise
      await conn.close()
    } catch {
      // ignore close errors
    }
    connectionPromise = null
  }
}
