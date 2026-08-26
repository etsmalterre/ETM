// SIREN (`client.siren`) — the 9-digit INSEE identifier of a French company.
// Mirrors the rules enforced by the API (apps/api/src/lib/siren.ts): the field
// is optional, but a non-empty value must be exactly 9 digits.

const SIREN_LEN = 9

/** Keep the digits only: users paste « 123 456 789 » or « 123.456.789 ». */
export function normalizeSiren(v: string | null | undefined): string {
  return (v ?? '').replace(/\D/g, '')
}

/** « 123456789 » → « 123 456 789 ». Display only — the stored value is digits. */
export function formatSiren(v: string | null | undefined): string {
  const s = normalizeSiren(v)
  return s.length === SIREN_LEN ? `${s.slice(0, 3)} ${s.slice(3, 6)} ${s.slice(6)}` : s
}

/** French explanation of why a value is refused — null when it is acceptable.
 *  Empty passes: the column is being filled in client by client. */
export function sirenError(v: string | null | undefined): string | null {
  const s = normalizeSiren(v)
  if (s === '' || s.length === SIREN_LEN) return null
  if (s.length === 14) {
    return 'Un SIREN comporte 9 chiffres — 14 correspond à un SIRET (gardez les 9 premiers).'
  }
  return `Le SIREN doit comporter 9 chiffres (${s.length} saisi${s.length > 1 ? 's' : ''}).`
}

/** Luhn key check. Advisory ONLY — surfaced as a warning, never a block:
 *  SIRENE has carried identifiers that do not satisfy the key. */
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
