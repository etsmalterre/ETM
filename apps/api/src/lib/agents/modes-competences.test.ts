import { describe, expect, it } from 'vitest'
import { modeDerive, modePlafonne } from './store.js'

describe('one switch per skill (2026-11-05)', () => {
  it('the agent runs while any skill does', () => {
    expect(modeDerive(['off', 'off', 'off'])).toBe('off')
    expect(modeDerive(['off', 'essai', 'off'])).toBe('actif')
    expect(modeDerive(['supervise', 'essai', 'autonomie'])).toBe('actif')
  })
  it('an old agent mode still caps a skill until it is folded in', () => {
    expect(modePlafonne('off', 'supervise')).toBe('off')
    expect(modePlafonne('essai', 'autonomie')).toBe('essai')
    expect(modePlafonne('actif', 'supervise')).toBe('supervise')
    expect(modePlafonne('actif', 'off')).toBe('off')
  })
})
