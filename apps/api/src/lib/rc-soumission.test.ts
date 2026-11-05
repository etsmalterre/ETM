import { describe, expect, it } from 'vitest'
import { clientEnCopie, rcJointASoumission } from './rc-soumission.js'
import { rcValable } from './rapport-controle-lot.js'

describe('rcJointASoumission (LIVA #1349)', () => {
  const base = { nature: 'stabilites' as const, recu: true, tirelleMesuree: true, clientDoitRc: true }

  it('rides with a stabilités soumission of a controlled lot whose client is owed it', () => {
    expect(rcJointASoumission(base)).toBe(true)
  })
  it('never with a coloris soumission: no measure exists yet', () => {
    expect(rcJointASoumission({ ...base, nature: 'coloris' })).toBe(false)
  })
  it('never before the reception', () => {
    expect(rcJointASoumission({ ...base, recu: false })).toBe(false)
  })
  it('never while our control of the tirelle is incomplete', () => {
    expect(rcJointASoumission({ ...base, tirelleMesuree: false })).toBe(false)
  })
  it('never for a client not owed it (no RC switch, already sent, dispensed)', () => {
    expect(rcJointASoumission({ ...base, clientDoitRc: false })).toBe(false)
  })
})

describe('clientEnCopie', () => {
  const lemahieu = new Set(['appro@lemahieu.com', 'prototype@lemahieu.com'])
  it('true when one client address is among the recipients, case-insensitive', () => {
    expect(clientEnCopie(['perrine@matel.fr', ' Appro@Lemahieu.com '], lemahieu)).toBe(true)
  })
  it('false when only the dyer receives it', () => {
    expect(clientEnCopie(['perrine@matel.fr'], lemahieu)).toBe(false)
  })
})

describe('rcValable — a reprise makes the RC owed again', () => {
  it('valid without any reprise', () => {
    expect(rcValable('2026-11-05 09:00:00.000000', null)).toBe(true)
  })
  it('valid when sent after the reprise was opened', () => {
    expect(rcValable('2026-11-06 09:00:00.000000', '2026-11-05 14:00:00.000000')).toBe(true)
  })
  it('stale when sent the same morning, before the reprise opened that afternoon', () => {
    expect(rcValable('2026-11-05 09:00:00.000000', '2026-11-05 14:00:00.000000')).toBe(false)
  })
})
