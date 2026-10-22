// Sous-traitants › Ennoblissement: the life cycle of a dye order and of each of
// its lots (decided with Vincent 2026-10-11, plan ~/.claude/plans/cycle-ennoblissement.md).
//
// Built from Pierre-Emmanuel's Journal (571 orders, oct. 2025 → oct. 2026), where
// he typed one code per lot: ACP (waiting for the dyer's measures; ACB at
// Bontemps), ACL (waiting for our control on the tirelle), « lot/s » (soumission
// sent to the client), « ok à ramer » (the client accepted, the lot is validated),
// « reprise » / lot suffixed R. On the 16 open lots of 2026-10-11 every code
// matched data ETM already holds, so the steps are COMPUTED here and nothing new
// is typed: he stops writing codes and relance dates.
//
//   Lot steps (first match wins) — since 2026-10-22 (LIVA #1304) the Suivi lots
//   screen owns the whole cycle: soumission, the client's answer, the rapport de
//   contrôle and the validation are lot gestures there, and « Valider le lot »
//   is refused while anything below is still to do (prealablesValidation):
//     valide           suivilot état 3 (or the legacy état 4 « expédié »)
//     en_reprise       état 2, or an open reprise (lib/reprises.ts — the dyer reworks it)
//     soumis           a soumission names the lot, the client has not answered
//     refuse_client    the client refused it: the only way on is « Reprendre »
//     attente_mesures  no dyer measure (ACP): shown « Contrôle ennoblisseur »
//     attente_tirelle  our tirelle measure not yet (ACL): « Contrôle Malterre »
//     a_soumettre      the client asks soumissions for this reference
//                      (Clients › Gestion, designation_client.soumettre), none sent
//                      since the lot's last return from reprise
//     rc_a_envoyer     a client switched « rapport de contrôle » holds pieces of
//                      the lot not shipped yet, and has not been sent its report
//     a_valider        nothing left to do: the responsable qualité validates
//
// Every step says whose move it is and when to chase: the relance is computed
// from the step's own date, never typed. Delays below are first estimates, to be
// corrected from PE's use like the point's rules.

import { mpsPg } from './mps-pg.js'
import { consumedEcruIds } from './fini-sources.js'
import { faitsReprises } from './reprises.js'
import { clientsDesLots, cleLotLigne } from './rapport-controle-lot.js'
import { echeanceDelai, lireFaitsDelai, relanceDue, derniereRelance, historiqueDelai, type EvenementDelai, type FaitsDelai } from './delai-sst.js'

export type EtapeLot =
  | 'attente_mesures'
  | 'attente_tirelle'
  | 'a_soumettre'
  | 'soumis'
  | 'refuse_client'
  | 'rc_a_envoyer'
  | 'a_valider'
  | 'en_reprise'
  | 'valide'

export type Main = 'teinturier' | 'nous' | 'client'

/** suivilot.idetatlot */
export const ETAT_LOT = { EN_CONTROLE: 1, EN_REPRISE: 2, VALIDE: 3, EXPEDIE: 4, ATTENTE_DECISION: 5 } as const

export interface LotFait {
  lot: string
  idsuivilot: number
  etat: number
  /** suivilot.date: the day the lot was received (BL). 'YYYY-MM-DD' */
  reception: string | null
  /** laize / poids given by the dyer (laize_sst, poids_sst). */
  mesuresTeinturier: boolean
  /** Our measure of the tirelle (laize_tirelle): our control is done. */
  tirelleMesuree: boolean
  /** The client asks a soumission for this reference (designation_client.soumettre). */
  soumissionRequise: boolean
  /** Last soumission email naming this lot. 'YYYY-MM-DD' — only one sent after
   *  the lot's latest return from reprise counts (lireCommandesEnnoblissement). */
  soumisLe: string | null
  /** The client's answer to that soumission (reponse_soumission, recorded on
   *  Suivi lots after the soumission). null = not answered yet. */
  reponseClient?: { accepte: boolean; commentaire: string } | null
  /** Clients still owed a rapport de contrôle for this lot (names). */
  rcAEnvoyer?: string[]
  /** A reprise of the lot is open at the dyer (lib/reprises.ts). */
  repriseOuverte?: boolean
  /** How many reprises the lot went through (« repris ×N »). */
  reprises?: number
}

/** Working days the other side gets before we chase. Estimates (2026-10-11). */
export const RELANCE_J = {
  /** The dyer's measures come in Perrine's answer to the next point. */
  attente_mesures: 1,
  /** The client answers a soumission. */
  soumis: 5,
  /** Our own steps: flagged once they wait this long. */
  nous: 1,
} as const

export interface EtatLot {
  lot: string
  idsuivilot: number
  etape: EtapeLot
  main: Main | null
  /** When to chase whoever has the move. 'YYYY-MM-DD', null = nothing to chase. */
  relance: string | null
  /** Reprises the lot went through (0 = never reworked). */
  reprises: number
}

const DAY = 86_400_000
const ms = (iso: string) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))
const isoOf = (t: number) => new Date(t).toISOString().slice(0, 10)

/** `iso` + n working days (Sat/Sun skipped, bank holidays not considered). */
export function plusJoursOuvres(iso: string, n: number): string {
  let t = ms(iso)
  let added = 0
  while (added < n) {
    t += DAY
    const dow = new Date(t).getUTCDay()
    if (dow !== 0 && dow !== 6) added++
  }
  return isoOf(t)
}

export function etapeLot(l: LotFait): EtapeLot {
  if (l.etat === ETAT_LOT.VALIDE || l.etat === ETAT_LOT.EXPEDIE) return 'valide'
  if (l.etat === ETAT_LOT.EN_REPRISE || l.repriseOuverte) return 'en_reprise'
  // A soumission already out waits on the client whatever else is missing
  // (one can leave before any BL, 9023 / 9037).
  if (l.soumisLe && !l.reponseClient) return 'soumis'
  if (l.soumisLe && l.reponseClient && !l.reponseClient.accepte) return 'refuse_client'
  if (!l.mesuresTeinturier) return 'attente_mesures'
  if (!l.tirelleMesuree) return 'attente_tirelle'
  if (l.soumissionRequise && !l.soumisLe) return 'a_soumettre'
  if ((l.rcAEnvoyer?.length ?? 0) > 0) return 'rc_a_envoyer'
  return 'a_valider'
}

/** What still stands between the lot and « Valider le lot », in the order the
 *  work is done. Empty = the responsable qualité may validate. Text shown as is
 *  on Suivi lots (the button's reason) and returned by the 409. */
export function prealablesValidation(l: LotFait): string[] {
  if (l.etat === ETAT_LOT.VALIDE || l.etat === ETAT_LOT.EXPEDIE) return ['Lot déjà validé.']
  const out: string[] = []
  if (l.etat === ETAT_LOT.EN_REPRISE || l.repriseOuverte) out.push('Le lot est en reprise chez l’ennoblisseur.')
  if (!l.mesuresTeinturier) out.push('Contrôle ennoblisseur manquant (laize / poids de l’ennoblisseur).')
  if (!l.tirelleMesuree) out.push('Contrôle Malterre manquant (mesure de la tirelle).')
  if (l.soumisLe && !l.reponseClient) out.push('Réponse du client à la soumission attendue.')
  else if (l.soumisLe && l.reponseClient && !l.reponseClient.accepte) out.push('Soumission refusée par le client : le lot est à reprendre.')
  else if (l.soumissionRequise && !l.soumisLe) out.push('Soumission au client à envoyer.')
  for (const nom of l.rcAEnvoyer ?? []) out.push(`Rapport de contrôle à envoyer à ${nom}.`)
  return out
}

const MAIN: Record<EtapeLot, Main | null> = {
  attente_mesures: 'teinturier',
  attente_tirelle: 'nous',
  a_soumettre: 'nous',
  soumis: 'client',
  refuse_client: 'nous',
  rc_a_envoyer: 'nous',
  a_valider: 'nous',
  en_reprise: 'teinturier',
  valide: null,
}

export function etatLot(l: LotFait): EtatLot {
  const etape = etapeLot(l)
  const r = l.reception
  let relance: string | null = null
  if (etape === 'attente_mesures' && r) relance = plusJoursOuvres(r, RELANCE_J.attente_mesures)
  else if (etape === 'soumis' && l.soumisLe) relance = plusJoursOuvres(l.soumisLe, RELANCE_J.soumis)
  else if ((etape === 'attente_tirelle' || etape === 'a_soumettre' || etape === 'refuse_client' || etape === 'rc_a_envoyer' || etape === 'a_valider') && r) relance = plusJoursOuvres(r, RELANCE_J.nous)
  // en_reprise: the dyer gives the date back in the point (§5), nothing to compute.
  return { lot: l.lot, idsuivilot: l.idsuivilot, etape, main: MAIN[etape], relance, reprises: l.reprises ?? 0 }
}

// ── The order ─────────────────────────────────────────────

/** Order steps, replacing the old phases on Sous-traitants › Ennoblissement. */
export type EtapeCommande = 'non_envoye' | 'attente_delai' | 'en_teinture' | 'en_reception' | 'a_cloturer' | 'terminee'

export interface CommandeFait {
  est_soldee: boolean
  /** Max line status rank: 0 Non_Envoye, 1 Attente_Delai, 2 anything later. */
  rangStatut: 0 | 1 | 2
  /** The délai question: asked, relances, reports (lib/delai-sst.ts). */
  delaiFaits?: FaitsDelai
  /** Earliest délai of a line not delivered yet, 'YYYY-MM-DD'. */
  delai: string | null
  lots: LotFait[]
  /** Écru pieces still at the dyer (handed over, not back dyed): the « solde ». */
  ecruChezTeinturier: number
}

export interface EtatCommande {
  etape: EtapeCommande
  main: Main | null
  relance: string | null
  /** Lots received and still open (not validated / shipped), with their step. */
  lots: EtatLot[]
  /** Pieces still at the dyer while lots came back. */
  solde: boolean
  /** attente_delai only: the délai question (lib/delai-sst.ts). */
  delai?: EtatDelai
}

export interface EtatDelai {
  /** From when the délai is due (the Point asks from that day), 'YYYY-MM-DD'. */
  echeance: string | null
  /** Latest relance: day and channel. */
  derniereRelance: { jour: string; canal: string } | null
  historique: EvenementDelai[]
}

export function etatCommande(c: CommandeFait): EtatCommande {
  const tous = c.lots.map(etatLot)
  const ouverts = tous.filter((l) => l.etape !== 'valide')
  const solde = c.lots.length > 0 && c.ecruChezTeinturier > 0
  if (c.est_soldee) return { etape: 'terminee', main: null, relance: null, lots: ouverts, solde: false }
  if (c.lots.length === 0) {
    if (c.rangStatut === 0) return { etape: 'non_envoye', main: 'nous', relance: null, lots: [], solde: false }
    if (c.rangStatut === 1) {
      // Red = due and nobody chased since (LIVA #1314): a relance pushes it back.
      const f = c.delaiFaits ?? { demandeLe: null, dateNotif: null, relances: [], reports: [], reponduLe: null }
      const r = derniereRelance(f)
      return {
        etape: 'attente_delai', main: 'teinturier', relance: relanceDue(f), lots: [], solde: false,
        delai: { echeance: echeanceDelai(f), derniereRelance: r ? { jour: r.jour, canal: r.canal } : null, historique: historiqueDelai(f) },
      }
    }
    return { etape: 'en_teinture', main: 'teinturier', relance: c.delai, lots: [], solde: false }
  }
  // Received: the earliest chase among the open lots, else the délai of what is
  // still at the dyer.
  const datees = ouverts.filter((l) => l.relance).sort((a, b) => a.relance!.localeCompare(b.relance!))
  if (datees.length > 0) {
    return { etape: 'en_reception', main: datees[0].main, relance: datees[0].relance, lots: ouverts, solde }
  }
  const enReprise = ouverts.find((l) => l.etape === 'en_reprise')
  if (enReprise) return { etape: 'en_reception', main: 'teinturier', relance: null, lots: ouverts, solde }
  if (solde) return { etape: 'en_reception', main: 'teinturier', relance: c.delai, lots: ouverts, solde }
  // Every lot validated, nothing left at the dyer: ours to close (8565).
  return { etape: 'a_cloturer', main: 'nous', relance: null, lots: ouverts, solde }
}

/** Red when the chase date is today or past, amber on the last working day before. */
export function urgenceCommande(e: EtatCommande, today: string): 'late' | 'soon' | null {
  if (!e.relance || e.etape === 'terminee') return null
  if (e.relance <= today) return 'late'
  if (e.relance <= plusJoursOuvres(today, 1)) return 'soon'
  return null
}

/** A lot's card colour on Qualité › Suivi lots (mps_designer §41). */
export interface UrgenceLot {
  niveau: 'rouge' | 'ambre'
  /** Printed under the card, in the colour: who to chase, since when. */
  raison: string
}

/** The lot's own chase date read like the order's (urgenceCommande): red from the
 *  relance day, amber the working day before — so a lot is red on Suivi lots
 *  exactly when it turns its order red on Sous-traitants › Ennoblissement. A
 *  validated lot still owing a rapport de contrôle is our move, like the step
 *  rc_a_envoyer. */
export function urgenceLot(l: LotFait, today: string): UrgenceLot | null {
  const e = etatLot(l)
  let { relance, main } = e
  if (e.etape === 'valide') {
    if ((l.rcAEnvoyer?.length ?? 0) === 0 || !l.reception) return null
    relance = plusJoursOuvres(l.reception, RELANCE_J.nous)
    main = 'nous'
  }
  if (!relance) return null
  const niveau = relance <= today ? 'rouge' : relance <= plusJoursOuvres(today, 1) ? 'ambre' : null
  if (!niveau) return null
  const jour = relance === today ? 'aujourd’hui' : `le ${relance.slice(8, 10)}/${relance.slice(5, 7)}`
  const quoi = main === 'teinturier' ? 'Relancer l’ennoblisseur' : main === 'client' ? 'Relancer le client' : 'À traiter'
  return { niveau, raison: niveau === 'rouge' && relance < today ? `${quoi} depuis ${jour}` : `${quoi} ${jour}` }
}

/** « MA109331 », « 109331/s », « MA109102R » (an old reprise suffix): the digits
 *  name the lot. A reprise is data now (lib/reprises.ts): a soumission sent
 *  before the lot came back from reprise no longer counts, by date. */
export function cleLot(s: string): string {
  const m = /(\d{5,})/.exec(s)
  return m ? m[1] : s.trim().toUpperCase()
}

// ── Reading the facts (native PostgreSQL) ────────────────


const TYPE_DOC_SOUMISSION = 15

function rang(sstatut: string | null): 0 | 1 | 2 {
  const s = (sstatut ?? '').trim()
  if (s === 'Non_Envoye') return 0
  if (s === 'Attente_Delai') return 1
  return 2
}

/** The facts of each dye order, in a few flat reads. */
export async function lireCommandesEnnoblissement(ids: number[]): Promise<Map<number, CommandeFait>> {
  const out = new Map<number, CommandeFait>()
  const cmdIds = [...new Set(ids.filter((x) => x > 0))]
  if (cmdIds.length === 0) return out
  const sql = mpsPg()

  const faitsDelaiP = lireFaitsDelai(cmdIds, sql)
  const [entetes, lignes, soumissions, reponses] = await Promise.all([
    sql<{ id: number; est_soldee: number; idcommande_client: number }[]>`
      SELECT idcommande_sous_traitant AS id, est_soldee,
             COALESCE(idcommande_client, 0) AS idcommande_client
      FROM commande_sous_traitant WHERE idcommande_sous_traitant = ANY(${cmdIds})`,
    sql<{ id: number; cmd: number; type: number; sstatut: string | null; delai: string | null; idref_fini: number }[]>`
      SELECT idligne_commande_sous_traitant AS id, idcommande_sous_traitant AS cmd, type, sstatut::text AS sstatut,
             to_char(date_livraison, 'YYYY-MM-DD') AS delai, COALESCE(idreference, 0) AS idref_fini
      FROM ligne_commande_sous_traitant WHERE idcommande_sous_traitant = ANY(${cmdIds})`,
    sql<{ cmd: number; notes: string | null; jour: string; ts: string }[]>`
      SELECT idreference AS cmd, notes::text AS notes, to_char(max(date), 'YYYY-MM-DD') AS jour,
             to_char(max(date), 'YYYY-MM-DD HH24:MI:SS') AS ts FROM envoi_email
      WHERE idtype_doc = ${TYPE_DOC_SOUMISSION} AND idreference = ANY(${cmdIds}) AND COALESCE(invalide, 0) = 0
      GROUP BY idreference, notes`,
    // The client's answers, recorded on Suivi lots (LIVA #1304).
    sql<{ cmd: number; lot: string | null; reponse: number; commentaire: string | null; ts: string }[]>`
      SELECT idcommande_sous_traitant AS cmd, lot::text AS lot, COALESCE(reponse, 0)::int AS reponse, commentaire,
             to_char(COALESCE(saisi_le AT TIME ZONE 'Europe/Paris', date::timestamp), 'YYYY-MM-DD HH24:MI:SS') AS ts
      FROM reponse_soumission WHERE idcommande_sous_traitant = ANY(${cmdIds})`,
  ])

  const faitsDelai = await faitsDelaiP
  const lineIds = lignes.map((l) => Number(l.id))
  const [lots, ecru, clientsPieces] = lineIds.length === 0 ? [[], [], []] : await Promise.all([
    sql<{ idsuivilot: number; ligne: number; lot: string | null; etat: number; reception: string | null; laize_sst: number; poids_sst: number; laize_tirelle: number }[]>`
      SELECT idsuivilot, idligne_commande_sous_traitant AS ligne, lot::text AS lot, COALESCE(idetatlot, 0)::int AS etat,
             to_char(date, 'YYYY-MM-DD') AS reception, COALESCE(laize_sst, 0) AS laize_sst,
             COALESCE(poids_sst, 0) AS poids_sst, COALESCE(laize_tirelle, 0) AS laize_tirelle
      FROM suivilot WHERE idligne_commande_sous_traitant = ANY(${lineIds})`,
    sql<{ ligne: number; idecru: number }[]>`
      SELECT idref_commande_affectation AS ligne, idstock_ecru AS idecru
      FROM stock_ecru WHERE idref_commande_affectation = ANY(${lineIds})`,
    // The client of a line: through the pieces (the order header is often 0, #1249).
    sql<{ ligne: number; idclient: number }[]>`
      SELECT DISTINCT se.idref_commande_affectation AS ligne, cc.idclient
      FROM stock_ecru se
      JOIN ligne_commande_client lcc ON lcc.idligne_commande_client = se.idligne_commande_client
      JOIN commande_client cc ON cc.idcommande_client = lcc.idcommande_client
      WHERE se.idref_commande_affectation = ANY(${lineIds}) AND se.idligne_commande_client > 0`,
  ])

  const enteteClient = await (async () => {
    const ccIds = [...new Set(entetes.map((e) => Number(e.idcommande_client)).filter((x) => x > 0))]
    if (ccIds.length === 0) return new Map<number, number>()
    const rows = await sql<{ id: number; idclient: number }[]>`
      SELECT idcommande_client AS id, idclient FROM commande_client WHERE idcommande_client = ANY(${ccIds})`
    return new Map(rows.map((r) => [Number(r.id), Number(r.idclient)]))
  })()

  // Soumission asked per (client, ref fini): Clients › Gestion.
  const clientsParLigne = new Map<number, Set<number>>()
  const ajouter = (ligne: number, client: number) => {
    if (!(client > 0)) return
    const set = clientsParLigne.get(ligne) ?? new Set<number>()
    set.add(client)
    clientsParLigne.set(ligne, set)
  }
  const cmdParId = new Map(entetes.map((e) => [Number(e.id), e]))
  for (const l of lignes) ajouter(Number(l.id), enteteClient.get(Number(cmdParId.get(Number(l.cmd))?.idcommande_client)) ?? 0)
  for (const r of clientsPieces) ajouter(Number(r.ligne), Number(r.idclient))
  const tousClients = [...new Set([...clientsParLigne.values()].flatMap((s) => [...s]))]
  const refs = [...new Set(lignes.map((l) => Number(l.idref_fini)).filter((x) => x > 0))]
  const aSoumettre = new Set<string>()
  if (tousClients.length > 0 && refs.length > 0) {
    const rows = await sql<{ idclient: number; idref_fini: number }[]>`
      SELECT idclient, idref_fini FROM designation_client
      WHERE idclient = ANY(${tousClients}) AND idref_fini = ANY(${refs})
        AND COALESCE(soumettre, 0) = 1 AND COALESCE(archive, 0) = 0`
    for (const r of rows) aSoumettre.add(`${r.idclient}:${r.idref_fini}`)
  }
  const ligneRequiert = (l: { id: number; idref_fini: number }) =>
    [...(clientsParLigne.get(Number(l.id)) ?? [])].some((c) => aSoumettre.has(`${c}:${Number(l.idref_fini)}`))

  // The « solde »: écru handed over and not back dyed (own fini or merged component).
  const [revenus, reprises] = await Promise.all([consumedEcruIds(ecru.map((r) => Number(r.idecru))), faitsReprises(lineIds)])
  const chezTeinturier = new Map<number, number>()
  for (const r of ecru) if (!revenus.has(Number(r.idecru))) chezTeinturier.set(Number(r.ligne), (chezTeinturier.get(Number(r.ligne)) ?? 0) + 1)

  const soumisParCle = new Map<string, string>()
  const soumisTsParCle = new Map<string, string>()
  for (const s of soumissions) {
    const k = `${s.cmd}:${cleLot(s.notes ?? '')}`
    const prev = soumisParCle.get(k)
    if (!prev || s.jour > prev) soumisParCle.set(k, s.jour)
    const prevTs = soumisTsParCle.get(k)
    if (!prevTs || s.ts > prevTs) soumisTsParCle.set(k, s.ts)
  }
  // Latest answer per lot; it answers the soumission only if given after it.
  const reponseParCle = new Map<string, { accepte: boolean; commentaire: string; ts: string }>()
  for (const r of reponses) {
    const k = `${r.cmd}:${cleLot(r.lot ?? '')}`
    const prev = reponseParCle.get(k)
    if (!prev || r.ts > prev.ts) reponseParCle.set(k, { accepte: Number(r.reponse) === 1, commentaire: (r.commentaire ?? '').trim(), ts: r.ts })
  }
  const rcParLot = await clientsDesLots(lots.map((s) => ({ ligne: Number(s.ligne), lot: String(s.lot ?? '') })))
  const ligneParId = new Map(lignes.map((l) => [Number(l.id), l]))

  for (const e of entetes) {
    const id = Number(e.id)
    const sesLignes = lignes.filter((l) => Number(l.cmd) === id)
    const sesLots: LotFait[] = lots
      .filter((s) => Number(ligneParId.get(Number(s.ligne))?.cmd) === id && String(s.lot ?? '').trim())
      .map((s) => {
        const ligne = ligneParId.get(Number(s.ligne))!
        const rep = reprises.get(`${Number(s.ligne)}:${String(s.lot).trim()}`)
        const cle = `${id}:${cleLot(String(s.lot))}`
        const soumis = soumisParCle.get(cle) ?? null
        const soumisValable = soumis && (!rep?.dernierRetour || soumis >= rep.dernierRetour) ? soumis : null
        const reponse = reponseParCle.get(cle)
        return {
          lot: String(s.lot).trim(),
          idsuivilot: Number(s.idsuivilot),
          etat: Number(s.etat),
          reception: s.reception,
          mesuresTeinturier: Number(s.laize_sst) > 0 || Number(s.poids_sst) > 0,
          tirelleMesuree: Number(s.laize_tirelle) > 0,
          soumissionRequise: ligneRequiert(ligne),
          // A soumission sent before the lot came back from reprise was about the old dye.
          soumisLe: soumisValable,
          reponseClient: soumisValable && reponse && reponse.ts >= (soumisTsParCle.get(cle) ?? '') ? reponse : null,
          rcAEnvoyer: (rcParLot.get(cleLotLigne(Number(s.ligne), String(s.lot))) ?? []).filter((c) => c.du).map((c) => c.nom),
          repriseOuverte: rep?.ouverte ?? false,
          reprises: rep?.nombre ?? 0,
        }
      })
    // A soumission can leave before any BL (a piece already in the dyer's stock,
    // 9023 / 9037): the lot exists only in the email, it is still « soumis ».
    const connus = new Set(sesLots.map((l) => cleLot(l.lot)))
    for (const [k, jour] of soumisParCle) {
      const [cmd, cle] = k.split(':')
      if (Number(cmd) !== id || connus.has(cle)) continue
      sesLots.push({
        lot: `MA${cle}`, idsuivilot: 0, etat: 0, reception: null,
        mesuresTeinturier: false, tirelleMesuree: false, soumissionRequise: true, soumisLe: jour,
      })
    }
    const delais = sesLignes.filter((l) => !String(l.sstatut ?? '').startsWith('Termin')).map((l) => l.delai).filter((d): d is string => !!d).sort()
    out.set(id, {
      est_soldee: Number(e.est_soldee) === 1,
      rangStatut: Math.max(0, ...sesLignes.map((l) => rang(l.sstatut))) as 0 | 1 | 2,
      delaiFaits: faitsDelai.get(id),
      delai: delais[0] ?? null,
      lots: sesLots,
      ecruChezTeinturier: sesLignes.reduce((n, l) => n + (chezTeinturier.get(Number(l.id)) ?? 0), 0),
    })
  }
  return out
}
