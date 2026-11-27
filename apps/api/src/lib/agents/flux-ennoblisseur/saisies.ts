// What Tricobot wrote or decided, point by point (PG `saisie_agent`, migration
// 0060), and the gestures a person answers it with — the ground the three
// measures are read from (competences.ts, claude_doc/agents_autonomie.md).
//
// One skill on it: Flux Ennoblisseur › BL, a delivery note to receive
// (reception-bl.ts). The gestures are given where the work is done
// (Sous-traitants › Ennoblissement, the order's card), never in Agents IA:
//   valider    the saisie stays            → fiabilité 1/1 (the rolls are received)
//   supprimer  nothing to write, with why  → fiabilité 0/1 (« pas à réceptionner »)
//   trancher   an aide settled by a person → discernement (its proposal kept or not)
// A BL is corrected from the réception dialog, which judges its point
// (`receptionFaite`); a roll corrected after Tricobot received it alone too
// (`rouleauCorrige`).
//
// The points of the skills Délais and Contrôles (removed 2026-11-27) stay in
// the table (`competence` 'delais' / 'controles', all read in observation):
// every read here names the BL, so they are ignored.
//
// Also here, since those skills used them: the writes of « the dyer said so »
// (`ecrireDelai`, `ecrireMesures`), which the espace partenaire goes through
// (lib/espace-partenaire-saisies.ts).

import type { Sql } from 'postgres'
import { mpsPg } from '../../mps-pg.js'
import { valeurStab } from '../../stabilites.js'
import { query } from '../../hfsql-auto.js'
import { sstDelaiSets, STATUT_ATTENTE_DELAI, STATUT_NON_ENVOYE } from '../../sst-shared.js'
import { noterDelaiRecu } from '../../delai-sst.js'
import { dateDeReference, enregistrerReportDelai, estUnReportDelai, noterAvanceDelai, refusAvanceDelai } from '../../report-delai-sst.js'
import { noterReponseUrgence } from '../../urgence-sst.js'
import type { Decision, PointMesure, StatutPoint } from '../competences.js'
import { enregistrerRetour } from '../retours.js'
import { CHAMP_RECEPTION, lireReception, lotNormalise, receptionnerProposition, retirerPreRemplissage, texteReception } from './reception-bl.js'

export interface Auteur { id: number; nom: string }

/** The author of what Tricobot writes (a réception done alone). */
export const TRICOBOT: Auteur = { id: 0, nom: 'Tricobot' }

/** `saisie_agent.competence` of the points read here. */
const BL = 'bl'

export interface Saisie {
  id: number
  agent: string
  competence: string
  version: number
  runId: string
  messageId: string | null
  threadId: string | null
  creeLe: string
  mode: 'supervise' | 'autonome'
  decision: Decision
  idsousTraitant: number
  idcommande: number
  idligne: number
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
})

// ── Reads ────────────────────────────────────────────────

export async function saisiesDeCompetence(agent: string, competence: string, version?: number, sql: Sql = mpsPg()): Promise<Saisie[]> {
  const rows = version === undefined
    ? await sql`SELECT * FROM saisie_agent WHERE agent = ${agent} AND competence = ${competence} ORDER BY cree_le`
    : await sql`SELECT * FROM saisie_agent WHERE agent = ${agent} AND competence = ${competence} AND version = ${version} ORDER BY cree_le`
  return rows.map(versSaisie)
}

/** Every saisie on one sst order, newest first (the order's revue). */
export async function saisiesDeCommande(idcommande: number, sql: Sql = mpsPg()): Promise<Saisie[]> {
  const rows = await sql`SELECT * FROM saisie_agent WHERE idcommande_sous_traitant = ${idcommande} AND competence = ${BL} ORDER BY cree_le DESC, id`
  return rows.map(versSaisie)
}

export async function saisie(id: number, sql: Sql = mpsPg()): Promise<Saisie | null> {
  const [r] = await sql`SELECT * FROM saisie_agent WHERE id = ${id} AND competence = ${BL}`
  return r ? versSaisie(r) : null
}

/** Per order: what waits for a person (a réception to validate, an aide) and
 *  what Tricobot received alone, for the cards of Sous-traitants › Ennoblissement. */
export async function compteursParCommande(sql: Sql = mpsPg()): Promise<Record<number, { aValider: number; aide: number; autonome: number }>> {
  const rows = await sql<{ cmd: number; decision: string; statut: string; n: number }[]>`
    SELECT idcommande_sous_traitant AS cmd, decision, statut, count(*)::int AS n FROM saisie_agent
    WHERE idcommande_sous_traitant > 0 AND competence = ${BL} AND statut IN ('a_revoir', 'autonome')
    GROUP BY 1, 2, 3`
  const out: Record<number, { aValider: number; aide: number; autonome: number }> = {}
  for (const r of rows) {
    const o = (out[Number(r.cmd)] ??= { aValider: 0, aide: 0, autonome: 0 })
    if (r.statut === 'autonome') o.autonome += r.n
    else if (r.decision === 'aide') o.aide += r.n
    else o.aValider += r.n
  }
  return out
}

// ── Writes by the agent ──────────────────────────────────

export interface NouvelleSaisie {
  agent: string
  competence: string
  version: number
  runId: string
  messageId: string | null
  threadId: string | null
  mode: 'supervise' | 'autonome'
  decision: Decision
  idsousTraitant: number
  idcommande: number
  idligne: number
  champ: string | null
  valeurAvant: string | null
  etatAvant: Record<string, unknown> | null
  proposition: string | null
  ecrit: boolean
  explication: string
  citation: string
}

export async function enregistrerSaisie(n: NouvelleSaisie, sql: Sql = mpsPg()): Promise<number> {
  const statut: StatutPoint = n.mode === 'autonome' && n.decision !== 'aide' ? 'autonome' : 'a_revoir'
  const [r] = await sql<{ id: number }[]>`
    INSERT INTO saisie_agent (agent, competence, version, run_id, message_id, thread_id, mode, decision,
      idsous_traitant, idcommande_sous_traitant, idligne_commande_sous_traitant, champ, valeur_avant, etat_avant,
      proposition, ecrit, explication, citation, statut)
    VALUES (${n.agent}, ${n.competence}, ${n.version}, ${n.runId}, ${n.messageId}, ${n.threadId}, ${n.mode}, ${n.decision},
      ${n.idsousTraitant}, ${n.idcommande}, ${n.idligne}, ${n.champ}, ${n.valeurAvant}, ${n.etatAvant ? sql.json(n.etatAvant as never) : null},
      ${n.proposition}, ${n.ecrit}, ${n.explication}, ${n.citation}, ${statut})
    RETURNING id`
  return Number(r.id)
}

// ── The délai on a sst line (« the dyer said so ») ───────

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
 *  one given is a report (LIVA #1364): announced by the dyer, so due to the
 *  sous-traitant, its motif quoting what it wrote (`citation`). Returns the line before. */
export async function ecrireDelai(idligne: number, delai: string, par: Auteur, citation?: string | null): Promise<EtatLigne> {
  const avant = await lireEtatLigne(idligne)
  if (!avant) throw new Error(`ligne ${idligne} introuvable`)
  // Brought earlier only to a date still to come (lib/report-delai-sst.ts).
  const cur = { date_livraison: avant.dateLivraison, date_delai: avant.dateDelai, sstatut: avant.sstatut }
  const avance = await refusAvanceDelai(Math.trunc(idligne), cur, delai)
  if (avance) throw new Error(avance)
  const r = sstDelaiSets(cur, delai)
  await query(`UPDATE ligne_commande_sous_traitant SET ${r.sets.join(', ')} WHERE IDligne_commande_sous_traitant = ${Math.trunc(idligne)}`)
  if (avant.sstatut === STATUT_ATTENTE_DELAI && r.sstatut !== STATUT_ATTENTE_DELAI && r.sstatut !== STATUT_NON_ENVOYE) {
    await noterDelaiRecu(idligne, r.date_livraison || null, par)
  }
  // The dyer announced an earlier délai: a fact for the Journal.
  await noterAvanceDelai({ idligne: Math.trunc(idligne), avant: cur, nouveau: r.date_livraison, par })
  // The dyer moved the délai it had given while an urgency awaited: that is its answer.
  await noterReponseUrgence(Math.trunc(idligne), avant.dateLivraison, r.date_livraison, par)
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

// ── The dyer's measures on a lot (« the dyer said so ») ──

/** The dyer side of a lot's control (suivilot *_sst). laize / poids / stab are
 *  integers in the table; stab and vrillage NULL = not measured, 0 is a measure (#1358). */
export interface MesuresSst { laize: number; poids: number; stabH: number | null; stabL: number | null; vrillage: number | null }

/** One canonical text per measure set: « nothing changed » is a string comparison. */
export const texteMesures = (m: MesuresSst) =>
  JSON.stringify({ laize: m.laize, poids: m.poids, stabH: m.stabH, stabL: m.stabL, vrillage: m.vrillage })

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

// ── The person's gestures ────────────────────────────────

export class GesteRefuse extends Error {
  constructor(public code: string, message: string) { super(message) }
}

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

/** « Valider » a saisie: Tricobot was right. A supervisé saisie was only
 *  proposed: validating writes it, by the person. */
export async function valider(id: number, par: Auteur, sql: Sql = mpsPg()): Promise<void> {
  const s = await aJuger(id, ['saisie'])
  if (!s.ecrit && s.proposition) {
    await ecrireValeur(s, s.proposition, par)
    await sql`UPDATE saisie_agent SET ecrit = true WHERE id = ${id}`
  }
  await marquer(id, 'validee', par, s.proposition, null, sql)
  await retourBl(s, true, '', par)
}

/** A BL point judged: the same verdict on its run, so Agents IA › Exécutions
 *  reads what the person said (best effort — the point is the measure). */
async function retourBl(s: Pick<Saisie, 'agent' | 'runId'>, juste: boolean, commentaire: string, par: Auteur, corrections: string[] = []): Promise<void> {
  try {
    await enregistrerRetour({ slug: s.agent, runId: s.runId, cle: null, juste, commentaire, corrections, par, garderEchec: true })
  } catch (e) {
    console.error('[saisies] BL retour not recorded on its run', s.runId, e)
  }
}

/** The rolls of a BL's proposal received on its line, by the person who validates. Returns the canonical text. */
async function ecrireValeur(s: Saisie, valeur: string, par: Auteur): Promise<string> {
  const p = lireReception(valeur)
  if (!p) throw new GesteRefuse('reception_invalide', 'Proposition de réception illisible : réceptionne ce BL à la main.')
  await receptionnerProposition(s.idcommande, s.idligne, p, par)
  return texteReception(p)
}

/** « Pas à réceptionner »: nothing should have been proposed, with why. The
 *  réception must not offer these rolls again; rolls already received stay. */
export async function supprimer(id: number, commentaire: string, par: Auteur): Promise<void> {
  const s = await aJuger(id, ['saisie'])
  const why = pourquoi(commentaire)
  const p = lireReception(s.proposition)
  if (p) await retirerPreRemplissage(s.idligne, p.lot)
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
        AND competence = ${BL} AND champ = ${CHAMP_RECEPTION} AND decision = 'saisie' AND statut IN ('a_revoir', 'autonome')`).map(versSaisie)
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

/** A person corrected or removed a roll of a lot (« Corriger la réception », a
 *  roll deleted): a BL Tricobot received alone on that line for that lot was
 *  wrong on it. Its point, still « non revu », is corrected, with what changed
 *  as the why (doctrine §4: an autonomous point corrected later is a fiabilité
 *  failure). A point waiting in supervisé is not touched: the réception judges
 *  it (`receptionFaite`). Never fails the write. Returns how many were judged. */
export async function rouleauCorrige(idligne: number, lot: string, quoi: string, par: Auteur | null): Promise<number> {
  try {
    const sql = mpsPg()
    const seuls = (await sql`
      SELECT * FROM saisie_agent WHERE idligne_commande_sous_traitant = ${idligne}
        AND competence = ${BL} AND champ = ${CHAMP_RECEPTION} AND decision = 'saisie' AND statut = 'autonome'`).map(versSaisie)
    const cible = lotNormalise(lot)
    const qui = par ?? { id: 0, nom: 'Inconnu' }
    let n = 0
    for (const s of seuls) {
      if (lotNormalise(lireReception(s.proposition)?.lot ?? '') !== cible) continue
      await marquer(s.id, 'corrigee', qui, quoi.slice(0, 4000), 'Rouleau corrigé après la réception faite seul par Tricobot.', sql)
      await retourBl(s, false, '', qui, [quoi])
      n++
    }
    return n
  } catch (e) {
    console.error('[saisies] roll edit not reflected on Tricobot’s BL point', idligne, lot, e)
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
