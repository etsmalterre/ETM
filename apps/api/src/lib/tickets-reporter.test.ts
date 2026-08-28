import { describe, expect, it } from 'vitest'
import { composeReporterName, syntheticReporterEmail } from './tickets-reporter.js'

describe('syntheticReporterEmail', () => {
  it('is stable per account and lands under the reserved .invalid TLD', () => {
    expect(syntheticReporterEmail(10)).toBe('utilisateur-10@mps.malterre.invalid')
    expect(syntheticReporterEmail(10)).toBe(syntheticReporterEmail(10))
    expect(syntheticReporterEmail(10)).not.toBe(syntheticReporterEmail(11))
    // RFC 2606: `.invalid` is guaranteed never to resolve — the tracker's
    // follow-up mail could not reach anyone even if the proxy let it through.
    expect(syntheticReporterEmail(1)).toMatch(/\.invalid$/)
  })
})

describe('composeReporterName', () => {
  it('keeps the account name when there is no hint', () => {
    expect(composeReporterName('Visitage', undefined)).toBe('Visitage')
    expect(composeReporterName('Visitage', '   ')).toBe('Visitage')
  })
  it('appends the person to the station, never replaces it', () => {
    expect(composeReporterName('Visitage', 'Isabelle Dupont')).toBe('Isabelle Dupont (Visitage)')
  })
  it('normalises whitespace and drops a hint that is the account itself', () => {
    expect(composeReporterName('Visitage', '  Isabelle   Dupont ')).toBe('Isabelle Dupont (Visitage)')
    expect(composeReporterName('Visitage', 'visitage')).toBe('Visitage')
  })
})
