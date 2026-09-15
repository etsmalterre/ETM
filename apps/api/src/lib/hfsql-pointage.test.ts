import { describe, expect, it } from 'vitest'
import { pointageConnectionString, withDatabase } from './hfsql-pointage.js'
import { hfsqlLogTag } from './hfsql-log-tag.js'

const MAIN = 'DRIVER={HFSQL};Server Name=10.10.20.2;Server Port=4900;Database=mps;UID=u;PWD=p;'

describe('pointageConnectionString', () => {
  it('reuses the main server and credentials with Database=pointage', () => {
    expect(pointageConnectionString({ HFSQL_CONNECTION_STRING: MAIN })).toBe(
      'DRIVER={HFSQL};Server Name=10.10.20.2;Server Port=4900;Database=pointage;UID=u;PWD=p;',
    )
  })

  it('prefers an explicit HFSQL_POINTAGE_CONNECTION_STRING', () => {
    const explicit = 'DRIVER={HFSQL};Server Name=elsewhere;Database=pointage;'
    expect(pointageConnectionString({ HFSQL_CONNECTION_STRING: MAIN, HFSQL_POINTAGE_CONNECTION_STRING: explicit })).toBe(explicit)
  })

  it('falls back to the local server like lib/hfsql.ts', () => {
    expect(pointageConnectionString({})).toBe(
      'DRIVER={HFSQL};Server Name=localhost;Server Port=4900;Database=pointage;UID=Admin;PWD=;',
    )
  })
})

describe('withDatabase', () => {
  it('replaces the key whatever its case and spacing', () => {
    expect(withDatabase('Server Name=x; database = MPS ;UID=a', 'pointage')).toBe('Server Name=x; database =pointage;UID=a')
  })

  it('never touches a key that merely ends in "Database"', () => {
    expect(withDatabase('MyDatabase=keep;Server Name=x', 'pointage')).toBe('MyDatabase=keep;Server Name=x;Database=pointage;')
  })
})

describe('hfsqlLogTag', () => {
  it('stays [hfsql] for the main database and names any other', () => {
    expect(hfsqlLogTag(MAIN)).toBe('[hfsql]')
    expect(hfsqlLogTag(withDatabase(MAIN, 'pointage'))).toBe('[hfsql:pointage]')
    expect(hfsqlLogTag(withDatabase(MAIN, 'pointage'), 'hfsql_bridge')).toBe('[hfsql_bridge:pointage]')
  })
})
