// « Hors réf » — a yarn an OF knits that the écru reference's own
// composition_ecru does not list.
//
// The régleur adds it in TRM (« Ajouter un fil ») to knit a deliberate
// variation of the reference, most often to burn internal stock on a run the
// customer will not notice. The OF freezes its `asso_fil_of` and never re-reads
// the composition, so the fact is recorded on the OF — and every piece the OF
// dropped (`stock_ecru.IDordre_fabrication`) inherits it, then every fini roll
// dyed from such a piece (`stock_fini.IDstock_ecru` + merged components).
//
// ONE predicate for every reader: the TRM OF fiche (`GET /of-trm/:id`), the TRM
// commande, and on the ETM side the sst réception, Tombé Métier › Stock and
// Finis › Stock. Guard: `scripts/check-hors-ref-trm.ts`.
//
// ⚠️ Internal information: never on a document that leaves the company (BL,
// confirmation, invoice, espace client). A TRM client who is not Malterre must
// not learn that his run was knitted with another yarn.

import { query, fixEncoding } from './hfsql-auto.js'
import { loadFiniSources } from './fini-sources.js'

export interface FilHorsRef {
  IDref_fil: number
  IDcolori_fil: number
  /** « REF coloris », what the badge's tooltip lists. */
  label: string
}

const CHUNK = 200

function uniqueIds(arr: readonly (number | null | undefined)[]): number[] {
  return Array.from(new Set(arr.map((x) => Number(x) || 0).filter((x) => x > 0)))
}

function chunks<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

const pairKey = (rf: number, cf: number) => `${rf}:${cf}`

/** The pure rule. `false`, never « everything », when the reference declares
 *  no composition at all: "everything is off-sheet" would be noise. */
export function estHorsRef(refPairs: ReadonlySet<string>, IDref_fil: number, IDcolori_fil: number): boolean {
  return refPairs.size > 0 && !refPairs.has(pairKey(IDref_fil, IDcolori_fil))
}

/** Every (ref fil, coloris fil) pair of each écru reference's composition. */
export async function loadRefPairs(refEcruIds: readonly number[]): Promise<Map<number, Set<string>>> {
  const out = new Map<number, Set<string>>()
  for (const part of chunks(uniqueIds(refEcruIds), CHUNK)) {
    const rows = await query<{ IDref_ecru: number; IDref_fil: number; IDcolori_fil: number }>(
      `SELECT IDref_ecru, IDref_fil, IDcolori_fil FROM composition_ecru WHERE IDref_ecru IN (${part.join(',')})`,
    )
    for (const r of rows) {
      const k = Number(r.IDref_ecru)
      if (!out.has(k)) out.set(k, new Set())
      out.get(k)!.add(pairKey(Number(r.IDref_fil) || 0, Number(r.IDcolori_fil) || 0))
    }
  }
  return out
}

// ── Label resolvers (flat batched lookups — no JOIN + CONVERT) ──

export async function resolveRefFilNames(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const list = uniqueIds(ids)
  if (list.length === 0) return out
  const rows = await query<{ IDref_fil: number; reference: string | null }>(
    `SELECT IDref_fil, reference FROM ref_fil WHERE IDref_fil IN (${list.join(',')})`,
  )
  for (const r of await fixEncoding(rows, 'ref_fil', 'IDref_fil', ['reference'])) {
    out.set(Number(r.IDref_fil), (r.reference ?? '').toString().trim())
  }
  return out
}

export async function resolveColoriFilNames(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const list = uniqueIds(ids)
  if (list.length === 0) return out
  const rows = await query<{ IDcolori_fil: number; reference: string | null }>(
    `SELECT IDcolori_fil, reference FROM colori_fil WHERE IDcolori_fil IN (${list.join(',')})`,
  )
  for (const r of await fixEncoding(rows, 'colori_fil', 'IDcolori_fil', ['reference'])) {
    out.set(Number(r.IDcolori_fil), (r.reference ?? '').toString().trim())
  }
  return out
}

/** The off-sheet yarns of each OF. Only OFs that have one get an entry. */
export async function horsRefParOf(ofIds: readonly number[]): Promise<Map<number, FilHorsRef[]>> {
  const out = new Map<number, FilHorsRef[]>()
  const list = uniqueIds(ofIds)
  if (list.length === 0) return out

  const refByOf = new Map<number, number>()
  const asso: { of: number; rf: number; cf: number }[] = []
  for (const part of chunks(list, CHUNK)) {
    const ofs = await query<{ IDordre_fabrication: number; IDref_ecru: number }>(
      `SELECT IDordre_fabrication, IDref_ecru FROM ordre_fabrication WHERE IDordre_fabrication IN (${part.join(',')})`,
    )
    for (const o of ofs) refByOf.set(Number(o.IDordre_fabrication), Number(o.IDref_ecru) || 0)
    const rows = await query<{ IDordre_fabrication: number; IDref_fil: number; IDcolori_fil: number }>(
      `SELECT IDordre_fabrication, IDref_fil, IDcolori_fil FROM asso_fil_of
       WHERE IDordre_fabrication IN (${part.join(',')}) ORDER BY IDasso_fil_of`,
    )
    for (const r of rows) {
      asso.push({ of: Number(r.IDordre_fabrication), rf: Number(r.IDref_fil) || 0, cf: Number(r.IDcolori_fil) || 0 })
    }
  }
  const pairsByRef = await loadRefPairs(Array.from(refByOf.values()))
  const empty = new Set<string>()
  const flagged = asso.filter((a) => estHorsRef(pairsByRef.get(refByOf.get(a.of) ?? 0) ?? empty, a.rf, a.cf))
  if (flagged.length === 0) return out

  const [refNames, coloriNames] = await Promise.all([
    resolveRefFilNames(flagged.map((a) => a.rf)),
    resolveColoriFilNames(flagged.map((a) => a.cf)),
  ])
  for (const a of flagged) {
    const arr = out.get(a.of) ?? []
    // An OF can feed the same yarn on two positions: list it once.
    if (arr.some((f) => f.IDref_fil === a.rf && f.IDcolori_fil === a.cf)) continue
    arr.push({
      IDref_fil: a.rf,
      IDcolori_fil: a.cf,
      label: [refNames.get(a.rf) ?? `#${a.rf}`, coloriNames.get(a.cf) ?? ''].filter(Boolean).join(' '),
    })
    out.set(a.of, arr)
  }
  return out
}

/** The off-sheet yarns of each écru piece, through the OF that knitted it.
 *  A piece knitted outside TRM (no OF) never has any. */
export async function horsRefParEcru(ecruIds: readonly number[]): Promise<Map<number, FilHorsRef[]>> {
  const out = new Map<number, FilHorsRef[]>()
  const ofByEcru = new Map<number, number>()
  for (const part of chunks(uniqueIds(ecruIds), CHUNK)) {
    const rows = await query<{ IDstock_ecru: number; IDordre_fabrication: number }>(
      `SELECT IDstock_ecru, IDordre_fabrication FROM stock_ecru WHERE IDstock_ecru IN (${part.join(',')})`,
    )
    for (const r of rows) {
      const of = Number(r.IDordre_fabrication) || 0
      if (of > 0) ofByEcru.set(Number(r.IDstock_ecru), of)
    }
  }
  const byOf = await horsRefParOf(Array.from(ofByEcru.values()))
  for (const [ecru, of] of ofByEcru) {
    const fils = byOf.get(of)
    if (fils) out.set(ecru, fils)
  }
  return out
}

/** The off-sheet yarns of each fini roll: those of its écru piece, and of every
 *  component of a merged roll (LIVA #1149). */
export async function horsRefParFini(finiIds: readonly number[]): Promise<Map<number, FilHorsRef[]>> {
  const out = new Map<number, FilHorsRef[]>()
  const list = uniqueIds(finiIds)
  if (list.length === 0) return out
  const ecruByFini = new Map<number, number[]>()
  for (const part of chunks(list, CHUNK)) {
    const rows = await query<{ IDstock_fini: number; IDstock_ecru: number }>(
      `SELECT IDstock_fini, IDstock_ecru FROM stock_fini WHERE IDstock_fini IN (${part.join(',')})`,
    )
    for (const r of rows) ecruByFini.set(Number(r.IDstock_fini), uniqueIds([r.IDstock_ecru]))
  }
  for (const [fini, comps] of await loadFiniSources(list)) {
    ecruByFini.set(fini, uniqueIds([...(ecruByFini.get(fini) ?? []), ...comps]))
  }
  const byEcru = await horsRefParEcru(Array.from(ecruByFini.values()).flat())
  for (const [fini, ecrus] of ecruByFini) {
    const fils: FilHorsRef[] = []
    for (const e of ecrus) {
      for (const f of byEcru.get(e) ?? []) {
        if (!fils.some((x) => x.IDref_fil === f.IDref_fil && x.IDcolori_fil === f.IDcolori_fil)) fils.push(f)
      }
    }
    if (fils.length > 0) out.set(fini, fils)
  }
  return out
}
