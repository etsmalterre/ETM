// « Article initial » composition on the bon de commande sous-traitant —
// LIVA #1157 (with #1158).
//
// The PDF used to print `ref_ecru.composition`, a free-text column the
// legacy fiche fills by hand — empty on 184 of the 398 écrus in prod (78 of
// them behind a wash-only fini), so the teinturier's order said nothing about
// the yarn and Gilles had to look it up. The structured truth is
// `composition_ecru` (one row per feeding position: ref_fil × colori_fil ×
// pourcentage, optionally scoped to one colori_ecru), which every OF is
// created from. When the text is empty, derive the label from it.
//
// Row choice mirrors of-trm's /lookups/composition: rows scoped to the line's
// colori_ecru first, then the unscoped rows (IDcolori_ecru = 0), then the
// first coloris variant found — never the union, which would sum above 100 %
// on a ref whose variants repeat the same yarn. Feeding positions sharing a
// yarn are folded (ref 119/ecru feeds the SAME 280/48/1 PES HT three times:
// 71 % + 14,5 % + 14,5 % reads « 100 % 280/48/1 PES HT » on a label).
//
// Pure: the builder feeds it flat query rows and the yarn names.

export interface CompositionEcruRow {
  IDref_ecru: number
  IDcolori_ecru: number
  IDref_fil: number
  pourcentage: number
}

/** Rows of ONE écru relevant to `coloriEcruId` (see the header comment). */
export function pickCompositionRows(rows: CompositionEcruRow[], coloriEcruId: number): CompositionEcruRow[] {
  const valid = rows.filter((r) => r.IDref_fil > 0 && r.pourcentage > 0)
  if (coloriEcruId > 0) {
    const scoped = valid.filter((r) => r.IDcolori_ecru === coloriEcruId)
    if (scoped.length > 0) return scoped
  }
  const unscoped = valid.filter((r) => !(r.IDcolori_ecru > 0))
  if (unscoped.length > 0) return unscoped
  const first = valid.map((r) => r.IDcolori_ecru).sort((a, b) => a - b)[0]
  return first == null ? [] : valid.filter((r) => r.IDcolori_ecru === first)
}

const fmtPct = (n: number) => n.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 1 })

/** « 66 % 1/60 COTON PEIGNE BIO Z · 34 % 1/28 COTON PEIGNE BIO Z », biggest
 *  share first, or null when nothing usable. */
export function formatCompositionLabel(
  rows: CompositionEcruRow[],
  coloriEcruId: number,
  refFilName: (id: number) => string | undefined,
): string | null {
  const picked = pickCompositionRows(rows, coloriEcruId)
  const byFil = new Map<number, number>()
  for (const r of picked) byFil.set(r.IDref_fil, (byFil.get(r.IDref_fil) ?? 0) + r.pourcentage)
  const parts = Array.from(byFil.entries())
    .map(([id, pct]) => ({ name: (refFilName(id) ?? '').trim(), pct }))
    .filter((p) => p.name)
    .sort((a, b) => b.pct - a.pct)
    .map((p) => `${fmtPct(p.pct)} % ${p.name}`)
  return parts.length > 0 ? parts.join(' · ') : null
}
