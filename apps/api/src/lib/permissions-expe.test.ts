import { describe, it, expect } from 'vitest'
import { EXPE_PERMISSION_KEYS, isKnownExpePermissionKey } from './permission-keys-expe.js'
import { EXPE_SCREEN_MENUS, allExpeMenuAccessKeys, expeMenuAccessKey, expeScreenHideKey, isExpeScreenAccessKey } from './screen-keys-expe.js'
import { isStorableExpeKey } from './permissions-expe.js'
import { agentsDe } from './agents/catalog.js'
import { automatesDe } from './automates/catalog.js'

describe('Expe rights', () => {
  it('stores only the keys of its own catalog and of its own screens', () => {
    expect(isStorableExpeKey('edit_agents_ia')).toBe(true)
    expect(isKnownExpePermissionKey('evaluer_agents_ia')).toBe(true)
    // An ETM key (same table, another app) and an unknown screen are dropped.
    expect(isStorableExpeKey('edit_commandes_client')).toBe(false)
    expect(isStorableExpeKey('screen_clients')).toBe(false)
  })

  it('names every key once', () => {
    const cles = EXPE_PERMISSION_KEYS.map((p) => p.key)
    expect(new Set(cles).size).toBe(cles.length)
  })

  it('derives the screen keys like the two ERPs', () => {
    expect(expeMenuAccessKey('/a-faire-partir')).toBe('screen_a_faire_partir')
    expect(expeScreenHideKey('/transporteurs/fiche')).toBe('hide_transporteurs_fiche')
    // Every menu of the manifest is a grant an admin holds and the store accepts.
    expect(allExpeMenuAccessKeys()).toHaveLength(EXPE_SCREEN_MENUS.length)
    for (const k of allExpeMenuAccessKeys()) expect(isExpeScreenAccessKey(k)).toBe(true)
  })

  it('has no agent nor automate of its own yet, and takes none from the ERPs', () => {
    expect(agentsDe('expe')).toEqual([])
    expect(automatesDe('expe')).toEqual([])
  })
})
