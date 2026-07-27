// Commandes sous-traitant — orders sent to subcontractors (knitters,
// dyers, makers). Phase 1 focuses on the **Ennoblisseur** (dyeing) flow:
// the order line references a `ref_ecru` greige reference + coloris, and
// the user can attach existing tombé-de-métier rolls (`stock_ecru`) to be
// sent to the dyer, then record the dyed rolls coming back (`stock_fini`).
//
// Mirrors the shape of `commandes-fil.ts` — every public concept here
// (header CRUD, line CRUD, status toggle, polymorphic ged docs, PDF,
// email) follows the same pattern. Differences are domain-specific:
//
// - Header status field is `est_soldee` BOOLEAN (0/1), not `etat` SMALLINT.
// - Per-line status is `sstatut` VARCHAR — Phase 1 maps the binary toggle
//   to the literal values `'En_Cours'` / `'Terminé'`. Other legacy values
//   (`Notification`, `Soumis_Au_Client`, …) are preserved on read but the
//   binary toggle never produces them.
// - `ligne_commande_sous_traitant.date_delai` preserves the **original**
//   delivery date the first time `date_livraison` is rescheduled. After
//   that, `date_delai` is frozen.
// - Yarn allocation (commande_fil's `stock_fil.IDref_fil_commande` pattern)
//   is replaced here by `stock_ecru.IDref_commande_affectation` and
//   `stock_fini.IDref_commande_source` — both pointing at
//   `IDligne_commande_sous_traitant`. Verified empirically against legacy
//   data by `inspect-pieces-flow.ts`.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import multer from 'multer'
import { renderToBuffer } from '@react-pdf/renderer'
import React from 'react'
import { query, queryRaw, fixEncoding } from '../lib/hfsql-auto.js'
import {
  CommandeSoustraitantPdf,
  type CommandeSoustraitantPdfData,
} from '../lib/pdf/CommandeSoustraitantPdf.js'
import {
  SoumissionLotPdf,
  type SoumissionLotPdfData,
} from '../lib/pdf/SoumissionLotPdf.js'
import { sendMail } from '../lib/gmail.js'
import { getUserEmail } from '../lib/user-emails.js'
import { stripRtf, wrapRtf } from '../lib/rtf-utils.js'
import { trmLinePrix } from '../lib/pricing-trm.js'
import { recalcLignePrix, hasTariffData, calcTarifSSTBreakdown, type PrixBreakdown } from '../lib/pricing-sst.js'
import { resolveSearch, type SearchHits } from '../lib/sst-search-cache.js'
import {
  IS_WINDOWS,
  esc,
  n,
  dateDigits as dateStr,
  addWorkingDays,
  STATUT_OPEN,
  STATUT_NON_ENVOYE,
  STATUT_ATTENTE_DELAI,
  isLineDone,
  lineStatutRank,
} from '../lib/sst-shared.js'

const upload = multer({ storage: multer.memoryStorage() })

/** Soumis-detection predicate that's safe on both Windows ODBC (accepts
 *  the accented `invalidé` column) and the Linux iODBC bridge (rejects it
 *  outright — the bridge can't tokenize accented identifiers, so the SQL
 *  must omit the column reference). On Linux the caller's WHERE clause
 *  drops the `invalidé` filter and falls back to a JS-level prune via
 *  `filterActiveSoumisRows`. */
const SOUMIS_INVALIDE_SQL_PREDICATE = IS_WINDOWS
  ? `AND (invalidé = 0 OR invalidé IS NULL)`
  : ''

/** JS-level filter that removes invalidated soumis rows from a result set
 *  that omitted the SQL predicate (Linux path). Uses both the truncated
 *  (`invalid`, what the bridge surfaces) and intact (`invalidé`) column
 *  keys so the helper is also safe to call on Windows-shaped rows. Pass a
 *  SELECT * row set. */
function filterActiveSoumisRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.filter((r) => {
    const flag = Number((r as any).invalid ?? (r as any)['invalidé'] ?? 0)
    return flag === 0
  })
}

export const commandesSousTraitantRouter: RouterType = Router()

// ── Status string conventions ───────────────────────────
//
// Legacy `sstatut` values (count from production HFSQL):
//   "Terminé" 4616, "Notification" 1101, "En_Cours" 859, "Soumis_Au_Client"
//   259, "Non_Affecté" 186, "Attente_Delai" 128, "Delai_Expiré" 46,
//   "Non_Envoye" 18, "En_Contrôle" 15, "En_Création" 11, "A_Soumettre" 6,
//   "En_Reprise" 2.
// MPS_NG wires three of them into a state machine:
//   - Non_Envoye      → line just created, bon de commande not sent yet
//   - Attente_Delai   → bon de commande sent (envoi_email IDtype_doc=13),
//                       waiting on the sst to confirm a delivery date
//   - En_Cours        → user edited date_livraison after the bon de
//                       commande was sent (sst has confirmed)
// Other legacy values (Notification, Non_Affecté, …) are preserved on read
// but never written from MPS_NG; phase computation treats them as the
// generic "open / progressed" bucket alongside En_Cours.

// The `sstatut` state-machine constants (STATUT_*), `isLineDone`,
// `lineStatutRank`, and the pure SQL/date helpers (esc, n, dateStr,
// addWorkingDays, IS_WINDOWS) now live in `../lib/sst-shared.js` and are
// imported above so the Rapports endpoints can reuse them.

// ── Types ────────────────────────────────────────────────

interface CommandeSousTraitantHeader {
  IDcommande_sous_traitant: number
  IDsous_traitant: number
  IDadresse_sous_traitant: number | null
  IDadresse_livraison: number | null
  date_commande: string | null
  commentaire: string | null
  est_soldee: number | null
  IDdossier: number | null
  IDcommande_client: number | null
  date_notif: string | null
  IDligne_commande_client: number | null
  journal: string | null
}

// ── Helpers ──────────────────────────────────────────────

/** SQL literal for a user-supplied text value written to an HFSQL column.
 *
 *  Pure-ASCII values use a normal quoted literal (readable in logs).
 *  Values containing accented / non-ASCII characters are emitted as a hex
 *  literal `x'<bytes>'` instead: the Linux iODBC bridge corrupts raw
 *  multi-byte UTF-8 embedded in the SQL line — it desyncs the query
 *  pipeline and HFSQL then reports "string without end" parse errors
 *  (a reception with "tâche d'encre" in the observations 500'd this way).
 *  HFSQL text columns are ANSI/Latin-1 natively, so we encode the value
 *  to Latin-1 (Windows-1252) bytes; the hex literal is pure ASCII in
 *  transit and stores the exact bytes. Reads keep going through
 *  fixEncoding()/CONVERT as before. Smart punctuation that isn't in
 *  Latin-1 is degraded to ASCII; anything still out of range becomes '?'. */
function sqlText(value: string | null | undefined): string {
  const v = (value ?? '').toString()
  if (v === '') return "''"
  // Fast path: tab/CR/LF + printable ASCII → normal escaped literal.
  if (/^[\x09\x0A\x0D\x20-\x7E]*$/.test(v)) return `'${esc(v)}'`
  const ascii = v
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—−]/g, '-')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
  const bytes = Buffer.from(
    Array.from(ascii, (ch) => {
      const c = ch.codePointAt(0) ?? 0x3F
      return c <= 0xFF ? c : 0x3F
    }),
  )
  return `x'${bytes.toString('hex')}'`
}

/** Today + `n` working days, formatted as an HFSQL `YYYYMMDD` date string. */
function hfsqlDatePlusWorkingDays(n: number): string {
  const d = addWorkingDays(new Date(), n)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

// ── Commande lifecycle helpers ───────────────────────────

async function loadCommandeSoldee(commandeId: number): Promise<number | null> {
  const rows = await query<{ est_soldee: number | null }>(
    `SELECT est_soldee FROM commande_sous_traitant WHERE IDcommande_sous_traitant = ${commandeId}`,
  )
  if (rows.length === 0) return null
  return rows[0].est_soldee ?? 0
}

async function loadCommandeIdForLine(lineId: number): Promise<number | null> {
  const rows = await query<{ IDcommande_sous_traitant: number }>(
    `SELECT IDcommande_sous_traitant FROM ligne_commande_sous_traitant WHERE IDligne_commande_sous_traitant = ${lineId}`,
  )
  if (rows.length === 0) return null
  return Number(rows[0].IDcommande_sous_traitant) || null
}

function refuseIfTerminee(res: Response, est_soldee: number | null): boolean {
  if (est_soldee === 1) {
    res.status(409).json({
      error: 'commande_terminee',
      message: 'Commande terminée — réouvrir la commande pour modifier les lignes.',
    })
    return true
  }
  return false
}

/** Phase keyword → SstPhase override for the search bar smart filter.
 *  Matches are accent-stripped and lowercased. The simplified toggle bar
 *  only exposes open / terminee / all, so this is how the operator drills
 *  into a specific sub-phase ("rep", "soum", "dela", "term", …).
 *
 *  Order matters: when an input is ambiguous (e.g. "en c" matches both
 *  "en cours" and "en controle"), the FIRST entry wins. Listed roughly
 *  by frequency so the common case is one keystroke away. */
const PHASE_KEYWORD_ALIASES: Array<[string, SstPhase]> = [
  ['en cours', 'en_cours'],
  ['en controle', 'en_controle'],
  ['controle', 'en_controle'],
  ['en reprise', 'en_reprise'],
  ['reprise', 'en_reprise'],
  ['attente delai', 'attente_delai'],
  ['attente', 'attente_delai'],
  ['delai', 'attente_delai'],
  ['non envoye', 'non_envoye'],
  ['envoye', 'non_envoye'],
  ['soumis', 'soumis'],
  ['terminee', 'terminee'],
  ['termine', 'terminee'],
]

function normalizePhaseQuery(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

/** Returns the matching phase if the user's query (a) is at least 3
 *  characters (avoids false positives on 1-2 char typeahead), AND (b)
 *  either prefixes one of the alias strings ("rep" → "reprise") or
 *  appears as a substring inside one ("dela" → "attente delai", "trole"
 *  → "en controle"). Prefix is tried first since it produces more
 *  intuitive results when both could apply. */
function matchPhaseKeyword(q: string): SstPhase | null {
  if (!q) return null
  const norm = normalizePhaseQuery(q)
  if (norm.length < 3) return null
  for (const [kw, phase] of PHASE_KEYWORD_ALIASES) {
    if (kw.startsWith(norm)) return phase
  }
  for (const [kw, phase] of PHASE_KEYWORD_ALIASES) {
    if (kw.includes(norm)) return phase
  }
  return null
}

/** Whether a bon de commande email (envoi_email IDtype_doc=13) has been
 *  logged for this commande. Drives the initial sstatut on line creation:
 *  fresh commande → Non_Envoye; lines added after the bon de commande was
 *  already sent → Attente_Delai. */
async function hasBonDeCommandeBeenSent(commandeId: number): Promise<boolean> {
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM envoi_email
     WHERE IDtype_doc = 13 AND IDreference = ${commandeId}`,
  )
  return Number(rows[0]?.n) > 0
}

/** Flip est_soldee to 1 when every line is in the done state. */
async function maybeAutoCloseCommande(commandeId: number): Promise<void> {
  const lines = await query<{ sstatut: string | null }>(
    `SELECT sstatut FROM ligne_commande_sous_traitant WHERE IDcommande_sous_traitant = ${commandeId}`,
  )
  if (lines.length === 0) return
  if (!lines.every((l) => isLineDone(l.sstatut))) return
  await query(
    `UPDATE commande_sous_traitant SET est_soldee = 1 WHERE IDcommande_sous_traitant = ${commandeId} AND est_soldee = 0`,
  )
}

/** Look up the type label for a sous-traitant — used to gate ennoblisseur features. */
async function loadSousTraitantType(IDsous_traitant: number): Promise<{ IDtype_sst: number; type: string | null } | null> {
  const rows = await query<{ IDtype_sst: number; type: unknown }>(
    `SELECT st.IDtype_sst, CONVERT(ts.type USING 'UTF-8') AS type
     FROM sous_traitant st
     LEFT JOIN type_sst ts ON st.IDtype_sst = ts.IDtype_sst
     WHERE st.IDsous_traitant = ${IDsous_traitant}`,
  )
  if (rows.length === 0) return null
  const r = rows[0]
  let typeStr: string | null = null
  if (r.type instanceof ArrayBuffer) typeStr = Buffer.from(r.type).toString('utf8')
  else if (typeof r.type === 'string') typeStr = r.type
  return { IDtype_sst: Number(r.IDtype_sst) || 0, type: typeStr }
}

// ── ETM ↔ TRM bridge helpers ─────────────────────────────
//
// Two-company shared DB: ETM (this app, IDsociete=1, sst ledger) and TRM
// (Tricotage Malterre, IDsociete=2, client ledger; ETM is its IDclient=1,
// the sister knitter on IDsous_traitant=1). The auto-mirror logic
// (commande_client + line back-pointers via IDcommande_ETM / IDligne_commande_ETM)
// is SPECIFIC to the sister-company relationship. Other tricoteur
// sous-traitants (JERSEY DE LA BUCHE, MAILL'TUB, AET — IDtype_sst=1 but
// IDsous_traitant != 1) are external suppliers; they get the standard
// sous-traitant workflow without any cross-ledger mirror. Reception of
// their rolls happens via the regular legacy paths, not via the
// IDref_commande_source stamp TRM's app applies.
//
// Full spec in memory [[project-etm-trm-bridge]].

/** Identity of the sister-company knitter. Hardcoded as IDsous_traitant=1
 *  in the legacy DB. If TRM is ever rekeyed, this is the single point of
 *  update; do not scatter "= 1" comparisons through the file. */
export const TRICOTAGE_MALTERRE_ID = 1

/** True if the commande_sst's sous-traitant has IDtype_sst=1 (Tricoteur).
 *  Used to default line.type / unite / prix for ANY tricoteur — including
 *  external ones — because those defaults aren't TRM-specific. */
async function isTricoteurSst(sstId: number): Promise<boolean> {
  const r = await query<{ IDtype_sst: number | null }>(
    `SELECT st.IDtype_sst FROM commande_sous_traitant cst
     JOIN sous_traitant st ON st.IDsous_traitant = cst.IDsous_traitant
     WHERE cst.IDcommande_sous_traitant = ${sstId}`,
  )
  return Number(r[0]?.IDtype_sst) === 1
}

/** True iff the commande_sst targets Tricotage Malterre (the sister
 *  company). This is the gate that activates the TRM mirror — NOT
 *  `isTricoteurSst`, which would catch external tricoteurs too. */
async function isTricotageMalterreSst(sstId: number): Promise<boolean> {
  const r = await query<{ IDsous_traitant: number | null }>(
    `SELECT IDsous_traitant FROM commande_sous_traitant
     WHERE IDcommande_sous_traitant = ${sstId}`,
  )
  return Number(r[0]?.IDsous_traitant) === TRICOTAGE_MALTERRE_ID
}

/** Return the TRM-side IDcommande_client mirroring this ETM sst, or null. */
async function getTrmMirror(sstId: number): Promise<number | null> {
  const r = await query<{ IDcommande_client: number }>(
    `SELECT IDcommande_client FROM commande_client WHERE IDcommande_ETM = ${sstId}`,
  )
  return r.length === 0 ? null : Number(r[0].IDcommande_client) || null
}

/** Return the TRM-side IDligne_commande_client mirroring this ETM sst line. */
async function getTrmMirrorLine(sstLineId: number): Promise<number | null> {
  const r = await query<{ IDligne_commande_client: number }>(
    `SELECT IDligne_commande_client FROM ligne_commande_client WHERE IDligne_commande_ETM = ${sstLineId}`,
  )
  return r.length === 0 ? null : Number(r[0].IDligne_commande_client) || null
}

/** Next numero sequence for the TRM ledger (IDsociete=2). Legacy data has
 *  gaps (one observed between 2792 and 2794), so MAX+1 matches the legacy
 *  allocator. Concurrent POSTs in the same tick can collide — the caller
 *  retries up to 3 times. */
async function nextTrmNumero(): Promise<number> {
  const r = await query<{ m: number | null }>(
    `SELECT MAX(numero) AS m FROM commande_client WHERE IDsociete = 2`,
  )
  return (Number(r[0]?.m) || 0) + 1
}

/** ref_ecru.prix for a given IDref_ecru — used to default tricoteur line
 *  prix on the ETM side AND mirror it on the TRM cc side. Returns 0 if
 *  the ref is unknown or has no price set. */
async function loadRefEcruPrix(IDref_ecru: number): Promise<number> {
  if (!(IDref_ecru > 0)) return 0
  const r = await query<{ prix: number | null }>(
    `SELECT prix FROM ref_ecru WHERE IDref_ecru = ${IDref_ecru}`,
  )
  return Number(r[0]?.prix) || 0
}

/** ref_ecru.reference for a given IDref_ecru, for the ref_client display
 *  string on the TRM cc. Returns '' on miss. */
async function loadRefEcruReference(IDref_ecru: number): Promise<string> {
  if (!(IDref_ecru > 0)) return ''
  const r = await query<{ reference: string | null }>(
    `SELECT reference FROM ref_ecru WHERE IDref_ecru = ${IDref_ecru}`,
  )
  return (r[0]?.reference ?? '').toString().trim()
}

/** Rebuild `commande_client.ref_client = "commande <sstId>, <ref1>, <ref2>, …"`
 *  by reading all cc lines' IDreference values and resolving to ref_ecru.reference.
 *  Matches legacy convention from sample cc 6885 ("commande 8582, 029"). */
async function refreshTrmRefClient(sstId: number, mirrorId: number): Promise<void> {
  const lines = await query<{ IDreference: number | null }>(
    `SELECT IDreference FROM ligne_commande_client WHERE IDcommande_client = ${mirrorId}`,
  )
  const ids = Array.from(new Set(
    lines.map((l) => Number(l.IDreference) || 0).filter((x) => x > 0),
  ))
  let refsStr = ''
  if (ids.length > 0) {
    const r = await query<{ IDref_ecru: number; reference: string | null }>(
      `SELECT IDref_ecru, reference FROM ref_ecru WHERE IDref_ecru IN (${ids.join(',')})`,
    )
    const fixed = await fixEncoding(r, 'ref_ecru', 'IDref_ecru', ['reference'])
    // Preserve the line insertion order from the previous query.
    const refByLine = new Map<number, string>()
    for (const row of fixed as any[]) refByLine.set(Number(row.IDref_ecru), (row.reference ?? '').toString().trim())
    const labels: string[] = []
    for (const l of lines) {
      const id = Number(l.IDreference) || 0
      const lbl = refByLine.get(id)
      if (lbl) labels.push(lbl)
    }
    refsStr = labels.length > 0 ? `, ${labels.join(', ')}` : ''
  }
  const refClient = `commande ${sstId}${refsStr}`
  await query(
    `UPDATE commande_client SET ref_client = '${esc(refClient)}' WHERE IDcommande_client = ${mirrorId}`,
  )
}

/** Returns true (and sets a 409 JSON response) if any ordre_fabrication
 *  is linked to this cc line — meaning TRM has started production and the
 *  line cannot be safely removed from MPS_NG. */
async function refuseIfTrmHasOFs(res: Response, ccLineId: number): Promise<boolean> {
  const r = await query<{ n: number | null }>(
    `SELECT COUNT(*) AS n FROM ordre_fabrication WHERE IDligne_commande_client = ${ccLineId}`,
  )
  const n = Number(r[0]?.n) || 0
  if (n > 0) {
    res.status(409).json({
      error: 'trm_production_started',
      message: 'Cette ligne ne peut pas être supprimée : Tricotage Malterre a déjà démarré la production.',
    })
    return true
  }
  return false
}

// ── Knit-order creation (used by the client-line Tricotage tab) ──
// Mirrors the legacy "Commande de Tricotage Malterre" modal generalized to any
// tricoteur: one commande at the knitter with a single tricoteur line.
// Template validated against legacy-created cst 8582: sst default addresses,
// empty RTF commentaire, line type=1 / unite=1 / empty dates. Statut and the
// cross-ledger mirror depend on the knitter:
//  - Tricotage Malterre (sister company): sstatut Attente_Delai (no
//    bon-de-commande step) + TRM commande_client mirror.
//  - External tricoteurs: sstatut Non_Envoye (standard workflow — the bon de
//    commande is sent from the Sous-traitants screen) and NO mirror.
// Prix follows the MPS_NG tricoteur convention (trmLinePrix — applies to ALL
// type=1 knitters) instead of legacy's sst-side 0.

export interface KnitOrderResult {
  IDcommande_sous_traitant: number
  IDligne_commande_sous_traitant: number
  prix: number
  mirror_status: 'created' | 'failed' | 'skipped'
}

export async function createKnitOrder(opts: {
  sstId: number
  ecruRefId: number
  coloriEcruId: number
  quantiteKg: number
  /** YYYYMMDD; defaults to today. */
  dateCommande?: string
}): Promise<KnitOrderResult> {
  const sstId = opts.sstId
  const isTrm = sstId === TRICOTAGE_MALTERRE_ID
  const dateCmd = dateStr(opts.dateCommande) || dateStr(new Date().toISOString().slice(0, 10))

  // The knitter's default addresses (legacy modal uses them for both header
  // fields — adresse 777 on the TRM reference commande). Fallback to the
  // first visible one.
  const adrRows = await query<{ IDadresse: number; est_defaut: number | null; est_defaut_livraison: number | null }>(
    `SELECT IDadresse, est_defaut, est_defaut_livraison FROM adresse
      WHERE IDsous_traitant = ${sstId} AND est_visible = 1`,
  )
  const defaut = adrRows.find((a) => Number(a.est_defaut) === 1) ?? adrRows[0]
  const defautLiv = adrRows.find((a) => Number(a.est_defaut_livraison) === 1) ?? defaut
  const adrId = Number(defaut?.IDadresse) || 0
  const adrLivId = Number(defautLiv?.IDadresse) || 0

  await query(
    `INSERT INTO commande_sous_traitant
     (IDsous_traitant, date_commande, est_soldee, commentaire, journal,
      IDadresse_sous_traitant, IDadresse_livraison, IDdossier, IDcommande_client, IDligne_commande_client)
     VALUES (${sstId}, '${dateCmd}', 0, '${esc(wrapRtf(''))}', '',
             ${adrId}, ${adrLivId}, 0, 0, 0)`,
  )
  const hdr = await query<{ IDcommande_sous_traitant: number }>(
    `SELECT IDcommande_sous_traitant FROM commande_sous_traitant
      WHERE IDsous_traitant = ${sstId} ORDER BY IDcommande_sous_traitant DESC`,
  )
  const cmdId = Number(hdr[0]?.IDcommande_sous_traitant) || 0
  if (cmdId <= 0) throw new Error('Header insert lookup failed')

  // Mirror header on the TRM ledger — sister company only (numero allocator
  // with collision retry, same pattern as the standard POST '/').
  let mirrorStatus: 'created' | 'failed' | 'skipped' = isTrm ? 'failed' : 'skipped'
  if (isTrm) {
    try {
      let inserted = false
      let lastErr: unknown = null
      for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
        const numero = await nextTrmNumero()
        try {
          await query(
            `INSERT INTO commande_client
             (IDclient, IDsociete, IDcommande_ETM, numero, date_commande,
              IDadresse_livraison, IDadresse_facturation, IDmode_paiement, IDecheance,
              ref_client, commentaire, est_soldee, remise, donation,
              attente_paiement, frais_port, IDdossier)
             VALUES (1, 2, ${cmdId}, ${numero}, '${dateCmd}',
                     1, 1, 3, 2,
                     'commande ${cmdId}', '', 0, 0, 0,
                     0, 0, 0)`,
          )
          inserted = true
        } catch (e) { lastErr = e }
      }
      if (!inserted) throw lastErr ?? new Error('mirror insert failed after 3 attempts')
      mirrorStatus = 'created'
    } catch (e) {
      console.error('[trm-bridge] mirror CREATE failed for knit order', cmdId, e)
    }
  }

  // Tricoteur line — prix via the MPS_NG cost model (see pricing-trm.ts).
  const prix = await trmLinePrix(opts.ecruRefId, opts.quantiteKg)
  const statut = isTrm ? STATUT_ATTENTE_DELAI : STATUT_NON_ENVOYE
  await query(
    `INSERT INTO ligne_commande_sous_traitant
     (IDcommande_sous_traitant, type, IDreference, IDColoris, quantite, unite, prix,
      date_livraison, date_delai, sstatut, commentaire)
     VALUES (${cmdId}, 1, ${opts.ecruRefId}, ${opts.coloriEcruId}, ${n(opts.quantiteKg)}, 1, ${n(prix)},
             '', '', '${statut}', '')`,
  )
  const lineRows = await query<{ IDligne_commande_sous_traitant: number }>(
    `SELECT IDligne_commande_sous_traitant FROM ligne_commande_sous_traitant
      WHERE IDcommande_sous_traitant = ${cmdId} ORDER BY IDligne_commande_sous_traitant DESC`,
  )
  const lineId = Number(lineRows[0]?.IDligne_commande_sous_traitant) || 0
  if (lineId <= 0) throw new Error('Line insert lookup failed')

  // Mirror line on the TRM cc (lowercase IDcolori quirk preserved).
  if (mirrorStatus === 'created') {
    try {
      const mirrorId = await getTrmMirror(cmdId)
      if (mirrorId == null) throw new Error('mirror cc not found')
      await query(
        `INSERT INTO ligne_commande_client
         (IDcommande_client, IDligne_commande_ETM, TYPE, IDreference, IDcolori,
          quantite, unite, prix, poids, date_livraison, commentaire)
         VALUES (${mirrorId}, ${lineId}, 1, ${opts.ecruRefId}, ${opts.coloriEcruId},
                 ${n(opts.quantiteKg)}, 1, ${n(prix)}, 0, '', '')`,
      )
      await refreshTrmRefClient(cmdId, mirrorId)
    } catch (e) {
      console.error('[trm-bridge] LINE CREATE mirror failed for knit order', cmdId, 'line', lineId, e)
      mirrorStatus = 'failed'
    }
  }

  return { IDcommande_sous_traitant: cmdId, IDligne_commande_sous_traitant: lineId, prix, mirror_status: mirrorStatus }
}

// ── Validation schemas ───────────────────────────────────

const commandeBody = z.object({
  IDsous_traitant: z.number().int().positive(),
  date_commande: z.string().optional(),
  IDadresse_sous_traitant: z.number().int().nonnegative().optional(),
  IDadresse_livraison: z.number().int().nonnegative().optional(),
  commentaire: z.string().optional(),
  journal: z.string().optional(),
  date_notif: z.string().optional(),
  est_soldee: z.number().int().min(0).max(1).optional(),
})

const ligneBody = z.object({
  type: z.number().int().optional(),
  IDreference: z.number().int().nonnegative().optional(),
  IDColoris: z.number().int().nonnegative().optional(),
  quantite: z.number().optional(),
  unite: z.number().int().optional(),
  prix: z.number().optional(),
  date_livraison: z.string().optional(),
  sstatut: z.string().optional(),
  commentaire: z.string().optional(),
})

// ── Lookups ──────────────────────────────────────────────

commandesSousTraitantRouter.get('/lookups/sous-traitants', async (req: Request, res: Response) => {
  try {
    const typeFilter = String(req.query.type ?? '').trim().toLowerCase()
    // Joining sous_traitant with type_sst + CONVERT() in one query collapses
    // the result set to a single row in HFSQL ODBC (likely a quirk with the
    // reserved-word column `type`). Split into two queries and merge in JS.
    // Note: do NOT CONVERT(tel) here — it silently truncates the result
    // set in HFSQL ODBC (suspect: empty/non-text values choke the CONVERT
    // function in this driver). `tel` is plain digits + spaces, no accents,
    // so it doesn't need decoding anyway.
    const rows = await query<{ IDsous_traitant: number; nom: unknown; tel: unknown; IDtype_sst: number | null }>(
      `SELECT IDsous_traitant,
              CONVERT(nom USING 'UTF-8') AS nom,
              tel,
              IDtype_sst
       FROM sous_traitant
       WHERE est_visible = 1
       ORDER BY nom`,
    )
    const decode = (v: unknown): string | null => {
      if (v instanceof ArrayBuffer) return Buffer.from(v).toString('utf8')
      if (typeof v === 'string') return v
      return null
    }
    const typeMap = new Map<number, string>()
    const tsRows = await query<{ IDtype_sst: number; v: unknown }>(
      `SELECT IDtype_sst, CONVERT(type USING 'UTF-8') AS v FROM type_sst`,
    )
    for (const t of tsRows) {
      const lbl = decode((t as any).v)
      if (lbl !== null) typeMap.set(Number(t.IDtype_sst), lbl)
    }
    const decoded = rows.map((r) => ({
      IDsous_traitant: Number(r.IDsous_traitant),
      nom: decode(r.nom),
      tel: decode(r.tel),
      IDtype_sst: r.IDtype_sst,
      type: r.IDtype_sst ? typeMap.get(Number(r.IDtype_sst)) ?? null : null,
    }))
    const filtered = typeFilter
      ? decoded.filter((r) => (r.type ?? '').toLowerCase().includes(typeFilter))
      : decoded
    res.json(filtered)
  } catch (err) {
    console.error('Error fetching sous-traitants lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesSousTraitantRouter.get('/lookups/adresses', async (req: Request, res: Response) => {
  try {
    const sid = parseInt(String(req.query.sous_traitant ?? ''), 10)
    if (isNaN(sid)) { res.status(400).json({ error: 'sous_traitant query parameter required' }); return }

    const rows = await query(
      `SELECT * FROM adresse WHERE IDsous_traitant = ${sid} AND (est_visible IS NULL OR est_visible = 1) ORDER BY est_defaut DESC, IDadresse`,
    )
    const fixed = await fixEncoding(rows, 'adresse', 'IDadresse', [
      'nom',
      'adresse1',
      'adresse2',
      'adresse3',
      'ville',
      'pays',
      'commentaire',
    ])
    res.json(fixed)
  } catch (err) {
    console.error('Error fetching adresses lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Phase 1: ref_ecru + colori_ecru pairs for the line picker (ennoblisseur flow).
// Two flat queries are merged in JS — JOINs in HFSQL ODBC sometimes truncate
// the result set (the same quirk we hit on sous_traitant + type_sst).
commandesSousTraitantRouter.get('/lookups/refs-ecru', async (_req: Request, res: Response) => {
  try {
    const refRows = await query<{ IDref_ecru: number; reference: string | null }>(
      `SELECT IDref_ecru, reference FROM ref_ecru ORDER BY reference`,
    )
    const fixedRefs = await fixEncoding(refRows, 'ref_ecru', 'IDref_ecru', ['reference'])

    const coloriRows = await query<{ IDcolori_ecru: number; IDref_ecru: number; reference: string | null }>(
      `SELECT IDcolori_ecru, IDref_ecru, reference FROM colori_ecru ORDER BY reference`,
    )
    const fixedColoris = await fixEncoding(coloriRows, 'colori_ecru', 'IDcolori_ecru', ['reference'])

    const refLabel = new Map<number, string>()
    for (const r of fixedRefs) refLabel.set(r.IDref_ecru, r.reference ?? '')

    res.json(
      fixedColoris.map((c) => ({
        IDref_ecru: Number(c.IDref_ecru),
        IDcolori_ecru: Number(c.IDcolori_ecru),
        ref_ecru: refLabel.get(Number(c.IDref_ecru)) ?? '',
        colori_reference: c.reference ?? '',
      })),
    )
  } catch (err) {
    console.error('Error fetching refs-ecru lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Flat ref_ecru list for the tricoteur line picker. Distinct from
// `/lookups/refs-ecru` (which produces (ref_ecru, colori_ecru) pairs for
// the ennoblisseur affectation drawer). Tricoteur lines pick a ref_ecru,
// then a colori_ecru via /lookups/colori-ecru.
commandesSousTraitantRouter.get('/lookups/refs-ecru-list', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDref_ecru: number; reference: string | null; designation: string | null; prix: number | null }>(
      `SELECT IDref_ecru, reference, designation, prix FROM ref_ecru ORDER BY reference`,
    )
    const fixed = await fixEncoding(rows, 'ref_ecru', 'IDref_ecru', ['reference', 'designation'])
    res.json(
      fixed.map((r) => ({
        IDref_ecru: Number(r.IDref_ecru),
        ref_ecru: r.reference ?? '',
        designation: r.designation ?? '',
        prix: Number(r.prix) || 0,
      })),
    )
  } catch (err) {
    console.error('Error fetching refs-ecru-list lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// colori_ecru variants for a given ref_ecru — used by the tricoteur line
// editor's coloris picker. The legacy schema keys colori_ecru on
// IDref_ecru directly (each variant belongs to one ref_ecru).
commandesSousTraitantRouter.get('/lookups/colori-ecru', async (req: Request, res: Response) => {
  try {
    const refEcruId = parseInt(String(req.query.ref_ecru ?? ''), 10)
    if (isNaN(refEcruId) || refEcruId <= 0) {
      res.status(400).json({ error: 'ref_ecru query parameter required' })
      return
    }
    const rows = await query<{ IDcolori_ecru: number; reference: string | null }>(
      `SELECT IDcolori_ecru, reference FROM colori_ecru
       WHERE IDref_ecru = ${refEcruId}
       ORDER BY reference`,
    )
    const fixed = await fixEncoding(rows, 'colori_ecru', 'IDcolori_ecru', ['reference'])
    res.json(
      fixed.map((r) => ({
        IDcolori_ecru: Number(r.IDcolori_ecru),
        reference: r.reference ?? '',
      })),
    )
  } catch (err) {
    console.error('Error fetching colori-ecru lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ref_fini list for the line picker / reception form.
commandesSousTraitantRouter.get('/lookups/refs-fini', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDref_fini: number; reference: string | null; designation: string | null }>(
      `SELECT IDref_fini, reference, designation FROM ref_fini ORDER BY reference`,
    )
    const fixed = await fixEncoding(rows, 'ref_fini', 'IDref_fini', ['reference', 'designation'])
    res.json(
      fixed.map((r) => ({
        IDref_fini: Number(r.IDref_fini),
        ref_fini: r.reference ?? '',
        designation: r.designation ?? '',
      })),
    )
  } catch (err) {
    console.error('Error fetching refs-fini lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Coloris options for a given ref_fini. The legacy table is `ref_fini_colori`
// (NOT `colori_fini`, which is a different M:N junction). Each row is one
// (ref_fini, coloris) pair — `IDref_fini_colori` is the ID stored in
// `ligne_commande_sous_traitant.IDColoris` and `stock_fini.IDColoris`.
commandesSousTraitantRouter.get('/lookups/colori-fini', async (req: Request, res: Response) => {
  try {
    const refFiniId = parseInt(String(req.query.ref_fini ?? ''), 10)
    if (isNaN(refFiniId) || refFiniId <= 0) {
      res.status(400).json({ error: 'ref_fini query parameter required' })
      return
    }
    const rows = await query<{ IDref_fini_colori: number; reference: string | null }>(
      `SELECT IDref_fini_colori, reference FROM ref_fini_colori
       WHERE IDref_fini = ${refFiniId}
       ORDER BY reference`,
    )
    const fixed = await fixEncoding(rows, 'ref_fini_colori', 'IDref_fini_colori', ['reference'])
    res.json(
      fixed.map((r) => ({
        IDref_fini_colori: Number(r.IDref_fini_colori),
        reference: r.reference ?? '',
      })),
    )
  } catch (err) {
    console.error('Error fetching colori-fini lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Reuse the same magasin lookup that other screens will need.
commandesSousTraitantRouter.get('/lookups/magasins', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDmagasin: number; nom: string | null }>(
      `SELECT IDmagasin, nom FROM magasin ORDER BY nom`,
    )
    const fixed = await fixEncoding(rows, 'magasin', 'IDmagasin', ['nom'])
    res.json(fixed)
  } catch (err) {
    console.error('Error fetching magasins lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Urgency bucket helper ────────────────────────────────
//
// Mirrors the frontend frame-colour logic so the header pills count
// exactly the cards that render as red / amber:
//   - attente_delai → the commande's `date_notif` relance date
//     (<= today → late, last working day before it → soon, otherwise no
//     frame). Legacy commandes with no date_notif fall back to the bon de
//     commande send date + 3 working days. Weekends are skipped; French
//     bank holidays are not considered.
//   - any other open phase → earliest open-line `date_livraison` deadline
//     (<= today → late, within 3 days → soon). Open commandes with no
//     valid earliest delivery are treated as late, matching the frontend
//     `deliveryUrgency` fallback.
//   - terminée → never urgent.
//
// Returns the set of IDs for each bucket so callers can either count them
// (pill endpoint) or use them as an IN-list filter (list endpoint).
async function computeUrgencyBuckets(): Promise<{
  late: Set<number>
  soon: Set<number>
}> {
  const empty = { late: new Set<number>(), soon: new Set<number>() }
  const openRows = await query<{ IDcommande_sous_traitant: number; date_notif: string | null }>(
    `SELECT IDcommande_sous_traitant, date_notif FROM commande_sous_traitant WHERE est_soldee = 0`,
  )
  const openIds = openRows.map((r) => Number(r.IDcommande_sous_traitant)).filter((n) => n > 0)
  if (openIds.length === 0) return empty

  // Relance date per commande (`date_notif`, HFSQL YYYYMMDD). Drives the
  // attente_delai urgency frame.
  const dateNotifByCmd = new Map<number, string>()
  for (const r of openRows) {
    const dn = (r.date_notif ?? '').toString()
    if (/^\d{8}$/.test(dn)) dateNotifByCmd.set(Number(r.IDcommande_sous_traitant), dn)
  }
  const idList = openIds.join(',')

  // Phase per open commande — reuses the same batched logic as the list
  // endpoint so the bucket boundaries stay in sync.
  const phaseMap = await computePhasesBatch(openIds.map((id) => ({ id, est_soldee: 0 })))

  // Earliest open-line delivery deadline per commande (min over lines
  // whose sstatut != Terminé). Open lines with no valid date_livraison
  // contribute nothing; the commande's earliest stays null in that case.
  const lineRows = await query<{
    IDcommande_sous_traitant: number
    sstatut: string | null
    date_livraison: string | null
  }>(
    `SELECT IDcommande_sous_traitant, sstatut, date_livraison
     FROM ligne_commande_sous_traitant
     WHERE IDcommande_sous_traitant IN (${idList})`,
  )
  const earliestByCmd = new Map<number, string | null>()
  for (const l of lineRows) {
    const cid = Number(l.IDcommande_sous_traitant)
    if (!earliestByCmd.has(cid)) earliestByCmd.set(cid, null)
    if (isLineDone(l.sstatut)) continue
    const dl = typeof l.date_livraison === 'string' ? l.date_livraison : ''
    if (!/^\d{8}$/.test(dl)) continue
    const prev = earliestByCmd.get(cid) ?? null
    if (prev === null || dl < prev) earliestByCmd.set(cid, dl)
  }

  // Latest bon de commande send date per attente_delai commande.
  const attenteDelaiIds = openIds.filter((id) => phaseMap.get(id) === 'attente_delai')
  const lastSent = new Map<number, string>()
  if (attenteDelaiIds.length > 0) {
    const sendRows = await query<{ IDreference: number; DATE: string | null }>(
      `SELECT IDreference, DATE FROM envoi_email
       WHERE IDtype_doc = 13 AND IDreference IN (${attenteDelaiIds.join(',')})`,
    )
    for (const r of sendRows) {
      const cid = Number(r.IDreference)
      const raw = (r.DATE ?? '').toString()
      if (!cid || !raw) continue
      const day = raw.slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
      const prev = lastSent.get(cid)
      if (!prev || day > prev) lastSent.set(cid, day)
    }
  }

  const today = new Date(); today.setHours(0, 0, 0, 0)
  const late = new Set<number>()
  const soon = new Set<number>()
  for (const id of openIds) {
    const phase = phaseMap.get(id) ?? 'en_cours'
    if (phase === 'attente_delai') {
      // Effective relance date: the stored `date_notif` when set, else the
      // bon de commande send date + 3 working days — the fallback keeps
      // legacy commandes (no date_notif) consistent with the seed rule.
      let notif: Date | null = null
      const dn = dateNotifByCmd.get(id)
      if (dn) {
        notif = new Date(Number(dn.slice(0, 4)), Number(dn.slice(4, 6)) - 1, Number(dn.slice(6, 8)))
        notif.setHours(0, 0, 0, 0)
      } else {
        const iso = lastSent.get(id)
        if (iso) {
          const sent = new Date(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)))
          notif = addWorkingDays(sent, 3)
        }
      }
      if (!notif) continue
      // Red on the relance day and after; amber on the last working day
      // before it (so a Monday relance turns the card amber on Friday,
      // not over the weekend the employee can't act on).
      if (notif.getTime() <= today.getTime()) late.add(id)
      else if (notif.getTime() <= addWorkingDays(today, 1).getTime()) soon.add(id)
      continue
    }
    // All other open phases — deadline-based, matching `deliveryUrgency`.
    const earliest = earliestByCmd.get(id) ?? null
    if (!earliest) { late.add(id); continue }
    const y = Number(earliest.slice(0, 4))
    const m = Number(earliest.slice(4, 6)) - 1
    const d = Number(earliest.slice(6, 8))
    const target = new Date(y, m, d); target.setHours(0, 0, 0, 0)
    const diff = Math.round((target.getTime() - today.getTime()) / 86_400_000)
    if (diff <= 0) late.add(id)
    else if (diff <= 3) soon.add(id)
  }
  return { late, soon }
}

// ── Urgency pill counts ──────────────────────────────────
//
// Surfaces the two scalars driving the header pills:
//   - `late`: every open commande currently rendering as a red frame
//   - `soon`: every open commande currently rendering as an amber frame
// See `computeUrgencyBuckets` for the per-phase rules. Registered before
// `/:id` so the literal path wins the Express match.
commandesSousTraitantRouter.get('/urgency-counts', async (_req: Request, res: Response) => {
  try {
    const { late, soon } = await computeUrgencyBuckets()
    res.json({ late: late.size, soon: soon.size })
  } catch (err) {
    console.error('Error fetching urgency counts:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── List all commandes ───────────────────────────────────

commandesSousTraitantRouter.get('/', async (req: Request, res: Response) => {
  try {
    const q = String(req.query.q ?? '').trim()
    const stFilter = parseInt(String(req.query.sous_traitant ?? ''), 10)
    const statusFilterRaw = String(req.query.status ?? 'all')

    // Keyset pagination: the frontend can pass `limit` (default 100, max 500)
    // and `before_id` (the last IDcommande_sous_traitant it has). We sort by
    // ID descending so "before_id" means "give me older commandes". Sorting
    // by ID rather than date_commande is required for keyset to be stable —
    // and IDs are sequential so the visible order barely changes.
    //
    // Search (`q` non-empty) is pushed down to SQL via `resolveSearch()`,
    // which matches the query tokens against in-process caches of the
    // sous_traitant + ref/coloris catalog tables and returns the matching
    // IDs. Those IDs become IN-list predicates on the main commande query
    // (sst match) and on a `ligne_commande_sous_traitant` sub-SELECT (ref +
    // coloris match per polymorphic `type`). We keep `TOP limit` even on
    // search — a typeahead doesn't need 4000 hits. `commentaire` is no
    // longer fetched/stripped because the list card doesn't render it.
    //
    // Smart phase-keyword override: the simplified toggle bar only offers
    // open / terminee / all, so sub-phase narrowing has moved to the search
    // bar. When `q` (accent-stripped, lowercased) exactly matches one of
    // the known phase keywords, we override statusFilter to that phase and
    // skip the catalog search. Compound queries like "MATEL reprise" are
    // intentionally NOT supported in v1 — a future iteration can tokenise.
    const phaseFromKeyword = matchPhaseKeyword(q)
    const statusFilter = phaseFromKeyword ?? statusFilterRaw
    const isSearching = q.length > 0 && phaseFromKeyword === null
    const limitRaw = parseInt(String(req.query.limit ?? ''), 10)
    const limit = isNaN(limitRaw) ? 100 : Math.min(Math.max(limitRaw, 1), 500)
    const beforeIdRaw = parseInt(String(req.query.before_id ?? ''), 10)
    const beforeId = isNaN(beforeIdRaw) || beforeIdRaw <= 0 ? null : beforeIdRaw

    let hits: SearchHits | null = null
    if (isSearching) {
      try {
        hits = await resolveSearch(q)
      } catch (err) {
        console.error('Search cache resolve failed:', err)
        hits = null
      }
    }

    const whereParts: string[] = []
    if (!isNaN(stFilter)) whereParts.push(`cst.IDsous_traitant = ${stFilter}`)

    // Status filter — accepts:
    //   - 'all'        → no predicate (everything)
    //   - 'open'       → est_soldee = 0 (macro filter for the simplified
    //                    toggle bar — covers non_envoye / attente_delai /
    //                    en_cours / en_controle / soumis / en_reprise)
    //   - 'terminee'   → est_soldee = 1
    //   - any SstPhase → sub-phase classification within est_soldee = 0
    //                    (pre-resolved via signal sets so the SQL can
    //                    narrow to IN (...) and pagination stays stable)
    const SUB_PHASES: SstPhase[] = ['non_envoye', 'attente_delai', 'en_cours', 'en_controle', 'soumis', 'en_reprise']
    if (statusFilter === 'terminee') {
      whereParts.push(`cst.est_soldee = 1`)
    } else if (statusFilter === 'open') {
      whereParts.push(`cst.est_soldee = 0`)
    } else if (SUB_PHASES.includes(statusFilter as SstPhase)) {
      whereParts.push(`cst.est_soldee = 0`)
      // Resolve the three signal ID sets — scoped to open commandes for
      // efficiency. We compute the phase priority (reprise > soumis >
      // en_controle > en_cours) by set subtraction.
      const [repriseRows, soumisRows, receptionRows] = await Promise.all([
        query<{ IDcommande_sous_traitant: number }>(
          `SELECT DISTINCT lcs.IDcommande_sous_traitant
           FROM stock_fini sf
           JOIN ligne_commande_sous_traitant lcs
             ON lcs.IDligne_commande_sous_traitant = sf.IDref_commande_source
           JOIN commande_sous_traitant cst
             ON cst.IDcommande_sous_traitant = lcs.IDcommande_sous_traitant
           WHERE sf.IDetat_stock_fini = 2 AND cst.est_soldee = 0`,
        ),
        // Soumis IDs — non-invalidé emails on open commandes. SQL omits
        // the `invalidé` predicate on Linux (iODBC tokenizer chokes on
        // accented identifiers); we fall back to a JS filter using
        // `filterActiveSoumisRows`. On Windows the SQL predicate prunes
        // server-side, JS filter is a no-op.
        IS_WINDOWS
          ? query<{ IDreference: number }>(
              `SELECT DISTINCT ee.IDreference
               FROM envoi_email ee
               JOIN commande_sous_traitant cst
                 ON cst.IDcommande_sous_traitant = ee.IDreference
               WHERE ee.IDtype_doc = ${TYPE_DOC_SOUMISSION_LOT_CLIENT}
                 ${SOUMIS_INVALIDE_SQL_PREDICATE}
                 AND cst.est_soldee = 0`,
            )
          : (async () => {
              // Linux path: pull every soumis email row (small N — bounded
              // by IDtype_doc=15) and prune locally. Don't JOIN — the
              // Linux bridge handles bare SELECT cleaner than alias-dot
              // SELECT for accented-row payloads.
              const rows = await query<Record<string, unknown>>(
                `SELECT * FROM envoi_email WHERE IDtype_doc = ${TYPE_DOC_SOUMISSION_LOT_CLIENT}`,
              )
              const open = await query<{ IDcommande_sous_traitant: number }>(
                `SELECT IDcommande_sous_traitant FROM commande_sous_traitant WHERE est_soldee = 0`,
              )
              const openSet = new Set(open.map((r) => Number(r.IDcommande_sous_traitant)))
              const active = filterActiveSoumisRows(rows)
              const seen = new Set<number>()
              const out: { IDreference: number }[] = []
              for (const r of active) {
                const id = Number((r as any).IDreference) || 0
                if (id > 0 && openSet.has(id) && !seen.has(id)) {
                  seen.add(id); out.push({ IDreference: id })
                }
              }
              return out
            })(),
        query<{ IDcommande_sous_traitant: number }>(
          `SELECT DISTINCT lcs.IDcommande_sous_traitant
           FROM stock_fini sf
           JOIN ligne_commande_sous_traitant lcs
             ON lcs.IDligne_commande_sous_traitant = sf.IDref_commande_source
           JOIN commande_sous_traitant cst
             ON cst.IDcommande_sous_traitant = lcs.IDcommande_sous_traitant
           WHERE cst.est_soldee = 0`,
        ),
      ])
      const repriseSet = new Set(repriseRows.map((r) => Number(r.IDcommande_sous_traitant)))
      const soumisSetRaw = new Set(soumisRows.map((r) => Number(r.IDreference)))
      const receptionSetRaw = new Set(receptionRows.map((r) => Number(r.IDcommande_sous_traitant)))
      // Priority-gated sets (each phase excludes higher-priority ones).
      const soumisSet = new Set(Array.from(soumisSetRaw).filter((id) => !repriseSet.has(id)))
      const controleSet = new Set(
        Array.from(receptionSetRaw).filter((id) => !repriseSet.has(id) && !soumisSet.has(id)),
      )
      const excludeFromEnCours = new Set<number>([
        ...repriseSet, ...soumisSet, ...controleSet,
      ])

      const pickSet = (s: Set<number>): string | null => {
        if (s.size === 0) return null
        return Array.from(s).join(',')
      }
      if (statusFilter === 'en_reprise') {
        const list = pickSet(repriseSet)
        if (!list) { res.json([]); return }
        whereParts.push(`cst.IDcommande_sous_traitant IN (${list})`)
      } else if (statusFilter === 'soumis') {
        const list = pickSet(soumisSet)
        if (!list) { res.json([]); return }
        whereParts.push(`cst.IDcommande_sous_traitant IN (${list})`)
      } else if (statusFilter === 'en_controle') {
        const list = pickSet(controleSet)
        if (!list) { res.json([]); return }
        whereParts.push(`cst.IDcommande_sous_traitant IN (${list})`)
      } else if (
        statusFilter === 'en_cours'
        || statusFilter === 'attente_delai'
        || statusFilter === 'non_envoye'
      ) {
        // Sub-classify the open-bucket commandes (those not already in a
        // higher-priority signal set) by MAX(line sstatut rank):
        //   rank 0 → Non_Envoye, 1 → Attente_Delai, 2 → En_Cours (or any
        //   other legacy "progressed" value). The commande's rank is the
        //   max across its lines — one confirmed line lifts the whole
        //   commande to en_cours.
        const lineRows = await query<{ IDcommande_sous_traitant: number; sstatut: string | null }>(
          `SELECT lcs.IDcommande_sous_traitant, lcs.sstatut
           FROM ligne_commande_sous_traitant lcs
           JOIN commande_sous_traitant cst
             ON cst.IDcommande_sous_traitant = lcs.IDcommande_sous_traitant
           WHERE cst.est_soldee = 0`,
        )
        const maxRankByCmd = new Map<number, 0 | 1 | 2>()
        for (const r of lineRows) {
          const cmdId = Number(r.IDcommande_sous_traitant)
          if (excludeFromEnCours.has(cmdId)) continue
          const rank = lineStatutRank(r.sstatut)
          const prev = maxRankByCmd.get(cmdId) ?? 0
          if (rank > prev) maxRankByCmd.set(cmdId, rank)
        }
        const nonEnvoyeSet = new Set<number>()
        const attenteDelaiSet = new Set<number>()
        const enCoursSet = new Set<number>()
        for (const [cmdId, rank] of maxRankByCmd) {
          if (rank === 2) enCoursSet.add(cmdId)
          else if (rank === 1) attenteDelaiSet.add(cmdId)
          else nonEnvoyeSet.add(cmdId)
        }
        // Commandes with no lines at all aren't in maxRankByCmd; classify
        // them as non_envoye (fresh commande, no work yet).
        if (statusFilter === 'non_envoye') {
          // Open AND not in any higher-priority set AND (no lines OR all lines Non_Envoye).
          const exclude = new Set<number>([
            ...excludeFromEnCours,
            ...attenteDelaiSet,
            ...enCoursSet,
          ])
          if (exclude.size > 0) {
            whereParts.push(`cst.IDcommande_sous_traitant NOT IN (${Array.from(exclude).join(',')})`)
          }
        } else if (statusFilter === 'attente_delai') {
          const list = pickSet(attenteDelaiSet)
          if (!list) { res.json([]); return }
          whereParts.push(`cst.IDcommande_sous_traitant IN (${list})`)
        } else {
          // en_cours
          const list = pickSet(enCoursSet)
          if (!list) { res.json([]); return }
          whereParts.push(`cst.IDcommande_sous_traitant IN (${list})`)
        }
      }
    }
    // Urgency filter — `urgency_in=late`, `=soon`, or `=late,soon`. Narrows
    // to the cards the frontend would paint red / amber. Composes with the
    // existing statusFilter and search predicates; pagination keeps working
    // because we resolve the matching IDs up-front and add an IN-list
    // predicate. Skipped when no urgency tokens are passed.
    const urgencyTokens = String(req.query.urgency_in ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s === 'late' || s === 'soon')
    if (urgencyTokens.length > 0) {
      const buckets = await computeUrgencyBuckets()
      const merged = new Set<number>()
      if (urgencyTokens.includes('late')) for (const id of buckets.late) merged.add(id)
      if (urgencyTokens.includes('soon')) for (const id of buckets.soon) merged.add(id)
      if (merged.size === 0) { res.json([]); return }
      whereParts.push(`cst.IDcommande_sous_traitant IN (${Array.from(merged).join(',')})`)
    }
    if (!isSearching && beforeId !== null) whereParts.push(`cst.IDcommande_sous_traitant < ${beforeId}`)

    if (isSearching && hits) {
      const orParts: string[] = []
      // Digit-only query → exact commande-id match. Users type the full
      // numero de commande, and HFSQL `CAST(... AS VARCHAR) LIKE` is flaky
      // on some driver versions — exact equality is the safer primitive.
      const qDigits = /^\d+$/.test(q) ? parseInt(q, 10) : NaN
      if (!isNaN(qDigits) && qDigits > 0) orParts.push(`cst.IDcommande_sous_traitant = ${qDigits}`)
      if (hits.sstIds.length > 0) orParts.push(`cst.IDsous_traitant IN (${hits.sstIds.join(',')})`)

      // Ref + coloris match on the lines. Type discriminates the catalog,
      // per the polymorphic rule (CLAUDE.md HFSQL section):
      //   type=2 → IDreference is IDref_fini, IDColoris is IDref_fini_colori
      //   type=1 → IDreference is IDref_ecru, IDColoris is IDcolori_ecru
      //   type=0 → IDreference is IDref_ecru, IDColoris is IDcolori_ecru
      // So both type=0 AND type=1 share the ref_ecru + colori_ecru
      // catalogs. `refFilIds` is never stored on sst lines today; the
      // resolved hits are intentionally ignored.
      const lineConds: string[] = []
      if (hits.refEcruIds.length) lineConds.push(`(lcs.type IN (0,1) AND lcs.IDreference IN (${hits.refEcruIds.join(',')}))`)
      if (hits.refFiniIds.length) lineConds.push(`(lcs.type = 2 AND lcs.IDreference IN (${hits.refFiniIds.join(',')}))`)
      if (hits.coloriEcruIds.length) lineConds.push(`(lcs.type IN (0,1) AND lcs.IDColoris IN (${hits.coloriEcruIds.join(',')}))`)
      if (hits.refFiniColoriIds.length) lineConds.push(`(lcs.type = 2 AND lcs.IDColoris IN (${hits.refFiniColoriIds.join(',')}))`)
      if (lineConds.length > 0) {
        orParts.push(
          `cst.IDcommande_sous_traitant IN (SELECT lcs.IDcommande_sous_traitant FROM ligne_commande_sous_traitant lcs WHERE ${lineConds.join(' OR ')})`,
        )
      }

      if (orParts.length === 0) {
        // q didn't match any catalog and isn't a numeric ID. Short-circuit
        // so we don't return the unfiltered list.
        res.json([])
        return
      }
      whereParts.push(`(${orParts.join(' OR ')})`)
    }

    const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : ''

    const commandes = await query<any>(
      `SELECT TOP ${limit} cst.IDcommande_sous_traitant, cst.IDsous_traitant, cst.date_commande, cst.est_soldee, cst.date_notif
       FROM commande_sous_traitant cst
       ${whereSql}
       ORDER BY cst.IDcommande_sous_traitant DESC`,
    )

    // Bulk-resolve sous-traitant nom + type label. The JOIN with type_sst
    // truncates results in HFSQL ODBC, so we run two flat queries and merge.
    const stIds = Array.from(
      new Set(commandes.map((c: any) => Number(c.IDsous_traitant)).filter((x) => !isNaN(x) && x > 0)),
    )
    const stInfo = new Map<number, { nom: string; type: string | null }>()
    if (stIds.length > 0) {
      const decode = (v: unknown): string | null => {
        if (v instanceof ArrayBuffer) return Buffer.from(v).toString('utf8')
        if (typeof v === 'string') return v
        return null
      }
      const stRows = await query<{ IDsous_traitant: number; nom: unknown; IDtype_sst: number | null }>(
        `SELECT IDsous_traitant, CONVERT(nom USING 'UTF-8') AS nom, IDtype_sst
         FROM sous_traitant
         WHERE IDsous_traitant IN (${stIds.join(',')})`,
      )
      const typeIdsNeeded = Array.from(new Set(stRows.map((s) => Number(s.IDtype_sst) || 0).filter((x) => x > 0)))
      const typeMap = new Map<number, string>()
      if (typeIdsNeeded.length > 0) {
        const tsRows = await query<{ IDtype_sst: number; v: unknown }>(
          `SELECT IDtype_sst, CONVERT(type USING 'UTF-8') AS v FROM type_sst WHERE IDtype_sst IN (${typeIdsNeeded.join(',')})`,
        )
        for (const t of tsRows) {
          const lbl = decode((t as any).v)
          if (lbl !== null) typeMap.set(Number(t.IDtype_sst), lbl)
        }
      }
      for (const s of stRows) {
        stInfo.set(Number(s.IDsous_traitant), {
          nom: decode(s.nom) ?? '',
          type: s.IDtype_sst ? typeMap.get(Number(s.IDtype_sst)) ?? null : null,
        })
      }
    }

    // Bulk fetch line aggregates only for the rows we're returning.
    // `total_eur` is the **actual** total (sum of attached écru kg × prix),
    // not the nominal qty × prix — for ennoblisseur lines, the user enters
    // qty (Ml) and prix (€/Kg) as *projections*, and the bill comes from
    // the weights of the écru rolls they attach via the pieces drawer.
    const ids = commandes.map((c: any) => c.IDcommande_sous_traitant).filter(Boolean)
    const totalsMap = new Map<number, {
      total_eur: number
      total_qte: number
      nb_lignes: number
      earliest_delivery: string | null
    }>()
    if (ids.length > 0) {
      const [lignes, ecruWeights] = await Promise.all([
        query<any>(
          `SELECT IDligne_commande_sous_traitant, IDcommande_sous_traitant, quantite, prix, date_livraison, sstatut
           FROM ligne_commande_sous_traitant
           WHERE IDcommande_sous_traitant IN (${ids.join(',')})`,
        ),
        query<{ IDref_commande_affectation: number; poids: number | null }>(
          // Sum of écru weight per affected line — joining via the IN list
          // so the planner can use the index on stock_ecru.IDref_commande_affectation.
          `SELECT IDref_commande_affectation, poids
           FROM stock_ecru
           WHERE IDref_commande_affectation IN (
             SELECT IDligne_commande_sous_traitant FROM ligne_commande_sous_traitant
             WHERE IDcommande_sous_traitant IN (${ids.join(',')})
           )`,
        ),
      ])
      const kgByLine = new Map<number, number>()
      for (const e of ecruWeights) {
        const lid = Number(e.IDref_commande_affectation) || 0
        if (lid === 0) continue
        kgByLine.set(lid, (kgByLine.get(lid) ?? 0) + (Number(e.poids) || 0))
      }
      for (const l of lignes) {
        const id = Number(l.IDcommande_sous_traitant)
        const lid = Number(l.IDligne_commande_sous_traitant)
        const acc = totalsMap.get(id) ?? { total_eur: 0, total_qte: 0, nb_lignes: 0, earliest_delivery: null }
        const qty = Number(l.quantite) || 0
        const price = Number(l.prix) || 0
        const affectedKg = kgByLine.get(lid) ?? 0
        acc.total_qte += qty
        acc.total_eur += affectedKg * price
        acc.nb_lignes += 1
        if (!isLineDone(typeof l.sstatut === 'string' ? l.sstatut : null)) {
          const dl = typeof l.date_livraison === 'string' ? l.date_livraison : ''
          if (/^\d{8}$/.test(dl) && (acc.earliest_delivery === null || dl < acc.earliest_delivery)) {
            acc.earliest_delivery = dl
          }
        }
        totalsMap.set(id, acc)
      }
    }

    // Compute the derived phase per returned row in one batched pass so
    // the frontend can render the new colored pill without an extra
    // round-trip. Phase order: terminée > en_reprise > soumis >
    // en_controle > en_cours (see computePhasesBatch).
    const phaseMap = await computePhasesBatch(
      commandes.map((c: any) => ({
        id: Number(c.IDcommande_sous_traitant),
        est_soldee: Number(c.est_soldee) || 0,
      })),
    )

    // Most recent bon de commande send date per commande (envoi_email
    // IDtype_doc=13). Frontend uses this to drive the "Attente Délai"
    // urgency frame — once the bon is out, the sst has 1 day grace before
    // the card starts warning.
    const bonEnvoyeMap = new Map<number, string>()
    if (ids.length > 0) {
      const sendRows = await query<{ IDreference: number; DATE: string | null }>(
        `SELECT IDreference, DATE FROM envoi_email
         WHERE IDtype_doc = 13 AND IDreference IN (${ids.join(',')})`,
      )
      for (const r of sendRows) {
        const cid = Number(r.IDreference)
        const raw = (r.DATE ?? '').toString()
        if (!cid || !raw) continue
        // envoi_email.DATE is "YYYY-MM-DD HH:MM:SS.SSS"; take the date prefix.
        const day = raw.slice(0, 10)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
        const prev = bonEnvoyeMap.get(cid)
        if (!prev || day > prev) bonEnvoyeMap.set(cid, day)
      }
    }

    const result = commandes.map((c: any) => {
      const totals = totalsMap.get(Number(c.IDcommande_sous_traitant)) ?? {
        total_eur: 0,
        total_qte: 0,
        nb_lignes: 0,
        earliest_delivery: null,
      }
      const sst = stInfo.get(Number(c.IDsous_traitant))
      const cid = Number(c.IDcommande_sous_traitant)
      return {
        ...c,
        sous_traitant_nom: sst?.nom ?? '',
        sous_traitant_type: sst?.type ?? null,
        phase: phaseMap.get(cid) ?? 'en_cours',
        bon_envoye_at: bonEnvoyeMap.get(cid) ?? null,
        ...totals,
      }
    })

    res.json(result)
  } catch (err) {
    console.error('Error fetching commandes-sous-traitant:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Get one commande with full detail ────────────────────

commandesSousTraitantRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const rows = await query<CommandeSousTraitantHeader>(
      `SELECT * FROM commande_sous_traitant WHERE IDcommande_sous_traitant = ${id}`,
    )
    if (rows.length === 0) { res.status(404).json({ error: 'Commande not found' }); return }

    const fixedHeader = await fixEncoding(
      rows,
      'commande_sous_traitant',
      'IDcommande_sous_traitant',
      ['commentaire', 'journal'],
    )
    const header = fixedHeader[0] as any
    // commentaire + journal are stored as RTF by the legacy app — strip
    // formatting for the new UI. Round-trip back to RTF on save (PUT).
    if (header) {
      header.commentaire = stripRtf(header.commentaire) || null
      header.journal = stripRtf(header.journal) || null
    }

    const [stRows, adresseStRows, adresseLivRows, lignes] = await Promise.all([
      // Two flat queries are merged below; the JOIN with type_sst truncates
      // result sets in HFSQL ODBC. CONVERT(tel) also truncates so we read
      // it raw — no accents in phone numbers anyway.
      query<{ IDsous_traitant: number; nom: unknown; tel: unknown; IDtype_sst: number }>(
        `SELECT IDsous_traitant,
                CONVERT(nom USING 'UTF-8') AS nom,
                tel,
                IDtype_sst
         FROM sous_traitant
         WHERE IDsous_traitant = ${n(header.IDsous_traitant)}`,
      ),
      header.IDadresse_sous_traitant
        ? query(`SELECT * FROM adresse WHERE IDadresse = ${n(header.IDadresse_sous_traitant)}`)
        : Promise.resolve([]),
      header.IDadresse_livraison
        ? query(`SELECT * FROM adresse WHERE IDadresse = ${n(header.IDadresse_livraison)}`)
        : Promise.resolve([]),
      // `type` is uppercased by HFSQL ODBC (reserved word) — alias to a
      // safe key.
      query(
        `SELECT lcs.IDligne_commande_sous_traitant, lcs.IDcommande_sous_traitant,
                lcs.type AS type_kind, lcs.IDreference, lcs.IDColoris,
                lcs.quantite, lcs.unite, lcs.prix, lcs.date_livraison, lcs.date_delai,
                lcs.date_reception, lcs.commentaire, lcs.sstatut, lcs.num_facture
         FROM ligne_commande_sous_traitant lcs
         WHERE lcs.IDcommande_sous_traitant = ${id}
         ORDER BY lcs.IDligne_commande_sous_traitant`,
      ),
    ])

    const decode = (v: unknown): string | null => {
      if (v instanceof ArrayBuffer) return Buffer.from(v).toString('utf8')
      if (typeof v === 'string') return v
      return null
    }
    const sst = (stRows[0] ?? null) as any
    const sousTraitantNom = decode(sst?.nom) ?? ''
    const sousTraitantTel = decode(sst?.tel) ?? null
    const sousTraitantIDtypeSst = sst ? Number(sst.IDtype_sst) || 0 : 0
    let sousTraitantType: string | null = null
    if (sousTraitantIDtypeSst > 0) {
      const tsRows = await query<{ v: unknown }>(
        `SELECT CONVERT(type USING 'UTF-8') AS v FROM type_sst WHERE IDtype_sst = ${sousTraitantIDtypeSst}`,
      )
      if (tsRows.length > 0) sousTraitantType = decode((tsRows[0] as any).v)
    }

    const fixedAdresseSt = await fixEncoding(adresseStRows, 'adresse', 'IDadresse', [
      'nom',
      'adresse1',
      'adresse2',
      'adresse3',
      'ville',
      'pays',
    ])
    const fixedAdresseLiv = await fixEncoding(adresseLivRows, 'adresse', 'IDadresse', [
      'nom',
      'adresse1',
      'adresse2',
      'adresse3',
      'ville',
      'pays',
    ])
    const fixedLignes = (await fixEncoding(
      lignes,
      'ligne_commande_sous_traitant',
      'IDligne_commande_sous_traitant',
      ['commentaire', 'sstatut', 'num_facture'],
    )) as any[]

    // Resolve ref labels per line — type-aware. The line's `type` SMALLINT
    // (aliased as `type_kind` here) discriminates which catalog IDreference
    // belongs to:
    //   type=2 → ref_fini   (ennoblisseur — Phase 1 default)
    //   type=1 → ref_fil    (yarn — tricoteur)
    //   type=0 → ref_ecru   (greige — confectionneur or legacy)
    // We can't trust a triple-fallback by table because the same numeric ID
    // can exist in two of the three catalogs (e.g. IDref_ecru=294 collides
    // with IDref_fini=294, "Escrime imprimée" vs whatever ref_ecru#294 is) —
    // so the user picks fini and the card surfaces ecru's reference. Always
    // route by type, fall back to the other catalogs only if the chosen
    // table doesn't have the ID (defensive against bad legacy data).
    const refIds = Array.from(new Set(fixedLignes.map((l) => Number(l.IDreference) || 0).filter((x) => x > 0)))
    const colorisIds = Array.from(new Set(fixedLignes.map((l) => Number(l.IDColoris) || 0).filter((x) => x > 0)))
    const ecruMap = new Map<number, string>()
    const finiMap = new Map<number, string>()
    const filMap = new Map<number, string>()
    // ref_fini.rendement (Ml/kg) — used by the frontend LineCard to compute
    // "Ml potentiel" = totalKgEcru × rendement. Only populated for fini refs.
    const finiRendementMap = new Map<number, number>()
    // ref_fini.avec_teinture — 0 = wash only (IDColoris is a colori_ecru),
    // 1/2 = dyed (IDColoris is a ref_fini_colori). Drives resolveColoris below.
    const finiAvecTeintureMap = new Map<number, number>()
    if (refIds.length > 0) {
      // Build all three maps in parallel; we'll pick the right one per line below.
      const [ecruRows, finiRows, filRows] = await Promise.all([
        query<{ IDref_ecru: number; reference: string | null }>(
          `SELECT IDref_ecru, reference FROM ref_ecru WHERE IDref_ecru IN (${refIds.join(',')})`,
        ),
        query<{ IDref_fini: number; reference: string | null; rendement: number | null; avec_teinture: number | null }>(
          `SELECT IDref_fini, reference, rendement, avec_teinture FROM ref_fini WHERE IDref_fini IN (${refIds.join(',')})`,
        ),
        query<{ IDref_fil: number; reference: string | null }>(
          `SELECT IDref_fil, reference FROM ref_fil WHERE IDref_fil IN (${refIds.join(',')})`,
        ),
      ])
      for (const r of await fixEncoding(ecruRows, 'ref_ecru', 'IDref_ecru', ['reference']))
        ecruMap.set(r.IDref_ecru, r.reference ?? '')
      for (const r of await fixEncoding(finiRows, 'ref_fini', 'IDref_fini', ['reference'])) {
        finiMap.set(r.IDref_fini, r.reference ?? '')
        finiRendementMap.set(r.IDref_fini, Number(r.rendement) || 0)
        finiAvecTeintureMap.set(r.IDref_fini, Number((r as any).avec_teinture) || 0)
      }
      for (const r of await fixEncoding(filRows, 'ref_fil', 'IDref_fil', ['reference']))
        filMap.set(r.IDref_fil, r.reference ?? '')
    }
    // Per-line resolver: pick the catalog matching `type`, fall back to the
    // others only if the primary catalog doesn't have the ID.
    function resolveRef(IDref: number, typeKind: number): { label: string; kind: 'ecru' | 'fini' | 'fil' | null } {
      if (IDref <= 0) return { label: '', kind: null }
      const tryFini = () => finiMap.has(IDref) ? { label: finiMap.get(IDref)!, kind: 'fini' as const } : null
      const tryEcru = () => ecruMap.has(IDref) ? { label: ecruMap.get(IDref)!, kind: 'ecru' as const } : null
      const tryFil = () => filMap.has(IDref) ? { label: filMap.get(IDref)!, kind: 'fil' as const } : null
      let order: Array<() => { label: string; kind: 'ecru' | 'fini' | 'fil' } | null>
      // type=2 (ennoblisseur) — line spec is the OUTPUT fini being dyed.
      // type=1 (tricoteur)    — line spec is the OUTPUT écru being knit
      //                         (NOT the input yarn — that's derived via
      //                         composition_ecru). Legacy commande 8582
      //                         confirmed: IDreference=146 exists in both
      //                         ref_ecru (ref "029") and ref_fil (ref
      //                         "1/50 VISCOSE/LAINE 75/25"); the WinDev
      //                         app displays the ecru ref, so do we.
      // type=0 (legacy)       — direct ref_ecru pointer (same shape as 1
      //                         but without the implicit tricoteur flow).
      if (typeKind === 2) order = [tryFini, tryEcru, tryFil]
      else if (typeKind === 1) order = [tryEcru, tryFini, tryFil]
      else order = [tryEcru, tryFini, tryFil]
      for (const fn of order) {
        const hit = fn()
        if (hit) return hit
      }
      return { label: '', kind: null }
    }
    // Per-type coloris resolution. type=2 (fini/ennoblisseur) → ref_fini_colori;
    // type=0 (ecru) → colori_ecru; we also pre-fetch both maps here so a
    // legacy line with a mismatched type still resolves (defensive).
    const colorisFiniMap = new Map<number, string>()
    const colorisEcruMap = new Map<number, string>()
    if (colorisIds.length > 0) {
      const [finiC, ecruC] = await Promise.all([
        query<{ IDref_fini_colori: number; reference: string | null }>(
          `SELECT IDref_fini_colori, reference FROM ref_fini_colori WHERE IDref_fini_colori IN (${colorisIds.join(',')})`,
        ),
        query<{ IDcolori_ecru: number; reference: string | null }>(
          `SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDcolori_ecru IN (${colorisIds.join(',')})`,
        ),
      ])
      for (const c of await fixEncoding(finiC, 'ref_fini_colori', 'IDref_fini_colori', ['reference']))
        colorisFiniMap.set(c.IDref_fini_colori, c.reference ?? '')
      for (const c of await fixEncoding(ecruC, 'colori_ecru', 'IDcolori_ecru', ['reference']))
        colorisEcruMap.set(c.IDcolori_ecru, c.reference ?? '')
    }
    // type=2 (ennoblisseur): the IDColoris catalog depends on the ref's
    // avec_teinture — 0 = wash only → colori_ecru; 1/2 = dyed → ref_fini_colori.
    // The two id spaces collide numerically, so order matters (a wash-only
    // IDColoris usually also exists as an unrelated ref_fini_colori).
    function resolveColoris(IDcoloris: number, typeKind: number, IDref: number): string {
      if (IDcoloris <= 0) return ''
      if (typeKind === 2) {
        const dyed = (finiAvecTeintureMap.get(IDref) ?? 1) !== 0
        return dyed
          ? (colorisFiniMap.get(IDcoloris) ?? colorisEcruMap.get(IDcoloris) ?? '')
          : (colorisEcruMap.get(IDcoloris) ?? colorisFiniMap.get(IDcoloris) ?? '')
      }
      return colorisEcruMap.get(IDcoloris) ?? colorisFiniMap.get(IDcoloris) ?? ''
    }

    // Pieces aggregates per line. The line price math works off these:
    // - `total_kg_ecru_lie` is the sum of poids over écru rolls affected to
    //   the line — multiplied by `prix` it yields the actual € total
    //   (qty × prix is treated as a *nominal* projection, not the bill).
    // - `total_metrage_fini_recu` is the running metrage of dyed rolls
    //   received back, surfaced so the user can see how much of the order
    //   has actually returned.
    const lineIds = fixedLignes.map((l) => Number(l.IDligne_commande_sous_traitant)).filter((x) => x > 0)
    interface LineAgg {
      nb_ecru_lies: number
      total_kg_ecru_lie: number
      nb_fini_recu: number
      total_metrage_fini_recu: number
      // Per-lot breakdown of the received fini rolls — feeds the "Ml reçus"
      // tooltip in the frontend totals footer. Rolls with an empty lot
      // string group under ''.
      fini_lots: Array<{ lot: string; nb: number; metrage: number }>
    }
    const newAgg = (): LineAgg => ({ nb_ecru_lies: 0, total_kg_ecru_lie: 0, nb_fini_recu: 0, total_metrage_fini_recu: 0, fini_lots: [] })
    const piecesByLine = new Map<number, LineAgg>()
    if (lineIds.length > 0) {
      const [ecruRows, finiRows] = await Promise.all([
        query<{ IDref_commande_affectation: number; poids: number | null }>(
          `SELECT IDref_commande_affectation, poids
           FROM stock_ecru
           WHERE IDref_commande_affectation IN (${lineIds.join(',')})`,
        ),
        query<{ IDstock_fini: number; IDref_commande_source: number; metrage: number | null; lot: string | null }>(
          `SELECT IDstock_fini, IDref_commande_source, metrage, lot
           FROM stock_fini
           WHERE IDref_commande_source IN (${lineIds.join(',')})`,
        ),
      ])
      for (const r of ecruRows) {
        const lid = Number(r.IDref_commande_affectation) || 0
        if (lid === 0) continue
        const acc = piecesByLine.get(lid) ?? newAgg()
        acc.nb_ecru_lies += 1
        acc.total_kg_ecru_lie += Number(r.poids) || 0
        piecesByLine.set(lid, acc)
      }
      const fixedFini = await fixEncoding(finiRows, 'stock_fini', 'IDstock_fini', ['lot'])
      for (const r of fixedFini) {
        const lid = Number(r.IDref_commande_source) || 0
        if (lid === 0) continue
        const acc = piecesByLine.get(lid) ?? newAgg()
        acc.nb_fini_recu += 1
        acc.total_metrage_fini_recu += Number(r.metrage) || 0
        const lotKey = String(r.lot ?? '').trim()
        let lotAgg = acc.fini_lots.find((x) => x.lot === lotKey)
        if (!lotAgg) {
          lotAgg = { lot: lotKey, nb: 0, metrage: 0 }
          acc.fini_lots.push(lotAgg)
        }
        lotAgg.nb += 1
        lotAgg.metrage += Number(r.metrage) || 0
        piecesByLine.set(lid, acc)
      }
    }

    const lignesEnriched = fixedLignes.map((l) => {
      const refId = Number(l.IDreference) || 0
      const colId = Number(l.IDColoris) || 0
      const typeKind = Number((l as any).type_kind) || 0
      const resolved = resolveRef(refId, typeKind)
      const agg = piecesByLine.get(Number(l.IDligne_commande_sous_traitant)) ?? newAgg()
      const refRendement = resolved.kind === 'fini' ? (finiRendementMap.get(refId) ?? 0) : 0
      return {
        ...l,
        // Canonical `type` field for the frontend (mirrors type_kind, which
        // is the SQL-safe alias for the HFSQL reserved-word column).
        // 2=fini/ennoblisseur, 1=fil/tricoteur, 0=écru.
        type: typeKind,
        ref_label: resolved.label || null,
        ref_kind: resolved.kind,
        ref_rendement: refRendement,
        colori_reference: resolveColoris(colId, typeKind, refId) || null,
        ...agg,
      }
    })

    // Whether this commande's sous-traitant has any tariff catalog rows.
    // Drives the frontend's "lock prix input" affordance: only suppliers
    // present in `tranche_tarif_ennoblissement` get the auto-pricing
    // read-only treatment. Suppliers like FRANCE TEINTURE (no catalog)
    // keep manual prix entry. The flag is per-commande, not per-line,
    // because IDsous_traitant is set once at commande creation.
    const autoPricingEnabled = await hasTariffData(Number(header.IDsous_traitant) || 0)
    const phase = await computePhase(id, Number(header.est_soldee) || 0)

    // Most recent bon de commande send date (envoi_email IDtype_doc=13) for
    // this commande. The frontend uses it to show "Attente depuis X jours"
    // on Attente_Delai lines — same anchor as the list-level urgency frame.
    const bonRows = await query<{ DATE: string | null }>(
      `SELECT DATE FROM envoi_email WHERE IDtype_doc = 13 AND IDreference = ${id}`,
    )
    let bonEnvoyeAt: string | null = null
    for (const r of bonRows) {
      const day = (r.DATE ?? '').toString().slice(0, 10)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
      if (!bonEnvoyeAt || day > bonEnvoyeAt) bonEnvoyeAt = day
    }

    // TRM mirror — when the sst targets Tricotage Malterre (the sister
    // company), the legacy bridge auto-creates a `commande_client` on the
    // TRM ledger with `IDcommande_ETM` pointing back here. Surface the
    // mirror's status so the user can see whether the knit is done without
    // leaving the sst screen. Lines on the TRM side mirror the sst lines
    // 1:1 (ligne_commande_client.IDligne_commande_ETM = sst line id) so the
    // delivered-rolls count comes from stock_ecru.IDref_commande_source
    // pointing at the sst line.
    let trmMirror: {
      IDcommande_client: number
      numero: number | null
      date_commande: string | null
      ref_client: string | null
      est_soldee: number
      rolls_produced: number
      poids_produced_kg: number
    } | null = null
    if (Number(header.IDsous_traitant) === TRICOTAGE_MALTERRE_ID) {
      const ccRows = await query<{
        IDcommande_client: number
        numero: number | null
        date_commande: string | null
        ref_client: string | null
        est_soldee: number | null
      }>(
        `SELECT IDcommande_client, numero, date_commande, ref_client, est_soldee
         FROM commande_client WHERE IDcommande_ETM = ${id}`,
      )
      if (ccRows.length > 0) {
        const ccFixed = await fixEncoding(ccRows as any[], 'commande_client', 'IDcommande_client', ['ref_client'])
        const cc = ccFixed[0] as any
        // Tally produced écru rolls via the back-pointer TRM stamps on
        // every roll it knits (IDref_commande_source = sst line id).
        let rolls = 0
        let poids = 0
        const lineIds = (fixedLignes as any[])
          .map((l) => Number(l.IDligne_commande_sous_traitant))
          .filter((x) => x > 0)
        if (lineIds.length > 0) {
          const ecruRows = await query<{ poids: number | null }>(
            `SELECT poids FROM stock_ecru WHERE IDref_commande_source IN (${lineIds.join(',')})`,
          )
          rolls = ecruRows.length
          for (const r of ecruRows) poids += Number(r.poids) || 0
        }
        trmMirror = {
          IDcommande_client: Number(cc.IDcommande_client),
          numero: cc.numero != null ? Number(cc.numero) : null,
          date_commande: cc.date_commande ?? null,
          ref_client: (cc.ref_client ?? null) as string | null,
          est_soldee: Number(cc.est_soldee) || 0,
          rolls_produced: rolls,
          poids_produced_kg: poids,
        }
      }
    }

    res.json({
      ...header,
      sous_traitant_nom: sousTraitantNom,
      sous_traitant_tel: sousTraitantTel,
      sous_traitant_type: sousTraitantType,
      sous_traitant_IDtype_sst: sousTraitantIDtypeSst,
      adresse_sous_traitant: fixedAdresseSt[0] ?? null,
      adresse_livraison: fixedAdresseLiv[0] ?? null,
      lignes: lignesEnriched,
      auto_pricing_enabled: autoPricingEnabled,
      phase,
      bon_envoye_at: bonEnvoyeAt,
      trm_mirror: trmMirror,
    })
  } catch (err) {
    console.error('Error fetching commande-sous-traitant detail:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PDF + email helpers ─────────────────────────────────

function formatHfsqlDateFr(raw: string | null | undefined): string {
  if (!raw) return ''
  const s = String(raw)
  if (/^\d{8}$/.test(s)) return `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`
  return ''
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

function cleanAddrField(s: string | null | undefined): string | null {
  if (!s) return null
  const t = String(s).trim()
  if (!t) return null
  if (/^[.\-_·•\s]+$/.test(t)) return null
  return t
}

function cleanAddress(a: any | null) {
  if (!a) return null
  return {
    nom: cleanAddrField(a.nom),
    adresse1: cleanAddrField(a.adresse1),
    adresse2: cleanAddrField(a.adresse2),
    adresse3: cleanAddrField(a.adresse3),
    cp: cleanAddrField(a.cp),
    ville: cleanAddrField(a.ville),
    pays: cleanAddrField(a.pays),
  }
}

export async function buildCommandePdfData(id: number): Promise<CommandeSoustraitantPdfData | null> {
  const rows = await query<CommandeSousTraitantHeader>(
    `SELECT * FROM commande_sous_traitant WHERE IDcommande_sous_traitant = ${id}`,
  )
  if (rows.length === 0) return null
  const fixedHeader = await fixEncoding(
    rows,
    'commande_sous_traitant',
    'IDcommande_sous_traitant',
    ['commentaire', 'journal'],
  )
  const header = fixedHeader[0] as any
  if (header) header.commentaire = stripRtf(header.commentaire) || null

  const [stRows, adresseStRows, adresseLivRows, lignes] = await Promise.all([
    query<{ IDsous_traitant: number; nom: unknown }>(
      `SELECT IDsous_traitant, CONVERT(nom USING 'UTF-8') AS nom FROM sous_traitant WHERE IDsous_traitant = ${n(header.IDsous_traitant)}`,
    ),
    header.IDadresse_sous_traitant
      ? query(`SELECT * FROM adresse WHERE IDadresse = ${n(header.IDadresse_sous_traitant)}`)
      : Promise.resolve([]),
    header.IDadresse_livraison
      ? query(`SELECT * FROM adresse WHERE IDadresse = ${n(header.IDadresse_livraison)}`)
      : Promise.resolve([]),
    query(
      // type aliased — see detail endpoint comment on the HFSQL reserved-word
      // quirk that uppercases `type` otherwise.
      `SELECT lcs.IDligne_commande_sous_traitant, lcs.type AS type_kind, lcs.IDreference,
              lcs.IDColoris, lcs.quantite, lcs.unite, lcs.prix, lcs.date_livraison, lcs.date_delai
       FROM ligne_commande_sous_traitant lcs
       WHERE lcs.IDcommande_sous_traitant = ${id}
       ORDER BY lcs.IDligne_commande_sous_traitant`,
    ),
  ])
  const decode = (v: unknown): string | null => {
    if (v instanceof ArrayBuffer) return Buffer.from(v).toString('utf8')
    if (typeof v === 'string') return v
    return null
  }
  const sousTraitantNom = decode((stRows[0] as any)?.nom) ?? ''

  const fixedAdresseSt = await fixEncoding(adresseStRows, 'adresse', 'IDadresse', [
    'nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays',
  ])
  const fixedAdresseLiv = await fixEncoding(adresseLivRows, 'adresse', 'IDadresse', [
    'nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays',
  ])
  const fixedLignes = lignes as any[]

  // Per-line attached écru weight — needed to compute the actual € total
  // on the bon de commande (Ml × €/Kg is unitless garbage, see the line
  // card refactor on the screen).
  const lineIdsForKg = fixedLignes.map((l) => Number(l.IDligne_commande_sous_traitant)).filter((x) => x > 0)
  const kgByLine = new Map<number, number>()
  if (lineIdsForKg.length > 0) {
    const ecruWeights = await query<{ IDref_commande_affectation: number; poids: number | null }>(
      `SELECT IDref_commande_affectation, poids FROM stock_ecru
       WHERE IDref_commande_affectation IN (${lineIdsForKg.join(',')})`,
    )
    for (const e of ecruWeights) {
      const lid = Number(e.IDref_commande_affectation) || 0
      if (lid === 0) continue
      kgByLine.set(lid, (kgByLine.get(lid) ?? 0) + (Number(e.poids) || 0))
    }
  }

  // Type-aware ref label resolution — see the detail endpoint for the
  // reasoning. Same pattern: build all 3 maps, pick by `type_kind`.
  const refIds = Array.from(new Set(fixedLignes.map((l) => Number(l.IDreference) || 0).filter((x) => x > 0)))
  const colorisIds = Array.from(new Set(fixedLignes.map((l) => Number(l.IDColoris) || 0).filter((x) => x > 0)))
  const ecruMap = new Map<number, string>()
  const finiMap = new Map<number, string>()
  const filMap = new Map<number, string>()
  const colorisFiniMap = new Map<number, string>()
  const colorisEcruMap = new Map<number, string>()
  // ref_fini.avec_teinture: 0 = wash (IDColoris→colori_ecru), 1/2 = dyed
  // (IDColoris→ref_fini_colori). Drives resolveColoris below.
  const finiAvecTeintureMap = new Map<number, number>()
  // Per-fini extras for the PDF: cosmetic + technical specs + IDref_ecru
  // pointer so we can pull the "article initial" block (designation +
  // composition) once we know which ref_ecru each line maps to.
  interface FiniExtra {
    designation: string | null
    conditionnement: string | null
    poids_Moy: number | null
    laizeHT_Moy: number | null
    rendement: number | null
    IDref_ecru: number
  }
  const finiExtrasMap = new Map<number, FiniExtra>()
  if (refIds.length > 0) {
    const [ecru, fini, fil] = await Promise.all([
      query<{ IDref_ecru: number; reference: string | null }>(
        `SELECT IDref_ecru, reference FROM ref_ecru WHERE IDref_ecru IN (${refIds.join(',')})`,
      ),
      query<{
        IDref_fini: number
        reference: string | null
        designation: string | null
        conditionnement: string | null
        poids_Moy: number | null
        laizeHT_Moy: number | null
        rendement: number | null
        IDref_ecru: number | null
        avec_teinture: number | null
      }>(
        `SELECT IDref_fini, reference, designation, conditionnement,
                poids_Moy, laizeHT_Moy, rendement, IDref_ecru, avec_teinture
         FROM ref_fini WHERE IDref_fini IN (${refIds.join(',')})`,
      ),
      query<{ IDref_fil: number; reference: string | null }>(
        `SELECT IDref_fil, reference FROM ref_fil WHERE IDref_fil IN (${refIds.join(',')})`,
      ),
    ])
    for (const r of await fixEncoding(ecru, 'ref_ecru', 'IDref_ecru', ['reference']))
      ecruMap.set(r.IDref_ecru, r.reference ?? '')
    for (const r of await fixEncoding(fini, 'ref_fini', 'IDref_fini', ['reference', 'designation', 'conditionnement'])) {
      finiMap.set(r.IDref_fini, r.reference ?? '')
      finiAvecTeintureMap.set(r.IDref_fini, Number((r as any).avec_teinture) || 0)
      finiExtrasMap.set(r.IDref_fini, {
        designation: (r.designation ?? null) || null,
        conditionnement: (r.conditionnement ?? null) || null,
        poids_Moy: r.poids_Moy == null ? null : Number(r.poids_Moy),
        laizeHT_Moy: r.laizeHT_Moy == null ? null : Number(r.laizeHT_Moy),
        rendement: r.rendement == null ? null : Number(r.rendement),
        IDref_ecru: Number(r.IDref_ecru) || 0,
      })
    }
    for (const r of await fixEncoding(fil, 'ref_fil', 'IDref_fil', ['reference']))
      filMap.set(r.IDref_fil, r.reference ?? '')
  }

  // Per-fini treatment list. Single batch query; we group by IDref_fini and
  // preserve traitement.ordre. Drives the "Préfixation - Adoucissage - Rame"
  // subscript line in the PDF.
  const treatmentsByFini = new Map<number, string[]>()
  if (refIds.length > 0) {
    const trtRows = await query<{ IDref_fini: number; IDtraitement: number; designation: string | null; ordre: number | null }>(
      `SELECT trf.IDref_fini, t.IDtraitement, t.designation, t.ordre
       FROM traitement_ref_fini trf
       JOIN traitement t ON t.IDtraitement = trf.IDtraitement
       WHERE trf.IDref_fini IN (${refIds.join(',')})
         AND (t.is_deleted = 0 OR t.is_deleted IS NULL)`,
    )
    const trtFixed = await fixEncoding(trtRows, 'traitement', 'IDtraitement', ['designation'])
    interface TrtEntry { ordre: number; designation: string }
    const buckets = new Map<number, TrtEntry[]>()
    for (const r of trtFixed as any[]) {
      const fid = Number(r.IDref_fini) || 0
      const designation = (r.designation ?? '').trim()
      if (fid === 0 || !designation) continue
      const arr = buckets.get(fid) ?? []
      arr.push({ ordre: Number(r.ordre) || 0, designation })
      buckets.set(fid, arr)
    }
    for (const [fid, arr] of buckets) {
      arr.sort((a, b) => a.ordre - b.ordre)
      treatmentsByFini.set(fid, arr.map((e) => e.designation))
    }
  }

  // ref_ecru extras (designation + composition) keyed by IDref_ecru. We
  // gather IDs from both directly-referenced écru lines (type=0) and the
  // IDref_ecru pointer on each fini we just fetched.
  interface EcruExtra {
    reference: string | null
    designation: string | null
    composition: string | null
  }
  const ecruExtrasMap = new Map<number, EcruExtra>()
  const ecruExtraIds = new Set<number>()
  for (const extra of finiExtrasMap.values()) {
    if (extra.IDref_ecru > 0) ecruExtraIds.add(extra.IDref_ecru)
  }
  for (const l of fixedLignes) {
    const tk = Number((l as any).type_kind) || 0
    const rid = Number(l.IDreference) || 0
    if (tk === 0 && rid > 0) ecruExtraIds.add(rid)
  }
  if (ecruExtraIds.size > 0) {
    const ecruExtraRows = await query<{ IDref_ecru: number; reference: string | null; designation: string | null; composition: string | null }>(
      `SELECT IDref_ecru, reference, designation, composition FROM ref_ecru
       WHERE IDref_ecru IN (${Array.from(ecruExtraIds).join(',')})`,
    )
    const fixedEcru = await fixEncoding(ecruExtraRows, 'ref_ecru', 'IDref_ecru', ['reference', 'designation', 'composition'])
    for (const r of fixedEcru as any[]) {
      ecruExtrasMap.set(Number(r.IDref_ecru), {
        reference: (r.reference ?? null) || null,
        designation: (r.designation ?? null) || null,
        composition: (r.composition ?? null) || null,
      })
    }
  }

  // Attached écru rolls per line — Stock à mettre en oeuvre. Single batch
  // SELECT scoped to the lines on this commande; group by line id.
  const piecesByLine = new Map<number, Array<{ numero: string | null; poids_kg: number | null; metrage_m: number | null; observations: string | null }>>()
  if (lineIdsForKg.length > 0) {
    const pieceRows = await query<{
      IDref_commande_affectation: number
      numero: string | null
      lot: string | null
      poids: number | null
      metrage: number | null
      observations: string | null
    }>(
      `SELECT IDref_commande_affectation, numero, lot, poids, metrage, observations
       FROM stock_ecru
       WHERE IDref_commande_affectation IN (${lineIdsForKg.join(',')})
       ORDER BY numero, lot`,
    )
    const piecesFixed = await fixEncoding(pieceRows, 'stock_ecru', 'IDstock_ecru', ['numero', 'lot', 'observations'])
    for (const p of piecesFixed as any[]) {
      const lid = Number(p.IDref_commande_affectation) || 0
      if (lid === 0) continue
      const arr = piecesByLine.get(lid) ?? []
      const numero = (p.numero ?? '').toString().trim() || null
      const obs = (p.observations ?? null) ? String(p.observations).trim() || null : null
      arr.push({
        numero,
        poids_kg: p.poids == null ? null : Number(p.poids),
        metrage_m: p.metrage == null ? null : Number(p.metrage),
        observations: obs,
      })
      piecesByLine.set(lid, arr)
    }
  }
  function resolveRef(IDref: number, typeKind: number): string {
    if (IDref <= 0) return ''
    const tryFini = () => finiMap.get(IDref)
    const tryEcru = () => ecruMap.get(IDref)
    const tryFil = () => filMap.get(IDref)
    let order: Array<() => string | undefined>
    // Same ordering as the detail endpoint: type=1 (tricoteur) line ref
    // is the OUTPUT écru, not the input yarn. See the comment block in
    // the detail endpoint's resolveRef for the legacy 8582 evidence.
    if (typeKind === 2) order = [tryFini, tryEcru, tryFil]
    else if (typeKind === 1) order = [tryEcru, tryFini, tryFil]
    else order = [tryEcru, tryFini, tryFil]
    for (const fn of order) {
      const hit = fn()
      if (hit !== undefined) return hit
    }
    return ''
  }
  if (colorisIds.length > 0) {
    const [finiC, ecruC] = await Promise.all([
      query<{ IDref_fini_colori: number; reference: string | null }>(
        `SELECT IDref_fini_colori, reference FROM ref_fini_colori WHERE IDref_fini_colori IN (${colorisIds.join(',')})`,
      ),
      query<{ IDcolori_ecru: number; reference: string | null }>(
        `SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDcolori_ecru IN (${colorisIds.join(',')})`,
      ),
    ])
    for (const c of await fixEncoding(finiC, 'ref_fini_colori', 'IDref_fini_colori', ['reference']))
      colorisFiniMap.set(c.IDref_fini_colori, c.reference ?? '')
    for (const c of await fixEncoding(ecruC, 'colori_ecru', 'IDcolori_ecru', ['reference']))
      colorisEcruMap.set(c.IDcolori_ecru, c.reference ?? '')
  }
  // type=2 coloris catalog depends on ref_fini.avec_teinture (0 = wash →
  // colori_ecru; 1/2 = dyed → ref_fini_colori). See the detail endpoint.
  function resolveColoris(IDcoloris: number, typeKind: number, IDref: number): string {
    if (IDcoloris <= 0) return ''
    if (typeKind === 2) {
      const dyed = (finiAvecTeintureMap.get(IDref) ?? 1) !== 0
      return dyed
        ? (colorisFiniMap.get(IDcoloris) ?? colorisEcruMap.get(IDcoloris) ?? '')
        : (colorisEcruMap.get(IDcoloris) ?? colorisFiniMap.get(IDcoloris) ?? '')
    }
    return colorisEcruMap.get(IDcoloris) ?? colorisFiniMap.get(IDcoloris) ?? ''
  }

  const earliestDelivery = (fixedLignes
    .map((l) => (typeof l.date_livraison === 'string' ? l.date_livraison : ''))
    .filter((s: string) => /^\d{8}$/.test(s)) as string[])
    .sort()[0] ?? null

  // Quantity unit for the PDF table header + totals row. Tricoteur lines
  // (type=1) order kg of écru output; ennoblisseur (type=2) orders Ml of
  // fini. Use 'Kg' iff every line is tricoteur — fall back to 'Ml' (the
  // historical default) for ennoblisseur and mixed commandes.
  const allTricoteur = fixedLignes.length > 0
    && fixedLignes.every((l) => Number((l as any).type_kind) === 1)
  const qtyUnit: 'Ml' | 'Kg' = allTricoteur ? 'Kg' : 'Ml'

  return {
    numero: String(header.IDcommande_sous_traitant),
    dateCommande: formatHfsqlDateLongFr(header.date_commande),
    qty_unit: qtyUnit,
    sousTraitantNom: sousTraitantNom || '—',
    sousTraitantAdresse: cleanAddress(fixedAdresseSt[0] as any),
    adresseLivraison: cleanAddress(fixedAdresseLiv[0] as any),
    delaiLivraison: earliestDelivery ? formatHfsqlDateLongFr(earliestDelivery) : null,
    commentaire: (header.commentaire ?? null) as string | null,
    lignes: fixedLignes.map((l) => {
      const refId = Number(l.IDreference) || 0
      const colId = Number(l.IDColoris) || 0
      const typeKind = Number(l.type_kind) || 0
      const lid = Number(l.IDligne_commande_sous_traitant) || 0
      const dl = formatHfsqlDateFr(l.date_livraison) || null
      const ddRaw = typeof l.date_delai === 'string' ? l.date_delai : ''
      const dd = formatHfsqlDateFr(ddRaw) || null

      // Pull the fini extras (only meaningful for type=2 ennoblisseur
      // lines, but we attempt for all and the maps just miss for non-fini).
      const finiExtra = typeKind === 2 ? finiExtrasMap.get(refId) : null

      // Resolve the écru pointed to by the fini (article initial). For
      // ecru lines (type=0), the line's own IDreference IS the écru.
      const ecruId = finiExtra?.IDref_ecru || (typeKind === 0 ? refId : 0)
      const ecruExtra = ecruId > 0 ? ecruExtrasMap.get(ecruId) : null

      return {
        ref_label: resolveRef(refId, typeKind) || null,
        colori_reference: resolveColoris(colId, typeKind, refId) || null,
        ref_designation: finiExtra?.designation ?? null,
        ref_presentation: derivePresentation(finiExtra?.conditionnement ?? null),
        traitements: treatmentsByFini.get(refId) ?? [],
        poids_gm2: finiExtra?.poids_Moy ?? null,
        laize_cm: finiExtra?.laizeHT_Moy ?? null,
        rendement_ml_kg: finiExtra?.rendement ?? null,
        ecru_label: buildEcruLabel(ecruExtra),
        quantite: l.quantite == null ? null : Number(l.quantite),
        prix: l.prix == null ? null : Number(l.prix),
        total_kg_ecru_lie: kgByLine.get(lid) ?? 0,
        date_livraison: dl,
        date_delai: dd && dl && dd !== dl ? dd : null,
        pieces: piecesByLine.get(lid) ?? [],
      }
    }),
  }
}

// "OUVERT AU LARGE" / "TUBULAIRE" / "PLIÉ" distilled from the long
// ref_fini.conditionnement free-text (multi-line description). Returns
// null when no recognized keyword is present so the PDF skips the row
// entirely.
function derivePresentation(conditionnement: string | null): string | null {
  if (!conditionnement) return null
  const s = conditionnement.toLowerCase()
  if (s.includes('au large')) return 'OUVERT AU LARGE'
  if (s.includes('tubulaire')) return 'TUBULAIRE'
  if (s.includes('plié') || s.includes('plie ')) return 'PLIÉ'
  return null
}

function buildEcruLabel(e: { reference: string | null; designation: string | null; composition: string | null } | null | undefined): string | null {
  if (!e) return null
  const parts: string[] = []
  if (e.reference) parts.push(e.reference)
  // The legacy report renders "ARTICLE INITIAL : DF85/55 - ecru : <desc>" —
  // we keep the "ecru" hint inline so the bilingual row reads cleanly.
  if (e.designation) parts.push(`écru : ${e.designation}`)
  else parts.push('écru')
  if (e.composition) parts.push(e.composition)
  return parts.join(' — ')
}

async function renderCommandePdfBuffer(data: CommandeSoustraitantPdfData): Promise<Buffer> {
  return renderToBuffer(
    React.createElement(CommandeSoustraitantPdf, { data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >,
  )
}

commandesSousTraitantRouter.get('/:id/pdf', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const data = await buildCommandePdfData(id)
    if (!data) { res.status(404).json({ error: 'Commande not found' }); return }

    const buffer = await renderCommandePdfBuffer(data)

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `inline; filename="commande-sous-traitant-${data.numero}.pdf"`,
    )
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buffer)
  } catch (err) {
    console.error('Error rendering commande-sous-traitant PDF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Email defaults + send ────────────────────────────────

interface EmailRecipientPayload {
  email: string
  name?: string
  source: 'contact'
  contactId: number
}

interface EmailDefaultsPayload {
  recipients: { selected: EmailRecipientPayload[]; suggestions: EmailRecipientPayload[] }
  subject: string
  body: string
  sousTraitantNom: string
  numero: string
  /** Pre-filled Cc addresses (the dialog hydrates its Cc field from this). */
  cc?: string[]
}

async function buildEmailDefaults(id: number): Promise<EmailDefaultsPayload | null> {
  const rows = await query<{ IDsous_traitant: number }>(
    `SELECT IDsous_traitant FROM commande_sous_traitant WHERE IDcommande_sous_traitant = ${id}`,
  )
  if (rows.length === 0) return null
  const idSt = n((rows[0] as any).IDsous_traitant)

  const [stRows, contactRows] = await Promise.all([
    query<{ IDsous_traitant: number; nom: unknown }>(
      `SELECT IDsous_traitant, CONVERT(nom USING 'UTF-8') AS nom FROM sous_traitant WHERE IDsous_traitant = ${idSt}`,
    ),
    query<{
      IDcontact: number
      nom: string | null
      prenom: string | null
      mail: string | null
      envoi_commande: number | null
      est_visible: number | null
    }>(
      `SELECT IDcontact, nom, prenom, mail, envoi_commande, est_visible
       FROM contact
       WHERE IDsous_traitant = ${idSt}`,
    ),
  ])
  const decode = (v: unknown): string | null => {
    if (v instanceof ArrayBuffer) return Buffer.from(v).toString('utf8')
    if (typeof v === 'string') return v
    return null
  }
  const sousTraitantNom = decode((stRows[0] as any)?.nom) ?? ''
  const fixedContacts = await fixEncoding(contactRows, 'contact', 'IDcontact', ['nom', 'prenom', 'mail'])

  const selected: EmailRecipientPayload[] = []
  const suggestions: EmailRecipientPayload[] = []
  const seen = new Set<string>()
  for (const c of fixedContacts as any[]) {
    if (c.est_visible === 0) continue
    const raw = (c.mail ?? '').toString().trim()
    if (!raw) continue
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) continue
    const key = raw.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const displayName = [c.prenom, c.nom]
      .map((s: string | null) => (s ?? '').toString().trim())
      .filter((s: string) => s.length > 0)
      .join(' ')
    const recipient: EmailRecipientPayload = {
      email: raw,
      source: 'contact',
      contactId: n(c.IDcontact),
    }
    if (displayName) recipient.name = displayName
    if (c.envoi_commande === 1) selected.push(recipient)
    else suggestions.push(recipient)
  }

  const numero = String(id)
  const subject = `Bon de commande sous-traitant N°${numero} — ETS Malterre`
  const body =
    `Bonjour,\n\n` +
    `Veuillez trouver ci-joint notre bon de commande N°${numero}${sousTraitantNom ? ` à destination de ${sousTraitantNom}` : ''}.\n\n` +
    `Merci de bien vouloir nous confirmer la bonne réception de cette commande.\n\n` +
    `Cordialement,\n` +
    `ETS Malterre`

  return { recipients: { selected, suggestions }, subject, body, sousTraitantNom, numero }
}

commandesSousTraitantRouter.get('/:id/email-defaults', async (req: Request, res: Response) => {
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
  // Dev-only "Faux envoi" support — when true on a non-production server,
  // we skip the Gmail send but still run every side effect (envoi_email
  // row, sstatut Non_Envoye → Attente_Delai). Lets the operator exercise
  // status transitions in dev without spamming real ennoblisseurs.
  dev_skip_send: z.boolean().optional(),
})

/** True when the server is allowed to honour the `dev_skip_send` flag.
 *  Tied to NODE_ENV so a production build silently ignores it even if a
 *  client (e.g. a curl test) tries to set it. */
const ALLOW_DEV_SKIP_SEND = process.env.NODE_ENV !== 'production'

commandesSousTraitantRouter.post('/:id/email', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }

    const parsed = emailBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return
    }

    // Dev-only fake send — skip everything that talks to Gmail (sender
    // email lookup, PDF rendering, sendMail) but still log envoi_email +
    // flip sstatut below. Bypassing the sender-email check is intentional
    // so a developer without an email mapping can still exercise the
    // status transitions.
    const devSkip = parsed.data.dev_skip_send === true && ALLOW_DEV_SKIP_SEND

    let messageId: string
    if (devSkip) {
      messageId = `dev-skip-${Date.now()}`
      console.log(`[dev-skip-send] commande_sst #${id} — fake send to ${parsed.data.to.join(', ')}`)
    } else {
      const senderEmail = await getUserEmail(req.userId)
      if (!senderEmail) {
        res.status(400).json({
          error: 'no_sender_email',
          message:
            "Aucune adresse email n'est associée à votre compte. Un administrateur doit en définir une dans Paramètres › Utilisateurs.",
        })
        return
      }

      const userRows = await query<{ prenom: string | null; nom: string | null }>(
        `SELECT prenom, nom FROM utilisateur WHERE IDutilisateur = ${req.userId}`,
      )
      const fixedUser = await fixEncoding(userRows, 'utilisateur', 'IDutilisateur', ['prenom', 'nom'])
      const u = (fixedUser[0] as any) ?? null
      const displayName = u
        ? [u.prenom, u.nom].filter((s: string | null) => s && s.trim()).map((s: string) => s.trim()).join(' ')
        : ''
      const fromName = displayName ? `${displayName} — ETS Malterre` : 'ETS Malterre'

      const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = []
      if (parsed.data.attach_pdf !== false) {
        const data = await buildCommandePdfData(id)
        if (!data) { res.status(404).json({ error: 'Commande not found' }); return }
        const buffer = await renderCommandePdfBuffer(data)
        attachments.push({
          filename: `commande-sous-traitant-${data.numero}.pdf`,
          content: buffer,
          contentType: 'application/pdf',
        })
      }
      for (const a of parsed.data.extra_attachments ?? []) {
        attachments.push({
          filename: a.filename,
          content: Buffer.from(a.content_base64, 'base64'),
          contentType: a.content_type,
        })
      }

      messageId = await sendMail({
        from: senderEmail,
        fromName,
        to: parsed.data.to,
        cc: parsed.data.cc,
        bcc: parsed.data.bcc,
        subject: parsed.data.subject,
        body: parsed.data.body,
        attachments: attachments.length > 0 ? attachments : undefined,
      })
    }

    // Audit: log one envoi_email row per recipient with IDtype_doc=13
    // ("commande sst"). The historique tab and the Non_Envoye →
    // Attente_Delai phase transition both key off this row's presence,
    // and the legacy WinDev app surfaces it in its own UI.
    const allRecipients = [...parsed.data.to, ...(parsed.data.cc ?? [])]
    let societe = ''
    try {
      const stRows = await query<{ IDsous_traitant: number; nom: unknown }>(
        `SELECT cst.IDsous_traitant, CONVERT(st.nom USING 'UTF-8') AS nom
         FROM commande_sous_traitant cst
         JOIN sous_traitant st ON st.IDsous_traitant = cst.IDsous_traitant
         WHERE cst.IDcommande_sous_traitant = ${id}`,
      )
      const raw = stRows[0]?.nom
      if (raw instanceof ArrayBuffer) societe = Buffer.from(raw).toString('utf8')
      else if (typeof raw === 'string') societe = raw
    } catch {
      // Audit field is informational; fall back to empty.
    }
    await logEnvoiEmails(13, id, allRecipients, societe)

    // State machine: bon de commande has now been sent → flip every
    // still-Non_Envoye line to Attente_Delai. We intentionally do NOT
    // touch lines already in En_Cours / Terminé / other legacy values —
    // the flip is one-way and idempotent.
    try {
      await query(
        `UPDATE ligne_commande_sous_traitant
         SET sstatut = '${STATUT_ATTENTE_DELAI}'
         WHERE IDcommande_sous_traitant = ${id}
           AND sstatut = '${STATUT_NON_ENVOYE}'`,
      )
    } catch (e) {
      console.error('sstatut Non_Envoye → Attente_Delai failed for commande', id, e)
    }

    // Relance reminder: seed `date_notif` 3 working days ahead so the
    // "Attente Délai" urgency frame has an anchor. Only when none is set
    // yet — a date the employee already adjusted is left untouched, and so
    // is one from an earlier send (re-sending does not restart the clock).
    try {
      const cur = await query<{ date_notif: string | null }>(
        `SELECT date_notif FROM commande_sous_traitant WHERE IDcommande_sous_traitant = ${id}`,
      )
      const dn = (cur[0]?.date_notif ?? '').toString()
      if (!/^\d{8}$/.test(dn)) {
        await query(
          `UPDATE commande_sous_traitant SET date_notif = '${hfsqlDatePlusWorkingDays(3)}'
           WHERE IDcommande_sous_traitant = ${id}`,
        )
      }
    } catch (e) {
      console.error('date_notif seed failed for commande', id, e)
    }

    res.json({ ok: true, messageId })
  } catch (err) {
    console.error('Error sending commande-sous-traitant email:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    res.status(500).json({ error: 'send_failed', message })
  }
})

// ── Computed phase — replaces the binary "en cours / terminée" pill ───
//
// The legacy header status (`est_soldee` 0/1) only tells us whether the
// commande is open or closed. The actual workflow phase is much richer —
// the operator wants to see "Soumis au client" / "En reprise" / "En
// contrôle" / "En cours" at a glance. We derive that phase on read from:
//
//   - `est_soldee`                   → "terminée" (overrides everything)
//   - `stock_fini.IDetat_stock_fini` → "en reprise" / "en contrôle"
//   - `envoi_email.IDtype_doc=28`    → "soumis au client"
//
// Priority (top-down, first match wins): terminée > en_reprise > soumis
// > en_controle > en_cours. The phase is informational only — `est_soldee`
// remains the sole write gate (`refuseIfTerminee` is unchanged).

export type SstPhase =
  | 'non_envoye'
  | 'attente_delai'
  | 'en_cours'
  | 'en_controle'
  | 'soumis'
  | 'en_reprise'
  | 'terminee'

/** Sub-classify the open commande (est_soldee=0, no reprise/soumis/en_controle
 *  signal) into non_envoye / attente_delai / en_cours by reading its lines. */
async function classifyEnCoursBucket(commandeId: number): Promise<'non_envoye' | 'attente_delai' | 'en_cours'> {
  const rows = await query<{ sstatut: string | null }>(
    `SELECT sstatut FROM ligne_commande_sous_traitant WHERE IDcommande_sous_traitant = ${commandeId}`,
  )
  if (rows.length === 0) return 'non_envoye'
  let max: 0 | 1 | 2 = 0
  for (const r of rows) {
    const rank = lineStatutRank(r.sstatut)
    if (rank > max) max = rank
  }
  if (max === 2) return 'en_cours'
  if (max === 1) return 'attente_delai'
  return 'non_envoye'
}

/** Compute the phase for a single commande. Used by the detail endpoint. */
async function computePhase(commandeId: number, est_soldee: number): Promise<SstPhase> {
  if (est_soldee === 1) return 'terminee'

  // Reprise — any received roll currently flagged for redo.
  const reprise = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM stock_fini sf
     JOIN ligne_commande_sous_traitant lcs
       ON lcs.IDligne_commande_sous_traitant = sf.IDref_commande_source
     WHERE lcs.IDcommande_sous_traitant = ${commandeId}
       AND sf.IDetat_stock_fini = 2`,
  )
  if (Number(reprise[0]?.n) > 0) return 'en_reprise'

  // Soumis au client — at least one envoi_email row was logged for this
  // commande (TYPE_DOC_SOUMISSION_LOT_CLIENT = 15). Linux iODBC bridge
  // can't tokenize `invalidé` so we omit it from the SQL and prune in JS
  // via filterActiveSoumisRows. Windows keeps the SQL predicate.
  let isSoumis = false
  if (IS_WINDOWS) {
    const soumis = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM envoi_email
       WHERE IDtype_doc = ${TYPE_DOC_SOUMISSION_LOT_CLIENT}
         AND IDreference = ${commandeId}
         ${SOUMIS_INVALIDE_SQL_PREDICATE}`,
    )
    isSoumis = Number(soumis[0]?.n) > 0
  } else {
    const rows = await query<Record<string, unknown>>(
      `SELECT * FROM envoi_email
       WHERE IDtype_doc = ${TYPE_DOC_SOUMISSION_LOT_CLIENT}
         AND IDreference = ${commandeId}`,
    )
    isSoumis = filterActiveSoumisRows(rows).length > 0
  }
  if (isSoumis) return 'soumis'

  // En contrôle — at least one roll has been received.
  const reception = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM stock_fini sf
     JOIN ligne_commande_sous_traitant lcs
       ON lcs.IDligne_commande_sous_traitant = sf.IDref_commande_source
     WHERE lcs.IDcommande_sous_traitant = ${commandeId}`,
  )
  if (Number(reception[0]?.n) > 0) return 'en_controle'

  // Open bucket — sub-classify via line sstatut ranks.
  return classifyEnCoursBucket(commandeId)
}

/** Batched variant for the list endpoint — runs three flat IN-queries
 *  and merges signals in JS. Returns a Map<commandeId, phase>. */
async function computePhasesBatch(
  rows: Array<{ id: number; est_soldee: number }>,
): Promise<Map<number, SstPhase>> {
  const out = new Map<number, SstPhase>()
  if (rows.length === 0) return out

  const openIds: number[] = []
  for (const r of rows) {
    if (r.est_soldee === 1) {
      out.set(r.id, 'terminee')
    } else {
      openIds.push(r.id)
    }
  }
  if (openIds.length === 0) return out

  const idList = openIds.join(',')

  // 1) Reprise — group reprise rolls by commande.
  const repriseRows = await query<{ IDcommande_sous_traitant: number }>(
    `SELECT DISTINCT lcs.IDcommande_sous_traitant
     FROM stock_fini sf
     JOIN ligne_commande_sous_traitant lcs
       ON lcs.IDligne_commande_sous_traitant = sf.IDref_commande_source
     WHERE lcs.IDcommande_sous_traitant IN (${idList})
       AND sf.IDetat_stock_fini = 2`,
  )
  const repriseSet = new Set(repriseRows.map((r) => Number(r.IDcommande_sous_traitant)))

  // 2) Soumis au client — Linux iODBC bridge can't tokenize `invalidé`,
  // so on Linux we read SELECT * for the type_doc + idList scope and prune
  // in JS via filterActiveSoumisRows.
  let soumisRows: { IDreference: number }[]
  if (IS_WINDOWS) {
    soumisRows = await query<{ IDreference: number }>(
      `SELECT DISTINCT IDreference FROM envoi_email
       WHERE IDtype_doc = ${TYPE_DOC_SOUMISSION_LOT_CLIENT}
         AND IDreference IN (${idList})
         ${SOUMIS_INVALIDE_SQL_PREDICATE}`,
    )
  } else {
    const rows = await query<Record<string, unknown>>(
      `SELECT * FROM envoi_email
       WHERE IDtype_doc = ${TYPE_DOC_SOUMISSION_LOT_CLIENT}
         AND IDreference IN (${idList})`,
    )
    const active = filterActiveSoumisRows(rows)
    const seen = new Set<number>()
    soumisRows = []
    for (const r of active) {
      const id = Number((r as any).IDreference) || 0
      if (id > 0 && !seen.has(id)) { seen.add(id); soumisRows.push({ IDreference: id }) }
    }
  }
  const soumisSet = new Set(soumisRows.map((r) => Number(r.IDreference)))

  // 3) Any reception at all.
  const receptionRows = await query<{ IDcommande_sous_traitant: number }>(
    `SELECT DISTINCT lcs.IDcommande_sous_traitant
     FROM stock_fini sf
     JOIN ligne_commande_sous_traitant lcs
       ON lcs.IDligne_commande_sous_traitant = sf.IDref_commande_source
     WHERE lcs.IDcommande_sous_traitant IN (${idList})`,
  )
  const receptionSet = new Set(receptionRows.map((r) => Number(r.IDcommande_sous_traitant)))

  // Bucket the remaining "open" ids (no reprise / soumis / en_controle
  // signal) by line sstatut: read all their lines in one IN-query and
  // compute MAX(rank) per commande.
  const enCoursBucketIds = openIds.filter(
    (id) => !repriseSet.has(id) && !soumisSet.has(id) && !receptionSet.has(id),
  )
  const maxRankByCmd = new Map<number, 0 | 1 | 2>()
  if (enCoursBucketIds.length > 0) {
    const lineRows = await query<{ IDcommande_sous_traitant: number; sstatut: string | null }>(
      `SELECT IDcommande_sous_traitant, sstatut
       FROM ligne_commande_sous_traitant
       WHERE IDcommande_sous_traitant IN (${enCoursBucketIds.join(',')})`,
    )
    for (const r of lineRows) {
      const cmdId = Number(r.IDcommande_sous_traitant)
      const rank = lineStatutRank(r.sstatut)
      const prev = maxRankByCmd.get(cmdId) ?? 0
      if (rank > prev) maxRankByCmd.set(cmdId, rank)
    }
  }

  for (const id of openIds) {
    if (repriseSet.has(id)) out.set(id, 'en_reprise')
    else if (soumisSet.has(id)) out.set(id, 'soumis')
    else if (receptionSet.has(id)) out.set(id, 'en_controle')
    else {
      const rank = maxRankByCmd.get(id) ?? 0
      if (rank === 2) out.set(id, 'en_cours')
      else if (rank === 1) out.set(id, 'attente_delai')
      else out.set(id, 'non_envoye')
    }
  }
  return out
}

// ── envoi_email logging — shared with the étude-coloris path ─────
//
// `envoi_email` is the legacy WinDev audit log of every recipient an email
// has been sent to. We use it server-side as the canonical "this commande
// has been soumis to the client" signal — the new computed phase reads
// from this table.
//
// The `IDtype_doc` values are a small global enum keyed off the legacy
// `type_doc` lookup. The sst Soumission-Lot-Client flow uses `15`
// (`type_doc.nom = 'soumission'`) to stay legacy-compatible — the
// WinDev app has been logging sst soumissions with this code since
// 2021 (3 279 rows of type=15 all reference a real commande_sous_-
// traitant, with `notes` carrying the lot identifier like "MA105741").
// We mirror the same convention on send so the legacy app can read our
// outgoing soumissions out of envoi_email alongside its own.
const TYPE_DOC_SOUMISSION_LOT_CLIENT = 15

function nowHfsqlDatetime(): string {
  const d = new Date()
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.`
    + `${pad(d.getMilliseconds(), 3)}`
}

/** Insert one envoi_email row per recipient. Mirrors the helper in
 *  `etudes-coloris.ts` plus an optional `notes` field — the legacy
 *  sst-soumission convention stores the lot identifier there
 *  ("MA105741", "MA107896 (reprise)", …) so the WinDev app surfaces
 *  it in its UI. Failures are swallowed (logged) so the send response
 *  path isn't affected. */
async function logEnvoiEmails(
  idTypeDoc: number,
  idReference: number,
  recipients: string[],
  societe: string,
  notes: string = '',
): Promise<void> {
  if (recipients.length === 0) return
  const ts = nowHfsqlDatetime()
  for (const raw of recipients) {
    const addr = String(raw).trim()
    if (!addr) continue
    try {
      if (IS_WINDOWS) {
        await query(
          `INSERT INTO envoi_email
             (DATE, adresse, société, IDreference, invalidé, notes, IDtype_doc)
           VALUES
             ('${ts}', ${sqlText(addr)}, ${sqlText(societe || '')}, ${idReference}, 0, ${sqlText(notes || '')}, ${idTypeDoc})`,
        )
      } else {
        // Linux iODBC bridge can't tokenize the accented identifiers
        // `société`/`invalidé` — naming them throws [HY090] ("Unexpected word")
        // and the row is never written, while the email still goes out. That's
        // how soumissions silently failed to flip the phase to "soumis" and
        // never appeared in the historique (bon-de-commande logging too).
        // Omit both columns: HFSQL zero-fills `invalidé` (= 0 = active, what the
        // soumis-check wants) and leaves `société` empty (display-only).
        // Validated against the prod bridge. Values go through sqlText() so
        // accented input still survives the bridge.
        await query(
          `INSERT INTO envoi_email
             (DATE, adresse, IDreference, notes, IDtype_doc)
           VALUES
             ('${ts}', ${sqlText(addr)}, ${idReference}, ${sqlText(notes || '')}, ${idTypeDoc})`,
        )
      }
    } catch (e) {
      console.error(`envoi_email log failed (${idTypeDoc}/${idReference}/${addr}):`, (e as Error).message)
    }
  }
}

// ── Soumission Lot — feature ─────────────────────────────
//
// A sst commande is "soumissable au client" when at least one of its lines
// is linked (via affected écru OR received fini) to a client commande whose
// (IDclient, IDref_fini) tuple has a designation_client row with
// soumettre = 1 AND archivé = 0.
//
// Two flavours of eligible candidate:
//
//   `kind: 'received'`
//     A fini roll exists (stock_fini back-linked via IDref_commande_source,
//     reserved to a client via IDligne_commande_client). The lot string is
//     the actual fini lot (e.g. "MA108391") and we know nb_rolls + Σmetrage.
//     Grouped by (IDref_fini, IDColoris, lot, IDcommande_client) so a
//     physical batch split across multiple client orders becomes multiple
//     candidates (one PDF per client).
//
//   `kind: 'manual'`
//     The fini hasn't been received yet but the line has affected écrus
//     reserved to a client (stock_ecru.IDref_commande_affectation = line,
//     stock_ecru.IDligne_commande_client → commande_client → client). The
//     legacy WinDev app allowed soumission in this state with a user-typed
//     lot. We surface one candidate per (line ref_fini, line coloris,
//     IDcommande_client) tuple, with an empty `lot` — the picker prompts
//     the user. Suppressed when a received candidate already covers the
//     same (IDref_fini, IDColoris, IDcommande_client) so we don't duplicate.

interface EligibleLot {
  kind: 'received' | 'manual'
  // Composite key parts (drive the PDF/email URL)
  IDref_fini: number
  IDColoris: number
  lot: string                  // '' for manual — user types it
  IDcommande_client: number
  // Resolved display fields
  IDclient: number
  client_nom: string
  ref_malterre: string         // ref_fini.reference
  client_designation: string   // designation_client.designation (= ref client)
  coloris_reference: string
  numero: number               // commande_client.numero — disambiguates same-client/ref/coloris cards
  date_commande: string        // commande_client.date_commande (YYYYMMDD)
  nb_rolls: number             // 0 for manual
  total_metrage: number        // 0 for manual (planned qty comes from the line at render time)
  // React-friendly key
  key: string
}

export async function findEligibleLots(commandeId: number): Promise<EligibleLot[]> {
  // 1) Lines belonging to this commande_sous_traitant. Carry the line's
  //    own (IDreference=IDref_fini for type=2 ennoblisseur, IDColoris) so
  //    the manual path can emit a candidate even when no fini rolls exist.
  const lineRows = await query<{
    IDligne_commande_sous_traitant: number
    IDreference: number
    IDColoris: number
    type_kind: number
  }>(
    `SELECT IDligne_commande_sous_traitant, IDreference, IDColoris, type AS type_kind
     FROM ligne_commande_sous_traitant
     WHERE IDcommande_sous_traitant = ${commandeId}`,
  )
  const lineIds = lineRows.map((r) => Number(r.IDligne_commande_sous_traitant)).filter((x) => x > 0)
  if (lineIds.length === 0) return []
  // type=2 (ennoblisseur) lines: line.IDreference IS ref_fini, line.IDColoris
  // IS the fini coloris (ref_fini_colori). Only these can be soumis to a
  // client — tricoteur (type=1) and the rare type=0 emit no fini.
  const enLines = lineRows.filter((l) => Number(l.type_kind) === 2)
  // Lookup: lineId → (ref_fini, coloris) for manual fallback
  const lineRefMap = new Map<number, { IDref_fini: number; IDColoris: number }>()
  for (const l of enLines) {
    lineRefMap.set(Number(l.IDligne_commande_sous_traitant), {
      IDref_fini: Number(l.IDreference),
      IDColoris: Number(l.IDColoris),
    })
  }

  // ── 2a) Received: fini rolls with a client-order reservation.
  interface GroupAcc {
    kind: 'received' | 'manual'
    IDref_fini: number
    IDColoris: number
    lot: string
    IDcommande_client: number
    IDclient: number
    nb_rolls: number
    total_metrage: number
  }
  const groups = new Map<string, GroupAcc>()
  const finiRows = await query<{
    IDref_fini: number
    IDColoris: number
    lot: string | null
    IDligne_commande_client: number
    metrage: number | null
  }>(
    `SELECT IDref_fini, IDColoris, lot, IDligne_commande_client, metrage
     FROM stock_fini
     WHERE IDref_commande_source IN (${lineIds.join(',')})
       AND IDligne_commande_client > 0`,
  )
  const fixedFini = await fixEncoding(finiRows as any[], 'stock_fini', 'IDstock_fini', ['lot'])

  // Resolve IDligne_commande_client → IDcommande_client (shared by fini + écru).
  const finiLccIds = new Set<number>(fixedFini.map((r: any) => n(r.IDligne_commande_client)).filter((x) => x > 0))

  // ── 2b) Manual: écru rolls affected to this commande's lines with a
  //       client-order reservation. The fini lot doesn't exist yet — the
  //       user types it at picker time.
  const ecruRows = await query<{
    IDref_commande_affectation: number
    IDligne_commande_client: number
  }>(
    `SELECT IDref_commande_affectation, IDligne_commande_client
     FROM stock_ecru
     WHERE IDref_commande_affectation IN (${lineIds.join(',')})
       AND IDligne_commande_client > 0`,
  )

  // Combine all client-order ids we need to resolve.
  const ecruLccIds = new Set<number>(ecruRows.map((r) => Number(r.IDligne_commande_client)).filter((x) => x > 0))
  const allLccIds = Array.from(new Set<number>([...finiLccIds, ...ecruLccIds]))

  // ── 3) Resolve IDligne_commande_client → IDcommande_client.
  const lccToCc = new Map<number, number>()
  if (allLccIds.length > 0) {
    const lccRows = await query<{ IDligne_commande_client: number; IDcommande_client: number }>(
      `SELECT IDligne_commande_client, IDcommande_client FROM ligne_commande_client
       WHERE IDligne_commande_client IN (${allLccIds.join(',')})`,
    )
    for (const r of lccRows) lccToCc.set(n(r.IDligne_commande_client), n(r.IDcommande_client))
  }

  // ── 4) Resolve IDcommande_client → IDclient.
  const ccIds = Array.from(new Set(Array.from(lccToCc.values()))).filter((x) => x > 0)
  const ccToClient = new Map<number, number>()
  if (ccIds.length > 0) {
    const ccRows = await query<{ IDcommande_client: number; IDclient: number }>(
      `SELECT IDcommande_client, IDclient FROM commande_client
       WHERE IDcommande_client IN (${ccIds.join(',')})`,
    )
    for (const r of ccRows) ccToClient.set(n(r.IDcommande_client), n(r.IDclient))
  }

  // ── 5a) Build received groups keyed (IDref_fini, IDColoris, lot, ccId).
  //        Skip rolls whose lot string is empty (defensive — empty lots
  //        would group together meaninglessly).
  for (const r of fixedFini as any[]) {
    const lot = (r.lot ?? '').toString().trim()
    if (!lot) continue
    const lccId = n(r.IDligne_commande_client)
    const ccId = lccToCc.get(lccId) ?? 0
    const clientId = ccToClient.get(ccId) ?? 0
    if (ccId === 0 || clientId === 0) continue
    const idRefFini = n(r.IDref_fini)
    const idColoris = n(r.IDColoris)
    const k = `r|${idRefFini}|${idColoris}|${lot}|${ccId}`
    const acc = groups.get(k) ?? {
      kind: 'received' as const,
      IDref_fini: idRefFini,
      IDColoris: idColoris,
      lot,
      IDcommande_client: ccId,
      IDclient: clientId,
      nb_rolls: 0,
      total_metrage: 0,
    }
    acc.nb_rolls += 1
    acc.total_metrage += Number(r.metrage) || 0
    groups.set(k, acc)
  }

  // ── 5b) Build manual groups keyed (IDref_fini, IDColoris, ccId) per
  //        (line, client) tuple from écru affectations. Suppress when a
  //        received group already covers the same (ref_fini, coloris, cc).
  const receivedCoverage = new Set<string>()
  for (const g of groups.values()) {
    if (g.kind === 'received') receivedCoverage.add(`${g.IDref_fini}|${g.IDColoris}|${g.IDcommande_client}`)
  }
  for (const r of ecruRows) {
    const lineId = Number(r.IDref_commande_affectation)
    const refInfo = lineRefMap.get(lineId)
    if (!refInfo) continue // tricoteur / unknown — not a fini line
    const lccId = Number(r.IDligne_commande_client)
    const ccId = lccToCc.get(lccId) ?? 0
    const clientId = ccToClient.get(ccId) ?? 0
    if (ccId === 0 || clientId === 0) continue
    const sig = `${refInfo.IDref_fini}|${refInfo.IDColoris}|${ccId}`
    if (receivedCoverage.has(sig)) continue
    const k = `m|${sig}`
    if (groups.has(k)) continue
    groups.set(k, {
      kind: 'manual',
      IDref_fini: refInfo.IDref_fini,
      IDColoris: refInfo.IDColoris,
      lot: '',
      IDcommande_client: ccId,
      IDclient: clientId,
      nb_rolls: 0,
      total_metrage: 0,
    })
  }

  if (groups.size === 0) return []

  // ── 6) Filter by designation_client soumettre = 1 AND get the client's
  //       preferred reference label. `archivé` is an accented identifier —
  //       Linux iODBC bridge can't tokenize it in WHERE, and the truncated
  //       `archiv` form is bridge-output-only (also unknown to the data
  //       file). Mirror the SOUMIS_INVALIDE pattern: SELECT * (so the row
  //       carries the archive flag back under whichever key the platform
  //       surfaces), filter in JS by both keys.
  const uniqueClients = Array.from(new Set(Array.from(groups.values()).map((g) => g.IDclient)))
  const uniqueRefFini = Array.from(new Set(Array.from(groups.values()).map((g) => g.IDref_fini)))
  const dcMap = new Map<string, string>() // `${IDclient}|${IDref_fini}` → designation (fallback)
  const dcColorisMap = new Map<string, string>() // `${IDclient}|${IDref_fini}|${IDColoris}` → designation
  if (uniqueClients.length > 0 && uniqueRefFini.length > 0) {
    const dcRows = await query<any>(
      `SELECT * FROM designation_client
       WHERE IDclient IN (${uniqueClients.join(',')})
         AND IDref_fini IN (${uniqueRefFini.join(',')})
         AND soumettre = 1`,
    )
    const dcActive = (dcRows as any[]).filter(
      (r) => Number(r.archiv ?? r['archivé'] ?? 0) === 0,
    )
    const dcFixed = await fixEncoding(dcActive as any[], 'designation_client', 'IDdesignation_client', ['designation'])
    for (const r of dcFixed as any[]) {
      dcMap.set(`${n(r.IDclient)}|${n(r.IDref_fini)}`, (r.designation ?? '').toString())
    }
    // A client may carry SEVERAL designations for the same ref_fini, one per
    // coloris (linked through ref_client_colori). Keying on (client, ref)
    // alone lets an arbitrary sibling overwrite the right one (bug: commande
    // 8500 printed 65511019000 instead of 65511008000 for coloris 3520).
    // Build a per-coloris map to resolve exactly; dcMap stays as fallback.
    const dcIds = (dcFixed as any[]).map((r) => n(r.IDdesignation_client)).filter((x) => x > 0)
    if (dcIds.length > 0) {
      const dcById = new Map<number, any>((dcFixed as any[]).map((r) => [n(r.IDdesignation_client), r]))
      const rccRows = await query<any>(
        `SELECT * FROM ref_client_colori WHERE IDdesignation_client IN (${dcIds.join(',')})`,
      )
      for (const r of rccRows as any[]) {
        if (Number(r.archiv ?? r['archivé'] ?? 0) !== 0) continue
        const dc = dcById.get(n(r.IDdesignation_client))
        if (!dc) continue
        // dye refs link via IDref_fini_colori, wash refs via IDcolori_ecru —
        // group IDColoris carries whichever catalog the ref dictates.
        const colorisId = n(r.IDref_fini_colori) > 0 ? n(r.IDref_fini_colori) : n(r.IDcolori_ecru)
        if (colorisId <= 0) continue
        const key = `${n(dc.IDclient)}|${n(dc.IDref_fini)}|${colorisId}`
        if (!dcColorisMap.has(key)) dcColorisMap.set(key, (dc.designation ?? '').toString())
      }
    }
  }

  // ── 7) Display lookups: ref_fini.reference, ref_fini_colori.reference,
  //       client.nom — all flat queries to avoid CONVERT-in-JOIN collapse.
  const refFiniMap = new Map<number, string>()
  // avec_teinture per ref: 0 = wash (IDColoris→colori_ecru), 1/2 = dyed
  // (IDColoris→ref_fini_colori). The eligible lots are all type=2 fini lines.
  const avecTeintureMap = new Map<number, number>()
  if (uniqueRefFini.length > 0) {
    const rf = await query<{ IDref_fini: number; reference: string | null; avec_teinture: number | null }>(
      `SELECT IDref_fini, reference, avec_teinture FROM ref_fini WHERE IDref_fini IN (${uniqueRefFini.join(',')})`,
    )
    for (const r of await fixEncoding(rf as any[], 'ref_fini', 'IDref_fini', ['reference'])) {
      refFiniMap.set(n((r as any).IDref_fini), ((r as any).reference ?? '').toString())
      avecTeintureMap.set(n((r as any).IDref_fini), Number((r as any).avec_teinture) || 0)
    }
  }
  const uniqueColoris = Array.from(new Set(Array.from(groups.values()).map((g) => g.IDColoris).filter((x) => x > 0)))
  const colorisMap = new Map<number, string>()      // ref_fini_colori (dyed)
  const colorisEcruMap = new Map<number, string>()  // colori_ecru (wash)
  if (uniqueColoris.length > 0) {
    const [rc, ec] = await Promise.all([
      query<{ IDref_fini_colori: number; reference: string | null }>(
        `SELECT IDref_fini_colori, reference FROM ref_fini_colori
         WHERE IDref_fini_colori IN (${uniqueColoris.join(',')})`,
      ),
      query<{ IDcolori_ecru: number; reference: string | null }>(
        `SELECT IDcolori_ecru, reference FROM colori_ecru
         WHERE IDcolori_ecru IN (${uniqueColoris.join(',')})`,
      ),
    ])
    for (const r of await fixEncoding(rc as any[], 'ref_fini_colori', 'IDref_fini_colori', ['reference'])) {
      colorisMap.set(n((r as any).IDref_fini_colori), ((r as any).reference ?? '').toString())
    }
    for (const r of await fixEncoding(ec as any[], 'colori_ecru', 'IDcolori_ecru', ['reference'])) {
      colorisEcruMap.set(n((r as any).IDcolori_ecru), ((r as any).reference ?? '').toString())
    }
  }
  // Resolve a group's coloris label against the catalog its ref dictates.
  const resolveGroupColoris = (g: { IDref_fini: number; IDColoris: number }): string => {
    if (g.IDColoris <= 0) return ''
    const dyed = (avecTeintureMap.get(g.IDref_fini) ?? 1) !== 0
    return dyed
      ? (colorisMap.get(g.IDColoris) ?? colorisEcruMap.get(g.IDColoris) ?? '')
      : (colorisEcruMap.get(g.IDColoris) ?? colorisMap.get(g.IDColoris) ?? '')
  }
  const clientMap = new Map<number, string>()
  if (uniqueClients.length > 0) {
    const cl = await query<{ IDclient: number; nom: string | null }>(
      `SELECT IDclient, nom FROM client WHERE IDclient IN (${uniqueClients.join(',')})`,
    )
    for (const r of await fixEncoding(cl as any[], 'client', 'IDclient', ['nom'])) {
      clientMap.set(n((r as any).IDclient), ((r as any).nom ?? '').toString().trim())
    }
  }
  // commande_client numero + date — disambiguates cards that share the same
  // client / ref / coloris but target different client orders.
  const uniqueCc = Array.from(new Set(Array.from(groups.values()).map((g) => g.IDcommande_client).filter((x) => x > 0)))
  const ccInfoMap = new Map<number, { numero: number; date_commande: string }>()
  if (uniqueCc.length > 0) {
    const ccRows = await query<{ IDcommande_client: number; numero: number | null; date_commande: string | null }>(
      `SELECT IDcommande_client, numero, date_commande FROM commande_client WHERE IDcommande_client IN (${uniqueCc.join(',')})`,
    )
    for (const r of ccRows) {
      ccInfoMap.set(n(r.IDcommande_client), {
        numero: n(r.numero),
        date_commande: (r.date_commande ?? '').toString(),
      })
    }
  }

  // ── 8) Assemble surviving groups (those with a designation_client.soumettre=1 row).
  const out: EligibleLot[] = []
  for (const g of groups.values()) {
    const dcKey = `${g.IDclient}|${g.IDref_fini}`
    // Exact per-coloris designation first; (client, ref) fallback keeps
    // eligibility for coloris without a ref_client_colori row.
    const clientDesignation = dcColorisMap.get(`${dcKey}|${g.IDColoris}`) ?? dcMap.get(dcKey)
    if (clientDesignation === undefined) continue
    // Key encodes kind so the same (ref, coloris, cc) tuple can carry both a
    // received and a manual candidate if we ever want to surface them
    // side-by-side; today we suppress manual when received covers it.
    const key = g.kind === 'received'
      ? `received|${g.IDref_fini}|${g.IDColoris}|${g.lot}|${g.IDcommande_client}`
      : `manual|${g.IDref_fini}|${g.IDColoris}|${g.IDcommande_client}`
    out.push({
      kind: g.kind,
      IDref_fini: g.IDref_fini,
      IDColoris: g.IDColoris,
      lot: g.lot,
      IDcommande_client: g.IDcommande_client,
      IDclient: g.IDclient,
      client_nom: clientMap.get(g.IDclient) || '',
      ref_malterre: refFiniMap.get(g.IDref_fini) || '',
      client_designation: clientDesignation,
      coloris_reference: resolveGroupColoris(g) || '',
      numero: ccInfoMap.get(g.IDcommande_client)?.numero ?? 0,
      date_commande: ccInfoMap.get(g.IDcommande_client)?.date_commande ?? '',
      nb_rolls: g.nb_rolls,
      total_metrage: g.total_metrage,
      key,
    })
  }
  // Stable order: received before manual, then by client_nom, then by lot.
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'received' ? -1 : 1
    return a.client_nom.localeCompare(b.client_nom) || a.numero - b.numero || a.lot.localeCompare(b.lot)
  })
  return out
}

// Long-form FR date formatter — reuses the existing FRENCH_MONTHS const
// declared above for the bon-de-commande PDF helpers.
function todayLongFr(): string {
  const d = new Date()
  return `${d.getDate()} ${FRENCH_MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

interface SoumissionLotParams {
  IDref_fini: number
  IDColoris: number
  lot: string
  IDcommande_client: number
}

function parseSoumissionLotParams(q: any): SoumissionLotParams | null {
  const idRefFini = parseInt(String(q.ref_fini ?? ''), 10)
  const idColoris = parseInt(String(q.coloris ?? ''), 10)
  const idCommandeClient = parseInt(String(q.commande_client ?? ''), 10)
  const lot = String(q.lot ?? '').trim()
  if (!Number.isFinite(idRefFini) || idRefFini <= 0) return null
  if (!Number.isFinite(idColoris) || idColoris < 0) return null
  if (!Number.isFinite(idCommandeClient) || idCommandeClient <= 0) return null
  if (!lot) return null
  return { IDref_fini: idRefFini, IDColoris: idColoris, lot, IDcommande_client: idCommandeClient }
}

/** Find the eligible candidate matching the params. Received candidates
 *  require exact lot match; manual candidates ignore the lot (user-typed)
 *  and match only on (ref_fini, coloris, commande_client). */
function matchEligibleLot(eligible: EligibleLot[], params: SoumissionLotParams): EligibleLot | null {
  return eligible.find((l) =>
    l.IDref_fini === params.IDref_fini &&
    l.IDColoris === params.IDColoris &&
    l.IDcommande_client === params.IDcommande_client &&
    (l.kind === 'manual' || l.lot === params.lot),
  ) ?? null
}

export async function buildSoumissionLotPdfData(
  commandeId: number,
  params: SoumissionLotParams,
  userId: number,
): Promise<SoumissionLotPdfData | null> {
  // 1) Verify the lot is eligible for THIS commande (defensive — also
  //    drops requests for lots not belonging to this commande).
  //    For 'manual' candidates the lot string is user-input — any non-empty
  //    string is accepted as long as the (ref, coloris, cc) tuple matches.
  const eligible = await findEligibleLots(commandeId)
  const lot = matchEligibleLot(eligible, params)
  if (!lot) return null
  // Resolve the lot string to use downstream: actual fini lot for received,
  // user-typed for manual.
  const lotString = lot.kind === 'manual' ? params.lot : lot.lot

  // 2) commande_client row → date_commande, numero, ref_client, IDadresse_livraison.
  const ccRows = await query<{
    IDcommande_client: number
    numero: number | null
    date_commande: string | null
    ref_client: string | null
    IDadresse_livraison: number | null
  }>(
    `SELECT IDcommande_client, numero, date_commande, ref_client, IDadresse_livraison
     FROM commande_client WHERE IDcommande_client = ${lot.IDcommande_client}`,
  )
  const ccFixed = await fixEncoding(ccRows as any[], 'commande_client', 'IDcommande_client', ['ref_client'])
  const cc = (ccFixed[0] as any) ?? null

  // 3) date_livraison of the SPECIFIC client-order line this lot fulfils.
  //    A commande_client can hold many lines (different refs/coloris/dates);
  //    taking the earliest across all of them returns an unrelated line's date
  //    (bug: lot MA108499 → line 12617 due 20/07, but the order's earliest line
  //    is 30/04 for another coloris). Resolve the real line(s):
  //      • received lot → the lot's fini rolls carry IDligne_commande_client
  //      • manual lot (no fini yet) → narrow to lines matching ref + coloris
  const earliestValid = (rows: { date_livraison: string | null }[]): string | null =>
    (rows
      .map((r) => (typeof r.date_livraison === 'string' ? r.date_livraison : ''))
      .filter((s: string) => /^\d{8}$/.test(s)) as string[]).sort()[0] ?? null

  let targetLccIds: number[] = []
  if (lot.kind !== 'manual') {
    const sfRows = await query<{ IDligne_commande_client: number | null }>(
      `SELECT IDligne_commande_client FROM stock_fini
       WHERE lot = ${sqlText(lotString)}
         AND IDref_fini = ${lot.IDref_fini}
         AND IDColoris = ${lot.IDColoris}`,
    )
    targetLccIds = [...new Set(sfRows.map((r) => n(r.IDligne_commande_client)).filter((x) => x > 0))]
  }

  let dlValid: string | null = null
  if (targetLccIds.length > 0) {
    const dRows = await query<{ date_livraison: string | null }>(
      `SELECT date_livraison FROM ligne_commande_client
       WHERE IDligne_commande_client IN (${targetLccIds.join(',')})`,
    )
    dlValid = earliestValid(dRows)
  }
  if (dlValid === null) {
    // Manual lots, or received with no resolvable reservation: narrow to the
    // order's lines matching this lot's ref + coloris (still far better than
    // every line of the order).
    const narrowRows = await query<{ date_livraison: string | null }>(
      `SELECT date_livraison FROM ligne_commande_client
       WHERE IDcommande_client = ${lot.IDcommande_client}
         AND IDreference = ${lot.IDref_fini}
         AND IDcolori = ${lot.IDColoris}`,
    )
    dlValid = earliestValid(narrowRows)
  }

  // 4) Adresse de livraison.
  const idAdresse = n(cc?.IDadresse_livraison)
  let adresseLivraison: SoumissionLotPdfData['adresseLivraison'] = null
  if (idAdresse > 0) {
    const aRows = await query(
      `SELECT * FROM adresse WHERE IDadresse = ${idAdresse}`,
    )
    const aFixed = await fixEncoding(aRows as any[], 'adresse', 'IDadresse', [
      'nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays',
    ])
    adresseLivraison = cleanAddress(aFixed[0] as any)
  }

  // 5) Expéditeur — current user's prénom.
  const uRows = await query<{ prenom: string | null; nom: string | null }>(
    `SELECT prenom, nom FROM utilisateur WHERE IDutilisateur = ${userId}`,
  )
  const uFixed = await fixEncoding(uRows as any[], 'utilisateur', 'IDutilisateur', ['prenom', 'nom'])
  const expediteur = ((uFixed[0] as any)?.prenom ?? '').toString().trim() || 'ETS Malterre'

  // 6) Destinataire — client's contact with envoi_soumission = 1.
  const contactRows = await query<{
    IDcontact: number; nom: string | null; prenom: string | null; mail: string | null
  }>(
    `SELECT IDcontact, nom, prenom, mail FROM contact
     WHERE IDclient = ${lot.IDclient}
       AND envoi_soumission = 1
       AND est_visible = 1`,
  )
  const cFixed = await fixEncoding(contactRows as any[], 'contact', 'IDcontact', ['nom', 'prenom', 'mail'])
  const firstContact = (cFixed[0] as any) ?? null
  const destinataire = firstContact
    ? [firstContact.prenom, firstContact.nom]
        .map((s: string | null) => (s ?? '').toString().trim())
        .filter((s: string) => s.length > 0)
        .join(' ')
    : ''

  // 7) Quantité Ml — for received lots, Σ stock_fini.metrage; for manual
  //    (no fini yet) fall back to the matching line's planned quantite.
  let quantiteMl = lot.total_metrage
  if (lot.kind === 'manual') {
    const lineRows = await query<{ quantite: number | null }>(
      `SELECT quantite FROM ligne_commande_sous_traitant
       WHERE IDcommande_sous_traitant = ${commandeId}
         AND IDreference = ${lot.IDref_fini}
         AND IDColoris = ${lot.IDColoris}
         AND type = 2`,
    )
    quantiteMl = lineRows.reduce((sum, r) => sum + (Number(r.quantite) || 0), 0)
  }

  return {
    numeroCommande: cc?.numero != null ? String(cc.numero) : '',
    dateSoumission: todayLongFr(),
    dateCommande: cc?.date_commande ? formatHfsqlDateFr(cc.date_commande) : '',
    dateLivraison: dlValid ? formatHfsqlDateFr(dlValid) : '',
    refCommandeClient: (cc?.ref_client ?? '').toString().trim(),
    quantiteMl,
    clientNom: lot.client_nom,
    refClient: lot.client_designation,
    refMalterre: lot.ref_malterre,
    coloris: lot.coloris_reference,
    adresseLivraison,
    expediteur,
    destinataire,
    lot: lotString,
  }
}

async function renderSoumissionLotPdfBuffer(data: SoumissionLotPdfData): Promise<Buffer> {
  return renderToBuffer(
    React.createElement(SoumissionLotPdf, { data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >,
  )
}

// ── Soumission: eligibility list ─────────────────────────

commandesSousTraitantRouter.get('/:id/soumission/lots-eligibles', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const lots = await findEligibleLots(id)
    res.json({ lots })
  } catch (err) {
    console.error('Error fetching eligible soumission lots:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Soumission: PDF preview / download ───────────────────

commandesSousTraitantRouter.get('/:id/soumission/pdf', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }

    const params = parseSoumissionLotParams(req.query)
    if (!params) { res.status(400).json({ error: 'Missing or invalid lot params' }); return }

    const data = await buildSoumissionLotPdfData(id, params, req.userId)
    if (!data) { res.status(404).json({ error: 'Lot not eligible for this commande' }); return }

    const buffer = await renderSoumissionLotPdfBuffer(data)

    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader(
      'Content-Disposition',
      `inline; filename="soumission-lot-${data.lot.replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf"`,
    )
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buffer)
  } catch (err) {
    console.error('Error rendering soumission lot PDF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Soumission: email defaults ───────────────────────────

async function buildSoumissionEmailDefaults(
  commandeId: number,
  params: SoumissionLotParams,
): Promise<EmailDefaultsPayload | null> {
  const eligible = await findEligibleLots(commandeId)
  const lot = matchEligibleLot(eligible, params)
  if (!lot) return null
  const lotString = lot.kind === 'manual' ? params.lot : lot.lot

  // Recipients are INVERTED relative to a normal client-facing document: the
  // lot soumission is addressed TO the sous-traitant (ennoblisseur) contacts,
  // with the client's soumission contacts in Cc.
  const selected: EmailRecipientPayload[] = []
  const suggestions: EmailRecipientPayload[] = []
  const seen = new Set<string>()

  // To: sous-traitant contacts. envoi_soumission=1 → pre-selected; other
  // visible contacts → suggestions (click to add).
  const stRows = await query<{ IDsous_traitant: number | null }>(
    `SELECT IDsous_traitant FROM commande_sous_traitant WHERE IDcommande_sous_traitant = ${commandeId}`,
  )
  const idSt = n((stRows[0] as any)?.IDsous_traitant)
  if (idSt > 0) {
    const stContacts = await query<{
      IDcontact: number; nom: string | null; prenom: string | null; mail: string | null;
      envoi_soumission: number | null; est_visible: number | null
    }>(
      `SELECT IDcontact, nom, prenom, mail, envoi_soumission, est_visible
       FROM contact WHERE IDsous_traitant = ${idSt}`,
    )
    const fixedSt = await fixEncoding(stContacts as any[], 'contact', 'IDcontact', ['nom', 'prenom', 'mail'])
    for (const c of fixedSt as any[]) {
      if (c.est_visible === 0) continue
      const raw = (c.mail ?? '').toString().trim()
      if (!raw || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) continue
      const key = raw.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      const displayName = [c.prenom, c.nom]
        .map((s: string | null) => (s ?? '').toString().trim())
        .filter((s: string) => s.length > 0)
        .join(' ')
      const recipient: EmailRecipientPayload = {
        email: raw,
        source: 'contact',
        contactId: n(c.IDcontact),
      }
      if (displayName) recipient.name = displayName
      if (c.envoi_soumission === 1) selected.push(recipient)
      else suggestions.push(recipient)
    }
  }

  // Cc: the client's soumission contacts (envoi_soumission = 1).
  const cc: string[] = []
  const clientContacts = await query<{
    IDcontact: number; mail: string | null; envoi_soumission: number | null; est_visible: number | null
  }>(
    `SELECT IDcontact, mail, envoi_soumission, est_visible
     FROM contact WHERE IDclient = ${lot.IDclient} AND envoi_soumission = 1`,
  )
  const fixedClient = await fixEncoding(clientContacts as any[], 'contact', 'IDcontact', ['mail'])
  for (const c of fixedClient as any[]) {
    if (c.est_visible === 0) continue
    const raw = (c.mail ?? '').toString().trim()
    if (!raw || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) continue
    const key = raw.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    cc.push(raw)
  }

  // Ref commande client (commande_client.ref_client) — same field the PDF
  // shows as "Ref commande client"; surfaced in the body so the recipient
  // can tie the soumission back to the client's own order.
  const ccRows = await query<{ IDcommande_client: number; ref_client: string | null }>(
    `SELECT IDcommande_client, ref_client FROM commande_client
     WHERE IDcommande_client = ${lot.IDcommande_client}`,
  )
  const ccFixed = await fixEncoding(ccRows as any[], 'commande_client', 'IDcommande_client', ['ref_client'])
  const refCommandeClient = ((ccFixed[0] as any)?.ref_client ?? '').toString().trim()

  const subject = `Soumission Lot ${lotString} - ${lot.ref_malterre}${lot.coloris_reference ? ` · ${lot.coloris_reference}` : ''}${refCommandeClient ? ` · ${refCommandeClient}` : ''}`
  const body =
    `Bonjour,\n\n` +
    `Veuillez trouver ci-joint la soumission du lot ${lotString} pour la référence ${lot.client_designation || lot.ref_malterre}${lot.coloris_reference ? ` (coloris ${lot.coloris_reference})` : ''}.\n\n` +
    (refCommandeClient ? `Réf commande client : ${refCommandeClient}\n\n` : '') +
    `Un échantillon est joint au document imprimé.\n\n` +
    `Cordialement,\n` +
    `ETS Malterre`

  return {
    recipients: { selected, suggestions },
    subject,
    body,
    sousTraitantNom: lot.client_nom, // reuse the field — the email dialog displays it as contextLabel
    numero: lotString,
    cc: cc.length > 0 ? cc : undefined,
  }
}

commandesSousTraitantRouter.get('/:id/soumission/email-defaults', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const params = parseSoumissionLotParams(req.query)
    if (!params) { res.status(400).json({ error: 'Missing or invalid lot params' }); return }
    const defaults = await buildSoumissionEmailDefaults(id, params)
    if (!defaults) { res.status(404).json({ error: 'Lot not eligible for this commande' }); return }
    res.json(defaults)
  } catch (err) {
    console.error('Error building soumission email defaults:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Soumission: send email + attach PDF ──────────────────

const soumissionEmailBody = z.object({
  to: z.array(z.string().email()).min(1, 'At least one recipient is required'),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(20000),
  attach_pdf: z.boolean().optional(),
  extra_attachments: z.array(extraAttachmentSchema).optional(),
  // Lot params travel in the body so the server can rebuild the right PDF.
  ref_fini: z.number().int().positive(),
  coloris: z.number().int().nonnegative(),
  lot: z.string().min(1).max(200),
  commande_client: z.number().int().positive(),
  // Dev-only — see emailBody for semantics.
  dev_skip_send: z.boolean().optional(),
})

commandesSousTraitantRouter.post('/:id/soumission/email', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (req.userId === undefined) { res.status(401).json({ error: 'not authenticated' }); return }

    const parsed = soumissionEmailBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return
    }
    const lotParams: SoumissionLotParams = {
      IDref_fini: parsed.data.ref_fini,
      IDColoris: parsed.data.coloris,
      lot: parsed.data.lot,
      IDcommande_client: parsed.data.commande_client,
    }

    // Dev-only fake send — see the bon-de-commande endpoint above.
    const devSkip = parsed.data.dev_skip_send === true && ALLOW_DEV_SKIP_SEND

    let messageId: string
    if (devSkip) {
      messageId = `dev-skip-${Date.now()}`
      console.log(`[dev-skip-send] soumission #${id} lot=${parsed.data.lot} — fake send to ${parsed.data.to.join(', ')}`)
    } else {
      const senderEmail = await getUserEmail(req.userId)
      if (!senderEmail) {
        res.status(400).json({
          error: 'no_sender_email',
          message:
            "Aucune adresse email n'est associée à votre compte. Un administrateur doit en définir une dans Paramètres › Utilisateurs.",
        })
        return
      }

      const userRows = await query<{ prenom: string | null; nom: string | null }>(
        `SELECT prenom, nom FROM utilisateur WHERE IDutilisateur = ${req.userId}`,
      )
      const fixedUser = await fixEncoding(userRows, 'utilisateur', 'IDutilisateur', ['prenom', 'nom'])
      const u = (fixedUser[0] as any) ?? null
      const displayName = u
        ? [u.prenom, u.nom].filter((s: string | null) => s && s.trim()).map((s: string) => s.trim()).join(' ')
        : ''
      const fromName = displayName ? `${displayName} — ETS Malterre` : 'ETS Malterre'

      const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = []
      if (parsed.data.attach_pdf !== false) {
        const data = await buildSoumissionLotPdfData(id, lotParams, req.userId)
        if (!data) { res.status(404).json({ error: 'Lot not eligible for this commande' }); return }
        const buffer = await renderSoumissionLotPdfBuffer(data)
        attachments.push({
          filename: `soumission-lot-${data.lot.replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`,
          content: buffer,
          contentType: 'application/pdf',
        })
      }
      for (const a of parsed.data.extra_attachments ?? []) {
        attachments.push({
          filename: a.filename,
          content: Buffer.from(a.content_base64, 'base64'),
          contentType: a.content_type,
        })
      }

      messageId = await sendMail({
        from: senderEmail,
        fromName,
        to: parsed.data.to,
        cc: parsed.data.cc,
        bcc: parsed.data.bcc,
        subject: parsed.data.subject,
        body: parsed.data.body,
        attachments: attachments.length > 0 ? attachments : undefined,
      })
    }

    // Audit: log one envoi_email row per recipient (to+cc). The legacy
    // WinDev app reads from this same table — by using IDtype_doc=15
    // and storing the lot identifier in `notes` we stay compatible
    // with what the legacy UI surfaces. The computed phase also reads
    // type=15 rows for this commande to derive "Soumis au client".
    const allRecipients = [...parsed.data.to, ...(parsed.data.cc ?? [])]
    let societe = ''
    try {
      const eligible = await findEligibleLots(id)
      const lot = matchEligibleLot(eligible, lotParams)
      societe = lot?.client_nom ?? ''
    } catch {
      // Audit field is informational; fall back to empty.
    }
    await logEnvoiEmails(
      TYPE_DOC_SOUMISSION_LOT_CLIENT,
      id,
      allRecipients,
      societe,
      lotParams.lot, // notes — lot identifier (legacy convention)
    )

    // Auto-advance the lot's quality status to "Attente Client" (état 5): the
    // soumission has been sent, so the lot now awaits the customer's decision.
    // The Qualité screen reads suivilot.IDetatLot. Best-effort — a status sync
    // failure must never block the email response (mirrors upsertSuivilot).
    try {
      const ligneRows = await query<{ IDligne_commande_sous_traitant: number }>(
        `SELECT IDligne_commande_sous_traitant FROM ligne_commande_sous_traitant
         WHERE IDcommande_sous_traitant = ${id}`,
      )
      const ligneIds = ligneRows
        .map((r) => Number(r.IDligne_commande_sous_traitant))
        .filter((v) => v > 0)
      if (ligneIds.length > 0) {
        await query(
          `UPDATE suivilot SET IDetatLot = 5
           WHERE lot = ${sqlText(lotParams.lot)}
             AND IDref_fini = ${Number(lotParams.IDref_fini) || 0}
             AND IDligne_commande_sous_traitant IN (${ligneIds.join(',')})`,
        )
      }
    } catch (err) {
      console.error(`Soumission status-sync (Attente Client) failed for commande=${id} lot=${lotParams.lot}:`, err)
    }

    res.json({ ok: true, messageId })
  } catch (err) {
    console.error('Error sending soumission lot email:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    res.status(500).json({ error: 'send_failed', message })
  }
})

// ── Historique — activity timeline for the right sidebar ─────
//
// Surfaces every envoi_email row whose IDreference points to this
// commande_sous_traitant and whose IDtype_doc is in the set we care
// about. IMPORTANT: envoi_email.IDreference is polymorphic — its
// target table depends on IDtype_doc:
//   13 = commande sst             → commande_sous_traitant.IDcommande_sous_traitant ✓
//   14 = avis expedition          → expedition.IDexpedition (NOT this commande!)
//   15 = soumission (sst → client)→ commande_sous_traitant.IDcommande_sous_traitant ✓
//                                    `notes` carries the lot identifier
//                                    ("MA105741", "MA107896 (reprise)", …)
//
// Type 14 is intentionally excluded: it lives in the expedition
// polymorphic context. A sst commande #8586 and expedition #8586 are
// unrelated rows with colliding IDs; if we naively join on IDreference
// we surface 2024-era avis-expedition emails on the 2026 sst commande
// (real bug observed on commande 8586). To show expeditions on a sst
// commande's timeline we'd need to walk sst lines → stock_fini →
// ligne_expedition → expedition — out of scope here.
//
// In addition to email events, we also surface client-response
// events from `reponse_soumission` (per-lot approve/reject log).
//
// Rows from a single send burst share the same DATE down to the
// millisecond (4 recipients → 4 rows). We group by IDtype_doc +
// timestamp-truncated-to-second so the UI renders one event per send
// with a recipient list, not one event per recipient.

type HistoriqueEvent =
  | {
      kind: 'email'
      /** Stable group key. */
      id: string
      /** HFSQL DATETIME string (e.g. "2026-03-09 14:17:36"). */
      date: string
      type_doc_id: number
      type_doc_label: string
      recipients: Array<{ email: string; societe: string | null }>
      /** First non-empty `notes` cell in the group — for sst soumissions
       *  this carries the lot identifier (e.g. "MA105741"). */
      notes: string | null
    }
  | {
      kind: 'reponse'
      id: string
      /** HFSQL date "YYYY-MM-DD" (reponse_soumission has no time). */
      date: string
      /** 1 = approuvé, 0 = refusé. */
      reponse: number
      lot: string
      IDclient: number
    }

// Only the type_doc codes whose IDreference points to a commande_sous_traitant.
const HISTORIQUE_TYPE_DOC_IDS = [13, 15] as const

commandesSousTraitantRouter.get('/:id/historique', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    // Read envoi_email rows for this commande. The Linux iODBC bridge
    // can't tokenize the `société` identifier in a SELECT column list, so
    // we fall back to `SELECT *` there and let fixEncoding decode the row
    // dict. Windows keeps the explicit column list. Same pattern as the
    // computePhase soumis-check.
    const rows = IS_WINDOWS
      ? await query<Record<string, unknown>>(
          `SELECT IDenvoi_email, DATE, adresse, société, IDreference, IDtype_doc, notes
           FROM envoi_email
           WHERE IDreference = ${id}
             AND IDtype_doc IN (${HISTORIQUE_TYPE_DOC_IDS.join(',')})
           ORDER BY DATE DESC`,
        )
      : await query<Record<string, unknown>>(
          `SELECT * FROM envoi_email
           WHERE IDreference = ${id}
             AND IDtype_doc IN (${HISTORIQUE_TYPE_DOC_IDS.join(',')})
           ORDER BY DATE DESC`,
        )
    const fixed = await fixEncoding(rows as any[], 'envoi_email', 'IDenvoi_email', ['adresse', 'société', 'notes'])

    // Resolve type_doc labels (small lookup — 29 rows). Fetch once,
    // share across all events.
    const tdRows = await query<{ IDtype_doc: number; nom: string | null }>(
      `SELECT IDtype_doc, nom FROM type_doc
       WHERE IDtype_doc IN (${HISTORIQUE_TYPE_DOC_IDS.join(',')})`,
    )
    const tdFixed = await fixEncoding(tdRows as any[], 'type_doc', 'IDtype_doc', ['nom'])
    const labelMap = new Map<number, string>()
    for (const r of tdFixed as any[]) labelMap.set(Number(r.IDtype_doc), (r.nom ?? '').toString())

    // Group email rows by (IDtype_doc, DATE-to-minute). Truncating to
    // the second isn't enough — a single send burst with many
    // recipients can straddle the second boundary (e.g. 4 emails
    // spanning 17:00:31.855 → 17:00:32.026 would otherwise become two
    // separate "events"). Minute precision keeps real sends together
    // while still distinguishing distinct user actions (no two sends
    // for the same commande + type ever happen within the same minute).
    type EmailEvent = Extract<HistoriqueEvent, { kind: 'email' }>
    const groups = new Map<string, EmailEvent>()
    for (const r of fixed as any[]) {
      const rawDate = (r.DATE ?? '').toString()
      // "2026-03-09 14:17:36.744" → "2026-03-09 14:17" (drop seconds + subseconds).
      const dateMin = rawDate.split('.')[0].replace(/:\d{2}$/, '')
      const dateSec = rawDate.split('.')[0]
      const tdid = Number(r.IDtype_doc) || 0
      const key = `email|${tdid}|${dateMin}`
      const event: EmailEvent = groups.get(key) ?? {
        kind: 'email',
        id: key,
        date: dateSec,
        type_doc_id: tdid,
        type_doc_label: labelMap.get(tdid) ?? `type_doc ${tdid}`,
        recipients: [],
        notes: null,
      }
      const email = (r.adresse ?? '').toString().trim()
      const societe = (r['société'] ?? '').toString().trim() || null
      if (email) event.recipients.push({ email, societe })
      if (!event.notes) {
        const n = (r.notes ?? '').toString().trim()
        if (n) event.notes = n
      }
      groups.set(key, event)
    }

    // Fetch client-response events from reponse_soumission. Keyed
    // directly on IDcommande_sous_traitant, no polymorphism concerns.
    const reponseRows = await query<{
      IDreponse_soumission: number
      DATE: string | null
      reponse: number | null
      lot: string | null
      IDclient: number | null
    }>(
      `SELECT IDreponse_soumission, DATE, reponse, lot, IDclient
       FROM reponse_soumission
       WHERE IDcommande_sous_traitant = ${id}`,
    )
    const reponseFixed = await fixEncoding(reponseRows as any[], 'reponse_soumission', 'IDreponse_soumission', ['lot'])
    const reponseEvents: HistoriqueEvent[] = (reponseFixed as any[]).map((r) => {
      // reponse_soumission.DATE is HFSQL "YYYYMMDD" — convert to "YYYY-MM-DD"
      // so the timeline can sort it alongside the timestamped email events.
      const raw = (r.DATE ?? '').toString()
      const iso = /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}` : raw
      return {
        kind: 'reponse' as const,
        id: `reponse|${Number(r.IDreponse_soumission)}`,
        date: iso,
        reponse: Number(r.reponse) || 0,
        lot: (r.lot ?? '').toString().trim(),
        IDclient: Number(r.IDclient) || 0,
      }
    })

    // Merge + sort by date DESC. For events with the same date, emails
    // (with timestamps) outrank responses (date-only); within emails,
    // SQL already returned them DESC; within responses, order by id
    // DESC as a tie-breaker.
    const merged: HistoriqueEvent[] = [
      ...Array.from(groups.values()),
      ...reponseEvents,
    ].sort((a, b) => {
      // String compare on date works for both "2026-03-09 14:17:36" and "2026-03-09" formats.
      if (a.date !== b.date) return a.date < b.date ? 1 : -1
      // Emails first (richer info), then responses.
      if (a.kind !== b.kind) return a.kind === 'email' ? -1 : 1
      return a.id < b.id ? 1 : -1
    })

    res.json({ events: merged })
  } catch (err) {
    console.error('Error fetching historique:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Create commande ──────────────────────────────────────

commandesSousTraitantRouter.post('/', async (req: Request, res: Response) => {
  try {
    const parsed = commandeBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const d = parsed.data
    const dateCmd = dateStr(d.date_commande)

    // commentaire is still wrapped in minimal RTF (legacy WinDev windows
    // outside the migrated sst commande screen may still read it as RTF).
    // journal is plain text — the legacy screen that bound it is retired.
    const commentaireRtf = wrapRtf(d.commentaire ?? '')
    await query(
      `INSERT INTO commande_sous_traitant
       (IDsous_traitant, date_commande, est_soldee, commentaire, journal,
        IDadresse_sous_traitant, IDadresse_livraison, IDdossier, IDcommande_client, IDligne_commande_client)
       VALUES (${d.IDsous_traitant}, '${dateCmd}', 0, '${esc(commentaireRtf)}', ${sqlText(d.journal ?? '')},
               ${d.IDadresse_sous_traitant ?? 0}, ${d.IDadresse_livraison ?? 0}, 0, 0, 0)`,
    )

    const rows = await query<{ IDcommande_sous_traitant: number }>(
      `SELECT IDcommande_sous_traitant FROM commande_sous_traitant
       WHERE IDsous_traitant = ${d.IDsous_traitant}
       ORDER BY IDcommande_sous_traitant DESC`,
    )
    const newId = rows[0]?.IDcommande_sous_traitant ?? null
    if (newId == null) { res.status(500).json({ error: 'Insert lookup failed' }); return }

    // ── TRM mirror (Tricotage Malterre only — sister company) ──
    // The auto-mirror to TRM's commande_client ledger is SPECIFIC to the
    // sister-company knitter (IDsous_traitant=1). External tricoteurs
    // (JERSEY DE LA BUCHE, MAILL'TUB, AET, …) get the standard sous-
    // traitant workflow with no cross-ledger writes. Best-effort: on
    // failure we log + report mirror_status, but the ETM-side row stays.
    let mirrorStatus: 'created' | 'skipped' | 'failed' | undefined
    let mirrorError: string | undefined
    if (await isTricotageMalterreSst(Number(newId))) {
      try {
        // numero allocator with a small retry loop to absorb concurrent
        // POST collisions on MAX(numero)+1.
        let inserted = false
        let lastErr: unknown = null
        for (let attempt = 0; attempt < 3 && !inserted; attempt++) {
          const numero = await nextTrmNumero()
          try {
            // Accented column names (`archivé`, `expedié`, `envoyé_client`)
            // are omitted: the Linux iODBC bridge can't tokenize accented
            // identifiers, and HFSQL defaults all three to 0 — which is what
            // we'd be setting anyway. See memory project-hfsql-bridge-accent-fix.
            // `commentaire` mirrors the sst header comment onto the TRM
            // bon-de-commande comment (plain text — the legacy TRM order
            // window reads commande_client.commentaire as plain; sqlText keeps
            // accents bridge-safe). The sst side is the source of truth.
            await query(
              `INSERT INTO commande_client
               (IDclient, IDsociete, IDcommande_ETM, numero, date_commande,
                IDadresse_livraison, IDadresse_facturation, IDmode_paiement, IDecheance,
                ref_client, commentaire, est_soldee, remise, donation,
                attente_paiement, frais_port, IDdossier)
               VALUES (1, 2, ${Number(newId)}, ${numero}, '${dateCmd}',
                       1, 1, 3, 2,
                       'commande ${Number(newId)}', ${sqlText(d.commentaire ?? '')}, 0, 0, 0,
                       0, 0, 0)`,
            )
            inserted = true
          } catch (e) {
            lastErr = e
            // Retry on collision; rethrow on any other error after final try.
          }
        }
        if (!inserted) throw lastErr ?? new Error('mirror insert failed after 3 attempts')
        mirrorStatus = 'created'
      } catch (e: any) {
        console.error('[trm-bridge] mirror CREATE failed for sst', newId, e)
        mirrorStatus = 'failed'
        mirrorError = e?.message ? String(e.message) : 'unknown'
      }
    } else {
      mirrorStatus = 'skipped'
    }

    const body: Record<string, unknown> = { IDcommande_sous_traitant: Number(newId) }
    if (mirrorStatus && mirrorStatus !== 'skipped') body.mirror_status = mirrorStatus
    if (mirrorError) body.mirror_error = mirrorError
    res.status(201).json(body)
  } catch (err) {
    console.error('Error creating commande-sous-traitant:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Update commande header ───────────────────────────────

commandesSousTraitantRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const parsed = commandeBody.partial().safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const d = parsed.data

    const sets: string[] = []
    if (d.date_commande !== undefined) sets.push(`date_commande = '${dateStr(d.date_commande)}'`)
    if (d.est_soldee !== undefined) sets.push(`est_soldee = ${d.est_soldee}`)
    if (d.commentaire !== undefined) sets.push(`commentaire = '${esc(wrapRtf(d.commentaire))}'`)
    if (d.journal !== undefined) sets.push(`journal = ${sqlText(d.journal)}`)
    if (d.date_notif !== undefined) sets.push(`date_notif = '${dateStr(d.date_notif)}'`)
    if (d.IDadresse_sous_traitant !== undefined) sets.push(`IDadresse_sous_traitant = ${d.IDadresse_sous_traitant}`)
    if (d.IDadresse_livraison !== undefined) sets.push(`IDadresse_livraison = ${d.IDadresse_livraison}`)

    if (sets.length === 0) { res.status(400).json({ error: 'No fields to update' }); return }

    await query(
      `UPDATE commande_sous_traitant SET ${sets.join(', ')} WHERE IDcommande_sous_traitant = ${id}`,
    )

    // TRM mirror sync (Tricotage Malterre commandes): keep the TRM
    // commande_client in step with the sst header for the fields the user
    // expects to be linked — `date_commande` and the bon-de-commande comment
    // (`commande_client.commentaire`). The sst side is the source of truth, so
    // sst edits overwrite the mirror. commentaire is written plain (the legacy
    // TRM order window reads it as plain text) via sqlText for accent-safe
    // bridge transport. est_soldee/addresses still stay manual.
    let mirrorStatus: 'updated' | 'skipped' | 'failed' | undefined
    let mirrorError: string | undefined
    const wantsMirrorSync = d.date_commande !== undefined || d.commentaire !== undefined
    if (wantsMirrorSync && (await isTricotageMalterreSst(id))) {
      try {
        const mirrorId = await getTrmMirror(id)
        if (mirrorId == null) {
          mirrorStatus = 'skipped'
        } else {
          const mSets: string[] = []
          if (d.date_commande !== undefined) mSets.push(`date_commande = '${dateStr(d.date_commande)}'`)
          if (d.commentaire !== undefined) mSets.push(`commentaire = ${sqlText(d.commentaire)}`)
          if (mSets.length > 0) {
            await query(
              `UPDATE commande_client SET ${mSets.join(', ')} WHERE IDcommande_client = ${mirrorId}`,
            )
          }
          mirrorStatus = 'updated'
        }
      } catch (e: any) {
        console.error('[trm-bridge] HEADER UPDATE mirror failed for sst', id, e)
        mirrorStatus = 'failed'
        mirrorError = e?.message ? String(e.message) : 'unknown'
      }
    }

    const body: Record<string, unknown> = { ok: true }
    if (mirrorStatus) body.mirror_status = mirrorStatus
    if (mirrorError) body.mirror_error = mirrorError
    res.json(body)
  } catch (err) {
    console.error('Error updating commande-sous-traitant:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Status toggle (binary est_soldee) ────────────────────

commandesSousTraitantRouter.put('/:id/etat', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = z.object({ est_soldee: z.number().int().min(0).max(1) }).safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    await query(
      `UPDATE commande_sous_traitant SET est_soldee = ${parsed.data.est_soldee} WHERE IDcommande_sous_traitant = ${id}`,
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('Error toggling commande-sous-traitant etat:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Delete commande (cascade lines + clear ecru affectations) ──

commandesSousTraitantRouter.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    // Refuse the delete outright if a TRM mirror exists. Safe default per
    // the bridge plan: avoid leaving the TRM ledger with dangling
    // back-pointers, OFs, or invoiced/billed history. Operator must remove
    // the mirror via the legacy app first (or via a future cascade-delete
    // pass that checks ordre_fabrication / stock_ecru downstream).
    if ((await getTrmMirror(id)) !== null) {
      res.status(409).json({
        error: 'trm_mirror_exists',
        message: "Cette commande ne peut pas être supprimée depuis MPS_NG. Un miroir client existe côté Tricotage Malterre — utilisez l'application legacy pour la supprimer.",
      })
      return
    }

    // Collect line ids to clear stock_ecru affectations.
    const lines = await query<{ IDligne_commande_sous_traitant: number }>(
      `SELECT IDligne_commande_sous_traitant FROM ligne_commande_sous_traitant WHERE IDcommande_sous_traitant = ${id}`,
    )
    const lineIds = lines.map((l) => Number(l.IDligne_commande_sous_traitant)).filter((x) => x > 0)
    if (lineIds.length > 0) {
      await query(
        `UPDATE stock_ecru SET IDref_commande_affectation = 0
         WHERE IDref_commande_affectation IN (${lineIds.join(',')})`,
      )
    }
    await query(`DELETE FROM ligne_commande_sous_traitant WHERE IDcommande_sous_traitant = ${id}`)
    await query(`DELETE FROM commande_sous_traitant WHERE IDcommande_sous_traitant = ${id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting commande-sous-traitant:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Create line ──────────────────────────────────────────

commandesSousTraitantRouter.post('/:id/lignes', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const parsed = ligneBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const d = parsed.data
    const dateLiv = dateStr(d.date_livraison)

    if (refuseIfTerminee(res, await loadCommandeSoldee(id))) return

    // Defaults for ANY tricoteur sst (TRM or external):
    // - line.type defaults to 1 for tricoteur sst (instead of the legacy 2).
    // - prix defaults to the TRM cost model with 30% margin, floored by
    //   ref_ecru.prix (see [[project-pricing-prixderevient-trm]] / pricing-trm.ts).
    //   When ref_ecru_machine has no rows for the ref or tarif_TRM isn't
    //   set up, the algo bails to 0 and the floor wins by default.
    const isTricoteur = await isTricoteurSst(id)
    // TRM-specific mirror gate — only the sister company gets the
    // cross-ledger commande_client write.
    const isTrm = await isTricotageMalterreSst(id)
    const lineType = d.type ?? (isTricoteur ? 1 : 2)
    let linePrix = d.prix
    if (isTricoteur && (linePrix == null || linePrix === 0)) {
      linePrix = await trmLinePrix(d.IDreference ?? 0, Number(d.quantite) || 0)
    }

    // On creation, date_delai mirrors date_livraison so the "first reschedule"
    // rule has a baseline to compare against later. `type` defaults to 2,
    // the dominant legacy value for ennoblisseur lines (matches stock_ecru
    // references; 4668/7247 legacy lines have type=2).
    //
    // Initial sstatut: starts at Non_Envoye for a fresh commande; if the
    // bon de commande has already been sent (e.g. user adds a line after
    // the fact) the new line skips straight to Attente_Delai so the
    // commande phase doesn't regress.
    const defaultStatut = (await hasBonDeCommandeBeenSent(id))
      ? STATUT_ATTENTE_DELAI
      : STATUT_NON_ENVOYE
    await query(
      `INSERT INTO ligne_commande_sous_traitant
       (IDcommande_sous_traitant, type, IDreference, IDColoris, quantite, unite, prix,
        date_livraison, date_delai, sstatut, commentaire)
       VALUES (${id}, ${lineType}, ${d.IDreference ?? 0}, ${d.IDColoris ?? 0},
               ${n(d.quantite)}, ${d.unite ?? 0}, ${n(linePrix)},
               '${dateLiv}', '${dateLiv}', '${esc(d.sstatut ?? defaultStatut)}', '${esc(d.commentaire ?? '')}')`,
    )

    // Mirror to TRM only for Tricotage Malterre (sister-company knitter).
    let mirrorStatus: 'created' | 'skipped' | 'failed' | undefined
    let mirrorError: string | undefined
    let newSstLineId = 0
    if (isTrm) {
      try {
        // Look up the brand-new sst line id (no RETURNING in HFSQL — we
        // identify the row by (commande, no existing IDligne_commande_ETM
        // back-pointer from cc, ORDER BY id DESC LIMIT 1)).
        const rs = await query<{ IDligne_commande_sous_traitant: number }>(
          `SELECT IDligne_commande_sous_traitant FROM ligne_commande_sous_traitant
           WHERE IDcommande_sous_traitant = ${id}
           ORDER BY IDligne_commande_sous_traitant DESC`,
        )
        newSstLineId = Number(rs[0]?.IDligne_commande_sous_traitant) || 0
        if (newSstLineId === 0) throw new Error('cannot resolve new sst line id')

        const mirrorId = await getTrmMirror(id)
        if (mirrorId == null) {
          // Orphan tricoteur sst (created before the bridge existed). Skip
          // the line mirror; ensureMirror (deferred) will backfill later.
          console.warn('[trm-bridge] LINE CREATE: no mirror cc for sst', id, '— skipping line mirror')
          mirrorStatus = 'skipped'
        } else {
          // ligne_commande_client uses IDcolori (lowercase) — not IDColoris
          // like the sst side. Quirk preserved from legacy schema.
          await query(
            `INSERT INTO ligne_commande_client
             (IDcommande_client, IDligne_commande_ETM, TYPE, IDreference, IDcolori,
              quantite, unite, prix, poids, date_livraison, commentaire)
             VALUES (${mirrorId}, ${newSstLineId}, 1, ${d.IDreference ?? 0}, ${d.IDColoris ?? 0},
                     ${n(d.quantite)}, 1, ${n(linePrix)}, 0,
                     '${dateLiv}', '${esc(d.commentaire ?? '')}')`,
          )
          await refreshTrmRefClient(id, mirrorId)
          mirrorStatus = 'created'
        }
      } catch (e: any) {
        console.error('[trm-bridge] LINE CREATE mirror failed for sst', id, 'line', newSstLineId, e)
        mirrorStatus = 'failed'
        mirrorError = e?.message ? String(e.message) : 'unknown'
      }
    }

    const body: Record<string, unknown> = { ok: true }
    if (mirrorStatus) body.mirror_status = mirrorStatus
    if (mirrorError) body.mirror_error = mirrorError
    res.status(201).json(body)
  } catch (err) {
    console.error('Error creating ligne_commande_sous_traitant:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Update line ──────────────────────────────────────────
// Implements the first-change capture rule for date_delai: if the request
// changes date_livraison AND the row's current date_delai equals the row's
// current date_livraison (never been rescheduled before), promote the
// previous date_livraison into date_delai before applying the new value.

commandesSousTraitantRouter.put('/lignes/:lineId', async (req: Request, res: Response) => {
  try {
    const lineId = parseInt(req.params.lineId, 10)
    if (isNaN(lineId)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const parsed = ligneBody.partial().safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const d = parsed.data

    const commandeId = await loadCommandeIdForLine(lineId)
    if (commandeId == null) { res.status(404).json({ error: 'Line not found' }); return }
    if (refuseIfTerminee(res, await loadCommandeSoldee(commandeId))) return

    // Read current dates + type + IDreference + quantite + sstatut — needed
    // for the delai-initial preservation rule, the tricoteur prix recompute,
    // AND the Attente_Delai → En_Cours auto-flip when the user edits
    // date_livraison.
    const currentRows = await query<{
      date_livraison: string | null
      date_delai: string | null
      type_kind: number | null
      IDreference: number | null
      quantite: number | null
      sstatut: string | null
    }>(
      `SELECT date_livraison, date_delai, type AS type_kind, IDreference, quantite, sstatut
       FROM ligne_commande_sous_traitant WHERE IDligne_commande_sous_traitant = ${lineId}`,
    )
    const cur = currentRows[0] ?? { date_livraison: '', date_delai: '', type_kind: 0, IDreference: 0, quantite: 0, sstatut: '' }

    const sets: string[] = []
    if (d.type !== undefined) sets.push(`type = ${d.type}`)
    if (d.IDreference !== undefined) sets.push(`IDreference = ${d.IDreference}`)
    if (d.IDColoris !== undefined) sets.push(`IDColoris = ${d.IDColoris}`)
    if (d.quantite !== undefined) sets.push(`quantite = ${n(d.quantite)}`)
    if (d.unite !== undefined) sets.push(`unite = ${d.unite}`)
    if (d.prix !== undefined) sets.push(`prix = ${n(d.prix)}`)
    if (d.commentaire !== undefined) sets.push(`commentaire = '${esc(d.commentaire)}'`)
    if (d.sstatut !== undefined) sets.push(`sstatut = '${esc(d.sstatut)}'`)
    if (d.date_livraison !== undefined) {
      const nextLiv = dateStr(d.date_livraison)
      const prevLiv = typeof cur.date_livraison === 'string' ? cur.date_livraison : ''
      const prevDelai = typeof cur.date_delai === 'string' ? cur.date_delai : ''
      // Capture-once rule: only promote prevLiv into date_delai if the line
      // has never been rescheduled before (date_delai still equals
      // date_livraison) AND this update actually changes date_livraison.
      if (nextLiv !== prevLiv && prevDelai === prevLiv && prevLiv) {
        sets.push(`date_delai = '${prevLiv}'`)
      }
      sets.push(`date_livraison = '${nextLiv}'`)
      // State machine: editing date_livraison on an Attente_Delai line
      // means the sst has confirmed a délai → flip to En_Cours. Lines in
      // Non_Envoye keep their status (the bon de commande hasn't been
      // sent yet, the date is hypothetical). An explicit d.sstatut in the
      // patch wins over this auto-flip.
      if (d.sstatut === undefined && (cur.sstatut ?? '').trim() === STATUT_ATTENTE_DELAI) {
        sets.push(`sstatut = '${STATUT_OPEN}'`)
      }
    }

    // Tricoteur prix recompute: when IDreference or quantite changes on a
    // tricoteur line (type=1) AND the caller didn't pass an explicit prix,
    // re-run PrixDeRevientTRM with the post-merge values. Applies to ANY
    // tricoteur (legacy WLanguage gate is `ligne.type = 1`, not TRM-only).
    const effectiveType = d.type !== undefined ? d.type : (Number(cur.type_kind) || 0)
    const refChanged = d.IDreference !== undefined && d.IDreference !== (Number(cur.IDreference) || 0)
    const qtyChanged = d.quantite !== undefined && d.quantite !== (Number(cur.quantite) || 0)
    let recomputedTrmPrix: number | null = null
    if (effectiveType === 1 && d.prix === undefined && (refChanged || qtyChanged)) {
      const nextRef = d.IDreference !== undefined ? d.IDreference : (Number(cur.IDreference) || 0)
      const nextQty = d.quantite !== undefined ? Number(d.quantite) : (Number(cur.quantite) || 0)
      recomputedTrmPrix = await trmLinePrix(nextRef, nextQty)
      sets.push(`prix = ${n(recomputedTrmPrix)}`)
    }

    if (sets.length === 0) { res.status(400).json({ error: 'No fields to update' }); return }

    await query(
      `UPDATE ligne_commande_sous_traitant SET ${sets.join(', ')} WHERE IDligne_commande_sous_traitant = ${lineId}`,
    )

    // Auto-close on "all lines done" was removed when we moved to the
    // computed-phase model — the operator now uses the Clôturer button in
    // the sidebar footer to flip est_soldee manually. `maybeAutoCloseCommande`
    // and `isLineDone` remain in the module (cheap to revert) but are no
    // longer called from the line-update path.

    // TRM mirror sync (Tricotage Malterre only).
    let mirrorStatus: 'updated' | 'skipped' | 'failed' | undefined
    let mirrorError: string | undefined
    if (await isTricotageMalterreSst(commandeId)) {
      try {
        const ccLineId = await getTrmMirrorLine(lineId)
        if (ccLineId == null) {
          console.warn('[trm-bridge] LINE UPDATE: no mirror cc line for sst line', lineId, '— skipping')
          mirrorStatus = 'skipped'
        } else {
          // sst-side prix was already recomputed in the outer block via
          // trmLinePrix when IDreference or quantite changed. Mirror that
          // same value onto the cc line below for ledger parity.

          // Build SET clauses for the cc line (IDColoris → IDcolori).
          const ccSets: string[] = []
          if (d.type !== undefined) ccSets.push(`TYPE = ${d.type}`)
          if (d.IDreference !== undefined) ccSets.push(`IDreference = ${d.IDreference}`)
          if (d.IDColoris !== undefined) ccSets.push(`IDcolori = ${d.IDColoris}`)
          if (d.quantite !== undefined) ccSets.push(`quantite = ${n(d.quantite)}`)
          if (d.unite !== undefined) ccSets.push(`unite = ${d.unite}`)
          if (d.prix !== undefined) ccSets.push(`prix = ${n(d.prix)}`)
          else if (recomputedTrmPrix !== null) ccSets.push(`prix = ${n(recomputedTrmPrix)}`)
          if (d.commentaire !== undefined) ccSets.push(`commentaire = '${esc(d.commentaire)}'`)
          if (d.date_livraison !== undefined) ccSets.push(`date_livraison = '${dateStr(d.date_livraison)}'`)

          if (ccSets.length > 0) {
            await query(
              `UPDATE ligne_commande_client SET ${ccSets.join(', ')} WHERE IDligne_commande_client = ${ccLineId}`,
            )
          }

          // If the ref changed, the cc.ref_client display string needs to
          // pick up the new ref_ecru.reference.
          if (d.IDreference !== undefined) {
            const mirrorId = await getTrmMirror(commandeId)
            if (mirrorId != null) await refreshTrmRefClient(commandeId, mirrorId)
          }
          mirrorStatus = 'updated'
        }
      } catch (e: any) {
        console.error('[trm-bridge] LINE UPDATE mirror failed for sst line', lineId, e)
        mirrorStatus = 'failed'
        mirrorError = e?.message ? String(e.message) : 'unknown'
      }
    }

    const body: Record<string, unknown> = { ok: true }
    if (mirrorStatus) body.mirror_status = mirrorStatus
    if (mirrorError) body.mirror_error = mirrorError
    res.json(body)
  } catch (err) {
    console.error('Error updating ligne_commande_sous_traitant:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Delete line ──────────────────────────────────────────

commandesSousTraitantRouter.delete('/lignes/:lineId', async (req: Request, res: Response) => {
  try {
    const lineId = parseInt(req.params.lineId, 10)
    if (isNaN(lineId)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const commandeId = await loadCommandeIdForLine(lineId)
    if (commandeId == null) { res.status(404).json({ error: 'Line not found' }); return }
    if (refuseIfTerminee(res, await loadCommandeSoldee(commandeId))) return

    // TRM mirror cleanup (Tricotage Malterre only) — must run BEFORE the
    // sst DELETE so we can refuse cleanly if TRM has already started
    // production (ordre_fabrication rows). On refuse, the sst row stays.
    const isTrm = await isTricotageMalterreSst(commandeId)
    let ccLineId: number | null = null
    if (isTrm) {
      ccLineId = await getTrmMirrorLine(lineId)
      if (ccLineId != null) {
        if (await refuseIfTrmHasOFs(res, ccLineId)) return
        await query(`DELETE FROM ligne_commande_client WHERE IDligne_commande_client = ${ccLineId}`)
      }
    }

    // Clear ecru affectations pointing at this line (rolls go back to stock).
    await query(`UPDATE stock_ecru SET IDref_commande_affectation = 0 WHERE IDref_commande_affectation = ${lineId}`)
    await query(`DELETE FROM ligne_commande_sous_traitant WHERE IDligne_commande_sous_traitant = ${lineId}`)

    // Refresh cc.ref_client now that one line is gone.
    if (isTrm && ccLineId != null) {
      const mirrorId = await getTrmMirror(commandeId)
      if (mirrorId != null) {
        try { await refreshTrmRefClient(commandeId, mirrorId) }
        catch (e) { console.error('[trm-bridge] refreshTrmRefClient after LINE DELETE failed', e) }
      }
    }

    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting ligne_commande_sous_traitant:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Pieces drawer (ennoblisseur flow) ────────────────────
//
// Each line of an ennoblisseur commande drives two flows:
//   1. Affectation: take an existing stock_ecru roll (greige fabric we
//      knitted in-house) and mark it as sent to this dyer for finishing.
//      Wire: stock_ecru.IDref_commande_affectation = IDligne_commande_sous_traitant
//   2. Reception: when the dyer returns the dyed roll, we record a new
//      stock_fini row that references both the source écru roll and the
//      sous-traitant commande line.
//      Wire: stock_fini.IDref_commande_source = IDligne_commande_sous_traitant,
//            stock_fini.IDstock_ecru = IDstock_ecru of the original.

interface LineContext {
  commandeId: number
  /** The line's IDreference column — it's an IDref_fini. */
  IDref_fini: number
  /** The line's IDColoris — for a type=2 ennoblisseur line this IS the
   *  intended ref_fini_colori of the produced fini. Authoritative coloris
   *  for rolls received against this line (stock_fini.IDColoris). */
  IDColoris: number
  /** The IDref_ecru that ref_fini maps to (via ref_fini.IDref_ecru). Used
   *  to filter compatible écru rolls for the drawer. */
  IDref_ecru: number
  /** The commande's sous-traitant. Doubles as a magasin id (stock_*.IDmagasin
   *  is the same id space as sous_traitant.IDsous_traitant) — used to narrow
   *  the "Affecter des rouleaux écru" picker to rolls physically present at
   *  the ennoblisseur's warehouse. */
  IDsous_traitant: number
}

async function loadEnnoblisseurLineContext(
  commandeId: number,
  ligneId: number,
): Promise<LineContext | null> {
  const lineRows = await query<{
    IDcommande_sous_traitant: number
    IDreference: number | null
    IDColoris: number | null
  }>(
    `SELECT IDcommande_sous_traitant, IDreference, IDColoris
     FROM ligne_commande_sous_traitant
     WHERE IDligne_commande_sous_traitant = ${ligneId}`,
  )
  if (lineRows.length === 0) return null
  const line = lineRows[0] as any
  if (Number(line.IDcommande_sous_traitant) !== commandeId) return null
  const IDref_fini = Number(line.IDreference) || 0
  const IDColoris = Number(line.IDColoris) || 0

  // Resolve the écru ref via ref_fini.IDref_ecru — that's the ref the
  // ennoblisseur receives (greige rolls of that ecru ref are dyed/finished
  // into rolls of this fini ref).
  let IDref_ecru = 0
  if (IDref_fini > 0) {
    const r = await query<{ IDref_ecru: number | null }>(
      `SELECT IDref_ecru FROM ref_fini WHERE IDref_fini = ${IDref_fini}`,
    )
    IDref_ecru = Number((r[0] as any)?.IDref_ecru) || 0
  }

  // Resolve the sous-traitant id for the magasin-based available-rolls filter.
  const sst = await query<{ IDsous_traitant: number | null }>(
    `SELECT IDsous_traitant FROM commande_sous_traitant
     WHERE IDcommande_sous_traitant = ${commandeId}`,
  )
  const IDsous_traitant = Number((sst[0] as any)?.IDsous_traitant) || 0

  return { commandeId, IDref_fini, IDColoris, IDref_ecru, IDsous_traitant }
}

/** Create a `suivilot` row for a (ligne, lot) pair.
 *
 *  Legacy behaviour: ONE `suivilot` row per (IDligne_commande_sous_traitant,
 *  lot). The row identifies the lot + carries the demande fields copied
 *  from `ref_fini` at creation. `quantite_receptionnee` and
 *  `metrage_receptionne` start at 0 and are filled by a downstream
 *  workflow (verified against the user's MA108050-Actual sample). We
 *  match that exactly — no auto-aggregation on reception.
 *
 *  - Empty/whitespace lot → no-op (matches legacy: stock_fini rows with
 *    empty lot have no suivilot).
 *  - If a suivilot already exists for the same (ligne, lot) → no-op
 *    (the lot is already tracked).
 *  - First call → INSERT with totals=0, IDetatLot=1 (initial state, set
 *    by the legacy app on creation; later workflow steps advance it).
 *  - `IDColoris` / `IDref_fini_colori` come from the LINE, not the
 *    écru's `IDcolori_ecru` — fini lines reference `ref_fini_colori`.
 *  - Accented columns (`stabL_demandée`, `stabH_demandée`,
 *    `freinte_demandée`, `approuvé_qualité`) are omitted on Linux
 *    because the bridge rejects them in INSERT clauses. HFSQL fills
 *    its own defaults there.
 *  - Failures are logged but never bubble up: the stock_fini reception
 *    is the user's primary action, and a missing suivilot row is a
 *    secondary annoyance, not data loss.
 */
async function upsertSuivilot(opts: {
  commandeId: number
  ligneId: number
  lot: string
}): Promise<void> {
  const lot = (opts.lot ?? '').trim()
  if (lot.length === 0) return
  try {
    const existing = await query<{ IDsuivilot: number }>(
      `SELECT IDsuivilot FROM suivilot
       WHERE IDligne_commande_sous_traitant = ${opts.ligneId} AND lot = '${esc(lot)}'`,
    )
    if (existing.length > 0) return  // Lot already tracked.

    // Resolve everything else from the line + parent commande + ref_fini.
    const lineRows = await query<{ IDreference: number | null; IDColoris: number | null }>(
      `SELECT IDreference, IDColoris FROM ligne_commande_sous_traitant
       WHERE IDligne_commande_sous_traitant = ${opts.ligneId}`,
    )
    const IDref_fini = Number(lineRows[0]?.IDreference) || 0
    const IDColoris = Number(lineRows[0]?.IDColoris) || 0
    const cmdRows = await query<{ IDsous_traitant: number | null }>(
      `SELECT IDsous_traitant FROM commande_sous_traitant WHERE IDcommande_sous_traitant = ${opts.commandeId}`,
    )
    const IDsous_traitant = Number(cmdRows[0]?.IDsous_traitant) || 0
    const refRows = IDref_fini > 0
      ? await query<{
          laizeHT_Moy: number | null
          poids_Moy: number | null
          rendement: number | null
          freinte: number | null
          stab_hauteur: number | null
          stab_largeur: number | null
        }>(
          `SELECT laizeHT_Moy, poids_Moy, rendement, freinte, stab_hauteur, stab_largeur
           FROM ref_fini WHERE IDref_fini = ${IDref_fini}`,
        )
      : []
    const ref = refRows[0] ?? {
      laizeHT_Moy: null, poids_Moy: null, rendement: null,
      freinte: null, stab_hauteur: null, stab_largeur: null,
    }

    const today = new Date()
    const dateStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`

    // For fini lines, ligne.IDColoris IS the ref_fini_colori id —
    // legacy verified: every sample row has IDColoris == IDref_fini_colori.
    const baseCols = [
      'IDref_fini_colori', 'IDcommande_sous_traitant', 'IDsous_traitant', 'DATE', 'lot',
      'laize_demandee', 'poids_demande', 'rendement_demande',
      'quantite_receptionnee', 'metrage_receptionne',
      'IDref_fini', 'IDColoris', 'IDligne_commande_sous_traitant', 'IDetatLot',
    ]
    const baseVals = [
      String(IDColoris),
      String(opts.commandeId),
      String(IDsous_traitant),
      `'${dateStr}'`,
      `'${esc(lot)}'`,
      String(n(ref.laizeHT_Moy)),
      String(n(ref.poids_Moy)),
      String(n(ref.rendement)),
      '0',
      '0',
      String(IDref_fini),
      String(IDColoris),
      String(opts.ligneId),
      '1',
    ]
    // Accented columns — only on Windows. Linux will get HFSQL's column
    // defaults (typically 0 / NULL) and the user can backfill via the
    // legacy app if those values are needed.
    if (IS_WINDOWS) {
      baseCols.push('stabL_demandée', 'stabH_demandée', 'freinte_demandée', 'approuvé_qualité')
      baseVals.push(
        String(n(ref.stab_hauteur)),
        String(n(ref.stab_largeur)),
        String(n(ref.freinte)),
        '0',
      )
    }
    await query(
      `INSERT INTO suivilot (${baseCols.join(', ')}) VALUES (${baseVals.join(', ')})`,
    )
  } catch (err) {
    console.error(`upsertSuivilot failed for ligne=${opts.ligneId} lot=${lot}:`, err)
  }
}

/** True when a suivilot row carries operator-entered contrôles data worth
 *  preserving (measurements, observations, archivage). Only ASCII columns are
 *  checked — the accented `*_demandée` spec columns are system-filled copies
 *  of ref_fini and carry no operator input. */
function suivilotHasControles(row: Record<string, unknown>): boolean {
  const numCols = [
    'laize_sst', 'poids_sst', 'rendement_sst', 'stabH_sst', 'stabL_sst',
    'laize_tirelle', 'poids_tirelle', 'rendement_tirelle', 'stabH_tirelle', 'stabL_tirelle',
  ]
  if (numCols.some((c) => Number(row[c]) > 0)) return true
  const textCols = ['observations', 'emplacement_tirelle', 'fin_archivage']
  return textCols.some((c) => (row[c] ?? '').toString().replace(/\0/g, '').trim() !== '')
}

/** Re-key the suivilot tracking of (ligneId, oldLot) onto newLot after a
 *  reprise edit renamed a roll's lot (see the PATCH handler). Invoked once
 *  per patched roll, AFTER the stock_fini UPDATE:
 *   - rolls still left under oldLot → just ensure newLot is tracked (the
 *     old suivilot still legitimately describes the remaining rolls);
 *   - oldLot empty → migrate: rename the old suivilot to newLot when the
 *     new lot is untracked; when both rows exist keep whichever carries
 *     contrôles data (the loser is deleted only if it carries none, so
 *     operator input is never destroyed — worst case both rows survive
 *     and the état sync below still fixes the visible status). */
async function migrateSuivilotLot(opts: {
  commandeId: number
  ligneId: number
  oldLot: string
  newLot: string
}): Promise<void> {
  const { commandeId, ligneId, oldLot, newLot } = opts
  const [oldRows, newRows, remaining] = await Promise.all([
    oldLot
      ? query<Record<string, unknown>>(
          `SELECT * FROM suivilot
           WHERE IDligne_commande_sous_traitant = ${ligneId} AND lot = ${sqlText(oldLot)}`,
        )
      : Promise.resolve([] as Record<string, unknown>[]),
    query<Record<string, unknown>>(
      `SELECT * FROM suivilot
       WHERE IDligne_commande_sous_traitant = ${ligneId} AND lot = ${sqlText(newLot)}`,
    ),
    oldLot
      ? query<{ n: number }>(
          `SELECT COUNT(*) AS n FROM stock_fini
           WHERE IDref_commande_source = ${ligneId} AND lot = ${sqlText(oldLot)}`,
        )
      : Promise.resolve([{ n: 0 }]),
  ])
  const oldId = Number(oldRows[0]?.IDsuivilot) || 0
  const newId = Number(newRows[0]?.IDsuivilot) || 0
  const oldLotEmpty = Number(remaining[0]?.n) === 0

  if (!oldLotEmpty || oldId === 0) {
    // Old lot still live (or was never tracked): only ensure the new lot
    // is tracked so it surfaces in Qualité.
    if (newId === 0) await upsertSuivilot({ commandeId, ligneId, lot: newLot })
    return
  }

  // Old lot has no rolls left — its suivilot must not linger.
  if (newId === 0) {
    await query(`UPDATE suivilot SET lot = ${sqlText(newLot)} WHERE IDsuivilot = ${oldId}`)
    return
  }
  const oldHasData = suivilotHasControles(oldRows[0])
  const newHasData = suivilotHasControles(newRows[0])
  if (oldHasData && !newHasData) {
    // Typical batch tail: the new-lot row is a placeholder created by an
    // earlier roll of this same batch — keep the old row's contrôles.
    await query(`DELETE FROM suivilot WHERE IDsuivilot = ${newId}`)
    await query(`UPDATE suivilot SET lot = ${sqlText(newLot)} WHERE IDsuivilot = ${oldId}`)
  } else if (!oldHasData) {
    await query(`DELETE FROM suivilot WHERE IDsuivilot = ${oldId}`)
  } else {
    console.warn(
      `Suivilot migration ligne=${ligneId}: both '${oldLot}' (#${oldId}) and '${newLot}' (#${newId}) carry contrôles — keeping both.`,
    )
  }
}

/** Quality defect recorded against an écru roll. Stored in the legacy
 *  `defaut_qualite` table with a polymorphic link: when
 *  `Type_Reference = 2`, `reference` is a stringified `IDstock_ecru`.
 *  Multiple defects per piece are possible (each is its own row), so
 *  the per-roll payload carries an array. */
interface DefautQualite {
  IDdefaut_qualite: number
  description: string | null
  type_defaut: string | null
  taille_cm: number | null
}

interface StockEcruLite {
  IDstock_ecru: number
  numero: string | null
  lot: string | null
  poids: number | null
  metrage: number | null
  IDref_ecru: number
  IDcolori_ecru: number
  IDmagasin: number
  IDordre_fabrication: number
  date_saisie: string | null
  // Quality + free-text notes. `second_choix` is the legacy
  // 0-or-positive flag the textile industry uses to mark downgraded
  // rolls ("second choix"). Surfaced as a destructive badge in the
  // drawer; `observations` renders as the italic comment line.
  second_choix: number | null
  observations: string | null
  /** Structured defects from `defaut_qualite` (visiteur-logged). Empty
   *  array when the piece has none. Distinct from the free-text
   *  `observations` field — both can coexist on the same roll. */
  defects?: DefautQualite[]
  // Customer reservation: when the sous-traitant order was created from
  // a commande_client screen in the legacy ERP, the stock_ecru roll keeps
  // a back-pointer to the originating client line. We chase the chain
  // stock_ecru.IDligne_commande_client → ligne_commande_client.IDcommande_client
  // → commande_client.IDclient → client.nom so the UI can tag the roll
  // with the customer it's been earmarked for. Only set on linked rolls;
  // the `ecruAvailable` list omits these fields (they're not needed in the
  // picker UI, and including them would require resolving the chain for
  // every unaffected roll of the ref).
  IDligne_commande_client?: number
  client_nom?: string | null
}

interface StockFiniLite {
  IDstock_fini: number
  numero: string | null
  lot: string | null
  poids: number | null
  metrage: number | null
  IDref_fini: number
  IDColoris: number
  IDstock_ecru: number
  IDmagasin: number
  date_saisie: string | null
  // Two distinct free-text fields on stock_fini: the visitor's note
  // (`observations`, captured when the roll is checked in) and the
  // ennoblisseur's note (`observation_sst`). They're surfaced as two
  // separate italic lines in the card so the source of each comment
  // stays clear. `second_choix` mirrors the écru behaviour.
  second_choix: number | null
  observations: string | null
  observation_sst: string | null
  /** Workflow state from `etat_stock_fini`:
   *    1=En Contrôle, 2=En Reprise, 3=Validé, 4=Expédié, 5=Attente de décision.
   *  New receptions enter at 1; the legacy app advances it as the roll
   *  moves through inspection / shipping. */
  IDetat_stock_fini: number | null
  /** Resolved client name when this fini is reserved for a client order —
   *  derived from `stock_fini.IDligne_commande_client` walked through
   *  ligne_commande_client → commande_client → client. Inherited from
   *  the source écru's reservation at reception time. */
  client_nom?: string | null
}

async function fetchPiecesPayload(ctx: LineContext, ligneId: number): Promise<{
  ecruLinked: StockEcruLite[]
  ecruAvailable: StockEcruLite[]
  finiReceived: StockFiniLite[]
  /** Current `ligne_commande_sous_traitant.prix` for this line. Surfaced
   *  so the link/unlink endpoints can return the freshly-recalculated
   *  price without forcing the frontend to refetch the whole commande
   *  detail. Read from the row after any in-flight recalc has persisted. */
  prix: number
}> {
  // Linked écru rolls — those already affected to this line.
  const linkedRows = await query<StockEcruLite>(
    `SELECT IDstock_ecru, numero, lot, poids, metrage, IDref_ecru, IDcolori_ecru,
            IDmagasin, IDordre_fabrication, date_saisie, IDligne_commande_client,
            second_choix, observations
     FROM stock_ecru
     WHERE IDref_commande_affectation = ${ligneId}
     ORDER BY date_saisie DESC, IDstock_ecru DESC`,
  )
  const linkedFixed = await fixEncoding(linkedRows, 'stock_ecru', 'IDstock_ecru', ['numero', 'lot', 'observations'])

  // Pull fini rows up front so their IDligne_commande_client values
  // join the same client-name lookup pass used for écru (one chain walk
  // instead of two). Fini rolls inherit the écru's client reservation
  // on creation — that lcc id propagates into stock_fini and we surface
  // it as `client_nom` on the response so the Réception card can render
  // the same client badge.
  const finiRowsRaw = await query<StockFiniLite & { IDligne_commande_client?: number | null }>(
    `SELECT IDstock_fini, numero, lot, poids, metrage, IDref_fini, IDColoris,
            IDstock_ecru, IDmagasin, date_saisie, observations, observation_sst, second_choix,
            IDetat_stock_fini, IDligne_commande_client
     FROM stock_fini
     WHERE IDref_commande_source = ${ligneId}
     ORDER BY date_saisie DESC, IDstock_fini DESC`,
  )
  const finiFixed = await fixEncoding(finiRowsRaw, 'stock_fini', 'IDstock_fini', ['numero', 'lot', 'observations', 'observation_sst'])

  // Resolve each roll's client reservation in two batched JOIN hops.
  // We can't do a 3-way JOIN here because the legacy bridge has issues
  // with CONVERT() across joins (see CLAUDE.md), so we walk the chain
  // ligne_commande_client → commande_client → client manually and
  // assemble the name map.
  const clientByLcc = new Map<number, string>()
  const lccIds = Array.from(new Set([
    ...linkedFixed.map((r) => Number(r.IDligne_commande_client) || 0),
    ...finiFixed.map((r) => Number((r as any).IDligne_commande_client) || 0),
  ].filter((x) => x > 0)))
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
    if (ccIds.length > 0) {
      const ccRows = await query<{ IDcommande_client: number; IDclient: number }>(
        `SELECT IDcommande_client, IDclient FROM commande_client
         WHERE IDcommande_client IN (${ccIds.join(',')})`,
      )
      for (const r of ccRows) clientIdByCC.set(Number(r.IDcommande_client), Number(r.IDclient))
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
      const cid = clientIdByCC.get(Number(r.IDcommande_client))
      if (cid && cid > 0) {
        const nm = nameById.get(cid)
        if (nm) clientByLcc.set(Number(r.IDligne_commande_client), nm)
      }
    }
  }

  // Available écru rolls — every roll of the ref_ecru that maps to this
  // fini line, currently unaffected AND physically present at the sous-
  // traitant's magasin (stock_ecru.IDmagasin = ctx.IDsous_traitant). The
  // legacy MPS workflow only links rolls the ennoblisseur actually holds;
  // showing Malterre-magasin rolls here would let an operator link rolls
  // that still need to be transferred. Coloris is intentionally not
  // filtered: the ennoblisseur dyes regardless of source coloris.
  let available: StockEcruLite[] = []
  if (ctx.IDref_ecru > 0 && ctx.IDsous_traitant > 0) {
    const availRows = await query<StockEcruLite>(
      `SELECT IDstock_ecru, numero, lot, poids, metrage, IDref_ecru, IDcolori_ecru,
              IDmagasin, IDordre_fabrication, date_saisie,
              second_choix, observations
       FROM stock_ecru
       WHERE IDref_ecru = ${ctx.IDref_ecru}
         AND IDmagasin = ${ctx.IDsous_traitant}
         AND (IDref_commande_affectation IS NULL OR IDref_commande_affectation = 0)
         AND (IDcommande_donation IS NULL OR IDcommande_donation = 0)
       ORDER BY date_saisie DESC, IDstock_ecru DESC`,
    )
    available = await fixEncoding(availRows, 'stock_ecru', 'IDstock_ecru', ['numero', 'lot', 'observations'])
  }

  // Batch-fetch structured defects from `defaut_qualite` for every écru
  // roll we're about to return (linked + available). The link is
  // polymorphic — Type_Reference=2 with reference (string) =
  // IDstock_ecru. We group by IDstock_ecru and attach as `defects` so
  // the UI can render them in the red banner alongside `observations`.
  const allEcruIds = Array.from(new Set<number>([
    ...linkedFixed.map((r) => Number(r.IDstock_ecru) || 0),
    ...available.map((r) => Number(r.IDstock_ecru) || 0),
  ].filter((x) => x > 0)))
  const defectsByEcruId = new Map<number, DefautQualite[]>()
  if (allEcruIds.length > 0) {
    const inList = allEcruIds.map((id) => `'${id}'`).join(',')
    const defaultRows = await query<{
      IDdefaut_qualite: number
      reference: string | null
      description: string | null
      type_defaut: string | null
      taille_cm: number | null
    }>(
      `SELECT IDdefaut_qualite, reference, description, type_defaut, taille_cm
       FROM defaut_qualite
       WHERE Type_Reference = 2 AND reference IN (${inList})`,
    )
    const defaultsFixed = await fixEncoding(defaultRows, 'defaut_qualite', 'IDdefaut_qualite', ['description', 'type_defaut'])
    for (const d of defaultsFixed as any[]) {
      const refId = parseInt(String(d.reference ?? ''), 10)
      if (!(refId > 0)) continue
      const arr = defectsByEcruId.get(refId) ?? []
      arr.push({
        IDdefaut_qualite: Number(d.IDdefaut_qualite),
        description: d.description ?? null,
        type_defaut: d.type_defaut ?? null,
        taille_cm: Number(d.taille_cm) || 0,
      })
      defectsByEcruId.set(refId, arr)
    }
  }

  const linked = linkedFixed.map((r) => ({
    ...r,
    client_nom: clientByLcc.get(Number(r.IDligne_commande_client) || 0) ?? null,
    defects: defectsByEcruId.get(Number(r.IDstock_ecru) || 0) ?? [],
  }))
  available = available.map((r) => ({
    ...r,
    defects: defectsByEcruId.get(Number(r.IDstock_ecru) || 0) ?? [],
  }))

  // Attach client_nom to each fini using the shared clientByLcc map
  // built above. The raw IDligne_commande_client comes from the stock_fini
  // SELECT (already fetched into finiFixed); it isn't part of the public
  // StockFiniLite shape so we read it as any.
  const fini = finiFixed.map((r) => {
    const lcc = Number((r as any).IDligne_commande_client) || 0
    return {
      ...r,
      client_nom: lcc > 0 ? (clientByLcc.get(lcc) ?? null) : null,
    }
  })

  // Read the line's current prix so the caller can patch the frontend
  // detail cache without a full refetch. We re-read here (rather than
  // passing it in) so the value reflects any recalc that ran between
  // the link/unlink mutation and this fetch.
  const prixRows = await query<{ prix: number | null }>(
    `SELECT prix FROM ligne_commande_sous_traitant WHERE IDligne_commande_sous_traitant = ${ligneId}`,
  )
  const prix = Number(prixRows[0]?.prix) || 0

  return {
    ecruLinked: linked as StockEcruLite[],
    ecruAvailable: available as StockEcruLite[],
    finiReceived: fini as StockFiniLite[],
    prix,
  }
}

commandesSousTraitantRouter.get('/:commandeId/lignes/:ligneId/pieces', async (req: Request, res: Response) => {
  try {
    const commandeId = parseInt(req.params.commandeId, 10)
    const ligneId = parseInt(req.params.ligneId, 10)
    if (isNaN(commandeId) || isNaN(ligneId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const ctx = await loadEnnoblisseurLineContext(commandeId, ligneId)
    if (!ctx) { res.status(404).json({ error: 'Line not found or does not belong to commande' }); return }
    res.json(await fetchPiecesPayload(ctx, ligneId))
  } catch (err) {
    console.error('Error fetching line pieces:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Tricoteur (type=1) drawer ──────────────────────────────────────────
//
// Read-only sibling to loadEnnoblisseurLineContext / fetchPiecesPayload.
// A tricoteur line's IDreference is the OUTPUT IDref_ecru — what the
// knitter is asked to produce (NOT the input yarn; the yarn composition
// lives in `composition_ecru`, keyed by IDref_ecru + IDcolori_ecru).
// Confirmed against legacy commande 8582 / ligne 8558: IDreference=146
// resolves to ref_ecru "029" in the WinDev app, while IDref_fil=146 (yarn
// "1/50 VISCOSE/LAINE 75/25") is a numeric-ID collision per CLAUDE.md.
//
// The drawer surfaces:
//   • Réception — stock_ecru rolls produced by the knitter, linked to the
//     line via IDref_commande_affectation (same projection as ennoblisseur's
//     "linked écru", so the existing roll card can be reused).
//   • Stock fil — every stock_fil roll of every IDref_fil that appears in
//     composition_ecru WHERE IDref_ecru = line.IDreference. This shows
//     the operator the on-hand yarn that could feed this écru's knitting
//     run, regardless of coloris variant / fournisseur / magasin.
//
// No batch reception, no link/unlink, no auto-pricing — those are deferred.

interface TricoteurLineContext {
  commandeId: number
  /** The line's IDreference column — it's an IDref_ecru (output écru). */
  IDref_ecru: number
  /** The line's IDColoris column — it's an IDcolori_ecru. Used to scope
   *  composition_ecru to the exact yarn variant the knitter must use to
   *  produce this écru in this specific colour (e.g. "ecru" vs a dyed
   *  variant of the same ref_ecru). */
  IDcolori_ecru: number
}

async function loadTricoteurLineContext(
  commandeId: number,
  ligneId: number,
): Promise<TricoteurLineContext | null> {
  const lineRows = await query<{
    IDcommande_sous_traitant: number
    IDreference: number | null
    IDColoris: number | null
    type_kind: number | null
  }>(
    `SELECT IDcommande_sous_traitant, IDreference, IDColoris, type AS type_kind
     FROM ligne_commande_sous_traitant
     WHERE IDligne_commande_sous_traitant = ${ligneId}`,
  )
  if (lineRows.length === 0) return null
  const line = lineRows[0] as any
  if (Number(line.IDcommande_sous_traitant) !== commandeId) return null
  if (Number(line.type_kind) !== 1) return null
  return {
    commandeId,
    IDref_ecru: Number(line.IDreference) || 0,
    IDcolori_ecru: Number(line.IDColoris) || 0,
  }
}

interface StockFilLite {
  IDstock_fil: number
  IDref_fil: number
  IDcolori_fil: number | null
  IDfournisseur: number | null
  IDMagasin: number | null
  IDref_fil_commande: number | null
  stock: number | null
  lot: string | null
  lot_frs: string | null
  emplacement: string | null
  date_entree: string | null
  /** Resolved display names (flat batch lookups, no JOIN+CONVERT — see
   *  CLAUDE.md HFSQL rules: JOIN + CONVERT() collapses result sets). */
  ref_fil_reference?: string | null
  colori_reference?: string | null
  fournisseur_nom?: string | null
  magasin_nom?: string | null
  /** Sum of asso_fil_lignecmdsst.quantite for (this lot, this line) — kg
   *  of yarn currently affected from this lot to the line. 0 means not
   *  affected. Used by the Stock fil tab to render the "affecté X kg"
   *  chip and to gate the Affecter/Désaffecter button switch. */
  affecte_kg?: number
}

// ── Yarn affectation helpers (asso_fil_lignecmdsst) ──────────
//
// Per-lot yarn → sst-line junction. Schema (730 rows in prod):
//   IDasso_fil_ligneCmdSST (PK, camelCase per legacy)
//   IDstock_fil            (the yarn lot consumed)
//   IDligne_commande_sous_traitant
//   quantite               (kg of this lot affected to this line)
//
// stock_fil.stock is NOT decremented by affectation (verified: legacy
// affectations can sum >> physical stock; physical decrement happens
// elsewhere, probably at reception time in the WinDev app). Treat asso
// rows as PLAN/RESERVATION, not physical movement.

interface CompositionPair {
  IDref_fil: number
  IDcolori_fil: number
  pourcentage: number  // 0..100 (legacy stores as 94 for 94%)
}

/** Yarn composition pairs for a given (IDref_ecru, IDcolori_ecru). Used
 *  both by the Stock fil tab filter AND by the affectation planner. */
async function loadCompositionPairs(
  IDref_ecru: number,
  IDcolori_ecru: number,
): Promise<CompositionPair[]> {
  if (!(IDref_ecru > 0)) return []
  const where = IDcolori_ecru > 0
    ? `IDref_ecru = ${IDref_ecru} AND IDcolori_ecru = ${IDcolori_ecru}`
    : `IDref_ecru = ${IDref_ecru}`
  const rows = await query<{ IDref_fil: number; IDcolori_fil: number; pourcentage: number | null }>(
    `SELECT DISTINCT IDref_fil, IDcolori_fil, pourcentage FROM composition_ecru
     WHERE ${where} AND IDref_fil > 0`,
  )
  return rows
    .map((r) => ({
      IDref_fil: Number(r.IDref_fil) || 0,
      IDcolori_fil: Number(r.IDcolori_fil) || 0,
      pourcentage: Number(r.pourcentage) || 0,
    }))
    .filter((p) => p.IDref_fil > 0 && p.pourcentage > 0)
}

interface AffectationRow {
  IDasso_fil_ligneCmdSST: number
  IDstock_fil: number
  IDligne_commande_sous_traitant: number
  quantite: number
}

async function loadAffectationsForLine(ligneId: number): Promise<AffectationRow[]> {
  const rows = await query<AffectationRow>(
    `SELECT IDasso_fil_ligneCmdSST, IDstock_fil, IDligne_commande_sous_traitant, quantite
     FROM asso_fil_lignecmdsst WHERE IDligne_commande_sous_traitant = ${ligneId}`,
  )
  return rows.map((r) => ({
    IDasso_fil_ligneCmdSST: Number(r.IDasso_fil_ligneCmdSST) || 0,
    IDstock_fil: Number(r.IDstock_fil) || 0,
    IDligne_commande_sous_traitant: Number(r.IDligne_commande_sous_traitant) || 0,
    quantite: Number(r.quantite) || 0,
  }))
}

interface StockLotMini {
  IDstock_fil: number
  IDref_fil: number
  IDcolori_fil: number
  stock: number
  lot: string
  date_entree: string
}

async function loadStockLotsByIds(ids: number[]): Promise<StockLotMini[]> {
  if (ids.length === 0) return []
  const rows = await query<{
    IDstock_fil: number
    IDref_fil: number
    IDcolori_fil: number
    stock: number | null
    lot: string | null
    date_entree: string | null
  }>(
    `SELECT IDstock_fil, IDref_fil, IDcolori_fil, stock, lot, date_entree
     FROM stock_fil WHERE IDstock_fil IN (${ids.join(',')})`,
  )
  const fixed = await fixEncoding(rows, 'stock_fil', 'IDstock_fil', ['lot'])
  return (fixed as any[]).map((r) => ({
    IDstock_fil: Number(r.IDstock_fil) || 0,
    IDref_fil: Number(r.IDref_fil) || 0,
    IDcolori_fil: Number(r.IDcolori_fil) || 0,
    stock: Number(r.stock) || 0,
    lot: (r.lot ?? '').toString(),
    date_entree: (r.date_entree ?? '').toString(),
  }))
}

interface AffectationPlanEntry {
  IDstock_fil: number
  quantite: number
}

interface AffectationPlanResult {
  ok: boolean
  errors: string[]
  /** target line qty in kg — input as-is for `standard`, computed for `finir`. */
  targetQtyKg: number
  plan: AffectationPlanEntry[]
  /** Only set for `finir` mode — the lot whose stock is consumed entirely. */
  limitingLot?: { IDstock_fil: number; lot: string }
}

/** Distribute the target line quantity (in kg of écru) across the selected
 *  yarn lots, respecting composition_ecru percentages. Pure function over
 *  pre-fetched lot data; no DB access. FIFO by date_entree within a bucket. */
function computeAffectationPlan(args: {
  targetQtyKg: number
  selectedLots: StockLotMini[]
  pairs: CompositionPair[]
}): AffectationPlanResult {
  const errors: string[] = []
  const { targetQtyKg, selectedLots, pairs } = args

  if (!(targetQtyKg > 0)) errors.push("La quantité de la ligne doit être supérieure à 0.")
  if (pairs.length === 0) errors.push("Aucune composition n'est définie pour cet écru. Vérifiez `composition_ecru`.")
  if (selectedLots.length === 0) errors.push("Sélectionnez au moins un lot.")

  // Group lots by (IDref_fil, IDcolori_fil) bucket.
  const bucketKey = (rf: number, cf: number) => `${rf}:${cf}`
  const lotsByBucket = new Map<string, StockLotMini[]>()
  for (const lot of selectedLots) {
    const k = bucketKey(lot.IDref_fil, lot.IDcolori_fil)
    const arr = lotsByBucket.get(k) ?? []
    arr.push(lot)
    lotsByBucket.set(k, arr)
  }
  // Sort each bucket FIFO (oldest first).
  for (const arr of lotsByBucket.values()) {
    arr.sort((a, b) => (a.date_entree || '').localeCompare(b.date_entree || ''))
  }

  // Every required composition pair must have at least one selected lot.
  const plan: AffectationPlanEntry[] = []
  for (const pair of pairs) {
    const k = bucketKey(pair.IDref_fil, pair.IDcolori_fil)
    const bucket = lotsByBucket.get(k) ?? []
    if (bucket.length === 0) {
      errors.push(`Lot manquant pour la composition (ref_fil=${pair.IDref_fil}, coloris=${pair.IDcolori_fil}, ${pair.pourcentage}%).`)
      continue
    }
    let needed = targetQtyKg * (pair.pourcentage / 100)
    for (const lot of bucket) {
      if (needed <= 0) break
      const take = Math.min(needed, lot.stock)
      if (take > 0) {
        plan.push({ IDstock_fil: lot.IDstock_fil, quantite: take })
        needed -= take
      }
    }
    if (needed > 0.01) {
      errors.push(`Stock insuffisant pour la composition (ref_fil=${pair.IDref_fil}, coloris=${pair.IDcolori_fil}) — manque ${needed.toFixed(2)} kg.`)
    }
  }

  // Reject lots in user selection that don't match any pair (defensive
  // — the UI should never let the user select these, but enforce here).
  const validKeys = new Set(pairs.map((p) => bucketKey(p.IDref_fil, p.IDcolori_fil)))
  for (const lot of selectedLots) {
    if (!validKeys.has(bucketKey(lot.IDref_fil, lot.IDcolori_fil))) {
      errors.push(`Le lot ${lot.lot || lot.IDstock_fil} ne correspond pas à la composition de l'écru.`)
    }
  }

  return { ok: errors.length === 0, errors, targetQtyKg, plan }
}

/** "Finir le lot X" — compute the max producible écru qty using the most
 *  limiting selected bucket entirely. */
function computeFinirLotPlan(args: {
  selectedLots: StockLotMini[]
  pairs: CompositionPair[]
}): AffectationPlanResult {
  const errors: string[] = []
  const { selectedLots, pairs } = args

  if (pairs.length === 0) errors.push("Aucune composition n'est définie pour cet écru.")
  if (selectedLots.length === 0) errors.push("Sélectionnez au moins un lot.")

  const bucketKey = (rf: number, cf: number) => `${rf}:${cf}`
  const lotsByBucket = new Map<string, StockLotMini[]>()
  for (const lot of selectedLots) {
    const k = bucketKey(lot.IDref_fil, lot.IDcolori_fil)
    const arr = lotsByBucket.get(k) ?? []
    arr.push(lot)
    lotsByBucket.set(k, arr)
  }
  for (const arr of lotsByBucket.values()) {
    arr.sort((a, b) => (a.date_entree || '').localeCompare(b.date_entree || ''))
  }

  // For each composition pair, the producible écru = bucket total / pourcentage.
  let limitingBucketKey = ''
  let limitingProducible = Infinity
  for (const pair of pairs) {
    const k = bucketKey(pair.IDref_fil, pair.IDcolori_fil)
    const bucket = lotsByBucket.get(k) ?? []
    if (bucket.length === 0) {
      errors.push(`Lot manquant pour la composition (ref_fil=${pair.IDref_fil}, coloris=${pair.IDcolori_fil}, ${pair.pourcentage}%).`)
      continue
    }
    const bucketStock = bucket.reduce((s, l) => s + l.stock, 0)
    const producible = bucketStock / (pair.pourcentage / 100)
    if (producible < limitingProducible) {
      limitingProducible = producible
      limitingBucketKey = k
    }
  }

  if (!isFinite(limitingProducible) || limitingProducible <= 0) {
    if (errors.length === 0) errors.push("Stock insuffisant dans les lots sélectionnés.")
    return { ok: false, errors, targetQtyKg: 0, plan: [] }
  }

  if (errors.length > 0) {
    return { ok: false, errors, targetQtyKg: 0, plan: [] }
  }

  const targetQtyKg = limitingProducible
  // Pick the limiting lot label = first (oldest) lot in the limiting bucket.
  const limitingBucket = lotsByBucket.get(limitingBucketKey) ?? []
  const limitingLotPick = limitingBucket[0]
  const limitingLot = limitingLotPick
    ? { IDstock_fil: limitingLotPick.IDstock_fil, lot: limitingLotPick.lot }
    : undefined

  // Re-run the standard plan with the computed targetQtyKg.
  const std = computeAffectationPlan({ targetQtyKg, selectedLots, pairs })
  return { ...std, limitingLot }
}

interface CompositionPairLite {
  IDref_fil: number
  IDcolori_fil: number
  pourcentage: number
  /** Display labels — joined client-side as "<ref> · <coloris>" for the
   *  coverage hint banner ("Sélectionnez un lot de <pair>"). */
  ref_fil_reference: string | null
  colori_reference: string | null
}

async function fetchPiecesFilPayload(ctx: TricoteurLineContext, ligneId: number): Promise<{
  ecruProduced: StockEcruLite[]
  stockFil: StockFilLite[]
  /** Current line qty (kg) — surfaced so the Stock fil tab buttons can show
   *  "Affecter (1234 kg)" without a separate detail fetch. */
  targetQtyKg: number
  /** Current asso_fil_lignecmdsst rows for this line. Frontend uses this
   *  to compute per-row `affecte_kg` chips and to decide whether to show
   *  Affecter/Finir vs Désaffecter. */
  affectations: AffectationRow[]
  /** Required composition pairs (IDref_fil + IDcolori_fil + pourcentage)
   *  for this line's IDref_ecru + IDcolori_ecru. The frontend uses these
   *  to enforce coverage on the Stock fil tab: Affecter / Finir le lot
   *  only enable when the user has selected at least one lot per pair. */
  compositionPairs: CompositionPairLite[]
}> {
  // Écru rolls produced by the knitter for this tricoteur line. Tricoteur
  // production uses `IDref_commande_source` (the line that *caused* the
  // production), NOT `IDref_commande_affectation` (which is the
  // ennoblisseur-side affectation pointer set when an écru is later
  // assigned to a dyer). Verified against legacy commande 8544 (24 rolls,
  // all with IDref_commande_source = 8520, IDref_commande_affectation = 0).
  // The TRM-side back-pointer `IDLigne_Commande_TRM` is also set on the
  // same rows; we don't query through it because the source pointer is
  // already keyed on the ETM sst line.
  const ecruRows = await query<StockEcruLite>(
    `SELECT IDstock_ecru, numero, lot, poids, metrage, IDref_ecru, IDcolori_ecru,
            IDmagasin, IDordre_fabrication, date_saisie,
            second_choix, observations
     FROM stock_ecru
     WHERE IDref_commande_source = ${ligneId}
     ORDER BY date_saisie DESC, IDstock_ecru DESC`,
  )
  const ecruFixed = await fixEncoding(ecruRows, 'stock_ecru', 'IDstock_ecru', ['numero', 'lot', 'observations'])

  // Defects (polymorphic): Type_Reference=2, reference (varchar) = IDstock_ecru.
  const ecruIds = Array.from(new Set(ecruFixed.map((r) => Number(r.IDstock_ecru) || 0).filter((x) => x > 0)))
  const defectsByEcruId = new Map<number, DefautQualite[]>()
  if (ecruIds.length > 0) {
    const inList = ecruIds.map((id) => `'${id}'`).join(',')
    const defectRows = await query<{
      IDdefaut_qualite: number
      reference: string | null
      description: string | null
      type_defaut: string | null
      taille_cm: number | null
    }>(
      `SELECT IDdefaut_qualite, reference, description, type_defaut, taille_cm
       FROM defaut_qualite
       WHERE Type_Reference = 2 AND reference IN (${inList})`,
    )
    const defectsFixed = await fixEncoding(defectRows, 'defaut_qualite', 'IDdefaut_qualite', ['description', 'type_defaut'])
    for (const d of defectsFixed as any[]) {
      const refId = parseInt(String(d.reference ?? ''), 10)
      if (!(refId > 0)) continue
      const arr = defectsByEcruId.get(refId) ?? []
      arr.push({
        IDdefaut_qualite: Number(d.IDdefaut_qualite),
        description: d.description ?? null,
        type_defaut: d.type_defaut ?? null,
        taille_cm: Number(d.taille_cm) || 0,
      })
      defectsByEcruId.set(refId, arr)
    }
  }

  const ecruProduced: StockEcruLite[] = (ecruFixed as StockEcruLite[]).map((r) => ({
    ...r,
    defects: defectsByEcruId.get(Number(r.IDstock_ecru) || 0) ?? [],
  }))

  // Stock fil — yarn rolls actually usable to produce this écru in its
  // line-specific coloris. Legacy WinDev app filter (verified against
  // commande 8582 line 8558):
  //
  //   1. composition_ecru WHERE IDref_ecru = line AND IDcolori_ecru =
  //      line.IDColoris  →  set of (IDref_fil, IDcolori_fil) pairs.
  //   2. stock_fil matching ANY of those pairs AND stock > 0 (depleted
  //      lots are hidden — "active stock" view).
  //
  // Coloris pair filter matters: ref_ecru 146 (ref "029") has yarn variants
  // for "ecru" (IDcolori_ecru=1094 → IDref_fil=5/IDcolori_fil=317) AND
  // dyed variants (different IDcolori_fil values). Without the pair
  // filter, dyeing a "marron" écru would surface "ecru" yarn rolls and
  // vice-versa.
  //
  // Plain SELECT (no JOIN+CONVERT — bridge collapses results, see
  // CLAUDE.md). Accented columns (terminé / controlé) omitted: read-only
  // view, Linux bridge rejects them.
  let stockFil: StockFilLite[] = []
  // Composition pairs (with percentages) — used for the stock_fil filter
  // AND surfaced in the response payload so the frontend can enforce
  // coverage on the Stock fil tab. Hoisted out of the `if` block so the
  // labeling step at the end of the function can see it.
  let pairs: CompositionPair[] = []
  if (ctx.IDref_ecru > 0) {
    pairs = await loadCompositionPairs(ctx.IDref_ecru, ctx.IDcolori_ecru)
    if (pairs.length === 0) {
      const lineQtyRow = await query<{ quantite: number | null }>(
        `SELECT quantite FROM ligne_commande_sous_traitant WHERE IDligne_commande_sous_traitant = ${ligneId}`,
      )
      return {
        ecruProduced,
        stockFil: [],
        targetQtyKg: Number(lineQtyRow[0]?.quantite) || 0,
        affectations: await loadAffectationsForLine(ligneId),
        compositionPairs: [],
      }
    }

    // Build a SQL OR clause for the pair list. Each (IDref_fil,
    // IDcolori_fil) is a separate "ref AND colori" predicate joined by
    // OR; we also AND stock > 0 to hide depleted lots (legacy default).
    const pairClause = pairs
      .map((p) => `(sf.IDref_fil = ${p.IDref_fil} AND sf.IDcolori_fil = ${p.IDcolori_fil})`)
      .join(' OR ')

    const stockRows = await query<StockFilLite>(
      `SELECT sf.IDstock_fil, sf.IDref_fil, sf.IDcolori_fil, sf.IDfournisseur, sf.IDMagasin,
              sf.IDref_fil_commande, sf.stock, sf.lot, sf.lot_frs, sf.emplacement, sf.date_entree
       FROM stock_fil sf
       WHERE (${pairClause}) AND sf.stock > 0
       ORDER BY sf.date_entree DESC, sf.IDstock_fil DESC`,
    )
    const stockFixed = await fixEncoding(stockRows, 'stock_fil', 'IDstock_fil', ['lot', 'lot_frs', 'emplacement'])

    // Flat batched lookups for the display name columns.
    const refFilIds = Array.from(new Set(stockFixed.map((r) => Number((r as any).IDref_fil) || 0).filter((x) => x > 0)))
    const coloriIds = Array.from(new Set(stockFixed.map((r) => Number((r as any).IDcolori_fil) || 0).filter((x) => x > 0)))
    const fournisseurIds = Array.from(new Set(stockFixed.map((r) => Number((r as any).IDfournisseur) || 0).filter((x) => x > 0)))
    const magasinIds = Array.from(new Set(stockFixed.map((r) => Number((r as any).IDMagasin) || 0).filter((x) => x > 0)))

    const refFilNameById = new Map<number, string>()
    if (refFilIds.length > 0) {
      const r = await query<{ IDref_fil: number; reference: string | null }>(
        `SELECT IDref_fil, reference FROM ref_fil WHERE IDref_fil IN (${refFilIds.join(',')})`,
      )
      for (const row of r) refFilNameById.set(Number(row.IDref_fil), (row.reference ?? '').toString().trim())
    }

    const coloriNameById = new Map<number, string>()
    if (coloriIds.length > 0) {
      const r = await query<{ IDcolori_fil: number; reference: string | null }>(
        `SELECT IDcolori_fil, reference FROM colori_fil WHERE IDcolori_fil IN (${coloriIds.join(',')})`,
      )
      const fixedC = await fixEncoding(r, 'colori_fil', 'IDcolori_fil', ['reference'])
      for (const row of fixedC as any[]) coloriNameById.set(Number(row.IDcolori_fil), (row.reference ?? '').toString().trim())
    }

    const fournisseurNameById = new Map<number, string>()
    if (fournisseurIds.length > 0) {
      const r = await query<{ IDfournisseur: number; nom: string | null }>(
        `SELECT IDfournisseur, nom FROM fournisseur WHERE IDfournisseur IN (${fournisseurIds.join(',')})`,
      )
      const fixedF = await fixEncoding(r, 'fournisseur', 'IDfournisseur', ['nom'])
      for (const row of fixedF as any[]) fournisseurNameById.set(Number(row.IDfournisseur), (row.nom ?? '').toString().trim())
    }

    const magasinNameById = new Map<number, string>()
    if (magasinIds.length > 0) {
      // stock_fil.IDMagasin → sous_traitant.IDsous_traitant (legacy convention).
      const r = await query<{ IDsous_traitant: number; nom: string | null }>(
        `SELECT IDsous_traitant, nom FROM sous_traitant WHERE IDsous_traitant IN (${magasinIds.join(',')})`,
      )
      const fixedM = await fixEncoding(r, 'sous_traitant', 'IDsous_traitant', ['nom'])
      for (const row of fixedM as any[]) magasinNameById.set(Number(row.IDsous_traitant), (row.nom ?? '').toString().trim())
    }

    stockFil = (stockFixed as StockFilLite[]).map((r) => ({
      ...r,
      ref_fil_reference: refFilNameById.get(Number(r.IDref_fil) || 0) ?? null,
      colori_reference: coloriNameById.get(Number(r.IDcolori_fil) || 0) ?? null,
      fournisseur_nom: fournisseurNameById.get(Number(r.IDfournisseur) || 0) ?? null,
      magasin_nom: magasinNameById.get(Number(r.IDMagasin) || 0) ?? null,
    }))
  }

  // Affectations + target qty — surfaced so the Stock fil tab buttons can
  // render labels and the lot rows can show their "affecté X kg" chip in
  // a single round-trip.
  const affectations = await loadAffectationsForLine(ligneId)
  const lineRow = await query<{ quantite: number | null }>(
    `SELECT quantite FROM ligne_commande_sous_traitant WHERE IDligne_commande_sous_traitant = ${ligneId}`,
  )
  const targetQtyKg = Number(lineRow[0]?.quantite) || 0

  // Annotate each stockFil row with affecte_kg = sum of asso quantite for
  // this (line, lot) pair. Tiny map lookup per row.
  const affecteByLot = new Map<number, number>()
  for (const a of affectations) {
    affecteByLot.set(a.IDstock_fil, (affecteByLot.get(a.IDstock_fil) ?? 0) + a.quantite)
  }
  const stockFilWithAffecte = stockFil.map((r) => ({
    ...r,
    affecte_kg: affecteByLot.get(r.IDstock_fil) ?? 0,
  }))

  // Resolve composition-pair labels. Independent lookup (the pair's yarn
  // might have no stock_fil rows, so we can't reuse the stock_fil-side
  // name maps). Pairs are 1–3 entries → cheap.
  let compositionPairs: CompositionPairLite[] = []
  if (pairs.length > 0) {
    const pairRefFilIds = Array.from(new Set(pairs.map((p) => p.IDref_fil).filter((x) => x > 0)))
    const pairColoriIds = Array.from(new Set(pairs.map((p) => p.IDcolori_fil).filter((x) => x > 0)))
    const refFilLabels = new Map<number, string>()
    if (pairRefFilIds.length > 0) {
      const r = await query<{ IDref_fil: number; reference: string | null }>(
        `SELECT IDref_fil, reference FROM ref_fil WHERE IDref_fil IN (${pairRefFilIds.join(',')})`,
      )
      for (const row of r) refFilLabels.set(Number(row.IDref_fil), (row.reference ?? '').toString().trim())
    }
    const coloriLabels = new Map<number, string>()
    if (pairColoriIds.length > 0) {
      const r = await query<{ IDcolori_fil: number; reference: string | null }>(
        `SELECT IDcolori_fil, reference FROM colori_fil WHERE IDcolori_fil IN (${pairColoriIds.join(',')})`,
      )
      const fixed = await fixEncoding(r, 'colori_fil', 'IDcolori_fil', ['reference'])
      for (const row of fixed as any[]) coloriLabels.set(Number(row.IDcolori_fil), (row.reference ?? '').toString().trim())
    }
    compositionPairs = pairs.map((p) => ({
      IDref_fil: p.IDref_fil,
      IDcolori_fil: p.IDcolori_fil,
      pourcentage: p.pourcentage,
      ref_fil_reference: refFilLabels.get(p.IDref_fil) ?? null,
      colori_reference: coloriLabels.get(p.IDcolori_fil) ?? null,
    }))
  }

  return {
    ecruProduced,
    stockFil: stockFilWithAffecte,
    targetQtyKg,
    affectations,
    compositionPairs,
  }
}

commandesSousTraitantRouter.get(
  '/:commandeId/lignes/:ligneId/pieces-fil',
  async (req: Request, res: Response) => {
    try {
      const commandeId = parseInt(req.params.commandeId, 10)
      const ligneId = parseInt(req.params.ligneId, 10)
      if (isNaN(commandeId) || isNaN(ligneId)) { res.status(400).json({ error: 'Invalid ID' }); return }
      const ctx = await loadTricoteurLineContext(commandeId, ligneId)
      if (!ctx) { res.status(404).json({ error: 'Line not found, not a tricoteur line, or does not belong to commande' }); return }
      res.json(await fetchPiecesFilPayload(ctx, ligneId))
    } catch (err) {
      console.error('Error fetching tricoteur line pieces:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

// ── Yarn affectation endpoints ───────────────────────────
//
// All-tricoteur (any IDtype_sst=1) — NOT TRM-only. The cross-company
// mirror logic is the only TRM-specific bit; yarn-to-line affectation is
// a generic tricoteur feature.

const affecterBody = z.object({
  stockFilIds: z.array(z.number().int().positive()).min(1),
  mode: z.enum(['standard', 'finir']),
})

commandesSousTraitantRouter.post(
  '/:commandeId/lignes/:ligneId/affecter',
  async (req: Request, res: Response) => {
    try {
      const commandeId = parseInt(req.params.commandeId, 10)
      const ligneId = parseInt(req.params.ligneId, 10)
      if (isNaN(commandeId) || isNaN(ligneId)) { res.status(400).json({ error: 'Invalid ID' }); return }

      const ctx = await loadTricoteurLineContext(commandeId, ligneId)
      if (!ctx) { res.status(404).json({ error: 'Line not found or not a tricoteur line' }); return }
      if (refuseIfTerminee(res, await loadCommandeSoldee(commandeId))) return

      const parsed = affecterBody.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
        return
      }
      const { stockFilIds, mode } = parsed.data

      // Refuse if affectations already exist — caller must DELETE
      // /affectations first to avoid silent overlap with old data.
      const existing = await loadAffectationsForLine(ligneId)
      if (existing.length > 0) {
        res.status(409).json({
          error: 'affectations_exist',
          message: 'Des affectations existent déjà pour cette ligne. Cliquez sur Désaffecter avant de relancer le calcul.',
        })
        return
      }

      // Load composition + selected lots + current line qty.
      const pairs = await loadCompositionPairs(ctx.IDref_ecru, ctx.IDcolori_ecru)
      const selectedLots = await loadStockLotsByIds(stockFilIds)
      const lineQtyRow = await query<{ quantite: number | null }>(
        `SELECT quantite FROM ligne_commande_sous_traitant WHERE IDligne_commande_sous_traitant = ${ligneId}`,
      )
      const currentQty = Number(lineQtyRow[0]?.quantite) || 0

      const planResult = mode === 'finir'
        ? computeFinirLotPlan({ selectedLots, pairs })
        : computeAffectationPlan({ targetQtyKg: currentQty, selectedLots, pairs })

      if (!planResult.ok) {
        res.status(400).json({ error: 'plan_invalid', messages: planResult.errors })
        return
      }

      // For 'finir' mode, also update the line's quantite to the
      // computed target. We go through the existing PUT path conceptually
      // (a direct UPDATE here, then bridge sync to TRM cc if applicable).
      if (mode === 'finir' && Math.abs(planResult.targetQtyKg - currentQty) > 0.001) {
        // Re-run PrixDeRevientTRM with the new quantity — one-off costs
        // amortize over more or fewer kg → different €/kg. Keep both
        // ledgers (sst + TRM mirror) aligned.
        const newPrix = await trmLinePrix(ctx.IDref_ecru, planResult.targetQtyKg)
        await query(
          `UPDATE ligne_commande_sous_traitant
           SET quantite = ${n(planResult.targetQtyKg)}, prix = ${n(newPrix)}
           WHERE IDligne_commande_sous_traitant = ${ligneId}`,
        )
        // TRM mirror line sync — only if this is a Tricotage Malterre sst.
        if (await isTricotageMalterreSst(commandeId)) {
          const ccLineId = await getTrmMirrorLine(ligneId)
          if (ccLineId != null) {
            await query(
              `UPDATE ligne_commande_client
               SET quantite = ${n(planResult.targetQtyKg)}, prix = ${n(newPrix)}
               WHERE IDligne_commande_client = ${ccLineId}`,
            )
          }
        }
      }

      // INSERT one asso row per plan entry.
      for (const entry of planResult.plan) {
        await query(
          `INSERT INTO asso_fil_lignecmdsst (IDstock_fil, IDligne_commande_sous_traitant, quantite)
           VALUES (${entry.IDstock_fil}, ${ligneId}, ${n(entry.quantite)})`,
        )
      }

      res.json({
        ok: true,
        mode,
        targetQtyKg: planResult.targetQtyKg,
        limitingLot: planResult.limitingLot,
        payload: await fetchPiecesFilPayload(ctx, ligneId),
      })
    } catch (err) {
      console.error('Error affecting yarn lots:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

commandesSousTraitantRouter.delete(
  '/:commandeId/lignes/:ligneId/affectations',
  async (req: Request, res: Response) => {
    try {
      const commandeId = parseInt(req.params.commandeId, 10)
      const ligneId = parseInt(req.params.ligneId, 10)
      if (isNaN(commandeId) || isNaN(ligneId)) { res.status(400).json({ error: 'Invalid ID' }); return }

      const ctx = await loadTricoteurLineContext(commandeId, ligneId)
      if (!ctx) { res.status(404).json({ error: 'Line not found or not a tricoteur line' }); return }
      if (refuseIfTerminee(res, await loadCommandeSoldee(commandeId))) return

      // Refuse if production has started — `stock_ecru` rolls already
      // reference this line. Désaffecter would leave orphan production.
      const rolls = await query<{ n: number | null }>(
        `SELECT COUNT(*) AS n FROM stock_ecru WHERE IDref_commande_source = ${ligneId}`,
      )
      if ((Number(rolls[0]?.n) || 0) > 0) {
        res.status(409).json({
          error: 'production_started',
          message: 'Impossible de désaffecter : des rouleaux ont déjà été produits pour cette ligne.',
        })
        return
      }

      await query(
        `DELETE FROM asso_fil_lignecmdsst WHERE IDligne_commande_sous_traitant = ${ligneId}`,
      )

      res.json({ ok: true, payload: await fetchPiecesFilPayload(ctx, ligneId) })
    } catch (err) {
      console.error('Error clearing affectations:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

// ── Reception: create a stock_ecru roll ──────────────────

const rollBody = z.object({
  numero: z.string().min(1).max(40),
  lot: z.string().max(40).optional(),
  poids: z.number().positive(),
  observations: z.string().optional(),
  second_choix: z.number().int().min(0).max(1).optional(),
})

commandesSousTraitantRouter.post(
  '/:commandeId/lignes/:ligneId/pieces-fil/rolls',
  async (req: Request, res: Response) => {
    try {
      const commandeId = parseInt(req.params.commandeId, 10)
      const ligneId = parseInt(req.params.ligneId, 10)
      if (isNaN(commandeId) || isNaN(ligneId)) { res.status(400).json({ error: 'Invalid ID' }); return }

      const ctx = await loadTricoteurLineContext(commandeId, ligneId)
      if (!ctx) { res.status(404).json({ error: 'Line not found or not a tricoteur line' }); return }
      if (refuseIfTerminee(res, await loadCommandeSoldee(commandeId))) return

      const parsed = rollBody.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
        return
      }
      const d = parsed.data

      // For Tricotage Malterre commandes only, also stamp IDLigne_Commande_TRM
      // with the mirror cc line so the TRM side sees this roll in its ledger.
      let IDLigne_Commande_TRM = 0
      if (await isTricotageMalterreSst(commandeId)) {
        IDLigne_Commande_TRM = (await getTrmMirrorLine(ligneId)) ?? 0
      }

      const today = new Date()
      const todayStr = `${today.getFullYear()}${String(today.getMonth() + 1).padStart(2, '0')}${String(today.getDate()).padStart(2, '0')}`

      // Insert. IDsociete=1 because ownership transfers to ETM as the
      // yarn-to-écru transformation completes (legacy convention,
      // confirmed on sst 8544's 24 rolls). IDordre_fabrication=0 because
      // MPS_NG doesn't model OFs yet — the legacy TRM workflow fills it
      // when production starts; leaving 0 is harmless here.
      await query(
        `INSERT INTO stock_ecru
         (numero, lot, poids, metrage, IDref_ecru, IDcolori_ecru,
          IDmagasin, IDordre_fabrication, IDref_commande_source,
          IDLigne_Commande_TRM, IDsociete, second_choix, observations, date_saisie)
         VALUES (${sqlText(d.numero)}, ${sqlText(d.lot)}, ${n(d.poids)}, 0,
                 ${ctx.IDref_ecru}, ${ctx.IDcolori_ecru},
                 0, 0, ${ligneId},
                 ${IDLigne_Commande_TRM}, 1, ${d.second_choix ?? 0},
                 ${sqlText(d.observations)}, '${todayStr}')`,
      )

      res.status(201).json({ ok: true, payload: await fetchPiecesFilPayload(ctx, ligneId) })
    } catch (err) {
      console.error('Error creating tricoteur roll:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

// Breakdown of the current prix calculation for a line. Returns the
// algorithm's full trace (base + treatments + multipliers) with
// human-readable names resolved server-side, so the LineCard tooltip can
// render an explanatory popover. Called on-demand when the user hovers
// the Info icon next to "Prix unit.".
commandesSousTraitantRouter.get(
  '/:commandeId/lignes/:ligneId/prix-breakdown',
  async (req: Request, res: Response) => {
    try {
      const commandeId = parseInt(req.params.commandeId, 10)
      const ligneId = parseInt(req.params.ligneId, 10)
      if (isNaN(commandeId) || isNaN(ligneId)) { res.status(400).json({ error: 'Invalid ID' }); return }

      // Resolve line + commande context.
      const lineRows = await query<any>(
        `SELECT IDcommande_sous_traitant, IDreference, IDColoris, type AS type_kind
         FROM ligne_commande_sous_traitant
         WHERE IDligne_commande_sous_traitant = ${ligneId}`,
      )
      if (lineRows.length === 0) { res.status(404).json({ error: 'Line not found' }); return }
      const line = lineRows[0]
      if (Number(line.IDcommande_sous_traitant) !== commandeId) { res.status(404).json({ error: 'Line does not belong to commande' }); return }
      if (Number(line.type_kind) !== 2) { res.json({ enabled: false, reason: 'not-ennoblisseur' }); return }

      const cmdRows = await query<{ IDsous_traitant: number }>(
        `SELECT IDsous_traitant FROM commande_sous_traitant WHERE IDcommande_sous_traitant = ${commandeId}`,
      )
      const IDsous_traitant = Number(cmdRows[0]?.IDsous_traitant) || 0
      if (!(await hasTariffData(IDsous_traitant))) {
        res.json({ enabled: false, reason: 'no-tariff-data' })
        return
      }

      const poidsRows = await query<{ total: number | null }>(
        `SELECT SUM(poids) AS total FROM stock_ecru WHERE IDref_commande_affectation = ${ligneId}`,
      )
      const xPoids = Number(poidsRows[0]?.total) || 0

      const bd: PrixBreakdown | null = await calcTarifSSTBreakdown({
        xPoids,
        IDsous_traitant,
        IDref_fini: Number(line.IDreference) || 0,
        IDref_fini_colori: Number(line.IDColoris) || 0,
      })
      if (!bd) { res.json({ enabled: false, reason: 'no-weight' }); return }

      // Resolve human-readable names for the IDs in the breakdown.
      // Must select IDsous_traitant: fixEncoding uses it as idField; omitting it
      // makes the CONVERT run `WHERE IDsous_traitant = NaN` → bridge respawn storm.
      const stRows = await query<{ IDsous_traitant: number; nom: string | null }>(
        `SELECT IDsous_traitant, nom FROM sous_traitant WHERE IDsous_traitant = ${IDsous_traitant}`,
      )
      const sstFixed = await fixEncoding(stRows, 'sous_traitant', 'IDsous_traitant', ['nom'])
      const sst_nom = ((sstFixed[0] as any)?.nom ?? '').trim()

      let teinture_nom: string | null = null
      if (bd.IDteinture > 0) {
        const teintRows = await query<{ designation_interne: string | null; designation_externe: string | null }>(
          `SELECT designation_interne, designation_externe FROM teinture WHERE IDteinture = ${bd.IDteinture}`,
        )
        const fixedT = await fixEncoding(teintRows, 'teinture', 'IDteinture', ['designation_interne', 'designation_externe'])
        const t = fixedT[0] as any
        teinture_nom = (t?.designation_externe || t?.designation_interne || '').trim() || null
      }

      // Collect all treatment ids we need names for (combination-covered
      // + remaining-priced + unpriced).
      const trtIds = new Set<number>()
      if (bd.base?.kind === 'combination') for (const t of bd.base.covered) trtIds.add(t)
      for (const t of bd.treatments) trtIds.add(t.IDtraitement)
      for (const t of bd.unpriced_treatments) trtIds.add(t)
      const trtNames = new Map<number, string>()
      if (trtIds.size > 0) {
        const trtRows = await query<{ IDtraitement: number; designation: string | null }>(
          `SELECT IDtraitement, designation FROM traitement WHERE IDtraitement IN (${Array.from(trtIds).join(',')})`,
        )
        const fixedTrt = await fixEncoding(trtRows, 'traitement', 'IDtraitement', ['designation'])
        for (const r of fixedTrt as any[]) trtNames.set(Number(r.IDtraitement), (r.designation ?? '').trim())
      }

      res.json({
        enabled: true,
        sst_nom,
        teinture_nom,
        traitement_names: Object.fromEntries(trtNames),
        breakdown: bd,
      })
    } catch (err) {
      console.error('Error computing prix breakdown:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

commandesSousTraitantRouter.put(
  '/:commandeId/lignes/:ligneId/pieces/ecru/:stockEcruId',
  async (req: Request, res: Response) => {
    try {
      const commandeId = parseInt(req.params.commandeId, 10)
      const ligneId = parseInt(req.params.ligneId, 10)
      const stockEcruId = parseInt(req.params.stockEcruId, 10)
      if (isNaN(commandeId) || isNaN(ligneId) || isNaN(stockEcruId)) {
        res.status(400).json({ error: 'Invalid ID' }); return
      }
      const ctx = await loadEnnoblisseurLineContext(commandeId, ligneId)
      if (!ctx) { res.status(404).json({ error: 'Line not found or does not belong to commande' }); return }
      if (refuseIfTerminee(res, await loadCommandeSoldee(commandeId))) return

      // Verify the écru row's IDref_ecru matches the ref_fini.IDref_ecru
      // resolved for this line, and that the roll is unassigned.
      const ecruRows = await query<{
        IDstock_ecru: number
        IDref_ecru: number
        IDref_commande_affectation: number | null
      }>(
        `SELECT IDstock_ecru, IDref_ecru, IDref_commande_affectation
         FROM stock_ecru
         WHERE IDstock_ecru = ${stockEcruId}`,
      )
      if (ecruRows.length === 0) { res.status(404).json({ error: 'Stock ecru not found' }); return }
      const s = ecruRows[0] as any
      if (Number(s.IDref_ecru) !== ctx.IDref_ecru) {
        res.status(400).json({ error: 'Stock ecru ref does not match the line\'s fini ref mapping' })
        return
      }
      const current = Number(s.IDref_commande_affectation) || 0
      if (current !== 0 && current !== ligneId) {
        res.status(409).json({ error: 'Stock ecru is already linked to another line' })
        return
      }

      await query(
        `UPDATE stock_ecru SET IDref_commande_affectation = ${ligneId} WHERE IDstock_ecru = ${stockEcruId}`,
      )
      // Auto-recompute the line's prix from the new total écru weight.
      // Must run AFTER the link UPDATE so the SUM sees the new roll, and
      // BEFORE fetchPiecesPayload so the payload's `prix` reflects the
      // freshly-computed value. See pricing-sst.ts for the algorithm.
      await recalcLignePrix(ligneId)
      res.json(await fetchPiecesPayload(ctx, ligneId))
    } catch (err) {
      console.error('Error linking ecru to line:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

commandesSousTraitantRouter.delete(
  '/:commandeId/lignes/:ligneId/pieces/ecru/:stockEcruId',
  async (req: Request, res: Response) => {
    try {
      const commandeId = parseInt(req.params.commandeId, 10)
      const ligneId = parseInt(req.params.ligneId, 10)
      const stockEcruId = parseInt(req.params.stockEcruId, 10)
      if (isNaN(commandeId) || isNaN(ligneId) || isNaN(stockEcruId)) {
        res.status(400).json({ error: 'Invalid ID' }); return
      }
      const ctx = await loadEnnoblisseurLineContext(commandeId, ligneId)
      if (!ctx) { res.status(404).json({ error: 'Line not found or does not belong to commande' }); return }
      if (refuseIfTerminee(res, await loadCommandeSoldee(commandeId))) return

      await query(
        `UPDATE stock_ecru SET IDref_commande_affectation = 0
         WHERE IDstock_ecru = ${stockEcruId} AND IDref_commande_affectation = ${ligneId}`,
      )
      // Recompute prix now that the écru weight total has dropped.
      await recalcLignePrix(ligneId)
      res.json(await fetchPiecesPayload(ctx, ligneId))
    } catch (err) {
      console.error('Error unlinking ecru from line:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

const finiBody = z.object({
  numero: z.string().min(1).max(20),
  lot: z.string().optional(),
  poids: z.number().optional(),
  metrage: z.number().optional(),
  IDstock_ecru: z.number().int().nonnegative().optional(),
  IDref_fini: z.number().int().positive(),
  IDColoris: z.number().int().nonnegative().optional(),
  IDmagasin: z.number().int().nonnegative().optional(),
  observations: z.string().optional(),
  observation_sst: z.string().optional(),
})

commandesSousTraitantRouter.post(
  '/:commandeId/lignes/:ligneId/pieces/fini',
  async (req: Request, res: Response) => {
    try {
      const commandeId = parseInt(req.params.commandeId, 10)
      const ligneId = parseInt(req.params.ligneId, 10)
      if (isNaN(commandeId) || isNaN(ligneId)) { res.status(400).json({ error: 'Invalid ID' }); return }

      const ctx = await loadEnnoblisseurLineContext(commandeId, ligneId)
      if (!ctx) { res.status(404).json({ error: 'Line not found or does not belong to commande' }); return }
      if (refuseIfTerminee(res, await loadCommandeSoldee(commandeId))) return

      const parsed = finiBody.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
        return
      }
      const d = parsed.data

      // stock_fini.IDColoris is the produced fini's coloris (a ref_fini_colori).
      // The authoritative source is the LINE's IDColoris (the ennoblisseur was
      // ordered to dye into that coloris) — NOT the source écru's IDcolori_ecru,
      // which lives in a different id space (colori_ecru). The old code inherited
      // IDcolori_ecru here, producing rows whose IDColoris resolved to a bogus
      // cross-referenced ref_fini_colori (wrong coloris in Stock Finis + the
      // Soumission Lot picker). A body-supplied IDColoris (>0) still wins as an
      // explicit override; otherwise default to the line's coloris.
      const inheritedIDColoris = (d.IDColoris && d.IDColoris > 0) ? d.IDColoris : ctx.IDColoris
      // Inherit the source écru's client reservation. When the écru was
      // affected with `IDligne_commande_client > 0` (e.g. reserved for
      // "BONNE NOUVELLE"), the dyed roll keeps the same reservation so
      // the client tag flows downstream into the Réception tab.
      let inheritedLcc = 0
      if (d.IDstock_ecru && d.IDstock_ecru > 0) {
        const verify = await query<{
          IDref_commande_affectation: number | null
          IDligne_commande_client: number | null
        }>(
          `SELECT IDref_commande_affectation, IDligne_commande_client
           FROM stock_ecru WHERE IDstock_ecru = ${d.IDstock_ecru}`,
        )
        if (verify.length === 0) {
          res.status(400).json({ error: 'Source ecru not found' }); return
        }
        const aff = Number((verify[0] as any).IDref_commande_affectation) || 0
        if (aff !== ligneId) {
          res.status(400).json({ error: 'Source ecru is not affected to this line' }); return
        }
        inheritedLcc = Number((verify[0] as any).IDligne_commande_client) || 0
      }

      const today = new Date()
      const yyyy = String(today.getFullYear())
      const mm = String(today.getMonth() + 1).padStart(2, '0')
      const dd = String(today.getDate()).padStart(2, '0')
      const dateSaisie = `${yyyy}${mm}${dd}`

      // Resolve the parent commande's sous-traitant. New receptions are
      // stored in the magasin keyed on that sst id (matches legacy: 86%
      // of legacy stock_fini rows have IDmagasin = IDsous_traitant; the
      // mismatched ones are mostly the IDmagasin=0 rows previously
      // inserted by MPS_NG before this fix). Body-supplied IDmagasin
      // (non-zero) still wins so a user can override later.
      const cmdInfo = await query<{ IDsous_traitant: number | null }>(
        `SELECT IDsous_traitant FROM commande_sous_traitant WHERE IDcommande_sous_traitant = ${commandeId}`,
      )
      const sstId = Number(cmdInfo[0]?.IDsous_traitant) || 0
      const idMagasin = (d.IDmagasin && d.IDmagasin > 0) ? d.IDmagasin : sstId

      // IDetat_stock_fini = 1 → "En Contrôle" (per etat_stock_fini
      // label table). New receptions need inspection before being
      // validated/shipped, so they enter at state 1.
      await query(
        `INSERT INTO stock_fini
         (numero, lot, poids, metrage, IDref_fini, IDColoris, IDstock_ecru,
          IDmagasin, IDref_commande_source, observations, observation_sst, date_saisie,
          second_choix, destockage, don, IDProprietaire, IDcommande_donation, IDligne_commande_client, IDligne_expedition,
          IDetat_stock_fini)
         VALUES (${sqlText(d.numero)}, ${sqlText(d.lot)}, ${n(d.poids)}, ${n(d.metrage)},
                 ${d.IDref_fini}, ${inheritedIDColoris}, ${d.IDstock_ecru ?? 0},
                 ${idMagasin}, ${ligneId}, ${sqlText(d.observations)}, ${sqlText(d.observation_sst)}, '${dateSaisie}',
                 0, 0, 0, 0, 0, ${inheritedLcc}, 0, 1)`,
      )

      // Track the lot in suivilot if it isn't already. Idempotent per
      // (ligne, lot) — only the first reception of a given lot creates
      // the row. Totals stay at 0 (a downstream workflow populates
      // quantite_receptionnee / metrage_receptionne), matching legacy.
      await upsertSuivilot({ commandeId, ligneId, lot: d.lot ?? '' })

      res.status(201).json(await fetchPiecesPayload(ctx, ligneId))
    } catch (err) {
      console.error('Error creating stock_fini reception:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

commandesSousTraitantRouter.delete(
  '/:commandeId/lignes/:ligneId/pieces/fini/:stockFiniId',
  async (req: Request, res: Response) => {
    try {
      const commandeId = parseInt(req.params.commandeId, 10)
      const ligneId = parseInt(req.params.ligneId, 10)
      const stockFiniId = parseInt(req.params.stockFiniId, 10)
      if (isNaN(commandeId) || isNaN(ligneId) || isNaN(stockFiniId)) {
        res.status(400).json({ error: 'Invalid ID' }); return
      }
      const ctx = await loadEnnoblisseurLineContext(commandeId, ligneId)
      if (!ctx) { res.status(404).json({ error: 'Line not found or does not belong to commande' }); return }
      if (refuseIfTerminee(res, await loadCommandeSoldee(commandeId))) return

      // Refuse if the row already has downstream usage we'd be erasing silently.
      const verify = await query<{
        IDref_commande_source: number | null
        IDligne_expedition: number | null
        IDligne_commande_client: number | null
        destockage: number | null
      }>(
        `SELECT IDref_commande_source, IDligne_expedition, IDligne_commande_client, destockage
         FROM stock_fini
         WHERE IDstock_fini = ${stockFiniId}`,
      )
      if (verify.length === 0) { res.status(404).json({ error: 'Stock fini not found' }); return }
      const v = verify[0] as any
      if (Number(v.IDref_commande_source) !== ligneId) {
        res.status(400).json({ error: 'Stock fini is not linked to this line' }); return
      }
      if ((Number(v.IDligne_expedition) || 0) > 0
        || (Number(v.IDligne_commande_client) || 0) > 0
        || Number(v.destockage) === 1) {
        res.status(409).json({
          error: 'fini_already_used',
          message:
            "Ce rouleau a déjà été utilisé en aval (expédition / commande client / destockage). Annulez d'abord ces opérations dans le stock finis.",
        })
        return
      }

      await query(`DELETE FROM stock_fini WHERE IDstock_fini = ${stockFiniId}`)
      res.json(await fetchPiecesPayload(ctx, ligneId))
    } catch (err) {
      console.error('Error deleting stock_fini reception:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

// ── Edit a stock_fini reception's notes ──────────────────
//
// PATCH only edits the two free-text columns:
//   - `observations`     : the visiteur's note shared with the customer
//                          (blue banner in the UI)
//   - `observation_sst`  : the ennoblisseur's defect report
//                          (red banner in the UI)
//
// Reprise flow (multi-select in the Réception tab → "Reprendre X" → batch
// dialog): the same PATCH endpoint is also used to update lot / poids /
// metrage / numero on a roll currently in `IDetat_stock_fini = 2` ("En
// reprise"). The frontend defaults the etat back to `1` (En contrôle)
// after the reprise edit so the visiteur can re-validate the values.
// Other stock_fini fields (magasin, …) remain non-editable from this
// surface — they'd require revisiting the link/destockage invariants.

const finiNotesPatchBody = z.object({
  observations: z.string().optional(),
  observation_sst: z.string().optional(),
  // Reprise-only fields. All optional — only set when the caller wants to
  // overwrite the corresponding stock_fini column.
  numero: z.string().max(40).optional(),
  lot: z.string().max(40).optional(),
  poids: z.number().nonnegative().optional(),
  metrage: z.number().nonnegative().optional(),
  IDetat_stock_fini: z.number().int().min(1).max(5).optional(),
})

commandesSousTraitantRouter.patch(
  '/:commandeId/lignes/:ligneId/pieces/fini/:stockFiniId',
  async (req: Request, res: Response) => {
    try {
      const commandeId = parseInt(req.params.commandeId, 10)
      const ligneId = parseInt(req.params.ligneId, 10)
      const stockFiniId = parseInt(req.params.stockFiniId, 10)
      if (isNaN(commandeId) || isNaN(ligneId) || isNaN(stockFiniId)) {
        res.status(400).json({ error: 'Invalid ID' }); return
      }
      const ctx = await loadEnnoblisseurLineContext(commandeId, ligneId)
      if (!ctx) { res.status(404).json({ error: 'Line not found or does not belong to commande' }); return }
      if (refuseIfTerminee(res, await loadCommandeSoldee(commandeId))) return

      const parsed = finiNotesPatchBody.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
        return
      }
      const d = parsed.data

      // Verify the row belongs to this line — symmetric with the DELETE
      // handler. We don't need the downstream-usage guard here because
      // editing notes never breaks an expedition / commande client / etc.
      const verify = await query<{ IDref_commande_source: number | null; lot: string | null }>(
        `SELECT IDref_commande_source, lot FROM stock_fini WHERE IDstock_fini = ${stockFiniId}`,
      )
      if (verify.length === 0) { res.status(404).json({ error: 'Stock fini not found' }); return }
      if (Number(verify[0].IDref_commande_source) !== ligneId) {
        res.status(400).json({ error: 'Stock fini is not linked to this line' }); return
      }

      const setParts: string[] = []
      if (d.observations !== undefined) setParts.push(`observations = ${sqlText(d.observations)}`)
      if (d.observation_sst !== undefined) setParts.push(`observation_sst = ${sqlText(d.observation_sst)}`)
      if (d.numero !== undefined) setParts.push(`numero = ${sqlText(d.numero)}`)
      if (d.lot !== undefined) setParts.push(`lot = ${sqlText(d.lot)}`)
      if (d.poids !== undefined) setParts.push(`poids = ${d.poids}`)
      if (d.metrage !== undefined) setParts.push(`metrage = ${d.metrage}`)
      if (d.IDetat_stock_fini !== undefined) setParts.push(`IDetat_stock_fini = ${d.IDetat_stock_fini}`)
      if (setParts.length > 0) {
        await query(`UPDATE stock_fini SET ${setParts.join(', ')} WHERE IDstock_fini = ${stockFiniId}`)
      }

      // Lot migration: suivilot rows are keyed on (ligne, lot), so when the
      // reprise dialog corrects a roll's lot number the old lot's suivilot
      // would otherwise stay orphaned (stuck "En reprise", zero pieces) and
      // the corrected lot would never appear in Qualité at all.
      //
      // The reprise dialog PATCHes the batch one roll at a time, so this runs
      // once per roll: while rolls remain under the old lot we only make sure
      // the new lot is tracked; when the last roll leaves the old lot we
      // migrate the old suivilot onto the new lot — preferring the row that
      // carries contrôles data (rename the old row and drop a data-less
      // placeholder created earlier in the same batch, never the reverse).
      // Best-effort: a failure here must not fail the roll update itself.
      const oldLot = ((verify[0].lot ?? '') as string).toString().trim()
      const newLot = d.lot !== undefined ? d.lot.trim() : oldLot
      if (d.lot !== undefined && newLot && newLot !== oldLot) {
        try {
          await migrateSuivilotLot({ commandeId, ligneId, oldLot, newLot })
        } catch (err) {
          console.error(
            `Suivilot lot migration failed for ligne=${ligneId} '${oldLot}' -> '${newLot}':`,
            err,
          )
        }
      }

      // Reprise sync: when a roll's état is reset (En reprise 2 → En contrôle 1),
      // mirror it onto the lot-level status (suivilot.IDetatLot). The legacy
      // Qualité screen reads suivilot.IDetatLot — without this the lot stays
      // stuck "en reprise" after the user reprend the rolls (the reported bug).
      // The reprise dialog sends lot + IDetat_stock_fini together; fall back to
      // the roll's existing lot when only the état changed.
      if (d.IDetat_stock_fini === 1 || d.IDetat_stock_fini === 2) {
        const suiviLot = ((d.lot !== undefined ? d.lot : verify[0].lot) ?? '').toString().trim()
        if (suiviLot) {
          await query(
            `UPDATE suivilot SET IDetatLot = ${d.IDetat_stock_fini}
             WHERE IDligne_commande_sous_traitant = ${ligneId} AND lot = ${sqlText(suiviLot)}`,
          )
        }
      }

      res.json(await fetchPiecesPayload(ctx, ligneId))
    } catch (err) {
      console.error('Error updating stock_fini notes:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

// ── Tricobot — autofill from BL PDFs ─────────────────────
//
// Tricobot is an AI agent that monitors the company inbox, parses BLs
// received from sous-traitants, and writes per-piece rows into
// `data_bl_tricotbot`. This endpoint returns those rows for a given
// ligne so the frontend batch-reception dialog can pre-populate Lot /
// Poids / Métrage / Défaut by matching `num_piece` to each roll's
// numero (écru numero on create, fini numero on reprise). Ordered by
// PK ascending: after a reprise the same num_piece exists twice (old +
// corrected BL) and the frontend keeps the last row per num_piece, so
// ascending order makes the newest BL win.
commandesSousTraitantRouter.get(
  '/:commandeId/lignes/:ligneId/tricobot',
  async (req: Request, res: Response) => {
    try {
      const commandeId = parseInt(req.params.commandeId, 10)
      const ligneId = parseInt(req.params.ligneId, 10)
      if (isNaN(commandeId) || isNaN(ligneId)) { res.status(400).json({ error: 'Invalid ID' }); return }
      const ctx = await loadEnnoblisseurLineContext(commandeId, ligneId)
      if (!ctx) { res.status(404).json({ error: 'Line not found or does not belong to commande' }); return }

      const rows = await query<{
        IDdata_bl_tricotbot: number
        IDligne_commande_sous_traitant: number
        lot: string | null
        poids: number | null
        metrage: number | null
        observation: string | null
        num_piece: string | null
        DATE: string | null
      }>(
        `SELECT IDdata_bl_tricotbot, IDligne_commande_sous_traitant, lot, poids, metrage,
                observation, num_piece, DATE
         FROM data_bl_tricotbot
         WHERE IDligne_commande_sous_traitant = ${ligneId}
         ORDER BY IDdata_bl_tricotbot`,
      )
      const fixed = await fixEncoding(rows, 'data_bl_tricotbot', 'IDdata_bl_tricotbot', ['observation', 'num_piece', 'lot'])
      res.json(fixed)
    } catch (err) {
      console.error('Error fetching tricobot data:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

// ── Documents (polymorphic GED) ──────────────────────────
//
// Discriminator: rows where IDcommande_sous_traitant = id AND IDtype_doc
// is in the sst-relevant whitelist below. The whitelist was empirically
// derived from production data — see inspect-pieces-flow.ts output:
//   1=facture fil, 2=autre, 3=bl retour ennoblisseur (most common),
//   4=bl retour tricoteur, 5=cert GOTS, 6=bl fournisseur, 15=soumission
//
// CRITICAL: we do NOT filter `IDcommande_client = 0`. A single ged row
// can legitimately point at BOTH a sous-traitant commande and the parent
// client commande in the chain (e.g. ged#9292 for sst-cmd 7925 also has
// IDcommande_client = 6351). Adding the zero filter silently hides
// those shared docs — see the CLAUDE.md polymorphic-ged rule.

const COMMANDE_SST_DOC_TYPES = '1, 2, 3, 4, 5, 6, 15'

commandesSousTraitantRouter.get('/:id/documents', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const rows = await query<{
      IDged: number
      nom: string | null
      commentaire: string | null
      IDtype_doc: number
    }>(
      `SELECT g.IDged, g.nom, g.commentaire, g.IDtype_doc
       FROM ged g
       WHERE g.IDcommande_sous_traitant = ${id}
         AND g.IDtype_doc IN (${COMMANDE_SST_DOC_TYPES})
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

    const out = fixed.map((r) => ({
      IDged: r.IDged,
      nom: r.nom,
      commentaire: r.commentaire,
      IDtype_doc: r.IDtype_doc,
      type_nom: typeMap.get(r.IDtype_doc) ?? null,
    }))
    res.json(out)
  } catch (err) {
    console.error('Error listing commande-sst documents:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesSousTraitantRouter.get('/:id/documents/:idged/fichier', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const idged = parseInt(req.params.idged, 10)
    if (isNaN(id) || isNaN(idged)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const rows = await queryRaw(
      `SELECT fichier FROM ged
       WHERE IDged = ${idged}
         AND IDcommande_sous_traitant = ${id}
         AND IDtype_doc IN (${COMMANDE_SST_DOC_TYPES})`,
    )
    if (rows.length === 0) { res.status(404).json({ error: 'Document not found' }); return }
    const fichier = (rows[0] as any).fichier
    if (fichier == null) { res.status(404).json({ error: 'No file attached' }); return }
    let buf: Buffer
    if (fichier instanceof ArrayBuffer) buf = Buffer.from(fichier)
    else if (Buffer.isBuffer(fichier)) buf = fichier
    else { res.status(404).json({ error: 'No file attached' }); return }
    if (buf.length === 0 || (buf.length === 1 && buf[0] === 0)) {
      res.status(404).json({ error: 'No file attached' }); return
    }

    let contentType = 'application/octet-stream'
    if (buf.length >= 4) {
      const h = buf.subarray(0, 4)
      if (h[0] === 0x25 && h[1] === 0x50 && h[2] === 0x44 && h[3] === 0x46) contentType = 'application/pdf'
      else if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4E && h[3] === 0x47) contentType = 'image/png'
      else if (h[0] === 0xFF && h[1] === 0xD8) contentType = 'image/jpeg'
    }
    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Disposition', 'inline')
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.end(buf)
  } catch (err) {
    console.error('Error serving commande-sst document:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

commandesSousTraitantRouter.post(
  '/:id/documents',
  upload.single('fichier'),
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10)
      if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
      const cf = await query(
        `SELECT IDcommande_sous_traitant FROM commande_sous_traitant WHERE IDcommande_sous_traitant = ${id}`,
      )
      if (cf.length === 0) { res.status(404).json({ error: 'Commande not found' }); return }

      const nom = (req.body.nom ?? '').toString()
      const commentaire = (req.body.commentaire ?? '').toString()
      const idTypeDoc = parseInt(req.body.IDtype_doc, 10) || 0

      // Note: IDreference is set to the commande id too (mirroring the
      // legacy convention seen in commande_fil docs) so any future query
      // that joined on IDreference still finds the rows.
      await query(
        `INSERT INTO ged (nom, commentaire, IDtype_doc, IDreference, IDcommande_client, IDcommande_sous_traitant, IDdossier)
         VALUES ('${esc(nom)}', '${esc(commentaire)}', ${idTypeDoc}, ${id}, 0, ${id}, 0)`,
      )

      const newRows = await query<{ IDged: number }>(
        `SELECT IDged FROM ged
         WHERE IDcommande_sous_traitant = ${id}
           AND IDcommande_client = 0
           AND IDtype_doc = ${idTypeDoc}
         ORDER BY IDged DESC`,
      )
      if (newRows.length === 0) { res.status(500).json({ error: 'Insert lookup failed' }); return }
      const newId = newRows[0].IDged

      if (req.file && req.file.buffer.length > 0) {
        const hexStr = req.file.buffer.toString('hex')
        await queryRaw(`UPDATE ged SET fichier = x'${hexStr}' WHERE IDged = ${newId}`)
      }

      res.status(201).json({ IDged: newId })
    } catch (err) {
      console.error('Error creating commande-sst document:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

commandesSousTraitantRouter.put(
  '/:id/documents/:idged',
  upload.single('fichier'),
  async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id, 10)
      const idged = parseInt(req.params.idged, 10)
      if (isNaN(id) || isNaN(idged)) { res.status(400).json({ error: 'Invalid ID' }); return }

      const scope = await query(
        `SELECT IDged FROM ged
         WHERE IDged = ${idged}
           AND IDcommande_sous_traitant = ${id}
           AND IDtype_doc IN (${COMMANDE_SST_DOC_TYPES})`,
      )
      if (scope.length === 0) { res.status(404).json({ error: 'Document not found' }); return }

      const sets: string[] = []
      if (req.body.nom !== undefined) sets.push(`nom = '${esc(String(req.body.nom))}'`)
      if (req.body.commentaire !== undefined) sets.push(`commentaire = '${esc(String(req.body.commentaire))}'`)
      if (req.body.IDtype_doc !== undefined) sets.push(`IDtype_doc = ${parseInt(req.body.IDtype_doc, 10) || 0}`)
      if (sets.length > 0) {
        await query(`UPDATE ged SET ${sets.join(', ')} WHERE IDged = ${idged}`)
      }
      if (req.file && req.file.buffer.length > 0) {
        const hexStr = req.file.buffer.toString('hex')
        await queryRaw(`UPDATE ged SET fichier = x'${hexStr}' WHERE IDged = ${idged}`)
      } else if (req.body.remove_fichier === '1') {
        await query(`UPDATE ged SET fichier = NULL WHERE IDged = ${idged}`)
      }
      res.json({ ok: true })
    } catch (err) {
      console.error('Error updating commande-sst document:', err)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

commandesSousTraitantRouter.delete('/:id/documents/:idged', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const idged = parseInt(req.params.idged, 10)
    if (isNaN(id) || isNaN(idged)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const scope = await query(
      `SELECT IDged FROM ged
       WHERE IDged = ${idged}
         AND IDcommande_sous_traitant = ${id}
         AND IDtype_doc IN (${COMMANDE_SST_DOC_TYPES})`,
    )
    if (scope.length === 0) { res.status(404).json({ error: 'Document not found' }); return }
    await query(`DELETE FROM ged WHERE IDged = ${idged}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting commande-sst document:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Reuse the type-doc lookup that fournisseurs already exposes (if the FE
// relies on it). The list endpoint above already includes per-doc type_nom
// resolution, so the FE often won't need this — but having the router
// expose it locally avoids a cross-route dependency for the FE.
commandesSousTraitantRouter.get('/lookups/type-doc', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDtype_doc: number; nom: string | null }>(
      `SELECT IDtype_doc, nom FROM type_doc WHERE IDtype_doc IN (${COMMANDE_SST_DOC_TYPES}) ORDER BY nom`,
    )
    const fixed = await fixEncoding(rows, 'type_doc', 'IDtype_doc', ['nom'])
    res.json(fixed)
  } catch (err) {
    console.error('Error listing sst type-doc:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// Suppress unused-import noise for the type loader helper used only in
// validation paths. (kept here intentionally for future ennoblisseur-only
// gating logic on POST line, etc.)
void loadSousTraitantType
