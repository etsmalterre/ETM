import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { query } from '../lib/hfsql-auto.js'
import { repairAliased } from './stock-fini.js'
import { defautSummary, fetchDefectsByEcru, resolveClientReservations } from './stock-ecru.js'

export const stockEcruTrmRouter: RouterType = Router()

type StockEcru = Record<string, unknown>

// ── Why this is a separate route file from stock-ecru.ts ────────────────
// `stock_ecru` is shared by both companies (IDsociete: 1 = ETM, 2 = TRM), but
// the two halves are different objects with different lifecycles, so the ETM
// endpoints cannot simply take a `societe` param:
//
//   ETM écru        bought from a tricoteur, sits in a magasin, gets affected
//                   to an ennoblisseur for dyeing, then becomes a stock_fini.
//                   Keys: IDmagasin, IDref_commande_affectation,
//                   IDligne_commande_client, IDligne_expedition_ETM.
//
//   TRM écru        knitted in-house from an ordre_fabrication on a machine
//                   (métier), then shipped to the customer — usually ETM.
//                   Keys: IDordre_fabrication, IDpiece_production,
//                   IDLigne_Commande_TRM, IDligne_expedition_TRM.
//                   IDmagasin is 0 on every row, metrage is 0, lot is empty,
//                   and there is no teinture step at all (dyeing is what the
//                   *customer* does with the piece, not part of TRM's ledger).
//
// So: own population filter, own status codes, own joins. The pieces that ARE
// identical — the défauts summary and the ligne_commande_client → client chain
// — are imported from stock-ecru.ts rather than duplicated.

// Every selected column name is ASCII, so no IS_WINDOWS branching is needed on
// the base query (same reasoning as stock-ecru.ts). Note the tables joined here
// DO carry accented columns we deliberately never name: `machine.archivé` /
// `machine.diamètre` / `machine.connecté` and `ordre_fabrication.productivité*`
// — naming any of them storms the Linux bridge, and `SELECT *` inside a JOIN
// silently returns zero rows on the Windows driver.
const STOCK_ECRU_TRM_SELECT = `se.IDstock_ecru, se.IDref_ecru, se.IDcolori_ecru, se.IDordre_fabrication, se.IDpiece_production, se.IDLigne_Commande_TRM, se.poids, se.metrage, se.lot, se.numero, se.num_piece_OF, se.observations, se.visiteur, se.second_choix, se.date_saisie, re.reference AS ref_ecru, ce.reference AS coloris_reference, orf.IDmachine, m.nom AS machine_nom`

// `of` is too close to SQL keyword territory for comfort in the HFSQL parser —
// the ordre_fabrication alias is `orf` everywhere in this file.
const STOCK_ECRU_TRM_JOINS = `FROM stock_ecru se LEFT JOIN ref_ecru re ON se.IDref_ecru = re.IDref_ecru LEFT JOIN colori_ecru ce ON se.IDcolori_ecru = ce.IDcolori_ecru LEFT JOIN ordre_fabrication orf ON se.IDordre_fabrication = orf.IDordre_fabrication LEFT JOIN machine m ON orf.IDmachine = m.IDmachine`

/** TRM's live working set: pieces this company knitted and still physically
 *  holds. `IDligne_expedition_TRM = 0` is the "not shipped out yet" signal —
 *  the TRM-side mirror of ETM's `IDligne_expedition_ETM`. HFSQL stores "no FK"
 *  as 0 rather than NULL, so guard both. Bounds the view to ~1k rows out of the
 *  ~6.7k TRM rows on file, which keeps the défauts + client hydration fast. */
const TRM_BASE_WHERE = [
  'se.IDsociete = 2',
  '(se.IDligne_expedition_TRM = 0 OR se.IDligne_expedition_TRM IS NULL)',
]

/** Repair the base text columns + joined labels, then attach the commande
 *  client reservation and the défauts summary. Shared by list and detail. */
async function hydrateTrmEcruRows(rows: StockEcru[]): Promise<StockEcru[]> {
  let fixed = await repairAliased(rows, 'stock_ecru', 'IDstock_ecru', {
    numero: 'numero',
    lot: 'lot',
    observations: 'observations',
    visiteur: 'visiteur',
  })
  fixed = await repairAliased(fixed, 'ref_ecru', 'IDref_ecru', { ref_ecru: 'reference' })
  fixed = await repairAliased(fixed, 'colori_ecru', 'IDcolori_ecru', { coloris_reference: 'reference' })
  fixed = await repairAliased(fixed, 'machine', 'IDmachine', { machine_nom: 'nom' })

  // The commande client hangs off IDLigne_Commande_TRM, NOT
  // IDligne_commande_client (which is 0 on every TRM row) — see the exported
  // resolver's doc comment in stock-ecru.ts.
  const lineIds = fixed.map((r) => Number((r as any).IDLigne_Commande_TRM) || 0)
  const reservations = await resolveClientReservations(lineIds)
  const ecruIds = fixed.map((r) => Number((r as any).IDstock_ecru) || 0)
  const defectsByEcru = await fetchDefectsByEcru(ecruIds)

  for (const r of fixed as any[]) {
    const lineId = Number(r.IDLigne_Commande_TRM) || 0
    const resv = lineId > 0 ? reservations.get(lineId) : undefined
    r.commande_numero = resv?.commande_numero ?? null
    r.client_nom = resv?.client_nom ?? null
    const defects = defectsByEcru.get(Number(r.IDstock_ecru) || 0) ?? []
    r.defects = defects
    r.defauts = defautSummary(defects)
  }
  return fixed
}

// GET /api/stock/ecru-trm — Tombé Métier › Stock for Tricotage Malterre.
//   ?statut=disponible | affecte | tous   (default disponible)
//      disponible → not yet reserved to a commande client (free stock)
//      affecte    → reserved to a commande client line (IDLigne_Commande_TRM > 0)
//      tous       → no affectation filter
//   ?second_choix=1 → only second-choix pieces
stockEcruTrmRouter.get('/ecru-trm', async (req: Request, res: Response) => {
  try {
    const statut = typeof req.query.statut === 'string' ? req.query.statut : 'disponible'
    const onlySecond = req.query.second_choix === '1'

    const where = [...TRM_BASE_WHERE]
    if (statut === 'disponible') {
      where.push('(se.IDLigne_Commande_TRM = 0 OR se.IDLigne_Commande_TRM IS NULL)')
    } else if (statut === 'affecte') {
      where.push('se.IDLigne_Commande_TRM > 0')
    }
    if (onlySecond) where.push('se.second_choix = 1')

    const sql = `SELECT ${STOCK_ECRU_TRM_SELECT} ${STOCK_ECRU_TRM_JOINS} WHERE ${where.join(' AND ')} ORDER BY se.date_saisie DESC, se.IDstock_ecru DESC`
    const rows = await query<StockEcru>(sql)
    res.json(await hydrateTrmEcruRows(rows))
  } catch (err) {
    console.error('Error fetching TRM stock_ecru:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/stock/ecru-trm/:id — one piece, with its production context (the OF
//   it came off and the piece_production timings the visiteuse recorded).
stockEcruTrmRouter.get('/ecru-trm/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) {
      res.status(400).json({ error: 'Invalid id' })
      return
    }

    const rows = await query<StockEcru>(
      `SELECT ${STOCK_ECRU_TRM_SELECT} ${STOCK_ECRU_TRM_JOINS} WHERE se.IDstock_ecru = ${id} AND se.IDsociete = 2`,
    )
    if (rows.length === 0) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    const [row] = await hydrateTrmEcruRows(rows)

    // Production context. Both lookups are optional — 2026 pieces carry an
    // IDpiece_production, older imported rows often don't.
    const ofId = Number((row as any).IDordre_fabrication) || 0
    const pieceId = Number((row as any).IDpiece_production) || 0

    let ordre: Record<string, unknown> | null = null
    if (ofId > 0) {
      const ofRows = await query<Record<string, unknown>>(
        `SELECT IDordre_fabrication, IDmachine, quantite, nb_pieces, poids_piece, date_creation, est_termine, est_actif
         FROM ordre_fabrication WHERE IDordre_fabrication = ${ofId}`,
      )
      ordre = ofRows[0] ?? null
    }

    let piece: Record<string, unknown> | null = null
    if (pieceId > 0) {
      const pieceRows = await query<Record<string, unknown>>(
        `SELECT IDpiece_production, numero, poids, date_debut, date_fin, date_visitage
         FROM piece_production WHERE IDpiece_production = ${pieceId}`,
      )
      piece = pieceRows[0] ?? null
    }

    res.json({
      ...row,
      production: {
        IDordre_fabrication: ofId || null,
        machine_nom: (row as any).machine_nom ?? null,
        num_piece: Number((row as any).num_piece_OF) || (piece ? Number(piece.numero) || null : null),
        of_quantite: ordre ? Number(ordre.quantite) || null : null,
        of_nb_pieces: ordre ? Number(ordre.nb_pieces) || null : null,
        of_est_termine: ordre ? Number(ordre.est_termine) || 0 : null,
        date_debut: (piece?.date_debut ?? null) as string | null,
        date_fin: (piece?.date_fin ?? null) as string | null,
        date_visitage: (piece?.date_visitage ?? null) as string | null,
      },
    })
  } catch (err) {
    console.error('Error fetching TRM stock_ecru detail:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
