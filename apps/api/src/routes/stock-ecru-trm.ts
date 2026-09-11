import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { repairAliased } from './stock-fini.js'
import { defautSummary, fetchDefectsByEcru, resolveClientReservations } from './stock-ecru.js'
import { maxId } from './expeditions.js'
import { nowDt, sqlText } from '../lib/production-trm.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { trmUserHasPermission } from '../lib/permissions-trm.js'

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

// ── PATCH /api/stock/ecru-trm/:id — observations and / or choix ──────────
//
// The ONLY write on this screen. A roll is created by the poste de visitage
// (poids, choix, défauts, étiquette) and closed by an expédition; what a
// person legitimately changes after the fact is:
//
//   • `observations` — a note on the roll, « ouvrir dans la maille » on one
//     already in stock (LIVA #1108). Key edit_stock_ecru.
//   • `second_choix` — the roll's choix, re-inspected on the floor (LIVA
//     #1150). Key edit_choix_stock_ecru, its OWN key: a note is harmless, a
//     choix change moves money. The flag is the source of truth everywhere
//     (rapports, Prime, TRS, freinte, valorisation) — `num_piece_OF` is NOT
//     renumbered: it is the roll's identity on the label, the defects and the
//     avis, the legacy never renumbered either (3 % of live rows already have
//     flag ≠ number range), and a round trip would be impossible once the freed
//     number is reused. The label is therefore wrong after a flip — the
//     response says so (`choix_change`) and the drawer asks for a reprint.
//     Its reservation follows the #1129 rule: a déclassé carries no commande
//     line (else it leaves with the next « Expédier » at full weight as 1er
//     choix); a re-promoted roll takes the OF's line, as the poste would have
//     stamped it — TRM has no « affecter des pièces disponibles » screen, so
//     without that the roll could only ship from the legacy. Refused (409
//     rouleau_expedie) once the roll has shipped: its choix is on an avis and
//     an invoice, possibly in ETM's ledger. Traced as an evenement_piece row
//     so the Visitage tab of the OF shows who flipped it and when.
//
// poids / IDLigne_Commande_TRM keep belonging to the flows that own them, and
// a client sending them gets 400 (z.strict) rather than a silent ignore. Each
// field is checked against its own key, so a body carrying both needs both.
//
// The partition is IDsociete = 2 on the row itself, which also means a roll
// ETM has received (its IDsociete flipped to 1 at reception) can no longer be
// touched from here: it is ETM's stock now. Named UPDATE: every column named
// is ASCII; the observations VALUE goes through sqlText (Latin-1 hex literal
// when accented — the visiteuse's notes carry accents).
const patchBody = z
  .object({
    observations: z.string().max(4000).optional(),
    second_choix: z.boolean().optional(),
  })
  .strict()
  .refine((b) => b.observations !== undefined || b.second_choix !== undefined, {
    message: 'observations or second_choix is required',
  })

/** The two labels this route writes to evenement_piece — ASCII on purpose
 *  (no « ᵉ », which is not Latin-1), through sqlText like every other label. */
const EVT_PASSAGE_2ND = 'Passage en 2nd choix'
const EVT_PASSAGE_1ER = 'Passage en 1er choix'

stockEcruTrmRouter.patch('/ecru-trm/:id', async (req: Request, res: Response) => {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return
  }
  const id = parseInt(req.params.id, 10)
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid id' })
    return
  }
  const parsed = patchBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
    return
  }
  const body = parsed.data
  const admin = isEffectiveAdmin(req)
  if (body.observations !== undefined && !(await trmUserHasPermission(req.userId, admin, 'edit_stock_ecru'))) {
    res.status(403).json({ error: 'permission denied: edit_stock_ecru' })
    return
  }
  if (body.second_choix !== undefined && !(await trmUserHasPermission(req.userId, admin, 'edit_choix_stock_ecru'))) {
    res.status(403).json({ error: 'permission denied: edit_choix_stock_ecru' })
    return
  }
  try {
    const rows = await query<Record<string, unknown>>(
      `SELECT IDstock_ecru, IDordre_fabrication, IDpiece_production, second_choix, IDLigne_Commande_TRM, IDligne_expedition_TRM
       FROM stock_ecru WHERE IDstock_ecru = ${id} AND IDsociete = 2`,
    )
    const row = rows[0]
    if (!row) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    const wasSecond = Number(row.second_choix) === 1
    const sets: string[] = []
    const out: Record<string, unknown> = { IDstock_ecru: id }

    if (body.observations !== undefined) {
      const observations = body.observations.trim()
      sets.push(`observations = ${sqlText(observations)}`)
      out.observations = observations
    }

    // Same value = nothing to do: the reservation is not re-derived, the
    // event is not written. Only a real flip moves the line.
    const choixChange = body.second_choix !== undefined && body.second_choix !== wasSecond
    let ligne = Number(row.IDLigne_Commande_TRM) || 0
    if (choixChange) {
      if ((Number(row.IDligne_expedition_TRM) || 0) > 0) {
        res.status(409).json({
          error: 'rouleau_expedie',
          message: 'Ce rouleau est déjà expédié : son choix figure sur l’avis d’expédition et ne peut plus changer ici.',
        })
        return
      }
      const toSecond = body.second_choix === true
      if (toSecond) {
        ligne = 0
      } else {
        const ofId = Number(row.IDordre_fabrication) || 0
        const of = ofId > 0
          ? await query<{ IDligne_commande_client: number }>(
              `SELECT IDligne_commande_client FROM ordre_fabrication WHERE IDordre_fabrication = ${ofId}`,
            )
          : []
        ligne = Number(of[0]?.IDligne_commande_client) || 0
      }
      sets.push(`second_choix = ${toSecond ? 1 : 0}`, `IDLigne_Commande_TRM = ${ligne}`)
    }

    if (sets.length > 0) {
      await query(`UPDATE stock_ecru SET ${sets.join(', ')} WHERE IDstock_ecru = ${id}`)
    }

    if (choixChange) {
      // Who flipped it — the utilisateur, not a bonnetier (IDbonnetier stays
      // 0, the name goes in `observation`, which the timeline renders after
      // the label). IDutilisateur must be in the SELECT: fixEncoding reads it
      // as the id field.
      let who = ''
      try {
        const users = await query<{ IDutilisateur: number; prenom: string | null; nom: string | null }>(
          `SELECT IDutilisateur, prenom, nom FROM utilisateur WHERE IDutilisateur = ${req.userId}`,
        )
        const fixed = await fixEncoding(users, 'utilisateur', 'IDutilisateur', ['prenom', 'nom'])
        const u = fixed[0] as { prenom?: string | null; nom?: string | null } | undefined
        who = u ? [u.prenom, u.nom].map((s) => (s ?? '').toString().trim()).filter(Boolean).join(' ') : ''
      } catch (err) {
        console.error('Could not resolve utilisateur name for the choix event:', err)
      }
      // evenement_piece — reserved `date` → positional, MAX+1 PK (the shape
      // visitage-trm writes). Physical order: IDevenement_piece, evenement,
      // IDpiece_production, DATE, IDbonnetier, observation, IDstock_ecru,
      // appareil. Never worth failing the flip over — the UPDATE is done.
      try {
        const evtId = (await maxId('evenement_piece', 'IDevenement_piece')) + 1
        await query(
          `INSERT INTO evenement_piece VALUES (${evtId}, ${sqlText(body.second_choix ? EVT_PASSAGE_2ND : EVT_PASSAGE_1ER)}, ` +
          `${Number(row.IDpiece_production) || 0}, '${nowDt()}', 0, ${sqlText(who ? `par ${who}` : '')}, ${id}, '')`,
        )
      } catch (err) {
        console.error('Could not trace the choix change on evenement_piece:', err)
      }
    }

    res.json({
      ...out,
      second_choix: choixChange ? (body.second_choix ? 1 : 0) : (wasSecond ? 1 : 0),
      IDLigne_Commande_TRM: ligne,
      choix_change: choixChange,
    })
  } catch (err) {
    console.error('Error updating TRM stock_ecru:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
