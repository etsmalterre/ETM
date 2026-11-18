// Since when an item is red (Vincent 2026-11-18).
//
// A task = something red: someone at Malterre must act now (mps_designer §41).
// Each list computes its red live from data, so nothing knew how long an item
// had been waiting. This register keeps one row per red item of a family
// (PG `tache_rouge`, migration 0080): the periodic relevé (releve.ts) writes
// what is red now, `depuis` is kept while the item stays red and the row goes
// the day it is no longer red.
//
// It serves ONE rule: a task left red more than SEUIL_RETARD_J working days
// also reaches whoever holds « Tâches en retard » (lib/abonnements-etm.ts),
// in addition to the family's subscribers.
//
// State, not history: nothing here says what was red last month.

import type { Sql } from 'postgres'
import { mpsPg } from '../mps-pg.js'
import { joursOuvresEntre } from '../jours-ouvres.js'

/** One red item, as its family reads it now. */
export interface TacheRelevee {
  /** The item's id inside its family (an order id, a lot id…). */
  cle: string
  /** What it is: « Commande N° 3891 · LEMAHIEU ». */
  titre: string
  /** The Malterre action, as the list prints it: « 2 lignes à expédier ». */
  raison: string
  /** Where to act (a deep link of the web app), or null. */
  lien: string | null
}

export interface TacheRouge extends TacheRelevee {
  /** The family's key (SourceRouge.cle). */
  source: string
  /** First day seen red, Paris, YYYYMMDD. */
  depuis: string
}

/** A task is late once it has stayed red MORE than this many working days. */
export const SEUIL_RETARD_J = 2

/** Working days an item has been red: 0 the day it turned red (weekends and
 *  French public holidays do not count). Both dates YYYYMMDD. */
export function joursRouges(depuis: string, aujourdhui: string): number {
  return Math.max(0, joursOuvresEntre(depuis, aujourdhui))
}

/** Red since Monday: late from Thursday (Tuesday and Wednesday are the two days). */
export function enRetard(depuis: string, aujourdhui: string): boolean {
  return joursRouges(depuis, aujourdhui) > SEUIL_RETARD_J
}

/** Today in Paris, YYYYMMDD. */
export function aujourdhuiParis(maintenant: Date = new Date()): string {
  return new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(maintenant).replace(/-/g, '')
}

/** What a relevé changes in the register (pure, pinned by registre.test.ts):
 *  a key already known keeps its row (and its `depuis`), a new one enters,
 *  a known one that is no longer red leaves. Duplicate keys of a relevé count once. */
export function planSynchronisation(connues: readonly string[], relevees: readonly TacheRelevee[]): {
  nouvelles: TacheRelevee[]
  gardees: TacheRelevee[]
  closes: string[]
} {
  const deja = new Set(connues)
  const vues = new Map<string, TacheRelevee>()
  for (const t of relevees) if (!vues.has(t.cle)) vues.set(t.cle, t)
  const nouvelles: TacheRelevee[] = []
  const gardees: TacheRelevee[] = []
  for (const t of vues.values()) (deja.has(t.cle) ? gardees : nouvelles).push(t)
  return { nouvelles, gardees, closes: connues.filter((c) => !vues.has(c)) }
}

/** Write one family's relevé. ⚠️ Call it only with a relevé that SUCCEEDED: an
 *  empty list means « nothing is red », and clears the family. */
export async function synchroniser(source: string, relevees: readonly TacheRelevee[], sql: Sql = mpsPg()): Promise<void> {
  await sql.begin(async (tx) => {
    const t = tx as unknown as Sql
    const connues = (await t<{ cle: string }[]>`SELECT cle FROM tache_rouge WHERE source = ${source}`).map((r) => r.cle)
    const plan = planSynchronisation(connues, relevees)
    if (plan.closes.length) await t`DELETE FROM tache_rouge WHERE source = ${source} AND cle = ANY(${plan.closes})`
    // Text and link follow the item (its reason changes while it stays red); `depuis` never moves.
    for (const g of plan.gardees) {
      await t`UPDATE tache_rouge SET titre = ${g.titre}, raison = ${g.raison}, lien = ${g.lien}, vu_le = now()
              WHERE source = ${source} AND cle = ${g.cle}`
    }
    if (plan.nouvelles.length) {
      const lignes = plan.nouvelles.map((n) => ({ source, cle: n.cle, titre: n.titre, raison: n.raison, lien: n.lien }))
      await t`INSERT INTO tache_rouge ${t(lignes, 'source', 'cle', 'titre', 'raison', 'lien')}`
    }
  })
}

/** The red items of these families, oldest first. */
export async function lireTaches(sources: readonly string[], sql: Sql = mpsPg()): Promise<TacheRouge[]> {
  if (sources.length === 0) return []
  return sql<TacheRouge[]>`
    SELECT source, cle, titre, raison, lien,
           to_char(depuis AT TIME ZONE 'Europe/Paris', 'YYYYMMDD') AS depuis
      FROM tache_rouge
     WHERE source = ANY(${[...sources]})
     ORDER BY tache_rouge.depuis, cle`
}
