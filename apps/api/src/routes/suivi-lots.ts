// Qualité › Suivi Lots — quality-control lot tracking.
//
// One `suivilot` row per (IDligne_commande_sous_traitant, lot) pair, created
// on reception by `upsertSuivilot()` in commandes-sous-traitant.ts. This route
// powers the read-only récap + pièces and the editable Contrôles (SST + tirelle
// measurements, observations, emplacement, archivage) plus lot état / archive.
//
// HFSQL footguns honoured (see CLAUDE.md):
//  - No parameterized queries: string-interpolate with esc()/sqlText()/n().
//  - No RETURNING: follow-up SELECT after writes.
//  - Accented columns (`freinte_demandée`, `stabH_demandée`, `stabL_demandée`,
//    `approuvé_qualité`) are NEVER named on Linux: reads go through SELECT * +
//    pickKey regex; the only accented write (`approuvé_qualité`) is gated on
//    IS_WINDOWS, with IDetatLot carrying validation state on the bridge.
//  - All editable Contrôles columns are ASCII → direct UPDATE is bridge-safe.
//  - Empty FK columns store 0, not NULL: guard with (col IS NULL OR col = 0).
//  - Driver returns état ids as BigInt → coerce with Number().

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { query, queryRaw, fixEncoding } from '../lib/hfsql-auto.js'
import { stripRtf } from '../lib/rtf-utils.js'
import { userHasPermission } from '../lib/permissions.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import {
  CONFORMITE_VALUES,
  loadActions,
  loadAllMentions,
  loadConformites,
  mentionsForLine,
  setConformite,
  type Conformite,
} from '../lib/actions-qualite.js'

import { IS_WINDOWS, canNameAccented } from '../lib/sst-shared.js'
import { ouvrirReprise, reprisesDuLot, RepriseRefusee } from '../lib/reprises.js'
import { nomUtilisateur } from '../lib/stock-fini-mesures.js'
import { finiCommandeParClientEtiquettes, lotColoriId } from './etiquettes-sp.js'
import { z } from 'zod'
import React from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import { mpsPg } from '../lib/mps-pg.js'
import { sendMail } from '../lib/gmail.js'
import { getUserEmail } from '../lib/user-emails.js'
import {
  cleLot, etapeLot, lireCommandesEnnoblissement, prealablesValidation, urgenceLot, type EtapeLot, type LotFait, type SoumissionFait,
} from '../lib/cycle-ennoblissement.js'
import { enregistrerOkRamer, type NatureSoumission } from '../lib/soumission-lot.js'
import { findEligibleLots } from './commandes-sous-traitant.js'
import { clientsDesLots, cleLotLigne, journaliserEnvoiRc, rapportControleLot, type ClientDuLot, type RapportControleLot } from '../lib/rapport-controle-lot.js'
import { RapportControlePdf } from '../lib/pdf/RapportControlePdf.js'
import { CONTROLES_PAR_DEFAUT } from '../lib/controles-lot.js'

export const suiviLotsRouter: RouterType = Router()

// ── Helpers ──────────────────────────────────────────────

/** Gate a mutating endpoint behind the `responsable_qualite` permission
 *  (effective admins bypass). Writes the 401/403 response and returns false
 *  when the caller isn't allowed, so handlers can `if (!(await ...)) return`.
 *  Reads stay open — the Qualité screen is view-for-all, interact-for-responsable. */
async function ensureResponsable(req: Request, res: Response): Promise<boolean> {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return false
  }
  const allowed = await userHasPermission(req.userId, isEffectiveAdmin(req), 'responsable_qualite')
  if (!allowed) {
    res.status(403).json({ error: 'permission denied: responsable_qualite' })
    return false
  }
  return true
}

function esc(value: string): string {
  return value.replace(/'/g, "''")
}

/** SQL literal for user text: ASCII → quoted, accented → Latin-1 hex literal
 *  (the Linux bridge corrupts raw multi-byte UTF-8 in the SQL line). */
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

function n(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0
  const parsed = Number(value)
  return isNaN(parsed) ? 0 : parsed
}

/** Keep only an 8-digit YYYYMMDD; accepts 'YYYY-MM-DD' / 'YYYYMMDD' / ''. */
function dateStr(value: unknown): string {
  if (value === null || value === undefined) return ''
  const s = String(value).replace(/-/g, '')
  return /^\d{8}$/.test(s) ? s : ''
}

/** Resolve an accent-mangled SELECT * key by prefix regex (the Linux bridge
 *  truncates accented identifiers; Windows keeps them intact). */
function pickKey(row: Record<string, unknown>, re: RegExp): unknown {
  const k = Object.keys(row).find((key) => re.test(key))
  return k !== undefined ? row[k] : null
}

/** Normalise a free-text DB field: HFSQL stores "empty" as a NUL byte / single
 *  space, both truthy in JS. Strip NULs and trim; return '' when effectively empty. */
function cleanText(value: unknown): string {
  return (value ?? '').toString().replace(/\u0000/g, '').trim()
}

// ── The lot's cycle (LIVA #1304) ─────────────────────────
//
// The step and what still blocks « Valider le lot » are computed by
// lib/cycle-ennoblissement.ts from the same facts as Sous-traitants ›
// Ennoblissement, so both screens always agree.

interface EtapeDuLot { etape: EtapeLot; prealables: string[]; fait: LotFait }

/** The cycle facts of the given lots, read per dye order. */
async function etapesDesLots(lots: Array<{ id: number; cmd: number }>): Promise<Map<number, EtapeDuLot>> {
  const out = new Map<number, EtapeDuLot>()
  const cmdIds = [...new Set(lots.map((l) => l.cmd).filter((x) => x > 0))]
  if (cmdIds.length === 0) return out
  const voulus = new Set(lots.map((l) => l.id))
  const faits = await lireCommandesEnnoblissement(cmdIds)
  for (const c of faits.values()) {
    for (const f of c.lots) {
      if (!voulus.has(f.idsuivilot)) continue
      out.set(f.idsuivilot, { etape: etapeLot(f), prealables: prealablesValidation(f), fait: f })
    }
  }
  return out
}

async function etapeDuLot(id: number): Promise<EtapeDuLot | null> {
  const rows = await mpsPg()<{ cmd: number }[]>`SELECT COALESCE(idcommande_sous_traitant, 0) AS cmd FROM suivilot WHERE idsuivilot = ${id}`
  if (rows.length === 0) return null
  return (await etapesDesLots([{ id, cmd: Number(rows[0].cmd) }])).get(id) ?? null
}

/** Validated lots that still owe a client its rapport de contrôle: a client
 *  switched « rapport de contrôle » holds unshipped pieces of the lot. The
 *  exact rule (sent since the last reprise?) is applied by clientsDesLots(). */
async function lotsValidesRcDu(): Promise<number[]> {
  const rows = await mpsPg()<{ id: number; ligne: number; lot: string }[]>`
    SELECT DISTINCT s.idsuivilot AS id, s.idligne_commande_sous_traitant AS ligne, trim(s.lot::text) AS lot
    FROM suivilot s
    JOIN stock_fini sf ON sf.idref_commande_source = s.idligne_commande_sous_traitant AND trim(sf.lot::text) = trim(s.lot::text)
    JOIN ligne_commande_client lcc ON lcc.idligne_commande_client = sf.idligne_commande_client
    JOIN commande_client cc ON cc.idcommande_client = lcc.idcommande_client
    JOIN client c ON c.idclient = cc.idclient AND COALESCE(c.inclurerapportqualite, 0) = 1
    WHERE s.idetatlot IN (3, 4) AND sf.idligne_commande_client > 0
      AND COALESCE(sf.idligne_expedition, 0) = 0 AND COALESCE(sf.idcommande_donation, 0) = 0`
  if (rows.length === 0) return []
  const clients = await clientsDesLots(rows.map((r) => ({ ligne: Number(r.ligne), lot: r.lot })))
  return rows.filter((r) => (clients.get(cleLotLigne(Number(r.ligne), r.lot)) ?? []).some((c) => c.du)).map((r) => Number(r.id))
}

/** Cache-free per-request état label map (small table). */
async function loadEtatLabels(): Promise<Map<number, string>> {
  const map = new Map<number, string>()
  try {
    const rows = await query<{ IDetat_stock_fini: number; libelle: string | null }>(
      `SELECT IDetat_stock_fini, libelle FROM etat_stock_fini`,
    )
    const fixed = await fixEncoding(rows, 'etat_stock_fini', 'IDetat_stock_fini', ['libelle'])
    for (const r of fixed) map.set(Number(r.IDetat_stock_fini), (r.libelle ?? '').toString())
  } catch {
    /* labels are best-effort */
  }
  return map
}

// ── Types ────────────────────────────────────────────────

interface SuiviLotListRow {
  IDsuivilot: number
  lot: string | null
  IDsous_traitant: number
  IDetatLot: number | null
  fin_archivage: string | null
  DATE: string | null
}

// ── List ─────────────────────────────────────────────────
//
// GET /suivi-lots?status=en_cours|termine|tous&q=
suiviLotsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const status = (req.query.status as string) || 'en_cours'
    const q = ((req.query.q as string) || '').trim()

    let where = 'WHERE 1=1'
    // "Terminé" ⟺ lot validated (IDetatLot = 3 = "Validé"), matching legacy.
    // Everything else (En Contrôle / En Reprise / Attente de décision …) is en cours,
    // plus a validated lot that still owes a client its rapport de contrôle (#1304).
    // NB: this is the lot état, NOT fin_archivage — archiving is a separate flag.
    const rcDus = await lotsValidesRcDu()
    if (status === 'en_cours') {
      where += ` AND (s.IDetatLot IS NULL OR s.IDetatLot <> 3${rcDus.length ? ` OR s.IDsuivilot IN (${rcDus.join(',')})` : ''})`
    } else if (status === 'termine') where += ` AND s.IDetatLot = 3`
    if (q) {
      const e = esc(q)
      where += ` AND (s.lot LIKE '%${e}%' OR st.nom LIKE '%${e}%')`
    }

    // NB: select the real column `nom` (not an alias) — fixEncoding re-runs
    // `CONVERT(<field>) FROM sous_traitant`, so the field name must be the actual
    // column. Aliasing to sous_traitant_nom makes that CONVERT fail and silently
    // leaves the U+FFFD mangling in place. Rename to sous_traitant_nom in JS below.
    const rows = await query<SuiviLotListRow & { nom: string | null; IDcommande_sous_traitant: number | null }>(
      `SELECT s.IDsuivilot, s.lot, s.IDsous_traitant, s.IDetatLot, s.fin_archivage, s.DATE, s.IDcommande_sous_traitant,
              st.nom
       FROM suivilot s
       LEFT JOIN sous_traitant st ON s.IDsous_traitant = st.IDsous_traitant
       ${where}
       ORDER BY s.DATE DESC, s.IDsuivilot DESC`,
    )
    const fixed = await fixEncoding(rows, 'sous_traitant', 'IDsous_traitant', ['nom'])
    const etatLabels = await loadEtatLabels()
    // The computed step, for the open lots and those owing an RC only — a
    // validated lot reads « Validé » (5 500 of them under « Tous »).
    const rcDu = new Set(rcDus)
    const etapes = await etapesDesLots(
      fixed
        .filter((r) => Number(r.IDetatLot) !== 3 || rcDu.has(Number(r.IDsuivilot)))
        .map((r) => ({ id: Number(r.IDsuivilot), cmd: Number(r.IDcommande_sous_traitant) || 0 })),
    )

    const t = new Date()
    const today = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
    res.json(
      fixed.map((r) => {
        const etat = r.IDetatLot != null ? Number(r.IDetatLot) : null
        const e = etapes.get(Number(r.IDsuivilot))
        return {
          IDsuivilot: Number(r.IDsuivilot),
          lot: r.lot ?? '',
          sous_traitant_nom: r.nom ?? '',
          IDetatLot: etat,
          etat_libelle: etat != null ? etatLabels.get(etat) ?? null : null,
          // null = not computed (lot not tied to a dye order): the screen reads the état.
          etape: e?.etape ?? (etat === 3 || etat === 4 ? 'valide' : null),
          rc_a_envoyer: (e?.fait.rcAEnvoyer ?? []).length > 0,
          // Red / amber card (§41): the lot's own relance, the rule of Sous-traitants › Ennoblissement.
          urgence: e ? urgenceLot(e.fait, today) : null,
          date: r.DATE ?? null,
        }
      }),
    )
  } catch (err) {
    console.error('Error listing suivi-lots:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Soumission coloris: the lots not received yet (LIVA #1313) ─────
//
// GET /suivi-lots/soumission-coloris/candidats
//
// Where a lot MATEL announces (« on peut soumettre le lot MA… cde N », in
// Perrine's answer to the point §3) is submitted for its coloris before the
// stenter: the open dye lines whose client asks the coloris for the reference
// (Clients › Gestion), with écru at the dyer reserved to the client order. The
// lot number is typed at send time; the soumission creates the lot here.
suiviLotsRouter.get('/soumission-coloris/candidats', async (_req: Request, res: Response) => {
  try {
    const sql = mpsPg()
    const commandes = await sql<{ cmd: number; sst: string | null }[]>`
      SELECT DISTINCT l.idcommande_sous_traitant AS cmd, st.nom::text AS sst
      FROM ligne_commande_sous_traitant l
      JOIN commande_sous_traitant c ON c.idcommande_sous_traitant = l.idcommande_sous_traitant
      LEFT JOIN sous_traitant st ON st.idsous_traitant = c.idsous_traitant
      JOIN stock_ecru se ON se.idref_commande_affectation = l.idligne_commande_sous_traitant AND se.idligne_commande_client > 0
      JOIN ligne_commande_client lcc ON lcc.idligne_commande_client = se.idligne_commande_client
      JOIN commande_client cc ON cc.idcommande_client = lcc.idcommande_client
      JOIN designation_client d ON d.idclient = cc.idclient AND d.idref_fini = l.idreference
        AND (COALESCE(d.soumettre, 0) & 2) = 2 AND COALESCE(d.archive, 0) = 0
      WHERE l.type = 2 AND COALESCE(c.est_soldee, 0) = 0 AND COALESCE(l.sstatut::text, '') NOT LIKE 'Termin%'
      ORDER BY 1 DESC`
    const out = []
    for (const c of commandes) {
      const lots = (await findEligibleLots(Number(c.cmd))).filter((l) => l.kind === 'manual' && l.natures.includes('coloris'))
      for (const l of lots) out.push({ ...l, idcommande_sous_traitant: Number(c.cmd), sous_traitant_nom: (c.sst ?? '').trim() })
    }
    res.json(out)
  } catch (err) {
    console.error('Error listing coloris soumission candidates:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Detail ───────────────────────────────────────────────
//
// GET /suivi-lots/:id
suiviLotsRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    // Base row — single-table SELECT * so accented spec columns survive
    // (resolved via pickKey below). Windows returns intact keys; Linux
    // truncates them, both matched by the prefix regex.
    const baseRows = await query<Record<string, unknown>>(
      `SELECT * FROM suivilot WHERE IDsuivilot = ${id}`,
    )
    if (baseRows.length === 0) { res.status(404).json({ error: 'Lot not found' }); return }
    const raw = baseRows[0]

    const ligneId = Number(raw.IDligne_commande_sous_traitant) || 0
    const cmdId = Number(raw.IDcommande_sous_traitant) || 0
    const sstId = Number(raw.IDsous_traitant) || 0
    const IDref_fini = Number(raw.IDref_fini) || 0
    const IDref_fini_colori = Number(raw.IDref_fini_colori) || 0
    const IDColoris = Number(raw.IDColoris) || 0
    const lot = (raw.lot ?? '').toString()

    // Repair encoding on the free-text fields stored on suivilot itself.
    const [fixedSelf] = await fixEncoding(
      [raw],
      'suivilot',
      'IDsuivilot',
      ['observations', 'emplacement_tirelle'],
    )

    // Récap context: commande header + références + coloris (avec_teinture rule).
    const [cmdRows, refRows] = await Promise.all([
      cmdId > 0
        ? query<{ IDcommande_sous_traitant: number; date_commande: string | null; commentaire: string | null; IDcommande_client: number | null }>(
            // NB: select IDcommande_sous_traitant — fixEncoding keys its CONVERT
            // repair on it; omitting it makes the repair a silent no-op (NaN guard).
            `SELECT IDcommande_sous_traitant, date_commande, commentaire, IDcommande_client
             FROM commande_sous_traitant WHERE IDcommande_sous_traitant = ${cmdId}`,
          )
        : Promise.resolve([]),
      IDref_fini > 0
        ? query<{
            IDref_fini: number
            reference: string | null
            avec_teinture: number | null
            poids_Min: number | null
            poids_Max: number | null
            laizeHT_Min: number | null
            laizeHT_Max: number | null
            stab_hauteur: number | null
            stab_largeur: number | null
            freinte: number | null
            rendement: number | null
          }>(
            // NB: select IDref_fini — fixEncoding keys its CONVERT repair on it.
            `SELECT IDref_fini, reference, avec_teinture, poids_Min, poids_Max, laizeHT_Min, laizeHT_Max,
                    stab_hauteur, stab_largeur, freinte, rendement
             FROM ref_fini WHERE IDref_fini = ${IDref_fini}`,
          )
        : Promise.resolve([]),
    ])
    const [fixedCmd] = cmdRows.length
      ? await fixEncoding(cmdRows, 'commande_sous_traitant', 'IDcommande_sous_traitant', ['commentaire'])
      : [undefined as any]
    const [fixedRef] = refRows.length
      ? await fixEncoding(refRows, 'ref_fini', 'IDref_fini', ['reference'])
      : [undefined as any]

    const avecTeinture = Number(fixedRef?.avec_teinture) || 0
    let coloris = ''
    if (avecTeinture > 0 && IDref_fini_colori > 0) {
      const cr = await query<{ IDref_fini_colori: number; reference: string | null }>(
        // NB: select IDref_fini_colori — fixEncoding keys its CONVERT repair on it.
        `SELECT IDref_fini_colori, reference FROM ref_fini_colori WHERE IDref_fini_colori = ${IDref_fini_colori}`,
      )
      const [fc] = cr.length ? await fixEncoding(cr, 'ref_fini_colori', 'IDref_fini_colori', ['reference']) : []
      coloris = (fc?.reference ?? '').toString()
    } else if (IDColoris > 0) {
      const cr = await query<{ IDcolori_ecru: number; reference: string | null }>(
        // NB: select IDcolori_ecru — fixEncoding keys its CONVERT repair on it.
        `SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDcolori_ecru = ${IDColoris}`,
      )
      const [fc] = cr.length ? await fixEncoding(cr, 'colori_ecru', 'IDcolori_ecru', ['reference']) : []
      coloris = (fc?.reference ?? '').toString()
    }

    // Pièces du lot — received finished rolls for this (ligne, lot).
    type PieceRow = {
      IDstock_fini: number; numero: string | null; poids: number | null; metrage: number | null
      IDmagasin: number | null; IDstock_ecru: number | null
      observations: string | null; observation_sst: string | null
      IDligne_commande_client: number | null
    }
    const pieceRowsRaw = ligneId > 0
      ? await query<PieceRow>(
          `SELECT IDstock_fini, numero, poids, metrage, IDmagasin, IDstock_ecru, observations, observation_sst,
                  IDligne_commande_client
           FROM stock_fini
           WHERE IDref_commande_source = ${ligneId} AND lot = '${esc(lot)}'
           ORDER BY numero, IDstock_fini`,
        )
      : []
    // Repair encoding on the fini-level free-text quality fields.
    const pieceRows = pieceRowsRaw.length
      ? await fixEncoding(pieceRowsRaw, 'stock_fini', 'IDstock_fini', ['observations', 'observation_sst'])
      : []

    // ── Roll quality history ────────────────────────────────
    // Each roll surfaces comments/defects from up to three stages:
    //   • Tricotage — the source écru roll's visiteur comment + structured
    //     knitting defects (defaut_qualite, écru via Type_Reference=2 and the
    //     écru's piece_production via Type_Reference=1).
    //   • Ennoblisseur — the dyer's free-text note on the fini roll (observation_sst).
    //   • Contrôle fini — the visiteur note captured at fini reception (observations).
    type QualityEntry = { source: string; author: string; text: string }
    const qualityByFini = new Map<number, QualityEntry[]>()
    const pushQuality = (finiId: number, e: QualityEntry) => {
      if (!e.text) return
      const arr = qualityByFini.get(finiId) ?? []
      arr.push(e)
      qualityByFini.set(finiId, arr)
    }

    // Fini-level notes (already encoding-repaired above).
    for (const p of pieceRows) {
      const finiId = Number(p.IDstock_fini)
      pushQuality(finiId, { source: 'Ennoblisseur', author: '', text: cleanText(p.observation_sst) })
      pushQuality(finiId, { source: 'Contrôle fini', author: '', text: cleanText(p.observations) })
    }

    // Map fini → source écru, and load écru-stage notes + knitting defects.
    const ecruIds = Array.from(new Set(pieceRows.map((p) => Number(p.IDstock_ecru)).filter((e) => e > 0)))
    if (ecruIds.length > 0) {
      const finiByEcru = new Map<number, number[]>()
      for (const p of pieceRows) {
        const e = Number(p.IDstock_ecru)
        if (e > 0) { const arr = finiByEcru.get(e) ?? []; arr.push(Number(p.IDstock_fini)); finiByEcru.set(e, arr) }
      }
      const ecruRows = await query<{ IDstock_ecru: number; observations: string | null; visiteur: string | null; IDpiece_production: number | null }>(
        `SELECT IDstock_ecru, observations, visiteur, IDpiece_production
         FROM stock_ecru WHERE IDstock_ecru IN (${ecruIds.join(',')})`,
      )
      const ecruFixed = await fixEncoding(ecruRows, 'stock_ecru', 'IDstock_ecru', ['observations', 'visiteur'])
      const ppByEcru = new Map<number, number>()
      for (const e of ecruFixed) {
        const eid = Number(e.IDstock_ecru)
        const targets = finiByEcru.get(eid) ?? []
        const note = cleanText(e.observations)
        for (const fid of targets) pushQuality(fid, { source: 'Tricotage', author: cleanText(e.visiteur), text: note })
        const pp = Number(e.IDpiece_production) || 0
        if (pp > 0) ppByEcru.set(eid, pp)
      }

      // Structured knitting defects: defaut_qualite is polymorphic — Type_Reference=2
      // keys on the écru id, Type_Reference=1 on the écru's piece_production id.
      const ppIds = Array.from(new Set([...ppByEcru.values()]))
      const ecruByPp = new Map<number, number>()
      for (const [eid, pp] of ppByEcru) ecruByPp.set(pp, eid)

      const collectDefauts = async (typeRef: number, refIds: number[], keyToEcru: (ref: number) => number) => {
        if (refIds.length === 0) return
        const inList = refIds.map((x) => `'${x}'`).join(',')
        const defRows = await queryRaw(
          `SELECT * FROM defaut_qualite WHERE Type_Reference = ${typeRef} AND reference IN (${inList})`,
        )
        const defFixed = await fixEncoding(
          defRows as Record<string, unknown>[], 'defaut_qualite', 'IDdefaut_qualite', ['description', 'type_defaut'],
        )
        for (const d of defFixed) {
          const ecru = keyToEcru(Number((d as any).reference) || 0)
          const targets = finiByEcru.get(ecru) ?? []
          const typ = cleanText((d as any).type_defaut)
          const desc = cleanText((d as any).description)
          const text = [typ, desc].filter(Boolean).join(' — ')
          for (const fid of targets) pushQuality(fid, { source: 'Défaut tricotage', author: '', text })
        }
      }
      await collectDefauts(2, ecruIds, (ref) => ref)
      await collectDefauts(1, ppIds, (ref) => ecruByPp.get(ref) ?? 0)
    }
    // Resolve magasin (= sous_traitant) names in one batched query.
    const magIds = Array.from(new Set(pieceRows.map((p) => Number(p.IDmagasin)).filter((m) => m > 0)))
    const magMap = new Map<number, string>()
    if (magIds.length > 0) {
      const magRows = await query<{ IDsous_traitant: number; nom: string | null }>(
        `SELECT IDsous_traitant, nom FROM sous_traitant WHERE IDsous_traitant IN (${magIds.join(',')})`,
      )
      for (const m of await fixEncoding(magRows, 'sous_traitant', 'IDsous_traitant', ['nom']))
        magMap.set(Number(m.IDsous_traitant), (m.nom ?? '').toString())
    }
    // Rendement validity bounds (ports legacy gxRendementMini/Maxi).
    // A piece is conforming when its rdt (metrage/poids) falls in [mini, maxi].
    // Mini comes from the max weight/laize (→ lowest rendement), maxi from the min.
    const rendementDemande = n(raw.rendement_demande)
    const refPoidsMin = n(fixedRef?.poids_Min)
    const refPoidsMax = n(fixedRef?.poids_Max)
    const refLaizeMin = n(fixedRef?.laizeHT_Min)
    const refLaizeMax = n(fixedRef?.laizeHT_Max)
    const refFreinte = n(fixedRef?.freinte)
    const refRendement = n(fixedRef?.rendement)
    let rendementMini = rendementDemande
    let rendementMaxi = rendementDemande
    if (refPoidsMax > 0 && refLaizeMax > 0 && refRendement > 0) {
      const rendementMiniNominal = (1 - refFreinte) / ((refPoidsMax * refLaizeMax) / 100000)
      rendementMini = (rendementDemande * rendementMiniNominal) / refRendement
    }
    if (refPoidsMin > 0 && refLaizeMin > 0 && refRendement > 0) {
      const rendementMaxiNominal = (1 - refFreinte) / ((refPoidsMin * refLaizeMin) / 100000)
      rendementMaxi = (rendementDemande * rendementMaxiNominal) / refRendement
    }
    const hasBounds = rendementMini > 0 || rendementMaxi > 0

    let rdtSum = 0
    let rdtCount = 0
    const pieces = pieceRows.map((p) => {
      const poids = n(p.poids)
      const metrage = n(p.metrage)
      const rdt = poids > 0 ? metrage / poids : null
      if (rdt != null) { rdtSum += rdt; rdtCount += 1 }
      const valid =
        rdt == null || !hasBounds ? null : rdt >= rendementMini && rdt <= rendementMaxi
      return {
        IDstock_fini: Number(p.IDstock_fini),
        numero: (p.numero ?? '').toString() || `#${Number(p.IDstock_fini)}`,
        poids,
        metrage,
        magasin_nom: magMap.get(Number(p.IDmagasin)) ?? '',
        rdt,
        valid,
        quality: qualityByFini.get(Number(p.IDstock_fini)) ?? [],
      }
    })
    const moyenne_rdt = rdtCount > 0 ? rdtSum / rdtCount : null

    // Freinte Sous-Traitant — legacy computed value (not a stored column).
    //   freinte = 1 - (poids_sst * laize_sst / 100000) * rendementMoyen
    // where rendementMoyen is the pieces' average rdt (COL_Rendement[ligneMoyenne]).
    // Returns a ratio (e.g. 0.8744 → 87.44 %); 0 when any input is missing.
    const poidsSstVal = n(raw.poids_sst)
    const laizeSstVal = n(raw.laize_sst)
    const moyRdtVal = moyenne_rdt ?? 0
    const freinte_sst =
      poidsSstVal !== 0 && laizeSstVal !== 0 && moyRdtVal !== 0
        ? 1 - ((poidsSstVal * laizeSstVal) / 100000) * moyRdtVal
        : 0

    // Client orders this lot serves (#1249). The header's IDcommande_client is
    // only set when the sst order was launched FROM a client line; an order
    // placed ahead (for stock, or before the client order existed) reaches the
    // client through its pieces — the lot's fini rolls, or before any reception
    // the écru pieces affected to the sst line. The header is the last resort.
    const lccIds = new Set<number>()
    for (const p of pieceRows) {
      const l = Number(p.IDligne_commande_client) || 0
      if (l > 0) lccIds.add(l)
    }
    if (lccIds.size === 0 && ligneId > 0) {
      const ecruRows = await query<{ IDligne_commande_client: number | null }>(
        `SELECT IDligne_commande_client FROM stock_ecru
         WHERE IDref_commande_affectation = ${ligneId} AND IDligne_commande_client > 0`,
      )
      for (const r of ecruRows) {
        const l = Number(r.IDligne_commande_client) || 0
        if (l > 0) lccIds.add(l)
      }
    }
    const ccIds = new Set<number>()
    if (lccIds.size > 0) {
      const lccRows = await query<{ IDligne_commande_client: number; IDcommande_client: number | null }>(
        `SELECT IDligne_commande_client, IDcommande_client FROM ligne_commande_client
         WHERE IDligne_commande_client IN (${Array.from(lccIds).join(',')})`,
      )
      for (const r of lccRows) {
        const cc = Number(r.IDcommande_client) || 0
        if (cc > 0) ccIds.add(cc)
      }
    }
    const headerCc = Number(fixedCmd?.IDcommande_client) || 0
    if (ccIds.size === 0 && headerCc > 0) ccIds.add(headerCc)

    const clients: Array<{
      IDcommande_client: number; IDclient: number; nom: string; numero: string | null; ref_client: string | null
    }> = []
    if (ccIds.size > 0) {
      const ccRaw = await query<{ IDcommande_client: number; IDclient: number | null; numero: string | number | null; ref_client: string | null }>(
        // NB: select IDcommande_client — fixEncoding keys its CONVERT repair on it.
        `SELECT IDcommande_client, IDclient, numero, ref_client FROM commande_client
         WHERE IDcommande_client IN (${Array.from(ccIds).join(',')})`,
      )
      const ccRows = ccRaw.length
        ? await fixEncoding(ccRaw, 'commande_client', 'IDcommande_client', ['numero', 'ref_client'])
        : []
      const clientIds = Array.from(new Set(ccRows.map((c) => Number(c.IDclient) || 0).filter((x) => x > 0)))
      const nomById = new Map<number, string>()
      if (clientIds.length > 0) {
        const clRaw = await query<{ IDclient: number; nom: string | null }>(
          `SELECT IDclient, nom FROM client WHERE IDclient IN (${clientIds.join(',')})`,
        )
        const clRows = clRaw.length ? await fixEncoding(clRaw, 'client', 'IDclient', ['nom']) : []
        for (const c of clRows) nomById.set(Number(c.IDclient), (c.nom ?? '').toString())
      }
      for (const cc of ccRows) {
        const IDclient = Number(cc.IDclient) || 0
        if (IDclient <= 0) continue
        clients.push({
          IDcommande_client: Number(cc.IDcommande_client),
          IDclient,
          nom: nomById.get(IDclient) ?? '',
          // commande_client.numero is an integer column on PostgreSQL: coerce, or the
          // localeCompare sort below throws on a lot with 2+ client orders (#1264).
          numero: cc.numero != null ? String(cc.numero) : null,
          ref_client: cc.ref_client ?? null,
        })
      }
      clients.sort((a, b) => (a.numero ?? '').localeCompare(b.numero ?? '', 'fr', { numeric: true }))
    }

    const etat = raw.IDetatLot != null ? Number(raw.IDetatLot) : null
    const etatLabels = await loadEtatLabels()
    // Simone Pérèle lot: its tableau de métrage is asked from here (LIVA #1303).
    const etiquettesSp = await finiCommandeParClientEtiquettes(
      IDref_fini, lotColoriId(avecTeinture, IDref_fini_colori, IDColoris),
    )

    res.json({
      IDsuivilot: id,
      lot,
      etiquettes_sp: etiquettesSp,
      DATE: raw.DATE ?? null,
      IDcommande_sous_traitant: cmdId,
      IDligne_commande_sous_traitant: ligneId,
      IDsous_traitant: sstId,

      // Récap context
      date_commande: fixedCmd?.date_commande ?? null,
      reference: (fixedRef?.reference ?? '').toString(),
      coloris,
      commentaire: stripRtf(fixedCmd?.commentaire ?? ''),

      // Spec banner (demande) — accented cols via pickKey
      laize_demandee: n(raw.laize_demandee),
      poids_demande: n(raw.poids_demande),
      rendement_demande: n(raw.rendement_demande),
      freinte_demandee: n(pickKey(raw, /^freinte/i)),
      stabH_demandee: n(pickKey(raw, /^stabh_dem/i)),
      stabL_demandee: n(pickKey(raw, /^stabl_dem/i)),

      // Contrôles — Sous-Traitant
      laize_sst: n(raw.laize_sst),
      poids_sst: n(raw.poids_sst),
      rendement_sst: n(raw.rendement_sst),
      freinte_sst, // computed (ratio); UI shows as percentage
      stabH_sst: n(raw.stabH_sst),
      stabL_sst: n(raw.stabL_sst),

      // Contrôles — Tirelle
      laize_tirelle: n(raw.laize_tirelle),
      poids_tirelle: n(raw.poids_tirelle),
      rendement_tirelle: n(raw.rendement_tirelle),
      stabH_tirelle: n(raw.stabH_tirelle),
      stabL_tirelle: n(raw.stabL_tirelle),

      observations: (fixedSelf?.observations ?? '').toString(),
      emplacement_tirelle: (fixedSelf?.emplacement_tirelle ?? '').toString(),
      fin_archivage: (raw.fin_archivage ?? '').toString(),

      IDetatLot: etat,
      etat_libelle: etat != null ? etatLabels.get(etat) ?? null : null,
      // The lot's reprises at the dyer, oldest first (lib/reprises.ts).
      reprises: ligneId > 0 && lot ? await reprisesDuLot(ligneId, String(lot)) : [],

      pieces,
      moyenne_rdt,
      rendement_mini: hasBounds ? rendementMini : null,
      rendement_maxi: hasBounds ? rendementMaxi : null,

      // ref_fini tolerance bounds → the client flags each contrôle (laize / poids
      // / stab, both Sous-Traitant and Tirelle) as conforme or not. Legacy rules:
      //   laize : laizeHT_Min ≤ val ≤ laizeHT_Max
      //   poids : poids_Min   ≤ val ≤ poids_Max
      //   stab  : val ≥ ref_fini.stab_hauteur / stab_largeur (max shrinkage)
      ...(await cycleDuDetail(id, cmdId, ligneId, lot)),

      ref_bounds: {
        laize_min: n(fixedRef?.laizeHT_Min),
        laize_max: n(fixedRef?.laizeHT_Max),
        poids_min: n(fixedRef?.poids_Min),
        poids_max: n(fixedRef?.poids_Max),
        stab_hauteur: n(fixedRef?.stab_hauteur),
        stab_largeur: n(fixedRef?.stab_largeur),
      },
      clients,
    })
  } catch (err) {
    console.error('Error loading suivi-lot detail:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** One soumission as the detail shows it. */
function soumissionDuDetail(s: SoumissionFait | undefined) {
  return {
    requise: !!s?.requise,
    envoyee_le: s?.envoyeeLe ?? null,
    // The answer to the CURRENT soumission (null while it waits).
    reponse: s?.reponse
      ? { accepte: s.reponse.accepte, commentaire: s.reponse.commentaire, par: s.reponse.par ?? '', le: s.reponse.le.slice(0, 16) }
      : null,
  }
}

/** The detail's cycle block: step, the controls the reference asks, what blocks the validation, both
 *  soumissions and the client's answers (LIVA #1313), the « coloris validé », the
 *  clients a RC can go to. */
async function cycleDuDetail(id: number, cmdId: number, ligneId: number, lot: string) {
  const [e, clients] = await Promise.all([
    etapesDesLots([{ id, cmd: cmdId }]).then((m) => m.get(id) ?? null),
    ligneId > 0 && lot.trim() ? clientsDesLots([{ ligne: ligneId, lot }]) : Promise.resolve(new Map<string, ClientDuLot[]>()),
  ])
  const f = e?.fait
  return {
    etape: e?.etape ?? null,
    prealables: e?.prealables ?? [],
    recu: !!f?.reception,
    soumissions: { coloris: soumissionDuDetail(f?.coloris), stabilites: soumissionDuDetail(f?.stabilites) },
    ok_ramer_le: f?.okRamerLe ?? null,
    // What the lot's reference asks (Finis › Références, lib/controles-lot.ts).
    controles: f?.controles ?? CONTROLES_PAR_DEFAUT,
    clients_rc: clients.get(cleLotLigne(ligneId, lot)) ?? [],
  }
}

// ── Évolution (trend série) ──────────────────────────────
//
// GET /suivi-lots/:id/serie
//
// Historical série of control measurements for the "Graphique" modal: every
// suivilot sharing the current lot's référence (IDref_fini) AND sous-traitant
// (IDsous_traitant), so the values stay directly comparable (same target spec,
// same supplier). One point per lot. Newest 200 (the UI windows to 50/100/200);
// returned oldest→newest so the chart reads left-to-right in time.
//
// SELECT * (single table) so accented spec columns survive the bridge — every
// metric is read by prefix-regex (pickNum), never named in SQL.
suiviLotsRouter.get('/:id/serie', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const baseRows = await query<Record<string, unknown>>(
      `SELECT * FROM suivilot WHERE IDsuivilot = ${id}`,
    )
    if (baseRows.length === 0) { res.status(404).json({ error: 'Lot not found' }); return }
    const IDref_fini = Number(baseRows[0].IDref_fini) || 0
    const currentSstId = Number(baseRows[0].IDsous_traitant) || 0

    // The référence label.
    const refRows = IDref_fini > 0
      ? await query<{ reference: string | null }>(`SELECT IDref_fini, reference FROM ref_fini WHERE IDref_fini = ${IDref_fini}`)
      : []
    const [fixedRef] = refRows.length
      ? await fixEncoding(refRows, 'ref_fini', 'IDref_fini', ['reference'])
      : [undefined as any]

    // Every sous-traitant that has worked on this référence (so the UI can let
    // the user switch between them), with names.
    const stNames = new Map<number, string>()
    let sstIds: number[] = []
    if (IDref_fini > 0) {
      const sstRefRows = await query<{ IDsous_traitant: number }>(
        `SELECT IDsous_traitant FROM suivilot WHERE IDref_fini = ${IDref_fini}`,
      )
      sstIds = Array.from(new Set(sstRefRows.map((r) => Number(r.IDsous_traitant) || 0).filter((x) => x > 0)))
      if (sstIds.length > 0) {
        const nameRows = await query<{ IDsous_traitant: number; nom: string | null }>(
          `SELECT IDsous_traitant, nom FROM sous_traitant WHERE IDsous_traitant IN (${sstIds.join(',')})`,
        )
        for (const r of await fixEncoding(nameRows, 'sous_traitant', 'IDsous_traitant', ['nom']))
          stNames.set(Number(r.IDsous_traitant), (r.nom ?? '').toString())
      }
    }
    const sousTraitants = sstIds
      .map((sid) => ({ id: sid, nom: stNames.get(sid) ?? `#${sid}` }))
      .sort((a, b) => a.nom.localeCompare(b.nom))

    // Which sous-traitant to plot: the ?sst query param when valid, else the
    // current lot's own. The modal opens on the lot's sst, then lets the user
    // pick any other that has worked on the same référence.
    const reqSst = parseInt((req.query.sst as string) ?? '', 10)
    const targetSst = !isNaN(reqSst) && reqSst > 0 ? reqSst : currentSstId

    // Scope: same référence + the chosen sous-traitant. If either is missing we
    // can't scope meaningfully — fall back to just this lot.
    const serieRows =
      IDref_fini > 0 && targetSst > 0
        ? await query<Record<string, unknown>>(
            `SELECT TOP 200 * FROM suivilot
             WHERE IDref_fini = ${IDref_fini} AND IDsous_traitant = ${targetSst}
             ORDER BY DATE DESC, IDsuivilot DESC`,
          )
        : baseRows

    // Numeric field by prefix regex (survives accent truncation + case).
    const pickNum = (row: Record<string, unknown>, re: RegExp): number => {
      const k = Object.keys(row).find((key) => re.test(key))
      return k !== undefined ? n(row[k]) : 0
    }

    // Per-lot points (laize / poids / stab — measured once per lot). Newest-first
    // from SQL → reverse to oldest→newest for the X axis.
    const points = serieRows
      .map((row) => ({
        IDsuivilot: Number(row.IDsuivilot) || 0,
        lot: (row.lot ?? '').toString(),
        date: ((pickKey(row, /^date$/i) as string | null) ?? null),

        laize_sst: pickNum(row, /^laize_sst$/i),
        poids_sst: pickNum(row, /^poids_sst$/i),
        stabH_sst: pickNum(row, /^stabh_sst$/i),
        stabL_sst: pickNum(row, /^stabl_sst$/i),

        laize_tirelle: pickNum(row, /^laize_tir/i),
        poids_tirelle: pickNum(row, /^poids_tir/i),
        stabH_tirelle: pickNum(row, /^stabh_tir/i),
        stabL_tirelle: pickNum(row, /^stabl_tir/i),

        laize_demandee: pickNum(row, /^laize_dem/i),
        poids_demande: pickNum(row, /^poids_dem/i),
        stabH_demandee: pickNum(row, /^stabh_dem/i),
        stabL_demandee: pickNum(row, /^stabl_dem/i),
      }))
      .reverse()

    // Per-roll rendement série: rendement is read per received roll (its actual
    // rdt = metrage/poids), not per lot. Gather every roll (stock_fini) of the
    // in-scope (ligne, lot) pairs, in lot-chronological order, with the lot's
    // target rendement for a reference line.
    const lotsMetaAsc = serieRows
      .map((row) => ({
        suiviId: Number(row.IDsuivilot) || 0,
        ligneId: Number(row.IDligne_commande_sous_traitant) || 0,
        lot: (row.lot ?? '').toString().trim(),
        date: ((pickKey(row, /^date$/i) as string | null) ?? null),
        rendement_demande: pickNum(row, /^rendement_dem/i),
      }))
      .reverse()

    const ligneIds = Array.from(new Set(lotsMetaAsc.map((l) => l.ligneId).filter((x) => x > 0)))
    const rollsByPair = new Map<string, Array<{ IDstock_fini: number; numero: string; poids: number; metrage: number }>>()
    if (ligneIds.length > 0) {
      const sfRows = await query<{
        IDstock_fini: number; IDref_commande_source: number; lot: string | null
        poids: number | null; metrage: number | null; numero: string | null
      }>(
        `SELECT IDstock_fini, IDref_commande_source, lot, poids, metrage, numero
         FROM stock_fini WHERE IDref_commande_source IN (${ligneIds.join(',')})`,
      )
      for (const r of sfRows) {
        const key = `${Number(r.IDref_commande_source) || 0}|${(r.lot ?? '').toString().trim()}`
        const arr = rollsByPair.get(key) ?? []
        arr.push({
          IDstock_fini: Number(r.IDstock_fini) || 0,
          numero: (r.numero ?? '').toString(),
          poids: n(r.poids),
          metrage: n(r.metrage),
        })
        rollsByPair.set(key, arr)
      }
    }

    const rolls: Array<{
      IDstock_fini: number; IDsuivilot: number; numero: string; lot: string
      date: string | null; rdt: number; rendement_demande: number
    }> = []
    for (const lm of lotsMetaAsc) {
      const arr = (rollsByPair.get(`${lm.ligneId}|${lm.lot}`) ?? [])
        .slice()
        .sort((a, b) => a.numero.localeCompare(b.numero) || a.IDstock_fini - b.IDstock_fini)
      for (const roll of arr) {
        rolls.push({
          IDstock_fini: roll.IDstock_fini,
          IDsuivilot: lm.suiviId,
          numero: roll.numero,
          lot: lm.lot,
          date: lm.date,
          rdt: roll.poids > 0 ? roll.metrage / roll.poids : 0,
          rendement_demande: lm.rendement_demande,
        })
      }
    }

    res.json({
      current_id: id,
      reference: (fixedRef?.reference ?? '').toString(),
      sous_traitant_id: targetSst,
      sous_traitant_nom: stNames.get(targetSst) ?? '',
      sous_traitants: sousTraitants,
      points,
      rolls: rolls.slice(-200),
    })
  } catch (err) {
    console.error('Error loading suivi-lot série:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Save Contrôles ───────────────────────────────────────
//
// PUT /suivi-lots/:id — every named column is ASCII → bridge-safe.
suiviLotsRouter.put('/:id', async (req: Request, res: Response) => {
  try {
    if (!(await ensureResponsable(req, res))) return
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const b = req.body ?? {}

    const exists = await query<{ IDsuivilot: number }>(
      `SELECT IDsuivilot FROM suivilot WHERE IDsuivilot = ${id}`,
    )
    if (exists.length === 0) { res.status(404).json({ error: 'Lot not found' }); return }

    await query(
      `UPDATE suivilot SET
         laize_sst = ${n(b.laize_sst)}, poids_sst = ${n(b.poids_sst)}, rendement_sst = ${n(b.rendement_sst)},
         stabH_sst = ${n(b.stabH_sst)}, stabL_sst = ${n(b.stabL_sst)},
         laize_tirelle = ${n(b.laize_tirelle)}, poids_tirelle = ${n(b.poids_tirelle)}, rendement_tirelle = ${n(b.rendement_tirelle)},
         stabH_tirelle = ${n(b.stabH_tirelle)}, stabL_tirelle = ${n(b.stabL_tirelle)},
         observations = ${sqlText(b.observations)}, emplacement_tirelle = ${sqlText(b.emplacement_tirelle)},
         fin_archivage = '${dateStr(b.fin_archivage)}'
       WHERE IDsuivilot = ${id}`,
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('Error saving suivi-lot:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Change lot état (immediate, no edit-mode) ────────────
//
// POST /suivi-lots/:id/etat { etat }
//
// The responsable qualité's only two manual verdicts: Valider (3) or Reprendre
// (2). Other états are system-driven (1 on reception, 5 on soumission, 1 again
// on rework re-reception) and rejected here. Gated by responsable_qualite.
suiviLotsRouter.post('/:id/etat', async (req: Request, res: Response) => {
  try {
    if (!(await ensureResponsable(req, res))) return
    const id = parseInt(req.params.id, 10)
    const etat = parseInt(req.body?.etat, 10)
    if (isNaN(id) || isNaN(etat)) { res.status(400).json({ error: 'Invalid input' }); return }
    // Only Valider (3) / Reprendre (2) are user-driven transitions.
    if (etat !== 2 && etat !== 3) {
      res.status(400).json({ error: 'Transition non autorisée : seules « Valider » (3) et « Reprendre » (2) sont permises.' })
      return
    }

    // Reprendre OPENS a reprise (lib/reprises.ts): its motif is required, the
    // lot's rolls still in stock go « En reprise » with it, the lot keeps the
    // dyer's number (never an « R »).
    if (etat === 2) {
      const motif = typeof req.body?.motif === 'string' ? req.body.motif.trim() : ''
      if (!motif) { res.status(400).json({ error: 'motif_requis', message: 'Indiquez le motif de la reprise.' }); return }
      const base = await query<{ IDligne_commande_sous_traitant: number | null; lot: string | null }>(
        `SELECT IDligne_commande_sous_traitant, lot FROM suivilot WHERE IDsuivilot = ${id}`,
      )
      const ligneId = Number(base[0]?.IDligne_commande_sous_traitant) || 0
      const lot = (base[0]?.lot ?? '').toString().trim()
      if (!(ligneId > 0) || !lot) { res.status(404).json({ error: 'Lot introuvable' }); return }
      try {
        // 'teinture' re-dyes the lot: its coloris is submitted again (LIVA #1313).
        const nature = req.body?.nature === 'teinture' ? 'teinture' : 'rame'
        await ouvrirReprise({ ligneId, lot, motif, nature, par: { id: req.userId ?? 0, nom: req.userId ? await nomUtilisateur(req.userId) : '' } })
      } catch (err) {
        if (err instanceof RepriseRefusee) { res.status(409).json({ error: err.code, message: err.message }); return }
        throw err
      }
      if (canNameAccented()) await query(`UPDATE suivilot SET approuvé_qualité = 0 WHERE IDsuivilot = ${id}`)
      res.json({ ok: true })
      return
    }

    // « Valider le lot » only once nothing is left to do (LIVA #1304): both
    // controls, the soumission and the client's yes, every rapport de contrôle owed.
    const cycle = await etapeDuLot(id)
    if (cycle && cycle.prealables.length > 0) {
      res.status(409).json({
        error: 'prealables',
        message: `Le lot ne peut pas encore être validé : ${cycle.prealables.join(' ')}`,
        prealables: cycle.prealables,
      })
      return
    }

    await query(`UPDATE suivilot SET IDetatLot = ${etat} WHERE IDsuivilot = ${id}`)
    // Validation flag lives in the accented `approuvé_qualité` column — skipped
    // only on the Linux HFSQL bridge, where IDetatLot was the source of truth.
    if (canNameAccented()) {
      await query(`UPDATE suivilot SET approuvé_qualité = ${etat === 3 ? 1 : 0} WHERE IDsuivilot = ${id}`)
    }

    // Cascade the verdict onto the lot's received rolls (stock_fini), keyed on
    // (IDref_commande_source = ligne, lot) like the détail/pièces query.
    // (Reprendre (2) returned above: ouvrirReprise() puts the rolls in état 2.)
    //   • Valider (3) → IDetat_stock_fini = 3 "Validé": the rolls leave "En
    //     contrôle" and become available finished stock. Without this the rolls
    //     stayed stuck at 1 after the lot was validated (reported bug).
    // Guard out only Expédié (4) rolls so a verdict never pulls an already-shipped
    // roll backwards; every other state (1/2/3/5) follows the lot verdict.
    // Best-effort: a failure here must not fail the verdict the user just recorded.
    if (etat === 3) {
      try {
        const base = await query<{ IDligne_commande_sous_traitant: number | null; lot: string | null }>(
          `SELECT IDligne_commande_sous_traitant, lot FROM suivilot WHERE IDsuivilot = ${id}`,
        )
        const ligneId = Number(base[0]?.IDligne_commande_sous_traitant) || 0
        const lot = (base[0]?.lot ?? '').toString().trim()
        if (ligneId > 0 && lot) {
          await query(
            `UPDATE stock_fini SET IDetat_stock_fini = ${etat}
             WHERE IDref_commande_source = ${ligneId} AND lot = '${esc(lot)}'
               AND (IDetat_stock_fini IS NULL OR IDetat_stock_fini <> 4)`,
          )
        }
      } catch (err) {
        console.error(`Roll état cascade failed for suivilot=${id} (etat=${etat}):`, err)
      }
    }

    res.json({ ok: true })
  } catch (err) {
    console.error('Error changing suivi-lot état:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Réponse du client à la soumission (LIVA #1304) ───────
//
// POST /suivi-lots/:id/reponse-client { accepte, commentaire }
//
// Recorded on the legacy reponse_soumission (+ who / when / why, 0029). An
// acceptance unblocks the validation; a refusal (why required) leaves
// « Reprendre » as the way on. The latest answer given after the latest
// soumission is the one that counts (lib/cycle-ennoblissement.ts).
const reponseBody = z.object({
  accepte: z.boolean(),
  commentaire: z.string().max(2000).optional(),
  /** Which soumission it answers (LIVA #1313); default: the one awaiting an answer. */
  nature: z.enum(['coloris', 'stabilites']).optional(),
})

suiviLotsRouter.post('/:id/reponse-client', async (req: Request, res: Response) => {
  try {
    if (!(await ensureResponsable(req, res))) return
    const id = parseInt(req.params.id, 10)
    const parsed = reponseBody.safeParse(req.body)
    if (isNaN(id) || !parsed.success) { res.status(400).json({ error: 'Invalid input' }); return }
    const commentaire = (parsed.data.commentaire ?? '').trim()
    if (!parsed.data.accepte && !commentaire) {
      res.status(400).json({ error: 'commentaire_requis', message: 'Indiquez pourquoi le client refuse le lot.' })
      return
    }
    const sql = mpsPg()
    const [s] = await sql<{ cmd: number; ligne: number; lot: string }[]>`
      SELECT COALESCE(idcommande_sous_traitant, 0) AS cmd, COALESCE(idligne_commande_sous_traitant, 0) AS ligne, trim(lot::text) AS lot
      FROM suivilot WHERE idsuivilot = ${id}`
    if (!s) { res.status(404).json({ error: 'Lot introuvable' }); return }
    const cycle = await etapeDuLot(id)
    const enAttente = (n: NatureSoumission) => !!cycle?.fait[n].envoyeeLe && !cycle.fait[n].reponse
    const nature: NatureSoumission = parsed.data.nature ?? (enAttente('coloris') ? 'coloris' : 'stabilites')
    if (!cycle?.fait[nature].envoyeeLe) {
      res.status(409).json({
        error: 'pas_de_soumission',
        message: `Aucune soumission ${nature === 'coloris' ? 'coloris' : 'des stabilités'} n’a été envoyée pour ce lot.`,
      })
      return
    }
    if (cycle.etape === 'valide') {
      res.status(409).json({ error: 'lot_valide', message: 'Le lot est déjà validé.' })
      return
    }
    const clients = await clientsDesLots([{ ligne: Number(s.ligne), lot: s.lot }])
    // A lot not received yet has no roll to name its client (a coloris answer
    // before the stenter, LIVA #1313): the soumission's client order does.
    const idclient = (clients.get(cleLotLigne(Number(s.ligne), s.lot)) ?? [])[0]?.idclient ?? (await (async () => {
      const [r] = await sql<{ idclient: number }[]>`
        SELECT cc.idclient FROM soumission_lot sl
        JOIN commande_client cc ON cc.idcommande_client = sl.idcommande_client
        WHERE sl.idsuivilot = ${id} AND sl.nature = ${nature}
        ORDER BY sl.envoyee_le DESC LIMIT 1`
      return Number(r?.idclient) || 0
    })())
    const par = req.userId ? await nomUtilisateur(req.userId) : ''
    await sql`
      INSERT INTO reponse_soumission (date, reponse, idcommande_sous_traitant, idclient, lot, commentaire, saisi_le, saisi_par_id, saisi_par, idsuivilot, nature)
      VALUES (CURRENT_DATE, ${parsed.data.accepte ? 1 : 0}, ${Number(s.cmd)}, ${idclient}, ${s.lot}, ${commentaire || null},
              now(), ${req.userId ?? 0}, ${par}, ${id}, ${nature})`
    res.json({ ok: true })
  } catch (err) {
    console.error('Error recording soumission answer:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── « Coloris validé » mail to the dyer (LIVA #1313) ──────────────────────────
//
// The client accepted the coloris of a lot still at the dyer: we tell the
// dyer to put it on the stenter. Until 2026-10-22 Pierre-Emmanuel forwarded
// the client's answer with « Lot à ramer stp » (contact@, 2025 → 2026); the
// mail is journaled in ok_a_ramer_envoi — the cycle reads it (« En rame »).
//   GET  /suivi-lots/:id/ok-ramer/email-defaults
//   POST /suivi-lots/:id/ok-ramer/email

interface LotOkRamer {
  id: number
  cmd: number
  lot: string
  idsousTraitant: number
  sousTraitant: string
  reference: string
  coloris: string
  commentaireClient: string
}

/** The lot, when its « coloris validé » may leave (coloris accepted, not received). */
async function lotOkRamer(req: Request, res: Response): Promise<LotOkRamer | null> {
  const id = parseInt(req.params.id, 10)
  if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return null }
  const [s] = await mpsPg()<{ cmd: number; lot: string; sst: number; sst_nom: string | null; reference: string | null; coloris: string | null }[]>`
    SELECT COALESCE(s.idcommande_sous_traitant, 0) AS cmd, trim(s.lot::text) AS lot, COALESCE(s.idsous_traitant, 0) AS sst,
           st.nom::text AS sst_nom, rf.reference::text AS reference,
           CASE WHEN COALESCE(rf.avec_teinture, 1) = 0 THEN ce.reference::text ELSE COALESCE(rfc.reference::text, ce.reference::text) END AS coloris
    FROM suivilot s
    LEFT JOIN sous_traitant st ON st.idsous_traitant = s.idsous_traitant
    LEFT JOIN ref_fini rf ON rf.idref_fini = s.idref_fini
    LEFT JOIN ref_fini_colori rfc ON rfc.idref_fini_colori = s.idcoloris
    LEFT JOIN colori_ecru ce ON ce.idcolori_ecru = s.idcoloris
    WHERE s.idsuivilot = ${id}`
  if (!s) { res.status(404).json({ error: 'Lot introuvable' }); return null }
  const cycle = await etapeDuLot(id)
  if (!cycle || (cycle.etape !== 'ok_ramer_a_envoyer' && cycle.etape !== 'en_rame')) {
    res.status(409).json({
      error: 'pas_ok_ramer',
      message: 'La validation du coloris part quand le client a accepté le coloris d’un lot pas encore réceptionné.',
    })
    return null
  }
  return {
    id, cmd: Number(s.cmd), lot: s.lot, idsousTraitant: Number(s.sst), sousTraitant: (s.sst_nom ?? '').trim(),
    reference: (s.reference ?? '').trim(), coloris: (s.coloris ?? '').trim(),
    commentaireClient: cycle.fait.coloris.reponse?.commentaire ?? '',
  }
}

suiviLotsRouter.get('/:id/ok-ramer/email-defaults', async (req: Request, res: Response) => {
  try {
    const l = await lotOkRamer(req, res)
    if (!l) return
    // The dyer's contacts: those who receive the soumissions pre-selected.
    const contacts = l.idsousTraitant > 0
      ? await mpsPg()<{ id: number; nom: string | null; prenom: string | null; mail: string | null; soumission: number; visible: number }[]>`
          SELECT idcontact AS id, nom::text AS nom, prenom::text AS prenom, mail::text AS mail,
                 COALESCE(envoi_soumission, 0)::int AS soumission, COALESCE(est_visible, 1)::int AS visible
          FROM contact WHERE idsous_traitant = ${l.idsousTraitant}`
      : []
    type Destinataire = { email: string; name?: string; source: 'contact'; contactId: number }
    const selected: Destinataire[] = []
    const suggestions: Destinataire[] = []
    const vus = new Set<string>()
    for (const c of contacts) {
      const mail = (c.mail ?? '').trim()
      if (Number(c.visible) === 0 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) || vus.has(mail.toLowerCase())) continue
      vus.add(mail.toLowerCase())
      const name = [c.prenom, c.nom].map((x) => (x ?? '').trim()).filter(Boolean).join(' ')
      const r: Destinataire = { email: mail, source: 'contact', contactId: Number(c.id), ...(name ? { name } : {}) }
      if (Number(c.soumission) === 1) selected.push(r)
      else suggestions.push(r)
    }
    const article = [l.reference, l.coloris].filter(Boolean).join(' · ')
    res.json({
      recipients: { selected, suggestions },
      subject: `Coloris validé - Lot ${l.lot}${l.cmd ? ` - commande ${l.cmd}` : ''}`,
      body:
        `Bonjour,\n\n` +
        `Le client a accepté le coloris du lot ${l.lot}${article ? ` (${article}` : ''}${l.cmd ? `${article ? ', ' : ' ('}notre commande ${l.cmd})` : article ? ')' : ''} : vous pouvez le ramer.\n\n` +
        (l.commentaireClient ? `Remarque du client : « ${l.commentaireClient} »\n\n` : '') +
        `Cordialement,`,
      sousTraitantNom: l.sousTraitant,
      numero: l.lot,
    })
  } catch (err) {
    console.error('Error building ok à ramer email defaults:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const okRamerBody = z.object({
  to: z.array(z.string().email()).min(1, 'At least one recipient is required'),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(20000),
  extra_attachments: z.array(z.object({
    filename: z.string().min(1).max(255),
    content_base64: z.string().min(1),
    content_type: z.string().min(1).max(100),
  })).optional(),
  dev_skip_send: z.boolean().optional(),
})

suiviLotsRouter.post('/:id/ok-ramer/email', async (req: Request, res: Response) => {
  try {
    if (!(await ensureResponsable(req, res))) return
    const parsed = okRamerBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const l = await lotOkRamer(req, res)
    if (!l) return
    const nom = await nomUtilisateur(req.userId!)
    const devSkip = parsed.data.dev_skip_send === true && process.env.NODE_ENV !== 'production'
    let messageId: string
    if (devSkip) {
      messageId = `dev-skip-${Date.now()}`
      console.log(`[dev-skip-send] ok à ramer lot=${l.lot} — fake send to ${parsed.data.to.join(', ')}`)
    } else {
      const from = await getUserEmail(req.userId!)
      if (!from) {
        res.status(400).json({
          error: 'no_sender_email',
          message: "Aucune adresse email n'est associée à votre compte. Un administrateur doit en définir une dans Paramètres › Utilisateurs.",
        })
        return
      }
      const attachments = (parsed.data.extra_attachments ?? []).map((a) => ({
        filename: a.filename, content: Buffer.from(a.content_base64, 'base64'), contentType: a.content_type,
      }))
      messageId = await sendMail({
        from,
        fromName: `${nom} — ETS Malterre`,
        to: parsed.data.to,
        cc: parsed.data.cc,
        bcc: parsed.data.bcc,
        subject: parsed.data.subject,
        body: parsed.data.body,
        attachments: attachments.length > 0 ? attachments : undefined,
      })
    }
    await enregistrerOkRamer({
      idsuivilot: l.id, idcommande: l.cmd, lot: l.lot,
      par: { id: req.userId ?? 0, nom }, destinataires: [...parsed.data.to, ...(parsed.data.cc ?? [])],
    })
    res.json({ ok: true, messageId })
  } catch (err) {
    console.error('Error sending ok à ramer:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    res.status(500).json({ error: 'send_failed', message })
  }
})

// ── Rapport de contrôle (LIVA #1304) ─────────────────────
//
// Per lot and per client, only the client's pieces (lib/rapport-controle-lot.ts).
//   GET  /suivi-lots/:id/rapport-controle/pdf?client=
//   GET  /suivi-lots/:id/rapport-controle/email-defaults?client=
//   POST /suivi-lots/:id/rapport-controle/email { client, to, … }

async function renderRcBuffer(rc: RapportControleLot): Promise<Buffer> {
  return renderToBuffer(
    React.createElement(RapportControlePdf, { data: rc.data }) as unknown as React.ReactElement<
      import('@react-pdf/renderer').DocumentProps
    >,
  )
}

const rcFilename = (rc: RapportControleLot) => `rapport-controle-${rc.lot.replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`

async function rcDepuisRequete(req: Request, res: Response, client: unknown): Promise<RapportControleLot | null> {
  const id = parseInt(req.params.id, 10)
  const idclient = parseInt(String(client ?? ''), 10)
  if (isNaN(id) || isNaN(idclient) || idclient <= 0) { res.status(400).json({ error: 'Invalid input' }); return null }
  const rc = await rapportControleLot(id, idclient)
  if (!rc) { res.status(404).json({ error: 'aucune_piece', message: 'Ce client n’a aucune pièce de ce lot.' }); return null }
  return rc
}

suiviLotsRouter.get('/:id/rapport-controle/pdf', async (req: Request, res: Response) => {
  try {
    const rc = await rcDepuisRequete(req, res, req.query.client)
    if (!rc) return
    const buffer = await renderRcBuffer(rc)
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `inline; filename="${rcFilename(rc)}"`)
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buffer)
  } catch (err) {
    console.error('Error rendering rapport de contrôle:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

suiviLotsRouter.get('/:id/rapport-controle/email-defaults', async (req: Request, res: Response) => {
  try {
    const rc = await rcDepuisRequete(req, res, req.query.client)
    if (!rc) return
    // The people who received it on the BL until now: the client's BL contacts.
    const contacts = await mpsPg()<{ id: number; nom: string | null; prenom: string | null; mail: string | null; bl: number; visible: number }[]>`
      SELECT idcontact AS id, nom::text AS nom, prenom::text AS prenom, mail::text AS mail,
             COALESCE(envoi_bl, 0)::int AS bl, COALESCE(est_visible, 1)::int AS visible
      FROM contact WHERE idclient = ${rc.idclient}`
    type Destinataire = { email: string; name?: string; source: 'contact'; contactId: number }
    const selected: Destinataire[] = []
    const suggestions: Destinataire[] = []
    const vus = new Set<string>()
    for (const c of contacts) {
      const mail = (c.mail ?? '').trim()
      if (Number(c.visible) === 0 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) || vus.has(mail.toLowerCase())) continue
      vus.add(mail.toLowerCase())
      const name = [c.prenom, c.nom].map((x) => (x ?? '').trim()).filter(Boolean).join(' ')
      const r: Destinataire = { email: mail, source: 'contact', contactId: Number(c.id), ...(name ? { name } : {}) }
      if (Number(c.bl) === 1) selected.push(r)
      else suggestions.push(r)
    }
    const titre = rc.data.articles[0]?.titre ?? rc.reference
    const n = rc.pieces.length
    res.json({
      recipients: { selected, suggestions },
      subject: `Rapport de contrôle - Lot ${rc.lot} - ${titre}${rc.refClient ? ` · ${rc.refClient}` : ''}`,
      body:
        `Bonjour,\n\n` +
        `Veuillez trouver ci-joint le rapport de contrôle du lot ${rc.lot} (${titre}), ` +
        `pour ${n > 1 ? `vos ${n} pièces` : 'votre pièce'} de ce lot.\n\n` +
        (rc.refClient ? `Réf commande client : ${rc.refClient}\n\n` : '') +
        `Cordialement,`,
      sousTraitantNom: rc.clientNom,
      numero: rc.lot,
    })
  } catch (err) {
    console.error('Error building rapport de contrôle email defaults:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const rcEmailBody = z.object({
  client: z.number().int().positive(),
  to: z.array(z.string().email()).min(1, 'At least one recipient is required'),
  cc: z.array(z.string().email()).optional(),
  bcc: z.array(z.string().email()).optional(),
  subject: z.string().min(1).max(500),
  body: z.string().min(1).max(20000),
  attach_pdf: z.boolean().optional(),
  extra_attachments: z.array(z.object({
    filename: z.string().min(1).max(255),
    content_base64: z.string().min(1),
    content_type: z.string().min(1).max(100),
  })).optional(),
  dev_skip_send: z.boolean().optional(),
})

suiviLotsRouter.post('/:id/rapport-controle/email', async (req: Request, res: Response) => {
  try {
    if (!(await ensureResponsable(req, res))) return
    const parsed = rcEmailBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return }
    const rc = await rcDepuisRequete(req, res, parsed.data.client)
    if (!rc) return
    const nom = await nomUtilisateur(req.userId!)

    const devSkip = parsed.data.dev_skip_send === true && process.env.NODE_ENV !== 'production'
    let messageId: string
    if (devSkip) {
      messageId = `dev-skip-${Date.now()}`
      console.log(`[dev-skip-send] rapport de contrôle lot=${rc.lot} client=${rc.idclient} — fake send to ${parsed.data.to.join(', ')}`)
    } else {
      const from = await getUserEmail(req.userId!)
      if (!from) {
        res.status(400).json({
          error: 'no_sender_email',
          message: "Aucune adresse email n'est associée à votre compte. Un administrateur doit en définir une dans Paramètres › Utilisateurs.",
        })
        return
      }
      const attachments: Array<{ filename: string; content: Buffer; contentType: string }> = []
      if (parsed.data.attach_pdf !== false) {
        attachments.push({ filename: rcFilename(rc), content: await renderRcBuffer(rc), contentType: 'application/pdf' })
      }
      for (const a of parsed.data.extra_attachments ?? []) {
        attachments.push({ filename: a.filename, content: Buffer.from(a.content_base64, 'base64'), contentType: a.content_type })
      }
      messageId = await sendMail({
        from,
        fromName: `${nom} — ETS Malterre`,
        to: parsed.data.to,
        cc: parsed.data.cc,
        bcc: parsed.data.bcc,
        subject: parsed.data.subject,
        body: parsed.data.body,
        attachments: attachments.length > 0 ? attachments : undefined,
      })
    }
    // The send is what the cycle reads: journal it once the mail left.
    await journaliserEnvoiRc(rc, { id: req.userId ?? 0, nom }, [...parsed.data.to, ...(parsed.data.cc ?? [])])
    res.json({ ok: true, messageId })
  } catch (err) {
    console.error('Error sending rapport de contrôle:', err)
    const message = err instanceof Error ? err.message : 'Internal server error'
    res.status(500).json({ error: 'send_failed', message })
  }
})

// ── Actions qualité (conformité per mention, for this lot's sst line) ─────
//
// A suivilot hangs off exactly one ligne_commande_sous_traitant, and the Qualité
// › Actions screen attaches "mentions" (automatic comments) to sst lines by
// (type, référence, sous-traitant, coloris). This is where the responsable
// qualité records whether the lot actually honoured each of those instructions.
// The matching rule + every accented-column workaround live in
// lib/actions-qualite.ts.
//
// GET /suivi-lots/:id/actions
suiviLotsRouter.get('/:id/actions', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const baseRows = await query<{
      IDligne_commande_sous_traitant: number | null
      IDcommande_sous_traitant: number | null
      IDsous_traitant: number | null
    }>(
      `SELECT IDligne_commande_sous_traitant, IDcommande_sous_traitant, IDsous_traitant
       FROM suivilot WHERE IDsuivilot = ${id}`,
    )
    if (baseRows.length === 0) { res.status(404).json({ error: 'Lot not found' }); return }
    const ligneId = Number(baseRows[0].IDligne_commande_sous_traitant) || 0
    if (ligneId === 0) { res.json([]); return }

    // The line's own matching key. `type` is a reserved word → always aliased.
    const lineRows = await query<{ type_kind: number; refid: number; colid: number }>(
      `SELECT type AS type_kind, IDreference AS refid, IDColoris AS colid
       FROM ligne_commande_sous_traitant
       WHERE IDligne_commande_sous_traitant = ${ligneId}`,
    )
    if (lineRows.length === 0) { res.json([]); return }
    const line = {
      IDligne_commande_sous_traitant: ligneId,
      IDcommande_sous_traitant: Number(baseRows[0].IDcommande_sous_traitant) || 0,
      type_kind: Number(lineRows[0].type_kind) || 0,
      IDreference: Number(lineRows[0].refid) || 0,
      IDColoris: Number(lineRows[0].colid) || 0,
      IDsous_traitant: Number(baseRows[0].IDsous_traitant) || 0,
    }

    const [allMentions, actions, verdicts] = await Promise.all([
      loadAllMentions(),
      loadActions(),
      loadConformites({ ligneIds: [ligneId] }),
    ])
    const actionById = new Map(actions.map((a) => [a.IDaction_qualite, a]))
    const verdictByMention = new Map(verdicts.map((v) => [v.IDmention_qualite, v.conformite]))

    // Mentions of OPEN actions that match this line, plus any mention this lot
    // already carries a verdict for. The second half matters: closing an action
    // must not make the verdicts already recorded against it vanish from the lot
    // that was judged under it.
    const openMatches = mentionsForLine(
      line,
      allMentions.filter((m) => actionById.get(m.IDaction_qualite)?.termine === 0),
    )
    const seen = new Set(openMatches.map((m) => m.IDmention_qualite))
    const historic = allMentions.filter(
      (m) => !seen.has(m.IDmention_qualite) && verdictByMention.has(m.IDmention_qualite),
    )

    res.json(
      [...openMatches, ...historic].map((m) => {
        const action = actionById.get(m.IDaction_qualite)
        return {
          IDmention_qualite: m.IDmention_qualite,
          IDaction_qualite: m.IDaction_qualite,
          action_titre: action?.titre ?? '',
          action_description: action?.description ?? '',
          action_termine: action?.termine ?? 0,
          mention: m.mention,
          conformite: verdictByMention.get(m.IDmention_qualite) ?? 'non_controle',
          /** false ⇒ shown only because a verdict already exists (action closed
           *  or the line no longer matches); the UI greys it out. */
          applicable: seen.has(m.IDmention_qualite),
        }
      }),
    )
  } catch (err) {
    console.error('Error loading suivi-lot actions:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /suivi-lots/:id/actions/:mentionId { conformite }
//
// Immediate write, no edit-mode round trip — the verdict is a standalone
// judgement, not part of the Contrôles form (same reasoning as the lot état).
suiviLotsRouter.put('/:id/actions/:mentionId', async (req: Request, res: Response) => {
  try {
    if (!(await ensureResponsable(req, res))) return
    const id = parseInt(req.params.id, 10)
    const mentionId = parseInt(req.params.mentionId, 10)
    if (isNaN(id) || isNaN(mentionId)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const code = String(req.body?.conformite ?? '')
    if (!CONFORMITE_VALUES.includes(code as Conformite)) {
      res.status(400).json({ error: `conformite must be one of ${CONFORMITE_VALUES.join(', ')}` })
      return
    }

    const baseRows = await query<{ IDligne_commande_sous_traitant: number | null }>(
      `SELECT IDligne_commande_sous_traitant FROM suivilot WHERE IDsuivilot = ${id}`,
    )
    if (baseRows.length === 0) { res.status(404).json({ error: 'Lot not found' }); return }
    const ligneId = Number(baseRows[0].IDligne_commande_sous_traitant) || 0
    if (ligneId === 0) {
      res.status(400).json({ error: 'Ce lot n\'est rattaché à aucune ligne de commande sous-traitant.' })
      return
    }

    // Scope guard: refuse to invent a verdict against a mention that doesn't exist.
    const mentions = await loadAllMentions()
    if (!mentions.some((m) => m.IDmention_qualite === mentionId)) {
      res.status(404).json({ error: 'Mention not found' }); return
    }

    await setConformite(ligneId, mentionId, code as Conformite)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error saving suivi-lot conformité:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Défauts (read-only aggregate over the lot's source écrus) ─────
//
// GET /suivi-lots/:id/defauts
suiviLotsRouter.get('/:id/defauts', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }

    const baseRows = await query<{ IDligne_commande_sous_traitant: number | null; lot: string | null }>(
      `SELECT IDligne_commande_sous_traitant, lot FROM suivilot WHERE IDsuivilot = ${id}`,
    )
    if (baseRows.length === 0) { res.status(404).json({ error: 'Lot not found' }); return }
    const ligneId = Number(baseRows[0].IDligne_commande_sous_traitant) || 0
    const lot = (baseRows[0].lot ?? '').toString()
    if (ligneId === 0) { res.json([]); return }

    // The lot's rolls → their source écru ids (defaut_qualite.Type_Reference=2
    // keys reference = stringified IDstock_ecru).
    const rolls = await query<{ IDstock_fini: number; numero: string | null; IDstock_ecru: number | null }>(
      `SELECT IDstock_fini, numero, IDstock_ecru
       FROM stock_fini
       WHERE IDref_commande_source = ${ligneId} AND lot = '${esc(lot)}'`,
    )
    const ecruIds = Array.from(new Set(rolls.map((r) => Number(r.IDstock_ecru)).filter((e) => e > 0)))
    if (ecruIds.length === 0) { res.json([]); return }
    const numByEcru = new Map<number, string>()
    for (const r of rolls) {
      const e = Number(r.IDstock_ecru)
      if (e > 0 && !numByEcru.has(e)) numByEcru.set(e, (r.numero ?? '').toString())
    }

    const inList = ecruIds.map((e) => `'${e}'`).join(',')
    // SELECT * + pickKey: defaut_qualite has accented cols (traité, récuperé).
    const defRows = await queryRaw(
      `SELECT * FROM defaut_qualite WHERE Type_Reference = 2 AND reference IN (${inList})`,
    )
    const fixed = await fixEncoding(
      defRows as Record<string, unknown>[],
      'defaut_qualite',
      'IDdefaut_qualite',
      ['description', 'type_defaut'],
    )
    res.json(
      fixed.map((d) => {
        const ecru = Number((d as any).reference) || 0
        return {
          IDdefaut_qualite: Number((d as any).IDdefaut_qualite),
          reference: (d as any).reference ?? null,
          roll_numero: numByEcru.get(ecru) ?? '',
          description: ((d as any).description ?? '').toString(),
          type_defaut: ((d as any).type_defaut ?? '').toString(),
          taille_cm: n((d as any).taille_cm),
          nombre: n((d as any).nombre),
          date: ((d as any).DATE ?? '').toString(),
        }
      }),
    )
  } catch (err) {
    console.error('Error loading suivi-lot defauts:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
