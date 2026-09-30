import { describe, it, expect } from 'vitest'
import { refusApps } from './utilisateur-apps.js'

describe('refusApps', () => {
  it('accepts joining or leaving an app while one remains', () => {
    expect(refusApps(['etm'], ['etm', 'trm'], false)).toBeNull()
    expect(refusApps(['etm', 'trm'], ['trm'], false)).toBeNull()
  })

  it('refuses an account without any app — deactivate it instead', () => {
    expect(refusApps(['trm'], [], false)).toMatch(/désactivez/)
  })

  it('refuses an admin leaving an app on their own account', () => {
    expect(refusApps(['etm', 'trm'], ['etm'], true)).toMatch(/vous-même/)
  })

  it('lets an admin join an app on their own account', () => {
    expect(refusApps(['etm'], ['etm', 'trm'], true)).toBeNull()
  })

  it('an appareils account holds no app — and cannot join one', () => {
    expect(refusApps(['trm'], [], false, 'appareils')).toBeNull()
    expect(refusApps([], ['trm'], false, 'appareils')).toMatch(/aucune application/)
  })
})
