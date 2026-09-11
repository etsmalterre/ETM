/**
 * « Clients » of a finished reference — who has already ordered it (LIVA
 * #1155). Port of the legacy `FI_Ref_Fini` `TABLE_Client`, whose single query
 * grouped the ETM order lines of the ref by client with a line count and a
 * summed quantity. The aggregation is a pure function so its edge cases are
 * pinned without a database; `loadClientsForRefFini` does the flat queries.
 */
import { query, fixEncoding } from './hfsql-auto.js'

export interface RefFiniOrderLine {
  IDcommande_client: number
  quantite: number
  /** 1 = Kg, 3 = Ml (the legacy WinDev combo — see commandes-client.ts). */
  unite: number
}

export interface RefFiniOrderHeader {
  IDcommande_client: number
  IDclient: number
  numero: number
  /** HFSQL `YYYYMMDD` (empty when unknown). */
  date_commande: string
}

export interface RefFiniClientRow {
  IDclient: number
  nom: string
  nb_commandes: number
  nb_lignes: number
  /** Σ quantite of the Ml lines. */
  metrage: number
  /** Σ quantite of the Kg lines. */
  poids: number
  /** Most recent order of this client for the ref. */
  derniere_date: string | null
  dernier_numero: number | null
}

/**
 * Group the lines of one ref by client. Lines whose order header is missing
 * (foreign partition, dangling FK) are dropped — the header set IS the scope.
 * Sorted by volume, highest first (Ml, then Kg for the rare Kg-only client,
 * then name) — the big buyers of the reference are what the user wants to see
 * at the top (Vincent, 2026-09-11).
 */
export function aggregateClientsForRef(
  lines: RefFiniOrderLine[],
  headers: RefFiniOrderHeader[],
  names: Map<number, string>,
): RefFiniClientRow[] {
  const headerById = new Map<number, RefFiniOrderHeader>()
  for (const h of headers) headerById.set(h.IDcommande_client, h)

  const byClient = new Map<number, RefFiniClientRow & { commandes: Set<number> }>()
  for (const line of lines) {
    const h = headerById.get(line.IDcommande_client)
    if (!h) continue
    let row = byClient.get(h.IDclient)
    if (!row) {
      row = {
        IDclient: h.IDclient,
        nom: names.get(h.IDclient) ?? `Client #${h.IDclient}`,
        nb_commandes: 0,
        nb_lignes: 0,
        metrage: 0,
        poids: 0,
        derniere_date: null,
        dernier_numero: null,
        commandes: new Set(),
      }
      byClient.set(h.IDclient, row)
    }
    row.nb_lignes += 1
    row.commandes.add(h.IDcommande_client)
    const q = Number(line.quantite) || 0
    if (Number(line.unite) === 3) row.metrage += q
    else row.poids += q
    // YYYYMMDD strings compare lexically; an empty date never wins.
    const d = (h.date_commande ?? '').trim()
    if (d !== '' && (row.derniere_date === null || d > row.derniere_date)) {
      row.derniere_date = d
      row.dernier_numero = h.numero
    } else if (row.derniere_date === null && row.dernier_numero === null) {
      row.dernier_numero = h.numero
    }
  }

  const out: RefFiniClientRow[] = []
  for (const r of byClient.values()) {
    const { commandes, ...rest } = r
    out.push({ ...rest, nb_commandes: commandes.size })
  }
  out.sort((a, b) => {
    if (a.metrage !== b.metrage) return b.metrage - a.metrage
    if (a.poids !== b.poids) return b.poids - a.poids
    return a.nom.localeCompare(b.nom, 'fr')
  })
  return out
}

/** Flat queries (no JOIN — a JOIN + CONVERT collapses on this driver), ETM
 *  partition only (`IDsociete = 1`, as the legacy table did). */
export async function loadClientsForRefFini(refId: number): Promise<RefFiniClientRow[]> {
  // `type` is a reserved word on the bridge: write it uppercase, never alias-free
  // in the SELECT list (we don't need it back anyway).
  const lineRows = await query<{ IDcommande_client: number; quantite: number | null; unite: number | null }>(
    `SELECT IDcommande_client, quantite, unite FROM ligne_commande_client
     WHERE TYPE = 2 AND IDreference = ${refId}`,
  )
  const lines: RefFiniOrderLine[] = lineRows.map((r) => ({
    IDcommande_client: Number(r.IDcommande_client) || 0,
    quantite: Number(r.quantite) || 0,
    unite: Number(r.unite) || 0,
  }))
  const cmdIds = Array.from(new Set(lines.map((l) => l.IDcommande_client).filter((x) => x > 0)))
  if (cmdIds.length === 0) return []

  const headers: RefFiniOrderHeader[] = []
  // Keep IN lists bounded — a popular ref can sit on hundreds of orders.
  for (let i = 0; i < cmdIds.length; i += 200) {
    const chunk = cmdIds.slice(i, i + 200)
    const rows = await query<{ IDcommande_client: number; IDclient: number; numero: number; date_commande: string | null }>(
      `SELECT IDcommande_client, IDclient, numero, date_commande FROM commande_client
       WHERE IDsociete = 1 AND IDcommande_client IN (${chunk.join(',')})`,
    )
    for (const r of rows) {
      headers.push({
        IDcommande_client: Number(r.IDcommande_client) || 0,
        IDclient: Number(r.IDclient) || 0,
        numero: Number(r.numero) || 0,
        date_commande: (r.date_commande ?? '').toString(),
      })
    }
  }

  const clientIds = Array.from(new Set(headers.map((h) => h.IDclient).filter((x) => x > 0)))
  const names = new Map<number, string>()
  if (clientIds.length > 0) {
    // `SELECT *` returns 0 rows on client (memo column) — explicit columns.
    const rows = await query<{ IDclient: number; nom: string | null }>(
      `SELECT IDclient, nom FROM client WHERE IDclient IN (${clientIds.join(',')})`,
    )
    const fixed = await fixEncoding(rows, 'client', 'IDclient', ['nom'])
    for (const r of fixed) names.set(Number(r.IDclient), (r.nom ?? '').toString().trim())
  }

  return aggregateClientsForRef(lines, headers, names)
}
