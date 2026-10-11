// Sous-traitants › Tricotage: the status, the kg gauge and the late frame of
// a knitting order (sous-traitant IDtype_sst = 1), apart from ennoblissement
// since 2026-10-11 (Vincent: the two lifecycles have nothing in common).
//
// Measured on 597 knitting orders over two years (mps_dev, 2026-10-11):
// 98 % go to Tricotage Malterre, no bon de commande was ever emailed to it
// (the line `sstatut` says « Non envoyé » on orders already knitting), the
// first OF is created the same day, the first shipment comes at 7 days, the
// last at 9 (90 % within 39). So for TRM the useful facts are « can TRM
// start » (yarn assigned, #1159: no OF on a mirror line without it), « is it
// knitting », « is it late », « how far along » (the gauge), and « TRM has
// soldé, ETM must check and close ».
//
// Statuses, first match wins:
//   terminee        est_soldee = 1
//   trm_soldee      the TRM mirror is soldée (every OF done, every roll shipped)
//   en_tricotage    TRM: an OF on a mirror line, or a rectiligne-only order
//                   (cols / bandes never get an OF, #1185)
//                   external knitter: délai announced, or rolls received
//   a_lancer        TRM: yarn assigned on every circulaire line, no OF yet
//   fil_a_affecter  TRM: a circulaire line has no yarn assigned: ETM's move
//   attente_delai   external knitter: bon de commande sent, no délai yet
//   non_envoye      external knitter: bon de commande not sent (« À envoyer »)
// « Livrée en partie » was considered and left out (Vincent): the gauge
// shows it.

import { mpsPg } from './mps-pg.js'
import { SEUIL_EXPEDIE } from './statut-ligne-client.js'
import { LINE_TYPE_RECTILIGNE } from './sst-line-kind.js'

export const TYPE_SST_TRICOTEUR = 1
export const TRICOTAGE_MALTERRE_ID = 1

export type SstFamille = 'ennoblissement' | 'tricotage'

export function parseFamille(raw: unknown): SstFamille | null {
  return raw === 'ennoblissement' || raw === 'tricotage' ? raw : null
}

/** An order belongs to Tricotage when its sous-traitant is a tricoteur, to
 *  Ennoblissement otherwise: the « Autre » and « Confectionneur » types
 *  never had an order (2026-10-11), the one untyped order is a dye job. */
export function familleOfTypeSst(IDtype_sst: number | null | undefined): SstFamille {
  return Number(IDtype_sst) === TYPE_SST_TRICOTEUR ? 'tricotage' : 'ennoblissement'
}

export type TricotagePhase =
  | 'non_envoye'
  | 'attente_delai'
  | 'fil_a_affecter'
  | 'a_lancer'
  | 'en_tricotage'
  | 'trm_soldee'
  | 'terminee'

export interface LigneTricotage {
  id: number
  /** sst line type: 1 circulaire, 4 rectiligne. */
  type: number
  /** kg on a circulaire line, pieces (U) on a rectiligne one. */
  quantite: number
  /** YYYYMMDD or '' */
  date_livraison: string
  /** Legacy line status rank: 0 Non_Envoye, 1 Attente_Delai, 2 anything else. */
  rang_statut: 0 | 1 | 2
  fil_affecte: boolean
  a_un_of: boolean
  kg_tricote: number
  kg_livre: number
}

export interface CommandeTricotage {
  est_soldee: boolean
  /** Ordered from Tricotage Malterre (the sister company, mirrored in TRM). */
  trm: boolean
  trm_soldee: boolean
  lignes: LigneTricotage[]
}

function isRectiligne(l: LigneTricotage): boolean {
  return l.type === LINE_TYPE_RECTILIGNE
}

export function phaseTricotage(c: CommandeTricotage): TricotagePhase {
  if (c.est_soldee) return 'terminee'
  if (c.trm_soldee) return 'trm_soldee'
  const circulaires = c.lignes.filter((l) => !isRectiligne(l))
  if (c.trm) {
    if (c.lignes.some((l) => l.a_un_of)) return 'en_tricotage'
    if (c.lignes.length > 0 && circulaires.length === 0) return 'en_tricotage'
    // An empty order is ETM's move too: nothing to launch yet.
    if (circulaires.length === 0 || circulaires.some((l) => !l.fil_affecte)) return 'fil_a_affecter'
    return 'a_lancer'
  }
  const rang = Math.max(0, ...c.lignes.map((l) => l.rang_statut))
  if (rang === 2 || c.lignes.some((l) => l.kg_tricote > 0)) return 'en_tricotage'
  if (rang === 1) return 'attente_delai'
  return 'non_envoye'
}

export interface JaugeTricotage {
  kg_commande: number
  kg_tricote: number
  kg_livre: number
}

/** kg over the circulaire lines only; a rectiligne line counts pieces. */
export function jaugeTricotage(c: CommandeTricotage): JaugeTricotage {
  const j: JaugeTricotage = { kg_commande: 0, kg_tricote: 0, kg_livre: 0 }
  for (const l of c.lignes) {
    if (isRectiligne(l)) continue
    j.kg_commande += l.quantite
    j.kg_tricote += l.kg_tricote
    j.kg_livre += l.kg_livre
  }
  return {
    kg_commande: Math.round(j.kg_commande * 10) / 10,
    kg_tricote: Math.round(j.kg_tricote * 10) / 10,
    kg_livre: Math.round(j.kg_livre * 10) / 10,
  }
}

/** A circulaire line is delivered at SEUIL_EXPEDIE of its kg (the threshold
 *  Clients › Commandes uses); a rectiligne line is never followed after the
 *  order (no OF, no piece, no shipment, #1185), so only « soldée » ends it. */
function ligneLivree(l: LigneTricotage): boolean {
  if (isRectiligne(l)) return false
  return l.quantite > 0 && l.kg_livre >= l.quantite * SEUIL_EXPEDIE
}

export type Urgence = 'late' | 'soon' | null

function dayOf(yyyymmdd: string): Date | null {
  if (!/^\d{8}$/.test(yyyymmdd)) return null
  return new Date(Number(yyyymmdd.slice(0, 4)), Number(yyyymmdd.slice(4, 6)) - 1, Number(yyyymmdd.slice(6, 8)))
}

function addWorkingDays(base: Date, n: number): Date {
  const r = new Date(base.getFullYear(), base.getMonth(), base.getDate())
  let added = 0
  while (added < n) {
    r.setDate(r.getDate() + 1)
    const dow = r.getDay()
    if (dow !== 0 && dow !== 6) added++
  }
  return r
}

/** Red when a line not yet delivered is due today or earlier, amber within 3
 *  days. A line without a date raises nothing (TRM announces it; the
 *  ennoblissement rule « no date = late » would flag every fresh order).
 *  Attente délai keeps the ennoblissement relance rule (`date_notif`, else
 *  bon sent + 3 working days). Soldée par TRM is never late: the goods are
 *  in, what is left is ETM's check. */
export function urgenceTricotage(
  c: CommandeTricotage,
  phase: TricotagePhase,
  relance: { date_notif: string; bon_envoye_le: string },
  today: Date = new Date(),
): Urgence {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  if (phase === 'terminee' || phase === 'trm_soldee') return null
  if (phase === 'attente_delai') {
    let notif = dayOf(relance.date_notif)
    if (!notif) {
      const sent = dayOf(relance.bon_envoye_le)
      notif = sent ? addWorkingDays(sent, 3) : null
    }
    if (!notif) return null
    if (notif.getTime() <= t.getTime()) return 'late'
    if (notif.getTime() <= addWorkingDays(t, 1).getTime()) return 'soon'
    return null
  }
  let earliest: Date | null = null
  for (const l of c.lignes) {
    if (ligneLivree(l)) continue
    const d = dayOf(l.date_livraison)
    if (d && (!earliest || d < earliest)) earliest = d
  }
  if (!earliest) return null
  const diff = Math.round((earliest.getTime() - t.getTime()) / 86_400_000)
  if (diff <= 0) return 'late'
  if (diff <= 3) return 'soon'
  return null
}

export interface EtatTricotage {
  phase: TricotagePhase
  urgence: Urgence
  jauge: JaugeTricotage
}

function rangStatut(sstatut: string | null): 0 | 1 | 2 {
  const s = (sstatut ?? '').trim()
  if (s === 'Non_Envoye') return 0
  if (s === 'Attente_Delai') return 1
  return 2
}

/** Tricoteur sous-traitant ids (8 in 2026). */
export async function tricoteurIds(): Promise<number[]> {
  const rows = await mpsPg()<{ id: number }[]>`
    SELECT idsous_traitant AS id FROM sous_traitant WHERE idtype_sst = ${TYPE_SST_TRICOTEUR}`
  return rows.map((r) => Number(r.id))
}

/** Status, gauge and urgency of knitting orders, in a few flat reads.
 *  Knitted kg = pieces of the OFs on the mirror lines (TRM production is
 *  counted by OF, never by IDsociete, per CLAUDE.md), shipped = those with a
 *  TRM expedition line; an external knitter's rolls are created at ETM on
 *  reception (`IDref_commande_source`), so knitted = delivered. */
export async function etatsTricotage(ids: number[], today: Date = new Date()): Promise<Map<number, EtatTricotage>> {
  const out = new Map<number, EtatTricotage>()
  const cmdIds = [...new Set(ids.filter((x) => x > 0))]
  if (cmdIds.length === 0) return out
  const sql = mpsPg()

  const [entetes, lignes, mirrors, bons] = await Promise.all([
    sql<{ id: number; idsous_traitant: number; est_soldee: number; date_notif: string | null }[]>`
      SELECT idcommande_sous_traitant AS id, idsous_traitant, est_soldee,
             to_char(date_notif, 'YYYYMMDD') AS date_notif
      FROM commande_sous_traitant WHERE idcommande_sous_traitant = ANY(${cmdIds})`,
    sql<{ id: number; cmd: number; type: number; quantite: number; date_livraison: string | null; sstatut: string | null }[]>`
      SELECT idligne_commande_sous_traitant AS id, idcommande_sous_traitant AS cmd, type, quantite,
             to_char(date_livraison, 'YYYYMMDD') AS date_livraison, sstatut::text AS sstatut
      FROM ligne_commande_sous_traitant WHERE idcommande_sous_traitant = ANY(${cmdIds})`,
    sql<{ cmd: number; est_soldee: number }[]>`
      SELECT idcommande_etm AS cmd, est_soldee FROM commande_client WHERE idcommande_etm = ANY(${cmdIds})`,
    sql<{ cmd: number; jour: string }[]>`
      SELECT idreference AS cmd, to_char(max(date), 'YYYYMMDD') AS jour
      FROM envoi_email WHERE idtype_doc = 13 AND idreference = ANY(${cmdIds}) GROUP BY idreference`,
  ])

  const lineIds = lignes.map((l) => Number(l.id))
  const [fils, production, recus] = lineIds.length === 0
    ? [[], [], []]
    : await Promise.all([
      sql<{ ligne: number }[]>`
        SELECT DISTINCT idligne_commande_sous_traitant AS ligne FROM asso_fil_lignecmdsst
        WHERE idligne_commande_sous_traitant = ANY(${lineIds})`,
      // Mirror line → OF → pieces. A mirror line copies the sst line id in
      // `idligne_commande_etm`.
      sql<{ ligne: number; nb_of: number; kg_tricote: number | null; kg_livre: number | null }[]>`
        SELECT lc.idligne_commande_etm AS ligne, count(DISTINCT o.idordre_fabrication)::int AS nb_of,
               sum(se.poids) AS kg_tricote,
               sum(se.poids) FILTER (WHERE coalesce(se.idligne_expedition_trm, 0) > 0) AS kg_livre
        FROM ligne_commande_client lc
        JOIN ordre_fabrication o ON o.idligne_commande_client = lc.idligne_commande_client
        LEFT JOIN stock_ecru se ON se.idordre_fabrication = o.idordre_fabrication
        WHERE lc.idligne_commande_etm = ANY(${lineIds})
        GROUP BY lc.idligne_commande_etm`,
      sql<{ ligne: number; kg: number | null }[]>`
        SELECT idref_commande_source AS ligne, sum(poids) AS kg FROM stock_ecru
        WHERE idref_commande_source = ANY(${lineIds}) AND coalesce(idordre_fabrication, 0) = 0
        GROUP BY idref_commande_source`,
    ])

  const filSet = new Set(fils.map((r) => Number(r.ligne)))
  const prodByLine = new Map(production.map((r) => [Number(r.ligne), r]))
  const recuByLine = new Map(recus.map((r) => [Number(r.ligne), Number(r.kg) || 0]))
  const mirrorByCmd = new Map<number, boolean>()
  for (const m of mirrors) mirrorByCmd.set(Number(m.cmd), (mirrorByCmd.get(Number(m.cmd)) ?? false) || Number(m.est_soldee) === 1)
  const bonByCmd = new Map(bons.map((b) => [Number(b.cmd), b.jour ?? '']))
  const lignesByCmd = new Map<number, LigneTricotage[]>()
  for (const l of lignes) {
    const lid = Number(l.id)
    const prod = prodByLine.get(lid)
    const recu = recuByLine.get(lid) ?? 0
    const arr = lignesByCmd.get(Number(l.cmd)) ?? []
    arr.push({
      id: lid,
      type: Number(l.type) || 0,
      quantite: Number(l.quantite) || 0,
      date_livraison: l.date_livraison ?? '',
      rang_statut: rangStatut(l.sstatut),
      fil_affecte: filSet.has(lid),
      a_un_of: (prod?.nb_of ?? 0) > 0,
      kg_tricote: (Number(prod?.kg_tricote) || 0) + recu,
      kg_livre: (Number(prod?.kg_livre) || 0) + recu,
    })
    lignesByCmd.set(Number(l.cmd), arr)
  }

  for (const e of entetes) {
    const id = Number(e.id)
    const c: CommandeTricotage = {
      est_soldee: Number(e.est_soldee) === 1,
      trm: Number(e.idsous_traitant) === TRICOTAGE_MALTERRE_ID,
      trm_soldee: mirrorByCmd.get(id) ?? false,
      lignes: lignesByCmd.get(id) ?? [],
    }
    const phase = phaseTricotage(c)
    out.set(id, {
      phase,
      urgence: urgenceTricotage(c, phase, { date_notif: e.date_notif ?? '', bon_envoye_le: bonByCmd.get(id) ?? '' }, today),
      jauge: jaugeTricotage(c),
    })
  }
  return out
}
