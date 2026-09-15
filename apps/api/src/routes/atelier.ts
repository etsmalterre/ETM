// Atelier — the bonnetier/régleur PWA's read API (TRM, host atelier.intra.etsmalterre.com).
//
// Port of the legacy WinDev Android app (project MPS, configurations
// "Appli_Bonnetier" / "Appli_Regleur"). Unlike every previous TRM port the
// legacy is NOT PCS-compressed: `C:\Mes Projets\MPS\Android\dbg\Compile\`
// holds the generated Java with the WLanguage in comments and the SQL in
// clear. Every query below quotes its legacy original verbatim.
//
// ⚠️ That snapshot is dated 24/03/2026 and the app has grown since — its
// info.build lists 12 windows and the running app has at least one more (a
// Production/Visitage screen reached from a 4th action icon). Treat the Java
// as authoritative for what it contains, not as an inventory.
//
// Scope: the OF tables carry no IDsociete (tricotage IS Tricotage Malterre,
// like ordre_fabrication elsewhere in TRM), so there is nothing to partition —
// see loadOf(), which validates through the commande chain when there is one.
//
// This file is READ-ONLY for now. The commit path (evenement_piece,
// piece_production, defaut_qualite, the ordre_fabrication timestamps) lands
// next, and it MUST carry its own permission guard: attachUser() is
// best-effort and there is no global gate — see CLAUDE.md § Paramètres >
// Utilisateurs.

import { Router, type Request, type Response, type Router as RouterType } from 'express'
import { z } from 'zod'
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import {
  selectMachines,
  selectBonnetiers,
  resolveEcruRefs,
  resolveColorisEcru,
  parseDtMs,
  round2,
  loadOf,
  uniteForType,
  sqlText,
  nowDt,
  IS_WINDOWS,
  bonnetierDirectory,
} from '../lib/production-trm.js'
import { pickVal } from '../lib/accented-keys.js'
import { dureeMinimalePiece, productivitePiece, dureeMinutes } from '../lib/historique-atelier-trm.js'
import { terminerOf } from '../lib/of-queue-trm.js'
import { trmUserHasPermission } from '../lib/permissions-trm.js'
import { maxId } from './expeditions.js'
import { resolveRefFilNames, resolveColoriFilNames } from './of-trm.js'
import {
  etatMetier,
  pourcentageDefauts,
  alerteRegleur,
  type AlerteRegleur,
} from '../lib/atelier-regleur-trm.js'
import { arretsParPieceDesOfs } from '../lib/arrets-par-piece-trm.js'
import { dernierOfParMetier, prochainOfParMetier, finDeOf, DERNIERS_OF_MAX } from '../lib/metier-repos-trm.js'

export const atelierRouter: RouterType = Router()

const n = (v: unknown): number => Number(v) || 0

// ── GET /api/atelier/bonnetiers?regleur=0|1 ───────────────
//
// The person picker. Legacy (FEN_Accueil_Bonnetier, requête 2):
//
//   SELECT bonnetier.prénom, bonnetier.photo, bonnetier.regleur,
//          bonnetier.archivé,
//          CASE WHEN bonnetier.photo IS NOT NULL THEN bonnetier.photo
//               ELSE 'travailleur.png' END AS Profil,
//          bonnetier.IDbonnetier
//   FROM bonnetier
//   WHERE bonnetier.regleur = {Paramregleur#0} AND bonnetier.archivé = 0
//
// Note the parameter: the legacy serves this same window twice, once per role.
// We keep that shape rather than returning everyone with a flag, because the
// régleur grid must not be reachable from a bonnetier's phone at all — the
// rule is expressed in what the screen offers, not in a refusal.
//
// `prénom` and `archivé` are accented, so selectBonnetiers() does SELECT * +
// key folding on both platforms. Never name those columns in SQL.
//
// No has_photo flag: the photo endpoint 404s when the blob is absent or
// unreadable and the client falls back to initials — the same contract the
// visitage poste already uses, and it avoids dragging ~1 MB of JPEG through a
// list query.
atelierRouter.get('/bonnetiers', async (req: Request, res: Response) => {
  try {
    const wantRegleur = String(req.query.regleur ?? '0') === '1' ? 1 : 0
    const rows = await selectBonnetiers()
    const payload = rows
      .filter((b) => b.archive === 0 && b.regleur === wantRegleur)
      .map((b) => ({
        IDbonnetier: b.id,
        prenom: b.prenom,
        nom: b.nom,
        regleur: b.regleur,
      }))
      // Legacy orders by prénom; the picker is read as a wall of faces, so
      // stable alphabetical order matters more than any ranking.
      .sort((a, b) => a.prenom.localeCompare(b.prenom, 'fr'))
    res.json(payload)
  } catch (err) {
    console.error('Error fetching atelier bonnetiers:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /api/atelier/machines ─────────────────────────────
//
// The métier picker. Legacy (FEN_Choix_Metier, ZR_Machine init):
//
//   SELECT machine.IDmachine, machine.emplacement,
//          ordre_fabrication.IDordre_fabrication, ordre_fabrication.est_actif,
//          ordre_fabrication.demarrage_prod, ordre_fabrication.arret_prod,
//          ordre_fabrication.nb_pieces, ordre_fabrication.finir_fil,
//          ordre_fabrication.auto_activation, ordre_fabrication.prioritaire
//   from machine
//   left join ordre_fabrication
//     on ordre_fabrication.IDmachine = machine.IDmachine
//    and ordre_fabrication.est_actif = 1
//   where machine.archivé = 0
//   ORDER BY machine.emplacement
//
// plus, per row, the piece count:
//   SELECT COUNT(*) AS total FROM piece_production
//   WHERE IDordre_fabrication = {pIDOF} and date_fin <> ''
//
// and the WLanguage that classifies each row into the screen's two lists:
//   "Machines Actives" ⇔ an OF exists AND (total < nb_pieces OR finir_fil)
//   otherwise the métier goes to the second list.
//
// ⚠️ Three deliberate departures from that SQL, each for a reason:
//
//  1. `machine.archivé` is accented → no WHERE on it. selectMachines() does
//     SELECT * + key folding and we filter in JS, on both platforms.
//  2. `date_fin <> ''` is NOT sent to the driver. Windows ODBC and the Linux
//     bridge disagree on empty-vs-null DATETIME, so a piece count built that
//     way is right on one platform and wrong on the other. We fetch the rows
//     and count with parseDtMs(), the same discipline awaitingPieces() encodes.
//  3. NOT a departure, but worth pinning: the label is `machine.emplacement`,
//     exactly as the legacy has it — and deliberately the OPPOSITE of what
//     Atelier > Maintenance does.
//
//     Maintenance uses `nom` because `emplacement` is empty on four métiers
//     (Vignoni, jersey 1F, terrot, RAY), which rendered as nameless rows. All
//     four are ARCHIVED, so they never reach this screen: measured on the live
//     base 2026-08-27, all 30 non-archived métiers carry a non-empty
//     emplacement (1A…3K). The reason to prefer it here is positive, not just
//     safe — `emplacement` is the code painted on the workshop floor, and two
//     métiers have a `nom` that is a brand instead of a position ("Beck" =
//     1G, "Orizio" = 1H). A bonnetier sent to métier 1G would not recognise a
//     tile labelled "Orizio".
//
//     The `|| nom` fallback stays for the day an unarchived métier lands with
//     no emplacement — a blank tile is unusable, a brand name merely odd.
//
// ── `?regleur=1` — the régleur build's tile (lib/atelier-regleur-trm.ts) ──
//
// The legacy régleur configuration (`Android\gen\Compile`, 2026-05-25) decorates
// every active tile with a state icon, a stop frequency and a second-choice
// ratio, plus an alert flag; and its « Inactifs » list holds only the métiers
// with NO active OF (the bonnetier build also lists finished-but-still-active
// ones there). The extras cost bounded queries — two 24 h scans plus one
// `TOP 100` per (reference, coloris) pair — so they are computed only when the
// phone asks for them; the bonnetier list stays as cheap as before.
//
// ── `inactif` — what an idle métier says about itself (2026-09-15) ──
//
// The legacy tile of a métier without an OF is blank. Here it carries the last
// OF that ran on it (reference, coloris, when it stopped) and the head of its
// waiting queue, for both roles — the régleur reads the idle list as the
// machines to set up next. Three bounded reads for the whole list
// (reposDesMetiers); `null` on a métier that has an OF.
atelierRouter.get('/machines', async (req: Request, res: Response) => {
  try {
    const wantRegleur = String(req.query.regleur ?? '0') === '1'
    const machines = (await selectMachines()).filter((m) => m.archive === 0)

    // Active OFs, one per métier at most (the queue invariant).
    const ofRows = await query<Record<string, unknown>>(
      `SELECT IDordre_fabrication, IDmachine, nb_pieces, finir_fil, quantite, poids_piece,
              demarrage_prod, arret_prod, auto_activation, prioritaire, priorite,
              IDref_ecru, IDcolori_ecru, observations
       FROM ordre_fabrication WHERE est_actif = 1`,
    )
    const ofs = await fixEncoding(ofRows, 'ordre_fabrication', 'IDordre_fabrication', ['observations'])

    const byMachine = new Map<number, Record<string, unknown>>()
    for (const o of ofs) byMachine.set(n(o.IDmachine), o)
    const idleIds = machines.filter((m) => !byMachine.has(m.id)).map((m) => m.id)

    const ofIds = ofs.map((o) => n(o.IDordre_fabrication)).filter((x) => x > 0)
    const [pieces, repos] = await Promise.all([selectPiecesForOfs(ofIds), reposDesMetiers(idleIds)])
    const reposOfs = Array.from(repos.values()).flatMap((r) => [r.dernier, r.prochain]).filter((x) => x !== null)
    const [refs, coloris] = await Promise.all([
      resolveEcruRefs([...ofs, ...reposOfs].map((o) => n(o.IDref_ecru)).filter((x) => x > 0)),
      resolveColorisEcru([...ofs, ...reposOfs].map((o) => n(o.IDcolori_ecru)).filter((x) => x > 0)),
    ])
    const produites = countFinished(pieces)
    const regleur = wantRegleur ? await regleurExtras(ofs) : null

    const payload = machines.map((m) => {
      const o = byMachine.get(m.id)
      const ofId = o ? n(o.IDordre_fabrication) : 0
      const nbPieces = o ? n(o.nb_pieces) : 0
      const finirFil = o ? n(o.finir_fil) === 1 : false
      const total = produites.get(ofId) ?? 0
      // The legacy's own predicate, verbatim in meaning: a métier is "active"
      // when it still owes pieces, or when it runs until the yarn is gone.
      const actif = ofId > 0 && (total < nbPieces || finirFil)
      const demarre = o ? parseDtMs(o.demarrage_prod) !== null : false
      const interrompu = o ? parseDtMs(o.arret_prod) !== null : false
      return {
        IDmachine: m.id,
        label: m.emplacement || m.nom,
        nom: m.nom,
        emplacement: m.emplacement,
        actif,
        of: ofId
          ? {
              IDordre_fabrication: ofId,
              reference: refs.get(n(o!.IDref_ecru))?.reference ?? '',
              coloris: coloris.get(n(o!.IDcolori_ecru)) ?? '',
              nb_pieces: nbPieces,
              produites: total,
              finir_fil: finirFil,
              poids_piece: round2(n(o!.poids_piece)),
              // Presence only — the consigne itself is read on the OF screen.
              // HFSQL stores " " for empty, so trim before deciding (§24).
              a_consigne: String(o!.observations ?? '').trim().length > 0,
              demarre,
              interrompu,
            }
          : null,
        // Only on `?regleur=1`; null for a bonnetier's phone.
        regleur:
          regleur && ofId
            ? {
                etat: etatMetier(demarre, interrompu),
                ...(regleur.get(ofId) ?? { alerte: false, pct_defaut: 0, arrets_piece: { moyenne: null, pieces: 0 }, eligible: false }),
              }
            : null,
        // Only on a métier with no OF at all; null while one runs.
        inactif: ofId
          ? null
          : (() => {
              const r = repos.get(m.id)
              const d = r?.dernier ?? null
              const p = r?.prochain ?? null
              return {
                dernier_of: d
                  ? {
                      IDordre_fabrication: n(d.IDordre_fabrication),
                      reference: refs.get(n(d.IDref_ecru))?.reference ?? '',
                      coloris: coloris.get(n(d.IDcolori_ecru)) ?? '',
                      fin_ms: d.fin_ms,
                    }
                  : null,
                prochain_of: p
                  ? {
                      IDordre_fabrication: n(p.IDordre_fabrication),
                      reference: refs.get(n(p.IDref_ecru))?.reference ?? '',
                      coloris: coloris.get(n(p.IDcolori_ecru)) ?? '',
                      nb_pieces: n(p.nb_pieces),
                      finir_fil: n(p.finir_fil) === 1,
                    }
                  : null,
              }
            })(),
      }
    })

    // Legacy orders by emplacement; we order by the label actually rendered so
    // the four blank-emplacement métiers sort where the operator sees them.
    payload.sort((a, b) => a.label.localeCompare(b.label, 'fr', { numeric: true }))
    res.json(payload)
  } catch (err) {
    console.error('Error fetching atelier machines:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

interface ReposMetier {
  /** The last finished OF of the métier, with `fin_ms` resolved (finDeOf). */
  dernier: (Record<string, unknown> & { fin_ms: number | null }) | null
  /** The head of the métier's waiting queue. */
  prochain: Record<string, unknown> | null
}

/** The idle métiers' last and next OF, in three bounded reads for the whole
 *  list: one GROUP BY for the highest finished id per métier, one for those
 *  rows, one for the waiting queue (a handful of rows across the workshop).
 *  A fourth, rare read fetches the last piece end for a finished OF without
 *  `arret_prod` (the legacy Android handover stamps none — 1 in 3 163). The
 *  choices themselves are lib/metier-repos-trm.ts. */
async function reposDesMetiers(machineIds: number[]): Promise<Map<number, ReposMetier>> {
  const out = new Map<number, ReposMetier>()
  const ids = machineIds.filter((x) => x > 0)
  if (ids.length === 0) return out
  const inList = ids.join(',')

  const [groupRows, attenteRows] = await Promise.all([
    query<Record<string, unknown>>(
      `SELECT IDmachine, MAX(IDordre_fabrication) AS dernier FROM ordre_fabrication
       WHERE est_termine = 1 AND IDmachine IN (${inList}) GROUP BY IDmachine`,
    ),
    query<Record<string, unknown>>(
      `SELECT IDordre_fabrication, IDmachine, IDref_ecru, IDcolori_ecru, priorite, nb_pieces, finir_fil
       FROM ordre_fabrication WHERE est_termine = 0 AND est_actif = 0 AND IDmachine IN (${inList})`,
    ),
  ])
  // The GROUP BY already picked the max per métier; dernierOfParMetier() only
  // re-applies the rule over the rows, so the driver's grouping is not trusted
  // to be the reader of record.
  const dernierIds = dernierOfParMetier(
    groupRows.map((r) => ({ id: n(r.dernier), machineId: n(r.IDmachine) })),
  )
  const prochains = prochainOfParMetier(
    attenteRows.map((r) => ({ id: n(r.IDordre_fabrication), machineId: n(r.IDmachine), priorite: n(r.priorite), row: r })),
  )

  const dernierRows =
    dernierIds.size > 0
      ? await query<Record<string, unknown>>(
          `SELECT IDordre_fabrication, IDmachine, IDref_ecru, IDcolori_ecru, arret_prod
           FROM ordre_fabrication WHERE IDordre_fabrication IN (${Array.from(dernierIds.values()).join(',')})`,
        )
      : []
  const sansArret = dernierRows.filter((r) => parseDtMs(r.arret_prod) === null).map((r) => n(r.IDordre_fabrication))
  const finPieces = await finDernierePiece(sansArret)

  for (const id of ids) {
    const d = dernierRows.find((r) => n(r.IDmachine) === id) ?? null
    out.set(id, {
      dernier: d
        ? { ...d, fin_ms: finDeOf(parseDtMs(d.arret_prod), finPieces.get(n(d.IDordre_fabrication)) ?? null) }
        : null,
      prochain: prochains.get(id)?.row ?? null,
    })
  }
  return out
}

/** The end of the last finished piece of each OF (the `finDeOf` fallback).
 *  Empty map for an empty list — the common case. */
async function finDernierePiece(ofIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  if (ofIds.length === 0) return out
  for (const p of await selectPiecesForOfs(ofIds)) {
    if (p.finMs === null) continue
    const cur = out.get(p.ofId)
    if (cur === undefined || p.finMs > cur) out.set(p.ofId, p.finMs)
  }
  return out
}

// ── GET /api/atelier/machines/:id/derniers-of ─────────────
//
// The last DERNIERS_OF_MAX finished OFs knitted on one métier, newest first,
// for the poste's « Aucun OF en cours » state (2026-09-15). Not a legacy
// window — FEN_Historique is the per-piece history of ONE OF — but the answer
// to the question a régleur asks in front of an idle machine: what ran here,
// when, and how did it go. Read-only; both roles.
//
// Per OF: reference, coloris, pieces ordered / finished, total weight visited
// and the second-choice share of it (Σ stock_ecru.poids, no IDsociete filter —
// a delivered roll flips to société 1 on the ETM handover and must keep
// counting, see realiseByOf), start and stop stamps.
atelierRouter.get('/machines/:id/derniers-of', async (req: Request, res: Response) => {
  try {
    const machineId = parseInt(String(req.params.id), 10)
    if (!Number.isInteger(machineId) || machineId <= 0) {
      res.status(400).json({ error: 'Invalid id' })
      return
    }
    const machine = (await selectMachines()).find((m) => m.id === machineId && m.archive === 0)
    if (!machine) {
      res.status(404).json({ error: 'Machine not found' })
      return
    }
    const ofRows = await query<Record<string, unknown>>(
      `SELECT TOP ${DERNIERS_OF_MAX} IDordre_fabrication, IDref_ecru, IDcolori_ecru, nb_pieces, finir_fil,
              demarrage_prod, arret_prod
       FROM ordre_fabrication WHERE IDmachine = ${machineId} AND est_termine = 1
       ORDER BY IDordre_fabrication DESC`,
    )
    const ofIds = ofRows.map((r) => n(r.IDordre_fabrication)).filter((x) => x > 0)
    const [pieces, rolls, refs, coloris] = await Promise.all([
      selectPiecesForOfs(ofIds),
      ofIds.length > 0
        ? query<Record<string, unknown>>(
            `SELECT IDordre_fabrication, poids, second_choix FROM stock_ecru
             WHERE IDordre_fabrication IN (${ofIds.join(',')})`,
          )
        : Promise.resolve([] as Record<string, unknown>[]),
      resolveEcruRefs(ofRows.map((r) => n(r.IDref_ecru)).filter((x) => x > 0)),
      resolveColorisEcru(ofRows.map((r) => n(r.IDcolori_ecru)).filter((x) => x > 0)),
    ])
    const produites = countFinished(pieces, ofIds)
    const finPiece = new Map<number, number>()
    for (const p of pieces) {
      if (p.finMs === null) continue
      const cur = finPiece.get(p.ofId)
      if (cur === undefined || p.finMs > cur) finPiece.set(p.ofId, p.finMs)
    }
    const poids = new Map<number, { total: number; second: number }>()
    for (const r of rolls) {
      const id = n(r.IDordre_fabrication)
      const acc = poids.get(id) ?? { total: 0, second: 0 }
      const kg = Number(r.poids) || 0
      acc.total += kg
      if (n(r.second_choix) === 1) acc.second += kg
      poids.set(id, acc)
    }

    res.json({
      IDmachine: machineId,
      label: machine.emplacement || machine.nom,
      ofs: ofRows.map((r) => {
        const id = n(r.IDordre_fabrication)
        const w = poids.get(id) ?? { total: 0, second: 0 }
        return {
          IDordre_fabrication: id,
          reference: refs.get(n(r.IDref_ecru))?.reference ?? '',
          coloris: coloris.get(n(r.IDcolori_ecru)) ?? '',
          nb_pieces: n(r.nb_pieces),
          finir_fil: n(r.finir_fil) === 1,
          produites: produites.get(id) ?? 0,
          poids: round2(w.total),
          poids_second_choix: round2(w.second),
          debut_ms: parseDtMs(r.demarrage_prod),
          fin_ms: finDeOf(parseDtMs(r.arret_prod), finPiece.get(id) ?? null),
        }
      }),
    })
  } catch (err) {
    console.error('Error fetching atelier derniers OF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

interface PieceRow {
  id: number
  ofId: number
  finMs: number | null
}

/** Every piece of the given OFs — the one read behind both the finished-piece
 *  count and the régleur's stop frequency (which needs piece → OF). */
async function selectPiecesForOfs(ofIds: number[]): Promise<PieceRow[]> {
  const ids = ofIds.filter((x) => x > 0)
  if (ids.length === 0) return []
  const rows = await query<Record<string, unknown>>(
    `SELECT IDpiece_production, IDordre_fabrication, date_fin FROM piece_production
     WHERE IDordre_fabrication IN (${ids.join(',')})`,
  )
  return rows.map((r) => ({
    id: n(r.IDpiece_production),
    ofId: n(r.IDordre_fabrication),
    finMs: parseDtMs(r.date_fin),
  }))
}

/** Finished pieces per OF. See departure (2) above: the count is done in JS on
 *  parsed dates, never with `date_fin <> ''` in the WHERE. Every requested OF
 *  gets an entry, 0 included. */
function countFinished(pieces: PieceRow[], ofIds?: number[]): Map<number, number> {
  const out = new Map<number, number>()
  for (const id of ofIds ?? []) out.set(id, 0)
  for (const p of pieces) {
    if (!out.has(p.ofId)) out.set(p.ofId, 0)
    if (p.finMs === null) continue // still on the machine
    out.set(p.ofId, (out.get(p.ofId) ?? 0) + 1)
  }
  return out
}

async function countFinishedPieces(ofIds: number[]): Promise<Map<number, number>> {
  return countFinished(await selectPiecesForOfs(ofIds), ofIds.filter((x) => x > 0))
}

type RegleurExtras = AlerteRegleur & { eligible: boolean }

/** The régleur tile's numbers for every active OF, in three bounded reads:
 *
 *   1. arrêts par pièce — lib/arrets-par-piece-trm.ts, the TRS tablet's own
 *      reader, cached per (OF, ids of its last finished pieces)
 *   2. stock_ecru TOP 100 per distinct (reference, coloris)   (the 2nd-choice ratio)
 *   3. ref_ecru_machine for the métiers on screen             (the eligibility)
 *
 *  The legacy runs two 24 h scans PER TILE for an hourly stop rate; why that
 *  number is not ported: the header of lib/atelier-regleur-trm.ts. */
async function regleurExtras(ofs: Record<string, unknown>[]): Promise<Map<number, RegleurExtras>> {
  const out = new Map<number, RegleurExtras>()
  if (ofs.length === 0) return out
  const machineIds = Array.from(new Set(ofs.map((o) => n(o.IDmachine)).filter((x) => x > 0)))

  const [arrets, eligRows] = await Promise.all([
    arretsParPieceDesOfs(ofs.map((o) => ({ ofId: n(o.IDordre_fabrication), machineId: n(o.IDmachine) }))),
    machineIds.length > 0
      ? query<Record<string, unknown>>(
          `SELECT IDref_ecru, IDmachine FROM ref_ecru_machine WHERE IDmachine IN (${machineIds.join(',')})`,
        )
      : Promise.resolve([] as Record<string, unknown>[]),
  ])
  const eligible = new Set(eligRows.map((r) => `${n(r.IDref_ecru)}:${n(r.IDmachine)}`))

  // One TOP 100 per distinct (reference, coloris) pair — two OFs on the same
  // article share the read, as they share the ratio.
  const pctParPaire = new Map<string, number>()
  for (const o of ofs) {
    const key = `${n(o.IDref_ecru)}:${n(o.IDcolori_ecru)}`
    if (pctParPaire.has(key)) continue
    if (n(o.IDref_ecru) <= 0) {
      pctParPaire.set(key, 0)
      continue
    }
    const rows = await query<Record<string, unknown>>(
      `SELECT TOP 100 poids, second_choix FROM stock_ecru
       WHERE IDref_ecru = ${n(o.IDref_ecru)} AND IDcolori_ecru = ${n(o.IDcolori_ecru)}
       ORDER BY date_saisie DESC`,
    )
    pctParPaire.set(
      key,
      pourcentageDefauts(rows.map((r) => ({ poids: Number(r.poids) || 0, second_choix: n(r.second_choix) === 1 }))),
    )
  }

  for (const o of ofs) {
    const ofId = n(o.IDordre_fabrication)
    const pct = pctParPaire.get(`${n(o.IDref_ecru)}:${n(o.IDcolori_ecru)}`) ?? 0
    out.set(ofId, {
      ...alerteRegleur(pct, arrets.get(ofId) ?? { moyenne: null, pieces: 0 }),
      eligible: eligible.has(`${n(o.IDref_ecru)}:${n(o.IDmachine)}`),
    })
  }
  return out
}

// ── GET /api/atelier/of/:id ───────────────────────────────
//
// Everything the poste screen (legacy FEN_Action_Machine) shows above its
// action combo. Assembled from four legacy queries plus the OF row itself.
//
// Last piece:
//   SELECT IDpiece_production, numero FROM piece_production
//   WHERE IDordre_fabrication = {pIDOF}
//   ORDER BY IDpiece_production DESC LIMIT 1
//
// Nettoyages already done on that piece:
//   select count(*) as nettoyage_efectué from evenement_piece
//   where evenement_piece.evenement like '%Nettoyage%'
//     AND evenement_piece.IDpiece_production = {pIDPieceProd}
//
// Message count (the bonnetier thread badge):
//   select count(*) as total from message_of
//   where message_of.IDordre_fabrication = {pIDOF}
atelierRouter.get('/of/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10)
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' })
      return
    }
    const ctx = await chargerContexte(id)
    if (!ctx) {
      res.status(404).json({ error: 'OF not found' })
      return
    }
    res.json(ctx)
  } catch (err) {
    console.error('Error fetching atelier OF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ═══════════════════════════════════════════════════════════
//  RÉGLEUR — the screens only the régleur build opens
// ═══════════════════════════════════════════════════════════
//
// Spec: `C:\Mes Projets\MPS\Android\gen\Compile\` (configuration Appli_Regleur,
// 2026-05-25). Three deltas over the bonnetier build, all ported here:
//   - FEN_Reglage_Machine — the setup sheet a régleur reads before « Lancer OF »
//     (GET /of/:id/reglage; the launch itself is the existing « Lancement OF »
//     event, so there is one write path for it, not two);
//   - FEN_Consigne plan 3 — the régleur WRITES the consigne (PUT /of/:id/consigne);
//   - FEN_Consigne plan 2 — the message_of thread, both roles (GET/POST/DELETE
//     /of/:id/messages).
// FEN_Historique and FEN_Fils_OF are ported further down (« HISTORIQUE & FILS »).

// ── GET /api/atelier/of/:id/reglage ───────────────────────
//
// Legacy FEN_Reglage_Machine, verbatim:
//
//   req (ref_ecru_machine): SELECT IDref_ecru_machine FROM ref_ecru_machine
//        WHERE IDmachine = {pIDMachine} AND IDref_ecru = {pIDRefEcru}
//   reqRefPrec: SELECT ordre_fabrication.arret_prod, ref_ecru.lfa_tour_1..4
//        FROM ordre_fabrication
//        LEFT JOIN ligne_commande_client ON … LEFT JOIN ref_ecru ON …IDreference
//        WHERE IDmachine = {pIDMachine} AND IDordre_fabrication <> {pOFEnCours}
//          AND arret_prod <> '' ORDER BY arret_prod DESC LIMIT 1
//   ZR_Repere: 4 rows (tour, reqRefPrec.lfa_tour_n, ref_ecru.lfa_tour_n,
//        ref_ecru_machine.repere_n) + a 5th with repere_5 only
//   ZR_Reglage: Hauteur Plateau / Abattage · Nb Chutes / Compteur ·
//        Écarteur / Poids Pièce · Maille d'ouverture / Tombé Métier ·
//        Ouvert au large
//   Fils: SELECT DISTINCT … FROM asso_fil_of, ref_fil, colori_fil
//   Observations: ordre_fabrication.observations (the consigne)
//
// Choix_Metier only opens this window when `reqEligible.total = 1`
// (a ref_ecru_machine row exists) — otherwise « La référence demandée n'est
// pas disponible sur cette machine ». Here the sheet carries `eligible` and
// the phone renders that sentence instead of the launch button.
//
// Two departures:
//   - the previous OF's reference is read from `ordre_fabrication.IDref_ecru`
//     (the column every other atelier read uses), not through the commande
//     line; and `arret_prod <> ''` is not sent to the driver (departure 2 of
//     /machines) — the last 20 OFs of the métier are fetched and the first
//     with a parseable arret_prod wins;
//   - the compteur is the poste's own (compteurFor: OF poids_piece), where the
//     legacy sheet divides `ref_ecru.poids`. The régleur dialling the counter
//     and the bonnetier reading it on the poste must see the same number.
atelierRouter.get('/of/:id/reglage', async (req: Request, res: Response) => {
  try {
    const id = parseInt(String(req.params.id), 10)
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' })
      return
    }
    const loaded = await loadOf(id)
    if (!loaded) {
      res.status(404).json({ error: 'OF not found' })
      return
    }
    const { of } = loaded
    const machineId = n(of.IDmachine)
    const refId = n(of.IDref_ecru)
    const coloriId = n(of.IDcolori_ecru)
    const poidsPiece = round2(n(of.poids_piece))

    const [machines, refs, coloris, refRows, refMachRows, assoRaw, prevRows, compteur] = await Promise.all([
      selectMachines(),
      refId > 0 ? resolveEcruRefs([refId]) : Promise.resolve(new Map()),
      coloriId > 0 ? resolveColorisEcru([coloriId]) : Promise.resolve(new Map()),
      refId > 0
        ? query<Record<string, unknown>>(
            `SELECT IDref_ecru, poids, ouvert_visiteuse, maille_ouverture, ecarteur, tombe_metier,
                    lfa_tour_1, lfa_tour_2, lfa_tour_3, lfa_tour_4
             FROM ref_ecru WHERE IDref_ecru = ${refId}`,
          )
        : Promise.resolve([] as Record<string, unknown>[]),
      refId > 0 && machineId > 0
        ? query<Record<string, unknown>>(
            `SELECT IDref_ecru_machine, repere_1, repere_2, repere_3, repere_4, repere_5,
                    hauteur_pl, abattage, nb_chutes, trs_10kg_chute
             FROM ref_ecru_machine WHERE IDref_ecru = ${refId} AND IDmachine = ${machineId}`,
          )
        : Promise.resolve([] as Record<string, unknown>[]),
      query<Record<string, unknown>>(
        `SELECT IDref_fil, IDcolori_fil FROM asso_fil_of WHERE IDordre_fabrication = ${id} ORDER BY IDasso_fil_of`,
      ),
      machineId > 0
        ? query<Record<string, unknown>>(
            `SELECT TOP 20 IDordre_fabrication, arret_prod, IDref_ecru FROM ordre_fabrication
             WHERE IDmachine = ${machineId} AND IDordre_fabrication <> ${id}
             ORDER BY IDordre_fabrication DESC`,
          )
        : Promise.resolve([] as Record<string, unknown>[]),
      compteurFor(refId, machineId, poidsPiece),
    ])

    const ref = (await fixEncoding(refRows, 'ref_ecru', 'IDref_ecru', ['tombe_metier', 'lfa_tour_1', 'lfa_tour_2', 'lfa_tour_3', 'lfa_tour_4']))[0]
    const refMach = (
      await fixEncoding(refMachRows, 'ref_ecru_machine', 'IDref_ecru_machine', [
        'repere_1', 'repere_2', 'repere_3', 'repere_4', 'repere_5', 'hauteur_pl', 'abattage',
      ])
    )[0]

    // The reference that ran before this one on the métier — its LFA are the
    // starting point the régleur adjusts from.
    const prev = prevRows
      .filter((r) => parseDtMs(r.arret_prod) !== null)
      .sort((a, b) => (parseDtMs(b.arret_prod) ?? 0) - (parseDtMs(a.arret_prod) ?? 0))[0]
    const prevRefId = prev ? n(prev.IDref_ecru) : 0
    let prevRef: Record<string, unknown> | undefined
    if (prevRefId > 0) {
      const rows = await query<Record<string, unknown>>(
        `SELECT IDref_ecru, lfa_tour_1, lfa_tour_2, lfa_tour_3, lfa_tour_4 FROM ref_ecru WHERE IDref_ecru = ${prevRefId}`,
      )
      prevRef = (await fixEncoding(rows, 'ref_ecru', 'IDref_ecru', ['lfa_tour_1', 'lfa_tour_2', 'lfa_tour_3', 'lfa_tour_4']))[0]
    }

    const txt = (v: unknown): string => String(v ?? '').trim()
    const reperes = [1, 2, 3, 4].map((tour) => ({
      tour,
      lfa_precedente: prevRef ? txt(prevRef[`lfa_tour_${tour}`]) : '',
      lfa: ref ? txt(ref[`lfa_tour_${tour}`]) : '',
      repere: refMach ? txt(refMach[`repere_${tour}`]) : '',
    }))
    reperes.push({ tour: 5, lfa_precedente: '', lfa: '', repere: refMach ? txt(refMach.repere_5) : '' })

    // Fils: the legacy lists DISTINCT (fil, coloris) pairs — a composition is a
    // list of feed positions, so the same pair legitimately repeats.
    const [refFilNames, coloriFilNames] = await Promise.all([
      resolveRefFilNames(assoRaw.map((a) => n(a.IDref_fil))),
      resolveColoriFilNames(assoRaw.map((a) => n(a.IDcolori_fil))),
    ])
    const fils: string[] = []
    const seen = new Set<string>()
    for (const a of assoRaw) {
      const k = `${n(a.IDref_fil)}:${n(a.IDcolori_fil)}`
      if (seen.has(k)) continue
      seen.add(k)
      const r = refFilNames.get(n(a.IDref_fil)) ?? ''
      const c = coloriFilNames.get(n(a.IDcolori_fil)) ?? ''
      fils.push(c ? `${r} - ${c}` : r)
    }

    const machine = machines.find((m) => m.id === machineId)
    res.json({
      IDordre_fabrication: id,
      IDmachine: machineId,
      machine: machine ? machine.emplacement || machine.nom : '',
      reference: refs.get(refId)?.reference ?? '',
      coloris: coloris.get(coloriId) ?? '',
      demarre: parseDtMs(of.demarrage_prod) !== null,
      termine: n(of.est_termine) === 1,
      eligible: !!refMach,
      consigne: txt(of.observations),
      reperes,
      reglages: {
        hauteur_pl: refMach ? txt(refMach.hauteur_pl) : '',
        abattage: refMach ? txt(refMach.abattage) : '',
        nb_chutes: refMach ? n(refMach.nb_chutes) : 0,
        compteur,
        ecarteur: ref ? Number(ref.ecarteur) || 0 : 0,
        poids_piece: poidsPiece,
        maille_ouverture: ref ? n(ref.maille_ouverture) === 1 : false,
        tombe_metier: ref ? txt(ref.tombe_metier) : '',
        ouvert_visiteuse: ref ? n(ref.ouvert_visiteuse) === 1 : false,
      },
      fils,
    })
  } catch (err) {
    console.error('Error fetching atelier reglage:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── The message_of thread (FEN_Consigne plan 2) ───────────
//
// Legacy: ZR_Messages lists every message of the OF with the author's photo;
// « ENVOYER » appends one (`Erreur("Vous n'avez écrit aucun message")` on an
// empty field); the « Supprimer » button shows only on the reader's OWN
// messages (`ATT_Btn = ATT_IDBonnetier = bonnetier.IDbonnetier`).
//
// `message_of` carries the reserved `date` column → positional INSERT, MAX+1
// PK. Physical order (routes/of-trm.ts, same table):
//   IDmessage_of, observation, IDordre_fabrication, IDbonnetier, date
// The ERP's own POST writes IDbonnetier = 0 to mark a saisie bureau; here the
// author is the identified bonnetier, as the legacy terminal writes it.

/** The write gate every régleur/bonnetier write of this file shares. Three
 *  checks, in order, each refusing on its own:
 *   1. the request comes from an ENROLLED PHONE (`req.appareil`, the
 *      `mps_appareil` cookie — lib/appareils-atelier.ts). A plain user cookie
 *      is not enough: `POST /auth/login` accepts any IDutilisateur with no
 *      authentication, so without this a curl could act as anyone;
 *   2. the phone's account holds `saisie_atelier` (granted in Paramètres ›
 *      Utilisateurs, exactly as the visitage PC's poste account);
 *   3. the body names a live bonnetier — and the phone is allowed to speak
 *      for him: a régleur's phone (fixed identity) only for HIMSELF, a shared
 *      phone only for a NON-régleur (a régleur is his own phone, never a face
 *      in the shared grid — the plan's §3.3 rule, enforced here, not only in
 *      the UI).
 *  Sends the refusal itself; null when refused. */
async function gateSaisie(
  req: Request,
  res: Response,
  IDbonnetier: number,
): Promise<{ id: number; regleur: number; appareil: string } | null> {
  const appareil = req.appareil
  if (!appareil) {
    res.status(req.userId === undefined ? 401 : 403).json({
      error: 'appareil_non_enrole',
      message: 'Ce téléphone n’est pas enrôlé.',
    })
    return null
  }
  const allowed = await trmUserHasPermission(appareil.IDutilisateur, false, 'saisie_atelier')
  if (!allowed) {
    res.status(403).json({ error: 'permission denied: saisie_atelier' })
    return null
  }
  const who = (await selectBonnetiers()).find((b) => b.id === IDbonnetier)
  if (!who || who.archive !== 0) {
    res.status(400).json({ error: 'bonnetier inconnu ou archivé' })
    return null
  }
  if (appareil.IDbonnetier !== null && appareil.IDbonnetier !== who.id) {
    res.status(403).json({
      error: 'identite_appareil',
      message: 'Ce téléphone ne peut enregistrer que pour son régleur.',
    })
    return null
  }
  if (appareil.IDbonnetier === null && who.regleur === 1) {
    res.status(403).json({
      error: 'regleur_hors_appareil',
      message: 'Un régleur enregistre depuis son propre téléphone.',
    })
    return null
  }
  return { id: who.id, regleur: who.regleur, appareil: appareil.libelle }
}

function parseOfId(req: Request, res: Response): number | null {
  const id = parseInt(String(req.params.id), 10)
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid id' })
    return null
  }
  return id
}

atelierRouter.get('/of/:id/messages', async (req: Request, res: Response) => {
  try {
    const id = parseOfId(req, res)
    if (id === null) return
    if (!(await loadOf(id))) {
      res.status(404).json({ error: 'OF not found' })
      return
    }
    const raw = await query<Record<string, unknown>>(
      `SELECT IDmessage_of, observation, IDbonnetier, DATE AS date_obs
       FROM message_of WHERE IDordre_fabrication = ${id} ORDER BY DATE DESC`,
    )
    const rows = await fixEncoding(raw, 'message_of', 'IDmessage_of', ['observation'])
    const bonnetiers = new Map((await selectBonnetiers()).map((b) => [b.id, b]))
    res.json(
      rows.map((r) => {
        const bid = n(r.IDbonnetier)
        const b = bonnetiers.get(bid)
        return {
          id: n(r.IDmessage_of),
          observation: String(r.observation ?? '').trim(),
          IDbonnetier: bid,
          // 0 = written from the ERP (saisie bureau), which has no face.
          prenom: b ? b.prenom : bid === 0 ? 'Bureau' : '',
          date_ms: parseDtMs(r.date_obs),
        }
      }),
    )
  } catch (err) {
    console.error('Error fetching atelier messages:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const messageBody = z
  .object({
    IDbonnetier: z.number().int().positive(),
    observation: z.string().trim().min(1).max(2000),
  })
  .strict()

atelierRouter.post('/of/:id/messages', async (req: Request, res: Response) => {
  try {
    const id = parseOfId(req, res)
    if (id === null) return
    const parsed = messageBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const who = await gateSaisie(req, res, parsed.data.IDbonnetier)
    if (!who) return
    if (!(await loadOf(id))) {
      res.status(404).json({ error: 'OF not found' })
      return
    }
    const newId = (await maxId('message_of', 'IDmessage_of')) + 1
    await query(
      `INSERT INTO message_of VALUES (${newId}, ${sqlText(parsed.data.observation)}, ${id}, ${who.id}, '${nowDt()}')`,
    )
    res.status(201).json({ id: newId })
  } catch (err) {
    console.error('Error creating atelier message:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

const deleteMessageBody = z.object({ IDbonnetier: z.number().int().positive() }).strict()

atelierRouter.delete('/of/:id/messages/:msgId', async (req: Request, res: Response) => {
  try {
    const id = parseOfId(req, res)
    if (id === null) return
    const msgId = parseInt(String(req.params.msgId), 10)
    if (!Number.isInteger(msgId) || msgId <= 0) {
      res.status(400).json({ error: 'Invalid message id' })
      return
    }
    const parsed = deleteMessageBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const who = await gateSaisie(req, res, parsed.data.IDbonnetier)
    if (!who) return
    const rows = await query<Record<string, unknown>>(
      `SELECT IDmessage_of, IDordre_fabrication, IDbonnetier FROM message_of WHERE IDmessage_of = ${msgId}`,
    )
    const m = rows[0]
    if (!m || n(m.IDordre_fabrication) !== id) {
      res.status(404).json({ error: 'message not found' })
      return
    }
    // The legacy only offers the button on your own messages; the route is
    // where that rule actually holds.
    if (n(m.IDbonnetier) !== who.id) {
      res.status(403).json({ error: 'message_autrui', message: "Ce message n'est pas le vôtre." })
      return
    }
    await query(`DELETE FROM message_of WHERE IDmessage_of = ${msgId}`)
    res.status(204).end()
  } catch (err) {
    console.error('Error deleting atelier message:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── PUT /api/atelier/of/:id/consigne (FEN_Consigne plan 3) ─
//
// The one régleur-only WRITE of the legacy: `SAI_Consigne_regleur` is bound to
// `ordre_fabrication.observations` and saves on every keystroke. Here it saves
// on « Enregistrer », and the route — not the grid — is what makes it
// régleur-only: the named bonnetier must carry `regleur = 1`, exactly the
// check that gates « Interrompre OF ». Until device enrolment lands the name
// is self-declared on the phone, which is the accepted trust model of the
// workshop (dossier § Identité); the cookie right still has to be held.
const consigneBody = z
  .object({
    IDbonnetier: z.number().int().positive(),
    consigne: z.string().max(4000),
  })
  .strict()

atelierRouter.put('/of/:id/consigne', async (req: Request, res: Response) => {
  try {
    const id = parseOfId(req, res)
    if (id === null) return
    const parsed = consigneBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const who = await gateSaisie(req, res, parsed.data.IDbonnetier)
    if (!who) return
    if (who.regleur !== 1) {
      res.status(403).json({ error: 'regleur_requis', message: 'Seul un régleur peut écrire la consigne.' })
      return
    }
    const loaded = await loadOf(id)
    if (!loaded) {
      res.status(404).json({ error: 'OF not found' })
      return
    }
    if (n(loaded.of.est_termine) === 1) {
      res.status(409).json({ error: 'of_termine', message: 'OF terminé — il ne peut plus être modifié.' })
      return
    }
    const consigne = parsed.data.consigne.trim()
    await query(
      `UPDATE ordre_fabrication SET observations = ${sqlText(consigne)} WHERE IDordre_fabrication = ${id}`,
    )
    res.json({ ok: true, consigne })
  } catch (err) {
    console.error('Error writing atelier consigne:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ═══════════════════════════════════════════════════════════
//  HISTORIQUE & FILS — the two consultation windows of an OF
// ═══════════════════════════════════════════════════════════
//
// Legacy FEN_Historique (régleur build, `Android\gen\Compile`) and
// FEN_Fils_OF (both builds). Both are read-only, both are keyed by the OF the
// métier resolved to, and the phone reaches them from the poste's link rows.
// The pure arithmetic of the first lives in lib/historique-atelier-trm.ts.

// ── GET /api/atelier/of/:id/historique ────────────────────
//
// FEN_Historique, plan 1 (ZR_Prod) + plan 3 (ZR_Visitage):
//
//   ZR_Prod:     select IDpiece_production, date_debut, date_fin, observations
//                from piece_production where IDordre_fabrication = {pIDOF}
//                order by IDpiece_production desc
//                → « Pièce N° i » (i = NbEnr() counting DOWN — a position,
//                  not the `numero` column), durée, productivité, couleur
//   ZR_Visitage: SELECT numero, date_saisie, visiteur, poids, observations,
//                CASE WHEN second_choix = 1 THEN 'croix.png' ELSE 'terminer3.png' END
//                FROM stock_ecru where IDordre_fabrication = {pIDOF}
//
// Departures:
//   - the reference is read on `ordre_fabrication.IDref_ecru` (every other
//     atelier read does), where the legacy goes through the commande line;
//   - the theoretical minimum takes `ref_ecru.poids` like the legacy, and only
//     falls back to the OF's `poids_piece` when the reference carries none;
//   - the rolls are ordered newest first (num_piece_OF DESC) — the legacy's
//     inline query has no ORDER BY and the Android list shows 3568/1, 3568/10,
//     3568/11… (string order), which nobody wants.
atelierRouter.get('/of/:id/historique', async (req: Request, res: Response) => {
  try {
    const id = parseOfId(req, res)
    if (id === null) return
    const loaded = await loadOf(id)
    if (!loaded) {
      res.status(404).json({ error: 'OF not found' })
      return
    }
    const { of } = loaded
    const machineId = n(of.IDmachine)
    const refId = n(of.IDref_ecru)

    const [pieces, rollsRaw, refRows, refMachRows] = await Promise.all([
      query<Record<string, unknown>>(
        `SELECT IDpiece_production, numero, date_debut, date_fin, observations
         FROM piece_production WHERE IDordre_fabrication = ${id}
         ORDER BY IDpiece_production DESC`,
      ),
      query<Record<string, unknown>>(
        `SELECT IDstock_ecru, numero, num_piece_OF, poids, second_choix, visiteur, observations, date_saisie
         FROM stock_ecru WHERE IDordre_fabrication = ${id}
         ORDER BY num_piece_OF DESC, IDstock_ecru DESC`,
      ),
      refId > 0
        ? query<{ poids: number | null }>(`SELECT poids FROM ref_ecru WHERE IDref_ecru = ${refId}`)
        : Promise.resolve([] as { poids: number | null }[]),
      refId > 0 && machineId > 0
        ? query<{ trs_10kg_chute: number | null; nb_chutes: number | null }>(
            `SELECT trs_10kg_chute, nb_chutes FROM ref_ecru_machine
             WHERE IDref_ecru = ${refId} AND IDmachine = ${machineId}`,
          )
        : Promise.resolve([] as { trs_10kg_chute: number | null; nb_chutes: number | null }[]),
    ])

    const poidsRef = Number(refRows[0]?.poids) || 0
    const poids = poidsRef > 0 ? poidsRef : n(of.poids_piece)
    const dureeMini = dureeMinimalePiece(
      Number(refMachRows[0]?.trs_10kg_chute) || 0,
      Number(refMachRows[0]?.nb_chutes) || 0,
      poids,
    )

    const piecesFixed = await fixEncoding(pieces, 'piece_production', 'IDpiece_production', ['observations'])
    let i = piecesFixed.length
    const productions = piecesFixed.map((p) => {
      const debut = parseDtMs(p.date_debut)
      const fin = parseDtMs(p.date_fin)
      const minutes = dureeMinutes(debut, fin)
      const prod = productivitePiece(dureeMini, minutes)
      return {
        IDpiece_production: n(p.IDpiece_production),
        position: i--,
        numero: n(p.numero),
        terminee: fin !== null,
        debut_ms: debut,
        fin_ms: fin,
        duree_min: minutes,
        pct: prod?.pct ?? null,
        alerte: prod?.alerte ?? false,
        observations: String(p.observations ?? '').trim(),
      }
    })

    const rolls = await fixEncoding(rollsRaw, 'stock_ecru', 'IDstock_ecru', ['numero', 'visiteur', 'observations'])
    const rouleaux = rolls.map((r) => ({
      IDstock_ecru: n(r.IDstock_ecru),
      numero: String(r.numero ?? '').trim(),
      num_piece_OF: n(r.num_piece_OF),
      poids: round2(Number(r.poids) || 0),
      second_choix: n(r.second_choix) === 1,
      visiteur: String(r.visiteur ?? '').trim(),
      observations: String(r.observations ?? '').trim(),
      date_ms: parseDtMs(r.date_saisie),
    }))

    res.json({
      IDordre_fabrication: id,
      duree_mini_min: dureeMini === null ? null : Math.round(dureeMini * 10) / 10,
      pieces: productions,
      rouleaux,
    })
  } catch (err) {
    console.error('Error fetching atelier historique:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /api/atelier/of/:id/pieces/:pieceId/evenements ────
//
// FEN_Historique plan 2 (SC_Popup / ZR_Controle) — the events of one piece:
//
//   SELECT evenement_piece.IDevenement_piece, IDpiece_production, date, evenement,
//          observation, bonnetier.prénom, bonnetier.photo
//   FROM bonnetier, evenement_piece
//   WHERE bonnetier.IDbonnetier = evenement_piece.IDbonnetier
//     AND evenement_piece.IDpiece_production = {ParamIDpiece_production}
//
// The legacy's inner join silently drops rows whose IDbonnetier matches no
// one (the visitage poste writes with the visiteuse's id, the ERP with 0);
// here they are kept with an empty prénom — the phone shows the event anyway.
atelierRouter.get('/of/:id/pieces/:pieceId/evenements', async (req: Request, res: Response) => {
  try {
    const id = parseOfId(req, res)
    if (id === null) return
    const pieceId = parseInt(String(req.params.pieceId), 10)
    if (!Number.isInteger(pieceId) || pieceId <= 0) {
      res.status(400).json({ error: 'Invalid piece id' })
      return
    }
    const owner = await query<{ IDordre_fabrication: number }>(
      `SELECT IDordre_fabrication FROM piece_production WHERE IDpiece_production = ${pieceId}`,
    )
    if (n(owner[0]?.IDordre_fabrication) !== id) {
      res.status(404).json({ error: 'Piece not found' })
      return
    }
    const [raw, bonnetiers] = await Promise.all([
      query<Record<string, unknown>>(
        `SELECT IDevenement_piece, evenement, observation, IDbonnetier, DATE AS date_ev
         FROM evenement_piece WHERE IDpiece_production = ${pieceId}
         ORDER BY IDevenement_piece ASC`,
      ),
      bonnetierDirectory(),
    ])
    const rows = await fixEncoding(raw, 'evenement_piece', 'IDevenement_piece', ['evenement', 'observation'])
    res.json(
      rows.map((r) => {
        const bid = n(r.IDbonnetier)
        return {
          id: n(r.IDevenement_piece),
          evenement: String(r.evenement ?? '').trim(),
          observation: String(r.observation ?? '').trim(),
          IDbonnetier: bid,
          prenom: bonnetiers.get(bid)?.prenom ?? '',
          date_ms: parseDtMs(r.date_ev),
        }
      }),
    )
  } catch (err) {
    console.error('Error fetching atelier piece events:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// ── GET /api/atelier/of/:id/fils ──────────────────────────
//
// FEN_Fils_OF — where the yarn of an OF is, for the OF on the métier and for
// the one before and the one after it. Legacy, verbatim:
//
//   ZR_Fil (requête 2):
//     SELECT DISTINCT asso_fil_of.IDordre_fabrication, stock_fil.IDfournisseur,
//            stock_fil.stock, stock_fil.lot, stock_fil.emplacement,
//            stock_fil.commentaire, fournisseur.nom,
//            concat(ref_fil.reference,' - ',colori_fil.reference) AS RefColoris,
//            stock_fil.terminé
//     FROM ref_fil, asso_fil_of, colori_fil, stock_fil, fournisseur
//     WHERE fournisseur.IDfournisseur = stock_fil.IDfournisseur
//       AND stock_fil.IDstock_fil = asso_fil_of.IDstock_fil
//       AND colori_fil.IDcolori_fil = asso_fil_of.IDcolori_fil
//       AND ref_fil.IDref_fil = asso_fil_of.IDref_fil
//       AND asso_fil_of.IDordre_fabrication = {ParamIDordre_fabrication}
//       AND stock_fil.terminé = 0
//   ZR_Compo:
//     SELECT ref_fil.reference, colori_fil.reference as coloris,
//            composition_ecru.pourcentage, composition_ecru.commentaire
//     FROM composition_ecru
//     left join ref_fil … left join colori_fil …
//     where composition_ecru.IDref_ecru = {pIDRefEcru}
//       and composition_ecru.IDcolori_ecru = {pIDColorisEcru}
//     → « <pourcentage>% : <reference> - <coloris> » + ⓘ commentaire
//   reqOFPrec:
//     select evenement_piece.date, ordre_fabrication.IDordre_fabrication
//     from evenement_piece
//     left join piece_production on … left join ordre_fabrication on …
//     where ordre_fabrication.IDmachine = {pIDMachine}
//       and ordre_fabrication.IDordre_fabrication <> {pOFEnCours}
//     order by evenement_piece.date desc limit 1
//   gReqOFSuivant:
//     select IDordre_fabrication from ordre_fabrication
//     where IDmachine = {pIDMachine} and priorite = {pPriorité}   -- current + 1
//       and est_termine = 0 limit 1
//
// Departures:
//   - the previous OF is NOT found by scanning every evenement_piece of the
//     métier (the biggest table in the base, for one id): it is the OF of the
//     métier with the latest `arret_prod` — the same reading the réglage sheet
//     uses for the previous reference (TOP 20 by id, first parseable stamp).
//     An OF that ran but was never stopped is the one in front of you anyway;
//   - `stock_fil.terminé` is accented: named as `terminé AS termine` on
//     Windows, read by key prefix through SELECT * on the Linux bridge
//     (routes/stock-fil-trm.ts, same pattern). A lot that has no fournisseur
//     is kept (the legacy's inner join would drop it), with an empty name;
//   - the response carries `precedent` / `suivant` ids relative to :id; the
//     phone re-calls this route with the other id and ignores its neighbours,
//     exactly as the legacy window computes its two neighbours once and then
//     only swaps the displayed OF.
atelierRouter.get('/of/:id/fils', async (req: Request, res: Response) => {
  try {
    const id = parseOfId(req, res)
    if (id === null) return
    const loaded = await loadOf(id)
    if (!loaded) {
      res.status(404).json({ error: 'OF not found' })
      return
    }
    const { of } = loaded
    const machineId = n(of.IDmachine)
    const refId = n(of.IDref_ecru)
    const coloriId = n(of.IDcolori_ecru)
    const priorite = n(of.priorite)

    const [produites, refs, coloris, assoRaw, compoRaw, prevRows, nextRows] = await Promise.all([
      countFinishedPieces([id]),
      refId > 0 ? resolveEcruRefs([refId]) : Promise.resolve(new Map()),
      coloriId > 0 ? resolveColorisEcru([coloriId]) : Promise.resolve(new Map()),
      query<Record<string, unknown>>(
        `SELECT IDasso_fil_of, IDref_fil, IDcolori_fil, IDstock_fil FROM asso_fil_of
         WHERE IDordre_fabrication = ${id} ORDER BY IDasso_fil_of`,
      ),
      refId > 0
        ? query<Record<string, unknown>>(
            `SELECT IDcomposition_ecru, IDref_fil, IDcolori_fil, pourcentage, commentaire
             FROM composition_ecru
             WHERE IDref_ecru = ${refId} AND IDcolori_ecru = ${coloriId}
             ORDER BY IDcomposition_ecru`,
          )
        : Promise.resolve([] as Record<string, unknown>[]),
      machineId > 0
        ? query<Record<string, unknown>>(
            `SELECT TOP 20 IDordre_fabrication, arret_prod FROM ordre_fabrication
             WHERE IDmachine = ${machineId} AND IDordre_fabrication <> ${id}
             ORDER BY IDordre_fabrication DESC`,
          )
        : Promise.resolve([] as Record<string, unknown>[]),
      machineId > 0
        ? query<Record<string, unknown>>(
            `SELECT TOP 1 IDordre_fabrication FROM ordre_fabrication
             WHERE IDmachine = ${machineId} AND priorite = ${priorite + 1} AND est_termine = 0
             ORDER BY IDordre_fabrication`,
          )
        : Promise.resolve([] as Record<string, unknown>[]),
    ])

    // The lots — one row per DISTINCT lot (the legacy's DISTINCT folds the
    // feed positions that share a lot), un-finished ones only.
    const lotIds = Array.from(new Set(assoRaw.map((a) => n(a.IDstock_fil)).filter((x) => x > 0)))
    const lotRows: Record<string, unknown>[] = lotIds.length === 0
      ? []
      : IS_WINDOWS
        ? await query<Record<string, unknown>>(
            `SELECT IDstock_fil, IDfournisseur, stock, lot, emplacement, commentaire, terminé AS termine
             FROM stock_fil WHERE IDstock_fil IN (${lotIds.join(',')})`,
          )
        : await query<Record<string, unknown>>(
            `SELECT * FROM stock_fil WHERE IDstock_fil IN (${lotIds.join(',')})`,
          )
    const lotsFixed = await fixEncoding(lotRows, 'stock_fil', 'IDstock_fil', ['lot', 'emplacement', 'commentaire'])
    const lotById = new Map<number, Record<string, unknown>>()
    for (const r of lotsFixed) {
      if (n(pickVal(r, /^termin/i)) !== 0) continue
      lotById.set(n(r.IDstock_fil), r)
    }
    const fournisseurIds = Array.from(new Set(Array.from(lotById.values()).map((r) => n(r.IDfournisseur)).filter((x) => x > 0)))
    const fournisseurs = new Map<number, string>()
    if (fournisseurIds.length > 0) {
      const rows = await query<Record<string, unknown>>(
        `SELECT IDfournisseur, nom FROM fournisseur WHERE IDfournisseur IN (${fournisseurIds.join(',')})`,
      )
      for (const r of await fixEncoding(rows, 'fournisseur', 'IDfournisseur', ['nom'])) {
        fournisseurs.set(n(r.IDfournisseur), String(r.nom ?? '').trim())
      }
    }

    const compoFixed = await fixEncoding(compoRaw, 'composition_ecru', 'IDcomposition_ecru', ['commentaire'])
    const [refFilNames, coloriFilNames] = await Promise.all([
      resolveRefFilNames([...assoRaw, ...compoFixed].map((a) => n(a.IDref_fil))),
      resolveColoriFilNames([...assoRaw, ...compoFixed].map((a) => n(a.IDcolori_fil))),
    ])
    const filLabel = (rf: number, cf: number): string => {
      const r = refFilNames.get(rf) ?? ''
      const c = coloriFilNames.get(cf) ?? ''
      return c ? `${r} - ${c}` : r
    }

    const lots: {
      IDstock_fil: number
      fil: string
      lot: string
      stock: number
      emplacement: string
      fournisseur: string
      commentaire: string
    }[] = []
    const seen = new Set<number>()
    for (const a of assoRaw) {
      const lotId = n(a.IDstock_fil)
      const lot = lotById.get(lotId)
      if (!lot || seen.has(lotId)) continue
      seen.add(lotId)
      lots.push({
        IDstock_fil: lotId,
        fil: filLabel(n(a.IDref_fil), n(a.IDcolori_fil)),
        lot: String(lot.lot ?? '').trim(),
        stock: round2(Number(lot.stock) || 0),
        emplacement: String(lot.emplacement ?? '').trim(),
        fournisseur: fournisseurs.get(n(lot.IDfournisseur)) ?? '',
        commentaire: String(lot.commentaire ?? '').trim(),
      })
    }

    const composition = compoFixed.map((c) => ({
      IDcomposition_ecru: n(c.IDcomposition_ecru),
      pourcentage: Number(c.pourcentage) || 0,
      fil: filLabel(n(c.IDref_fil), n(c.IDcolori_fil)),
      commentaire: String(c.commentaire ?? '').trim(),
    }))

    const prev = prevRows
      .filter((r) => parseDtMs(r.arret_prod) !== null)
      .sort((a, b) => (parseDtMs(b.arret_prod) ?? 0) - (parseDtMs(a.arret_prod) ?? 0))[0]

    res.json({
      IDordre_fabrication: id,
      reference: refs.get(refId)?.reference ?? '',
      coloris: coloris.get(coloriId) ?? '',
      nb_pieces: n(of.nb_pieces),
      produites: produites.get(id) ?? 0,
      finir_fil: n(of.finir_fil) === 1,
      demarre: parseDtMs(of.demarrage_prod) !== null,
      termine: n(of.est_termine) === 1,
      lots,
      composition,
      precedent: prev ? n(prev.IDordre_fabrication) : null,
      suivant: nextRows[0] ? n(nextRows[0].IDordre_fabrication) : null,
    })
  } catch (err) {
    console.error('Error fetching atelier fils:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** The poste's whole read state for one OF.
 *
 *  Shared by GET /of/:id and by the write route, which re-derives the offered
 *  actions from it. That sharing is the point: the client must never be able
 *  to name an action the screen would not have offered. */
async function chargerContexte(id: number) {
  {
    const loaded = await loadOf(id)
    if (!loaded) {
      return null
    }
    const { of } = loaded
    const machineId = n(of.IDmachine)
    const refId = n(of.IDref_ecru)
    const coloriId = n(of.IDcolori_ecru)

    const [produites, refs, coloris, machines, pieces] = await Promise.all([
      countFinishedPieces([id]),
      refId > 0 ? resolveEcruRefs([refId]) : Promise.resolve(new Map()),
      coloriId > 0 ? resolveColorisEcru([coloriId]) : Promise.resolve(new Map()),
      selectMachines(),
      query<Record<string, unknown>>(
        `SELECT IDpiece_production, numero, date_debut, date_fin
         FROM piece_production WHERE IDordre_fabrication = ${id}
         ORDER BY IDpiece_production DESC`,
      ),
    ])

    const machine = machines.find((m) => m.id === machineId)
    const last = pieces[0]
    const lastPieceId = last ? n(last.IDpiece_production) : 0

    const [nettoyages, nbMessages, derniere] = await Promise.all([
      lastPieceId > 0 ? countNettoyages(lastPieceId) : Promise.resolve(0),
      countMessages(id),
      lastPieceId > 0 ? lastAction(lastPieceId) : Promise.resolve(null),
    ])

    const total = produites.get(id) ?? 0
    const poidsPiece = round2(n(of.poids_piece))

    return {
      IDordre_fabrication: id,
      IDmachine: machineId,
      machine: machine ? machine.emplacement || machine.nom : '',
      reference: refs.get(refId)?.reference ?? '',
      coloris: coloris.get(coloriId) ?? '',
      nb_pieces: n(of.nb_pieces),
      produites: total,
      finir_fil: n(of.finir_fil) === 1,
      poids_piece: poidsPiece,
      // §24 / §46.2: HFSQL stores " " for empty — trim before deciding, or the
      // consigne callout renders as an empty red box.
      consigne: String(of.observations ?? '').trim(),
      demarre: parseDtMs(of.demarrage_prod) !== null,
      interrompu: parseDtMs(of.arret_prod) !== null,
      nb_nettoyages_requis: n(of.Nettoyage),
      nb_nettoyages_faits: nettoyages,
      nb_messages: nbMessages,
      auto_activation: n(of.auto_activation) === 1,
      priorite: n(of.priorite),
      piece_en_cours: {
        // The legacy labels the piece being knitted as total + 1 — pieces
        // already finished, plus the one on the machine right now.
        numero_affiche: total + 1,
        IDpiece_production: lastPieceId,
        numero: last ? n(last.numero) : 0,
        terminee: last ? parseDtMs(last.date_fin) !== null : true,
      },
      compteur: await compteurFor(refId, machineId, poidsPiece),
      derniere_action: derniere,
    }
  }
}

type Contexte = NonNullable<Awaited<ReturnType<typeof chargerContexte>>>

async function countNettoyages(pieceId: number): Promise<number> {
  const rows = await query<{ total: number | null }>(
    `SELECT COUNT(*) AS total FROM evenement_piece
     WHERE evenement LIKE '%Nettoyage%' AND IDpiece_production = ${pieceId}`,
  )
  return n(rows[0]?.total)
}

async function countMessages(ofId: number): Promise<number> {
  const rows = await query<{ total: number | null }>(
    `SELECT COUNT(*) AS total FROM message_of WHERE IDordre_fabrication = ${ofId}`,
  )
  return n(rows[0]?.total)
}

/** The knitting counter the bonnetier dials into the métier.
 *
 *  Legacy (FEN_Action_Machine, LIB_Compteur):
 *    compteur = (ref_ecru_machine.trs_10kg_chute / ref_ecru_machine.nb_chutes)
 *               * (ordre_fabrication.poids_piece / 20) / 10
 *    compteur = Arrondi(compteur, 0) * 10
 *
 *  ⚠️ NOT the same formula as the per-piece efficiency % documented at the top
 *  of of-trm.ts, which divides by `vitesse`. Two different numbers off the same
 *  two columns — do not "unify" them.
 *
 *  Null when the reference has no sheet for this métier: the legacy blanks the
 *  label rather than guessing, and a wrong counter is a wrong piece weight. */
async function compteurFor(
  refId: number,
  machineId: number,
  poidsPiece: number,
): Promise<number | null> {
  if (refId <= 0 || machineId <= 0 || poidsPiece <= 0) return null
  const rows = await query<{ trs_10kg_chute: number | null; nb_chutes: number | null }>(
    `SELECT trs_10kg_chute, nb_chutes FROM ref_ecru_machine
     WHERE IDref_ecru = ${refId} AND IDmachine = ${machineId}`,
  )
  const trs = Number(rows[0]?.trs_10kg_chute) || 0
  const chutes = Number(rows[0]?.nb_chutes) || 0
  if (trs <= 0 || chutes <= 0) return null
  return Math.round(((trs / chutes) * (poidsPiece / 20)) / 10) * 10
}

export interface DerniereAction {
  evenement: string
  detail: string
  date_ms: number | null
  IDbonnetier: number
}

/** The « Dernière action » footer card.
 *
 *  The legacy runs one query: a UNION of evenement_piece and defaut_qualite
 *  wrapped in `select * from (…) order by date desc limit 1`. We run the two
 *  halves separately and pick the later one in JS — a UNION inside a derived
 *  table is exactly the shape that has bitten this codebase on the Linux
 *  bridge before, and the merge is three lines.
 *
 *  ⚠️ `defaut_qualite.reference` is TEXT storing an id, so it must be quoted —
 *  the same trap Qualité › Retour client documents.
 *
 *  The two visitage events are excluded, as in the legacy: they belong to the
 *  visiteuse's station, not the bonnetier's. */
async function lastAction(pieceId: number): Promise<DerniereAction | null> {
  const [evRows, dfRows] = await Promise.all([
    query<Record<string, unknown>>(
      `SELECT IDevenement_piece, DATE AS date_ev, evenement, IDbonnetier
       FROM evenement_piece WHERE IDpiece_production = ${pieceId}
       ORDER BY IDevenement_piece DESC`,
    ),
    query<Record<string, unknown>>(
      `SELECT IDdefaut_qualite, DATE AS date_ev, description, IDSpotteur
       FROM defaut_qualite
       WHERE Type_Spotteur = 1 AND Type_Reference = 1 AND reference = '${pieceId}'
       ORDER BY IDdefaut_qualite DESC`,
    ),
  ])

  const fixedEv = await fixEncoding(evRows, 'evenement_piece', 'IDevenement_piece', ['evenement'])
  const fixedDf = await fixEncoding(dfRows, 'defaut_qualite', 'IDdefaut_qualite', ['description'])

  const cands: DerniereAction[] = []
  for (const r of fixedEv as Record<string, unknown>[]) {
    const label = String(r.evenement ?? '').trim()
    if (label === 'Visitage tombé métier' || label === 'Pesage tombé métier') continue
    cands.push({
      evenement: label,
      detail: '',
      date_ms: parseDtMs(r.date_ev),
      IDbonnetier: n(r.IDbonnetier),
    })
  }
  for (const r of fixedDf as Record<string, unknown>[]) {
    cands.push({
      evenement: 'Défaut',
      // Historical rows carry doubled spaces ("Autre Barrure  Plus de 3m").
      detail: String(r.description ?? '').replace(/\s+/g, ' ').trim(),
      date_ms: parseDtMs(r.date_ev),
      IDbonnetier: n(r.IDSpotteur),
    })
  }

  if (cands.length === 0) return null
  cands.sort((a, b) => (b.date_ms ?? 0) - (a.date_ms ?? 0))
  return cands[0]
}

// ════════════════════════════════════════════════════════
//  SAISIE — the commit path
// ════════════════════════════════════════════════════════
//
// Legacy: FEN_Action_Machine / BTN_Valider, an eight-branch `selon` on the
// combo's link id. Recovered from the generated Java's CONTROL FLOW (the
// WLanguage comments lose the branch boundaries, so the `sinon`s had to come
// from the if/else chain itself), and the labels re-confirmed against the
// 25/08/2026 compile cache.
//
//   1 Lancement OF   demarrage_prod = now ; pièce n°1 ; « Début du tricotage »
//   2 Nettoyage      pièce.poids = round(poids_piece / 2) ; « Nettoyage »
//   3 Fin de pièce   close the piece (« Fin du tricotage ») then OPEN the next
//                    one (« Début du tricotage »)
//   4 Dernière pièce close the piece, arret_prod = now, AutoActivation()
//   5 Terminer OF    IDENTICAL to 4 — they differ only in when they are
//                    offered, not in what they do
//   6 Relancer OF    arret_prod = '' ; new piece if the last one is closed,
//                    otherwise just « Reprise OF »
//   7 Défaut         one defaut_qualite row on the current piece
//   8 Interrompre OF « Interruption OF » ; arret_prod = now
//
// ⚠️ NO TRANSACTION — HFSQL through this driver gives us none, exactly as in
// visitage-trm.ts. Everything checkable is checked BEFORE the first write, and
// the response reports what actually landed rather than a bare 500.
//
// ⚠️ The offered-action list is RECOMPUTED here from the stored state. The
// client's own derivation (apps/atelier/src/lib/actions.ts) decides what to
// show; this decides what may happen. A client naming an action the OF is not
// currently offering gets a 409, not a write.

const ACTIONS = [
  'Lancement OF',
  'Nettoyage',
  'Terminer OF',
  'Fin de pièce',
  'Dernière pièce',
  'Défaut',
  'Interrompre OF',
  'Relancer OF',
] as const
type ActionAtelier = (typeof ACTIONS)[number]

/** ⚠️ The combo LABEL is not the stored event string. Years of history are
 *  keyed on the right-hand side — never derive one from the other. Actions
 *  absent from this map write no evenement_piece row of their own
 *  (« Défaut » writes a defaut_qualite instead; « Fin de pièce » and the two
 *  ending actions write two rows and are handled in their branch). */
const EVENEMENT: Partial<Record<ActionAtelier, string>> = {
  'Lancement OF': 'Début du tricotage',
  Nettoyage: 'Nettoyage',
  'Interrompre OF': 'Interruption OF',
  'Relancer OF': 'Reprise OF',
}
const EVT_FIN_PIECE = 'Fin du tricotage'
const EVT_DEBUT_PIECE = 'Début du tricotage'

/** The atelier's OWN defect combo, verbatim from the legacy window
 *  (`COMBO_Défaut.setContenuInitial`, Android build 24/03/2026):
 *
 *    "Maille\r\nDémaillage\r\nBarrure Lycra\r\nAutre Barrure \r\nPlis Marchand\r\nTrou\r\nGrille\r\nAutre"
 *
 *  ⚠️ Do NOT reuse TYPES_DEFAUT's ordering for this: that list is the VISITAGE
 *  vocabulary ordered by frequency (14 entries), and the legacy's cm-vs-count
 *  test is POSITIONAL — `si COMBO_Défaut.Select() dans (1,3,4,5)`. Against the
 *  list above those positions are Maille, Barrure Lycra, Autre Barrure and
 *  Plis Marchand, which is exactly the set `uniteForType()` already calls 'cm'.
 *  The two agree on meaning; they disagree on order. We key on the type name.
 *
 *  ⚠️ « Autre Barrure » is stored in the legacy window WITH A TRAILING SPACE,
 *  and that is the origin of the 453 dirty rows `normaliseTypeDefaut()` folds
 *  on read — the same ones that once bit the Prime screen. We write the clean
 *  spelling, so this app stops adding to that pile. */
const DEFAUTS_ATELIER = [
  'Maille',
  'Démaillage',
  'Barrure Lycra',
  'Autre Barrure',
  'Plis Marchand',
  'Trou',
  'Grille',
  'Autre',
] as const

/** `COMBO_Taille.setContenuInitial` + the `SELON COMBO_Taille.Select()` that
 *  maps each position to a `taille_cm`. Both verbatim from the legacy. */
const TAILLES = [
  { label: 'Moins de 50 cm', taille_cm: 25 },
  { label: '50 cm - 1m', taille_cm: 75 },
  { label: '1m - 3m', taille_cm: 200 },
  { label: 'Plus de 3m', taille_cm: 300 },
  { label: 'Toute la pièce', taille_cm: 999 },
] as const

// GET /api/atelier/lookups/defauts — the picker's vocabulary, served rather
// than duplicated in the web bundle so there is one source for it.
atelierRouter.get('/lookups/defauts', (_req: Request, res: Response) => {
  res.json({
    types: DEFAUTS_ATELIER.map((type) => ({ type, unite: uniteForType(type) })),
    tailles: TAILLES,
  })
})

/** Mirror of apps/atelier/src/lib/actions.ts. Duplicated across the package
 *  boundary on purpose (separate builds, no shared package yet) — but THIS is
 *  the authoritative copy: the other one only decides what to render. Change
 *  them together. */
function actionsFor(ctx: Contexte, estRegleur: boolean): ActionAtelier[] {
  if (!ctx.demarre) return ['Lancement OF']
  const out: ActionAtelier[] = []
  if (ctx.nb_nettoyages_faits < ctx.nb_nettoyages_requis) out.push('Nettoyage')
  if (ctx.produites + 1 >= ctx.nb_pieces && !ctx.finir_fil) out.push('Terminer OF')
  else out.push('Fin de pièce')
  if (ctx.finir_fil) out.push('Dernière pièce')
  out.push('Défaut')
  if (estRegleur) out.push(ctx.interrompu ? 'Relancer OF' : 'Interrompre OF')
  return out
}

const saisieBody = z.object({
  action: z.enum(ACTIONS),
  IDbonnetier: z.number().int().positive(),
  /** The legacy stamps `evenement_piece.appareil` with its hard-coded terminal
   *  name (NomAppareil()). Since enrolment the server stamps the phone's own
   *  label (lib/appareils-atelier.ts); this field is only a fallback and is
   *  ignored when the phone has one. */
  appareil: z.string().max(50).optional(),
  defaut: z
    .object({
      type: z.enum(DEFAUTS_ATELIER),
      /** 1-based index into TAILLES. Required for a cm-type, ignored otherwise. */
      taille: z.number().int().min(1).max(TAILLES.length).optional(),
    })
    .optional(),
})

// POST /api/atelier/of/:id/evenement
atelierRouter.post('/of/:id/evenement', async (req: Request, res: Response) => {
  try {
    // ── Gate. attachUser() is best-effort and there is no global guard, so
    // every write route in TRM carries its own (CLAUDE.md § Paramètres >
    // Utilisateurs). Here it is gateSaisie(): an enrolled phone, its account's
    // `saisie_atelier`, and a bonnetier the phone may speak for — WHO did the
    // work travels in IDbonnetier, which is the legacy's own model.
    const id = parseInt(String(req.params.id), 10)
    if (!Number.isInteger(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' })
      return
    }
    const parsed = saisieBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.issues })
      return
    }
    const body = parsed.data

    const who = await gateSaisie(req, res, body.IDbonnetier)
    if (!who) return

    // ── Everything checkable, checked before the first write.
    const ctx = await chargerContexte(id)
    if (!ctx) {
      res.status(404).json({ error: 'OF not found' })
      return
    }

    const offertes = actionsFor(ctx, who.regleur === 1)
    if (!offertes.includes(body.action)) {
      res.status(409).json({
        error: 'action_indisponible',
        message: `« ${body.action} » n'est pas proposée sur cet OF en ce moment.`,
        offertes,
      })
      return
    }

    let unite: 'cm' | 'nb' = 'nb'
    if (body.action === 'Défaut') {
      if (!body.defaut) {
        res.status(400).json({ error: 'defaut requis' })
        return
      }
      unite = uniteForType(body.defaut.type)
      if (unite === 'cm' && !body.defaut.taille) {
        res.status(400).json({ error: 'taille requise pour ce type de défaut' })
        return
      }
    }

    const pieceId = ctx.piece_en_cours.IDpiece_production
    // Every branch except « Lancement OF » writes against an existing piece.
    if (body.action !== 'Lancement OF' && pieceId <= 0) {
      res.status(409).json({ error: 'aucune_piece', message: "Cet OF n'a aucune pièce ouverte." })
      return
    }

    // The phone's enrolment label — the legacy's terminal name, from the
    // server's own row rather than whatever the client claims.
    const appareil = (who.appareil || body.appareil || '').slice(0, 50)
    const ecrits: string[] = []

    // ── Writes. Past this line a failure is partial, and the response says so.
    switch (body.action) {
      case 'Lancement OF': {
        await query(
          `UPDATE ordre_fabrication SET demarrage_prod = '${nowDt()}' WHERE IDordre_fabrication = ${id}`,
        )
        ecrits.push('demarrage_prod')
        const newPieceId = await creerPiece(id, 1)
        ecrits.push(`piece ${newPieceId}`)
        await ecrireEvenement(newPieceId, EVT_DEBUT_PIECE, body.IDbonnetier, appareil)
        ecrits.push(EVT_DEBUT_PIECE)
        break
      }

      case 'Nettoyage': {
        // The legacy marks the piece half-done by weight — this is what makes
        // « 1/2 Nettoyages » on the OF fiche mean anything.
        await query(
          `UPDATE piece_production SET poids = ${Math.round(ctx.poids_piece / 2)} WHERE IDpiece_production = ${pieceId}`,
        )
        await ecrireEvenement(pieceId, 'Nettoyage', body.IDbonnetier, appareil)
        ecrits.push('Nettoyage')
        break
      }

      case 'Fin de pièce': {
        if (!ctx.piece_en_cours.terminee) {
          await fermerPiece(pieceId, ctx.poids_piece)
          await ecrireEvenement(pieceId, EVT_FIN_PIECE, body.IDbonnetier, appareil)
          ecrits.push(EVT_FIN_PIECE)
        }
        const suivante = await creerPiece(id, ctx.piece_en_cours.numero + 1)
        ecrits.push(`piece ${suivante}`)
        await ecrireEvenement(suivante, EVT_DEBUT_PIECE, body.IDbonnetier, appareil)
        ecrits.push(EVT_DEBUT_PIECE)
        break
      }

      // Branches 4 and 5 of the legacy are byte-for-byte the same work. Kept
      // as one case rather than "unified" — they are two different decisions
      // by the operator, and the OF fiche's history reads better for it.
      case 'Dernière pièce':
      case 'Terminer OF': {
        await fermerPiece(pieceId, ctx.poids_piece)
        await ecrireEvenement(pieceId, EVT_FIN_PIECE, body.IDbonnetier, appareil)
        ecrits.push(EVT_FIN_PIECE)
        await query(
          `UPDATE ordre_fabrication SET arret_prod = '${nowDt()}' WHERE IDordre_fabrication = ${id}`,
        )
        ecrits.push('arret_prod')
        // Close the OF the way the web button does (est_termine, priorite,
        // re-rank, auto-activation of the head) — see lib/of-queue-trm.ts for
        // why the legacy est_actif-only flip was abandoned (LIVA #1128).
        const { activated } = await terminerOf(id, ctx.IDmachine, { stampArret: false })
        ecrits.push('OF terminé')
        if (activated > 0) ecrits.push(`OF ${activated} activé`)
        break
      }

      case 'Interrompre OF': {
        await ecrireEvenement(pieceId, 'Interruption OF', body.IDbonnetier, appareil)
        await query(
          `UPDATE ordre_fabrication SET arret_prod = '${nowDt()}' WHERE IDordre_fabrication = ${id}`,
        )
        ecrits.push('Interruption OF')
        break
      }

      case 'Relancer OF': {
        // ⚠️ The legacy also stamps `ordre_fabrication.interruption_prod` with
        // the elapsed stop time. We deliberately do NOT: it is the only HFSQL
        // *Durée* column in the whole MPS database, OF_COLUMNS excludes it
        // because READING it emits invalid JSON on the Linux bridge, and
        // nothing in either app consumes it. Writing a guessed encoding into a
        // column we cannot read back to verify is worse than leaving the
        // legacy's last value in place. Revisit only if something starts
        // reading it.
        await query(
          `UPDATE ordre_fabrication SET arret_prod = '' WHERE IDordre_fabrication = ${id}`,
        )
        ecrits.push('arret_prod effacé')
        if (ctx.piece_en_cours.terminee) {
          const suivante = await creerPiece(id, ctx.piece_en_cours.numero + 1)
          ecrits.push(`piece ${suivante}`)
          await ecrireEvenement(suivante, EVT_DEBUT_PIECE, body.IDbonnetier, appareil)
          ecrits.push(EVT_DEBUT_PIECE)
        } else {
          await ecrireEvenement(pieceId, 'Reprise OF', body.IDbonnetier, appareil)
          ecrits.push('Reprise OF')
        }
        break
      }

      case 'Défaut': {
        const d = body.defaut!
        const taille = d.taille ? TAILLES[d.taille - 1] : null
        // The legacy builds the description as the type plus, for a cm-type,
        // the size label — which is why live rows read « Maille Moins de 50 cm ».
        const description = unite === 'cm' && taille ? `${d.type} ${taille.label}` : d.type
        await ecrireDefaut({
          pieceId,
          type: d.type,
          description,
          IDbonnetier: body.IDbonnetier,
          taille_cm: unite === 'cm' && taille ? taille.taille_cm : 0,
          // The legacy sets nombre = 1 for a count-type and 0 for a cm-type.
          nombre: unite === 'nb' ? 1 : 0,
        })
        ecrits.push(`défaut ${description}`)
        break
      }
    }

    const apres = await chargerContexte(id)
    res.json({ ok: true, ecrits, contexte: apres })
  } catch (err) {
    console.error('Error saving atelier evenement:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

/** New `piece_production`. Named-column INSERT: the table carries no reserved
 *  and no accented column, so there is no reason to reach for the positional
 *  form the rest of this codebase needs elsewhere.
 *
 *  `poids` starts at 0 — the legacy leaves it untouched until a Nettoyage
 *  (half) or a fin de pièce (full) sets it. */
async function creerPiece(ofId: number, numero: number): Promise<number> {
  const newId = (await maxId('piece_production', 'IDpiece_production')) + 1
  await query(
    `INSERT INTO piece_production (IDpiece_production, IDordre_fabrication, numero, date_debut, poids)
     VALUES (${newId}, ${ofId}, ${numero}, '${nowDt()}', 0)`,
  )
  return newId
}

async function fermerPiece(pieceId: number, poidsPiece: number): Promise<void> {
  await query(
    `UPDATE piece_production SET date_fin = '${nowDt()}', poids = ${Math.round(poidsPiece)}
     WHERE IDpiece_production = ${pieceId}`,
  )
}

/** `evenement_piece` — positional INSERT, MAX+1 PK: `DATE` is reserved.
 *  Physical order (runtime SELECT * key order, same as visitage-trm.ts):
 *    IDevenement_piece, evenement, IDpiece_production, DATE, IDbonnetier,
 *    observation, IDstock_ecru, appareil */
async function ecrireEvenement(
  pieceId: number,
  evenement: string,
  IDbonnetier: number,
  appareil: string,
): Promise<number> {
  const newId = (await maxId('evenement_piece', 'IDevenement_piece')) + 1
  await query(
    `INSERT INTO evenement_piece VALUES (${newId}, ${sqlText(evenement)}, ${pieceId}, '${nowDt()}', ` +
      `${IDbonnetier}, NULL, 0, ${sqlText(appareil)})`,
  )
  return newId
}

/** `defaut_qualite` — positional, MAX+1 PK: `traité` and `récuperé` are
 *  accented and the Linux bridge refuses to name them.
 *  Physical order (runtime SELECT * key order):
 *    IDdefaut_qualite, reference, description, DATE, Type_Spotteur, IDSpotteur,
 *    Type_Reference, type_defaut, traité, taille_cm, récuperé, nombre
 *
 *  ⚠️ `reference` is TEXT holding an id — it must be quoted.
 *  Type_Spotteur 1 = Bonnetier (the machine), Type_Reference 1 = piece_production.
 *  The visitage poste later converts these rows to Type_Reference 2 pointing at
 *  the roll, preserving Type_Spotteur — which is what still distinguishes a
 *  terminal defect from a visitage one years later. */
async function ecrireDefaut(d: {
  pieceId: number
  type: string
  description: string
  IDbonnetier: number
  taille_cm: number
  nombre: number
}): Promise<number> {
  const newId = (await maxId('defaut_qualite', 'IDdefaut_qualite')) + 1
  await query(
    `INSERT INTO defaut_qualite VALUES (${newId}, '${d.pieceId}', ${sqlText(d.description)}, ` +
      `'${nowDt()}', 1, ${d.IDbonnetier}, 1, ${sqlText(d.type)}, 0, ${d.taille_cm}, 0, ${d.nombre})`,
  )
  return newId
}

// The legacy AutoActivation() — `SELECT … WHERE IDmachine = ? AND priorite =
// finished + 1 AND auto_activation = 1`, flip est_actif when EXACTLY one row —
// used to be reproduced here verbatim. It leaves the finished OF with
// est_termine = 0 and its old rank, which the ERP reads as « En attente » and
// Visitage as the queue head (LIVA #1128, 2026-09-07). The phone now closes an
// OF through lib/of-queue-trm.ts terminerOf, the same path as the web button;
// the Android terminals still in use write the old shape, which
// healHandedOverOfs repairs on the ERP reads.
