// Observation driven by people (Vincent 2026-11-09, claude_doc/agents_autonomie.md §2).
//
// A skill in observation is transparent: it writes nothing and shows nothing.
// What makes it worth watching is the comparison with what people really do,
// and that only exists once a person has reacted to the mail. So:
//
//   1. On arrival, a reply to the Point is NOT read: it waits (observation-attente.ts).
//   2. When a person types a délai on a line, or dyer measures on a lot, of
//      one of the agent's dyers, the value is kept (observation_saisie) with the
//      line / lot as it was just before (`noterSaisieHumaine`, from the routes).
//   3. Once an hour (`passeObservation`, scheduler.ts), every waiting mail a
//      person reacted to is read AS IT WAS on arrival (the line / lot before
//      the person typed, « today » = the mail's day: it never sees the answer)
//      and each point is judged by what the person typed: same value = accord,
//      another = désaccord, a value on a line / lot the mail was about that the
//      reading missed = omission.
//   4. A typed value no waiting mail explains is « hors de portée » (phone,
//      another mailbox): not the agent's mistake, the share of the work it
//      cannot see. A mail nobody reacts to within ATTENTE_MAX_J days is never read.
//
// The BL is read on arrival (nothing is received yet, so nothing leaks); its
// comparison with the réception runs in the same hourly pass (bl-observation.ts).

import type { Sql } from 'postgres'
import { mpsPg } from '../../mps-pg.js'
import { lireFil } from '../../gmail-reader.js'
import { BL_ENNOBLISSEUR_BOITE, BL_ENNOBLISSEUR_SLUG, BL_ENNOBLISSEUR_VERSION_INITIALE } from '../bl-ennoblisseur.js'
import { aComparer as aComparerBl, comparerObservationsBl } from '../bl-observation.js'
import { profilDuSousTraitant } from '../bl-profils.js'
import { etatCompetence, lireEtat, lireRuns, modePlafonne, promptsCompetence, versionCompetenceActive, type AgentRun } from '../store.js'
import { CONTROLES_VERSIONS_LIVREES, DELAIS_VERSIONS_LIVREES } from './lecture.js'
import { lireReponsePoint, questionsDuPoint, type ContexteLecture } from './delais.js'
import { ATTENTE_MAX_J, versMail, type MailEnAttente } from './observation-attente.js'
import {
  enregistrerOmissionObservation, jugerObservation, saisiesDeRuns,
  type Auteur, type EtatLigne, type MesuresSst, type Saisie,
} from './saisies.js'

export type CompetenceObservee = 'delais' | 'controles'

/** A failed reading is retried at the next passes, this many times in all. */
export const ESSAIS_MAX = 3

/** What a person typed that an observed skill is judged by. */
export interface SaisieHumaine {
  id: number
  competence: CompetenceObservee
  idsousTraitant: number
  idcommande: number
  idligne: number
  idsuivilot: number
  /** 'YYYY-MM-DD' (délai) or texteMesures() (contrôles). */
  valeur: string
  /** The line (EtatLigne) or the lot's measures (MesuresSst | null) before. */
  avant: EtatLigne | MesuresSst | null
  le: string
  par: Auteur
}

type Ligne = Record<string, unknown>

const versHumaine = (r: Ligne): SaisieHumaine => ({
  id: Number(r.id),
  competence: r.competence as CompetenceObservee,
  idsousTraitant: Number(r.idsous_traitant),
  idcommande: Number(r.idcommande_sous_traitant),
  idligne: Number(r.idligne_commande_sous_traitant),
  idsuivilot: Number(r.idsuivilot),
  valeur: String(r.valeur),
  avant: (r.avant as SaisieHumaine['avant']) ?? null,
  le: new Date(r.le as string).toISOString(),
  par: { id: Number(r.par_id ?? 0), nom: String(r.par ?? 'Inconnu') },
})

/** Délais are keyed by line, contrôles by lot. */
export const cleDe = (competence: CompetenceObservee, x: { idligne: number; idsuivilot: number }) =>
  competence === 'delais' ? x.idligne : x.idsuivilot

const OU_LU: Record<CompetenceObservee, string> = { delais: 'la ligne de commande', controles: 'Suivi lots' }

// ── Matching (pure) ──────────────────────────────────────

export interface Rapprochement {
  /** An observation point and the person's value that judges it (the first typed). */
  jugements: Array<{ point: Pick<Saisie, 'id' | 'decision' | 'proposition'>; humaine: SaisieHumaine }>
  /** A person's value on a line / lot the mail was about, with no point of the reading. */
  omissions: SaisieHumaine[]
  /** Every person's value this mail explains (judging or omission, and the later retypes). */
  rattachees: number[]
}

/** Match the points of a late reading with what people typed after the mail.
 *  `cibles`: the lines / lots the mail was about (the Point's questions and
 *  the reading's own points). A value elsewhere stays free (another mail, or
 *  hors de portée). Pure. */
export function rapprocher(
  competence: CompetenceObservee,
  points: ReadonlyArray<Pick<Saisie, 'id' | 'decision' | 'proposition' | 'idligne' | 'idsuivilot' | 'statut'>>,
  humaines: readonly SaisieHumaine[],
  cibles: ReadonlySet<number>,
): Rapprochement {
  const parCle = new Map<number, SaisieHumaine[]>()
  for (const h of [...humaines].sort((a, b) => a.le.localeCompare(b.le))) {
    const k = cleDe(competence, h)
    if (!k) continue
    parCle.set(k, [...(parCle.get(k) ?? []), h])
  }
  const out: Rapprochement = { jugements: [], omissions: [], rattachees: [] }
  const vues = new Set<number>()
  for (const p of points) {
    const k = cleDe(competence, p)
    if (!k || p.decision === 'rien') continue
    vues.add(k)
    const hs = parCle.get(k)
    if (!hs) continue
    if (p.statut === 'observation') out.jugements.push({ point: p, humaine: hs[0] })
    out.rattachees.push(...hs.map((h) => h.id))
  }
  for (const [k, hs] of parCle) {
    if (vues.has(k) || !cibles.has(k)) continue
    out.omissions.push(hs[0])
    out.rattachees.push(...hs.map((h) => h.id))
  }
  return out
}

/** What the mail is read against: each line / lot as it was before the FIRST
 *  value a person typed on it after the mail, and « today » = the mail's day. Pure. */
export function contexteAvant(dateMail: string, humaines: readonly SaisieHumaine[]): ContexteLecture {
  const c: ContexteLecture = {
    aujourdhui: new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date(dateMail)),
    etats: {},
    lots: {},
  }
  for (const h of [...humaines].sort((a, b) => a.le.localeCompare(b.le))) {
    if (h.competence === 'delais' && h.idligne && !(String(h.idligne) in c.etats) && h.avant) c.etats[String(h.idligne)] = h.avant as EtatLigne
    if (h.competence === 'controles' && h.idsuivilot && !(String(h.idsuivilot) in c.lots)) c.lots[String(h.idsuivilot)] = (h.avant as MesuresSst | null) ?? null
  }
  return c
}

// ── 2. A person typed ────────────────────────────────────

/** The skill's mode as it runs (the agent's mode caps it). */
async function enObservation(competence: CompetenceObservee): Promise<boolean> {
  const state = await lireEtat(BL_ENNOBLISSEUR_SLUG, BL_ENNOBLISSEUR_VERSION_INITIALE)
  return modePlafonne(state.mode, etatCompetence(state, competence, 'essai').mode) === 'essai'
}

/** Keep what a person typed on a line (délai) or a lot (dyer measures), when
 *  the skill is in observation and the partner is one of the agent's dyers.
 *  `juges`: observation points the same gesture already judged (saisies.ts,
 *  a mail read earlier): the value is then explained already. Never throws. */
export async function noterSaisieHumaine(n: {
  competence: CompetenceObservee
  idligne?: number
  idsuivilot?: number
  valeur: string
  avant: EtatLigne | MesuresSst | null
  par: Auteur | null
  juges: number
}): Promise<void> {
  try {
    if (!n.valeur || !(await enObservation(n.competence))) return
    const sql = mpsPg()
    const [o] = n.competence === 'delais'
      ? await sql<{ sst: number; cmd: number }[]>`
          SELECT c.idsous_traitant AS sst, l.idcommande_sous_traitant AS cmd FROM ligne_commande_sous_traitant l
          JOIN commande_sous_traitant c ON c.idcommande_sous_traitant = l.idcommande_sous_traitant
          WHERE l.idligne_commande_sous_traitant = ${n.idligne ?? 0}`
      : await sql<{ sst: number; cmd: number; lig: number }[]>`
          SELECT c.idsous_traitant AS sst, s.idcommande_sous_traitant AS cmd, s.idligne_commande_sous_traitant AS lig FROM suivilot s
          JOIN commande_sous_traitant c ON c.idcommande_sous_traitant = s.idcommande_sous_traitant
          WHERE s.idsuivilot = ${n.idsuivilot ?? 0}`
    // Only the agent's dyers: another partner's délai is not its work.
    if (!o || !profilDuSousTraitant(Number(o.sst))) return
    const lig = n.competence === 'delais' ? (n.idligne ?? 0) : Number((o as { lig?: number }).lig ?? 0)
    await sql`
      INSERT INTO observation_saisie (agent, competence, idsous_traitant, idcommande_sous_traitant, idligne_commande_sous_traitant,
        idsuivilot, valeur, avant, par_id, par, statut)
      VALUES (${BL_ENNOBLISSEUR_SLUG}, ${n.competence}, ${Number(o.sst)}, ${Number(o.cmd) || 0}, ${lig}, ${n.idsuivilot ?? 0},
        ${n.valeur}, ${n.avant ? sql.json(n.avant as never) : null}, ${n.par?.id ?? 0}, ${n.par?.nom ?? null},
        ${n.juges > 0 ? 'rattachee' : 'libre'})`
  } catch (e) {
    console.error('[observation] a person’s value not kept', n.competence, n.idligne ?? n.idsuivilot, e)
  }
}

// ── 3. The hourly pass ───────────────────────────────────

let dernierePasse: string | null = null
let enCours = false

/** The last pass of this process (null since a restart). */
export const dernierePasseObservation = () => dernierePasse

/** Read the waiting mails a person reacted to, judge them, close what is
 *  hors de portée or too old, and compare the BLs received. Never throws. */
export async function passeObservation(): Promise<{ lus: number; expires: number; horsPortee: number; bl: number }> {
  const bilan = { lus: 0, expires: 0, horsPortee: 0, bl: 0 }
  if (enCours) return bilan
  enCours = true
  try {
    const sql = mpsPg()
    bilan.expires = (await sql`
      UPDATE observation_mail SET statut = 'expire'
      WHERE statut = 'attente' AND recu_le < now() - make_interval(days => ${ATTENTE_MAX_J}) RETURNING id`).length
    const mails = (await sql`
      SELECT m.* FROM observation_mail m
      WHERE m.statut = 'attente' AND m.essais < ${ESSAIS_MAX} AND EXISTS (
        SELECT 1 FROM observation_saisie s WHERE s.statut = 'libre' AND s.agent = m.agent AND s.competence = m.competence
          AND s.idsous_traitant = m.idsous_traitant AND s.le > m.date_mail)
      ORDER BY m.date_mail`).map(versMail)
    for (const m of mails) if (await lireMailObserve(m, sql)) bilan.lus++
    bilan.horsPortee = await fermerSaisiesLibres(sql)
    bilan.bl = await comparerObservationsBl(BL_ENNOBLISSEUR_SLUG)
    dernierePasse = new Date().toISOString()
    if (bilan.lus || bilan.expires || bilan.horsPortee || bilan.bl) console.log('[observation] pass:', JSON.stringify(bilan))
  } catch (e) {
    console.error('[observation] pass failed:', e)
  } finally {
    enCours = false
  }
  return bilan
}

/** Read one waiting mail as it was on arrival and judge it. False when the
 *  reading failed (retried at the next pass, ESSAIS_MAX times in all). */
async function lireMailObserve(m: MailEnAttente, sql: Sql): Promise<boolean> {
  const competence = m.competence as CompetenceObservee
  const echec = async (erreur: string) => {
    await sql`UPDATE observation_mail SET essais = essais + 1, erreur = ${erreur} WHERE id = ${m.id}`
    console.error(`[observation] ${competence} mail ${m.messageId} not read:`, erreur)
    return false
  }
  try {
    const humaines = (await sql`
      SELECT * FROM observation_saisie WHERE statut = 'libre' AND agent = ${m.agent} AND competence = ${m.competence}
        AND idsous_traitant = ${m.idsousTraitant} AND le > ${m.dateMail}
        AND le < ${m.dateMail}::timestamptz + make_interval(days => ${ATTENTE_MAX_J})
      ORDER BY le, id`).map(versHumaine)
    const mail = m.threadId ? (await lireFil(BL_ENNOBLISSEUR_BOITE, m.threadId)).find((x) => x.id === m.messageId) : undefined
    if (!mail) return await echec('mail introuvable dans la boîte')
    const state = await lireEtat(BL_ENNOBLISSEUR_SLUG, BL_ENNOBLISSEUR_VERSION_INITIALE)
    const promptDelais = versionCompetenceActive(promptsCompetence(state, 'delais', DELAIS_VERSIONS_LIVREES))
    const promptControles = versionCompetenceActive(promptsCompetence(state, 'controles', CONTROLES_VERSIONS_LIVREES))
    const [run] = await lireReponsePoint(mail, {
      delais: competence === 'delais' ? 'essai' : 'off',
      controles: competence === 'controles' ? 'essai' : 'off',
      promptDelais, promptControles,
      tirerSeul: async () => false, tirerSeulControles: async () => false,
      source: 'observation', lancePar: null, slug: m.agent, idsousTraitant: m.idsousTraitant,
    }, m.jourPoint, m.idpoint || null, contexteAvant(m.dateMail, humaines))
    if (!run) return await echec('aucune lecture')
    if (run.statut === 'erreur') return await echec(run.erreur ?? 'lecture impossible')

    const points = await saisiesDeRuns([run.id], sql)
    const cibles = await ciblesDuMail(competence, m, run, points, sql)
    const r = rapprocher(competence, points, humaines, cibles)
    for (const j of r.jugements) await jugerObservation(j.point, j.humaine.valeur, j.humaine.par, OU_LU[competence], sql)
    for (const h of r.omissions) await omissionPour(competence, m, run, h, sql)
    if (r.rattachees.length) {
      await sql`UPDATE observation_saisie SET statut = 'rattachee', idobservation_mail = ${m.id} WHERE id IN ${sql(r.rattachees)}`
    }
    await sql`UPDATE observation_mail SET statut = 'lu', lu_le = now(), run_id = ${run.id}, cibles = ${[...cibles]}, erreur = NULL
      WHERE id = ${m.id}`
    return true
  } catch (e) {
    return await echec(e instanceof Error ? e.message : String(e))
  }
}

/** The lines (délais) or lots (contrôles) a mail was about: what its Point
 *  asked, and what its reading found. */
async function ciblesDuMail(competence: CompetenceObservee, m: MailEnAttente, run: AgentRun, points: readonly Saisie[], sql: Sql): Promise<Set<number>> {
  const cibles = new Set<number>()
  for (const p of points) { const k = cleDe(competence, p); if (k) cibles.add(k) }
  if (competence === 'delais') {
    if (m.idpoint) for (const q of await questionsDuPoint(m.idpoint, sql)) if (q.idligne) cibles.add(q.idligne)
    const res = run.resultat as { delais?: Array<{ idligne: number }> }
    for (const p of res.delais ?? []) if (p.idligne) cibles.add(p.idligne)
  } else {
    if (m.idpoint) {
      const lots = await sql<{ id: number }[]>`
        SELECT s.idsuivilot AS id FROM suivilot s JOIN point_sst_ligne p ON p.idligne_commande_sous_traitant = s.idligne_commande_sous_traitant
        WHERE p.idpoint_sst = ${m.idpoint} AND p.section = 2 AND NOT p.retiree AND p.idligne_commande_sous_traitant > 0`
      for (const l of lots) cibles.add(Number(l.id))
    }
    const res = run.resultat as { controles?: Array<{ idsuivilot: number | null }> }
    for (const c of res.controles ?? []) if (c.idsuivilot) cibles.add(c.idsuivilot)
  }
  return cibles
}

async function omissionPour(competence: CompetenceObservee, m: MailEnAttente, run: AgentRun, h: SaisieHumaine, sql: Sql): Promise<void> {
  await enregistrerOmissionObservation({
    agent: m.agent, competence, version: run.version, runId: run.id, messageId: m.messageId, threadId: m.threadId,
    idsousTraitant: m.idsousTraitant, idcommande: h.idcommande, idligne: h.idligne, idsuivilot: h.idsuivilot,
    champ: competence === 'delais' ? 'date_livraison' : 'mesures_sst',
    valeurAvant: null, explication: '', citation: '',
  }, h.valeur, h.par, OU_LU[competence], sql)
}

/** The values still free once the waiting mails are read: an omission of a
 *  mail read earlier that was about that line / lot, else hors de portée,
 *  unless a mail of that dyer, before it, still waits (read at a next pass). */
async function fermerSaisiesLibres(sql: Sql): Promise<number> {
  const libres = (await sql`
    SELECT s.* FROM observation_saisie s WHERE s.statut = 'libre' AND NOT EXISTS (
      SELECT 1 FROM observation_mail m WHERE m.statut = 'attente' AND m.essais < ${ESSAIS_MAX} AND m.agent = s.agent
        AND m.competence = s.competence AND m.idsous_traitant = s.idsous_traitant AND m.date_mail < s.le)
    ORDER BY s.le, s.id`).map(versHumaine)
  let horsPortee = 0
  for (const h of libres) {
    const k = cleDe(h.competence, h)
    // The latest mail read of that dyer that was about this line / lot, within the window.
    const [lu] = k ? (await sql`
      SELECT * FROM observation_mail WHERE statut = 'lu' AND agent = ${BL_ENNOBLISSEUR_SLUG} AND competence = ${h.competence}
        AND idsous_traitant = ${h.idsousTraitant} AND date_mail < ${h.le}
        AND date_mail > ${h.le}::timestamptz - make_interval(days => ${ATTENTE_MAX_J}) AND ${k} = ANY(cibles)
      ORDER BY date_mail DESC LIMIT 1`).map(versMail) : []
    const run = lu?.runId ? (await lireRuns(BL_ENNOBLISSEUR_SLUG)).find((r) => r.id === lu.runId) : undefined
    if (lu && run) {
      // Its reading has a point on it (judged in real time already) or not: an omission.
      const points = (await saisiesDeRuns([run.id], sql)).filter((p) => cleDe(h.competence, p) === k)
      if (!points.length) await omissionPour(h.competence, lu, run, h, sql)
      await sql`UPDATE observation_saisie SET statut = 'rattachee', idobservation_mail = ${lu.id} WHERE id = ${h.id}`
      continue
    }
    await sql`UPDATE observation_saisie SET statut = 'hors_portee' WHERE id = ${h.id}`
    horsPortee++
  }
  return horsPortee
}

// ── 4. What the Score shows in observation ───────────────

/** One gap between the reading and what a person typed, for the Score tab. */
export interface EcartObservation {
  le: string
  /** « Commande 9132 », « Lot MA109579 », or the BL's summary. */
  quoi: string
  /** 'desaccord': another value; 'omission': nothing read; 'aide': it would have asked, and proposed another value. */
  type: 'desaccord' | 'omission' | 'aide'
  /** What the reading gave (null: nothing), and what the person typed. Délais 'YYYY-MM-DD', contrôles texteMesures(). */
  agent: string | null
  personne: string | null
  citation: string
}

/** Observation, as it is worth watching (Vincent 2026-11-09): how much ran,
 *  how it compares with what people did, and the gaps. No autonomie, no discernement. */
export interface BilanObservation {
  /** Mails received while in observation: read once a person reacted, waiting, never reacted to. */
  mails: { recus: number; lus: number; attente: number; sansReaction: number }
  /** Values people typed for the agent's dyers: explained by a mail, or out of its reach. Null for the BL. */
  saisies: { total: number; expliquees: number; horsPortee: number; enCours: number } | null
  /** The points of the reading on the version: compared, and how. */
  points: { compares: number; accords: number; desaccords: number; omissions: number; aides: number; enAttente: number }
  ecarts: EcartObservation[]
  dernierePasse: string | null
}

const ECARTS_MAX = 20

/** Délais / Contrôles in observation, on a version (null = every version). */
export async function bilanObservation(competence: CompetenceObservee, version: number | null, sql: Sql = mpsPg()): Promise<BilanObservation> {
  const agent = BL_ENNOBLISSEUR_SLUG
  const [m] = await sql<{ recus: number; lus: number; attente: number; expires: number }[]>`
    SELECT count(*)::int AS recus, count(*) FILTER (WHERE statut = 'lu')::int AS lus,
      count(*) FILTER (WHERE statut = 'attente')::int AS attente, count(*) FILTER (WHERE statut = 'expire')::int AS expires
    FROM observation_mail WHERE agent = ${agent} AND competence = ${competence}`
  const [h] = await sql<{ total: number; rattachees: number; hors: number; libres: number }[]>`
    SELECT count(*)::int AS total, count(*) FILTER (WHERE statut = 'rattachee')::int AS rattachees,
      count(*) FILTER (WHERE statut = 'hors_portee')::int AS hors, count(*) FILTER (WHERE statut = 'libre')::int AS libres
    FROM observation_saisie WHERE agent = ${agent} AND competence = ${competence}`
  const v = version === null ? sql`` : sql`AND a.version = ${version}`
  const points = await sql<{ decision: string; statut: string; proposition: string | null; valeur_finale: string | null; cree_le: Date; revu_le: Date | null; idcommande: number; lot: string | null; citation: string }[]>`
    SELECT a.decision, a.statut, a.proposition, a.valeur_finale, a.cree_le, a.revu_le, a.idcommande_sous_traitant AS idcommande,
      s.lot::text AS lot, a.citation
    FROM saisie_agent a LEFT JOIN suivilot s ON s.idsuivilot = a.idsuivilot AND a.idsuivilot > 0
    WHERE a.agent = ${agent} AND a.competence = ${competence} AND a.mode = 'observation' ${v}
    ORDER BY COALESCE(a.revu_le, a.cree_le) DESC`
  const p = { compares: 0, accords: 0, desaccords: 0, omissions: 0, aides: 0, enAttente: 0 }
  const ecarts: EcartObservation[] = []
  for (const x of points) {
    if (x.statut === 'observation') { p.enAttente++; continue }
    p.compares++
    const quoi = competence === 'delais' ? `Commande ${x.idcommande}` : `Lot ${x.lot ?? '?'}`
    const le = new Date(x.revu_le ?? x.cree_le).toISOString()
    const ecart = (type: EcartObservation['type']) => {
      if (ecarts.length < ECARTS_MAX) ecarts.push({ le, quoi, type, agent: x.proposition, personne: x.valeur_finale, citation: x.citation })
    }
    if (x.statut === 'validee') p.accords++
    else if (x.statut === 'corrigee') { p.desaccords++; ecart('desaccord') }
    else if (x.statut === 'omission') { p.omissions++; ecart('omission') }
    else if (x.decision === 'aide') {
      p.aides++
      if ((x.proposition ?? '') !== (x.valeur_finale ?? '')) ecart('aide')
    }
  }
  return {
    mails: { recus: m.recus, lus: m.lus, attente: m.attente, sansReaction: m.expires },
    saisies: { total: h.total, expliquees: h.rattachees, horsPortee: h.hors, enCours: h.libres },
    points: p,
    ecarts,
    dernierePasse,
  }
}

/** The BL in observation: read on arrival, compared once its rolls are received. */
export function bilanObservationBl(runs: readonly AgentRun[], version: number | null): BilanObservation {
  const lus = runs.filter((r) => (r.competence ?? 'bl') === 'bl' && r.mode === 'essai' && r.source !== 'essai_manuel'
    && (r.statut === 'simule' || r.statut === 'a_verifier') && (version === null || r.version === version))
  const p = { compares: 0, accords: 0, desaccords: 0, omissions: 0, aides: 0, enAttente: 0 }
  const ecarts: EcartObservation[] = []
  let attente = 0
  let sansReaction = 0
  for (const r of [...lus].sort((a, b) => (b.observation?.le ?? b.createdAt).localeCompare(a.observation?.le ?? a.createdAt))) {
    const o = r.observation
    if (!o) {
      p.enAttente++
      if (aComparerBl(r)) attente++
      else sansReaction++
      continue
    }
    p.compares++
    if (o.statut === 'validee') p.accords++
    else if (o.statut === 'corrigee') {
      p.desaccords++
      if (ecarts.length < ECARTS_MAX) ecarts.push({ le: o.le, quoi: r.resume, type: 'desaccord', agent: `${o.ecarts} écart${o.ecarts > 1 ? 's' : ''} avec la réception`, personne: null, citation: '' })
    } else p.aides++
  }
  return { mails: { recus: lus.length, lus: lus.length, attente, sansReaction }, saisies: null, points: p, ecarts, dernierePasse }
}
