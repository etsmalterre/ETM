// SIREN (`client.siren`) — the 9-digit INSEE identifier of a French company.
// It is the key the facturation électronique (Factur-X / PPF) routes an invoice
// on, so a typo here is a rejected invoice, not a cosmetic problem.
//
// Mirrored client-side by apps/web/src/lib/siren.ts — keep the two in sync.

const SIREN_LEN = 9

/** Keep the digits only: users paste « 123 456 789 » or « 123.456.789 ». */
export function normalizeSiren(v: string | null | undefined): string {
  return (v ?? '').replace(/\D/g, '')
}

/** Empty is valid — the field is optional, it is being filled in gradually. */
export function isValidSiren(v: string | null | undefined): boolean {
  const s = normalizeSiren(v)
  return s === '' || s.length === SIREN_LEN
}

/** Luhn key check. Advisory ONLY — it must never refuse a save: SIRENE has
 *  carried identifiers that do not satisfy the key, and hard-blocking one would
 *  stop a legitimate client from being recorded over a rule we cannot verify. */
export function sirenLuhnOk(v: string | null | undefined): boolean {
  const s = normalizeSiren(v)
  if (s.length !== SIREN_LEN) return false
  let sum = 0
  for (let i = 0; i < SIREN_LEN; i++) {
    let d = s.charCodeAt(i) - 48
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return sum % 10 === 0
}
