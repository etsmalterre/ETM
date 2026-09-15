import { describe, expect, it } from 'vitest'
import { enrolementContourne, estServeurLocal } from './pointage-dev.js'

const LOCAL = 'DRIVER={HFSQL};Server Name=localhost;Server Port=4900;Database=MPS;UID=Admin;PWD=;'
const PROD = 'DRIVER={HFSQL};Server Name=10.10.20.2;Server Port=4900;Database=mps;UID=u;PWD=p;'

describe('enrolementContourne', () => {
  it('skips enrolment on a local dev setup', () => {
    expect(enrolementContourne({ NODE_ENV: 'development', HFSQL_CONNECTION_STRING: LOCAL })).toBe(true)
    // The worktree scripts start the API without NODE_ENV: still dev.
    expect(enrolementContourne({ HFSQL_CONNECTION_STRING: LOCAL })).toBe(true)
  })

  it('never in production, whatever the database', () => {
    expect(enrolementContourne({ NODE_ENV: 'production', HFSQL_CONNECTION_STRING: LOCAL })).toBe(false)
  })

  it('never against a network server, even without NODE_ENV (prod API, or a local API on prod)', () => {
    expect(enrolementContourne({ HFSQL_CONNECTION_STRING: PROD })).toBe(false)
    expect(enrolementContourne({ HFSQL_CONNECTION_STRING: LOCAL, HFSQL_POINTAGE_CONNECTION_STRING: PROD })).toBe(false)
  })

  it('can be switched back on to work on the enrolment flow', () => {
    expect(enrolementContourne({ HFSQL_CONNECTION_STRING: LOCAL, POINTAGE_DEV_ENROLEMENT: '1' })).toBe(false)
  })
})

describe('estServeurLocal', () => {
  it('matches the server name key only', () => {
    expect(estServeurLocal('Server Name=127.0.0.1;Database=pointage')).toBe(true)
    expect(estServeurLocal('Server Name=localhost.malterre;Database=pointage')).toBe(false)
    expect(estServeurLocal(PROD)).toBe(false)
  })
})
