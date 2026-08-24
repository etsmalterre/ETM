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

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { query, queryB64Text, fixEncoding } from '../lib/hfsql-auto.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { trmUserHasPermission } from '../lib/permissions-trm.js'
import { n } from '../lib/sst-shared.js'

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
