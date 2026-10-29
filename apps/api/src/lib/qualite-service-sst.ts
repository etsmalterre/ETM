// Sous-traitants › Gestion › « Qualité de service » (LIVA #1314, Vincent 2026-10-22):
// how a sous-traitant answers and keeps its délais, read from facts ETM
// already holds — nothing is typed for it.
//
//   1. Réponse au délai — from the first bon de commande email to the first
//      délai received on a line (lib/delai-sst.ts), in working days, with the
//      relances it took. An order whose wait was REPORTED « de notre fait »
//      (yarn not there, client undecided) is set aside: the wait was ours.
//      Délais received before 2026-10-14 have no date in ETM (the journal's
//      « changements » start then; scripts/delai-sst-historique.ts) — those
//      orders are « non mesurées », never guessed.
//   2. Respect du délai — the FIRST délai given (the one recorded at the
//      answer, else the capture-once `date_delai`, else `date_livraison`)
//      against the first lot received (suivilot.date). A délai moved later
//      for the client does not excuse the dyer, nor accuse it: only the first
//      promise is judged.
//
// Native PostgreSQL, flat reads merged in JS. Pure rules exported for tests.

import { mpsPg } from './mps-pg.js'
import { DELAI_PREMIERE_DEMANDE_J, lireFaitsDelai, type FaitsDelai } from './delai-sst.js'
import { fermetures as lireFermetures, standards, STANDARDS_DEFAUT } from './delais-standards.js'
import { joursOuvresEntre as joursOuvresYmd, type Periode } from './jours-ouvres.js'

/** Working days from `a` to `b` (YYYY-MM-DD; b after a → positive): weekends, French holidays and the
 *  partner's closures out (lib/jours-ouvres.ts). Pure. */
export function joursOuvresEntre(a: string, b: string, fermetures: readonly Periode[] = []): number {
  return joursOuvresYmd(a.replace(/-/g, ''), b.replace(/-/g, ''), fermetures)
}

export interface CommandeReponse {
  idcommande: number
  demandeLe: string
  reponduLe: string | null
  /** Working days to answer (or waited so far when not answered). */
  jours: number
  relances: number
  enAttente: boolean
  /** A report « de notre fait »: left out of the averages. */
  neutralisee: boolean
  /** Reports imputed to the sous-traitant. */
  reportsSst: number
}

/** One order's answer to the délai question. null = not measurable. Pure. */
export function reponseCommande(idcommande: number, f: FaitsDelai, enAttente: boolean, aujourdhui: string): CommandeReponse | null {
  if (!f.demandeLe) return null
  if (!f.reponduLe && !enAttente) return null // answered before ETM recorded it
  const fin = f.reponduLe ?? aujourdhui
  return {
    idcommande,
    demandeLe: f.demandeLe,
    reponduLe: f.reponduLe,
    jours: Math.max(0, joursOuvresEntre(f.demandeLe, fin)),
    relances: f.relances.filter((r) => r.jour >= f.demandeLe! && r.jour <= fin).length,
    enAttente: !f.reponduLe && enAttente,
    neutralisee: f.reports.some((r) => r.imputable === 'malterre'),
    reportsSst: f.reports.filter((r) => r.imputable === 'sous_traitant').length,
  }
}

export interface LigneRespect {
  idcommande: number
  idligne: number
  reference: string
  delaiPromis: string
  /** The order date (commande_sous_traitant.date_commande), YYYY-MM-DD */
  commandeLe: string | null
  /** Working days from the order to the first lot received (to today while open): the real délai, compared
   *  with the partner's délai standard on the chart (lib/delais-standards.ts). */
  dureeJours: number | null
  premiereReception: string | null
  /** Working days late (0 = on time). For an open line not received, late so far. */
  retard: number
  /** Nothing received yet and the promised day has passed. */
  enRetardOuvert: boolean
}

export interface SyntheseQualite {
  reponse: {
    mesurees: number
    /** Average working days, over measured answered orders not set aside. */
    moyenneJours: number | null
    /** Share answered within DELAI_PREMIERE_DEMANDE_J working days. */
    partDansLesTemps: number | null
    relancesMoyennes: number | null
    enAttente: number
    neutralisees: number
    nonMesurees: number
    reportsSst: number
    seuilJours: number
  }
  respect: {
    lignes: number
    aLHeure: number
    partALHeure: number | null
    /** Average working days late, over late lines only. */
    retardMoyen: number | null
    enRetardOuvertes: number
  }
}

const moyenne = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null)

/** The figures of the tab. Pure. */
export function synthese(reponses: CommandeReponse[], nonMesurees: number, lignes: LigneRespect[]): SyntheseQualite {
  const repondues = reponses.filter((r) => !r.enAttente && !r.neutralisee)
  const recues = lignes.filter((l) => l.premiereReception)
  const enRetard = recues.filter((l) => l.retard > 0)
  return {
    reponse: {
      mesurees: repondues.length,
      moyenneJours: moyenne(repondues.map((r) => r.jours)),
      partDansLesTemps: repondues.length ? repondues.filter((r) => r.jours <= DELAI_PREMIERE_DEMANDE_J).length / repondues.length : null,
      relancesMoyennes: moyenne(repondues.map((r) => r.relances)),
      enAttente: reponses.filter((r) => r.enAttente).length,
      neutralisees: reponses.filter((r) => r.neutralisee && !r.enAttente).length,
      nonMesurees,
      reportsSst: reponses.reduce((n, r) => n + r.reportsSst, 0),
      seuilJours: DELAI_PREMIERE_DEMANDE_J,
    },
    respect: {
      lignes: recues.length,
      aLHeure: recues.length - enRetard.length,
      partALHeure: recues.length ? (recues.length - enRetard.length) / recues.length : null,
      retardMoyen: moyenne(enRetard.map((l) => l.retard)),
      enRetardOuvertes: lignes.filter((l) => l.enRetardOuvert).length,
    },
  }
}

// ── Reads ────────────────────────────────────────────────

const TYPE_DOC_BON = 13
/** First day a délai received has a date in ETM (journal « changements »). */
export const REPONSE_MESUREE_DEPUIS = '2026-10-14'

export interface QualiteService {
  depuis: string
  /** Délais received before this day are not dated (REPONSE_MESUREE_DEPUIS). */
  reponseMesureeDepuis: string
  synthese: SyntheseQualite
  reponses: CommandeReponse[]
  lignes: LigneRespect[]
  /** The partner's délai standard in working days (dyers: Sous-traitants › Gestion › Info), the chart's target. */
  standardJours: number
}

export async function qualiteService(idsousTraitant: number, depuis: string, aujourdhui: string): Promise<QualiteService> {
  const sql = mpsPg()
  // 1. Orders whose bon de commande first left in the period.
  const bons = await sql<{ id: number }[]>`
    SELECT c.idcommande_sous_traitant AS id
    FROM commande_sous_traitant c
    JOIN (SELECT idreference, min(date) AS premier FROM envoi_email WHERE idtype_doc = ${TYPE_DOC_BON} GROUP BY idreference) e
      ON e.idreference = c.idcommande_sous_traitant
    WHERE c.idsous_traitant = ${idsousTraitant} AND e.premier >= ${depuis}::date`
  const ids = bons.map((b) => Number(b.id))
  const [faits, attente] = await Promise.all([
    lireFaitsDelai(ids, sql),
    ids.length === 0 ? Promise.resolve([] as { id: number }[]) : sql<{ id: number }[]>`
      SELECT DISTINCT l.idcommande_sous_traitant AS id
      FROM ligne_commande_sous_traitant l JOIN commande_sous_traitant c ON c.idcommande_sous_traitant = l.idcommande_sous_traitant
      WHERE l.idcommande_sous_traitant = ANY(${ids}) AND trim(l.sstatut::text) = 'Attente_Delai' AND COALESCE(c.est_soldee, 0) = 0`,
  ])
  const enAttente = new Set(attente.map((r) => Number(r.id)))
  const reponses: CommandeReponse[] = []
  let nonMesurees = 0
  for (const id of ids) {
    const r = reponseCommande(id, faits.get(id)!, enAttente.has(id), aujourdhui)
    if (r) reponses.push(r)
    // Answered before ETM dated it: counted only when it should have been dated.
    else if ((faits.get(id)!.demandeLe ?? '') >= REPONSE_MESUREE_DEPUIS) nonMesurees++
  }
  reponses.sort((a, b) => b.demandeLe.localeCompare(a.demandeLe) || b.idcommande - a.idcommande)

  // 2. Lines with a promised délai: first lot received in the period, or still
  //    open and past their promise.
  const lignesRows = await sql<{ cmd: number; id: number; reference: string | null; promis: string | null; recu: string | null; termine: boolean; soldee: number; donne: string | null; commande: string | null }[]>`
    SELECT l.idcommande_sous_traitant AS cmd, l.idligne_commande_sous_traitant AS id, rf.reference::text AS reference,
           to_char(c.date_commande, 'YYYY-MM-DD') AS commande,
           to_char(COALESCE(l.date_delai, l.date_livraison), 'YYYY-MM-DD') AS promis,
           to_char(s.premier, 'YYYY-MM-DD') AS recu,
           COALESCE(l.sstatut::text, '') LIKE 'Termin%' AS termine, COALESCE(c.est_soldee, 0)::int AS soldee,
           to_char(d.donne, 'YYYY-MM-DD') AS donne
    FROM ligne_commande_sous_traitant l
    JOIN commande_sous_traitant c ON c.idcommande_sous_traitant = l.idcommande_sous_traitant
    LEFT JOIN ref_fini rf ON rf.idref_fini = l.idreference AND l.type = 2
    LEFT JOIN (SELECT idligne_commande_sous_traitant AS ligne, min(date) AS premier FROM suivilot GROUP BY 1) s
      ON s.ligne = l.idligne_commande_sous_traitant
    LEFT JOIN (SELECT DISTINCT ON (idligne_commande_sous_traitant) idligne_commande_sous_traitant AS ligne, delai_donne AS donne
               FROM delai_sst_evenement WHERE type = 'delai_recu' AND delai_donne IS NOT NULL
               ORDER BY idligne_commande_sous_traitant, le) d ON d.ligne = l.idligne_commande_sous_traitant
    WHERE c.idsous_traitant = ${idsousTraitant} AND l.type = 2
      AND trim(COALESCE(l.sstatut::text, '')) NOT IN ('Non_Envoye', 'Attente_Delai')
      AND (s.premier >= ${depuis}::date
           OR (s.premier IS NULL AND COALESCE(c.est_soldee, 0) = 0 AND c.date_commande >= ${depuis}::date))`
  // Its closures, past ones included: a closed month is no délai (MATEL, August 2026).
  const fermes = (await lireFermetures([idsousTraitant], true)).get(idsousTraitant) ?? []
  const jo = (a: string, b: string) => joursOuvresEntre(a, b, fermes)
  const lignes: LigneRespect[] = []
  for (const l of lignesRows) {
    const promis = l.donne ?? l.promis
    if (!promis) continue
    const base = { idcommande: Number(l.cmd), idligne: Number(l.id), reference: (l.reference ?? '').trim(), delaiPromis: promis, commandeLe: l.commande }
    const duree = (fin: string) => (l.commande ? Math.max(0, jo(l.commande, fin)) : null)
    if (l.recu) {
      lignes.push({ ...base, dureeJours: duree(l.recu), premiereReception: l.recu, retard: Math.max(0, jo(promis, l.recu)), enRetardOuvert: false })
    } else if (!l.termine && !Number(l.soldee) && promis < aujourdhui) {
      lignes.push({ ...base, dureeJours: duree(aujourdhui), premiereReception: null, retard: Math.max(0, jo(promis, aujourdhui)), enRetardOuvert: true })
    }
  }
  lignes.sort((a, b) => (b.premiereReception ?? '9999').localeCompare(a.premiereReception ?? '9999') || b.idligne - a.idligne)

  const standardJours = (await standards([idsousTraitant])).get(idsousTraitant)?.ennoblissement_jours ?? STANDARDS_DEFAUT.ennoblissement_jours
  return { depuis, reponseMesureeDepuis: REPONSE_MESUREE_DEPUIS, synthese: synthese(reponses, nonMesurees, lignes), reponses, lignes, standardJours }
}
