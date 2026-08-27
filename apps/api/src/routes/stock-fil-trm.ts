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
  requirePermission, TRM_PERMISSIONS,
} from '../lib/clients-common.js'
import { pickVal, stripKeys } from './stock.js'
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
type EtatFilter = 'disponible' | 'archive' | 'tous'

// ── Row fetching — shaped by profiling ───────────────────────────────────
// Windows ODBC, 1 747 rows: the joined select of stock.ts costs ~1.4 s. Of
// that, ~0.9 s is the two MEMO columns (`commentaire`, `observation_freinte`
// — stored out-of-row, fetched per row) and ~0.4 s the five LEFT JOINs. The
// same rows without memos and joins come back in ~300 ms; a WHERE on the
// flag in 7 ms; memos for the 120 available lots in ~75 ms. Hence:
//   1. a light select, filtered in SQL where the platform allows;
//   2. memos fetched only for the surviving rows (chunked IN lists);
//   3. labels resolved from cached catalogs, not joins.
// The Linux bridge can neither name nor WHERE the accented flag, so there it
// stays `SELECT *` (memos included) + JS filter — but still without joins and
// without per-request catalog scans.

const LIGHT_COLS_WINDOWS =
  'IDstock_fil, IDclient, IDfournisseur, IDref_fil, IDcolori_fil, IDref_fil_commande, IDMagasin, ' +
  'stock, stock_initial, lot, lot_frs, emplacement, date_entree, dernier_mouvement, dernier_pointage, ' +
  'niveau, terminé AS termine, controlé AS controle'

const MEMO_CHUNK = 300

/** `withObservation`: the list only shows `commentaire`; `observation_freinte`
 *  is drawer-only, and each memo column costs ~0.4 s over the full table — so
 *  the list skips it and the detail fetch (single row) includes it. */
async function fetchBaseRows(etat: EtatFilter, id?: number, withObservation = false): Promise<Row[]> {
  const idWhere = id != null ? `IDstock_fil = ${id}` : ''
  if (IS_WINDOWS) {
    const flagWhere = etat === 'disponible' ? 'terminé = 0' : etat === 'archive' ? 'terminé = 1' : ''
    const where = [idWhere, flagWhere].filter(Boolean).join(' AND ')
    const rows = await query<Row>(
      `SELECT ${LIGHT_COLS_WINDOWS} FROM stock_fil${where ? ` WHERE ${where}` : ''} ORDER BY date_entree DESC, IDstock_fil DESC`,
    )
    const ids = rows.map((r) => numOf(r.IDstock_fil)).filter((x) => x > 0)
    const memoCols = withObservation ? 'commentaire, observation_freinte' : 'commentaire'
    const memos = new Map<number, Row>()
    for (let i = 0; i < ids.length; i += MEMO_CHUNK) {
      const chunk = ids.slice(i, i + MEMO_CHUNK)
      const m = await query<Row>(
        `SELECT IDstock_fil, ${memoCols} FROM stock_fil WHERE IDstock_fil IN (${chunk.join(',')})`,
      )
      for (const r of m) memos.set(numOf(r.IDstock_fil), r)
    }
    for (const r of rows) {
      const m = memos.get(numOf(r.IDstock_fil))
      r.commentaire = m?.commentaire ?? null
      r.observation_freinte = withObservation ? (m?.observation_freinte ?? null) : null
    }
    return rows
  }
  const rows = await query<Row>(
    `SELECT * FROM stock_fil${idWhere ? ` WHERE ${idWhere}` : ''} ORDER BY date_entree DESC, IDstock_fil DESC`,
  )
  if (etat === 'tous') return rows
  const want = etat === 'archive' ? 1 : 0
  return rows.filter((r) => (Number(pickVal(r, /^termin/i)) ? 1 : 0) === want)
}

// ── Catalogs (labels) — one cached load instead of five joins per request ──

interface RefFilInfo { reference: string | null; titrage: number | null; bio: number; recycle: number }
interface Catalogs {
  refFil: Map<number, RefFilInfo>
  colori: Map<number, string>
  fournisseur: Map<number, string>
  magasin: Map<number, string>
  client: Map<number, string>
}
let catalogCache: { at: number; data: Catalogs } | null = null
const CATALOG_TTL_MS = 60_000
// A row pointing at an id the cache doesn't know (client / fournisseur just
// created) forces one reload, rate-limited so a genuinely dangling FK can't
// turn every request into a catalog scan.
const CATALOG_MISS_RELOAD_MS = 3_000

async function loadCatalogs(): Promise<Catalogs> {
  // ref_fil: SELECT * because `recyclé` cannot be named (bridge); it has no
  // blob column, so the Windows driver returns rows.
  const [rfRaw, cfRaw, fRaw, stRaw, cRaw] = await Promise.all([
    query<Row>(`SELECT * FROM ref_fil`),
    query<Row>(`SELECT IDcolori_fil, reference FROM colori_fil`),
    query<Row>(`SELECT IDfournisseur, nom FROM fournisseur`),
    query<Row>(`SELECT IDsous_traitant, nom FROM sous_traitant`),
    query<Row>(`SELECT IDclient, nom FROM client`),
  ])
  const [rf, cf, f, st, c] = await Promise.all([
    fixEncoding(rfRaw, 'ref_fil', 'IDref_fil', ['reference']),
    fixEncoding(cfRaw, 'colori_fil', 'IDcolori_fil', ['reference']),
    fixEncoding(fRaw, 'fournisseur', 'IDfournisseur', ['nom']),
    fixEncoding(stRaw, 'sous_traitant', 'IDsous_traitant', ['nom']),
    fixEncoding(cRaw, 'client', 'IDclient', ['nom']),
  ])
  const nameMap = (rows: Row[], idKey: string, col: string): Map<number, string> => {
    const m = new Map<number, string>()
    for (const r of rows) m.set(numOf(r[idKey]), String(r[col] ?? '').trim())
    return m
  }
  const refFil = new Map<number, RefFilInfo>()
  for (const r of rf) {
    refFil.set(numOf(r.IDref_fil), {
      reference: r.reference == null ? null : String(r.reference),
      titrage: r.titrage == null ? null : floatOf(r.titrage),
      bio: numOf(r.bio) ? 1 : 0,
      // recyclé → recycl/recyclt/… on the bridge, recyclé on Windows.
      recycle: numOf(pickVal(r, /^recycl/i)) ? 1 : 0,
    })
  }
  return {
    refFil,
    colori: nameMap(cf, 'IDcolori_fil', 'reference'),
    fournisseur: nameMap(f, 'IDfournisseur', 'nom'),
    magasin: nameMap(st, 'IDsous_traitant', 'nom'),
    client: nameMap(c, 'IDclient', 'nom'),
  }
}

async function getCatalogs(force = false): Promise<Catalogs> {
  if (!force && catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.data
  const data = await loadCatalogs()
  catalogCache = { at: Date.now(), data }
  return data
}

/** Encoding repair + accent-key normalisation + label resolution, shared by
 *  list and detail. Output keys match what the ETM list emits (ref_fil,
 *  titrage, bio, recycle, colori_reference, fournisseur_nom, magasin_nom)
 *  plus client_nom. */
async function hydrateRows(rows: Row[]): Promise<Row[]> {
  const fixed: Row[] = await fixEncoding(
    rows,
    'stock_fil',
    'IDstock_fil',
    ['lot', 'lot_frs', 'emplacement', 'commentaire', 'observation_freinte'],
  )

  let cat = await getCatalogs()
  const missing = fixed.some((r) => {
    const cid = numOf(r.IDclient), fid = numOf(r.IDfournisseur), rid = numOf(r.IDref_fil), col = numOf(r.IDcolori_fil)
    return (cid > 0 && !cat.client.has(cid)) || (fid > 0 && !cat.fournisseur.has(fid))
      || (rid > 0 && !cat.refFil.has(rid)) || (col > 0 && !cat.colori.has(col))
  })
  if (missing && catalogCache && Date.now() - catalogCache.at > CATALOG_MISS_RELOAD_MS) {
    cat = await getCatalogs(true)
  }

  return fixed.map((r) => {
    const out: Row = { ...r }
    // terminé / controlé: read by prefix BEFORE stripping every mangled
    // variant (bridge key is non-deterministic — see stock.ts pickVal).
    const termineVal = pickVal(out, /^termin/i)
    const controleVal = pickVal(out, /^control/i)
    stripKeys(out, /^termin/i)
    stripKeys(out, /^control/i)
    stripKeys(out, /^certif/i) // blob columns of the Linux SELECT * — never in the payload
    out.termine = Number(termineVal) || 0
    out.controle = Number(controleVal) || 0

    const rf = cat.refFil.get(numOf(out.IDref_fil))
    out.ref_fil = rf?.reference ?? null
    out.titrage = rf?.titrage ?? null
    out.bio = rf?.bio ?? 0
    out.recycle = rf?.recycle ?? 0
    out.colori_reference = cat.colori.get(numOf(out.IDcolori_fil)) ?? null
    out.fournisseur_nom = cat.fournisseur.get(numOf(out.IDfournisseur)) ?? null
    out.magasin_nom = cat.magasin.get(numOf(out.IDMagasin)) ?? null
    out.client_nom = cat.client.get(numOf(out.IDclient)) ?? null
    return out
  })
}

/** One hydrated row by id, or null. */
async function fetchRow(id: number): Promise<Row | null> {
  const rows = await fetchBaseRows('tous', id, true)
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

/** A lot dumped into a run through the OF window's "Incorporer un fil": a
 *  leftover fed in so it stops sitting in stock. `fil_incorpore` carries no
 *  percentage — the weight is declared in Kg, once, for the whole OF. */
interface BilanIncorpore {
  of: number
  ref_ecru: string
  poids: number
}

interface Bilan {
  ofs: BilanOf[]
  /** Weighted yarn consumption: Σ over OFs [Σ(pieces poids) × pourcentage/100].
   *  The weighting is load-bearing on blended yarns — verified against the
   *  legacy annotations (e.g. the "90kg de freinte négative" lot). */
  produit: number
  /** Incorporations of THIS lot, and their total. Consumption too — it is why
   *  the lot is short — but it never rides `asso_fil_of`, so `produit` cannot
   *  see it. Counting it as freinte inflates the loss by exactly the declared
   *  weight: on ~10 of the 32 incorporated lots the computed freinte WAS the
   *  incorporated weight to the kilo (lot 9479: 50,5 vs 50; lot 10065: 20,6 vs
   *  20), and the median freinte across them falls 3,76 % → 1,00 % once it is
   *  taken out. User decision, 2026-08-26. Probes:
   *  `scripts/probe-fil-incorpore-trm{,2,3,4}.ts`.
   *
   *  Kept as its OWN line rather than folded into `produit`, because the
   *  weight is DECLARED, not measured: the consigne often reads "incorporer le
   *  lot X si possible", and a handful of rows do not reconcile at all (lot
   *  10106 declares 8 Kg incorporated on an 8 Kg lot that already knitted
   *  6,6 Kg). The archivist has to see the figure to judge it — and can still
   *  correct Quantité initiale, which is what the dialog is for. */
  incorpore: BilanIncorpore[]
  incorpore_total: number
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
  const incs = await query<{ IDordre_fabrication: number; poids: number | null }>(
    `SELECT IDordre_fabrication, poids FROM fil_incorpore WHERE IDstock_fil = ${id} ORDER BY IDfil_incorpore`,
  )
  const ofIds = Array.from(
    new Set(assos.map((a) => numOf(a.IDordre_fabrication)).filter((x) => x > 0)),
  )
  // An incorporation lands on an OF this lot may not knit at all — 31 of the
  // 34 in the ledger are exactly that — so its OF still needs a ref_ecru label.
  const labelledOfIds = Array.from(
    new Set([...ofIds, ...incs.map((i) => numOf(i.IDordre_fabrication)).filter((x) => x > 0)]),
  )

  const refEcruByOf = new Map<number, number>()
  if (labelledOfIds.length > 0) {
    const ofRows = await query<{ IDordre_fabrication: number; IDref_ecru: number }>(
      `SELECT IDordre_fabrication, IDref_ecru FROM ordre_fabrication WHERE IDordre_fabrication IN (${labelledOfIds.join(',')})`,
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

  const incorpore: BilanIncorpore[] = incs.map((i) => ({
    of: numOf(i.IDordre_fabrication),
    ref_ecru: refEcruLabel.get(refEcruByOf.get(numOf(i.IDordre_fabrication)) ?? 0) ?? '',
    poids: floatOf(i.poids),
  }))
  const incorporeTotal = incorpore.reduce((s, i) => s + i.poids, 0)

  return {
    ofs,
    produit,
    incorpore,
    incorpore_total: incorporeTotal,
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

// Archived lots are frozen (stock forced to 0, no further edits accepted), so
// their ~1.6k hydrated rows are cached briefly — the Archivé view, and the
// Archivé half of Tous, then cost nothing after the first load. Invalidated by
// this router's archiver; a lot archived from the legacy app shows up within
// the TTL.
let archiveCache: { at: number; rows: Row[] } | null = null
const ARCHIVE_TTL_MS = 60_000

async function getArchivedRows(): Promise<Row[]> {
  if (archiveCache && Date.now() - archiveCache.at < ARCHIVE_TTL_MS) return archiveCache.rows
  const rows = await hydrateRows(await fetchBaseRows('archive'))
  archiveCache = { at: Date.now(), rows }
  return rows
}

/** List order: date_entree DESC, IDstock_fil DESC (what the SQL emits). */
function byEntreeDesc(a: Row, b: Row): number {
  const da = String(a.date_entree ?? ''), db = String(b.date_entree ?? '')
  if (da !== db) return da < db ? 1 : -1
  return numOf(b.IDstock_fil) - numOf(a.IDstock_fil)
}

// GET /api/stock/fil-trm?etat=disponible|archive|tous — the TRM list.
// The etat filter runs in SQL on Windows, in JS on the Linux bridge (accented
// column) — either way BEFORE hydration, so the default view only repairs and
// labels its ~120 rows.
stockFilTrmRouter.get('/fil-trm', async (req: Request, res: Response) => {
  try {
    const etat: EtatFilter =
      req.query.etat === 'archive' ? 'archive' : req.query.etat === 'tous' ? 'tous' : 'disponible'
    if (etat === 'archive') {
      res.json(await getArchivedRows())
      return
    }
    const live = await hydrateRows(await fetchBaseRows('disponible'))
    if (etat === 'disponible') {
      res.json(live)
      return
    }
    res.json([...live, ...(await getArchivedRows())].sort(byEntreeDesc))
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
  if (!(await requirePermission(req, res, 'create_stock_fil', TRM_PERMISSIONS))) return
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
  if (!(await requirePermission(req, res, 'create_stock_fil', TRM_PERMISSIONS))) return
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
    // Consommé = tricoté + incorporé. See Bilan.incorpore for why the two
    // stay separate figures rather than one merged `produit`.
    const freinteKg = stockInitial - bilan.produit - bilan.incorpore_total
    res.json({
      IDstock_fil: id,
      lot: row.lot,
      stock_initial: stockInitial,
      stock: floatOf(row.stock),
      observation_freinte: row.observation_freinte ?? '',
      ofs: bilan.ofs,
      produit: bilan.produit,
      incorpore: bilan.incorpore,
      incorpore_total: bilan.incorpore_total,
      consomme: bilan.produit + bilan.incorpore_total,
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
  if (!(await requirePermission(req, res, 'create_stock_fil', TRM_PERMISSIONS))) return
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
    archiveCache = null

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
    const freinteKg = stockInitial - bilan.produit - bilan.incorpore_total

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
      incorpore: bilan.incorpore,
      incorpore_total: bilan.incorpore_total,
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
