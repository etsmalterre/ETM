// The pure half of the phone-enrolment store: token shape, secret check,
// code lifecycle and the brute-force brake. The file-backed half is exercised
// by the routes against a real API.
import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import {
  parseToken,
  secretMatches,
  creerCode,
  consommerCode,
  annulerCode,
  listerCodes,
  peutEssayer,
  noterEchec,
  oublierEchecs,
  CODE_TTL_MS,
} from './appareils-atelier.js'

const secret = crypto.randomBytes(32).toString('base64url')
const hash = crypto.createHash('sha256').update(secret).digest('hex')

describe('parseToken', () => {
  it('accepts <id>.<secret> and nothing else', () => {
    expect(parseToken(`12.${secret}`)).toEqual({ id: 12, secret })
    expect(parseToken(undefined)).toBeNull()
    expect(parseToken('')).toBeNull()
    expect(parseToken('12')).toBeNull()
    expect(parseToken(`.${secret}`)).toBeNull()
    expect(parseToken(`abc.${secret}`)).toBeNull()
    expect(parseToken('12.short')).toBeNull()
    expect(parseToken(`12.${secret}!`)).toBeNull()
  })
})

describe('secretMatches', () => {
  it('matches the stored hash and refuses anything else', () => {
    expect(secretMatches(secret, hash)).toBe(true)
    expect(secretMatches(secret.slice(1) + 'A', hash)).toBe(false)
    expect(secretMatches(secret, 'deadbeef')).toBe(false)
  })
})

describe('enrolment codes', () => {
  const input = { IDutilisateur: 11, IDbonnetier: 16, libelle: 'Téléphone Nico', creePar: 1 }

  it('is six digits, single use, and expires', () => {
    const t0 = 1_000_000
    const c = creerCode(input, t0)
    expect(c.code).toMatch(/^\d{6}$/)
    expect(c.expireLe).toBe(t0 + CODE_TTL_MS)
    expect(listerCodes(t0).map((x) => x.code)).toContain(c.code)

    // Expired: gone, not consumable.
    expect(consommerCode(c.code, t0 + CODE_TTL_MS)).toBeNull()

    const d = creerCode(input, t0)
    expect(consommerCode(d.code, t0 + 1)).toMatchObject({ IDutilisateur: 11, IDbonnetier: 16 })
    expect(consommerCode(d.code, t0 + 2)).toBeNull() // second use refused
  })

  it('can be cancelled by the admin', () => {
    const c = creerCode(input)
    expect(annulerCode(c.code)).toBe(true)
    expect(annulerCode(c.code)).toBe(false)
    expect(consommerCode(c.code)).toBeNull()
  })
})

describe('brute-force brake', () => {
  it('allows ten misses per window, then refuses until the window passes', () => {
    const ip = '10.10.20.99'
    const t0 = 5_000_000
    for (let i = 0; i < 10; i++) {
      expect(peutEssayer(ip, t0 + i)).toBe(true)
      noterEchec(ip, t0 + i)
    }
    expect(peutEssayer(ip, t0 + 11)).toBe(false)
    expect(peutEssayer(ip, t0 + 16 * 60_000)).toBe(true)
    noterEchec(ip, t0 + 16 * 60_000)
    oublierEchecs(ip)
    expect(peutEssayer(ip, t0 + 16 * 60_000 + 1)).toBe(true)
  })
})
