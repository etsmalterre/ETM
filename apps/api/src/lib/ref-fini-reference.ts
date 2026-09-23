import { query } from './hfsql-auto.js'
import { batchRepair } from './batch-repair.js'
import { createSerialLock } from './serial-lock.js'

/**
 * A finished reference's name is unique (Vincent, 2026-09-23, with LIVA #1186).
 * ref_fini has no unique index and HFSQL no transactions, so the rule lives
 * here, for the three writers of `ref_fini.reference`: « + Nouveau », the
 * fiche's rename (PUT) and « Dupliquer ». Prod had 1904/1905 both called
 * « Nouvelle référence » — two clicks on « + Nouveau ».
 *
 * "Same name" = same after trimming, collapsing inner spaces, ignoring case AND
 * accents (« 061d » is « 061D », « Nouvelle reference » is « Nouvelle
 * référence ») — how the user reads a list. The comparison is done in JS on
 * faithfully read text, never with SQL `=`: on the Windows driver an accented
 * literal compared case-sensitively while its unaccented twin matched (measured
 * 2026-09-23), the same platform drift as every other accent footgun.
 */

/** Every check-then-write on ref_fini.reference runs under this lock, or two
 *  requests landing together both see the name free (lib/serial-lock.ts). */
export const refFiniReferenceLock = createSerialLock()

/** Comparison key of a reference name. */
export function referenceKey(reference: string): string {
  return reference
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** Keys of every ref_fini name except `exceptId`'s. ~600 rows, one flat query
 *  plus one batched CONVERT for the accented ones — create/rename are rare. */
async function takenKeys(exceptId = 0): Promise<Set<string>> {
  const rows = await query<{ IDref_fini: number; reference: string | null }>(
    `SELECT IDref_fini, reference FROM ref_fini`,
  )
  const fixed = await batchRepair(rows, 'ref_fini', 'IDref_fini', ['reference'])
  return new Set(
    fixed.filter((r) => Number(r.IDref_fini) !== exceptId).map((r) => referenceKey(String(r.reference ?? ''))),
  )
}

/** Is `reference` used by a ref_fini other than `exceptId`? Call under the lock. */
export async function refFiniReferenceTaken(reference: string, exceptId = 0): Promise<boolean> {
  return (await takenKeys(exceptId)).has(referenceKey(reference))
}

/** n-th candidate name: `copy` → « X (copie) », « X (copie 2) »…;
 *  otherwise « X », « X 2 », « X 3 »… */
export function referenceCandidate(base: string, n: number, copy: boolean): string {
  const b = base.trim()
  if (copy) return n === 1 ? `${b} (copie)` : `${b} (copie ${n})`
  return n === 1 ? b : `${b} ${n}`
}

/** First candidate no other ref_fini uses. Call under `refFiniReferenceLock`. */
export async function freeRefFiniReference(base: string, copy: boolean): Promise<string> {
  const taken = await takenKeys()
  for (let n = 1; n < 1000; n++) {
    const candidate = referenceCandidate(base, n, copy)
    if (!taken.has(referenceKey(candidate))) return candidate
  }
  throw new Error(`No free ref_fini reference for « ${base} »`)
}
