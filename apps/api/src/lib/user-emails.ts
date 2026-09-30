// A user's company email address: the column `utilisateur.email` (migration
// 0001_comptes_utilisateurs), unique across accounts because it doubles as a
// login identifier. Was data/user-emails.json until 2026-09-30.
//
// Used as the Gmail « From » of what the user sends, for notification mails,
// and to log in.

import { mpsPg } from './mps-pg.js'

export class EmailDejaUtilise extends Error {
  constructor(email: string) { super(`email already used by another account: ${email}`) }
}

/** Returns the email address stored for a user, or null if none. */
export async function getUserEmail(userId: number): Promise<string | null> {
  const [row] = await mpsPg()<{ email: string | null }[]>`
    SELECT email FROM utilisateur WHERE idutilisateur = ${userId}`
  const v = row?.email?.trim()
  return v ? v : null
}

/** Overwrite a user's email address. Pass empty string to clear.
 *  Throws EmailDejaUtilise when another account holds it. */
export async function setUserEmail(userId: number, email: string): Promise<void> {
  const trimmed = email.trim()
  try {
    await mpsPg()`UPDATE utilisateur SET email = ${trimmed || null} WHERE idutilisateur = ${userId}`
  } catch (err) {
    if ((err as { code?: string }).code === '23505') throw new EmailDejaUtilise(trimmed)
    throw err
  }
}

/** Every stored address (admin /users endpoint, notification mails). */
export async function getAllUserEmails(): Promise<Record<number, string>> {
  const rows = await mpsPg()<{ idutilisateur: number; email: string }[]>`
    SELECT idutilisateur, email FROM utilisateur WHERE email IS NOT NULL AND email <> ''`
  const out: Record<number, string> = {}
  for (const r of rows) out[r.idutilisateur] = r.email.trim()
  return out
}
