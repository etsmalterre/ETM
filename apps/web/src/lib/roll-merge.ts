// Grouped rolls (LIVA #1149) — the numero of a roll the dyer made out of
// several écru pieces. Twin of `apps/api/src/lib/fini-sources.ts`
// (`mergedNumero` / `splitMergedNumero`): the dialog needs the number before
// the row exists, the server stores it. Keep the two in step — the test file
// pins the same cases on both sides.

/** `stock_fini.numero` is a 20-char column. */
export const NUMERO_MAX_LEN = 20

/** `3510/11+3510/2`, as the dyer prints it on the BL and the tags. Falls back
 *  to the compact `3510/11+2` form when the full one does not fit. */
export function mergedNumero(numeros: readonly string[]): string {
  const parts = numeros.map((n) => (n ?? '').trim()).filter((n) => n.length > 0)
  if (parts.length === 0) return ''
  const full = parts.join('+')
  if (full.length <= NUMERO_MAX_LEN) return full
  const [first, ...rest] = parts
  const slash = first.lastIndexOf('/')
  const base = slash > 0 ? first.slice(0, slash + 1) : ''
  const compact = [
    first,
    ...rest.map((p) => (base && p.startsWith(base) ? p.slice(base.length) : p)),
  ].join('+')
  if (compact.length <= NUMERO_MAX_LEN) return compact
  return compact.slice(0, NUMERO_MAX_LEN)
}

/** The printed components of a merged numero; a plain numero yields itself. */
export function splitMergedNumero(numero: string): string[] {
  return (numero ?? '').split('+').map((s) => s.trim()).filter((s) => s.length > 0)
}
