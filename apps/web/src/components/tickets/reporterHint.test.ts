import { afterEach, describe, expect, it } from 'vitest'
import { getTicketReporterHint, setTicketReporterHint } from './reporterHint'

afterEach(() => setTicketReporterHint(null))

describe('ticket reporter hint', () => {
  it('starts empty and trims what a page sets', () => {
    expect(getTicketReporterHint()).toBeNull()
    setTicketReporterHint('  Isabelle Dupont ')
    expect(getTicketReporterHint()).toBe('Isabelle Dupont')
  })
  it('treats blank and null alike — an unidentified poste names nobody', () => {
    setTicketReporterHint('Isabelle Dupont')
    setTicketReporterHint('   ')
    expect(getTicketReporterHint()).toBeNull()
  })
})
