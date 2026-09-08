// Numbering rules shared by the two roll-cut endpoints (stock_fini and
// stock_ecru, `POST /:id/cut`). Ported from the legacy FEN_Coupe_Fini window:
//
//   - the roll that stays on the shelf KEEPS its numero — it is the same
//     physical roll it always was; the piece cut off is the new object and gets
//     the suffixed number (LIVA #1135: the dialog used to hand the suffix to the
//     remainder);
//   - the suffix is the next free index among the numeros already derived from
//     the same base (legacy: MAX over `numero LIKE '%<base>%'` of the digits
//     after the dash, so the first cut piece is `-1` — the tables hold
//     `3204/11-1`, `3204/13-1`, `3204/13-2`), never a fixed `-2` — cutting the
//     same roll twice used to produce a duplicate `<base>-2`, and cutting
//     `<base>-2` a `<base>-2-2`.
//
// The caller feeds `nextCutIndex` the rows of `numero LIKE '<base>-%'`; the
// HFSQL driver also returns the bare `<base>` for that pattern (probed on
// 3204/14: `LIKE '3204/14-%'` → `['3204/14']`), which is why the digits test
// lives here in JS and not in SQL.
//
// `numero` is a 20-char column: the base is trimmed, never the suffix.

export const NUMERO_MAX_LEN = 20

/** Strip a trailing `-<digits>` cut suffix: '3204/14-2' → '3204/14'. A numero
 *  with no such suffix is its own base. */
export function cutBase(numero: string): string {
  const m = /^(.+)-\d+$/.exec(numero.trim())
  return m ? m[1] : numero.trim()
}

/** Next free suffix index for `base`, given the numeros already in the table
 *  (any list — only `<base>-<digits>` entries count). Starts at 1, like the
 *  legacy window: the roll keeping the bare base is not counted. */
export function nextCutIndex(base: string, existing: readonly string[]): number {
  let max = 0
  const prefix = `${base}-`
  for (const raw of existing) {
    const n = (raw ?? '').trim()
    if (!n.startsWith(prefix)) continue
    const tail = n.slice(prefix.length)
    if (!/^\d+$/.test(tail)) continue
    max = Math.max(max, parseInt(tail, 10))
  }
  return max + 1
}

/** `<base>-<index>` capped to the column width, trimming the base. */
export function childNumero(base: string, index: number): string {
  const suffix = `-${index}`
  return base.slice(0, NUMERO_MAX_LEN - suffix.length) + suffix
}
