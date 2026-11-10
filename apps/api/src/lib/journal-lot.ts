// Qualité › Suivi lots « Journal » tab (Vincent 2026-11-10): what was done on a
// lot, by whom and when — « BL enregistré par Pierre-Emmanuel le 26/10 »,
// « Rapport de contrôle envoyé le… », « Contrôle ennoblisseur enregistré le… par… ».
//
// Two kinds of source, never copied into each other:
//   - the facts that already carry who + when in their own table (soumissions,
//     the client's answers, « coloris validé », rapports de contrôle and their
//     dispenses, reprises, action verdicts, Tricobot's measures) are READ there;
//   - the gestures that had no trace of their own (reception, dyer / Malterre
//     measures typed on Suivi lots, the lab tablet, état changes) are written in
//     `journal_lot` (migration 0068, append-only) by noterLot().
//
// Never built on `journal_activite`: purged after a year, it keeps the whole
// form a save sends (not what changed), and it is a monitoring device whose
// purpose is the activity report, not a screen everyone reads.

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'
import { cleLot } from './cycle-ennoblissement.js'

export type EvenementLot =
  | 'reception'
  | 'mesures_ennoblisseur'
  | 'mesures_malterre'
  | 'coloris_malterre'
  | 'tirelle_avant_lavage'
  | 'tirelle_apres_lavage'
  | 'tirelle_jete'
  | 'etat'

export interface ParLot { id: number; nom: string }

/** Write one gesture on the lot. Never throws: the gesture itself is the user's
 *  action, a missing journal line is not worth failing it. */
export async function noterLot(n: {
  idsuivilot: number
  evenement: EvenementLot
  detail?: string | null
  par: ParLot | null
  sql?: Sql
}): Promise<void> {
  if (!(n.idsuivilot > 0)) return
  try {
    await (n.sql ?? mpsPg())`
      INSERT INTO journal_lot (idsuivilot, evenement, detail, par_id, par)
      VALUES (${n.idsuivilot}, ${n.evenement}, ${n.detail ?? null}, ${n.par?.id ?? 0}, ${n.par?.nom ?? null})`
  } catch (e) {
    console.error('[journal-lot] not written', n.idsuivilot, n.evenement, e)
  }
}

// ── The measures of a lot, to tell which side a save changed ──

export interface MesuresLot {
  laize_sst: number | null; poids_sst: number | null; stabh_sst: number | null; stabl_sst: number | null; vrillage_sst: number | null
  laize_tirelle: number | null; poids_tirelle: number | null; stabh_tirelle: number | null; stabl_tirelle: number | null; vrillage_tirelle: number | null
  allongementh_tirelle: number | null; allongementl_tirelle: number | null
  coloris_tirelle: string | null
}

export async function lireMesuresCotes(idsuivilot: number, sql: Sql = mpsPg()): Promise<MesuresLot | null> {
  const [r] = await sql<MesuresLot[]>`
    SELECT laize_sst, poids_sst, stabh_sst, stabl_sst, vrillage_sst,
           laize_tirelle, poids_tirelle, stabh_tirelle, stabl_tirelle, vrillage_tirelle,
           allongementh_tirelle, allongementl_tirelle, coloris_tirelle
    FROM suivilot WHERE idsuivilot = ${idsuivilot}`
  return r ?? null
}

/** [column base, label, unit]. The allongement exists on the tirelle side only. */
const LIBELLES: Array<[string, string, string]> = [
  ['laize', 'laize', ''], ['poids', 'poids', ''], ['stabh', 'stab H', ''], ['stabl', 'stab L', ''], ['vrillage', 'vrillage', ' %'],
  ['allongementh', 'allongement H', ' %'], ['allongementl', 'allongement L', ' %'],
]

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v))
/** laize / poids store 0 for « not measured » (legacy); stabs, vrillage and allongement NULL. */
const mesure = (champ: string, v: unknown): number | null => {
  const x = num(v)
  if (x === null || !Number.isFinite(x)) return null
  return (champ === 'laize' || champ === 'poids') && x === 0 ? null : x
}
const fmt = (x: number) => String(x).replace('.', ',')

/** « laize 154 · poids 166 · stab H −3 » for what changed on one side; null = nothing. */
export function changementsCote(avant: MesuresLot | null, apres: MesuresLot | null, cote: 'sst' | 'tirelle'): string | null {
  if (!apres) return null
  const parts: string[] = []
  for (const [base, libelle, unite] of LIBELLES) {
    const col = `${base}_${cote}` as keyof MesuresLot
    const a = mesure(base, avant?.[col])
    const b = mesure(base, apres[col])
    if (a === b) continue
    parts.push(b === null ? `${libelle} effacé` : `${libelle} ${fmt(b)}${unite}`)
  }
  return parts.length ? parts.join(' · ') : null
}

/** Journal the measures a save of the lot changed, one line per side. */
export async function noterMesures(idsuivilot: number, avant: MesuresLot | null, apres: MesuresLot | null, par: ParLot | null): Promise<void> {
  const sst = changementsCote(avant, apres, 'sst')
  if (sst) await noterLot({ idsuivilot, evenement: 'mesures_ennoblisseur', detail: sst, par })
  const tir = changementsCote(avant, apres, 'tirelle')
  if (tir) await noterLot({ idsuivilot, evenement: 'mesures_malterre', detail: tir, par })
  if (apres && (avant?.coloris_tirelle ?? null) !== (apres.coloris_tirelle ?? null)) {
    const v = apres.coloris_tirelle
    await noterLot({
      idsuivilot, evenement: 'coloris_malterre', par,
      detail: v === 'conforme' ? 'Conforme au rond 0' : v === 'ecart' ? 'Écart avec le rond 0' : 'Effacé',
    })
  }
}

// ── Reading ──

/** Who acted: a person, the dyer / client (outside), Tricobot, or unknown (history). */
export type AuteurType = 'personne' | 'tricobot' | 'inconnu'

export interface EntreeJournal {
  /** ISO timestamp. */
  le: string
  /** Groups the look on the screen (icon, colour). */
  type: string
  titre: string
  detail: string | null
  par: string | null
  auteur: AuteurType
}

const TITRES: Record<string, string> = {
  reception: 'BL enregistré',
  mesures_ennoblisseur: 'Contrôle ennoblisseur enregistré',
  mesures_malterre: 'Contrôle Malterre enregistré',
  coloris_malterre: 'Coloris contrôlé',
  tirelle_avant_lavage: 'Tirelle : contrôle avant lavage',
  tirelle_apres_lavage: 'Tirelle : contrôle après lavage',
  tirelle_jete: 'Tirelle jetée',
  etat: 'État du lot changé',
}

/** Rows of the same gesture by the same person within this window are one
 *  click (a BL reception posts one request per roll). */
const GROUPE_MS = 3 * 60 * 1000

/** Everything known about the lot, newest first. */
export async function lireJournalLot(idsuivilot: number, sql: Sql = mpsPg()): Promise<EntreeJournal[]> {
  const [lot] = await sql<{ ligne: number; cmd: number; lot: string; reception: string | null }[]>`
    SELECT COALESCE(idligne_commande_sous_traitant, 0)::bigint AS ligne, COALESCE(idcommande_sous_traitant, 0)::bigint AS cmd,
           trim(lot::text) AS lot, to_char(date, 'YYYY-MM-DD') AS reception
    FROM suivilot WHERE idsuivilot = ${idsuivilot}`
  if (!lot) return []
  const ligne = Number(lot.ligne)
  const cmd = Number(lot.cmd)
  const cle = cleLot(lot.lot)
  const memeLot = (l: string | null) => !!l && cleLot(String(l)) === cle

  const [propres, soumissions, reponses, okRamer, rcs, dispenses, reprises, verdicts, labo, tricobot] = await Promise.all([
    sql<{ evenement: string; detail: string | null; par: string | null; le: Date; source: string }[]>`
      SELECT evenement, detail, par, le, source FROM journal_lot WHERE idsuivilot = ${idsuivilot} ORDER BY le, id`,
    sql<{ nature: string; lot: string; le: Date; par: string | null; destinataires: string | null; idsuivilot: number }[]>`
      SELECT nature, lot, envoyee_le AS le, envoyee_par AS par, destinataires, idsuivilot FROM soumission_lot
      WHERE idsuivilot = ${idsuivilot} OR (idcommande_sous_traitant = ${cmd} AND ${cmd} > 0)`,
    sql<{ nature: string | null; lot: string | null; reponse: number; commentaire: string | null; le: Date | null; jour: string | null; par: string | null; idsuivilot: number }[]>`
      SELECT nature, lot::text AS lot, COALESCE(reponse, 0)::int AS reponse, commentaire, saisi_le AS le,
             to_char(date, 'YYYY-MM-DD') AS jour, saisi_par AS par, COALESCE(idsuivilot, 0)::bigint AS idsuivilot
      FROM reponse_soumission WHERE idsuivilot = ${idsuivilot} OR (idcommande_sous_traitant = ${cmd} AND ${cmd} > 0)`,
    sql<{ le: Date; par: string | null; destinataires: string | null }[]>`
      SELECT envoye_le AS le, envoye_par AS par, destinataires FROM ok_a_ramer_envoi WHERE idsuivilot = ${idsuivilot}`,
    sql<{ le: Date; par: string | null; destinataires: string | null; client: string | null; lot: string }[]>`
      SELECT r.envoye_le AS le, r.envoye_par AS par, r.destinataires, c.nom AS client, r.lot
      FROM rapport_controle_envoi r LEFT JOIN client c ON c.idclient = r.idclient
      WHERE r.idsuivilot = ${idsuivilot} OR (r.idligne_commande_sous_traitant = ${ligne} AND ${ligne} > 0)`,
    sql<{ le: Date; par: string | null; motif: string; client: string | null; lot: string }[]>`
      SELECT d.saisi_le AS le, d.saisi_par AS par, d.motif, c.nom AS client, d.lot
      FROM rapport_controle_dispense d LEFT JOIN client c ON c.idclient = d.idclient
      WHERE d.idligne_commande_sous_traitant = ${ligne} AND ${ligne} > 0`,
    sql<{ lot: string; rang: number; motif: string | null; envoye_le: Date | null; envoye_par: string | null; retour_le: Date | null; retour_par: string | null; origine: string }[]>`
      SELECT lot, rang, motif, envoye_le, envoye_par, retour_le, retour_par, origine FROM reprise
      WHERE idligne_commande_sous_traitant = ${ligne} AND ${ligne} > 0`,
    sql<{ conformite: string; par: string; le: Date }[]>`
      SELECT conformite, par, le FROM conformite_lot WHERE idsuivilot = ${idsuivilot}`,
    sql<{ termine_le: Date | null; jete_le: Date | null; a_jeter_depuis: Date | null; a_jeter_motif: string | null }[]>`
      SELECT termine_le, jete_le, a_jeter_depuis, a_jeter_motif FROM tirelle_labo WHERE idsuivilot = ${idsuivilot}`,
    sql<{ le: Date; proposition: string | null; statut: string | null; revu_par: string | null; revu_le: Date | null }[]>`
      SELECT cree_le AS le, proposition, statut, revu_par, revu_le FROM saisie_agent
      WHERE idsuivilot = ${idsuivilot} AND competence = 'controles' AND ecrit AND mode <> 'observation'`,
  ])

  const out: EntreeJournal[] = []
  const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString())

  // Own gestures, grouped per click.
  let precedent: { e: EntreeJournal; ev: string; t: number; n: number } | null = null
  for (const r of propres) {
    const t = new Date(r.le).getTime()
    if (precedent && precedent.ev === r.evenement && precedent.e.par === (r.par ?? null) && t - precedent.t <= GROUPE_MS && r.evenement === 'reception') {
      precedent.n++
      precedent.t = t
      precedent.e.detail = `${precedent.n} rouleaux`
      continue
    }
    const e: EntreeJournal = {
      le: iso(r.le),
      type: r.evenement,
      // An état change reads as itself: « Lot validé ».
      titre: r.evenement === 'etat' ? (r.detail || TITRES.etat) : (TITRES[r.evenement] ?? r.evenement),
      detail: r.evenement === 'reception' ? '1 rouleau' : r.evenement === 'etat' ? null : r.detail,
      par: r.par ?? null,
      auteur: r.par ? 'personne' : 'inconnu',
    }
    out.push(e)
    precedent = { e, ev: r.evenement, t, n: 1 }
  }
  // A lot received before the journal existed: its reception date, nobody known.
  if (lot.reception && !propres.some((r) => r.evenement === 'reception')) {
    out.push({ le: `${lot.reception}T00:00:00.000Z`, type: 'reception', titre: 'Lot reçu', detail: null, par: null, auteur: 'inconnu' })
  }

  for (const s of soumissions) {
    if (Number(s.idsuivilot) !== idsuivilot && !memeLot(s.lot)) continue
    out.push({
      le: iso(s.le), type: 'soumission',
      titre: s.nature === 'coloris' ? 'Coloris soumis au client' : 'Stabilités soumises au client',
      detail: s.destinataires ? `À ${s.destinataires}` : null, par: s.par, auteur: s.par ? 'personne' : 'inconnu',
    })
  }
  for (const r of reponses) {
    if (Number(r.idsuivilot) !== idsuivilot && !memeLot(r.lot)) continue
    const quoi = r.nature === 'coloris' ? 'le coloris' : r.nature === 'stabilites' ? 'les stabilités' : 'le lot'
    out.push({
      le: r.le ? iso(r.le) : `${r.jour}T00:00:00.000Z`, type: r.reponse === 1 ? 'reponse_ok' : 'reponse_refus',
      titre: `Le client ${r.reponse === 1 ? 'accepte' : 'refuse'} ${quoi}`,
      detail: r.commentaire?.trim() || null, par: r.par, auteur: r.par ? 'personne' : 'inconnu',
    })
  }
  for (const o of okRamer) {
    out.push({ le: iso(o.le), type: 'ok_ramer', titre: 'Coloris validé transmis à l’ennoblisseur', detail: o.destinataires ? `À ${o.destinataires}` : null, par: o.par, auteur: o.par ? 'personne' : 'inconnu' })
  }
  for (const r of rcs) {
    if (!memeLot(r.lot)) continue
    out.push({
      le: iso(r.le), type: 'rc', titre: `Rapport de contrôle envoyé${r.client ? ` à ${r.client.trim()}` : ''}`,
      detail: r.destinataires ? `À ${r.destinataires}` : null, par: r.par, auteur: r.par ? 'personne' : 'inconnu',
    })
  }
  for (const d of dispenses) {
    if (!memeLot(d.lot)) continue
    out.push({ le: iso(d.le), type: 'rc', titre: `Rapport de contrôle dispensé${d.client ? ` : ${d.client.trim()}` : ''}`, detail: d.motif, par: d.par, auteur: d.par ? 'personne' : 'inconnu' })
  }
  for (const r of reprises) {
    if (!memeLot(r.lot)) continue
    if (r.envoye_le) out.push({ le: iso(r.envoye_le), type: 'reprise', titre: `Envoyé en reprise${r.rang > 1 ? ` (${r.rang}e)` : ''}`, detail: r.motif, par: r.envoye_par, auteur: r.envoye_par ? 'personne' : 'inconnu' })
    if (r.retour_le) out.push({ le: iso(r.retour_le), type: 'reception', titre: 'Retour de reprise réceptionné', detail: null, par: r.retour_par, auteur: r.retour_par ? 'personne' : 'inconnu' })
  }
  for (const v of verdicts) {
    out.push({ le: iso(v.le), type: v.conformite === 'conforme' ? 'reponse_ok' : 'reponse_refus', titre: `Action qualité jugée ${v.conformite === 'conforme' ? 'conforme' : 'non conforme'}`, detail: null, par: v.par || null, auteur: v.par ? 'personne' : 'inconnu' })
  }
  const l = labo[0]
  const aLigne = (ev: string) => propres.some((r) => r.evenement === ev)
  if (l?.termine_le && !aLigne('tirelle_apres_lavage')) out.push({ le: iso(l.termine_le), type: 'tirelle_apres_lavage', titre: 'Tirelle : contrôles terminés', detail: null, par: null, auteur: 'inconnu' })
  if (l?.a_jeter_depuis) out.push({ le: iso(l.a_jeter_depuis), type: 'tirelle_jete', titre: 'Tirelle à jeter', detail: l.a_jeter_motif, par: null, auteur: 'inconnu' })
  if (l?.jete_le && !aLigne('tirelle_jete')) out.push({ le: iso(l.jete_le), type: 'tirelle_jete', titre: 'Tirelle jetée', detail: null, par: null, auteur: 'inconnu' })
  for (const t of tricobot) {
    out.push({ le: iso(t.le), type: 'mesures_ennoblisseur', titre: 'Contrôle ennoblisseur enregistré', detail: t.proposition, par: 'Tricobot', auteur: 'tricobot' })
  }

  return out.sort((a, b) => b.le.localeCompare(a.le))
}
