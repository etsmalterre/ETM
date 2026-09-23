/**
 * Which catalog an order line's `IDreference` / coloris point into — ONE rule
 * for the two ledgers that share the polymorphic shape:
 *
 *   ligne_commande_sous_traitant.TYPE (ETM sst orders)
 *     0 → ref_ecru + colori_ecru       (legacy écru lines)
 *     1 → ref_ecru + colori_ecru       (tricoteur: the écru being knit)
 *     2 → ref_fini + ref_fini_colori / colori_ecru by avec_teinture
 *     4 → ref_rectiligne + coloris_rectiligne   (cols / bandes knitted flat
 *                                                at Tricotage Malterre)
 *
 *   ligne_commande_client.TYPE on the TRM ledger (IDsociete = 2)
 *     1 → ref_ecru + colori_ecru
 *     4 → ref_rectiligne + coloris_rectiligne   (the mirror of an sst type 4,
 *                                                or a native TRM rectiligne line)
 *
 * The id spaces collide (ref_rectiligne 17 « R006-38 » is also ref_ecru 17
 * « LTP02 »), so a rectiligne line is resolved against the rectiligne tables
 * ONLY — never "try the other catalogs". That fallback, plus an older reading
 * of type 4 as « confection / écru », is what printed LTP02 on 354 legacy
 * lines until LIVA #1185 (2026-09-23; evidence in claude_doc/screen_notes.md
 * § 4 and § 7).
 *
 * Pure — no I/O. The rectiligne catalog readers live in lib/rectiligne.ts.
 */

/** `TYPE` of a rectiligne line, on both ledgers. */
export const LINE_TYPE_RECTILIGNE = 4

export type SstLineKind = 'ecru' | 'fini' | 'rectiligne'
export type TrmLineKind = 'ecru' | 'rectiligne'

export function isRectiligneType(type: unknown): boolean {
  return Number(type) === LINE_TYPE_RECTILIGNE
}

/** Catalog of an sst line (`ligne_commande_sous_traitant.TYPE`). */
export function sstLineKind(type: unknown): SstLineKind {
  const t = Number(type) || 0
  if (t === 2) return 'fini'
  if (t === LINE_TYPE_RECTILIGNE) return 'rectiligne'
  return 'ecru'
}

/** Catalog of a TRM order line (`ligne_commande_client.TYPE`, IDsociete 2). */
export function trmLineKind(type: unknown): TrmLineKind {
  return isRectiligneType(type) ? 'rectiligne' : 'ecru'
}

/** Split line ids by kind — the écru/fini resolvers must never see a
 *  rectiligne id, and vice versa. */
export function partitionByKind<T>(
  lines: T[],
  typeOf: (l: T) => unknown,
): { rectiligne: T[]; other: T[] } {
  const rectiligne: T[] = []
  const other: T[] = []
  for (const l of lines) (isRectiligneType(typeOf(l)) ? rectiligne : other).push(l)
  return { rectiligne, other }
}

/** Minimal response shape — keeps this module free of an express import. */
interface JsonResponder {
  status(code: number): { json(body: unknown): unknown }
}

/**
 * 409 for the production paths a rectiligne line has none of: no OF (its
 * IDreference would be written into ordre_fabrication.IDref_ecru and knit the
 * écru sharing the id), no piece, no shipment — the legacy never tracked cols
 * past the order. Returns true when it answered.
 */
export function refuseIfRectiligne(res: JsonResponder, typeKind: unknown): boolean {
  if (!isRectiligneType(typeKind)) return false
  res.status(409).json({
    error: 'ligne_rectiligne',
    message: "Ligne rectiligne (cols / bandes) : pas d'ordre de fabrication, de pièces ni d'expédition.",
  })
  return true
}
