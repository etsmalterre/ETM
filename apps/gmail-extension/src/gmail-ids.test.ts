import { describe, it, expect } from 'vitest'
import { hexFromPermId, normaliseHex, readMailbox, resolveId, resolveIds } from './gmail-ids'

describe('hexFromPermId', () => {
  it('converts Gmail decimal ids to the API hex id', () => {
    // 0x19a0c0ffee000001 = 1846688052664074241
    expect(hexFromPermId('#msg-f:1846688052664074241')).toBe('19a0c0ffee000001')
    expect(hexFromPermId('thread-f:1846688052664074241')).toBe('19a0c0ffee000001')
  })

  it('ignores other id formats', () => {
    expect(hexFromPermId('#msg-a:r-123456789')).toBeNull()
    expect(hexFromPermId('FMfcgzQXJWlkqDnN')).toBeNull()
    expect(hexFromPermId(null)).toBeNull()
  })
})

describe('normaliseHex', () => {
  it('accepts and lowercases hex ids', () => {
    expect(normaliseHex(' 19A0C0FFEE000001 ')).toBe('19a0c0ffee000001')
  })
  it('rejects non-hex values', () => {
    expect(normaliseHex('FMfcgzQXJWlkqDnN')).toBeNull()
    expect(normaliseHex('')).toBeNull()
  })
})

describe('resolveId / resolveIds', () => {
  it('prefers the legacy hex attribute and falls back to the decimal one', () => {
    expect(resolveId({ legacy: '19a0c0ffee000002', perm: '#msg-f:1846688052664074241' })).toBe('19a0c0ffee000002')
    expect(resolveId({ legacy: null, perm: '#msg-f:1846688052664074241' })).toBe('19a0c0ffee000001')
  })

  it('dedupes ids seen on several elements of the same message, in DOM order', () => {
    expect(
      resolveIds([
        { legacy: '19a0c0ffee000001' },
        { perm: '#msg-f:1846688052664074241' },
        { legacy: '19a0c0ffee000002' },
        { legacy: 'garbage' },
      ]),
    ).toEqual(['19a0c0ffee000001', '19a0c0ffee000002'])
  })
})

describe('readMailbox', () => {
  const doc = (title: string, accountLabel: string | null = null) =>
    ({ title, querySelector: () => (accountLabel ? { getAttribute: () => accountLabel } : null) }) as unknown as Document

  it('reads the account at the end of the tab title, not an address in the subject', () => {
    expect(readMailbox(doc('Re: devis pour jean@client.fr - Contact@EtsMalterre.com - Ets Malterre Mail'))).toBe('contact@etsmalterre.com')
  })

  it('falls back to the account button', () => {
    expect(readMailbox(doc('Gmail', 'Compte Google : Isabelle (isabelle@etsmalterre.com)'))).toBe('isabelle@etsmalterre.com')
    expect(readMailbox(doc('Gmail'))).toBeNull()
  })
})
