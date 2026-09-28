import { beforeAll, describe, expect, it } from 'vitest'
import {
  BLOCAGE_MS,
  ESSAIS_MAX,
  RH_SESSION_MS,
  blocageRestant,
  hacherCode,
  lireSessionRh,
  noterEchec,
  noterSucces,
  personneRh,
  signerSessionRh,
  verifierCode,
} from './rh-acces.js'

beforeAll(() => {
  process.env.AUTH_COOKIE_SECRET ??= 'test-secret'
})

describe('qui peut ouvrir RH', () => {
  it('is Vincent and Isabelle only, by name, whatever the case or the PC row', () => {
    expect(personneRh({ prenom: 'Vincent', nom: 'Malterre' })?.cle).toBe('vincent')
    expect(personneRh({ prenom: ' isabelle ', nom: 'MALTERRE' })?.cle).toBe('isabelle')
    expect(personneRh({ prenom: 'Laetitia', nom: 'Tellier' })).toBeNull()
    expect(personneRh({ prenom: 'Isabelle', nom: null })).toBeNull()
    expect(personneRh({ prenom: 'Vincent', nom: 'Roux' })).toBeNull()
  })
})

describe('code RH', () => {
  it('verifies the right code only', () => {
    const { hash, sel } = hacherCode('12345678')
    expect(verifierCode('12345678', hash, sel)).toBe(true)
    expect(verifierCode('12345679', hash, sel)).toBe(false)
    expect(verifierCode('', hash, sel)).toBe(false)
  })

  it('locks a person out after five wrong codes, per person', () => {
    const t0 = 1_000_000
    for (let i = 0; i < ESSAIS_MAX - 1; i++) noterEchec('test-a', t0)
    expect(blocageRestant('test-a', t0)).toBe(0)
    noterEchec('test-a', t0)
    expect(blocageRestant('test-a', t0)).toBe(BLOCAGE_MS)
    expect(blocageRestant('test-b', t0)).toBe(0)
    expect(blocageRestant('test-a', t0 + BLOCAGE_MS)).toBe(0)
    noterSucces('test-a')
    expect(blocageRestant('test-a', t0)).toBe(0)
  })
})

describe('session RH', () => {
  it('is bound to the person and expires', () => {
    const now = 5_000_000
    const c = signerSessionRh('isabelle', now)
    expect(lireSessionRh(c, now)).toBe('isabelle')
    expect(lireSessionRh(c, now + RH_SESSION_MS + 1)).toBeNull()
  })

  it('refuses a tampered cookie', () => {
    const now = 5_000_000
    const [, exp, sig] = signerSessionRh('isabelle', now).split('.')
    expect(lireSessionRh(`vincent.${exp}.${sig}`, now)).toBeNull()
    expect(lireSessionRh(`isabelle.${Number(exp) + 1000}.${sig}`, now)).toBeNull()
    expect(lireSessionRh('garbage', now)).toBeNull()
    expect(lireSessionRh(undefined, now)).toBeNull()
  })
})
