// TRS — the workshop tablet's read API (TRM/apps/trs, host trs.malterre).
//
// One endpoint, polled every few seconds by a wall screen: the state of every
// live métier over the CURRENT shift — running / stopped and since when, the
// measured speed, the shift TRS, the arrêt count — laid on the floor plan by
// the client. Port of the legacy WinDev `Appli_TRS` (FEN_Main_App_TRS.wdw,
// PCS-compressed: only its procedure names survive — MappingAdresseAutomate,
// NombreArrets, TRSEquipeEnCours, MAJAffichage). The formula comes from the
// FI_TRS timeline procedure the user supplied; it lives in lib/trs-trm.ts
// with its tests, and this file only feeds it rows.
//
// Reads ONLY. `evenement_machine` has exactly one writer (the recorder —
// routes/recorder.ts) and this screen never touches it. No permission guard
// either: a passive read-only wall display with no per-person identity, on
// the same footing as consulting the visitage poste. The tables involved
// carry no IDsociete (the métiers ARE Tricotage Malterre).
//
// Driver discipline, all inherited from the sibling routes:
//   - `DATE` is reserved on evenement_machine / evenement_piece → always
//     `DATE AS date_evt`, literals as 'YYYYMMDDHHMMSS'.
//   - `machine.archivé` is accented → selectMachines() + filter in JS.
//   - `asso_fil_matiere.IDMatière` is accented → SELECT * on the (small)
//     table and fold keys with rawGet(), never name it in a WHERE.
//   - `arret_prod` reads NULL on Windows and may read '' on the bridge →
//     parseDtMs() decides, not the SQL.
//   - « Début du tricotage » carries an accent → `LIKE 'D%but du tricotage'`
//     so the literal never has to match the driver's encoding.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { query } from '../lib/hfsql-auto.js'
import {
  selectMachines,
  parseDtMs,
  rawGet,
  resolveEcruRefs,
  resolveColorisEcru,
} from '../lib/production-trm.js'
import {
  ARRETS_PIECES,
  arretsParPiece,
  calculerTrs,
  equipeCourante,
  etatCourant,
  toHfsqlDt,
  type ArretsParPiece,
  type EvenementMachine,
  type EvenementPiece,
  type Fenetre,
} from '../lib/trs-trm.js'

export const trsRouter: RouterType = Router()

const n = (v: unknown): number => Number(v) || 0

// ── The state before the shift, cached per shift ──────────
//
// The walk needs to know whether each métier was running at 05:00 (or 13:00,
// 21:00). That is the last event BEFORE the shift — one indexed `TOP 1` per
// métier, 30 small queries — and it cannot change once the shift has begun,
// so it is fetched once per shift and kept. Without the cache a 10 s poll
// would re-issue those 30 queries every time for an answer that is constant.

interface EtatInitial { etat: 0 | 1; atMs: number | null }
let cacheEtatsInitiaux: { debutMs: number; etats: Map<number, EtatInitial | null> } | null = null

async function etatsInitiaux(machineIds: number[], debutMs: number): Promise<Map<number, EtatInitial | null>> {
  if (cacheEtatsInitiaux && cacheEtatsInitiaux.debutMs === debutMs) {
    const missing = machineIds.filter((id) => !cacheEtatsInitiaux!.etats.has(id))
    if (missing.length === 0) return cacheEtatsInitiaux.etats
  }
  const etats = cacheEtatsInitiaux?.debutMs === debutMs ? cacheEtatsInitiaux.etats : new Map<number, EtatInitial | null>()
  const lit = toHfsqlDt(debutMs)
  for (const id of machineIds) {
    if (etats.has(id)) continue
    const rows = await query<{ etat: number; date_evt: unknown }>(
      `SELECT TOP 1 etat, DATE AS date_evt FROM evenement_machine
       WHERE IDmachine = ${id} AND DATE < '${lit}' ORDER BY DATE DESC`,
    )
    etats.set(
      id,
      rows.length > 0 ? { etat: n(rows[0].etat) === 1 ? 1 : 0, atMs: parseDtMs(rows[0].date_evt) } : null,
    )
  }
  cacheEtatsInitiaux = { debutMs, etats }
  return etats
}

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
    const debutLit = toHfsqlDt(equipe.debutMs)

    const machines = (await selectMachines()).filter((m) => m.archive === 0)
    const machineIds = machines.map((m) => m.id)

    const [evRows, ofRows, pieceEvRows, initiaux] = await Promise.all([
      query<{ IDmachine: number; date_evt: unknown; etat: number }>(
        `SELECT IDmachine, DATE AS date_evt, etat FROM evenement_machine
         WHERE DATE >= '${debutLit}' ORDER BY DATE ASC`,
      ),
      // Every OF that can have a window inside the shift: still open (running
      // or interrupted), or closed after the shift began. `demarrage_prod`
      // is not bounded on purpose — a running OF may have started in January.
      query<Record<string, unknown>>(
        `SELECT IDordre_fabrication, IDmachine, est_actif, demarrage_prod, arret_prod,
                vitesse, IDref_ecru, IDcolori_ecru
         FROM ordre_fabrication
         WHERE est_termine = 0 OR arret_prod >= '${debutLit}'`,
      ),
      query<{ IDevenement_piece: number; evenement: string; date_evt: unknown; IDpiece_production: number }>(
        `SELECT IDevenement_piece, evenement, DATE AS date_evt, IDpiece_production
         FROM evenement_piece
         WHERE DATE >= '${debutLit}'
           AND (evenement = 'Nettoyage' OR evenement LIKE 'D%but du tricotage')`,
      ),
      etatsInitiaux(machineIds, equipe.debutMs),
    ])

    // Machine events, grouped.
    const evParMachine = new Map<number, EvenementMachine[]>()
    let dernierEvenementMs: number | null = null
    for (const r of evRows) {
      const atMs = parseDtMs(r.date_evt)
      if (atMs === null) continue
      const id = n(r.IDmachine)
      if (!evParMachine.has(id)) evParMachine.set(id, [])
      evParMachine.get(id)!.push({ atMs, etat: n(r.etat) === 1 ? 1 : 0 })
      if (dernierEvenementMs === null || atMs > dernierEvenementMs) dernierEvenementMs = atMs
    }
    if (dernierEvenementMs === null) {
      for (const e of initiaux.values()) {
        if (e?.atMs !== null && e?.atMs !== undefined && (dernierEvenementMs === null || e.atMs > dernierEvenementMs)) {
          dernierEvenementMs = e.atMs
        }
      }
    }

    // OF windows per machine, and the active OF per machine for the label.
    const fenetresParMachine = new Map<number, Fenetre[]>()
    const machineParOf = new Map<number, number>()
    const ofActifParMachine = new Map<number, Record<string, unknown>>()
    for (const o of ofRows) {
      const ofId = n(o.IDordre_fabrication)
      const mid = n(o.IDmachine)
      machineParOf.set(ofId, mid)
      const debutMs = parseDtMs(o.demarrage_prod)
      if (debutMs !== null) {
        if (!fenetresParMachine.has(mid)) fenetresParMachine.set(mid, [])
        fenetresParMachine.get(mid)!.push({ debutMs, finMs: parseDtMs(o.arret_prod) })
      }
      if (n(o.est_actif) === 1) ofActifParMachine.set(mid, o)
    }

    // Piece events → their OF (through piece_production) → machine, plus the
    // lycra flag of each OF concerned.
    const pieceIds = Array.from(new Set(pieceEvRows.map((r) => n(r.IDpiece_production)).filter((x) => x > 0)))
    const pieces = new Map<number, { numero: number; ofId: number }>()
    if (pieceIds.length > 0) {
      const rows = await query<{ IDpiece_production: number; numero: number; IDordre_fabrication: number }>(
        `SELECT IDpiece_production, numero, IDordre_fabrication FROM piece_production
         WHERE IDpiece_production IN (${pieceIds.join(',')})`,
      )
      for (const r of rows) pieces.set(n(r.IDpiece_production), { numero: n(r.numero), ofId: n(r.IDordre_fabrication) })
    }
    const ofIdsPieces = Array.from(new Set(Array.from(pieces.values()).map((p) => p.ofId).filter((x) => x > 0)))
    // An OF that ended before the shift but whose piece event is dated inside
    // it cannot exist, but an OF terminated inside the shift is already in
    // ofRows; anything still unknown gets its machine resolved here.
    const inconnus = ofIdsPieces.filter((id) => !machineParOf.has(id))
    if (inconnus.length > 0) {
      const rows = await query<{ IDordre_fabrication: number; IDmachine: number }>(
        `SELECT IDordre_fabrication, IDmachine FROM ordre_fabrication
         WHERE IDordre_fabrication IN (${inconnus.join(',')})`,
      )
      for (const r of rows) machineParOf.set(n(r.IDordre_fabrication), n(r.IDmachine))
    }
    const [lycraParOf, arretsParMachine] = await Promise.all([
      ofsAvecLycra(ofIdsPieces),
      arretsDesOfsActifs(ofActifParMachine),
    ])

    const pieceEvParMachine = new Map<number, EvenementPiece[]>()
    for (const r of pieceEvRows) {
      const atMs = parseDtMs(r.date_evt)
      const piece = pieces.get(n(r.IDpiece_production))
      if (atMs === null || !piece) continue
      const mid = machineParOf.get(piece.ofId)
      if (!mid) continue
      if (!pieceEvParMachine.has(mid)) pieceEvParMachine.set(mid, [])
      pieceEvParMachine.get(mid)!.push({
        atMs,
        type: String(r.evenement).trim() === 'Nettoyage' ? 'nettoyage' : 'debut_piece',
        numero: piece.numero,
        lycra: lycraParOf.has(piece.ofId),
      })
    }

    // Labels of the active OFs.
    const actifs = Array.from(ofActifParMachine.values())
    const [refs, coloris] = await Promise.all([
      resolveEcruRefs(actifs.map((o) => n(o.IDref_ecru))),
      resolveColorisEcru(actifs.map((o) => n(o.IDcolori_ecru))),
    ])

    let sommeMarcheS = 0
    let sommeProdMaxS = 0
    const payload: TrsMachine[] = machines.map((m) => {
      const evenements = evParMachine.get(m.id) ?? []
      const initial = initiaux.get(m.id) ?? null
      const r = calculerTrs({
        equipe,
        nowMs,
        etatInitial: initial ? initial.etat : null,
        evenements,
        fenetres: fenetresParMachine.get(m.id) ?? [],
        evenementsPiece: pieceEvParMachine.get(m.id) ?? [],
      })
      if (r.trs !== null) {
        sommeMarcheS += r.tempsMarcheS
        sommeProdMaxS += r.tempsProdS - r.deductibleS
      }
      const courant = etatCourant(evenements, initial)
      const o = ofActifParMachine.get(m.id)
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
              id: n(o.IDordre_fabrication),
              reference: refs.get(n(o.IDref_ecru))?.reference ?? '',
              coloris: coloris.get(n(o.IDcolori_ecru)) ?? '',
              vitesse: n(o.vitesse),
              vitesseCible: refs.get(n(o.IDref_ecru))?.vitesse_cible ?? 0,
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
      dernierEvenement: dernierEvenementMs === null ? null : new Date(dernierEvenementMs).toISOString(),
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

// ── Arrêts par pièce of the active OFs, cached per OF ──────
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

async function arretsDesOfsActifs(
  ofActifParMachine: Map<number, Record<string, unknown>>,
): Promise<Map<number, ArretsParPiece>> {
  const out = new Map<number, ArretsParPiece>()
  const ofIds = Array.from(ofActifParMachine.values())
    .map((o) => n(o.IDordre_fabrication))
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
    const ofId = n(o.IDordre_fabrication)
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

/** OF ids whose composition carries élasthanne — the legacy's
 *  `asso_fil_matiere.IDMatière IN (4, 13)` over `asso_fil_of.IDref_fil`. The
 *  matière column is accented, so the (small) table is read whole and folded. */
async function ofsAvecLycra(ofIds: number[]): Promise<Set<number>> {
  const out = new Set<number>()
  if (ofIds.length === 0) return out
  const compo = await query<{ IDordre_fabrication: number; IDref_fil: number }>(
    `SELECT IDordre_fabrication, IDref_fil FROM asso_fil_of
     WHERE IDordre_fabrication IN (${ofIds.join(',')})`,
  )
  const refFils = new Set(compo.map((c) => n(c.IDref_fil)))
  if (refFils.size === 0) return out
  const matieres = await query<Record<string, unknown>>('SELECT * FROM asso_fil_matiere')
  const filsLycra = new Set<number>()
  for (const r of matieres) {
    const mat = n(rawGet(r, /^IDmati/i))
    const fil = n(rawGet(r, /^IDref_fil$/i))
    if ((mat === 4 || mat === 13) && refFils.has(fil)) filsLycra.add(fil)
  }
  for (const c of compo) if (filsLycra.has(n(c.IDref_fil))) out.add(n(c.IDordre_fabrication))
  return out
}
