// TRS — the two read APIs of the workshop's TRS:
//
//   GET /api/trs/atelier   the wall tablet (TRM/apps/trs, host trs.malterre):
//                          the state of every live métier over the CURRENT
//                          shift — running / stopped and since when, the
//                          measured speed, the shift TRS, the arrêts par
//                          pièce — laid on the floor plan by the client.
//                          Polled every few seconds. Port of the legacy
//                          `Appli_TRS` (FEN_Main_App_TRS.wdw).
//   GET /api/trs/equipe    the ERP screen Production › TRS (TRM/apps/web):
//                          ANY shift — the per-métier timeline, the four KPI
//                          cards, the piece lists with their event cards and
//                          the bonnetiers clocked in. Port of the legacy
//                          `FI_TRS.wdw`, recovered from its compile cache.
//
// The formula is the FI_TRS timeline procedure (lib/trs-trm.ts, tested); the
// loading is shared (lib/trs-equipe-trm.ts) so the tablet and the ERP can
// never disagree on a métier's TRS.
//
// Reads ONLY. `evenement_machine` has exactly one writer (the recorder —
// routes/recorder.ts) and neither screen touches it. The tables involved
// carry no IDsociete (the métiers ARE Tricotage Malterre).
//
// Permissions: /atelier has NO guard — a passive read-only wall display with
// no per-person identity, on the same footing as consulting the visitage
// poste. /equipe is behind `view_trs` (permission-keys-trm.ts): it names
// people and their hours, and the user chose to grant it by hand.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { query } from '../lib/hfsql-auto.js'
import { isEffectiveAdmin } from '../lib/auth.js'
import { trmUserHasPermission } from '../lib/permissions-trm.js'
import { parseDtMs, resolveColorisEcru, resolveEcruRefs } from '../lib/production-trm.js'
import {
  ARRETS_PIECES,
  arretsParPiece,
  calculerTrs,
  equipeCourante,
  equipeDepuisLiteral,
  etatCourant,
  toHfsqlDt,
  type ArretsParPiece,
} from '../lib/trs-trm.js'
import { chargerBase, chargerEquipe, type OfRow, type TrsEquipePayload } from '../lib/trs-equipe-trm.js'

export const trsRouter: RouterType = Router()

const n = (v: unknown): number => Number(v) || 0

// ── GET /api/trs/atelier ──────────────────────────────────

export interface TrsMachine {
  id: number
  /** `machine.emplacement` — the code painted on the floor (1A … 3K). */
  emplacement: string
  /** Machine state from the PLC log: 1 running, 0 stopped, null never recorded. */
  etat: 0 | 1 | null
  /** When that state began (epoch ms), null if unknown. */
  depuisMs: number | null
  /** `machine.vitesse` — the live measured speed the recorder writes, tr/min. */
  vitesse: number
  /** An OF window covers now. Off → the tile only shows its label. */
  enProduction: boolean
  of: {
    id: number
    reference: string
    coloris: string
    /** `ordre_fabrication.vitesse` — the recorder's running average. */
    vitesse: number
    /** `ref_ecru.vitesse_cible`. */
    vitesseCible: number
  } | null
  /** Shift TRS as a ratio (1 = 100 %), null when nothing to measure. */
  trs: number | null
  /** The tile's « arrêts » pill: mean « défaut » stops per piece over the
   *  last ARRETS_PIECES finished pieces of the active OF (lib/trs-trm.ts
   *  § Arrêts par pièce). Null until the OF has a finished piece. */
  arretsParPiece: number | null
  /** How many finished pieces that mean covers (0 … ARRETS_PIECES). */
  arretsPieces: number
  /** FI_TRS's shift count (stops net of piece events) — the figure the pill
   *  showed until 2026-08-28, kept for the record; not displayed. */
  arretsEquipe: number
  arretsParHeure: number
  tempsProdS: number
  tempsMarcheS: number
  deductibleS: number
}

trsRouter.get('/atelier', async (_req: Request, res: Response) => {
  try {
    const nowMs = Date.now()
    const equipe = equipeCourante(nowMs)
    const base = await chargerBase(equipe, nowMs)

    const actifs = Array.from(base.ofActifParMachine.values())
    const [refs, coloris, arretsParMachine] = await Promise.all([
      resolveEcruRefs(actifs.map((o) => o.refId)),
      resolveColorisEcru(actifs.map((o) => o.coloriId)),
      arretsDesOfsActifs(base.ofActifParMachine),
    ])

    let sommeMarcheS = 0
    let sommeProdMaxS = 0
    const payload: TrsMachine[] = base.machines.map((m) => {
      const evenements = base.evParMachine.get(m.id) ?? []
      const initial = base.initiaux.get(m.id) ?? null
      const r = calculerTrs({
        equipe,
        nowMs,
        etatInitial: initial ? initial.etat : null,
        evenements,
        fenetres: base.fenetresParMachine.get(m.id) ?? [],
        evenementsPiece: base.pieceEvParMachine.get(m.id) ?? [],
      })
      if (r.trs !== null) {
        sommeMarcheS += r.tempsMarcheS
        sommeProdMaxS += r.tempsProdS - r.deductibleS
      }
      const courant = etatCourant(evenements, initial)
      const o = base.ofActifParMachine.get(m.id)
      const a = arretsParMachine.get(m.id) ?? { moyenne: null, pieces: 0 }
      return {
        id: m.id,
        emplacement: m.emplacement || m.nom,
        etat: courant.etat,
        depuisMs: courant.depuisMs,
        vitesse: m.vitesse,
        enProduction: r.enProduction,
        of: o
          ? {
              id: o.id,
              reference: refs.get(o.refId)?.reference ?? '',
              coloris: coloris.get(o.coloriId) ?? '',
              vitesse: o.vitesse,
              vitesseCible: refs.get(o.refId)?.vitesse_cible ?? 0,
            }
          : null,
        trs: r.trs,
        arretsParPiece: a.moyenne,
        arretsPieces: a.pieces,
        arretsEquipe: r.arrets,
        arretsParHeure: r.arretsParHeure,
        tempsProdS: r.tempsProdS,
        tempsMarcheS: r.tempsMarcheS,
        deductibleS: r.deductibleS,
      }
    })

    res.json({
      generatedAt: new Date(nowMs).toISOString(),
      equipe: {
        nom: equipe.nom,
        debut: new Date(equipe.debutMs).toISOString(),
        fin: new Date(equipe.finMs).toISOString(),
      },
      /** Age of the newest transition in the whole parc — the only signal that
       *  the recorder is still writing (TRS/docs/recorder.md: nobody watches
       *  its heartbeat, and a silent PLC looks exactly like an idle workshop). */
      dernierEvenement: base.dernierEvenementMs === null ? null : new Date(base.dernierEvenementMs).toISOString(),
      parc: {
        /** Time-weighted shift TRS of the métiers in production. */
        trs: sommeProdMaxS > 0 ? sommeMarcheS / sommeProdMaxS : null,
        enMarche: payload.filter((m) => m.enProduction && m.etat === 1).length,
        arret: payload.filter((m) => m.enProduction && m.etat !== 1).length,
        inactifs: payload.filter((m) => !m.enProduction).length,
      },
      machines: payload,
    })
  } catch (err) {
    console.error('[trs] atelier failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /api/trs/equipe?debut=YYYYMMDDHHMMSS ──────────────
//
// The ERP shift dashboard. `debut` names the shift (a 05 / 13 / 21 h
// boundary, local time); absent → the current shift. A shift that is over
// no longer moves — except for a late weighing changing « Visitée le » —
// so past shifts are served from a short cache; the current shift is
// always recomputed (its initial states are cached underneath anyway).

async function requireViewTrs(req: Request, res: Response): Promise<boolean> {
  if (req.userId === undefined) {
    res.status(401).json({ error: 'not authenticated' })
    return false
  }
  const ok = await trmUserHasPermission(req.userId, isEffectiveAdmin(req), 'view_trs')
  if (!ok) res.status(403).json({ error: 'permission denied: view_trs' })
  return ok
}

const CACHE_EQUIPE_TTL_MS = 10 * 60_000
const CACHE_EQUIPE_MAX = 12
const cacheEquipes = new Map<string, { atMs: number; payload: TrsEquipePayload }>()

trsRouter.get('/equipe', async (req: Request, res: Response) => {
  if (!(await requireViewTrs(req, res))) return
  try {
    const nowMs = Date.now()
    const debut = req.query.debut === undefined ? '' : String(req.query.debut)
    const equipe = debut === '' ? equipeCourante(nowMs) : equipeDepuisLiteral(debut)
    if (!equipe) {
      res.status(400).json({ error: 'debut must be a shift start (YYYYMMDDHHMMSS at 05, 13 or 21 h)' })
      return
    }
    if (equipe.debutMs > nowMs) {
      res.status(400).json({ error: 'debut is in the future' })
      return
    }
    const passee = equipe.finMs <= nowMs
    const cle = toHfsqlDt(equipe.debutMs)
    if (passee) {
      const hit = cacheEquipes.get(cle)
      if (hit && nowMs - hit.atMs < CACHE_EQUIPE_TTL_MS) {
        res.json(hit.payload)
        return
      }
    }
    const payload = await chargerEquipe(equipe, nowMs)
    if (passee) {
      cacheEquipes.set(cle, { atMs: nowMs, payload })
      while (cacheEquipes.size > CACHE_EQUIPE_MAX) cacheEquipes.delete(cacheEquipes.keys().next().value!)
    }
    res.json(payload)
  } catch (err) {
    console.error('[trs] equipe failed:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── Arrêts par pièce of the active OFs, cached per OF (tablet only) ──
//
// The mean is over FINISHED pieces, so it can only change when a piece
// ends: keyed on (OF, ids of its last finished pieces) it is computed once
// per piece, not once per 10 s poll. Only the piece list is re-read each
// poll — one narrow query over the active OFs — and `date_fin` is judged by
// parseDtMs(), never in SQL (`<> ''` vs IS NULL differ across the drivers,
// see production-trm.ts awaitingPieces). The stop query is bounded to the
// span of those pieces and to the OF's machine, as the legacy joined it.

interface PieceRow {
  IDpiece_production: number
  IDordre_fabrication: number
  date_debut: unknown
  date_fin: unknown
}
const cacheArretsParOf = new Map<number, { cle: string; resultat: ArretsParPiece }>()

async function arretsDesOfsActifs(ofActifParMachine: Map<number, OfRow>): Promise<Map<number, ArretsParPiece>> {
  const out = new Map<number, ArretsParPiece>()
  const ofIds = Array.from(ofActifParMachine.values())
    .map((o) => o.id)
    .filter((x) => x > 0)
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

  for (const [mid, o] of ofActifParMachine) {
    const ofId = o.id
    const dernieres = (finiesParOf.get(ofId) ?? []).sort((a, b) => b.id - a.id).slice(0, ARRETS_PIECES)
    const cle = dernieres.map((p) => p.id).join(',')
    const hit = cacheArretsParOf.get(ofId)
    if (hit && hit.cle === cle) {
      out.set(mid, hit.resultat)
      continue
    }
    let resultat: ArretsParPiece = { moyenne: null, pieces: 0 }
    if (dernieres.length > 0) {
      const debutLit = toHfsqlDt(Math.min(...dernieres.map((p) => p.debutMs)))
      const finLit = toHfsqlDt(Math.max(...dernieres.map((p) => p.finMs)))
      const [stops, evts] = await Promise.all([
        query<{ date_evt: unknown }>(
          `SELECT DATE AS date_evt FROM evenement_machine
           WHERE IDmachine = ${mid} AND etat = 0 AND DATE > '${debutLit}' AND DATE < '${finLit}'`,
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
    out.set(mid, resultat)
  }
  return out
}
