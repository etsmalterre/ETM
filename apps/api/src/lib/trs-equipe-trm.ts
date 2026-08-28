// TRS — loading one shift of the workshop from HFSQL, for both TRS clients:
// the wall tablet (`GET /api/trs/atelier`, the current shift only) and the
// ERP screen Production › TRS (`GET /api/trs/equipe`, any shift). The pure
// arithmetic lives in lib/trs-trm.ts; this file only turns rows into its
// inputs and assembles the ERP payload.
//
// Everything is read ONCE for the whole parc, never per métier — the legacy
// FI_TRS issues four queries per métier plus one per piece event; a dense
// shift measured on 2025-10-15 (253 machine events, 58 piece events, 14 piece
// ends, 13 weighings) fits in a few KB, so a handful of shift-bounded reads
// resolved in JS is both faster and simpler.
//
// Driver discipline, inherited from routes/trs.ts and the sibling routes:
//   - `DATE` is reserved on evenement_machine / evenement_piece / pointage →
//     always `DATE AS date_x`, literals as 'YYYYMMDDHHMMSS' (toHfsqlDt).
//   - `machine.archivé`, `bonnetier.prénom/archivé` are accented →
//     selectMachines() / selectBonnetiers() (SELECT * + key folding).
//   - `asso_fil_matiere.IDMatière` is accented → SELECT * on the small table
//     and rawGet(), never name it in a WHERE.
//   - `arret_prod` / `date_fin` / `date_saisie` read NULL on Windows and may
//     read '' on the bridge → parseDtMs() decides, never the SQL.
//   - « Début du tricotage » carries an accent → `LIKE 'D%but du tricotage'`.
//   - `defaut_qualite.reference` is TEXT holding an id → selectDefauts()
//     quotes the IN list.
//   - IN lists are chunked (200) like selectDefauts — a shift never needs it,
//     the chunking is a guard, not a tuning.

import { query, fixEncoding } from './hfsql-auto.js'
import {
  parseDtMs,
  rawGet,
  resolveColorisEcru,
  resolveEcruRefs,
  selectBonnetiers,
  selectDefauts,
  selectMachines,
  type MachineRow,
} from './production-trm.js'
import {
  calculerTrs,
  equipeCourante,
  equipePrecedente,
  equipeSuivante,
  fenetresProduction,
  kpiEquipe,
  presenceEquipe,
  segmentsMachine,
  teinteArretsParHeure,
  teinteTrsFiTrs,
  teinteVitesseFiTrs,
  toHfsqlDt,
  type Equipe,
  type EvenementMachine,
  type EvenementPiece,
  type Fenetre,
  type Intervalle,
  type KpiEquipe,
  type Teinte,
  type TrsDetail,
} from './trs-trm.js'

const n = (v: unknown): number => Number(v) || 0
const H = 3_600_000

/** Run `fn` on 200-id slices and concatenate. */
async function parLots<T>(ids: number[], fn: (chunk: number[]) => Promise<T[]>): Promise<T[]> {
  const list = Array.from(new Set(ids.filter((x) => x > 0)))
  const out: T[] = []
  for (let i = 0; i < list.length; i += 200) out.push(...(await fn(list.slice(i, i + 200))))
  return out
}

// ── The state before the shift, cached per shift ──────────
//
// The walk needs to know whether each métier was running at 05:00 (or 13:00,
// 21:00): the last event BEFORE the shift. It cannot change once the shift
// has begun, so it is read once per shift and kept — a 10 s poll must not
// re-ask 30 questions with a constant answer, and browsing past shifts in
// the ERP must not evict the tablet's entry (hence a small map, not one
// slot). One bounded read covers the whole parc (the 48 h before the shift,
// last row per métier wins); only a métier silent for two days falls back to
// its own indexed `TOP 1`, which for a métier without a PLC answers "never"
// and is then cached like the others.

export interface EtatInitial { etat: 0 | 1; atMs: number | null }
const cacheEtats = new Map<number, Map<number, EtatInitial | null>>()
const CACHE_ETATS_MAX = 8

export async function etatsInitiaux(machineIds: number[], debutMs: number): Promise<Map<number, EtatInitial | null>> {
  let etats = cacheEtats.get(debutMs)
  if (etats && machineIds.every((id) => etats!.has(id))) return etats
  if (!etats) {
    etats = new Map()
    cacheEtats.set(debutMs, etats)
    while (cacheEtats.size > CACHE_ETATS_MAX) cacheEtats.delete(cacheEtats.keys().next().value!)
  }
  const missing = new Set(machineIds.filter((id) => !etats!.has(id)))
  if (missing.size === 0) return etats
  const lit = toHfsqlDt(debutMs)
  const rows = await query<{ IDmachine: number; date_evt: unknown; etat: number }>(
    `SELECT IDmachine, DATE AS date_evt, etat FROM evenement_machine
     WHERE DATE >= '${toHfsqlDt(debutMs - 48 * H)}' AND DATE < '${lit}' ORDER BY DATE ASC`,
  )
  for (const r of rows) {
    const id = n(r.IDmachine)
    if (!missing.has(id)) continue
    const atMs = parseDtMs(r.date_evt)
    if (atMs === null) continue
    etats.set(id, { etat: n(r.etat) === 1 ? 1 : 0, atMs }) // ascending → the last one stays
  }
  for (const id of missing) {
    if (etats.has(id)) continue
    const r = await query<{ etat: number; date_evt: unknown }>(
      `SELECT TOP 1 etat, DATE AS date_evt FROM evenement_machine
       WHERE IDmachine = ${id} AND DATE < '${lit}' ORDER BY DATE DESC`,
    )
    etats.set(id, r.length > 0 ? { etat: n(r[0].etat) === 1 ? 1 : 0, atMs: parseDtMs(r[0].date_evt) } : null)
  }
  return etats
}

// ── The base every TRS client needs ───────────────────────

export interface OfRow {
  id: number
  machineId: number
  estActif: boolean
  estTermine: boolean
  debutMs: number | null
  finMs: number | null
  /** `ordre_fabrication.vitesse` — the recorder's running average. */
  vitesse: number
  refId: number
  coloriId: number
}

/** A piece event of the shift, resolved to its piece, OF and author. */
export interface EvenementPieceBrut extends EvenementPiece {
  pieceId: number
  ofId: number
  bonnetierId: number
}

export interface BaseEquipe {
  equipe: Equipe
  nowMs: number
  /** min(now, shift end) — where every walk stops. */
  finEvalMs: number
  /** Living métiers, `archivé = 0`. */
  machines: MachineRow[]
  evParMachine: Map<number, EvenementMachine[]>
  initiaux: Map<number, EtatInitial | null>
  /** Newest transition in the whole parc, the recorder's only heartbeat. */
  dernierEvenementMs: number | null
  /** Every OF that can have a window inside the shift, by id. */
  ofParId: Map<number, OfRow>
  fenetresParMachine: Map<number, Fenetre[]>
  /** `est_actif = 1` — the OF running NOW, what the tablet labels. */
  ofActifParMachine: Map<number, OfRow>
  pieceEvParMachine: Map<number, EvenementPieceBrut[]>
}

function ofRow(o: Record<string, unknown>): OfRow {
  return {
    id: n(o.IDordre_fabrication),
    machineId: n(o.IDmachine),
    estActif: n(o.est_actif) === 1,
    estTermine: n(o.est_termine) === 1,
    debutMs: parseDtMs(o.demarrage_prod),
    finMs: parseDtMs(o.arret_prod),
    vitesse: n(o.vitesse),
    refId: n(o.IDref_ecru),
    coloriId: n(o.IDcolori_ecru),
  }
}

const OF_COLS =
  'IDordre_fabrication, IDmachine, est_actif, est_termine, demarrage_prod, arret_prod, vitesse, IDref_ecru, IDcolori_ecru'

/** OFs by id, for ids the shift read did not cover (a piece whose OF ended
 *  before the shift cannot have an event inside it, but be safe). */
async function chargerOfs(ids: number[], connus: Map<number, OfRow>): Promise<void> {
  const rows = await parLots(
    ids.filter((id) => !connus.has(id)),
    (chunk) => query<Record<string, unknown>>(`SELECT ${OF_COLS} FROM ordre_fabrication WHERE IDordre_fabrication IN (${chunk.join(',')})`),
  )
  for (const r of rows) connus.set(n(r.IDordre_fabrication), ofRow(r))
}

/** OF ids whose composition carries élasthanne — the legacy's
 *  `asso_fil_matiere.IDMatière IN (4, 13)` over `asso_fil_of.IDref_fil`. The
 *  matière column is accented, so the (small) table is read whole and folded. */
export async function ofsAvecLycra(ofIds: number[]): Promise<Set<number>> {
  const out = new Set<number>()
  const compo = await parLots(ofIds, (chunk) =>
    query<{ IDordre_fabrication: number; IDref_fil: number }>(
      `SELECT IDordre_fabrication, IDref_fil FROM asso_fil_of WHERE IDordre_fabrication IN (${chunk.join(',')})`,
    ),
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

export async function chargerBase(equipe: Equipe, nowMs: number): Promise<BaseEquipe> {
  const finEvalMs = Math.min(nowMs, equipe.finMs)
  const debutLit = toHfsqlDt(equipe.debutMs)
  const finLit = toHfsqlDt(equipe.finMs)

  const machines = (await selectMachines()).filter((m) => m.archive === 0)
  const machineIds = machines.map((m) => m.id)

  const [evRows, ofRows, pieceEvRows, initiaux] = await Promise.all([
    query<{ IDmachine: number; date_evt: unknown; etat: number }>(
      `SELECT IDmachine, DATE AS date_evt, etat FROM evenement_machine
       WHERE DATE >= '${debutLit}' AND DATE <= '${finLit}' ORDER BY DATE ASC`,
    ),
    // Every OF that can have a window inside the shift: still open (running
    // or interrupted) or closed after the shift began, and started before it
    // ended. `demarrage_prod` has no lower bound on purpose — a running OF
    // may have started months ago.
    query<Record<string, unknown>>(
      `SELECT ${OF_COLS} FROM ordre_fabrication
       WHERE (est_termine = 0 OR arret_prod >= '${debutLit}') AND demarrage_prod < '${finLit}'`,
    ),
    query<{ evenement: string; date_evt: unknown; IDpiece_production: number; IDbonnetier: number }>(
      `SELECT evenement, DATE AS date_evt, IDpiece_production, IDbonnetier FROM evenement_piece
       WHERE DATE >= '${debutLit}' AND DATE <= '${finLit}'
         AND (evenement = 'Nettoyage' OR evenement LIKE 'D%but du tricotage')`,
    ),
    etatsInitiaux(machineIds, equipe.debutMs),
  ])

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
      if (e?.atMs != null && (dernierEvenementMs === null || e.atMs > dernierEvenementMs)) dernierEvenementMs = e.atMs
    }
  }

  const ofParId = new Map<number, OfRow>()
  const fenetresParMachine = new Map<number, Fenetre[]>()
  const ofActifParMachine = new Map<number, OfRow>()
  for (const raw of ofRows) {
    const o = ofRow(raw)
    ofParId.set(o.id, o)
    if (o.debutMs !== null) {
      if (!fenetresParMachine.has(o.machineId)) fenetresParMachine.set(o.machineId, [])
      fenetresParMachine.get(o.machineId)!.push({ debutMs: o.debutMs, finMs: o.finMs })
    }
    if (o.estActif) ofActifParMachine.set(o.machineId, o)
  }

  // Piece events → their piece (numero, OF) → machine, plus the lycra flag.
  const pieceIds = pieceEvRows.map((r) => n(r.IDpiece_production))
  const pieces = new Map<number, { numero: number; ofId: number }>()
  const pieceRows = await parLots(pieceIds, (chunk) =>
    query<{ IDpiece_production: number; numero: number; IDordre_fabrication: number }>(
      `SELECT IDpiece_production, numero, IDordre_fabrication FROM piece_production
       WHERE IDpiece_production IN (${chunk.join(',')})`,
    ),
  )
  for (const r of pieceRows) pieces.set(n(r.IDpiece_production), { numero: n(r.numero), ofId: n(r.IDordre_fabrication) })
  const ofIdsPieces = Array.from(new Set(Array.from(pieces.values()).map((p) => p.ofId)))
  await chargerOfs(ofIdsPieces, ofParId)
  const lycraParOf = await ofsAvecLycra(ofIdsPieces)

  const pieceEvParMachine = new Map<number, EvenementPieceBrut[]>()
  for (const r of pieceEvRows) {
    const atMs = parseDtMs(r.date_evt)
    const pieceId = n(r.IDpiece_production)
    const piece = pieces.get(pieceId)
    if (atMs === null || !piece) continue
    const mid = ofParId.get(piece.ofId)?.machineId
    if (!mid) continue
    if (!pieceEvParMachine.has(mid)) pieceEvParMachine.set(mid, [])
    pieceEvParMachine.get(mid)!.push({
      atMs,
      type: String(r.evenement).trim() === 'Nettoyage' ? 'nettoyage' : 'debut_piece',
      numero: piece.numero,
      lycra: lycraParOf.has(piece.ofId),
      pieceId,
      ofId: piece.ofId,
      bonnetierId: n(r.IDbonnetier),
    })
  }

  return {
    equipe, nowMs, finEvalMs, machines, evParMachine, initiaux, dernierEvenementMs,
    ofParId, fenetresParMachine, ofActifParMachine, pieceEvParMachine,
  }
}

// ── The ERP payload — Production › TRS ────────────────────

export interface EvenementTimeline {
  atMs: number
  /** `debut_of` = « Début du tricotage » of piece n° 1 (the launch, black in
   *  the legacy); `fin_of` = `arret_prod` of an OF terminated in the shift. */
  type: 'nettoyage' | 'debut_piece' | 'debut_of' | 'fin_of'
  numero: number | null
  prenom: string
  bonnetierId: number
  ofId: number
  pieceId: number | null
}

export interface MachineEquipe {
  id: number
  emplacement: string
  /** No PLC log at all for this métier (never recorded, nothing in the shift). */
  sansAutomate: boolean
  /** The OF of the shift — the last one whose window overlaps it. */
  of: { id: number; reference: string; coloris: string; vitesse: number; vitesseCible: number } | null
  /** Production windows clipped to the evaluated shift (union). */
  fenetres: Intervalle[]
  segments: { debutMs: number; finMs: number; etat: 0 | 1 }[]
  evenements: EvenementTimeline[]
  trs: number | null
  arrets: number
  arretsParHeure: number
  tempsProdS: number
  tempsMarcheS: number
  deductibleS: number
  detail: TrsDetail
  /** The legacy ZR_TRS colours. `trs` null = nothing to measure. */
  teintes: { vitesse: Teinte; arrets: Teinte; trs: Teinte | null }
}

export interface LignePiece {
  /** `pp:<IDpiece_production>` or `se:<IDstock_ecru>` — the key of `evenements`. */
  cle: string
  id: number
  machine: string
  /** « 3554/48 » — the roll's `numero`, or OF/n° for a piece. */
  numero: string
  poids: number
  /** « 029 - ecru » */
  reference: string
  finMs: number | null
  visiteeMs: number | null
  secondChoix: boolean
  ofId: number
}

/** One card of the legacy ZR_Detail: an `evenement_piece` row, or a
 *  `defaut_qualite` row rendered as « Défaut ». Same shape as the web's
 *  `PieceEvent` (components/shared/PieceEvents.tsx). */
export interface EvenementCarte {
  id: string
  date: string | null
  evenement: string
  observation: string
  IDbonnetier: number
  bonnetier: string
}

export interface BonnetierEquipe {
  id: number
  prenom: string
  nom: string
  regleur: boolean
  intervalles: Intervalle[]
  pauses: Intervalle[]
  dureeS: number
}

export interface TrsEquipePayload {
  generatedAt: string
  equipe: {
    nom: Equipe['nom']
    debut: string
    fin: string
    debutLit: string
    enCours: boolean
    /** The shift is over (fin ≤ now): its figures no longer move. */
    passee: boolean
    precedentLit: string
    /** Null on the current shift — the future has no production. */
    suivantLit: string | null
  }
  kpi: KpiEquipe
  parc: { trs: number | null }
  machines: MachineEquipe[]
  pieces: {
    production: LignePiece[]
    visitage: LignePiece[]
    secondChoix: LignePiece[]
    nonVisitees: LignePiece[]
  }
  evenements: Record<string, EvenementCarte[]>
  equipeBonnetiers: { rows: BonnetierEquipe[]; totalS: number }
  dernierEvenement: string | null
}

interface PieceProdRow {
  IDpiece_production: number
  IDordre_fabrication: number
  numero: number
  poids: number
  date_fin: unknown
}
interface StockEcruRow {
  IDstock_ecru: number
  IDpiece_production: number
  IDordre_fabrication: number
  numero: string
  poids: number
  second_choix: number
  date_saisie: unknown
  IDref_ecru: number
  IDcolori_ecru: number
}
const SE_COLS =
  'IDstock_ecru, IDpiece_production, IDordre_fabrication, numero, poids, second_choix, date_saisie, IDref_ecru, IDcolori_ecru'

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

export async function chargerEquipe(equipe: Equipe, nowMs: number): Promise<TrsEquipePayload> {
  const base = await chargerBase(equipe, nowMs)
  const { finEvalMs } = base
  const debutLit = toHfsqlDt(equipe.debutMs)
  const finLit = toHfsqlDt(equipe.finMs)

  const [pieceRows, rollRows, pointageRows, bonnetiers] = await Promise.all([
    // KPI « Production » / « Non visitées »: pieces finished inside ]debut, fin].
    query<PieceProdRow>(
      `SELECT IDpiece_production, IDordre_fabrication, numero, poids, date_fin FROM piece_production
       WHERE date_fin > '${debutLit}' AND date_fin <= '${finLit}'`,
    ),
    // KPI « Visitage » / « Second choix »: rolls weighed inside ]debut, fin].
    query<StockEcruRow>(
      `SELECT ${SE_COLS} FROM stock_ecru WHERE date_saisie > '${debutLit}' AND date_saisie <= '${finLit}'`,
    ),
    // ZR_Equipe: the day before sets the opening state, then the shift.
    query<{ IDbonnetier: number; date_pt: unknown; en_poste: number }>(
      `SELECT IDbonnetier, DATE AS date_pt, en_poste FROM pointage
       WHERE DATE >= '${toHfsqlDt(equipe.debutMs - 24 * H)}' AND DATE <= '${toHfsqlDt(finEvalMs)}' ORDER BY DATE ASC`,
    ),
    selectBonnetiers(),
  ])

  // The rolls of the shift's pieces (« Visitée le », and their events), merged
  // with the rolls weighed in the shift.
  const rolls = new Map<number, StockEcruRow>()
  for (const r of rollRows) rolls.set(n(r.IDstock_ecru), r)
  const rollsOfPieces = await parLots(
    pieceRows.map((p) => n(p.IDpiece_production)),
    (chunk) => query<StockEcruRow>(`SELECT ${SE_COLS} FROM stock_ecru WHERE IDpiece_production IN (${chunk.join(',')})`),
  )
  for (const r of rollsOfPieces) if (!rolls.has(n(r.IDstock_ecru))) rolls.set(n(r.IDstock_ecru), r)

  // Every OF the lists refer to, then the labels.
  await chargerOfs(
    [...pieceRows.map((p) => n(p.IDordre_fabrication)), ...Array.from(rolls.values()).map((r) => n(r.IDordre_fabrication))],
    base.ofParId,
  )
  const machineParId = new Map(base.machines.map((m) => [m.id, m]))
  const emplacement = (mid: number) => {
    const m = machineParId.get(mid)
    return m ? m.emplacement || m.nom : ''
  }

  // Pistes: the métiers with an OF window inside the shift (the legacy
  // reqMachine), in emplacement order.
  const pistes = base.machines
    .filter((m) => fenetresProduction(base.fenetresParMachine.get(m.id) ?? [], equipe.debutMs, finEvalMs).length > 0)
    .sort((a, b) => (a.emplacement || a.nom).localeCompare(b.emplacement || b.nom, 'fr'))
  const ofDeLEquipe = new Map<number, OfRow>()
  for (const o of base.ofParId.values()) {
    if (o.debutMs === null || o.debutMs >= finEvalMs || (o.finMs !== null && o.finMs <= equipe.debutMs)) continue
    const cur = ofDeLEquipe.get(o.machineId)
    if (!cur || (cur.debutMs ?? 0) < o.debutMs) ofDeLEquipe.set(o.machineId, o)
  }

  const refIds = new Set<number>()
  const coloriIds = new Set<number>()
  for (const o of ofDeLEquipe.values()) { refIds.add(o.refId); coloriIds.add(o.coloriId) }
  for (const p of pieceRows) { const o = base.ofParId.get(n(p.IDordre_fabrication)); if (o) { refIds.add(o.refId); coloriIds.add(o.coloriId) } }
  for (const r of rolls.values()) { refIds.add(n(r.IDref_ecru)); coloriIds.add(n(r.IDcolori_ecru)) }
  const [refs, coloris] = await Promise.all([resolveEcruRefs(Array.from(refIds)), resolveColorisEcru(Array.from(coloriIds))])
  const libelle = (refId: number, coloriId: number) => {
    const ref = refs.get(refId)?.reference ?? ''
    const col = coloris.get(coloriId) ?? ''
    return [ref, col].filter(Boolean).join(' - ')
  }

  const bonnetierParId = new Map(bonnetiers.map((b) => [b.id, b]))
  const prenomDe = (id: number) => bonnetierParId.get(id)?.prenom ?? ''
  const nomComplet = (id: number) => {
    const b = bonnetierParId.get(id)
    return b ? [b.prenom, b.nom].filter(Boolean).join(' ') : ''
  }

  // ── Machines ──
  let sommeMarcheS = 0
  let sommeProdMaxS = 0
  const machines: MachineEquipe[] = pistes.map((m) => {
    const evenements = base.evParMachine.get(m.id) ?? []
    const initial = base.initiaux.get(m.id) ?? null
    const pieceEv = base.pieceEvParMachine.get(m.id) ?? []
    const entree = {
      equipe, nowMs, etatInitial: initial ? initial.etat : null, evenements,
      fenetres: base.fenetresParMachine.get(m.id) ?? [], evenementsPiece: pieceEv,
    }
    const r = calculerTrs(entree)
    if (r.trs !== null) {
      sommeMarcheS += r.tempsMarcheS
      sommeProdMaxS += r.tempsProdS - r.deductibleS
    }
    const evTimeline: EvenementTimeline[] = pieceEv
      .filter((e) => e.atMs >= equipe.debutMs && e.atMs <= finEvalMs)
      .map((e) => ({
        atMs: e.atMs,
        type: e.type === 'nettoyage' ? 'nettoyage' : e.numero === 1 ? 'debut_of' : 'debut_piece',
        numero: e.numero,
        prenom: prenomDe(e.bonnetierId),
        bonnetierId: e.bonnetierId,
        ofId: e.ofId,
        pieceId: e.pieceId,
      }))
    for (const o of base.ofParId.values()) {
      if (o.machineId === m.id && o.estTermine && o.finMs !== null && o.finMs >= equipe.debutMs && o.finMs <= finEvalMs) {
        evTimeline.push({ atMs: o.finMs, type: 'fin_of', numero: null, prenom: '', bonnetierId: 0, ofId: o.id, pieceId: null })
      }
    }
    evTimeline.sort((a, b) => a.atMs - b.atMs)
    const o = ofDeLEquipe.get(m.id) ?? null
    const vitesse = o?.vitesse ?? 0
    return {
      id: m.id,
      emplacement: m.emplacement || m.nom,
      sansAutomate: initial === null && evenements.length === 0,
      of: o
        ? {
            id: o.id,
            reference: refs.get(o.refId)?.reference ?? '',
            coloris: coloris.get(o.coloriId) ?? '',
            vitesse,
            vitesseCible: refs.get(o.refId)?.vitesse_cible ?? 0,
          }
        : null,
      fenetres: fenetresProduction(entree.fenetres, equipe.debutMs, finEvalMs),
      segments: segmentsMachine(entree).map(({ debutMs, finMs, etat }) => ({ debutMs, finMs, etat })),
      evenements: evTimeline,
      trs: r.trs,
      arrets: r.arrets,
      arretsParHeure: r.arretsParHeure,
      tempsProdS: r.tempsProdS,
      tempsMarcheS: r.tempsMarcheS,
      deductibleS: r.deductibleS,
      detail: r.detail,
      teintes: {
        vitesse: teinteVitesseFiTrs(vitesse),
        arrets: teinteArretsParHeure(r.arretsParHeure),
        trs: r.trs === null ? null : teinteTrsFiTrs(r.trs),
      },
    }
  })

  // ── Pieces & rolls ──
  const rollsParPiece = new Map<number, StockEcruRow[]>()
  for (const r of rolls.values()) {
    const pid = n(r.IDpiece_production)
    if (!rollsParPiece.has(pid)) rollsParPiece.set(pid, [])
    rollsParPiece.get(pid)!.push(r)
  }
  const visiteeDe = (pieceId: number): number | null => {
    let out: number | null = null
    for (const r of rollsParPiece.get(pieceId) ?? []) {
      const ms = parseDtMs(r.date_saisie)
      if (ms !== null && (out === null || ms < out)) out = ms
    }
    return out
  }
  const lignesPieces: LignePiece[] = pieceRows
    .map((p) => {
      const ofId = n(p.IDordre_fabrication)
      const o = base.ofParId.get(ofId)
      return {
        cle: `pp:${n(p.IDpiece_production)}`,
        id: n(p.IDpiece_production),
        machine: o ? emplacement(o.machineId) : '',
        numero: `${ofId}/${n(p.numero)}`,
        poids: n(p.poids),
        reference: o ? libelle(o.refId, o.coloriId) : '',
        finMs: parseDtMs(p.date_fin),
        visiteeMs: visiteeDe(n(p.IDpiece_production)),
        secondChoix: false,
        ofId,
      }
    })
    .filter((p) => p.finMs !== null && p.finMs > equipe.debutMs && p.finMs <= equipe.finMs)
    .sort((a, b) => (a.finMs ?? 0) - (b.finMs ?? 0))
  const lignesRouleaux: LignePiece[] = Array.from(rolls.values())
    .map((r) => {
      const ofId = n(r.IDordre_fabrication)
      const o = base.ofParId.get(ofId)
      return {
        cle: `se:${n(r.IDstock_ecru)}`,
        id: n(r.IDstock_ecru),
        machine: o ? emplacement(o.machineId) : '',
        numero: String(r.numero ?? '').trim(),
        poids: n(r.poids),
        reference: libelle(n(r.IDref_ecru), n(r.IDcolori_ecru)),
        finMs: null,
        visiteeMs: parseDtMs(r.date_saisie),
        secondChoix: n(r.second_choix) === 1,
        ofId,
      }
    })
    .filter((r) => r.visiteeMs !== null && r.visiteeMs > equipe.debutMs && r.visiteeMs <= equipe.finMs)
    .sort((a, b) => (a.visiteeMs ?? 0) - (b.visiteeMs ?? 0))

  const kpi = kpiEquipe(
    lignesPieces.map((p) => ({ id: p.id, poidsNominal: p.poids, finMs: p.finMs!, visiteeMs: p.visiteeMs })),
    lignesRouleaux.map((r) => ({ id: r.id, poids: r.poids, secondChoix: r.secondChoix, saisieMs: r.visiteeMs! })),
    equipe,
    nowMs,
  )

  // ── Event cards (ZR_Detail): evenement_piece ∪ defaut_qualite ──
  const pieceIdsTous = Array.from(new Set([
    ...lignesPieces.map((p) => p.id),
    ...Array.from(rolls.values()).map((r) => n(r.IDpiece_production)),
  ])).filter((x) => x > 0)
  const rollIds = Array.from(rolls.keys())
  interface EvRaw { IDevenement_piece: number; evenement: string; IDbonnetier: number; observation: string; IDpiece_production: number; IDstock_ecru: number; date_evt: unknown }
  const evCols = 'IDevenement_piece, evenement, IDbonnetier, observation, IDpiece_production, IDstock_ecru, DATE AS date_evt'
  const [evParPiece, evParRoll, defPieces, defRolls] = await Promise.all([
    parLots(pieceIdsTous, (chunk) =>
      query<EvRaw>(`SELECT ${evCols} FROM evenement_piece WHERE IDpiece_production IN (${chunk.join(',')})`)),
    parLots(rollIds, (chunk) =>
      query<EvRaw>(`SELECT ${evCols} FROM evenement_piece WHERE IDstock_ecru IN (${chunk.join(',')})`)),
    selectDefauts(1, pieceIdsTous),
    selectDefauts(2, rollIds),
  ])
  const evRaw = new Map<number, EvRaw>()
  for (const e of [...evParPiece, ...evParRoll]) evRaw.set(n(e.IDevenement_piece), e)
  const evRows = await fixEncoding(Array.from(evRaw.values()), 'evenement_piece', 'IDevenement_piece', ['evenement', 'observation'])

  type Carte = EvenementCarte & { atMs: number; pieceId: number; rollId: number }
  const cartes: Carte[] = []
  for (const e of evRows) {
    const atMs = parseDtMs(e.date_evt)
    const bid = n(e.IDbonnetier)
    cartes.push({
      id: `ev:${n(e.IDevenement_piece)}`,
      date: iso(atMs),
      evenement: String(e.evenement ?? '').trim(),
      observation: String(e.observation ?? '').trim(),
      IDbonnetier: bid,
      bonnetier: nomComplet(bid),
      atMs: atMs ?? 0,
      pieceId: n(e.IDpiece_production),
      rollId: n(e.IDstock_ecru),
    })
  }
  for (const d of [...defPieces.map((d) => ({ ...d, kind: 1 as const })), ...defRolls.map((d) => ({ ...d, kind: 2 as const }))]) {
    cartes.push({
      id: `def:${d.id}`,
      date: iso(d.date_ms),
      evenement: 'Défaut',
      observation: d.description || d.type_defaut,
      IDbonnetier: d.id_spotteur,
      bonnetier: nomComplet(d.id_spotteur),
      atMs: d.date_ms ?? 0,
      pieceId: d.kind === 1 ? d.reference : 0,
      rollId: d.kind === 2 ? d.reference : 0,
    })
  }
  cartes.sort((a, b) => a.atMs - b.atMs)
  const pieceDuRoll = new Map<number, number>()
  for (const r of rolls.values()) pieceDuRoll.set(n(r.IDstock_ecru), n(r.IDpiece_production))
  const strip = ({ atMs: _a, pieceId: _p, rollId: _r, ...c }: Carte): EvenementCarte => c
  const evenements: Record<string, EvenementCarte[]> = {}
  for (const p of lignesPieces) {
    const rollsIds = new Set((rollsParPiece.get(p.id) ?? []).map((r) => n(r.IDstock_ecru)))
    evenements[p.cle] = cartes.filter((c) => c.pieceId === p.id || (c.rollId > 0 && rollsIds.has(c.rollId))).map(strip)
  }
  for (const r of lignesRouleaux) {
    const pid = pieceDuRoll.get(r.id) ?? 0
    evenements[r.cle] = cartes.filter((c) => c.rollId === r.id || (pid > 0 && c.pieceId === pid)).map(strip)
  }

  // ── Roster (ZR_Equipe) ──
  const presence = presenceEquipe(
    pointageRows
      .map((p) => ({ bonnetierId: n(p.IDbonnetier), atMs: parseDtMs(p.date_pt), enPoste: n(p.en_poste) === 1 }))
      .filter((p): p is { bonnetierId: number; atMs: number; enPoste: boolean } => p.atMs !== null),
    equipe.debutMs,
    finEvalMs,
  )
  const rows: BonnetierEquipe[] = presence.rows.map((r) => {
    const b = bonnetierParId.get(r.bonnetierId)
    return {
      id: r.bonnetierId,
      prenom: b?.prenom ?? '',
      nom: b?.nom ?? '',
      regleur: (b?.regleur ?? 0) === 1,
      intervalles: r.intervalles,
      pauses: r.pauses,
      dureeS: r.dureeS,
    }
  })

  const courante = equipeCourante(nowMs)
  const enCours = courante.debutMs === equipe.debutMs
  return {
    generatedAt: new Date(nowMs).toISOString(),
    equipe: {
      nom: equipe.nom,
      debut: new Date(equipe.debutMs).toISOString(),
      fin: new Date(equipe.finMs).toISOString(),
      debutLit,
      enCours,
      passee: equipe.finMs <= nowMs,
      precedentLit: toHfsqlDt(equipePrecedente(equipe).debutMs),
      suivantLit: enCours || equipe.debutMs > nowMs ? null : toHfsqlDt(equipeSuivante(equipe).debutMs),
    },
    kpi,
    parc: { trs: sommeProdMaxS > 0 ? sommeMarcheS / sommeProdMaxS : null },
    machines,
    pieces: {
      production: lignesPieces,
      visitage: lignesRouleaux,
      secondChoix: lignesRouleaux.filter((r) => r.secondChoix),
      nonVisitees: lignesPieces
        .filter((p) => p.visiteeMs === null || p.visiteeMs > equipe.finMs)
        .sort((a, b) => (b.finMs ?? 0) - (a.finMs ?? 0)),
    },
    evenements,
    equipeBonnetiers: { rows, totalS: presence.totalS },
    dernierEvenement: iso(base.dernierEvenementMs),
  }
}
