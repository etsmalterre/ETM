// Commandes client TRM — the Tricotage Malterre client ledger.
//
// Same physical tables as commandes-client.ts (commande_client /
// ligne_commande_client) but the OTHER partition: every read and write here is
// `IDsociete = 2`. The two routes are deliberately separate rather than one
// parameterised route — the screens they serve have almost nothing in common
// beyond the header. ETM sells finished/écru goods and reserves rolls; TRM
// KNITS, so its order lines are followed through production (ordre_fabrication)
// and the pieces its own machines drop (stock_ecru.IDLigne_Commande_TRM).
//
// ── The mirror rule (the single most important thing in this file) ──
// 93 % of TRM orders are mirrors of an ETM sous-traitant order: they carry
// `IDcommande_ETM > 0` and their header + lines are written by
// commandes-sous-traitant.ts, which keeps them in sync from the ETM side.
// Those rows are READ-ONLY here. Editing them from TRM would silently diverge
// from the ETM commande that owns them (there is no reverse sync), so every
// write path calls `refuseIfMirror` first. Native TRM orders
// (`IDcommande_ETM = 0`) are fully editable.
//
// Hard rules baked in (same HFSQL footguns as the ETM route):
//  - numero allocator: MAX(numero)+1 WHERE IDsociete = 2, with a retry loop.
//  - Accented commande_client columns (archivé/expedié/envoyé_client) and ligne
//    columns (delai_annoncé/déverrouiller) are NEVER named in SQL — the Linux
//    iODBC bridge cannot tokenize accented identifiers. SELECT * + prune on
//    reads; omit on writes (HFSQL zero-fills).
//  - `SELECT * FROM client` returns 0 rows on this driver — explicit columns.
//  - `SELECT * FROM stock_fil` likewise (accented `terminé`) — explicit columns.
//  - ligne_commande_client.TYPE is a reserved word (alias `TYPE AS type_kind`,
//    write it uppercase) and the coloris column is lowercase `IDcolori`.
//  - TRM lines are always type 1 (écru): TRM knits tombé de métier, nothing else.
//
// ── Where each panel of the legacy window gets its data ──
//  Affectation        stock_ecru WHERE IDLigne_Commande_TRM = <ligne>
//                     (shipped ⇔ IDligne_expedition_TRM > 0)
//  Stock de fil       composition_ecru → stock_fil lots of those yarns
//  Ordre de fabrication  ordre_fabrication WHERE IDligne_commande_client = <ligne>
//                     réalisé = Σ stock_ecru.poids for the OF; the footer's
//                     "Compatible sur" list is ref_ecru_machine → machine.nom
//  Expédition         expedition (IDsociete = 2) → ligne_expedition → the rolls
//                     stamped with that IDligne_expedition_TRM

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { stripRtf } from '../lib/rtf-utils.js'
import { esc, n, dateDigits as dateStr, IS_WINDOWS } from '../lib/sst-shared.js'
import { prixDeRevientTRM, prixDeRevientTRMDetail } from '../lib/pricing-trm.js'
import { trmUserHasPermission } from '../lib/permissions-trm.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { fetchDefectsByEcru, type DefautQualite } from './stock-ecru.js'
import { CommandeClientPdf, type CommandeClientPdfData } from '../lib/pdf/CommandeClientPdf.js'
import { companyTrm } from '../lib/pdf/theme.js'
import { loadClientTvaRate } from '../lib/tva.js'
import { formatHfsqlDateLongFr, logEnvoiEmails, type EmailRecipientPayload } from './expeditions.js'
import { TYPE_DOC_COMMANDE_CLIENT } from './commandes-client.js'
import { sendMail } from '../lib/gmail.js'
import { getUserEmail } from '../lib/user-emails.js'

export const commandesTrmRouter: RouterType = Router()

/** The Tricotage Malterre partition of the shared tables. */
const TRM_SOCIETE = 2

// ── Small SQL/format helpers (same contract as commandes-client.ts) ──

/** SQL literal for a user-supplied text value. Pure ASCII → quoted literal;
 *  anything accented → Latin-1 hex literal (the Linux iODBC bridge corrupts
 *  raw multi-byte UTF-8 embedded in a SQL line). */
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

/** Normalise for accent-insensitive contains-matching (search). */
function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

function todayHfsql(): string {
  const t = new Date()
  return `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}`
}

function round2(x: number): number {
  return Math.round((Number(x) || 0) * 100) / 100
}

// ── Phase model ──────────────────────────────────────────
// TRM's phases follow PRODUCTION, not reservation (that's the ETM screen's
// axis). A line is satisfied by the pieces its OFs actually dropped:
//   terminee   — est_soldee = 1
//   en_prod    — open AND at least one ordre_fabrication exists
//   a_lancer   — open AND no OF yet (nothing has been scheduled on a machine)

export type TrmPhase = 'a_lancer' | 'en_prod' | 'terminee'

/** Commande ids that have at least one ordre_fabrication on any of their lines. */
async function ordersWithOFs(commandeIds: number[]): Promise<Set<number>> {
  const out = new Set<number>()
  const ids = commandeIds.filter((x) => x > 0)
  if (ids.length === 0) return out
  const lineRows = await query<{ IDligne_commande_client: number; IDcommande_client: number }>(
    `SELECT IDligne_commande_client, IDcommande_client FROM ligne_commande_client
     WHERE IDcommande_client IN (${ids.join(',')})`,
  )
  const cmdByLine = new Map<number, number>()
  for (const r of lineRows) cmdByLine.set(Number(r.IDligne_commande_client), Number(r.IDcommande_client))
  const lineIds = Array.from(cmdByLine.keys()).filter((x) => x > 0)
  if (lineIds.length === 0) return out
  const ofs = await query<{ IDligne_commande_client: number }>(
    `SELECT DISTINCT IDligne_commande_client FROM ordre_fabrication
     WHERE IDligne_commande_client IN (${lineIds.join(',')})`,
  )
  for (const r of ofs) {
    const cmd = cmdByLine.get(Number(r.IDligne_commande_client))
    if (cmd && cmd > 0) out.add(cmd)
  }
  return out
}

async function computePhasesBatch(
  orders: Array<{ id: number; est_soldee: number }>,
): Promise<Map<number, TrmPhase>> {
  const out = new Map<number, TrmPhase>()
  const openIds = orders.filter((o) => o.est_soldee !== 1).map((o) => o.id)
  const withOFs = await ordersWithOFs(openIds)
  for (const o of orders) {
    if (o.est_soldee === 1) out.set(o.id, 'terminee')
    else out.set(o.id, withOFs.has(o.id) ? 'en_prod' : 'a_lancer')
  }
  return out
}

// ── Lookups shared by list + detail ──────────────────────

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

interface EcruRefInfo {
  reference: string
  designation: string
  contexture: string
  prix: number
  poids_piece: number
}

/** Batch-resolve ref_ecru display info + its contexture label ("jersey", …),
 *  which the legacy line card prints under the reference. */
async function resolveEcruRefs(refIds: number[]): Promise<Map<number, EcruRefInfo>> {
  const out = new Map<number, EcruRefInfo>()
  const ids = Array.from(new Set(refIds.filter((x) => x > 0)))
  if (ids.length === 0) return out
  const rows = await query<{
    IDref_ecru: number; reference: string | null; designation: string | null
    IDcontexture: number | null; prix: number | null; poids: number | null
  }>(
    `SELECT IDref_ecru, reference, designation, IDcontexture, prix, poids
     FROM ref_ecru WHERE IDref_ecru IN (${ids.join(',')})`,
  )
  const fixed = await fixEncoding(rows, 'ref_ecru', 'IDref_ecru', ['reference', 'designation'])
  const ctxIds = Array.from(new Set(fixed.map((r) => Number(r.IDcontexture) || 0).filter((x) => x > 0)))
  const ctxNames = new Map<number, string>()
  if (ctxIds.length > 0) {
    const c = await query<{ IDcontexture: number; nom: string | null }>(
      `SELECT IDcontexture, nom FROM contexture WHERE IDcontexture IN (${ctxIds.join(',')})`,
    )
    for (const row of await fixEncoding(c, 'contexture', 'IDcontexture', ['nom'])) {
      ctxNames.set(Number(row.IDcontexture), (row.nom ?? '').toString().trim())
    }
  }
  for (const r of fixed as any[]) {
    out.set(Number(r.IDref_ecru), {
      reference: (r.reference ?? '').toString().trim(),
      designation: (r.designation ?? '').toString().trim(),
      contexture: ctxNames.get(Number(r.IDcontexture) || 0) ?? '',
      prix: Number(r.prix) || 0,
      poids_piece: Number(r.poids) || 0,
    })
  }
  return out
}

async function resolveColorisEcru(coloriIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const ids = Array.from(new Set(coloriIds.filter((x) => x > 0)))
  if (ids.length === 0) return out
  const rows = await query<{ IDcolori_ecru: number; reference: string | null }>(
    `SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDcolori_ecru IN (${ids.join(',')})`,
  )
  for (const r of await fixEncoding(rows, 'colori_ecru', 'IDcolori_ecru', ['reference'])) {
    out.set(Number(r.IDcolori_ecru), (r.reference ?? '').toString().trim())
  }
  return out
}

// ── Per-line production aggregates ───────────────────────
// Everything the machines dropped for a line, and how much of it left.
// `produit` is what the legacy header prints left of the slash
// ("84.50 / 300 Kgs"); `expedie` is the line card's Expédié column.

interface LineProduction { nb_pieces: number; produit: number; expedie: number }

async function lineProductionAggregates(lineIds: number[]): Promise<Map<number, LineProduction>> {
  const out = new Map<number, LineProduction>()
  const ids = lineIds.filter((x) => x > 0)
  if (ids.length === 0) return out
  for (const id of ids) out.set(id, { nb_pieces: 0, produit: 0, expedie: 0 })
  const rows = await query<{ IDLigne_Commande_TRM: number; poids: number | null; IDligne_expedition_TRM: number | null }>(
    `SELECT IDLigne_Commande_TRM, poids, IDligne_expedition_TRM FROM stock_ecru
     WHERE IDLigne_Commande_TRM IN (${ids.join(',')})`,
  )
  for (const r of rows) {
    const acc = out.get(Number(r.IDLigne_Commande_TRM))
    if (!acc) continue
    const kg = Number(r.poids) || 0
    acc.nb_pieces += 1
    acc.produit += kg
    if ((Number(r.IDligne_expedition_TRM) || 0) > 0) acc.expedie += kg
  }
  for (const acc of out.values()) {
    acc.produit = round2(acc.produit)
    acc.expedie = round2(acc.expedie)
  }
  return out
}

// ── Write guards ─────────────────────────────────────────

interface CommandeGuardInfo { est_soldee: number; IDcommande_ETM: number }

async function loadCommandeGuard(commandeId: number): Promise<CommandeGuardInfo | null> {
  const rows = await query<{ est_soldee: number | null; IDcommande_ETM: number | null; IDsociete: number | null }>(
    `SELECT est_soldee, IDcommande_ETM, IDsociete FROM commande_client
     WHERE IDcommande_client = ${commandeId}`,
  )
  if (rows.length === 0) return null
  // A wrong-partition id is "not found" as far as this route is concerned —
  // never let a TRM endpoint mutate an ETM order that happens to share an id space.
  if (Number(rows[0].IDsociete) !== TRM_SOCIETE) return null
  return {
    est_soldee: Number(rows[0].est_soldee) || 0,
    IDcommande_ETM: Number(rows[0].IDcommande_ETM) || 0,
  }
}

async function loadCommandeIdForLine(lineId: number): Promise<number | null> {
  const rows = await query<{ IDcommande_client: number }>(
    `SELECT IDcommande_client FROM ligne_commande_client WHERE IDligne_commande_client = ${lineId}`,
  )
  if (rows.length === 0) return null
  return Number(rows[0].IDcommande_client) || null
}

/** The mirror gate. ETM owns mirrored orders; TRM must not write them. */
function refuseIfMirror(res: Response, g: CommandeGuardInfo): boolean {
  if (g.IDcommande_ETM > 0) {
    res.status(409).json({
      error: 'commande_miroir_etm',
      message:
        'Commande pilotée par ETM — modifiez-la depuis la commande sous-traitant correspondante.',
    })
    return true
  }
  return false
}

function refuseIfSoldee(res: Response, g: CommandeGuardInfo): boolean {
  if (g.est_soldee === 1) {
    res.status(409).json({
      error: 'commande_soldee',
      message: 'Commande soldée — rouvrez la commande pour la modifier.',
    })
    return true
  }
  return false
}

/** Resolve + guard a write on a commande. Sends its own error response and
 *  returns null when the caller must stop. `allowSoldee` is for the état
 *  toggle, which is precisely how a soldée order gets reopened. */
async function guardWrite(
  res: Response,
  commandeId: number,
  opts: { allowSoldee?: boolean } = {},
): Promise<CommandeGuardInfo | null> {
  const g = await loadCommandeGuard(commandeId)
  if (!g) { res.status(404).json({ error: 'Commande not found' }); return null }
  if (refuseIfMirror(res, g)) return null
  if (!opts.allowSoldee && refuseIfSoldee(res, g)) return null
  return g
}

/** Next numero for the TRM ledger. Legacy data has gaps, so MAX+1 matches the
 *  legacy allocator; concurrent POSTs retry on collision. */
async function nextTrmNumero(): Promise<number> {
  const r = await query<{ m: number | null }>(
    `SELECT MAX(numero) AS m FROM commande_client WHERE IDsociete = ${TRM_SOCIETE}`,
  )
  return (Number(r[0]?.m) || 0) + 1
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
})

const ligneBody = z.object({
  IDreference: z.number().int().nonnegative().optional(),
  IDcolori: z.number().int().nonnegative().optional(),
  quantite: z.number().optional(),
  prix: z.number().optional(),
  date_livraison: z.string().optional(),
  commentaire: z.string().optional(),
})

// ════════════════════════════════════════════════════════
//  LOOKUPS  (literal paths — must register before /:id)
// ════════════════════════════════════════════════════════

// Clients of the TRM ledger. `client` is partitioned by IDsociete exactly like
// commande_client, so this must NOT reuse the ETM lookup.
commandesTrmRouter.get('/lookups/clients', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDclient: number; nom: string | null; IDmode_paiement: number | null; IDecheance: number | null }>(
      `SELECT IDclient, nom, IDmode_paiement, IDecheance FROM client
       WHERE est_visible = 1 AND IDsociete = ${TRM_SOCIETE} ORDER BY nom`,
    )
    const fixed = await fixEncoding(rows, 'client', 'IDclient', ['nom'])
    res.json(fixed.map((r) => ({
      IDclient: Number(r.IDclient),
      nom: (r.nom ?? '').toString(),
      IDmode_paiement: Number(r.IDmode_paiement) || 0,
      IDecheance: Number(r.IDecheance) || 0,
    })))
  } catch (err) {
    console.error('Error fetching TRM clients lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesTrmRouter.get('/lookups/adresses', async (req: Request, res: Response) => {
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
    res.json(await fixEncoding(rows, 'adresse', 'IDadresse', [
      'nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays',
    ]))
  } catch (err) {
    console.error('Error fetching TRM adresses lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// mode_paiement / echeance are global reference tables — not partitioned by
// société, so these are byte-identical to the ETM route's versions.
commandesTrmRouter.get('/lookups/modes-paiement', async (_req: Request, res: Response) => {
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

commandesTrmRouter.get('/lookups/echeances', async (_req: Request, res: Response) => {
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

// Écru catalogue for the line dialog. `archivé` is accented and can never be
// named in SQL — SELECT the explicit columns and let the picker show everything
// (matching the legacy combo, which is also unfiltered).
commandesTrmRouter.get('/lookups/refs-ecru', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDref_ecru: number; reference: string | null; designation: string | null; prix: number | null }>(
      `SELECT IDref_ecru, reference, designation, prix FROM ref_ecru ORDER BY reference`,
    )
    const fixed = await fixEncoding(rows, 'ref_ecru', 'IDref_ecru', ['reference', 'designation'])
    res.json(fixed.map((r) => ({
      IDref_ecru: Number(r.IDref_ecru),
      reference: r.reference ?? '',
      designation: r.designation ?? '',
      prix: Number(r.prix) || 0,
    })))
  } catch (err) {
    console.error('Error fetching TRM refs-ecru lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesTrmRouter.get('/lookups/colori-ecru', async (req: Request, res: Response) => {
  try {
    const refEcru = parseInt(String(req.query.ref_ecru ?? ''), 10)
    // colori_ecru fails on SELECT * — explicit columns only.
    const where = !isNaN(refEcru) && refEcru > 0 ? `WHERE IDref_ecru = ${refEcru}` : ''
    const rows = await query<{ IDcolori_ecru: number; reference: string | null }>(
      `SELECT IDcolori_ecru, reference FROM colori_ecru ${where} ORDER BY reference`,
    )
    const fixed = await fixEncoding(rows, 'colori_ecru', 'IDcolori_ecru', ['reference'])
    res.json(fixed.map((r) => ({ IDcolori_ecru: Number(r.IDcolori_ecru), reference: r.reference ?? '' })))
  } catch (err) {
    console.error('Error fetching TRM colori-ecru lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** Suggested price for a line being entered — `max(PrixDeRevientTRM,
 *  ref_ecru.prix) / 0.7`, the `'cost-floor'` rule. `ref_ecru.prix` is the safe
 *  base: whichever of the base and the computed cost of revient is the higher
 *  assiette gets TRM's 30 % margin, so a native client order never goes out
 *  below base + 30 % (user decision, 2026-08-26).
 *
 *  ⚠️ This is NOT `trmLinePrix`, which stays on the legacy `'price-floor'`
 *  rule (`max(cost / 0.7, base)`) because it prices the ETM → TRM
 *  sous-traitance lines and must keep matching the WinDev app that still
 *  writes them — the two rules differ by ~+39 % in value on recent lines. Do
 *  not "unify" them without deciding the intercompany transfer price too.
 *
 *  The legacy TRM client-order window suggested neither: its COMBO_Reference
 *  event reads `ref_ecru.prix` and stops there, which is why it proposes a
 *  visibly lower number than this screen.
 *
 *  `cout` and `base` ride along so the form can say where the price came from
 *  rather than showing a bare figure. Never throws; an unpriceable ref comes
 *  back priceable=false and the form falls back to manual entry. */
commandesTrmRouter.get('/lookups/line-price', async (req: Request, res: Response) => {
  const empty = { priceable: false, prix: 0, cout: 0, base: 0, retenu: 'revient' as const }
  try {
    const refId = parseInt(String(req.query.ref ?? ''), 10) || 0
    const quantite = Number(req.query.quantite ?? 0) || 0
    if (refId <= 0 || quantite <= 0) { res.json(empty); return }
    const d = await prixDeRevientTRMDetail(refId, quantite, 'cost-floor')
    res.json({
      priceable: d.retainedPrice > 0,
      prix: d.retainedPrice,
      cout: round2(d.costPerKg),
      base: round2(d.floor),
      retenu: d.retainedFrom,
    })
  } catch (err) {
    console.error('Error computing TRM line price:', err)
    res.json(empty)
  }
})

// ════════════════════════════════════════════════════════
//  LIST
// ════════════════════════════════════════════════════════

/** TRM commandes carrying a line whose écru reference matches `q`. Two steps
 *  (LIKE over ref_ecru, then IN over the lines) because the line table only
 *  stores IDreference. Skipped for non-ASCII input — a raw accented literal
 *  corrupts the Linux bridge, and écru references are ASCII codes anyway. */
async function findCommandeIdsByRefLabel(q: string): Promise<number[]> {
  if (!/^[\x20-\x7E]+$/.test(q)) return []
  const refs = await query<{ IDref_ecru: number }>(
    `SELECT TOP 500 IDref_ecru FROM ref_ecru WHERE reference LIKE '%${esc(q)}%'`,
  )
  const refIds = Array.from(new Set(refs.map((r) => Number(r.IDref_ecru) || 0).filter((x) => x > 0)))
  if (refIds.length === 0) return []
  const lignes = await query<{ IDcommande_client: number }>(
    `SELECT IDcommande_client FROM ligne_commande_client
     WHERE TYPE = 1 AND IDreference IN (${refIds.join(',')})`,
  )
  return Array.from(new Set(lignes.map((l) => Number(l.IDcommande_client) || 0).filter((x) => x > 0)))
    .sort((a, b) => b - a)
    .slice(0, 500)
}

commandesTrmRouter.get('/', async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q ?? '').trim()
    const statusFilter = String(req.query.status ?? 'all')
    const limitRaw = parseInt(String(req.query.limit ?? ''), 10)
    const limit = isNaN(limitRaw) ? 100 : Math.min(Math.max(limitRaw, 1), 500)

    const whereParts: string[] = [`cc.IDsociete = ${TRM_SOCIETE}`]
    if (statusFilter === 'terminee') whereParts.push('cc.est_soldee = 1')
    else if (statusFilter === 'open') whereParts.push('cc.est_soldee = 0')

    // Search: numero exact (digits) OR client-name contains OR écru reference OR
    // the ref_client free text (which on mirrors reads "commande 8974, 128" —
    // the way the office actually looks an order up).
    if (q.length > 0) {
      const orParts: string[] = []
      if (/^\d+$/.test(q)) orParts.push(`cc.numero = ${parseInt(q, 10)}`)
      const [clientRows, refCommandeIds] = await Promise.all([
        query<{ IDclient: number; nom: string | null }>(
          `SELECT IDclient, nom FROM client WHERE est_visible = 1 AND IDsociete = ${TRM_SOCIETE}`,
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
      if (refCommandeIds.length > 0) orParts.push(`cc.IDcommande_client IN (${refCommandeIds.join(',')})`)
      if (/^[\x20-\x7E]+$/.test(q)) orParts.push(`cc.ref_client LIKE '%${esc(q)}%'`)
      if (orParts.length === 0) { res.json([]); return }
      whereParts.push(`(${orParts.join(' OR ')})`)
    }

    const commandes = await query<any>(
      `SELECT TOP ${limit} cc.IDcommande_client, cc.IDclient, cc.numero, cc.date_commande,
              cc.est_soldee, cc.IDcommande_ETM, cc.ref_client
       FROM commande_client cc
       WHERE ${whereParts.join(' AND ')}
       ORDER BY cc.IDcommande_client DESC`,
    )
    const fixedCommandes = await fixEncoding(commandes, 'commande_client', 'IDcommande_client', ['ref_client'])

    const ids = fixedCommandes.map((c: any) => Number(c.IDcommande_client)).filter(Boolean)
    const [clientNames, phaseMap] = await Promise.all([
      resolveClientNames(fixedCommandes.map((c: any) => Number(c.IDclient))),
      computePhasesBatch(fixedCommandes.map((c: any) => ({
        id: Number(c.IDcommande_client),
        est_soldee: Number(c.est_soldee) || 0,
      }))),
    ])

    // Line aggregates + the production gauge, in two flat passes.
    const totalsMap = new Map<number, {
      total_eur: number; total_qte: number; nb_lignes: number
      earliest_delivery: string | null; produit: number
    }>()
    if (ids.length > 0) {
      const lignes = await query<any>(
        `SELECT IDligne_commande_client, IDcommande_client, quantite, prix, date_livraison
         FROM ligne_commande_client WHERE IDcommande_client IN (${ids.join(',')})`,
      )
      const prodMap = await lineProductionAggregates(
        lignes.map((l: any) => Number(l.IDligne_commande_client) || 0),
      )
      for (const l of lignes) {
        const id = Number(l.IDcommande_client)
        const acc = totalsMap.get(id) ?? { total_eur: 0, total_qte: 0, nb_lignes: 0, earliest_delivery: null, produit: 0 }
        const qty = Number(l.quantite) || 0
        acc.total_qte += qty
        acc.total_eur += qty * (Number(l.prix) || 0)
        acc.nb_lignes += 1
        acc.produit += prodMap.get(Number(l.IDligne_commande_client))?.produit ?? 0
        const dl = typeof l.date_livraison === 'string' ? l.date_livraison : ''
        if (/^\d{8}$/.test(dl) && (acc.earliest_delivery === null || dl < acc.earliest_delivery)) {
          acc.earliest_delivery = dl
        }
        totalsMap.set(id, acc)
      }
    }

    res.json(fixedCommandes.map((c: any) => {
      const cid = Number(c.IDcommande_client)
      const t = totalsMap.get(cid) ?? { total_eur: 0, total_qte: 0, nb_lignes: 0, earliest_delivery: null, produit: 0 }
      return {
        IDcommande_client: cid,
        IDclient: Number(c.IDclient) || 0,
        numero: c.numero != null ? Number(c.numero) : null,
        date_commande: c.date_commande ?? null,
        ref_client: (c.ref_client ?? '') || null,
        est_soldee: Number(c.est_soldee) || 0,
        // Drives the read-only lock badge on the card + detail header.
        is_mirror: (Number(c.IDcommande_ETM) || 0) > 0,
        IDcommande_ETM: Number(c.IDcommande_ETM) || 0,
        client_nom: clientNames.get(Number(c.IDclient)) ?? '',
        phase: phaseMap.get(cid) ?? 'a_lancer',
        total_eur: round2(t.total_eur),
        total_qte: round2(t.total_qte),
        produit: round2(t.produit),
        nb_lignes: t.nb_lignes,
        earliest_delivery: t.earliest_delivery,
      }
    }))
  } catch (err) {
    console.error('Error fetching commandes-trm:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  DETAIL
// ════════════════════════════════════════════════════════

commandesTrmRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    // SELECT * is safe on commande_client (unlike client / stock_fil); the
    // accented keys come back mangled and are simply never read.
    const rows = await query<any>(`SELECT * FROM commande_client WHERE IDcommande_client = ${id}`)
    if (rows.length === 0) { res.status(404).json({ error: 'Commande not found' }); return }
    if (Number(rows[0].IDsociete) !== TRM_SOCIETE) {
      res.status(404).json({ error: 'Commande not found' }); return
    }
    const fixedHeader = await fixEncoding(rows, 'commande_client', 'IDcommande_client',
      ['ref_client', 'commentaire', 'commentaire_interne'])
    const h = fixedHeader[0] as any
    h.commentaire = stripRtf(h.commentaire) || null
    h.commentaire_interne = stripRtf(h.commentaire_interne) || null

    const IDclient = Number(h.IDclient) || 0
    const [clientNames, ficheRows, adrLivRows, adrFacRows, lignesRaw] = await Promise.all([
      resolveClientNames([IDclient]),
      IDclient > 0
        ? query<any>(`SELECT IDclient, commentaire FROM client WHERE IDclient = ${IDclient}`)
        : Promise.resolve([]),
      h.IDadresse_livraison
        ? query(`SELECT IDadresse, nom, adresse1, adresse2, adresse3, cp, ville, pays FROM adresse WHERE IDadresse = ${n(h.IDadresse_livraison)}`)
        : Promise.resolve([]),
      h.IDadresse_facturation
        ? query(`SELECT IDadresse, nom, adresse1, adresse2, adresse3, cp, ville, pays FROM adresse WHERE IDadresse = ${n(h.IDadresse_facturation)}`)
        : Promise.resolve([]),
      // TYPE is reserved → alias. IDcolori is lowercase. Accented ligne columns
      // (delai_annoncé / déverrouiller) are never named.
      query<any>(
        `SELECT IDligne_commande_client, IDcommande_client, TYPE AS type_kind,
                IDreference, IDcolori, quantite, unite, prix, poids,
                date_livraison, commentaire, IDligne_commande_ETM
         FROM ligne_commande_client
         WHERE IDcommande_client = ${id}
         ORDER BY IDligne_commande_client`,
      ),
    ])

    const adrFields = ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays']
    const adrLiv = (await fixEncoding(adrLivRows, 'adresse', 'IDadresse', adrFields))[0] ?? null
    const adrFac = (await fixEncoding(adrFacRows, 'adresse', 'IDadresse', adrFields))[0] ?? null
    const ficheFixed = (await fixEncoding(ficheRows, 'client', 'IDclient', ['commentaire']))[0] as any
    const clientFiche = (stripRtf(ficheFixed?.commentaire) || '').trim() || null

    const lignesFixed = (await fixEncoding(
      lignesRaw, 'ligne_commande_client', 'IDligne_commande_client', ['commentaire'],
    )) as any[]
    for (const l of lignesFixed) l.commentaire = stripRtf(l.commentaire) || null

    const [refMap, coloriMap, prodMap] = await Promise.all([
      resolveEcruRefs(lignesFixed.map((l) => Number(l.IDreference) || 0)),
      resolveColorisEcru(lignesFixed.map((l) => Number(l.IDcolori) || 0)),
      lineProductionAggregates(lignesFixed.map((l) => Number(l.IDligne_commande_client) || 0)),
    ])

    // Marge — the legacy line card's "37 %" chip: how much of the sale price is
    // left once TRM's own cost of knitting this weight is paid. Computed per
    // line because PrixDeRevientTRM amortises one-off operations over the
    // ordered weight, so the same ref costs differently at 60 kg and 600 kg.
    // Best-effort: a ref with no machine sheet just yields marge_pct = null.
    const marges = await Promise.all(lignesFixed.map(async (l) => {
      const refId = Number(l.IDreference) || 0
      const qty = Number(l.quantite) || 0
      const prix = Number(l.prix) || 0
      if (refId <= 0 || qty <= 0 || prix <= 0) return null
      try {
        const cout = await prixDeRevientTRM(refId, qty)
        if (!(cout > 0)) return null
        return { cout: round2(cout), marge_pct: Math.round(((prix - cout) / prix) * 100) }
      } catch {
        return null
      }
    }))

    const lignes = lignesFixed.map((l, i) => {
      const refId = Number(l.IDreference) || 0
      const info = refMap.get(refId)
      const qty = Number(l.quantite) || 0
      const prix = Number(l.prix) || 0
      const prod = prodMap.get(Number(l.IDligne_commande_client)) ?? { nb_pieces: 0, produit: 0, expedie: 0 }
      const m = marges[i]
      return {
        IDligne_commande_client: Number(l.IDligne_commande_client),
        IDcommande_client: Number(l.IDcommande_client),
        type: Number(l.type_kind) || 0,
        IDreference: refId,
        IDcolori: Number(l.IDcolori) || 0,
        quantite: qty,
        unite: Number(l.unite) || 1,
        // TRM knits by weight — the legacy screen has no unit selector at all.
        unite_label: 'Kgs',
        prix,
        date_livraison: l.date_livraison ?? null,
        commentaire: l.commentaire ?? null,
        ref_label: info?.reference || null,
        ref_designation: info?.designation || null,
        contexture: info?.contexture || null,
        colori_reference: coloriMap.get(Number(l.IDcolori) || 0) || null,
        montant: round2(qty * prix),
        cout_revient: m?.cout ?? null,
        marge_pct: m?.marge_pct ?? null,
        nb_pieces: prod.nb_pieces,
        produit: prod.produit,
        expedie: prod.expedie,
        // Mirrored lines carry a back-pointer to the ETM sst line that owns them.
        IDligne_commande_ETM: Number(l.IDligne_commande_ETM) || 0,
      }
    })

    const phase = (await computePhasesBatch([{ id, est_soldee: Number(h.est_soldee) || 0 }])).get(id) ?? 'a_lancer'

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
      est_soldee: Number(h.est_soldee) || 0,
      remise: Number(h.remise) || 0,
      IDcommande_ETM: Number(h.IDcommande_ETM) || 0,
      is_mirror: (Number(h.IDcommande_ETM) || 0) > 0,
      adresse_livraison: adrLiv,
      adresse_facturation: adrFac,
      lignes,
      phase,
    })
  } catch (err) {
    console.error('Error fetching commande-trm detail:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  HEADER CRUD  (native TRM orders only — see refuseIfMirror)
// ════════════════════════════════════════════════════════

/** Guard for the commande write paths: create, header edit, delete, line CRUD
 *  (TRM `edit_commandes_client` permission — effective admins bypass, an admin
 *  impersonating someone does not). The état toggle is deliberately NOT behind
 *  this key, mirroring ETM's split where clôture has its own permission.
 *  Sends the 401/403 itself and returns false when the caller is not allowed. */
async function requireEditCommandes(req: Request, res: Response): Promise<boolean> {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return false
  }
  const allowed = await trmUserHasPermission(req.userId, isEffectiveAdmin(req), 'edit_commandes_client')
  if (!allowed) {
    res.status(403).json({ error: 'permission denied: edit_commandes_client' })
    return false
  }
  return true
}

commandesTrmRouter.post('/', async (req: Request, res: Response) => {
  if (!(await requireEditCommandes(req, res))) return
  try {
    const parsed = commandeBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data
    if (!d.IDclient) { res.status(400).json({ error: 'IDclient is required' }); return }

    const dateCmd = d.date_commande ? dateStr(d.date_commande) : todayHfsql()

    // numero allocator with collision retry. Accented columns omitted (HFSQL
    // zero-fills archivé / expedié / envoyé_client). IDcommande_ETM = 0 is what
    // makes this a NATIVE TRM order rather than a mirror.
    let newNumero = 0
    let inserted = false
    let lastErr: unknown = null
    for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
      newNumero = await nextTrmNumero()
      try {
        await query(
          `INSERT INTO commande_client
             (IDclient, IDsociete, IDcommande_ETM, numero, date_commande,
              IDadresse_livraison, IDadresse_facturation, IDmode_paiement, IDecheance,
              ref_client, commentaire, est_soldee, remise, donation,
              attente_paiement, frais_port, IDdossier)
           VALUES
             (${n(d.IDclient)}, ${TRM_SOCIETE}, 0, ${newNumero}, '${dateCmd}',
              ${n(d.IDadresse_livraison ?? 0)}, ${n(d.IDadresse_facturation ?? 0)},
              ${n(d.IDmode_paiement ?? 0)}, ${n(d.IDecheance ?? 0)},
              ${sqlText(d.ref_client ?? '')}, ${sqlText(d.commentaire ?? '')}, 0,
              ${Number(d.remise) || 0}, 0, 0, 0, 0)`,
        )
        inserted = true
      } catch (e) { lastErr = e }
    }
    if (!inserted) throw lastErr ?? new Error('insert failed after 3 attempts')

    const newRows = await query<{ IDcommande_client: number }>(
      `SELECT IDcommande_client FROM commande_client
       WHERE IDsociete = ${TRM_SOCIETE} AND numero = ${newNumero}
       ORDER BY IDcommande_client DESC`,
    )
    res.status(201).json({ IDcommande_client: Number(newRows[0]?.IDcommande_client) || 0 })
  } catch (err) {
    console.error('Error creating commande-trm:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesTrmRouter.put('/:id', async (req: Request, res: Response) => {
  if (!(await requireEditCommandes(req, res))) return
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await guardWrite(res, id))) return

    const parsed = commandeBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data

    const sets: string[] = []
    if (d.date_commande !== undefined) sets.push(`date_commande = '${dateStr(d.date_commande)}'`)
    if (d.ref_client !== undefined) sets.push(`ref_client = ${sqlText(d.ref_client)}`)
    if (d.commentaire !== undefined) sets.push(`commentaire = ${sqlText(d.commentaire)}`)
    if (d.commentaire_interne !== undefined) sets.push(`commentaire_interne = ${sqlText(d.commentaire_interne)}`)
    if (d.IDmode_paiement !== undefined) sets.push(`IDmode_paiement = ${n(d.IDmode_paiement)}`)
    if (d.IDecheance !== undefined) sets.push(`IDecheance = ${n(d.IDecheance)}`)
    if (d.IDadresse_livraison !== undefined) sets.push(`IDadresse_livraison = ${n(d.IDadresse_livraison)}`)
    if (d.IDadresse_facturation !== undefined) sets.push(`IDadresse_facturation = ${n(d.IDadresse_facturation)}`)
    if (d.remise !== undefined) sets.push(`remise = ${Number(d.remise) || 0}`)
    if (sets.length === 0) { res.json({ ok: true }); return }

    await query(`UPDATE commande_client SET ${sets.join(', ')} WHERE IDcommande_client = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating commande-trm:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// État toggle (soldée ↔ en cours). Mirrors are excluded like every other write:
// on a mirror, ETM's own clôture is what drives the state.
commandesTrmRouter.put('/:id/etat', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await guardWrite(res, id, { allowSoldee: true }))) return
    const etat = Number(req.body?.est_soldee)
    if (etat !== 0 && etat !== 1) { res.status(400).json({ error: 'est_soldee must be 0 or 1' }); return }
    await query(`UPDATE commande_client SET est_soldee = ${etat} WHERE IDcommande_client = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating commande-trm etat:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesTrmRouter.delete('/:id', async (req: Request, res: Response) => {
  if (!(await requireEditCommandes(req, res))) return
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    // allowSoldee: deleting a closed native order is legitimate; the mirror
    // gate is the one that matters here.
    if (!(await guardWrite(res, id, { allowSoldee: true }))) return

    const lignes = await query<{ IDligne_commande_client: number }>(
      `SELECT IDligne_commande_client FROM ligne_commande_client WHERE IDcommande_client = ${id}`,
    )
    const lineIds = lignes.map((l) => Number(l.IDligne_commande_client)).filter((x) => x > 0)

    // Production is the hard stop: once an OF exists, machines have been
    // scheduled and pieces may already carry this order's id.
    if (lineIds.length > 0) {
      const ofs = await query<{ nb: number }>(
        `SELECT COUNT(*) AS nb FROM ordre_fabrication WHERE IDligne_commande_client IN (${lineIds.join(',')})`,
      )
      if ((Number(ofs[0]?.nb) || 0) > 0) {
        res.status(409).json({
          error: 'production_lancee',
          message: 'Cette commande ne peut pas être supprimée : la production a déjà été lancée.',
        })
        return
      }
    }
    const exp = await query<{ nb: number }>(
      `SELECT COUNT(*) AS nb FROM expedition WHERE IDcommande_client = ${id}`,
    )
    if ((Number(exp[0]?.nb) || 0) > 0) {
      res.status(409).json({
        error: 'expedition_existante',
        message: 'Cette commande ne peut pas être supprimée : elle a déjà été expédiée.',
      })
      return
    }

    if (lineIds.length > 0) {
      // Release any piece still pointing at these lines before the rows vanish,
      // otherwise the stock keeps a dangling reservation.
      await query(
        `UPDATE stock_ecru SET IDLigne_Commande_TRM = 0 WHERE IDLigne_Commande_TRM IN (${lineIds.join(',')})`,
      )
      await query(`DELETE FROM ligne_commande_client WHERE IDcommande_client = ${id}`)
    }
    await query(`DELETE FROM commande_client WHERE IDcommande_client = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting commande-trm:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  LINE CRUD
// ════════════════════════════════════════════════════════

commandesTrmRouter.post('/:id/lignes', async (req: Request, res: Response) => {
  if (!(await requireEditCommandes(req, res))) return
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await guardWrite(res, id))) return

    const parsed = ligneBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data

    // TYPE uppercase (reserved word), IDcolori lowercase, unite 1 = Kg — the
    // same shape the ETM bridge writes for its TRM mirror lines.
    await query(
      `INSERT INTO ligne_commande_client
         (IDcommande_client, IDligne_commande_ETM, TYPE, IDreference, IDcolori,
          quantite, unite, prix, poids, date_livraison, commentaire)
       VALUES
         (${id}, 0, 1, ${n(d.IDreference ?? 0)}, ${n(d.IDcolori ?? 0)},
          ${Number(d.quantite) || 0}, 1, ${Number(d.prix) || 0}, 0,
          '${d.date_livraison ? dateStr(d.date_livraison) : ''}', ${sqlText(d.commentaire ?? '')})`,
    )
    const rows = await query<{ IDligne_commande_client: number }>(
      `SELECT IDligne_commande_client FROM ligne_commande_client
       WHERE IDcommande_client = ${id} ORDER BY IDligne_commande_client DESC`,
    )
    res.status(201).json({ IDligne_commande_client: Number(rows[0]?.IDligne_commande_client) || 0 })
  } catch (err) {
    console.error('Error creating commande-trm ligne:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesTrmRouter.put('/lignes/:lineId', async (req: Request, res: Response) => {
  if (!(await requireEditCommandes(req, res))) return
  try {
    const lineId = parseInt(req.params.lineId, 10)
    if (isNaN(lineId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const commandeId = await loadCommandeIdForLine(lineId)
    if (commandeId === null) { res.status(404).json({ error: 'Ligne not found' }); return }
    if (!(await guardWrite(res, commandeId))) return

    const parsed = ligneBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const d = parsed.data

    const sets: string[] = []
    if (d.IDreference !== undefined) sets.push(`IDreference = ${n(d.IDreference)}`)
    if (d.IDcolori !== undefined) sets.push(`IDcolori = ${n(d.IDcolori)}`)
    if (d.quantite !== undefined) sets.push(`quantite = ${Number(d.quantite) || 0}`)
    if (d.prix !== undefined) sets.push(`prix = ${Number(d.prix) || 0}`)
    if (d.date_livraison !== undefined) sets.push(`date_livraison = '${d.date_livraison ? dateStr(d.date_livraison) : ''}'`)
    if (d.commentaire !== undefined) sets.push(`commentaire = ${sqlText(d.commentaire)}`)
    if (sets.length === 0) { res.json({ ok: true }); return }

    await query(`UPDATE ligne_commande_client SET ${sets.join(', ')} WHERE IDligne_commande_client = ${lineId}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating commande-trm ligne:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesTrmRouter.delete('/lignes/:lineId', async (req: Request, res: Response) => {
  if (!(await requireEditCommandes(req, res))) return
  try {
    const lineId = parseInt(req.params.lineId, 10)
    if (isNaN(lineId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const commandeId = await loadCommandeIdForLine(lineId)
    if (commandeId === null) { res.status(404).json({ error: 'Ligne not found' }); return }
    if (!(await guardWrite(res, commandeId))) return

    const ofs = await query<{ nb: number }>(
      `SELECT COUNT(*) AS nb FROM ordre_fabrication WHERE IDligne_commande_client = ${lineId}`,
    )
    if ((Number(ofs[0]?.nb) || 0) > 0) {
      res.status(409).json({
        error: 'production_lancee',
        message: 'Cette ligne ne peut pas être supprimée : un ordre de fabrication existe déjà.',
      })
      return
    }
    await query(`UPDATE stock_ecru SET IDLigne_Commande_TRM = 0 WHERE IDLigne_Commande_TRM = ${lineId}`)
    await query(`DELETE FROM ligne_commande_client WHERE IDligne_commande_client = ${lineId}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting commande-trm ligne:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  PROGRESSION PANEL — the four legacy bottom tabs
// ════════════════════════════════════════════════════════

/** Resolve a line and confirm it belongs to the given TRM commande. Returns
 *  null (caller 404s) for a wrong-partition or cross-commande id. */
async function loadTrmLine(commandeId: number, ligneId: number): Promise<{
  IDreference: number; IDcolori: number; quantite: number; prix: number
} | null> {
  const g = await loadCommandeGuard(commandeId)
  if (!g) return null
  const rows = await query<any>(
    `SELECT IDreference, IDcolori, quantite, prix FROM ligne_commande_client
     WHERE IDligne_commande_client = ${ligneId} AND IDcommande_client = ${commandeId}`,
  )
  if (rows.length === 0) return null
  return {
    IDreference: Number(rows[0].IDreference) || 0,
    IDcolori: Number(rows[0].IDcolori) || 0,
    quantite: Number(rows[0].quantite) || 0,
    prix: Number(rows[0].prix) || 0,
  }
}

/** TRM's own warehouse — the legacy Stock de fil query's `IDMagasin = 1`. */
const TRM_MAGASIN = 1

/** Which of these lots are archived (`terminé = 1`).
 *
 *  Platform-split for the same reason as `stock-fil-trm.ts` § fetchBaseRows:
 *  the Windows ODBC driver takes the accented identifier in a WHERE but
 *  returns zero rows for `SELECT *` on a table holding memo-binary columns,
 *  while the Linux bridge is the mirror image — `SELECT *` is fine, the
 *  accented identifier is not. So neither form works on both, and the flag has
 *  to be read the way the platform allows. */
async function archivedLotIds(ids: number[]): Promise<Set<number>> {
  const clean = Array.from(new Set(ids.filter((x) => x > 0)))
  if (clean.length === 0) return new Set()
  if (IS_WINDOWS) {
    const rows = await query<{ IDstock_fil: number }>(
      `SELECT IDstock_fil FROM stock_fil WHERE IDstock_fil IN (${clean.join(',')}) AND terminé = 1`,
    )
    return new Set(rows.map((r) => Number(r.IDstock_fil) || 0))
  }
  const rows = await query<Record<string, unknown>>(
    `SELECT * FROM stock_fil WHERE IDstock_fil IN (${clean.join(',')})`,
  )
  const out = new Set<number>()
  for (const r of rows) {
    // The bridge's key for an accented column is not deterministic — match by
    // prefix, exactly like stock.ts's pickVal.
    const key = Object.keys(r).find((k) => /^termin/i.test(k))
    if (key && Number(r[key])) out.add(Number(r.IDstock_fil) || 0)
  }
  return out
}

// ── Tab 1: Affectation — "Stock Affecté a la commande" ──
// The pieces the machines dropped for this line. `expedie` marks the ones
// already gone (IDligne_expedition_TRM > 0), which is what the legacy
// "Non Expédiées" filter button narrows to.

interface AffectationPiece {
  id: number
  numero: string | null
  lot: string | null
  poids: number
  metrage: number
  second_choix: number
  observations: string | null
  date_saisie: string | null
  num_piece_OF: number
  IDordre_fabrication: number
  expedie: boolean
  defects: DefautQualite[]
}

commandesTrmRouter.get('/:id/lignes/:ligneId/pieces', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.id, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    if (isNaN(commandeId) || isNaN(ligneId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const line = await loadTrmLine(commandeId, ligneId)
    if (!line) { res.status(404).json({ error: 'Ligne not found' }); return }

    const rowsRaw = await query<any>(
      `SELECT IDstock_ecru, numero, lot, poids, metrage, second_choix, observations,
              date_saisie, num_piece_OF, IDordre_fabrication, IDligne_expedition_TRM
       FROM stock_ecru
       WHERE IDLigne_Commande_TRM = ${ligneId}
       ORDER BY num_piece_OF, IDstock_ecru`,
    )
    const rows = await fixEncoding(rowsRaw, 'stock_ecru', 'IDstock_ecru', ['numero', 'lot', 'observations'])
    const defectsById = await fetchDefectsByEcru(rows.map((r: any) => Number(r.IDstock_ecru) || 0))

    const pieces: AffectationPiece[] = rows.map((r: any) => ({
      id: Number(r.IDstock_ecru),
      numero: (r.numero ?? '') || null,
      lot: (r.lot ?? '') || null,
      poids: Number(r.poids) || 0,
      metrage: Number(r.metrage) || 0,
      second_choix: Number(r.second_choix) || 0,
      observations: (r.observations ?? '') || null,
      date_saisie: r.date_saisie ?? null,
      num_piece_OF: Number(r.num_piece_OF) || 0,
      IDordre_fabrication: Number(r.IDordre_fabrication) || 0,
      expedie: (Number(r.IDligne_expedition_TRM) || 0) > 0,
      defects: defectsById.get(Number(r.IDstock_ecru)) ?? [],
    }))

    // "Stock disponible 1er choix" in the legacy footer: the un-shipped,
    // first-choice weight still sitting on this order.
    const dispo = pieces
      .filter((p) => !p.expedie && p.second_choix === 0)
      .reduce((s, p) => s + p.poids, 0)

    res.json({
      pieces,
      commande: round2(line.quantite),
      produit: round2(pieces.reduce((s, p) => s + p.poids, 0)),
      expedie: round2(pieces.filter((p) => p.expedie).reduce((s, p) => s + p.poids, 0)),
      disponible_1er_choix: round2(dispo),
    })
  } catch (err) {
    console.error('Error fetching commande-trm pieces:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Tab 2: Stock de fil — "Fils en stock" ──────────────
// The yarn lots that can knit this line's écru, from composition_ecru. The
// legacy footer's "Potentiel de X Kgs de <ref>" is how much fabric the lots on
// hand could produce: for each composition pair, lot weight ÷ its share of the
// blend; the blend as a whole is capped by its scarcest component.

commandesTrmRouter.get('/:id/lignes/:ligneId/stock-fil', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.id, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    if (isNaN(commandeId) || isNaN(ligneId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const line = await loadTrmLine(commandeId, ligneId)
    if (!line) { res.status(404).json({ error: 'Ligne not found' }); return }

    const refMap = await resolveEcruRefs([line.IDreference])
    const coloriMap = await resolveColorisEcru([line.IDcolori])
    // Named in the payload so an empty tab can say WHOSE yarn is missing —
    // with the client filter below, "aucun lot" is now most often "aucun lot
    // *de ce client*", and a bare empty state would read as a broken screen.
    // Two flat reads, never a JOIN: the Linux bridge mangles accents across
    // joins, and client names carry them.
    const cmdRow = await query<{ IDclient: number }>(
      `SELECT IDclient FROM commande_client WHERE IDcommande_client = ${commandeId}`,
    )
    const IDclient = Number(cmdRow[0]?.IDclient) || 0
    const cliRow = IDclient > 0
      ? await query<{ IDclient: number; nom: string | null }>(
          `SELECT IDclient, nom FROM client WHERE IDclient = ${IDclient}`,
        )
      : []
    const clientNom = String(
      ((await fixEncoding(cliRow as any, 'client', 'IDclient', ['nom']))[0] as any)?.nom ?? '',
    ).trim()
    const base = {
      lots: [] as unknown[],
      potentiel_kg: 0,
      ecru_ref_label: refMap.get(line.IDreference)?.reference ?? '',
      ecru_coloris_label: coloriMap.get(line.IDcolori) ?? '',
      client_nom: clientNom,
      composants: [] as unknown[],
    }
    if (line.IDreference <= 0) { res.json(base); return }

    // Composition rows — coloris-scoped first, falling back to every variant
    // of the écru (composition data is sparse on older refs).
    //
    // ⚠️ No DISTINCT, and the shares are SUMMED per pair: a blend may feed the
    // same yarn from two positions (ref 119/ecru = 71 % + 14,5 % + 14,5 %, the
    // last two being one and the same 280/48/1 PES HT). Keeping only the first
    // row would say this lot covers 14,5 % of the blend when it covers 29 —
    // overstating the potentiel and mislabelling the % column. Same finding as
    // `of-trm.ts` § lookups/composition.
    const rowQuery = (coloriIn: string) => query<{
      IDcomposition_ecru: number; IDref_fil: number; IDcolori_fil: number; pourcentage: number | null
    }>(
      `SELECT IDcomposition_ecru, IDref_fil, IDcolori_fil, pourcentage FROM composition_ecru
       WHERE IDref_ecru = ${line.IDreference}${coloriIn} AND IDref_fil > 0`,
    )
    let pairRows = line.IDcolori > 0
      ? await rowQuery(` AND IDcolori_ecru = ${line.IDcolori}`)
      : await rowQuery('')
    if (pairRows.length === 0) pairRows = await rowQuery('')

    const pctByPair = new Map<string, number>()
    for (const p of pairRows) {
      const rf = Number(p.IDref_fil) || 0
      const cf = Number(p.IDcolori_fil) || 0
      const pct = Number(p.pourcentage) || 0
      if (rf <= 0 || pct <= 0) continue
      const k = `${rf}:${cf}`
      pctByPair.set(k, (pctByPair.get(k) ?? 0) + pct)
    }
    if (pctByPair.size === 0) { res.json(base); return }

    // On-hand lots. stock_fil has an accented `terminé` column, so SELECT *
    // returns nothing on this driver — name every column explicitly.
    //
    // ⚠️ Scoped to the ORDER'S CLIENT (`IDclient`), like the legacy query. TRM
    // knits à façon: the client supplies the yarn, so an order can only be run
    // off lots that client owns. Without it the tab offered Ets Malterre's lot
    // 10131 on Bonneterie Gautier's commande 2799 — which is how an OF gets
    // created that eats another customer's stock. `stock_fil` is not
    // partitioned by société; `IDclient` is the only thing that says whose
    // yarn a lot is (user-reported, 2026-08-26). Barely visible in practice
    // because Ets Malterre places 2 469 of the ~2 600 TRM orders and owns 77
    // of the 123 lots in stock — it only bites on the small clients, which is
    // exactly where it matters.
    //
    // The other two legacy filters, same rationale: `IDMagasin = 1` is TRM's
    // own warehouse (122 of 123 lots), and `terminé = 0` excludes archived
    // lots — `stock > 0` is NOT equivalent, 3 lots are archived with stock
    // still on them.
    const pairClause = Array.from(pctByPair.keys())
      .map((k) => { const [rf, cf] = k.split(':'); return `(IDref_fil = ${rf} AND IDcolori_fil = ${cf})` })
      .join(' OR ')
    const lotsRaw = await query<any>(
      `SELECT IDstock_fil, IDref_fil, IDcolori_fil, lot, stock, stock_initial,
              IDMagasin, IDfournisseur, IDclient, emplacement
       FROM stock_fil WHERE (${pairClause}) AND stock > 0
             AND IDclient = ${IDclient} AND IDMagasin = ${TRM_MAGASIN}
       ORDER BY lot`,
    )
    const archived = await archivedLotIds(lotsRaw.map((l: any) => Number(l.IDstock_fil) || 0))
    const lotsOpen = lotsRaw.filter((l: any) => !archived.has(Number(l.IDstock_fil) || 0))
    const lotsFixed = await fixEncoding(lotsOpen, 'stock_fil', 'IDstock_fil', ['lot', 'emplacement'])

    // Display names — flat batched lookups (no JOIN + CONVERT; the bridge
    // mangles accents across joins).
    // Names are resolved for every composition pair, not only the ones that
    // have a lot: `composants` below has to name a yarn the client has none of.
    const refFilIds = Array.from(new Set([
      ...lotsFixed.map((l: any) => Number(l.IDref_fil) || 0),
      ...Array.from(pctByPair.keys()).map((k) => Number(k.split(':')[0]) || 0),
    ].filter(Boolean)))
    const coloriFilIds = Array.from(new Set([
      ...lotsFixed.map((l: any) => Number(l.IDcolori_fil) || 0),
      ...Array.from(pctByPair.keys()).map((k) => Number(k.split(':')[1]) || 0),
    ].filter(Boolean)))
    const frsIds = Array.from(new Set(lotsFixed.map((l: any) => Number(l.IDfournisseur) || 0).filter(Boolean)))
    const cliIds = Array.from(new Set(lotsFixed.map((l: any) => Number(l.IDclient) || 0).filter(Boolean)))

    const [refFilNames, coloriFilNames, frsNames, cliNames] = await Promise.all([
      (async () => {
        const m = new Map<number, string>()
        if (refFilIds.length === 0) return m
        const r = await query<{ IDref_fil: number; reference: string | null }>(
          `SELECT IDref_fil, reference FROM ref_fil WHERE IDref_fil IN (${refFilIds.join(',')})`,
        )
        for (const row of await fixEncoding(r, 'ref_fil', 'IDref_fil', ['reference'])) {
          m.set(Number(row.IDref_fil), (row.reference ?? '').toString().trim())
        }
        return m
      })(),
      (async () => {
        const m = new Map<number, string>()
        if (coloriFilIds.length === 0) return m
        const r = await query<{ IDcolori_fil: number; reference: string | null }>(
          `SELECT IDcolori_fil, reference FROM colori_fil WHERE IDcolori_fil IN (${coloriFilIds.join(',')})`,
        )
        for (const row of await fixEncoding(r, 'colori_fil', 'IDcolori_fil', ['reference'])) {
          m.set(Number(row.IDcolori_fil), (row.reference ?? '').toString().trim())
        }
        return m
      })(),
      (async () => {
        const m = new Map<number, string>()
        if (frsIds.length === 0) return m
        const r = await query<{ IDfournisseur: number; nom: string | null }>(
          `SELECT IDfournisseur, nom FROM fournisseur WHERE IDfournisseur IN (${frsIds.join(',')})`,
        )
        for (const row of await fixEncoding(r, 'fournisseur', 'IDfournisseur', ['nom'])) {
          m.set(Number(row.IDfournisseur), (row.nom ?? '').toString().trim())
        }
        return m
      })(),
      resolveClientNames(cliIds),
    ])

    const lots = lotsFixed.map((l: any) => {
      const rf = Number(l.IDref_fil) || 0
      const cf = Number(l.IDcolori_fil) || 0
      return {
        id: Number(l.IDstock_fil),
        // The pair identifies which composition component this lot can feed —
        // the "Créer un OF" flow maps the user's selection onto the seed with it.
        IDref_fil: rf,
        IDcolori_fil: cf,
        lot: (l.lot ?? '') || null,
        reference: refFilNames.get(rf) ?? `#${rf}`,
        coloris: coloriFilNames.get(cf) ?? '',
        emplacement: (l.emplacement ?? '') || null,
        fournisseur: frsNames.get(Number(l.IDfournisseur) || 0) ?? '',
        client: cliNames.get(Number(l.IDclient) || 0) ?? '',
        stock: round2(Number(l.stock) || 0),
        stock_initial: round2(Number(l.stock_initial) || 0),
        pourcentage: pctByPair.get(`${rf}:${cf}`) ?? 0,
      }
    })

    // Potentiel: weight per composition pair ÷ its share, then the minimum
    // across pairs (a blend can only be knitted while every component lasts).
    // Pairs with zero stock make the whole potential zero, which is the honest
    // answer and what the legacy footer shows.
    const kgByPair = new Map<string, number>()
    for (const k of pctByPair.keys()) kgByPair.set(k, 0)
    for (const raw of lotsFixed as any[]) {
      const k = `${Number(raw.IDref_fil) || 0}:${Number(raw.IDcolori_fil) || 0}`
      if (!kgByPair.has(k)) continue
      kgByPair.set(k, (kgByPair.get(k) ?? 0) + (Number(raw.stock) || 0))
    }
    let potentiel = Infinity
    for (const [k, pct] of pctByPair) {
      const kg = kgByPair.get(k) ?? 0
      potentiel = Math.min(potentiel, kg / (pct / 100))
    }
    if (!isFinite(potentiel)) potentiel = 0

    // Every (fil, coloris) the reference's composition declares — including
    // the ones this client holds no lot of, which is exactly the case `lots`
    // cannot express. « Créer un OF » is offered only once each of these has a
    // ticked lot: a run missing one of its yarns is not knittable, and the
    // dialog would open with a component that has no lot behind it. Shares are
    // summed per pair, like `pctByPair` itself — a blend can feed one yarn from
    // two positions, and the tab is a per-yarn view.
    const composants = Array.from(pctByPair.entries()).map(([k, pct]) => {
      const [rf, cf] = k.split(':').map(Number)
      return {
        IDref_fil: rf,
        IDcolori_fil: cf,
        pourcentage: round2(pct),
        ref_label: refFilNames.get(rf) ?? `#${rf}`,
        coloris_label: coloriFilNames.get(cf) ?? '',
      }
    })

    res.json({
      lots,
      composants,
      client_nom: base.client_nom,
      potentiel_kg: round2(potentiel),
      ecru_ref_label: base.ecru_ref_label,
      ecru_coloris_label: base.ecru_coloris_label,
    })
  } catch (err) {
    console.error('Error fetching commande-trm stock-fil:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Tab 3: Ordre de fabrication ────────────────────────
// The OFs scheduled for this line, with what each one has actually produced
// so far, plus the legacy footer's "Compatible sur : 1H, 3F, …" machine list.

commandesTrmRouter.get('/:id/lignes/:ligneId/ordres-fabrication', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.id, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    if (isNaN(commandeId) || isNaN(ligneId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const line = await loadTrmLine(commandeId, ligneId)
    if (!line) { res.status(404).json({ error: 'Ligne not found' }); return }

    // `productivité` and `Nettoyage` are accented/odd-cased — never named.
    const ofsRaw = await query<any>(
      `SELECT IDordre_fabrication, quantite, IDmachine, nb_pieces, poids_piece,
              est_actif, est_termine, finir_fil, priorite, prioritaire,
              date_creation, planning_depart, planning_fin, observations
       FROM ordre_fabrication
       WHERE IDligne_commande_client = ${ligneId}
       ORDER BY IDordre_fabrication`,
    )
    const ofs = await fixEncoding(ofsRaw, 'ordre_fabrication', 'IDordre_fabrication', ['observations'])
    const ofIds = ofs.map((o: any) => Number(o.IDordre_fabrication)).filter((x: number) => x > 0)

    // Réalisé per OF = the weight of the pieces it dropped.
    const realiseByOf = new Map<number, number>()
    if (ofIds.length > 0) {
      const prod = await query<{ IDordre_fabrication: number; poids: number | null }>(
        `SELECT IDordre_fabrication, poids FROM stock_ecru
         WHERE IDordre_fabrication IN (${ofIds.join(',')})`,
      )
      for (const p of prod) {
        const k = Number(p.IDordre_fabrication)
        realiseByOf.set(k, (realiseByOf.get(k) ?? 0) + (Number(p.poids) || 0))
      }
    }

    // Yarn lots assigned to each OF (the legacy "Fils" column).
    const filsByOf = new Map<number, string[]>()
    if (ofIds.length > 0) {
      const asso = await query<{ IDordre_fabrication: number; IDstock_fil: number }>(
        `SELECT IDordre_fabrication, IDstock_fil FROM asso_fil_of
         WHERE IDordre_fabrication IN (${ofIds.join(',')})`,
      )
      const lotIds = Array.from(new Set(asso.map((a) => Number(a.IDstock_fil) || 0).filter(Boolean)))
      const lotLabels = new Map<number, string>()
      if (lotIds.length > 0) {
        const l = await query<{ IDstock_fil: number; lot: string | null }>(
          `SELECT IDstock_fil, lot FROM stock_fil WHERE IDstock_fil IN (${lotIds.join(',')})`,
        )
        for (const row of await fixEncoding(l, 'stock_fil', 'IDstock_fil', ['lot'])) {
          lotLabels.set(Number(row.IDstock_fil), (row.lot ?? '').toString().trim())
        }
      }
      for (const a of asso) {
        const k = Number(a.IDordre_fabrication)
        const label = lotLabels.get(Number(a.IDstock_fil) || 0)
        if (!label) continue
        const arr = filsByOf.get(k) ?? []
        arr.push(label)
        filsByOf.set(k, arr)
      }
    }

    const machineIds = Array.from(new Set(ofs.map((o: any) => Number(o.IDmachine) || 0).filter(Boolean)))
    const machineNames = new Map<number, string>()
    if (machineIds.length > 0) {
      const m = await query<{ IDmachine: number; nom: string | null }>(
        `SELECT IDmachine, nom FROM machine WHERE IDmachine IN (${machineIds.join(',')})`,
      )
      for (const row of await fixEncoding(m, 'machine', 'IDmachine', ['nom'])) {
        machineNames.set(Number(row.IDmachine), (row.nom ?? '').toString().trim())
      }
    }

    // "Compatible sur" — every machine the écru has a machine sheet for.
    let compatibles: string[] = []
    if (line.IDreference > 0) {
      const rem = await query<{ IDmachine: number }>(
        `SELECT IDmachine FROM ref_ecru_machine WHERE IDref_ecru = ${line.IDreference}`,
      )
      const ids = Array.from(new Set(rem.map((r) => Number(r.IDmachine) || 0).filter(Boolean)))
      if (ids.length > 0) {
        const m = await query<{ IDmachine: number; nom: string | null }>(
          `SELECT IDmachine, nom FROM machine WHERE IDmachine IN (${ids.join(',')})`,
        )
        compatibles = (await fixEncoding(m, 'machine', 'IDmachine', ['nom']))
          .map((row) => (row.nom ?? '').toString().trim())
          .filter(Boolean)
      }
    }

    res.json({
      ordres: ofs.map((o: any) => {
        const ofId = Number(o.IDordre_fabrication)
        const quantite = Number(o.quantite) || 0
        const realise = round2(realiseByOf.get(ofId) ?? 0)
        return {
          id: ofId,
          machine: machineNames.get(Number(o.IDmachine) || 0) ?? '',
          IDmachine: Number(o.IDmachine) || 0,
          rouleaux: Number(o.nb_pieces) || 0,
          poids_piece: Number(o.poids_piece) || 0,
          quantite: round2(quantite),
          realise,
          progression_pct: quantite > 0 ? Math.round((realise / quantite) * 1000) / 10 : 0,
          finir_fil: Number(o.finir_fil) || 0,
          est_actif: Number(o.est_actif) || 0,
          est_termine: Number(o.est_termine) || 0,
          prioritaire: Number(o.prioritaire) || 0,
          date_creation: o.date_creation ?? null,
          planning_depart: o.planning_depart ?? null,
          planning_fin: o.planning_fin ?? null,
          observations: (o.observations ?? '') || null,
          fils: filsByOf.get(ofId) ?? [],
        }
      }),
      compatibles,
      commande: round2(line.quantite),
    })
  } catch (err) {
    console.error('Error fetching commande-trm ordres-fabrication:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Tab 4: Expédition ──────────────────────────────────
// The order's shipments and the pieces that left in each. `expedition` is
// partitioned by société like commande_client, so scope on IDsociete = 2.

commandesTrmRouter.get('/:id/expeditions', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.id, 10)
    if (isNaN(commandeId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const g = await loadCommandeGuard(commandeId)
    if (!g) { res.status(404).json({ error: 'Commande not found' }); return }

    // `envoyé_client` / `envoyé_sst` are accented — never named. DATE is a
    // reserved word and comes back uppercased, so alias it.
    const expsRaw = await query<any>(
      `SELECT IDexpedition, IDcommande_client, DATE AS date_exp, IDadresse,
              IDtransporteur, est_valide, est_facture, observation_bl
       FROM expedition
       WHERE IDcommande_client = ${commandeId} AND IDsociete = ${TRM_SOCIETE}
       ORDER BY IDexpedition DESC`,
    )
    const exps = await fixEncoding(expsRaw, 'expedition', 'IDexpedition', ['observation_bl'])
    if (exps.length === 0) { res.json({ expeditions: [] }); return }

    const expIds = exps.map((e: any) => Number(e.IDexpedition)).filter(Boolean)
    const lignesExp = await query<{ IDligne_expedition: number; IDexpedition: number; IDligne_commande_client: number }>(
      `SELECT IDligne_expedition, IDexpedition, IDligne_commande_client
       FROM ligne_expedition WHERE IDexpedition IN (${expIds.join(',')})`,
    )
    const expByLigneExp = new Map<number, number>()
    for (const le of lignesExp) expByLigneExp.set(Number(le.IDligne_expedition), Number(le.IDexpedition))

    // Rolls: stamped with the ligne_expedition they left on (TRM side).
    const rollsByExp = new Map<number, any[]>()
    const leIds = Array.from(expByLigneExp.keys()).filter((x) => x > 0)
    if (leIds.length > 0) {
      const rollsRaw = await query<any>(
        `SELECT IDstock_ecru, numero, lot, poids, IDmagasin, IDsociete, IDligne_expedition_TRM
         FROM stock_ecru WHERE IDligne_expedition_TRM IN (${leIds.join(',')})
         ORDER BY IDstock_ecru`,
      )
      const rolls = await fixEncoding(rollsRaw, 'stock_ecru', 'IDstock_ecru', ['numero', 'lot'])
      // IDmagasin points at sous_traitant; 0 means the roll is at the factory,
      // in which case the legacy screen labels it by its OWNING company
      // (stock_ecru.IDsociete → societe.nom). Same convention as the ETM
      // stock screens (resolveMagasinNames / resolveSocieteNames).
      const magIds = Array.from(new Set(rolls.map((r: any) => Number(r.IDmagasin) || 0).filter(Boolean)))
      const socIds = Array.from(new Set(
        rolls.filter((r: any) => !(Number(r.IDmagasin) > 0)).map((r: any) => Number(r.IDsociete) || 0).filter(Boolean),
      ))
      const [magNames, socNames] = await Promise.all([
        (async () => {
          const m = new Map<number, string>()
          if (magIds.length === 0) return m
          const rowsM = await query<{ IDsous_traitant: number; nom: string | null }>(
            `SELECT IDsous_traitant, nom FROM sous_traitant WHERE IDsous_traitant IN (${magIds.join(',')})`,
          )
          for (const row of await fixEncoding(rowsM, 'sous_traitant', 'IDsous_traitant', ['nom'])) {
            m.set(Number(row.IDsous_traitant), (row.nom ?? '').toString().trim())
          }
          return m
        })(),
        (async () => {
          const m = new Map<number, string>()
          if (socIds.length === 0) return m
          // societe.nom is ASCII — no CONVERT needed.
          const rowsS = await query<{ IDsociete: number; nom: string | null }>(
            `SELECT IDsociete, nom FROM societe WHERE IDsociete IN (${socIds.join(',')})`,
          )
          for (const row of rowsS) m.set(Number(row.IDsociete), (row.nom ?? '').toString().trim())
          return m
        })(),
      ])
      for (const r of rolls as any[]) {
        const expId = expByLigneExp.get(Number(r.IDligne_expedition_TRM) || 0)
        if (!expId) continue
        const arr = rollsByExp.get(expId) ?? []
        const magId = Number(r.IDmagasin) || 0
        const socId = Number(r.IDsociete) || 0
        arr.push({
          id: Number(r.IDstock_ecru),
          numero: (r.numero ?? '') || null,
          lot: (r.lot ?? '') || null,
          poids: Number(r.poids) || 0,
          magasin: magId > 0
            ? (magNames.get(magId) ?? `#${magId}`)
            : (socNames.get(socId) ?? "À l'usine"),
        })
        rollsByExp.set(expId, arr)
      }
    }

    const transporteurIds = Array.from(new Set(exps.map((e: any) => Number(e.IDtransporteur) || 0).filter(Boolean)))
    const transporteurNames = new Map<number, string>()
    if (transporteurIds.length > 0) {
      const t = await query<{ IDtransporteur: number; nom: string | null }>(
        `SELECT IDtransporteur, nom FROM transporteur WHERE IDtransporteur IN (${transporteurIds.join(',')})`,
      )
      for (const row of await fixEncoding(t, 'transporteur', 'IDtransporteur', ['nom'])) {
        transporteurNames.set(Number(row.IDtransporteur), (row.nom ?? '').toString().trim())
      }
    }

    const adrIds = Array.from(new Set(exps.map((e: any) => Number(e.IDadresse) || 0).filter(Boolean)))
    const adrById = new Map<number, any>()
    if (adrIds.length > 0) {
      const a = await query<any>(
        `SELECT IDadresse, nom, adresse1, adresse2, adresse3, cp, ville, pays
         FROM adresse WHERE IDadresse IN (${adrIds.join(',')})`,
      )
      for (const row of await fixEncoding(a, 'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays'])) {
        adrById.set(Number(row.IDadresse), row)
      }
    }

    res.json({
      expeditions: exps.map((e: any) => {
        const eid = Number(e.IDexpedition)
        const rolls = rollsByExp.get(eid) ?? []
        return {
          id: eid,
          date: e.date_exp ?? null,
          est_valide: Number(e.est_valide) || 0,
          est_facture: Number(e.est_facture) || 0,
          transporteur: transporteurNames.get(Number(e.IDtransporteur) || 0) ?? '',
          adresse: adrById.get(Number(e.IDadresse) || 0) ?? null,
          observation_bl: (e.observation_bl ?? '') || null,
          poids: round2(rolls.reduce((s: number, r: any) => s + (Number(r.poids) || 0), 0)),
          rolls,
        }
      }),
    })
  } catch (err) {
    console.error('Error fetching commande-trm expeditions:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  CONFIRMATION DE COMMANDE  (PDF + email)
// ════════════════════════════════════════════════════════
//
// Port of the legacy TRM commande print. The document itself is NOT a
// TRM-specific template: ETS Malterre and Tricotage Malterre confirm an order
// the same way, so this renders the shared `CommandeClientPdf` with
// `company: companyTrm` — TRM signs a commercial document, so the footer must
// carry its own SIRET / TVA / capital (same legal reason as the avis
// d'expédition, see BonLivraisonPdf's `issuer`).
//
// Deltas from the legacy print (deliberate — both are the ETM document's
// behaviour): the lines table carries a montant column and a totals block
// (HT · remise · TVA · TTC) the legacy omits, and the écru designation prints
// under the reference instead of the legacy's "V/ref" line.
//
// Available on MIRRORED orders too. The mirror rule is about writes: reading
// what ETM ordered from TRM and confirming it back is exactly what a
// sous-traitance confirmation is, and the legacy prints those as well.

const SENDER_LABEL = 'Tricotage Malterre'

/** HFSQL YYYYMMDD → dd/mm/yyyy (the lines table's livraison column). */
function dateFr(raw: string | null | undefined): string {
  const s = (raw ?? '').toString()
  if (!/^\d{8}$/.test(s) || s === '00000000') return ''
  return `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`
}

/** Blank-ish HFSQL text (' ') must not print as an empty address line. */
function addrField(s: string | null | undefined): string | null {
  const t = (s ?? '').toString().trim()
  return t.length > 0 ? t : null
}

async function loadLibelle(
  table: 'mode_paiement' | 'echeance',
  pk: 'IDmode_paiement' | 'IDecheance',
  id: number,
): Promise<string | null> {
  if (!(id > 0)) return null
  const rows = await query<{ libelle: string | null }>(`SELECT libelle FROM ${table} WHERE ${pk} = ${id}`)
  const fixed = await fixEncoding(rows, table, pk, ['libelle'])
  const v = (fixed[0]?.libelle ?? '').toString().trim()
  return v.length > 0 ? v : null
}

export async function buildTrmConfirmationPdfData(id: number): Promise<CommandeClientPdfData | null> {
  const rows = await query<any>(`SELECT * FROM commande_client WHERE IDcommande_client = ${id}`)
  if (rows.length === 0) return null
  if (Number(rows[0].IDsociete) !== TRM_SOCIETE) return null

  const fixedHeader = await fixEncoding(rows, 'commande_client', 'IDcommande_client', ['ref_client', 'commentaire'])
  const h = fixedHeader[0] as any
  const commentaire = stripRtf(h.commentaire) || null
  const IDclient = Number(h.IDclient) || 0

  const adrCols = 'IDadresse, nom, adresse1, adresse2, adresse3, cp, ville, pays'
  const [clientNames, adrFacRows, adrLivRows, lignesRaw, tvaRate, modePaiement, echeance] = await Promise.all([
    resolveClientNames([IDclient]),
    h.IDadresse_facturation
      ? query<any>(`SELECT ${adrCols} FROM adresse WHERE IDadresse = ${n(h.IDadresse_facturation)}`)
      : Promise.resolve([]),
    h.IDadresse_livraison
      ? query<any>(`SELECT ${adrCols} FROM adresse WHERE IDadresse = ${n(h.IDadresse_livraison)}`)
      : Promise.resolve([]),
    query<any>(
      `SELECT IDligne_commande_client, IDreference, IDcolori, quantite, prix, date_livraison
       FROM ligne_commande_client
       WHERE IDcommande_client = ${id}
       ORDER BY IDligne_commande_client`,
    ),
    // The client's own rate — an export client sits at 0 % (exonération) and
    // must be confirmed at 0 % on every document.
    loadClientTvaRate(IDclient),
    loadLibelle('mode_paiement', 'IDmode_paiement', Number(h.IDmode_paiement) || 0),
    loadLibelle('echeance', 'IDecheance', Number(h.IDecheance) || 0),
  ])

  const adrFields = ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays']
  const adrFac = (await fixEncoding(adrFacRows, 'adresse', 'IDadresse', adrFields))[0] ?? null
  const adrLiv = (await fixEncoding(adrLivRows, 'adresse', 'IDadresse', adrFields))[0] ?? null
  const cleanAddr = (a: any | null) => a
    ? {
        nom: addrField(a.nom), adresse1: addrField(a.adresse1), adresse2: addrField(a.adresse2),
        adresse3: addrField(a.adresse3), cp: addrField(a.cp), ville: addrField(a.ville), pays: addrField(a.pays),
      }
    : null

  const lignesFixed = lignesRaw as any[]
  const [refMap, coloriMap] = await Promise.all([
    resolveEcruRefs(lignesFixed.map((l) => Number(l.IDreference) || 0)),
    resolveColorisEcru(lignesFixed.map((l) => Number(l.IDcolori) || 0)),
  ])

  const lignes = lignesFixed.map((l) => {
    const info = refMap.get(Number(l.IDreference) || 0)
    const qty = Number(l.quantite) || 0
    const prix = Number(l.prix) || 0
    return {
      ref_label: info?.reference || null,
      colori_reference: coloriMap.get(Number(l.IDcolori) || 0) || null,
      designation: info?.designation || null,
      quantite: qty,
      // TRM knits by weight — every line of the partition is a type-1 écru
      // priced per Kg, so the unit is never read from `unite`.
      unite_label: 'Kgs',
      prix,
      montant: round2(qty * prix),
      date_livraison: dateFr(l.date_livraison),
    }
  })

  return {
    numero: String(h.numero ?? id),
    dateCommande: formatHfsqlDateLongFr(h.date_commande),
    clientNom: clientNames.get(IDclient) ?? '',
    refClient: ((h.ref_client ?? '').toString().trim()) || null,
    adresseFacturation: cleanAddr(adrFac),
    adresseLivraison: cleanAddr(adrLiv),
    modePaiement,
    echeance,
    commentaire,
    remise: Number(h.remise) || 0,
    fraisPort: Number(h.frais_port) || 0,
    tvaRate,
    company: companyTrm,
    lignes,
  }
}

async function renderTrmConfirmationPdf(data: CommandeClientPdfData): Promise<Buffer> {
  return renderToBuffer(
    React.createElement(CommandeClientPdf, { data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >,
  )
}

function pdfFilename(numero: string): string {
  return `confirmation-commande-${numero}.pdf`
}

commandesTrmRouter.get('/:id/pdf', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const data = await buildTrmConfirmationPdfData(id)
    if (!data) { res.status(404).json({ error: 'Commande not found' }); return }
    const buffer = await renderTrmConfirmationPdf(data)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${pdfFilename(data.numero)}"`)
    // Previewed in an iframe by the send-email dialog — the API's default
    // framing headers would blank it.
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buffer)
  } catch (err) {
    console.error('Error rendering TRM commande PDF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesTrmRouter.get('/:id/email-defaults', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const rows = await query<{ IDclient: number; numero: number | null; IDsociete: number }>(
      `SELECT IDclient, numero, IDsociete FROM commande_client WHERE IDcommande_client = ${id}`,
    )
    if (rows.length === 0 || Number(rows[0].IDsociete) !== TRM_SOCIETE) {
      res.status(404).json({ error: 'Commande not found' }); return
    }
    const IDclient = Number(rows[0].IDclient) || 0
    const numero = String(rows[0].numero ?? id)

    const [clientNames, contactRows] = await Promise.all([
      resolveClientNames([IDclient]),
      IDclient > 0
        ? query<{ IDcontact: number; nom: string | null; prenom: string | null; mail: string | null; envoi_commande: number | null; est_visible: number | null }>(
            `SELECT IDcontact, nom, prenom, mail, envoi_commande, est_visible FROM contact WHERE IDclient = ${IDclient}`,
          )
        : Promise.resolve([]),
    ])
    const fixedContacts = await fixEncoding(contactRows, 'contact', 'IDcontact', ['nom', 'prenom', 'mail'])

    // Same rule as every other send dialog: contacts flagged for this document
    // land in "À", the rest are offered as suggestions.
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
      if (c.envoi_commande === 1) selected.push(recipient)
      else suggestions.push(recipient)
    }

    // Recap in the body itself so the terms are checkable without opening the
    // attachment. Built from the PDF payload so the two can never disagree.
    let recap = ''
    try {
      const data = await buildTrmConfirmationPdfData(id)
      if (data && data.lignes.length > 0) {
        const items = data.lignes.map((l) => {
          const ref = [l.ref_label, l.colori_reference].filter((s) => s && s.trim()).join(' - ')
          const qty = `${l.quantite.toLocaleString('fr-FR').replace(/[  ]/g, ' ')} ${l.unite_label}`.trim()
          const liv = l.date_livraison ? ` - livraison ${l.date_livraison}` : ''
          return `  •  ${ref || 'Ligne'} : ${qty}${liv}`
        })
        recap = `Récapitulatif :\n${items.join('\n')}\n\n`
      }
    } catch (e) {
      // Best-effort: the attached PDF stays the reference document.
      console.error('TRM commande email recap failed:', (e as Error).message)
    }

    res.json({
      recipients: { selected, suggestions },
      subject: `Confirmation de commande N°${numero} - ${SENDER_LABEL}`,
      body:
        `Bonjour,\n\n` +
        `Veuillez trouver ci-joint la confirmation de votre commande N°${numero}.\n\n` +
        recap +
        `Nous vous remercions de vérifier les références, quantités et délais indiqués et de nous signaler toute anomalie.\n\n` +
        `Nous restons à votre disposition pour toute information complémentaire.\n\n` +
        `Cordialement,\n` +
        SENDER_LABEL,
      clientNom: clientNames.get(IDclient) ?? '',
      // No Cci: unlike the ETM avis there is no holding warehouse to copy in.
      bcc: [],
      optional_attachments: [],
    })
  } catch (err) {
    console.error('Error building TRM commande email defaults:', err)
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

commandesTrmRouter.post('/:id/email', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }
    const scoped = await query<{ IDsociete: number }>(
      `SELECT IDsociete FROM commande_client WHERE IDcommande_client = ${id}`,
    )
    if (scoped.length === 0 || Number(scoped[0].IDsociete) !== TRM_SOCIETE) {
      res.status(404).json({ error: 'Commande not found' }); return
    }
    const parsed = emailBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const devSkip = parsed.data.dev_skip_send === true && ALLOW_DEV_SKIP_SEND

    let messageId: string
    if (devSkip) {
      messageId = `dev-skip-${Date.now()}`
      console.log(`[dev-skip-send] commande TRM #${id} — fake send to ${parsed.data.to.join(', ')}`)
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
        const data = await buildTrmConfirmationPdfData(id)
        if (!data) { res.status(404).json({ error: 'Commande not found' }); return }
        attachments.push({
          filename: pdfFilename(data.numero),
          content: await renderTrmConfirmationPdf(data),
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

    // Audit into the shared envoi_email ledger, IDtype_doc = 7 like ETM's
    // confirmation. `notes` stays '' — that is what ETM's historique reads as
    // "confirmation de commande", and the id spaces cannot collide (one table).
    const allRecipients = [...parsed.data.to, ...(parsed.data.cc ?? []), ...(parsed.data.bcc ?? [])]
    let societe = ''
    try {
      const cr = await query<{ IDclient: number }>(`SELECT IDclient FROM commande_client WHERE IDcommande_client = ${id}`)
      const names = await resolveClientNames([Number(cr[0]?.IDclient) || 0])
      societe = names.get(Number(cr[0]?.IDclient) || 0) ?? ''
    } catch { /* informational */ }
    await logEnvoiEmails(id, allRecipients, societe, TYPE_DOC_COMMANDE_CLIENT, '')

    res.json({ ok: true, messageId })
  } catch (err) {
    console.error('Error sending TRM commande email:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    res.status(500).json({ error: 'send_failed', message })
  }
})
