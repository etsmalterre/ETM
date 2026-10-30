import { describe, expect, it } from 'vitest'
import { versionDesPoints } from './historique.js'

const run = (createdAt: string, version: number, memoireMiseAJour = true) => ({ createdAt, version, resultat: { memoireMiseAJour } })

describe('versionDesPoints', () => {
  const runs = [
    run('2026-10-01T05:00:00.000Z', 2),
    run('2026-10-10T05:00:00.000Z', 3),
    run('2026-10-12T09:00:00.000Z', 4, false),
    run('2026-10-15T05:00:00.000Z', 2),
  ]

  it('takes the version of the run that raised the point', () => {
    expect(versionDesPoints([{ depuis: '2026-10-10T05:00:00.000Z' }], runs)[0].version).toBe(3)
    // Version 2 reactivated: its points are its own again.
    expect(versionDesPoints([{ depuis: '2026-10-15T05:00:00.000Z' }], runs)[0].version).toBe(2)
  })

  it('falls back to the last run before it, a preview never raises a point', () => {
    expect(versionDesPoints([{ depuis: '2026-10-13T05:00:00.000Z' }], runs)[0].version).toBe(3)
  })

  it('is null when no run is that old', () => {
    expect(versionDesPoints([{ depuis: '2026-09-01T05:00:00.000Z' }], runs)[0].version).toBeNull()
  })
})
