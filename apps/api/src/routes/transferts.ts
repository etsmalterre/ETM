// Transferts — bons de transfert between Ets Malterre and sous-traitant sites.
// Ports the legacy WinDev screens FEN_Bons_de_transfert /
// FEN_Gestion_d_un_bon_de_transfert / FEN_detail_transfert_fil and the report
// ETAT_Bon_de_transfert ("Bordereau de livraison N° X") as a two-kind route:
//
//   kind 'rouleaux' → bon_transfert.type_matiere = 1 (pieces: écru "tombé de
//                     métier" rolls + fini rolls, mixable on one bon)
//   kind 'fils'     → bon_transfert.type_matiere = 2 (stock_fil lots)
//
// Data model (verified by live introspection):
//   bon_transfert:   IDbon_transfert PK (the displayed Numéro), IDmagasin_source,
//                    IDmagasin_destination, IDadresse_destination, DATE (reserved
//                    word — alias on read, uppercase on write), commentaire
//                    (PLAIN text, not RTF), est_valide (dead since 02/2025 —
//                    write 0, never surface), IDtransporteur, type_matiere.
//   piece_transfert: IDpiece_transfert PK, IDbon_transfert FK, exactly one
//                    non-zero among IDpiece_ecru → stock_ecru / IDpiece_fini →
//                    stock_fini / IDstock_fil → stock_fil.
//
// "Magasins" here are NOT the (broken, unused) magasin table — they are
// sous_traitant rows, with the special id 0 = Ets Malterre. Stock location
// lives on stock_ecru.IDmagasin / stock_fini.IDmagasin / stock_fil.IDMagasin
// (note the capital M on stock_fil).
//
// Stock-move semantics (user-confirmed, mirrors legacy): adding a piece to a
// bon moves it to the destination magasin IMMEDIATELY; removing it moves it
// back to the source. Deleting a bon returns every piece to the source.
// Because stock moves on add, source/destination are LOCKED once a bon has
// lines (changing them would strand the already-moved stock).
//
// Hard HFSQL rules applied throughout (CLAUDE.md): no parameterized queries /
// RETURNING; esc()/parseInt/sqlText; DATE aliased; empty FK = 0 not NULL;
// never name accented columns (ref_ecru.archivé, stock_fil.terminé, …) — the
// stock_fil reads follow stock.ts's IS_WINDOWS split + prefix pickVal.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { repairAliased } from './stock-fini.js'
import { esc, n, dateDigits as dateStr, IS_WINDOWS } from '../lib/sst-shared.js'
import { BonTransfertPdf, type BonTransfertPdfData, type BtArticle, type BtPiece, type BtFilRow } from '../lib/pdf/BonTransfertPdf.js'
import { sendMail } from '../lib/gmail.js'
import { getUserEmail } from '../lib/user-emails.js'

export const transfertsRouter: RouterType = Router()

// ── Kind model ───────────────────────────────────────────

type Kind = 'rouleaux' | 'fils'

const TYPE_MATIERE: Record<Kind, number> = { rouleaux: 1, fils: 2 }

function parseKind(raw: string | undefined): Kind | null {
  return raw === 'rouleaux' ? 'rouleaux' : raw === 'fils' ? 'fils' : null
}

/** Display label for magasin id 0 — the company itself has no sous_traitant row. */
const ETS_MALTERRE = 'Ets Malterre'
/** Legacy convention: the Ets Malterre destination address row. */
const ADRESSE_ETS_MALTERRE = 1

// ── Small SQL/format helpers (same as expeditions.ts) ────

/** SQL literal for user text. ASCII → quoted literal; accents → Latin-1 hex
 *  literal (the Linux iODBC bridge corrupts raw multi-byte UTF-8 in a SQL line). */
function sqlText(value: string | null | undefined): string {
  const v = (value ?? '').toString()
  if (v === '') return "''"
  if (/^[\x09\x0A\x0D\x20-\x7E]*$/.test(v)) return `'${esc(v)}'`
  const ascii = v
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
  const bytes = Buffer.from(Array.from(ascii, (ch) => {
    const c = ch.codePointAt(0) ?? 0x3f
    return c <= 0xff ? c : 0x3f
  }))
  return `x'${bytes.toString('hex')}'`
}

function decode(v: unknown): string | null {
  if (v instanceof ArrayBuffer) return Buffer.from(v).toString('utf8')
  if (typeof v === 'string') return v
  return null
}

/** Accent-insensitive contains-matching (search). */
function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

function todayDigits(): string {
  const t = new Date()
  return `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}`
}

const FRENCH_MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
function formatHfsqlDateLongFr(raw: string | null | undefined): string {
  if (!raw) return ''
  const s = String(raw)
  if (!/^\d{8}$/.test(s)) return ''
  const day = parseInt(s.slice(6, 8), 10)
  const month = parseInt(s.slice(4, 6), 10)
  if (month < 1 || month > 12) return ''
  return `${day} ${FRENCH_MONTHS[month - 1]} ${s.slice(0, 4)}`
}

/** Resolve accented columns by case-insensitive prefix — the Linux bridge
 *  truncates the identifier at the accent with a non-deterministic trailing
 *  byte (terminé → termin/termint/…). See stock.ts for the full story. */
function pickVal(row: Record<string, unknown>, re: RegExp): unknown {
  const k = Object.keys(row).find((key) => re.test(key))
  return k === undefined ? undefined : row[k]
}

// ── Name/address resolvers ───────────────────────────────

/** sous_traitant names for magasin ids (0 is handled by magasinNom below). */
async function resolveSstNames(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const u = Array.from(new Set(ids.filter((x) => x > 0)))
  if (u.length === 0) return out
  const rows = await query<{ IDsous_traitant: number; nom: unknown }>(
    `SELECT IDsous_traitant, CONVERT(nom USING 'UTF-8') AS nom FROM sous_traitant WHERE IDsous_traitant IN (${u.join(',')})`,
  )
  for (const r of rows) out.set(Number(r.IDsous_traitant), decode(r.nom) ?? '')
  return out
}

function magasinNom(id: number, sstNames: Map<number, string>): string {
  return id === 0 ? ETS_MALTERRE : (sstNames.get(id) ?? `Magasin #${id}`)
}

async function resolveTransporteurNames(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const u = Array.from(new Set(ids.filter((x) => x > 0)))
  if (u.length === 0) return out
  const rows = await query<{ IDtransporteur: number; nom: string | null }>(
    `SELECT IDtransporteur, nom FROM transporteur WHERE IDtransporteur IN (${u.join(',')})`,
  )
  const fixed = await fixEncoding(rows, 'transporteur', 'IDtransporteur', ['nom'])
  for (const r of fixed) out.set(Number(r.IDtransporteur), (r.nom ?? '').toString())
  return out
}

async function loadAdresse(id: number): Promise<Record<string, unknown> | null> {
  if (!(id > 0)) return null
  const rows = await query(
    `SELECT IDadresse, nom, adresse1, adresse2, adresse3, cp, ville, pays FROM adresse WHERE IDadresse = ${id}`,
  )
  const fixed = await fixEncoding(rows, 'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays'])
  return (fixed[0] as Record<string, unknown>) ?? null
}

// ── Coloris resolution (mixed refs — per-roll avec_teinture) ──

async function loadEcruColorisMap(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const u = Array.from(new Set(ids.filter((x) => x > 0)))
  if (u.length === 0) return out
  const rows = await query<{ IDcolori_ecru: number; reference: string | null }>(
    `SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDcolori_ecru IN (${u.join(',')})`,
  )
  for (const r of await fixEncoding(rows, 'colori_ecru', 'IDcolori_ecru', ['reference'])) out.set(Number(r.IDcolori_ecru), (r.reference ?? '').toString())
  return out
}
async function loadFiniColorisMap(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const u = Array.from(new Set(ids.filter((x) => x > 0)))
  if (u.length === 0) return out
  const rows = await query<{ IDref_fini_colori: number; reference: string | null }>(
    `SELECT IDref_fini_colori, reference FROM ref_fini_colori WHERE IDref_fini_colori IN (${u.join(',')})`,
  )
  for (const r of await fixEncoding(rows, 'ref_fini_colori', 'IDref_fini_colori', ['reference'])) out.set(Number(r.IDref_fini_colori), (r.reference ?? '').toString())
  return out
}

// ── Header loading ───────────────────────────────────────

interface BonHead {
  id: number
  IDmagasin_source: number
  IDmagasin_destination: number
  IDadresse_destination: number
  IDtransporteur: number
  date: string | null
  commentaire: string | null
  type_matiere: number
}

async function loadBonHead(kind: Kind, id: number): Promise<BonHead | null> {
  const rows = await query<any>(
    `SELECT IDbon_transfert, IDmagasin_source, IDmagasin_destination, IDadresse_destination, ` +
      `IDtransporteur, DATE AS dtransfert, commentaire ` +
      `FROM bon_transfert WHERE IDbon_transfert = ${id} AND type_matiere = ${TYPE_MATIERE[kind]}`,
  )
  if (rows.length === 0) return null
  const fixed = await fixEncoding(rows, 'bon_transfert', 'IDbon_transfert', ['commentaire'])
  const h = fixed[0] as any
  return {
    id,
    IDmagasin_source: Number(h.IDmagasin_source) || 0,
    IDmagasin_destination: Number(h.IDmagasin_destination) || 0,
    IDadresse_destination: Number(h.IDadresse_destination) || 0,
    IDtransporteur: Number(h.IDtransporteur) || 0,
    date: h.dtransfert ?? null,
    commentaire: (h.commentaire ?? '').toString().trim() || null,
    type_matiere: TYPE_MATIERE[kind],
  }
}

// ── Lines loading (shared by detail + PDF) ───────────────

interface RouleauxLine {
  IDpiece_transfert: number
  type: 'tm' | 'fini'
  stock_id: number
  reference: string
  designation: string
  composition: string
  coloris_reference: string
  numero: string
  lot: string
  poids: number
  metrage: number
  second_choix: number
}

interface FilLine {
  IDpiece_transfert: number
  type: 'fil'
  stock_id: number
  lot: string
  reference: string
  coloris_reference: string
  poids: number
  fournisseur_nom: string
  commentaire: string | null
}

const pieceCollator = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' })

async function loadRouleauxLines(bonId: number): Promise<RouleauxLine[]> {
  const pieces = await query<any>(
    `SELECT IDpiece_transfert, IDpiece_ecru, IDpiece_fini FROM piece_transfert WHERE IDbon_transfert = ${bonId} ORDER BY IDpiece_transfert`,
  )
  const ecruIds = pieces.map((p: any) => Number(p.IDpiece_ecru) || 0).filter((x: number) => x > 0)
  const finiIds = pieces.map((p: any) => Number(p.IDpiece_fini) || 0).filter((x: number) => x > 0)

  // Flat per-table queries + JS merge (JOIN + CONVERT collapses result sets).
  const [ecruRaw, finiRaw] = await Promise.all([
    ecruIds.length
      ? query<any>(`SELECT IDstock_ecru, IDref_ecru, IDcolori_ecru, numero, lot, poids, metrage, second_choix FROM stock_ecru WHERE IDstock_ecru IN (${ecruIds.join(',')})`)
      : Promise.resolve([]),
    finiIds.length
      ? query<any>(`SELECT IDstock_fini, IDref_fini, IDColoris, numero, lot, poids, metrage, second_choix FROM stock_fini WHERE IDstock_fini IN (${finiIds.join(',')})`)
      : Promise.resolve([]),
  ])
  const ecruFixed = await fixEncoding(ecruRaw, 'stock_ecru', 'IDstock_ecru', ['numero', 'lot'])
  const finiFixed = await fixEncoding(finiRaw, 'stock_fini', 'IDstock_fini', ['numero', 'lot'])
  const ecruById = new Map((ecruFixed as any[]).map((r) => [Number(r.IDstock_ecru), r]))
  const finiById = new Map((finiFixed as any[]).map((r) => [Number(r.IDstock_fini), r]))

  // Reference labels + designation/composition for the PDF article bands.
  // ref_ecru/ref_fini both carry accented columns (archivé, …) — name only
  // the ASCII ones. Fini composition comes from the parent écru reference.
  const refEcruIds = Array.from(new Set((ecruFixed as any[]).map((r) => Number(r.IDref_ecru) || 0).filter((x) => x > 0)))
  const refFiniIds = Array.from(new Set((finiFixed as any[]).map((r) => Number(r.IDref_fini) || 0).filter((x) => x > 0)))
  const [refEcruRows, refFiniRows] = await Promise.all([
    refEcruIds.length
      ? query<any>(`SELECT IDref_ecru, reference, designation, composition FROM ref_ecru WHERE IDref_ecru IN (${refEcruIds.join(',')})`)
      : Promise.resolve([]),
    refFiniIds.length
      ? query<any>(`SELECT IDref_fini, IDref_ecru, reference, designation, avec_teinture FROM ref_fini WHERE IDref_fini IN (${refFiniIds.join(',')})`)
      : Promise.resolve([]),
  ])
  const refEcruFixed = await fixEncoding(refEcruRows, 'ref_ecru', 'IDref_ecru', ['reference', 'designation', 'composition'])
  const refFiniFixed = await fixEncoding(refFiniRows, 'ref_fini', 'IDref_fini', ['reference', 'designation'])
  const refEcru = new Map((refEcruFixed as any[]).map((r) => [Number(r.IDref_ecru), r]))
  const refFini = new Map((refFiniFixed as any[]).map((r) => [Number(r.IDref_fini), r]))

  // Fini refs inherit their composition from the parent écru reference.
  const parentEcruIds = Array.from(new Set(
    (refFiniFixed as any[]).map((r) => Number(r.IDref_ecru) || 0).filter((x) => x > 0 && !refEcru.has(x)),
  ))
  if (parentEcruIds.length > 0) {
    const rows = await query<any>(`SELECT IDref_ecru, reference, designation, composition FROM ref_ecru WHERE IDref_ecru IN (${parentEcruIds.join(',')})`)
    for (const r of await fixEncoding(rows, 'ref_ecru', 'IDref_ecru', ['reference', 'designation', 'composition'])) {
      refEcru.set(Number((r as any).IDref_ecru), r)
    }
  }

  // Coloris — écru rolls via colori_ecru; fini rolls polymorphic on avec_teinture.
  const ecruColIds = (ecruFixed as any[]).map((r) => Number(r.IDcolori_ecru) || 0)
  const finiWashColIds: number[] = []
  const finiDyeColIds: number[] = []
  for (const r of finiFixed as any[]) {
    const avec = Number(refFini.get(Number(r.IDref_fini))?.avec_teinture) || 0
    if (avec === 0) finiWashColIds.push(Number(r.IDColoris) || 0)
    else finiDyeColIds.push(Number(r.IDColoris) || 0)
  }
  const [ecruCol, dyeCol] = await Promise.all([
    loadEcruColorisMap([...ecruColIds, ...finiWashColIds]),
    loadFiniColorisMap(finiDyeColIds),
  ])

  const out: RouleauxLine[] = []
  for (const p of pieces as any[]) {
    const pid = Number(p.IDpiece_transfert)
    const ecruId = Number(p.IDpiece_ecru) || 0
    const finiId = Number(p.IDpiece_fini) || 0
    if (ecruId > 0) {
      const r = ecruById.get(ecruId)
      if (!r) continue
      const ref = refEcru.get(Number(r.IDref_ecru)) ?? {}
      out.push({
        IDpiece_transfert: pid, type: 'tm', stock_id: ecruId,
        reference: ((ref as any).reference ?? '').toString(),
        designation: ((ref as any).designation ?? '').toString().trim(),
        composition: ((ref as any).composition ?? '').toString().trim(),
        coloris_reference: ecruCol.get(Number(r.IDcolori_ecru)) ?? '',
        numero: (r.numero ?? '').toString(), lot: (r.lot ?? '').toString(),
        poids: Number(r.poids) || 0, metrage: Number(r.metrage) || 0,
        second_choix: Number(r.second_choix) || 0,
      })
    } else if (finiId > 0) {
      const r = finiById.get(finiId)
      if (!r) continue
      const rf = refFini.get(Number(r.IDref_fini)) ?? {}
      const parent = refEcru.get(Number((rf as any).IDref_ecru) || 0) ?? {}
      const avec = Number((rf as any).avec_teinture) || 0
      const colId = Number(r.IDColoris) || 0
      out.push({
        IDpiece_transfert: pid, type: 'fini', stock_id: finiId,
        reference: ((rf as any).reference ?? '').toString(),
        designation: ((rf as any).designation ?? '').toString().trim(),
        composition: ((parent as any).composition ?? '').toString().trim(),
        coloris_reference: (avec === 0 ? ecruCol.get(colId) : dyeCol.get(colId)) ?? '',
        numero: (r.numero ?? '').toString(), lot: (r.lot ?? '').toString(),
        poids: Number(r.poids) || 0, metrage: Number(r.metrage) || 0,
        second_choix: Number(r.second_choix) || 0,
      })
    }
  }
  return out
}

async function loadFilLines(bonId: number): Promise<FilLine[]> {
  const pieces = await query<any>(
    `SELECT IDpiece_transfert, IDstock_fil FROM piece_transfert WHERE IDbon_transfert = ${bonId} ORDER BY IDpiece_transfert`,
  )
  const filIds = pieces.map((p: any) => Number(p.IDstock_fil) || 0).filter((x: number) => x > 0)
  if (filIds.length === 0) return []

  // Named ASCII columns only — stock_fil's accented certif block poisons
  // SELECT * on Windows (silently returns 0 rows).
  const raw = await query<any>(
    `SELECT sf.IDstock_fil, sf.IDfournisseur, sf.IDref_fil, sf.IDcolori_fil, sf.lot, sf.stock, sf.commentaire, ` +
      `rf.reference AS ref_fil, cf.reference AS colori_reference, f.nom AS fournisseur_nom ` +
      `FROM stock_fil sf ` +
      `LEFT JOIN ref_fil rf ON sf.IDref_fil = rf.IDref_fil ` +
      `LEFT JOIN colori_fil cf ON sf.IDcolori_fil = cf.IDcolori_fil ` +
      `LEFT JOIN fournisseur f ON sf.IDfournisseur = f.IDfournisseur ` +
      `WHERE sf.IDstock_fil IN (${filIds.join(',')})`,
  )
  let fixed = await fixEncoding(raw, 'stock_fil', 'IDstock_fil', ['lot', 'commentaire'])
  fixed = await repairAliased(fixed, 'ref_fil', 'IDref_fil', { ref_fil: 'reference' })
  fixed = await repairAliased(fixed, 'colori_fil', 'IDcolori_fil', { colori_reference: 'reference' })
  fixed = await repairAliased(fixed, 'fournisseur', 'IDfournisseur', { fournisseur_nom: 'nom' })
  const byId = new Map((fixed as any[]).map((r) => [Number(r.IDstock_fil), r]))

  const out: FilLine[] = []
  for (const p of pieces as any[]) {
    const sid = Number(p.IDstock_fil) || 0
    const r = byId.get(sid)
    if (!r) continue
    out.push({
      IDpiece_transfert: Number(p.IDpiece_transfert), type: 'fil', stock_id: sid,
      lot: (r.lot ?? '').toString(),
      reference: (r.ref_fil ?? '').toString(),
      coloris_reference: (r.colori_reference ?? '').toString(),
      poids: Number(r.stock) || 0,
      fournisseur_nom: (r.fournisseur_nom ?? '').toString(),
      commentaire: (r.commentaire ?? '').toString().trim() || null,
    })
  }
  return out
}

async function loadLines(kind: Kind, bonId: number): Promise<Array<RouleauxLine | FilLine>> {
  return kind === 'rouleaux' ? loadRouleauxLines(bonId) : loadFilLines(bonId)
}

async function countLines(bonId: number): Promise<number> {
  const rows = await query<{ c: number }>(`SELECT COUNT(*) AS c FROM piece_transfert WHERE IDbon_transfert = ${bonId}`)
  return Number(rows[0]?.c) || 0
}

async function maxId(head: string, pk: string): Promise<number> {
  const rows = await query<{ m: number | null }>(`SELECT MAX(${pk}) AS m FROM ${head}`)
  return Number(rows[0]?.m) || 0
}
async function newIdAfterInsert(head: string, pk: string, before: number): Promise<number> {
  const rows = await query<{ id: number }>(`SELECT TOP 1 ${pk} AS id FROM ${head} WHERE ${pk} > ${before} ORDER BY ${pk} DESC`)
  return Number(rows[0]?.id) || 0
}

// ════════════════════════════════════════════════════════
//  LOOKUPS  (literal paths — must register before /:kind/*)
// ════════════════════════════════════════════════════════

// Magasins = visible sous-traitants. The frontend prepends {id: 0, nom: 'Ets
// Malterre'} — the company itself has no sous_traitant row.
transfertsRouter.get('/lookups/magasins', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDsous_traitant: number; nom: string | null }>(
      `SELECT IDsous_traitant, nom FROM sous_traitant WHERE est_visible = 1 ORDER BY nom`,
    )
    const fixed = await fixEncoding(rows, 'sous_traitant', 'IDsous_traitant', ['nom'])
    res.json(fixed.map((r) => ({ id: Number(r.IDsous_traitant), nom: (r.nom ?? '').toString() })))
  } catch (err) {
    console.error('Error fetching magasins lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

transfertsRouter.get('/lookups/transporteurs', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDtransporteur: number; nom: string | null }>(
      `SELECT IDtransporteur, nom FROM transporteur WHERE est_visible = 1 ORDER BY nom`,
    )
    const fixed = await fixEncoding(rows, 'transporteur', 'IDtransporteur', ['nom'])
    res.json(fixed.map((r) => ({ IDtransporteur: Number(r.IDtransporteur), nom: (r.nom ?? '').toString() })))
  } catch (err) {
    console.error('Error fetching transporteurs lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Destination addresses for a magasin: sous-traitant addresses, or the fixed
// Ets Malterre address row for magasin 0.
transfertsRouter.get('/lookups/adresses', async (req: Request, res: Response) => {
  try {
    const mid = parseInt(String(req.query.magasin ?? ''), 10)
    if (isNaN(mid) || mid < 0) { res.status(400).json({ error: 'magasin query parameter required' }); return }
    const where = mid === 0
      ? `IDadresse = ${ADRESSE_ETS_MALTERRE}`
      : `IDsous_traitant = ${mid} AND (est_visible IS NULL OR est_visible = 1)`
    const rows = await query(
      `SELECT IDadresse, nom, adresse1, adresse2, adresse3, cp, ville, pays, est_defaut ` +
        `FROM adresse WHERE ${where} ORDER BY est_defaut DESC, IDadresse`,
    )
    const fixed = await fixEncoding(rows, 'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays'])
    res.json(fixed)
  } catch (err) {
    console.error('Error fetching adresses lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  LIST
// ════════════════════════════════════════════════════════

transfertsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const kind = parseKind(String(req.query.kind ?? 'rouleaux')) ?? 'rouleaux'
    const q = String(req.query.q ?? '').trim()
    const limitRaw = parseInt(String(req.query.limit ?? ''), 10)
    const limit = isNaN(limitRaw) ? 100 : Math.min(Math.max(limitRaw, 1), 500)
    const fetchCap = q ? 800 : limit

    // Cursor pagination (load more): only ids strictly below `before`. Ignored while searching.
    const beforeRaw = parseInt(String(req.query.before ?? ''), 10)
    const beforeSql = !q && !isNaN(beforeRaw) && beforeRaw > 0 ? ` AND IDbon_transfert < ${beforeRaw}` : ''

    const heads = await query<any>(
      `SELECT TOP ${fetchCap} IDbon_transfert, IDmagasin_source, IDmagasin_destination, IDtransporteur, DATE AS dtransfert ` +
        `FROM bon_transfert WHERE type_matiere = ${TYPE_MATIERE[kind]}${beforeSql} ORDER BY IDbon_transfert DESC`,
    )
    const ids = heads.map((h: any) => Number(h.IDbon_transfert)).filter(Boolean)

    // Per-bon line counts, batched.
    const countMap = new Map<number, number>()
    if (ids.length > 0) {
      const rows = await query<{ IDbon_transfert: number; c: number }>(
        `SELECT IDbon_transfert, COUNT(*) AS c FROM piece_transfert WHERE IDbon_transfert IN (${ids.join(',')}) GROUP BY IDbon_transfert`,
      )
      for (const r of rows) countMap.set(Number(r.IDbon_transfert), Number(r.c) || 0)
    }

    const [sstNames, transNames] = await Promise.all([
      resolveSstNames(heads.flatMap((h: any) => [Number(h.IDmagasin_source), Number(h.IDmagasin_destination)])),
      resolveTransporteurNames(heads.map((h: any) => Number(h.IDtransporteur))),
    ])

    let result = heads.map((h: any) => {
      const id = Number(h.IDbon_transfert)
      const src = Number(h.IDmagasin_source) || 0
      const dst = Number(h.IDmagasin_destination) || 0
      return {
        id, kind,
        IDmagasin_source: src, source_nom: magasinNom(src, sstNames),
        IDmagasin_destination: dst, destination_nom: magasinNom(dst, sstNames),
        transporteur_nom: transNames.get(Number(h.IDtransporteur)) ?? '',
        date: h.dtransfert ?? null,
        nb_pieces: countMap.get(id) ?? 0,
      }
    })
    if (q) {
      const nq = norm(q)
      result = result.filter((r: any) =>
        String(r.id).includes(q) || norm(r.source_nom).includes(nq) || norm(r.destination_nom).includes(nq) || norm(r.transporteur_nom).includes(nq),
      )
    }
    res.json(result.slice(0, limit))
  } catch (err) {
    console.error('Error fetching transferts:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  DETAIL
// ════════════════════════════════════════════════════════

transfertsRouter.get('/:kind/:id', async (req: Request, res: Response) => {
  try {
    const kind = parseKind(req.params.kind)
    if (!kind) { res.status(404).json({ error: 'Not found' }); return }
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const h = await loadBonHead(kind, id)
    if (!h) { res.status(404).json({ error: 'Bon de transfert introuvable' }); return }

    const [sstNames, transNames, adr, lines] = await Promise.all([
      resolveSstNames([h.IDmagasin_source, h.IDmagasin_destination]),
      resolveTransporteurNames([h.IDtransporteur]),
      loadAdresse(h.IDadresse_destination),
      loadLines(kind, id),
    ])

    res.json({
      id, kind,
      IDmagasin_source: h.IDmagasin_source,
      source_nom: magasinNom(h.IDmagasin_source, sstNames),
      IDmagasin_destination: h.IDmagasin_destination,
      destination_nom: magasinNom(h.IDmagasin_destination, sstNames),
      IDadresse_destination: h.IDadresse_destination,
      adresse_destination: adr,
      IDtransporteur: h.IDtransporteur,
      transporteur_nom: transNames.get(h.IDtransporteur) ?? '',
      date: h.date,
      commentaire: h.commentaire,
      lines,
    })
  } catch (err) {
    console.error('Error fetching transfert detail:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  HEADER CRUD
// ════════════════════════════════════════════════════════

const createBody = z.object({
  IDmagasin_source: z.number().int().nonnegative(),
  IDmagasin_destination: z.number().int().nonnegative(),
  IDadresse_destination: z.number().int().nonnegative().optional(),
  IDtransporteur: z.number().int().nonnegative().optional(),
  date: z.string().optional(),
  commentaire: z.string().optional(),
})

transfertsRouter.post('/:kind', async (req: Request, res: Response) => {
  try {
    const kind = parseKind(req.params.kind)
    if (!kind) { res.status(404).json({ error: 'Not found' }); return }
    const parsed = createBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data
    if (d.IDmagasin_source === d.IDmagasin_destination) {
      res.status(400).json({ error: 'source_equals_destination', message: 'La source et la destination doivent être différentes.' })
      return
    }
    const date = d.date ? dateStr(d.date) || todayDigits() : todayDigits()
    // Default the destination address: the picked one, else the destination's
    // default address (Ets Malterre → the fixed row 1).
    let idAdresse = n(d.IDadresse_destination)
    if (idAdresse === 0) {
      if (d.IDmagasin_destination === 0) idAdresse = ADRESSE_ETS_MALTERRE
      else {
        const rows = await query<{ IDadresse: number }>(
          `SELECT TOP 1 IDadresse FROM adresse WHERE IDsous_traitant = ${n(d.IDmagasin_destination)} AND (est_visible IS NULL OR est_visible = 1) ORDER BY est_defaut DESC, IDadresse`,
        )
        idAdresse = Number(rows[0]?.IDadresse) || 0
      }
    }

    const before = await maxId('bon_transfert', 'IDbon_transfert')
    await query(
      `INSERT INTO bon_transfert (IDmagasin_source, IDmagasin_destination, IDadresse_destination, DATE, commentaire, est_valide, IDtransporteur, type_matiere) ` +
        `VALUES (${n(d.IDmagasin_source)}, ${n(d.IDmagasin_destination)}, ${idAdresse}, '${date}', ${sqlText(d.commentaire)}, 0, ${n(d.IDtransporteur)}, ${TYPE_MATIERE[kind]})`,
    )
    const newId = await newIdAfterInsert('bon_transfert', 'IDbon_transfert', before)
    res.status(201).json({ id: newId, kind })
  } catch (err) {
    console.error('Error creating transfert:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const updateBody = z.object({
  IDmagasin_source: z.number().int().nonnegative().optional(),
  IDmagasin_destination: z.number().int().nonnegative().optional(),
  IDadresse_destination: z.number().int().nonnegative().optional(),
  IDtransporteur: z.number().int().nonnegative().optional(),
  date: z.string().optional(),
  commentaire: z.string().optional(),
})

transfertsRouter.put('/:kind/:id', async (req: Request, res: Response) => {
  try {
    const kind = parseKind(req.params.kind)
    if (!kind) { res.status(404).json({ error: 'Not found' }); return }
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const h = await loadBonHead(kind, id)
    if (!h) { res.status(404).json({ error: 'Bon de transfert introuvable' }); return }
    const parsed = updateBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data

    // Stock already moved to the current destination on add — retro-changing
    // either endpoint would strand it. Locked once lines exist.
    const wantsSrc = d.IDmagasin_source !== undefined && d.IDmagasin_source !== h.IDmagasin_source
    const wantsDst = d.IDmagasin_destination !== undefined && d.IDmagasin_destination !== h.IDmagasin_destination
    if (wantsSrc || wantsDst) {
      const nb = await countLines(id)
      if (nb > 0) {
        res.status(400).json({
          error: 'magasins_locked',
          message: 'Le bon contient des pièces — retirez-les avant de changer la source ou la destination.',
        })
        return
      }
      const src = d.IDmagasin_source ?? h.IDmagasin_source
      const dst = d.IDmagasin_destination ?? h.IDmagasin_destination
      if (src === dst) {
        res.status(400).json({ error: 'source_equals_destination', message: 'La source et la destination doivent être différentes.' })
        return
      }
    }

    const sets: string[] = []
    if (d.IDmagasin_source !== undefined) sets.push(`IDmagasin_source = ${n(d.IDmagasin_source)}`)
    if (d.IDmagasin_destination !== undefined) sets.push(`IDmagasin_destination = ${n(d.IDmagasin_destination)}`)
    if (d.IDadresse_destination !== undefined) sets.push(`IDadresse_destination = ${n(d.IDadresse_destination)}`)
    if (d.IDtransporteur !== undefined) sets.push(`IDtransporteur = ${n(d.IDtransporteur)}`)
    if (d.date !== undefined) sets.push(`DATE = '${dateStr(d.date)}'`)
    if (d.commentaire !== undefined) sets.push(`commentaire = ${sqlText(d.commentaire)}`)
    if (sets.length === 0) { res.status(400).json({ error: 'No fields to update' }); return }
    await query(`UPDATE bon_transfert SET ${sets.join(', ')} WHERE IDbon_transfert = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating transfert:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** Move every piece of a bon back to its source magasin (delete / cleanup). */
async function returnAllPiecesToSource(bonId: number, sourceId: number): Promise<void> {
  const pieces = await query<any>(
    `SELECT IDpiece_ecru, IDpiece_fini, IDstock_fil FROM piece_transfert WHERE IDbon_transfert = ${bonId}`,
  )
  const ecru = pieces.map((p: any) => Number(p.IDpiece_ecru) || 0).filter((x: number) => x > 0)
  const fini = pieces.map((p: any) => Number(p.IDpiece_fini) || 0).filter((x: number) => x > 0)
  const fil = pieces.map((p: any) => Number(p.IDstock_fil) || 0).filter((x: number) => x > 0)
  if (ecru.length > 0) await query(`UPDATE stock_ecru SET IDmagasin = ${sourceId} WHERE IDstock_ecru IN (${ecru.join(',')})`)
  if (fini.length > 0) await query(`UPDATE stock_fini SET IDmagasin = ${sourceId} WHERE IDstock_fini IN (${fini.join(',')})`)
  if (fil.length > 0) await query(`UPDATE stock_fil SET IDMagasin = ${sourceId} WHERE IDstock_fil IN (${fil.join(',')})`)
}

transfertsRouter.delete('/:kind/:id', async (req: Request, res: Response) => {
  try {
    const kind = parseKind(req.params.kind)
    if (!kind) { res.status(404).json({ error: 'Not found' }); return }
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const h = await loadBonHead(kind, id)
    if (!h) { res.status(404).json({ error: 'Bon de transfert introuvable' }); return }

    await returnAllPiecesToSource(id, h.IDmagasin_source)
    await query(`DELETE FROM piece_transfert WHERE IDbon_transfert = ${id}`)
    await query(`DELETE FROM bon_transfert WHERE IDbon_transfert = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting transfert:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  AVAILABLE STOCK AT SOURCE
// ════════════════════════════════════════════════════════
//
// A magasin can hold tens of thousands of legacy rolls (30k+ écru at MATEL),
// so this endpoint caps each group at AVAILABLE_CAP most-recent rows and
// supports a server-side ?q= (numero / lot / reference LIKE). The add/remove
// mutations therefore return { lines } only — the UI invalidates the
// available query instead of hydrating a full payload.

const AVAILABLE_CAP = 200

interface AvailableRoll {
  stock_id: number
  reference: string
  coloris_reference: string
  numero: string
  lot: string
  poids: number
  metrage: number
  second_choix: number
}

async function loadAvailableEcru(sourceId: number, q: string): Promise<AvailableRoll[]> {
  const like = q ? ` AND (se.numero LIKE '%${esc(q)}%' OR se.lot LIKE '%${esc(q)}%' OR re.reference LIKE '%${esc(q)}%')` : ''
  const raw = await query<any>(
    `SELECT TOP ${AVAILABLE_CAP} se.IDstock_ecru, se.numero, se.lot, se.poids, se.metrage, se.second_choix, se.IDcolori_ecru, ` +
      `re.reference AS ref_label ` +
      `FROM stock_ecru se LEFT JOIN ref_ecru re ON se.IDref_ecru = re.IDref_ecru ` +
      `WHERE se.IDmagasin = ${sourceId} AND (se.IDligne_expedition_ETM IS NULL OR se.IDligne_expedition_ETM = 0)${like} ` +
      `ORDER BY se.IDstock_ecru DESC`,
  )
  let fixed = await fixEncoding(raw, 'stock_ecru', 'IDstock_ecru', ['numero', 'lot'])
  fixed = await repairAliased(fixed, 'ref_ecru', 'IDref_ecru', { ref_label: 'reference' })
  const col = await loadEcruColorisMap((fixed as any[]).map((r) => Number(r.IDcolori_ecru) || 0))
  return (fixed as any[]).map((r) => ({
    stock_id: Number(r.IDstock_ecru),
    reference: (r.ref_label ?? '').toString(),
    coloris_reference: col.get(Number(r.IDcolori_ecru)) ?? '',
    numero: (r.numero ?? '').toString(), lot: (r.lot ?? '').toString(),
    poids: Number(r.poids) || 0, metrage: Number(r.metrage) || 0,
    second_choix: Number(r.second_choix) || 0,
  }))
}

async function loadAvailableFini(sourceId: number, q: string): Promise<AvailableRoll[]> {
  const like = q ? ` AND (sf.numero LIKE '%${esc(q)}%' OR sf.lot LIKE '%${esc(q)}%' OR rf.reference LIKE '%${esc(q)}%')` : ''
  const raw = await query<any>(
    `SELECT TOP ${AVAILABLE_CAP} sf.IDstock_fini, sf.numero, sf.lot, sf.poids, sf.metrage, sf.second_choix, sf.IDColoris, ` +
      `rf.reference AS ref_label, rf.avec_teinture ` +
      `FROM stock_fini sf LEFT JOIN ref_fini rf ON sf.IDref_fini = rf.IDref_fini ` +
      `WHERE sf.IDmagasin = ${sourceId} AND (sf.IDligne_expedition IS NULL OR sf.IDligne_expedition = 0) AND sf.destockage = 0${like} ` +
      `ORDER BY sf.IDstock_fini DESC`,
  )
  let fixed = await fixEncoding(raw, 'stock_fini', 'IDstock_fini', ['numero', 'lot'])
  fixed = await repairAliased(fixed, 'ref_fini', 'IDref_fini', { ref_label: 'reference' })
  const washIds: number[] = []
  const dyeIds: number[] = []
  for (const r of fixed as any[]) {
    if ((Number(r.avec_teinture) || 0) === 0) washIds.push(Number(r.IDColoris) || 0)
    else dyeIds.push(Number(r.IDColoris) || 0)
  }
  const [washCol, dyeCol] = await Promise.all([loadEcruColorisMap(washIds), loadFiniColorisMap(dyeIds)])
  return (fixed as any[]).map((r) => {
    const colId = Number(r.IDColoris) || 0
    const avec = Number(r.avec_teinture) || 0
    return {
      stock_id: Number(r.IDstock_fini),
      reference: (r.ref_label ?? '').toString(),
      coloris_reference: (avec === 0 ? washCol.get(colId) : dyeCol.get(colId)) ?? '',
      numero: (r.numero ?? '').toString(), lot: (r.lot ?? '').toString(),
      poids: Number(r.poids) || 0, metrage: Number(r.metrage) || 0,
      second_choix: Number(r.second_choix) || 0,
    }
  })
}

interface AvailableFilLot {
  stock_id: number
  lot: string
  reference: string
  coloris_reference: string
  poids: number
  fournisseur_nom: string
  commentaire: string | null
}

async function loadAvailableFil(sourceId: number, q: string): Promise<AvailableFilLot[]> {
  const like = q ? ` AND (sf.lot LIKE '%${esc(q)}%' OR rf.reference LIKE '%${esc(q)}%' OR f.nom LIKE '%${esc(q)}%')` : ''
  // terminé is accented — cannot be named in SQL on the Linux bridge. Windows
  // names it aliased; the bridge pulls it via sf.* and we resolve by prefix.
  const select = IS_WINDOWS
    ? `sf.IDstock_fil, sf.IDfournisseur, sf.IDref_fil, sf.IDcolori_fil, sf.lot, sf.stock, sf.commentaire, sf.terminé AS termine, rf.reference AS ref_fil, cf.reference AS colori_reference, f.nom AS fournisseur_nom`
    : `sf.*, rf.reference AS ref_fil, cf.reference AS colori_reference, f.nom AS fournisseur_nom`
  const raw = await query<any>(
    `SELECT TOP ${AVAILABLE_CAP * 2} ${select} ` +
      `FROM stock_fil sf ` +
      `LEFT JOIN ref_fil rf ON sf.IDref_fil = rf.IDref_fil ` +
      `LEFT JOIN colori_fil cf ON sf.IDcolori_fil = cf.IDcolori_fil ` +
      `LEFT JOIN fournisseur f ON sf.IDfournisseur = f.IDfournisseur ` +
      `WHERE sf.IDMagasin = ${sourceId}${like} ORDER BY sf.IDstock_fil DESC`,
  )
  let fixed = await fixEncoding(raw, 'stock_fil', 'IDstock_fil', ['lot', 'commentaire'])
  fixed = await repairAliased(fixed, 'ref_fil', 'IDref_fil', { ref_fil: 'reference' })
  fixed = await repairAliased(fixed, 'colori_fil', 'IDcolori_fil', { colori_reference: 'reference' })
  fixed = await repairAliased(fixed, 'fournisseur', 'IDfournisseur', { fournisseur_nom: 'nom' })
  return (fixed as any[])
    .filter((r) => (Number(pickVal(r, /^termin/i)) || 0) === 0)
    .slice(0, AVAILABLE_CAP)
    .map((r) => ({
      stock_id: Number(r.IDstock_fil),
      lot: (r.lot ?? '').toString(),
      reference: (r.ref_fil ?? '').toString(),
      coloris_reference: (r.colori_reference ?? '').toString(),
      poids: Number(r.stock) || 0,
      fournisseur_nom: (r.fournisseur_nom ?? '').toString(),
      commentaire: (r.commentaire ?? '').toString().trim() || null,
    }))
}

transfertsRouter.get('/:kind/:id/available', async (req: Request, res: Response) => {
  try {
    const kind = parseKind(req.params.kind)
    if (!kind) { res.status(404).json({ error: 'Not found' }); return }
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const h = await loadBonHead(kind, id)
    if (!h) { res.status(404).json({ error: 'Bon de transfert introuvable' }); return }
    const q = String(req.query.q ?? '').trim()

    if (kind === 'rouleaux') {
      const [ecru, fini] = await Promise.all([
        loadAvailableEcru(h.IDmagasin_source, q),
        loadAvailableFini(h.IDmagasin_source, q),
      ])
      res.json({ ecru, fini, cap: AVAILABLE_CAP })
      return
    }
    const fil = await loadAvailableFil(h.IDmagasin_source, q)
    res.json({ fil, cap: AVAILABLE_CAP })
  } catch (err) {
    console.error('Error fetching available stock for transfert:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  PIECES — add (bulk) / remove, moving stock immediately
// ════════════════════════════════════════════════════════

const addPiecesBody = z.object({
  type: z.enum(['ecru', 'fini', 'fil']),
  stockIds: z.array(z.number().int().positive()).min(1).max(500),
})

transfertsRouter.put('/:kind/:id/pieces', async (req: Request, res: Response) => {
  try {
    const kind = parseKind(req.params.kind)
    if (!kind) { res.status(404).json({ error: 'Not found' }); return }
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = addPiecesBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const { type, stockIds } = parsed.data
    if ((kind === 'rouleaux') !== (type !== 'fil')) {
      res.status(400).json({ error: 'type_kind_mismatch' })
      return
    }
    const h = await loadBonHead(kind, id)
    if (!h) { res.status(404).json({ error: 'Bon de transfert introuvable' }); return }

    // Re-validate each roll/lot is still at the source and shippable — the UI
    // list may be stale (legacy app shares the data live). Invalid ids are
    // skipped, valid ones applied; the count is reported back.
    const inIds = Array.from(new Set(stockIds)).join(',')
    let validIds: number[] = []
    if (type === 'ecru') {
      const rows = await query<any>(
        `SELECT IDstock_ecru FROM stock_ecru WHERE IDstock_ecru IN (${inIds}) AND IDmagasin = ${h.IDmagasin_source} AND (IDligne_expedition_ETM IS NULL OR IDligne_expedition_ETM = 0)`,
      )
      validIds = rows.map((r: any) => Number(r.IDstock_ecru))
    } else if (type === 'fini') {
      const rows = await query<any>(
        `SELECT IDstock_fini FROM stock_fini WHERE IDstock_fini IN (${inIds}) AND IDmagasin = ${h.IDmagasin_source} AND (IDligne_expedition IS NULL OR IDligne_expedition = 0) AND destockage = 0`,
      )
      validIds = rows.map((r: any) => Number(r.IDstock_fini))
    } else {
      const rows = await query<any>(
        `SELECT IDstock_fil FROM stock_fil WHERE IDstock_fil IN (${inIds}) AND IDMagasin = ${h.IDmagasin_source}`,
      )
      validIds = rows.map((r: any) => Number(r.IDstock_fil))
    }
    if (validIds.length === 0) {
      res.status(409).json({ error: 'no_valid_pieces', message: 'Aucune pièce sélectionnée n’est encore disponible au magasin source.' })
      return
    }

    // Insert the lines, then move the stock to the destination. The pieces are
    // inserted one by one (HFSQL has no multi-row VALUES on this path) — the
    // PK is auto-assigned like ligne_expedition's.
    for (const sid of validIds) {
      const cols = type === 'ecru' ? `${sid}, 0, 0` : type === 'fini' ? `0, ${sid}, 0` : `0, 0, ${sid}`
      await query(`INSERT INTO piece_transfert (IDbon_transfert, IDpiece_ecru, IDpiece_fini, IDstock_fil) VALUES (${id}, ${cols})`)
    }
    const inValid = validIds.join(',')
    if (type === 'ecru') await query(`UPDATE stock_ecru SET IDmagasin = ${h.IDmagasin_destination} WHERE IDstock_ecru IN (${inValid})`)
    else if (type === 'fini') await query(`UPDATE stock_fini SET IDmagasin = ${h.IDmagasin_destination} WHERE IDstock_fini IN (${inValid})`)
    else await query(`UPDATE stock_fil SET IDMagasin = ${h.IDmagasin_destination} WHERE IDstock_fil IN (${inValid})`)

    res.json({ lines: await loadLines(kind, id), added: validIds.length, skipped: stockIds.length - validIds.length })
  } catch (err) {
    console.error('Error adding pieces to transfert:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

transfertsRouter.delete('/:kind/:id/pieces/:pieceId', async (req: Request, res: Response) => {
  try {
    const kind = parseKind(req.params.kind)
    if (!kind) { res.status(404).json({ error: 'Not found' }); return }
    const id = parseInt(req.params.id, 10)
    const pieceId = parseInt(req.params.pieceId, 10)
    if (isNaN(id) || isNaN(pieceId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const h = await loadBonHead(kind, id)
    if (!h) { res.status(404).json({ error: 'Bon de transfert introuvable' }); return }

    const rows = await query<any>(
      `SELECT IDpiece_transfert, IDpiece_ecru, IDpiece_fini, IDstock_fil FROM piece_transfert WHERE IDpiece_transfert = ${pieceId} AND IDbon_transfert = ${id}`,
    )
    if (rows.length === 0) { res.status(404).json({ error: 'Pièce introuvable sur ce bon' }); return }
    const p = rows[0]
    const ecruId = Number(p.IDpiece_ecru) || 0
    const finiId = Number(p.IDpiece_fini) || 0
    const filId = Number(p.IDstock_fil) || 0
    if (ecruId > 0) await query(`UPDATE stock_ecru SET IDmagasin = ${h.IDmagasin_source} WHERE IDstock_ecru = ${ecruId}`)
    else if (finiId > 0) await query(`UPDATE stock_fini SET IDmagasin = ${h.IDmagasin_source} WHERE IDstock_fini = ${finiId}`)
    else if (filId > 0) await query(`UPDATE stock_fil SET IDMagasin = ${h.IDmagasin_source} WHERE IDstock_fil = ${filId}`)
    await query(`DELETE FROM piece_transfert WHERE IDpiece_transfert = ${pieceId}`)

    res.json({ lines: await loadLines(kind, id) })
  } catch (err) {
    console.error('Error removing piece from transfert:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  PDF — Bordereau de livraison
// ════════════════════════════════════════════════════════

export async function buildBonTransfertPdfData(kind: Kind, id: number): Promise<BonTransfertPdfData | null> {
  const h = await loadBonHead(kind, id)
  if (!h) return null
  const [sstNames, transNames, adr, lines] = await Promise.all([
    resolveSstNames([h.IDmagasin_source, h.IDmagasin_destination]),
    resolveTransporteurNames([h.IDtransporteur]),
    loadAdresse(h.IDadresse_destination),
    loadLines(kind, id),
  ])

  const a = adr as any
  const adresseDestination = a
    ? {
        nom: (a.nom ?? null) as string | null,
        adresse1: (a.adresse1 ?? null) as string | null,
        adresse2: (a.adresse2 ?? null) as string | null,
        adresse3: (a.adresse3 ?? null) as string | null,
        cp: (a.cp ?? null) as string | null,
        ville: (a.ville ?? null) as string | null,
        pays: (a.pays ?? null) as string | null,
      }
    : null

  let articles: BtArticle[] = []
  let filRows: BtFilRow[] = []
  if (kind === 'rouleaux') {
    // Group pieces by reference — one gold band per article like the legacy
    // ETAT_Bon_de_transfert ("128/101 : interlock - 100% polyester").
    const byRef = new Map<string, BtArticle>()
    for (const l of lines as RouleauxLine[]) {
      const key = l.reference || '—'
      let art = byRef.get(key)
      if (!art) {
        const sousTitre = [l.designation, l.composition].filter(Boolean).join(' - ')
        art = { titre: key, sousTitre: sousTitre || null, pieces: [] }
        byRef.set(key, art)
      }
      const piece: BtPiece = {
        reference: l.reference, coloris: l.coloris_reference, numero: l.numero,
        lot: l.lot, poids: l.poids, metrage: l.metrage,
      }
      art.pieces.push(piece)
    }
    articles = Array.from(byRef.values())
    for (const art of articles) art.pieces.sort((x, y) => pieceCollator.compare(x.numero, y.numero))
  } else {
    filRows = (lines as FilLine[]).map((l) => ({
      lot: l.lot, reference: l.reference, coloris: l.coloris_reference,
      poids: l.poids, fournisseur: l.fournisseur_nom,
    }))
  }

  return {
    numero: id,
    typeMatiere: kind === 'rouleaux' ? 1 : 2,
    dateLong: formatHfsqlDateLongFr(h.date),
    sourceNom: magasinNom(h.IDmagasin_source, sstNames),
    destinationNom: magasinNom(h.IDmagasin_destination, sstNames),
    transporteurNom: transNames.get(h.IDtransporteur) || null,
    adresseDestination,
    commentaire: h.commentaire,
    articles,
    filRows,
  }
}

export async function renderBonTransfertPdfBuffer(data: BonTransfertPdfData): Promise<Buffer> {
  return renderToBuffer(
    React.createElement(BonTransfertPdf, { data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >,
  )
}

transfertsRouter.get('/:kind/:id/pdf', async (req: Request, res: Response) => {
  try {
    const kind = parseKind(req.params.kind)
    if (!kind) { res.status(404).json({ error: 'Not found' }); return }
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const data = await buildBonTransfertPdfData(kind, id)
    if (!data) { res.status(404).json({ error: 'Bon de transfert introuvable' }); return }
    const buffer = await renderBonTransfertPdfBuffer(data)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="bordereau-transfert-${id}.pdf"`)
    // Allow cross-origin iframe embedding (SendEmailDialog preview).
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.end(buffer)
  } catch (err) {
    console.error('Error rendering bon de transfert PDF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  EMAIL
// ════════════════════════════════════════════════════════

interface EmailRecipientPayload { email: string; name?: string; source: 'contact'; contactId: number }

async function buildTransfertEmailDefaults(kind: Kind, id: number): Promise<{
  recipients: { selected: EmailRecipientPayload[]; suggestions: EmailRecipientPayload[] }
  subject: string
  body: string
  destinationNom: string
} | null> {
  const h = await loadBonHead(kind, id)
  if (!h) return null
  const sstNames = await resolveSstNames([h.IDmagasin_destination])
  const destNom = magasinNom(h.IDmagasin_destination, sstNames)

  // Recipients: contacts of the destination sous-traitant (envoi_bl → selected).
  // Destination 0 = Ets Malterre — no external contacts to preselect.
  const selected: EmailRecipientPayload[] = []
  const suggestions: EmailRecipientPayload[] = []
  if (h.IDmagasin_destination > 0) {
    const contactRows = await query<any>(
      `SELECT IDcontact, nom, prenom, mail, envoi_bl, est_visible FROM contact WHERE IDsous_traitant = ${h.IDmagasin_destination}`,
    )
    const fixed = await fixEncoding(contactRows, 'contact', 'IDcontact', ['nom', 'prenom', 'mail'])
    const seen = new Set<string>()
    for (const c of fixed as any[]) {
      if (c.est_visible === 0) continue
      const raw = (c.mail ?? '').toString().trim()
      if (!raw || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) continue
      const key = raw.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const displayName = [c.prenom, c.nom].map((s: string | null) => (s ?? '').toString().trim()).filter((s: string) => s.length > 0).join(' ')
      const recipient: EmailRecipientPayload = { email: raw, source: 'contact', contactId: Number(c.IDcontact) }
      if (displayName) recipient.name = displayName
      if (c.envoi_bl === 1) selected.push(recipient)
      else suggestions.push(recipient)
    }
  }

  const subject = `Bordereau de livraison N°${id} - ETS Malterre`
  const body =
    `Bonjour,\n\n` +
    `Veuillez trouver ci-joint notre bordereau de livraison N°${id}.\n\n` +
    `Nous restons à votre disposition pour toute information complémentaire.\n\n` +
    `Cordialement,\n` +
    `ETS Malterre`
  return { recipients: { selected, suggestions }, subject, body, destinationNom: destNom }
}

transfertsRouter.get('/:kind/:id/email-defaults', async (req: Request, res: Response) => {
  try {
    const kind = parseKind(req.params.kind)
    if (!kind) { res.status(404).json({ error: 'Not found' }); return }
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const defaults = await buildTransfertEmailDefaults(kind, id)
    if (!defaults) { res.status(404).json({ error: 'Bon de transfert introuvable' }); return }
    res.json(defaults)
  } catch (err) {
    console.error('Error building transfert email defaults:', err)
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
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(20000),
  attach_pdf: z.boolean().optional(),
  extra_attachments: z.array(extraAttachmentSchema).optional(),
  dev_skip_send: z.boolean().optional(),
})
const ALLOW_DEV_SKIP_SEND = process.env.NODE_ENV !== 'production'

transfertsRouter.post('/:kind/:id/email', async (req: Request, res: Response) => {
  try {
    const kind = parseKind(req.params.kind)
    if (!kind) { res.status(404).json({ error: 'Not found' }); return }
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    const parsed = emailBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const devSkip = parsed.data.dev_skip_send === true && ALLOW_DEV_SKIP_SEND

    let messageId: string
    if (devSkip) {
      messageId = `dev-skip-${Date.now()}`
      console.log(`[dev-skip-send] transfert ${kind} #${id} — fake send to ${parsed.data.to.join(', ')}`)
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
      const fixedUser = await fixEncoding(userRows, 'utilisateur', 'IDutilisateur', ['prenom', 'nom'])
      const u = (fixedUser[0] as any) ?? null
      const displayName = u ? [u.prenom, u.nom].filter((s: string | null) => s && s.trim()).map((s: string) => s.trim()).join(' ') : ''
      const fromName = displayName ? `${displayName} - ETS Malterre` : 'ETS Malterre'

      const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = []
      if (parsed.data.attach_pdf !== false) {
        const data = await buildBonTransfertPdfData(kind, id)
        if (!data) { res.status(404).json({ error: 'Bon de transfert introuvable' }); return }
        attachments.push({ filename: `bordereau-transfert-${id}.pdf`, content: await renderBonTransfertPdfBuffer(data), contentType: 'application/pdf' })
      }
      for (const a of parsed.data.extra_attachments ?? []) {
        attachments.push({ filename: a.filename, content: Buffer.from(a.content_base64, 'base64'), contentType: a.content_type })
      }
      messageId = await sendMail({
        from: senderEmail, fromName, to: parsed.data.to, cc: parsed.data.cc,
        subject: parsed.data.subject, body: parsed.data.body,
        attachments: attachments.length > 0 ? attachments : undefined,
      })
    }

    // No envoi_email audit row: the legacy type_doc catalog has no "bon de
    // transfert" entry, and inventing one would collide with legacy views.
    res.json({ ok: true, messageId })
  } catch (err) {
    console.error('Error sending transfert email:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    res.status(500).json({ error: 'send_failed', message })
  }
})
