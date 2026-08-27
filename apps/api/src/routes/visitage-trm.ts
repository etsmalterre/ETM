// Production › Visitage — port of the legacy FI_Visitage.wdw (Tricotage
// Malterre mode). Mounted at /api/visitage-trm, consumed by TRM's
// apps/web/src/pages/ProductionVisitage.tsx.
//
// What the screen does: the visiteuse picks a MÉTIER, the screen surfaces the
// OF at the head of that métier's queue and the oldest knitted piece not yet
// visited. She weighs it, optionally CUTS it into several rolls, DÉCLASSE the
// ones that deserve it, arbitrates the defects the bonnetier declared at the
// workshop terminal (keep / move between rolls / mark recovered / delete),
// adds her own, and validates. That write creates the stock_ecru rolls, traces
// the event, and DECREMENTS THE YARN STOCK.
//
// This is the single entry point of TRM production into stock. Tombé Métier ›
// Stock, Expéditions, Facturation, Prime and the "Poids des pièces" widget all
// read what this route writes.
//
// ── Provenance ──────────────────────────────────────────
// FI_Visitage.wdw is PCS-compressed and has no Android generation (unlike
// FI_Prime). The spec was recovered from three sources:
//   1. The WinDev compile cache
//      MPS\MPS.cpl\<user>\00000000\FI_Visitage.DC61D6CF.wdw.wcw — string
//      literals, control names and FULL SQL queries survive there (integer
//      literals and function names do not). Every query quoted below is
//      verbatim from it.
//   2. Eight screenshots of the running legacy screen (2026-08-26).
//   3. A probe of the live HFSQL base — which is what settles everything the
//      cache cannot say. Each rule below carries its evidence.
//
// ── Data model (verified 2026-08-26) ────────────────────
//  - Numbering: TWO sequences per OF. 1er choix = MAX(num_piece_OF < 1000) + 1.
//    2nd choix = a dedicated 1000+ sequence, first déclassé at 1001 (438 OFs
//    start there vs 167 at 1000, an older code path we do not reproduce).
//    `second_choix = 1` ⇔ `num_piece_OF >= 1000` on 97 % of rows.
//  - The cut is real: 1 109 pieces yielded 2 rolls, 123 → 3, 8 → 4. Rolls of
//    one piece share IDpiece_production and differ by num_piece_OF.
//  - defaut_qualite is polymorphic. Type_Reference 1 → reference =
//    IDpiece_production (declared at the terminal while knitting);
//    Type_Reference 2 → reference = IDstock_ecru (stringified). Validation
//    CONVERTS the piece's rows in place, preserving DATE / Type_Spotteur /
//    IDSpotteur / description — that is what still tells a terminal defect
//    from a visitage one years later.
//  - Type_Spotteur 1 = bonnetier at the terminal (description holds a bucket
//    label like "Maille 1m - 3m"); Type_Spotteur 2 = the visiteur here, and
//    since 2023 description stays NULL — 1 553 consecutive rows, no exception.
//    (2021–22 rows carry a free-text note from an older code path: "BARRURE
//    SUR TTE LA PIECE (FIL EN DIRECT)". Read them, never write like them.)
//    So Type_Spotteur — NOT the presence of a description — is what classifies
//    a defect's origin; `origine` in the payload is derived from it alone.
//  - `récuperé` = the visiteur recovered a bonnetier-declared defect by hand.
//    1 344 of its 1 345 live rows sit on Type_Spotteur = 1, which matches.
//  - Defects move between the rolls of a cut piece: 240 terminal-declared
//    defects sit on a roll other than the first of their piece.
//  - IDLigne_Commande_TRM on a new roll = ordre_fabrication
//    .IDligne_commande_client (12/12 on recent rolls). IDligne_commande_client
//    stays 0 — it is ETM's column.
//  - IDmagasin = 0 and IDsociete = 2 (6 662 / 6 663 société-2 rows).
//
// ── HFSQL discipline ────────────────────────────────────
// All of lib/production-trm.ts's rules apply. Specific to this file:
//  - `defaut_qualite` carries the accented `traité` / `récuperé` AND the
//    reserved `date` → read via SELECT * (selectDefauts), write positionally.
//  - `evenement_piece` carries the reserved `date` → positional INSERT with a
//    self-assigned MAX+1 PK (the message_of / desiderata shape).
//  - `stock_ecru` carries the accented `IDPropriétaire` → named INSERT that
//    never mentions it (HFSQL zero-fills).
//  - Never `SELECT *` on stock_fil / colori_ecru / client: memo-binary columns
//    make the Windows driver return zero rows silently.
import { Router, type Request, type Response, type Router as RouterType } from 'express'
import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { z } from 'zod'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { trmUserHasPermission } from '../lib/permissions-trm.js'
import { newIdAfterInsert, maxId } from './expeditions.js'
import {
  TRM_SOCIETE, round2, parseDtMs, sqlText, nowDt, todayHfsql,
  selectMachines, selectBonnetiers, selectDefauts, bonnetierDisplayName, bonnetierDirectory,
  resolveEcruRefs, resolveColorisEcru, selectStockFilByIds, loadOf, realiseByOf,
  TYPES_DEFAUT, normaliseTypeDefaut, uniteForType,
  awaitingPieces,
  type DefautRow, type WaitingPieceRow,
} from '../lib/production-trm.js'
import { EtiquetteEcruPdf, type EtiquetteEcruData } from '../lib/pdf/EtiquetteEcruPdf.js'

export const visitageTrmRouter: RouterType = Router()

/** Rolls without a "Visitage" event allowed between two visited ones before
 *  the next piece is due a full inspection. The legacy label of
 *  ordre_fabrication.visitage = 1 reads "2 premières pièces et toutes les
 *  3 pièces", and OF 3415 shows V V P P V P P V P P V… — so two skipped rolls.
 *  ⚠️ APPROXIMATION: the real predicate is in unrecoverable WLanguage and the
 *  history drifts (OF 3378 shows gaps of 2 and 3). probe-visitage-trm.ts
 *  measures the parity of this rule against the whole history. */
const ROLLS_BETWEEN_VISITAGES = 2

/** The two labels the legacy writes to evenement_piece. A piece due a full
 *  inspection gets the first; one merely weighed gets the second (12 507 vs
 *  37 291 live rows). Accented → always through sqlText. */
const EVT_VISITAGE = 'Visitage tombé métier'
const EVT_PESAGE = 'Pesage tombé métier'

// ── Small readers ────────────────────────────────────────

/** The scan itself lives in lib/production-trm.ts (awaitingPieces) — the
 *  « Pièces à visiter » dashboard widget asks the same question over a
 *  24-hour window. This file owns only what to OFFER out of it. */
type PieceRow = WaitingPieceRow

/** A piece stops being offered once it is this old.
 *
 *  Live data 2026-08-26 shows 56 finished pieces with no roll over five months
 *  (~11/month, 45 of them on OFs since terminé). That reads like a leak, and it
 *  partly is — but per the user (2026-08-26) the workshop also SKIPS pieces on
 *  purpose, and a piece nobody weighed within a week is normally one of those.
 *  So the screen offers the last week and stays quiet about the rest, instead
 *  of nagging about deliberate skips.
 *
 *  ⚠️ Nothing is deleted — these rows stay in piece_production untouched. This
 *  is a display cutoff, and the backlog is still there the day someone wants to
 *  clear it (probe-visitage-trm.ts §5 counts it).
 *
 *  Overridable so the stale dev copy stays usable: it is a snapshot months
 *  behind, and a literal 7-day window would show an empty workshop there. Set
 *  VISITAGE_PIECE_MAX_AGE_DAYS in apps/api/.env.development only — prod keeps
 *  the 7 days.
 *
 *  ⚠️ Read lazily, NOT into a module-level const. ESM evaluates an imported
 *  module before the importing module's body, so `index.ts`'s dotenv.config()
 *  has not run yet when this file is first evaluated — a top-level
 *  process.env read here is always undefined. */
function pieceMaxAgeDays(): number {
  return Number(process.env.VISITAGE_PIECE_MAX_AGE_DAYS ?? '7') || 7
}

function ageJours(ms: number | null): number | null {
  if (ms === null) return null
  return Math.floor((Date.now() - ms) / 86_400_000)
}

/** How long a STRANDED piece stays on offer — one whose OF is no longer the
 *  head of its métier's queue (OF terminé, or an OF overtaken in the file).
 *  Those are the strays the legacy screen cannot reach at all; we hand them
 *  back, but only for a week (user, 2026-08-26: « on a 7 jours pour les
 *  traiter ou elles disparaissent de cet écran »).
 *
 *  Deliberately a hard constant, NOT pieceMaxAgeDays(): the dev widening must
 *  not extend it. A stale dev copy widened to 400 days filled the piece picker
 *  with nine-month-old strays, which is what made the rule necessary.
 *
 *  Nothing is deleted — the rows stay in piece_production, and
 *  probe-visitage-trm.ts still counts the backlog. */
const ORPHAN_MAX_AGE_DAYS = 7

/** What a métier actually offers: every piece of the queue-head OF, plus the
 *  strays of the last ORPHAN_MAX_AGE_DAYS. headId = 0 (métier with no OF in
 *  production) makes every waiting piece a stray, which is the intent. */
function offeredPieces(waiting: PieceRow[], headId: number): PieceRow[] {
  return waiting.filter(
    (p) => p.IDordre_fabrication === headId || (ageJours(p.date_fin_ms) ?? 0) <= ORPHAN_MAX_AGE_DAYS,
  )
}

/** Finished pieces carrying no roll yet, grouped by métier and windowed to
 *  the last pieceMaxAgeDays().
 *
 *  The scan (and the driver discipline behind it — the JS anti-join, the
 *  workshop-wide sweep that the legacy's per-OF query cannot do) lives in
 *  lib/production-trm.ts's awaitingPieces, shared with the « Pièces à visiter »
 *  dashboard widget. What is local here is the OFFER window: a piece older than
 *  the window is a deliberate skip, not a task, so the poste stays quiet about
 *  it. Nothing is deleted — the rows stay in piece_production and
 *  probe-visitage-trm.ts §5 still counts the backlog. */
async function awaitingByMachine(): Promise<Map<number, PieceRow[]>> {
  const out = new Map<number, PieceRow[]>()
  for (const p of await awaitingPieces()) {
    if ((ageJours(p.date_fin_ms) ?? 0) > pieceMaxAgeDays()) continue
    const arr = out.get(p.IDmachine) ?? []
    arr.push(p)
    out.set(p.IDmachine, arr)
  }
  return out
}

/** The OF at the head of a métier's queue — the legacy's machine → OF hop,
 *  verbatim from the compile cache. `est_actif` names the running OF; the
 *  `priorite <= prio_actif.priorite AND priorite <> 0` pair then takes the
 *  lowest-ranked open OF at or before it. Returns 0 when the métier has none
 *  ("Pas d'OF affecté à cette machine"). */
async function headOfForMachine(machineId: number): Promise<number> {
  const rows = await query<{ IDordre_fabrication: number }>(
    `SELECT ordre_fabrication.IDordre_fabrication
     FROM ordre_fabrication
     LEFT JOIN (
       SELECT ordre_fabrication.IDmachine, ordre_fabrication.priorite
       FROM ordre_fabrication WHERE ordre_fabrication.est_actif = 1
     ) prio_actif ON prio_actif.IDmachine = ordre_fabrication.IDmachine
     WHERE ordre_fabrication.IDmachine = ${machineId}
       AND ordre_fabrication.est_termine = 0
       AND ordre_fabrication.priorite <= prio_actif.priorite
       AND ordre_fabrication.priorite <> 0
     ORDER BY ordre_fabrication.priorite ASC
     LIMIT 1`,
  )
  return Number(rows[0]?.IDordre_fabrication) || 0
}

/** Open (non-terminé) OFs of a métier — the population `autres_pieces` scans
 *  for pieces the legacy screen can no longer reach. */
async function openOfsForMachine(machineId: number): Promise<number[]> {
  const rows = await query<{ IDordre_fabrication: number }>(
    `SELECT IDordre_fabrication FROM ordre_fabrication
     WHERE IDmachine = ${machineId} AND est_termine = 0`,
  )
  return rows.map((r) => Number(r.IDordre_fabrication) || 0).filter(Boolean)
}

/** "OF 3364 · 180 noir" for a set of OF ids — used to name the OF an orphan
 *  piece belongs to. */
async function labelOfs(ofIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const ids = Array.from(new Set(ofIds.filter((x) => x > 0)))
  if (ids.length === 0) return out
  const rows = await query<any>(
    `SELECT IDordre_fabrication, IDref_ecru, IDcolori_ecru FROM ordre_fabrication
     WHERE IDordre_fabrication IN (${ids.join(',')})`,
  )
  const [refs, coloris] = await Promise.all([
    resolveEcruRefs(rows.map((r: any) => Number(r.IDref_ecru) || 0)),
    resolveColorisEcru(rows.map((r: any) => Number(r.IDcolori_ecru) || 0)),
  ])
  for (const r of rows) {
    const id = Number(r.IDordre_fabrication) || 0
    const ref = refs.get(Number(r.IDref_ecru) || 0)
    const col = coloris.get(Number(r.IDcolori_ecru) || 0) ?? ''
    out.set(id, [`OF ${id}`, [ref?.reference, col].filter(Boolean).join(' ')].filter(Boolean).join(' · '))
  }
  return out
}

interface RollRow {
  id: number
  numero: string
  num_piece_OF: number
  poids: number
  second_choix: number
  visiteur: string
  date_saisie_ms: number | null
  IDpiece_production: number
}

async function rollsOfOf(ofId: number): Promise<RollRow[]> {
  const rows = await query<any>(
    `SELECT IDstock_ecru, numero, num_piece_OF, poids, second_choix, visiteur,
            date_saisie, IDpiece_production
     FROM stock_ecru WHERE IDordre_fabrication = ${ofId}
     ORDER BY IDstock_ecru ASC`,
  )
  const fixed = await fixEncoding(rows, 'stock_ecru', 'IDstock_ecru', ['numero', 'visiteur'])
  return (fixed as any[]).map((r) => ({
    id: Number(r.IDstock_ecru),
    numero: (r.numero ?? '').toString().trim(),
    num_piece_OF: Number(r.num_piece_OF) || 0,
    poids: round2(Number(r.poids) || 0),
    second_choix: Number(r.second_choix) || 0,
    visiteur: (r.visiteur ?? '').toString().trim(),
    date_saisie_ms: parseDtMs(r.date_saisie),
    IDpiece_production: Number(r.IDpiece_production) || 0,
  }))
}

/** Which of these rolls carry a full-visitage event (vs a mere weighing).
 *  `date` is reserved on evenement_piece — never named, and we only need the
 *  label here. */
async function visitageEventRolls(rollIds: number[]): Promise<Set<number>> {
  const out = new Set<number>()
  const ids = Array.from(new Set(rollIds.filter((x) => x > 0)))
  if (ids.length === 0) return out
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200).join(',')
    const rows = await query<any>(
      `SELECT IDstock_ecru, evenement FROM evenement_piece WHERE IDstock_ecru IN (${chunk})`,
    )
    const fixed = await fixEncoding(rows, 'evenement_piece', 'IDevenement_piece', ['evenement'])
    for (const r of fixed as any[]) {
      // "Visitage tombé métier" and the 17 legacy "Visitage Tombé de métier"
      // rows both count; "Pesage tombé métier" does not.
      if (/^visitage/i.test((r.evenement ?? '').toString().trim())) out.add(Number(r.IDstock_ecru) || 0)
    }
  }
  return out
}

// ── The two derived rules ────────────────────────────────

/** Next numbers for both sequences. Verbatim from the compile cache, plus the
 *  `+ 1` the WLanguage applies after each query:
 *
 *    SELECT MAX(num_piece_OF) AS num FROM stock_ecru
 *    WHERE IDordre_fabrication = {p} AND stock_ecru.num_piece_OF < 1000
 *
 *    SELECT CASE WHEN max_num IS NULL THEN 1000 ELSE max_num END AS num FROM (
 *      SELECT MAX(num_piece_OF) AS max_num FROM stock_ecru
 *      WHERE IDordre_fabrication = {p} AND num_piece_OF >= 1000 AND num_piece_OF < 2000)
 */
async function nextNumeros(ofId: number): Promise<{ premier_choix: number; second_choix: number }> {
  const a = await query<{ num: number | null }>(
    `SELECT MAX(num_piece_OF) AS num FROM stock_ecru
     WHERE IDordre_fabrication = ${ofId} AND num_piece_OF < 1000`,
  )
  const b = await query<{ num: number | null }>(
    `SELECT MAX(num_piece_OF) AS num FROM stock_ecru
     WHERE IDordre_fabrication = ${ofId} AND num_piece_OF >= 1000 AND num_piece_OF < 2000`,
  )
  const maxFirst = Number(a[0]?.num) || 0
  const maxSecond = Number(b[0]?.num) || 0
  return {
    premier_choix: maxFirst + 1,
    second_choix: (maxSecond >= 1000 ? maxSecond : 1000) + 1,
  }
}

export interface VisitageDue { a_visiter: boolean; raison: 'ouvert_visiteuse' | 'debut_of' | 'cadence' | null }

/** Is the next piece due a FULL visitage, or only a weighing? Drives the red
 *  "Pièce à visiter" banner and which of the two events gets written.
 *
 *  `ouvert_visiteuse = 1` → every piece, verified at 100 % (OF 3417's 77 rolls
 *  and OF 3424's 7 are all "Visitage"). It is also the pink "Ouvrir au large"
 *  chip of the legacy banner.
 *
 *  Otherwise the ~1-in-3 cadence, which is an APPROXIMATION (see
 *  ROLLS_BETWEEN_VISITAGES). The screen lets the visiteuse override it, so an
 *  imperfect rule never writes a false history on its own. */
async function visitageDue(ofId: number, ouvertVisiteuse: number, rolls: RollRow[]): Promise<VisitageDue> {
  if (ouvertVisiteuse === 1) return { a_visiter: true, raison: 'ouvert_visiteuse' }
  if (rolls.length < 2) return { a_visiter: true, raison: 'debut_of' }
  const visited = await visitageEventRolls(rolls.map((r) => r.id))
  let since = 0
  for (let i = rolls.length - 1; i >= 0; i--) {
    if (visited.has(rolls[i].id)) break
    since++
  }
  return since >= ROLLS_BETWEEN_VISITAGES ? { a_visiter: true, raison: 'cadence' } : { a_visiter: false, raison: null }
}

// ── Defect shaping ───────────────────────────────────────

interface DefautPayload {
  id: number
  type_defaut: string
  description: string | null
  taille_cm: number
  nombre: number
  unite: 'cm' | 'nb'
  recupere: number
  origine: 'bonnetier' | 'visitage'
  spotteur_nom: string
  date_ms: number | null
}

function shapeDefauts(rows: DefautRow[], names: Map<number, { prenom: string; nom: string }>): DefautPayload[] {
  return rows
    .map((d) => {
      const type = normaliseTypeDefaut(d.type_defaut)
      const origine: 'bonnetier' | 'visitage' = d.type_spotteur === 2 ? 'visitage' : 'bonnetier'
      return {
        id: d.id,
        type_defaut: type,
        // Rendered verbatim when present — NEVER recomputed from taille_cm.
        // The historical mapping is not deterministic (1000 appears both as
        // "1m - 3m" and "Plus de 3m"), and taille_cm on a terminal row is a
        // bucket code, not a length.
        description: d.description ? d.description.replace(/\s+/g, ' ').trim() : null,
        taille_cm: d.taille_cm,
        nombre: d.nombre,
        unite: uniteForType(d.type_defaut),
        recupere: d.recupere,
        origine,
        spotteur_nom: bonnetierDisplayName(names.get(d.id_spotteur)),
        date_ms: d.date_ms,
      }
    })
    .sort((a, b) => (a.date_ms ?? 0) - (b.date_ms ?? 0) || a.id - b.id)
}

// ════════════════════════════════════════════════════════
//  LOOKUPS  (literal paths — register before any /:param)
// ════════════════════════════════════════════════════════

// GET /api/visitage-trm/lookups/metiers — the picker, as a worklist.
//
// The legacy COMBO_Machine lists métiers carrying an active, unfinished OF —
// live data returns exactly the ten of the 2026-08-26 screenshot (1F 2A 2D 2H
// 3B 3C 3E 3G 3H 3K), which is how that rule was confirmed. This one lists
// métiers that have a piece WAITING instead, active OF or not: half the legacy
// list is a dead end (an OF but nothing to weigh), and the pieces stranded on a
// terminé OF never appear there at all.
visitageTrmRouter.get('/lookups/metiers', async (req: Request, res: Response) => {
  try {
    const actives = await query<{ IDmachine: number }>(
      `SELECT IDmachine FROM ordre_fabrication WHERE est_actif = 1 AND est_termine = 0`,
    )
    const activeIds = new Set(actives.map((a) => Number(a.IDmachine) || 0))
    const awaiting = await awaitingByMachine()

    // Resolve every queue head once — the filter below and the per-métier
    // counts both need it, and headOfForMachine is a query each.
    const headByMachine = new Map<number, number>()
    for (const mid of activeIds) headByMachine.set(mid, await headOfForMachine(mid))

    // What each métier really offers — the head OF's pieces plus the strays of
    // the last week. Resolved here, before the filter below, so a métier whose
    // only waiting pieces have aged out drops off the list with them.
    const offered = new Map<number, PieceRow[]>()
    for (const [mid, list] of awaiting) {
      const head = activeIds.has(mid) ? headByMachine.get(mid) ?? 0 : 0
      offered.set(mid, offeredPieces(list, head))
    }

    // Only métiers with something to weigh (user, 2026-08-26). The legacy lists
    // every métier carrying an active OF, so half of its list is a dead end —
    // an OF, but no piece waiting. What the visiteuse needs is her worklist.
    const machines = (await selectMachines())
      .filter((m) => m.archive === 0 && m.emplacement !== '' && (offered.get(m.id)?.length ?? 0) > 0)
      .sort((a, b) => a.emplacement.localeCompare(b.emplacement, 'fr'))

    const out = []
    for (const m of machines) {
      const head = activeIds.has(m.id) ? headByMachine.get(m.id) ?? 0 : 0
      const waiting = offered.get(m.id) ?? []
      out.push({
        id: m.id,
        emplacement: m.emplacement,
        nom: m.nom,
        of_id: head || null,
        actif: activeIds.has(m.id),
        // Split so the screen can still tell apart the pieces of the OF in
        // production from the ones stranded on another OF — the legacy cannot
        // reach the latter at all.
        pieces_en_attente: head > 0 ? waiting.filter((p) => p.IDordre_fabrication === head).length : 0,
        pieces_orphelines: waiting.filter((p) => p.IDordre_fabrication !== head).length,
      })
    }
    res.json(out)
  } catch (err) {
    console.error('visitage-trm lookups/metiers:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/visitage-trm/lookups/visiteurs — who may sign a visitage. The
// legacy combo lists bonnetiers; régleurs included (they do take part in the
// workshop, same finding as the Prime screen). Photo blobs are served by
// /api/of-trm/bonnetiers/:id/photo — reused, never copied.
visitageTrmRouter.get('/lookups/visiteurs', async (_req: Request, res: Response) => {
  try {
    const rows = (await selectBonnetiers())
      .filter((b) => b.archive === 0)
      .map((b) => ({ id: b.id, nom: b.nom, prenom: b.prenom, label: bonnetierDisplayName(b), regleur: b.regleur }))
      .sort((a, b) => a.label.localeCompare(b.label, 'fr'))
    res.json(rows)
  } catch (err) {
    console.error('visitage-trm lookups/visiteurs:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/visitage-trm/lookups/types-defaut — the FEN_Ajout_Défaut picker.
// Static: there is no reference table for this vocabulary (the base's
// `type_defaut` table is ETM's retour-client one and is unrelated). See
// lib/production-trm.ts for how the list and its units were recovered.
visitageTrmRouter.get('/lookups/types-defaut', (_req: Request, res: Response) => {
  res.json(TYPES_DEFAUT)
})

// ════════════════════════════════════════════════════════
//  READS
// ════════════════════════════════════════════════════════

/** Everything the poste needs for one métier, in one round trip.
 *
 *    GET /poste?metier=10            → the OF at the head of 2A's queue and
 *                                      its oldest piece awaiting visitage
 *    GET /poste?metier=10&piece=37303 → that piece instead, with ITS OF as the
 *                                      context — this is how an orphan piece
 *                                      (stranded on a terminé OF) gets worked.
 *
 * Folding the piece switch into this endpoint rather than a second /piece/:id
 * call keeps the screen one query deep: picking another piece can change the
 * OF, and with it the banner, both gauges, the consigne and both numbering
 * sequences. Two calls would render a frame of mismatched context.
 */
visitageTrmRouter.get('/poste', async (req: Request, res: Response) => {
  try {
    const machineId = parseInt(String(req.query.metier ?? ''), 10)
    if (isNaN(machineId) || machineId <= 0) { res.status(400).json({ error: 'Invalid métier' }); return }
    const wantPiece = req.query.piece != null ? parseInt(String(req.query.piece), 10) : 0

    const machine = (await selectMachines()).find((m) => m.id === machineId)
    if (!machine) { res.status(404).json({ error: 'Métier introuvable' }); return }
    const metier = { id: machine.id, emplacement: machine.emplacement, nom: machine.nom }

    const headId = await headOfForMachine(machineId)
    // Strays older than ORPHAN_MAX_AGE_DAYS are off the screen: a stale tab
    // asking for one gets the same 409 as a piece another poste took.
    const waiting = offeredPieces((await awaitingByMachine()).get(machineId) ?? [], headId)

    // Which piece are we working, and therefore which OF is the context?
    let piece: PieceRow | null = null
    if (wantPiece > 0) {
      piece = waiting.find((p) => p.id === wantPiece) ?? null
      // Asking for a piece that is not awaiting on this métier is either a
      // stale tab or a race with another poste — say so rather than silently
      // falling back to a different piece.
      if (!piece) { res.status(409).json({ error: 'piece_indisponible' }); return }
    } else {
      piece = waiting.find((p) => p.IDordre_fabrication === headId) ?? null
    }
    const ofId = piece ? piece.IDordre_fabrication : headId

    if (ofId === 0) {
      // "Pas d'OF affecté à cette machine" — the legacy's own wording.
      res.json({ metier, of: null, piece: null, autres_pieces: [], numeros: null, a_visiter: false, a_visiter_raison: null, approx: false })
      return
    }

    const loaded = await loadOf(ofId)
    if (!loaded) { res.status(404).json({ error: 'OF hors périmètre TRM' }); return }
    const { of, ligne } = loaded

    const refId = Number(of.IDref_ecru) || 0
    const coloriId = Number(of.IDcolori_ecru) || 0
    const [refMap, coloriMap] = await Promise.all([resolveEcruRefs([refId]), resolveColorisEcru([coloriId])])
    const ref = refMap.get(refId)

    // Gauges. The legacy SQL filters `second_choix = 0` on BOTH: a déclassé
    // roll is produced weight, but not weight delivered against the order.
    const rolls = await rollsOfOf(ofId)
    const realiseOf = round2(rolls.filter((r) => r.second_choix === 0).reduce((s, r) => s + r.poids, 0))
    const quantite = round2(Number(of.quantite) || 0)

    let commande: Record<string, unknown> | null = null
    if (ligne) {
      const siblings = await query<{ IDordre_fabrication: number }>(
        `SELECT IDordre_fabrication FROM ordre_fabrication
         WHERE IDligne_commande_client = ${ligne.ligneId}`,
      )
      const sibIds = siblings.map((s) => Number(s.IDordre_fabrication) || 0).filter(Boolean)
      const realiseLigne = round2(
        Array.from((await realiseByOf(sibIds, { premierChoixOnly: true })).values()).reduce((s, v) => s + v, 0),
      )
      commande = {
        ligne_id: ligne.ligneId,
        numero: ligne.commande_numero,
        client_nom: ligne.client_nom,
        quantite: ligne.ligne_quantite,
        realise: realiseLigne,
        pct: ligne.ligne_quantite > 0 ? Math.round((realiseLigne / ligne.ligne_quantite) * 100) : null,
      }
    }

    // Everything else awaiting on this métier — the pieces of another OF the
    // legacy screen can no longer reach, plus the siblings of the one loaded.
    const others = waiting.filter((p) => p.id !== (piece?.id ?? 0))
    const otherOfLabels = await labelOfs(others.map((p) => p.IDordre_fabrication))

    let piecePayload: Record<string, unknown> | null = null
    if (piece) {
      const [defauts, names] = await Promise.all([selectDefauts(1, [piece.id]), bonnetierDirectory()])
      piecePayload = {
        id: piece.id,
        numero: piece.numero,
        label: `${metier.emplacement} - ${piece.numero}`,
        date_fin_ms: piece.date_fin_ms,
        of_id: piece.IDordre_fabrication,
        orpheline: piece.IDordre_fabrication !== headId,
        defauts: shapeDefauts(defauts, names),
      }
    }

    const due = await visitageDue(ofId, Number(of.ouvert_visiteuse) || 0, rolls)

    res.json({
      metier,
      of: {
        id: ofId,
        est_tete_de_file: ofId === headId,
        quantite,
        poids_piece: round2(Number(of.poids_piece) || 0),
        ouvert_visiteuse: Number(of.ouvert_visiteuse) || 0,
        visitage: Number(of.visitage) || 0,
        est_termine: Number(of.est_termine) || 0,
        // The legacy consigne opens with a stray CRLF on most rows.
        consigne: (of.observations ?? '').toString().replace(/^[\r\n]+/, '').trim() || null,
        ref_reference: ref?.reference ?? '',
        ref_designation: ref?.designation ?? '',
        contexture: ref?.contexture ?? '',
        coloris_label: coloriMap.get(coloriId) ?? '',
        IDref_ecru: refId,
        IDcolori_ecru: coloriId,
        IDligne_commande_client: Number(of.IDligne_commande_client) || 0,
        realise: realiseOf,
        pct: quantite > 0 ? Math.round((realiseOf / quantite) * 100) : null,
        commande,
      },
      piece: piecePayload,
      autres_pieces: others.map((p) => ({
        id: p.id,
        numero: p.numero,
        label: `${metier.emplacement} - ${p.numero}`,
        date_fin_ms: p.date_fin_ms,
        of_id: p.IDordre_fabrication,
        of_label: otherOfLabels.get(p.IDordre_fabrication) ?? `OF ${p.IDordre_fabrication}`,
        orpheline: p.IDordre_fabrication !== headId,
      })),
      numeros: await nextNumeros(ofId),
      a_visiter: due.a_visiter,
      a_visiter_raison: due.raison,
      // The cadence half of a_visiter is a recovered approximation (see
      // ROLLS_BETWEEN_VISITAGES); the screen says so and lets the visiteuse
      // override it. ouvert_visiteuse = 1 is exact, so no caveat there.
      approx: Number(of.ouvert_visiteuse) !== 1,
    })
  } catch (err) {
    console.error('visitage-trm poste:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** Rolls dropped on this métier over the last `jours` days (default: today
 *  only) — the bottom strip. The legacy has no equivalent: the visiteuse has
 *  no way of checking she has not already passed a piece. Read-only.
 *
 *  `jours` exists because a métier that ran a night shift and stopped can have
 *  nothing "today" while the last rolls are hours old; the screen widens the
 *  window rather than showing an empty strip. */
visitageTrmRouter.get('/historique', async (req: Request, res: Response) => {
  try {
    const machineId = parseInt(String(req.query.metier ?? ''), 10)
    if (isNaN(machineId) || machineId <= 0) { res.status(400).json({ error: 'Invalid métier' }); return }
    const jours = Math.min(30, Math.max(1, parseInt(String(req.query.jours ?? '1'), 10) || 1))

    const ofIds = await openOfsForMachine(machineId)
    if (ofIds.length === 0) { res.json([]); return }

    // date_saisie comparisons differ between the two drivers — read the tail
    // and cut in JS.
    const rows = await query<any>(
      `SELECT IDstock_ecru, IDordre_fabrication, numero, num_piece_OF, poids, second_choix,
              visiteur, date_saisie, IDpiece_production
       FROM stock_ecru WHERE IDordre_fabrication IN (${ofIds.join(',')})
       ORDER BY IDstock_ecru DESC LIMIT 60`,
    )
    const fixed = await fixEncoding(rows, 'stock_ecru', 'IDstock_ecru', ['numero', 'visiteur'])
    const from = new Date(); from.setHours(0, 0, 0, 0); from.setDate(from.getDate() - (jours - 1))
    const today = (fixed as any[])
      .map((r) => ({
        id: Number(r.IDstock_ecru),
        of_id: Number(r.IDordre_fabrication) || 0,
        numero: (r.numero ?? '').toString().trim(),
        num_piece_OF: Number(r.num_piece_OF) || 0,
        poids: round2(Number(r.poids) || 0),
        second_choix: Number(r.second_choix) || 0,
        visiteur: (r.visiteur ?? '').toString().trim(),
        date_saisie_ms: parseDtMs(r.date_saisie),
        IDpiece_production: Number(r.IDpiece_production) || 0,
      }))
      .filter((r) => r.date_saisie_ms !== null && r.date_saisie_ms >= from.getTime())

    const defauts = await selectDefauts(2, today.map((r) => r.id))
    const byRoll = new Map<number, number>()
    for (const d of defauts) byRoll.set(d.reference, (byRoll.get(d.reference) ?? 0) + 1)

    res.json(today.map((r) => ({ ...r, nb_defauts: byRoll.get(r.id) ?? 0 })))
  } catch (err) {
    console.error('visitage-trm historique:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  ÉTIQUETTES
// ════════════════════════════════════════════════════════

/** PDF response boilerplate — same three header tweaks as the other label
 *  endpoints, so the browser can embed the PDF cross-origin in dev. */
function sendPdf(res: Response, buffer: Buffer, filename: string): void {
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`)
  res.removeHeader('X-Frame-Options')
  res.removeHeader('Content-Security-Policy')
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  res.send(buffer)
}

/** Sample labels for the temporary print-test buttons. The only machine that
 *  can exercise the real Dymo is the production poste, so the shape has to be
 *  printable without creating a roll: these carry plausible values (and the
 *  third is a déclassé, the one variant that changes the layout). */
function demoEtiquettes(count: number): EtiquetteEcruData[] {
  const now = Date.now()
  return Array.from({ length: count }, (_, i) => ({
    numero: `3417/${71 + i}`,
    poids: [19.8, 20.15, 12.4, 20.05, 19.95][i % 5],
    metier: '3E',
    ref: '029',
    coloris: 'ecru',
    date_ms: now - i * 47 * 60 * 1000,
    second_choix: (i === 2 ? 1 : 0) as 0 | 1,
  }))
}

/**
 * GET /api/visitage-trm/etiquettes?ids=41231,41232
 *
 * The Dymo tags for rolls this poste created — ONE PDF PAGE PER ROLL, so a cut
 * piece spools its whole set in a single print job rather than one dialog per
 * label. The screen calls this with the ids POST /valider just returned.
 *
 * `?demo=N` renders N sample labels and reads nothing — see demoEtiquettes.
 *
 * No saisie_visitage gate: this only re-renders what is already printed on the
 * roll's own tag, which is exactly as sensitive as consulting the poste.
 *
 * ⚠️ No IDsociete filter — ETM's reception flips a delivered roll to société 1,
 * and a tag must stay reprintable afterwards (the same rule the rest of this
 * file and Tombé Métier › Stock follow). The partition guard is
 * `IDordre_fabrication > 0`: only TRM knitting has an OF, which is how Prime
 * scopes TRM production too.
 */
visitageTrmRouter.get('/etiquettes', async (req: Request, res: Response) => {
  try {
    const demo = parseInt(String(req.query.demo ?? ''), 10)
    if (Number.isFinite(demo) && demo > 0) {
      const buffer = await renderToBuffer(
        React.createElement(EtiquetteEcruPdf, { data: demoEtiquettes(Math.min(10, demo)) }) as React.ReactElement,
      )
      sendPdf(res, buffer, `etiquettes-test-${Math.min(10, demo)}.pdf`)
      return
    }

    const ids = String(req.query.ids ?? '')
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((x) => Number.isFinite(x) && x > 0)
      .slice(0, 20)
    if (ids.length === 0) { res.status(400).json({ error: 'ids manquants' }); return }

    const rows = await query<any>(
      `SELECT IDstock_ecru, numero, poids, second_choix, date_saisie,
              IDordre_fabrication, IDref_ecru, IDcolori_ecru
       FROM stock_ecru WHERE IDstock_ecru IN (${ids.join(',')})`,
    )
    const fixed = (await fixEncoding(rows, 'stock_ecru', 'IDstock_ecru', ['numero'])) as any[]
    const rolls = fixed.filter((r) => (Number(r.IDordre_fabrication) || 0) > 0)
    if (rolls.length === 0) { res.status(404).json({ error: 'rouleaux_introuvables' }); return }

    // OF → métier. machine is read through selectMachines (accented `archivé` /
    // `diamètre` → SELECT * + key folding), never joined in SQL.
    const ofIds = Array.from(new Set(rolls.map((r) => Number(r.IDordre_fabrication) || 0)))
    const ofRows = await query<{ IDordre_fabrication: number; IDmachine: number }>(
      `SELECT IDordre_fabrication, IDmachine FROM ordre_fabrication
       WHERE IDordre_fabrication IN (${ofIds.join(',')})`,
    )
    const machineByOf = new Map<number, number>()
    for (const o of ofRows) machineByOf.set(Number(o.IDordre_fabrication), Number(o.IDmachine) || 0)
    const machines = new Map((await selectMachines()).map((m) => [m.id, m]))

    const refs = await resolveEcruRefs(rolls.map((r) => Number(r.IDref_ecru) || 0))
    const coloris = await resolveColorisEcru(rolls.map((r) => Number(r.IDcolori_ecru) || 0))

    const byId = new Map<number, EtiquetteEcruData>()
    for (const r of rolls) {
      const m = machines.get(machineByOf.get(Number(r.IDordre_fabrication) || 0) ?? 0)
      byId.set(Number(r.IDstock_ecru), {
        numero: (r.numero ?? '').toString().trim(),
        poids: round2(Number(r.poids) || 0),
        // The poste and the "Poids des pièces" widget both name a métier by its
        // emplacement; `nom` is the fallback for the handful of rows where the
        // emplacement is blank.
        metier: (m?.emplacement || m?.nom || '').trim(),
        ref: refs.get(Number(r.IDref_ecru) || 0)?.reference ?? '',
        coloris: coloris.get(Number(r.IDcolori_ecru) || 0) ?? '',
        date_ms: parseDtMs(r.date_saisie),
        second_choix: (Number(r.second_choix) === 1 ? 1 : 0) as 0 | 1,
      })
    }

    // Requested order, not the driver's — the labels come off the Dymo in the
    // order the cut produced them.
    const data = ids.map((id) => byId.get(id)).filter((d): d is EtiquetteEcruData => d !== undefined)
    const buffer = await renderToBuffer(
      React.createElement(EtiquetteEcruPdf, { data }) as React.ReactElement,
    )
    sendPdf(res, buffer, `etiquettes-${data.length === 1 ? data[0].numero.replace('/', '-') : `x${data.length}`}.pdf`)
  } catch (err) {
    console.error('visitage-trm etiquettes:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  WRITE
// ════════════════════════════════════════════════════════

const validerBody = z.object({
  IDpiece_production: z.number().int().positive(),
  IDbonnetier: z.number().int().positive(),
  visitage_complet: z.boolean(),
  rouleaux: z.array(z.object({
    poids: z.number().positive(),
    second_choix: z.union([z.literal(0), z.literal(1)]),
    observations: z.string().max(2000).optional().default(''),
    defauts: z.array(z.object({
      /** > 0 = an existing defaut_qualite row declared at the terminal, to be
       *  carried onto this roll. 0 = a new one entered by the visiteuse. */
      id: z.number().int().nonnegative().default(0),
      type_defaut: z.string().max(60).optional().default(''),
      taille_cm: z.number().int().nonnegative().optional().default(0),
      nombre: z.number().int().nonnegative().optional().default(0),
      recupere: z.union([z.literal(0), z.literal(1)]).optional().default(0),
    })).default([]),
  })).min(1).max(10),
})

/** 401/403 guard for the only write on this router. Consulting the poste is
 *  open; creating stock is not. `isEffectiveAdmin` (not session admin) drives
 *  the bypass — same contract as commandes-trm's requireEditCommandes. */
async function requireSaisieVisitage(req: Request, res: Response): Promise<boolean> {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return false
  }
  const allowed = await trmUserHasPermission(req.userId, isEffectiveAdmin(req), 'saisie_visitage')
  if (!allowed) {
    res.status(403).json({ error: 'permission denied: saisie_visitage' })
    return false
  }
  return true
}

/** Rewrite one defect row so its accented `récuperé` changes value.
 *
 *  The Linux bridge rejects an accented identifier in a named SET, so the flag
 *  can only be written positionally — delete the row and reinsert it under the
 *  SAME id, in physical column order (the setClientFlag pattern from
 *  clients-common.ts). Everything that identifies the defect's origin is
 *  carried over untouched: its DATE, Type_Spotteur, IDSpotteur and description.
 *
 *  Physical order, taken from the runtime `SELECT *` key order and NOT from the
 *  .xdd listing (they disagree, and that already bit controle_titrage):
 *    IDdefaut_qualite, reference, description, DATE, Type_Spotteur, IDSpotteur,
 *    Type_Reference, type_defaut, traité, taille_cm, récuperé, nombre
 */
async function rewriteDefautWithRecupere(src: DefautRow, rollId: number, recupere: 0 | 1): Promise<void> {
  const dt = src.date_ms === null ? nowDt() : (() => {
    const d = new Date(src.date_ms as number)
    const p = (x: number) => String(x).padStart(2, '0')
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  })()
  await query(`DELETE FROM defaut_qualite WHERE IDdefaut_qualite = ${src.id}`)
  await query(
    `INSERT INTO defaut_qualite VALUES (${src.id}, '${rollId}', ` +
    `${src.description === '' ? 'NULL' : sqlText(src.description)}, '${dt}', ` +
    `${src.type_spotteur}, ${src.id_spotteur}, 2, ${sqlText(src.type_defaut)}, ` +
    `${src.traite}, ${src.taille_cm}, ${recupere}, ${src.nombre})`,
  )
}

/**
 * POST /api/visitage-trm/valider — the whole point of the screen.
 *
 * `?dry_run=1` returns the exact plan (numbers, rolls, defect moves, yarn
 * decrements) WITHOUT writing anything. That is what check-visitage-trm.ts
 * asserts, so the HTTP guard never has to create a real production row.
 *
 * Writes per validation, in order:
 *   1. stock_ecru — one named INSERT per roll (never naming IDPropriétaire,
 *      which is accented).
 *   2. defaut_qualite — the piece's Type_Reference = 1 rows are CONVERTED in
 *      place to Type_Reference = 2 pointing at the new roll, preserving DATE /
 *      Type_Spotteur / IDSpotteur / description. Defects the visiteuse added
 *      are fresh positional INSERTs with Type_Spotteur = 2 and a NULL
 *      description. Defects she dropped are DELETEd.
 *   3. evenement_piece — one positional INSERT per roll, "Visitage tombé
 *      métier" or "Pesage tombé métier".
 *   4. stock_fil — each asso_fil_of lot loses Σ(poids) × pourcentage / 100 and
 *      gets today's dernier_mouvement.
 *
 * ⚠️ There are NO transactions across the HFSQL bridge. Everything checkable is
 * checked BEFORE the first write (piece still free, defect ownership, weights,
 * rights), and on a mid-sequence failure the response reports the rolls that
 * did get created rather than a bare 500 — an honest partial beats a lie.
 */
visitageTrmRouter.post('/valider', async (req: Request, res: Response) => {
  if (!(await requireSaisieVisitage(req, res))) return

  const dryRun = String(req.query.dry_run ?? '') === '1'
  const parsed = validerBody.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
    return
  }
  const body = parsed.data
  const created: { id: number; numero: string; num_piece_OF: number; second_choix: number; poids: number }[] = []

  try {
    // ── 1. Pre-flight, all of it, before any write ──────
    const pieceRows = await query<any>(
      `SELECT IDpiece_production, IDordre_fabrication, numero, date_fin
       FROM piece_production WHERE IDpiece_production = ${body.IDpiece_production}`,
    )
    if (pieceRows.length === 0) { res.status(404).json({ error: 'piece_introuvable' }); return }
    if (parseDtMs(pieceRows[0].date_fin) === null) { res.status(409).json({ error: 'piece_non_terminee' }); return }

    const ofId = Number(pieceRows[0].IDordre_fabrication) || 0
    const loaded = await loadOf(ofId)
    if (!loaded) { res.status(404).json({ error: 'of_hors_perimetre' }); return }
    const { of } = loaded

    // The race that actually happens: two postes on the same piece. stock_ecru
    // has no unique key to lean on, so this check is the only guard.
    const already = await query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM stock_ecru WHERE IDpiece_production = ${body.IDpiece_production}`,
    )
    if ((Number(already[0]?.c) || 0) > 0) { res.status(409).json({ error: 'piece_deja_visitee' }); return }

    // Every carried defect must really belong to THIS piece — otherwise a
    // crafted payload could re-parent another piece's defect onto this roll.
    const carriedIds = body.rouleaux.flatMap((r) => r.defauts.map((d) => d.id)).filter((id) => id > 0)
    const pieceDefauts = await selectDefauts(1, [body.IDpiece_production])
    const pieceDefautIds = new Set(pieceDefauts.map((d) => d.id))
    for (const id of carriedIds) {
      if (!pieceDefautIds.has(id)) {
        res.status(409).json({ error: 'defaut_hors_piece', IDdefaut_qualite: id })
        return
      }
    }
    // New defects must name a type we know how to store.
    for (const r of body.rouleaux) {
      for (const d of r.defauts) {
        if (d.id > 0) continue
        if (normaliseTypeDefaut(d.type_defaut) === '') {
          res.status(400).json({ error: 'type_defaut_manquant' })
          return
        }
      }
    }

    const visiteurs = await bonnetierDirectory()
    const visiteurNom = bonnetierDisplayName(visiteurs.get(body.IDbonnetier))
    if (visiteurNom === '') { res.status(400).json({ error: 'visiteur_inconnu' }); return }

    // ── 2. Numbering, recomputed at the last moment ─────
    const nums = await nextNumeros(ofId)
    let nextFirst = nums.premier_choix
    let nextSecond = nums.second_choix
    const plan = body.rouleaux.map((r) => ({
      ...r,
      num_piece_OF: r.second_choix === 1 ? nextSecond++ : nextFirst++,
    }))

    // Yarn: every roll consumes, déclassés included — 43 of 75 open lots
    // reproduce stock_initial − stock that way and NONE reproduce a
    // first-choice-only sum (probe-visitage-trm.ts §2).
    const totalPoids = round2(plan.reduce((s, r) => s + r.poids, 0))
    const asso = await query<any>(
      `SELECT IDstock_fil, pourcentage FROM asso_fil_of
       WHERE IDordre_fabrication = ${ofId} AND IDstock_fil > 0`,
    )
    const lots = await selectStockFilByIds(asso.map((a: any) => Number(a.IDstock_fil) || 0))
    const filPlan = asso.map((a: any) => {
      const id = Number(a.IDstock_fil) || 0
      const lot = lots.get(id)
      const delta = round2(totalPoids * ((Number(a.pourcentage) || 100) / 100))
      return {
        IDstock_fil: id,
        lot: lot?.lot ?? '',
        pourcentage: Number(a.pourcentage) || 100,
        avant: lot?.stock ?? 0,
        // `stock` legitimately goes negative — documented, do not clamp.
        apres: round2((lot?.stock ?? 0) - delta),
        delta,
      }
    })

    const evenement = body.visitage_complet ? EVT_VISITAGE : EVT_PESAGE

    if (dryRun) {
      res.json({
        dry_run: true,
        of_id: ofId,
        evenement,
        rouleaux: plan.map((r) => ({
          numero: `${ofId}/${r.num_piece_OF}`,
          num_piece_OF: r.num_piece_OF,
          second_choix: r.second_choix,
          poids: r.poids,
          defauts_reportes: r.defauts.filter((d) => d.id > 0).map((d) => d.id),
          defauts_ajoutes: r.defauts.filter((d) => d.id === 0).length,
        })),
        defauts_supprimes: pieceDefauts.filter((d) => !carriedIds.includes(d.id)).map((d) => d.id),
        fil: filPlan,
      })
      return
    }

    // ── 3. Writes ───────────────────────────────────────
    for (const r of plan) {
      // stock_ecru. IDsociete = 2, IDmagasin = 0, IDligne_commande_client = 0
      // (that one is ETM's), IDLigne_Commande_TRM = the OF's line. lot/metrage
      // stay empty on TRM rows. IDPropriétaire is accented → never named.
      // newIdAfterInsert needs the pre-insert high-water mark: HFSQL hands
      // out the PK itself, so the new row is the first id above it.
      const beforeId = await maxId('stock_ecru', 'IDstock_ecru')
      await query(
        `INSERT INTO stock_ecru
         (numero, lot, poids, metrage, num_piece_OF, second_choix, visiteur, observations,
          date_saisie, IDmagasin, IDsociete, IDordre_fabrication, IDref_ecru, IDcolori_ecru,
          IDpiece_production, IDLigne_Commande_TRM, IDligne_commande_client,
          IDligne_expedition_TRM, IDligne_expedition_ETM,
          IDref_commande_source, IDref_commande_affectation, IDcommande_donation)
         VALUES (${sqlText(`${ofId}/${r.num_piece_OF}`)}, '', ${r.poids}, 0, ${r.num_piece_OF},
                 ${r.second_choix}, ${sqlText(visiteurNom)}, ${sqlText(r.observations)},
                 '${nowDt()}', 0, ${TRM_SOCIETE}, ${ofId}, ${Number(of.IDref_ecru) || 0},
                 ${Number(of.IDcolori_ecru) || 0}, ${body.IDpiece_production},
                 ${Number(of.IDligne_commande_client) || 0}, 0, 0, 0, 0, 0, 0)`,
      )
      const rollId = await newIdAfterInsert('stock_ecru', 'IDstock_ecru', beforeId)
      created.push({
        id: rollId,
        numero: `${ofId}/${r.num_piece_OF}`,
        num_piece_OF: r.num_piece_OF,
        second_choix: r.second_choix,
        poids: r.poids,
      })

      for (const d of r.defauts) {
        if (d.id > 0) {
          // Carried from the terminal: re-parent in place. `récuperé` is
          // accented, so it can only be written by the delete + positional
          // reinsert dance — and only when it actually changed, which keeps the
          // common path a plain UPDATE.
          const src = pieceDefauts.find((x) => x.id === d.id)
          if (!src) continue
          if (Number(src.recupere) === Number(d.recupere)) {
            await query(
              `UPDATE defaut_qualite SET Type_Reference = 2, reference = '${rollId}'
               WHERE IDdefaut_qualite = ${d.id}`,
            )
          } else {
            await rewriteDefautWithRecupere(src, rollId, d.recupere)
          }
        } else {
          // Entered here. Type_Spotteur = 2 + description NULL is the visitage
          // signature; `date` is reserved → positional INSERT, MAX+1 PK.
          const type = normaliseTypeDefaut(d.type_defaut)
          const unite = uniteForType(type)
          const newId = (await maxId('defaut_qualite', 'IDdefaut_qualite')) + 1
          await query(
            `INSERT INTO defaut_qualite VALUES (${newId}, '${rollId}', NULL, '${nowDt()}', 2, ` +
            `${body.IDbonnetier}, 2, ${sqlText(type)}, 0, ${unite === 'cm' ? d.taille_cm : 0}, 0, ` +
            `${unite === 'nb' ? d.nombre : 0})`,
          )
        }
      }

      // evenement_piece — reserved `date` → positional, MAX+1 PK. Physical
      // order: IDevenement_piece, evenement, IDpiece_production, DATE,
      // IDbonnetier, observation, IDstock_ecru, appareil.
      const evtId = (await maxId('evenement_piece', 'IDevenement_piece')) + 1
      await query(
        `INSERT INTO evenement_piece VALUES (${evtId}, ${sqlText(evenement)}, 0, '${nowDt()}', ` +
        `${body.IDbonnetier}, NULL, ${rollId}, '')`,
      )
    }

    // Defects the visiteuse dropped: they were the piece's, and no roll claims
    // them any more.
    const kept = new Set(carriedIds)
    for (const d of pieceDefauts) {
      if (!kept.has(d.id)) await query(`DELETE FROM defaut_qualite WHERE IDdefaut_qualite = ${d.id}`)
    }

    // stock_fil. Both named columns are ASCII, so a plain UPDATE is safe — but
    // never SELECT * this table (memo-binary certif columns → 0 rows on the
    // Windows driver).
    for (const f of filPlan) {
      if (f.IDstock_fil <= 0) continue
      await query(
        `UPDATE stock_fil SET stock = ${f.apres}, dernier_mouvement = '${todayHfsql()}'
         WHERE IDstock_fil = ${f.IDstock_fil}`,
      )
    }

    res.status(201).json({ of_id: ofId, evenement, rouleaux: created, fil: filPlan })
  } catch (err) {
    console.error('visitage-trm valider:', err)
    // No transactions here: say exactly what did land rather than implying
    // nothing did.
    res.status(500).json({ error: 'ecriture_partielle', rouleaux_crees: created })
  }
})
