// Reporter identity for the ticket proxy (routes/tickets.ts) — the part that
// needs no session, no HFSQL and no tracker, so it can be unit-tested.
//
// The tracker keys a reporter by `reporter_email` (User.email, unique) and
// only ever *sends* to that address for the opt-in follow-up mail. An MPS
// account with no mapped address — a shared station such as the visitage PC,
// or a colleague without a company mailbox — therefore still gets a stable
// identity here: a per-account address under the RFC 2606 `.invalid` TLD,
// which no resolver will ever deliver to and no real mailbox can collide
// with. What such an account loses is exactly the follow-up mail, nothing
// else (the proxy forces `follow_up` off and refuses `PATCH /:id/follow`).
//
// ⚠️ The identity is per IDutilisateur, so mapping a real address to the
// account LATER moves it to a new tracker identity: the earlier tickets stay
// under the synthetic one and drop out of "Mes tickets". Acceptable for the
// accounts this exists for; don't "fix" it by merging two lists on every poll.

export const SYNTHETIC_REPORTER_DOMAIN = 'mps.malterre.invalid'

/** The tracker identity of an account that has no mapped email. */
export function syntheticReporterEmail(userId: number): string {
  return `utilisateur-${userId}@${SYNTHETIC_REPORTER_DOMAIN}`
}

/** Display name sent to the tracker. A shared station may say who is actually
 *  at the keyboard (`hint`, e.g. the visiteuse picked on the poste); it is
 *  appended to the account name, never substituted, so the ticket still says
 *  which station it came from: « Isabelle Dupont (Visitage) ». */
export function composeReporterName(accountName: string, hint: string | undefined): string {
  const h = (hint ?? '').trim().replace(/\s+/g, ' ')
  if (!h || h.toLowerCase() === accountName.toLowerCase()) return accountName
  return `${h} (${accountName})`
}
