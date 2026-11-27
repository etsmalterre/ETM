import { describe, expect, it } from 'vitest'
import { PLANNING_ATELIER_PROMPT_LIVRE, PROMPT_V1, PROMPT_V2, PROMPT_V3 } from './agent.js'

describe('PROMPT_V3', () => {
  it('says one’s hours hold for the week and a week with someone missing keeps the pairs', () => {
    // Each replace of V2 found its target (a silent miss would ship V2 under a new number).
    expect(PROMPT_V3).not.toContain('d’une fois sur l’autre')
    expect(PROMPT_V3).toContain('chacun garde le même horaire du lundi au vendredi')
    expect(PROMPT_V3).toContain('est une semaine incomplète')
    expect(PROMPT_V3).toContain('sont ceux de la grille')
    expect(PLANNING_ATELIER_PROMPT_LIVRE.prompt).toBe(PROMPT_V3)
  })
})

describe('PROMPT_V2', () => {
  it('replaces V1’s « keep the hours » with the swap of the start hours', () => {
    expect(PROMPT_V2).not.toBe(PROMPT_V1)
    expect(PROMPT_V2).not.toContain('Garde les horaires de chacun')
    expect(PROMPT_V2).toContain('ils échangent')
  })
})
