// Expéditions — Tricotage Malterre (IDsociete = 2). Port of the legacy WinDev
// pair FEN_Expéditions / FEN_Gestion_expédition in Tricotage Malterre mode, plus
// the ETAT_Expédition_TRM report.
//
// ── Why a separate route file from expeditions.ts ───────────────────────────
// The TABLES are the same — `expedition` / `ligne_expedition` are shared and
// partitioned by `expedition.IDsociete` (1 = ETM, 2 = TRM). What differs is the
// merchandise the lines carry, and that difference runs through every query:
//
//   ETM formelle   ships FINISHED rolls (stock_fini.IDligne_expedition) and
//                  bought écru (stock_ecru.IDligne_expedition_ETM). A line can
//                  be either, decided by ligne_commande_client.TYPE. Rolls have
//                  a lot, a métrage and a magasin.
//
//   TRM            ships only tombé de métier it knitted itself:
//                  stock_ecru.IDligne_expedition_TRM. Every line is écru, the
//                  pieces come off an ordre_fabrication on a machine (le métier),
//                  `lot` and `metrage` are empty, IDmagasin is 0, and the client
//                  reservation hangs off IDLigne_Commande_TRM (not
//                  IDligne_commande_client, which is 0 on every TRM row — same
//                  quirk the Tombé Métier › Stock screen documents).
//
// So: own population filter, own piece joins, own document. Everything that IS
// identical — client / transporteur / adresse / contact resolution, the facture
// lock, the id-after-insert dance, the envoi_email audit log, the défauts lookup
// — is imported from expeditions.ts / stock-ecru.ts rather than duplicated.
//
// ── Hard rules (CLAUDE.md § HFSQL + the XDD) ────────────────────────────────
//  - `DATE` is a RESERVED word on `expedition` → read as `DATE AS dexp`, write
//    `DATE` uppercase.
//  - `expedition` has ACCENTED bool columns `envoyé_client` / `envoyé_sst` —
//    NEVER name them (storms the Linux bridge) and never `SELECT *` on the
//    table. Explicit ASCII column lists only; INSERT omits them (HFSQL
//    zero-fills). They are the legacy list's two "Envoyé" checkboxes; like ETM
//    we don't surface them.
//  - `ligne_commande_client.TYPE` is reserved → `SELECT TYPE AS type_kind`.
//  - Empty FK = 0, not NULL → `(col IS NULL OR col = 0)` everywhere.
//  - No parameterized queries / no RETURNING; esc()/parseInt/sqlText; RTF for
//    observation_bl via stripRtf (read) + wrapRtf + sqlText (write); text reads
//    through fixEncoding.
//  - No `numero` column on `expedition` — the document number IS the PK.
//  - Lock model: same as ETM. The legacy validé/dévalider concept stays
//    RETIRED — an expedition is "non facturée" (fully editable) or "facturée"
//    (est_facture = 1, or a definitive facture references one of its
//    ligne_expedition rows) and then every write 409s. `est_valide` is written
//    once at INSERT (0) and ignored everywhere else, exactly like ETM.
//  - Handover guard: when TRM ships to ETS Malterre, ETM's reception takes
//    OWNERSHIP of the piece — the legacy flow flips `stock_ecru.IDsociete` from
//    2 to 1 and stamps `lot = 'trm<IDexpedition>'`. Those rows must stay
//    visible on the avis (they are what was shipped) but must never be
//    reassigned from here, or we would silently detach a piece ETM now owns.
//    Reads therefore ignore IDsociete; writes require `IDsociete = 2`.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { n, dateDigits as dateStr } from '../lib/sst-shared.js'
import { stripRtf, wrapRtf } from '../lib/rtf-utils.js'
import {
  BonLivraisonPdf,
  type BonLivraisonPdfData,
  type BlArticle,
  type BlLot,
  type BlPiece,
} from '../lib/pdf/BonLivraisonPdf.js'
import { sendMail } from '../lib/gmail.js'
import { getUserEmail } from '../lib/user-emails.js'
import { fetchDefectsByEcru, type DefautQualite } from './stock-ecru.js'
import {
  sqlText,
  norm,
  todayDigits,
  uniteLabel,
  lineDim,
  resolveClientNames,
  resolveTransporteurNames,
  loadAdresse,
  loadContactName,
  resolveEcruColoris,
  attachedFactures,
  newIdAfterInsert,
  maxId,
  formatHfsqlDateLongFr,
  logEnvoiEmails,
  pieceCollator,
  TYPE_DOC_AVIS_EXPEDITION,
  type FactureRef,
  type EmailRecipientPayload,
} from './expeditions.js'

export const expeditionsTrmRouter: RouterType = Router()

/** Tricotage Malterre. Every read and every write on `expedition` carries it. */
const SOCIETE_TRM = 2

const FACTURE_LOCK = { error: 'expedition_facturee', message: 'Expédition facturée — non modifiable.' }

/** Explicit ASCII column list — `SELECT *` on `expedition` would pull the two
 *  accented `envoyé_*` columns and storm the Linux bridge. */
const EXP_COLS =
  'IDexpedition, IDcommande_client, IDadresse, IDtransporteur, IDcontact, DATE AS dexp, ' +
  'affiche_observations, est_facture, est_valide, donation, observation_bl'

// ── Piece (tombé de métier) shape ────────────────────────

interface TrmPiece {
  IDstock_ecru: number
  numero: string
  poids: number
  observations: string
  second_choix: number
  /** One label per défaut, in the legacy avis wording ("Maille 25 cm",
   *  "Trou x1"). The screen and the PDF read the SAME array so a piece never
   *  reads differently on paper than on screen. */
  defauts: string[]
  IDordre_fabrication: number
  machine_nom: string | null
  /** false once ETM's reception has taken the piece over (IDsociete flipped to
   *  1) — the UI shows it but offers no "retirer". */
  editable: boolean
}

/** One défaut, formatted the way the legacy report prints it: measured defects
 *  show their size ("Maille 25 cm"), countable ones their count ("Trou x1"), and
 *  anything unstructured falls back to its free-text description.
 *
 *  Deliberately NOT `defautSummary` from stock-ecru.ts: that one is the ETM
 *  stock screens' one-line summary and drops `nombre`, so three separate
 *  démaillages would read as one "Démaillage". On a delivery note the customer
 *  is counting them. */
function defautLabel(d: DefautQualite): string {
  const type = (d.type_defaut ?? '').toString().trim()
  const size = d.taille_cm != null && Number(d.taille_cm) > 0 ? `${Number(d.taille_cm)} cm` : ''
  const count = d.nombre != null && Number(d.nombre) > 0 ? `x${Number(d.nombre)}` : ''
  const head = [type, size || count].filter(Boolean).join(' ')
  return head || (d.description ?? '').toString().trim()
}

/** `orf` is the ordre_fabrication alias everywhere (`of` sits too close to SQL
 *  keyword territory for the HFSQL parser — same choice as stock-ecru-trm.ts).
 *  `machine.archivé` / `diamètre` / `connecté` and `ordre_fabrication.productivité*`
 *  are accented: never named, and `SELECT *` inside a JOIN silently returns zero
 *  rows on the Windows driver. */
const PIECE_SELECT =
  'se.IDstock_ecru, se.numero, se.poids, se.observations, se.second_choix, se.IDsociete, ' +
  'se.IDordre_fabrication, se.IDcolori_ecru, se.IDligne_expedition_TRM, se.IDLigne_Commande_TRM, ' +
  'orf.IDmachine, m.nom AS machine_nom'
const PIECE_JOINS =
  'FROM stock_ecru se ' +
  'LEFT JOIN ordre_fabrication orf ON se.IDordre_fabrication = orf.IDordre_fabrication ' +
  'LEFT JOIN machine m ON orf.IDmachine = m.IDmachine'

async function hydratePieces(rows: any[]): Promise<TrmPiece[]> {
  if (rows.length === 0) return []
  // repairAliased is stock-fini's helper for aliased JOIN columns; here the base
  // columns keep their own names, so plain fixEncoding per source table is enough.
  const baseFixed = (await fixEncoding(
    rows.map((r) => ({
      IDstock_ecru: Number(r.IDstock_ecru) || 0,
      numero: (r.numero ?? '') as string,
      observations: (r.observations ?? '') as string,
    })),
    'stock_ecru', 'IDstock_ecru', ['numero', 'observations'],
  )) as any[]
  const textByPiece = new Map<number, { numero: string; observations: string }>(
    baseFixed.map((r) => [Number(r.IDstock_ecru), {
      numero: (r.numero ?? '').toString().trim(),
      observations: (r.observations ?? '').toString().trim(),
    }]),
  )
  const machineFixed = (await fixEncoding(
    rows.map((r) => ({ IDmachine: Number(r.IDmachine) || 0, nom: (r.machine_nom ?? '') as string })),
    'machine', 'IDmachine', ['nom'],
  )) as any[]
  const machineByRow = new Map<number, string>(
    machineFixed.map((r) => [Number(r.IDmachine), (r.nom ?? '').toString().trim()]),
  )
  const defectsByEcru = await fetchDefectsByEcru(rows.map((r) => Number(r.IDstock_ecru) || 0))

  return rows.map((r) => {
    const id = Number(r.IDstock_ecru) || 0
    const text = textByPiece.get(id) ?? { numero: '', observations: '' }
    const defects = defectsByEcru.get(id) ?? []
    return {
      IDstock_ecru: id,
      numero: text.numero,
      poids: Number(r.poids) || 0,
      observations: text.observations,
      second_choix: Number(r.second_choix) || 0,
      defauts: defects.map(defautLabel).filter(Boolean),
      IDordre_fabrication: Number(r.IDordre_fabrication) || 0,
      machine_nom: machineByRow.get(Number(r.IDmachine) || 0) || null,
      editable: Number(r.IDsociete) === SOCIETE_TRM,
    }
  }).sort((a, b) => pieceCollator.compare(a.numero, b.numero))
}

// ── Aggregates ───────────────────────────────────────────

/** Piece count + Σ poids per expedition, via ligne_expedition → stock_ecru
 *  (IDligne_expedition_TRM). Deliberately NOT filtered on IDsociete: once ETM
 *  receives a shipment its pieces belong to société 1, and dropping them would
 *  make every delivered avis read "0 pièces". */
async function pieceAggregates(expIds: number[]): Promise<Map<number, { nb: number; poids: number }>> {
  const out = new Map<number, { nb: number; poids: number }>()
  const ids = Array.from(new Set(expIds.filter((x) => x > 0)))
  if (ids.length === 0) return out
  const leRows = await query<{ IDligne_expedition: number; IDexpedition: number }>(
    `SELECT IDligne_expedition, IDexpedition FROM ligne_expedition WHERE IDexpedition IN (${ids.join(',')})`,
  )
  const expByLine = new Map<number, number>()
  for (const r of leRows) expByLine.set(Number(r.IDligne_expedition), Number(r.IDexpedition))
  const lineIds = [...expByLine.keys()].filter((x) => x > 0)
  if (lineIds.length === 0) return out
  const pieces = await query<{ le: number; poids: number | null }>(
    `SELECT IDligne_expedition_TRM AS le, poids FROM stock_ecru WHERE IDligne_expedition_TRM IN (${lineIds.join(',')})`,
  )
  for (const p of pieces) {
    const exp = expByLine.get(Number(p.le)) ?? 0
    if (exp === 0) continue
    const acc = out.get(exp) ?? { nb: 0, poids: 0 }
    acc.nb += 1
    acc.poids += Number(p.poids) || 0
    out.set(exp, acc)
  }
  return out
}

/** Delivery-address label per expedition — the legacy list's "Livraison"
 *  column, which is the address `nom` (often a different site than the client). */
async function resolveAdresseNames(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const u = Array.from(new Set(ids.filter((x) => x > 0)))
  if (u.length === 0) return out
  const rows = await query<{ IDadresse: number; nom: string | null }>(
    `SELECT IDadresse, nom FROM adresse WHERE IDadresse IN (${u.join(',')})`,
  )
  for (const r of await fixEncoding(rows, 'adresse', 'IDadresse', ['nom'])) {
    out.set(Number(r.IDadresse), (r.nom ?? '').toString().trim())
  }
  return out
}

/** Write lock — identical rule and identical linkage to ETM (`ligne_facture`
 *  → this expedition's `ligne_expedition` rows), so the resolver is reused. */
async function isLocked(id: number): Promise<boolean> {
  const rows = await query<{ est_facture: number | null }>(
    `SELECT est_facture FROM expedition WHERE IDexpedition = ${id} AND IDsociete = ${SOCIETE_TRM}`,
  )
  if (rows.length === 0) return false
  if (Number(rows[0].est_facture) === 1) return true
  return (await attachedFactures('formelle', id)).length > 0
}

async function expeditionExists(id: number): Promise<boolean> {
  const rows = await query<{ IDexpedition: number }>(
    `SELECT IDexpedition FROM expedition WHERE IDexpedition = ${id} AND IDsociete = ${SOCIETE_TRM}`,
  )
  return rows.length > 0
}

// ════════════════════════════════════════════════════════
//  LOOKUPS  (literal paths — register before /:id)
// ════════════════════════════════════════════════════════

expeditionsTrmRouter.get('/lookups/transporteurs', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDtransporteur: number; nom: string | null }>(
      `SELECT IDtransporteur, nom FROM transporteur WHERE est_visible = 1 ORDER BY nom`,
    )
    const fixed = await fixEncoding(rows, 'transporteur', 'IDtransporteur', ['nom'])
    res.json(fixed.map((r) => ({ IDtransporteur: Number(r.IDtransporteur), nom: (r.nom ?? '').toString() })))
  } catch (err) {
    console.error('Error fetching TRM transporteurs lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** TRM client orders for the create picker. `IDcommande_ETM` is NOT excluded
 *  here (unlike ETM's own lookup): a TRM order mirroring an ETM
 *  commande_sous_traitant is the NORMAL case — that mirror is exactly what TRM
 *  knits and ships back. Optional ?client= narrows the list. */
expeditionsTrmRouter.get('/lookups/commandes', async (req: Request, res: Response) => {
  try {
    const cid = parseInt(String(req.query.client ?? ''), 10)
    const where = [`IDsociete = ${SOCIETE_TRM}`]
    if (!isNaN(cid) && cid > 0) where.push(`IDclient = ${cid}`)
    const rows = await query<{ IDcommande_client: number; numero: number | null; date_commande: string | null; IDclient: number; ref_client: string | null }>(
      `SELECT TOP 300 IDcommande_client, numero, date_commande, IDclient, ref_client FROM commande_client ` +
        `WHERE ${where.join(' AND ')} ORDER BY IDcommande_client DESC`,
    )
    const fixed = await fixEncoding(rows, 'commande_client', 'IDcommande_client', ['ref_client'])
    const names = await resolveClientNames(rows.map((r) => Number(r.IDclient)))
    res.json((fixed as any[]).map((r) => ({
      IDcommande_client: Number(r.IDcommande_client),
      numero: r.numero != null ? Number(r.numero) : null,
      date_commande: r.date_commande ?? null,
      IDclient: Number(r.IDclient) || 0,
      client_nom: names.get(Number(r.IDclient)) ?? '',
      ref_client: (r.ref_client ?? '').toString().replace(/\s+/g, ' ').trim(),
    })))
  } catch (err) {
    console.error('Error fetching TRM commandes lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

expeditionsTrmRouter.get('/lookups/adresses', async (req: Request, res: Response) => {
  try {
    const cid = parseInt(String(req.query.client ?? ''), 10)
    if (isNaN(cid)) { res.status(400).json({ error: 'client query parameter required' }); return }
    const rows = await query(
      `SELECT IDadresse, nom, adresse1, adresse2, adresse3, cp, ville, pays,
              est_defaut, est_defaut_facturation, est_defaut_livraison
       FROM adresse
       WHERE IDclient = ${cid} AND (est_visible IS NULL OR est_visible = 1)
       ORDER BY est_defaut_livraison DESC, est_defaut DESC, IDadresse`,
    )
    res.json(await fixEncoding(rows, 'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays']))
  } catch (err) {
    console.error('Error fetching TRM adresses lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

expeditionsTrmRouter.get('/lookups/contacts', async (req: Request, res: Response) => {
  try {
    const cid = parseInt(String(req.query.client ?? ''), 10)
    if (isNaN(cid)) { res.status(400).json({ error: 'client query parameter required' }); return }
    const rows = await query<{ IDcontact: number; nom: string | null; prenom: string | null; mail: string | null; est_visible: number | null }>(
      `SELECT IDcontact, nom, prenom, mail, est_visible FROM contact WHERE IDclient = ${cid}`,
    )
    const fixed = await fixEncoding(rows, 'contact', 'IDcontact', ['nom', 'prenom', 'mail'])
    res.json(
      (fixed as any[])
        .filter((c) => c.est_visible !== 0)
        .map((c) => ({
          IDcontact: Number(c.IDcontact),
          nom: [c.prenom, c.nom].map((s: string | null) => (s ?? '').toString().trim()).filter((s: string) => s).join(' ') || `Contact #${Number(c.IDcontact)}`,
          mail: (c.mail ?? '').toString(),
        })),
    )
  } catch (err) {
    console.error('Error fetching TRM contacts lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  LIST  (?q=&state=&limit=&before=)
// ════════════════════════════════════════════════════════

expeditionsTrmRouter.get('/', async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q ?? '').trim()
    const state = String(req.query.state ?? 'all') // 'all' | 'facture' | 'nonfacture'
    const limitRaw = parseInt(String(req.query.limit ?? ''), 10)
    const limit = isNaN(limitRaw) ? 200 : Math.min(Math.max(limitRaw, 1), 500)
    const fetchCap = q ? 800 : limit

    // Cursor pagination (load more): only ids strictly below `before`. Ignored while searching.
    const beforeRaw = parseInt(String(req.query.before ?? ''), 10)
    const beforeId = !q && !isNaN(beforeRaw) && beforeRaw > 0 ? beforeRaw : null

    // HFSQL keeps unset flags at 0 (or NULL) — never trust IS NULL alone.
    const stateSql = state === 'nonfacture'
      ? ' AND (est_facture IS NULL OR est_facture = 0)'
      : state === 'facture' ? ' AND est_facture = 1' : ''
    const beforeSql = beforeId !== null ? ` AND IDexpedition < ${beforeId}` : ''

    const heads = await query<any>(
      `SELECT TOP ${fetchCap} IDexpedition, IDcommande_client, IDadresse, IDtransporteur, DATE AS dexp, est_facture, donation ` +
        `FROM expedition WHERE IDsociete = ${SOCIETE_TRM}${stateSql}${beforeSql} ORDER BY IDexpedition DESC`,
    )

    const cmdIds = heads.map((h: any) => Number(h.IDcommande_client)).filter(Boolean)
    const cmdRows = cmdIds.length
      ? await query<{ IDcommande_client: number; numero: number | null; IDclient: number }>(
          `SELECT IDcommande_client, numero, IDclient FROM commande_client WHERE IDcommande_client IN (${Array.from(new Set(cmdIds)).join(',')})`,
        )
      : []
    const cmdMap = new Map(cmdRows.map((c) => [Number(c.IDcommande_client), {
      numero: c.numero != null ? Number(c.numero) : null,
      IDclient: Number(c.IDclient) || 0,
    }]))
    const [clientNames, transNames, adresseNames, aggs] = await Promise.all([
      resolveClientNames(cmdRows.map((c) => Number(c.IDclient))),
      resolveTransporteurNames(heads.map((h: any) => Number(h.IDtransporteur))),
      resolveAdresseNames(heads.map((h: any) => Number(h.IDadresse))),
      pieceAggregates(heads.map((h: any) => Number(h.IDexpedition))),
    ])

    let result = heads.map((h: any) => {
      const id = Number(h.IDexpedition)
      const cmd = cmdMap.get(Number(h.IDcommande_client)) ?? { numero: null, IDclient: 0 }
      const agg = aggs.get(id) ?? { nb: 0, poids: 0 }
      return {
        id,
        IDcommande_client: Number(h.IDcommande_client) || 0,
        commande_numero: cmd.numero,
        IDclient: cmd.IDclient,
        client_nom: clientNames.get(cmd.IDclient) ?? '',
        IDadresse: Number(h.IDadresse) || 0,
        livraison_nom: adresseNames.get(Number(h.IDadresse)) ?? '',
        transporteur_nom: transNames.get(Number(h.IDtransporteur)) ?? '',
        date: h.dexp ?? null,
        est_facture: Number(h.est_facture) || 0,
        donation: Number(h.donation) || 0,
        nb_pieces: agg.nb,
        total_poids: agg.poids,
      }
    })

    if (q) {
      const nq = norm(q)
      result = result.filter((r: any) =>
        String(r.id).includes(q)
        || (r.commande_numero != null && String(r.commande_numero).includes(q))
        || norm(r.client_nom).includes(nq)
        || norm(r.livraison_nom).includes(nq),
      )
    }
    res.json(result.slice(0, limit))
  } catch (err) {
    console.error('Error fetching TRM expeditions:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  DETAIL
// ════════════════════════════════════════════════════════

/** Per-line piece aggregates + free-stock counts for one expedition.
 *  - `leByLcc` — the ligne_expedition linking this expedition to each order line
 *    (created lazily on the first piece assigned).
 *  - `expAgg` — pieces already on this expedition, per order line.
 *  - `dispoCount` — TRM-owned pieces reserved to the line and not yet shipped. */
async function lignePieceInfo(expId: number, lccIds: number[]): Promise<{
  leByLcc: Map<number, number>
  expAgg: Map<number, { nb: number; poids: number }>
  dispoCount: Map<number, number>
}> {
  const leByLcc = new Map<number, number>()
  const expAgg = new Map<number, { nb: number; poids: number }>()
  const dispoCount = new Map<number, number>()
  const ids = lccIds.filter((x) => x > 0)
  if (ids.length === 0) return { leByLcc, expAgg, dispoCount }

  const leRows = await query<{ IDligne_expedition: number; IDligne_commande_client: number }>(
    `SELECT IDligne_expedition, IDligne_commande_client FROM ligne_expedition WHERE IDexpedition = ${expId}`,
  )
  const lccByLe = new Map<number, number>()
  for (const r of leRows) {
    leByLcc.set(Number(r.IDligne_commande_client), Number(r.IDligne_expedition))
    lccByLe.set(Number(r.IDligne_expedition), Number(r.IDligne_commande_client))
  }
  const leIds = leRows.map((r) => Number(r.IDligne_expedition)).filter((x) => x > 0)
  if (leIds.length > 0) {
    const rows = await query<{ le: number; poids: number | null }>(
      `SELECT IDligne_expedition_TRM AS le, poids FROM stock_ecru WHERE IDligne_expedition_TRM IN (${leIds.join(',')})`,
    )
    for (const r of rows) {
      const lcc = lccByLe.get(Number(r.le)) ?? 0
      if (lcc === 0) continue
      const acc = expAgg.get(lcc) ?? { nb: 0, poids: 0 }
      acc.nb += 1
      acc.poids += Number(r.poids) || 0
      expAgg.set(lcc, acc)
    }
  }

  // Free stock: TRM's own pieces reserved to the line via IDLigne_Commande_TRM.
  const dispo = await query<{ IDLigne_Commande_TRM: number }>(
    `SELECT IDLigne_Commande_TRM FROM stock_ecru
      WHERE IDsociete = ${SOCIETE_TRM} AND IDLigne_Commande_TRM IN (${ids.join(',')})
        AND (IDligne_expedition_TRM IS NULL OR IDligne_expedition_TRM = 0)`,
  )
  for (const r of dispo) {
    const lcc = Number(r.IDLigne_Commande_TRM) || 0
    if (lcc === 0) continue
    dispoCount.set(lcc, (dispoCount.get(lcc) ?? 0) + 1)
  }
  return { leByLcc, expAgg, dispoCount }
}

/** ref_ecru + colori_ecru labels for a set of order lines. Every TRM line is
 *  écru (type 1), so there is no fini/divers branch to resolve. */
async function resolveEcruLineLabels(lignes: Array<{ IDreference: number; IDcolori: number }>): Promise<{
  refs: Map<number, { reference: string; designation: string }>
  coloris: Map<number, string>
}> {
  const refs = new Map<number, { reference: string; designation: string }>()
  const refIds = Array.from(new Set(lignes.map((l) => l.IDreference).filter((x) => x > 0)))
  if (refIds.length > 0) {
    const rows = await query<any>(
      `SELECT IDref_ecru, reference, designation FROM ref_ecru WHERE IDref_ecru IN (${refIds.join(',')})`,
    )
    for (const r of await fixEncoding(rows, 'ref_ecru', 'IDref_ecru', ['reference', 'designation'])) {
      refs.set(Number((r as any).IDref_ecru), {
        reference: ((r as any).reference ?? '').toString().trim(),
        designation: ((r as any).designation ?? '').toString().trim(),
      })
    }
  }
  const coloris = await resolveEcruColoris(lignes.map((l) => l.IDcolori))
  return { refs, coloris }
}

expeditionsTrmRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const rows = await query<any>(
      `SELECT ${EXP_COLS} FROM expedition WHERE IDexpedition = ${id} AND IDsociete = ${SOCIETE_TRM}`,
    )
    if (rows.length === 0) { res.status(404).json({ error: 'Expédition not found' }); return }
    const h = rows[0]
    const cmdId = Number(h.IDcommande_client) || 0

    const cmdRows = cmdId > 0
      ? await query<any>(
          `SELECT IDcommande_client, numero, IDclient, ref_client FROM commande_client WHERE IDcommande_client = ${cmdId}`,
        )
      : []
    const cmd = (await fixEncoding(cmdRows, 'commande_client', 'IDcommande_client', ['ref_client']))[0] as any
    const IDclient = Number(cmd?.IDclient) || 0

    const [clientNames, transNames, adr, contactNom, factures, lignesRaw] = await Promise.all([
      resolveClientNames([IDclient]),
      resolveTransporteurNames([Number(h.IDtransporteur)]),
      loadAdresse(Number(h.IDadresse) || 0),
      loadContactName(Number(h.IDcontact) || 0),
      attachedFactures('formelle', id),
      cmdId > 0
        ? query<any>(
            `SELECT IDligne_commande_client, TYPE AS type_kind, IDreference, IDcolori, quantite, unite, IDdesignation_client ` +
              `FROM ligne_commande_client WHERE IDcommande_client = ${cmdId} ORDER BY IDligne_commande_client`,
          )
        : Promise.resolve([]),
    ])

    const lignesArr = lignesRaw as any[]
    const { refs, coloris } = await resolveEcruLineLabels(lignesArr.map((l) => ({
      IDreference: Number(l.IDreference) || 0,
      IDcolori: Number(l.IDcolori) || 0,
    })))
    const { leByLcc, expAgg, dispoCount } = await lignePieceInfo(
      id, lignesArr.map((l) => Number(l.IDligne_commande_client) || 0),
    )

    const lignes = lignesArr.map((l) => {
      const lcc = Number(l.IDligne_commande_client) || 0
      const ref = refs.get(Number(l.IDreference) || 0)
      const agg = expAgg.get(lcc) ?? { nb: 0, poids: 0 }
      return {
        IDligne_commande_client: lcc,
        IDligne_expedition: leByLcc.get(lcc) ?? 0,
        type: Number(l.type_kind) || 0,
        ref_label: ref?.reference || null,
        ref_designation: ref?.designation || null,
        colori_reference: coloris.get(Number(l.IDcolori) || 0) || null,
        quantite: Number(l.quantite) || 0,
        unite: Number(l.unite) || 0,
        unite_label: uniteLabel(l.unite),
        dim: lineDim(l.unite),
        nb_pieces_exp: agg.nb,
        poids_exp: agg.poids,
        nb_pieces_dispo: dispoCount.get(lcc) ?? 0,
      }
    })

    const locked = Number(h.est_facture) === 1 || (factures as FactureRef[]).length > 0
    res.json({
      id,
      IDcommande_client: cmdId,
      commande_numero: cmd?.numero != null ? Number(cmd.numero) : null,
      IDclient,
      client_nom: clientNames.get(IDclient) ?? '',
      // Legacy ref_client can embed CR/LF — collapse so the sidebar row reads flat.
      ref_client: (cmd?.ref_client ?? '').toString().replace(/\s+/g, ' ').trim(),
      date: h.dexp ?? null,
      IDtransporteur: Number(h.IDtransporteur) || 0,
      transporteur_nom: transNames.get(Number(h.IDtransporteur)) ?? '',
      IDadresse: Number(h.IDadresse) || 0,
      adresse_livraison: adr,
      IDcontact: Number(h.IDcontact) || 0,
      contact_nom: contactNom,
      donation: Number(h.donation) || 0,
      affiche_observations: Number(h.affiche_observations) || 0,
      observation_bl: stripRtf(h.observation_bl) || '',
      est_facture: Number(h.est_facture) || 0,
      factures,
      locked,
      lignes,
    })
  } catch (err) {
    console.error('Error fetching TRM expedition detail:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  HEADER CRUD
// ════════════════════════════════════════════════════════

const createBody = z.object({
  IDcommande_client: z.number().int().positive(),
  date: z.string().optional(),
  IDtransporteur: z.number().int().nonnegative().optional(),
  IDadresse: z.number().int().nonnegative().optional(),
})

expeditionsTrmRouter.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = createBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data
    const date = d.date ? dateStr(d.date) || todayDigits() : todayDigits()

    const cmdRows = await query<{ IDclient: number; IDadresse_livraison: number; donation: number | null }>(
      `SELECT IDclient, IDadresse_livraison, donation FROM commande_client ` +
        `WHERE IDcommande_client = ${n(d.IDcommande_client)} AND IDsociete = ${SOCIETE_TRM}`,
    )
    if (cmdRows.length === 0) { res.status(400).json({ error: 'Commande introuvable' }); return }
    const IDclient = Number(cmdRows[0].IDclient) || 0
    // Auto-fill: delivery address from the order, carrier from the client.
    const clientRows = await query<{ IDtransporteur: number }>(
      `SELECT IDtransporteur FROM client WHERE IDclient = ${IDclient}`,
    )
    const idAdresse = d.IDadresse ?? (Number(cmdRows[0].IDadresse_livraison) || 0)
    const idTrans = d.IDtransporteur ?? (Number(clientRows[0]?.IDtransporteur) || 0)
    const donation = Number(cmdRows[0].donation) === 1 ? 1 : 0

    // `envoyé_client` / `envoyé_sst` are deliberately omitted (accented) — HFSQL
    // zero-fills them. `inclureRapportQualite` is an ETM-only flag: TRM's
    // visitage data rides in the Défauts column of the avis itself.
    const before = await maxId('expedition', 'IDexpedition')
    await query(
      `INSERT INTO expedition (IDsociete, IDcommande_client, IDadresse, IDtransporteur, IDcontact, DATE, donation, affiche_observations, est_valide, est_facture) ` +
        `VALUES (${SOCIETE_TRM}, ${n(d.IDcommande_client)}, ${n(idAdresse)}, ${n(idTrans)}, 0, '${date}', ${donation}, 1, 0, 0)`,
    )
    const newId = await newIdAfterInsert('expedition', 'IDexpedition', before)
    res.status(201).json({ id: newId })
  } catch (err) {
    console.error('Error creating TRM expedition:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const updateBody = z.object({
  date: z.string().optional(),
  IDtransporteur: z.number().int().nonnegative().optional(),
  IDadresse: z.number().int().nonnegative().optional(),
  IDcontact: z.number().int().nonnegative().optional(),
  affiche_observations: z.number().int().min(0).max(1).optional(),
  observation_bl: z.string().optional(),
})

expeditionsTrmRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await expeditionExists(id))) { res.status(404).json({ error: 'Expédition not found' }); return }
    if (await isLocked(id)) { res.status(409).json(FACTURE_LOCK); return }

    const parsed = updateBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data
    const sets: string[] = []
    if (d.date !== undefined) sets.push(`DATE = '${dateStr(d.date)}'`)
    if (d.IDtransporteur !== undefined) sets.push(`IDtransporteur = ${n(d.IDtransporteur)}`)
    if (d.IDadresse !== undefined) sets.push(`IDadresse = ${n(d.IDadresse)}`)
    if (d.IDcontact !== undefined) sets.push(`IDcontact = ${n(d.IDcontact)}`)
    if (d.affiche_observations !== undefined) sets.push(`affiche_observations = ${d.affiche_observations ? 1 : 0}`)
    if (d.observation_bl !== undefined) sets.push(`observation_bl = ${sqlText(wrapRtf(d.observation_bl))}`)
    if (sets.length === 0) { res.status(400).json({ error: 'No fields to update' }); return }
    await query(`UPDATE expedition SET ${sets.join(', ')} WHERE IDexpedition = ${id} AND IDsociete = ${SOCIETE_TRM}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating TRM expedition:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

expeditionsTrmRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await expeditionExists(id))) { res.status(404).json({ error: 'Expédition not found' }); return }
    if (await isLocked(id)) { res.status(409).json(FACTURE_LOCK); return }

    const leRows = await query<{ IDligne_expedition: number }>(
      `SELECT IDligne_expedition FROM ligne_expedition WHERE IDexpedition = ${id}`,
    )
    const leIds = leRows.map((r) => Number(r.IDligne_expedition)).filter((x) => x > 0)
    if (leIds.length > 0) {
      // A piece ETM has already received (IDsociete flipped to 1) must keep its
      // provenance stamp — releasing it would orphan ETM's reception. Refuse the
      // delete instead of half-doing it.
      const handedOver = await query<{ nb: number }>(
        `SELECT COUNT(*) AS nb FROM stock_ecru
          WHERE IDligne_expedition_TRM IN (${leIds.join(',')}) AND IDsociete <> ${SOCIETE_TRM}`,
      )
      if (Number(handedOver[0]?.nb) > 0) {
        res.status(409).json({
          error: 'expedition_receptionnee',
          message: 'Expédition déjà réceptionnée par le client — non supprimable.',
        })
        return
      }
      await query(
        `UPDATE stock_ecru SET IDligne_expedition_TRM = 0 ` +
          `WHERE IDligne_expedition_TRM IN (${leIds.join(',')}) AND IDsociete = ${SOCIETE_TRM}`,
      )
    }
    await query(`DELETE FROM ligne_expedition WHERE IDexpedition = ${id}`)
    await query(`DELETE FROM expedition WHERE IDexpedition = ${id} AND IDsociete = ${SOCIETE_TRM}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting TRM expedition:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  PIECE PICKING per commande line
// ════════════════════════════════════════════════════════

interface LineCtx { lcc: number; type: number; refId: number; quantite: number; unite: number }

async function loadLineCtx(lccId: number): Promise<LineCtx | null> {
  const rows = await query<any>(
    `SELECT IDligne_commande_client, TYPE AS type_kind, IDreference, quantite, unite ` +
      `FROM ligne_commande_client WHERE IDligne_commande_client = ${lccId}`,
  )
  if (rows.length === 0) return null
  const r = rows[0]
  return {
    lcc: lccId,
    type: Number(r.type_kind) || 0,
    refId: Number(r.IDreference) || 0,
    quantite: Number(r.quantite) || 0,
    unite: Number(r.unite) || 0,
  }
}

/** Resolve the ligne_expedition id linking (expId, lccId), 0 if none. */
async function findLigneExpedition(expId: number, lccId: number): Promise<number> {
  const rows = await query<{ IDligne_expedition: number }>(
    `SELECT TOP 1 IDligne_expedition FROM ligne_expedition ` +
      `WHERE IDexpedition = ${expId} AND IDligne_commande_client = ${lccId} ORDER BY IDligne_expedition DESC`,
  )
  return Number(rows[0]?.IDligne_expedition) || 0
}

async function buildPiecePayload(expId: number, ctx: LineCtx) {
  const leId = await findLigneExpedition(expId, ctx.lcc)
  const [onRaw, dispoRaw] = await Promise.all([
    leId > 0
      ? query<any>(`SELECT ${PIECE_SELECT} ${PIECE_JOINS} WHERE se.IDligne_expedition_TRM = ${leId}`)
      : Promise.resolve([]),
    query<any>(
      `SELECT ${PIECE_SELECT} ${PIECE_JOINS} ` +
        `WHERE se.IDsociete = ${SOCIETE_TRM} AND se.IDLigne_Commande_TRM = ${ctx.lcc} ` +
        `AND (se.IDligne_expedition_TRM IS NULL OR se.IDligne_expedition_TRM = 0)`,
    ),
  ])
  const [onExp, dispo] = await Promise.all([hydratePieces(onRaw), hydratePieces(dispoRaw)])
  return {
    unite_label: uniteLabel(ctx.unite),
    target_qty: ctx.quantite,
    onExp,
    dispo,
  }
}

expeditionsTrmRouter.get('/:id/lignes/:lccId/pieces', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const lccId = parseInt(req.params.lccId, 10)
    if (isNaN(id) || isNaN(lccId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const ctx = await loadLineCtx(lccId)
    if (!ctx) { res.status(404).json({ error: 'Ligne introuvable' }); return }
    res.json(await buildPiecePayload(id, ctx))
  } catch (err) {
    console.error('Error fetching TRM expedition pieces:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** Assign a piece to the expedition: create the ligne_expedition lazily on the
 *  first piece of the line, then stamp `stock_ecru.IDligne_expedition_TRM`. */
expeditionsTrmRouter.put('/:id/lignes/:lccId/pieces/:stockId', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const lccId = parseInt(req.params.lccId, 10)
    const stockId = parseInt(req.params.stockId, 10)
    if (isNaN(id) || isNaN(lccId) || isNaN(stockId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await expeditionExists(id))) { res.status(404).json({ error: 'Expédition not found' }); return }
    if (await isLocked(id)) { res.status(409).json(FACTURE_LOCK); return }
    const ctx = await loadLineCtx(lccId)
    if (!ctx) { res.status(404).json({ error: 'Ligne introuvable' }); return }

    // The piece must be TRM's own, reserved to this order line, and free.
    const pieceRows = await query<{ IDstock_ecru: number; IDligne_expedition_TRM: number; IDLigne_Commande_TRM: number }>(
      `SELECT IDstock_ecru, IDligne_expedition_TRM, IDLigne_Commande_TRM FROM stock_ecru ` +
        `WHERE IDstock_ecru = ${stockId} AND IDsociete = ${SOCIETE_TRM}`,
    )
    if (pieceRows.length === 0) { res.status(404).json({ error: 'Pièce introuvable' }); return }
    if (Number(pieceRows[0].IDligne_expedition_TRM) > 0) {
      res.status(409).json({ error: 'piece_deja_expediee', message: 'Cette pièce est déjà sur une expédition.' })
      return
    }
    if (Number(pieceRows[0].IDLigne_Commande_TRM) !== lccId) {
      res.status(409).json({ error: 'piece_autre_ligne', message: "Cette pièce n'est pas affectée à cette ligne de commande." })
      return
    }

    let leId = await findLigneExpedition(id, lccId)
    if (leId === 0) {
      const before = await maxId('ligne_expedition', 'IDligne_expedition')
      await query(
        `INSERT INTO ligne_expedition (IDexpedition, IDligne_commande_client, est_facture) ` +
          `VALUES (${id}, ${lccId}, 0)`,
      )
      leId = await newIdAfterInsert('ligne_expedition', 'IDligne_expedition', before)
      if (leId === 0) { res.status(500).json({ error: 'ligne_expedition_insert_failed' }); return }
    }
    await query(
      `UPDATE stock_ecru SET IDligne_expedition_TRM = ${leId} ` +
        `WHERE IDstock_ecru = ${stockId} AND IDsociete = ${SOCIETE_TRM}`,
    )
    res.json(await buildPiecePayload(id, ctx))
  } catch (err) {
    console.error('Error assigning TRM expedition piece:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** Unassign a piece; drop the now-empty ligne_expedition so the line falls back
 *  to "candidate" (same lazy-line semantics as ETM). */
expeditionsTrmRouter.delete('/:id/lignes/:lccId/pieces/:stockId', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const lccId = parseInt(req.params.lccId, 10)
    const stockId = parseInt(req.params.stockId, 10)
    if (isNaN(id) || isNaN(lccId) || isNaN(stockId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await expeditionExists(id))) { res.status(404).json({ error: 'Expédition not found' }); return }
    if (await isLocked(id)) { res.status(409).json(FACTURE_LOCK); return }
    const ctx = await loadLineCtx(lccId)
    if (!ctx) { res.status(404).json({ error: 'Ligne introuvable' }); return }

    const leId = await findLigneExpedition(id, lccId)
    if (leId === 0) { res.json(await buildPiecePayload(id, ctx)); return }

    const pieceRows = await query<{ IDsociete: number }>(
      `SELECT IDsociete FROM stock_ecru WHERE IDstock_ecru = ${stockId} AND IDligne_expedition_TRM = ${leId}`,
    )
    if (pieceRows.length === 0) { res.status(404).json({ error: 'Pièce introuvable sur cette expédition' }); return }
    if (Number(pieceRows[0].IDsociete) !== SOCIETE_TRM) {
      res.status(409).json({
        error: 'piece_receptionnee',
        message: 'Pièce déjà réceptionnée par le client — elle ne peut plus être retirée de l\'expédition.',
      })
      return
    }

    await query(`UPDATE stock_ecru SET IDligne_expedition_TRM = 0 WHERE IDstock_ecru = ${stockId}`)
    const remaining = await query<{ nb: number }>(
      `SELECT COUNT(*) AS nb FROM stock_ecru WHERE IDligne_expedition_TRM = ${leId}`,
    )
    if (Number(remaining[0]?.nb) === 0) {
      await query(`DELETE FROM ligne_expedition WHERE IDligne_expedition = ${leId}`)
    }
    res.json(await buildPiecePayload(id, ctx))
  } catch (err) {
    console.error('Error unassigning TRM expedition piece:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  AVIS D'EXPÉDITION PDF  (legacy ETAT_Expédition_TRM)
// ════════════════════════════════════════════════════════

/** Yarn lots behind an ordre_fabrication, as the report's two lot labels:
 *  "Lots Malterre" = `stock_fil.lot`, "Lots Fournisseur" = `stock_fil.lot_frs`.
 *  A lot knitted from two yarns lists both, joined with " / ", like legacy.
 *  `stock_fil` must never be read with `SELECT *` nor with `certif_bio` in the
 *  column list — both silently return zero rows on the Windows driver. */
async function resolveOfYarnLots(ofIds: number[]): Promise<Map<number, { malterre: string; fournisseur: string }>> {
  const out = new Map<number, { malterre: string; fournisseur: string }>()
  const ids = Array.from(new Set(ofIds.filter((x) => x > 0)))
  if (ids.length === 0) return out
  const asso = await query<{ IDordre_fabrication: number; IDstock_fil: number }>(
    `SELECT IDordre_fabrication, IDstock_fil FROM asso_fil_of WHERE IDordre_fabrication IN (${ids.join(',')})`,
  )
  const stockIds = Array.from(new Set(asso.map((a) => Number(a.IDstock_fil)).filter((x) => x > 0)))
  const lotByStock = new Map<number, { lot: string; lot_frs: string }>()
  if (stockIds.length > 0) {
    const rows = await query<any>(
      `SELECT IDstock_fil, lot, lot_frs FROM stock_fil WHERE IDstock_fil IN (${stockIds.join(',')})`,
    )
    for (const r of await fixEncoding(rows, 'stock_fil', 'IDstock_fil', ['lot', 'lot_frs'])) {
      lotByStock.set(Number((r as any).IDstock_fil), {
        lot: ((r as any).lot ?? '').toString().trim(),
        lot_frs: ((r as any).lot_frs ?? '').toString().trim(),
      })
    }
  }
  for (const ofId of ids) {
    const mine = asso.filter((a) => Number(a.IDordre_fabrication) === ofId)
    const malterre: string[] = []
    const fournisseur: string[] = []
    for (const a of mine) {
      const l = lotByStock.get(Number(a.IDstock_fil))
      if (!l) continue
      if (l.lot && !malterre.includes(l.lot)) malterre.push(l.lot)
      if (l.lot_frs && !fournisseur.includes(l.lot_frs)) fournisseur.push(l.lot_frs)
    }
    out.set(ofId, { malterre: malterre.join(' / '), fournisseur: fournisseur.join(' / ') })
  }
  return out
}

/** Group an article's pieces the way the legacy report does: one block per
 *  ordre_fabrication. Every piece of an OF came off the same métier and was
 *  knitted from the same yarn lots, which is exactly the block header
 *  ("Métier: 1F  Lots Malterre: 10556  Lots Fournisseur: …"). Grouping on
 *  `stock_ecru.lot` — what the ETM avis does — is not an option here: that
 *  column is empty on every TRM row. */
function groupPiecesByOf(
  pieces: TrmPiece[],
  yarnLots: Map<number, { malterre: string; fournisseur: string }>,
): BlLot[] {
  const byOf = new Map<number, TrmPiece[]>()
  for (const p of pieces) {
    const arr = byOf.get(p.IDordre_fabrication) ?? []
    arr.push(p)
    byOf.set(p.IDordre_fabrication, arr)
  }
  return Array.from(byOf, ([ofId, list]) => {
    const lots = yarnLots.get(ofId) ?? { malterre: '', fournisseur: '' }
    const blPieces: BlPiece[] = list
      .slice()
      .sort((a, b) => pieceCollator.compare(a.numero, b.numero))
      .map((p) => ({
        numero: p.numero,
        poids: p.poids,
        metrage: 0,
        observations: p.observations || null,
        defauts: p.defauts,
      }))
    return {
      lot: lots.malterre,
      lotsFournisseur: lots.fournisseur || null,
      metier: list.find((p) => p.machine_nom)?.machine_nom ?? null,
      pieces: blPieces,
    }
  })
}

export async function buildBlTrmPdfData(id: number): Promise<BonLivraisonPdfData | null> {
  const rows = await query<any>(
    `SELECT IDexpedition, IDcommande_client, IDadresse, IDtransporteur, IDcontact, DATE AS dexp, ` +
      `affiche_observations, donation, observation_bl ` +
      `FROM expedition WHERE IDexpedition = ${id} AND IDsociete = ${SOCIETE_TRM}`,
  )
  if (rows.length === 0) return null
  const h = rows[0]
  const cmdId = Number(h.IDcommande_client) || 0

  const cmdRows = cmdId > 0
    ? await query<any>(`SELECT IDcommande_client, numero, IDclient, ref_client FROM commande_client WHERE IDcommande_client = ${cmdId}`)
    : []
  const cmd = (await fixEncoding(cmdRows, 'commande_client', 'IDcommande_client', ['ref_client']))[0] as any
  const IDclient = Number(cmd?.IDclient) || 0

  const [clientNames, transNames, adr, contactNom, leRows] = await Promise.all([
    resolveClientNames([IDclient]),
    resolveTransporteurNames([Number(h.IDtransporteur)]),
    loadAdresse(Number(h.IDadresse) || 0),
    loadContactName(Number(h.IDcontact) || 0),
    query<any>(
      `SELECT IDligne_expedition, IDligne_commande_client FROM ligne_expedition ` +
        `WHERE IDexpedition = ${id} ORDER BY IDligne_expedition`,
    ),
  ])

  const articles: BlArticle[] = []
  for (const le of leRows as any[]) {
    const leId = Number(le.IDligne_expedition) || 0
    const lccId = Number(le.IDligne_commande_client) || 0
    if (leId === 0 || lccId === 0) continue
    const lccRows = await query<any>(
      `SELECT IDligne_commande_client, IDdesignation_client, IDreference, IDcolori ` +
        `FROM ligne_commande_client WHERE IDligne_commande_client = ${lccId}`,
    )
    if (lccRows.length === 0) continue
    const lcc = lccRows[0]

    // Client-side article reference → "V/réf. : ech42".
    let refClientArticle: string | null = null
    const desigId = Number(lcc.IDdesignation_client) || 0
    if (desigId > 0) {
      const dcRows = await query<any>(
        `SELECT IDdesignation_client, designation FROM designation_client WHERE IDdesignation_client = ${desigId}`,
      )
      const dc = (await fixEncoding(dcRows, 'designation_client', 'IDdesignation_client', ['designation']))[0] as any
      refClientArticle = (dc?.designation ?? '').toString().trim() || null
    }

    const { refs, coloris } = await resolveEcruLineLabels([
      { IDreference: Number(lcc.IDreference) || 0, IDcolori: Number(lcc.IDcolori) || 0 },
    ])
    const ref = refs.get(Number(lcc.IDreference) || 0)
    const reference = ref?.reference ?? ''
    const designation = ref?.designation ?? ''
    const colorisLabel = coloris.get(Number(lcc.IDcolori) || 0) ?? ''

    const pieceRaw = await query<any>(
      `SELECT ${PIECE_SELECT} ${PIECE_JOINS} WHERE se.IDligne_expedition_TRM = ${leId}`,
    )
    const pieces = await hydratePieces(pieceRaw)
    if (pieces.length === 0) continue
    const yarnLots = await resolveOfYarnLots(pieces.map((p) => p.IDordre_fabrication))
    const lots = groupPiecesByOf(pieces, yarnLots)

    articles.push({
      titre: [reference, colorisLabel].filter(Boolean).join(' ') || `Ligne ${lccId}`,
      sousTitre: designation || null,
      finition: null,
      refClientArticle,
      lots,
    })
  }

  const a = adr as any
  return {
    numero: id,
    dateLong: formatHfsqlDateLongFr(h.dexp),
    clientNom: clientNames.get(IDclient) ?? '',
    refClient: (cmd?.ref_client ?? '').toString().replace(/\s+/g, ' ').trim() || null,
    commandeNumero: cmd?.numero != null ? Number(cmd.numero) : null,
    transporteurNom: transNames.get(Number(h.IDtransporteur)) || null,
    contactNom,
    donation: Number(h.donation) === 1,
    showObservations: Number(h.affiche_observations) === 1,
    observationBl: stripRtf(h.observation_bl) || null,
    adresseLivraison: a
      ? {
          nom: (a.nom ?? null) as string | null,
          adresse1: (a.adresse1 ?? null) as string | null,
          adresse2: (a.adresse2 ?? null) as string | null,
          adresse3: (a.adresse3 ?? null) as string | null,
          cp: (a.cp ?? null) as string | null,
          ville: (a.ville ?? null) as string | null,
          pays: (a.pays ?? null) as string | null,
        }
      : null,
    articles,
    variant: 'trm',
  }
}

async function renderBlTrmPdfBuffer(data: BonLivraisonPdfData): Promise<Buffer> {
  return renderToBuffer(
    React.createElement(BonLivraisonPdf, { data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >,
  )
}

expeditionsTrmRouter.get('/:id/pdf', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const data = await buildBlTrmPdfData(id)
    if (!data) { res.status(404).json({ error: 'Expédition not found' }); return }
    const buffer = await renderBlTrmPdfBuffer(data)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="BL-TRM-${id}.pdf"`)
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buffer)
  } catch (err) {
    console.error('Error rendering TRM expedition PDF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  EMAIL
// ════════════════════════════════════════════════════════

const SENDER_LABEL = 'Tricotage Malterre'

expeditionsTrmRouter.get('/:id/email-defaults', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const rows = await query<{ IDcommande_client: number }>(
      `SELECT IDcommande_client FROM expedition WHERE IDexpedition = ${id} AND IDsociete = ${SOCIETE_TRM}`,
    )
    if (rows.length === 0) { res.status(404).json({ error: 'Expédition not found' }); return }
    const cmdId = Number(rows[0].IDcommande_client) || 0
    const cmdRows = cmdId > 0
      ? await query<{ IDclient: number }>(`SELECT IDclient FROM commande_client WHERE IDcommande_client = ${cmdId}`)
      : []
    const IDclient = Number(cmdRows[0]?.IDclient) || 0

    const [clientNames, contactRows] = await Promise.all([
      resolveClientNames([IDclient]),
      IDclient > 0
        ? query<{ IDcontact: number; nom: string | null; prenom: string | null; mail: string | null; envoi_bl: number | null; est_visible: number | null }>(
            `SELECT IDcontact, nom, prenom, mail, envoi_bl, est_visible FROM contact WHERE IDclient = ${IDclient}`,
          )
        : Promise.resolve([]),
    ])
    const fixedContacts = await fixEncoding(contactRows, 'contact', 'IDcontact', ['nom', 'prenom', 'mail'])

    const selected: EmailRecipientPayload[] = []
    const suggestions: EmailRecipientPayload[] = []
    const seen = new Set<string>()
    for (const c of fixedContacts as any[]) {
      if (c.est_visible === 0) continue
      const raw = (c.mail ?? '').toString().trim()
      if (!raw || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) continue
      const key = raw.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const displayName = [c.prenom, c.nom]
        .map((s: string | null) => (s ?? '').toString().trim())
        .filter((s: string) => s.length > 0).join(' ')
      const recipient: EmailRecipientPayload = { email: raw, source: 'contact', contactId: Number(c.IDcontact) }
      if (displayName) recipient.name = displayName
      if (c.envoi_bl === 1) selected.push(recipient)
      else suggestions.push(recipient)
    }

    res.json({
      recipients: { selected, suggestions },
      subject: `Avis d'expédition N°${id} - ${SENDER_LABEL}`,
      body:
        `Bonjour,\n\n` +
        `Veuillez trouver ci-joint notre avis d'expédition N°${id}.\n\n` +
        `Nous restons à votre disposition pour toute information complémentaire.\n\n` +
        `Cordialement,\n` +
        SENDER_LABEL,
      clientNom: clientNames.get(IDclient) ?? '',
      // No Cci: TRM ships from its own workshop, so there is no sous-traitant
      // magasin to notify (the ETM avis copies the holding warehouse in).
      bcc: [],
      optional_attachments: [],
    })
  } catch (err) {
    console.error('Error building TRM expedition email defaults:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const extraAttachmentSchema = z.object({
  filename: z.string().min(1).max(255),
  content_base64: z.string().min(1),
  content_type: z.string().min(1).max(100),
})
const emailBody = z.object({
  to: z.array(z.string().email()).min(1, 'At least one recipient is required'),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(20000),
  attach_pdf: z.boolean().optional(),
  extra_attachments: z.array(extraAttachmentSchema).optional(),
  dev_skip_send: z.boolean().optional(),
})
const ALLOW_DEV_SKIP_SEND = process.env.NODE_ENV !== 'production'

expeditionsTrmRouter.post('/:id/email', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    const parsed = emailBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const devSkip = parsed.data.dev_skip_send === true && ALLOW_DEV_SKIP_SEND

    let messageId: string
    if (devSkip) {
      messageId = `dev-skip-${Date.now()}`
      console.log(`[dev-skip-send] expedition TRM #${id} — fake send to ${parsed.data.to.join(', ')}`)
    } else {
      const senderEmail = await getUserEmail(req.userId)
      if (!senderEmail) {
        res.status(400).json({
          error: 'no_sender_email',
          message: "Aucune adresse email n'est associée à votre compte. Un administrateur doit en définir une dans Paramètres › Utilisateurs.",
        })
        return
      }
      const userRows = await query<{ prenom: string | null; nom: string | null }>(
        `SELECT prenom, nom FROM utilisateur WHERE IDutilisateur = ${req.userId}`,
      )
      const u = (await fixEncoding(userRows, 'utilisateur', 'IDutilisateur', ['prenom', 'nom']))[0] as any
      const displayName = u
        ? [u.prenom, u.nom].filter((s: string | null) => s && s.trim()).map((s: string) => s.trim()).join(' ')
        : ''
      const fromName = displayName ? `${displayName} - ${SENDER_LABEL}` : SENDER_LABEL

      const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = []
      if (parsed.data.attach_pdf !== false) {
        const data = await buildBlTrmPdfData(id)
        if (!data) { res.status(404).json({ error: 'Expédition not found' }); return }
        attachments.push({
          filename: `BL-TRM-${id}.pdf`,
          content: await renderBlTrmPdfBuffer(data),
          contentType: 'application/pdf',
        })
      }
      for (const a of parsed.data.extra_attachments ?? []) {
        attachments.push({ filename: a.filename, content: Buffer.from(a.content_base64, 'base64'), contentType: a.content_type })
      }
      messageId = await sendMail({
        from: senderEmail, fromName, to: parsed.data.to, cc: parsed.data.cc, bcc: parsed.data.bcc,
        subject: parsed.data.subject, body: parsed.data.body,
        attachments: attachments.length > 0 ? attachments : undefined,
      })
    }

    const allRecipients = [...parsed.data.to, ...(parsed.data.cc ?? []), ...(parsed.data.bcc ?? [])]
    let societe = ''
    try {
      const er = await query<{ IDcommande_client: number }>(
        `SELECT IDcommande_client FROM expedition WHERE IDexpedition = ${id} AND IDsociete = ${SOCIETE_TRM}`,
      )
      const cr = Number(er[0]?.IDcommande_client) > 0
        ? await query<{ IDclient: number }>(`SELECT IDclient FROM commande_client WHERE IDcommande_client = ${Number(er[0].IDcommande_client)}`)
        : []
      const names = await resolveClientNames([Number(cr[0]?.IDclient) || 0])
      societe = names.get(Number(cr[0]?.IDclient) || 0) ?? ''
    } catch { /* informational */ }
    await logEnvoiEmails(id, allRecipients, societe, TYPE_DOC_AVIS_EXPEDITION, 'BL TRM')

    res.json({ ok: true, messageId })
  } catch (err) {
    console.error('Error sending TRM expedition email:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    res.status(500).json({ error: 'send_failed', message })
  }
})
