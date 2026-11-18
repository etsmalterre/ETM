// The relevé of the red families: read what is red now, write the register.
//
// Two callers, one function:
//   - the automate « Tâches rouges » (lib/automates/taches-rouges/), every
//     10 minutes in production, so that `depuis` is right even when nobody has
//     the app open (the 2-working-day rule counts from it);
//   - the notification feed (routes/abonnements.ts), which asks for the
//     families it is about to show to be FRESH: a person who has just handled
//     an order must not find it still red in the bell. Memoised 60 s per
//     family, like the legacy detectors (lib/abonnements.ts).
//
// A family that fails to read leaves its register rows untouched: yesterday's
// red is better than an emptied family (and its `depuis` are kept).

import { synchroniser } from './registre.js'
import type { SourceRouge } from './sources.js'

const FRAICHEUR_MS = 60_000

/** Last successful relevé of each family (ms). */
const releveLe = new Map<string, number>()
/** A relevé under way: two readers arriving together share it. */
const enCours = new Map<string, Promise<number>>()

/** Read one family and write its register. Returns how many items are red. Throws when the read fails. */
export function relever(source: SourceRouge): Promise<number> {
  const deja = enCours.get(source.cle)
  if (deja) return deja
  const p = (async () => {
    const relevees = await source.relever()
    await synchroniser(source.cle, relevees)
    releveLe.set(source.cle, Date.now())
    return relevees.length
  })().finally(() => enCours.delete(source.cle))
  enCours.set(source.cle, p)
  return p
}

/** Make sure the register of these families is at most a minute old. Never throws:
 *  a family that cannot be read is logged and keeps what the register had. */
export async function assurerFrais(sources: readonly SourceRouge[]): Promise<void> {
  const maintenant = Date.now()
  await Promise.all(sources
    .filter((s) => maintenant - (releveLe.get(s.cle) ?? 0) > FRAICHEUR_MS)
    .map((s) => relever(s).catch((err) => { console.error(`[taches] relevé « ${s.cle} » failed:`, err) })))
}

/** Forget the memo: the next read hits the lists (the feed's refresh button). */
export function oublierReleves(): void {
  releveLe.clear()
}
