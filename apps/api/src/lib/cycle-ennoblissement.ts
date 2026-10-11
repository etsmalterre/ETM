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
//   Lot steps (first match wins):
//     expedie          suivilot état 4
//     valide           état 3 (after a soumission it is PE's « ok à ramer »)
//     en_reprise       état 2 (the dyer reworks it)
//     soumis           a soumission email names the lot (envoi_email type 15, notes)
//     attente_mesures  no dyer measure and no tirelle measure (ACP)
//     attente_tirelle  dyer measures in, our tirelle measure not yet (ACL):
//                      Laëtitia controls the tirelle the day it arrives
//                      (Vincent), so the wait is the dyer's
//     a_soumettre      tirelle measured, the client asks soumissions for this
//                      reference (Clients › Gestion, designation_client.soumettre)
//     a_valider        tirelle measured, no soumission asked (or état 5 without one)
//
// Every step says whose move it is and when to chase: the relance is computed
// from the step's own date, never typed. Delays below are first estimates, to be
// corrected from PE's use like the point's rules.

import { mpsPg } from './mps-pg.js'
import { consumedEcruIds } from './fini-sources.js'

export type EtapeLot =
  | 'attente_mesures'
  | 'attente_tirelle'
  | 'a_soumettre'
  | 'soumis'
  | 'a_valider'
  | 'en_reprise'
  | 'valide'
  | 'expedie'

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
  /** Last soumission email naming this lot. 'YYYY-MM-DD' */
  soumisLe: string | null
}

/** Working days the other side gets before we chase. Estimates (2026-10-11). */
export const RELANCE_J = {
  /** The dyer's measures come in Perrine's answer to the next point. */
  attente_mesures: 1,
  /** The tirelle travels after the measures. */
  attente_tirelle: 3,
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
  if (l.etat === ETAT_LOT.EXPEDIE) return 'expedie'
  if (l.etat === ETAT_LOT.VALIDE) return 'valide'
  if (l.etat === ETAT_LOT.EN_REPRISE) return 'en_reprise'
  if (l.soumisLe) return 'soumis'
  if (l.etat === ETAT_LOT.ATTENTE_DECISION) return 'a_valider'
  if (!l.tirelleMesuree) return l.mesuresTeinturier ? 'attente_tirelle' : 'attente_mesures'
  return l.soumissionRequise ? 'a_soumettre' : 'a_valider'
}

const MAIN: Record<EtapeLot, Main | null> = {
  attente_mesures: 'teinturier',
  attente_tirelle: 'teinturier',
  a_soumettre: 'nous',
  soumis: 'client',
  a_valider: 'nous',
  en_reprise: 'teinturier',
  valide: null,
  expedie: null,
}

export function etatLot(l: LotFait): EtatLot {
  const etape = etapeLot(l)
  const r = l.reception
  let relance: string | null = null
  if (etape === 'attente_mesures' && r) relance = plusJoursOuvres(r, RELANCE_J.attente_mesures)
  else if (etape === 'attente_tirelle' && r) relance = plusJoursOuvres(r, RELANCE_J.attente_tirelle)
  else if (etape === 'soumis' && l.soumisLe) relance = plusJoursOuvres(l.soumisLe, RELANCE_J.soumis)
  else if ((etape === 'a_soumettre' || etape === 'a_valider') && r) relance = plusJoursOuvres(r, RELANCE_J.nous)
  // en_reprise: the dyer gives the date back in the point (§5), nothing to compute.
  return { lot: l.lot, idsuivilot: l.idsuivilot, etape, main: MAIN[etape], relance }
}

// ── The order ─────────────────────────────────────────────

/** Order steps, replacing the old phases on Sous-traitants › Ennoblissement. */
export type EtapeCommande = 'non_envoye' | 'attente_delai' | 'en_teinture' | 'en_reception' | 'a_cloturer' | 'terminee'

export interface CommandeFait {
  est_soldee: boolean
  /** Max line status rank: 0 Non_Envoye, 1 Attente_Delai, 2 anything later. */
  rangStatut: 0 | 1 | 2
  /** The relance date of the délai question (commande_sous_traitant.date_notif), 'YYYY-MM-DD'. */
  relanceDelai: string | null
  /** Bon de commande sent, 'YYYY-MM-DD' (fallback relance: + 3 working days). */
  bonEnvoyeLe: string | null
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
}

export function etatCommande(c: CommandeFait): EtatCommande {
  const tous = c.lots.map(etatLot)
  const ouverts = tous.filter((l) => l.etape !== 'valide' && l.etape !== 'expedie')
  const solde = c.lots.length > 0 && c.ecruChezTeinturier > 0
  if (c.est_soldee) return { etape: 'terminee', main: null, relance: null, lots: ouverts, solde: false }
  if (c.lots.length === 0) {
    if (c.rangStatut === 0) return { etape: 'non_envoye', main: 'nous', relance: null, lots: [], solde: false }
    if (c.rangStatut === 1) {
      const relance = c.relanceDelai ?? (c.bonEnvoyeLe ? plusJoursOuvres(c.bonEnvoyeLe, 3) : null)
      return { etape: 'attente_delai', main: 'teinturier', relance, lots: [], solde: false }
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

/** « MA109331 », « 109331/s »: the digits name the lot; a reprise lot keeps an R
 *  (« MA109102R », « MA109090 REPRIS ») so its soumission never marks the original. */
export function cleLot(s: string): string {
  const m = /(\d{5,})\s*(R\b|R(?=\/)|REPRIS)?/i.exec(s)
  if (!m) return s.trim().toUpperCase()
  return m[2] ? `${m[1]}R` : m[1]
}

// ── Reading the facts (native PostgreSQL) ────────────────


const TYPE_DOC_BON = 13
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

  const [entetes, lignes, bons, soumissions] = await Promise.all([
    sql<{ id: number; est_soldee: number; relance: string | null; idcommande_client: number }[]>`
      SELECT idcommande_sous_traitant AS id, est_soldee, to_char(date_notif, 'YYYY-MM-DD') AS relance,
             COALESCE(idcommande_client, 0) AS idcommande_client
      FROM commande_sous_traitant WHERE idcommande_sous_traitant = ANY(${cmdIds})`,
    sql<{ id: number; cmd: number; type: number; sstatut: string | null; delai: string | null; idref_fini: number }[]>`
      SELECT idligne_commande_sous_traitant AS id, idcommande_sous_traitant AS cmd, type, sstatut::text AS sstatut,
             to_char(date_livraison, 'YYYY-MM-DD') AS delai, COALESCE(idreference, 0) AS idref_fini
      FROM ligne_commande_sous_traitant WHERE idcommande_sous_traitant = ANY(${cmdIds})`,
    sql<{ cmd: number; jour: string }[]>`
      SELECT idreference AS cmd, to_char(max(date), 'YYYY-MM-DD') AS jour FROM envoi_email
      WHERE idtype_doc = ${TYPE_DOC_BON} AND idreference = ANY(${cmdIds}) GROUP BY idreference`,
    sql<{ cmd: number; notes: string | null; jour: string }[]>`
      SELECT idreference AS cmd, notes::text AS notes, to_char(max(date), 'YYYY-MM-DD') AS jour FROM envoi_email
      WHERE idtype_doc = ${TYPE_DOC_SOUMISSION} AND idreference = ANY(${cmdIds}) AND COALESCE(invalide, 0) = 0
      GROUP BY idreference, notes`,
  ])

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
  const revenus = await consumedEcruIds(ecru.map((r) => Number(r.idecru)))
  const chezTeinturier = new Map<number, number>()
  for (const r of ecru) if (!revenus.has(Number(r.idecru))) chezTeinturier.set(Number(r.ligne), (chezTeinturier.get(Number(r.ligne)) ?? 0) + 1)

  const soumisParCle = new Map<string, string>()
  for (const s of soumissions) {
    const k = `${s.cmd}:${cleLot(s.notes ?? '')}`
    const prev = soumisParCle.get(k)
    if (!prev || s.jour > prev) soumisParCle.set(k, s.jour)
  }
  const bonParCmd = new Map(bons.map((b) => [Number(b.cmd), b.jour]))
  const ligneParId = new Map(lignes.map((l) => [Number(l.id), l]))

  for (const e of entetes) {
    const id = Number(e.id)
    const sesLignes = lignes.filter((l) => Number(l.cmd) === id)
    const sesLots: LotFait[] = lots
      .filter((s) => Number(ligneParId.get(Number(s.ligne))?.cmd) === id && String(s.lot ?? '').trim())
      .map((s) => {
        const ligne = ligneParId.get(Number(s.ligne))!
        return {
          lot: String(s.lot).trim(),
          idsuivilot: Number(s.idsuivilot),
          etat: Number(s.etat),
          reception: s.reception,
          mesuresTeinturier: Number(s.laize_sst) > 0 || Number(s.poids_sst) > 0,
          tirelleMesuree: Number(s.laize_tirelle) > 0,
          soumissionRequise: ligneRequiert(ligne),
          soumisLe: soumisParCle.get(`${id}:${cleLot(String(s.lot))}`) ?? null,
        }
      })
    // A soumission can leave before any BL (a piece already in the dyer's stock,
    // 9023 / 9037): the lot exists only in the email, it is still « soumis ».
    // A reprise renames the lot (MA109102 → MA109102R): its older soumission is the same lot.
    const connus = new Set(sesLots.flatMap((l) => [cleLot(l.lot), cleLot(l.lot).replace(/R$/, '')]))
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
      relanceDelai: e.relance,
      bonEnvoyeLe: bonParCmd.get(id) ?? null,
      delai: delais[0] ?? null,
      lots: sesLots,
      ecruChezTeinturier: sesLignes.reduce((n, l) => n + (chezTeinturier.get(Number(l.id)) ?? 0), 0),
    })
  }
  return out
}
