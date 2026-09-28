import { describe, it, expect } from 'vitest'
import { NOTIF_PERMISSIONS, abonnementsPermis, fusionnerAbonnements } from './abonnements.js'
import { PERMISSION_KEYS } from './permission-keys.js'

describe('NOTIF_PERMISSIONS', () => {
  it('names only sub-permissions of dashboard_notifications', () => {
    for (const key of Object.values(NOTIF_PERMISSIONS)) {
      const def = PERMISSION_KEYS.find((k) => k.key === key)
      expect(def && 'parent' in def ? def.parent : undefined).toBe('dashboard_notifications')
    }
  })
})

describe('abonnementsPermis', () => {
  const catalog = [{ id: 1 }, { id: 2 }, { id: 99 }]

  it('offers a subscription only to a holder of its sub-permission', () => {
    const held = new Set(['dashboard_notif_dossiers_qualite'])
    expect(abonnementsPermis(catalog, (k) => held.has(k)).map((a) => a.id)).toEqual([1, 99])
  })

  it('keeps a catalog row with no key (no detector) offered', () => {
    expect(abonnementsPermis(catalog, () => false).map((a) => a.id)).toEqual([99])
  })
})

describe('fusionnerAbonnements', () => {
  it('takes offered ids from the request and keeps the others as stored', () => {
    // 4 is stored but no longer offered: kept. 1 is offered, unticked: dropped.
    expect(fusionnerAbonnements([1, 4], [2, 4, 7], [1, 2])).toEqual([2, 4])
  })
})
