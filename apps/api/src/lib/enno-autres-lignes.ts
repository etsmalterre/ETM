// One dyer order may carry the écru reserved to SEVERAL client lines (Vincent, 2026-11-02: Agape
// 3858 + 3892, same 228/122 Black Lace, both planned at MATEL for the same day — one order, one
// weight band, plus free pieces for the stock). The rule of 2026-10-28 stays: an order from a line
// dyes only RESERVED matter (+ free pieces for the stock) — but reserved to this line OR to another
// client line of the same article, whatever the client. Each piece keeps its own reservation, so the
// dyer order's Affectations (lib/affectations-sst.ts) read every client through the pieces.
//
// Another line's piece goes only when that line could have sent it itself: a fini line of the same
// reference AND coloris (strict: a line without coloris is waiting for its étude, LIVA #1215), its
// order validated (not « En préparation ») and not soldée.

import { query, fixEncoding } from './hfsql-auto.js'
import { commandesEnPreparation } from './preparation-commande.js'
import type { DyeLineKey } from './reservation-teinture.js'

export interface AutreLigne {
  ligneId: number
  commandeId: number
  /** commande_client.numero, as a string (PG returns a number — #1264) */
  numero: string
  client_nom: string
  /** Same fini reference + coloris as the dyer line being created. */
  memeArticle: boolean
  /** Why its pieces cannot go on the order; null = they can. */
  raison: string | null
}

/** The pure decision, unit-tested. */
export function raisonRefus(l: { memeArticle: boolean; enPreparation: boolean; soldee: boolean }): string | null {
  if (!l.memeArticle) return 'réservée pour un autre article'
  if (l.soldee) return 'commande soldée'
  if (l.enPreparation) return 'commande en préparation'
  return null
}

/** Same article = a FINI line of the dyer line's reference and coloris, both set. */
export function memeArticle(line: { type: number; ref: number; coloris: number }, dye: DyeLineKey): boolean {
  return line.type === 2 && line.ref === dye.ref && dye.coloris > 0 && line.coloris === dye.coloris
}

/** Client lines `lineIds` (other than the one the order is made from), described against `dye`. */
export async function chargerAutresLignes(lineIds: readonly number[], dye: DyeLineKey): Promise<Map<number, AutreLigne>> {
  const out = new Map<number, AutreLigne>()
  const ids = [...new Set(lineIds.filter((x) => x > 0))]
  if (ids.length === 0) return out
  // TYPE is a reserved word — always aliased.
  const lines = await query<Record<string, unknown>>(
    `SELECT IDligne_commande_client, IDcommande_client, TYPE AS type_kind, IDreference, IDcolori
       FROM ligne_commande_client WHERE IDligne_commande_client IN (${ids.join(',')})`,
  )
  const cmdIds = [...new Set(lines.map((r) => Number(r.IDcommande_client) || 0).filter((x) => x > 0))]
  const cmds = cmdIds.length === 0 ? [] : await query<{ IDcommande_client: number; numero: unknown; IDclient: number | null; est_soldee: number | null }>(
    `SELECT IDcommande_client, numero, IDclient, est_soldee FROM commande_client WHERE IDcommande_client IN (${cmdIds.join(',')})`,
  )
  const cmdById = new Map(cmds.map((c) => [Number(c.IDcommande_client), c]))
  const clientIds = [...new Set(cmds.map((c) => Number(c.IDclient) || 0).filter((x) => x > 0))]
  const clientRows = clientIds.length === 0 ? [] : await fixEncoding(
    await query<{ IDclient: number; nom: string | null }>(`SELECT IDclient, nom FROM client WHERE IDclient IN (${clientIds.join(',')})`),
    'client', 'IDclient', ['nom'],
  )
  const clientNom = new Map(clientRows.map((c) => [Number(c.IDclient), String(c.nom ?? '').trim()]))
  const enPrep = await commandesEnPreparation(cmdIds)

  for (const r of lines) {
    const ligneId = Number(r.IDligne_commande_client) || 0
    const commandeId = Number(r.IDcommande_client) || 0
    const cmd = cmdById.get(commandeId)
    const meme = memeArticle({ type: Number(r.type_kind) || 0, ref: Number(r.IDreference) || 0, coloris: Number(r.IDcolori) || 0 }, dye)
    out.set(ligneId, {
      ligneId,
      commandeId,
      numero: String(cmd?.numero ?? '').trim() || '?',
      client_nom: clientNom.get(Number(cmd?.IDclient) || 0) ?? '',
      memeArticle: meme,
      raison: raisonRefus({ memeArticle: meme, enPreparation: enPrep.has(commandeId), soldee: Number(cmd?.est_soldee) === 1 }),
    })
  }
  return out
}
