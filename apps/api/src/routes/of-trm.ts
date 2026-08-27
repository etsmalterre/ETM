// Gestion des OF — TRM production orders (legacy FEN_Gestion_des_OF.wdw).
//
// The ordre_fabrication family (ordre_fabrication, piece_production,
// asso_fil_of, fil_incorpore, message_of, evenement_piece, evenement_machine)
// has NO IDsociete column — knitting production is inherently TRM, like the
// planning-atelier tables. Scope guard: an OF is only addressable when its
// IDligne_commande_client chain lands on a commande_client with IDsociete = 2
// (or when it has no line at all, which does not happen on live data).
//
// This file is the FIRST write path to these tables. Write rules:
//  - ordre_fabrication / asso_fil_of / fil_incorpore: every written column is
//    ASCII → plain named INSERT/UPDATE + newIdAfterInsert. The four accented
//    `productivité*` columns are never named, never written (HFSQL zero-fills
//    them on insert; live data shows them dead at 0 everywhere).
//  - message_of has the reserved-word `date` column → positional INSERT with a
//    self-assigned MAX+1 PK (same shape as desiderata in planning-atelier.ts).
//    Physical order: IDmessage_of, observation, IDordre_fabrication,
//    IDbonnetier, date.
//  - Reserved `date` on evenement_piece / evenement_machine / message_of /
//    defaut_qualite is written uppercase `DATE` everywhere it appears — SELECT
//    (aliased), WHERE ranges and ORDER BY.
//  - Réalisé = Σ stock_ecru.poids per OF, NEVER filtered on IDsociete: the
//    ETM handover flips delivered pieces from 2 to 1 (see expeditions-trm.ts).
//  - `machine` / `bonnetier` / `defaut_qualite` carry accented columns →
//    SELECT * + key folding, queryB64Text on the Linux bridge (the
//    selectBonnetiers pattern from planning-atelier.ts).
//  - The ordre_fabrication alias is `orf` everywhere; `of` sits too close to
//    SQL keyword territory for the HFSQL parser.
//
// Queue model (recovered from live data):
//  - En cours  = est_actif = 1 AND est_termine = 0 (at most one per métier)
//  - Attente   = est_actif = 0 AND est_termine = 0, ordered by priorite
//  - Terminé   = est_termine = 1 (priorite reset to 0)
//  - Terminer: est_termine←1, est_actif←0, priorite←0, arret_prod←now, then the
//    machine's queue is re-ranked and, if the new head has auto_activation = 1,
//    it becomes est_actif = 1. The legacy auto-activation trigger lives in the
//    unreadable workshop terminal code — this route now owns that flip for
//    web-driven completions; both write the same columns, so no conflict.
//
// Deliberate approximations (the legacy windows are PCS-compressed):
//  - Per-piece % = théorique/réel with théorique_min =
//    (ref_ecru_machine.trs_10kg_chute / nb_chutes) × (poids_piece / 10) ÷
//    vitesse (fallback chain orf.vitesse → machine.vitesse →
//    ref_ecru.vitesse_cible). Flagged `approx: true` in the payload.
//  - Faux arrêts: stops shorter than FAUX_ARRETS_MIN_S are ignored — the
//    legacy REQ_FauxArrets threshold is unrecoverable.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { query, queryRaw, fixEncoding } from '../lib/hfsql-auto.js'
import { trmUserHasPermission } from '../lib/permissions-trm.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { n } from '../lib/sst-shared.js'
import { newIdAfterInsert, maxId } from './expeditions.js'
import { fetchDefectsByEcru, type DefautQualite } from './stock-ecru.js'
// Shared TRM production plumbing — see lib/production-trm.ts. These were
// module-locals here until Visitage needed the same ones; they were extracted
// rather than duplicated (the clients-common.ts precedent). Improve them THERE.
import {
  TRM_SOCIETE, sqlText, round2, todayHfsql, nowDt, parseDtMs,
  selectMachines, bonnetierDirectory, selectDefauts, resolveEcruRefs, resolveColorisEcru,
  selectStockFilByIds, resolveLigneContexts, loadOf, realiseByOf, OF_COLUMNS,
  type DefautRow, type StockFilLot, type OfRow,
} from '../lib/production-trm.js'

export const ofTrmRouter: RouterType = Router()

/** Stops shorter than this are treated as "faux arrêts" and not counted —
 *  approximation of the legacy REQ_FauxArrets filter (threshold unrecoverable). */
const FAUX_ARRETS_MIN_S = 120

// ── Label resolvers (flat batched lookups — no JOIN + CONVERT) ──

async function resolveMachineNames(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const list = Array.from(new Set(ids.filter((x) => x > 0)))
  if (list.length === 0) return out
  const rows = await query<{ IDmachine: number; nom: string | null }>(
    `SELECT IDmachine, nom FROM machine WHERE IDmachine IN (${list.join(',')})`,
  )
  for (const r of await fixEncoding(rows, 'machine', 'IDmachine', ['nom'])) {
    out.set(Number(r.IDmachine), (r.nom ?? '').toString().trim())
  }
  return out
}

async function resolveRefFilNames(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const list = Array.from(new Set(ids.filter((x) => x > 0)))
  if (list.length === 0) return out
  const rows = await query<{ IDref_fil: number; reference: string | null }>(
    `SELECT IDref_fil, reference FROM ref_fil WHERE IDref_fil IN (${list.join(',')})`,
  )
  for (const r of await fixEncoding(rows, 'ref_fil', 'IDref_fil', ['reference'])) {
    out.set(Number(r.IDref_fil), (r.reference ?? '').toString().trim())
  }
  return out
}

async function resolveColoriFilNames(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  const list = Array.from(new Set(ids.filter((x) => x > 0)))
  if (list.length === 0) return out
  const rows = await query<{ IDcolori_fil: number; reference: string | null }>(
    `SELECT IDcolori_fil, reference FROM colori_fil WHERE IDcolori_fil IN (${list.join(',')})`,
  )
  for (const r of await fixEncoding(rows, 'colori_fil', 'IDcolori_fil', ['reference'])) {
    out.set(Number(r.IDcolori_fil), (r.reference ?? '').toString().trim())
  }
  return out
}

async function selectStockFilByPair(refFil: number, coloriFil: number): Promise<StockFilLot[]> {
  const rows = await query<any>(
    `SELECT IDstock_fil, IDref_fil, IDcolori_fil, lot, stock, emplacement
     FROM stock_fil WHERE IDref_fil = ${refFil} AND IDcolori_fil = ${coloriFil} AND stock > 0
     ORDER BY lot`,
  )
  const fixed = await fixEncoding(rows, 'stock_fil', 'IDstock_fil', ['lot', 'emplacement'])
  return fixed.map((r: any) => ({
    id: Number(r.IDstock_fil),
    lot: (r.lot ?? '').toString().trim(),
    IDref_fil: Number(r.IDref_fil) || 0,
    IDcolori_fil: Number(r.IDcolori_fil) || 0,
    stock: round2(Number(r.stock) || 0),
    emplacement: (r.emplacement ?? '').toString().trim(),
  }))
}

/** Does the OF have any production attached (pieces knitted or rolls dropped)?
 *  Gates quantite edits and deletion. */
async function hasProduction(ofId: number): Promise<boolean> {
  const p = await query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM piece_production WHERE IDordre_fabrication = ${ofId}`,
  )
  if ((Number(p[0]?.c) || 0) > 0) return true
  const s = await query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM stock_ecru WHERE IDordre_fabrication = ${ofId}`,
  )
  return (Number(s[0]?.c) || 0) > 0
}

// ── Queue management ─────────────────────────────────────

interface QueueEntry { id: number; priorite: number; est_actif: number; auto_activation: number }

/** Re-rank a métier's open queue to a dense 1..n (active OF first). Returns the
 *  ranked queue. Priorite semantics recovered from live data: 1 = the running
 *  OF, 2 = next, …; 0 once terminé. */
async function rerankQueue(machineId: number): Promise<QueueEntry[]> {
  if (machineId <= 0) return []
  const rows = await query<any>(
    `SELECT IDordre_fabrication, priorite, est_actif, auto_activation
     FROM ordre_fabrication WHERE IDmachine = ${machineId} AND est_termine = 0
     ORDER BY est_actif DESC, priorite ASC, IDordre_fabrication ASC`,
  )
  const out: QueueEntry[] = []
  let p = 1
  for (const r of rows) {
    const id = Number(r.IDordre_fabrication)
    if (Number(r.priorite) !== p) {
      await query(`UPDATE ordre_fabrication SET priorite = ${p} WHERE IDordre_fabrication = ${id}`)
    }
    out.push({ id, priorite: p, est_actif: Number(r.est_actif) || 0, auto_activation: Number(r.auto_activation) || 0 })
    p++
  }
  return out
}

async function activeOfOnMachine(machineId: number, excludeId = 0): Promise<number> {
  const rows = await query<{ IDordre_fabrication: number }>(
    `SELECT IDordre_fabrication FROM ordre_fabrication
     WHERE IDmachine = ${machineId} AND est_actif = 1 AND est_termine = 0
       AND IDordre_fabrication <> ${excludeId}`,
  )
  return Number(rows[0]?.IDordre_fabrication) || 0
}

// ════════════════════════════════════════════════════════
//  LOOKUPS  (literal paths — must register before /:id)
// ════════════════════════════════════════════════════════

// GET /api/of-trm/lookups/machines — métier picker (?all=1 includes archived).
ofTrmRouter.get('/lookups/machines', async (req: Request, res: Response) => {
  try {
    const all = req.query.all === '1'
    const machines = (await selectMachines())
      .filter((m) => all || m.archive === 0)
      .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'))
    res.json(machines)
  } catch (err) {
    console.error('Error fetching of-trm machines:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/of-trm/lookups/lignes-commande — open TRM order lines for the
// création dialog, with how much existing OFs already cover.
ofTrmRouter.get('/lookups/lignes-commande', async (req: Request, res: Response) => {
  try {
    // `?ligne=<id>` returns just that line, whatever its commande's état. It is
    // how the Commandes screen's "Créer un OF" seeds the dialog: there the line
    // is imposed, not picked, and it may well sit on a commande the open-orders
    // list below deliberately excludes.
    const oneId = parseInt(String(req.query.ligne ?? ''), 10)
    const single = !isNaN(oneId) && oneId > 0

    const cmds = await query<any>(
      single
        ? `SELECT IDcommande_client, numero, IDclient FROM commande_client
           WHERE IDsociete = ${TRM_SOCIETE}
             AND IDcommande_client = (SELECT IDcommande_client FROM ligne_commande_client
                                      WHERE IDligne_commande_client = ${oneId})`
        : `SELECT IDcommande_client, numero, IDclient FROM commande_client
           WHERE IDsociete = ${TRM_SOCIETE} AND est_soldee = 0`,
    )
    const cmdIds = cmds.map((c: any) => Number(c.IDcommande_client) || 0).filter(Boolean)
    if (cmdIds.length === 0) { res.json([]); return }
    const lines = await query<any>(
      `SELECT IDligne_commande_client, IDcommande_client, quantite, IDreference, IDcolori
       FROM ligne_commande_client
       WHERE ${single ? `IDligne_commande_client = ${oneId}` : `IDcommande_client IN (${cmdIds.join(',')})`}`,
    )
    const lineIds = lines.map((l: any) => Number(l.IDligne_commande_client) || 0).filter(Boolean)

    // Existing OF coverage per line (open + finished both count as "planned").
    const couvertByLine = new Map<number, number>()
    if (lineIds.length > 0) {
      for (let i = 0; i < lineIds.length; i += 300) {
        const chunk = lineIds.slice(i, i + 300)
        const ofs = await query<{ IDligne_commande_client: number; quantite: number | null }>(
          `SELECT IDligne_commande_client, quantite FROM ordre_fabrication
           WHERE IDligne_commande_client IN (${chunk.join(',')})`,
        )
        for (const o of ofs) {
          const k = Number(o.IDligne_commande_client)
          couvertByLine.set(k, (couvertByLine.get(k) ?? 0) + (Number(o.quantite) || 0))
        }
      }
    }

    const clientIds = Array.from(new Set(cmds.map((c: any) => Number(c.IDclient) || 0).filter(Boolean)))
    const clientNames = new Map<number, string>()
    if (clientIds.length > 0) {
      const rows = await query<{ IDclient: number; nom: string | null }>(
        `SELECT IDclient, nom FROM client WHERE IDclient IN (${clientIds.join(',')})`,
      )
      for (const r of await fixEncoding(rows, 'client', 'IDclient', ['nom'])) {
        clientNames.set(Number(r.IDclient), (r.nom ?? '').toString().trim())
      }
    }
    const cmdById = new Map<number, { numero: number; client: string }>()
    for (const c of cmds) {
      cmdById.set(Number(c.IDcommande_client), {
        numero: Number(c.numero) || 0,
        client: clientNames.get(Number(c.IDclient) || 0) ?? '',
      })
    }

    const refMap = await resolveEcruRefs(lines.map((l: any) => Number(l.IDreference) || 0))
    const coloriMap = await resolveColorisEcru(lines.map((l: any) => Number(l.IDcolori) || 0))

    const out = lines.map((l: any) => {
      const id = Number(l.IDligne_commande_client)
      const cmd = cmdById.get(Number(l.IDcommande_client) || 0)
      const quantite = round2(Number(l.quantite) || 0)
      const couvert = round2(couvertByLine.get(id) ?? 0)
      const ref = refMap.get(Number(l.IDreference) || 0)
      return {
        id,
        IDcommande_client: Number(l.IDcommande_client) || 0,
        commande_numero: cmd?.numero ?? 0,
        client_nom: cmd?.client ?? '',
        IDreference: Number(l.IDreference) || 0,
        IDcolori: Number(l.IDcolori) || 0,
        ref_label: ref?.reference ?? '',
        contexture: ref?.contexture ?? '',
        poids_piece_defaut: ref?.poids_piece ?? 0,
        coloris_label: coloriMap.get(Number(l.IDcolori) || 0) ?? '',
        quantite,
        couvert,
        restant: round2(Math.max(0, quantite - couvert)),
      }
    })
    // Uncovered lines first, then by commande numero desc (recent work on top).
    out.sort((a: any, b: any) => (b.restant > 0 ? 1 : 0) - (a.restant > 0 ? 1 : 0) || b.commande_numero - a.commande_numero)
    res.json(out)
  } catch (err) {
    console.error('Error fetching of-trm lignes-commande:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/of-trm/lookups/composition?ligne=<id> — the création dialog's seed:
// composition_ecru defaults for the line's (ref, coloris), each component with
// its on-hand lots and the biggest-stock lot pre-selected.
//
// ⚠️ One row per composition_ecru ROW, never per (fil, coloris) PAIR. A blend
// legitimately feeds the same yarn twice — ref 119/ecru is 71 % + 14,5 % +
// 14,5 % of the SAME 280/48/1 PES HT, and only all three add up to the 100 %
// the legacy window checks. Collapsing the pair (what this endpoint did until
// 2026-08-26) declared 85,5 % of the yarn on every OF created for such a ref,
// which then under-counts the stock movement at piece declaration and the
// freinte at archivage (both are `poids × pourcentage/100`). 70 of the base's
// 2 859 composition groups are doubled like this, and the OFs the legacy
// itself writes carry the duplicate asso_fil_of row (verified 4/4 on ref 189).
ofTrmRouter.get('/lookups/composition', async (req: Request, res: Response) => {
  try {
    const ligneId = parseInt(String(req.query.ligne ?? ''), 10)
    if (isNaN(ligneId) || ligneId <= 0) { res.status(400).json({ error: 'Invalid ligne' }); return }
    const ctx = (await resolveLigneContexts([ligneId])).get(ligneId)
    if (!ctx) { res.status(404).json({ error: 'Ligne not found' }); return }
    if (ctx.IDreference <= 0) { res.json({ components: [], compatibles: [], total_pourcentage: 0 }); return }

    // Composition rows — coloris-scoped first, falling back to every variant
    // of the écru (composition data is sparse on older refs). No DISTINCT: it
    // would fold the duplicate feeding positions back together.
    const rowQuery = (coloriIn: string) => query<{
      IDcomposition_ecru: number; IDref_fil: number; IDcolori_fil: number; pourcentage: number | null
    }>(
      `SELECT IDcomposition_ecru, IDref_fil, IDcolori_fil, pourcentage FROM composition_ecru
       WHERE IDref_ecru = ${ctx.IDreference}${coloriIn} AND IDref_fil > 0
       ORDER BY IDcomposition_ecru`,
    )
    let rows = ctx.IDcolori > 0 ? await rowQuery(` AND IDcolori_ecru = ${ctx.IDcolori}`) : await rowQuery('')
    if (rows.length === 0) rows = await rowQuery('')

    const components: any[] = []
    for (const p of rows) {
      const rf = Number(p.IDref_fil) || 0
      const cf = Number(p.IDcolori_fil) || 0
      const pct = Number(p.pourcentage) || 0
      if (rf <= 0 || pct <= 0) continue
      // `key` is the composition row id — stable, and distinct between two
      // rows carrying the same pair (which the dialog keys its lot picks by).
      components.push({ key: Number(p.IDcomposition_ecru), IDref_fil: rf, IDcolori_fil: cf, pourcentage: pct })
    }

    const refFilNames = await resolveRefFilNames(components.map((c) => c.IDref_fil))
    const coloriFilNames = await resolveColoriFilNames(components.map((c) => c.IDcolori_fil))
    // Lots are a property of the pair, so two rows sharing one pair share the
    // query (and offer the same lot list).
    const lotsByPair = new Map<string, Array<{ id: number; lot: string; stock: number }>>()
    for (const c of components) {
      const pairKey = `${c.IDref_fil}:${c.IDcolori_fil}`
      let lots = lotsByPair.get(pairKey)
      if (!lots) {
        lots = await selectStockFilByPair(c.IDref_fil, c.IDcolori_fil)
        lots.sort((a, b) => b.stock - a.stock)
        lotsByPair.set(pairKey, lots)
      }
      c.ref_label = refFilNames.get(c.IDref_fil) ?? `#${c.IDref_fil}`
      c.coloris_label = coloriFilNames.get(c.IDcolori_fil) ?? ''
      c.lots = lots
      c.defaultLot = lots[0]?.id ?? 0
    }

    // "Compatible sur" — every machine the écru has a machine sheet for.
    let compatibles: Array<{ id: number; nom: string }> = []
    const rem = await query<{ IDmachine: number }>(
      `SELECT IDmachine FROM ref_ecru_machine WHERE IDref_ecru = ${ctx.IDreference}`,
    )
    const machIds = Array.from(new Set(rem.map((r) => Number(r.IDmachine) || 0).filter(Boolean)))
    if (machIds.length > 0) {
      const names = await resolveMachineNames(machIds)
      compatibles = machIds.map((id) => ({ id, nom: names.get(id) ?? '' })).filter((m) => m.nom)
    }

    // Knitting defaults carried by the écru sheet. The création dialog ticks
    // its boxes with these, so what the user sees is what POST would have
    // written implicitly (same three columns the POST handler falls back to).
    let defaults = { poids_piece: 0, ouvert_visiteuse: 0, maille_ouverture: 0, sonneter: 0 }
    const refRow = await query<any>(
      `SELECT poids, ouvert_visiteuse, maille_ouverture, sonneter FROM ref_ecru
       WHERE IDref_ecru = ${ctx.IDreference}`,
    )
    if (refRow.length > 0) {
      defaults = {
        poids_piece: round2(Number(refRow[0].poids) || 0),
        ouvert_visiteuse: Number(refRow[0].ouvert_visiteuse) || 0,
        maille_ouverture: Number(refRow[0].maille_ouverture) || 0,
        sonneter: Number(refRow[0].sonneter) || 0,
      }
    }

    // The legacy window prints "Total des pourcentages" and expects 100 %.
    const total = components.reduce((s: number, c: any) => s + (Number(c.pourcentage) || 0), 0)
    res.json({ components, compatibles, defaults, total_pourcentage: round2(total) })
  } catch (err) {
    console.error('Error fetching of-trm composition lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/of-trm/lookups/observations?ligne=<id>&machine=<id>
//
// "Observations Régleur" — the standing notes carried by the ÉCRU REFERENCE
// (`obs_ref_ecru`), not by the OF. They are written in Tombé Métier ›
// Références (legacy tab "Obs OF") and scoped per machine and per coloris,
// which is why they matter exactly here: at lancement the régleur must see the
// history of this reference on this métier ("Attention risque de trous",
// "Faire impérativement des pièces de 21 kgs minimum") and pass it on.
//
// The predicate is the legacy window's, recovered verbatim from the WinDev
// compile cache (`FEN_Gestion_d_un_OF` / `FI_Gestion_OF`):
//
//   where obs_ref_ecru.IDref_ecru = :ref
//     and (obs_ref_ecru.IDmachine = :machine or obs_ref_ecru.IDmachine = 0)
//     and (obs_ref_ecru.IDcolori_ecru = :colori or obs_ref_ecru.IDcolori_ecru = 0)
//   order by obs_ref_ecru.date desc
//
// 0 is the wildcard on both axes ("Toutes" / "Tout coloris"), so `machine = 0`
// — no métier picked yet — legitimately narrows to the notes that apply to
// every machine. The legacy JOINs for its labels; we resolve them flat (the
// Linux bridge mangles accents across joins).
ofTrmRouter.get('/lookups/observations', async (req: Request, res: Response) => {
  try {
    const ligneId = parseInt(String(req.query.ligne ?? ''), 10)
    if (isNaN(ligneId) || ligneId <= 0) { res.status(400).json({ error: 'Invalid ligne' }); return }
    const machineId = Math.max(0, parseInt(String(req.query.machine ?? '0'), 10) || 0)
    const ctx = (await resolveLigneContexts([ligneId])).get(ligneId)
    if (!ctx) { res.status(404).json({ error: 'Ligne not found' }); return }
    if (ctx.IDreference <= 0) { res.json([]); return }
    res.json(await selectObsRefEcru(ctx.IDreference, machineId, ctx.IDcolori))
  } catch (err) {
    console.error('Error fetching of-trm observations lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** The legacy predicate above, run for one (ref, machine, coloris) triplet.
 *  Shared by the création dialog's lookup and by the OF fiche's own tab —
 *  `FI_Gestion_OF` and `FEN_Lancement_OF` ask the exact same question. */
async function selectObsRefEcru(refId: number, machineId: number, coloriId: number) {
  // `date` is reserved → alias it, like message_of does.
  const raw = await query<any>(
    `SELECT IDobs_ref_ecru, IDcolori_ecru, IDmachine, DATE AS date_obs, observation
     FROM obs_ref_ecru
     WHERE IDref_ecru = ${refId}
       AND (IDmachine = ${machineId} OR IDmachine = 0)
       AND (IDcolori_ecru = ${coloriId} OR IDcolori_ecru = 0)
     ORDER BY DATE DESC`,
  )
  const rows = await fixEncoding(raw, 'obs_ref_ecru', 'IDobs_ref_ecru', ['observation'])
  const machineNames = await resolveMachineNames(rows.map((r: any) => Number(r.IDmachine) || 0))
  const coloriNames = await resolveColorisEcru(rows.map((r: any) => Number(r.IDcolori_ecru) || 0))

  return rows.map((r: any) => {
    const m = Number(r.IDmachine) || 0
    const c = Number(r.IDcolori_ecru) || 0
    return {
      id: Number(r.IDobs_ref_ecru),
      date: r.date_obs ?? null,
      observation: (r.observation ?? '').toString().trim(),
      IDmachine: m,
      IDcolori_ecru: c,
      // Scope, as the legacy prints it: the wildcard reads "Toutes" /
      // "Tout coloris", anything else names the machine or the coloris.
      machine: m === 0 ? 'Toutes' : (machineNames.get(m) || `#${m}`),
      coloris: c === 0 ? 'Tout coloris' : (coloriNames.get(c) || `#${c}`),
      cible_machine: m > 0,
      cible_coloris: c > 0,
    }
  }).filter((o: any) => o.observation.length > 0)
}

// GET /api/of-trm/lookups/coloris-ecru?ref=<IDref_ecru> — the Coloris picker of
// the observation dialog. Scoped to the reference, like the legacy combo
// (`FEN_Editer_Observation_4$Requ`, parameterised on ParamIDref_ecru): an
// observation targets a coloris OF THIS REFERENCE or none at all.
ofTrmRouter.get('/lookups/coloris-ecru', async (req: Request, res: Response) => {
  try {
    const refId = parseInt(String(req.query.ref ?? ''), 10)
    if (isNaN(refId) || refId <= 0) { res.status(400).json({ error: 'Invalid ref' }); return }
    const rows = await query<{ IDcolori_ecru: number; reference: string | null }>(
      `SELECT IDcolori_ecru, reference FROM colori_ecru WHERE IDref_ecru = ${refId}`,
    )
    const fixed = await fixEncoding(rows, 'colori_ecru', 'IDcolori_ecru', ['reference'])
    res.json(
      fixed
        .map((r) => ({ id: Number(r.IDcolori_ecru) || 0, reference: (r.reference ?? '').toString().trim() }))
        .filter((c) => c.id > 0)
        .sort((a, b) => a.reference.localeCompare(b.reference, 'fr')),
    )
  } catch (err) {
    console.error('Error fetching of-trm coloris lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/of-trm/lookups/fils — distinct (fil, coloris) pairs present in the
// open yarn stock, with on-hand totals. The Tricoter/Incorporer editors pick
// from what is physically knittable rather than the whole catalog (TRM knits
// à façon: the client supplies the fil, so the stock IS the working catalog).
ofTrmRouter.get('/lookups/fils', async (_req: Request, res: Response) => {
  try {
    const rows = await query<{ IDref_fil: number; IDcolori_fil: number; stock: number | null }>(
      `SELECT IDref_fil, IDcolori_fil, stock FROM stock_fil WHERE stock > 0`,
    )
    const byPair = new Map<string, { IDref_fil: number; IDcolori_fil: number; stock: number; lots: number }>()
    for (const r of rows) {
      const rf = Number(r.IDref_fil) || 0
      const cf = Number(r.IDcolori_fil) || 0
      if (rf <= 0) continue
      const k = `${rf}:${cf}`
      const acc = byPair.get(k) ?? { IDref_fil: rf, IDcolori_fil: cf, stock: 0, lots: 0 }
      acc.stock += Number(r.stock) || 0
      acc.lots += 1
      byPair.set(k, acc)
    }
    const pairs = Array.from(byPair.values())
    const refNames = await resolveRefFilNames(pairs.map((p) => p.IDref_fil))
    const coloriNames = await resolveColoriFilNames(pairs.map((p) => p.IDcolori_fil))
    res.json(pairs
      .map((p) => ({
        key: `${p.IDref_fil}:${p.IDcolori_fil}`,
        IDref_fil: p.IDref_fil,
        IDcolori_fil: p.IDcolori_fil,
        ref_label: refNames.get(p.IDref_fil) ?? `#${p.IDref_fil}`,
        coloris_label: coloriNames.get(p.IDcolori_fil) ?? '',
        stock: round2(p.stock),
        lots: p.lots,
      }))
      .sort((a, b) => a.ref_label.localeCompare(b.ref_label, 'fr') || a.coloris_label.localeCompare(b.coloris_label, 'fr')))
  } catch (err) {
    console.error('Error fetching of-trm fils lookup:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/of-trm/lookups/lots?refFil=&coloriFil= — lot picker for one
// composition component (Tricoter / Incorporer editors).
ofTrmRouter.get('/lookups/lots', async (req: Request, res: Response) => {
  try {
    const refFil = parseInt(String(req.query.refFil ?? ''), 10)
    const coloriFil = parseInt(String(req.query.coloriFil ?? '0'), 10)
    if (isNaN(refFil) || refFil <= 0) { res.status(400).json({ error: 'Invalid refFil' }); return }
    const lots = await selectStockFilByPair(refFil, isNaN(coloriFil) ? 0 : coloriFil)
    res.json(lots)
  } catch (err) {
    console.error('Error fetching of-trm lots:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/of-trm/bonnetiers/:id/photo — bonnetier portrait blob for the event
// timelines. Same blob rules as the etudes-coloris photo proxy: empty BinMemo
// passes IS NOT NULL, so 404 on an empty buffer and let the Avatar fall back
// to initials.
ofTrmRouter.get('/bonnetiers/:id/photo', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10)
    if (isNaN(id) || id <= 0) { res.status(400).json({ error: 'Invalid ID' }); return }

    const rows = await queryRaw(`SELECT photo FROM bonnetier WHERE IDbonnetier = ${id}`)
    if (rows.length === 0) { res.status(404).json({ error: 'Not found' }); return }
    const raw = (rows[0] as any).photo
    if (raw == null) { res.status(404).json({ error: 'No photo' }); return }
    let buf: Buffer
    if (raw instanceof ArrayBuffer) buf = Buffer.from(raw)
    else if (Buffer.isBuffer(raw)) buf = raw
    else { res.status(404).json({ error: 'No photo' }); return }
    if (buf.length === 0 || (buf.length === 1 && buf[0] === 0)) {
      res.status(404).json({ error: 'No photo' }); return
    }

    let contentType = 'application/octet-stream'
    if (buf.length >= 4) {
      const h = buf.subarray(0, 4)
      if (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47) contentType = 'image/png'
      else if (h[0] === 0xff && h[1] === 0xd8) contentType = 'image/jpeg'
    }
    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Disposition', 'inline')
    res.setHeader('Cache-Control', 'private, max-age=3600')
    res.removeHeader('X-Frame-Options')
    res.removeHeader('Content-Security-Policy')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    res.send(buf)
  } catch (err) {
    console.error('Error fetching bonnetier photo:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  LIST + DETAIL
// ════════════════════════════════════════════════════════

// GET /api/of-trm?statut=encours|attente|termine&q=
ofTrmRouter.get('/', async (req: Request, res: Response) => {
  try {
    const statut = typeof req.query.statut === 'string' ? req.query.statut : 'encours'
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''

    let where: string
    let order: string
    let top = ''
    if (statut === 'termine') {
      where = 'est_termine = 1'
      order = 'IDordre_fabrication DESC'
      top = 'TOP 200 '
      // Terminés are searched by OF number only (label search would need
      // resolving 3k+ rows first) — deliberate limitation.
      if (/^\d+$/.test(q)) where += ` AND IDordre_fabrication = ${parseInt(q, 10)}`
    } else if (statut === 'attente') {
      where = 'est_actif = 0 AND est_termine = 0'
      order = 'IDmachine ASC, priorite ASC, IDordre_fabrication ASC'
    } else {
      where = 'est_actif = 1 AND est_termine = 0'
      order = 'IDmachine ASC'
    }

    const raw = await query<OfRow>(
      `SELECT ${top}${OF_COLUMNS} FROM ordre_fabrication WHERE ${where} ORDER BY ${order}`,
    )
    const ofs = await fixEncoding(raw, 'ordre_fabrication', 'IDordre_fabrication', ['observations'])
    const ofIds = ofs.map((o: any) => Number(o.IDordre_fabrication)).filter((x: number) => x > 0)

    const [machineNames, refMap, coloriMap, ligneCtx] = await Promise.all([
      resolveMachineNames(ofs.map((o: any) => Number(o.IDmachine) || 0)),
      resolveEcruRefs(ofs.map((o: any) => Number(o.IDref_ecru) || 0)),
      resolveColorisEcru(ofs.map((o: any) => Number(o.IDcolori_ecru) || 0)),
      resolveLigneContexts(ofs.map((o: any) => Number(o.IDligne_commande_client) || 0)),
    ])
    // Réalisé only for the two live buckets — a grouped sum over 200 finished
    // OFs would pull tens of thousands of stock rows for a progress bar the
    // list doesn't show on terminés.
    const realise = statut === 'termine' ? new Map<number, number>() : await realiseByOf(ofIds)

    const rows = ofs
      .map((o: any) => {
        const id = Number(o.IDordre_fabrication)
        const ligne = ligneCtx.get(Number(o.IDligne_commande_client) || 0) ?? null
        const quantite = round2(Number(o.quantite) || 0)
        const done = statut === 'termine' ? null : (realise.get(id) ?? 0)
        const ref = refMap.get(Number(o.IDref_ecru) || 0)
        return {
          id,
          IDmachine: Number(o.IDmachine) || 0,
          machine: machineNames.get(Number(o.IDmachine) || 0) ?? '',
          ref_label: ref?.reference ?? '',
          contexture: ref?.contexture ?? '',
          coloris_label: coloriMap.get(Number(o.IDcolori_ecru) || 0) ?? '',
          client_nom: ligne?.client_nom ?? '',
          commande_numero: ligne?.commande_numero ?? 0,
          quantite,
          realise: done,
          progression_pct: done !== null && quantite > 0 ? Math.round((done / quantite) * 1000) / 10 : null,
          priorite: Number(o.priorite) || 0,
          prioritaire: Number(o.prioritaire) || 0,
          auto_activation: Number(o.auto_activation) || 0,
          sonneter: Number(o.sonneter) || 0,
          est_actif: Number(o.est_actif) || 0,
          est_termine: Number(o.est_termine) || 0,
          date_creation: o.date_creation ?? null,
        }
      })
      // Scope guard: drop OFs whose commande chain isn't société 2 (none on
      // live data, but the id space is shared).
      .filter((r: any) => r.commande_numero > 0 || Number(ofs.find((o: any) => Number(o.IDordre_fabrication) === r.id)?.IDligne_commande_client || 0) === 0)

    // En cours reads best sorted by machine label (2E, 3B, …), which needs the
    // resolved names — sort here rather than in SQL.
    if (statut !== 'termine') {
      rows.sort((a: any, b: any) =>
        a.machine.localeCompare(b.machine, 'fr') || a.priorite - b.priorite || a.id - b.id)
    }
    res.json(rows)
  } catch (err) {
    console.error('Error fetching of-trm list:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/of-trm/:id — the full OF form payload.
ofTrmRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const loaded = await loadOf(id)
    if (!loaded) { res.status(404).json({ error: 'Not found' }); return }
    const { of, ligne } = loaded

    const machineId = Number(of.IDmachine) || 0
    const refId = Number(of.IDref_ecru) || 0
    const coloriId = Number(of.IDcolori_ecru) || 0

    const machines = await selectMachines()
    const machine = machines.find((m) => m.id === machineId) ?? null
    const refMap = await resolveEcruRefs([refId])
    const coloriMap = await resolveColorisEcru([coloriId])

    // Tricoter — the OF's yarn components with their chosen lot.
    const assoRaw = await query<any>(
      `SELECT IDasso_fil_of, IDref_fil, IDcolori_fil, IDstock_fil, pourcentage
       FROM asso_fil_of WHERE IDordre_fabrication = ${id} ORDER BY IDasso_fil_of`,
    )
    const lotMap = await selectStockFilByIds(assoRaw.map((a: any) => Number(a.IDstock_fil) || 0))
    const refFilNames = await resolveRefFilNames(assoRaw.map((a: any) => Number(a.IDref_fil) || 0))
    const coloriFilNames = await resolveColoriFilNames(assoRaw.map((a: any) => Number(a.IDcolori_fil) || 0))

    // Per-pair on-hand stock (all lots of the pair, not just the chosen one) —
    // feeds both the Stock column and the Réalisable potential.
    const pairStock = new Map<string, number>()
    for (const a of assoRaw) {
      const k = `${Number(a.IDref_fil) || 0}:${Number(a.IDcolori_fil) || 0}`
      if (pairStock.has(k)) continue
      const lots = await selectStockFilByPair(Number(a.IDref_fil) || 0, Number(a.IDcolori_fil) || 0)
      pairStock.set(k, round2(lots.reduce((s, l) => s + l.stock, 0)))
    }

    // « Hors réf » — the yarns this run knits that the reference's own
    // composition_ecru does not list. A deliberate variation: the régleur burns
    // internal stock on a run he knows the customer will not notice. The OF
    // freezes its asso_fil_of and never re-reads composition_ecru, so the fact
    // survives — but nothing SHOWED it, and the point of recording a variation
    // is being able to see it later (user decision, 2026-08-26). 271 OFs of
    // 3 175 carry one; on pre-2022 OFs a hit is often just composition drift
    // (the reference's sheet changed since), which is why this is a neutral
    // marker and not a warning.
    const refCompo = refId > 0
      ? await query<any>(
          `SELECT IDref_fil, IDcolori_fil FROM composition_ecru WHERE IDref_ecru = ${refId}`,
        )
      : []
    const refPairs = new Set(
      refCompo.map((c: any) => `${Number(c.IDref_fil) || 0}:${Number(c.IDcolori_fil) || 0}`),
    )

    const composition = assoRaw.map((a: any) => {
      const lot = lotMap.get(Number(a.IDstock_fil) || 0)
      const rf = Number(a.IDref_fil) || 0
      const cf = Number(a.IDcolori_fil) || 0
      return {
        id: Number(a.IDasso_fil_of),
        IDref_fil: rf,
        IDcolori_fil: cf,
        IDstock_fil: Number(a.IDstock_fil) || 0,
        ref_label: refFilNames.get(rf) ?? `#${rf}`,
        coloris_label: coloriFilNames.get(cf) ?? '',
        pourcentage: Number(a.pourcentage) || 0,
        lot: lot?.lot ?? '',
        lot_stock: lot?.stock ?? 0,
        pair_stock: pairStock.get(`${rf}:${cf}`) ?? 0,
        // false, never null, when the reference declares no composition at all:
        // "everything is off-sheet" would be noise, not information.
        hors_ref: refPairs.size > 0 && !refPairs.has(`${rf}:${cf}`),
      }
    })

    // Réalisable — yarn-limited potential over the OF's own composition: for
    // each pair, on-hand kg ÷ its share of the blend, then the minimum (a
    // blend only knits while every component lasts). Same algorithm as the
    // commandes-trm stock-fil footer.
    let potentiel = Infinity
    for (const c of composition) {
      if (c.pourcentage <= 0) continue
      potentiel = Math.min(potentiel, (pairStock.get(`${c.IDref_fil}:${c.IDcolori_fil}`) ?? 0) / (c.pourcentage / 100))
    }
    if (!isFinite(potentiel)) potentiel = 0

    // Incorporer — one-off extra lots fed alongside the recipe.
    const incRaw = await query<any>(
      `SELECT IDfil_incorpore, IDstock_fil, poids FROM fil_incorpore
       WHERE IDordre_fabrication = ${id} ORDER BY IDfil_incorpore`,
    )
    const incLots = await selectStockFilByIds(incRaw.map((i: any) => Number(i.IDstock_fil) || 0))
    const incRefNames = await resolveRefFilNames(Array.from(incLots.values()).map((l) => l.IDref_fil))
    const incColoriNames = await resolveColoriFilNames(Array.from(incLots.values()).map((l) => l.IDcolori_fil))
    const incorpore = incRaw.map((i: any) => {
      const lot = incLots.get(Number(i.IDstock_fil) || 0)
      return {
        id: Number(i.IDfil_incorpore),
        IDstock_fil: Number(i.IDstock_fil) || 0,
        lot: lot?.lot ?? '',
        ref_label: lot ? (incRefNames.get(lot.IDref_fil) ?? '') : '',
        coloris_label: lot ? (incColoriNames.get(lot.IDcolori_fil) ?? '') : '',
        poids: round2(Number(i.poids) || 0),
      }
    })

    // "Compatible sur" — machines the écru has a machine sheet for.
    let compatibles: string[] = []
    if (refId > 0) {
      const rem = await query<{ IDmachine: number }>(
        `SELECT IDmachine FROM ref_ecru_machine WHERE IDref_ecru = ${refId}`,
      )
      const ids = Array.from(new Set(rem.map((r) => Number(r.IDmachine) || 0).filter(Boolean)))
      compatibles = ids
        .map((mid) => machines.find((m) => m.id === mid)?.nom ?? '')
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, 'fr'))
    }

    const realise = (await realiseByOf([id])).get(id) ?? 0
    const produced = await hasProduction(id)

    res.json({
      id,
      quantite: round2(Number(of.quantite) || 0),
      poids_piece: round2(Number(of.poids_piece) || 0),
      nb_pieces: Number(of.nb_pieces) || 0,
      visitage: Number(of.visitage) || 0,
      nettoyage: Number(of.Nettoyage) || 1,
      finir_fil: Number(of.finir_fil) || 0,
      ouvert_visiteuse: Number(of.ouvert_visiteuse) || 0,
      maille_ouverture: Number(of.maille_ouverture) || 0,
      sonneter: Number(of.sonneter) || 0,
      auto_activation: Number(of.auto_activation) || 0,
      prioritaire: Number(of.prioritaire) || 0,
      priorite: Number(of.priorite) || 0,
      est_actif: Number(of.est_actif) || 0,
      est_termine: Number(of.est_termine) || 0,
      vitesse: Number(of.vitesse) || 0,
      observations: (of.observations ?? '') || '',
      raison_modif: (of.raison_modif ?? '') || '',
      date_creation: of.date_creation ?? null,
      demarrage_prod: of.demarrage_prod ?? null,
      arret_prod: of.arret_prod ?? null,
      IDmachine: machineId,
      machine: machine ? { id: machine.id, nom: machine.nom, jauge: machine.jauge, diametre: machine.diametre } : null,
      IDref_ecru: refId,
      IDcolori_ecru: coloriId,
      ref_label: refMap.get(refId)?.reference ?? '',
      ref_designation: refMap.get(refId)?.designation ?? '',
      contexture: refMap.get(refId)?.contexture ?? '',
      coloris_label: coloriMap.get(coloriId) ?? '',
      composition,
      incorpore,
      compatibles,
      commande: ligne
        ? {
            IDcommande_client: ligne.commandeId,
            IDligne_commande_client: ligne.ligneId,
            numero: ligne.commande_numero,
            client_nom: ligne.client_nom,
            quantite: ligne.ligne_quantite,
          }
        : null,
      realise: round2(realise),
      realisable: round2(potentiel),
      has_production: produced,
    })
  } catch (err) {
    console.error('Error fetching of-trm detail:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  SIDEBAR TABS
// ════════════════════════════════════════════════════════

// GET /api/of-trm/:id/observations — message_of thread (Observations tab).
ofTrmRouter.get('/:id/observations', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await loadOf(id))) { res.status(404).json({ error: 'Not found' }); return }

    const raw = await query<any>(
      `SELECT IDmessage_of, observation, IDbonnetier, DATE AS date_obs
       FROM message_of WHERE IDordre_fabrication = ${id} ORDER BY DATE DESC`,
    )
    const rows = await fixEncoding(raw, 'message_of', 'IDmessage_of', ['observation'])
    const bonnetiers = await bonnetierDirectory()
    res.json(rows.map((r: any) => {
      const bid = Number(r.IDbonnetier) || 0
      const b = bonnetiers.get(bid)
      return {
        id: Number(r.IDmessage_of),
        observation: (r.observation ?? '').toString(),
        IDbonnetier: bid,
        bonnetier: b ? `${b.prenom} ${b.nom}`.trim() : '',
        date: r.date_obs ?? null,
      }
    }))
  } catch (err) {
    console.error('Error fetching of-trm observations:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const observationBody = z.object({ observation: z.string().min(1).max(2000) })

// ════════════════════════════════════════════════════════
//  WRITES — all behind edit_of
// ════════════════════════════════════════════════════════

/** Guard for every write path of this router (TRM `edit_of` permission —
 *  effective admins bypass, an admin impersonating someone does not).
 *
 *  Reading an OF is deliberately NOT behind it: the queue, the consigne and
 *  the declared pieces are what the atelier consults all day, and the poste de
 *  visitage next door needs them read-only. Sends the 401/403 itself and
 *  returns false when the caller is not allowed. */
async function requireEditOf(req: Request, res: Response): Promise<boolean> {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return false
  }
  const allowed = await trmUserHasPermission(req.userId, isEffectiveAdmin(req), 'edit_of')
  if (!allowed) {
    res.status(403).json({ error: 'permission denied: edit_of' })
    return false
  }
  return true
}


// POST /api/of-trm/:id/observations — positional INSERT (reserved `date` col).
// Physical order: IDmessage_of, observation, IDordre_fabrication, IDbonnetier, date.
// IDbonnetier = 0 marks a saisie bureau (web) as opposed to a workshop terminal.

ofTrmRouter.post('/:id/observations', async (req: Request, res: Response) => {
  if (!(await requireEditOf(req, res))) return
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await loadOf(id))) { res.status(404).json({ error: 'Not found' }); return }
    const parsed = observationBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const maxRows = await query<{ m: unknown }>('SELECT MAX(IDmessage_of) AS m FROM message_of')
    const newId = n(maxRows[0]?.m) + 1
    await query(
      `INSERT INTO message_of VALUES (${newId}, ${sqlText(parsed.data.observation)}, ${id}, 0, '${nowDt()}')`,
    )
    res.status(201).json({ id: newId })
  } catch (err) {
    console.error('Error creating of-trm observation:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  OBSERVATIONS RÉGLEUR  (obs_ref_ecru)
// ════════════════════════════════════════════════════════
//
// The standing notes the régleur leaves on an ÉCRU REFERENCE, scoped per métier
// and per coloris — NOT the `message_of` thread above, which is the bonnetier's
// shop-floor chatter and lives only in the Android terminal (`FEN_Consigne`).
// The legacy desktop shows obs_ref_ecru in TWO windows, with the same table,
// the same delete confirmation and the same editor dialog
// (`FEN_Editer_Observation`):
//   - FI_Gestion_OF       → the OF fiche, filtered by the legacy predicate
//   - FI_Ref_TombéMetier  → Tombé Métier › Références, the whole reference
//
// So the CRUD lives here once and both screens call it. Write rules:
//   - `date` is reserved → positional INSERT. Physical order verified on the
//     runtime SELECT *: IDobs_ref_ecru, IDref_ecru, IDmachine, IDcolori_ecru,
//     observation, DATE. Every other column is ASCII → named UPDATE.
//   - An edit does NOT restamp the date: it is the date the note was written,
//     and both tables order by it — a typo fix must not jump the queue.
//   - 0 is the wildcard on both axes; a non-zero coloris must belong to the
//     reference (the legacy combo is parameterised on it).

const obsRefBody = z.object({
  IDmachine: z.number().int().min(0).default(0),
  IDcolori_ecru: z.number().int().min(0).default(0),
  observation: z.string().min(1).max(2000),
})

/** Validate the (ref, machine, coloris) triplet of a write. Sends the 4xx
 *  itself and returns false when the payload does not hold up. */
async function checkObsTarget(
  res: Response,
  refId: number,
  machineId: number,
  coloriId: number,
): Promise<boolean> {
  const ref = await query<{ c: number }>(
    `SELECT COUNT(*) AS c FROM ref_ecru WHERE IDref_ecru = ${refId}`,
  )
  if ((Number(ref[0]?.c) || 0) === 0) { res.status(404).json({ error: 'Référence introuvable' }); return false }
  if (machineId > 0) {
    const machines = await selectMachines()
    if (!machines.some((m) => m.id === machineId)) {
      res.status(400).json({ error: 'Métier inconnu' }); return false
    }
  }
  if (coloriId > 0) {
    const col = await query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM colori_ecru WHERE IDcolori_ecru = ${coloriId} AND IDref_ecru = ${refId}`,
    )
    if ((Number(col[0]?.c) || 0) === 0) {
      res.status(400).json({ error: 'Coloris hors de cette référence' }); return false
    }
  }
  return true
}

/** The reference an existing observation hangs on (0 when the row is gone). */
async function obsRefOf(obsId: number): Promise<number> {
  const rows = await query<{ IDref_ecru: number }>(
    `SELECT IDref_ecru FROM obs_ref_ecru WHERE IDobs_ref_ecru = ${obsId}`,
  )
  return Number(rows[0]?.IDref_ecru) || 0
}

// GET /api/of-trm/:id/observations-ref — the OF fiche's « Observations régleur »
// table: this OF's reference, filtered by its métier and its coloris.
ofTrmRouter.get('/:id/observations-ref', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const loaded = await loadOf(id)
    if (!loaded) { res.status(404).json({ error: 'Not found' }); return }
    const { of } = loaded
    // The OF's OWN ref/coloris, not its order line's: they disagree on 848 of
    // 3 178 rows and the fiche header shows the OF's (see GET /:id).
    const refId = Number(of.IDref_ecru) || 0
    if (refId <= 0) { res.json([]); return }
    res.json(await selectObsRefEcru(refId, Number(of.IDmachine) || 0, Number(of.IDcolori_ecru) || 0))
  } catch (err) {
    console.error('Error fetching of-trm observations-ref:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/of-trm/references/:refId/observations-ref — create.
ofTrmRouter.post('/references/:refId/observations-ref', async (req: Request, res: Response) => {
  if (!(await requireEditOf(req, res))) return
  try {
    const refId = parseInt(req.params.refId, 10)
    if (isNaN(refId) || refId <= 0) { res.status(400).json({ error: 'Invalid ref' }); return }
    const parsed = obsRefBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return
    }
    const { IDmachine, IDcolori_ecru, observation } = parsed.data
    if (!(await checkObsTarget(res, refId, IDmachine, IDcolori_ecru))) return

    const newId = (await maxId('obs_ref_ecru', 'IDobs_ref_ecru')) + 1
    await query(
      `INSERT INTO obs_ref_ecru VALUES (${newId}, ${refId}, ${IDmachine}, ${IDcolori_ecru}, ` +
      `${sqlText(observation.trim())}, '${todayHfsql()}')`,
    )
    res.status(201).json({ id: newId })
  } catch (err) {
    console.error('Error creating obs_ref_ecru:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/of-trm/observations-ref/:obsId — retarget and/or reword. Keeps the date.
ofTrmRouter.put('/observations-ref/:obsId', async (req: Request, res: Response) => {
  if (!(await requireEditOf(req, res))) return
  try {
    const obsId = parseInt(req.params.obsId, 10)
    if (isNaN(obsId) || obsId <= 0) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = obsRefBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues }); return
    }
    const refId = await obsRefOf(obsId)
    if (refId === 0) { res.status(404).json({ error: 'Not found' }); return }
    const { IDmachine, IDcolori_ecru, observation } = parsed.data
    if (!(await checkObsTarget(res, refId, IDmachine, IDcolori_ecru))) return

    await query(
      `UPDATE obs_ref_ecru SET IDmachine = ${IDmachine}, IDcolori_ecru = ${IDcolori_ecru}, ` +
      `observation = ${sqlText(observation.trim())} WHERE IDobs_ref_ecru = ${obsId}`,
    )
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating obs_ref_ecru:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/of-trm/observations-ref/:obsId
ofTrmRouter.delete('/observations-ref/:obsId', async (req: Request, res: Response) => {
  if (!(await requireEditOf(req, res))) return
  try {
    const obsId = parseInt(req.params.obsId, 10)
    if (isNaN(obsId) || obsId <= 0) { res.status(400).json({ error: 'Invalid ID' }); return }
    if ((await obsRefOf(obsId)) === 0) { res.status(404).json({ error: 'Not found' }); return }
    await query(`DELETE FROM obs_ref_ecru WHERE IDobs_ref_ecru = ${obsId}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting obs_ref_ecru:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/of-trm/:id/production — Production tab: pieces + timing + estimated
// efficiency, and the visited/non-visited split.
ofTrmRouter.get('/:id/production', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const loaded = await loadOf(id)
    if (!loaded) { res.status(404).json({ error: 'Not found' }); return }
    const { of } = loaded

    const pieces = await query<any>(
      `SELECT IDpiece_production, numero, poids, date_debut, date_fin
       FROM piece_production WHERE IDordre_fabrication = ${id} ORDER BY numero DESC`,
    )
    const visited = await query<{ IDpiece_production: number }>(
      `SELECT IDpiece_production FROM stock_ecru
       WHERE IDordre_fabrication = ${id} AND IDpiece_production > 0`,
    )
    const visitedSet = new Set(visited.map((v) => Number(v.IDpiece_production)))

    // Estimated theoretical minutes per piece (see file header — approximation).
    let theoriqueMin: number | null = null
    const machineId = Number(of.IDmachine) || 0
    const refId = Number(of.IDref_ecru) || 0
    if (refId > 0 && machineId > 0) {
      const rem = await query<{ trs_10kg_chute: number | null; nb_chutes: number | null }>(
        `SELECT trs_10kg_chute, nb_chutes FROM ref_ecru_machine
         WHERE IDref_ecru = ${refId} AND IDmachine = ${machineId}`,
      )
      const trs = Number(rem[0]?.trs_10kg_chute) || 0
      const chutes = Number(rem[0]?.nb_chutes) || 0
      let vitesse = Number(of.vitesse) || 0
      if (vitesse <= 0) {
        const machines = await selectMachines()
        vitesse = machines.find((m) => m.id === machineId)?.vitesse ?? 0
      }
      if (vitesse <= 0) {
        const refMap = await resolveEcruRefs([refId])
        vitesse = refMap.get(refId)?.vitesse_cible ?? 0
      }
      const poidsPiece = Number(of.poids_piece) || 0
      if (trs > 0 && chutes > 0 && vitesse > 0 && poidsPiece > 0) {
        theoriqueMin = (trs / chutes) * (poidsPiece / 10) / vitesse
      }
    }

    let produites = 0
    const rows = pieces.map((p: any) => {
      const debut = parseDtMs(p.date_debut)
      const fin = parseDtMs(p.date_fin)
      const minutes = debut !== null && fin !== null && fin > debut ? Math.round((fin - debut) / 60000) : null
      if (fin !== null) produites++
      const pct = theoriqueMin !== null && minutes !== null && minutes > 0
        ? Math.round((theoriqueMin / minutes) * 100)
        : null
      return {
        id: Number(p.IDpiece_production),
        numero: Number(p.numero) || 0,
        poids: round2(Number(p.poids) || 0),
        date_debut: p.date_debut ?? null,
        date_fin: p.date_fin ?? null,
        minutes,
        pct,
        visite: visitedSet.has(Number(p.IDpiece_production)),
      }
    })

    res.json({
      pieces: rows,
      produites,
      non_visitees: Math.max(0, produites - visitedSet.size),
      approx: true, // the % formula is inferred from data, not the legacy code
    })
  } catch (err) {
    console.error('Error fetching of-trm production:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** Shared shape for both event-timeline endpoints. */
async function eventsWhere(clause: string) {
  const raw = await query<any>(
    `SELECT IDevenement_piece, evenement, IDbonnetier, observation, appareil, DATE AS date_evt
     FROM evenement_piece WHERE ${clause} ORDER BY DATE ASC`,
  )
  const rows = await fixEncoding(raw, 'evenement_piece', 'IDevenement_piece', ['evenement', 'observation', 'appareil'])
  const bonnetiers = await bonnetierDirectory()
  return rows.map((r: any) => {
    const bid = Number(r.IDbonnetier) || 0
    const b = bonnetiers.get(bid)
    return {
      id: Number(r.IDevenement_piece),
      evenement: (r.evenement ?? '').toString().trim(),
      observation: (r.observation ?? '').toString().trim(),
      appareil: (r.appareil ?? '').toString().trim(),
      IDbonnetier: bid,
      bonnetier: b ? `${b.prenom} ${b.nom}`.trim() : '',
      date: r.date_evt ?? null,
    }
  })
}

// GET /api/of-trm/:id/pieces/:pieceId/evenements — one piece's timeline
// (Début du tricotage / Nettoyage / Fin du tricotage / Interruption / Reprise).
ofTrmRouter.get('/:id/pieces/:pieceId/evenements', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const pieceId = parseInt(req.params.pieceId, 10)
    if (isNaN(id) || isNaN(pieceId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const owner = await query<{ IDordre_fabrication: number }>(
      `SELECT IDordre_fabrication FROM piece_production WHERE IDpiece_production = ${pieceId}`,
    )
    if (Number(owner[0]?.IDordre_fabrication) !== id) { res.status(404).json({ error: 'Not found' }); return }
    res.json(await eventsWhere(`IDpiece_production = ${pieceId}`))
  } catch (err) {
    console.error('Error fetching of-trm piece events:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/of-trm/:id/visitage — Visitage tab: the rolls the OF dropped.
// NO IDsociete filter (delivered rolls flip to 1 on the ETM handover).
ofTrmRouter.get('/:id/visitage', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await loadOf(id))) { res.status(404).json({ error: 'Not found' }); return }

    const raw = await query<any>(
      `SELECT IDstock_ecru, numero, num_piece_OF, poids, second_choix, visiteur,
              observations, date_saisie, IDligne_expedition_TRM, IDpiece_production
       FROM stock_ecru WHERE IDordre_fabrication = ${id}
       ORDER BY num_piece_OF DESC, IDstock_ecru DESC`,
    )
    const rows = await fixEncoding(raw, 'stock_ecru', 'IDstock_ecru', ['numero', 'visiteur', 'observations'])
    const defects = await fetchDefectsByEcru(rows.map((r: any) => Number(r.IDstock_ecru) || 0))

    let totalKg = 0
    let secondKg = 0
    const pieces = rows.map((r: any) => {
      const poids = Number(r.poids) || 0
      totalKg += poids
      const second = Number(r.second_choix) || 0
      if (second === 1) secondKg += poids
      return {
        id: Number(r.IDstock_ecru),
        numero: (r.numero ?? '').toString().trim(),
        num_piece_OF: Number(r.num_piece_OF) || 0,
        poids: round2(poids),
        second_choix: second,
        visiteur: (r.visiteur ?? '').toString().trim(),
        observations: (r.observations ?? '').toString().trim(),
        date_saisie: r.date_saisie ?? null,
        expedie: (Number(r.IDligne_expedition_TRM) || 0) > 0,
        defects: defects.get(Number(r.IDstock_ecru)) ?? ([] as DefautQualite[]),
      }
    })

    res.json({
      pieces,
      total_kg: round2(totalKg),
      second_choix_kg: round2(secondKg),
    })
  } catch (err) {
    console.error('Error fetching of-trm visitage:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/of-trm/:id/rolls/:stockId/evenements — one roll's timeline
// (Visitage tombé métier / Pesage tombé métier).
ofTrmRouter.get('/:id/rolls/:stockId/evenements', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    const stockId = parseInt(req.params.stockId, 10)
    if (isNaN(id) || isNaN(stockId)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const owner = await query<{ IDordre_fabrication: number }>(
      `SELECT IDordre_fabrication FROM stock_ecru WHERE IDstock_ecru = ${stockId}`,
    )
    if (Number(owner[0]?.IDordre_fabrication) !== id) { res.status(404).json({ error: 'Not found' }); return }
    res.json(await eventsWhere(`IDstock_ecru = ${stockId}`))
  } catch (err) {
    console.error('Error fetching of-trm roll events:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/of-trm/:id/qualite — Qualité tab: second-choix %, defect family
// pie, and the Continue/Ponctuel series over 300 kg production slices.
ofTrmRouter.get('/:id/qualite', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    if (!(await loadOf(id))) { res.status(404).json({ error: 'Not found' }); return }

    const rolls = await query<any>(
      `SELECT IDstock_ecru, poids, second_choix, date_saisie, IDpiece_production
       FROM stock_ecru WHERE IDordre_fabrication = ${id}
       ORDER BY date_saisie ASC, IDstock_ecru ASC`,
    )
    const rollIds = rolls.map((r: any) => Number(r.IDstock_ecru) || 0).filter(Boolean)
    const pieceRows = await query<{ IDpiece_production: number }>(
      `SELECT IDpiece_production FROM piece_production WHERE IDordre_fabrication = ${id}`,
    )
    const pieceIds = pieceRows.map((p) => Number(p.IDpiece_production)).filter(Boolean)

    // Two defect populations: spotted at the loom (Type_Reference = 1, keyed on
    // piece ids) and at visitage (Type_Reference = 2, keyed on roll ids).
    const [pieceDefauts, rollDefauts] = await Promise.all([
      selectDefauts(1, pieceIds),
      selectDefauts(2, rollIds),
    ])

    // Second-choix ratios (by weight — the legacy headline figure — and count).
    let totalKg = 0
    let secondKg = 0
    let secondNb = 0
    for (const r of rolls) {
      const kg = Number(r.poids) || 0
      totalKg += kg
      if (Number(r.second_choix) === 1) { secondKg += kg; secondNb++ }
    }

    // Production slices of 300 kg (cumulative weight in visitage order). Each
    // roll belongs to the slice its cumulative start falls in.
    const sliceOfRoll = new Map<number, number>()
    const sliceOfPiece = new Map<number, number>()
    let cum = 0
    let maxSlice = 0
    for (const r of rolls) {
      const slice = Math.floor(cum / 300)
      maxSlice = Math.max(maxSlice, slice)
      sliceOfRoll.set(Number(r.IDstock_ecru), slice)
      const pid = Number(r.IDpiece_production) || 0
      if (pid > 0 && !sliceOfPiece.has(pid)) sliceOfPiece.set(pid, slice)
      cum += Number(r.poids) || 0
    }

    const tranches = Array.from({ length: totalKg > 0 ? maxSlice + 1 : 0 }, (_, i) => ({
      kg_max: (i + 1) * 300,
      continue_cm: 0,
      ponctuel: 0,
    }))

    // Pie buckets — type_defaut is a free string with historical typos
    // (`"Autre Barrure "` has a trailing space): trim, and split Maille into
    // récupéré / non. Weight = max(nombre, 1) so counted defects weigh their
    // count and measured ones weigh 1 record.
    const pie = new Map<string, number>()
    const addDefect = (d: DefautRow, slice: number | undefined) => {
      let label = d.type_defaut || 'Autre'
      if (label === 'Maille' && d.recupere === 1) label = 'Maille récupéré'
      pie.set(label, (pie.get(label) ?? 0) + Math.max(d.nombre, 1))
      if (slice !== undefined && tranches[slice]) {
        if (d.taille_cm > 0) tranches[slice].continue_cm += d.taille_cm
        else tranches[slice].ponctuel += Math.max(d.nombre, 1)
      }
    }
    for (const d of rollDefauts) addDefect(d, sliceOfRoll.get(d.reference))
    for (const d of pieceDefauts) addDefect(d, sliceOfPiece.get(d.reference))

    res.json({
      total_kg: round2(totalKg),
      second_choix_pct_poids: totalKg > 0 ? Math.round((secondKg / totalKg) * 1000) / 10 : 0,
      second_choix_pct_nb: rolls.length > 0 ? Math.round((secondNb / rolls.length) * 1000) / 10 : 0,
      second_choix_kg: round2(secondKg),
      pie: Array.from(pie.entries())
        .map(([label, value]) => ({ label, value }))
        .sort((a, b) => b.value - a.value),
      tranches,
      nb_defauts: rollDefauts.length + pieceDefauts.length,
    })
  } catch (err) {
    console.error('Error fetching of-trm qualite:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/of-trm/:id/performance — Performance tab: machine stops per piece
// from the PLC event log. The recorder only covers PLC-connected métiers and
// has a hard data window — the payload says whether anything was recorded so
// the UI can show an honest empty state.
ofTrmRouter.get('/:id/performance', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const loaded = await loadOf(id)
    if (!loaded) { res.status(404).json({ error: 'Not found' }); return }
    const machineId = Number(loaded.of.IDmachine) || 0

    const pieces = await query<any>(
      `SELECT IDpiece_production, numero, date_debut, date_fin
       FROM piece_production WHERE IDordre_fabrication = ${id} ORDER BY numero ASC`,
    )
    const windows = pieces
      .map((p: any) => ({
        numero: Number(p.numero) || 0,
        debut: parseDtMs(p.date_debut),
        fin: parseDtMs(p.date_fin),
      }))
      .filter((w: any) => w.debut !== null && w.fin !== null && w.fin > w.debut)

    if (machineId <= 0 || windows.length === 0) {
      res.json({ pieces: [], arrets_par_piece: null, total_arrets: 0, covered: false })
      return
    }

    const fromMs = Math.min(...windows.map((w: any) => w.debut as number))
    const toMs = Math.max(...windows.map((w: any) => w.fin as number))
    const toLit = (ms: number) => {
      const t = new Date(ms)
      const p = (x: number) => String(x).padStart(2, '0')
      return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}`
    }
    const events = await query<any>(
      `SELECT IDevenement_machine, etat, DATE AS date_evt FROM evenement_machine
       WHERE IDmachine = ${machineId} AND DATE >= '${toLit(fromMs)}' AND DATE <= '${toLit(toMs + 3600_000)}'
       ORDER BY DATE ASC`,
    )

    // etat alternates strictly per machine: an arrêt = one etat=0 row, lasting
    // until the next etat=1. Stops shorter than FAUX_ARRETS_MIN_S are ignored.
    const stops: number[] = [] // start ms of each real stop
    let stopStart: number | null = null
    for (const e of events) {
      const ms = parseDtMs(e.date_evt)
      if (ms === null) continue
      if (Number(e.etat) === 0) {
        if (stopStart === null) stopStart = ms
      } else if (stopStart !== null) {
        if ((ms - stopStart) / 1000 >= FAUX_ARRETS_MIN_S) stops.push(stopStart)
        stopStart = null
      }
    }

    const perPiece = windows.map((w: any) => ({
      numero: w.numero,
      arrets: stops.filter((s) => s >= (w.debut as number) && s <= (w.fin as number)).length,
    }))
    const total = perPiece.reduce((s: number, p: any) => s + p.arrets, 0)

    res.json({
      pieces: perPiece,
      arrets_par_piece: perPiece.length > 0 ? Math.round((total / perPiece.length) * 10) / 10 : null,
      total_arrets: total,
      covered: events.length > 0,
      faux_arrets_min_s: FAUX_ARRETS_MIN_S,
    })
  } catch (err) {
    console.error('Error fetching of-trm performance:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ════════════════════════════════════════════════════════
//  WRITES
// ════════════════════════════════════════════════════════

const compositionRow = z.object({
  IDref_fil: z.number().int().positive(),
  IDcolori_fil: z.number().int().nonnegative(),
  IDstock_fil: z.number().int().nonnegative(),
  pourcentage: z.number().positive().max(100),
})

const incorporeRow = z.object({
  IDstock_fil: z.number().int().positive(),
  poids: z.number().positive(),
})

const createBody = z.object({
  IDligne_commande_client: z.number().int().positive(),
  IDmachine: z.number().int().positive(),
  quantite: z.number().positive(),
  poids_piece: z.number().positive().optional(),
  composition: z.array(compositionRow).min(1),
  /** "Incorporer un fil" — the legacy création window's second table. Same
   *  rows as PUT /:id/incorpore, accepted here so the flow does not have to
   *  create an OF and then immediately edit it. */
  incorpore: z.array(incorporeRow).optional(),
  visitage: z.number().int().min(0).max(2).optional(),
  nettoyage: z.union([z.literal(1), z.literal(2)]).optional(),
  finir_fil: z.union([z.literal(0), z.literal(1)]).optional(),
  ouvert_visiteuse: z.union([z.literal(0), z.literal(1)]).optional(),
  maille_ouverture: z.union([z.literal(0), z.literal(1)]).optional(),
  sonneter: z.union([z.literal(0), z.literal(1)]).optional(),
  auto_activation: z.union([z.literal(0), z.literal(1)]).optional(),
  observations: z.string().max(4000).optional(),
})

// POST /api/of-trm — création (legacy FEN_Lancement_OF). Always created in
// attente (est_actif = 0) at the back of the métier's queue — activation is a
// distinct act, matching the legacy flow.
ofTrmRouter.post('/', async (req: Request, res: Response) => {
  if (!(await requireEditOf(req, res))) return
  try {
    const parsed = createBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const b = parsed.data
    const ctx = (await resolveLigneContexts([b.IDligne_commande_client])).get(b.IDligne_commande_client)
    if (!ctx) { res.status(404).json({ error: 'Ligne not found' }); return }

    // Reference defaults for anything the dialog left implicit.
    let refDefaults = { poids: 0, ouvert: 0, maille: 0, sonneter: 0 }
    if (ctx.IDreference > 0) {
      const r = await query<any>(
        `SELECT poids, ouvert_visiteuse, maille_ouverture, sonneter FROM ref_ecru
         WHERE IDref_ecru = ${ctx.IDreference}`,
      )
      if (r.length > 0) {
        refDefaults = {
          poids: Number(r[0].poids) || 0,
          ouvert: Number(r[0].ouvert_visiteuse) || 0,
          maille: Number(r[0].maille_ouverture) || 0,
          sonneter: Number(r[0].sonneter) || 0,
        }
      }
    }
    const poidsPiece = b.poids_piece ?? (refDefaults.poids > 0 ? refDefaults.poids : 20)
    const nbPieces = Math.max(1, Math.ceil(b.quantite / poidsPiece))
    const prio = await query<{ m: number | null }>(
      `SELECT MAX(priorite) AS m FROM ordre_fabrication WHERE IDmachine = ${b.IDmachine} AND est_termine = 0`,
    )
    const priorite = (Number(prio[0]?.m) || 0) + 1

    const before = await maxId('ordre_fabrication', 'IDordre_fabrication')
    await query(
      `INSERT INTO ordre_fabrication (quantite, IDligne_commande_client, poids_piece, ouvert_visiteuse,
         maille_ouverture, observations, date_creation, visitage, est_actif, est_termine, IDmachine,
         nb_tour_cpt, nb_tour_1_chute, priorite, finir_fil, nb_pieces, auto_activation, IDref_ecru,
         IDcolori_ecru, Nettoyage, prioritaire, vitesse, sonneter)
       VALUES (${b.quantite}, ${b.IDligne_commande_client}, ${poidsPiece},
         ${b.ouvert_visiteuse ?? refDefaults.ouvert}, ${b.maille_ouverture ?? refDefaults.maille},
         ${sqlText(b.observations ?? '')}, '${todayHfsql()}', ${b.visitage ?? 1}, 0, 0, ${b.IDmachine},
         0, 0, ${priorite}, ${b.finir_fil ?? 0}, ${nbPieces}, ${b.auto_activation ?? 0},
         ${ctx.IDreference}, ${ctx.IDcolori}, ${b.nettoyage ?? 1}, 0, 0,
         ${b.sonneter ?? refDefaults.sonneter})`,
    )
    const newId = await newIdAfterInsert('ordre_fabrication', 'IDordre_fabrication', before)
    if (newId <= 0) { res.status(500).json({ error: 'Internal server error' }); return }

    for (const c of b.composition) {
      await query(
        `INSERT INTO asso_fil_of (IDordre_fabrication, IDref_fil, pourcentage, IDcolori_fil, IDstock_fil)
         VALUES (${newId}, ${c.IDref_fil}, ${c.pourcentage}, ${c.IDcolori_fil}, ${c.IDstock_fil})`,
      )
    }
    for (const i of b.incorpore ?? []) {
      await query(
        `INSERT INTO fil_incorpore (IDordre_fabrication, IDstock_fil, poids)
         VALUES (${newId}, ${i.IDstock_fil}, ${i.poids})`,
      )
    }
    res.status(201).json({ id: newId })
  } catch (err) {
    console.error('Error creating of-trm:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const updateBody = z.object({
  IDmachine: z.number().int().positive().optional(),
  quantite: z.number().positive().optional(),
  poids_piece: z.number().positive().optional(),
  visitage: z.number().int().min(0).max(2).optional(),
  nettoyage: z.union([z.literal(1), z.literal(2)]).optional(),
  finir_fil: z.union([z.literal(0), z.literal(1)]).optional(),
  ouvert_visiteuse: z.union([z.literal(0), z.literal(1)]).optional(),
  maille_ouverture: z.union([z.literal(0), z.literal(1)]).optional(),
  sonneter: z.union([z.literal(0), z.literal(1)]).optional(),
  auto_activation: z.union([z.literal(0), z.literal(1)]).optional(),
  prioritaire: z.union([z.literal(0), z.literal(1)]).optional(),
  vitesse: z.number().int().min(0).max(60).optional(),
  observations: z.string().max(4000).optional(),
})

// PUT /api/of-trm/:id — form update. Quantité is locked once production
// started (legacy greys it); poids_piece stays editable throughout.
ofTrmRouter.put('/:id', async (req: Request, res: Response) => {
  if (!(await requireEditOf(req, res))) return
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const loaded = await loadOf(id)
    if (!loaded) { res.status(404).json({ error: 'Not found' }); return }
    const { of } = loaded
    if (Number(of.est_termine) === 1) {
      res.status(409).json({ error: 'of_termine', message: 'OF terminé — il ne peut plus être modifié.' })
      return
    }
    const parsed = updateBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const b = parsed.data

    const produced = await hasProduction(id)
    if (b.quantite !== undefined && produced && round2(b.quantite) !== round2(Number(of.quantite) || 0)) {
      res.status(409).json({
        error: 'production_lancee',
        message: 'La production a démarré — la quantité ne peut plus être modifiée.',
      })
      return
    }

    // Machine move: leave the old queue, join the back of the new one. An
    // active OF can only move to a métier that has no active OF.
    const oldMachine = Number(of.IDmachine) || 0
    let newPriorite: number | null = null
    const movingMachine = b.IDmachine !== undefined && b.IDmachine !== oldMachine
    if (movingMachine) {
      if (Number(of.est_actif) === 1) {
        const active = await activeOfOnMachine(b.IDmachine!, id)
        if (active > 0) {
          res.status(409).json({
            error: 'machine_occupee',
            message: `Le métier cible a déjà un OF en cours (OF ${active}).`,
          })
          return
        }
        newPriorite = 0 // rerank puts the active OF first
      } else {
        const prio = await query<{ m: number | null }>(
          `SELECT MAX(priorite) AS m FROM ordre_fabrication WHERE IDmachine = ${b.IDmachine} AND est_termine = 0`,
        )
        newPriorite = (Number(prio[0]?.m) || 0) + 1
      }
    }

    const sets: string[] = []
    if (b.IDmachine !== undefined) sets.push(`IDmachine = ${b.IDmachine}`)
    if (newPriorite !== null) sets.push(`priorite = ${newPriorite}`)
    if (b.quantite !== undefined) sets.push(`quantite = ${b.quantite}`)
    if (b.poids_piece !== undefined) sets.push(`poids_piece = ${b.poids_piece}`)
    if (b.visitage !== undefined) sets.push(`visitage = ${b.visitage}`)
    if (b.nettoyage !== undefined) sets.push(`Nettoyage = ${b.nettoyage}`)
    if (b.finir_fil !== undefined) sets.push(`finir_fil = ${b.finir_fil}`)
    if (b.ouvert_visiteuse !== undefined) sets.push(`ouvert_visiteuse = ${b.ouvert_visiteuse}`)
    if (b.maille_ouverture !== undefined) sets.push(`maille_ouverture = ${b.maille_ouverture}`)
    if (b.sonneter !== undefined) sets.push(`sonneter = ${b.sonneter}`)
    if (b.auto_activation !== undefined) sets.push(`auto_activation = ${b.auto_activation}`)
    if (b.prioritaire !== undefined) sets.push(`prioritaire = ${b.prioritaire}`)
    if (b.vitesse !== undefined) sets.push(`vitesse = ${b.vitesse}`)
    if (b.observations !== undefined) sets.push(`observations = ${sqlText(b.observations)}`)

    // nb_pieces follows quantité/poids pièce (derived, like the legacy form).
    const quantite = b.quantite ?? (Number(of.quantite) || 0)
    const poidsPiece = b.poids_piece ?? (Number(of.poids_piece) || 0)
    if ((b.quantite !== undefined || b.poids_piece !== undefined) && poidsPiece > 0) {
      sets.push(`nb_pieces = ${Math.max(1, Math.ceil(quantite / poidsPiece))}`)
    }

    if (sets.length > 0) {
      await query(`UPDATE ordre_fabrication SET ${sets.join(', ')} WHERE IDordre_fabrication = ${id}`)
    }
    if (movingMachine) {
      await rerankQueue(oldMachine)
      await rerankQueue(b.IDmachine!)
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating of-trm:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/of-trm/:id/composition — full replace of the Tricoter rows.
// Allowed during production (lot swaps mid-OF are normal legacy practice).
ofTrmRouter.put('/:id/composition', async (req: Request, res: Response) => {
  if (!(await requireEditOf(req, res))) return
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const loaded = await loadOf(id)
    if (!loaded) { res.status(404).json({ error: 'Not found' }); return }
    if (Number(loaded.of.est_termine) === 1) {
      res.status(409).json({ error: 'of_termine', message: 'OF terminé — il ne peut plus être modifié.' })
      return
    }
    const parsed = z.object({ rows: z.array(compositionRow).min(1) }).safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    await query(`DELETE FROM asso_fil_of WHERE IDordre_fabrication = ${id}`)
    for (const c of parsed.data.rows) {
      await query(
        `INSERT INTO asso_fil_of (IDordre_fabrication, IDref_fil, pourcentage, IDcolori_fil, IDstock_fil)
         VALUES (${id}, ${c.IDref_fil}, ${c.pourcentage}, ${c.IDcolori_fil}, ${c.IDstock_fil})`,
      )
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating of-trm composition:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/of-trm/:id/incorpore — full replace of the Incorporer rows.
ofTrmRouter.put('/:id/incorpore', async (req: Request, res: Response) => {
  if (!(await requireEditOf(req, res))) return
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const loaded = await loadOf(id)
    if (!loaded) { res.status(404).json({ error: 'Not found' }); return }
    if (Number(loaded.of.est_termine) === 1) {
      res.status(409).json({ error: 'of_termine', message: 'OF terminé — il ne peut plus être modifié.' })
      return
    }
    const parsed = z.object({
      rows: z.array(z.object({
        IDstock_fil: z.number().int().positive(),
        poids: z.number().positive(),
      })),
    }).safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    await query(`DELETE FROM fil_incorpore WHERE IDordre_fabrication = ${id}`)
    for (const r of parsed.data.rows) {
      await query(
        `INSERT INTO fil_incorpore (IDordre_fabrication, IDstock_fil, poids)
         VALUES (${id}, ${r.IDstock_fil}, ${r.poids})`,
      )
    }
    res.json({ ok: true })
  } catch (err) {
    console.error('Error updating of-trm incorpore:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/of-trm/:id/terminer — close the OF and hand the métier to the next
// queued OF when it asked for auto-activation.
ofTrmRouter.post('/:id/terminer', async (req: Request, res: Response) => {
  if (!(await requireEditOf(req, res))) return
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const loaded = await loadOf(id)
    if (!loaded) { res.status(404).json({ error: 'Not found' }); return }
    const { of } = loaded
    if (Number(of.est_termine) === 1) {
      res.status(409).json({ error: 'of_termine', message: 'OF déjà terminé.' })
      return
    }
    await query(
      `UPDATE ordre_fabrication SET est_termine = 1, est_actif = 0, priorite = 0,
         arret_prod = '${nowDt()}' WHERE IDordre_fabrication = ${id}`,
    )
    const machineId = Number(of.IDmachine) || 0
    let activated = 0
    if (machineId > 0) {
      const queue = await rerankQueue(machineId)
      const head = queue[0]
      if (head && head.est_actif === 0 && head.auto_activation === 1) {
        await query(`UPDATE ordre_fabrication SET est_actif = 1 WHERE IDordre_fabrication = ${head.id}`)
        activated = head.id
      }
    }
    res.json({ ok: true, activated })
  } catch (err) {
    console.error('Error terminating of-trm:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/of-trm/:id/activer — manual start of a waiting OF (one active OF
// per métier, like the legacy screen).
ofTrmRouter.post('/:id/activer', async (req: Request, res: Response) => {
  if (!(await requireEditOf(req, res))) return
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const loaded = await loadOf(id)
    if (!loaded) { res.status(404).json({ error: 'Not found' }); return }
    const { of } = loaded
    if (Number(of.est_termine) === 1) {
      res.status(409).json({ error: 'of_termine', message: 'OF terminé — il ne peut plus être activé.' })
      return
    }
    if (Number(of.est_actif) === 1) { res.json({ ok: true }); return }
    const machineId = Number(of.IDmachine) || 0
    const active = await activeOfOnMachine(machineId, id)
    if (active > 0) {
      res.status(409).json({
        error: 'machine_occupee',
        message: `Le métier a déjà un OF en cours (OF ${active}). Terminez-le d'abord.`,
      })
      return
    }
    // priorite 0 + est_actif 1 → rerank orders it first and re-densifies.
    await query(`UPDATE ordre_fabrication SET est_actif = 1, priorite = 0 WHERE IDordre_fabrication = ${id}`)
    await rerankQueue(machineId)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error activating of-trm:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/of-trm/:id/reorder {direction: 'up'|'down'} — move a WAITING OF
// within its métier's queue (the active OF is pinned at the front).
ofTrmRouter.post('/:id/reorder', async (req: Request, res: Response) => {
  if (!(await requireEditOf(req, res))) return
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const parsed = z.object({ direction: z.enum(['up', 'down']) }).safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const loaded = await loadOf(id)
    if (!loaded) { res.status(404).json({ error: 'Not found' }); return }
    const { of } = loaded
    if (Number(of.est_termine) === 1 || Number(of.est_actif) === 1) {
      res.status(409).json({ error: 'of_non_reordonnable', message: 'Seuls les OF en attente se réordonnent.' })
      return
    }
    const machineId = Number(of.IDmachine) || 0
    const queue = await rerankQueue(machineId)
    const waiting = queue.filter((q) => q.est_actif === 0)
    const idx = waiting.findIndex((q) => q.id === id)
    if (idx < 0) { res.status(404).json({ error: 'Not found' }); return }
    const swapWith = parsed.data.direction === 'up' ? idx - 1 : idx + 1
    if (swapWith < 0 || swapWith >= waiting.length) { res.json({ ok: true }); return } // already at the edge
    const a = waiting[idx]
    const b = waiting[swapWith]
    await query(`UPDATE ordre_fabrication SET priorite = ${b.priorite} WHERE IDordre_fabrication = ${a.id}`)
    await query(`UPDATE ordre_fabrication SET priorite = ${a.priorite} WHERE IDordre_fabrication = ${b.id}`)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error reordering of-trm:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// DELETE /api/of-trm/:id — hard delete, refused once anything was produced.
ofTrmRouter.delete('/:id', async (req: Request, res: Response) => {
  if (!(await requireEditOf(req, res))) return
  try {
    const id = parseInt(req.params.id, 10)
    if (isNaN(id)) { res.status(400).json({ error: 'Invalid ID' }); return }
    const loaded = await loadOf(id)
    if (!loaded) { res.status(404).json({ error: 'Not found' }); return }
    if (await hasProduction(id)) {
      res.status(409).json({
        error: 'production_lancee',
        message: 'Cet OF a déjà produit des pièces — il ne peut pas être supprimé. Terminez-le.',
      })
      return
    }
    const machineId = Number(loaded.of.IDmachine) || 0
    await query(`DELETE FROM asso_fil_of WHERE IDordre_fabrication = ${id}`)
    await query(`DELETE FROM fil_incorpore WHERE IDordre_fabrication = ${id}`)
    await query(`DELETE FROM message_of WHERE IDordre_fabrication = ${id}`)
    await query(`DELETE FROM ordre_fabrication WHERE IDordre_fabrication = ${id}`)
    if (machineId > 0) await rerankQueue(machineId)
    res.json({ ok: true })
  } catch (err) {
    console.error('Error deleting of-trm:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
