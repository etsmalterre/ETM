// Arrêts par pièce of the active OFs — the ONE reader behind the TRS tablet
// tile (routes/trs.ts) and the régleur's machine list in the Atelier PWA
// (routes/atelier.ts). The pure arithmetic is `arretsParPiece()` in
// trs-trm.ts; this module owns the two reads around it and the per-OF cache.
//
// The mean is over FINISHED pieces, so it can only change when a piece
// ends: keyed on (OF, ids of its last finished pieces) it is computed once
// per piece, not once per poll. Only the piece list is re-read each call —
// one narrow query over the active OFs — and `date_fin` is judged by
// parseDtMs(), never in SQL (`<> ''` vs IS NULL differ across the drivers,
// see production-trm.ts awaitingPieces). The stop query is bounded to the
// span of those pieces and to the OF's machine, as the legacy joined it.
//
// Both callers see the same number for the same OF — that is the point
// (decision 2026-09-14, see atelier-regleur-trm.ts): the wall tablet and the
// régleur's phone must not disagree on how often a métier stops.

import { query } from './hfsql-auto.js'
import { parseDtMs } from './production-trm.js'
import { arretsParPiece, toHfsqlDt, ARRETS_PIECES, type ArretsParPiece } from './trs-trm.js'

const n = (v: unknown): number => Number(v) || 0

interface PieceRow {
  IDpiece_production: number
  IDordre_fabrication: number
  date_debut: unknown
  date_fin: unknown
}

/** An active OF and the métier it runs on (`ordre_fabrication.IDmachine`). */
export interface OfActif {
  ofId: number
  machineId: number
}

const cacheArretsParOf = new Map<number, { cle: string; resultat: ArretsParPiece }>()

/** Mean unexplained stops per piece over the last ARRETS_PIECES finished
 *  pieces of every OF given, keyed by OF id. Cached per (OF, piece ids). */
export async function arretsParPieceDesOfs(ofs: OfActif[]): Promise<Map<number, ArretsParPiece>> {
  const out = new Map<number, ArretsParPiece>()
  const ofIds = Array.from(new Set(ofs.map((o) => o.ofId).filter((x) => x > 0)))
  if (ofIds.length === 0) {
    cacheArretsParOf.clear()
    return out
  }
  const rows = await query<PieceRow>(
    `SELECT IDpiece_production, IDordre_fabrication, date_debut, date_fin
     FROM piece_production WHERE IDordre_fabrication IN (${ofIds.join(',')})`,
  )
  const finiesParOf = new Map<number, { id: number; debutMs: number; finMs: number }[]>()
  for (const r of rows) {
    const debutMs = parseDtMs(r.date_debut)
    const finMs = parseDtMs(r.date_fin)
    if (debutMs === null || finMs === null || finMs <= debutMs) continue
    const ofId = n(r.IDordre_fabrication)
    if (!finiesParOf.has(ofId)) finiesParOf.set(ofId, [])
    finiesParOf.get(ofId)!.push({ id: n(r.IDpiece_production), debutMs, finMs })
  }
  for (const id of Array.from(cacheArretsParOf.keys())) if (!ofIds.includes(id)) cacheArretsParOf.delete(id)

  for (const { ofId, machineId } of ofs) {
    if (ofId <= 0 || out.has(ofId)) continue
    const dernieres = (finiesParOf.get(ofId) ?? []).sort((a, b) => b.id - a.id).slice(0, ARRETS_PIECES)
    const cle = dernieres.map((p) => p.id).join(',')
    const hit = cacheArretsParOf.get(ofId)
    if (hit && hit.cle === cle) {
      out.set(ofId, hit.resultat)
      continue
    }
    let resultat: ArretsParPiece = { moyenne: null, pieces: 0 }
    if (dernieres.length > 0) {
      const debutLit = toHfsqlDt(Math.min(...dernieres.map((p) => p.debutMs)))
      const finLit = toHfsqlDt(Math.max(...dernieres.map((p) => p.finMs)))
      const [stops, evts] = await Promise.all([
        query<{ date_evt: unknown }>(
          `SELECT DATE AS date_evt FROM evenement_machine
           WHERE IDmachine = ${machineId} AND etat = 0 AND DATE > '${debutLit}' AND DATE < '${finLit}'`,
        ),
        query<{ IDpiece_production: number; evenement: string }>(
          `SELECT IDpiece_production, evenement FROM evenement_piece
           WHERE IDpiece_production IN (${dernieres.map((p) => p.id).join(',')})`,
        ),
      ])
      // « Début du tricotage » is the one event that is not a stop; its accent
      // may arrive mangled, hence the tolerant match.
      const normaux = new Map<number, number>()
      for (const e of evts) {
        if (/^d.{1,2}but du tricotage/i.test(String(e.evenement).trim())) continue
        const pid = n(e.IDpiece_production)
        normaux.set(pid, (normaux.get(pid) ?? 0) + 1)
      }
      resultat = arretsParPiece(
        dernieres.map((p) => ({ ...p, evenementsNormaux: normaux.get(p.id) ?? 0 })),
        stops.map((s) => parseDtMs(s.date_evt)).filter((x): x is number => x !== null),
      )
    }
    cacheArretsParOf.set(ofId, { cle, resultat })
    out.set(ofId, resultat)
  }
  return out
}
