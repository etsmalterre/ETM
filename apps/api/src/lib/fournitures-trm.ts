// TRM menu « Fournitures » (LIVA #1263) — the pure rules of the stock, shared by
// routes/fournitures-trm.ts and scripts/seed-fournitures-trm.ts. Tested in
// fournitures-trm.test.ts.
//
// The stock is a ledger: trm_fourniture_mouvement rows, signed, per article and
// constructeur (null = not split by constructeur — the opening stock taken
// from Nicolas's sheet had one number per reference). Stock = Σ quantite.

/** « Vota LS  83.41 G003 » → « Vota LS 83.41 G003 »: trimmed, single spaces.
 *  Case is kept (Vo / Vota / LS are read as typed); uniqueness is
 *  case-insensitive in the base. */
export function normaliserLibelle(v: string): string {
  return v.replace(/\s+/g, ' ').trim()
}

export interface Seau {
  /** null = stock not split by constructeur. */
  constructeur: number | null
  stock: number
}

export interface Prelevement {
  constructeur: number | null
  quantite: number
}

/**
 * Where a montage takes `quantite` needles of constructeur `constructeur` from:
 *   1. that constructeur's own stock, as far as it goes;
 *   2. then the stock not split by constructeur (the opening stock is there
 *      until Nicolas's first count splits it);
 *   3. whatever is still missing goes on the constructeur's own stock, which
 *      turns negative — a montage is never refused for want of stock: the
 *      needles are on the machine, the ledger is what is wrong, and a negative
 *      stock is what calls for a count.
 * Without a constructeur, everything comes from the unsplit stock.
 * Returns only non-zero takes.
 */
export function repartirSortie(seaux: Seau[], constructeur: number | null, quantite: number): Prelevement[] {
  if (!(quantite > 0)) return []
  if (constructeur === null) return [{ constructeur: null, quantite }]
  const dispo = (c: number | null) => Math.max(0, seaux.find((s) => s.constructeur === c)?.stock ?? 0)
  const propre = Math.min(quantite, dispo(constructeur))
  const commun = Math.min(quantite - propre, dispo(null))
  const reste = quantite - propre - commun
  const out: Prelevement[] = []
  if (propre + reste > 0) out.push({ constructeur, quantite: propre + reste })
  if (commun > 0) out.push({ constructeur: null, quantite: commun })
  return out
}

/** The movement a count makes: counted − current (0 = nothing to write). */
export function correctionInventaire(stockActuel: number, compte: number): number {
  return compte - stockActuel
}

/** Orders received per calendar year: Σ of the `entree` movements. */
export function commandesParAnnee(
  mouvements: { type: string; quantite: number; date: string }[],
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of mouvements) {
    if (m.type !== 'entree') continue
    const annee = m.date.slice(0, 4)
    if (!/^\d{4}$/.test(annee)) continue
    out[annee] = (out[annee] ?? 0) + m.quantite
  }
  return out
}
