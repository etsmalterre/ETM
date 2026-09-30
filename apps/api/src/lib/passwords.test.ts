import { describe, expect, it } from 'vitest'
import { genererMotDePasse, hacherMotDePasse, motDePasseRefuse, verifierMotDePasse } from './passwords.js'

describe('passwords', () => {
  it('verifies the right password and refuses a wrong one', async () => {
    const h = await hacherMotDePasse('correct horse battery')
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$/)
    expect(await verifierMotDePasse('correct horse battery', h)).toBe(true)
    expect(await verifierMotDePasse('correct horse batterY', h)).toBe(false)
  })

  it('salts every hash', async () => {
    expect(await hacherMotDePasse('azertyuiop')).not.toBe(await hacherMotDePasse('azertyuiop'))
  })

  it('treats composed and decomposed accents alike', async () => {
    const h = await hacherMotDePasse('Mickaël est là')
    expect(await verifierMotDePasse('Mickaël est là', h)).toBe(true)
  })

  it('refuses a missing or malformed stored hash', async () => {
    expect(await verifierMotDePasse('x', null)).toBe(false)
    expect(await verifierMotDePasse('x', 'bcrypt$abc')).toBe(false)
  })

  it('checks length only', () => {
    expect(motDePasseRefuse('court')).toMatch(/au moins 8/)
    expect(motDePasseRefuse('huit car')).toBeNull()
  })

  it('generates 4 groups of 4 unambiguous characters', () => {
    const p = genererMotDePasse()
    expect(p).toMatch(/^([a-zA-Z2-9]{4}-){3}[a-zA-Z2-9]{4}$/)
    expect(p).not.toMatch(/[01lIoO]/)
  })
})
