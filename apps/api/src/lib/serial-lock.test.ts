// The mutex in front of POST /visitage-trm/valider. What it must guarantee:
// strict FIFO (the second caller's "is this piece already visited?" read runs
// after the first caller's last write), and liveness (a caller that throws
// releases the lock — a stuck lock would freeze every poste de visitage).
import { describe, expect, it } from 'vitest'
import { createSerialLock } from './serial-lock'

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('createSerialLock', () => {
  it('runs callers one after the other, in arrival order', async () => {
    const lock = createSerialLock()
    const log: string[] = []
    const a = lock.run(async () => { log.push('a:start'); await tick(); await tick(); log.push('a:end'); return 'A' })
    const b = lock.run(async () => { log.push('b:start'); await tick(); log.push('b:end'); return 'B' })
    const c = lock.run(async () => { log.push('c:start'); log.push('c:end'); return 'C' })
    expect(lock.pending).toBe(3)
    expect(await Promise.all([a, b, c])).toEqual(['A', 'B', 'C'])
    expect(log).toEqual(['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end'])
    expect(lock.pending).toBe(0)
  })

  it('a caller that throws does not block the next one', async () => {
    const lock = createSerialLock()
    const boom = lock.run(async () => { await tick(); throw new Error('boom') })
    const next = lock.run(async () => 'still alive')
    await expect(boom).rejects.toThrow('boom')
    expect(await next).toBe('still alive')
    expect(lock.pending).toBe(0)
  })

  it('a synchronous throw inside the callback is contained too', async () => {
    const lock = createSerialLock()
    const boom = lock.run(() => { throw new Error('sync') })
    const next = lock.run(async () => 42)
    await expect(boom).rejects.toThrow('sync')
    expect(await next).toBe(42)
  })

  it('the second of two concurrent callers sees what the first wrote', async () => {
    // The visitage race in miniature: check-then-insert on a shared table.
    const lock = createSerialLock()
    const rows = new Set<number>()
    const validate = (piece: number) => lock.run(async () => {
      await tick() // the pre-flight read
      if (rows.has(piece)) return 'piece_deja_visitee'
      await tick() // the writes
      rows.add(piece)
      return 'created'
    })
    const [first, second] = await Promise.all([validate(40751), validate(40751)])
    expect([first, second]).toEqual(['created', 'piece_deja_visitee'])
    expect(rows.size).toBe(1)
  })
})
