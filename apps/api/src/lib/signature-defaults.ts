// Automatic fallback signature.
//
// A signature is normally composed of per-user fields an admin fills in
// Paramètres › Utilisateurs (lib/user-profiles.ts). Most accounts never get
// that far, and a mail leaving MPS with no signature at all looks unsigned to
// the client / sous-traitant. So when a user has nothing stored, we derive a
// minimal one from what the app already knows about them: their name on the
// `utilisateur` row and the address the mail is sent from.
//
// Only identity data is used — never invented job titles or phone numbers.
// Anything richer stays an admin edit, which always supersedes this.

import { query, fixEncoding } from './hfsql-auto.js'
import { getUserEmail } from './user-emails.js'
import { hasSignatureContent, type SignatureFields } from './signature-template.js'

/** Derived signature fields for a user with nothing stored: display name from
 *  `utilisateur`, email from the per-user Gmail address. Returns null when
 *  neither is known (nothing meaningful to sign with). */
export async function getDefaultSignatureFields(userId: number): Promise<SignatureFields | null> {
  let displayName = ''
  try {
    // IDutilisateur must be in the SELECT: fixEncoding reads it as its id
    // field, and an undefined id builds `WHERE ... = NaN` — a query storm on
    // the Linux bridge.
    const rows = await query<{ IDutilisateur: number; prenom: string | null; nom: string | null }>(
      `SELECT IDutilisateur, prenom, nom FROM utilisateur WHERE IDutilisateur = ${userId}`,
    )
    const fixed = await fixEncoding(rows, 'utilisateur', 'IDutilisateur', ['prenom', 'nom'])
    const u = (fixed[0] as { prenom?: string | null; nom?: string | null } | undefined) ?? null
    displayName = u
      ? [u.prenom, u.nom].filter((s) => s && String(s).trim()).map((s) => String(s).trim()).join(' ')
      : ''
  } catch (err) {
    // A signature is never worth failing a send over.
    console.error('Failed to derive default signature name:', err)
  }

  const email = (await getUserEmail(userId)) ?? ''
  const fields: SignatureFields = {
    displayName,
    fonction: '',
    telFixe: '',
    email: email.trim(),
  }
  return hasSignatureContent(fields) ? fields : null
}
