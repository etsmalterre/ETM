import { spawn, ChildProcess } from 'child_process'
import { resolve } from 'path'
import { createInterface, Interface } from 'readline'

/**
 * HFSQL Bridge - communicates with HFSQL via a C child process linked against iODBC.
 * Used on Linux where the HFSQL ODBC driver requires iODBC (incompatible with Node.js odbc/unixODBC).
 * On Windows, the standard `odbc` npm package is used instead (see hfsql.ts).
 *
 * Queries are serialized through a queue since the bridge handles one query at a time.
 */

let bridge: ChildProcess | null = null
let rl: Interface | null = null
let pendingResolve: ((value: string) => void) | null = null
let connected = false

// Query queue to serialize concurrent requests
const queryQueue: Array<{ sql: string; b64text?: boolean; resolve: (value: string) => void; reject: (err: Error) => void }> = []
let processing = false

function getBridgePath(): string {
  return resolve(process.cwd(), 'hfsql_bridge')
}

function getConnectionString(): string {
  const cs = process.env.HFSQL_CONNECTION_STRING || ''
  if (cs.includes('DRIVER={HFSQL}')) {
    return cs.replace('DRIVER={HFSQL}', 'DRIVER=/opt/hfsql_odbc/wd310hfo64.so')
  }
  return cs
}

async function ensureConnected(): Promise<void> {
  if (connected && bridge && !bridge.killed) return

  return new Promise((resolve, reject) => {
    const connStr = getConnectionString()
    bridge = spawn(getBridgePath(), [connStr], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    rl = createInterface({ input: bridge.stdout! })

    bridge.stderr!.on('data', (data: Buffer) => {
      console.error('[hfsql_bridge stderr]', data.toString())
    })

    bridge.on('error', (err) => {
      console.error('[hfsql_bridge] Failed to start:', err.message)
      connected = false
      bridge = null
      reject(err)
    })

    bridge.on('exit', (code) => {
      connected = false
      bridge = null
      rl = null
      if (pendingResolve) {
        pendingResolve('')
        pendingResolve = null
      }
      // Reject all queued queries
      while (queryQueue.length > 0) {
        const item = queryQueue.shift()!
        item.reject(new Error('Bridge process exited'))
      }
    })

    rl.on('line', (line: string) => {
      if (!connected) {
        try {
          const msg = JSON.parse(line)
          if (msg.status === 'connected') {
            connected = true
            resolve()
          } else if (msg.error) {
            reject(new Error(msg.error))
          }
        } catch {
          reject(new Error(`Unexpected bridge output: ${line}`))
        }
      } else if (pendingResolve) {
        const cb = pendingResolve
        pendingResolve = null
        cb(line)
      }
    })
  })
}

function sendQueryRaw(sql: string, b64text?: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!bridge || !bridge.stdin) {
      reject(new Error('Bridge not connected'))
      return
    }
    pendingResolve = resolve
    const escaped = sql.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')
    // The C bridge detects b64text only when the line is prefixed EXACTLY with
    // {"b64text":1, — keep this literal in sync with the strncmp in hfsql_bridge.c.
    bridge.stdin.write(b64text ? `{"b64text":1,"sql":"${escaped}"}\n` : `{"sql":"${escaped}"}\n`)
  })
}

async function processQueue(): Promise<void> {
  if (processing) return
  processing = true

  while (queryQueue.length > 0) {
    const item = queryQueue.shift()!
    try {
      await ensureConnected()
      const result = await sendQueryRaw(item.sql, item.b64text)
      item.resolve(result)
    } catch (err) {
      item.reject(err instanceof Error ? err : new Error(String(err)))
    }
  }

  processing = false
}

function sendQuery(sql: string, b64text?: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    queryQueue.push({ sql, b64text, resolve, reject })
    processQueue()
  })
}

/** Clean HFSQL quirks: \x00 memo → null, b64: prefix → UTF-8 string */
function cleanRow<T>(row: Record<string, unknown>): T {
  const cleaned: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'string' && (value === '\x00' || value.charCodeAt(0) === 0)) {
      cleaned[key] = null
    } else if (typeof value === 'string' && value.startsWith('b64:')) {
      // Decode base64 — for text fields (CONVERT results), return as UTF-8 string
      cleaned[key] = Buffer.from(value.slice(4), 'base64').toString('utf8')
    } else {
      cleaned[key] = value
    }
  }
  return cleaned as T
}

/** Clean row for b64text-mode results: text columns arrive as "b64t:<base64 of
 *  raw Latin-1 bytes>" — decode them as latin1 so accented chars survive (the
 *  only way to read accented-NAMED columns like prénom/société correctly on the
 *  Linux bridge, which can't CONVERT them). Binary "b64:" stays a Buffer. */
function cleanRowB64Text<T>(row: Record<string, unknown>): T {
  const cleaned: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'string' && (value === '\x00' || value.charCodeAt(0) === 0)) {
      cleaned[key] = null
    } else if (typeof value === 'string' && value.startsWith('b64t:')) {
      cleaned[key] = Buffer.from(value.slice(5), 'base64').toString('latin1')
    } else if (typeof value === 'string' && value.startsWith('b64:')) {
      cleaned[key] = Buffer.from(value.slice(4), 'base64')
    } else {
      cleaned[key] = value
    }
  }
  return cleaned as T
}

/** Clean row but preserve b64 as raw Buffer (for binary blob retrieval) */
function cleanRowRaw(row: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'string' && (value === '\x00' || value.charCodeAt(0) === 0)) {
      cleaned[key] = null
    } else if (typeof value === 'string' && value.startsWith('b64:')) {
      cleaned[key] = Buffer.from(value.slice(4), 'base64')
    } else {
      cleaned[key] = value
    }
  }
  return cleaned
}

/** Detect errors that indicate the HFSQL connection is dead and the bridge needs respawning */
function isConnectionLostError(errMsg: string): boolean {
  // A server-side SQL error (unknown column, bad syntax) is ALSO returned with
  // SQLSTATE [01000], but it is NOT a lost connection. Respawning + retrying it
  // does nothing but hammer the shared HFSQL server — a single bad-column query
  // (e.g. an accented identifier the Linux bridge can't tokenize) turns into a
  // respawn storm that hangs every app on the server. Treat those as fatal SQL
  // errors (let them throw) instead of connection losses.
  const looksLikeSqlError =
    errMsg.includes('item unknown')
    || errMsg.includes('Unable to initialize the query')
    || errMsg.includes('Unexpected word')
    || errMsg.includes('consistent with file description')
    || errMsg.includes('description of the data files')
    // A NOT NULL / constraint violation is a fatal SQL error, not a lost
    // connection. Respawning + retrying it wedges the bridge queue (it once
    // took prod's DB layer down — empty stock_fini.pointage written as NULL).
    || errMsg.includes('does not allow Null values')
    || errMsg.includes('n\'autorise pas les valeurs Null')
  if (looksLikeSqlError) return false
  return errMsg.includes('[01000]')
    || errMsg.includes('Unable to establish communication')
    || errMsg.includes('Connection reset by peer')
    || errMsg.includes('Bridge not connected')
    || errMsg.includes('Bridge process exited')
}

/** Force-kill the bridge so the next query respawns it with a fresh HFSQL connection */
function killBridge(): void {
  if (bridge) {
    try { bridge.kill() } catch { /* ignore */ }
  }
  bridge = null
  rl = null
  connected = false
  pendingResolve = null
}

/** Run a SQL query against HFSQL via the iODBC bridge, with auto-reconnect on
 *  connection loss. No params argument on purpose — `?` placeholders do not
 *  work on HFSQL (CLAUDE.md rule). */
export async function query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await sendQuery(sql)
      if (!raw) throw new Error('Empty response from bridge')

      const result = JSON.parse(raw)
      if (result.error) {
        if (isConnectionLostError(result.error) && attempt === 0) {
          console.warn('[hfsql_bridge] Connection lost, respawning bridge and retrying:', result.error)
          killBridge()
          continue
        }
        throw new Error(result.error)
      }

      return (result.rows as Record<string, unknown>[]).map((row) => cleanRow<T>(row))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (isConnectionLostError(msg) && attempt === 0) {
        console.warn('[hfsql_bridge] Connection error, respawning bridge and retrying:', msg)
        killBridge()
        continue
      }
      throw err
    }
  }
  throw new Error('Query failed after retry')
}

/**
 * Run a SQL query in base64-text mode: every text column value is returned
 * decoded from its raw Latin-1 bytes, so accented characters survive even in
 * columns whose NAME is accented (prénom, société) and therefore can't be
 * CONVERT()'d. Use for tables with accented column names; ordinary routes keep
 * using query() + fixEncoding(). Numeric/date columns are unaffected.
 */
export async function queryB64Text<T = Record<string, unknown>>(sql: string): Promise<T[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await sendQuery(sql, true)
      if (!raw) throw new Error('Empty response from bridge')
      const result = JSON.parse(raw)
      if (result.error) {
        if (isConnectionLostError(result.error) && attempt === 0) {
          console.warn('[hfsql_bridge] Connection lost in queryB64Text, respawning:', result.error)
          killBridge()
          continue
        }
        throw new Error(result.error)
      }
      return (result.rows as Record<string, unknown>[]).map((row) => cleanRowB64Text<T>(row))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (isConnectionLostError(msg) && attempt === 0) {
        console.warn('[hfsql_bridge] Connection error in queryB64Text, respawning:', msg)
        killBridge()
        continue
      }
      throw err
    }
  }
  throw new Error('queryB64Text failed after retry')
}

/**
 * Fix encoding for text/memo fields - on iODBC bridge, encoding may already be correct.
 * Keeping the same interface as hfsql.ts for compatibility.
 */
export async function fixEncoding<T extends object>(
  rows: T[],
  table: string,
  idField: string,
  textFields: string[]
): Promise<T[]> {
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

    if (r[idField] === undefined) {
      // The feeding SELECT did not include idField: the repair below cannot key
      // its CONVERT and the U+FFFD glyph stays - which sqlText() then writes back
      // as a literal "?" (#1137, #1146). Say so instead of failing silently.
      console.warn(`[fixEncoding] ${table}: idField ${idField} is not selected by the feeding query - accents cannot be repaired`)
    }
    const idNum = Number(r[idField])
    const fixed = { ...row } as T
    // Guard: a non-finite id would emit `WHERE col = NaN`, which HFSQL treats as
    // an unknown identifier and rejects with [01000] \u2014 on the Linux bridge that
    // is classed as "connection lost" and triggers a respawn storm that floods
    // the shared HFSQL server. Skip the CONVERT and keep the original (a leftover
    // U+FFFD glyph is purely cosmetic; a prod outage is not).
    if (!Number.isInteger(idNum)) {
      result.push(fixed)
      continue
    }
    const fixedRec = fixed as Record<string, unknown>
    for (const field of textFields) {
      const orig = r[field]
      if (typeof orig === 'string' && orig.includes('\ufffd')) {
        try {
          const qRes = await query<{ v: string }>(
            `SELECT CONVERT(${field} USING 'UTF-8') as v FROM ${table} WHERE ${idField} = ${idNum}`
          )
          if (qRes.length > 0 && qRes[0].v != null) {
            fixedRec[field] = qRes[0].v
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

/** queryRaw for bridge — preserves b64 as raw Buffer (for binary blob retrieval) */
export async function queryRaw(sql: string): Promise<Record<string, unknown>[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await sendQuery(sql)
      if (!raw) throw new Error('Empty response from bridge')
      const result = JSON.parse(raw)
      if (result.error) {
        if (isConnectionLostError(result.error) && attempt === 0) {
          console.warn('[hfsql_bridge] Connection lost in queryRaw, respawning:', result.error)
          killBridge()
          continue
        }
        throw new Error(result.error)
      }
      return (result.rows as Record<string, unknown>[]).map(cleanRowRaw)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (isConnectionLostError(msg) && attempt === 0) {
        console.warn('[hfsql_bridge] Connection error in queryRaw, respawning:', msg)
        killBridge()
        continue
      }
      throw err
    }
  }
  throw new Error('queryRaw failed after retry')
}

export async function closeConnection(): Promise<void> {
  if (bridge && bridge.stdin) {
    bridge.stdin.write('{"cmd":"quit"}\n')
    bridge.kill()
  }
  bridge = null
  rl = null
  connected = false
}
