// What Tricobot wrote or decided, point by point (PG `saisie_agent`, migration
// 0060), and the gestures a person answers it with — the ground the three
// measures are read from (competences.ts, claude_doc/agents_autonomie.md).
//
// First skill on it: Flux Ennoblisseur › Délais — a dyer's délai on a sst line.
// The gestures are given where the work is done (Sous-traitants › Ennoblissement,
// the order's card), never in Agents IA:
//   valider    the saisie stays            → fiabilité 1/1
//   corriger   another value, with why     → fiabilité 0/1 (the line is rewritten)
//   supprimer  nothing to write, with why  → fiabilité 0/1 (the line is put back)
//   trancher   an aide settled by a person → discernement (its proposal kept or not)
//   confirmer / omission   a « rien »: right, or something was missed (why) → fiabilité
// A person who changes a line's date by hand while Tricobot's saisie waits (or
// was written alone) corrects it too (`ligneModifiee`, PUT lignes).

import type { PendingQuery, Row, Sql } from 'postgres'
import { mpsPg } from '../../mps-pg.js'
import { valeurStab } from '../../stabilites.js'
import { query } from '../../hfsql-auto.js'
import { esc, sstDelaiSets, STATUT_ATTENTE_DELAI, STATUT_NON_ENVOYE } from '../../sst-shared.js'
import { noterDelaiRecu } from '../../delai-sst.js'
import { dateDeReference, enregistrerReportDelai, estUnReportDelai, refusAvanceDelai } from '../../report-delai-sst.js'
import type { Decision, PointMesure, StatutPoint } from '../competences.js'
import { enregistrerRetour } from '../retours.js'
import { CHAMP_RECEPTION, lireReception, lotNormalise, receptionnerProposition, retirerPreRemplissage, texteReception } from './reception-bl.js'

export interface Auteur { id: number; nom: string }

/** The author of what Tricobot writes on a line (journal, délai reçu). */
export const TRICOBOT: Auteur = { id: 0, nom: 'Tricobot' }

export interface Saisie {
  id: number
  agent: string
  competence: string
  version: number
  runId: string
  messageId: string | null
  threadId: string | null
  creeLe: string
  /** 'observation': recorded in observation (skill in essai), invisible in ETM. */
  mode: 'supervise' | 'autonome' | 'observation'
  decision: Decision
  idsousTraitant: number
  idcommande: number
  idligne: number
  /** Contrôles: the lot whose dyer measures were written. */
  idsuivilot: number
  champ: string | null
  valeurAvant: string | null
  proposition: string | null
  ecrit: boolean
  explication: string
  citation: string
  statut: StatutPoint
  valeurFinale: string | null
  commentaire: string | null
  /** Aide settled: « Tu as bien fait de me demander ? » */
  douteJustifie: boolean | null
  douteCommentaire: string | null
  revuPar: string | null
  revuLe: string | null
}

type Ligne = Record<string, unknown>

const versSaisie = (r: Ligne): Saisie => ({
  id: Number(r.id),
  agent: String(r.agent),
  competence: String(r.competence),
  version: Number(r.version),
  runId: String(r.run_id),
  messageId: (r.message_id as string) ?? null,
  threadId: (r.thread_id as string) ?? null,
  creeLe: new Date(r.cree_le as string).toISOString(),
  mode: r.mode as Saisie['mode'],
  decision: r.decision as Decision,
  idsousTraitant: Number(r.idsous_traitant),
  idcommande: Number(r.idcommande_sous_traitant),
  idligne: Number(r.idligne_commande_sous_traitant),
  idsuivilot: Number(r.idsuivilot ?? 0),
  champ: (r.champ as string) ?? null,
  valeurAvant: (r.valeur_avant as string) ?? null,
  proposition: (r.proposition as string) ?? null,
  ecrit: !!r.ecrit,
  explication: String(r.explication ?? ''),
  citation: String(r.citation ?? ''),
  statut: r.statut as StatutPoint,
  valeurFinale: (r.valeur_finale as string) ?? null,
  commentaire: (r.commentaire as string) ?? null,
  douteJustifie: r.doute_justifie == null ? null : !!r.doute_justifie,
  douteCommentaire: (r.doute_commentaire as string) ?? null,
  revuPar: (r.revu_par as string) ?? null,
  revuLe: r.revu_le ? new Date(r.revu_le as string).toISOString() : null,
})

/** A saisie as the measures read it. */
export const pointDe = (s: Saisie): PointMesure => ({
  decision: s.decision,
  statut: s.statut,
  proposition: s.proposition,
  valeurFinale: s.valeurFinale,
  le: s.creeLe,
  autonome: s.mode === 'autonome',
  douteJustifie: s.douteJustifie,
  observation: s.mode === 'observation',
})

// ── Reads ────────────────────────────────────────────────

export async function saisiesDeCompetence(agent: string, competence: string, version?: number, sql: Sql = mpsPg()): Promise<Saisie[]> {
  const rows = version === undefined
    ? await sql`SELECT * FROM saisie_agent WHERE agent = ${agent} AND competence = ${competence} ORDER BY cree_le`
    : await sql`SELECT * FROM saisie_agent WHERE agent = ${agent} AND competence = ${competence} AND version = ${version} ORDER BY cree_le`
  return rows.map(versSaisie)
}

/** Every saisie of these runs (Agents IA: a run's points as judged, the replay's reference). */
export async function saisiesDeRuns(runIds: readonly string[], sql: Sql = mpsPg()): Promise<Saisie[]> {
  if (!runIds.length) return []
  const rows = await sql`SELECT * FROM saisie_agent WHERE run_id IN ${sql(runIds as string[])} ORDER BY cree_le, id`
  return rows.map(versSaisie)
}

/** The lot numbers of these saisies' lots (idsuivilot → lot), to name a
 *  Contrôles point the reading does not carry (an omission). */
export async function numerosDeLots(saisies: readonly Pick<Saisie, 'idsuivilot'>[], sql: Sql = mpsPg()): Promise<Map<number, string>> {
  const ids = [...new Set(saisies.map((s) => s.idsuivilot).filter((id) => id > 0))]
  if (!ids.length) return new Map()
  const rows = await sql<{ id: number; lot: string | null }[]>`SELECT idsuivilot AS id, lot::text AS lot FROM suivilot WHERE idsuivilot IN ${sql(ids)}`
  return new Map(rows.filter((r) => r.lot).map((r) => [Number(r.id), String(r.lot).trim()]))
}

/** Every saisie on one sst order, newest first (the order's revue). */
export async function saisiesDeCommande(idcommande: number, sql: Sql = mpsPg()): Promise<Saisie[]> {
  // Observation points are invisible in ETM (2026-11-05): only Agents IA reads them.
  const rows = await sql`SELECT * FROM saisie_agent WHERE idcommande_sous_traitant = ${idcommande} AND idsuivilot = 0 AND mode <> 'observation' ORDER BY cree_le DESC, id`
  return rows.map(versSaisie)
}

export async function saisie(id: number, sql: Sql = mpsPg()): Promise<Saisie | null> {
  const [r] = await sql`SELECT * FROM saisie_agent WHERE id = ${id}`
  return r ? versSaisie(r) : null
}

/** Every saisie on one lot (Contrôles), newest first. */
export async function saisiesDeLot(idsuivilot: number, sql: Sql = mpsPg()): Promise<Saisie[]> {
  const rows = await sql`SELECT * FROM saisie_agent WHERE idsuivilot = ${idsuivilot} AND mode <> 'observation' ORDER BY cree_le DESC, id`
  return rows.map(versSaisie)
}

/** Per lot: what waits for a person on its dyer measures (Qualité › Suivi lots). */
export async function compteursParLot(sql: Sql = mpsPg()): Promise<Record<number, { aValider: number; aide: number; autonome: number }>> {
  const rows = await sql<{ lot: number; decision: string; statut: string; n: number }[]>`
    SELECT idsuivilot AS lot, decision, statut, count(*)::int AS n FROM saisie_agent
    WHERE idsuivilot > 0 AND statut IN ('a_revoir', 'autonome')
    GROUP BY 1, 2, 3`
  const out: Record<number, { aValider: number; aide: number; autonome: number }> = {}
  for (const r of rows) {
    const o = (out[Number(r.lot)] ??= { aValider: 0, aide: 0, autonome: 0 })
    if (r.statut === 'autonome') o.autonome += r.n
    else if (r.decision === 'aide') o.aide += r.n
    else o.aValider += r.n
  }
  return out
}

/** Per order: what waits for a person (supervisé saisies, aides) and what
 *  Tricobot wrote alone — for the cards of Sous-traitants › Ennoblissement.
 *  `bl`: how many of the waiting points are delivery notes (a réception to
 *  validate, not a délai — the card says which). */
export async function compteursParCommande(sql: Sql = mpsPg()): Promise<Record<number, { aValider: number; aide: number; autonome: number; bl: number }>> {
  const rows = await sql<{ cmd: number; decision: string; statut: string; bl: boolean; n: number }[]>`
    SELECT idcommande_sous_traitant AS cmd, decision, statut, (competence = 'bl') AS bl, count(*)::int AS n FROM saisie_agent
    WHERE idcommande_sous_traitant > 0 AND idsuivilot = 0 AND statut IN ('a_revoir', 'autonome')
    GROUP BY 1, 2, 3, 4`
  const out: Record<number, { aValider: number; aide: number; autonome: number; bl: number }> = {}
  for (const r of rows) {
    const o = (out[Number(r.cmd)] ??= { aValider: 0, aide: 0, autonome: 0, bl: 0 })
    if (r.statut === 'autonome') o.autonome += r.n
    else if (r.decision === 'aide') o.aide += r.n
    else o.aValider += r.n
    if (r.bl && r.statut !== 'autonome') o.bl += r.n
  }
  return out
}

/** The mails Tricobot read without writing anything, waiting for a person
 *  (supervisé): an omission is only seen there (doctrine §4); and the aides
 *  he could hang on no order nor lot. */
export async function riensARevoir(sql: Sql = mpsPg()): Promise<Saisie[]> {
  // …and the aides with nowhere to hang (a lot or a Point not found): else nobody sees them.
  const rows = await sql`
    SELECT * FROM saisie_agent WHERE statut = 'a_revoir'
      AND (decision = 'rien' OR (decision = 'aide' AND idcommande_sous_traitant = 0 AND idsuivilot = 0))
    ORDER BY cree_le`
  return rows.map(versSaisie)
}

// ── Writes by the agent ──────────────────────────────────

export interface NouvelleSaisie {
  agent: string
  competence: string
  version: number
  runId: string
  messageId: string | null
  threadId: string | null
  mode: 'supervise' | 'autonome' | 'observation'
  decision: Decision
  idsousTraitant: number
  idcommande: number
  idligne: number
  idsuivilot?: number
  champ: string | null
  valeurAvant: string | null
  etatAvant: Record<string, unknown> | null
  proposition: string | null
  ecrit: boolean
  explication: string
  citation: string
}

export async function enregistrerSaisie(n: NouvelleSaisie, sql: Sql = mpsPg()): Promise<number> {
  const statut: StatutPoint = n.mode === 'observation' ? 'observation' : n.mode === 'autonome' && n.decision !== 'aide' ? 'autonome' : 'a_revoir'
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO saisie_agent (agent, competence, version, run_id, message_id, thread_id, mode, decision,
      idsous_traitant, idcommande_sous_traitant, idligne_commande_sous_traitant, idsuivilot, champ, valeur_avant, etat_avant,
      proposition, ecrit, explication, citation, statut)
    VALUES (${n.agent}, ${n.competence}, ${n.version}, ${n.runId}, ${n.messageId}, ${n.threadId}, ${n.mode}, ${n.decision},
      ${n.idsousTraitant}, ${n.idcommande}, ${n.idligne}, ${n.idsuivilot ?? 0}, ${n.champ}, ${n.valeurAvant}, ${n.etatAvant ? sql.json(n.etatAvant as never) : null},
      ${n.proposition}, ${n.ecrit}, ${n.explication}, ${n.citation}, ${statut})
    RETURNING id`
  return Number(r.id)
}

// ── The délai on a sst line ──────────────────────────────

export interface EtatLigne {
  idcommande: number
  /** 'YYYYMMDD' or ''. */
  dateLivraison: string
  dateDelai: string
  sstatut: string
}

const digits = (v: unknown) => (typeof v === 'string' ? v.replace(/\D/g, '').slice(0, 8) : '')

export async function lireEtatLigne(idligne: number): Promise<EtatLigne | null> {
  const [r] = await query<Ligne>(
    `SELECT IDcommande_sous_traitant, date_livraison, date_delai, sstatut FROM ligne_commande_sous_traitant WHERE IDligne_commande_sous_traitant = ${Math.trunc(idligne)}`,
  )
  if (!r) return null
  return {
    idcommande: Number(r.IDcommande_sous_traitant) || 0,
    dateLivraison: digits(r.date_livraison),
    dateDelai: digits(r.date_delai),
    sstatut: String(r.sstatut ?? '').trim(),
  }
}

/** Write a délai ('YYYY-MM-DD') on a sst line by the screen's rules
 *  (sstDelaiSets: capture-once date_delai, Attente_Delai → En_Cours) and
 *  record the « délai reçu » fact (Qualité de service). A date later than the
 *  one given is a report (LIVA #1364): read in the dyer's mail, so due to the
 *  sous-traitant, its motif quoting the mail. Returns the line before. */
export async function ecrireDelai(idligne: number, delai: string, par: Auteur, citation?: string | null): Promise<EtatLigne> {
  const avant = await lireEtatLigne(idligne)
  if (!avant) throw new Error(`ligne ${idligne} introuvable`)
  // Never brought earlier, by Tricobot either (lib/report-delai-sst.ts).
  const avance = await refusAvanceDelai(Math.trunc(idligne), { date_livraison: avant.dateLivraison, date_delai: avant.dateDelai, sstatut: avant.sstatut }, delai)
  if (avance) throw new Error(avance)
  const r = sstDelaiSets({ date_livraison: avant.dateLivraison, date_delai: avant.dateDelai, sstatut: avant.sstatut }, delai)
  await query(`UPDATE ligne_commande_sous_traitant SET ${r.sets.join(', ')} WHERE IDligne_commande_sous_traitant = ${Math.trunc(idligne)}`)
  if (avant.sstatut === STATUT_ATTENTE_DELAI && r.sstatut !== STATUT_ATTENTE_DELAI && r.sstatut !== STATUT_NON_ENVOYE) {
    await noterDelaiRecu(idligne, r.date_livraison || null, par)
  }
  if (estUnReportDelai(avant.dateLivraison, avant.dateDelai, r.date_livraison)) {
    const cite = (citation ?? '').replace(/\s+/g, ' ').trim()
    try {
      await enregistrerReportDelai({
        idligne: Math.trunc(idligne), ancien: dateDeReference(avant.dateLivraison, avant.dateDelai), nouveau: r.date_livraison,
        motif: cite ? `Nouveau délai annoncé par l’ennoblisseur : « ${cite.slice(0, 400)} »` : 'Nouveau délai annoncé par l’ennoblisseur',
        imputable: 'sous_traitant', par,
      })
    } catch (e) {
      console.error('[flux-ennoblisseur] report de délai non enregistré, ligne', idligne, e)
    }
  }
  return avant
}

/** Put a line back as it was before Tricobot wrote (« Supprimer »). */
async function remettreLigne(idligne: number, e: EtatLigne): Promise<void> {
  const d = (x: string) => (x ? `'${x}'` : 'NULL')
  await query(
    `UPDATE ligne_commande_sous_traitant SET date_livraison = ${d(e.dateLivraison)}, date_delai = ${d(e.dateDelai)}, sstatut = '${esc(e.sstatut)}' WHERE IDligne_commande_sous_traitant = ${Math.trunc(idligne)}`,
  )
}

// ── The dyer's measures on a lot (Contrôles) ─────────────

/** The dyer side of a lot's control (suivilot *_sst). laize / poids / stab are
 *  integers in the table; stab and vrillage NULL = not measured, 0 is a measure (#1358). */
export interface MesuresSst { laize: number; poids: number; stabH: number | null; stabL: number | null; vrillage: number | null }

/** One canonical text per measure set — what `proposition` / `valeur_finale`
 *  hold, so « the person kept Tricobot's values » is a string comparison. */
export const texteMesures = (m: MesuresSst) =>
  JSON.stringify({ laize: m.laize, poids: m.poids, stabH: m.stabH, stabL: m.stabL, vrillage: m.vrillage })

export function lireMesures(v: string | null): MesuresSst | null {
  if (!v) return null
  try {
    const o = JSON.parse(v) as Partial<MesuresSst>
    const nombre = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
    const ouNull = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null)
    return { laize: nombre(o.laize), poids: nombre(o.poids), stabH: ouNull(o.stabH), stabL: ouNull(o.stabL), vrillage: ouNull(o.vrillage) }
  } catch {
    return null
  }
}

export async function lireMesuresLot(idsuivilot: number, sql: Sql = mpsPg()): Promise<MesuresSst | null> {
  const [r] = await sql<{ laize: number; poids: number; stabh: number | null; stabl: number | null; vrillage: number | null }[]>`
    SELECT laize_sst AS laize, poids_sst AS poids, stabh_sst AS stabh, stabl_sst AS stabl, vrillage_sst AS vrillage
    FROM suivilot WHERE idsuivilot = ${idsuivilot}`
  if (!r) return null
  return { laize: Number(r.laize) || 0, poids: Number(r.poids) || 0, stabH: valeurStab(r.stabh), stabL: valeurStab(r.stabl), vrillage: r.vrillage == null ? null : Number(r.vrillage) }
}

/** Write the dyer side of a lot's control, as a person would on Suivi lots. Returns what was there. */
export async function ecrireMesures(idsuivilot: number, m: MesuresSst, sql: Sql = mpsPg()): Promise<MesuresSst> {
  const avant = await lireMesuresLot(idsuivilot, sql)
  if (!avant) throw new Error(`lot ${idsuivilot} introuvable`)
  await sql`
    UPDATE suivilot SET laize_sst = ${Math.round(m.laize)}, poids_sst = ${Math.round(m.poids)},
      stabh_sst = ${m.stabH == null ? null : Math.round(m.stabH)}, stabl_sst = ${m.stabL == null ? null : Math.round(m.stabL)}, vrillage_sst = ${m.vrillage}
    WHERE idsuivilot = ${idsuivilot}`
  return avant
}

/** Does the lot hold any dyer measure already? */
export const aDesMesures = (m: MesuresSst) => m.laize !== 0 || m.poids !== 0 || m.stabH != null || m.stabL != null || m.vrillage != null

// ── The person's gestures ────────────────────────────────

export class GesteRefuse extends Error {
  constructor(public code: string, message: string) { super(message) }
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/
const pourquoi = (c: string | undefined) => {
  const t = (c ?? '').trim()
  if (!t) throw new GesteRefuse('pourquoi_requis', 'Dites à Tricobot pourquoi : il s’en sert pour s’améliorer.')
  return t
}

async function marquer(id: number, statut: StatutPoint, par: Auteur, valeurFinale: string | null, commentaire: string | null, sql: Sql = mpsPg()): Promise<void> {
  await sql`
    UPDATE saisie_agent SET statut = ${statut}, valeur_finale = ${valeurFinale}, commentaire = ${commentaire},
      revu_par_id = ${par.id}, revu_par = ${par.nom}, revu_le = now()
    WHERE id = ${id}`
}

async function aJuger(id: number, decisions: Decision[]): Promise<Saisie> {
  const s = await saisie(id)
  if (!s) throw new GesteRefuse('introuvable', 'Cette saisie de Tricobot n’existe plus.')
  if (!decisions.includes(s.decision)) throw new GesteRefuse('geste_invalide', 'Ce geste ne s’applique pas à ce point.')
  // An autonomous saisie stays correctable; a judged one is closed.
  if (s.statut !== 'a_revoir' && !(s.statut === 'autonome')) throw new GesteRefuse('deja_revu', `Déjà revu${s.revuPar ? ` par ${s.revuPar}` : ''}.`)
  return s
}

/** « Valider » a saisie (or confirm a « rien »): Tricobot was right. A
 *  supervisé saisie was only proposed: validating writes it, by the person. */
export async function valider(id: number, par: Auteur, sql: Sql = mpsPg()): Promise<void> {
  const s = await aJuger(id, ['saisie', 'rien'])
  if (s.decision === 'saisie' && !s.ecrit && s.proposition) {
    // What was there before, for a later « Supprimer » of an autonomous point
    // (a réception has no « before »: its rolls are removed from the stock, not put back).
    const avant = s.champ === CHAMP_RECEPTION ? null
      : s.champ === 'mesures_sst' ? (s.idsuivilot > 0 ? await lireMesuresLot(s.idsuivilot, sql) : null) : (s.idligne > 0 ? await lireEtatLigne(s.idligne) : null)
    await ecrireValeur(s, s.proposition, par)
    await sql`UPDATE saisie_agent SET ecrit = true, etat_avant = ${avant ? sql.json(avant as never) : null} WHERE id = ${id}`
  }
  await marquer(id, 'validee', par, s.proposition, null, sql)
  await retourBl(s, true, '', par)
}

/** A BL point judged: the same verdict on its run, so Agents IA › Exécutions
 *  reads what the person said (best effort — the point is the measure). */
async function retourBl(s: Pick<Saisie, 'agent' | 'competence' | 'runId'>, juste: boolean, commentaire: string, par: Auteur, corrections: string[] = []): Promise<void> {
  if (s.competence !== 'bl') return
  try {
    await enregistrerRetour({ slug: s.agent, runId: s.runId, cle: null, juste, commentaire, corrections, par, garderEchec: true })
  } catch (e) {
    console.error('[saisies] BL retour not recorded on its run', s.runId, e)
  }
}

/** A person's value for the field Tricobot wrote, checked and written. Returns the canonical text. */
async function ecrireValeur(s: Saisie, valeur: string, par: Auteur): Promise<string> {
  if (s.champ === CHAMP_RECEPTION) {
    // A BL: the rolls of the proposal are received on its line, by the person who validates.
    const p = lireReception(valeur)
    if (!p) throw new GesteRefuse('reception_invalide', 'Proposition de réception illisible : réceptionne ce BL à la main.')
    await receptionnerProposition(s.idcommande, s.idligne, p, par)
    return texteReception(p)
  }
  if (s.champ === 'mesures_sst') {
    const m = lireMesures(valeur)
    if (!m) throw new GesteRefuse('mesures_invalides', 'Indiquez les mesures de l’ennoblisseur.')
    if (s.idsuivilot > 0) await ecrireMesures(s.idsuivilot, m)
    return texteMesures(m)
  }
  if (!isoDate.test(valeur)) throw new GesteRefuse('date_invalide', 'Indiquez le bon délai.')
  if (s.idligne > 0) await ecrireDelai(s.idligne, valeur, par, s.citation)
  return valeur
}

/** « Modifier »: another value, with why. The person's value is written. */
export async function corriger(id: number, valeur: string, commentaire: string, par: Auteur): Promise<void> {
  const s = await aJuger(id, ['saisie'])
  // A BL is corrected roll by roll in the réception dialog, which judges the point (receptionFaite).
  if (s.champ === CHAMP_RECEPTION) throw new GesteRefuse('par_la_reception', 'Un BL se corrige depuis la réception des rouleaux.')
  const why = pourquoi(commentaire)
  const canon = s.champ === 'mesures_sst' ? texteMesures(lireMesures(valeur) ?? { laize: NaN, poids: 0, stabH: null, stabL: null, vrillage: null }) : valeur
  if (canon === s.proposition) throw new GesteRefuse('meme_valeur', 'Ce sont les valeurs de Tricobot : validez-les plutôt.')
  const ecrit = await ecrireValeur(s, valeur, par)
  await marquer(id, 'corrigee', par, ecrit, why)
}

/** « Supprimer »: nothing should have been written, with why. The line goes back. */
export async function supprimer(id: number, commentaire: string, par: Auteur, sql: Sql = mpsPg()): Promise<void> {
  const s = await aJuger(id, ['saisie'])
  const why = pourquoi(commentaire)
  const [r] = await sql<{ etat_avant: (EtatLigne & MesuresSst) | null }[]>`SELECT etat_avant FROM saisie_agent WHERE id = ${id}`
  if (s.champ === CHAMP_RECEPTION) {
    // « Pas à réceptionner »: the réception must not offer these rolls again. Rolls already received stay.
    const p = lireReception(s.proposition)
    if (p) await retirerPreRemplissage(s.idligne, p.lot)
  } else if (s.ecrit && r?.etat_avant) {
    if (s.champ === 'mesures_sst' && s.idsuivilot > 0) await ecrireMesures(s.idsuivilot, r.etat_avant, sql)
    else if (s.idligne > 0) await remettreLigne(s.idligne, r.etat_avant)
  }
  await marquer(id, 'supprimee', par, null, why)
  await retourBl(s, false, why, par)
}

/** A person received rolls of a lot from the réception dialog (PUT
 *  /tricobot/bl-reception): Tricobot's BL point waiting on that line for that
 *  lot is judged by it — received as he read it = validée, a value changed =
 *  corrigée (the changes are the why). An aide stays open: the person still
 *  owes « avais-je raison de demander ? ». Never fails the réception. */
export async function receptionFaite(idligne: number, lot: string, corrections: readonly string[], commentaire: string, par: Auteur): Promise<number> {
  try {
    const sql = mpsPg()
    const ouvertes = (await sql`
      SELECT * FROM saisie_agent WHERE idligne_commande_sous_traitant = ${idligne}
        AND competence = 'bl' AND champ = ${CHAMP_RECEPTION} AND decision = 'saisie' AND statut IN ('a_revoir', 'autonome')`).map(versSaisie)
    const cible = lotNormalise(lot)
    let n = 0
    for (const s of ouvertes) {
      if (lotNormalise(lireReception(s.proposition)?.lot ?? '') !== cible) continue
      if (corrections.length === 0) await marquer(s.id, 'validee', par, s.proposition, null, sql)
      else await marquer(s.id, 'corrigee', par, corrections.join(' ; ').slice(0, 4000), commentaire.trim() || 'Corrigé à la réception des rouleaux.', sql)
      await sql`UPDATE saisie_agent SET ecrit = true WHERE id = ${s.id}`
      n++
    }
    return n
  } catch (e) {
    console.error('[saisies] réception not reflected on Tricobot’s BL point', idligne, lot, e)
    return 0
  }
}

/** An aide settled: the value the person writes (or none), and their answer to
 *  « Tu as bien fait de me demander ? » — the Discernement measure, asked apart
 *  from the value (a right proposal can still be worth asking about). A « non »
 *  needs a why: it is what the next version learns to decide alone from. */
export async function trancher(
  id: number,
  valeur: string | null,
  commentaire: string,
  par: Auteur,
  avis: { justifie: boolean; pourquoi: string },
  sql: Sql = mpsPg(),
): Promise<void> {
  const s = await aJuger(id, ['aide'])
  const pq = avis.pourquoi.trim()
  if (!avis.justifie && !pq) throw new GesteRefuse('pourquoi_requis', 'Dis à Tricobot pourquoi il pouvait décider seul : il s’en sert pour s’améliorer.')
  const ecrit = valeur ? await ecrireValeur(s, valeur, par) : null
  await marquer(id, 'resolue', par, ecrit, commentaire.trim() || null, sql)
  await sql`UPDATE saisie_agent SET doute_justifie = ${avis.justifie}, doute_commentaire = ${pq || null} WHERE id = ${id}`
  // A BL's run carries the same answer: in Agents IA the score of an « à
  // vérifier » run IS « was it right to ask? » (competences-flux.ts pointsBl).
  await retourBl(s, avis.justifie, pq, par)
}

/** « Il y avait un délai dans ce mail » on a « rien »: an omission, with why. */
export async function omission(id: number, commentaire: string, par: Auteur): Promise<void> {
  await aJuger(id, ['rien'])
  await marquer(id, 'omission', par, null, pourquoi(commentaire))
}

/** A person changed a line's délai by hand (PUT lignes): every saisie of
 *  Tricobot on it still open (waiting, or written alone) is judged by that
 *  value — the same value validates, another corrects. Never fails the write. */
export async function ligneModifiee(idligne: number, delaiDigits: string, par: Auteur | null): Promise<number> {
  try {
    const sql = mpsPg()
    const ouvertes = (await sql`
      SELECT * FROM saisie_agent WHERE idligne_commande_sous_traitant = ${idligne}
        AND decision = 'saisie' AND champ = 'date_livraison' AND statut IN ('a_revoir', 'autonome')`).map(versSaisie)
    const iso = /^\d{8}$/.test(delaiDigits) ? `${delaiDigits.slice(0, 4)}-${delaiDigits.slice(4, 6)}-${delaiDigits.slice(6, 8)}` : null
    const qui = par ?? { id: 0, nom: 'Inconnu' }
    for (const s of ouvertes) {
      if (iso && iso === s.proposition) await marquer(s.id, 'validee', qui, iso, null, sql)
      else await marquer(s.id, 'corrigee', qui, iso, 'Délai modifié depuis la ligne de commande.', sql)
    }
    // Observation: what Tricobot would have done, judged by the délai the person typed.
    return iso ? await comparerObservations(sql`idligne_commande_sous_traitant = ${idligne} AND champ = 'date_livraison'`, iso, qui, 'la ligne de commande', sql) : 0
  } catch (e) {
    console.error('[saisies] line edit not reflected on Tricobot’s saisies', idligne, e)
    return 0
  }
}

/** A person saved a lot's dyer measures on Suivi lots (PUT): Tricobot's open
 *  saisie on it is judged by them — the same values validate, others correct.
 *  Never fails the write. */
export async function lotModifie(idsuivilot: number, par: Auteur | null): Promise<number> {
  try {
    const sql = mpsPg()
    const ouvertes = (await sql`
      SELECT * FROM saisie_agent WHERE idsuivilot = ${idsuivilot}
        AND decision = 'saisie' AND champ = 'mesures_sst' AND statut IN ('a_revoir', 'autonome')`).map(versSaisie)
    const m = await lireMesuresLot(idsuivilot, sql)
    if (!m) return 0
    const t = texteMesures(m)
    const qui = par ?? { id: 0, nom: 'Inconnu' }
    for (const s of ouvertes) {
      if (t === s.proposition) await marquer(s.id, 'validee', qui, t, null, sql)
      else await marquer(s.id, 'corrigee', qui, t, 'Mesures modifiées depuis Suivi lots.', sql)
    }
    return aDesMesures(m) ? await comparerObservations(sql`idsuivilot = ${idsuivilot} AND champ = 'mesures_sst'`, t, qui, 'Suivi lots', sql) : 0
  } catch (e) {
    console.error('[saisies] lot edit not reflected on Tricobot’s saisies', idsuivilot, e)
    return 0
  }
}

// ── Observation (ex-essai, Vincent 2026-11-05) ───────────

/** An observation point is compared with the first value a person types within this many days. */
export const OBSERVATION_FENETRE_J = 14

/** Judge the observation points of a line or a lot by the value a person just
 *  typed (canonical: 'YYYY-MM-DD', texteMesures()). Only points of the last
 *  OBSERVATION_FENETRE_J days, once each. Returns how many were judged. */
async function comparerObservations(ou: PendingQuery<Row[]>, valeur: string, par: Auteur, ou_lu: string, sql: Sql): Promise<number> {
  const points = (await sql`
    SELECT * FROM saisie_agent WHERE statut = 'observation' AND ${ou}
      AND cree_le > now() - make_interval(days => ${OBSERVATION_FENETRE_J})`).map(versSaisie)
  for (const s of points) await jugerObservation(s, valeur, par, ou_lu, sql)
  return points.length
}

/** One observation point judged by the value a person typed. A saisie with
 *  the same value is validated, another is corrected; an aide is settled with
 *  that value, and its doubt is ESTIMATED (nobody was asked): asking was
 *  useful unless its own proposal was already right. */
export async function jugerObservation(
  s: Pick<Saisie, 'id' | 'decision' | 'proposition'>, valeur: string, par: Auteur, ou_lu: string, sql: Sql = mpsPg(),
): Promise<void> {
  const pareil = (s.proposition ?? '') === valeur
  if (s.decision === 'saisie') {
    await marquer(s.id, pareil ? 'validee' : 'corrigee', par, valeur, pareil ? null : `Comparé à la saisie faite depuis ${ou_lu} (observation).`, sql)
  } else if (s.decision === 'aide') {
    await marquer(s.id, 'resolue', par, valeur, null, sql)
    await sql`UPDATE saisie_agent SET doute_justifie = ${!pareil},
      doute_commentaire = ${pareil ? 'Estimé en observation : sa proposition était la valeur saisie, il pouvait décider seul.' : null}
      WHERE id = ${s.id}`
  }
}

/** Observation: a person typed a value on a line or a lot the mail was about,
 *  and Tricobot read nothing for it: an omission, recorded already judged. */
export async function enregistrerOmissionObservation(
  n: Omit<NouvelleSaisie, 'mode' | 'decision' | 'proposition' | 'ecrit' | 'etatAvant'>, valeur: string, par: Auteur, ou_lu: string, sql: Sql = mpsPg(),
): Promise<number> {
  const id = await enregistrerSaisie({ ...n, mode: 'observation', decision: 'rien', proposition: null, ecrit: false, etatAvant: null }, sql)
  await marquer(id, 'omission', par, valeur, `Une personne a saisi cette valeur depuis ${ou_lu} ; Tricobot n’avait rien lu pour elle (observation).`, sql)
  return id
}
