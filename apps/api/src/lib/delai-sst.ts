// The délai question of a sous-traitant order (LIVA #1314, decided with Vincent
// 2026-10-22).
//
// Once the bon de commande is out, the order waits for the dyer's délai
// (lines in Attente_Delai). Until then the only trace was one date,
// `commande_sous_traitant.date_notif`, seeded at bon + 3 working days and
// overwritten by hand — no record of who chased, when, nor why the date was
// moved. A card stayed red for days while MATEL had been asked in every
// morning's Point (9117, 22/10). Now the question is a series of dated facts:
//
//   - asked:     the first bon de commande email (envoi_email type 13);
//   - relances:  every Point sent with the order in its « délais » section
//                (point_sst_ligne — derived, never copied) and every
//                « Relancer » gesture (e-mail / phone, `delai_sst_evenement`);
//   - reports:   « Repousser » — a new échéance, a motif, and who the wait is
//                imputable to (the dyer, or us: yarn not there, client undecided);
//   - answered:  a line leaving Attente_Delai with a date (PUT lignes, TRM's
//                délai route), recorded at the write.
//
// Two dates come out of them:
//   - the ÉCHÉANCE: from when the délai is due — the latest report, else
//     date_notif, else bon + 3 working days. The Point asks from that day on,
//     every day until answered (lib/point-sst/regles.ts §5).
//   - the RELANCE (what the card shows): the échéance, pushed back
//     RELANCE_SUIVANTE_J working days after each relance. Red = it has come
//     and nobody chased since: Malterre is the one holding things up.
//
// The same facts feed the dyer's « Qualité de service » (lib/qualite-service-sst.ts).
// `delai_sst_evenement` is append-only (the API role may only SELECT / INSERT).

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'
import { plusJoursOuvres } from './cycle-ennoblissement.js'

/** Working days the dyer gets after the bon de commande before we ask (the old seed). */
export const DELAI_PREMIERE_DEMANDE_J = 3
/** Working days the dyer gets after a relance before it is ours to chase again. */
export const RELANCE_SUIVANTE_J = 2

export type CanalRelance = 'point' | 'email' | 'telephone'
export type Imputable = 'sous_traitant' | 'malterre'

export interface Relance {
  /** 'YYYY-MM-DD' (Paris). */
  jour: string
  canal: CanalRelance
  par: string | null
  note: string | null
}

export interface Report {
  /** When the report was made, 'YYYY-MM-DDTHH:MI' (Paris). */
  le: string
  /** The new échéance, 'YYYY-MM-DD'. */
  echeance: string
  motif: string
  imputable: Imputable
  par: string | null
}

export interface FaitsDelai {
  /** First bon de commande sent, 'YYYY-MM-DD'. */
  demandeLe: string | null
  /** commande_sous_traitant.date_notif, 'YYYY-MM-DD'. */
  dateNotif: string | null
  relances: Relance[]
  reports: Report[]
  /** First délai received on a line, 'YYYY-MM-DD' (null: none recorded). */
  reponduLe: string | null
}

/** From when the délai is due: the latest report, else date_notif, else bon + 3. Pure. */
export function echeanceDelai(f: FaitsDelai): string | null {
  const report = [...f.reports].sort((a, b) => a.le.localeCompare(b.le)).at(-1)
  if (report) return report.echeance
  if (f.dateNotif) return f.dateNotif
  return f.demandeLe ? plusJoursOuvres(f.demandeLe, DELAI_PREMIERE_DEMANDE_J) : null
}

/** The latest relance on or after the day the question was asked. Pure. */
export function derniereRelance(f: FaitsDelai): Relance | null {
  const rs = f.relances.filter((r) => !f.demandeLe || r.jour >= f.demandeLe)
  return rs.length ? rs.reduce((a, b) => (b.jour > a.jour ? b : a)) : null
}

/** When it is ours to chase: the échéance, or RELANCE_SUIVANTE_J working days
 *  after the latest relance if later. Pure. */
export function relanceDue(f: FaitsDelai): string | null {
  const e = echeanceDelai(f)
  const r = derniereRelance(f)
  if (!e) return r ? plusJoursOuvres(r.jour, RELANCE_SUIVANTE_J) : null
  if (!r) return e
  const apres = plusJoursOuvres(r.jour, RELANCE_SUIVANTE_J)
  return apres > e ? apres : e
}

// ── Reads ────────────────────────────────────────────────

const TYPE_DOC_BON = 13

const vide = (): FaitsDelai => ({ demandeLe: null, dateNotif: null, relances: [], reports: [], reponduLe: null })

/** The délai facts of each order, in a few flat reads. */
export async function lireFaitsDelai(ids: number[], sql: Sql = mpsPg()): Promise<Map<number, FaitsDelai>> {
  const out = new Map<number, FaitsDelai>()
  const cmdIds = [...new Set(ids.filter((x) => x > 0))]
  if (cmdIds.length === 0) return out
  for (const id of cmdIds) out.set(id, vide())

  const [entetes, bons, points, evenements] = await Promise.all([
    sql<{ id: number; date_notif: string | null }[]>`
      SELECT idcommande_sous_traitant AS id, to_char(date_notif, 'YYYY-MM-DD') AS date_notif
      FROM commande_sous_traitant WHERE idcommande_sous_traitant = ANY(${cmdIds})`,
    sql<{ id: number; jour: string }[]>`
      SELECT idreference AS id, to_char(min(date), 'YYYY-MM-DD') AS jour FROM envoi_email
      WHERE idtype_doc = ${TYPE_DOC_BON} AND idreference = ANY(${cmdIds}) GROUP BY idreference`,
    // A Point sent with the order in its « délais » section (§5) is a relance.
    // A lot in reprise sits in §5 too (cle « reprise: ») — not a délai question.
    sql<{ id: number; jour: string; par: string | null }[]>`
      SELECT DISTINCT l.idcommande_sous_traitant AS id,
             to_char(p.envoye_le AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS jour, p.envoye_par_nom AS par
      FROM point_sst_ligne l JOIN point_sst p ON p.idpoint_sst = l.idpoint_sst
      WHERE p.statut = 'envoye' AND p.envoye_le IS NOT NULL AND l.section = 5 AND NOT l.retiree
        AND l.idcommande_sous_traitant = ANY(${cmdIds}) AND COALESCE(l.cle, '') NOT LIKE 'reprise:%'`,
    sql<{ id: number; type: string; le: string; jour: string; canal: string | null; note: string | null; echeance: string | null; motif: string | null; imputable: string | null; par: string | null }[]>`
      SELECT idcommande_sous_traitant AS id, type,
             to_char(le AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD"T"HH24:MI') AS le,
             to_char(le AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS jour,
             canal, note, to_char(echeance, 'YYYY-MM-DD') AS echeance, motif, imputable, par
      FROM delai_sst_evenement WHERE idcommande_sous_traitant = ANY(${cmdIds}) ORDER BY le`,
  ])

  for (const e of entetes) out.get(Number(e.id))!.dateNotif = e.date_notif
  for (const b of bons) out.get(Number(b.id))!.demandeLe = b.jour
  for (const p of points) out.get(Number(p.id))!.relances.push({ jour: p.jour, canal: 'point', par: p.par, note: null })
  for (const e of evenements) {
    const f = out.get(Number(e.id))!
    if (e.type === 'relance') f.relances.push({ jour: e.jour, canal: (e.canal as CanalRelance) ?? 'email', par: e.par, note: e.note })
    else if (e.type === 'report' && e.echeance) f.reports.push({ le: e.le, echeance: e.echeance, motif: e.motif ?? '', imputable: (e.imputable as Imputable) ?? 'sous_traitant', par: e.par })
    else if (e.type === 'delai_recu' && (!f.reponduLe || e.jour < f.reponduLe)) f.reponduLe = e.jour
  }
  for (const f of out.values()) f.relances.sort((a, b) => a.jour.localeCompare(b.jour))
  return out
}

// ── Gestures ─────────────────────────────────────────────

export interface Auteur { id: number; nom: string }

export class DelaiRefuse extends Error {
  constructor(public code: string, message: string) { super(message) }
}

/** Lines of the order still waiting for their délai. */
async function lignesEnAttente(sql: Sql, idcommande: number): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM ligne_commande_sous_traitant
    WHERE idcommande_sous_traitant = ${idcommande} AND trim(sstatut::text) = 'Attente_Delai'`
  return Number(r?.n) || 0
}

/** « Relancer »: the dyer was asked again for the délai, by e-mail or phone. */
export async function noterRelance(idcommande: number, canal: 'email' | 'telephone', note: string, par: Auteur): Promise<void> {
  const sql = mpsPg()
  if ((await lignesEnAttente(sql, idcommande)) === 0) throw new DelaiRefuse('pas_en_attente', 'Cette commande n’attend plus de délai.')
  await sql`
    INSERT INTO delai_sst_evenement (idcommande_sous_traitant, type, canal, note, par_id, par)
    VALUES (${idcommande}, 'relance', ${canal}, ${note.trim() || null}, ${par.id}, ${par.nom})`
}

/** « Repousser »: the délai is not expected before `echeance`, for a reason.
 *  Writes date_notif too (every older reader of the relance date keeps one answer). */
export async function repousserEcheance(idcommande: number, echeance: string, motif: string, imputable: Imputable, par: Auteur, aujourdhui: string): Promise<void> {
  const m = motif.trim()
  if (!m) throw new DelaiRefuse('motif_requis', 'Indiquez pourquoi l’échéance est repoussée.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(echeance) || echeance <= aujourdhui) throw new DelaiRefuse('echeance_invalide', 'La nouvelle échéance doit être après aujourd’hui.')
  const sql = mpsPg()
  if ((await lignesEnAttente(sql, idcommande)) === 0) throw new DelaiRefuse('pas_en_attente', 'Cette commande n’attend plus de délai.')
  await sql.begin(async (t) => {
    const tx = t as unknown as Sql
    await tx`
      INSERT INTO delai_sst_evenement (idcommande_sous_traitant, type, echeance, motif, imputable, par_id, par)
      VALUES (${idcommande}, 'report', ${echeance}::date, ${m}, ${imputable}, ${par.id}, ${par.nom})`
    await tx`UPDATE commande_sous_traitant SET date_notif = ${echeance}::date WHERE idcommande_sous_traitant = ${idcommande}`
  })
}

/** A line got its délai (Attente_Delai → a date). Call after the line's UPDATE;
 *  never fails the write that called it. */
export async function noterDelaiRecu(idligne: number, delai: string | null, par: Auteur | null): Promise<void> {
  try {
    const sql = mpsPg()
    const [l] = await sql<{ cmd: number }[]>`
      SELECT idcommande_sous_traitant AS cmd FROM ligne_commande_sous_traitant WHERE idligne_commande_sous_traitant = ${idligne}`
    if (!l) return
    const d = delai && /^\d{8}$/.test(delai) ? `${delai.slice(0, 4)}-${delai.slice(4, 6)}-${delai.slice(6, 8)}` : delai
    await sql`
      INSERT INTO delai_sst_evenement (idcommande_sous_traitant, idligne_commande_sous_traitant, type, delai_donne, par_id, par)
      VALUES (${Number(l.cmd)}, ${idligne}, 'delai_recu', ${d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null}, ${par?.id ?? 0}, ${par?.nom ?? null})`
  } catch (e) {
    console.error('[delai-sst] délai reçu not recorded for line', idligne, e)
  }
}

// ── History of one order (Info tab) ──────────────────────

export interface EvenementDelai {
  /** 'YYYY-MM-DD' or 'YYYY-MM-DDTHH:MI'. */
  le: string
  type: 'demande' | 'relance' | 'report' | 'delai_recu'
  texte: string
  par: string | null
}

const jjmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`
const CANAL: Record<CanalRelance, string> = { point: 'dans le Point du jour', email: 'par e-mail', telephone: 'par téléphone' }

/** The délai question of one order, oldest first. Pure. */
export function historiqueDelai(f: FaitsDelai): EvenementDelai[] {
  const out: EvenementDelai[] = []
  if (f.demandeLe) out.push({ le: f.demandeLe, type: 'demande', texte: 'Bon de commande envoyé : délai demandé', par: null })
  for (const r of f.relances) out.push({ le: r.jour, type: 'relance', texte: `Relancé ${CANAL[r.canal]}${r.note ? ` — ${r.note}` : ''}`, par: r.par })
  for (const r of f.reports) {
    out.push({ le: r.le, type: 'report', texte: `Échéance repoussée au ${jjmm(r.echeance)} (${r.imputable === 'malterre' ? 'de notre fait' : 'du fait du sous-traitant'}) — ${r.motif}`, par: r.par })
  }
  if (f.reponduLe) out.push({ le: f.reponduLe, type: 'delai_recu', texte: 'Délai reçu', par: null })
  return out.sort((a, b) => a.le.localeCompare(b.le))
}
