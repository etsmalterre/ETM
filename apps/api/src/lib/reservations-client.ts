// Who some pieces are reserved to: the client name and order numero of client lines
// (IDligne_commande_client). Shared by the Sous-traitants drawers (dyer, knitter) and the
// Clients › Commandes knitting gauge (LIVA #1350).
import { query, fixEncoding } from './hfsql-auto.js'

/** Client name + order numero of the client lines some rolls are reserved to
 *  (IDligne_commande_client). The chain ligne_commande_client → commande_client
 *  → client is walked in flat batched queries: the legacy bridge mishandles
 *  CONVERT() across joins (CLAUDE.md). */
export async function reservationsClient(ids: number[]): Promise<{ clientByLcc: Map<number, string>; commandeNumByLcc: Map<number, number> }> {
  const clientByLcc = new Map<number, string>()
  const commandeNumByLcc = new Map<number, number>()
  const lccIds = Array.from(new Set(ids.filter((x) => x > 0)))
  if (lccIds.length > 0) {
    const lccRows = await query<{ IDligne_commande_client: number; IDcommande_client: number }>(
      `SELECT IDligne_commande_client, IDcommande_client
       FROM ligne_commande_client
       WHERE IDligne_commande_client IN (${lccIds.join(',')})`,
    )
    const ccIds = Array.from(new Set(
      lccRows.map((r) => Number(r.IDcommande_client) || 0).filter((x) => x > 0)
    ))
    const clientIdByCC = new Map<number, number>()
    const numeroByCC = new Map<number, number>()
    if (ccIds.length > 0) {
      const ccRows = await query<{ IDcommande_client: number; IDclient: number; numero: number | null }>(
        `SELECT IDcommande_client, IDclient, numero FROM commande_client
         WHERE IDcommande_client IN (${ccIds.join(',')})`,
      )
      for (const r of ccRows) {
        clientIdByCC.set(Number(r.IDcommande_client), Number(r.IDclient))
        if (Number(r.numero) > 0) numeroByCC.set(Number(r.IDcommande_client), Number(r.numero))
      }
    }
    const clientIds = Array.from(new Set(Array.from(clientIdByCC.values()).filter((x) => x > 0)))
    const nameById = new Map<number, string>()
    if (clientIds.length > 0) {
      const clRows = await query<{ IDclient: number; nom: string | null }>(
        `SELECT IDclient, nom FROM client WHERE IDclient IN (${clientIds.join(',')})`,
      )
      const fixedCl = await fixEncoding(clRows, 'client', 'IDclient', ['nom'])
      for (const r of fixedCl) nameById.set(Number(r.IDclient), (r.nom ?? '').trim())
    }
    for (const r of lccRows) {
      const num = numeroByCC.get(Number(r.IDcommande_client))
      if (num) commandeNumByLcc.set(Number(r.IDligne_commande_client), num)
      const cid = clientIdByCC.get(Number(r.IDcommande_client))
      if (cid && cid > 0) {
        const nm = nameById.get(cid)
        if (nm) clientByLcc.set(Number(r.IDligne_commande_client), nm)
      }
    }
  }
  return { clientByLcc, commandeNumByLcc }
}
