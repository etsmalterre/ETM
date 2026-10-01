import { describe, expect, it } from 'vitest'
import { automateDef, automatesDe } from './catalog.js'
import { agentsDe } from '../agents/catalog.js'

// Each app's « Agents IA » menu lists only its own jobs (lib/agents/app-scope.ts).
describe('automates per app', () => {
  it('the pointage report emails are TRM’s, Vidéosurveillance is ETM’s', () => {
    expect(automatesDe('trm').map((a) => a.slug).sort()).toEqual(['bilan-heures', 'rapport-pointage'])
    expect(automatesDe('etm').map((a) => a.slug)).toEqual(['videosurveillance'])
  })

  it('a slug of the other app is unknown to a mount, known to the engine', () => {
    expect(automateDef('rapport-pointage', 'etm')).toBeUndefined()
    expect(automateDef('rapport-pointage', 'trm')?.slug).toBe('rapport-pointage')
    expect(automateDef('rapport-pointage')?.slug).toBe('rapport-pointage')
  })

  it('every agent is still ETM’s', () => {
    expect(agentsDe('trm')).toEqual([])
    expect(agentsDe('etm').length).toBeGreaterThan(0)
  })
})
