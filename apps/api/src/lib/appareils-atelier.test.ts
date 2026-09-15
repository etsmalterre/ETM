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
  codeEnAttente,
  peutEssayer,
  noterEchec,
  oublierEchecs,
  typeAppareil,
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

  it('tells whether one is pending: until used, expired or cancelled', () => {
    const t0 = 2_000_000
    expect(codeEnAttente(t0)).toBe(false)

    creerCode(input, t0)
    expect(codeEnAttente(t0 + 1)).toBe(true)
    expect(codeEnAttente(t0 + CODE_TTL_MS)).toBe(false) // expired

    const d = creerCode(input, t0)
    consommerCode(d.code, t0 + 1)
    expect(codeEnAttente(t0 + 2)).toBe(false) // used

    const e = creerCode(input, t0)
    annulerCode(e.code)
    expect(codeEnAttente(t0 + 3)).toBe(false) // cancelled
  })
})

describe('device types', () => {
  const pointeuse = { type: 'pointeuse' as const, IDutilisateur: 14, IDbonnetier: null, libelle: 'Tablette pointage', creePar: 1 }

  it('a code enrols only its own type and stays pending for it', () => {
    const t0 = 3_000_000
    const c = creerCode(pointeuse, t0)
    expect(codeEnAttente(t0 + 1)).toBe(false) // the atelier PWA does not offer it
    expect(codeEnAttente(t0 + 1, 'pointeuse')).toBe(true)
    expect(consommerCode(c.code, t0 + 1)).toBeNull() // typed on a phone
    expect(consommerCode(c.code, t0 + 2, 'pointeuse')).toMatchObject({ type: 'pointeuse', IDutilisateur: 14 })
    expect(codeEnAttente(t0 + 3, 'pointeuse')).toBe(false)
  })

  it('defaults to a phone, as every row enrolled before the type existed', () => {
    expect(creerCode({ IDutilisateur: 11, IDbonnetier: null, libelle: 'x', creePar: 1 }).type).toBe('atelier')
    expect(typeAppareil({})).toBe('atelier')
    expect(typeAppareil({ type: 'pointeuse' })).toBe('pointeuse')
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
