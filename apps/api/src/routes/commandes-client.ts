// Commandes client — customer orders (commande_client / ligne_commande_client).
// The central client-facing screen: manage orders and RESERVE finished/écru
// stock rolls to each order line (the "Stock Affecté à la commande" ↔ "Stock
// disponible" affectation). Mirrors the structure of commandes-sous-traitant.ts
// but for the ETM client ledger — there is NO TRM cross-ledger mirror here
// (the sst route writes INTO commande_client; this route IS that table).
//
// Hard rules baked in (verified against live data + CLAUDE.md HFSQL section):
//  - ETM scope: every read/write is IDsociete = 1 AND IDcommande_ETM = 0
//    (IDsociete=2 rows are TRM mirrors, owned by the sister-company view).
//  - numero allocator: MAX(numero)+1 WHERE IDsociete=1, with a retry loop.
//  - Accented commande_client columns (archivé/expedié/envoyé_client) and
//    ligne columns (delai_annoncé/déverrouiller) are NEVER named in SQL — the
//    Linux iODBC bridge can't tokenize them. SELECT * + prune for reads;
//    omit on writes (HFSQL zero-fills).
//  - `SELECT * FROM client` returns 0 rows on this driver — explicit columns only.
//  - ligne_commande_client.TYPE is a reserved word (alias `TYPE AS type_kind`,
//    write uppercase) and IDcolori is lowercase (not IDColoris).
//  - Line polymorphism: type 1 = écru (ref_ecru + colori_ecru), 2 = fini
//    (ref_fini + coloris by avec_teinture), 3 = divers (ref_divers, display-only).
//  - unite enum: 1 = Kg (poids), 3 = Ml (metrage), 4 = U, 5 = m². The
//    affectation gauge sums poids for Kg lines, metrage for Ml lines.
//  - Reservation pointer: stock_ecru.IDligne_commande_client /
//    stock_fini.IDligne_commande_client (distinct from the sst affectation).

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import multer from 'multer'
import { renderToBuffer } from '@react-pdf/renderer'
import React from 'react'
import { query, queryRaw, fixEncoding } from '../lib/hfsql-auto.js'
import { CommandeClientPdf, type CommandeClientPdfData } from '../lib/pdf/CommandeClientPdf.js'
import { FacturePdf, type FacturePdfData } from '../lib/pdf/FacturePdf.js'
import { CgvPdf } from '../lib/pdf/CgvPdf.js'
import { ValeurDonationPdf } from '../lib/pdf/ValeurDonationPdf.js'
import { buildDonationValeurData, type DonationValeurPdfData } from '../lib/donation-valeur.js'
import { calcLignePriceClient, expiredContractMessage } from '../lib/pricing-ligne-client.js'
import { resolveLigneTarifMode } from '../lib/tarif-client.js'
import { calcTarifSST } from '../lib/pricing-sst.js'
import { loadClientTvaRate } from '../lib/tva.js'
import { sendMail } from '../lib/gmail.js'
import { getUserEmail } from '../lib/user-emails.js'
import { stripRtf, wrapRtf } from '../lib/rtf-utils.js'
import { userHasPermission } from '../lib/permissions.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { IS_WINDOWS, esc, n, dateDigits as dateStr, addWorkingDays } from '../lib/sst-shared.js'
import { createKnitOrder, TRICOTAGE_MALTERRE_ID } from './commandes-sous-traitant.js'
import { computeDateEcheance, loadEcheanceRule } from './factures.js'
import { repairAliased, repairAllJoins } from './stock-fini.js'
import { fetchDefectsByEcru, defautSummary } from './stock-ecru.js'
import { adjustDiversStock, loadDiversItems, type DiversItem } from './expeditions.js'

const upload = multer({ storage: multer.memoryStorage() })
export const commandesClientRouter: RouterType = Router()

// type_doc 7 = "commande client" — the bon de commande type for the
// envoi_email audit log and the ged document allowlist (verified live).
const TYPE_DOC_COMMANDE_CLIENT = 7

// ── Small SQL/format helpers (copied from commandes-sous-traitant.ts) ──

/** SQL literal for a user-supplied text value. Pure ASCII → quoted literal;
 *  anything with accents → Latin-1 hex literal (the Linux iODBC bridge
 *  corrupts raw multi-byte UTF-8 embedded in a SQL line). */
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
  const bytes = Buffer.from(
    Array.from(ascii, (ch) => {
      const c = ch.codePointAt(0) ?? 0x3f
      return c <= 0xff ? c : 0x3f
    }),
  )
  return `x'${bytes.toString('hex')}'`
}

function nowHfsqlDatetime(): string {
  const d = new Date()
  const pad = (x: number, w = 2) => String(x).padStart(w, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${pad(d.getMilliseconds(), 3)}`
  )
}

const FRENCH_MONTHS = [
  'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
] as const

function formatHfsqlDateLongFr(raw: string | null | undefined): string {
  if (!raw) return ''
  const s = String(raw)
  if (!/^\d{8}$/.test(s)) return ''
  const day = parseInt(s.slice(6, 8), 10)
  const month = parseInt(s.slice(4, 6), 10)
  const year = s.slice(0, 4)
  if (month < 1 || month > 12) return ''
  return `${day} ${FRENCH_MONTHS[month - 1]} ${year}`
}

function formatHfsqlDateFr(raw: string | null | undefined): string {
  if (!raw) return ''
  const s = String(raw)
  if (/^\d{8}$/.test(s)) return `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`
  return ''
}

function cleanAddrField(s: string | null | undefined): string | null {
  if (!s) return null
  const t = String(s).trim()
  if (!t) return null
  if (/^[.\-_·•\s]+$/.test(t)) return null
  return t
}

/** Decode an ODBC value (ArrayBuffer / string) to a JS string. */
function decode(v: unknown): string | null {
  if (v instanceof ArrayBuffer) return Buffer.from(v).toString('utf8')
  if (typeof v === 'string') return v
  return null
}

/** Normalise for accent-insensitive contains-matching (search). */
function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

// ── Line unit + dimension semantics ──────────────────────
// unite enum (hardcoded WinDev combo; no lookup table). Verified empirically:
// Kg lines track stock poids, Ml lines track stock metrage.

function uniteLabel(u: number | null | undefined): string {
  switch (Number(u)) {
    case 1: return 'Kg'
    case 3: return 'Ml'
    case 4: return 'unité'
    case 5: return 'm²'
    default: return ''
  }
}

/** Which roll dimension a line's quantite is measured in. */
function lineDim(unite: number | null | undefined): 'metrage' | 'poids' {
  return Number(unite) === 3 ? 'metrage' : 'poids'
}

/** Roll kind a line reserves: type 1 → écru, type 2 → fini, else none. */
function lineStockKind(typeKind: number): 'ecru' | 'fini' | 'none' {
  if (typeKind === 1) return 'ecru'
  if (typeKind === 2) return 'fini'
  return 'none'
}

// ── Lifecycle helpers ────────────────────────────────────

async function loadCommandeSoldee(commandeId: number): Promise<number | null> {
  const rows = await query<{ est_soldee: number | null }>(
    `SELECT est_soldee FROM commande_client WHERE IDcommande_client = ${commandeId}`,
  )
  if (rows.length === 0) return null
  return rows[0].est_soldee ?? 0
}

async function loadCommandeIdForLine(lineId: number): Promise<number | null> {
  const rows = await query<{ IDcommande_client: number }>(
    `SELECT IDcommande_client FROM ligne_commande_client WHERE IDligne_commande_client = ${lineId}`,
  )
  if (rows.length === 0) return null
  return Number(rows[0].IDcommande_client) || null
}

function refuseIfSoldee(res: Response, est_soldee: number | null): boolean {
  if (est_soldee === 1) {
    res.status(409).json({
      error: 'commande_soldee',
      message: 'Commande soldée — rouvrir la commande pour la modifier.',
    })
    return true
  }
  return false
}

/** Next numero for the ETM client ledger (IDsociete=1). Legacy data has gaps,
 *  so MAX+1 matches the allocator; concurrent POSTs retry on collision. */
async function nextNumero(): Promise<number> {
  const r = await query<{ m: number | null }>(
    `SELECT MAX(numero) AS m FROM commande_client WHERE IDsociete = 1`,
  )
  return (Number(r[0]?.m) || 0) + 1
}

// ── Phase model ──────────────────────────────────────────
// A client order is simpler than the sst computed phase (no per-line sstatut):
//   terminee   — est_soldee = 1 (the sidebar footer pill flips this)
//   partielle  — open AND at least one line has rolls reserved to it
//   a_affecter — open AND no rolls reserved yet
// `est_soldee` remains the sole write gate (refuseIfSoldee).

export type ClientPhase = 'a_affecter' | 'partielle' | 'terminee'

/** Set of commande ids that have at least one reserved roll on any line. */
async function ordersWithReservedRolls(commandeIds: number[]): Promise<Set<number>> {
  const out = new Set<number>()
  const ids = commandeIds.filter((x) => x > 0)
  if (ids.length === 0) return out
  // Map every line → its commande, then check both stock tables for rolls
  // reserved to those lines (IDligne_commande_client). Flat queries only.
  const lineRows = await query<{ IDligne_commande_client: number; IDcommande_client: number }>(
    `SELECT IDligne_commande_client, IDcommande_client FROM ligne_commande_client
     WHERE IDcommande_client IN (${ids.join(',')})`,
  )
  const cmdByLine = new Map<number, number>()
  for (const r of lineRows) cmdByLine.set(Number(r.IDligne_commande_client), Number(r.IDcommande_client))
  const lineIds = Array.from(cmdByLine.keys()).filter((x) => x > 0)
  if (lineIds.length === 0) return out
  const inList = lineIds.join(',')
  const [ecru, fini] = await Promise.all([
    query<{ IDligne_commande_client: number }>(
      `SELECT DISTINCT IDligne_commande_client FROM stock_ecru WHERE IDligne_commande_client IN (${inList})`,
    ),
    query<{ IDligne_commande_client: number }>(
      `SELECT DISTINCT IDligne_commande_client FROM stock_fini WHERE IDligne_commande_client IN (${inList})`,
    ),
  ])
  for (const r of [...ecru, ...fini]) {
    const cmd = cmdByLine.get(Number(r.IDligne_commande_client))
    if (cmd && cmd > 0) out.add(cmd)
  }
  return out
}

async function computePhasesBatch(
  orders: Array<{ id: number; est_soldee: number }>,
): Promise<Map<number, ClientPhase>> {
  const out = new Map<number, ClientPhase>()
  const openIds = orders.filter((o) => o.est_soldee !== 1).map((o) => o.id)
  const reserved = await ordersWithReservedRolls(openIds)
  for (const o of orders) {
    if (o.est_soldee === 1) out.set(o.id, 'terminee')
    else out.set(o.id, reserved.has(o.id) ? 'partielle' : 'a_affecter')
  }
  return out
}

// ── Client name resolution (batched, flat — never SELECT *) ──

async function resolveClientNames(clientIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const ids = Array.from(new Set(clientIds.filter((x) => x > 0)))
  if (ids.length === 0) return out
  const rows = await query<{ IDclient: number; nom: string | null }>(
    `SELECT IDclient, nom FROM client WHERE IDclient IN (${ids.join(',')})`,
  )
  const fixed = await fixEncoding(rows, 'client', 'IDclient', ['nom'])
  for (const r of fixed) out.set(Number(r.IDclient), (r.nom ?? '').toString().trim())
  return out
}

// ── Validation schemas ───────────────────────────────────

const commandeBody = z.object({
  IDclient: z.number().int().positive().optional(),
  date_commande: z.string().optional(),
  ref_client: z.string().optional(),
  IDadresse_livraison: z.number().int().nonnegative().optional(),
  IDadresse_facturation: z.number().int().nonnegative().optional(),
  IDmode_paiement: z.number().int().nonnegative().optional(),
  IDecheance: z.number().int().nonnegative().optional(),
  commentaire: z.string().optional(),
  commentaire_interne: z.string().optional(),
  remise: z.number().optional(),
  frais_port: z.number().optional(),
  est_soldee: z.number().int().min(0).max(1).optional(),
  donation: z.number().int().min(0).max(1).optional(),
})

const ligneBody = z.object({
  type: z.number().int().optional(),
  IDreference: z.number().int().nonnegative().optional(),
  IDcolori: z.number().int().nonnegative().optional(),
  // Divers (type 3) only: the two variation axes of ref_divers
  // (sTypeVariation1/2 — Couleur / Taille / Reference). Together with
  // IDreference they identify the exact article the line ships.
  IDVariation1: z.number().int().nonnegative().optional(),
  IDVariation2: z.number().int().nonnegative().optional(),
  quantite: z.number().optional(),
  unite: z.number().int().optional(),
  prix: z.number().optional(),
  poids: z.number().optional(),
  date_livraison: z.string().optional(),
  commentaire: z.string().optional(),
})

// ════════════════════════════════════════════════════════
//  LOOKUPS  (literal paths — must register before /:id)
// ════════════════════════════════════════════════════════

// Clients — explicit columns (SELECT * fails on this table), est_visible only
// (the IDsociete partition is not used to filter clients — verified live).
commandesClientRouter.get('/lookups/clients', async (_req: Request, res: Response) => {
  try {
    // ETM scope — client is partitioned by IDsociete (1=ETM, 2=TRM, 3=Confection);
    // without this the picker leaks the sister companies' clients into the ETM list.
    const rows = await query<{ IDclient: number; nom: string | null; IDmode_paiement: number | null; IDecheance: number | null }>(
      `SELECT IDclient, nom, IDmode_paiement, IDecheance FROM client WHERE est_visible = 1 AND IDsociete = 1 ORDER BY nom`,
    )
    const fixed = await fixEncoding(rows, 'client', 'IDclient', ['nom'])
    res.json(fixed.map((r) => ({
      IDclient: Number(r.IDclient),
      nom: (r.nom ?? '').toString(),
      // Client-sheet defaults — prefill the new-order modal's payment fields.
      IDmode_paiement: Number(r.IDmode_paiement) || 0,
      IDecheance: Number(r.IDecheance) || 0,
    })))
  } catch (err) {
    console.error('Error fetching clients lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Addresses for a client (delivery + billing pickers).
commandesClientRouter.get('/lookups/adresses', async (req: Request, res: Response) => {
  try {
    const cid = parseInt(String(req.query.client ?? ''), 10)
    if (isNaN(cid)) { res.status(400).json({ error: 'client query parameter required' }); return }
    const rows = await query(
      `SELECT IDadresse, nom, adresse1, adresse2, adresse3, cp, ville, pays,
              est_defaut, est_defaut_facturation, est_defaut_livraison
       FROM adresse
       WHERE IDclient = ${cid} AND (est_visible IS NULL OR est_visible = 1)
       ORDER BY est_defaut DESC, IDadresse`,
    )
    const fixed = await fixEncoding(rows, 'adresse', 'IDadresse', [
      'nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays',
    ])
    res.json(fixed)
  } catch (err) {
    console.error('Error fetching adresses lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Resolve the set of references a client is allowed to order, from
// designation_client (the legacy per-client product catalog). Each row ties a
// client to EITHER an IDref_fini OR an IDref_ecru. `archivé`/`caché` are accented
// columns — never name them in SQL (the Linux bridge storms on accented
// identifiers); SELECT * + prune in JS via pickKey (case-insensitive prefix).
function pickKey(row: Record<string, unknown>, re: RegExp): unknown {
  const k = Object.keys(row).find((key) => re.test(key))
  return k ? row[k] : undefined
}
async function assignedRefIds(clientId: number, col: 'IDref_fini' | 'IDref_ecru'): Promise<number[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM designation_client WHERE IDclient = ${clientId} AND ${col} > 0`,
  )
  const ids = new Set<number>()
  for (const r of rows) {
    if (Number(pickKey(r, /^archiv/i)) === 1) continue // archivé
    if (Number(pickKey(r, /^cach/i)) === 1) continue   // caché
    const id = Number(r[col])
    if (id > 0) ids.add(id)
  }
  return [...ids]
}

/** The coloris a client buys on a reference — its `ref_client_colori` rows under
 *  the (non archived, non caché) designation_client entries for that ref.
 *
 *  Returns BOTH coloris columns because which one holds the id depends on the
 *  ref (project_avec_teinture_coloris_rule: dyed refs use `IDref_fini_colori`,
 *  washed ones `IDcolori_ecru`) and legacy rows do not always follow the rule.
 *  The caller decides by intersecting with the list it is actually showing —
 *  see `scopeColoris`. */
async function clientColorisIds(
  clientId: number, kind: 1 | 2, refId: number,
): Promise<{ expected: Set<number>; other: Set<number> }> {
  const expectedIds = new Set<number>()
  const otherIds = new Set<number>()
  if (!(clientId > 0) || !(refId > 0)) return { expected: expectedIds, other: otherIds }
  const refCol = kind === 1 ? 'IDref_ecru' : 'IDref_fini'
  const dRows = await query<Record<string, unknown>>(
    `SELECT * FROM designation_client WHERE IDclient = ${clientId} AND ${refCol} = ${refId}`,
  )
  const dIds = dRows
    .filter((r) => Number(pickKey(r, /^archiv/i)) !== 1 && Number(pickKey(r, /^cach/i)) !== 1)
    .map((r) => Number(r.IDdesignation_client))
    .filter((n) => n > 0)
  if (dIds.length === 0) return { expected: expectedIds, other: otherIds }

  const rccRows = await query<Record<string, unknown>>(
    `SELECT * FROM ref_client_colori WHERE IDdesignation_client IN (${dIds.join(',')})`,
  )
  const active = rccRows.filter((r) => Number(pickKey(r, /^archiv/i)) !== 1)
  let expectedCol: 'IDref_fini_colori' | 'IDcolori_ecru' = 'IDcolori_ecru'
  if (kind === 2) {
    const fRows = await query<{ avec_teinture: number | null }>(
      `SELECT avec_teinture FROM ref_fini WHERE IDref_fini = ${refId}`,
    )
    expectedCol = (Number(fRows[0]?.avec_teinture) || 0) !== 0 ? 'IDref_fini_colori' : 'IDcolori_ecru'
  }
  const otherCol = expectedCol === 'IDref_fini_colori' ? 'IDcolori_ecru' : 'IDref_fini_colori'
  for (const r of active) {
    const a = Number(r[expectedCol]) || 0; if (a > 0) expectedIds.add(a)
    const b = Number(r[otherCol]) || 0; if (b > 0) otherIds.add(b)
  }
  return { expected: expectedIds, other: otherIds }
}

/** Narrow a coloris list to the client's catalogue.
 *
 *  Three states, and the last two both fall back to the full list rather than
 *  handing the user an empty picker — a catalogue gap must never make a
 *  reference unorderable:
 *   • catalogue usable        → only its coloris, plus `current` if outside it;
 *   • no catalogue at all     → everything, every row flagged (13 of the 2 025
 *                               live fini entries have no ref_client_colori);
 *   • catalogue that matches   → same fallback. Real case: client 202 / ref 1426
 *     nothing on this list       registers écru coloris of a ref_ecru the fini
 *                                no longer points at, so the two id sets are
 *                                disjoint and strict filtering emptied the list.
 *
 *  `current` (the coloris an existing line already carries) is always kept and
 *  flagged, so editing an old line never blanks its coloris — 381 of the 7 062
 *  legacy lines sit outside the catalogue they were entered from. */
function scopeColoris<T extends { id: number }>(
  rows: T[], sets: { expected: Set<number>; other: Set<number> }, current: number,
): (T & { hors_catalogue: boolean })[] {
  const hits = (s: Set<number>) => rows.filter((r) => s.has(r.id)).length
  const allowed = hits(sets.expected) > 0 ? sets.expected : hits(sets.other) > 0 ? sets.other : null
  if (!allowed) return rows.map((r) => ({ ...r, hors_catalogue: true }))
  return rows
    .filter((r) => allowed.has(r.id) || (current > 0 && r.id === current))
    .map((r) => ({ ...r, hors_catalogue: !allowed.has(r.id) }))
}

// Écru references (type-1 lines). When `client` is given, restrict to the refs
// assigned to that client in designation_client (the buyable catalogue).
commandesClientRouter.get('/lookups/refs-ecru', async (req: Request, res: Response) => {
  try {
    const cid = parseInt(String(req.query.client ?? ''), 10)
    let idFilter = ''
    if (!isNaN(cid) && cid > 0) {
      const ids = await assignedRefIds(cid, 'IDref_ecru')
      if (ids.length === 0) { res.json([]); return }
      idFilter = `WHERE IDref_ecru IN (${ids.join(',')})`
    }
    const rows = await query<{ IDref_ecru: number; reference: string | null; designation: string | null }>(
      `SELECT IDref_ecru, reference, designation FROM ref_ecru ${idFilter} ORDER BY reference`,
    )
    const fixed = await fixEncoding(rows, 'ref_ecru', 'IDref_ecru', ['reference', 'designation'])
    res.json(fixed.map((r) => ({ IDref_ecru: Number(r.IDref_ecru), reference: r.reference ?? '', designation: r.designation ?? '' })))
  } catch (err) {
    console.error('Error fetching refs-ecru lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Coloris of an écru ref. With `client`, the list is narrowed to the coloris
// that client buys on it (Clients › Gestion), because a reference can carry
// hundreds of coloris made for OTHER customers — picking one of those is how a
// line ends up ordering a colour this client never bought.
// Without `client` the full list is returned, which is what Clients › Gestion
// itself needs (it is the screen where the catalogue is built).
commandesClientRouter.get('/lookups/colori-ecru', async (req: Request, res: Response) => {
  try {
    const refEcru = parseInt(String(req.query.ref_ecru ?? ''), 10)
    const cid = parseInt(String(req.query.client ?? ''), 10) || 0
    const current = parseInt(String(req.query.current ?? ''), 10) || 0
    // colori_ecru fails on SELECT *; explicit columns. Filter by ref when given.
    const where = !isNaN(refEcru) && refEcru > 0 ? `WHERE IDref_ecru = ${refEcru}` : ''
    const rows = await query<{ IDcolori_ecru: number; reference: string | null }>(
      `SELECT IDcolori_ecru, reference FROM colori_ecru ${where} ORDER BY reference`,
    )
    const fixed = await fixEncoding(rows, 'colori_ecru', 'IDcolori_ecru', ['reference'])
    const mapped = fixed.map((r) => ({ id: Number(r.IDcolori_ecru), reference: r.reference ?? '' }))
    if (cid > 0 && refEcru > 0) {
      const allowed = await clientColorisIds(cid, 1, refEcru)
      res.json(scopeColoris(mapped, allowed, current).map((r) => ({
        IDcolori_ecru: r.id, reference: r.reference, hors_catalogue: r.hors_catalogue,
      })))
      return
    }
    res.json(mapped.map((r) => ({ IDcolori_ecru: r.id, reference: r.reference })))
  } catch (err) {
    console.error('Error fetching colori-ecru lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Finished references (type-2 lines) — carry avec_teinture so the FE picks the
// correct coloris catalog.
commandesClientRouter.get('/lookups/refs-fini', async (req: Request, res: Response) => {
  try {
    // ref_fini supports SELECT of explicit columns; archivé is accented so we
    // never name it — prune archived rows in JS via a SELECT *-free read.
    // When `client` is given, restrict to the refs assigned to that client in
    // designation_client (the buyable catalogue).
    const cid = parseInt(String(req.query.client ?? ''), 10)
    let idFilter = ''
    if (!isNaN(cid) && cid > 0) {
      const ids = await assignedRefIds(cid, 'IDref_fini')
      if (ids.length === 0) { res.json([]); return }
      idFilter = `WHERE IDref_fini IN (${ids.join(',')})`
    }
    const rows = await query<{
      IDref_fini: number; reference: string | null; designation: string | null; avec_teinture: number | null
    }>(
      `SELECT IDref_fini, reference, designation, avec_teinture FROM ref_fini ${idFilter} ORDER BY reference`,
    )
    const fixed = await fixEncoding(rows, 'ref_fini', 'IDref_fini', ['reference', 'designation'])
    res.json(fixed.map((r) => ({
      IDref_fini: Number(r.IDref_fini),
      reference: r.reference ?? '',
      designation: r.designation ?? '',
      avec_teinture: Number(r.avec_teinture) || 0,
    })))
  } catch (err) {
    console.error('Error fetching refs-fini lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Coloris for a ref_fini — branch on avec_teinture (0 = colori_ecru of the
// ref's IDref_ecru, 1/2 = ref_fini_colori). Returned id goes into IDcolori.
// `client` narrows the list to that client's catalogue, `current` keeps an
// existing line's coloris visible — see /lookups/colori-ecru above.
commandesClientRouter.get('/lookups/colori-fini', async (req: Request, res: Response) => {
  try {
    const refFini = parseInt(String(req.query.ref_fini ?? ''), 10)
    if (isNaN(refFini) || refFini <= 0) { res.status(400).json({ error: 'ref_fini query parameter required' }); return }
    const cid = parseInt(String(req.query.client ?? ''), 10) || 0
    const current = parseInt(String(req.query.current ?? ''), 10) || 0
    const refRows = await query<{ avec_teinture: number | null; IDref_ecru: number | null }>(
      `SELECT avec_teinture, IDref_ecru FROM ref_fini WHERE IDref_fini = ${refFini}`,
    )
    const avecTeinture = Number(refRows[0]?.avec_teinture) || 0
    let mapped: { id: number; reference: string }[]
    if (avecTeinture === 0) {
      const idEcru = Number(refRows[0]?.IDref_ecru) || 0
      const rows = await query<{ IDcolori_ecru: number; reference: string | null }>(
        `SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDref_ecru = ${idEcru} ORDER BY reference`,
      )
      const fixed = await fixEncoding(rows, 'colori_ecru', 'IDcolori_ecru', ['reference'])
      mapped = fixed.map((r) => ({ id: Number(r.IDcolori_ecru), reference: r.reference ?? '' }))
    } else {
      const rows = await query<{ IDref_fini_colori: number; reference: string | null }>(
        `SELECT IDref_fini_colori, reference FROM ref_fini_colori WHERE IDref_fini = ${refFini} ORDER BY reference`,
      )
      const fixed = await fixEncoding(rows, 'ref_fini_colori', 'IDref_fini_colori', ['reference'])
      mapped = fixed.map((r) => ({ id: Number(r.IDref_fini_colori), reference: r.reference ?? '' }))
    }
    if (cid > 0) {
      const allowed = await clientColorisIds(cid, 2, refFini)
      res.json(scopeColoris(mapped, allowed, current))
      return
    }
    res.json(mapped)
  } catch (err) {
    console.error('Error fetching colori-fini lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Divers references (type-3 lines).
commandesClientRouter.get('/lookups/refs-divers', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDref_divers: number; designation: string | null; unite: number | null }>(
      `SELECT IDref_divers, designation, unite FROM ref_divers ORDER BY designation`,
    )
    const fixed = await fixEncoding(rows, 'ref_divers', 'IDref_divers', ['designation'])
    res.json(fixed.map((r) => ({
      IDref_divers: Number(r.IDref_divers),
      designation: r.designation ?? '',
      unite: Number(r.unite) || 0,
    })))
  } catch (err) {
    console.error('Error fetching refs-divers lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesClientRouter.get('/lookups/modes-paiement', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDmode_paiement: number; libelle: string | null }>(
      `SELECT IDmode_paiement, libelle FROM mode_paiement WHERE est_visible = 1 ORDER BY libelle`,
    )
    const fixed = await fixEncoding(rows, 'mode_paiement', 'IDmode_paiement', ['libelle'])
    res.json(fixed.map((r) => ({ IDmode_paiement: Number(r.IDmode_paiement), libelle: r.libelle ?? '' })))
  } catch (err) {
    console.error('Error fetching modes-paiement lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesClientRouter.get('/lookups/echeances', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDecheance: number; libelle: string | null }>(
      `SELECT IDecheance, libelle FROM echeance WHERE est_visible = 1 ORDER BY IDecheance`,
    )
    const fixed = await fixEncoding(rows, 'echeance', 'IDecheance', ['libelle'])
    res.json(fixed.map((r) => ({ IDecheance: Number(r.IDecheance), libelle: r.libelle ?? '' })))
  } catch (err) {
    console.error('Error fetching echeances lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Auto-price + roll-count note for a line being entered (PrixDeVenteV4 port).
// Returns the suggested unit price and the roll geometry so the form can show the
// "N Rouleaux (X Ml)" indicator. Never throws — unpriceable inputs come back with
// priceable=false so the UI just falls back to manual entry.
//
// `client` is REQUIRED in practice: the price a client pays depends on its tarif
// mode for that (référence × coloris) — contrat négocié, coefficient fixe, or the
// standard grid — and an expired contract comes back `blocked` so the form can
// refuse the line. Omitting it prices standard, which is what a client with no
// negotiated tarif pays anyway.
commandesClientRouter.get('/lookups/line-price', async (req: Request, res: Response) => {
  try {
    const type = parseInt(String(req.query.type ?? ''), 10) || 0
    const IDreference = parseInt(String(req.query.ref ?? ''), 10) || 0
    const IDcolori = parseInt(String(req.query.coloris ?? ''), 10) || 0
    const quantite = Number(req.query.quantite ?? 0) || 0
    const unite = parseInt(String(req.query.unite ?? ''), 10) || 0
    const IDclient = parseInt(String(req.query.client ?? ''), 10) || 0
    const result = await calcLignePriceClient({ type, IDreference, IDcolori, quantite, unite, IDclient })
    res.json({ ...result, unite_label: uniteLabel(unite) })
  } catch (err) {
    console.error('Error computing line price:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  URGENCY  (header pills: late / soon, deadline = earliest open-line date)
// ════════════════════════════════════════════════════════

async function computeUrgencyBuckets(): Promise<{ late: Set<number>; soon: Set<number> }> {
  const late = new Set<number>()
  const soon = new Set<number>()
  const openRows = await query<{ IDcommande_client: number }>(
    `SELECT IDcommande_client FROM commande_client
     WHERE IDsociete = 1 AND IDcommande_ETM = 0 AND est_soldee = 0`,
  )
  const openIds = openRows.map((r) => Number(r.IDcommande_client)).filter((x) => x > 0)
  if (openIds.length === 0) return { late, soon }

  // Earliest line delivery deadline per open commande.
  const lineRows = await query<{ IDcommande_client: number; date_livraison: string | null }>(
    `SELECT IDcommande_client, date_livraison FROM ligne_commande_client
     WHERE IDcommande_client IN (${openIds.join(',')})`,
  )
  const earliest = new Map<number, string | null>()
  for (const id of openIds) earliest.set(id, null)
  for (const l of lineRows) {
    const cid = Number(l.IDcommande_client)
    const dl = typeof l.date_livraison === 'string' ? l.date_livraison : ''
    if (!/^\d{8}$/.test(dl)) continue
    const prev = earliest.get(cid) ?? null
    if (prev === null || dl < prev) earliest.set(cid, dl)
  }

  const today = new Date(); today.setHours(0, 0, 0, 0)
  for (const id of openIds) {
    const e = earliest.get(id) ?? null
    if (!e) { late.add(id); continue } // no valid deadline = data problem → red
    const target = new Date(Number(e.slice(0, 4)), Number(e.slice(4, 6)) - 1, Number(e.slice(6, 8)))
    target.setHours(0, 0, 0, 0)
    const diff = Math.round((target.getTime() - today.getTime()) / 86_400_000)
    if (diff <= 0) late.add(id)
    else if (diff <= 3) soon.add(id)
  }
  return { late, soon }
}

// ── GET /api/commandes-client/du-jour?date=YYYYMMDD ──────────────────
// "Commandes du jour" dashboard widget: the client orders taken on a given day
// (today by default) and what they represent in chiffre d'affaires.
//
// MUST stay declared before '/:id' or "du-jour" is captured as an id.
//
// Money, so it is permission-gated on the API too (like /rapports/ca-*): the
// widget being hidden is not a control, and this endpoint exposes per-client
// order values.
//
// An order's value is Σ(quantite × prix) over its lines — the same plain
// product `commandes-client.ts` already uses for a line's `montant`. (The
// caveat that bites sst ennoblisseur lines, where quantite is Ml and prix is
// €/Kg, does NOT apply here: client lines price their own unit.)
const DU_JOUR_MAX = 100

commandesClientRouter.get('/du-jour', async (req: Request, res: Response) => {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' }); return
  }
  const allowed = await userHasPermission(
    req.userId, isEffectiveAdmin(req), 'dashboard_commandes_jour',
  )
  if (!allowed) {
    res.status(403).json({ error: 'permission denied: dashboard_commandes_jour' }); return
  }

  // `?date=` exists so the day is testable and so a future "hier" control is a
  // query change, not an endpoint change. Anything malformed falls back to today.
  const raw = String(req.query.date ?? '').replace(/\D/g, '')
  const now = new Date()
  const today = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  const date = raw.length === 8 ? raw : today

  try {
    // commande_client carries accented columns (archivé, expedié, envoyé_client)
    // — name only the ASCII ones.
    const cmds = await query<{
      IDcommande_client: number; IDclient: number; numero: number | null
      donation: number; est_soldee: number
    }>(
      `SELECT TOP ${DU_JOUR_MAX} IDcommande_client, IDclient, numero, donation, est_soldee
       FROM commande_client
       WHERE date_commande = '${esc(date)}' AND IDsociete = 1 AND IDcommande_ETM = 0
       ORDER BY IDcommande_client DESC`,
    )

    // When there's nothing today, say when the last order actually was rather
    // than leaving the user wondering whether the widget is broken.
    let lastOrderDate: string | null = null
    if (cmds.length === 0) {
      const last = await query<{ date_commande: string | null }>(
        `SELECT TOP 1 date_commande FROM commande_client
         WHERE IDsociete = 1 AND IDcommande_ETM = 0 AND date_commande <> '' AND date_commande < '${esc(date)}'
         ORDER BY date_commande DESC`,
      )
      lastOrderDate = (last[0]?.date_commande ?? null) as string | null
    }

    const ids = cmds.map((c) => Number(c.IDcommande_client)).filter((x) => x > 0)
    const montantByCmd = new Map<number, number>()
    if (ids.length > 0) {
      const lignes = await query<{ IDcommande_client: number; quantite: number | null; prix: number | null }>(
        `SELECT IDcommande_client, quantite, prix FROM ligne_commande_client
         WHERE IDcommande_client IN (${ids.join(',')})`,
      )
      for (const l of lignes) {
        const k = Number(l.IDcommande_client)
        montantByCmd.set(k, (montantByCmd.get(k) ?? 0) + (Number(l.quantite) || 0) * (Number(l.prix) || 0))
      }
    }

    const clientNames = new Map<number, string>()
    const clientIds = Array.from(new Set(cmds.map((c) => Number(c.IDclient)).filter((x) => x > 0)))
    if (clientIds.length > 0) {
      const rows = await query<{ IDclient: number; nom: string | null }>(
        `SELECT IDclient, nom FROM client WHERE IDclient IN (${clientIds.join(',')})`,
      )
      for (const r of await fixEncoding(rows as any[], 'client', 'IDclient', ['nom'])) {
        clientNames.set(Number((r as any).IDclient), ((r as any).nom ?? '').toString().trim())
      }
    }
    const commandes = cmds.map((c) => {
      const id = Number(c.IDcommande_client)
      return {
        IDcommande_client: id,
        numero: c.numero == null ? null : Number(c.numero),
        client: clientNames.get(Number(c.IDclient)) || '—',
        montant: montantByCmd.get(id) ?? 0,
        donation: Number(c.donation) === 1,
        est_soldee: Number(c.est_soldee) === 1,
      }
    })

    // Donations are orders but not revenue, so they're listed and flagged yet
    // kept out of the CA. (In practice they carry no priced lines, so this
    // changes nothing today — it just stops a priced donation from ever
    // inflating the figure.)
    const total_ht = commandes
      .filter((c) => !c.donation)
      .reduce((s, c) => s + c.montant, 0)

    res.json({
      date,
      count: commandes.length,
      total_ht,
      donation_count: commandes.filter((c) => c.donation).length,
      last_order_date: lastOrderDate,
      truncated: commandes.length >= DU_JOUR_MAX,
      commandes,
    })
  } catch (err) {
    console.error('Error fetching commandes du jour:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesClientRouter.get('/urgency-counts', async (_req: Request, res: Response) => {
  try {
    const { late, soon } = await computeUrgencyBuckets()
    res.json({ late: late.size, soon: soon.size })
  } catch (err) {
    console.error('Error fetching urgency counts:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  LIST
// ════════════════════════════════════════════════════════

/** Commandes carrying at least one line whose article reference matches `q`.
 *  Matches the very labels the line cards show: ref_fini.reference (type 2),
 *  ref_ecru.reference (type 1) and ref_divers.designation (type 3). Two steps —
 *  LIKE over the catalogs, then one IN over the lines — because the line table
 *  only stores the polymorphic IDreference.
 *
 *  Skipped for non-ASCII input: a raw accented literal in a SQL line corrupts
 *  the Linux ODBC bridge, and article references are ASCII codes anyway.
 *  ref_divers carries an accented `archivé` column — never named here. */
const REF_SEARCH_CATALOG_CAP = 500
const REF_SEARCH_COMMANDE_CAP = 500

async function findCommandeIdsByRefLabel(q: string): Promise<number[]> {
  if (!/^[\x20-\x7E]+$/.test(q)) return []
  const e = esc(q)
  const [finiRows, ecruRows, diversRows] = await Promise.all([
    query<{ IDref_fini: number }>(
      `SELECT TOP ${REF_SEARCH_CATALOG_CAP} IDref_fini FROM ref_fini WHERE reference LIKE '%${e}%'`,
    ),
    query<{ IDref_ecru: number }>(
      `SELECT TOP ${REF_SEARCH_CATALOG_CAP} IDref_ecru FROM ref_ecru WHERE reference LIKE '%${e}%'`,
    ),
    query<{ IDref_divers: number }>(
      `SELECT TOP ${REF_SEARCH_CATALOG_CAP} IDref_divers FROM ref_divers WHERE designation LIKE '%${e}%'`,
    ),
  ])
  const ids = (rows: any[], key: string): number[] =>
    Array.from(new Set(rows.map((r) => Number(r[key]) || 0).filter((x) => x > 0)))
  const finiIds = ids(finiRows, 'IDref_fini')
  const ecruIds = ids(ecruRows, 'IDref_ecru')
  const diversIds = ids(diversRows, 'IDref_divers')

  // Type-scoped, because IDreference is polymorphic: the same numeric id can
  // exist in all three catalogs and would otherwise cross-match.
  const orParts: string[] = []
  if (finiIds.length > 0) orParts.push(`(TYPE = 2 AND IDreference IN (${finiIds.join(',')}))`)
  if (ecruIds.length > 0) orParts.push(`(TYPE = 1 AND IDreference IN (${ecruIds.join(',')}))`)
  if (diversIds.length > 0) orParts.push(`(TYPE = 3 AND IDreference IN (${diversIds.join(',')}))`)
  if (orParts.length === 0) return []

  const lignes = await query<{ IDcommande_client: number }>(
    `SELECT IDcommande_client FROM ligne_commande_client WHERE ${orParts.join(' OR ')}`,
  )
  return Array.from(new Set(lignes.map((l) => Number(l.IDcommande_client) || 0).filter((x) => x > 0)))
    .sort((a, b) => b - a)
    .slice(0, REF_SEARCH_COMMANDE_CAP)
}

commandesClientRouter.get('/', async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q ?? '').trim()
    const statusFilter = String(req.query.status ?? 'all')
    const limitRaw = parseInt(String(req.query.limit ?? ''), 10)
    const limit = isNaN(limitRaw) ? 100 : Math.min(Math.max(limitRaw, 1), 500)
    const beforeIdRaw = parseInt(String(req.query.before_id ?? ''), 10)
    const beforeId = isNaN(beforeIdRaw) || beforeIdRaw <= 0 ? null : beforeIdRaw
    const isSearching = q.length > 0

    const whereParts: string[] = ['cc.IDsociete = 1', 'cc.IDcommande_ETM = 0']
    if (statusFilter === 'terminee') whereParts.push('cc.est_soldee = 1')
    else if (statusFilter === 'open') whereParts.push('cc.est_soldee = 0')

    // Search: numero exact (digits) OR client-name contains. Client list is
    // small (~650 visible) so we resolve name matches in JS to dodge LIKE
    // accent issues, then push the matching IDclient set as an IN-list.
    if (isSearching) {
      const orParts: string[] = []
      if (/^\d+$/.test(q)) orParts.push(`cc.numero = ${parseInt(q, 10)}`)
      const [clientRows, refCommandeIds] = await Promise.all([
        query<{ IDclient: number; nom: string | null }>(
          `SELECT IDclient, nom FROM client WHERE est_visible = 1`,
        ),
        findCommandeIdsByRefLabel(q),
      ])
      const fixedClients = await fixEncoding(clientRows, 'client', 'IDclient', ['nom'])
      const nq = norm(q)
      const matchIds = fixedClients
        .filter((c) => norm((c.nom ?? '').toString()).includes(nq))
        .map((c) => Number(c.IDclient))
        .filter((x) => x > 0)
      if (matchIds.length > 0) orParts.push(`cc.IDclient IN (${matchIds.join(',')})`)
      // Article reference: commandes with at least one matching line.
      if (refCommandeIds.length > 0) orParts.push(`cc.IDcommande_client IN (${refCommandeIds.join(',')})`)
      if (orParts.length === 0) { res.json([]); return }
      whereParts.push(`(${orParts.join(' OR ')})`)
    }

    // Urgency narrowing (urgency_in=late,soon).
    const urgencyTokens = String(req.query.urgency_in ?? '')
      .split(',').map((s) => s.trim()).filter((s) => s === 'late' || s === 'soon')
    if (urgencyTokens.length > 0) {
      const buckets = await computeUrgencyBuckets()
      const merged = new Set<number>()
      if (urgencyTokens.includes('late')) for (const id of buckets.late) merged.add(id)
      if (urgencyTokens.includes('soon')) for (const id of buckets.soon) merged.add(id)
      if (merged.size === 0) { res.json([]); return }
      whereParts.push(`cc.IDcommande_client IN (${Array.from(merged).join(',')})`)
    }
    if (!isSearching && beforeId !== null) whereParts.push(`cc.IDcommande_client < ${beforeId}`)

    const whereSql = `WHERE ${whereParts.join(' AND ')}`
    const commandes = await query<any>(
      `SELECT TOP ${limit} cc.IDcommande_client, cc.IDclient, cc.numero, cc.date_commande, cc.est_soldee
       FROM commande_client cc
       ${whereSql}
       ORDER BY cc.IDcommande_client DESC`,
    )

    const ids = commandes.map((c: any) => Number(c.IDcommande_client)).filter(Boolean)
    const clientIds = commandes.map((c: any) => Number(c.IDclient)).filter(Boolean)
    const [clientNames, phaseMap] = await Promise.all([
      resolveClientNames(clientIds),
      computePhasesBatch(commandes.map((c: any) => ({
        id: Number(c.IDcommande_client),
        est_soldee: Number(c.est_soldee) || 0,
      }))),
    ])

    // Line aggregates: nb_lignes, total_qte, total_eur (Σ qty×prix), earliest.
    const totalsMap = new Map<number, { total_eur: number; total_qte: number; nb_lignes: number; earliest_delivery: string | null }>()
    if (ids.length > 0) {
      const lignes = await query<any>(
        `SELECT IDcommande_client, quantite, prix, date_livraison
         FROM ligne_commande_client WHERE IDcommande_client IN (${ids.join(',')})`,
      )
      for (const l of lignes) {
        const id = Number(l.IDcommande_client)
        const acc = totalsMap.get(id) ?? { total_eur: 0, total_qte: 0, nb_lignes: 0, earliest_delivery: null }
        const qty = Number(l.quantite) || 0
        const price = Number(l.prix) || 0
        acc.total_qte += qty
        acc.total_eur += qty * price
        acc.nb_lignes += 1
        const dl = typeof l.date_livraison === 'string' ? l.date_livraison : ''
        if (/^\d{8}$/.test(dl) && (acc.earliest_delivery === null || dl < acc.earliest_delivery)) {
          acc.earliest_delivery = dl
        }
        totalsMap.set(id, acc)
      }
    }

    const result = commandes.map((c: any) => {
      const cid = Number(c.IDcommande_client)
      const totals = totalsMap.get(cid) ?? { total_eur: 0, total_qte: 0, nb_lignes: 0, earliest_delivery: null }
      return {
        IDcommande_client: cid,
        IDclient: Number(c.IDclient) || 0,
        numero: c.numero != null ? Number(c.numero) : null,
        date_commande: c.date_commande ?? null,
        est_soldee: Number(c.est_soldee) || 0,
        client_nom: clientNames.get(Number(c.IDclient)) ?? '',
        phase: phaseMap.get(cid) ?? 'a_affecter',
        ...totals,
      }
    })
    res.json(result)
  } catch (err) {
    console.error('Error fetching commandes-client:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  LINE REF / COLORIS RESOLUTION (shared by detail + PDF)
// ════════════════════════════════════════════════════════

interface ResolvedMaps {
  ecru: Map<number, string>
  fini: Map<number, string>
  divers: Map<number, string>
  finiAvecTeinture: Map<number, number>
  colorisFini: Map<number, string>
  colorisEcru: Map<number, string>
}

/** Batch-resolve all ref + coloris labels for a set of lines. */
// Total "tombé de métier" (écru) ordered on a commande, aggregated by écru ref
// AND input coloris. Each line's écru weight: Kg lines (unite=1) count their
// quantite directly; Ml lines (unite=3) convert via rendement (kg = ml /
// rendement). Fini lines (type=2) trace to ref_fini.IDref_ecru +
// ref_fini.rendement; écru lines (type=1) use the ref directly +
// ref_ecru.rendement. Divers lines (type=3) are excluded.
// Input coloris per line: dyed finis (avec_teinture 1/2) consume the natural
// "ecru" base; wash-only finis (avec_teinture 0) and écru lines carry a
// colori_ecru id on the line itself — the écru consumed is knitted in that
// exact coloris (e.g. 040A/gris8985 ← écru 040/gris8985).
interface TombeMetierRow { IDref_ecru: number; ref_label: string; coloris_label: string; poids_kg: number }
async function computeTombeMetier(
  lignes: Array<{ type_kind: number; IDreference: number; IDcolori: number; quantite: number; unite: number }>,
): Promise<TombeMetierRow[]> {
  const finiIds = new Set<number>()
  const ecruLineIds = new Set<number>()
  for (const l of lignes) {
    const ref = Number(l.IDreference) || 0
    if (ref <= 0) continue
    if (Number(l.type_kind) === 2) finiIds.add(ref)
    else if (Number(l.type_kind) === 1) ecruLineIds.add(ref)
  }
  const finiMap = new Map<number, { ecru: number; rdt: number; avecTeinture: number }>()
  if (finiIds.size > 0) {
    const rows = await query<{ IDref_fini: number; IDref_ecru: number | null; rendement: number | null; avec_teinture: number | null }>(
      `SELECT IDref_fini, IDref_ecru, rendement, avec_teinture FROM ref_fini WHERE IDref_fini IN (${[...finiIds].join(',')})`,
    )
    for (const r of rows)
      finiMap.set(Number(r.IDref_fini), {
        ecru: Number(r.IDref_ecru) || 0,
        rdt: Number(r.rendement) || 0,
        avecTeinture: Number(r.avec_teinture) || 0,
      })
  }
  const ecruIds = new Set<number>(ecruLineIds)
  for (const v of finiMap.values()) if (v.ecru > 0) ecruIds.add(v.ecru)
  const ecruMap = new Map<number, { reference: string; rdt: number }>()
  if (ecruIds.size > 0) {
    const rows = await query<{ IDref_ecru: number; reference: string | null; rendement: number | null }>(
      `SELECT IDref_ecru, reference, rendement FROM ref_ecru WHERE IDref_ecru IN (${[...ecruIds].join(',')})`,
    )
    const fixed = await fixEncoding(rows, 'ref_ecru', 'IDref_ecru', ['reference'])
    for (const r of fixed) ecruMap.set(Number(r.IDref_ecru), { reference: (r.reference ?? '').toString(), rdt: Number(r.rendement) || 0 })
  }
  // Lines that carry a colori_ecru id (écru lines + wash-only fini lines) need
  // its label; dyed fini lines use the fixed "ecru" label.
  const coloriEcruIds = new Set<number>()
  for (const l of lignes) {
    const t = Number(l.type_kind) || 0
    const colId = Number(l.IDcolori) || 0
    if (colId <= 0) continue
    if (t === 1 || (t === 2 && finiMap.get(Number(l.IDreference) || 0)?.avecTeinture === 0)) coloriEcruIds.add(colId)
  }
  const coloriEcruLabels = coloriEcruIds.size > 0 ? await resolveEcruColoris([...coloriEcruIds]) : new Map<number, string>()

  const agg = new Map<string, { IDref_ecru: number; ref_label: string; coloris_label: string; kg: number }>()
  for (const l of lignes) {
    const t = Number(l.type_kind) || 0
    const ref = Number(l.IDreference) || 0
    const colId = Number(l.IDcolori) || 0
    const qte = Number(l.quantite) || 0
    const unite = Number(l.unite) || 0
    if (ref <= 0 || qte <= 0) continue
    let ecruRef = 0
    let rdt = 0
    let coloris = ''
    if (t === 2) {
      const f = finiMap.get(ref)
      if (!f) continue
      ecruRef = f.ecru
      rdt = f.rdt
      coloris = f.avecTeinture === 0 ? (coloriEcruLabels.get(colId) ?? '').trim() : 'ecru'
    } else if (t === 1) {
      ecruRef = ref
      rdt = ecruMap.get(ref)?.rdt ?? 0
      coloris = (coloriEcruLabels.get(colId) ?? '').trim()
    } else continue
    if (ecruRef <= 0) continue
    const kg = unite === 1 ? qte : (rdt > 0 ? qte / rdt : 0)
    if (kg <= 0) continue
    const key = `${ecruRef}|${coloris}`
    const a = agg.get(key) ?? { IDref_ecru: ecruRef, ref_label: ecruMap.get(ecruRef)?.reference ?? '', coloris_label: coloris, kg: 0 }
    a.kg += kg
    agg.set(key, a)
  }
  return [...agg.values()]
    .map((a): TombeMetierRow => ({ IDref_ecru: a.IDref_ecru, ref_label: a.ref_label, coloris_label: a.coloris_label, poids_kg: Math.round(a.kg * 100) / 100 }))
    .sort((x, y) => x.ref_label.localeCompare(y.ref_label) || x.coloris_label.localeCompare(y.coloris_label))
}

async function resolveLineLabels(
  lignes: Array<{ IDreference: number | null; IDcolori: number | null; type_kind: number }>,
): Promise<ResolvedMaps> {
  const refIds = Array.from(new Set(lignes.map((l) => Number(l.IDreference) || 0).filter((x) => x > 0)))
  const coloriIds = Array.from(new Set(lignes.map((l) => Number(l.IDcolori) || 0).filter((x) => x > 0)))
  const ecru = new Map<number, string>()
  const fini = new Map<number, string>()
  const divers = new Map<number, string>()
  const finiAvecTeinture = new Map<number, number>()
  const colorisFini = new Map<number, string>()
  const colorisEcru = new Map<number, string>()

  if (refIds.length > 0) {
    const [ecruRows, finiRows, diversRows] = await Promise.all([
      query<{ IDref_ecru: number; reference: string | null }>(
        `SELECT IDref_ecru, reference FROM ref_ecru WHERE IDref_ecru IN (${refIds.join(',')})`,
      ),
      query<{ IDref_fini: number; reference: string | null; avec_teinture: number | null }>(
        `SELECT IDref_fini, reference, avec_teinture FROM ref_fini WHERE IDref_fini IN (${refIds.join(',')})`,
      ),
      query<{ IDref_divers: number; designation: string | null }>(
        `SELECT IDref_divers, designation FROM ref_divers WHERE IDref_divers IN (${refIds.join(',')})`,
      ),
    ])
    for (const r of await fixEncoding(ecruRows, 'ref_ecru', 'IDref_ecru', ['reference']))
      ecru.set(Number(r.IDref_ecru), (r.reference ?? '').toString())
    for (const r of await fixEncoding(finiRows, 'ref_fini', 'IDref_fini', ['reference'])) {
      fini.set(Number(r.IDref_fini), (r.reference ?? '').toString())
      finiAvecTeinture.set(Number(r.IDref_fini), Number((r as any).avec_teinture) || 0)
    }
    for (const r of await fixEncoding(diversRows, 'ref_divers', 'IDref_divers', ['designation']))
      divers.set(Number(r.IDref_divers), (r.designation ?? '').toString())
  }
  if (coloriIds.length > 0) {
    const [finiC, ecruC] = await Promise.all([
      query<{ IDref_fini_colori: number; reference: string | null }>(
        `SELECT IDref_fini_colori, reference FROM ref_fini_colori WHERE IDref_fini_colori IN (${coloriIds.join(',')})`,
      ),
      query<{ IDcolori_ecru: number; reference: string | null }>(
        `SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDcolori_ecru IN (${coloriIds.join(',')})`,
      ),
    ])
    for (const c of await fixEncoding(finiC, 'ref_fini_colori', 'IDref_fini_colori', ['reference']))
      colorisFini.set(Number(c.IDref_fini_colori), (c.reference ?? '').toString())
    for (const c of await fixEncoding(ecruC, 'colori_ecru', 'IDcolori_ecru', ['reference']))
      colorisEcru.set(Number(c.IDcolori_ecru), (c.reference ?? '').toString())
  }
  return { ecru, fini, divers, finiAvecTeinture, colorisFini, colorisEcru }
}

function resolveRefLabel(maps: ResolvedMaps, IDref: number, typeKind: number): { label: string; kind: 'ecru' | 'fini' | 'divers' | null } {
  if (IDref <= 0) return { label: '', kind: null }
  if (typeKind === 1) return maps.ecru.has(IDref) ? { label: maps.ecru.get(IDref)!, kind: 'ecru' } : { label: '', kind: 'ecru' }
  if (typeKind === 2) return maps.fini.has(IDref) ? { label: maps.fini.get(IDref)!, kind: 'fini' } : { label: '', kind: 'fini' }
  if (typeKind === 3) return maps.divers.has(IDref) ? { label: maps.divers.get(IDref)!, kind: 'divers' } : { label: '', kind: 'divers' }
  // Unknown type — best effort across catalogs.
  if (maps.fini.has(IDref)) return { label: maps.fini.get(IDref)!, kind: 'fini' }
  if (maps.ecru.has(IDref)) return { label: maps.ecru.get(IDref)!, kind: 'ecru' }
  if (maps.divers.has(IDref)) return { label: maps.divers.get(IDref)!, kind: 'divers' }
  return { label: '', kind: null }
}

function resolveColorisLabel(maps: ResolvedMaps, IDcolori: number, typeKind: number, IDref: number): string {
  if (IDcolori <= 0) return ''
  if (typeKind === 2) {
    const dyed = (maps.finiAvecTeinture.get(IDref) ?? 1) !== 0
    return dyed
      ? (maps.colorisFini.get(IDcolori) ?? maps.colorisEcru.get(IDcolori) ?? '')
      : (maps.colorisEcru.get(IDcolori) ?? maps.colorisFini.get(IDcolori) ?? '')
  }
  // écru (type 1) and fallback
  return maps.colorisEcru.get(IDcolori) ?? maps.colorisFini.get(IDcolori) ?? ''
}

/** Per-line "affecté" aggregates keyed by IDligne_commande_client. The gauge
 *  counts EVERY affectation source, matching the legacy "854 / 800 Ml" figure
 *  on commande 3686:
 *   - stock_fini rolls reserved to the line (their own métrage),
 *   - stock_ecru rolls reserved to the line — at a dyer or not — whose métrage
 *    contribution is poids × rendement (écru rolls carry metrage = 0; legacy
 *    validates 240.60 kg × 3.548387 = 853.74 Ml),
 *   - affectation_cmd_tricotage planning allocations (poids × rendement).
 *  Needs each line's ref to resolve the rendement, hence the meta input. */
async function lineReservationAggregates(
  lines: Array<{ id: number; typeKind: number; refId: number }>,
): Promise<Map<number, { nb_rolls: number; total_metrage: number; total_poids: number; exp_metrage: number; exp_poids: number }>> {
  const out = new Map<number, { nb_rolls: number; total_metrage: number; total_poids: number; exp_metrage: number; exp_poids: number }>()
  const metas = lines.filter((l) => l.id > 0)
  if (metas.length === 0) return out
  const inList = metas.map((l) => l.id).join(',')

  // rendement per line (fini refs vs écru refs, batched).
  const finiRefIds = Array.from(new Set(metas.filter((l) => lineStockKind(l.typeKind) === 'fini').map((l) => l.refId).filter((x) => x > 0)))
  const ecruRefIds = Array.from(new Set(metas.filter((l) => lineStockKind(l.typeKind) === 'ecru').map((l) => l.refId).filter((x) => x > 0)))
  const rdtByFini = new Map<number, number>()
  const rdtByEcru = new Map<number, number>()
  if (finiRefIds.length > 0) {
    const r = await query<{ IDref_fini: number; rendement: number | null }>(
      `SELECT IDref_fini, rendement FROM ref_fini WHERE IDref_fini IN (${finiRefIds.join(',')})`,
    )
    for (const row of r) rdtByFini.set(Number(row.IDref_fini), Number(row.rendement) || 0)
  }
  if (ecruRefIds.length > 0) {
    const r = await query<{ IDref_ecru: number; rendement: number | null }>(
      `SELECT IDref_ecru, rendement FROM ref_ecru WHERE IDref_ecru IN (${ecruRefIds.join(',')})`,
    )
    for (const row of r) rdtByEcru.set(Number(row.IDref_ecru), Number(row.rendement) || 0)
  }
  const rdtByLine = new Map<number, number>()
  for (const l of metas) {
    const kind = lineStockKind(l.typeKind)
    rdtByLine.set(l.id, kind === 'fini' ? (rdtByFini.get(l.refId) ?? 0) : kind === 'ecru' ? (rdtByEcru.get(l.refId) ?? 0) : 0)
  }

  const [ecru, fini, trico] = await Promise.all([
    // Écru only counts while still écru: a roll already dyed into a stock_fini
    // (IDstock_ecru back-pointer) is represented by that fini roll — counting
    // its écru form too double-counted the gauge (commande 3643 showed
    // 4 404,8 / 1 635,0 Ml). Same NOT EXISTS as the available-écru pools.
    query<{ IDligne_commande_client: number; metrage: number | null; poids: number | null; IDligne_expedition_ETM: number | null }>(
      `SELECT se.IDligne_commande_client, se.metrage, se.poids, se.IDligne_expedition_ETM
       FROM stock_ecru se WHERE se.IDligne_commande_client IN (${inList})
         AND NOT EXISTS (SELECT 1 FROM stock_fini sfx WHERE sfx.IDstock_ecru = se.IDstock_ecru)`,
    ),
    query<{ IDligne_commande_client: number; metrage: number | null; poids: number | null; IDligne_expedition: number | null; IDetat_stock_fini: number | null }>(
      `SELECT IDligne_commande_client, metrage, poids, IDligne_expedition, IDetat_stock_fini FROM stock_fini WHERE IDligne_commande_client IN (${inList})`,
    ),
    query<{ IDligne_commande_client: number; poids_affecte: number | null }>(
      `SELECT IDligne_commande_client, poids_affecte FROM affectation_cmd_tricotage WHERE IDligne_commande_client IN (${inList})`,
    ),
  ])
  const acc = (lid: number) => {
    const a = out.get(lid) ?? { nb_rolls: 0, total_metrage: 0, total_poids: 0, exp_metrage: 0, exp_poids: 0 }
    out.set(lid, a)
    return a
  }
  for (const r of fini) {
    const lid = Number(r.IDligne_commande_client) || 0
    if (lid === 0) continue
    const a = acc(lid)
    const metrage = Number(r.metrage) || 0
    const poids = Number(r.poids) || 0
    a.nb_rolls += 1
    a.total_metrage += metrage
    a.total_poids += poids
    // Shipped = état Expédié or attached to an expedition line.
    if (Number(r.IDetat_stock_fini) === 4 || (Number(r.IDligne_expedition) || 0) > 0) {
      a.exp_metrage += metrage
      a.exp_poids += poids
    }
  }
  for (const r of ecru) {
    const lid = Number(r.IDligne_commande_client) || 0
    if (lid === 0) continue
    const a = acc(lid)
    const poids = Number(r.poids) || 0
    const rdt = rdtByLine.get(lid) ?? 0
    const metrage = rdt > 0 ? poids * rdt : Number(r.metrage) || 0
    a.nb_rolls += 1
    a.total_metrage += metrage
    a.total_poids += poids
    if ((Number(r.IDligne_expedition_ETM) || 0) > 0) {
      a.exp_metrage += metrage
      a.exp_poids += poids
    }
  }
  for (const r of trico) {
    const lid = Number(r.IDligne_commande_client) || 0
    if (lid === 0) continue
    const a = acc(lid)
    const poids = Number(r.poids_affecte) || 0
    a.total_metrage += poids * (rdtByLine.get(lid) ?? 0)
    a.total_poids += poids
  }
  for (const a of out.values()) {
    a.total_metrage = round2c(a.total_metrage)
    a.total_poids = round2c(a.total_poids)
    a.exp_metrage = round2c(a.exp_metrage)
    a.exp_poids = round2c(a.exp_poids)
  }
  return out
}

// ════════════════════════════════════════════════════════
//  DIVERS LINES (type 3) — article identity + shipment ledger
//  A divers line is NOT backed by stock rolls: it names a catalog article
//  (ref_divers) narrowed by up to two variation axes (IDVariation1/2 →
//  ref_divers_variation). It ships through the expedition_divers ledger, whose
//  header carries an IDcommande_client back-pointer:
//    expedition_divers (IDcommande_client = this order)
//      └ ligne_expedition_divers   = a CARTON (detail_ligne = its label)
//          └ ref_divers_expedie    = one row per article shipped in the carton
//  "Expédié" for a line = Σ quantite of the items whose (ref, v1, v2) matches
//  the line. On-hand comes from stock_divers, keyed on the same triple.
// ════════════════════════════════════════════════════════

/** Article key for a divers line / shipped item — ref + both variation axes. */
function diversKey(refId: number, v1: number, v2: number): string {
  return `${refId}|${v1}|${v2}`
}

/** Batch-resolve ref_divers_variation labels (accent repair via repairAliased,
 *  same as the Expéditions screen — designation is a plain-named column). */
async function resolveDiversVariations(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const u = Array.from(new Set(ids.filter((x) => Number.isInteger(x) && x > 0)))
  if (u.length === 0) return out
  const raw = await query<any>(
    `SELECT IDref_divers_variation, designation FROM ref_divers_variation WHERE IDref_divers_variation IN (${u.join(',')})`,
  )
  const fixed = await repairAliased(raw, 'ref_divers_variation', 'IDref_divers_variation', { designation: 'designation' })
  for (const v of fixed as any[]) out.set(Number(v.IDref_divers_variation), (v.designation ?? '').toString())
  return out
}

/** All expedition_divers headers attached to a commande, newest first. */
async function diversExpeditionIds(commandeId: number): Promise<number[]> {
  const rows = await query<{ IDexpedition_divers: number }>(
    `SELECT IDexpedition_divers FROM expedition_divers WHERE IDcommande_client = ${commandeId}`,
  )
  return rows.map((r) => Number(r.IDexpedition_divers)).filter((x) => x > 0).sort((a, b) => b - a)
}

/** Σ shipped quantity per article key across the commande's divers shipments. */
async function diversShippedByArticle(commandeId: number): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const expIds = await diversExpeditionIds(commandeId)
  if (expIds.length === 0) return out
  const cartons = await query<{ IDligne_expedition_divers: number }>(
    `SELECT IDligne_expedition_divers FROM ligne_expedition_divers WHERE IDexpedition_divers IN (${expIds.join(',')})`,
  )
  const cartonIds = cartons.map((c) => Number(c.IDligne_expedition_divers)).filter((x) => x > 0)
  if (cartonIds.length === 0) return out
  const items = await query<any>(
    `SELECT quantite, IDref_divers, IDVariation1, IDVariation2 FROM ref_divers_expedie ` +
      `WHERE IDligne_expedition_divers IN (${cartonIds.join(',')})`,
  )
  for (const i of items as any[]) {
    const k = diversKey(Number(i.IDref_divers) || 0, Number(i.IDVariation1) || 0, Number(i.IDVariation2) || 0)
    out.set(k, round2c((out.get(k) ?? 0) + (Number(i.quantite) || 0)))
  }
  return out
}

/** On-hand stock_divers quantity for a set of article keys (0 when untracked). */
async function diversStockByArticle(refIds: number[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const u = Array.from(new Set(refIds.filter((x) => x > 0)))
  if (u.length === 0) return out
  const rows = await query<any>(
    `SELECT IDref_divers, quantite, IDVariation1, IDVariation2 FROM stock_divers WHERE IDref_divers IN (${u.join(',')})`,
  )
  for (const r of rows as any[]) {
    const k = diversKey(Number(r.IDref_divers) || 0, Number(r.IDVariation1) || 0, Number(r.IDVariation2) || 0)
    out.set(k, round2c((out.get(k) ?? 0) + (Number(r.quantite) || 0)))
  }
  return out
}

// ════════════════════════════════════════════════════════
//  DETAIL
// ════════════════════════════════════════════════════════

commandesClientRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    // SELECT * is safe on commande_client (unlike client); accented keys
    // (archivé/expedié/envoyé_client) come back mangled and are simply ignored.
    const rows = await query<any>(`SELECT * FROM commande_client WHERE IDcommande_client = ${id}`)
    if (rows.length === 0) { res.status(404).json({ error: 'Commande not found' }); return }
    const fixedHeader = await fixEncoding(rows, 'commande_client', 'IDcommande_client',
      ['ref_client', 'commentaire', 'commentaire_interne', 'observations_facturation'])
    const h = fixedHeader[0] as any
    // commentaire fields read as plain (legacy reads commande_client.commentaire
    // as plain text); stripRtf defensively in case a row still carries RTF.
    h.commentaire = stripRtf(h.commentaire) || null
    h.commentaire_interne = stripRtf(h.commentaire_interne) || null
    h.observations_facturation = stripRtf(h.observations_facturation) || null

    const IDclient = Number(h.IDclient) || 0
    const [clientNames, ficheRows, adrLivRows, adrFacRows, lignesRaw] = await Promise.all([
      resolveClientNames([IDclient]),
      // "Fiche client" = client.commentaire — customer-specific handling notes
      // the legacy app surfaces on every commande (procedures, contrôle rules…).
      IDclient > 0
        ? query<any>(`SELECT IDclient, commentaire FROM client WHERE IDclient = ${IDclient}`)
        : Promise.resolve([]),
      h.IDadresse_livraison
        ? query(`SELECT IDadresse, nom, adresse1, adresse2, adresse3, cp, ville, pays FROM adresse WHERE IDadresse = ${n(h.IDadresse_livraison)}`)
        : Promise.resolve([]),
      h.IDadresse_facturation
        ? query(`SELECT IDadresse, nom, adresse1, adresse2, adresse3, cp, ville, pays FROM adresse WHERE IDadresse = ${n(h.IDadresse_facturation)}`)
        : Promise.resolve([]),
      // TYPE is a reserved word → alias type_kind. IDcolori is lowercase. Never
      // name the accented delai_annoncé / déverrouiller columns.
      query<any>(
        `SELECT IDligne_commande_client, IDcommande_client, TYPE AS type_kind,
                IDreference, IDcolori, IDVariation1, IDVariation2,
                quantite, unite, prix, poids, date_livraison, commentaire
         FROM ligne_commande_client
         WHERE IDcommande_client = ${id}
         ORDER BY IDligne_commande_client`,
      ),
    ])

    const adrLiv = (await fixEncoding(adrLivRows, 'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays']))[0] ?? null
    const adrFac = (await fixEncoding(adrFacRows, 'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays']))[0] ?? null
    const ficheFixed = (await fixEncoding(ficheRows, 'client', 'IDclient', ['commentaire']))[0] as any
    const clientFiche = (stripRtf(ficheFixed?.commentaire) || '').trim() || null
    const lignesFixed = (await fixEncoding(lignesRaw, 'ligne_commande_client', 'IDligne_commande_client', ['commentaire'])) as any[]
    for (const l of lignesFixed) l.commentaire = stripRtf(l.commentaire) || null

    const lignesForResolve = lignesFixed.map((l) => ({
      IDreference: Number(l.IDreference) || 0,
      IDcolori: Number(l.IDcolori) || 0,
      type_kind: Number(l.type_kind) || 0,
    }))
    const maps = await resolveLineLabels(lignesForResolve)
    const aggMap = await lineReservationAggregates(lignesFixed.map((l) => ({
      id: Number(l.IDligne_commande_client) || 0,
      typeKind: Number(l.type_kind) || 0,
      refId: Number(l.IDreference) || 0,
    })))

    // Divers lines carry no rolls — their variation labels and shipped totals
    // come from the ref_divers_variation catalog and the expedition_divers ledger.
    const diversLines = lignesFixed.filter((l) => Number(l.type_kind) === 3)
    const [variationLabels, diversShipped] = await Promise.all([
      resolveDiversVariations(diversLines.flatMap((l) => [Number(l.IDVariation1) || 0, Number(l.IDVariation2) || 0])),
      diversLines.length > 0 ? diversShippedByArticle(id) : Promise.resolve(new Map<string, number>()),
    ])

    const lignes = lignesFixed.map((l) => {
      const typeKind = Number(l.type_kind) || 0
      const refId = Number(l.IDreference) || 0
      const colId = Number(l.IDcolori) || 0
      const resolved = resolveRefLabel(maps, refId, typeKind)
      const agg = aggMap.get(Number(l.IDligne_commande_client)) ?? { nb_rolls: 0, total_metrage: 0, total_poids: 0, exp_metrage: 0, exp_poids: 0 }
      const qty = Number(l.quantite) || 0
      const prix = Number(l.prix) || 0
      const v1 = Number(l.IDVariation1) || 0
      const v2 = Number(l.IDVariation2) || 0
      return {
        IDligne_commande_client: Number(l.IDligne_commande_client),
        IDcommande_client: Number(l.IDcommande_client),
        type: typeKind,
        IDreference: refId,
        IDcolori: colId,
        IDVariation1: v1,
        IDVariation2: v2,
        variation1_label: typeKind === 3 && v1 > 0 ? (variationLabels.get(v1) ?? null) : null,
        variation2_label: typeKind === 3 && v2 > 0 ? (variationLabels.get(v2) ?? null) : null,
        quantite: qty,
        unite: Number(l.unite) || 0,
        unite_label: uniteLabel(l.unite),
        prix,
        poids: Number(l.poids) || 0,
        date_livraison: l.date_livraison ?? null,
        commentaire: l.commentaire ?? null,
        ref_label: resolved.label || null,
        ref_kind: resolved.kind,
        colori_reference: resolveColorisLabel(maps, colId, typeKind, refId) || null,
        montant: qty * prix,
        // affectation aggregates + the gauge basis (poids for Kg, metrage for Ml)
        nb_rolls: agg.nb_rolls,
        total_metrage: agg.total_metrage,
        total_poids: agg.total_poids,
        affecte: lineDim(l.unite) === 'metrage' ? agg.total_metrage : agg.total_poids,
        expedie: typeKind === 3
          ? (diversShipped.get(diversKey(refId, v1, v2)) ?? 0)
          : lineDim(l.unite) === 'metrage' ? agg.exp_metrage : agg.exp_poids,
      }
    })

    // Donation orders attach stock pieces instead of lignes; the count drives
    // the UI lock on the Donation toggle (can't untick while pieces remain).
    let nbDonationPieces = 0
    if (Number(h.donation) === 1) {
      const [pe, pf] = await Promise.all([
        query<{ nb: number }>(`SELECT COUNT(*) AS nb FROM stock_ecru WHERE IDcommande_donation = ${id}`),
        query<{ nb: number }>(`SELECT COUNT(*) AS nb FROM stock_fini WHERE IDcommande_donation = ${id}`),
      ])
      nbDonationPieces = (Number(pe[0]?.nb) || 0) + (Number(pf[0]?.nb) || 0)
    }

    const phase = (await computePhasesBatch([{ id, est_soldee: Number(h.est_soldee) || 0 }])).get(id) ?? 'a_affecter'
    const tombe_metier = await computeTombeMetier(lignesFixed.map((l) => ({
      type_kind: Number(l.type_kind) || 0,
      IDreference: Number(l.IDreference) || 0,
      IDcolori: Number(l.IDcolori) || 0,
      quantite: Number(l.quantite) || 0,
      unite: Number(l.unite) || 0,
    })))

    res.json({
      IDcommande_client: id,
      IDclient,
      client_nom: clientNames.get(IDclient) ?? '',
      client_fiche: clientFiche,
      numero: h.numero != null ? Number(h.numero) : null,
      date_commande: h.date_commande ?? null,
      ref_client: h.ref_client ?? null,
      IDadresse_livraison: Number(h.IDadresse_livraison) || 0,
      IDadresse_facturation: Number(h.IDadresse_facturation) || 0,
      IDmode_paiement: Number(h.IDmode_paiement) || 0,
      IDecheance: Number(h.IDecheance) || 0,
      commentaire: h.commentaire ?? null,
      commentaire_interne: h.commentaire_interne ?? null,
      observations_facturation: h.observations_facturation ?? null,
      est_soldee: Number(h.est_soldee) || 0,
      donation: Number(h.donation) || 0,
      nb_donation_pieces: nbDonationPieces,
      remise: Number(h.remise) || 0,
      frais_port: Number(h.frais_port) || 0,
      IDdossier: Number(h.IDdossier) || 0,
      adresse_livraison: adrLiv,
      adresse_facturation: adrFac,
      lignes,
      tombe_metier,
      phase,
    })
  } catch (err) {
    console.error('Error fetching commande-client detail:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  HEADER CRUD
// ════════════════════════════════════════════════════════

/** Guard for the commande write paths: create, header edit, delete, line
 *  CRUD (edit_commandes_client permission). View-mode workflows (état pill,
 *  affectation, expédier, observations, documents, email) stay open.
 *  Sends the 401/403 itself and returns false when the caller is not allowed. */
async function requireEditCommandes(req: Request, res: Response): Promise<boolean> {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return false
  }
  const allowed = await userHasPermission(req.userId, isEffectiveAdmin(req), 'edit_commandes_client')
  if (!allowed) {
    res.status(403).json({ error: 'permission denied: edit_commandes_client' })
    return false
  }
  return true
}

commandesClientRouter.post('/', async (req: Request, res: Response) => {
  try {
    if (!(await requireEditCommandes(req, res))) return
    const parsed = commandeBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data
    if (!d.IDclient) { res.status(400).json({ error: 'IDclient is required' }); return }

    const dateCmd = d.date_commande ? dateStr(d.date_commande) : (() => {
      const t = new Date()
      return `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}`
    })()

    // numero allocator with collision retry. Accented columns omitted (HFSQL
    // zero-fills archivé/expedié/envoyé_client).
    let newNumero = 0
    let inserted = false
    let lastErr: unknown = null
    for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
      newNumero = await nextNumero()
      try {
        await query(
          `INSERT INTO commande_client
             (IDclient, IDsociete, IDcommande_ETM, numero, date_commande,
              IDadresse_livraison, IDadresse_facturation, IDmode_paiement, IDecheance,
              ref_client, commentaire, est_soldee, remise, donation,
              attente_paiement, frais_port, IDdossier)
           VALUES
             (${n(d.IDclient)}, 1, 0, ${newNumero}, '${dateCmd}',
              ${n(d.IDadresse_livraison ?? 0)}, ${n(d.IDadresse_facturation ?? 0)},
              ${n(d.IDmode_paiement ?? 0)}, ${n(d.IDecheance ?? 0)},
              ${sqlText(d.ref_client ?? '')}, ${sqlText(d.commentaire ?? '')}, 0,
              ${Number(d.remise) || 0}, 0, 0, ${Number(d.frais_port) || 0}, 0)`,
        )
        inserted = true
      } catch (e) { lastErr = e }
    }
    if (!inserted) throw lastErr ?? new Error('insert failed after 3 attempts')

    const newRows = await query<{ IDcommande_client: number }>(
      `SELECT IDcommande_client FROM commande_client
       WHERE IDsociete = 1 AND numero = ${newNumero} ORDER BY IDcommande_client DESC`,
    )
    const newId = Number(newRows[0]?.IDcommande_client) || 0
    res.status(201).json({ IDcommande_client: newId })
  } catch (err) {
    console.error('Error creating commande-client:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesClientRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    if (!(await requireEditCommandes(req, res))) return
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = commandeBody.partial().safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data

    const sets: string[] = []
    if (d.IDclient !== undefined) sets.push(`IDclient = ${n(d.IDclient)}`)
    if (d.date_commande !== undefined) sets.push(`date_commande = '${dateStr(d.date_commande)}'`)
    if (d.ref_client !== undefined) sets.push(`ref_client = ${sqlText(d.ref_client)}`)
    if (d.IDadresse_livraison !== undefined) sets.push(`IDadresse_livraison = ${n(d.IDadresse_livraison)}`)
    if (d.IDadresse_facturation !== undefined) sets.push(`IDadresse_facturation = ${n(d.IDadresse_facturation)}`)
    if (d.IDmode_paiement !== undefined) sets.push(`IDmode_paiement = ${n(d.IDmode_paiement)}`)
    if (d.IDecheance !== undefined) sets.push(`IDecheance = ${n(d.IDecheance)}`)
    if (d.commentaire !== undefined) sets.push(`commentaire = ${sqlText(d.commentaire)}`)
    if (d.commentaire_interne !== undefined) sets.push(`commentaire_interne = ${sqlText(d.commentaire_interne)}`)
    if (d.remise !== undefined) sets.push(`remise = ${Number(d.remise) || 0}`)
    if (d.frais_port !== undefined) sets.push(`frais_port = ${Number(d.frais_port) || 0}`)
    if (d.est_soldee !== undefined) sets.push(`est_soldee = ${d.est_soldee}`)
    if (d.donation !== undefined) {
      // Permission-gated: only 403 when the value actually changes, so a
      // client echoing the current flag alongside other header edits passes.
      const cur = await query<{ donation: number | null }>(
        `SELECT donation FROM commande_client WHERE IDcommande_client = ${id}`,
      )
      const currentDonation = Number(cur[0]?.donation) === 1 ? 1 : 0
      if (d.donation !== currentDonation) {
        if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
        const allowed = await userHasPermission(req.userId, isEffectiveAdmin(req), 'donation_commande_client')
        if (!allowed) { res.status(403).json({ error: 'permission denied: donation_commande_client' }); return }
        // The flag rewires the whole order model (lignes ↔ donation pieces),
        // so it can only flip while the commande is still empty on both sides.
        if (d.donation === 1) {
          const lr = await query<{ nb: number }>(
            `SELECT COUNT(*) AS nb FROM ligne_commande_client WHERE IDcommande_client = ${id}`,
          )
          if ((Number(lr[0]?.nb) || 0) > 0) {
            res.status(409).json({
              error: 'donation_has_lines',
              message: 'Impossible d’activer la donation : la commande a déjà des lignes.',
            })
            return
          }
        } else {
          const [pe, pf] = await Promise.all([
            query<{ nb: number }>(`SELECT COUNT(*) AS nb FROM stock_ecru WHERE IDcommande_donation = ${id}`),
            query<{ nb: number }>(`SELECT COUNT(*) AS nb FROM stock_fini WHERE IDcommande_donation = ${id}`),
          ])
          if ((Number(pe[0]?.nb) || 0) + (Number(pf[0]?.nb) || 0) > 0) {
            res.status(409).json({
              error: 'donation_has_pieces',
              message: 'Impossible de désactiver la donation : des pièces sont encore attachées à la commande.',
            })
            return
          }
        }
        sets.push(`donation = ${d.donation}`)
      }
    }
    if (sets.length === 0) { res.status(400).json({ error: 'No fields to update' }); return }

    await query(`UPDATE commande_client SET ${sets.join(', ')} WHERE IDcommande_client = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating commande-client:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Binary est_soldee toggle (sidebar footer pill) — gated on its own
// cloture_commande_client permission (NOT edit_commandes_client: closing /
// reopening is a distinct responsibility from editing the commande).
commandesClientRouter.put('/:id/etat', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    const allowed = await userHasPermission(req.userId, isEffectiveAdmin(req), 'cloture_commande_client')
    if (!allowed) { res.status(403).json({ error: 'permission denied: cloture_commande_client' }); return }
    const est = Number(req.body?.est_soldee) === 1 ? 1 : 0
    await query(`UPDATE commande_client SET est_soldee = ${est} WHERE IDcommande_client = ${id}`)
    res.json({ ok: true, est_soldee: est })
  } catch (err) {
    console.error('Error toggling commande-client etat:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesClientRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    if (!(await requireEditCommandes(req, res))) return
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    // Release every reserved roll, then delete the lines, then the header.
    const lineRows = await query<{ IDligne_commande_client: number }>(
      `SELECT IDligne_commande_client FROM ligne_commande_client WHERE IDcommande_client = ${id}`,
    )
    const lineIds = lineRows.map((r) => Number(r.IDligne_commande_client)).filter((x) => x > 0)
    if (lineIds.length > 0) {
      const inList = lineIds.join(',')
      await query(`UPDATE stock_ecru SET IDligne_commande_client = 0 WHERE IDligne_commande_client IN (${inList})`)
      await query(`UPDATE stock_fini SET IDligne_commande_client = 0 WHERE IDligne_commande_client IN (${inList})`)
    }
    // Release donation pieces too (stock reserved via IDcommande_donation).
    await query(`UPDATE stock_ecru SET IDcommande_donation = 0 WHERE IDcommande_donation = ${id}`)
    await query(`UPDATE stock_fini SET IDcommande_donation = 0 WHERE IDcommande_donation = ${id}`)
    await query(`DELETE FROM ligne_commande_client WHERE IDcommande_client = ${id}`)
    await query(`DELETE FROM commande_client WHERE IDcommande_client = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting commande-client:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  DONATION PIECES — stock attached directly to a donation commande.
//  Legacy model (WinDev "Donation" tab): a donation commande has NO
//  ligne_commande_client rows. Instead individual stock pieces point at the
//  commande via stock_ecru.IDcommande_donation / stock_fini.IDcommande_donation.
//  The picker offers the full in-stock population: not shipped, not reserved
//  to a client line, not affected to a dyer (écru), not attached to another
//  donation. stock_divers has no IDcommande_donation column — only tombé de
//  métier (écru) and fini participate, matching the legacy dialog.
// ════════════════════════════════════════════════════════

interface DonationPiece {
  id: number
  ref_label: string | null
  coloris_reference: string | null
  numero: string | null
  poids: number
  metrage: number
  lot: string | null
  date_saisie: string | null
  second_choix: number
  observations: string | null
  /** Écru only — defect summary from defaut_qualite ("Maille 100 cm; Trou"). */
  defauts: string | null
  /** Candidates only — piece already attached to THIS commande. */
  attached: 0 | 1
}

// Eligibility fragments shared by the candidates list and the attach
// validation. HFSQL stores "no FK" as 0 (not NULL) — always guard both.
// `donationScope` widens IDcommande_donation to "free OR mine".
function ecruDonationWhere(commandeId: number): string {
  return `se.IDsociete = 1
    AND (se.IDligne_expedition_ETM IS NULL OR se.IDligne_expedition_ETM = 0)
    AND (se.IDligne_commande_client IS NULL OR se.IDligne_commande_client = 0)
    AND (se.IDref_commande_affectation IS NULL OR se.IDref_commande_affectation = 0)
    AND (se.IDcommande_donation IS NULL OR se.IDcommande_donation = 0 OR se.IDcommande_donation = ${commandeId})
    AND NOT EXISTS (SELECT 1 FROM stock_fini sfx WHERE sfx.IDstock_ecru = se.IDstock_ecru)`
}
function finiDonationWhere(commandeId: number): string {
  return `(sf.IDligne_expedition IS NULL OR sf.IDligne_expedition = 0)
    AND (sf.IDetat_stock_fini IS NULL OR sf.IDetat_stock_fini <> 4)
    AND (sf.IDligne_commande_client IS NULL OR sf.IDligne_commande_client = 0)
    AND (sf.IDcommande_donation IS NULL OR sf.IDcommande_donation = 0 OR sf.IDcommande_donation = ${commandeId})`
}

const ECRU_DONATION_SELECT = `SELECT se.IDstock_ecru, se.IDref_ecru, se.IDcolori_ecru, se.IDcommande_donation,
    se.numero, se.lot, se.poids, se.metrage, se.second_choix, se.observations, se.date_saisie,
    re.reference AS ref_label, ce.reference AS coloris_reference
  FROM stock_ecru se
  LEFT JOIN ref_ecru re ON se.IDref_ecru = re.IDref_ecru
  LEFT JOIN colori_ecru ce ON se.IDcolori_ecru = ce.IDcolori_ecru`

// Coloris is polymorphic by ref_fini.avec_teinture (0 = wash → colori_ecru,
// 1/2 = dyed → ref_fini_colori); select both labels and let repairAllJoins
// collapse them to coloris_reference (same pattern as stock-fini.ts).
const FINI_DONATION_SELECT = `SELECT sf.IDstock_fini, sf.IDref_fini, sf.IDColoris, sf.IDetat_stock_fini, sf.IDcommande_donation,
    sf.numero, sf.lot, sf.poids, sf.metrage, sf.second_choix, sf.observations, sf.date_saisie,
    rf.reference AS ref_fini, rf.avec_teinture, rfc.reference AS coloris_dyed, ce.reference AS coloris_wash
  FROM stock_fini sf
  LEFT JOIN ref_fini rf ON sf.IDref_fini = rf.IDref_fini
  LEFT JOIN ref_fini_colori rfc ON sf.IDColoris = rfc.IDref_fini_colori
  LEFT JOIN colori_ecru ce ON sf.IDColoris = ce.IDcolori_ecru`

async function hydrateDonationEcru(rows: any[], commandeId: number): Promise<DonationPiece[]> {
  let fixed = await repairAliased(rows, 'stock_ecru', 'IDstock_ecru', {
    numero: 'numero', lot: 'lot', observations: 'observations',
  })
  fixed = await repairAliased(fixed, 'ref_ecru', 'IDref_ecru', { ref_label: 'reference' })
  fixed = await repairAliased(fixed, 'colori_ecru', 'IDcolori_ecru', { coloris_reference: 'reference' })
  const defectsByEcru = await fetchDefectsByEcru(fixed.map((r: any) => Number(r.IDstock_ecru) || 0))
  return fixed.map((r: any) => ({
    id: Number(r.IDstock_ecru),
    ref_label: (r.ref_label ?? '').toString().trim() || null,
    coloris_reference: (r.coloris_reference ?? '').toString().trim() || null,
    numero: (r.numero ?? '').toString().trim() || null,
    poids: Number(r.poids) || 0,
    metrage: Number(r.metrage) || 0,
    lot: (r.lot ?? '').toString().trim() || null,
    date_saisie: r.date_saisie ?? null,
    second_choix: Number(r.second_choix) || 0,
    observations: (r.observations ?? '').toString().trim() || null,
    defauts: defautSummary(defectsByEcru.get(Number(r.IDstock_ecru) || 0) ?? []) || null,
    attached: Number(r.IDcommande_donation) === commandeId ? 1 : 0,
  }))
}

async function hydrateDonationFini(rows: any[], commandeId: number): Promise<DonationPiece[]> {
  let fixed = await repairAliased(rows, 'stock_fini', 'IDstock_fini', {
    numero: 'numero', lot: 'lot', observations: 'observations',
  })
  // Repairs ref_fini/coloris labels and collapses coloris_dyed/coloris_wash →
  // coloris_reference per avec_teinture. Missing aliases (etat, magasin) are
  // simply skipped by repairAliased.
  fixed = await repairAllJoins(fixed)
  return fixed.map((r: any) => ({
    id: Number(r.IDstock_fini),
    ref_label: (r.ref_fini ?? '').toString().trim() || null,
    coloris_reference: (r.coloris_reference ?? '').toString().trim() || null,
    numero: (r.numero ?? '').toString().trim() || null,
    poids: Number(r.poids) || 0,
    metrage: Number(r.metrage) || 0,
    lot: (r.lot ?? '').toString().trim() || null,
    date_saisie: r.date_saisie ?? null,
    second_choix: Number(r.second_choix) || 0,
    observations: (r.observations ?? '').toString().trim() || null,
    defauts: null,
    attached: Number(r.IDcommande_donation) === commandeId ? 1 : 0,
  }))
}

/** Attached pieces of both kinds — shared by the GET and the PUT response. */
async function buildDonationPieces(commandeId: number): Promise<{ ecru: DonationPiece[]; fini: DonationPiece[] }> {
  const [ecruRaw, finiRaw] = await Promise.all([
    query<any>(`${ECRU_DONATION_SELECT} WHERE se.IDcommande_donation = ${commandeId} ORDER BY re.reference, se.numero`),
    query<any>(`${FINI_DONATION_SELECT} WHERE sf.IDcommande_donation = ${commandeId} ORDER BY rf.reference, sf.numero`),
  ])
  const [ecru, fini] = await Promise.all([
    hydrateDonationEcru(ecruRaw, commandeId),
    hydrateDonationFini(finiRaw, commandeId),
  ])
  return { ecru, fini }
}

// GET /:id/donation-pieces — pieces currently attached to this commande.
commandesClientRouter.get('/:id/donation-pieces', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    res.json(await buildDonationPieces(id))
  } catch (err) {
    console.error('Error fetching donation pieces:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /:id/donation-candidates?kind=ecru|fini — the full eligible stock for
// the picker dialog. Pieces already attached to THIS commande are included
// with attached=1 (they render pre-checked).
commandesClientRouter.get('/:id/donation-candidates', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const kind = req.query.kind === 'fini' ? 'fini' : 'ecru'
    // Pieces already attached to THIS commande are always listed (pre-checked),
    // even when no longer "available" stock — e.g. état Expédié after the
    // donation shipped — so the user can still see and detach them.
    if (kind === 'ecru') {
      const rows = await query<any>(
        `${ECRU_DONATION_SELECT} WHERE (se.IDcommande_donation = ${id} OR (${ecruDonationWhere(id)})) ORDER BY re.reference, se.numero`,
      )
      res.json(await hydrateDonationEcru(rows, id))
    } else {
      const rows = await query<any>(
        `${FINI_DONATION_SELECT} WHERE (sf.IDcommande_donation = ${id} OR (${finiDonationWhere(id)})) ORDER BY rf.reference, sf.numero`,
      )
      res.json(await hydrateDonationFini(rows, id))
    }
  } catch (err) {
    console.error('Error fetching donation candidates:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /:id/donation-pieces { kind: 'ecru'|'fini', ids: number[] } —
// replace-set semantics per kind: `ids` becomes the attached set (the picker's
// Valider sends the full checked list). Adds are re-validated against the
// eligibility filters; pieces claimed elsewhere since the dialog opened are
// skipped, never stolen. Returns the refreshed attached payload (§31.6).
commandesClientRouter.put('/:id/donation-pieces', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const kind = req.body?.kind === 'fini' ? 'fini' : req.body?.kind === 'ecru' ? 'ecru' : null
    if (!kind) { res.status(400).json({ error: 'kind must be ecru or fini' }); return }
    const ids: number[] = (Array.isArray(req.body?.ids) ? req.body.ids : [])
      .map((x: unknown) => parseInt(String(x), 10))
      .filter((x: number) => Number.isInteger(x) && x > 0)
    if (ids.length > 5000) { res.status(400).json({ error: 'too many ids' }); return }

    const head = await query<{ donation: number | null; est_soldee: number | null }>(
      `SELECT donation, est_soldee FROM commande_client WHERE IDcommande_client = ${id}`,
    )
    if (head.length === 0) { res.status(404).json({ error: 'Commande not found' }); return }
    if (refuseIfSoldee(res, Number(head[0].est_soldee) || 0)) return
    if (Number(head[0].donation) !== 1) {
      res.status(409).json({ error: 'not_donation', message: 'Cette commande n’est pas une donation.' })
      return
    }

    const table = kind === 'ecru' ? 'stock_ecru' : 'stock_fini'
    const pk = kind === 'ecru' ? 'IDstock_ecru' : 'IDstock_fini'
    const currentRows = await query<any>(
      `SELECT ${pk} AS pid FROM ${table} WHERE IDcommande_donation = ${id}`,
    )
    const current = new Set(currentRows.map((r: any) => Number(r.pid)).filter((x: number) => x > 0))
    const wanted = new Set(ids)
    const toAdd = ids.filter((x) => !current.has(x))
    const toRemove = Array.from(current).filter((x) => !wanted.has(x))

    let added = 0
    if (toAdd.length > 0) {
      // Re-validate adds so a piece shipped / reserved / claimed by another
      // donation since the dialog opened is silently skipped.
      const alias = kind === 'ecru' ? 'se' : 'sf'
      const eligWhere = kind === 'ecru' ? ecruDonationWhere(id) : finiDonationWhere(id)
      const eligRows = await query<any>(
        `SELECT ${alias}.${pk} AS pid FROM ${table} ${alias}
         WHERE ${alias}.${pk} IN (${toAdd.join(',')}) AND ${eligWhere}`,
      )
      const eligible = eligRows.map((r: any) => Number(r.pid)).filter((x: number) => x > 0)
      if (eligible.length > 0) {
        await query(`UPDATE ${table} SET IDcommande_donation = ${id} WHERE ${pk} IN (${eligible.join(',')})`)
        added = eligible.length
      }
    }
    if (toRemove.length > 0) {
      await query(
        `UPDATE ${table} SET IDcommande_donation = 0 WHERE ${pk} IN (${toRemove.join(',')}) AND IDcommande_donation = ${id}`,
      )
    }

    res.json({ ok: true, added, removed: toRemove.length, skipped: toAdd.length - added, ...(await buildDonationPieces(id)) })
  } catch (err) {
    console.error('Error updating donation pieces:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  LINE CRUD
// ════════════════════════════════════════════════════════

/** A reference whose client contract has lapsed is not sellable — refuse the
 *  write, don't let it through on the standard grid. The UI blocks first; this
 *  is the authority (and covers a stale form or a direct API call).
 *  Returns true when it has answered 409. */
async function refuseIfContratExpire(
  res: Response,
  commandeId: number,
  line: { type: number; IDreference: number; IDcolori: number },
): Promise<boolean> {
  if (line.type !== 1 && line.type !== 2) return false
  const rows = await query<{ IDclient: number | null }>(
    `SELECT IDclient FROM commande_client WHERE IDcommande_client = ${commandeId}`,
  )
  const IDclient = Number(rows[0]?.IDclient) || 0
  if (!(IDclient > 0)) return false
  const mode = await resolveLigneTarifMode({
    IDclient, type: line.type, IDreference: line.IDreference, IDcolori: line.IDcolori,
  })
  if (!mode?.contrat_expire) return false
  res.status(409).json({ error: 'contrat_expire', message: expiredContractMessage(mode) })
  return true
}

commandesClientRouter.post('/:id/lignes', async (req: Request, res: Response) => {
  try {
    if (!(await requireEditCommandes(req, res))) return
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (refuseIfSoldee(res, await loadCommandeSoldee(id))) return
    // Donation orders carry stock pieces, not lignes — refuse so the two
    // models can never mix on one commande.
    const donRows = await query<{ donation: number | null }>(
      `SELECT donation FROM commande_client WHERE IDcommande_client = ${id}`,
    )
    if (Number(donRows[0]?.donation) === 1) {
      res.status(409).json({
        error: 'commande_donation',
        message: 'Commande en donation — les pièces s’attachent via l’onglet Donation, pas par des lignes.',
      })
      return
    }
    const parsed = ligneBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data
    const typeKind = Number(d.type) || 0
    if (await refuseIfContratExpire(res, id, {
      type: typeKind, IDreference: d.IDreference ?? 0, IDcolori: d.IDcolori ?? 0,
    })) return
    // TYPE written uppercase (reserved word); IDcolori lowercase; commentaire
    // accent-safe via sqlText. Accented line columns are never named.
    await query(
      `INSERT INTO ligne_commande_client
         (IDcommande_client, IDligne_commande_ETM, TYPE, IDreference, IDcolori,
          IDVariation1, IDVariation2,
          quantite, unite, prix, poids, date_livraison, commentaire)
       VALUES
         (${id}, 0, ${typeKind}, ${n(d.IDreference ?? 0)}, ${n(d.IDcolori ?? 0)},
          ${n(typeKind === 3 ? (d.IDVariation1 ?? 0) : 0)}, ${n(typeKind === 3 ? (d.IDVariation2 ?? 0) : 0)},
          ${Number(d.quantite) || 0}, ${n(d.unite ?? 0)}, ${Number(d.prix) || 0},
          ${Number(d.poids) || 0}, '${d.date_livraison ? dateStr(d.date_livraison) : ''}',
          ${sqlText(d.commentaire ?? '')})`,
    )
    const newRows = await query<{ IDligne_commande_client: number }>(
      `SELECT IDligne_commande_client FROM ligne_commande_client
       WHERE IDcommande_client = ${id} ORDER BY IDligne_commande_client DESC`,
    )
    res.status(201).json({ IDligne_commande_client: Number(newRows[0]?.IDligne_commande_client) || 0 })
  } catch (err) {
    console.error('Error creating ligne-commande-client:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesClientRouter.put('/lignes/:lineId', async (req: Request, res: Response) => {
  try {
    if (!(await requireEditCommandes(req, res))) return
    const lineId = parseInt(req.params.lineId, 10)
    if (isNaN(lineId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const commandeId = await loadCommandeIdForLine(lineId)
    if (commandeId == null) { res.status(404).json({ error: 'Line not found' }); return }
    if (refuseIfSoldee(res, await loadCommandeSoldee(commandeId))) return
    const parsed = ligneBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data

    // Contract guard on update. The body is partial, so the check runs on the
    // line as it WOULD be, and only when the payload actually changes something
    // commercial (référence, coloris, quantité, prix). A line taken while the
    // contract was still valid stays editable for its date or its comment —
    // blocking those would punish the user for a lapse they can't fix here.
    {
      const cur = await query<Record<string, unknown>>(
        `SELECT TYPE, IDreference, IDcolori, quantite, prix FROM ligne_commande_client WHERE IDligne_commande_client = ${lineId}`,
      )
      const row = cur[0] ?? {}
      // TYPE is a reserved word — ODBC hands the key back uppercased.
      const curType = Number(row.TYPE ?? (row as { type?: unknown }).type) || 0
      const next = {
        type: d.type ?? curType,
        IDreference: d.IDreference ?? (Number(row.IDreference) || 0),
        IDcolori: d.IDcolori ?? (Number(row.IDcolori) || 0),
      }
      const commercialChange =
        next.type !== curType ||
        next.IDreference !== (Number(row.IDreference) || 0) ||
        next.IDcolori !== (Number(row.IDcolori) || 0) ||
        (d.quantite !== undefined && Number(d.quantite) !== (Number(row.quantite) || 0)) ||
        // `prix` is a 4-byte REAL: compare at the centime, never raw floats.
        (d.prix !== undefined && Math.round(Number(d.prix) * 100) !== Math.round((Number(row.prix) || 0) * 100))
      if (commercialChange && await refuseIfContratExpire(res, commandeId, next)) return
    }

    const sets: string[] = []
    if (d.type !== undefined) sets.push(`TYPE = ${Number(d.type) || 0}`)
    if (d.IDreference !== undefined) sets.push(`IDreference = ${n(d.IDreference)}`)
    if (d.IDcolori !== undefined) sets.push(`IDcolori = ${n(d.IDcolori)}`)
    // Variations only mean anything on divers lines — switching a line to
    // écru/fini clears them so a stale axis can't survive the type change.
    if (d.IDVariation1 !== undefined) sets.push(`IDVariation1 = ${n(d.type !== undefined && d.type !== 3 ? 0 : d.IDVariation1)}`)
    if (d.IDVariation2 !== undefined) sets.push(`IDVariation2 = ${n(d.type !== undefined && d.type !== 3 ? 0 : d.IDVariation2)}`)
    if (d.quantite !== undefined) sets.push(`quantite = ${Number(d.quantite) || 0}`)
    if (d.unite !== undefined) sets.push(`unite = ${n(d.unite)}`)
    if (d.prix !== undefined) sets.push(`prix = ${Number(d.prix) || 0}`)
    if (d.poids !== undefined) sets.push(`poids = ${Number(d.poids) || 0}`)
    if (d.date_livraison !== undefined) sets.push(`date_livraison = '${dateStr(d.date_livraison)}'`)
    if (d.commentaire !== undefined) sets.push(`commentaire = ${sqlText(d.commentaire)}`)
    if (sets.length === 0) { res.status(400).json({ error: 'No fields to update' }); return }

    await query(`UPDATE ligne_commande_client SET ${sets.join(', ')} WHERE IDligne_commande_client = ${lineId}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating ligne-commande-client:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesClientRouter.delete('/lignes/:lineId', async (req: Request, res: Response) => {
  try {
    if (!(await requireEditCommandes(req, res))) return
    const lineId = parseInt(req.params.lineId, 10)
    if (isNaN(lineId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const commandeId = await loadCommandeIdForLine(lineId)
    if (commandeId == null) { res.status(404).json({ error: 'Line not found' }); return }
    if (refuseIfSoldee(res, await loadCommandeSoldee(commandeId))) return
    // Release this line's reserved rolls first.
    await query(`UPDATE stock_ecru SET IDligne_commande_client = 0 WHERE IDligne_commande_client = ${lineId}`)
    await query(`UPDATE stock_fini SET IDligne_commande_client = 0 WHERE IDligne_commande_client = ${lineId}`)
    await query(`DELETE FROM ligne_commande_client WHERE IDligne_commande_client = ${lineId}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting ligne-commande-client:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  AFFECTATION  (reserve écru / fini rolls to a line)
// ════════════════════════════════════════════════════════

interface ClientLineContext {
  commandeId: number
  ligneId: number
  typeKind: number
  kind: 'ecru' | 'fini' | 'none'
  refId: number
  coloriId: number
  unite: number
  quantite: number
}

async function loadClientLineContext(commandeId: number, ligneId: number): Promise<ClientLineContext | null> {
  // IDcolori is lowercase on ligne_commande_client (not IDColoris); TYPE is reserved.
  const rows = await query<any>(
    `SELECT IDcommande_client, TYPE AS type_kind, IDreference, IDcolori, unite, quantite
     FROM ligne_commande_client WHERE IDligne_commande_client = ${ligneId}`,
  )
  if (rows.length === 0) return null
  const l = rows[0]
  if (Number(l.IDcommande_client) !== commandeId) return null
  const typeKind = Number(l.type_kind) || 0
  return {
    commandeId,
    ligneId,
    typeKind,
    kind: lineStockKind(typeKind),
    refId: Number(l.IDreference) || 0,
    coloriId: Number(l.IDcolori) || 0,
    unite: Number(l.unite) || 0,
    quantite: Number(l.quantite) || 0,
  }
}

interface RollLite {
  id: number
  numero: string | null
  lot: string | null
  poids: number | null
  metrage: number | null
  coloris_reference: string | null
  magasin_nom: string | null
  second_choix: number | null
  observations: string | null
  /** Fini only — the ennoblisseur's defect report (stock_fini.observation_sst). */
  observation_sst: string | null
  etat_label: string | null
  /** Roll already shipped (état Expédié / expedition line set) — the
   *  affectation is locked, unlink is refused. */
  expedie: boolean
}

const ETAT_FINI_LABELS: Record<number, string> = {
  1: 'En Contrôle', 2: 'En Reprise', 3: 'Validé', 4: 'Expédié', 5: 'Attente décision',
}

/** Resolve magasin (sous_traitant) names for a set of IDmagasin. */
async function resolveMagasinNames(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const u = Array.from(new Set(ids.filter((x) => x > 0)))
  if (u.length === 0) return out
  const rows = await query<{ IDsous_traitant: number; nom: unknown }>(
    `SELECT IDsous_traitant, CONVERT(nom USING 'UTF-8') AS nom FROM sous_traitant WHERE IDsous_traitant IN (${u.join(',')})`,
  )
  for (const r of rows) out.set(Number(r.IDsous_traitant), decode(r.nom) ?? '')
  return out
}

/** Resolve company names (IDsociete → societe.nom): 1=Ets Malterre, 2=Tricotage
 *  Malterre, 3=Malterre Confection. Used to label factory ("à l'usine") écru by
 *  its owning company. Names are ASCII so no CONVERT/fixEncoding needed. */
async function resolveSocieteNames(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const u = Array.from(new Set(ids.filter((x) => x > 0)))
  if (u.length === 0) return out
  const rows = await query<{ IDsociete: number; nom: string | null }>(
    `SELECT IDsociete, nom FROM societe WHERE IDsociete IN (${u.join(',')})`,
  )
  for (const r of rows) out.set(Number(r.IDsociete), (r.nom ?? '').toString())
  return out
}

/** Resolve coloris labels for écru rolls (IDcolori_ecru → colori_ecru). */
async function resolveEcruColoris(coloriIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const u = Array.from(new Set(coloriIds.filter((x) => x > 0)))
  if (u.length === 0) return out
  const rows = await query<{ IDcolori_ecru: number; reference: string | null }>(
    `SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDcolori_ecru IN (${u.join(',')})`,
  )
  for (const r of await fixEncoding(rows, 'colori_ecru', 'IDcolori_ecru', ['reference']))
    out.set(Number(r.IDcolori_ecru), (r.reference ?? '').toString())
  return out
}

/** Resolve coloris labels for fini rolls — branch by the line ref's avec_teinture. */
async function resolveFiniColoris(coloriIds: number[], avecTeinture: number): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const u = Array.from(new Set(coloriIds.filter((x) => x > 0)))
  if (u.length === 0) return out
  if (avecTeinture === 0) {
    const rows = await query<{ IDcolori_ecru: number; reference: string | null }>(
      `SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDcolori_ecru IN (${u.join(',')})`,
    )
    for (const r of await fixEncoding(rows, 'colori_ecru', 'IDcolori_ecru', ['reference']))
      out.set(Number(r.IDcolori_ecru), (r.reference ?? '').toString())
  } else {
    const rows = await query<{ IDref_fini_colori: number; reference: string | null }>(
      `SELECT IDref_fini_colori, reference FROM ref_fini_colori WHERE IDref_fini_colori IN (${u.join(',')})`,
    )
    for (const r of await fixEncoding(rows, 'ref_fini_colori', 'IDref_fini_colori', ['reference']))
      out.set(Number(r.IDref_fini_colori), (r.reference ?? '').toString())
  }
  return out
}

async function fetchAffectationPayload(ctx: ClientLineContext) {
  const dim = lineDim(ctx.unite) as 'metrage' | 'poids'
  const base = {
    kind: ctx.kind,
    unite: ctx.unite,
    unite_label: uniteLabel(ctx.unite),
    dim,
    target_qty: ctx.quantite,
    // Combined "affecté" gauge — rolls (both stock tables) + tricotage
    // planning allocations, in the line's dim. Drives the line bar, the
    // drawer bar and the create-order modal footers.
    affecte_total: 0,
    linked: [] as RollLite[],
    available: [] as RollLite[],
  }
  if (ctx.kind === 'none' || ctx.refId <= 0) return base
  const agg = (await lineReservationAggregates([
    { id: ctx.ligneId, typeKind: ctx.typeKind, refId: ctx.refId },
  ])).get(ctx.ligneId)
  if (agg) base.affecte_total = dim === 'metrage' ? agg.total_metrage : agg.total_poids

  if (ctx.kind === 'ecru') {
    // Linked = rolls reserved to this line. Available = ETM rolls of this ref,
    // not reserved/shipped/at-a-dyer, and not already consumed into a fini roll.
    const [linkedRaw, availRaw] = await Promise.all([
      query<any>(
        `SELECT IDstock_ecru, numero, lot, poids, metrage, IDcolori_ecru, IDmagasin, second_choix, observations, IDligne_expedition_ETM
         FROM stock_ecru WHERE IDligne_commande_client = ${ctx.ligneId}
         ORDER BY date_saisie DESC, IDstock_ecru DESC`,
      ),
      query<any>(
        `SELECT IDstock_ecru, numero, lot, poids, metrage, IDcolori_ecru, IDmagasin, second_choix, observations, IDligne_expedition_ETM
         FROM stock_ecru
         WHERE IDref_ecru = ${ctx.refId} AND IDsociete = 1
           AND (${ctx.coloriId} = 0 OR IDcolori_ecru = ${ctx.coloriId})
           AND (IDligne_commande_client IS NULL OR IDligne_commande_client = 0)
           AND (IDcommande_donation IS NULL OR IDcommande_donation = 0)
           AND (IDligne_expedition_ETM IS NULL OR IDligne_expedition_ETM = 0)
           AND (IDref_commande_affectation IS NULL OR IDref_commande_affectation = 0)
         ORDER BY date_saisie DESC, IDstock_ecru DESC`,
      ),
    ])
    // Drop available écru rolls already consumed into a stock_fini (dyed).
    const availIds = availRaw.map((r: any) => Number(r.IDstock_ecru)).filter((x: number) => x > 0)
    const consumed = new Set<number>()
    if (availIds.length > 0) {
      const dyed = await query<{ IDstock_ecru: number }>(
        `SELECT DISTINCT IDstock_ecru FROM stock_fini WHERE IDstock_ecru IN (${availIds.join(',')})`,
      )
      for (const r of dyed) consumed.add(Number(r.IDstock_ecru))
    }
    const avail = availRaw.filter((r: any) => !consumed.has(Number(r.IDstock_ecru)))
    const linkedFixed = await fixEncoding(linkedRaw, 'stock_ecru', 'IDstock_ecru', ['numero', 'lot', 'observations'])
    const availFixed = await fixEncoding(avail, 'stock_ecru', 'IDstock_ecru', ['numero', 'lot', 'observations'])
    const magNames = await resolveMagasinNames([...linkedFixed, ...availFixed].map((r: any) => Number(r.IDmagasin)))
    const colNames = await resolveEcruColoris([...linkedFixed, ...availFixed].map((r: any) => Number(r.IDcolori_ecru)))
    const toRoll = (r: any): RollLite => ({
      id: Number(r.IDstock_ecru),
      numero: r.numero ?? null,
      lot: r.lot ?? null,
      poids: Number(r.poids) || 0,
      metrage: Number(r.metrage) || 0,
      coloris_reference: colNames.get(Number(r.IDcolori_ecru)) ?? null,
      magasin_nom: magNames.get(Number(r.IDmagasin)) ?? null,
      second_choix: Number(r.second_choix) || 0,
      observations: r.observations ?? null,
      observation_sst: null,
      etat_label: null,
      expedie: (Number(r.IDligne_expedition_ETM) || 0) > 0,
    })
    base.linked = linkedFixed.map(toRoll)
    base.available = availFixed.map(toRoll)
    return base
  }

  // fini
  const refRows = await query<{ avec_teinture: number | null }>(
    `SELECT avec_teinture FROM ref_fini WHERE IDref_fini = ${ctx.refId}`,
  )
  const avecTeinture = Number(refRows[0]?.avec_teinture) || 0
  const [linkedRaw, availRaw] = await Promise.all([
    query<any>(
      `SELECT IDstock_fini, numero, lot, poids, metrage, IDColoris, IDmagasin, second_choix, observations, observation_sst, IDetat_stock_fini, IDligne_expedition
       FROM stock_fini WHERE IDligne_commande_client = ${ctx.ligneId}
       ORDER BY date_saisie DESC, IDstock_fini DESC`,
    ),
    query<any>(
      `SELECT IDstock_fini, numero, lot, poids, metrage, IDColoris, IDmagasin, second_choix, observations, observation_sst, IDetat_stock_fini, IDligne_expedition
       FROM stock_fini
       WHERE IDref_fini = ${ctx.refId}
         AND (${ctx.coloriId} = 0 OR IDColoris = ${ctx.coloriId})
         AND (IDligne_commande_client IS NULL OR IDligne_commande_client = 0)
         AND (IDcommande_donation IS NULL OR IDcommande_donation = 0)
         AND (IDligne_expedition IS NULL OR IDligne_expedition = 0)
         AND (IDetat_stock_fini IS NULL OR IDetat_stock_fini <> 4)
       ORDER BY date_saisie DESC, IDstock_fini DESC`,
    ),
  ])
  const linkedFixed = await fixEncoding(linkedRaw, 'stock_fini', 'IDstock_fini', ['numero', 'lot', 'observations', 'observation_sst'])
  const availFixed = await fixEncoding(availRaw, 'stock_fini', 'IDstock_fini', ['numero', 'lot', 'observations', 'observation_sst'])
  const magNames = await resolveMagasinNames([...linkedFixed, ...availFixed].map((r: any) => Number(r.IDmagasin)))
  const colNames = await resolveFiniColoris([...linkedFixed, ...availFixed].map((r: any) => Number(r.IDColoris)), avecTeinture)
  const toRoll = (r: any): RollLite => ({
    id: Number(r.IDstock_fini),
    numero: r.numero ?? null,
    lot: r.lot ?? null,
    poids: Number(r.poids) || 0,
    metrage: Number(r.metrage) || 0,
    coloris_reference: colNames.get(Number(r.IDColoris)) ?? null,
    magasin_nom: magNames.get(Number(r.IDmagasin)) ?? null,
    second_choix: Number(r.second_choix) || 0,
    observations: r.observations ?? null,
    observation_sst: r.observation_sst ?? null,
    etat_label: ETAT_FINI_LABELS[Number(r.IDetat_stock_fini)] ?? null,
    expedie: Number(r.IDetat_stock_fini) === 4 || (Number(r.IDligne_expedition) || 0) > 0,
  })
  base.linked = linkedFixed.map(toRoll)
  base.available = availFixed.map(toRoll)
  return base
}

// ════════════════════════════════════════════════════════
//  SUPPLY — in-progress sous-traitant orders feeding a client line
//  (Tricotage = knitting the écru, Ennoblissement = dyeing it to the fini).
//  Read-only planning view. Mirrors the legacy "Gestion ligne de commande"
//  Ennoblissement / Tricotage tabs. Validated against legacy on commande 3686:
//   - Ennoblissement disponible/affecté = input écru (stock_ecru via
//     IDref_commande_affectation) × fini rendement; affecté = rolls reserved
//     to THIS client line only.
//   - Tricotage reads the affectation_cmd_tricotage planning table (NOT
//     stock_ecru rolls): affecté = poids allocated to THIS client line,
//     disponible = line quantite − ALL allocations, métrage = affecté × rdt.
// ════════════════════════════════════════════════════════

interface SupplyTricoRow {
  id: number
  commande_id: number
  date_commande: string | null
  sous_traitant_nom: string | null
  date_livraison: string | null
  etat_label: string
  poids_disponible: number
  poids_affecte: number
  metrage_potentiel: number
}
interface SupplyEnnoRow {
  id: number
  commande_id: number
  date_commande: string | null
  sous_traitant_nom: string | null
  date_livraison: string | null
  etat_label: string
  qte_disponible: number
  qte_affecte: number
}
interface SupplyPayload {
  applicable: boolean
  tricotage: SupplyTricoRow[]
  ennoblissement: SupplyEnnoRow[]
}

// Open (in-progress) line statuses — sent to the sous-traitant and awaiting /
// in production. Excludes Non_Envoye (draft) and Terminé (done). ASCII literals
// only, so no accented-identifier hazard on the Linux bridge.
// Which sst lines still feed a client line: everything that is NOT finished —
// deliberately a denylist. It used to enumerate the open statuts
// ('En_Cours','Attente_Delai'), which silently hid every other live state: a
// brand-new order starts `Non_Envoye` (so an order created from the drawer's
// own "Nouvelle commande" button never showed up in the table right above it,
// and neither did a knitting order for any external tricoteur — createKnitOrder
// only uses Attente_Delai for Tricotage Malterre), and the legacy
// `Notification` / `Soumis_Au_Client` lines were invisible too. `Terminé` is
// the only finished state (isLineDone in sst-shared) and `cst.est_soldee = 0`
// already drops settled orders.
//
// Matched on the ASCII prefix on purpose — the value is accented and naming
// 'Terminé' in SQL would push raw UTF-8 through the Linux bridge (CLAUDE.md:
// corrupts it). A JS-side isLineDone() is NOT an option either: ODBC returns
// the value as 'Termin�', so the comparison would never match and every
// finished line would be treated as open. Verified 2026-07-30.
const SUPPLY_NOT_DONE = (alias: string) =>
  `(${alias}.sstatut IS NULL OR ${alias}.sstatut NOT LIKE 'Termin%')`

const SSTATUT_LABELS: Array<[prefix: string, label: string]> = [
  ['En_Cours', 'En cours'], ['Attente_Delai', 'Attente délai'], ['Non_Envoye', 'Non envoyé'],
  ['Notification', 'Notification'], ['Soumis_Au_Client', 'Soumis au client'],
  ['A_Soumettre', 'À soumettre'], ['Non_Affect', 'Non affecté'], ['Delai_Expir', 'Délai expiré'],
  ['En_Contr', 'En contrôle'], ['En_Reprise', 'En reprise'], ['En_Cr', 'En création'],
  ['Termin', 'Terminé'],
]

/** Label for a legacy `sstatut`. Keyed on the ASCII prefix because the accented
 *  values arrive mangled from ODBC (`Delai_Expiré` → `Delai_Expir�`), so an
 *  exact-match map would fall through and print the mojibake to the user. */
function sstatutLabel(raw: unknown): string {
  const s = String(raw ?? '').trim()
  const ascii = s.replace(/[^\x20-\x7E]/g, '')
  for (const [prefix, label] of SSTATUT_LABELS) if (ascii.startsWith(prefix)) return label
  return ascii || s
}
const round2c = (v: number) => Math.round(v * 100) / 100

async function buildTricotage(ecruRefId: number, rendement: number, coloriIds: number[], ligneId: number): Promise<SupplyTricoRow[]> {
  // Coloris filter: a tricoteur line's IDColoris is the colori_ecru being
  // knitted. Without it, a 029/gris-anthracite knitting order leaks into the
  // supply view of a line that needs 029/ecru (legacy commande 8524 case).
  // Empty list → no filter (coloris restriction couldn't be resolved).
  const coloriFilter = coloriIds.length > 0 ? ` AND lcs.IDColoris IN (${coloriIds.join(',')})` : ''
  const lines = await query<any>(
    `SELECT lcs.IDligne_commande_sous_traitant AS lid, lcs.quantite AS q, lcs.date_livraison AS dl,
            lcs.sstatut AS st, cst.IDsous_traitant AS sstid,
            cst.IDcommande_sous_traitant AS cid, cst.date_commande AS dc
       FROM ligne_commande_sous_traitant lcs
       JOIN commande_sous_traitant cst ON cst.IDcommande_sous_traitant = lcs.IDcommande_sous_traitant
      WHERE lcs.type = 1 AND lcs.IDreference = ${ecruRefId}${coloriFilter}
        AND cst.est_soldee = 0 AND ${SUPPLY_NOT_DONE('lcs')}`,
  )
  if (lines.length === 0) return []
  const lineIds = lines.map((l: any) => Number(l.lid)).filter((x: number) => x > 0)
  // Planning allocations, NOT produced rolls: legacy binds this grid to the
  // affectation_cmd_tricotage table. "Affecté" is the weight allocated to THIS
  // client line; "disponible" is the line quantity minus allocations to ANY
  // line (commande 3686: lines 8558/8464 have no allocation rows → legacy
  // shows dispo 6388/4000, affecté 0 — even with 240.8 kg of produced rolls
  // reserved to the client line via stock_ecru).
  const affThis = new Map<number, number>()
  const allocAll = new Map<number, number>()
  if (lineIds.length > 0) {
    const rows = await query<any>(
      `SELECT IDligne_commande_sous_traitant AS lid, IDligne_commande_client AS lcc, poids_affecte
         FROM affectation_cmd_tricotage WHERE IDligne_commande_sous_traitant IN (${lineIds.join(',')})`,
    )
    for (const r of rows) {
      const lid = Number(r.lid)
      const p = Number(r.poids_affecte) || 0
      allocAll.set(lid, (allocAll.get(lid) ?? 0) + p)
      if (Number(r.lcc) === ligneId) affThis.set(lid, (affThis.get(lid) ?? 0) + p)
    }
  }
  const sstNames = await resolveMagasinNames(lines.map((l: any) => Number(l.sstid)))
  return lines.map((l: any) => {
    const lid = Number(l.lid)
    const aff = affThis.get(lid) ?? 0
    const dispo = Math.max(0, (Number(l.q) || 0) - (allocAll.get(lid) ?? 0))
    return {
      id: lid,
      commande_id: Number(l.cid),
      date_commande: l.dc ?? null,
      sous_traitant_nom: sstNames.get(Number(l.sstid)) ?? null,
      date_livraison: l.dl ?? null,
      etat_label: sstatutLabel(l.st),
      poids_disponible: round2c(dispo),
      poids_affecte: round2c(aff),
      metrage_potentiel: round2c(aff * rendement),
    }
  })
}

async function buildEnnoblissement(finiRefId: number, rendement: number, coloriId: number, ligneId: number): Promise<SupplyEnnoRow[]> {
  // Match the client line's coloris too: an ennoblisseur line is keyed on
  // (fini ref, ref_fini_colori) via lcs.IDColoris. Without this filter a dye
  // order for a different coloris of the same ref_fini (e.g. 029A Blanc) leaks
  // into the supply view of an 029A Marine client line. coloriId=0 → no filter.
  const lines = await query<any>(
    `SELECT lcs.IDligne_commande_sous_traitant AS lid, lcs.date_livraison AS dl,
            lcs.sstatut AS st, cst.IDsous_traitant AS sstid,
            cst.IDcommande_sous_traitant AS cid, cst.date_commande AS dc
       FROM ligne_commande_sous_traitant lcs
       JOIN commande_sous_traitant cst ON cst.IDcommande_sous_traitant = lcs.IDcommande_sous_traitant
      WHERE lcs.type = 2 AND lcs.IDreference = ${finiRefId}
        AND (${coloriId} = 0 OR lcs.IDColoris = ${coloriId})
        AND cst.est_soldee = 0 AND ${SUPPLY_NOT_DONE('lcs')}`,
  )
  if (lines.length === 0) return []
  const lineIds = lines.map((l: any) => Number(l.lid)).filter((x: number) => x > 0)
  // Input écru affected to each ennoblisseur line, split by client-affectation.
  // "Affecté" counts ONLY the rolls reserved to THIS client line (legacy shows
  // per-line affectation — commande 3686 vs sst 8558/8559 case). Rolls reserved
  // to another client line or to a donation commande are spoken for elsewhere:
  // they count in neither column (not affecté here, never disponible).
  const affKg = new Map<number, number>()
  const dispoKg = new Map<number, number>()
  if (lineIds.length > 0) {
    const rows = await query<any>(
      `SELECT IDref_commande_affectation AS lid, IDligne_commande_client AS lcc, IDcommande_donation AS don, poids
         FROM stock_ecru WHERE IDref_commande_affectation IN (${lineIds.join(',')})`,
    )
    for (const r of rows) {
      const lid = Number(r.lid)
      const p = Number(r.poids) || 0
      if (Number(r.lcc) === ligneId) affKg.set(lid, (affKg.get(lid) ?? 0) + p)
      else if (!(Number(r.lcc) > 0) && !(Number(r.don) > 0)) dispoKg.set(lid, (dispoKg.get(lid) ?? 0) + p)
    }
  }
  const sstNames = await resolveMagasinNames(lines.map((l: any) => Number(l.sstid)))
  return lines.map((l: any) => {
    const lid = Number(l.lid)
    return {
      id: lid,
      commande_id: Number(l.cid),
      date_commande: l.dc ?? null,
      sous_traitant_nom: sstNames.get(Number(l.sstid)) ?? null,
      date_livraison: l.dl ?? null,
      etat_label: sstatutLabel(l.st),
      qte_disponible: round2c((dispoKg.get(lid) ?? 0) * rendement),
      qte_affecte: round2c((affKg.get(lid) ?? 0) * rendement),
    }
  })
}

async function fetchSupplyPayload(ctx: ClientLineContext): Promise<SupplyPayload> {
  const base: SupplyPayload = { applicable: false, tricotage: [], ennoblissement: [] }
  if (ctx.kind === 'none' || ctx.refId <= 0) return base

  let ecruRefId = 0
  let finiRefId = 0
  let rendement = 0
  // Écru coloris the tricotage view is restricted to (same rule as the
  // écru-disponible pool / stock-fil panel): dyed finis knit the natural
  // "ecru" base, wash finis and écru lines knit the line's own colori_ecru.
  let ecruColoris: number[] = []
  if (ctx.kind === 'fini') {
    finiRefId = ctx.refId
    const r = await query<{ IDref_ecru: number | null; rendement: number | null; avec_teinture: number | null }>(
      `SELECT IDref_ecru, rendement, avec_teinture FROM ref_fini WHERE IDref_fini = ${finiRefId}`,
    )
    ecruRefId = Number(r[0]?.IDref_ecru) || 0
    rendement = Number(r[0]?.rendement) || 0
    const avecTeinture = Number(r[0]?.avec_teinture) || 0
    if (ecruRefId > 0) ecruColoris = await ennoInputColoriIds(ecruRefId, avecTeinture, ctx.coloriId)
  } else {
    ecruRefId = ctx.refId
    const r = await query<{ rendement: number | null }>(
      `SELECT rendement FROM ref_ecru WHERE IDref_ecru = ${ecruRefId}`,
    )
    rendement = Number(r[0]?.rendement) || 0
    if (ctx.coloriId > 0) ecruColoris = [ctx.coloriId]
  }
  // Use the raw rendement (NOT rounded) — the écru→fini métrage must match the
  // legacy exactly (e.g. 240.60 kg × 3.548387 = 853.74 ml, validated).

  const tricotage = ecruRefId > 0 ? await buildTricotage(ecruRefId, rendement, ecruColoris, ctx.ligneId) : []
  const ennoblissement = finiRefId > 0 ? await buildEnnoblissement(finiRefId, rendement, ctx.coloriId, ctx.ligneId) : []
  return { applicable: true, tricotage, ennoblissement }
}

commandesClientRouter.get('/:id/lignes/:ligneId/supply', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.id, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    if (isNaN(commandeId) || isNaN(ligneId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const ctx = await loadClientLineContext(commandeId, ligneId)
    if (!ctx) { res.status(404).json({ error: 'Line not found or does not belong to commande' }); return }
    res.json(await fetchSupplyPayload(ctx))
  } catch (err) {
    console.error('Error fetching line supply:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesClientRouter.get('/:id/lignes/:ligneId/pieces', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.id, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    if (isNaN(commandeId) || isNaN(ligneId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const ctx = await loadClientLineContext(commandeId, ligneId)
    if (!ctx) { res.status(404).json({ error: 'Line not found or does not belong to commande' }); return }
    res.json(await fetchAffectationPayload(ctx))
  } catch (err) {
    console.error('Error fetching line affectation:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Reserve / release an écru roll.
commandesClientRouter.put('/:id/lignes/:ligneId/pieces/ecru/:stockId', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.id, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    const stockId = parseInt(req.params.stockId, 10)
    if (isNaN(commandeId) || isNaN(ligneId) || isNaN(stockId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const ctx = await loadClientLineContext(commandeId, ligneId)
    if (!ctx || ctx.kind !== 'ecru') { res.status(404).json({ error: 'Écru line not found' }); return }
    if (refuseIfSoldee(res, await loadCommandeSoldee(commandeId))) return
    const rollRows = await query<{ IDref_ecru: number; IDcolori_ecru: number | null; IDligne_commande_client: number | null }>(
      `SELECT IDref_ecru, IDcolori_ecru, IDligne_commande_client FROM stock_ecru WHERE IDstock_ecru = ${stockId}`,
    )
    if (rollRows.length === 0) { res.status(404).json({ error: 'Stock ecru not found' }); return }
    if (Number(rollRows[0].IDref_ecru) !== ctx.refId) { res.status(400).json({ error: 'Roll ref does not match the line' }); return }
    if (ctx.coloriId > 0 && Number(rollRows[0].IDcolori_ecru) !== ctx.coloriId) { res.status(400).json({ error: 'Roll coloris does not match the line' }); return }
    const current = Number(rollRows[0].IDligne_commande_client) || 0
    if (current !== 0 && current !== ligneId) { res.status(409).json({ error: 'Roll already reserved to another line' }); return }
    await query(`UPDATE stock_ecru SET IDligne_commande_client = ${ligneId} WHERE IDstock_ecru = ${stockId}`)
    res.json(await fetchAffectationPayload(ctx))
  } catch (err) {
    console.error('Error linking ecru to client line:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesClientRouter.delete('/:id/lignes/:ligneId/pieces/ecru/:stockId', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.id, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    const stockId = parseInt(req.params.stockId, 10)
    if (isNaN(commandeId) || isNaN(ligneId) || isNaN(stockId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const ctx = await loadClientLineContext(commandeId, ligneId)
    if (!ctx || ctx.kind !== 'ecru') { res.status(404).json({ error: 'Écru line not found' }); return }
    if (refuseIfSoldee(res, await loadCommandeSoldee(commandeId))) return
    // A shipped roll's affectation is locked — the expedition owns it.
    const rollRows = await query<{ IDligne_expedition_ETM: number | null }>(
      `SELECT IDligne_expedition_ETM FROM stock_ecru WHERE IDstock_ecru = ${stockId}`,
    )
    if (rollRows.length > 0 && (Number(rollRows[0].IDligne_expedition_ETM) || 0) > 0) {
      res.status(409).json({ error: 'Roll already shipped — affectation locked' }); return
    }
    await query(`UPDATE stock_ecru SET IDligne_commande_client = 0 WHERE IDstock_ecru = ${stockId} AND IDligne_commande_client = ${ligneId}`)
    res.json(await fetchAffectationPayload(ctx))
  } catch (err) {
    console.error('Error unlinking ecru from client line:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Reserve / release a fini roll.
commandesClientRouter.put('/:id/lignes/:ligneId/pieces/fini/:stockId', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.id, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    const stockId = parseInt(req.params.stockId, 10)
    if (isNaN(commandeId) || isNaN(ligneId) || isNaN(stockId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const ctx = await loadClientLineContext(commandeId, ligneId)
    if (!ctx || ctx.kind !== 'fini') { res.status(404).json({ error: 'Fini line not found' }); return }
    if (refuseIfSoldee(res, await loadCommandeSoldee(commandeId))) return
    const rollRows = await query<{ IDref_fini: number; IDColoris: number | null; IDligne_commande_client: number | null; IDetat_stock_fini: number | null }>(
      `SELECT IDref_fini, IDColoris, IDligne_commande_client, IDetat_stock_fini FROM stock_fini WHERE IDstock_fini = ${stockId}`,
    )
    if (rollRows.length === 0) { res.status(404).json({ error: 'Stock fini not found' }); return }
    if (Number(rollRows[0].IDref_fini) !== ctx.refId) { res.status(400).json({ error: 'Roll ref does not match the line' }); return }
    if (ctx.coloriId > 0 && Number(rollRows[0].IDColoris) !== ctx.coloriId) { res.status(400).json({ error: 'Roll coloris does not match the line' }); return }
    const current = Number(rollRows[0].IDligne_commande_client) || 0
    if (current !== 0 && current !== ligneId) { res.status(409).json({ error: 'Roll already reserved to another line' }); return }
    await query(`UPDATE stock_fini SET IDligne_commande_client = ${ligneId} WHERE IDstock_fini = ${stockId}`)
    res.json(await fetchAffectationPayload(ctx))
  } catch (err) {
    console.error('Error linking fini to client line:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesClientRouter.delete('/:id/lignes/:ligneId/pieces/fini/:stockId', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.id, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    const stockId = parseInt(req.params.stockId, 10)
    if (isNaN(commandeId) || isNaN(ligneId) || isNaN(stockId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const ctx = await loadClientLineContext(commandeId, ligneId)
    if (!ctx || ctx.kind !== 'fini') { res.status(404).json({ error: 'Fini line not found' }); return }
    if (refuseIfSoldee(res, await loadCommandeSoldee(commandeId))) return
    // A shipped roll's affectation is locked — the expedition owns it.
    const rollRows = await query<{ IDetat_stock_fini: number | null; IDligne_expedition: number | null }>(
      `SELECT IDetat_stock_fini, IDligne_expedition FROM stock_fini WHERE IDstock_fini = ${stockId}`,
    )
    if (rollRows.length > 0
      && (Number(rollRows[0].IDetat_stock_fini) === 4 || (Number(rollRows[0].IDligne_expedition) || 0) > 0)) {
      res.status(409).json({ error: 'Roll already shipped — affectation locked' }); return
    }
    await query(`UPDATE stock_fini SET IDligne_commande_client = 0 WHERE IDstock_fini = ${stockId} AND IDligne_commande_client = ${ligneId}`)
    res.json(await fetchAffectationPayload(ctx))
  } catch (err) {
    console.error('Error unlinking fini from client line:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Batch-reserve rolls (Affectation tab "Stock disponible" multi-select).
// All-or-nothing: every roll is validated up front with the same rules as the
// per-roll PUT, before any UPDATE runs — a bad id can't leave the batch
// half-applied. Returns the refreshed payload like the per-roll endpoints.
const batchAffectSchema = z.object({
  stockIds: z.array(z.number().int().positive()).min(1).max(500),
})

commandesClientRouter.post('/:id/lignes/:ligneId/pieces/:kind/affecter', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.id, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    if (isNaN(commandeId) || isNaN(ligneId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const kindParam = req.params.kind
    if (kindParam !== 'ecru' && kindParam !== 'fini') { res.status(400).json({ error: 'Invalid kind' }); return }
    const parsed = batchAffectSchema.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const stockIds = Array.from(new Set(parsed.data.stockIds))
    const ctx = await loadClientLineContext(commandeId, ligneId)
    if (!ctx || ctx.kind !== kindParam) { res.status(404).json({ error: 'Line not found or does not match kind' }); return }
    if (refuseIfSoldee(res, await loadCommandeSoldee(commandeId))) return

    const table = kindParam === 'ecru' ? 'stock_ecru' : 'stock_fini'
    const pk = kindParam === 'ecru' ? 'IDstock_ecru' : 'IDstock_fini'
    const refCol = kindParam === 'ecru' ? 'IDref_ecru' : 'IDref_fini'
    const colCol = kindParam === 'ecru' ? 'IDcolori_ecru' : 'IDColoris'
    const idList = stockIds.join(',')
    const rows = await query<Record<string, unknown>>(
      `SELECT ${pk}, ${refCol}, ${colCol}, IDligne_commande_client FROM ${table} WHERE ${pk} IN (${idList})`,
    )
    const byId = new Map(rows.map((r) => [Number(r[pk]), r]))
    for (const sid of stockIds) {
      const r = byId.get(sid)
      if (!r) { res.status(404).json({ error: `Stock ${kindParam} ${sid} not found` }); return }
      if (Number(r[refCol]) !== ctx.refId) { res.status(400).json({ error: `Roll ${sid}: ref does not match the line` }); return }
      if (ctx.coloriId > 0 && Number(r[colCol]) !== ctx.coloriId) { res.status(400).json({ error: `Roll ${sid}: coloris does not match the line` }); return }
      const current = Number(r.IDligne_commande_client) || 0
      if (current !== 0 && current !== ligneId) { res.status(409).json({ error: `Roll ${sid} already reserved to another line` }); return }
    }
    await query(`UPDATE ${table} SET IDligne_commande_client = ${ligneId} WHERE ${pk} IN (${idList})`)
    res.json(await fetchAffectationPayload(ctx))
  } catch (err) {
    console.error('Error batch-linking rolls to client line:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Update a roll's free-text observations from the affectation drawer.
// Roll-level metadata (same column FinisStock edits), so no soldée guard —
// but the roll must belong to this line's ref and be either unreserved or
// reserved to THIS line (i.e. actually visible in the drawer).
const rollObsSchema = z.object({ observations: z.string().max(2000) })

commandesClientRouter.put('/:id/lignes/:ligneId/pieces/:kind/:stockId/observations', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.id, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    const stockId = parseInt(req.params.stockId, 10)
    const kind = req.params.kind
    if (isNaN(commandeId) || isNaN(ligneId) || isNaN(stockId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (kind !== 'ecru' && kind !== 'fini') { res.status(400).json({ error: 'Invalid kind' }); return }
    const parsed = rollObsSchema.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    const allowed = await userHasPermission(req.userId, isEffectiveAdmin(req), 'edit_observations_rouleaux')
    if (!allowed) { res.status(403).json({ error: 'permission denied: edit_observations_rouleaux' }); return }
    const ctx = await loadClientLineContext(commandeId, ligneId)
    if (!ctx || ctx.kind !== kind) { res.status(404).json({ error: 'Line not found or kind mismatch' }); return }
    if (refuseIfSoldee(res, await loadCommandeSoldee(commandeId))) return

    const table = kind === 'fini' ? 'stock_fini' : 'stock_ecru'
    const pk = kind === 'fini' ? 'IDstock_fini' : 'IDstock_ecru'
    const refCol = kind === 'fini' ? 'IDref_fini' : 'IDref_ecru'
    const rollRows = await query<{ ref: number; lcc: number | null }>(
      `SELECT ${refCol} AS ref, IDligne_commande_client AS lcc FROM ${table} WHERE ${pk} = ${stockId}`,
    )
    if (rollRows.length === 0) { res.status(404).json({ error: 'Roll not found' }); return }
    if (Number(rollRows[0].ref) !== ctx.refId) { res.status(400).json({ error: 'Roll ref does not match the line' }); return }
    const current = Number(rollRows[0].lcc) || 0
    if (current !== 0 && current !== ligneId) { res.status(409).json({ error: 'Roll reserved to another line' }); return }

    await query(`UPDATE ${table} SET observations = ${sqlText(parsed.data.observations)} WHERE ${pk} = ${stockId}`)
    res.json(await fetchAffectationPayload(ctx))
  } catch (err) {
    console.error('Error updating roll observations:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  ENNOBLISSEMENT roll affectation — reserve a dyer's INPUT écru
//  rolls (stock_ecru via IDref_commande_affectation = the ennoblisseur
//  sst line) to THIS client fini line (stock_ecru.IDligne_commande_client).
//  Mirrors the legacy double-click "transfer" modal on the Ennoblissement
//  tab. Same column buildEnnoblissement reads, so the supply table stays
//  consistent. Roll quantity is reported in the client line's unite
//  (ml = poids × fini rendement when unite=Ml, else raw poids in kg).
// ════════════════════════════════════════════════════════

/** Resolve the fini rendement + ennoblisseur (sous_traitant) name for an sst line. */
async function loadEnnoLineMeta(sstLineId: number, finiRefId: number): Promise<{ rendement: number; sstNom: string | null }> {
  const rRows = await query<{ rendement: number | null }>(
    `SELECT rendement FROM ref_fini WHERE IDref_fini = ${finiRefId}`,
  )
  const rendement = Number(rRows[0]?.rendement) || 0
  const stRows = await query<{ IDsous_traitant: number | null }>(
    `SELECT cst.IDsous_traitant
       FROM ligne_commande_sous_traitant lcs
       JOIN commande_sous_traitant cst ON cst.IDcommande_sous_traitant = lcs.IDcommande_sous_traitant
      WHERE lcs.IDligne_commande_sous_traitant = ${sstLineId}`,
  )
  const sstId = Number(stRows[0]?.IDsous_traitant) || 0
  const sstNom = sstId > 0 ? (await resolveMagasinNames([sstId])).get(sstId) ?? null : null
  return { rendement, sstNom }
}

async function fetchEnnoRollsPayload(ctx: ClientLineContext, sstLineId: number) {
  const { rendement, sstNom } = await loadEnnoLineMeta(sstLineId, ctx.refId)
  const dim = lineDim(ctx.unite)
  const cols = 'IDstock_ecru, numero, lot, poids, metrage, IDcolori_ecru, IDmagasin, second_choix, observations'
  const [linkedRaw, availRaw] = await Promise.all([
    query<any>(
      `SELECT ${cols} FROM stock_ecru
        WHERE IDref_commande_affectation = ${sstLineId} AND IDligne_commande_client = ${ctx.ligneId}
        ORDER BY date_saisie DESC, IDstock_ecru DESC`,
    ),
    query<any>(
      `SELECT ${cols} FROM stock_ecru
        WHERE IDref_commande_affectation = ${sstLineId}
          AND (IDligne_commande_client IS NULL OR IDligne_commande_client = 0)
        ORDER BY date_saisie DESC, IDstock_ecru DESC`,
    ),
  ])
  const linkedFixed = await fixEncoding(linkedRaw, 'stock_ecru', 'IDstock_ecru', ['numero', 'lot', 'observations'])
  const availFixed = await fixEncoding(availRaw, 'stock_ecru', 'IDstock_ecru', ['numero', 'lot', 'observations'])
  const magNames = await resolveMagasinNames([...linkedFixed, ...availFixed].map((r: any) => Number(r.IDmagasin)))
  const colNames = await resolveEcruColoris([...linkedFixed, ...availFixed].map((r: any) => Number(r.IDcolori_ecru)))
  const toRoll = (r: any): RollLite => ({
    id: Number(r.IDstock_ecru),
    numero: r.numero ?? null,
    lot: r.lot ?? null,
    poids: Number(r.poids) || 0,
    metrage: Number(r.metrage) || 0,
    coloris_reference: colNames.get(Number(r.IDcolori_ecru)) ?? null,
    magasin_nom: magNames.get(Number(r.IDmagasin)) ?? null,
    second_choix: Number(r.second_choix) || 0,
    observations: r.observations ?? null,
    observation_sst: null,
    etat_label: null,
    expedie: false,
  })
  const linked = linkedFixed.map(toRoll)
  const available = availFixed.map(toRoll)
  // Reserved contribution toward the client line target, in the line's unite.
  const reserved = linked.reduce((s, r) => s + (dim === 'metrage' ? (r.poids ?? 0) * rendement : (r.poids ?? 0)), 0)
  return {
    kind: 'ecru' as const,
    unite: ctx.unite,
    unite_label: uniteLabel(ctx.unite),
    dim,
    target_qty: ctx.quantite,
    rendement,
    sst_nom: sstNom,
    reserved: Math.round(reserved * 100) / 100,
    linked,
    available,
  }
}

commandesClientRouter.get('/:id/lignes/:ligneId/supply/ennoblissement/:sstLineId/rolls', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.id, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    const sstLineId = parseInt(req.params.sstLineId, 10)
    if (isNaN(commandeId) || isNaN(ligneId) || isNaN(sstLineId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const ctx = await loadClientLineContext(commandeId, ligneId)
    if (!ctx || ctx.kind !== 'fini') { res.status(404).json({ error: 'Fini line not found' }); return }
    res.json(await fetchEnnoRollsPayload(ctx, sstLineId))
  } catch (err) {
    console.error('Error fetching ennoblissement rolls:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Reserve a dyer's input écru roll to this client fini line.
commandesClientRouter.put('/:id/lignes/:ligneId/supply/ennoblissement/:sstLineId/rolls/:stockId', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.id, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    const sstLineId = parseInt(req.params.sstLineId, 10)
    const stockId = parseInt(req.params.stockId, 10)
    if (isNaN(commandeId) || isNaN(ligneId) || isNaN(sstLineId) || isNaN(stockId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const ctx = await loadClientLineContext(commandeId, ligneId)
    if (!ctx || ctx.kind !== 'fini') { res.status(404).json({ error: 'Fini line not found' }); return }
    if (refuseIfSoldee(res, await loadCommandeSoldee(commandeId))) return
    const rollRows = await query<{ IDref_commande_affectation: number | null; IDligne_commande_client: number | null }>(
      `SELECT IDref_commande_affectation, IDligne_commande_client FROM stock_ecru WHERE IDstock_ecru = ${stockId}`,
    )
    if (rollRows.length === 0) { res.status(404).json({ error: 'Stock ecru not found' }); return }
    if (Number(rollRows[0].IDref_commande_affectation) !== sstLineId) { res.status(400).json({ error: 'Roll does not belong to this ennoblisseur order' }); return }
    const current = Number(rollRows[0].IDligne_commande_client) || 0
    if (current !== 0 && current !== ligneId) { res.status(409).json({ error: 'Roll already reserved to another line' }); return }
    await query(`UPDATE stock_ecru SET IDligne_commande_client = ${ligneId} WHERE IDstock_ecru = ${stockId}`)
    res.json(await fetchEnnoRollsPayload(ctx, sstLineId))
  } catch (err) {
    console.error('Error reserving ennoblissement roll:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesClientRouter.delete('/:id/lignes/:ligneId/supply/ennoblissement/:sstLineId/rolls/:stockId', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.id, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    const sstLineId = parseInt(req.params.sstLineId, 10)
    const stockId = parseInt(req.params.stockId, 10)
    if (isNaN(commandeId) || isNaN(ligneId) || isNaN(sstLineId) || isNaN(stockId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const ctx = await loadClientLineContext(commandeId, ligneId)
    if (!ctx || ctx.kind !== 'fini') { res.status(404).json({ error: 'Fini line not found' }); return }
    if (refuseIfSoldee(res, await loadCommandeSoldee(commandeId))) return
    await query(`UPDATE stock_ecru SET IDligne_commande_client = 0 WHERE IDstock_ecru = ${stockId} AND IDligne_commande_client = ${ligneId}`)
    res.json(await fetchEnnoRollsPayload(ctx, sstLineId))
  } catch (err) {
    console.error('Error releasing ennoblissement roll:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  CREATE ENNOBLISSEUR ORDER from a client fini line — the upstream
//  half of the Ennoblissement tab. List the tombé-de-métier (écru)
//  rolls available across every location for this line's écru ref, then
//  commission a NEW commande_sous_traitant whose single type=2 line dyes
//  this line's ref_fini/coloris. The chosen écru rolls are affected to the
//  new sst line (IDref_commande_affectation) and, when free, reserved to
//  this client line (IDligne_commande_client). Affect-only: roll location
//  (IDmagasin) is untouched — physical shipment is a separate step. Ports
//  the legacy "create dyeing order from the line" flow.
// ════════════════════════════════════════════════════════

interface AvailableEcruRoll extends RollLite {
  reserved_elsewhere: boolean
  /** Already reserved to THIS client line (counted in affecte_total) — the
   *  create-order gauge must not add it a second time. */
  reserved_to_line: boolean
}

/** type_sst per sous-traitant (2 = Ennoblisseur — memory project_type_sst_ids). */
async function resolveSousTraitantTypes(ids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  const u = Array.from(new Set(ids.filter((x) => x > 0)))
  if (u.length === 0) return out
  const rows = await query<{ IDsous_traitant: number; IDtype_sst: number | null }>(
    `SELECT IDsous_traitant, IDtype_sst FROM sous_traitant WHERE IDsous_traitant IN (${u.join(',')})`,
  )
  for (const r of rows) out.set(Number(r.IDsous_traitant), Number(r.IDtype_sst) || 0)
  return out
}

// The ennoblisseur dyes the NATURAL écru base only. A ref_ecru carries several
// colori_ecru: the undyed base ("ecru") plus color-knitted variants knitted from
// pre-dyed yarn (e.g. "Gris clair C5010") that physically can't be re-dyed to a
// target fini coloris. Legacy's "écru disponible" panel counts only the "ecru"
// base — so we must too (without this, ref 029A/MATEL showed 485 kg = all coloris
// instead of 256.30 kg = the ecru base). Returns the base colori_ecru ids for a
// ref (normally exactly one); empty ⇒ this ref has no "ecru" coloris, in which
// case callers fall back to the whole pool rather than hide everything.
async function naturalEcruColoriIds(ecruRefId: number): Promise<number[]> {
  if (ecruRefId <= 0) return []
  const rows = await query<{ IDcolori_ecru: number }>(
    `SELECT IDcolori_ecru FROM colori_ecru WHERE IDref_ecru = ${ecruRefId} AND reference = 'ecru'`,
  )
  return rows.map((r) => Number(r.IDcolori_ecru)).filter((x) => x > 0)
}

// Which colori_ecru can feed this client line's ennoblissement? Branches on
// ref_fini.avec_teinture (the coloris-catalog rule):
//  - Dyed finis (avec_teinture 1/2): only the natural "ecru" base — the dyer
//    needs undyed input (naturalEcruColoriIds above).
//  - Wash-only finis (avec_teinture 0): the line's IDColoris IS a colori_ecru
//    id — the fini is built from tombé de métier in that exact coloris (e.g.
//    040A gris8985 ← écru 040 gris8985), NOT from the "ecru" base. Without
//    this branch, a 040A/gris8985 line wrongly showed the 040/ecru pool.
//    Line without a coloris ⇒ empty (callers fall back to the whole pool).
async function ennoInputColoriIds(ecruRefId: number, avecTeinture: number, lineColoriId: number): Promise<number[]> {
  if (avecTeinture === 0) return lineColoriId > 0 ? [lineColoriId] : []
  return naturalEcruColoriIds(ecruRefId)
}

async function fetchEnnoAvailableRolls(ctx: ClientLineContext, magasinId = 0) {
  // The écru a fini line needs is ref_fini.IDref_ecru. Use the RAW rendement
  // (NOT rounded) so the Ml projection matches the legacy / supply table.
  const r = await query<{ IDref_ecru: number | null; rendement: number | null; avec_teinture: number | null }>(
    `SELECT IDref_ecru, rendement, avec_teinture FROM ref_fini WHERE IDref_fini = ${ctx.refId}`,
  )
  const ecruRefId = Number(r[0]?.IDref_ecru) || 0
  const rendement = Number(r[0]?.rendement) || 0
  const avecTeinture = Number(r[0]?.avec_teinture) || 0
  const base = {
    unite: ctx.unite,
    unite_label: uniteLabel(ctx.unite),
    dim: lineDim(ctx.unite) as 'metrage' | 'poids',
    rendement,
    rolls: [] as AvailableEcruRoll[],
  }
  if (ecruRefId <= 0) return base

  // Available = ETM écru of this ref, not yet affected to a dyer, not shipped
  // out, not reserved to a donation commande (IDcommande_donation), not already
  // consumed into a fini roll. Coloris restricted per avec_teinture (see
  // ennoInputColoriIds): natural "ecru" base for dyed finis, the line's own
  // colori_ecru for wash-only finis. We DO surface rolls reserved to another
  // client line (flagged reserved_elsewhere) so the user sees the whole base
  // pool — the create step guards the reservation. When magasinId>0 scope to
  // that location.
  const ecruColoris = await ennoInputColoriIds(ecruRefId, avecTeinture, ctx.coloriId)
  const coloriFilter = ecruColoris.length > 0 ? ` AND IDcolori_ecru IN (${ecruColoris.join(',')})` : ''
  const magFilter = magasinId > 0 ? ` AND IDmagasin = ${magasinId}` : ''
  // IDLigne_Commande_TRM>0: same orphan-roll exclusion as the by-location aggregate
  // (fetchEnnoLocations) so the selectable rolls match the counted poids.
  const rows = await query<any>(
    `SELECT IDstock_ecru, numero, lot, poids, metrage, IDcolori_ecru, IDmagasin,
            IDligne_commande_client, second_choix, observations
     FROM stock_ecru
     WHERE IDref_ecru = ${ecruRefId} AND IDsociete = 1${magFilter}${coloriFilter}
       AND IDLigne_Commande_TRM > 0
       AND (IDcommande_donation IS NULL OR IDcommande_donation = 0)
       AND (IDref_commande_affectation IS NULL OR IDref_commande_affectation = 0)
       AND (IDligne_expedition_ETM IS NULL OR IDligne_expedition_ETM = 0)
     ORDER BY date_saisie DESC, IDstock_ecru DESC`,
  )
  const ids = rows.map((x: any) => Number(x.IDstock_ecru)).filter((x: number) => x > 0)
  const consumed = new Set<number>()
  if (ids.length > 0) {
    const dyed = await query<{ IDstock_ecru: number }>(
      `SELECT DISTINCT IDstock_ecru FROM stock_fini WHERE IDstock_ecru IN (${ids.join(',')})`,
    )
    for (const d of dyed) consumed.add(Number(d.IDstock_ecru))
  }
  const kept = rows.filter((x: any) => !consumed.has(Number(x.IDstock_ecru)))
  const fixed = await fixEncoding(kept, 'stock_ecru', 'IDstock_ecru', ['numero', 'lot', 'observations'])
  const magNames = await resolveMagasinNames(fixed.map((x: any) => Number(x.IDmagasin)))
  const colNames = await resolveEcruColoris(fixed.map((x: any) => Number(x.IDcolori_ecru)))
  base.rolls = fixed.map((x: any): AvailableEcruRoll => ({
    id: Number(x.IDstock_ecru),
    numero: x.numero ?? null,
    lot: x.lot ?? null,
    poids: Number(x.poids) || 0,
    metrage: Number(x.metrage) || 0,
    coloris_reference: colNames.get(Number(x.IDcolori_ecru)) ?? null,
    magasin_nom: magNames.get(Number(x.IDmagasin)) ?? null,
    second_choix: Number(x.second_choix) || 0,
    observations: x.observations ?? null,
    observation_sst: null,
    etat_label: null,
    expedie: false,
    reserved_elsewhere:
      (Number(x.IDligne_commande_client) || 0) > 0 && Number(x.IDligne_commande_client) !== ctx.ligneId,
    reserved_to_line: Number(x.IDligne_commande_client) === ctx.ligneId,
  }))
  return base
}

commandesClientRouter.get('/:id/lignes/:ligneId/supply/ennoblissement/available-rolls', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.id, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    if (isNaN(commandeId) || isNaN(ligneId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const ctx = await loadClientLineContext(commandeId, ligneId)
    if (!ctx || ctx.kind !== 'fini') { res.status(404).json({ error: 'Fini line not found' }); return }
    const magasinId = parseInt(String(req.query.magasin ?? '0'), 10) || 0
    res.json(await fetchEnnoAvailableRolls(ctx, magasinId))
  } catch (err) {
    console.error('Error fetching ennoblissement available rolls:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Tombé-de-métier (écru) of this fini's écru ref, available and AGGREGATED by
// current location (sous-traitant magasin). Powers the legacy "029 - écru
// disponible" panel: rows grouped into "chez les ennoblisseurs" (IDtype_sst=2)
// vs "à l'usine" (other sous-traitants, e.g. tricoteurs/TRM). Factory-only
// rolls (IDmagasin=0) are excluded — only real sous-traitant locations show.
interface EnnoLocationRow {
  IDsous_traitant: number
  location_nom: string
  is_ennoblisseur: boolean
  group: 'ennoblisseur' | 'usine'
  nb_rolls: number
  poids: number
  metrage_potentiel: number
}

/** ref_ecru.reference for a single id (the écru "029" code), encoding-repaired. */
async function resolveEcruRefLabel(ecruRefId: number): Promise<string> {
  if (ecruRefId <= 0) return ''
  const rows = await query<{ IDref_ecru: number; reference: string | null }>(
    `SELECT IDref_ecru, reference FROM ref_ecru WHERE IDref_ecru = ${ecruRefId}`,
  )
  const fixed = await fixEncoding(rows, 'ref_ecru', 'IDref_ecru', ['reference'])
  return (fixed[0]?.reference ?? '').toString()
}

async function fetchEnnoLocations(ctx: ClientLineContext) {
  const r = await query<{ IDref_ecru: number | null; rendement: number | null; avec_teinture: number | null }>(
    `SELECT IDref_ecru, rendement, avec_teinture FROM ref_fini WHERE IDref_fini = ${ctx.refId}`,
  )
  const ecruRefId = Number(r[0]?.IDref_ecru) || 0
  const rendement = Number(r[0]?.rendement) || 0
  const avecTeinture = Number(r[0]?.avec_teinture) || 0
  const ecruRefLabel = await resolveEcruRefLabel(ecruRefId)
  const base = {
    rendement,
    unite_label: uniteLabel(ctx.unite),
    ecru_ref_label: ecruRefLabel,
    // Coloris the pool is filtered on ("ecru", "gris8985", …) so the UI can
    // title the panel truthfully; '' when the pool is unfiltered.
    ecru_coloris_label: '',
    locations: [] as EnnoLocationRow[],
  }
  if (ecruRefId <= 0) return base

  // Coloris restriction per avec_teinture (see ennoInputColoriIds): dyed finis
  // count only the natural "ecru" base (color-knitted variants aren't dyeable —
  // the per-location totals match legacy); wash-only finis count the line's own
  // colori_ecru (their input tombé de métier is knitted in that coloris).
  const ecruColoris = await ennoInputColoriIds(ecruRefId, avecTeinture, ctx.coloriId)
  if (ecruColoris.length > 0) {
    const names = await resolveEcruColoris(ecruColoris)
    base.ecru_coloris_label = Array.from(new Set(ecruColoris.map((id) => (names.get(id) ?? '').trim()).filter(Boolean))).join(', ')
  }
  const coloriFilter = ecruColoris.length > 0 ? ` AND IDcolori_ecru IN (${ecruColoris.join(',')})` : ''
  // No IDsociete/IDmagasin restriction: legacy's "écru disponible" panel spans the
  // Malterre companies. Écru at a sous-traitant magasin (IDmagasin>0) groups under
  // that location; écru still at the factory (IDmagasin=0) is "à l'usine", grouped
  // by its owning company — that's how the in-house knitter Tricotage Malterre
  // (IDsociete=2, IDmagasin=0) surfaces. IDsociete>0 drops legacy-invisible rows.
  // IDLigne_Commande_TRM>0: only écru traceable to a TRM knitting order counts —
  // legacy excludes orphan rolls (old / 2nd-choix scraps with no TRM line). This
  // is what splits TRM 233.30→198.90 while leaving MATEL 256.30 untouched (all its
  // rolls carry a TRM line); it is NOT a second_choix filter (MATEL's 256.30
  // includes a 2nd-choix roll, so second_choix=0 would wrongly drop it).
  // IDcommande_donation=0: rolls reserved to a donation commande client are
  // already spoken for — legacy never counts them as écru disponible (bug seen
  // on ref 040: 44.7 kg of donation rolls showed as available at the usine).
  const rows = await query<{ IDstock_ecru: number; IDmagasin: number | null; IDsociete: number | null; poids: number | null }>(
    `SELECT IDstock_ecru, IDmagasin, IDsociete, poids FROM stock_ecru
      WHERE IDref_ecru = ${ecruRefId} AND IDsociete > 0${coloriFilter}
        AND IDLigne_Commande_TRM > 0
        AND (IDcommande_donation IS NULL OR IDcommande_donation = 0)
        AND (IDref_commande_affectation IS NULL OR IDref_commande_affectation = 0)
        AND (IDligne_expedition_ETM IS NULL OR IDligne_expedition_ETM = 0)`,
  )
  const ids = rows.map((x) => Number(x.IDstock_ecru)).filter((x) => x > 0)
  const consumed = new Set<number>()
  if (ids.length > 0) {
    const dyed = await query<{ IDstock_ecru: number }>(
      `SELECT DISTINCT IDstock_ecru FROM stock_fini WHERE IDstock_ecru IN (${ids.join(',')})`,
    )
    for (const d of dyed) consumed.add(Number(d.IDstock_ecru))
  }
  // Key by magasin when at a sous-traitant, else by owning company (à l'usine).
  const agg = new Map<string, { magId: number; socId: number; nb: number; poids: number }>()
  for (const x of rows) {
    if (consumed.has(Number(x.IDstock_ecru))) continue
    const mag = Number(x.IDmagasin) || 0
    const soc = Number(x.IDsociete) || 0
    const key = mag > 0 ? `m${mag}` : `s${soc}`
    const a = agg.get(key) ?? { magId: mag, socId: soc, nb: 0, poids: 0 }
    a.nb += 1
    a.poids += Number(x.poids) || 0
    agg.set(key, a)
  }
  const cells = Array.from(agg.values())
  const magIds = cells.filter((a) => a.magId > 0).map((a) => a.magId)
  const socIds = cells.filter((a) => a.magId === 0).map((a) => a.socId)
  const [names, types, socNames] = await Promise.all([
    resolveMagasinNames(magIds),
    resolveSousTraitantTypes(magIds),
    resolveSocieteNames(socIds),
  ])
  base.locations = cells
    .map((a): EnnoLocationRow => {
      if (a.magId > 0) {
        const isEnno = types.get(a.magId) === 2
        return {
          IDsous_traitant: a.magId,
          location_nom: names.get(a.magId) ?? `#${a.magId}`,
          is_ennoblisseur: isEnno,
          group: isEnno ? 'ennoblisseur' : 'usine',
          nb_rolls: a.nb,
          poids: round2c(a.poids),
          metrage_potentiel: round2c(a.poids * rendement),
        }
      }
      // Factory écru (IDmagasin=0): "à l'usine", labelled by owning company. No
      // create button — you only commission a dyer that already holds the écru.
      // Synthetic negative id keeps the React key distinct from any real dyer.
      return {
        IDsous_traitant: -a.socId,
        location_nom: socNames.get(a.socId) ?? `Société #${a.socId}`,
        is_ennoblisseur: false,
        group: 'usine',
        nb_rolls: a.nb,
        poids: round2c(a.poids),
        metrage_potentiel: round2c(a.poids * rendement),
      }
    })
    // Ennoblisseur rows first (they bear the create button), then by name.
    .sort((x, y) => (x.is_ennoblisseur === y.is_ennoblisseur ? x.location_nom.localeCompare(y.location_nom) : x.is_ennoblisseur ? -1 : 1))
  return base
}

// ── Open-OF yarn debt per stock_fil lot ──────────────────
// Legacy "disponible" is NOT the raw lot stock: it subtracts the yarn still
// needed by OPEN ordres de fabrication drawing on the lot (asso_fil_of →
// ordre_fabrication.est_termine = 0): remaining écru to knit (OF.quantite −
// Σ stock_ecru produced) × pourcentage/100. Validated to the cent on
// commande 3686: coton 5736.53 − 2414.25 = 3322.29, élasthanne 568.75 −
// 261.10 = 307.65.
async function openOfPendingByLot(lotIdsIn: number[]): Promise<Map<number, number>> {
  const pendingByLot = new Map<number, number>()
  const lotIds = Array.from(new Set(lotIdsIn.filter((x) => x > 0)))
  if (lotIds.length === 0) return pendingByLot
  const assoOf = await query<{ IDstock_fil: number; IDordre_fabrication: number; pourcentage: number | null }>(
    `SELECT IDstock_fil, IDordre_fabrication, pourcentage FROM asso_fil_of
     WHERE IDstock_fil IN (${lotIds.join(',')}) AND IDordre_fabrication > 0`,
  )
  const ofIds = Array.from(new Set(assoOf.map((a) => Number(a.IDordre_fabrication)).filter((x) => x > 0)))
  if (ofIds.length === 0) return pendingByLot
  const openRows = await query<{ IDordre_fabrication: number; quantite: number | null }>(
    `SELECT IDordre_fabrication, quantite FROM ordre_fabrication
     WHERE IDordre_fabrication IN (${ofIds.join(',')}) AND est_termine = 0`,
  )
  const openQ = new Map(openRows.map((o) => [Number(o.IDordre_fabrication), Number(o.quantite) || 0]))
  if (openQ.size === 0) return pendingByLot
  const prodRows = await query<{ ofid: number; kg: number | null }>(
    `SELECT IDordre_fabrication AS ofid, SUM(poids) AS kg FROM stock_ecru
     WHERE IDordre_fabrication IN (${Array.from(openQ.keys()).join(',')})
     GROUP BY IDordre_fabrication`,
  )
  const prodByOf = new Map(prodRows.map((r) => [Number(r.ofid), Number(r.kg) || 0]))
  for (const a of assoOf) {
    const ofid = Number(a.IDordre_fabrication)
    const q = openQ.get(ofid)
    if (q === undefined) continue
    const remaining = Math.max(0, q - (prodByOf.get(ofid) ?? 0))
    const lot = Number(a.IDstock_fil)
    pendingByLot.set(lot, (pendingByLot.get(lot) ?? 0) + remaining * ((Number(a.pourcentage) || 0) / 100))
  }
  return pendingByLot
}

// ── Tricotage: "Stock de fil disponible" — yarn on hand usable to knit this
// line's écru (legacy right-hand panel of the Tricotage tab), net of the yarn
// still needed by open ordres de fabrication. Yarn is scoped
// by composition_ecru (which yarn ref + coloris the écru is knitted from),
// aggregated per holding location (stock_fil.IDMagasin → sous_traitant, e.g.
// "Tricotage Malterre"; 0 = à l'usine). Métrage potentiel per yarn bucket:
// the fabric its weight can produce — poids / (pourcentage/100) × rendement,
// with the same rendement the rest of the supply view uses (fini's for fini
// lines, écru's for écru lines).

interface StockFilYarnRow {
  IDref_fil: number
  IDcolori_fil: number
  reference: string
  coloris: string
  pourcentage: number
  poids: number
  metrage_potentiel: number
}
interface StockFilLocationRow {
  magasin_id: number
  magasin_nom: string
  /** True when the holding sous-traitant is a knitter (IDtype_sst=1) — those
   *  rows bear the per-location "Nouvelle commande" launcher in the UI. */
  is_tricoteur: boolean
  yarns: StockFilYarnRow[]
}

async function fetchTricoStockFil(ctx: ClientLineContext) {
  const base = {
    rendement: 0,
    ecru_ref_label: '',
    locations: [] as StockFilLocationRow[],
  }
  if (ctx.kind === 'none' || ctx.refId <= 0) return base

  // Resolve the écru being knitted + the rendement used for Ml projections
  // (identical to fetchSupplyPayload so the two Tricotage sections agree).
  let ecruRefId = 0
  let rendement = 0
  let ecruColoris: number[] = []
  if (ctx.kind === 'fini') {
    const r = await query<{ IDref_ecru: number | null; rendement: number | null; avec_teinture: number | null }>(
      `SELECT IDref_ecru, rendement, avec_teinture FROM ref_fini WHERE IDref_fini = ${ctx.refId}`,
    )
    ecruRefId = Number(r[0]?.IDref_ecru) || 0
    rendement = Number(r[0]?.rendement) || 0
    const avecTeinture = Number(r[0]?.avec_teinture) || 0
    // Same coloris restriction as the écru-disponible pool: dyed finis knit the
    // natural "ecru" base; wash-only finis knit the line's own colori_ecru.
    if (ecruRefId > 0) ecruColoris = await ennoInputColoriIds(ecruRefId, avecTeinture, ctx.coloriId)
  } else {
    ecruRefId = ctx.refId
    const r = await query<{ rendement: number | null }>(
      `SELECT rendement FROM ref_ecru WHERE IDref_ecru = ${ecruRefId}`,
    )
    rendement = Number(r[0]?.rendement) || 0
    if (ctx.coloriId > 0) ecruColoris = [ctx.coloriId]
  }
  base.rendement = rendement
  if (ecruRefId <= 0) return base
  base.ecru_ref_label = await resolveEcruRefLabel(ecruRefId)

  // Composition pairs — which (yarn ref, yarn coloris, %) knit this écru.
  // Coloris-scoped first; if the scoped variant has no composition rows,
  // fall back to every variant of the écru (composition data is sparse).
  const pairQuery = (coloriIn: string) => query<{ IDref_fil: number; IDcolori_fil: number; pourcentage: number | null }>(
    `SELECT DISTINCT IDref_fil, IDcolori_fil, pourcentage FROM composition_ecru
     WHERE IDref_ecru = ${ecruRefId}${coloriIn} AND IDref_fil > 0`,
  )
  let pairRows = ecruColoris.length > 0
    ? await pairQuery(` AND IDcolori_ecru IN (${ecruColoris.join(',')})`)
    : await pairQuery('')
  if (pairRows.length === 0 && ecruColoris.length > 0) pairRows = await pairQuery('')
  const pairs = pairRows
    .map((p) => ({ IDref_fil: Number(p.IDref_fil) || 0, IDcolori_fil: Number(p.IDcolori_fil) || 0, pourcentage: Number(p.pourcentage) || 0 }))
    .filter((p) => p.IDref_fil > 0 && p.pourcentage > 0)
  if (pairs.length === 0) return base
  const pctByPair = new Map<string, number>()
  for (const p of pairs) {
    const k = `${p.IDref_fil}:${p.IDcolori_fil}`
    if (!pctByPair.has(k)) pctByPair.set(k, p.pourcentage)
  }

  // On-hand yarn lots matching the composition (stock > 0 = active lots,
  // same filter as the sst tricoteur "Stock fil" tab).
  const pairClause = Array.from(pctByPair.keys())
    .map((k) => { const [rf, cf] = k.split(':'); return `(IDref_fil = ${rf} AND IDcolori_fil = ${cf})` })
    .join(' OR ')
  const lots = await query<{ IDstock_fil: number; IDref_fil: number; IDcolori_fil: number; IDMagasin: number | null; stock: number | null }>(
    `SELECT IDstock_fil, IDref_fil, IDcolori_fil, IDMagasin, stock FROM stock_fil
     WHERE (${pairClause}) AND stock > 0`,
  )

  const pendingByLot = await openOfPendingByLot(lots.map((l) => Number(l.IDstock_fil)))

  // Aggregate per (location, yarn ref, yarn coloris), net of open-OF needs.
  const agg = new Map<string, { magId: number; refFil: number; coloriFil: number; poids: number }>()
  for (const l of lots) {
    const magId = Number(l.IDMagasin) || 0
    const key = `${magId}|${Number(l.IDref_fil)}:${Number(l.IDcolori_fil)}`
    const a = agg.get(key) ?? { magId, refFil: Number(l.IDref_fil), coloriFil: Number(l.IDcolori_fil), poids: 0 }
    a.poids += (Number(l.stock) || 0) - (pendingByLot.get(Number(l.IDstock_fil)) ?? 0)
    agg.set(key, a)
  }
  const cells = Array.from(agg.values())

  // Composition pairs with NO on-hand lot anywhere still get a row — the
  // user must see at a glance which yarn of the composition is missing
  // (e.g. 180102's coton/ecru 45% with every lot depleted). They group
  // under a synthetic "Sans stock" location (magasin_id = -1, sorted last).
  const stockedPairs = new Set(cells.map((c) => `${c.refFil}:${c.coloriFil}`))
  for (const k of pctByPair.keys()) {
    if (stockedPairs.has(k)) continue
    const [rf, cf] = k.split(':')
    cells.push({ magId: -1, refFil: Number(rf), coloriFil: Number(cf), poids: 0 })
  }

  // Display names — flat batched lookups (no JOIN+CONVERT).
  const refFilIds = Array.from(new Set(cells.map((c) => c.refFil)))
  const coloriFilIds = Array.from(new Set(cells.map((c) => c.coloriFil).filter((x) => x > 0)))
  const magIds = cells.map((c) => c.magId).filter((x) => x > 0)
  const refFilNames = new Map<number, string>()
  if (refFilIds.length > 0) {
    const r = await query<{ IDref_fil: number; reference: string | null }>(
      `SELECT IDref_fil, reference FROM ref_fil WHERE IDref_fil IN (${refFilIds.join(',')})`,
    )
    for (const row of await fixEncoding(r, 'ref_fil', 'IDref_fil', ['reference']))
      refFilNames.set(Number(row.IDref_fil), (row.reference ?? '').toString().trim())
  }
  const coloriFilNames = new Map<number, string>()
  if (coloriFilIds.length > 0) {
    const r = await query<{ IDcolori_fil: number; reference: string | null }>(
      `SELECT IDcolori_fil, reference FROM colori_fil WHERE IDcolori_fil IN (${coloriFilIds.join(',')})`,
    )
    for (const row of await fixEncoding(r, 'colori_fil', 'IDcolori_fil', ['reference']))
      coloriFilNames.set(Number(row.IDcolori_fil), (row.reference ?? '').toString().trim())
  }
  const [magNames, magTypes] = await Promise.all([
    resolveMagasinNames(magIds),
    resolveSousTraitantTypes(magIds),
  ])

  // Group per location, ennoblisseur-style ordering (name asc, usine last).
  const byLocation = new Map<number, StockFilLocationRow>()
  for (const c of cells) {
    const loc = byLocation.get(c.magId) ?? {
      magasin_id: c.magId,
      magasin_nom: c.magId > 0 ? (magNames.get(c.magId) ?? `#${c.magId}`) : c.magId === 0 ? "À l'usine" : 'Sans stock',
      is_tricoteur: c.magId > 0 && magTypes.get(c.magId) === 1,
      yarns: [],
    }
    const pct = pctByPair.get(`${c.refFil}:${c.coloriFil}`) ?? 0
    loc.yarns.push({
      IDref_fil: c.refFil,
      IDcolori_fil: c.coloriFil,
      reference: refFilNames.get(c.refFil) ?? `#${c.refFil}`,
      coloris: coloriFilNames.get(c.coloriFil) ?? '',
      pourcentage: pct,
      poids: round2c(c.poids),
      metrage_potentiel: pct > 0 ? round2c((c.poids / (pct / 100)) * rendement) : 0,
    })
    byLocation.set(c.magId, loc)
  }
  // Order: sous-traitant locations by name, then "À l'usine", then "Sans stock".
  const locRank = (l: StockFilLocationRow) => (l.magasin_id > 0 ? 0 : l.magasin_id === 0 ? 1 : 2)
  base.locations = Array.from(byLocation.values())
    .sort((a, b) => (locRank(a) !== locRank(b) ? locRank(a) - locRank(b) : a.magasin_nom.localeCompare(b.magasin_nom)))
  for (const loc of base.locations) loc.yarns.sort((a, b) => a.reference.localeCompare(b.reference))
  return base
}

commandesClientRouter.get('/:id/lignes/:ligneId/supply/tricotage/stock-fil', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.id, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    if (isNaN(commandeId) || isNaN(ligneId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const ctx = await loadClientLineContext(commandeId, ligneId)
    if (!ctx) { res.status(404).json({ error: 'Line not found or does not belong to commande' }); return }
    res.json(await fetchTricoStockFil(ctx))
  } catch (err) {
    console.error('Error fetching tricotage stock fil:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Tricotage: create a TRM knit order from the client line ──
// Mirrors the legacy "Commande de Tricotage Malterre" modal opened from the
// Tricotage tab: two weight inputs (kg affected to this client commande + kg
// for the ETM general stock) make one tricoteur line at the sister-company
// knitter. On Valider legacy writes: commande_sous_traitant + line (validated
// on cst 8582), an affectation_cmd_tricotage row for the affected part, and
// one asso_fil_lignecmdsst yarn reservation per composition yarn against the
// TRM lot (validated on lines 8558/8464: quantite = total × pourcentage).

/** Écru ref + rendement + écru-coloris restriction for a client line —
 *  identical resolution to fetchSupplyPayload / fetchTricoStockFil. */
async function resolveTricoEcru(ctx: ClientLineContext): Promise<{ ecruRefId: number; rendement: number; ecruColoris: number[] }> {
  let ecruRefId = 0
  let rendement = 0
  let ecruColoris: number[] = []
  if (ctx.kind === 'fini') {
    const r = await query<{ IDref_ecru: number | null; rendement: number | null; avec_teinture: number | null }>(
      `SELECT IDref_ecru, rendement, avec_teinture FROM ref_fini WHERE IDref_fini = ${ctx.refId}`,
    )
    ecruRefId = Number(r[0]?.IDref_ecru) || 0
    rendement = Number(r[0]?.rendement) || 0
    const avecTeinture = Number(r[0]?.avec_teinture) || 0
    if (ecruRefId > 0) ecruColoris = await ennoInputColoriIds(ecruRefId, avecTeinture, ctx.coloriId)
  } else if (ctx.kind === 'ecru') {
    ecruRefId = ctx.refId
    const r = await query<{ rendement: number | null }>(
      `SELECT rendement FROM ref_ecru WHERE IDref_ecru = ${ecruRefId}`,
    )
    rendement = Number(r[0]?.rendement) || 0
    if (ctx.coloriId > 0) ecruColoris = [ctx.coloriId]
  }
  return { ecruRefId, rendement, ecruColoris }
}

/** Composition pairs (yarn ref, coloris, %) for an écru — coloris-scoped with
 *  fallback to all variants, same rule as fetchTricoStockFil. */
async function tricoCompositionPairs(ecruRefId: number, ecruColoris: number[]) {
  const pairQuery = (coloriIn: string) => query<{ IDref_fil: number; IDcolori_fil: number; pourcentage: number | null }>(
    `SELECT DISTINCT IDref_fil, IDcolori_fil, pourcentage FROM composition_ecru
     WHERE IDref_ecru = ${ecruRefId}${coloriIn} AND IDref_fil > 0`,
  )
  let pairRows = ecruColoris.length > 0
    ? await pairQuery(` AND IDcolori_ecru IN (${ecruColoris.join(',')})`)
    : await pairQuery('')
  if (pairRows.length === 0 && ecruColoris.length > 0) pairRows = await pairQuery('')
  return pairRows
    .map((p) => ({ IDref_fil: Number(p.IDref_fil) || 0, IDcolori_fil: Number(p.IDcolori_fil) || 0, pourcentage: Number(p.pourcentage) || 0 }))
    .filter((p) => p.IDref_fil > 0 && p.pourcentage > 0)
}

/** Fournisseur name per ref_fil_commande line id (batched flat lookups:
 *  ref_fil_commande → commande_fil → fournisseur, accents repaired). */
async function fournisseurByRfc(rfcIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const ids = Array.from(new Set(rfcIds.filter((x) => x > 0)))
  if (ids.length === 0) return out
  const rfc = await query<{ IDref_fil_commande: number; IDcommande_fil: number }>(
    `SELECT IDref_fil_commande, IDcommande_fil FROM ref_fil_commande WHERE IDref_fil_commande IN (${ids.join(',')})`,
  )
  const cmdIds = Array.from(new Set(rfc.map((r) => Number(r.IDcommande_fil)).filter((x) => x > 0)))
  if (cmdIds.length === 0) return out
  const cmds = await query<{ IDcommande_fil: number; IDfournisseur: number }>(
    `SELECT IDcommande_fil, IDfournisseur FROM commande_fil WHERE IDcommande_fil IN (${cmdIds.join(',')})`,
  )
  const frsIds = Array.from(new Set(cmds.map((c) => Number(c.IDfournisseur)).filter((x) => x > 0)))
  const frsNames = new Map<number, string>()
  if (frsIds.length > 0) {
    const rows = await query<{ IDfournisseur: number; nom: string | null }>(
      `SELECT IDfournisseur, nom FROM fournisseur WHERE IDfournisseur IN (${frsIds.join(',')})`,
    )
    for (const r of await fixEncoding(rows, 'fournisseur', 'IDfournisseur', ['nom']))
      frsNames.set(Number(r.IDfournisseur), ((r as any).nom ?? '').toString().trim())
  }
  const frsByCmd = new Map(cmds.map((c) => [Number(c.IDcommande_fil), frsNames.get(Number(c.IDfournisseur)) ?? '']))
  for (const r of rfc) out.set(Number(r.IDref_fil_commande), frsByCmd.get(Number(r.IDcommande_fil)) ?? '')
  return out
}

commandesClientRouter.get('/:id/lignes/:ligneId/supply/tricotage/new-order-context', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.id, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    if (isNaN(commandeId) || isNaN(ligneId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    // Which knitter's stock the dialog shows (yarn can sit at several
    // tricoteurs) — defaults to the sister company.
    const magasin = parseInt(String(req.query.magasin ?? ''), 10) || TRICOTAGE_MALTERRE_ID
    const ctx = await loadClientLineContext(commandeId, ligneId)
    if (!ctx) { res.status(404).json({ error: 'Line not found or does not belong to commande' }); return }

    const { ecruRefId, rendement, ecruColoris } = await resolveTricoEcru(ctx)
    if (ecruRefId <= 0) { res.json({ applicable: false }); return }

    const [ecruLabel, coloriNames, pairs] = await Promise.all([
      resolveEcruRefLabel(ecruRefId),
      resolveEcruColoris(ecruColoris),
      tricoCompositionPairs(ecruRefId, ecruColoris),
    ])

    // On-hand lots at the chosen knitter (legacy panel: "Stock disponible chez
    // X"), net of open-OF needs; + open yarn purchase orders (etat=0).
    const yarns: any[] = []
    if (pairs.length > 0) {
      const pairClause = pairs.map((p) => `(IDref_fil = ${p.IDref_fil} AND IDcolori_fil = ${p.IDcolori_fil})`).join(' OR ')
      const lots = await query<{ IDstock_fil: number; IDref_fil: number; IDcolori_fil: number; lot: string | null; stock: number | null; IDref_fil_commande: number | null }>(
        `SELECT IDstock_fil, IDref_fil, IDcolori_fil, lot, stock, IDref_fil_commande FROM stock_fil
         WHERE (${pairClause}) AND stock > 0 AND IDMagasin = ${magasin}`,
      )
      const pending = await query<{ IDref_fil_commande: number; IDref_fil: number; IDcolori_fil: number; quantite: number | null; date_livraison: string | null }>(
        `SELECT IDref_fil_commande, IDref_fil, IDcolori_fil, quantite, date_livraison FROM ref_fil_commande
         WHERE (${pairClause}) AND etat = 0`,
      )
      const pendingByLot = await openOfPendingByLot(lots.map((l) => Number(l.IDstock_fil)))
      const frsNames = await fournisseurByRfc([
        ...lots.map((l) => Number(l.IDref_fil_commande) || 0),
        ...pending.map((p) => Number(p.IDref_fil_commande)),
      ])

      // Yarn display names
      const refFilIds = pairs.map((p) => p.IDref_fil)
      const coloriFilIds = pairs.map((p) => p.IDcolori_fil).filter((x) => x > 0)
      const refFilNames = new Map<number, string>()
      const rf = await query<{ IDref_fil: number; reference: string | null }>(
        `SELECT IDref_fil, reference FROM ref_fil WHERE IDref_fil IN (${refFilIds.join(',')})`,
      )
      for (const row of await fixEncoding(rf, 'ref_fil', 'IDref_fil', ['reference']))
        refFilNames.set(Number(row.IDref_fil), ((row as any).reference ?? '').toString().trim())
      const coloriFilNames = new Map<number, string>()
      if (coloriFilIds.length > 0) {
        const cf = await query<{ IDcolori_fil: number; reference: string | null }>(
          `SELECT IDcolori_fil, reference FROM colori_fil WHERE IDcolori_fil IN (${coloriFilIds.join(',')})`,
        )
        for (const row of await fixEncoding(cf, 'colori_fil', 'IDcolori_fil', ['reference']))
          coloriFilNames.set(Number(row.IDcolori_fil), ((row as any).reference ?? '').toString().trim())
      }

      for (const p of pairs) {
        const mlOf = (kg: number) => (p.pourcentage > 0 ? round2c((kg / (p.pourcentage / 100)) * rendement) : 0)
        yarns.push({
          IDref_fil: p.IDref_fil,
          IDcolori_fil: p.IDcolori_fil,
          reference: refFilNames.get(p.IDref_fil) ?? `#${p.IDref_fil}`,
          coloris: coloriFilNames.get(p.IDcolori_fil) ?? '',
          pourcentage: p.pourcentage,
          stock: lots
            .filter((l) => Number(l.IDref_fil) === p.IDref_fil && Number(l.IDcolori_fil) === p.IDcolori_fil)
            .map((l) => {
              const net = round2c((Number(l.stock) || 0) - (pendingByLot.get(Number(l.IDstock_fil)) ?? 0))
              return {
                id: Number(l.IDstock_fil),
                lot: (l.lot ?? '').toString().trim(),
                fournisseur: frsNames.get(Number(l.IDref_fil_commande) || 0) ?? '',
                poids: net,
                metrage: mlOf(net),
              }
            }),
          pending: pending
            .filter((o) => Number(o.IDref_fil) === p.IDref_fil && Number(o.IDcolori_fil) === p.IDcolori_fil)
            .map((o) => ({
              id: Number(o.IDref_fil_commande),
              date_livraison: o.date_livraison ?? null,
              fournisseur: frsNames.get(Number(o.IDref_fil_commande)) ?? '',
              poids: round2c(Number(o.quantite) || 0),
              metrage: mlOf(Number(o.quantite) || 0),
            })),
        })
      }
    }

    res.json({
      applicable: true,
      ecru_ref_label: ecruLabel,
      ecru_coloris_label: coloriNames.get(ecruColoris[0] ?? 0) ?? '',
      rendement,
      yarns,
    })
  } catch (err) {
    console.error('Error fetching tricotage new-order context:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const tricoOrderBody = z.object({
  // The knitter — any tricoteur location from the stock-fil panel; defaults
  // to the sister company for backward compatibility.
  IDsous_traitant: z.number().int().positive().default(TRICOTAGE_MALTERRE_ID),
  // Kg allocated to THIS client commande — legacy allows negative adjustments.
  poids_affecte: z.number().finite().default(0),
  // Kg knitted for the ETM general stock — never negative.
  poids_stock: z.number().finite().min(0).default(0),
  date_commande: z.string().optional(),
})

commandesClientRouter.post('/:id/lignes/:ligneId/supply/tricotage/orders', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.id, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    if (isNaN(commandeId) || isNaN(ligneId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = tricoOrderBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data
    const total = round2c(d.poids_affecte + d.poids_stock)
    if (!(total > 0)) { res.status(400).json({ error: 'Total weight must be positive' }); return }
    const ctx = await loadClientLineContext(commandeId, ligneId)
    if (!ctx || ctx.kind === 'none') { res.status(404).json({ error: 'Line not found or does not belong to commande' }); return }
    if (refuseIfSoldee(res, await loadCommandeSoldee(commandeId))) return

    const { ecruRefId, ecruColoris } = await resolveTricoEcru(ctx)
    if (ecruRefId <= 0) { res.status(400).json({ error: 'Line has no écru ref to knit' }); return }

    // Only actual knitters take knitting orders (defensive against a stale
    // client passing a dyer's magasin id).
    const sstTypes = await resolveSousTraitantTypes([d.IDsous_traitant])
    if (sstTypes.get(d.IDsous_traitant) !== 1) {
      res.status(400).json({ error: 'Sous-traitant is not a tricoteur' })
      return
    }

    const created = await createKnitOrder({
      sstId: d.IDsous_traitant,
      ecruRefId,
      coloriEcruId: ecruColoris[0] ?? 0,
      quantiteKg: total,
      dateCommande: d.date_commande,
    })

    // Planning allocation to this client line (the "Poids affecté" input) —
    // the same table the Tricotage tab's affecté column reads.
    if (d.poids_affecte !== 0) {
      await query(
        `INSERT INTO affectation_cmd_tricotage (poids_affecte, IDligne_commande_sous_traitant, IDligne_commande_client)
         VALUES (${n(d.poids_affecte)}, ${created.IDligne_commande_sous_traitant}, ${ligneId})`,
      )
    }

    // Yarn reservations: one asso row per composition yarn, quantite = total ×
    // pourcentage, against the knitter's lot holding the most stock (legacy
    // writes a single full-need row per yarn — lines 8558/8464). No lot on
    // hand at that knitter → skip.
    const pairs = await tricoCompositionPairs(ecruRefId, ecruColoris)
    for (const p of pairs) {
      const lot = await query<{ IDstock_fil: number }>(
        `SELECT IDstock_fil FROM stock_fil
          WHERE IDref_fil = ${p.IDref_fil} AND IDcolori_fil = ${p.IDcolori_fil}
            AND IDMagasin = ${d.IDsous_traitant} AND stock > 0
          ORDER BY stock DESC`,
      )
      const lotId = Number(lot[0]?.IDstock_fil) || 0
      if (lotId <= 0) continue
      const needKg = round2c(total * (p.pourcentage / 100))
      if (!(needKg > 0)) continue
      await query(
        `INSERT INTO asso_fil_lignecmdsst (IDstock_fil, IDligne_commande_sous_traitant, quantite)
         VALUES (${lotId}, ${created.IDligne_commande_sous_traitant}, ${needKg})`,
      )
    }

    res.status(201).json({ ok: true, ...created })
  } catch (err) {
    console.error('Error creating tricotage order from client line:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const tricoAffectationBody = z.object({
  // Kg of this knitting order allocated to THIS client line. Legacy allows
  // negative adjustments, so no lower bound — only the over-allocation guard.
  poids_affecte: z.number().finite(),
})

// Adjust the affectation_cmd_tricotage allocation of one tricoteur line to
// this client line (row click on the Tricotage tab — the knitting counterpart
// of the ennoblissement roll-transfer modal). Replaces the (sst line, client
// line) allocation with the given value; 0 clears it.
commandesClientRouter.put('/:id/lignes/:ligneId/supply/tricotage/:sstLineId/affectation', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.id, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    const sstLineId = parseInt(req.params.sstLineId, 10)
    if (isNaN(commandeId) || isNaN(ligneId) || isNaN(sstLineId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = tricoAffectationBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const value = parsed.data.poids_affecte
    const ctx = await loadClientLineContext(commandeId, ligneId)
    if (!ctx || ctx.kind === 'none') { res.status(404).json({ error: 'Line not found or does not belong to commande' }); return }
    if (refuseIfSoldee(res, await loadCommandeSoldee(commandeId))) return

    const lcs = await query<{ quantite: number | null; type_kind: number | null }>(
      `SELECT quantite, type AS type_kind FROM ligne_commande_sous_traitant WHERE IDligne_commande_sous_traitant = ${sstLineId}`,
    )
    if (lcs.length === 0 || Number(lcs[0].type_kind) !== 1) { res.status(404).json({ error: 'Ligne tricoteur introuvable' }); return }
    const quantite = Number(lcs[0].quantite) || 0

    // Over-allocation guard: allocations across ALL client lines stay within
    // the knitting order's quantity.
    const allocs = await query<{ lcc: number; poids_affecte: number | null }>(
      `SELECT IDligne_commande_client AS lcc, poids_affecte FROM affectation_cmd_tricotage
        WHERE IDligne_commande_sous_traitant = ${sstLineId}`,
    )
    const othersTotal = allocs
      .filter((a) => Number(a.lcc) !== ligneId)
      .reduce((s, a) => s + (Number(a.poids_affecte) || 0), 0)
    if (value + othersTotal > quantite + 0.01) {
      res.status(400).json({ error: 'Le poids affecté dépasse le disponible de la commande tricoteur' })
      return
    }

    await query(
      `DELETE FROM affectation_cmd_tricotage
        WHERE IDligne_commande_sous_traitant = ${sstLineId} AND IDligne_commande_client = ${ligneId}`,
    )
    if (value !== 0) {
      await query(
        `INSERT INTO affectation_cmd_tricotage (poids_affecte, IDligne_commande_sous_traitant, IDligne_commande_client)
         VALUES (${n(value)}, ${sstLineId}, ${ligneId})`,
      )
    }
    res.json({ ok: true, poids_affecte: value })
  } catch (err) {
    console.error('Error updating tricotage affectation:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  EXPÉDITIONS — per-line shipment view + quick-ship
//  Mirrors the legacy "Gestion ligne de commande" Expédition tab (list the
//  expeditions carrying this line's rolls + the rolls per expedition) and the
//  Affectation tab's "Expédier" button (select affected rolls → one new
//  expedition). Reuses the expedition/ligne_expedition model of the
//  Expéditions screen: rolls point at ligne_expedition via
//  stock_fini.IDligne_expedition / stock_ecru.IDligne_expedition_ETM.
// ════════════════════════════════════════════════════════

async function resolveTransporteurNamesCC(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const u = Array.from(new Set(ids.filter((x) => x > 0)))
  if (u.length === 0) return out
  const rows = await query<{ IDtransporteur: number; nom: string | null }>(
    `SELECT IDtransporteur, nom FROM transporteur WHERE IDtransporteur IN (${u.join(',')})`,
  )
  for (const r of await fixEncoding(rows, 'transporteur', 'IDtransporteur', ['nom']))
    out.set(Number((r as any).IDtransporteur), ((r as any).nom ?? '').toString().trim())
  return out
}

commandesClientRouter.get('/:id/lignes/:ligneId/expeditions', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.id, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    if (isNaN(commandeId) || isNaN(ligneId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const ctx = await loadClientLineContext(commandeId, ligneId)
    if (!ctx) { res.status(404).json({ error: 'Line not found or does not belong to commande' }); return }
    const dim = lineDim(ctx.unite) as 'metrage' | 'poids'
    const base = { dim, unite_label: uniteLabel(ctx.unite), expeditions: [] as any[] }
    if (ctx.kind === 'none') { res.json(base); return }

    const le = await query<{ IDligne_expedition: number; IDexpedition: number }>(
      `SELECT IDligne_expedition, IDexpedition FROM ligne_expedition WHERE IDligne_commande_client = ${ligneId}`,
    )
    const leIds = le.map((r) => Number(r.IDligne_expedition)).filter((x) => x > 0)
    const expByLe = new Map(le.map((r) => [Number(r.IDligne_expedition), Number(r.IDexpedition)]))
    const expIds = Array.from(new Set(le.map((r) => Number(r.IDexpedition)).filter((x) => x > 0)))
    if (expIds.length === 0) { res.json(base); return }

    // DATE is a reserved word → alias (same quirk as the Expéditions screen).
    const heads = await query<any>(
      `SELECT IDexpedition, DATE AS dexp, est_valide, est_facture, IDtransporteur, IDadresse, inclureRapportQualite
         FROM expedition WHERE IDexpedition IN (${expIds.join(',')})`,
    )

    // This line's rolls on those expeditions.
    const rollsRaw = leIds.length === 0 ? [] : ctx.kind === 'fini'
      ? await query<any>(
          `SELECT IDstock_fini AS id, numero, lot, poids, metrage, IDmagasin, IDligne_expedition AS le
             FROM stock_fini WHERE IDligne_expedition IN (${leIds.join(',')}) ORDER BY numero`,
        )
      : await query<any>(
          `SELECT IDstock_ecru AS id, numero, lot, poids, metrage, IDmagasin, IDligne_expedition_ETM AS le
             FROM stock_ecru WHERE IDligne_expedition_ETM IN (${leIds.join(',')}) ORDER BY numero`,
        )
    const rollsFixed = await fixEncoding(rollsRaw, ctx.kind === 'fini' ? 'stock_fini' : 'stock_ecru',
      ctx.kind === 'fini' ? 'IDstock_fini' : 'IDstock_ecru', ['numero', 'lot'])

    const [magNames, transNames, adrRows] = await Promise.all([
      resolveMagasinNames((rollsFixed as any[]).map((r) => Number(r.IDmagasin))),
      resolveTransporteurNamesCC(heads.map((h: any) => Number(h.IDtransporteur))),
      (async () => {
        const ids = Array.from(new Set(heads.map((h: any) => Number(h.IDadresse)).filter((x: number) => x > 0)))
        if (ids.length === 0) return new Map<number, { nom: string; ville: string }>()
        const rows = await query<any>(`SELECT IDadresse, nom, ville FROM adresse WHERE IDadresse IN (${ids.join(',')})`)
        const fixed = await fixEncoding(rows, 'adresse', 'IDadresse', ['nom', 'ville'])
        return new Map<number, { nom: string; ville: string }>(
          (fixed as any[]).map((a) => [Number(a.IDadresse), { nom: (a.nom ?? '').toString().trim(), ville: (a.ville ?? '').toString().trim() }]),
        )
      })(),
    ])

    const rollsByExp = new Map<number, any[]>()
    for (const r of rollsFixed as any[]) {
      const expId = expByLe.get(Number(r.le)) ?? 0
      if (expId === 0) continue
      const arr = rollsByExp.get(expId) ?? []
      arr.push({
        id: Number(r.id),
        numero: r.numero ?? null,
        lot: r.lot ?? null,
        poids: round2c(Number(r.poids) || 0),
        metrage: round2c(Number(r.metrage) || 0),
        magasin_nom: magNames.get(Number(r.IDmagasin)) ?? null,
      })
      rollsByExp.set(expId, arr)
    }

    base.expeditions = heads
      .map((h: any) => {
        const expId = Number(h.IDexpedition)
        const rolls = rollsByExp.get(expId) ?? []
        const adr = adrRows.get(Number(h.IDadresse))
        return {
          IDexpedition: expId,
          date: h.dexp ?? null,
          est_valide: Number(h.est_valide) || 0,
          est_facture: Number(h.est_facture) || 0,
          inclure_rapport: Number(h.inclureRapportQualite) || 0,
          transporteur_nom: transNames.get(Number(h.IDtransporteur)) ?? '',
          adresse_nom: adr?.nom ?? '',
          adresse_ville: adr?.ville ?? '',
          nb_rolls: rolls.length,
          poids: round2c(rolls.reduce((s: number, r: any) => s + r.poids, 0)),
          metrage: round2c(rolls.reduce((s: number, r: any) => s + r.metrage, 0)),
          rolls,
        }
      })
      .sort((a: any, b: any) => b.IDexpedition - a.IDexpedition)
    res.json(base)
  } catch (err) {
    console.error('Error fetching line expeditions:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const expedierBody = z.object({
  stockIds: z.array(z.number().int().positive()).min(1),
})

// Quick-ship: legacy Affectation tab "Expédier" — one new expedition for the
// commande carrying the selected (affected, unshipped) rolls of this line.
// Header defaults mirror the Expéditions screen's create: livraison address
// from the commande, carrier from the client, est_valide = 0 (the BL is
// validated from the Expéditions screen).
commandesClientRouter.post('/:id/lignes/:ligneId/expedier', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.id, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    if (isNaN(commandeId) || isNaN(ligneId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = expedierBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const ctx = await loadClientLineContext(commandeId, ligneId)
    if (!ctx || ctx.kind === 'none') { res.status(404).json({ error: 'Ligne non expédiable' }); return }
    if (refuseIfSoldee(res, await loadCommandeSoldee(commandeId))) return

    // Keep only rolls affected to this line and not already on an expedition.
    const inIds = parsed.data.stockIds.join(',')
    const rollRows = ctx.kind === 'fini'
      ? await query<any>(
          `SELECT IDstock_fini AS id, IDligne_commande_client AS lcc, IDligne_expedition AS le
             FROM stock_fini WHERE IDstock_fini IN (${inIds})`,
        )
      : await query<any>(
          `SELECT IDstock_ecru AS id, IDligne_commande_client AS lcc, IDligne_expedition_ETM AS le
             FROM stock_ecru WHERE IDstock_ecru IN (${inIds})`,
        )
    const usable = rollRows.filter((r: any) => Number(r.lcc) === ligneId && (Number(r.le) || 0) === 0)
    if (usable.length === 0) { res.status(400).json({ error: 'Aucun rouleau expédiable dans la sélection' }); return }

    // Header defaults: livraison address from the commande, carrier from the
    // client. donation inherits the commande's flag so material shipped from a
    // donation order never generates a proforma downstream (legacy behavior).
    const cmdRows = await query<{ IDclient: number; IDadresse_livraison: number; donation: number | null }>(
      `SELECT IDclient, IDadresse_livraison, donation FROM commande_client WHERE IDcommande_client = ${commandeId} AND IDsociete = 1`,
    )
    if (cmdRows.length === 0) { res.status(400).json({ error: 'Commande introuvable' }); return }
    const clientRows = await query<{ IDtransporteur: number; inclureRapportQualite: number | null }>(
      `SELECT IDtransporteur, inclureRapportQualite FROM client WHERE IDclient = ${Number(cmdRows[0].IDclient) || 0}`,
    )
    // Per-shipment mirror of the client's "inclure rapports contrôle" flag —
    // legacy seeds it from the client at creation time.
    const inclureRc = Number(clientRows[0]?.inclureRapportQualite) === 1 ? 1 : 0
    const today = dateStr(new Date().toISOString().slice(0, 10))
    await query(
      `INSERT INTO expedition (IDsociete, IDcommande_client, IDadresse, IDtransporteur, IDcontact, DATE, donation, affiche_observations, est_valide, est_facture, inclureRapportQualite)
       VALUES (1, ${commandeId}, ${Number(cmdRows[0].IDadresse_livraison) || 0}, ${Number(clientRows[0]?.IDtransporteur) || 0}, 0, '${today}', ${Number(cmdRows[0].donation) === 1 ? 1 : 0}, 1, 0, 0, ${inclureRc})`,
    )
    const expRows = await query<{ IDexpedition: number }>(
      `SELECT IDexpedition FROM expedition WHERE IDcommande_client = ${commandeId} ORDER BY IDexpedition DESC`,
    )
    const expId = Number(expRows[0]?.IDexpedition) || 0
    if (expId <= 0) { res.status(500).json({ error: 'Header insert lookup failed' }); return }

    await query(`INSERT INTO ligne_expedition (IDexpedition, IDligne_commande_client, est_facture) VALUES (${expId}, ${ligneId}, 0)`)
    const leRows = await query<{ IDligne_expedition: number }>(
      `SELECT TOP 1 IDligne_expedition FROM ligne_expedition WHERE IDexpedition = ${expId} AND IDligne_commande_client = ${ligneId} ORDER BY IDligne_expedition DESC`,
    )
    const leId = Number(leRows[0]?.IDligne_expedition) || 0
    if (leId <= 0) { res.status(500).json({ error: "Création de la ligne d'expédition échouée" }); return }

    for (const r of usable) {
      const sid = Number(r.id)
      if (ctx.kind === 'fini') {
        await query(
          `UPDATE stock_fini SET IDligne_expedition = ${leId}
            WHERE IDstock_fini = ${sid} AND IDligne_commande_client = ${ligneId}
              AND (IDligne_expedition IS NULL OR IDligne_expedition = 0)`,
        )
      } else {
        await query(
          `UPDATE stock_ecru SET IDligne_expedition_ETM = ${leId}
            WHERE IDstock_ecru = ${sid} AND IDligne_commande_client = ${ligneId}
              AND (IDligne_expedition_ETM IS NULL OR IDligne_expedition_ETM = 0)`,
        )
      }
    }

    res.status(201).json({ ok: true, IDexpedition: expId, shipped: usable.length })
  } catch (err) {
    console.error('Error creating expedition from client line:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  EXPÉDITIONS DIVERS — per-line drawer + grouped shipment
//  Ports the legacy Commandes › Expédition tab for divers lines (stock
//  disponible + "Expédier" quantity prompt) and the FEN_Expéditions_Groupées
//  modal (one expedition_divers per order, several cartons, articles inside).
//  Writes go through the same expedition_divers model the Clients ›
//  Expéditions screen edits, and through adjustDiversStock so the stock_divers
//  ledger stays in sync with the legacy app.
// ════════════════════════════════════════════════════════

interface DiversLineContext {
  commandeId: number
  ligneId: number
  refId: number
  v1: number
  v2: number
  unite: number
  quantite: number
  prix: number
}

/** Load a divers (type 3) line, refusing anything else. */
async function loadDiversLineContext(commandeId: number, ligneId: number): Promise<DiversLineContext | null> {
  const rows = await query<any>(
    `SELECT IDcommande_client, TYPE AS type_kind, IDreference, IDVariation1, IDVariation2, unite, quantite, prix
     FROM ligne_commande_client WHERE IDligne_commande_client = ${ligneId}`,
  )
  if (rows.length === 0) return null
  const l = rows[0]
  if (Number(l.IDcommande_client) !== commandeId) return null
  if (Number(l.type_kind) !== 3) return null
  return {
    commandeId,
    ligneId,
    refId: Number(l.IDreference) || 0,
    v1: Number(l.IDVariation1) || 0,
    v2: Number(l.IDVariation2) || 0,
    unite: Number(l.unite) || 0,
    quantite: Number(l.quantite) || 0,
    prix: Number(l.prix) || 0,
  }
}

interface DiversCartonOut {
  IDligne_expedition_divers: number
  detail_ligne: string
  items: DiversItem[]
}
interface DiversExpeditionOut {
  IDexpedition_divers: number
  date: string | null
  ref_client: string | null
  est_valide: number
  est_facture: number
  locked: number
  IDtransporteur: number
  transporteur_nom: string
  IDadresse: number
  adresse_nom: string
  adresse_ville: string
  cartons: DiversCartonOut[]
}

/** Every divers shipment attached to a commande, with cartons + articles.
 *  One round-trip per table (headers / cartons / items), newest expedition first. */
async function loadCommandeDiversExpeditions(commandeId: number): Promise<DiversExpeditionOut[]> {
  const expIds = await diversExpeditionIds(commandeId)
  if (expIds.length === 0) return []
  const inExp = expIds.join(',')
  // DATE is a reserved word → alias (same quirk as the Expéditions screen).
  const heads = await query<any>(
    `SELECT IDexpedition_divers, DATE AS dexp, ref_client, est_valide, est_facture, IDtransporteur, IDadresse
       FROM expedition_divers WHERE IDexpedition_divers IN (${inExp})`,
  )
  const headsFixed = await fixEncoding(heads, 'expedition_divers', 'IDexpedition_divers', ['ref_client'])
  const cartonsRaw = await query<any>(
    `SELECT IDligne_expedition_divers, IDexpedition_divers, detail_ligne
       FROM ligne_expedition_divers WHERE IDexpedition_divers IN (${inExp}) ORDER BY IDligne_expedition_divers`,
  )
  const cartonsFixed = await fixEncoding(cartonsRaw, 'ligne_expedition_divers', 'IDligne_expedition_divers', ['detail_ligne'])
  const cartonIds = (cartonsFixed as any[]).map((c) => Number(c.IDligne_expedition_divers)).filter((x) => x > 0)
  const [itemsByCarton, transNames, adrRows] = await Promise.all([
    loadDiversItems(cartonIds),
    resolveTransporteurNamesCC((headsFixed as any[]).map((h) => Number(h.IDtransporteur))),
    (async () => {
      const ids = Array.from(new Set((headsFixed as any[]).map((h) => Number(h.IDadresse)).filter((x: number) => x > 0)))
      if (ids.length === 0) return new Map<number, { nom: string; ville: string }>()
      const rows = await query<any>(`SELECT IDadresse, nom, ville FROM adresse WHERE IDadresse IN (${ids.join(',')})`)
      const fixed = await fixEncoding(rows, 'adresse', 'IDadresse', ['nom', 'ville'])
      return new Map<number, { nom: string; ville: string }>(
        (fixed as any[]).map((a) => [Number(a.IDadresse), { nom: (a.nom ?? '').toString().trim(), ville: (a.ville ?? '').toString().trim() }]),
      )
    })(),
  ])

  const cartonsByExp = new Map<number, DiversCartonOut[]>()
  for (const c of cartonsFixed as any[]) {
    const expId = Number(c.IDexpedition_divers) || 0
    const cid = Number(c.IDligne_expedition_divers) || 0
    const arr = cartonsByExp.get(expId) ?? []
    arr.push({
      IDligne_expedition_divers: cid,
      detail_ligne: stripRtf(c.detail_ligne) ?? '',
      items: itemsByCarton.get(cid) ?? [],
    })
    cartonsByExp.set(expId, arr)
  }

  return (headsFixed as any[])
    .map((h): DiversExpeditionOut => {
      const expId = Number(h.IDexpedition_divers) || 0
      const adr = adrRows.get(Number(h.IDadresse))
      const estFacture = Number(h.est_facture) || 0
      return {
        IDexpedition_divers: expId,
        date: h.dexp ?? null,
        ref_client: h.ref_client ?? null,
        est_valide: Number(h.est_valide) || 0,
        est_facture: estFacture,
        // Facturée → the whole shipment is read-only (same rule as the
        // Expéditions screen; its endpoints reject the writes anyway).
        locked: estFacture === 1 ? 1 : 0,
        IDtransporteur: Number(h.IDtransporteur) || 0,
        transporteur_nom: transNames.get(Number(h.IDtransporteur)) ?? '',
        IDadresse: Number(h.IDadresse) || 0,
        adresse_nom: adr?.nom ?? '',
        adresse_ville: adr?.ville ?? '',
        cartons: cartonsByExp.get(expId) ?? [],
      }
    })
    .sort((a, b) => b.IDexpedition_divers - a.IDexpedition_divers)
}

/** Header defaults for a new expedition_divers on this commande: client +
 *  livraison address + ref_client from the order, carrier from the client
 *  (mirrors the écru/fini quick-ship defaults). */
async function diversExpeditionDefaults(commandeId: number): Promise<
  { IDclient: number; IDadresse: number; IDtransporteur: number; ref_client: string } | null
> {
  const cmdRows = await query<any>(
    `SELECT IDclient, IDadresse_livraison, numero, date_commande, ref_client
       FROM commande_client WHERE IDcommande_client = ${commandeId} AND IDsociete = 1`,
  )
  if (cmdRows.length === 0) return null
  const fixed = (await fixEncoding(cmdRows, 'commande_client', 'IDcommande_client', ['ref_client']))[0] as any
  const IDclient = Number(cmdRows[0].IDclient) || 0
  const clientRows = IDclient > 0
    ? await query<{ IDtransporteur: number }>(`SELECT IDtransporteur FROM client WHERE IDclient = ${IDclient}`)
    : []
  // Legacy seeds ref_client with the order's own customer reference, falling
  // back to "Commande C<numero> du <date>" — the label seen on live rows.
  const numero = cmdRows[0].numero != null ? Number(cmdRows[0].numero) : 0
  const fallback = numero > 0
    ? `Commande C${numero}${cmdRows[0].date_commande ? ` du ${formatHfsqlDateFr(cmdRows[0].date_commande)}` : ''}`
    : ''
  return {
    IDclient,
    IDadresse: Number(cmdRows[0].IDadresse_livraison) || 0,
    IDtransporteur: Number(clientRows[0]?.IDtransporteur) || 0,
    ref_client: (fixed?.ref_client ?? '').toString().trim() || fallback,
  }
}

/** Create an expedition_divers for a commande and return its id. */
async function createDiversExpeditionForCommande(commandeId: number): Promise<number> {
  const d = await diversExpeditionDefaults(commandeId)
  if (!d) return 0
  const before = await query<{ m: number | null }>(`SELECT MAX(IDexpedition_divers) AS m FROM expedition_divers`)
  const beforeId = Number(before[0]?.m) || 0
  await query(
    `INSERT INTO expedition_divers (IDclient, ref_client, IDadresse, IDtransporteur, DATE, est_valide, est_facture, IDcommande_client) ` +
      `VALUES (${d.IDclient}, ${sqlText(d.ref_client)}, ${d.IDadresse}, ${d.IDtransporteur}, '${dateStr(new Date().toISOString().slice(0, 10))}', 0, 0, ${commandeId})`,
  )
  const rows = await query<{ id: number }>(
    `SELECT TOP 1 IDexpedition_divers AS id FROM expedition_divers WHERE IDexpedition_divers > ${beforeId} ORDER BY IDexpedition_divers DESC`,
  )
  return Number(rows[0]?.id) || 0
}

/** First carton of an expedition, creating "CARTON 1" when there is none. */
async function ensureDiversCarton(expId: number): Promise<number> {
  const existing = await query<{ IDligne_expedition_divers: number }>(
    `SELECT IDligne_expedition_divers FROM ligne_expedition_divers WHERE IDexpedition_divers = ${expId} ORDER BY IDligne_expedition_divers`,
  )
  const ids = existing.map((r) => Number(r.IDligne_expedition_divers)).filter((x) => x > 0)
  if (ids.length > 0) return ids[ids.length - 1]
  const before = await query<{ m: number | null }>(`SELECT MAX(IDligne_expedition_divers) AS m FROM ligne_expedition_divers`)
  const beforeId = Number(before[0]?.m) || 0
  await query(
    `INSERT INTO ligne_expedition_divers (IDexpedition_divers, detail_ligne) VALUES (${expId}, ${sqlText(wrapRtf('CARTON 1'))})`,
  )
  const rows = await query<{ id: number }>(
    `SELECT TOP 1 IDligne_expedition_divers AS id FROM ligne_expedition_divers WHERE IDligne_expedition_divers > ${beforeId} ORDER BY IDligne_expedition_divers DESC`,
  )
  return Number(rows[0]?.id) || 0
}

// Drawer payload for a divers line: the article it names, what's on hand, what
// already shipped, and the cartons carrying it.
commandesClientRouter.get('/:id/lignes/:ligneId/divers', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.id, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    if (isNaN(commandeId) || isNaN(ligneId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const ctx = await loadDiversLineContext(commandeId, ligneId)
    if (!ctx) { res.status(404).json({ error: 'Ligne divers introuvable' }); return }

    const key = diversKey(ctx.refId, ctx.v1, ctx.v2)
    const [refRows, varLabels, stockMap, expeditions] = await Promise.all([
      ctx.refId > 0
        ? query<any>(`SELECT IDref_divers, designation FROM ref_divers WHERE IDref_divers = ${ctx.refId}`)
        : Promise.resolve([]),
      resolveDiversVariations([ctx.v1, ctx.v2]),
      diversStockByArticle([ctx.refId]),
      loadCommandeDiversExpeditions(commandeId),
    ])
    const refFixed = (await repairAliased(refRows as any[], 'ref_divers', 'IDref_divers', { designation: 'designation' }))[0] as any

    // Keep only the cartons that actually carry this line's article, and expose
    // the matching item so the drawer can show its quantity + price.
    const scoped = expeditions
      .map((e) => ({
        ...e,
        cartons: e.cartons
          .map((c) => ({
            ...c,
            items: c.items.filter((i) => diversKey(i.IDref_divers, i.IDVariation1, i.IDVariation2) === key),
          }))
          .filter((c) => c.items.length > 0),
      }))
      .filter((e) => e.cartons.length > 0)

    const expedie = scoped.reduce(
      (s, e) => s + e.cartons.reduce((cs, c) => cs + c.items.reduce((is, i) => is + i.quantite, 0), 0),
      0,
    )

    res.json({
      IDligne_commande_client: ligneId,
      IDref_divers: ctx.refId,
      ref_designation: (refFixed?.designation ?? '').toString(),
      IDVariation1: ctx.v1,
      variation1_label: ctx.v1 > 0 ? (varLabels.get(ctx.v1) ?? null) : null,
      IDVariation2: ctx.v2,
      variation2_label: ctx.v2 > 0 ? (varLabels.get(ctx.v2) ?? null) : null,
      unite: ctx.unite,
      unite_label: uniteLabel(ctx.unite),
      prix: round2c(ctx.prix),
      quantite_commandee: round2c(ctx.quantite),
      quantite_expediee: round2c(expedie),
      // stock_divers on-hand for this exact article; null = no ledger row
      // (the combo is untracked — legacy opens rows from Gestion Stock Divers).
      stock_disponible: stockMap.has(key) ? round2c(stockMap.get(key)!) : null,
      expeditions: scoped,
    })
  } catch (err) {
    console.error('Error fetching divers line shipments:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const expedierDiversBody = z.object({
  quantite: z.number().positive(),
  /** Target shipment. Omitted / 0 → append to the order's open (non-facturée)
   *  shipment, creating one when there is none. */
  IDexpedition_divers: z.number().int().nonnegative().optional(),
  IDligne_expedition_divers: z.number().int().nonnegative().optional(),
})

// Quick-ship a divers line — the legacy "Expédier" button + quantity prompt.
commandesClientRouter.post('/:id/lignes/:ligneId/expedier-divers', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.id, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    if (isNaN(commandeId) || isNaN(ligneId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = expedierDiversBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const ctx = await loadDiversLineContext(commandeId, ligneId)
    if (!ctx) { res.status(404).json({ error: 'Ligne divers introuvable' }); return }
    if (ctx.refId <= 0) { res.status(400).json({ error: 'Ligne sans référence divers' }); return }
    if (refuseIfSoldee(res, await loadCommandeSoldee(commandeId))) return
    const qty = round2c(parsed.data.quantite)
    if (!(qty > 0)) { res.status(400).json({ error: 'Quantité invalide' }); return }

    // Target carton: explicit, else the last carton of the order's open
    // shipment, else a fresh shipment + CARTON 1.
    let cartonId = Number(parsed.data.IDligne_expedition_divers) || 0
    let expId = Number(parsed.data.IDexpedition_divers) || 0
    if (cartonId > 0) {
      const owner = await query<{ IDexpedition_divers: number }>(
        `SELECT IDexpedition_divers FROM ligne_expedition_divers WHERE IDligne_expedition_divers = ${cartonId}`,
      )
      expId = Number(owner[0]?.IDexpedition_divers) || 0
      if (expId <= 0) { res.status(400).json({ error: 'Carton introuvable' }); return }
    }
    if (expId <= 0) {
      const open = (await loadCommandeDiversExpeditions(commandeId)).find((e) => e.locked === 0)
      expId = open?.IDexpedition_divers ?? 0
    }
    if (expId <= 0) {
      expId = await createDiversExpeditionForCommande(commandeId)
      if (expId <= 0) { res.status(500).json({ error: "Création de l'expédition échouée" }); return }
    }
    // The shipment must belong to this order and not be invoiced.
    const head = await query<{ IDcommande_client: number; est_facture: number | null }>(
      `SELECT IDcommande_client, est_facture FROM expedition_divers WHERE IDexpedition_divers = ${expId}`,
    )
    if (head.length === 0 || Number(head[0].IDcommande_client) !== commandeId) {
      res.status(400).json({ error: 'Expédition hors de cette commande' }); return
    }
    if (Number(head[0].est_facture) === 1) {
      res.status(409).json({ error: 'expedition_facturee', message: 'Expédition facturée — non modifiable.' }); return
    }
    if (cartonId <= 0) cartonId = await ensureDiversCarton(expId)
    if (cartonId <= 0) { res.status(500).json({ error: 'Création du carton échouée' }); return }

    // unite comes from the catalog (ref_divers), price from the order line —
    // that's what the customer is billed, and what live rows carry.
    const refRows = await query<{ unite: number | null }>(`SELECT IDref_divers, unite FROM ref_divers WHERE IDref_divers = ${ctx.refId}`)
    if (refRows.length === 0) { res.status(400).json({ error: 'Référence divers introuvable' }); return }
    await query(
      `INSERT INTO ref_divers_expedie (IDligne_expedition_divers, designation, quantite, unite, prix, IDref_divers, IDVariation1, IDVariation2) ` +
        `VALUES (${cartonId}, '', ${qty}, ${Number(refRows[0].unite) || 0}, ${round2c(ctx.prix)}, ${ctx.refId}, ${ctx.v1}, ${ctx.v2})`,
    )
    await adjustDiversStock(ctx.refId, ctx.v1, ctx.v2, -qty)

    res.status(201).json({ ok: true, IDexpedition_divers: expId, IDligne_expedition_divers: cartonId, quantite: qty })
  } catch (err) {
    console.error('Error shipping divers line:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Grouped-shipment payload: every divers shipment of the order with its
// cartons and articles, plus the order's shippable lines and their remainders.
commandesClientRouter.get('/:id/expeditions-divers', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const lignesRaw = await query<any>(
      `SELECT IDligne_commande_client, TYPE AS type_kind, IDreference, IDVariation1, IDVariation2, quantite, unite, prix
         FROM ligne_commande_client WHERE IDcommande_client = ${id} ORDER BY IDligne_commande_client`,
    )
    const diversLines = (lignesRaw as any[]).filter((l) => Number(l.type_kind) === 3)
    const refIds = Array.from(new Set(diversLines.map((l) => Number(l.IDreference) || 0).filter((x) => x > 0)))

    const [expeditions, shipped, stock, varLabels, refRows, defaults] = await Promise.all([
      loadCommandeDiversExpeditions(id),
      diversLines.length > 0 ? diversShippedByArticle(id) : Promise.resolve(new Map<string, number>()),
      diversStockByArticle(refIds),
      resolveDiversVariations(diversLines.flatMap((l) => [Number(l.IDVariation1) || 0, Number(l.IDVariation2) || 0])),
      refIds.length > 0
        ? query<any>(`SELECT IDref_divers, designation FROM ref_divers WHERE IDref_divers IN (${refIds.join(',')})`)
        : Promise.resolve([]),
      diversExpeditionDefaults(id),
    ])
    const refFixed = await repairAliased(refRows as any[], 'ref_divers', 'IDref_divers', { designation: 'designation' })
    const refName = new Map<number, string>()
    for (const r of refFixed as any[]) refName.set(Number(r.IDref_divers), (r.designation ?? '').toString())

    const lignes = diversLines.map((l) => {
      const refId = Number(l.IDreference) || 0
      const v1 = Number(l.IDVariation1) || 0
      const v2 = Number(l.IDVariation2) || 0
      const key = diversKey(refId, v1, v2)
      const commandee = round2c(Number(l.quantite) || 0)
      const expediee = round2c(shipped.get(key) ?? 0)
      return {
        IDligne_commande_client: Number(l.IDligne_commande_client),
        IDref_divers: refId,
        ref_designation: refName.get(refId) ?? '',
        IDVariation1: v1,
        variation1_label: v1 > 0 ? (varLabels.get(v1) ?? null) : null,
        IDVariation2: v2,
        variation2_label: v2 > 0 ? (varLabels.get(v2) ?? null) : null,
        unite: Number(l.unite) || 0,
        unite_label: uniteLabel(l.unite),
        prix: round2c(Number(l.prix) || 0),
        quantite_commandee: commandee,
        quantite_expediee: expediee,
        reste: round2c(Math.max(0, commandee - expediee)),
        stock_disponible: stock.has(key) ? round2c(stock.get(key)!) : null,
      }
    })

    res.json({ lignes, expeditions, defaults })
  } catch (err) {
    console.error('Error fetching commande divers expeditions:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Open a new grouped shipment on this order (header seeded from the order).
commandesClientRouter.post('/:id/expeditions-divers', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (refuseIfSoldee(res, await loadCommandeSoldee(id))) return
    const expId = await createDiversExpeditionForCommande(id)
    if (expId <= 0) { res.status(400).json({ error: 'Commande introuvable' }); return }
    await ensureDiversCarton(expId)
    res.status(201).json({ ok: true, IDexpedition_divers: expId })
  } catch (err) {
    console.error('Error creating commande divers expedition:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesClientRouter.get('/:id/lignes/:ligneId/supply/ennoblissement/available-by-location', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.id, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    if (isNaN(commandeId) || isNaN(ligneId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const ctx = await loadClientLineContext(commandeId, ligneId)
    if (!ctx || ctx.kind !== 'fini') { res.status(404).json({ error: 'Fini line not found' }); return }
    res.json(await fetchEnnoLocations(ctx))
  } catch (err) {
    console.error('Error fetching ennoblissement locations:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const ennoOrderBody = z.object({
  IDsous_traitant: z.number().int().positive(),
  date_commande: z.string().optional(),
  date_livraison: z.string().optional(),
  stockEcruIds: z.array(z.number().int().positive()).min(1),
})

commandesClientRouter.post('/:id/lignes/:ligneId/supply/ennoblissement/orders', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.id, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    if (isNaN(commandeId) || isNaN(ligneId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = ennoOrderBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data
    const ctx = await loadClientLineContext(commandeId, ligneId)
    if (!ctx || ctx.kind !== 'fini') { res.status(404).json({ error: 'Fini line not found' }); return }
    if (refuseIfSoldee(res, await loadCommandeSoldee(commandeId))) return

    // Resolve the fini's écru ref + rendement (line ↔ dye trace).
    const refRows = await query<{ IDref_ecru: number | null; rendement: number | null }>(
      `SELECT IDref_ecru, rendement FROM ref_fini WHERE IDref_fini = ${ctx.refId}`,
    )
    const ecruRefId = Number(refRows[0]?.IDref_ecru) || 0
    const rendement = Number(refRows[0]?.rendement) || 0
    if (ecruRefId <= 0) { res.status(400).json({ error: 'Fini ref has no écru ref' }); return }

    // Keep only selected rolls that are this écru ref, still free of a dyer
    // affectation, and not reserved to a donation commande (defensive against
    // a stale client cache).
    const rollRows = await query<{
      IDstock_ecru: number; IDref_ecru: number; poids: number | null
      IDref_commande_affectation: number | null; IDcommande_donation: number | null
    }>(
      `SELECT IDstock_ecru, IDref_ecru, poids, IDref_commande_affectation, IDcommande_donation
         FROM stock_ecru WHERE IDstock_ecru IN (${d.stockEcruIds.join(',')})`,
    )
    const usable = rollRows.filter(
      (r) =>
        Number(r.IDref_ecru) === ecruRefId &&
        (Number(r.IDref_commande_affectation) || 0) === 0 &&
        (Number(r.IDcommande_donation) || 0) === 0,
    )
    if (usable.length === 0) { res.status(400).json({ error: 'No usable rolls in selection' }); return }
    const totalPoids = usable.reduce((s, r) => s + (Number(r.poids) || 0), 0)

    // ── Create the dyer order header. Ennoblisseurs are external sous-
    //    traitants → NO TRM cross-ledger mirror (and no bridge-storm risk).
    const dateCmd = dateStr(d.date_commande ?? '')
    await query(
      `INSERT INTO commande_sous_traitant
       (IDsous_traitant, date_commande, est_soldee, commentaire, journal,
        IDadresse_sous_traitant, IDadresse_livraison, IDdossier, IDcommande_client, IDligne_commande_client)
       VALUES (${d.IDsous_traitant}, '${dateCmd}', 0, '', '',
               0, 0, 0, 0, 0)`,
    )
    const hdr = await query<{ IDcommande_sous_traitant: number }>(
      `SELECT IDcommande_sous_traitant FROM commande_sous_traitant
        WHERE IDsous_traitant = ${d.IDsous_traitant} ORDER BY IDcommande_sous_traitant DESC`,
    )
    const newCmdId = Number(hdr[0]?.IDcommande_sous_traitant) || 0
    if (newCmdId <= 0) { res.status(500).json({ error: 'Header insert lookup failed' }); return }

    // ── Create the single ennoblisseur line (type=2). quantite is the metrage
    //    to dye (Ml = Σ écru poids × raw rendement); unite=0 + prix=€/Kg match
    //    how the Sous-traitants screen stores ennoblisseur lines. A fresh order
    //    has not been sent → sstatut starts Non_Envoye.
    const dateLiv = dateStr(d.date_livraison ?? '')
    const quantiteMl = Math.round(totalPoids * rendement * 100) / 100
    await query(
      `INSERT INTO ligne_commande_sous_traitant
       (IDcommande_sous_traitant, type, IDreference, IDColoris, quantite, unite, prix,
        date_livraison, date_delai, sstatut, commentaire)
       VALUES (${newCmdId}, 2, ${ctx.refId}, ${ctx.coloriId}, ${quantiteMl}, 0, 0,
               '${dateLiv}', '${dateLiv}', 'Non_Envoye', '')`,
    )
    const lineRows = await query<{ IDligne_commande_sous_traitant: number }>(
      `SELECT IDligne_commande_sous_traitant FROM ligne_commande_sous_traitant
        WHERE IDcommande_sous_traitant = ${newCmdId} ORDER BY IDligne_commande_sous_traitant DESC`,
    )
    const newLineId = Number(lineRows[0]?.IDligne_commande_sous_traitant) || 0
    if (newLineId <= 0) { res.status(500).json({ error: 'Line insert lookup failed' }); return }

    // ── Affect rolls to the new dyer line; auto-reserve the FREE ones to this
    //    client line (rolls already reserved elsewhere keep their reservation).
    for (const r of usable) {
      const sid = Number(r.IDstock_ecru)
      await query(`UPDATE stock_ecru SET IDref_commande_affectation = ${newLineId} WHERE IDstock_ecru = ${sid}`)
      await query(
        `UPDATE stock_ecru SET IDligne_commande_client = ${ligneId}
          WHERE IDstock_ecru = ${sid} AND (IDligne_commande_client IS NULL OR IDligne_commande_client = 0)`,
      )
    }

    // ── Auto-price (best-effort: stays 0 when the dyer has no tariff data).
    let prix = 0
    try {
      prix = await calcTarifSST({
        xPoids: totalPoids,
        IDsous_traitant: d.IDsous_traitant,
        IDref_fini: ctx.refId,
        IDref_fini_colori: ctx.coloriId,
      })
      if (prix > 0) {
        await query(`UPDATE ligne_commande_sous_traitant SET prix = ${n(prix)} WHERE IDligne_commande_sous_traitant = ${newLineId}`)
      }
    } catch (e) {
      console.error('[enno-order] auto-price failed for line', newLineId, e)
    }

    res.status(201).json({
      ok: true,
      IDcommande_sous_traitant: newCmdId,
      IDligne_commande_sous_traitant: newLineId,
      affected: usable.length,
      prix,
    })
  } catch (err) {
    console.error('Error creating ennoblisseur order from client line:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  PDF  (bon de commande client)
// ════════════════════════════════════════════════════════

async function loadModePaiementLabel(id: number): Promise<string | null> {
  if (!(id > 0)) return null
  const rows = await query<{ libelle: string | null }>(`SELECT libelle FROM mode_paiement WHERE IDmode_paiement = ${id}`)
  const fixed = await fixEncoding(rows, 'mode_paiement', 'IDmode_paiement', ['libelle'])
  return (fixed[0]?.libelle ?? null) as string | null
}

async function loadEcheanceLabel(id: number): Promise<string | null> {
  if (!(id > 0)) return null
  const rows = await query<{ libelle: string | null }>(`SELECT libelle FROM echeance WHERE IDecheance = ${id}`)
  const fixed = await fixEncoding(rows, 'echeance', 'IDecheance', ['libelle'])
  return (fixed[0]?.libelle ?? null) as string | null
}

export async function buildClientPdfData(id: number): Promise<CommandeClientPdfData | null> {
  const rows = await query<any>(`SELECT * FROM commande_client WHERE IDcommande_client = ${id}`)
  if (rows.length === 0) return null
  const fixedHeader = await fixEncoding(rows, 'commande_client', 'IDcommande_client', ['ref_client', 'commentaire'])
  const h = fixedHeader[0] as any
  h.commentaire = stripRtf(h.commentaire) || null

  const IDclient = Number(h.IDclient) || 0
  const [clientNames, adrLivRows, adrFacRows, lignesRaw, tvaRate, modePaiement, echeance] = await Promise.all([
    resolveClientNames([IDclient]),
    h.IDadresse_livraison ? query(`SELECT IDadresse, nom, adresse1, adresse2, adresse3, cp, ville, pays FROM adresse WHERE IDadresse = ${n(h.IDadresse_livraison)}`) : Promise.resolve([]),
    h.IDadresse_facturation ? query(`SELECT IDadresse, nom, adresse1, adresse2, adresse3, cp, ville, pays FROM adresse WHERE IDadresse = ${n(h.IDadresse_facturation)}`) : Promise.resolve([]),
    query<any>(
      `SELECT IDligne_commande_client, TYPE AS type_kind, IDreference, IDcolori,
              quantite, unite, prix, date_livraison
       FROM ligne_commande_client WHERE IDcommande_client = ${id} ORDER BY IDligne_commande_client`,
    ),
    // The client's own rate, NOT the ETM default — an "Exonération" client
    // (export) must be billed at 0 % on every document (lib/tva.ts).
    loadClientTvaRate(IDclient),
    loadModePaiementLabel(Number(h.IDmode_paiement) || 0),
    loadEcheanceLabel(Number(h.IDecheance) || 0),
  ])

  const adrLiv = (await fixEncoding(adrLivRows, 'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays']))[0] ?? null
  const adrFac = (await fixEncoding(adrFacRows, 'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays']))[0] ?? null
  const lignesFixed = lignesRaw as any[]
  const maps = await resolveLineLabels(lignesFixed.map((l) => ({
    IDreference: Number(l.IDreference) || 0, IDcolori: Number(l.IDcolori) || 0, type_kind: Number(l.type_kind) || 0,
  })))

  const lignes = lignesFixed.map((l) => {
    const typeKind = Number(l.type_kind) || 0
    const refId = Number(l.IDreference) || 0
    const colId = Number(l.IDcolori) || 0
    const resolved = resolveRefLabel(maps, refId, typeKind)
    const qty = Number(l.quantite) || 0
    const prix = Number(l.prix) || 0
    return {
      ref_label: resolved.label || null,
      colori_reference: resolveColorisLabel(maps, colId, typeKind, refId) || null,
      quantite: qty,
      unite_label: uniteLabel(l.unite),
      prix,
      montant: qty * prix,
      date_livraison: formatHfsqlDateFr(l.date_livraison),
    }
  })

  const cleanAddr = (a: any | null) => a ? {
    nom: cleanAddrField(a.nom), adresse1: cleanAddrField(a.adresse1), adresse2: cleanAddrField(a.adresse2),
    adresse3: cleanAddrField(a.adresse3), cp: cleanAddrField(a.cp), ville: cleanAddrField(a.ville), pays: cleanAddrField(a.pays),
  } : null

  return {
    numero: String(h.numero ?? id),
    dateCommande: formatHfsqlDateLongFr(h.date_commande),
    clientNom: clientNames.get(IDclient) ?? '',
    refClient: (h.ref_client ?? null) as string | null,
    adresseFacturation: cleanAddr(adrFac),
    adresseLivraison: cleanAddr(adrLiv),
    modePaiement: modePaiement,
    echeance: echeance,
    commentaire: h.commentaire ?? null,
    remise: Number(h.remise) || 0,
    fraisPort: Number(h.frais_port) || 0,
    tvaRate,
    lignes,
  }
}

async function renderClientPdfBuffer(data: CommandeClientPdfData): Promise<Buffer> {
  return renderToBuffer(
    React.createElement(CommandeClientPdf, { data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >,
  )
}

// ── CGV (conditions générales de vente) ──────────────────
// Rendered from CgvPdf.tsx (the legal text lives there), always attached to
// confirmation-de-commande emails and previewable in the send-email dialog.
// The content is static per process lifetime, so render once and cache.
const CGV_ATTACHMENT_FILENAME = 'CGV - ETS Malterre.pdf'
let cgvPdfCache: Buffer | null = null

async function getCgvPdf(): Promise<Buffer> {
  if (!cgvPdfCache) {
    cgvPdfCache = await renderToBuffer(
      React.createElement(CgvPdf) as unknown as React.ReactElement<
        import('@react-pdf/renderer').DocumentProps
      >,
    )
  }
  return cgvPdfCache
}

// Registered before /:id/pdf so the literal segment wins over the param route.
commandesClientRouter.get('/cgv/pdf', async (_req: Request, res: Response) => {
  try {
    const buf = await getCgvPdf()
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${CGV_ATTACHMENT_FILENAME}"`)
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buf)
  } catch (err) {
    console.error('Error rendering CGV PDF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesClientRouter.get('/:id/pdf', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const data = await buildClientPdfData(id)
    if (!data) { res.status(404).json({ error: 'Commande not found' }); return }
    const buffer = await renderClientPdfBuffer(data)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="confirmation-commande-${data.numero}.pdf"`)
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buffer)
  } catch (err) {
    console.error('Error rendering commande-client PDF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  FACTURE PROFORMA  (commande-based, generated on the fly)
// ════════════════════════════════════════════════════════
//
// A proforma invoice derived straight from the commande header + lines —
// NEVER persisted to facturation (no facture_prov row, no proforma numero
// consumed). Rendered with the same FacturePdf template as facturation
// proformas ("Facture proforma" title, bank-coordinates card, non-contractual
// mention) so clients see one consistent proforma look, extended with the
// commande's remise / frais de port totals rows. Dated at generation time.

// Proforma numero = 1 000 000 + commande numero (e.g. commande 3658 →
// proforma N°1003658). The offset guarantees it can never collide with the
// numbers issued by clients/facturation — definitive facture.numero (~9k)
// and facturation-proforma IDfacture_prov (~13k) are both far below 1M —
// while staying purely numeric and deterministic (same commande → same
// proforma number on every re-print/re-send).
const PROFORMA_NUMERO_OFFSET = 1_000_000

/** Today as HFSQL YYYYMMDD. */
function todayHfsqlDate(): string {
  const d = new Date()
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

export async function buildProformaPdfData(id: number): Promise<FacturePdfData | null> {
  const base = await buildClientPdfData(id)
  if (!base) return null

  const hdr = await query<{ IDclient: number; IDecheance: number }>(
    `SELECT IDclient, IDecheance FROM commande_client WHERE IDcommande_client = ${id}`,
  )
  const IDclient = Number(hdr[0]?.IDclient) || 0
  const IDecheance = Number(hdr[0]?.IDecheance) || 0

  // Billing defaults from the client row — the same source facture creation
  // uses (factures.ts billingDefaults). The TVA rate already comes from the
  // client via buildClientPdfData; only the VAT number is read here.
  let numTva: string | null = null
  const tvaRate = base.tvaRate
  if (IDclient > 0) {
    try {
      const cli = await query<{ num_tva: string | null }>(
        `SELECT num_tva FROM client WHERE IDclient = ${IDclient}`,
      )
      numTva = ((cli[0]?.num_tva ?? '').toString().trim()) || null
    } catch { /* keep defaults */ }
  }

  const todayYmd = todayHfsqlDate()
  const echRule = await loadEcheanceRule(IDecheance)

  return {
    numero: String(PROFORMA_NUMERO_OFFSET + (Number(base.numero) || id)),
    refCommande: base.numero,
    type: 1,
    isProforma: true,
    dateFacture: formatHfsqlDateLongFr(todayYmd),
    clientNom: base.clientNom,
    numTva,
    adresseFacturation: base.adresseFacturation,
    modePaiement: base.modePaiement,
    echeance: base.echeance,
    echeanceDate: computeDateEcheance(todayYmd, echRule),
    tvaRate,
    remise: base.remise,
    fraisPort: base.fraisPort,
    lignes: base.lignes.map((l) => ({
      designation: [l.ref_label, l.colori_reference].filter((s) => s && s.trim()).join(' - ') || '—',
      quantite: l.quantite,
      unite: l.unite_label,
      prix: l.prix,
      montant: l.montant,
    })),
  }
}

async function renderProformaPdfBuffer(data: FacturePdfData): Promise<Buffer> {
  return renderToBuffer(
    React.createElement(FacturePdf, { data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >,
  )
}

/** The proforma (print + email) is permission-gated: users without the right
 *  only ever get the confirmation de commande. Responds 401/403 itself and
 *  returns false when the caller must stop. */
async function requireProformaPermission(req: Request, res: Response): Promise<boolean> {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return false
  }
  const allowed = await userHasPermission(req.userId, isEffectiveAdmin(req), 'proforma_commande_client')
  if (!allowed) {
    res.status(403).json({ error: 'permission denied: proforma_commande_client' })
    return false
  }
  return true
}

commandesClientRouter.get('/:id/proforma/pdf', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await requireProformaPermission(req, res))) return
    const data = await buildProformaPdfData(id)
    if (!data) { res.status(404).json({ error: 'Commande not found' }); return }
    const buffer = await renderProformaPdfBuffer(data)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="proforma-${data.numero}.pdf"`)
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buffer)
  } catch (err) {
    console.error('Error rendering commande-client proforma PDF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  CALCUL DE LA VALEUR  (donation orders only)
// ════════════════════════════════════════════════════════
//
// Cost valuation of the stock pieces attached to a donation commande — the
// legacy ETAT_ValeurDonation report. Only offered on donation orders (a normal
// order carries lignes, not attached pieces). The figures are built by
// buildDonationValeurData; see that module for the cost model.

const DONATION_VALEUR_NOTES = 'donation-valeur'

async function renderDonationValeurBuffer(data: DonationValeurPdfData): Promise<Buffer> {
  return renderToBuffer(
    React.createElement(ValeurDonationPdf, { data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >,
  )
}

function donationValeurFilename(numero: string): string {
  return `calcul-valeur-donation-${numero}.pdf`
}

/** Loads the valuation and rejects non-donation orders. Responds itself and
 *  returns null when the caller must stop. */
async function loadDonationValeur(id: number, res: Response): Promise<DonationValeurPdfData | null> {
  const data = await buildDonationValeurData(id)
  if (!data) { res.status(404).json({ error: 'Commande not found' }); return null }
  if (!data.isDonation) {
    res.status(400).json({
      error: 'not_a_donation',
      message: "Le calcul de la valeur n'existe que sur les commandes de type donation.",
    })
    return null
  }
  return data
}

commandesClientRouter.get('/:id/donation-valeur/pdf', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const data = await loadDonationValeur(id, res)
    if (!data) return
    const buffer = await renderDonationValeurBuffer(data)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${donationValeurFilename(data.numero)}"`)
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buffer)
  } catch (err) {
    console.error('Error rendering donation valeur PDF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  EMAIL  (bon de commande client → Gmail)
// ════════════════════════════════════════════════════════

interface EmailRecipientPayload { email: string; name?: string; source: 'contact'; contactId: number }
interface EmailDefaultsPayload {
  recipients: { selected: EmailRecipientPayload[]; suggestions: EmailRecipientPayload[] }
  subject: string
  body: string
  clientNom: string
  numero: string
}

async function buildEmailDefaults(
  id: number,
  variant: 'confirmation' | 'proforma' | 'donation-valeur' = 'confirmation',
): Promise<EmailDefaultsPayload | null> {
  const rows = await query<{ IDclient: number; numero: number | null }>(
    `SELECT IDclient, numero FROM commande_client WHERE IDcommande_client = ${id}`,
  )
  if (rows.length === 0) return null
  const IDclient = Number(rows[0].IDclient) || 0
  const numero = String(rows[0].numero ?? id)

  const [clientNames, contactRows] = await Promise.all([
    resolveClientNames([IDclient]),
    query<{ IDcontact: number; nom: string | null; prenom: string | null; mail: string | null; envoi_commande: number | null; est_visible: number | null }>(
      `SELECT IDcontact, nom, prenom, mail, envoi_commande, est_visible FROM contact WHERE IDclient = ${IDclient}`,
    ),
  ])
  const clientNom = clientNames.get(IDclient) ?? ''
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
    const displayName = [c.prenom, c.nom].map((s: string | null) => (s ?? '').toString().trim()).filter((s: string) => s.length > 0).join(' ')
    const recipient: EmailRecipientPayload = { email: raw, source: 'contact', contactId: Number(c.IDcontact) }
    if (displayName) recipient.name = displayName
    if (c.envoi_commande === 1) selected.push(recipient)
    else suggestions.push(recipient)
  }

  if (variant === 'donation-valeur') {
    const subject = `Calcul de la valeur - Donation N°${numero} - ETS Malterre`
    const body =
      `Bonjour,\n\n` +
      `Veuillez trouver ci-joint le calcul de la valeur des pièces de la donation N°${numero}.\n\n` +
      `Nous restons à votre disposition pour toute information complémentaire.\n\n` +
      `Cordialement,\n` +
      `ETS Malterre`
    return { recipients: { selected, suggestions }, subject, body, clientNom, numero }
  }

  if (variant === 'proforma') {
    const subject = `Facture proforma - Commande N°${numero} - ETS Malterre`
    const body =
      `Bonjour,\n\n` +
      `Veuillez trouver ci-joint notre facture proforma relative à votre commande N°${numero}.\n\n` +
      `Nous restons à votre disposition pour toute information complémentaire.\n\n` +
      `Cordialement,\n` +
      `ETS Malterre`
    return { recipients: { selected, suggestions }, subject, body, clientNom, numero }
  }

  // Order recap in the body itself so key terms are verifiable without
  // opening the PDF. Reuses the PDF data builder so both always agree.
  let recap = ''
  try {
    const pdfData = await buildClientPdfData(id)
    if (pdfData && pdfData.lignes.length > 0) {
      const lines = pdfData.lignes.map((l) => {
        const ref = [l.ref_label, l.colori_reference].filter((s) => s && s.trim()).join(' - ')
        const qty = `${l.quantite.toLocaleString('fr-FR').replace(/[\u202f\u00a0]/g, ' ')} ${l.unite_label}`.trim()
        const liv = l.date_livraison ? ` - expédition ${l.date_livraison}` : ''
        return `  •  ${ref || 'Ligne'} : ${qty}${liv}`
      })
      recap = `Récapitulatif :\n${lines.join('\n')}\n\n`
    }
  } catch (e) {
    // Recap is best-effort — the attached PDF stays the reference document.
    console.error('email-defaults recap build failed:', (e as Error).message)
  }

  const subject = `Confirmation de commande N°${numero} - ETS Malterre`
  const body =
    `Bonjour,\n\n` +
    `Veuillez trouver ci-joint la confirmation de votre commande N°${numero}, accompagnée de nos conditions générales de vente.\n\n` +
    recap +
    `**Nous vous remercions de vérifier attentivement les termes de ce document (références, coloris, quantités, délais) et de nous signaler toute anomalie sous 48 heures. Sans retour de votre part dans ce délai, la commande sera considérée comme acceptée en l'état.**\n\n` +
    `Nous restons à votre disposition pour toute information complémentaire.\n\n` +
    `Cordialement,\n` +
    `ETS Malterre`
  return { recipients: { selected, suggestions }, subject, body, clientNom, numero }
}

commandesClientRouter.get('/:id/email-defaults', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const defaults = await buildEmailDefaults(id)
    if (!defaults) { res.status(404).json({ error: 'Commande not found' }); return }
    res.json(defaults)
  } catch (err) {
    console.error('Error building email defaults:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesClientRouter.get('/:id/proforma/email-defaults', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await requireProformaPermission(req, res))) return
    const defaults = await buildEmailDefaults(id, 'proforma')
    if (!defaults) { res.status(404).json({ error: 'Commande not found' }); return }
    res.json(defaults)
  } catch (err) {
    console.error('Error building proforma email defaults:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesClientRouter.get('/:id/donation-valeur/email-defaults', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const defaults = await buildEmailDefaults(id, 'donation-valeur')
    if (!defaults) { res.status(404).json({ error: 'Commande not found' }); return }
    res.json(defaults)
  } catch (err) {
    console.error('Error building donation valeur email defaults:', err)
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

async function logEnvoiEmails(idTypeDoc: number, idReference: number, recipients: string[], societe: string, notes = ''): Promise<void> {
  if (recipients.length === 0) return
  const ts = nowHfsqlDatetime()
  for (const raw of recipients) {
    const addr = String(raw).trim()
    if (!addr) continue
    try {
      if (IS_WINDOWS) {
        await query(
          `INSERT INTO envoi_email (DATE, adresse, société, IDreference, invalidé, notes, IDtype_doc)
           VALUES ('${ts}', ${sqlText(addr)}, ${sqlText(societe || '')}, ${idReference}, 0, ${sqlText(notes)}, ${idTypeDoc})`,
        )
      } else {
        // Linux bridge can't tokenize accented société/invalidé — omit (HFSQL zero-fills).
        await query(
          `INSERT INTO envoi_email (DATE, adresse, IDreference, notes, IDtype_doc)
           VALUES ('${ts}', ${sqlText(addr)}, ${idReference}, ${sqlText(notes)}, ${idTypeDoc})`,
        )
      }
    } catch (e) {
      console.error(`envoi_email log failed (${idTypeDoc}/${idReference}/${addr}):`, (e as Error).message)
    }
  }
}

commandesClientRouter.post('/:id/email', async (req: Request, res: Response) => {
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
      console.log(`[dev-skip-send] commande_client #${id} — fake send to ${parsed.data.to.join(', ')}`)
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
        const data = await buildClientPdfData(id)
        if (!data) { res.status(404).json({ error: 'Commande not found' }); return }
        const buffer = await renderClientPdfBuffer(data)
        attachments.push({ filename: `confirmation-commande-${data.numero}.pdf`, content: buffer, contentType: 'application/pdf' })
      }
      // CGV ride along on every confirmation email.
      attachments.push({ filename: CGV_ATTACHMENT_FILENAME, content: await getCgvPdf(), contentType: 'application/pdf' })
      for (const a of parsed.data.extra_attachments ?? []) {
        attachments.push({ filename: a.filename, content: Buffer.from(a.content_base64, 'base64'), contentType: a.content_type })
      }
      messageId = await sendMail({
        from: senderEmail, fromName, to: parsed.data.to, cc: parsed.data.cc, bcc: parsed.data.bcc,
        subject: parsed.data.subject, body: parsed.data.body,
        attachments: attachments.length > 0 ? attachments : undefined,
      })
    }

    // Audit: one envoi_email row per recipient with IDtype_doc=7 (commande client).
    const allRecipients = [...parsed.data.to, ...(parsed.data.cc ?? [])]
    let societe = ''
    try {
      const cr = await query<{ IDclient: number }>(`SELECT IDclient FROM commande_client WHERE IDcommande_client = ${id}`)
      const names = await resolveClientNames([Number(cr[0]?.IDclient) || 0])
      societe = names.get(Number(cr[0]?.IDclient) || 0) ?? ''
    } catch { /* informational */ }
    await logEnvoiEmails(TYPE_DOC_COMMANDE_CLIENT, id, allRecipients, societe)

    res.json({ ok: true, messageId })
  } catch (err) {
    console.error('Error sending commande-client email:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    res.status(500).json({ error: 'send_failed', message })
  }
})

// Proforma variant: attaches the on-the-fly proforma PDF, NO CGV (matches
// facturation emails), and logs with notes='proforma' so the historique tab
// can label these sends distinctly. Nothing is written to facturation.
commandesClientRouter.post('/:id/proforma/email', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    if (!(await requireProformaPermission(req, res))) return
    const parsed = emailBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const devSkip = parsed.data.dev_skip_send === true && ALLOW_DEV_SKIP_SEND

    let messageId: string
    if (devSkip) {
      messageId = `dev-skip-${Date.now()}`
      console.log(`[dev-skip-send] commande_client #${id} proforma — fake send to ${parsed.data.to.join(', ')}`)
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
        const data = await buildProformaPdfData(id)
        if (!data) { res.status(404).json({ error: 'Commande not found' }); return }
        const buffer = await renderProformaPdfBuffer(data)
        attachments.push({ filename: `proforma-${data.numero}.pdf`, content: buffer, contentType: 'application/pdf' })
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

    // Audit: same envoi_email ledger as confirmations (IDtype_doc=7) but
    // tagged notes='proforma' — the historique read splits the label on it.
    const allRecipients = [...parsed.data.to, ...(parsed.data.cc ?? [])]
    let societe = ''
    try {
      const cr = await query<{ IDclient: number }>(`SELECT IDclient FROM commande_client WHERE IDcommande_client = ${id}`)
      const names = await resolveClientNames([Number(cr[0]?.IDclient) || 0])
      societe = names.get(Number(cr[0]?.IDclient) || 0) ?? ''
    } catch { /* informational */ }
    await logEnvoiEmails(TYPE_DOC_COMMANDE_CLIENT, id, allRecipients, societe, 'proforma')

    res.json({ ok: true, messageId })
  } catch (err) {
    console.error('Error sending commande-client proforma email:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    res.status(500).json({ error: 'send_failed', message })
  }
})

// Donation "calcul de la valeur" variant: attaches the valuation PDF, no CGV,
// and logs with notes='donation-valeur' so the historique tab labels it.
commandesClientRouter.post('/:id/donation-valeur/email', async (req: Request, res: Response) => {
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
      console.log(`[dev-skip-send] commande_client #${id} donation valeur — fake send to ${parsed.data.to.join(', ')}`)
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
        const data = await loadDonationValeur(id, res)
        if (!data) return
        const buffer = await renderDonationValeurBuffer(data)
        attachments.push({ filename: donationValeurFilename(data.numero), content: buffer, contentType: 'application/pdf' })
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

    const allRecipients = [...parsed.data.to, ...(parsed.data.cc ?? [])]
    let societe = ''
    try {
      const cr = await query<{ IDclient: number }>(`SELECT IDclient FROM commande_client WHERE IDcommande_client = ${id}`)
      const names = await resolveClientNames([Number(cr[0]?.IDclient) || 0])
      societe = names.get(Number(cr[0]?.IDclient) || 0) ?? ''
    } catch { /* informational */ }
    await logEnvoiEmails(TYPE_DOC_COMMANDE_CLIENT, id, allRecipients, societe, DONATION_VALEUR_NOTES)

    res.json({ ok: true, messageId })
  } catch (err) {
    console.error('Error sending donation valeur email:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    res.status(500).json({ error: 'send_failed', message })
  }
})

// ════════════════════════════════════════════════════════
//  HISTORIQUE  (envoi_email timeline for this commande)
// ════════════════════════════════════════════════════════

commandesClientRouter.get('/:id/historique', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    // envoi_email rows keyed on this commande (IDreference = id). société is
    // accented → omit on Linux; read base columns only.
    // adresse is an email (ASCII) so no encoding repair is needed. société is
    // accented → never named. DATE is a reserved word, returned as `DATE`.
    const rows = await query<{ adresse: string | null; DATE: string | null; notes: string | null }>(
      `SELECT adresse, DATE, notes FROM envoi_email WHERE IDreference = ${id} AND IDtype_doc = ${TYPE_DOC_COMMANDE_CLIENT}`,
    )
    // The legacy WinDev app never writes envoi_email for commandes client — it
    // only flips commande_client.envoyé_client. Accented column → SELECT * and
    // resolve the (possibly mangled) key via pickKey.
    const ccRows = await query<Record<string, unknown>>(
      `SELECT * FROM commande_client WHERE IDcommande_client = ${id}`,
    )
    const legacySent = ccRows.length > 0 && Number(pickKey(ccRows[0], /^envoy/i)) === 1
    // Group by send timestamp + document kind (one event, possibly multiple
    // recipients). Every document sent from this screen shares IDtype_doc=7, so
    // `notes` is what distinguishes them: '' = confirmation, 'proforma',
    // 'donation-valeur'.
    const NOTES_LABELS: Record<string, string> = {
      proforma: 'Facture proforma',
      [DONATION_VALEUR_NOTES]: 'Calcul de la valeur',
    }
    const byDate = new Map<string, { DATE: string; notes: string; recipients: string[] }>()
    for (const r of rows as any[]) {
      const dt = (r.DATE ?? '').toString()
      const notes = (r.notes ?? '').toString().trim()
      const key = `${dt}|${notes}`
      const acc = byDate.get(key) ?? { DATE: dt, notes, recipients: [] as string[] }
      const addr = (r.adresse ?? '').toString().trim()
      if (addr) acc.recipients.push(addr)
      byDate.set(key, acc)
    }
    const events: Array<{ kind: 'email' | 'legacy'; type_label: string; recipients: string[]; DATE: string }> =
      Array.from(byDate.values())
        .map((e) => ({
          kind: 'email' as const,
          type_label: NOTES_LABELS[e.notes] ?? 'Confirmation de commande',
          recipients: e.recipients,
          DATE: e.DATE,
        }))
        .sort((a, b) => (a.DATE < b.DATE ? 1 : -1))
    // Legacy flag carries no date/recipient — only surface it when no ETM
    // confirmation send is already in the timeline, appended last (undated).
    const hasConfirmation = events.some((e) => e.type_label === 'Confirmation de commande')
    if (legacySent && !hasConfirmation) {
      events.push({ kind: 'legacy', type_label: 'Confirmation de commande', recipients: [], DATE: '' })
    }
    res.json(events)
  } catch (err) {
    console.error('Error fetching commande-client historique:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  DOCUMENTS  (polymorphic GED — discriminator IDcommande_client = id)
// ════════════════════════════════════════════════════════
//
// Client-commande docs: discriminate on IDcommande_client = id AND
// IDcommande_sous_traitant = 0. Show every doc type attached to the order
// (the discriminator already scopes it); the create dialog offers all visible
// type_doc. type_doc 7 = "commande client" is the canonical bon-de-commande type.

commandesClientRouter.get('/:id/documents', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const rows = await query<{ IDged: number; nom: string | null; commentaire: string | null; IDtype_doc: number }>(
      `SELECT g.IDged, g.nom, g.commentaire, g.IDtype_doc
       FROM ged g
       WHERE g.IDcommande_client = ${id} AND g.IDcommande_sous_traitant = 0
       ORDER BY g.IDged DESC`,
    )
    const fixed = await fixEncoding(rows, 'ged', 'IDged', ['nom', 'commentaire'])
    const typeIds = Array.from(new Set(fixed.map((r) => r.IDtype_doc).filter((t) => t > 0)))
    const typeMap = new Map<number, string>()
    if (typeIds.length > 0) {
      const typeRows = await query<{ IDtype_doc: number; nom: string }>(
        `SELECT IDtype_doc, nom FROM type_doc WHERE IDtype_doc IN (${typeIds.join(',')})`,
      )
      const fixedTypes = await fixEncoding(typeRows, 'type_doc', 'IDtype_doc', ['nom'])
      for (const t of fixedTypes) typeMap.set(t.IDtype_doc, t.nom)
    }
    res.json(fixed.map((r) => ({
      IDged: r.IDged, nom: r.nom, commentaire: r.commentaire,
      IDtype_doc: r.IDtype_doc, type_nom: typeMap.get(r.IDtype_doc) ?? null,
    })))
  } catch (err) {
    console.error('Error listing commande-client documents:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesClientRouter.get('/:id/documents/:idged/fichier', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const idged = parseInt(req.params.idged, 10)
    if (isNaN(id) || isNaN(idged)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const rows = await queryRaw(
      `SELECT fichier FROM ged WHERE IDged = ${idged} AND IDcommande_client = ${id} AND IDcommande_sous_traitant = 0`,
    )
    if (rows.length === 0) { res.status(404).json({ error: 'Document not found' }); return }
    const fichier = (rows[0] as any).fichier
    if (fichier == null) { res.status(404).json({ error: 'No file attached' }); return }
    let buf: Buffer
    if (fichier instanceof ArrayBuffer) buf = Buffer.from(fichier)
    else if (Buffer.isBuffer(fichier)) buf = fichier
    else { res.status(404).json({ error: 'No file attached' }); return }
    if (buf.length === 0 || (buf.length === 1 && buf[0] === 0)) { res.status(404).json({ error: 'No file attached' }); return }
    let contentType = 'application/octet-stream'
    if (buf.length >= 4) {
      const hb = buf.subarray(0, 4)
      if (hb[0] === 0x25 && hb[1] === 0x50 && hb[2] === 0x44 && hb[3] === 0x46) contentType = 'application/pdf'
      else if (hb[0] === 0x89 && hb[1] === 0x50 && hb[2] === 0x4e && hb[3] === 0x47) contentType = 'image/png'
      else if (hb[0] === 0xff && hb[1] === 0xd8) contentType = 'image/jpeg'
    }
    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Disposition', 'inline')
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.end(buf)
  } catch (err) {
    console.error('Error serving commande-client document:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesClientRouter.post('/:id/documents', upload.single('fichier'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const cf = await query(`SELECT IDcommande_client FROM commande_client WHERE IDcommande_client = ${id}`)
    if (cf.length === 0) { res.status(404).json({ error: 'Commande not found' }); return }
    const nom = (req.body.nom ?? '').toString()
    const commentaire = (req.body.commentaire ?? '').toString()
    const idTypeDoc = parseInt(req.body.IDtype_doc, 10) || TYPE_DOC_COMMANDE_CLIENT
    await query(
      `INSERT INTO ged (nom, commentaire, IDtype_doc, IDreference, IDcommande_client, IDcommande_sous_traitant, IDdossier)
       VALUES (${sqlText(nom)}, ${sqlText(commentaire)}, ${idTypeDoc}, ${id}, ${id}, 0, 0)`,
    )
    const newRows = await query<{ IDged: number }>(
      `SELECT IDged FROM ged WHERE IDcommande_client = ${id} AND IDcommande_sous_traitant = 0 AND IDtype_doc = ${idTypeDoc} ORDER BY IDged DESC`,
    )
    if (newRows.length === 0) { res.status(500).json({ error: 'Insert lookup failed' }); return }
    const newId = newRows[0].IDged
    if (req.file && req.file.buffer.length > 0) {
      await queryRaw(`UPDATE ged SET fichier = x'${req.file.buffer.toString('hex')}' WHERE IDged = ${newId}`)
    }
    res.status(201).json({ IDged: newId })
  } catch (err) {
    console.error('Error creating commande-client document:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesClientRouter.put('/:id/documents/:idged', upload.single('fichier'), async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const idged = parseInt(req.params.idged, 10)
    if (isNaN(id) || isNaN(idged)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const scope = await query(`SELECT IDged FROM ged WHERE IDged = ${idged} AND IDcommande_client = ${id} AND IDcommande_sous_traitant = 0`)
    if (scope.length === 0) { res.status(404).json({ error: 'Document not found' }); return }
    const sets: string[] = []
    if (req.body.nom !== undefined) sets.push(`nom = ${sqlText(String(req.body.nom))}`)
    if (req.body.commentaire !== undefined) sets.push(`commentaire = ${sqlText(String(req.body.commentaire))}`)
    if (req.body.IDtype_doc !== undefined) sets.push(`IDtype_doc = ${parseInt(req.body.IDtype_doc, 10) || 0}`)
    if (sets.length > 0) await query(`UPDATE ged SET ${sets.join(', ')} WHERE IDged = ${idged}`)
    if (req.file && req.file.buffer.length > 0) {
      await queryRaw(`UPDATE ged SET fichier = x'${req.file.buffer.toString('hex')}' WHERE IDged = ${idged}`)
    } else if (req.body.remove_fichier === '1') {
      await query(`UPDATE ged SET fichier = NULL WHERE IDged = ${idged}`)
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating commande-client document:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesClientRouter.delete('/:id/documents/:idged', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const idged = parseInt(req.params.idged, 10)
    if (isNaN(id) || isNaN(idged)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const scope = await query(`SELECT IDged FROM ged WHERE IDged = ${idged} AND IDcommande_client = ${id} AND IDcommande_sous_traitant = 0`)
    if (scope.length === 0) { res.status(404).json({ error: 'Document not found' }); return }
    await query(`DELETE FROM ged WHERE IDged = ${idged}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting commande-client document:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Factures liées (auto-discovered, shown in the Docs tab) ──
//
// The facturation ledger carries no usable direct commande FK
// (facture.IDcommande_client is always 0 — verified live 2026-07); the
// reliable link is commande → expedition.IDcommande_client →
// ligne_expedition → ligne_facture(_prov).IDligne_expedition. Returns the
// definitive factures / avoirs plus still-open facturation proformas covering
// this commande's shipments. Legacy ligne_facture rows predating the
// IDligne_expedition link simply won't be found — the Docs tab only shows the
// invoice "when it can be found".
commandesClientRouter.get('/:id/factures', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const chunk500 = <T,>(arr: T[]): T[][] => {
      const out: T[][] = []
      for (let i = 0; i < arr.length; i += 500) out.push(arr.slice(i, i + 500))
      return out
    }

    const expRows = await query<{ IDexpedition: number }>(
      `SELECT IDexpedition FROM expedition WHERE IDcommande_client = ${id}`,
    )
    const expIds = expRows.map((r) => Number(r.IDexpedition)).filter((x) => x > 0)
    if (expIds.length === 0) { res.json([]); return }

    const leIds: number[] = []
    for (const chunk of chunk500(expIds)) {
      const rows = await query<{ IDligne_expedition: number }>(
        `SELECT IDligne_expedition FROM ligne_expedition WHERE IDexpedition IN (${chunk.join(',')})`,
      )
      for (const r of rows) { const v = Number(r.IDligne_expedition); if (v > 0) leIds.push(v) }
    }
    if (leIds.length === 0) { res.json([]); return }

    const defIds = new Set<number>()
    const provIds = new Set<number>()
    for (const chunk of chunk500(leIds)) {
      const defRows = await query<{ IDfacture: number }>(
        `SELECT IDfacture FROM ligne_facture WHERE IDligne_expedition IN (${chunk.join(',')})`,
      )
      for (const r of defRows) { const v = Number(r.IDfacture); if (v > 0) defIds.add(v) }
      const provRows = await query<{ IDfacture_prov: number }>(
        `SELECT IDfacture_prov FROM ligne_facture_prov WHERE IDligne_expedition IN (${chunk.join(',')})`,
      )
      for (const r of provRows) { const v = Number(r.IDfacture_prov); if (v > 0) provIds.add(v) }
    }

    // DATE / TYPE are reserved words — select them uppercase (same trick as
    // factures.ts). Display numero convention: definitive shows its numero
    // column, proforma shows its PK (facture_prov.numero is vestigial).
    const out: Array<{ kind: 'def' | 'prov'; id: number; numero: number | null; date: string | null; type: number }> = []
    for (const chunk of chunk500(Array.from(defIds))) {
      const rows = await query<any>(
        `SELECT IDfacture, numero, DATE, TYPE FROM facture WHERE IDfacture IN (${chunk.join(',')})`,
      )
      for (const r of rows) {
        out.push({
          kind: 'def',
          id: Number(r.IDfacture),
          numero: r.numero != null ? Number(r.numero) : null,
          date: r.DATE != null ? String(r.DATE) : null,
          type: Number(r.TYPE) || 1,
        })
      }
    }
    for (const chunk of chunk500(Array.from(provIds))) {
      const rows = await query<any>(
        `SELECT IDfacture_prov, DATE, TYPE FROM facture_prov WHERE IDfacture_prov IN (${chunk.join(',')})`,
      )
      for (const r of rows) {
        out.push({
          kind: 'prov',
          id: Number(r.IDfacture_prov),
          numero: Number(r.IDfacture_prov),
          date: r.DATE != null ? String(r.DATE) : null,
          type: Number(r.TYPE) || 1,
        })
      }
    }
    // Definitive first, then proformas; newest first within each group.
    out.sort((a, b) => (a.kind === b.kind ? b.id - a.id : a.kind === 'def' ? -1 : 1))
    res.json(out)
  } catch (err) {
    console.error('Error listing commande-client factures:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesClientRouter.get('/lookups/type-doc', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDtype_doc: number; nom: string | null }>(
      `SELECT IDtype_doc, nom FROM type_doc ORDER BY nom`,
    )
    const fixed = await fixEncoding(rows, 'type_doc', 'IDtype_doc', ['nom'])
    res.json(fixed.map((r) => ({ IDtype_doc: Number(r.IDtype_doc), nom: r.nom ?? '' })))
  } catch (err) {
    console.error('Error listing client type-doc:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Keep `addWorkingDays` import referenced for future relance use.
void addWorkingDays
