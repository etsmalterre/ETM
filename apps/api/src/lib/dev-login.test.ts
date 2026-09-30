import { describe, it, expect } from 'vitest'
import { devLoginActif, devLoginAutorise, estLoopback, nomBase } from './dev-login.js'

const DEV = 'postgres://u:p@10.10.20.6:5432/mps_dev'
const PROD = 'postgres://u:p@10.10.20.6:5432/mps'

describe('dev login gate', () => {
  it('reads the database name', () => {
    expect(nomBase(DEV)).toBe('mps_dev')
    expect(nomBase(PROD)).toBe('mps')
    expect(nomBase(undefined)).toBe('')
  })

  it('is off in production, on the prod database, or without a database', () => {
    expect(devLoginActif({ NODE_ENV: 'production', PG_CONNECTION_STRING: DEV })).toBe(false)
    expect(devLoginActif({ NODE_ENV: 'development', PG_CONNECTION_STRING: PROD })).toBe(false)
    expect(devLoginActif({ NODE_ENV: 'development' })).toBe(false)
    expect(devLoginActif({ NODE_ENV: 'development', PG_CONNECTION_STRING: DEV })).toBe(true)
  })

  it('only answers a request from this machine', () => {
    expect(estLoopback('::1')).toBe(true)
    expect(estLoopback('::ffff:127.0.0.1')).toBe(true)
    expect(estLoopback('10.10.20.4')).toBe(false)
    const req = (addr: string) => ({ socket: { remoteAddress: addr } }) as any
    const env = { NODE_ENV: 'development', PG_CONNECTION_STRING: DEV }
    expect(devLoginAutorise(req('127.0.0.1'), env)).toBe(true)
    expect(devLoginAutorise(req('192.168.1.20'), env)).toBe(false)
  })
})
