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
//   fil_a_affecter  TRM: no OF yet and a circulaire line has no yarn assigned:
//                   ETM's move first
//   attente_delai   TRM: a line not yet delivered has no délai, even once an OF
//                   exists — the knitter gives its délai like a dyer does
//                   (Vincent 2026-11-16), TRM within DELAI_TRM_J working day
//                   of the order (no bon de commande is sent to it)
//                   external knitter: bon de commande sent, no délai yet
//   en_tricotage    TRM: an OF on a mirror line, or a rectiligne-only order
//                   (cols / bandes never get an OF, #1185)
//                   external knitter: délai announced, or rolls received
//   a_lancer        TRM: yarn assigned on every circulaire line, no OF yet
//   non_envoye      external knitter: bon de commande not sent (« À envoyer »)
// So at TRM « En tricotage » and « À lancer » always carry a délai.
// « Livrée en partie » was considered and left out (Vincent): each line card
// shows its kg.
//
// Since 2026-11-16 there is no kg gauge on the order (Vincent: same card as an
// ennoblissement order, in the list and in the Journal). Where the order stands
// inside its status is the « Prochaines étapes » card of its Journal tab, read
// from `etapeTricotage()`: the knitter's working days, like « En traitement ».

import { mpsPg } from './mps-pg.js'
import { SEUIL_EXPEDIE } from './statut-ligne-client.js'
import { LINE_TYPE_RECTILIGNE } from './sst-line-kind.js'
import { urgencesOuvertes } from './urgence-sst.js'
import { joursOuvresEntre, type Periode } from './jours-ouvres.js'
import {
  DELAI_TRM_J, derniereRelance, echeanceDelai, historiqueDelai, lireFaitsDelai, ouvresEntre, relanceDue,
  type EvenementDelai, type FaitsDelai,
} from './delai-sst.js'

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
  /** YYYYMMDD or '': the date we asked for, while the knitter has given none. */
  date_demandee?: string
  /** Legacy line status rank: 0 Non_Envoye, 1 Attente_Delai, 2 anything else. */
  rang_statut: 0 | 1 | 2
  fil_affecte: boolean
  a_un_of: boolean
  kg_tricote: number
  kg_livre: number
}

export interface CommandeTricotage {
  /** YYYYMMDD or '' */
  date_commande?: string
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
    const lance = c.lignes.some((l) => l.a_un_of) || (c.lignes.length > 0 && circulaires.length === 0)
    // An empty order is ETM's move too: nothing to launch yet.
    if (!lance && (circulaires.length === 0 || circulaires.some((l) => !l.fil_affecte))) return 'fil_a_affecter'
    // TRM owes its délai on every line still to deliver, launched or not.
    if (c.lignes.some((l) => !ligneLivree(l) && !l.date_livraison)) return 'attente_delai'
    return lance ? 'en_tricotage' : 'a_lancer'
  }
  const rang = Math.max(0, ...c.lignes.map((l) => l.rang_statut))
  if (rang === 2 || c.lignes.some((l) => l.kg_tricote > 0)) return 'en_tricotage'
  if (rang === 1) return 'attente_delai'
  return 'non_envoye'
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

/** Red when a line not yet delivered is due today or earlier, amber within 3
 *  days. Attente délai is the dyers' rule (lib/delai-sst.ts `relanceDue`,
 *  `relance` = that chase day, 'YYYY-MM-DD'): red once it has come and nobody
 *  chased, never amber — nothing to get ahead on. Soldée par TRM is never late:
 *  the goods are in, what is left is ETM's check. */
export function urgenceTricotage(
  c: CommandeTricotage,
  phase: TricotagePhase,
  relance: string | null,
  today: Date = new Date(),
): Urgence {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  if (phase === 'terminee' || phase === 'trm_soldee') return null
  if (phase === 'attente_delai') {
    return relance && relance.replace(/-/g, '') <= ymdOf(t) ? 'late' : null
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

/** Where a knitting order stands INSIDE its status: the « Prochaines étapes »
 *  card of its Journal tab (Vincent 2026-11-16). Facts only, nothing typed. */
export interface EtapeTricotage {
  /** Circulaire lines by where they stand (a rectiligne line is never
   *  followed, #1185). A status is the order's most advanced line, so
   *  « En tricotage » may hide a line still without yarn: this says it. */
  lignes: { sans_fil: number; a_lancer: number; en_tricotage: number; livrees: number }
  /** Earliest délai of a line not yet delivered ('YYYY-MM-DD'); null = none given. */
  delai: string | null
  /** Working days from today to it, in the knitter's calendar (negative = late). */
  joursRestants: number | null
  /** The later délais of the other lines not yet delivered. */
  autres: string[]
  /** No délai yet: the earliest date we asked for. */
  demande: string | null
  /** Since when the knitter's time runs: the bon de commande while its délai
   *  is awaited, else the order's date. */
  depuis: string | null
  /** Working days since `depuis`. */
  joursDepuis: number | null
  /** En tricotage with a délai: the working days from the order (excluded) to
   *  the délai (included), and how many of them are behind us — the segments of
   *  the card, drawn like the dyer's « En traitement ». 0 = nothing to draw. */
  joursTotal: number
  joursEcoules: number
  /** Attente délai: the day the knitter is chased, and the question as the
   *  dyers' card draws it (asked when, due when, last relance). */
  relance: string | null
  question: QuestionDelai | null
}

/** The délai question of a knitting order (the web's DelaiCycle). */
export interface QuestionDelai {
  demandeLe: string | null
  echeance: string | null
  derniereRelance: { jour: string; canal: string } | null
  historique: EvenementDelai[]
  joursDepuisDemande: number | null
  joursAccordes: number | null
}

/** The délai facts of a knitting order read like a dyer's (lib/delai-sst.ts),
 *  with Tricotage Malterre's own start and days: no bon de commande goes to
 *  TRM, the question is asked by the order itself, due DELAI_TRM_J working day
 *  later. An external knitter keeps the bon de commande and the dyers' days. Pure. */
export function faitsDelaiTricotage(c: CommandeTricotage, faits: FaitsDelai | undefined): FaitsDelai {
  const f: FaitsDelai = faits ?? { demandeLe: null, dateNotif: null, relances: [], reports: [], reponduLe: null }
  if (!c.trm) return f
  return {
    ...f,
    demandeLe: f.demandeLe ?? (estDate(c.date_commande) ? iso(c.date_commande) : null),
    premiereDemandeJ: DELAI_TRM_J,
    stockChezSst: false,
  }
}

const MAX_JOURS_CALENDRIER = 60
const iso = (ymd: string) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
const ymdOf = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
const estDate = (s: string | undefined): s is string => !!s && /^\d{8}$/.test(s)

export function etapeTricotage(
  c: CommandeTricotage,
  phase: TricotagePhase,
  /** The délai facts while the délai is awaited (`faitsDelaiTricotage`). */
  faits: FaitsDelai | null,
  fermetures: readonly Periode[] = [],
  today: Date = new Date(),
): EtapeTricotage {
  const t = ymdOf(today)
  const lignes = { sans_fil: 0, a_lancer: 0, en_tricotage: 0, livrees: 0 }
  for (const l of c.lignes) {
    if (isRectiligne(l)) continue
    if (ligneLivree(l)) lignes.livrees++
    // An external knitter's line has no yarn of ours nor OF to follow.
    else if (!c.trm || l.a_un_of) lignes.en_tricotage++
    else if (l.fil_affecte) lignes.a_lancer++
    else lignes.sans_fil++
  }

  // Same lines as the late frame: not yet delivered, with a date.
  const fini = phase === 'terminee' || phase === 'trm_soldee'
  const ouvertes = fini ? [] : c.lignes.filter((l) => !ligneLivree(l))
  const delais = [...new Set(ouvertes.map((l) => l.date_livraison).filter(estDate))].sort()
  const delai = delais[0] ?? null
  const demandes = delai ? [] : ouvertes.map((l) => l.date_demandee).filter(estDate).sort()

  let depuis: string | null = null
  const attente = phase === 'attente_delai' ? faits : null
  if (phase === 'attente_delai') {
    depuis = attente?.demandeLe ? attente.demandeLe.replace(/-/g, '') : null
  } else if (!fini) {
    depuis = estDate(c.date_commande) ? c.date_commande : null
  }
  const echeance = attente ? echeanceDelai(attente) : null
  const derniere = attente ? derniereRelance(attente) : null
  const joursDepuis = depuis ? Math.max(0, joursOuvresEntre(depuis, t, fermetures)) : null
  // The knitter's time, one segment per working day (capped like the dyer's calendar).
  const joursTotal = phase === 'en_tricotage' && depuis && delai && depuis < delai
    ? Math.min(MAX_JOURS_CALENDRIER, joursOuvresEntre(depuis, delai, fermetures))
    : 0

  return {
    lignes,
    delai: delai ? iso(delai) : null,
    joursRestants: delai ? joursOuvresEntre(t, delai, fermetures) : null,
    autres: delais.slice(1).map(iso),
    demande: demandes[0] ? iso(demandes[0]) : null,
    depuis: depuis ? iso(depuis) : null,
    joursDepuis,
    joursTotal,
    joursEcoules: Math.min(joursTotal, joursDepuis ?? 0),
    relance: attente ? relanceDue(attente) : null,
    question: attente ? {
      demandeLe: attente.demandeLe,
      echeance,
      derniereRelance: derniere ? { jour: derniere.jour, canal: derniere.canal } : null,
      historique: historiqueDelai(attente),
      joursDepuisDemande: attente.demandeLe ? ouvresEntre(attente.demandeLe, iso(t)) : null,
      joursAccordes: attente.demandeLe && echeance ? ouvresEntre(attente.demandeLe, echeance) : null,
    } : null,
  }
}

export interface EtatTricotage {
  phase: TricotagePhase
  urgence: Urgence
  /** What `etapeTricotage()` reads (the detail asks for it with the knitter's closures). */
  commande: CommandeTricotage
  /** Attente délai only: the délai facts (asked, relances, reports). */
  faits: FaitsDelai | null
  /** An urgency asked of the knitter on a line without a délai (lib/urgence-sst.ts): 'attente' while
   *  its answer is expected, 'a_relancer' once the day has passed (the card is then red). */
  urgenceDemandee: 'attente' | 'a_relancer' | null
}

/** The order's urgency asked of the knitter, from its lines' open ones: one to chase wins. Pure. */
export function urgenceDemandeeCommande(ouvertes: readonly { aRelancer: boolean }[]): EtatTricotage['urgenceDemandee'] {
  if (ouvertes.length === 0) return null
  return ouvertes.some((u) => u.aRelancer) ? 'a_relancer' : 'attente'
}

/** The card's colour once the urgency asked of the knitter is read (lib/urgence-sst.ts). One whose
 *  answer did not come is ours to chase: red, whatever the délai rule says. While the answer is
 *  awaited on EVERY line still without its délai, « Attente délai » has nothing to chase: the
 *  knitter was asked again through the urgency and answers on that day — waiting is never red
 *  (a line nobody asked about keeps the order on the délai chase). Pure. */
export function urgenceAvecDemande(
  base: Urgence,
  phase: TricotagePhase,
  demandee: EtatTricotage['urgenceDemandee'],
  toutesLignesDemandees: boolean,
): Urgence {
  if (demandee === 'a_relancer') return 'late'
  if (phase === 'attente_delai' && demandee === 'attente' && toutesLignesDemandees) return null
  return base
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

/** Status and urgency of knitting orders, in a few flat reads.
 *  Knitted kg = pieces of the OFs on the mirror lines (TRM production is
 *  counted by OF, never by IDsociete, per CLAUDE.md), shipped = those with a
 *  TRM expedition line; an external knitter's rolls are created at ETM on
 *  reception (`IDref_commande_source`), so knitted = delivered. */
export async function etatsTricotage(ids: number[], today: Date = new Date()): Promise<Map<number, EtatTricotage>> {
  const out = new Map<number, EtatTricotage>()
  const cmdIds = [...new Set(ids.filter((x) => x > 0))]
  if (cmdIds.length === 0) return out
  const sql = mpsPg()

  const [entetes, lignes, mirrors] = await Promise.all([
    sql<{ id: number; idsous_traitant: number; est_soldee: number; date_commande: string | null }[]>`
      SELECT idcommande_sous_traitant AS id, idsous_traitant, est_soldee,
             to_char(date_commande, 'YYYYMMDD') AS date_commande
      FROM commande_sous_traitant WHERE idcommande_sous_traitant = ANY(${cmdIds})`,
    sql<{ id: number; cmd: number; type: number; quantite: number; date_livraison: string | null; date_demandee: string | null; sstatut: string | null }[]>`
      SELECT idligne_commande_sous_traitant AS id, idcommande_sous_traitant AS cmd, type, quantite,
             to_char(date_livraison, 'YYYYMMDD') AS date_livraison,
             to_char(date_demandee, 'YYYYMMDD') AS date_demandee, sstatut::text AS sstatut
      FROM ligne_commande_sous_traitant WHERE idcommande_sous_traitant = ANY(${cmdIds})`,
    sql<{ cmd: number; est_soldee: number }[]>`
      SELECT idcommande_etm AS cmd, est_soldee FROM commande_client WHERE idcommande_etm = ANY(${cmdIds})`,
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
      date_demandee: l.date_demandee ?? '',
      rang_statut: rangStatut(l.sstatut),
      fil_affecte: filSet.has(lid),
      a_un_of: (prod?.nb_of ?? 0) > 0,
      kg_tricote: (Number(prod?.kg_tricote) || 0) + recu,
      kg_livre: (Number(prod?.kg_livre) || 0) + recu,
    })
    lignesByCmd.set(Number(l.cmd), arr)
  }

  // Urgencies asked of the knitter (lib/urgence-sst.ts): open on a line still without its délai.
  const aujourdhui = iso(ymdOf(today))
  const urgences = await urgencesOuvertes(lignes.map((l) => ({ id: Number(l.id), aUnDelai: /^\d{8}$/.test(l.date_livraison ?? '') })), aujourdhui, sql)
  const cmdDeLigne = new Map(lignes.map((l) => [Number(l.id), Number(l.cmd)]))

  const commandes = new Map<number, { c: CommandeTricotage; phase: TricotagePhase }>()
  for (const e of entetes) {
    const id = Number(e.id)
    const c: CommandeTricotage = {
      date_commande: e.date_commande ?? '',
      est_soldee: Number(e.est_soldee) === 1,
      trm: Number(e.idsous_traitant) === TRICOTAGE_MALTERRE_ID,
      trm_soldee: mirrorByCmd.get(id) ?? false,
      lignes: lignesByCmd.get(id) ?? [],
    }
    commandes.set(id, { c, phase: phaseTricotage(c) })
  }
  // The délai question (asked, relances, reports) of the orders waiting for it only.
  const enAttente = [...commandes].filter(([, v]) => v.phase === 'attente_delai').map(([id]) => id)
  const faitsLus = enAttente.length > 0 ? await lireFaitsDelai(enAttente, sql) : new Map<number, FaitsDelai>()
  for (const [id, { c, phase }] of commandes) {
    const faits = phase === 'attente_delai' ? faitsDelaiTricotage(c, faitsLus.get(id)) : null
    // Nothing left to ask once the goods are in (soldée, soldée par TRM).
    const demandee = phase === 'terminee' || phase === 'trm_soldee'
      ? null
      : urgenceDemandeeCommande([...urgences].filter(([lid]) => cmdDeLigne.get(lid) === id).map(([, u]) => u))
    const sansDelai = c.lignes.filter((l) => !ligneLivree(l) && !l.date_livraison)
    out.set(id, {
      phase,
      urgence: urgenceAvecDemande(
        urgenceTricotage(c, phase, faits ? relanceDue(faits) : null, today),
        phase, demandee, sansDelai.length > 0 && sansDelai.every((l) => urgences.has(l.id)),
      ),
      commande: c,
      faits,
      urgenceDemandee: demandee,
    })
  }
  return out
}
