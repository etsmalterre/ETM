// Weekly volumes ETM counts itself, for the measured tasks of RH › Charge de
// travail (lib/rh-charge.ts). Each indicator is one flat HFSQL read of a date
// column over the last two years, bucketed per week in JS — no GROUP BY on a
// computed week, no JOIN + CONVERT (hfsql_odbc.md). Cached one hour: the
// workload of a person does not move by the minute, and these are real reads
// on the shared HFSQL server.

import { query } from './hfsql-auto.js'
import { compterParSemaine } from './rh-charge.js'

export interface Indicateur {
  cle: string
  label: string
  /** Unit shown after the number, singular. */
  unite: string
  /** SQL returning one row per unit with its date as `d` (YYYYMMDD), from `depuis`. */
  sql: (depuis: string) => string[]
}

export const INDICATEURS: readonly Indicateur[] = [
  {
    cle: 'commandes_client',
    label: 'Commandes clients',
    unite: 'commande',
    sql: (d) => [`SELECT date_commande AS d FROM commande_client WHERE IDsociete = 1 AND date_commande >= '${d}'`],
  },
  {
    cle: 'lignes_commande_client',
    label: 'Lignes de commande client',
    unite: 'ligne',
    sql: (d) => [
      `SELECT c.date_commande AS d FROM ligne_commande_client l
       JOIN commande_client c ON l.IDcommande_client = c.IDcommande_client
       WHERE c.IDsociete = 1 AND c.date_commande >= '${d}'`,
    ],
  },
  {
    cle: 'commandes_teinture',
    label: 'Commandes de teinture (ennoblisseurs)',
    unite: 'commande',
    sql: (d) => [
      `SELECT c.date_commande AS d FROM commande_sous_traitant c
       JOIN sous_traitant st ON c.IDsous_traitant = st.IDsous_traitant
       WHERE st.IDtype_sst = 2 AND c.date_commande >= '${d}'`,
    ],
  },
  {
    cle: 'commandes_tricotage',
    label: 'Commandes de tricotage',
    unite: 'commande',
    sql: (d) => [
      `SELECT c.date_commande AS d FROM commande_sous_traitant c
       JOIN sous_traitant st ON c.IDsous_traitant = st.IDsous_traitant
       WHERE st.IDtype_sst = 1 AND c.date_commande >= '${d}'`,
    ],
  },
  {
    cle: 'commandes_fil',
    label: 'Commandes de fil',
    unite: 'commande',
    sql: (d) => [`SELECT date_commande AS d FROM commande_fil WHERE date_commande >= '${d}'`],
  },
  {
    cle: 'expeditions',
    label: 'Expéditions (avis + divers)',
    unite: 'expédition',
    // `DATE` is a reserved word: written uppercase, aliased (CLAUDE.md §HFSQL).
    sql: (d) => [
      `SELECT DATE AS d FROM expedition WHERE IDsociete = 1 AND DATE >= '${d}'`,
      `SELECT DATE AS d FROM expedition_divers WHERE DATE >= '${d}'`,
    ],
  },
  {
    cle: 'etudes_coloris',
    label: 'Soumissions d’études coloris',
    unite: 'soumission',
    sql: (d) => [`SELECT date_soum AS d FROM soum_col WHERE date_soum >= '${d}'`],
  },
  {
    cle: 'suivi_lots',
    label: 'Lots suivis (Qualité › Suivi lots)',
    unite: 'lot',
    sql: (d) => [`SELECT DATE AS d FROM suivilot WHERE DATE >= '${d}'`],
  },
]

export function indicateurParCle(cle: string): Indicateur | undefined {
  return INDICATEURS.find((i) => i.cle === cle)
}

const TTL_MS = 60 * 60_000
const cache = new Map<string, { at: number; parSemaine: Map<string, number> }>()

function depuisDeuxAns(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear() - 2, now.getUTCMonth(), 1))
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}

/** Units per Monday for one indicator (cached one hour). */
export async function volumesHebdo(cle: string): Promise<Map<string, number>> {
  const ind = indicateurParCle(cle)
  if (!ind) return new Map()
  const hit = cache.get(cle)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.parSemaine
  const depuis = depuisDeuxAns()
  const dates: string[] = []
  for (const sql of ind.sql(depuis)) {
    const rows = await query<{ d: unknown; D?: unknown }>(sql)
    for (const r of rows) dates.push(String(r.d ?? r.D ?? ''))
  }
  const parSemaine = compterParSemaine(dates)
  cache.set(cle, { at: Date.now(), parSemaine })
  return parSemaine
}

/** Volumes for every indicator a set of tasks uses, fetched one after the
 *  other (never a burst of parallel reads on the shared server). */
export async function volumesPour(cles: Iterable<string>): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>()
  for (const cle of new Set(cles)) {
    if (indicateurParCle(cle)) out.set(cle, await volumesHebdo(cle))
  }
  return out
}
