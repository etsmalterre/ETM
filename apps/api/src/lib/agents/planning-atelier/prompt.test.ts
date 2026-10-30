import { describe, expect, it } from 'vitest'
import { PROMPT_V1, PROMPT_V2 } from './agent.js'

describe('PROMPT_V2', () => {
  it('replaces V1’s « keep the hours » with the swap of the start hours', () => {
    expect(PROMPT_V2).not.toBe(PROMPT_V1)
    expect(PROMPT_V2).not.toContain('Garde les horaires de chacun')
    expect(PROMPT_V2).toContain('ils échangent')
  })
})
