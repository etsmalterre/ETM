// Password hashing for ETM accounts: scrypt from node:crypto (no native
// dependency), stored as `scrypt$N$r$p$<salt b64>$<hash b64>` so the cost can
// be raised later without breaking existing hashes (verify reads the stored
// parameters). Tested in passwords.test.ts.

import crypto from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(crypto.scrypt) as (
  pw: string | Buffer, salt: Buffer, keylen: number, opts: crypto.ScryptOptions,
) => Promise<Buffer>

const N = 32768
const R = 8
const P = 1
const KEYLEN = 64
const MAXMEM = 128 * N * R * 2

export const MDP_LONGUEUR_MIN = 8

export async function hacherMotDePasse(motDePasse: string): Promise<string> {
  const salt = crypto.randomBytes(16)
  const hash = await scrypt(motDePasse.normalize('NFC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM })
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`
}

export async function verifierMotDePasse(motDePasse: string, stocke: string | null | undefined): Promise<boolean> {
  if (!stocke) return false
  const parts = stocke.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false
  const [, n, r, p, saltB64, hashB64] = parts
  const attendu = Buffer.from(hashB64, 'base64')
  const calcule = await scrypt(motDePasse.normalize('NFC'), Buffer.from(saltB64, 'base64'), attendu.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * Number(n) * Number(r) * 2,
  })
  return calcule.length === attendu.length && crypto.timingSafeEqual(calcule, attendu)
}

/** Why a new password is refused, or null. Deliberately few rules: length
 *  only (a long passphrase beats a short complex one). */
export function motDePasseRefuse(motDePasse: string): string | null {
  if (motDePasse.trim().length < MDP_LONGUEUR_MIN) {
    return `Le mot de passe doit faire au moins ${MDP_LONGUEUR_MIN} caractères.`
  }
  if (motDePasse.length > 200) return 'Le mot de passe est trop long.'
  return null
}

// No 0/O, 1/l/I: generated passwords are sometimes read aloud or copied by hand.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** A random password: 4 groups of 4 (`Kx7p-Qm3a-…`), ~90 bits. */
export function genererMotDePasse(): string {
  const groupes: string[] = []
  for (let g = 0; g < 4; g++) {
    let s = ''
    for (let i = 0; i < 4; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)]
    groupes.push(s)
  }
  return groupes.join('-')
}
