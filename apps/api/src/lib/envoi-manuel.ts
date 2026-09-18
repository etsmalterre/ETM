// « Marquer comme envoyée » — a facture sent outside the app (LIVA #1174).
//
// The Clients › Facturation list paints a definitive facture red until an
// `envoi_email` row (IDtype_doc 19, IDreference = IDfacture) exists. The only
// writer used to be the per-facture email POST, so an invoice mailed by hand —
// Pierrot completing the PDF with customs data for Agape, Isabelle grouping
// several invoices in one Gmail thread — stayed red for ever. The July 2026
// backfill (`scripts/backfill-factures-envoyees.ts`) already solved the same
// problem for pre-app invoices with ONE marker row per facture, recognisable
// by its `notes` value. This helper gives the marker a shape the screen can
// write and read back: an ASCII prefix (so the LIKE that finds it never has to
// carry an accent through the bridge), then the author, then the reason.
//
//   notes = "marquee envoyee hors application|<auteur>|<motif>"
//
// The row carries no address. Removing every row with this prefix undoes the
// mark; a real send logged later keeps the facture green on its own.

/** ASCII prefix of a manual-mark row's `notes` — used verbatim in `LIKE`. */
export const MANUAL_MARK_PREFIX = 'marquee envoyee hors application'

const SEP = '|'

/** Upper bound on the stored `notes` text. HFSQL truncates a string column
 *  silently; keeping the marker short guarantees the prefix survives. */
export const MANUAL_MARK_NOTES_MAX = 250

export interface ManualMark {
  auteur: string
  motif: string
}

/** Build the `notes` value for a manual-mark row. The author and reason are
 *  sanitised so the separator can never be ambiguous, and the whole string is
 *  capped so the prefix is never cut off. */
export function buildManualMarkNotes(auteur: string, motif: string): string {
  const clean = (s: string) => s.replace(/[|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  const head = `${MANUAL_MARK_PREFIX}${SEP}${clean(auteur)}${SEP}`
  const room = Math.max(0, MANUAL_MARK_NOTES_MAX - head.length)
  return head + clean(motif).slice(0, room)
}

/** True when a `notes` value is a manual-mark row (prefix match, any case). */
export function isManualMarkNotes(notes: string | null | undefined): boolean {
  return (notes ?? '').toString().toLowerCase().startsWith(MANUAL_MARK_PREFIX)
}

/** Parse a manual-mark `notes` value back into its author and reason.
 *  Returns null for any other row (a real send, a backfill marker…). */
export function parseManualMarkNotes(notes: string | null | undefined): ManualMark | null {
  const v = (notes ?? '').toString()
  if (!isManualMarkNotes(v)) return null
  const rest = v.slice(MANUAL_MARK_PREFIX.length)
  if (!rest.startsWith(SEP)) return { auteur: '', motif: '' }
  const body = rest.slice(1)
  const idx = body.indexOf(SEP)
  if (idx < 0) return { auteur: body.trim(), motif: '' }
  return { auteur: body.slice(0, idx).trim(), motif: body.slice(idx + 1).trim() }
}
