// Shared, pure helpers for the sous-traitant domain — extracted from
// `routes/commandes-sous-traitant.ts` so the Rapports endpoints can reuse
// the exact same status/date/SQL primitives without copy-paste drift.
//
// Keep this file free of side effects and DB access: it holds only the
// stable, pure building blocks (SQL escaping, number/date coercion,
// working-day math, the `sstatut` state-machine constants + ranking).
// Anything that issues queries stays in the route files.

/** HFSQL ODBC bridge rejects accented identifiers on Linux but accepts them
 *  on Windows. Several queries branch on this. */
export const IS_WINDOWS = process.platform === 'win32'

/** Escape a string for an HFSQL SQL literal (single-quote doubling). HFSQL
 *  has no parameterized queries, so every interpolated string must go
 *  through this. */
export function esc(value: string): string {
  return value.replace(/'/g, "''")
}

/** Coerce an unknown DB/query value to a finite number, defaulting to 0 for
 *  null/empty/NaN. */
export function n(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  const parsed = Number(value)
  return isNaN(parsed) ? 0 : parsed
}

/** Normalise a date-ish value to bare `YYYYMMDD` digits, or '' when it
 *  isn't a valid 8-digit date. Accepts 'YYYY-MM-DD', 'YYYYMMDD' or ''. */
export function dateDigits(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = String(value).replace(/-/g, '')
  return /^\d{8}$/.test(s) ? s : ''
}

/** A copy of `base` advanced by `n` working days (Sat/Sun skipped). French
 *  bank holidays are intentionally NOT considered. Result is midnight. */
export function addWorkingDays(base: Date, n: number): Date {
  const r = new Date(base.getFullYear(), base.getMonth(), base.getDate())
  let added = 0
  while (added < n) {
    r.setDate(r.getDate() + 1)
    const dow = r.getDay()
    if (dow !== 0 && dow !== 6) added++
  }
  return r
}

// ── `sstatut` state-machine constants ────────────────────
//
// Legacy `ligne_commande_sous_traitant.sstatut` has ~12 distinct values;
// ETM drives three of them as a state machine (Non_Envoye →
// Attente_Delai → En_Cours, plus Terminé on close). See the long comment in
// `commandes-sous-traitant.ts` for the full census.
export const STATUT_DONE = 'Terminé'
export const STATUT_OPEN = 'En_Cours'
export const STATUT_NON_ENVOYE = 'Non_Envoye'
export const STATUT_ATTENTE_DELAI = 'Attente_Delai'

/** ASCII prefix of `STATUT_DONE` — the longest part of it the driver cannot
 *  mangle. See `isLineDone`. */
const STATUT_DONE_PREFIX = 'Termin'

/** True for the legacy "Terminé" statut, whatever the driver did to the accent.
 *
 *  ⚠️ Matches the ASCII PREFIX on purpose — never `=== STATUT_DONE`. ODBC hands
 *  the value back as `Termin�`, so an exact comparison is **false for every
 *  genuinely finished line** unless the feeding query happened to run
 *  `fixEncoding` first. Two call sites in `commandes-sous-traitant.ts` read a
 *  raw `SELECT sstatut` and did exactly that, so their "toutes les lignes sont
 *  terminées" and "skip a done line" tests never fired — silently, for years.
 *
 *  The prefix is unambiguous: of the 12 distinct values live in
 *  `ligne_commande_sous_traitant.sstatut`, exactly one starts with "Termin"
 *  (measured 2026-08-25 — and it is 4 619 of the 7 257 rows, i.e. the majority
 *  of the table). It also stays correct for values that WERE repaired, since
 *  "Terminé" starts with "Termin" too.
 *
 *  Same reasoning as `commandes-client.ts`'s `SUPPLY_NOT_DONE`, which matches
 *  `NOT LIKE 'Termin%'` in SQL for the identical reason. */
export function isLineDone(sstatut: string | null | undefined): boolean {
  return (sstatut ?? '').trim().startsWith(STATUT_DONE_PREFIX)
}

/** Map a stored `sstatut` to a coarse progression rank.
 *    0 = Non_Envoye     (waiting for bon de commande to go out)
 *    1 = Attente_Delai  (sent, waiting on sst to confirm a date)
 *    2 = En_Cours / any other legacy value (date confirmed / line moving) */
export function lineStatutRank(sstatut: string | null | undefined): 0 | 1 | 2 {
  const s = (sstatut ?? '').trim()
  if (s === STATUT_NON_ENVOYE) return 0
  if (s === STATUT_ATTENTE_DELAI) return 1
  return 2
}
