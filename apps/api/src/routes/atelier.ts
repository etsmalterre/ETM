// Atelier — the bonnetier/régleur PWA's read API (TRM, host atelier.malterre).
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
import { query, fixEncoding } from '../lib/hfsql-auto.js'
import {
  selectMachines,
  selectBonnetiers,
  resolveEcruRefs,
  resolveColorisEcru,
  parseDtMs,
  round2,
  loadOf,
} from '../lib/production-trm.js'

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
atelierRouter.get('/machines', async (_req: Request, res: Response) => {
  try {
    const machines = (await selectMachines()).filter((m) => m.archive === 0)

    // Active OFs, one per métier at most (the queue invariant).
    const ofRows = await query<Record<string, unknown>>(
      `SELECT IDordre_fabrication, IDmachine, nb_pieces, finir_fil, quantite, poids_piece,
              demarrage_prod, arret_prod, auto_activation, prioritaire, priorite,
              IDref_ecru, IDcolori_ecru, observations
       FROM ordre_fabrication WHERE est_actif = 1`,
    )
    const ofs = await fixEncoding(ofRows, 'ordre_fabrication', 'IDordre_fabrication', ['observations'])

    const ofIds = ofs.map((o) => n(o.IDordre_fabrication)).filter((x) => x > 0)
    const [produites, refs, coloris] = await Promise.all([
      countFinishedPieces(ofIds),
      resolveEcruRefs(ofs.map((o) => n(o.IDref_ecru)).filter((x) => x > 0)),
      resolveColorisEcru(ofs.map((o) => n(o.IDcolori_ecru)).filter((x) => x > 0)),
    ])

    const byMachine = new Map<number, Record<string, unknown>>()
    for (const o of ofs) byMachine.set(n(o.IDmachine), o)

    const payload = machines.map((m) => {
      const o = byMachine.get(m.id)
      const ofId = o ? n(o.IDordre_fabrication) : 0
      const nbPieces = o ? n(o.nb_pieces) : 0
      const finirFil = o ? n(o.finir_fil) === 1 : false
      const total = produites.get(ofId) ?? 0
      // The legacy's own predicate, verbatim in meaning: a métier is "active"
      // when it still owes pieces, or when it runs until the yarn is gone.
      const actif = ofId > 0 && (total < nbPieces || finirFil)
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
              demarre: parseDtMs(o!.demarrage_prod) !== null,
              interrompu: parseDtMs(o!.arret_prod) !== null,
            }
          : null,
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

/** Finished pieces per OF. See departure (2) above: the count is done in JS on
 *  parsed dates, never with `date_fin <> ''` in the WHERE. */
async function countFinishedPieces(ofIds: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  const ids = ofIds.filter((x) => x > 0)
  if (ids.length === 0) return out
  for (const id of ids) out.set(id, 0)
  const rows = await query<Record<string, unknown>>(
    `SELECT IDordre_fabrication, date_fin FROM piece_production
     WHERE IDordre_fabrication IN (${ids.join(',')})`,
  )
  for (const r of rows) {
    if (parseDtMs(r.date_fin) === null) continue // still on the machine
    const k = n(r.IDordre_fabrication)
    out.set(k, (out.get(k) ?? 0) + 1)
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

    const loaded = await loadOf(id)
    if (!loaded) {
      res.status(404).json({ error: 'OF not found' })
      return
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

    res.json({
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
    })
  } catch (err) {
    console.error('Error fetching atelier OF:', err)
    res.status(500).json({ error: 'Internal server error' })
  }
})

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
