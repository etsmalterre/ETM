// TRS — the two read APIs of the workshop's TRS:
//
//   GET /api/trs/atelier   the wall tablet (TRM/apps/trs, host trs.intra.etsmalterre.com):
//                          the state of every live métier over the CURRENT
//                          shift — running / stopped and since when, the
//                          measured speed, the shift TRS, the arrêts par
//                          pièce — laid on the floor plan by the client,
//                          plus the band's two figures (LIVA #1194): the kg
//                          the shift has produced and who is clocked in.
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
import { isEffectiveAdmin } from '../lib/auth.js'
import { trmUserHasPermission } from '../lib/permissions-trm.js'
import { resolveColorisEcru, resolveEcruRefs } from '../lib/production-trm.js'
import {
  ARRETS_PIECES,
  calculerTrs,
  equipeCourante,
  equipeDepuisLiteral,
  etatCourant,
  toHfsqlDt,
  type ArretsParPiece,
} from '../lib/trs-trm.js'
import {
  chargerBandeau,
  chargerBase,
  chargerEquipe,
  type BandeauEquipe,
  type OfRow,
  type TrsEquipePayload,
} from '../lib/trs-equipe-trm.js'
import { arretsParPieceDesOfs } from '../lib/arrets-par-piece-trm.js'

export const trsRouter: RouterType = Router()


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

/** The wire shape of GET /api/trs/atelier — mirrored by `TrsAtelier` in
 *  TRM/apps/trs/src/lib/trs-api.ts; keep the two in step. */
export interface TrsAtelierPayload {
  generatedAt: string
  equipe: { nom: string; debut: string; fin: string }
  dernierEvenement: string | null
  parc: { trs: number | null; enMarche: number; arret: number; inactifs: number }
  production: BandeauEquipe['production']
  enPoste: BandeauEquipe['enPoste']
  machines: TrsMachine[]
}

trsRouter.get('/atelier', async (_req: Request, res: Response) => {
  try {
    const nowMs = Date.now()
    const equipe = equipeCourante(nowMs)
    const base = await chargerBase(equipe, nowMs)

    const actifs = Array.from(base.ofActifParMachine.values())
    const [refs, coloris, arretsParMachine, bandeau] = await Promise.all([
      resolveEcruRefs(actifs.map((o) => o.refId)),
      resolveColorisEcru(actifs.map((o) => o.coloriId)),
      arretsDesOfsActifs(base.ofActifParMachine),
      chargerBandeau(equipe, nowMs),
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
      /** The band's kg: the ERP's « Production » card for this shift
       *  (lib/trs-equipe-trm.ts chargerBandeau). */
      production: bandeau.production,
      /** Who is clocked in right now, earliest arrival first. */
      enPoste: bandeau.enPoste,
      machines: payload,
    } satisfies TrsAtelierPayload)
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

// ── Arrêts par pièce of the active OFs (tablet only) ──
//
// The reader and its per-OF cache live in lib/arrets-par-piece-trm.ts since
// 2026-09-14, shared with the régleur's machine list in the Atelier PWA so
// the wall and the phone show the same number. Keyed here by métier, as the
// plan du parc is.
async function arretsDesOfsActifs(ofActifParMachine: Map<number, OfRow>): Promise<Map<number, ArretsParPiece>> {
  const parOf = await arretsParPieceDesOfs(
    Array.from(ofActifParMachine, ([machineId, o]) => ({ ofId: o.id, machineId })),
  )
  const out = new Map<number, ArretsParPiece>()
  for (const [mid, o] of ofActifParMachine) out.set(mid, parOf.get(o.id) ?? { moyenne: null, pieces: 0 })
  return out
}
