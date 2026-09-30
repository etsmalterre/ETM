// Clients › Expéditions search over EVERY year (LIVA #1247).
//
// The list used to fetch the 800 most recent expeditions and filter them in
// JS: with the « Facturées » filter that reached back ~11 months, so an older
// invoiced expedition could not be found. The match now runs in the database
// and returns one page of ids, newest first, with the same `before` cursor as
// the plain list — so « Charger plus » keeps working while searching.
//
// Same matching as before: the expedition number, the order number (formelle)
// or the client name, accent- and case-insensitive. Client names are matched
// in JS (norm()) — there is no unaccent extension in `mps`, and 668 names cost
// nothing — then passed to SQL as an id list.

import { mpsPg } from './mps-pg.js'

export type RechercheEtat = 'all' | 'facture' | 'nonfacture'

export interface RechercheExpeditions {
  q: string
  etat: RechercheEtat
  limit: number
  /** Only ids strictly below this one (cursor), or null for the first page. */
  before: number | null
}

/** Accent-insensitive, case-insensitive form used for contains-matching. */
export function normRecherche(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

/** `%q%` for LIKE, with the user's own `%`, `_` and `\` taken literally. */
export function likeContient(q: string): string {
  return `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}

/** Ids of the clients whose name contains the search term. */
async function clientsCorrespondants(q: string): Promise<number[]> {
  const nq = normRecherche(q)
  if (!nq) return []
  const rows = await mpsPg()<{ idclient: number; nom: string | null }[]>`
    SELECT idclient, nom FROM client`
  return rows.filter((r) => normRecherche(r.nom ?? '').includes(nq)).map((r) => Number(r.idclient))
}

function etatSql(etat: RechercheEtat) {
  const sql = mpsPg()
  if (etat === 'facture') return sql`AND est_facture = 1`
  if (etat === 'nonfacture') return sql`AND (est_facture IS NULL OR est_facture = 0)`
  return sql``
}

/** Formelle (IDsociete = 1): ids of the matching expeditions, newest first. */
export async function rechercherExpeditionsFormelles(r: RechercheExpeditions): Promise<number[]> {
  const sql = mpsPg()
  const like = likeContient(r.q)
  const clients = await clientsCorrespondants(r.q)
  const rows = await sql<{ idexpedition: number }[]>`
    SELECT idexpedition FROM expedition
    WHERE idsociete = 1 ${etatSql(r.etat)}
      ${r.before !== null ? sql`AND idexpedition < ${r.before}` : sql``}
      AND (
        idexpedition::text LIKE ${like}
        OR idcommande_client IN (
          SELECT idcommande_client FROM commande_client
          WHERE numero::text LIKE ${like} OR idclient = ANY(${clients}::bigint[])
        )
      )
    ORDER BY idexpedition DESC
    LIMIT ${r.limit}`
  return rows.map((x) => Number(x.idexpedition))
}

/** Divers (no IDsociete): ids of the matching expeditions, newest first. A
 *  divers without a client shows its free-typed `ref_client` as the name. */
export async function rechercherExpeditionsDivers(r: RechercheExpeditions): Promise<number[]> {
  const sql = mpsPg()
  const like = likeContient(r.q)
  const nq = normRecherche(r.q)
  const [clients, refs] = await Promise.all([
    clientsCorrespondants(r.q),
    sql<{ ref_client: string | null }[]>`
      SELECT DISTINCT ref_client FROM expedition_divers WHERE (idclient IS NULL OR idclient = 0)`,
  ])
  const refsOk = nq
    ? refs.map((x) => x.ref_client ?? '').filter((ref) => normRecherche(ref).includes(nq))
    : []
  const rows = await sql<{ idexpedition_divers: number }[]>`
    SELECT idexpedition_divers FROM expedition_divers
    WHERE 1 = 1 ${etatSql(r.etat)}
      ${r.before !== null ? sql`AND idexpedition_divers < ${r.before}` : sql``}
      AND (
        idexpedition_divers::text LIKE ${like}
        OR idclient = ANY(${clients}::bigint[])
        OR ((idclient IS NULL OR idclient = 0) AND ref_client::text = ANY(${refsOk}::text[]))
      )
    ORDER BY idexpedition_divers DESC
    LIMIT ${r.limit}`
  return rows.map((x) => Number(x.idexpedition_divers))
}
