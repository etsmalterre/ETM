// Twin of apps/api/src/lib/roll-cut.ts (stock cut numbering, LIVA #1135) for
// the dialogs that PREVIEW a cut: the roll keeps its numero, each cut-off
// piece gets `<base>-N` with N = the next free suffix. The server recomputes
// the number on write, so a preview built from an incomplete list can only
// be off on screen, never in the table.

export const NUMERO_MAX_LEN = 20

/** Strip a trailing `-<digits>` cut suffix: '3204/14-2' → '3204/14'. */
export function cutBase(numero: string): string {
  const m = /^(.+)-\d+$/.exec(numero.trim())
  return m ? m[1] : numero.trim()
}

/** Next free suffix index for `base` among `existing` (starts at 1). */
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
