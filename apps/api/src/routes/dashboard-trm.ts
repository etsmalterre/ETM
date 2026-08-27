// TRM tableau de bord widgets — data endpoints consumed by the TRM web app
// (C:\dev\etsmalterre\TRM). One router for every TRM-only widget; each widget
// gets its own permission key in lib/permission-keys-trm.ts.
//
// ── « Poids des pièces » (legacy FI_Mauvais_Compteur.wdw + FEN_Graphe_Compteur.wdw)
//
// The legacy windows are PCS-compressed, but the WinDev compile cache
// (MPS.cpl\…\FI_Mauvais_Compteur.*.wcw) still holds the query text. Verbatim:
//
//   select machine, IDordre_fabrication, valide, total, valide/total as pct
//   from ( select emplacement as machine, IDordre_fabrication,
//                 sum(valide) as valide, count(*) as total
//          from ( select ordre_fabrication.IDordre_fabrication, machine.emplacement,
//                        (CASE WHEN stock_ecru.poids > ordre_fabrication.poids_piece*0.65
//                               and (stock_ecru.poids < ordre_fabrication.poids_piece
//                                    or stock_ecru.poids > ordre_fabrication.poids_piece+0.7)
//                              THEN 0 ELSE 1 END) as valide
//                 from ordre_fabrication
//                 left join machine on machine.IDmachine = ordre_fabrication.IDmachine
//                 left join stock_ecru on stock_ecru.IDordre_fabrication = ordre_fabrication.IDordre_fabrication
//                 where ordre_fabrication.est_actif = 1 and stock_ecru.poids is not null )
//          group by IDordre_fabrication, emplacement )
//   order by pct
//
// So the unit is the ROLL (`stock_ecru` row, i.e. what the visiteuse weighed),
// not `piece_production` (whose `poids` is the nominal 20/10 kg, never a
// measurement). A roll is valid when its weight sits in
// [poids_piece, poids_piece + 0.7 kg] — OR when it weighs at most 65 % of the
// target: a short remnant (end of lot, piece cut in two after a defect) is
// deliberately not held against the métier. Nothing here filters on
// IDsociete: the ETM handover flips delivered rolls from 2 to 1 and the
// legacy counts them regardless.
//
// The rule is evaluated in JS on the raw doubles the driver hands back so
// that both endpoints (list + chart) share one function. That also keeps the
// legacy's float behaviour: `poids` is a 4-byte real, so a roll entered as
// 20,7 comes back as 20.700000762… and is > poids_piece + 0.7 — the effective
// band is [20, 20.7) for a 20 kg target. Verified against the live widget:
// 6/6 rows reproduced exactly (74/52/0/96/69/10 %).
//
// The chart window (FEN_Graphe_Compteur) plots every roll of the OF ordered by
// date_saisie, with the target line at poids_piece and the band
// [poids_piece, poids_piece + 0.7]; the Y axis spans poids_piece ± 2 (the
// integer literals did not survive the compile cache — inferred from the
// screenshot). Title « <emplacement> - OF N° <id> ».
//
// ── « Pièces à visiter » (legacy FI_PiecesAVisiter.wdw)
//
// The pieces that came off a métier and that nobody has weighed yet — the
// visiteuse's to-do list, and the régleur's proof that tombé métier is piling
// up somewhere. Recovered the same way (MPS.cpl…FI_PiecesAVisiter.*.wcw for
// the query, the WLanguage of the "row colour" loop supplied by the user).
// Query verbatim:
//
//   SELECT machine.emplacement, piece_production.numero, piece_production.date_fin,
//     (CASE WHEN CAST(SUBSTR(piece_production.date_fin,9,2) AS INT) >= 5
//            AND CAST(SUBSTR(piece_production.date_fin,9,2) AS INT) < 13 THEN 'Matin'
//           WHEN CAST(SUBSTR(piece_production.date_fin,9,2) AS INT) >= 13
//            AND CAST(SUBSTR(piece_production.date_fin,9,2) AS INT) < 21 THEN 'Après-Midi'
//           ELSE 'Nuit' END) AS equipe
//   FROM piece_production
//   LEFT JOIN ordre_fabrication ON ordre_fabrication.IDordre_fabrication = piece_production.IDordre_fabrication
//   LEFT JOIN machine ON machine.IDmachine = ordre_fabrication.IDmachine
//   LEFT JOIN stock_ecru ON stock_ecru.IDpiece_production = piece_production.IDpiece_production
//   WHERE stock_ecru.date_saisie IS NULL
//     AND piece_production.date_fin > DATEADD(DAY,-1,SYSDATE)
//   ORDER BY piece_production.date_fin ASC
//
// and the colour loop that fills the table, verbatim:
//
//   dhDateRouge  = DateHeureSys() ; dhDateRouge.Heure  -= 3
//   dhDateOrange = DateHeureSys() ; dhDateOrange.Heure -= 2
//   si date_fin < dhDateRouge     → RougePastel
//   sinon si date_fin < dhDateOrange → OrangePastel
//   sinon → VertPastel
//
// So: a 24-hour window, oldest first, and one signal — how long the piece has
// been waiting (3 h rouge / 2 h orange / vert). Both thresholds are evaluated
// in the BROWSER against its own clock, as the legacy evaluates them against
// the workstation's: the endpoint returns date_fin as epoch ms and nothing
// else, so the colours stay true as the morning wears on rather than freezing
// at the moment of the fetch.
//
// ⚠️ The 24-hour cutoff is applied to date_fin, NOT to the scan: awaitingPieces
// sweeps the last PIECE_SCAN_DEPTH ids workshop-wide (lib/production-trm.ts)
// and the window is a JS filter on top. Reproducing the legacy's LEFT JOIN
// anti-join in SQL is what that helper exists to avoid — see its header.
//
// One deliberate delta, the same one the Visitage poste makes: the legacy's
// SUBSTR(date_fin, 9, 2) reads the hour out of the driver's own DATETIME
// rendering, which differs between the Windows ODBC driver and the Linux
// bridge (parseDtMs handles both). The équipe is therefore derived from the
// parsed local hour, with the legacy's own boundaries: 5–13 Matin, 13–21
// Après-Midi, else Nuit.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { query, queryB64Text, fixEncoding } from '../lib/hfsql-auto.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { trmUserHasPermission } from '../lib/permissions-trm.js'
import { n } from '../lib/sst-shared.js'
import { awaitingPieces } from '../lib/production-trm.js'

export const dashboardTrmRouter: RouterType = Router()

const IS_WINDOWS = process.platform === 'win32'

/** Upper tolerance above the target weight, in kg (legacy literal `+0.7`). */
export const POIDS_TOLERANCE_KG = 0.7
/** A roll at or under this share of the target is a remnant, counted valid
 *  (legacy literal `*0.65`). */
export const POIDS_CHUTE_RATIO = 0.65

/** The legacy CASE, verbatim: invalid ⇔ heavier than a remnant AND outside
 *  the band. Compare raw doubles — see the header on why no rounding. */
export function isPoidsValide(poids: number, poidsPiece: number): boolean {
  return !(poids > poidsPiece * POIDS_CHUTE_RATIO
    && (poids < poidsPiece || poids > poidsPiece + POIDS_TOLERANCE_KG))
}

// ── Permission gate ──

async function requirePoidsPieces(req: Request, res: Response): Promise<boolean> {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return false
  }
  const ok = await trmUserHasPermission(req.userId, isEffectiveAdmin(req), 'dashboard_poids_pieces')
  if (!ok) res.status(403).json({ error: 'permission denied: dashboard_poids_pieces' })
  return ok
}

// ── Readers ──

interface OfRow { IDordre_fabrication: number; IDmachine: number; poids_piece: number }

/** Métier display names by id. `machine` carries accented columns
 *  (archivé, diamètre, connecté) so it is read whole and key-folded — the
 *  selectMachines pattern of of-trm.ts. Emplacement is what the legacy widget
 *  shows (« 3B »); nom is the fallback for the few rows where it is empty. */
async function machineNames(ids: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>()
  if (ids.length === 0) return out
  const sql = 'SELECT * FROM machine'
  const raws = IS_WINDOWS
    ? await fixEncoding(await query<Record<string, unknown>>(sql), 'machine', 'IDmachine', ['nom', 'emplacement'])
    : await queryB64Text<Record<string, unknown>>(sql)
  const wanted = new Set(ids)
  for (const r of raws) {
    const id = n(r.IDmachine)
    if (!wanted.has(id)) continue
    const emplacement = String(r.emplacement ?? '').trim()
    const nom = String(r.nom ?? '').trim()
    out.set(id, emplacement || nom || `#${id}`)
  }
  return out
}

async function activeOfs(): Promise<OfRow[]> {
  const rows = await query<OfRow>(
    'SELECT IDordre_fabrication, IDmachine, poids_piece FROM ordre_fabrication WHERE est_actif = 1',
  )
  return rows.map((r) => ({
    IDordre_fabrication: n(r.IDordre_fabrication),
    IDmachine: n(r.IDmachine),
    poids_piece: Number(r.poids_piece ?? 0),
  }))
}

// ── GET /api/dashboard-trm/poids-pieces ──
// One row per active OF that has at least one weighed roll, worst first.
dashboardTrmRouter.get('/poids-pieces', async (req: Request, res: Response) => {
  if (!(await requirePoidsPieces(req, res))) return
  try {
    const ofs = await activeOfs()
    if (ofs.length === 0) { res.json([]); return }
    const ofIds = ofs.map((o) => o.IDordre_fabrication)
    const [rolls, names] = await Promise.all([
      query<{ IDordre_fabrication: number; poids: number | null }>(
        `SELECT IDordre_fabrication, poids FROM stock_ecru
         WHERE IDordre_fabrication IN (${ofIds.join(',')}) AND poids IS NOT NULL`,
      ),
      machineNames([...new Set(ofs.map((o) => o.IDmachine))]),
    ])
    const byOf = new Map<number, number[]>()
    for (const r of rolls) {
      const id = n(r.IDordre_fabrication)
      const list = byOf.get(id) ?? []
      list.push(Number(r.poids))
      byOf.set(id, list)
    }
    const out = ofs
      .map((o) => {
        const poids = byOf.get(o.IDordre_fabrication) ?? []
        const valide = poids.filter((p) => isPoidsValide(p, o.poids_piece)).length
        return {
          IDordre_fabrication: o.IDordre_fabrication,
          machine: names.get(o.IDmachine) ?? `#${o.IDmachine}`,
          poids_piece: o.poids_piece,
          valide,
          total: poids.length,
          pct: poids.length > 0 ? valide / poids.length : 0,
        }
      })
      // The legacy LEFT JOIN + `poids is not null` drops OFs with no roll yet.
      .filter((r) => r.total > 0)
      .sort((a, b) => a.pct - b.pct || a.machine.localeCompare(b.machine, 'fr'))
    res.json(out)
  } catch (err) {
    console.error('Error fetching poids-pieces:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /api/dashboard-trm/poids-pieces/:id ──
// Every weighed roll of one OF, in weighing order — the chart's series.
dashboardTrmRouter.get('/poids-pieces/:id', async (req: Request, res: Response) => {
  if (!(await requirePoidsPieces(req, res))) return
  const id = parseInt(req.params.id, 10)
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: 'invalid id' })
    return
  }
  try {
    const ofRows = await query<OfRow>(
      `SELECT IDordre_fabrication, IDmachine, poids_piece FROM ordre_fabrication WHERE IDordre_fabrication = ${id}`,
    )
    if (ofRows.length === 0) {
      res.status(404).json({ error: 'OF introuvable' })
      return
    }
    const of = ofRows[0]
    const poidsPiece = Number(of.poids_piece ?? 0)
    const [rolls, names] = await Promise.all([
      query<{ IDstock_ecru: number; numero: string | null; num_piece_OF: number | null; poids: number; date_saisie: string | null }>(
        `SELECT IDstock_ecru, numero, num_piece_OF, poids, date_saisie FROM stock_ecru
         WHERE IDordre_fabrication = ${id} AND poids IS NOT NULL
         ORDER BY date_saisie ASC, IDstock_ecru ASC`,
      ),
      machineNames([n(of.IDmachine)]),
    ])
    res.json({
      IDordre_fabrication: id,
      machine: names.get(n(of.IDmachine)) ?? `#${n(of.IDmachine)}`,
      poids_piece: poidsPiece,
      poids_min: poidsPiece,
      poids_max: poidsPiece + POIDS_TOLERANCE_KG,
      chute_max: poidsPiece * POIDS_CHUTE_RATIO,
      pieces: rolls.map((r) => ({
        IDstock_ecru: n(r.IDstock_ecru),
        numero: String(r.numero ?? '').trim(),
        num_piece_OF: n(r.num_piece_OF),
        poids: Number(r.poids),
        date_saisie: r.date_saisie ?? null,
        valide: isPoidsValide(Number(r.poids), poidsPiece),
      })),
    })
  } catch (err) {
    console.error('Error fetching poids-pieces detail:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── « Pièces à visiter » ─────────────────────────────────

/** The legacy window (`date_fin > DATEADD(DAY,-1,SYSDATE)`): only pieces
 *  finished in the last 24 h are listed. Anything older has stopped being
 *  today's work — the backlog is the Visitage poste's business, over its own
 *  7-day offer window, not this widget's.
 *
 *  Overridable so the stale dev copy stays usable: the dev database is a
 *  snapshot months behind, where a literal 24 h shows an empty workshop and
 *  the widget cannot be worked on at all. Set PIECES_A_VISITER_WINDOW_HOURS in
 *  apps/api/.env.development ONLY — prod keeps the 24 h. Same knob, same
 *  reason, as VISITAGE_PIECE_MAX_AGE_DAYS in routes/visitage-trm.ts.
 *
 *  ⚠️ Read lazily, NOT into a module-level const: ESM evaluates an imported
 *  module before the importing one's body, so index.ts's dotenv.config() has
 *  not run when this file is first evaluated and a top-level process.env read
 *  here is always undefined. */
function windowMs(): number {
  const h = Number(process.env.PIECES_A_VISITER_WINDOW_HOURS ?? '24') || 24
  return h * 60 * 60 * 1000
}

export type Equipe = 'Matin' | 'Après-Midi' | 'Nuit'

/** The legacy CASE, on the parsed local hour rather than on SUBSTR of the
 *  driver's own rendering: 5–13 Matin, 13–21 Après-Midi, else Nuit. */
export function equipeAt(ms: number): Equipe {
  const h = new Date(ms).getHours()
  if (h >= 5 && h < 13) return 'Matin'
  if (h >= 13 && h < 21) return 'Après-Midi'
  return 'Nuit'
}

async function requirePiecesAVisiter(req: Request, res: Response): Promise<boolean> {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return false
  }
  const ok = await trmUserHasPermission(req.userId, isEffectiveAdmin(req), 'dashboard_pieces_a_visiter')
  if (!ok) res.status(403).json({ error: 'permission denied: dashboard_pieces_a_visiter' })
  return ok
}

// ── GET /api/dashboard-trm/pieces-a-visiter ──
// One row per finished piece with no roll yet, of the last 24 h, oldest first.
dashboardTrmRouter.get('/pieces-a-visiter', async (req: Request, res: Response) => {
  if (!(await requirePiecesAVisiter(req, res))) return
  try {
    const since = Date.now() - windowMs()
    const waiting = (await awaitingPieces())
      .filter((p) => (p.date_fin_ms ?? 0) > since)
      .sort((a, b) => (a.date_fin_ms ?? 0) - (b.date_fin_ms ?? 0))
    if (waiting.length === 0) { res.json([]); return }

    const names = await machineNames([...new Set(waiting.map((p) => p.IDmachine))])
    res.json(
      waiting.map((p) => {
        const ms = p.date_fin_ms as number
        return {
          IDpiece_production: p.id,
          IDordre_fabrication: p.IDordre_fabrication,
          machine: names.get(p.IDmachine) ?? `#${p.IDmachine}`,
          numero: p.numero,
          date_fin_ms: ms,
          equipe: equipeAt(ms),
        }
      }),
    )
  } catch (err) {
    console.error('Error fetching pieces-a-visiter:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})
