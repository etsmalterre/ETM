// Sous-traitants › Ennoblissement « Journal » tab (Vincent 2026-11-10, ex
// « Historique »): what was done on the order, by whom and when — the order's
// own gestures, then every lot's journal (lib/journal-lot.ts), each line tagged
// with its lot.
//
// Same two kinds of source as the lot's journal:
//   - facts that already carry who + when are READ where they live: the délai
//     question (`delai_sst_evenement`), the Points sent (`point_sst`), the
//     lots' facts;
//   - the gestures with no author anywhere (creation, bon de commande — whose
//     `envoi_email` rows say when and to whom, never by whom — closing /
//     reopening) are written in `journal_commande_sst` (migration 0069).
// Never built on `journal_activite` (lib/journal-lot.ts says why).

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'
import { lireJournalLot, type AuteurType, type EntreeJournal } from './journal-lot.js'

export type EvenementCommandeSst = 'creation' | 'bon_commande' | 'etat'

export interface ParCommande { id: number; nom: string }

/** Write one gesture on the order. Never throws (the gesture is the user's). */
export async function noterCommandeSst(n: {
  idcommande: number
  evenement: EvenementCommandeSst
  detail?: string | null
  par: ParCommande | null
}): Promise<void> {
  if (!(n.idcommande > 0)) return
  try {
    await mpsPg()`
      INSERT INTO journal_commande_sst (idcommande_sous_traitant, evenement, detail, par_id, par)
      VALUES (${n.idcommande}, ${n.evenement}, ${n.detail ?? null}, ${n.par?.id ?? 0}, ${n.par?.nom ?? null})`
  } catch (e) {
    console.error('[journal-commande-sst] not written', n.idcommande, n.evenement, e)
  }
}

export interface EntreeJournalCommande extends EntreeJournal {
  /** The lot the line is about; null = the order itself. */
  lot: string | null
  idsuivilot: number | null
}

const TYPE_DOC_BON = 13
const TYPE_DOC_SOUMISSION = 15
/** An envoi_email burst and the journal row of the same click. */
const MEME_CLIC_MS = 3 * 60 * 1000
const jjmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`

/** Everything known about the order and its lots, newest first. */
export async function lireJournalCommandeSst(idcommande: number, sql: Sql = mpsPg()): Promise<EntreeJournalCommande[]> {
  const [entete] = await sql<{ jour: string | null }[]>`
    SELECT to_char(date_commande, 'YYYY-MM-DD') AS jour FROM commande_sous_traitant WHERE idcommande_sous_traitant = ${idcommande}`
  if (!entete) return []

  const [propres, emails, delais, points, lots] = await Promise.all([
    sql<{ evenement: string; detail: string | null; par: string | null; le: Date }[]>`
      SELECT evenement, detail, par, le FROM journal_commande_sst WHERE idcommande_sous_traitant = ${idcommande} ORDER BY le, id`,
    sql<{ le: Date; type_doc: number; adresse: string | null; notes: string | null }[]>`
      SELECT date AS le, idtype_doc AS type_doc, adresse, notes FROM envoi_email
      WHERE idreference = ${idcommande} AND idtype_doc IN (${TYPE_DOC_BON}, ${TYPE_DOC_SOUMISSION}) ORDER BY date`,
    sql<{ type: string; le: Date; canal: string | null; note: string | null; echeance: string | null; motif: string | null; imputable: string | null; delai: string | null; ancien: string | null; par: string | null; ref: string | null }[]>`
      SELECT e.type, e.le, e.canal, e.note, to_char(e.echeance, 'YYYY-MM-DD') AS echeance, e.motif, e.imputable,
             to_char(e.delai_donne, 'YYYY-MM-DD') AS delai, to_char(e.ancien_delai, 'YYYY-MM-DD') AS ancien, e.par, rf.reference AS ref
      FROM delai_sst_evenement e
      LEFT JOIN ligne_commande_sous_traitant l ON l.idligne_commande_sous_traitant = e.idligne_commande_sous_traitant
      LEFT JOIN ref_fini rf ON rf.idref_fini = l.idreference AND l.type = 2
      WHERE e.idcommande_sous_traitant = ${idcommande} ORDER BY e.le`,
    // A Point sent with the order in it (any section, not removed): one line per Point.
    sql<{ le: Date; jour: string; par: string | null }[]>`
      SELECT DISTINCT p.envoye_le AS le, to_char(p.jour, 'YYYY-MM-DD') AS jour, p.envoye_par_nom AS par
      FROM point_sst_ligne l JOIN point_sst p ON p.idpoint_sst = l.idpoint_sst
      WHERE p.statut = 'envoye' AND p.envoye_le IS NOT NULL AND NOT l.retiree AND l.idcommande_sous_traitant = ${idcommande}`,
    sql<{ id: number; lot: string }[]>`
      SELECT idsuivilot AS id, trim(lot::text) AS lot FROM suivilot WHERE idcommande_sous_traitant = ${idcommande} ORDER BY idsuivilot`,
  ])

  const out: EntreeJournalCommande[] = []
  const iso = (d: Date | string) => (d instanceof Date ? d.toISOString() : new Date(d).toISOString())
  const t = (d: Date | string) => new Date(d).getTime()
  const qui = (par: string | null): AuteurType => (par ? 'personne' : 'inconnu')
  const commande = (e: Omit<EntreeJournalCommande, 'lot' | 'idsuivilot'>): EntreeJournalCommande => ({ ...e, lot: null, idsuivilot: null })

  // The order's own gestures; a bon de commande row only lends its author to
  // the envoi_email burst of the same click (below).
  const bons = propres.filter((r) => r.evenement === 'bon_commande')
  for (const r of propres) {
    if (r.evenement === 'bon_commande') continue
    out.push(commande({
      le: iso(r.le), type: r.evenement === 'creation' ? 'creation' : 'cloture',
      titre: r.evenement === 'creation' ? 'Commande créée' : (r.detail || 'État de la commande changé'),
      detail: null, par: r.par, auteur: qui(r.par),
    }))
  }
  if (entete.jour && !propres.some((r) => r.evenement === 'creation')) {
    out.push(commande({ le: `${entete.jour}T00:00:00.000Z`, type: 'creation', titre: 'Commande créée', detail: null, par: null, auteur: 'inconnu' }))
  }

  // Lots first: their soumissions decide which legacy type-15 mails are already told.
  const parLot = await Promise.all(lots.map(async (l) => ({ l, entrees: await lireJournalLot(Number(l.id), sql) })))
  const soumissionsLots: number[] = []
  for (const { l, entrees } of parLot) {
    for (const e of entrees) {
      if (e.type === 'soumission') soumissionsLots.push(t(e.le))
      out.push({ ...e, lot: l.lot, idsuivilot: Number(l.id) })
    }
  }

  // envoi_email: one row per recipient — one entry per send (same type, within the window).
  type Envoi = { debut: number; le: Date; type_doc: number; dest: string[]; notes: string | null }
  const envois: Envoi[] = []
  for (const r of emails) {
    const last = envois[envois.length - 1]
    const at = t(r.le)
    const adresse = (r.adresse ?? '').trim()
    if (last && last.type_doc === Number(r.type_doc) && at - last.debut <= 60_000) {
      if (adresse && !last.dest.includes(adresse)) last.dest.push(adresse)
      continue
    }
    envois.push({ debut: at, le: r.le, type_doc: Number(r.type_doc), dest: adresse ? [adresse] : [], notes: r.notes?.trim() || null })
  }
  for (const e of envois) {
    const dest = e.dest.length ? `À ${e.dest.join(', ')}` : null
    if (e.type_doc === TYPE_DOC_BON) {
      const bon = bons.find((b) => Math.abs(t(b.le) - e.debut) <= MEME_CLIC_MS)
      out.push(commande({ le: iso(e.le), type: 'bon_commande', titre: 'Bon de commande envoyé', detail: dest, par: bon?.par ?? null, auteur: qui(bon?.par ?? null) }))
    } else if (!soumissionsLots.some((s) => Math.abs(s - e.debut) <= MEME_CLIC_MS)) {
      // A soumission sent before soumission_lot existed: the mail is its only trace.
      out.push({ le: iso(e.le), type: 'soumission', titre: 'Soumission envoyée au client', detail: dest, par: null, auteur: 'inconnu', lot: e.notes, idsuivilot: null })
    }
  }

  for (const d of delais) {
    if (d.type === 'relance') {
      out.push(commande({
        le: iso(d.le), type: 'relance', titre: `Délai relancé ${d.canal === 'telephone' ? 'par téléphone' : 'par e-mail'}`,
        detail: d.note, par: d.par, auteur: qui(d.par),
      }))
    } else if (d.type === 'report_delai') {
      // A délai pushed back after it was given (LIVA #1364).
      out.push(commande({
        le: iso(d.le), type: 'report', titre: `Délai repoussé du ${d.ancien ? jjmm(d.ancien) : '—'} au ${d.delai ? jjmm(d.delai) : '—'}`,
        detail: [d.ref?.trim() || null, d.imputable === 'malterre' ? 'De notre fait' : 'Du fait du sous-traitant', d.motif].filter(Boolean).join(' — '),
        par: d.par, auteur: d.par === 'Tricobot' ? 'tricobot' : qui(d.par),
      }))
    } else if (d.type === 'report') {
      out.push(commande({
        le: iso(d.le), type: 'report', titre: `Échéance repoussée au ${d.echeance ? jjmm(d.echeance) : '—'}`,
        detail: [d.imputable === 'malterre' ? 'De notre fait' : 'Du fait du sous-traitant', d.motif].filter(Boolean).join(' — '),
        par: d.par, auteur: qui(d.par),
      }))
    } else {
      out.push(commande({
        le: iso(d.le), type: 'delai_recu', titre: d.delai ? `Délai reçu : ${jjmm(d.delai)}/${d.delai.slice(0, 4)}` : 'Délai reçu',
        detail: d.ref?.trim() || null, par: d.par, auteur: qui(d.par),
      }))
    }
  }

  for (const p of points) {
    out.push(commande({ le: iso(p.le), type: 'point', titre: `Point du ${jjmm(p.jour)} envoyé`, detail: null, par: p.par, auteur: qui(p.par) }))
  }

  return out.sort((a, b) => b.le.localeCompare(a.le))
}
