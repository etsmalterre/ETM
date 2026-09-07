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

/** « 123 456 789 » — the printed form (invoices, client record). Anything that
 *  is not a full 9-digit SIREN is returned as-is, digits only. */
export function formatSiren(v: string | null | undefined): string {
  const s = normalizeSiren(v)
  return s.length === SIREN_LEN ? `${s.slice(0, 3)} ${s.slice(3, 6)} ${s.slice(6)}` : s
}

/** The SIREN printed on a document for this client — formatted, or null when
 *  the client record has none (the field is filled in client by client, and
 *  the document simply omits the row). Read live from `client` rather than
 *  snapshotted on the invoice: a SIREN identifies the legal entity for its
 *  whole life, so unlike a VAT number it never has an "as issued" value to
 *  preserve — a different SIREN would be a different client. Named column on
 *  purpose (`client` carries a memo-binary column, so `SELECT *` returns 0
 *  rows on Windows ODBC). */
export function formatSirenForDocument(raw: unknown): string | null {
  const s = normalizeSiren(String(raw ?? ''))
  return s.length === SIREN_LEN ? formatSiren(s) : null
}

export async function loadClientSirenForDocument(
  q: <T>(sql: string) => Promise<T[]>,
  IDclient: number,
): Promise<string | null> {
  if (!(IDclient > 0)) return null
  const rows = await q<{ siren: unknown }>(`SELECT siren FROM client WHERE IDclient = ${IDclient}`)
  return formatSirenForDocument(rows[0]?.siren)
}
