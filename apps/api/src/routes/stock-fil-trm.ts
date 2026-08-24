import { Router, type Request, type Response, type Router as RouterType } from 'express'
import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { query, queryB64Text, fixEncoding } from '../lib/hfsql-auto.js'
import { IS_WINDOWS } from '../lib/sst-shared.js'
import {
  sqlText,
  numOf,
  intOf,
  floatOf,
  todayDigits,
  dateDigitsOnly,
  requirePermission,
} from '../lib/clients-common.js'
import { pickVal, normalizeStockRow, loadRefFilRecycleMap } from './stock.js'
import { repairAliased } from './stock-fini.js'
import { fetchDefectsByEcru, type DefautQualite } from './stock-ecru.js'
import { StockFilLabelPdf, type StockFilLabelData } from '../lib/pdf/StockFilLabelPdf.js'
import { RapportFreintePdf, type RapportFreinteData } from '../lib/pdf/RapportFreintePdf.js'

export const stockFilTrmRouter: RouterType = Router()

// ── Why this is a separate route file from stock.ts ─────────────────────
// `stock_fil` is NOT partitioned (no IDsociete): the legacy TRM screen
// (FI_Stock_Fil_TRM.wdw) and ETM's Fournisseurs › Stock (FI_Stock_Fil.wdw)
// read the same ~1.7k rows — the yarn physically sits at Tricotage Malterre
// and `IDclient` names its owner (TRM knits à façon; Ets Malterre is TRM's
// biggest client). But the two screens are different FLAVORS of the ledger:
// the TRM one adds the Client column, the Disponible/Archivé filter, and the
// lifecycle actions (nouveau lot with client + auto lot number, division,
// contrôle de titrage, archivage with the freinte/second-choix bilan). Those
// endpoints live here, scoped for the TRM web app; ETM's simpler list/detail
// in stock.ts stays untouched.
//
// Everything platform-tricky is inherited from stock.ts (see the long comment
// there): Linux bridge can't tokenize accented identifiers (terminé, controlé,
// certif_recyclé) anywhere → `sf.*` + prefix-resolved keys; Windows driver
// can name them but returns zero rows for `alias.*` in a JOIN — and for ANY
// select naming a memo-binary column (certif_bio/certif_recyclé), which is why
// blob presence is probed via LENGTH() on Windows and via SELECT * on Linux.
// All writes go through sqlText() (Latin-1 hex literals), never raw UTF-8.

type Row = Record<string, unknown>

// Same SELECT as stock.ts plus sf.IDclient (the Windows list there omits it —
// ETM's screen has no Client column).
const TRM_SELECT = IS_WINDOWS
  ? `sf.IDstock_fil, sf.IDclient, sf.IDfournisseur, sf.IDref_fil, sf.IDcolori_fil, sf.IDref_fil_commande, sf.IDMagasin, sf.stock, sf.stock_initial, sf.lot, sf.lot_frs, sf.emplacement, sf.date_entree, sf.dernier_mouvement, sf.dernier_pointage, sf.niveau, sf.terminé AS termine, sf.controlé AS controle, sf.commentaire, sf.observation_freinte, rf.reference AS ref_fil, rf.titrage, rf.bio, rf.recyclé AS recycle, cf.reference AS colori_reference, f.nom AS fournisseur_nom, st.nom AS magasin_nom`
  : `sf.*, rf.reference AS ref_fil, rf.titrage, rf.bio, cf.reference AS colori_reference, f.nom AS fournisseur_nom, st.nom AS magasin_nom`

const TRM_JOINS = `FROM stock_fil sf LEFT JOIN ref_fil rf ON sf.IDref_fil = rf.IDref_fil LEFT JOIN colori_fil cf ON sf.IDcolori_fil = cf.IDcolori_fil LEFT JOIN fournisseur f ON sf.IDfournisseur = f.IDfournisseur LEFT JOIN sous_traitant st ON sf.IDMagasin = st.IDsous_traitant`

/** Encoding repair + accent-key normalisation shared by list and detail. */
async function hydrateRows(rows: Row[]): Promise<Row[]> {
  let fixed: Row[] = await fixEncoding(
    rows,
    'stock_fil',
    'IDstock_fil',
    ['lot', 'lot_frs', 'emplacement', 'commentaire', 'observation_freinte'],
  )
  fixed = await repairAliased(fixed, 'ref_fil', 'IDref_fil', { ref_fil: 'reference' })
  fixed = await repairAliased(fixed, 'colori_fil', 'IDcolori_fil', { colori_reference: 'reference' })
  fixed = await repairAliased(fixed, 'fournisseur', 'IDfournisseur', { fournisseur_nom: 'nom' })

  const recycleMap = await loadRefFilRecycleMap()
  const normalised = fixed.map((r) => normalizeStockRow(r, recycleMap))

  // Client column — flat lookup, never a JOIN + CONVERT (collapses the result
  // set on the bridge). `client.nom` is accented on several rows.
  const clientIds = Array.from(
    new Set(normalised.map((r) => numOf(r.IDclient)).filter((x) => x > 0)),
  )
  const clientName = new Map<number, string>()
  if (clientIds.length > 0) {
    const cRows = await query<{ IDclient: number; nom: string | null }>(
      `SELECT IDclient, nom FROM client WHERE IDclient IN (${clientIds.join(',')})`,
    )
    for (const c of await fixEncoding(cRows as Row[], 'client', 'IDclient', ['nom'])) {
      clientName.set(numOf((c as Row).IDclient), String((c as Row).nom ?? '').trim())
    }
  }
  for (const r of normalised) {
    r.client_nom = clientName.get(numOf(r.IDclient)) ?? null
  }
  return normalised
}

/** One hydrated row by id, or null. */
async function fetchRow(id: number): Promise<Row | null> {
  const rows = await query<Row>(`SELECT ${TRM_SELECT} ${TRM_JOINS} WHERE sf.IDstock_fil = ${id}`)
  if (rows.length === 0) return null
  const hydrated = await hydrateRows(rows)
  return hydrated[0] ?? null
}

/** Next internal lot number: MAX over the numeric lots + 1, computed in JS
 *  (all 1 747 lots are numeric strings; a SQL MAX(lot) would be lexicographic
 *  and CAST support on the bridge is unverified). */
async function nextLotNumber(): Promise<number> {
  const rows = await query<{ lot: string | null }>(`SELECT lot FROM stock_fil`)
  let max = 0
  for (const r of rows) {
    const n = parseInt(String(r.lot ?? ''), 10)
    if (Number.isFinite(n) && n > max) max = n
  }
  return max + 1
}

/** Certif blob presence, platform-split (see header comment). Returns byte
 *  lengths (0 = empty). */
async function certifLengths(id: number): Promise<{ bio: number; recycle: number }> {
  if (IS_WINDOWS) {
    const rows = await query<{ lb: number; lr: number }>(
      `SELECT LENGTH(certif_bio) AS lb, LENGTH(certif_recyclé) AS lr FROM stock_fil WHERE IDstock_fil = ${id}`,
    )
    return { bio: numOf(rows[0]?.lb), recycle: numOf(rows[0]?.lr) }
  }
  const rows = await query<Row>(`SELECT * FROM stock_fil WHERE IDstock_fil = ${id}`)
  if (rows.length === 0) return { bio: 0, recycle: 0 }
  const sizeOf = (v: unknown): number => {
    if (v == null || v === '' || v === '\x00') return 0
    if (Buffer.isBuffer(v)) return v.length === 1 && v[0] === 0 ? 0 : v.length
    if (v instanceof ArrayBuffer) return v.byteLength
    return String(v).length
  }
  return { bio: sizeOf(rows[0].certif_bio), recycle: sizeOf(pickVal(rows[0], /^certif_recycl/i)) }
}

// Physical text columns of stock_fil (dates are 8-char digit strings — safe
// through sqlText). Everything else is numeric; the two certif columns are
// blobs, re-emitted empty (guarded by certifLengths before the reinsert).
const STOCK_FIL_TEXT_COLS = /^(lot|lot_frs|emplacement|date_entree|dernier_mouvement|dernier_pointage|commentaire|observation_freinte)$/i
const STOCK_FIL_BLOB_COLS = /^certif/i

/** Set stock_fil.terminé. Windows: named UPDATE (accented identifiers work).
 *  Linux: the bridge rejects accented identifiers in SET, so — setClientFlag
 *  pattern (lib/clients-common.ts) — read the row via SELECT * (queryB64Text
 *  keeps accented VALUES lossless), flip the flag slot, then delete +
 *  positional reinsert preserving the PK. Caller must have verified both
 *  certif blobs are empty (they are on every row today — probed 2026-08) and
 *  must run its plain-column UPDATEs FIRST (this re-reads the row). */
async function setStockFilTermine(id: number, value: 0 | 1): Promise<boolean> {
  if (IS_WINDOWS) {
    const exists = await query<{ IDstock_fil: number }>(
      `SELECT IDstock_fil FROM stock_fil WHERE IDstock_fil = ${id}`,
    )
    if (exists.length === 0) return false
    await query(`UPDATE stock_fil SET terminé = ${value} WHERE IDstock_fil = ${id}`)
    return true
  }
  const rows = await queryB64Text<Row>(`SELECT * FROM stock_fil WHERE IDstock_fil = ${id}`)
  if (rows.length === 0) return false
  const keys = Object.keys(rows[0])
  const vals = Object.values(rows[0])
  const idx = keys.findIndex((k) => /^termin/i.test(k))
  if (idx === -1) throw new Error('stock_fil.terminé column not found — refusing positional reinsert')
  vals[idx] = value
  const literals = vals.map((v, i) => {
    const key = keys[i]
    if (STOCK_FIL_BLOB_COLS.test(key)) return "''"
    if (STOCK_FIL_TEXT_COLS.test(key)) {
      if (v == null) return "''"
      const s = v instanceof ArrayBuffer ? Buffer.from(v).toString('latin1') : String(v)
      return sqlText(s)
    }
    const n = Number(v)
    return Number.isFinite(n) ? String(n) : '0'
  })
  await query(`DELETE FROM stock_fil WHERE IDstock_fil = ${id}`)
  await query(`INSERT INTO stock_fil VALUES (${literals.join(', ')})`)
  return true
}

/** Read the terminé flag of one row (0/1), or null when the row is missing. */
async function readTermine(id: number): Promise<0 | 1 | null> {
  if (IS_WINDOWS) {
    const exists = await query<{ IDstock_fil: number }>(
      `SELECT IDstock_fil FROM stock_fil WHERE IDstock_fil = ${id}`,
    )
    if (exists.length === 0) return null
    const hit = await query<{ IDstock_fil: number }>(
      `SELECT IDstock_fil FROM stock_fil WHERE IDstock_fil = ${id} AND terminé = 1`,
    )
    return hit.length > 0 ? 1 : 0
  }
  const rows = await query<Row>(`SELECT * FROM stock_fil WHERE IDstock_fil = ${id}`)
  if (rows.length === 0) return null
  return Number(pickVal(rows[0], /^termin/i)) ? 1 : 0
}

// ── Bilan (archive preview) ─────────────────────────────

interface BilanOf {
  of: number
  ref_ecru: string
  pourcentage: number
  premier_choix: number
  second_choix: number
}

interface Bilan {
  ofs: BilanOf[]
  /** Weighted yarn consumption: Σ over OFs [Σ(pieces poids) × pourcentage/100].
   *  The weighting is load-bearing on blended yarns — verified against the
   *  legacy annotations (e.g. the "90kg de freinte négative" lot). */
  produit: number
  poids_total: number
  poids_second: number
  second_choix_pct: number | null
  defauts: Array<{ label: string; nombre: number }>
}

function defautLabel(d: DefautQualite): string {
  const type = (d.type_defaut ?? '').toString().trim()
  const size = d.taille_cm != null && Number(d.taille_cm) > 0 ? `${Number(d.taille_cm)} cm` : ''
  return [type, size].filter(Boolean).join(' ') || (d.description ?? '').toString().trim() || 'Défaut'
}

async function computeBilan(id: number): Promise<Bilan> {
  const assos = await query<{ IDordre_fabrication: number; pourcentage: number | null }>(
    `SELECT IDordre_fabrication, pourcentage FROM asso_fil_of WHERE IDstock_fil = ${id}`,
  )
  const ofIds = Array.from(
    new Set(assos.map((a) => numOf(a.IDordre_fabrication)).filter((x) => x > 0)),
  )

  const refEcruByOf = new Map<number, number>()
  if (ofIds.length > 0) {
    const ofRows = await query<{ IDordre_fabrication: number; IDref_ecru: number }>(
      `SELECT IDordre_fabrication, IDref_ecru FROM ordre_fabrication WHERE IDordre_fabrication IN (${ofIds.join(',')})`,
    )
    for (const o of ofRows) refEcruByOf.set(numOf(o.IDordre_fabrication), numOf(o.IDref_ecru))
  }
  const refEcruIds = Array.from(new Set(Array.from(refEcruByOf.values()).filter((x) => x > 0)))
  const refEcruLabel = new Map<number, string>()
  if (refEcruIds.length > 0) {
    const reRows = await query<{ IDref_ecru: number; reference: string | null }>(
      `SELECT IDref_ecru, reference FROM ref_ecru WHERE IDref_ecru IN (${refEcruIds.join(',')})`,
    )
    for (const r of await fixEncoding(reRows as Row[], 'ref_ecru', 'IDref_ecru', ['reference'])) {
      refEcruLabel.set(numOf((r as Row).IDref_ecru), String((r as Row).reference ?? '').trim())
    }
  }

  // All pieces of those OFs, one batched query.
  const pieces = ofIds.length
    ? await query<{ IDstock_ecru: number; IDordre_fabrication: number; poids: number | null; second_choix: number | null }>(
        `SELECT IDstock_ecru, IDordre_fabrication, poids, second_choix FROM stock_ecru WHERE IDordre_fabrication IN (${ofIds.join(',')})`,
      )
    : []
  const byOf = new Map<number, { premier: number; second: number }>()
  for (const p of pieces) {
    const ofId = numOf(p.IDordre_fabrication)
    const cur = byOf.get(ofId) ?? { premier: 0, second: 0 }
    const w = floatOf(p.poids)
    if (numOf(p.second_choix) === 1) cur.second += w
    else cur.premier += w
    byOf.set(ofId, cur)
  }

  const ofs: BilanOf[] = []
  let produit = 0
  for (const a of assos) {
    const ofId = numOf(a.IDordre_fabrication)
    const sums = byOf.get(ofId) ?? { premier: 0, second: 0 }
    const pct = floatOf(a.pourcentage)
    ofs.push({
      of: ofId,
      ref_ecru: refEcruLabel.get(refEcruByOf.get(ofId) ?? 0) ?? '',
      pourcentage: pct,
      premier_choix: sums.premier,
      second_choix: sums.second,
    })
    produit += ((sums.premier + sums.second) * pct) / 100
  }

  const poidsTotal = ofs.reduce((s, o) => s + o.premier_choix + o.second_choix, 0)
  const poidsSecond = ofs.reduce((s, o) => s + o.second_choix, 0)

  // Visitage defects on the pieces (polymorphic defaut_qualite, Type_Reference
  // 2 = stock_ecru), grouped by label with their occurrence counts.
  const defectsByEcru = await fetchDefectsByEcru(pieces.map((p) => numOf(p.IDstock_ecru)))
  const grouped = new Map<string, number>()
  for (const defects of defectsByEcru.values()) {
    for (const d of defects) {
      const label = defautLabel(d)
      const count = d.nombre != null && Number(d.nombre) > 0 ? Number(d.nombre) : 1
      grouped.set(label, (grouped.get(label) ?? 0) + count)
    }
  }
  const defauts = Array.from(grouped.entries())
    .map(([label, nombre]) => ({ label, nombre }))
    .sort((a, b) => b.nombre - a.nombre)

  return {
    ofs,
    produit,
    poids_total: poidsTotal,
    poids_second: poidsSecond,
    second_choix_pct: poidsTotal > 0 ? (poidsSecond / poidsTotal) * 100 : null,
    defauts,
  }
}

// ── Date formatting for the PDFs ────────────────────────

const MOIS_FR = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
]

function formatDateFrLong(ymd: string): string {
  const s = String(ymd ?? '').replace(/[^0-9]/g, '')
  if (s.length !== 8) return ''
  const month = MOIS_FR[parseInt(s.slice(4, 6), 10) - 1] ?? ''
  return `${parseInt(s.slice(6, 8), 10)} ${month} ${s.slice(0, 4)}`
}

// ── Routes ──────────────────────────────────────────────

// GET /api/stock/fil-trm/lookups/clients — the Client combo (owner of the
// yarn). Société-2 clients, non-archived rows only would need the accented
// `archivé` flag — the legacy dialog lists them all, so keep it simple.
// MUST be declared before '/fil-trm/:id'.
stockFilTrmRouter.get('/fil-trm/lookups/clients', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDclient: number; nom: string | null }>(
      `SELECT IDclient, nom FROM client WHERE IDsociete = 2 ORDER BY nom`,
    )
    const fixed = await fixEncoding(rows as Row[], 'client', 'IDclient', ['nom'])
    res.json(
      (fixed as Row[]).map((r) => ({ IDclient: numOf(r.IDclient), nom: String(r.nom ?? '').trim() })),
    )
  } catch (err) {
    console.error('Error fetching TRM clients lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/stock/fil-trm?etat=disponible|archive|tous — the TRM list.
// The terminé filter is applied in JS (accented column — see header comment).
stockFilTrmRouter.get('/fil-trm', async (req: Request, res: Response) => {
  try {
    const etat =
      req.query.etat === 'archive' ? 'archive' : req.query.etat === 'tous' ? 'tous' : 'disponible'

    const rows = await query<Row>(
      `SELECT ${TRM_SELECT} ${TRM_JOINS} ORDER BY sf.date_entree DESC, sf.IDstock_fil DESC`,
    )
    let normalised = await hydrateRows(rows)
    if (etat !== 'tous') {
      normalised = normalised.filter((r) =>
        etat === 'archive' ? numOf(r.termine) === 1 : numOf(r.termine) !== 1,
      )
    }
    res.json(normalised)
  } catch (err) {
    console.error('Error fetching TRM stock_fil list:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/stock/fil-trm/:id — detail: row + titrage reference block +
// contrôle history + commande N° + certif flags.
stockFilTrmRouter.get('/fil-trm/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const row = await fetchRow(id)
    if (!row) { res.status(404).json({ error: 'Stock fil not found' }); return }

    // Titrage de référence (ref_fil) + unit label. ASCII column names only.
    let titrage_ref: { titrage: number; nb_fil: number; nb_brin: number; unite: string } | null = null
    const refFilId = numOf(row.IDref_fil)
    if (refFilId > 0) {
      const rf = await query<{ titrage: number | null; nb_fil: number | null; nb_brin: number | null; IDunite_titrage: number | null }>(
        `SELECT titrage, nb_fil, nb_brin, IDunite_titrage FROM ref_fil WHERE IDref_fil = ${refFilId}`,
      )
      if (rf.length > 0) {
        const uniteId = numOf(rf[0].IDunite_titrage)
        let unite = ''
        if (uniteId > 0) {
          const u = await query<{ nomenclature: string | null }>(
            `SELECT nomenclature FROM unite_titrage WHERE IDunite_titrage = ${uniteId}`,
          )
          unite = String(u[0]?.nomenclature ?? '').trim()
        }
        titrage_ref = {
          titrage: floatOf(rf[0].titrage),
          nb_fil: numOf(rf[0].nb_fil),
          nb_brin: numOf(rf[0].nb_brin),
          unite,
        }
      }
    }

    // Contrôles de titrage history (1-N). `date` is a reserved word — SELECT *
    // returns it uppercased (DATE); resolve by exact-name prefix.
    const ctlRows = await query<Row>(
      `SELECT * FROM controle_titrage WHERE IDstock_fil = ${id}`,
    )
    const controles = ctlRows
      .map((r) => ({
        IDcontrole_titrage: numOf(r.IDcontrole_titrage),
        date: String(pickVal(r, /^date$/i) ?? '').replace(/[^0-9]/g, '').slice(0, 8),
        titrage: floatOf(r.titrage),
        nb_fil: numOf(r.nb_fil),
        nb_brin: numOf(r.nb_brin),
        IDunite_titrage: numOf(r.IDunite_titrage),
      }))
      .sort((a, b) => b.IDcontrole_titrage - a.IDcontrole_titrage)

    // Real commande N°: stock_fil.IDref_fil_commande is the order LINE PK.
    let IDcommande_fil = 0
    const lineId = numOf(row.IDref_fil_commande)
    if (lineId > 0) {
      const cmdRows = await query<{ IDcommande_fil: number }>(
        `SELECT IDcommande_fil FROM ref_fil_commande WHERE IDref_fil_commande = ${lineId}`,
      )
      IDcommande_fil = numOf(cmdRows[0]?.IDcommande_fil)
    }

    const certifs = await certifLengths(id)

    res.json({
      ...row,
      IDcommande_fil,
      has_certif_bio: certifs.bio > 1,
      has_certif_recycle: certifs.recycle > 1,
      titrage_ref,
      controles,
    })
  } catch (err) {
    console.error('Error fetching TRM stock_fil detail:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/stock/fil-trm — create a lot, legacy FEN_Gestion_lot_fil mapping:
// stock = stock_initial, lot auto max+1, dernier_mouvement = date_entree,
// dernier_pointage defaults to date_entree, IDMagasin = 1 (Tricotage
// Malterre), terminé = controlé = 0 (Windows-only column list; HFSQL defaults
// them to 0 on the Linux path).
stockFilTrmRouter.post('/fil-trm', async (req: Request, res: Response) => {
  if (!(await requirePermission(req, res, 'create_stock_fil'))) return
  try {
    const body = req.body ?? {}
    const IDclient = intOf(body.IDclient)
    const IDfournisseur = intOf(body.IDfournisseur)
    const IDref_fil = intOf(body.IDref_fil)
    const IDcolori_fil = intOf(body.IDcolori_fil)
    const stock_initial = floatOf(body.stock_initial)

    if (IDclient <= 0 || IDfournisseur <= 0 || IDref_fil <= 0 || IDcolori_fil <= 0) {
      res.status(400).json({ error: 'IDclient, IDfournisseur, IDref_fil and IDcolori_fil are required' })
      return
    }
    if (!(stock_initial > 0)) {
      res.status(400).json({ error: 'stock_initial must be a positive number' })
      return
    }

    const lot_frs = typeof body.lot_frs === 'string' ? body.lot_frs : ''
    const emplacement = typeof body.emplacement === 'string' ? body.emplacement : ''
    const commentaire = typeof body.commentaire === 'string' ? body.commentaire : ''
    const niveau = Math.min(3, Math.max(0, intOf(body.niveau)))
    const date_entree = dateDigitsOnly(body.date_entree) || todayDigits()
    const dernier_pointage = dateDigitsOnly(body.dernier_pointage) || date_entree

    // lot is a UNIQUE key — retry the max+1 allocation on a concurrent insert.
    let newId = 0
    let lot = 0
    let lastErr: unknown = null
    for (let attempt = 0; attempt < 3; attempt++) {
      lot = await nextLotNumber()
      const cols =
        `IDclient, IDfournisseur, IDref_fil, IDcolori_fil, stock, stock_initial, lot, lot_frs, ` +
        `emplacement, niveau, date_entree, dernier_mouvement, dernier_pointage, commentaire, ` +
        `IDMagasin, IDref_fil_commande` + (IS_WINDOWS ? ', terminé, controlé' : '')
      const vals =
        `${IDclient}, ${IDfournisseur}, ${IDref_fil}, ${IDcolori_fil}, ${stock_initial}, ${stock_initial}, ` +
        `'${lot}', ${sqlText(lot_frs)}, ${sqlText(emplacement)}, ${niveau}, '${date_entree}', ` +
        `'${date_entree}', '${dernier_pointage}', ${sqlText(commentaire)}, 1, 0` +
        (IS_WINDOWS ? ', 0, 0' : '')
      try {
        await query(`INSERT INTO stock_fil (${cols}) VALUES (${vals})`)
        const created = await query<{ IDstock_fil: number }>(
          `SELECT IDstock_fil FROM stock_fil WHERE lot = '${lot}'`,
        )
        newId = numOf(created[0]?.IDstock_fil)
        if (newId > 0) break
      } catch (e) {
        lastErr = e
      }
    }
    if (newId <= 0) {
      console.error('Error creating TRM stock_fil after retries:', lastErr)
      res.status(500).json({ error: 'Internal server error' })
      return
    }

    res.status(201).json({ IDstock_fil: newId, lot: String(lot) })
  } catch (err) {
    console.error('Error creating TRM stock_fil:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PATCH /api/stock/fil-trm/:id — light edit. Whitelist: emplacement, niveau,
// commentaire, lot_frs, dernier_pointage, IDclient. Archived lots refuse.
// stock / stock_initial / dernier_mouvement / terminé / controlé are NEVER
// writable here — the production flow and the Archivage own them (controlé is
// a dead pre-2023 flag, do not resurrect it).
stockFilTrmRouter.patch('/fil-trm/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const termine = await readTermine(id)
    if (termine === null) { res.status(404).json({ error: 'Stock fil not found' }); return }
    if (termine === 1) { res.status(409).json({ error: 'lot_archive' }); return }

    const body = req.body ?? {}
    const sets: string[] = []
    if (typeof body.emplacement === 'string') sets.push(`emplacement = ${sqlText(body.emplacement)}`)
    if (typeof body.commentaire === 'string') sets.push(`commentaire = ${sqlText(body.commentaire)}`)
    if (typeof body.lot_frs === 'string') sets.push(`lot_frs = ${sqlText(body.lot_frs)}`)
    if (body.niveau !== undefined) sets.push(`niveau = ${Math.min(3, Math.max(0, intOf(body.niveau)))}`)
    if (body.IDclient !== undefined) {
      const cid = intOf(body.IDclient)
      if (cid <= 0) { res.status(400).json({ error: 'IDclient must be a positive id' }); return }
      sets.push(`IDclient = ${cid}`)
    }
    if (typeof body.dernier_pointage === 'string') {
      const d = dateDigitsOnly(body.dernier_pointage)
      sets.push(d ? `dernier_pointage = '${d}'` : `dernier_pointage = NULL`)
    }

    if (sets.length === 0) {
      res.status(400).json({ error: 'No editable fields provided' })
      return
    }
    await query(`UPDATE stock_fil SET ${sets.join(', ')} WHERE IDstock_fil = ${id}`)

    const row = await fetchRow(id)
    res.json(row)
  } catch (err) {
    console.error('Error updating TRM stock_fil:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/stock/fil-trm/:id/diviser — split a lot (FEN_Diviser_Lot).
// Body { stock_initial: X }. New row copies the identity fields, gets the next
// lot number, stock = stock_initial = X; the source loses X on both columns.
// No ledger row exists for this in the legacy schema.
stockFilTrmRouter.post('/fil-trm/:id/diviser', async (req: Request, res: Response) => {
  if (!(await requirePermission(req, res, 'create_stock_fil'))) return
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const source = await fetchRow(id)
    if (!source) { res.status(404).json({ error: 'Stock fil not found' }); return }
    if (numOf(source.termine) === 1) { res.status(409).json({ error: 'lot_archive' }); return }

    const x = floatOf((req.body ?? {}).stock_initial)
    const srcInitial = floatOf(source.stock_initial)
    const srcStock = floatOf(source.stock)
    if (!(x > 0) || x >= srcInitial) {
      res.status(400).json({ error: 'stock_initial must be > 0 and < the source stock initial' })
      return
    }

    let newId = 0
    let lot = 0
    let lastErr: unknown = null
    for (let attempt = 0; attempt < 3; attempt++) {
      lot = await nextLotNumber()
      const cols =
        `IDclient, IDfournisseur, IDref_fil, IDcolori_fil, stock, stock_initial, lot, lot_frs, ` +
        `emplacement, niveau, date_entree, dernier_mouvement, dernier_pointage, commentaire, ` +
        `IDMagasin, IDref_fil_commande` + (IS_WINDOWS ? ', terminé, controlé' : '')
      const vals =
        `${numOf(source.IDclient)}, ${numOf(source.IDfournisseur)}, ${numOf(source.IDref_fil)}, ` +
        `${numOf(source.IDcolori_fil)}, ${x}, ${x}, '${lot}', ${sqlText(String(source.lot_frs ?? ''))}, ` +
        `${sqlText(String(source.emplacement ?? ''))}, ${numOf(source.niveau)}, ` +
        `'${dateDigitsOnly(source.date_entree) || todayDigits()}', ` +
        `'${dateDigitsOnly(source.dernier_mouvement) || dateDigitsOnly(source.date_entree) || todayDigits()}', ` +
        `'${dateDigitsOnly(source.dernier_pointage) || dateDigitsOnly(source.date_entree) || todayDigits()}', ` +
        `${sqlText(String(source.commentaire ?? ''))}, ${numOf(source.IDMagasin)}, ${numOf(source.IDref_fil_commande)}` +
        (IS_WINDOWS ? ', 0, 0' : '')
      try {
        await query(`INSERT INTO stock_fil (${cols}) VALUES (${vals})`)
        const created = await query<{ IDstock_fil: number }>(
          `SELECT IDstock_fil FROM stock_fil WHERE lot = '${lot}'`,
        )
        newId = numOf(created[0]?.IDstock_fil)
        if (newId > 0) break
      } catch (e) {
        lastErr = e
      }
    }
    if (newId <= 0) {
      console.error('Error splitting TRM stock_fil after retries:', lastErr)
      res.status(500).json({ error: 'Internal server error' })
      return
    }

    await query(
      `UPDATE stock_fil SET stock_initial = ${srcInitial - x}, stock = ${srcStock - x} WHERE IDstock_fil = ${id}`,
    )

    res.status(201).json({ IDstock_fil: newId, lot: String(lot) })
  } catch (err) {
    console.error('Error splitting TRM stock_fil:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/stock/fil-trm/:id/controle-titrage — record a titrage control.
// INSERT into controle_titrage; `date` is a reserved word → positional INSERT
// with a self-assigned max+1 PK (desiderata precedent, planning-atelier.ts).
// Physical column order — verified against SELECT * key order on the live
// rows (the analysis .xdd lists a DIFFERENT logical order; trust the driver):
// IDcontrole_titrage, titrage, nb_fil, nb_brin, IDstock_fil, IDunite_titrage,
// date. Nothing is written back to stock_fil.
stockFilTrmRouter.post('/fil-trm/:id/controle-titrage', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const termine = await readTermine(id)
    if (termine === null) { res.status(404).json({ error: 'Stock fil not found' }); return }

    const body = req.body ?? {}
    const titrage = floatOf(body.titrage)
    const nb_fil = intOf(body.nb_fil)
    const nb_brin = intOf(body.nb_brin)
    const IDunite_titrage = intOf(body.IDunite_titrage)
    if (!(titrage > 0)) { res.status(400).json({ error: 'titrage must be a positive number' }); return }

    const maxRows = await query<{ m: unknown }>(`SELECT MAX(IDcontrole_titrage) AS m FROM controle_titrage`)
    const newId = numOf(maxRows[0]?.m) + 1
    await query(
      `INSERT INTO controle_titrage VALUES (${newId}, ${titrage}, ${nb_fil}, ${nb_brin}, ${id}, ${IDunite_titrage}, '${todayDigits()}')`,
    )
    res.status(201).json({ IDcontrole_titrage: newId })
  } catch (err) {
    console.error('Error creating controle_titrage:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/stock/fil-trm/:id/bilan — the Archivage dialog's data: OF
// consumption, weighted produit, second choix, defects verdict. Also feeds the
// rapport de freinte PDF.
stockFilTrmRouter.get('/fil-trm/:id/bilan', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const row = await fetchRow(id)
    if (!row) { res.status(404).json({ error: 'Stock fil not found' }); return }

    const bilan = await computeBilan(id)
    const stockInitial = floatOf(row.stock_initial)
    const freinteKg = stockInitial - bilan.produit
    res.json({
      IDstock_fil: id,
      lot: row.lot,
      stock_initial: stockInitial,
      stock: floatOf(row.stock),
      observation_freinte: row.observation_freinte ?? '',
      ofs: bilan.ofs,
      produit: bilan.produit,
      freinte_kg: freinteKg,
      freinte_pct: stockInitial > 0 ? (freinteKg / stockInitial) * 100 : null,
      poids_total: bilan.poids_total,
      poids_second: bilan.poids_second,
      second_choix_pct: bilan.second_choix_pct,
      defauts: bilan.defauts,
    })
  } catch (err) {
    console.error('Error computing TRM stock_fil bilan:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/stock/fil-trm/:id/archiver — FEN_Archivage's Archiver: writes the
// (possibly corrected) stock_initial + observation_freinte, forces stock = 0,
// then sets terminé = 1 (platform-split — see setStockFilTermine). Plain
// UPDATE runs FIRST: the Linux flag path re-reads the row it reinserts.
stockFilTrmRouter.post('/fil-trm/:id/archiver', async (req: Request, res: Response) => {
  if (!(await requirePermission(req, res, 'create_stock_fil'))) return
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const termine = await readTermine(id)
    if (termine === null) { res.status(404).json({ error: 'Stock fil not found' }); return }
    if (termine === 1) { res.status(409).json({ error: 'lot_archive' }); return }

    // The Linux flag flip re-emits the certif blob slots empty. Every row holds
    // empty blobs today (probed 2026-08); refuse the rare future exception
    // rather than silently destroying a certificate.
    if (!IS_WINDOWS) {
      const certifs = await certifLengths(id)
      if (certifs.bio > 1 || certifs.recycle > 1) {
        res.status(409).json({ error: 'certificat_bloque' })
        return
      }
    }

    const body = req.body ?? {}
    const stockInitial = floatOf(body.stock_initial)
    if (!(stockInitial >= 0)) {
      res.status(400).json({ error: 'stock_initial must be a positive number' })
      return
    }
    const observation = typeof body.observation_freinte === 'string' ? body.observation_freinte : ''

    await query(
      `UPDATE stock_fil SET stock = 0, stock_initial = ${stockInitial}, observation_freinte = ${sqlText(observation)} WHERE IDstock_fil = ${id}`,
    )
    await setStockFilTermine(id, 1)

    const row = await fetchRow(id)
    res.json(row)
  } catch (err) {
    console.error('Error archiving TRM stock_fil:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PDF response boilerplate: the three header tweaks let the shared
// SendEmailDialog / browser tabs embed the PDF cross-origin in dev.
function sendPdf(res: Response, buffer: Buffer, filename: string): void {
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`)
  res.removeHeader('X-Frame-Options')
  res.removeHeader('Content-Security-Policy')
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  res.send(buffer)
}

// GET /api/stock/fil-trm/:id/label — Dymo 89×36 étiquette. Read-only.
stockFilTrmRouter.get('/fil-trm/:id/label', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const row = await fetchRow(id)
    if (!row) { res.status(404).json({ error: 'Stock fil not found' }); return }

    const data: StockFilLabelData = {
      lot: String(row.lot ?? '').trim(),
      ref_fil: String(row.ref_fil ?? '').trim(),
      colori_reference: String(row.colori_reference ?? '').trim(),
      client_nom: String(row.client_nom ?? '').trim(),
      lot_frs: String(row.lot_frs ?? '').trim(),
      stock_initial: floatOf(row.stock_initial),
      emplacement: String(row.emplacement ?? '').trim(),
      niveau: numOf(row.niveau),
    }
    const buffer = await renderToBuffer(
      React.createElement(StockFilLabelPdf, { data }) as React.ReactElement,
    )
    sendPdf(res, buffer, `etiquette-lot-${data.lot || id}.pdf`)
  } catch (err) {
    console.error('Error rendering stock_fil label:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/stock/fil-trm/:id/rapport-freinte — A4 rapport (Archivage's
// Imprimer). Issued by Tricotage Malterre (companyTrm footer in the PDF).
stockFilTrmRouter.get('/fil-trm/:id/rapport-freinte', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const row = await fetchRow(id)
    if (!row) { res.status(404).json({ error: 'Stock fil not found' }); return }

    const bilan = await computeBilan(id)
    // The dialog can pass the corrected Quantité initiale before it is saved.
    const overrideInitial = req.query.stock_initial != null ? floatOf(req.query.stock_initial) : null
    const stockInitial =
      overrideInitial != null && overrideInitial > 0 ? overrideInitial : floatOf(row.stock_initial)
    const freinteKg = stockInitial - bilan.produit

    const data: RapportFreinteData = {
      lot: String(row.lot ?? '').trim(),
      ref_fil: String(row.ref_fil ?? '').trim(),
      colori_reference: String(row.colori_reference ?? '').trim(),
      client_nom: String(row.client_nom ?? '').trim(),
      fournisseur_nom: String(row.fournisseur_nom ?? '').trim(),
      lot_frs: String(row.lot_frs ?? '').trim(),
      date_entree: formatDateFrLong(dateDigitsOnly(row.date_entree)),
      date_edition: formatDateFrLong(todayDigits()),
      stock_initial: stockInitial,
      ofs: bilan.ofs.map((o) => ({
        of: o.of,
        ref_ecru: o.ref_ecru,
        premier_choix: o.premier_choix,
        second_choix: o.second_choix,
      })),
      produit: bilan.produit,
      freinte_kg: freinteKg,
      freinte_pct: stockInitial > 0 ? (freinteKg / stockInitial) * 100 : null,
      second_choix_pct: bilan.second_choix_pct,
      defauts: bilan.defauts,
      observation_freinte: String(row.observation_freinte ?? '').trim(),
    }
    const buffer = await renderToBuffer(
      React.createElement(RapportFreintePdf, { data }) as React.ReactElement,
    )
    sendPdf(res, buffer, `rapport-freinte-lot-${data.lot || id}.pdf`)
  } catch (err) {
    console.error('Error rendering rapport de freinte:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
