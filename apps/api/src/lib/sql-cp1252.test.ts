import { describe, expect, it } from 'vitest'
import { cp1252Bytes, sqlTextCp1252 } from './sql-cp1252.js'

describe('sqlTextCp1252', () => {
  it('keeps printable ASCII as a quoted literal, quotes doubled', () => {
    expect(sqlTextCp1252("it's")).toBe("'it''s'")
    expect(sqlTextCp1252('')).toBe("''")
    expect(sqlTextCp1252(null)).toBe("''")
  })

  it('hex-encodes Latin-1 accents byte for byte', () => {
    expect(sqlTextCp1252('Mé')).toBe("x'4de9'")
  })

  it('maps the cp1252 punctuation of the legacy messages back to 0x80–0x9F', () => {
    // The bytes the dev server round-tripped to « é\r\n€’ » on 2026-09-15.
    expect(sqlTextCp1252('é\r\n€’')).toBe("x'e90d0a8092'")
    expect(cp1252Bytes('œŒ…–—“”').toString('hex')).toBe('9c8c8596979394')
  })

  it('sends control characters through the hex form', () => {
    expect(sqlTextCp1252('a\r\nb')).toBe("x'610d0a62'")
  })

  it('refuses what cp1252 cannot hold instead of altering it', () => {
    expect(() => sqlTextCp1252('poudr�')).toThrow('U+FFFD')
    expect(() => sqlTextCp1252('ok 👍')).toThrow('U+1F44D')
    expect(() => sqlTextCp1252('')).toThrow('U+0081')
  })
})
