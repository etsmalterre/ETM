// A ref_ecru's composition lives twice in composition_ecru: the reference's
// own recipe (IDcolori_ecru = 0, usually with IDcolori_fil = 0) and one recipe
// per écru coloris naming the actual yarn colours. Every reader that picks
// yarn — the TRM Stock de fil tab, « Créer un OF », the ETM sst affectation,
// the PDF label — prefers the coloris rows. Until LIVA #1205 the Références
// screen only showed the reference's recipe, so a duplicated ref kept its
// source's per-coloris yarns under a composition that said otherwise
// (« ech 55 » ordered with 029's cotton). Pure helpers, tested.

export interface CompoRow {
  IDref_fil: number
  pourcentage: number | null
}

/** fil → summed share, rounded to 0.01. Positions sharing a yarn are summed
 *  (a composition is a list of feed positions, not of yarns). */
function shares(rows: CompoRow[]): Map<number, number> {
  const m = new Map<number, number>()
  for (const r of rows) {
    const f = Number(r.IDref_fil) || 0
    if (f <= 0) continue
    m.set(f, (m.get(f) ?? 0) + (Number(r.pourcentage) || 0))
  }
  for (const [f, p] of m) m.set(f, Math.round(p * 100) / 100)
  return m
}

/** Does a coloris recipe name other yarns, or other shares, than the
 *  reference's? Yarn colours are ignored — the reference's rows carry none.
 *  False when either side is empty: nothing to compare. */
export function compositionEcart(base: CompoRow[], coloris: CompoRow[]): boolean {
  const a = shares(base)
  const b = shares(coloris)
  if (a.size === 0 || b.size === 0) return false
  if (a.size !== b.size) return true
  for (const [f, p] of a) if (b.get(f) !== p) return true
  return false
}

export interface WantedLine {
  IDref_fil: number
  IDcolori_fil: number
  pourcentage: number
}

export type CompoWrite =
  | { kind: 'update'; IDcomposition_ecru: number; line: WantedLine }
  | { kind: 'insert'; line: WantedLine }
  | { kind: 'delete'; IDcomposition_ecru: number }

/** Replace a coloris recipe while keeping existing row ids (anything that
 *  points at an IDcomposition_ecru — the liage diagram — keeps pointing at
 *  the same position): rows are reused in id order, extras inserted, the
 *  surplus deleted. Unchanged rows produce no write. */
export function planColorisComposition(
  existing: Array<{ IDcomposition_ecru: number; IDref_fil: number; IDcolori_fil: number; pourcentage: number | null }>,
  wanted: WantedLine[],
): CompoWrite[] {
  const rows = [...existing].sort((a, b) => a.IDcomposition_ecru - b.IDcomposition_ecru)
  const out: CompoWrite[] = []
  wanted.forEach((line, i) => {
    const r = rows[i]
    if (!r) { out.push({ kind: 'insert', line }); return }
    const same = Number(r.IDref_fil) === line.IDref_fil
      && Number(r.IDcolori_fil) === line.IDcolori_fil
      && Math.abs((Number(r.pourcentage) || 0) - line.pourcentage) < 0.001
    if (!same) out.push({ kind: 'update', IDcomposition_ecru: r.IDcomposition_ecru, line })
  })
  for (const r of rows.slice(wanted.length)) out.push({ kind: 'delete', IDcomposition_ecru: r.IDcomposition_ecru })
  return out
}

/** Empty (= the coloris follows the reference) or totalling 100 %. */
export function totalOk(lines: Array<{ pourcentage: number }>): boolean {
  if (lines.length === 0) return true
  const t = lines.reduce((s, l) => s + (Number(l.pourcentage) || 0), 0)
  return Math.abs(t - 100) < 0.01
}
