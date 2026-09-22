// Rapports › Factures — the totalizer arithmetic, as pure functions.
//
// The API returns every amount as a MAGNITUDE plus `type` (1 = Facture,
// 2 = Avoir); the sign is a presentation concern, applied here and in the
// table cells through `signed()`. The footer sums the SIGNED amounts (an avoir
// reduces the period's HT / TVA / TTC, as on the legacy grid where avoirs
// print negative) and splits them by TVA rate — the split the facturation
// desk needs to separate exonérées (0 %) from the 20 % base.

export interface FactureRapportAmounts {
  type: number
  tva_rate: number
  total_ht: number
  total_tva: number
  total_ttc: number
}

export interface RateBucket {
  rate: number
  count: number
  ht: number
  tva: number
  ttc: number
}

export interface FacturesTotals {
  count: number
  nbFactures: number
  nbAvoirs: number
  ht: number
  tva: number
  ttc: number
  /** One bucket per TVA rate present, highest rate first. */
  byRate: RateBucket[]
}

/** Apply the document's sign: an avoir is a credit, shown negative. */
export function signed(amount: number, type: number): number {
  // Never -0: an avoir at 0 % TVA would print "-0,00 €".
  return type === 2 && amount !== 0 ? -amount : amount
}

/** Σ of already-rounded centimes drifts in binary float — settle it. */
function round2(v: number): number {
  return Math.round(v * 100) / 100
}

export function aggregateFactures(rows: readonly FactureRapportAmounts[]): FacturesTotals {
  let nbFactures = 0
  let nbAvoirs = 0
  let ht = 0
  let tva = 0
  let ttc = 0
  const buckets = new Map<number, RateBucket>()
  for (const r of rows) {
    if (r.type === 2) nbAvoirs++
    else nbFactures++
    const sHt = signed(r.total_ht, r.type)
    const sTva = signed(r.total_tva, r.type)
    const sTtc = signed(r.total_ttc, r.type)
    ht += sHt
    tva += sTva
    ttc += sTtc
    const b = buckets.get(r.tva_rate) ?? { rate: r.tva_rate, count: 0, ht: 0, tva: 0, ttc: 0 }
    b.count++
    b.ht += sHt
    b.tva += sTva
    b.ttc += sTtc
    buckets.set(r.tva_rate, b)
  }
  const byRate = Array.from(buckets.values())
    .map((b) => ({ ...b, ht: round2(b.ht), tva: round2(b.tva), ttc: round2(b.ttc) }))
    .sort((a, b) => b.rate - a.rate)
  return {
    count: rows.length,
    nbFactures,
    nbAvoirs,
    ht: round2(ht),
    tva: round2(tva),
    ttc: round2(ttc),
    byRate,
  }
}
