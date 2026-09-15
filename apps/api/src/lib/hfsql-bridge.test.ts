// The Linux bridge must read its connection string when it spawns, never when
// the module loads: index.ts runs dotenv.config() in its body, after every
// (hoisted) import has been evaluated. A load-time read spawned the bridge with
// an empty string and every prod DB route answered 500 with [IM007]
// (2026-09-15, rolled back). The Windows dev path hides it — hfsql.ts falls
// back to a localhost `MPS` string that happens to match dev.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

const spawnMock = vi.hoisted(() => vi.fn())
vi.mock('child_process', () => ({ spawn: spawnMock }))

/** A bridge process that connects, then answers every query with one row. */
function fakeBridge() {
  const stdout = new PassThrough()
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr: new PassThrough(),
    killed: false,
    kill: () => true,
    stdin: {
      write: (line: string) => {
        if (line.includes('"sql"')) setImmediate(() => stdout.write('{"rows":[{"v":1}]}\n'))
        return true
      },
    },
  })
  setImmediate(() => stdout.write('{"status":"connected"}\n'))
  return proc
}

const PROD_CS = 'DRIVER={HFSQL};Server Name=h;Server Port=4900;Database=mps;UID=u;PWD=p;'
const PROD_CS_IODBC = 'DRIVER=/opt/hfsql_odbc/wd310hfo64.so;Server Name=h;Server Port=4900;Database=mps;UID=u;PWD=p;'

describe('hfsql-bridge — connection string read at spawn, not at import', () => {
  const saved = process.env.HFSQL_CONNECTION_STRING

  beforeEach(() => {
    spawnMock.mockReset()
    spawnMock.mockImplementation(fakeBridge)
    vi.resetModules()
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.HFSQL_CONNECTION_STRING
    else process.env.HFSQL_CONNECTION_STRING = saved
  })

  it('default client sees an env var set after the module loaded (dotenv after hoisted imports)', async () => {
    delete process.env.HFSQL_CONNECTION_STRING
    const mod = await import('./hfsql-bridge.js')
    process.env.HFSQL_CONNECTION_STRING = PROD_CS

    await expect(mod.query('SELECT 1')).resolves.toEqual([{ v: 1 }])
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock.mock.calls[0][1]).toEqual([PROD_CS_IODBC])
  })

  it('a client on a fixed string passes it through, driver swapped', async () => {
    const mod = await import('./hfsql-bridge.js')
    const client = mod.createBridgeClient(PROD_CS.replace('Database=mps', 'Database=pointage'))

    await client.query('SELECT 1')
    expect(spawnMock.mock.calls[0][1]).toEqual([PROD_CS_IODBC.replace('Database=mps', 'Database=pointage')])
  })
})
