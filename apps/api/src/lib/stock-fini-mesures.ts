// Correcting the poids / métrage of a finished roll (LIVA #1245, Nico's
// inventory of dead stock, 2026-09-30).
//
// These two figures come from the dyer's BL at reception and were never
// editable: a roll fresh out of MATEL must keep matching MATEL's paper. An
// OLD roll, re-measured during inventory, may be corrected — decision
// Vincent 2026-09-30:
//   - a dedicated sub-right (edit_stock_fini_mesures, not cascaded from
//     « Éditer un rouleau »),
//   - only on a roll still in stock (not shipped, not donated),
//   - only once received MESURES_AGE_MIN_JOURS days ago,
//   - every change journaled (who, when, before → after) in
//     `stock_fini_mesure_journal`, shown on the roll.
// MATEL invoices on the écru weight, never on the fini, so a correction here
// cannot move what we owe the dyer — it only departs from their paper BL.
//
// Native PostgreSQL (lib/mps-pg.ts): the UPDATE and its journal row commit in
// ONE transaction, so a correction is never written without its trace.

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'
import { parseDtMs } from './production-trm.js'
import { metrageCompatible } from './ml-non-factures.js'

export const MESURES_AGE_MIN_JOURS = 60

export type RefusMesures = 'expedie' | 'donne' | 'trop_recent' | 'date_inconnue' | 'sous_non_factures'

export type MesuresModifiables =
  | { ok: true }
  | { ok: false; raison: RefusMesures; message: string; disponible_le?: string }

export interface EtatRouleau {
  date_saisie: unknown
  idetat_stock_fini: number
  idligne_expedition: number
  idcommande_donation: number
}

/** A date column as it may come back: a Date (native driver) or the
 *  HFSQL-shaped text ('YYYYMMDD', 'YYYY-MM-DD…'). */
function dateMs(v: unknown): number | null {
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null
  return parseDtMs(v)
}

function isoJour(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Whether the poids / métrage of this roll may be corrected now. Pure. */
export function mesuresModifiables(r: EtatRouleau, now: number = Date.now()): MesuresModifiables {
  // "Shipped" is two facts (CLAUDE.md): either one refuses.
  if (r.idligne_expedition > 0 || r.idetat_stock_fini === 4) {
    return { ok: false, raison: 'expedie', message: 'Rouleau expédié : son poids et son métrage sont ceux du bon de livraison.' }
  }
  if (r.idcommande_donation > 0) {
    return { ok: false, raison: 'donne', message: 'Rouleau donné : il est sorti du stock.' }
  }
  const recu = dateMs(r.date_saisie)
  if (recu === null) {
    return { ok: false, raison: 'date_inconnue', message: 'Date de réception inconnue : impossible de vérifier l’ancienneté du rouleau.' }
  }
  // Calendar days from the reception day, so a DST change in between does
  // not shift the opening by an hour — and so a day earlier.
  const jourRecu = new Date(recu)
  const disponible = new Date(jourRecu.getFullYear(), jourRecu.getMonth(), jourRecu.getDate() + MESURES_AGE_MIN_JOURS).getTime()
  if (now < disponible) {
    const jour = isoJour(disponible)
    const [y, m, d] = jour.split('-')
    return {
      ok: false,
      raison: 'trop_recent',
      message: `Reçu il y a moins de ${MESURES_AGE_MIN_JOURS} jours : poids et métrage restent ceux du BL de l’ennoblisseur jusqu’au ${d}/${m}/${y}.`,
      disponible_le: jour,
    }
  }
  return { ok: true }
}

export interface JournalMesure {
  id: number
  le: string
  auteur: string
  poids_avant: number
  poids_apres: number
  metrage_avant: number
  metrage_apres: number
}

const r2 = (n: number) => Math.round(n * 100) / 100

export class MesuresRefusees extends Error {
  constructor(public verdict: Extract<MesuresModifiables, { ok: false }>) {
    super(verdict.message)
  }
}
export class RouleauIntrouvable extends Error {}

/** Read the roll's state + journal, for the drawer. */
export async function lireMesures(id: number): Promise<{ modifiable: MesuresModifiables; journal: JournalMesure[] } | null> {
  const s = mpsPg()
  const rows = await s<EtatRouleau[]>`
    SELECT date_saisie, idetat_stock_fini, idligne_expedition, idcommande_donation
    FROM stock_fini WHERE idstock_fini = ${id}`
  if (rows.length === 0) return null
  const journal = await s<JournalMesure[]>`
    SELECT id, le, auteur, poids_avant, poids_apres, metrage_avant, metrage_apres
    FROM stock_fini_mesure_journal WHERE idstock_fini = ${id} ORDER BY le DESC, id DESC`
  return {
    modifiable: mesuresModifiables(normalise(rows[0])),
    journal: journal.map((j) => ({
      ...j,
      le: new Date(j.le).toISOString(),
      poids_avant: Number(j.poids_avant),
      poids_apres: Number(j.poids_apres),
      metrage_avant: Number(j.metrage_avant),
      metrage_apres: Number(j.metrage_apres),
    })),
  }
}

function normalise(r: EtatRouleau): EtatRouleau {
  return {
    date_saisie: r.date_saisie,
    idetat_stock_fini: Number(r.idetat_stock_fini) || 0,
    idligne_expedition: Number(r.idligne_expedition) || 0,
    idcommande_donation: Number(r.idcommande_donation) || 0,
  }
}

/** Write the new poids / métrage and its journal row in one transaction.
 *  A field left undefined keeps its value. Returns false when nothing
 *  changed (no journal row either). Throws MesuresRefusees / RouleauIntrouvable. */
export async function ecrireMesures(
  id: number,
  valeurs: { poids?: number; metrage?: number },
  auteur: { idutilisateur: number; nom: string },
): Promise<boolean> {
  return mpsPg().begin(async (t) => {
    const tx = t as unknown as Sql // postgres.js typing: TransactionSql loses its call signatures
    const rows = await tx<(EtatRouleau & { poids: number; metrage: number; ml_non_factures: number })[]>`
      SELECT date_saisie, idetat_stock_fini, idligne_expedition, idcommande_donation, poids, metrage, ml_non_factures
      FROM stock_fini WHERE idstock_fini = ${id} FOR UPDATE`
    if (rows.length === 0) throw new RouleauIntrouvable()
    const verdict = mesuresModifiables(normalise(rows[0]))
    if (!verdict.ok) throw new MesuresRefusees(verdict)

    const poidsAvant = r2(Number(rows[0].poids) || 0)
    const metrageAvant = r2(Number(rows[0].metrage) || 0)
    const poidsApres = valeurs.poids === undefined ? poidsAvant : r2(valeurs.poids)
    const metrageApres = valeurs.metrage === undefined ? metrageAvant : r2(valeurs.metrage)
    if (poidsApres === poidsAvant && metrageApres === metrageAvant) return false
    // A roll carrying « Ml non facturés » (lib/ml-non-factures.ts) may not
    // shrink below them: the invoice would bill a negative part.
    const mlNf = Number(rows[0].ml_non_factures) || 0
    if (!metrageCompatible(metrageApres, mlNf)) {
      throw new MesuresRefusees({
        ok: false,
        raison: 'sous_non_factures',
        message: `Ce rouleau porte ${mlNf} Ml non facturés : son métrage ne peut pas descendre en dessous. Corrigez d’abord les Ml non facturés.`,
      })
    }

    await tx`UPDATE stock_fini SET poids = ${poidsApres}, metrage = ${metrageApres} WHERE idstock_fini = ${id}`
    await tx`
      INSERT INTO stock_fini_mesure_journal
        (idstock_fini, idutilisateur, auteur, poids_avant, poids_apres, metrage_avant, metrage_apres)
      VALUES (${id}, ${auteur.idutilisateur}, ${auteur.nom}, ${poidsAvant}, ${poidsApres}, ${metrageAvant}, ${metrageApres})`
    return true
  }) as Promise<boolean>
}

/** « Prénom Nom » of the acting user, frozen into the journal row so the
 *  trace survives a renamed or merged account. */
export async function nomUtilisateur(idutilisateur: number): Promise<string> {
  const rows = await mpsPg()<{ prenom: string | null; nom: string | null }[]>`
    SELECT prenom, nom FROM utilisateur WHERE idutilisateur = ${idutilisateur}`
  const n = rows[0] ? `${rows[0].prenom ?? ''} ${rows[0].nom ?? ''}`.trim() : ''
  return n || `Utilisateur ${idutilisateur}`
}

// ── Net length of a labelled roll (LIVA #1246) ─────────────────────────────
//
// Simone Pérèle is billed the NET length MATEL writes on the tableau de
// métrage (lib/etiquettes-sp.ts `netAAppliquer`), and every shipping document
// sums `stock_fini.metrage`. So the net, once the roll's measures are complete,
// replaces the BL's gross length on the roll — journaled like a correction.
// The gross length stays in the label data. None of the #1245 rules apply
// (a fresh roll is exactly the case), but:
//   - a roll whose shipment is on an invoice (provisional or definitive) is
//     left alone: the invoice froze its quantity, a change would only make
//     the BL disagree with it;
//   - a donated roll is out of stock.

export type NetEtiquette = 'applique' | 'inchange' | 'facture' | 'donne' | 'introuvable' | 'sous_non_factures'

export async function appliquerNetEtiquette(
  id: number,
  net: number,
  auteur: { idutilisateur: number; nom: string },
): Promise<NetEtiquette> {
  return mpsPg().begin(async (t) => {
    const tx = t as unknown as Sql
    const rows = await tx<{ poids: number; metrage: number; idligne_expedition: number; idcommande_donation: number; ml_non_factures: number }[]>`
      SELECT poids, metrage, idligne_expedition, idcommande_donation, ml_non_factures
      FROM stock_fini WHERE idstock_fini = ${id} FOR UPDATE`
    if (rows.length === 0) return 'introuvable'
    const r = rows[0]
    if ((Number(r.idcommande_donation) || 0) > 0) return 'donne'
    const le = Number(r.idligne_expedition) || 0
    if (le > 0) {
      const [def, prov] = await Promise.all([
        tx`SELECT 1 FROM ligne_facture WHERE idligne_expedition = ${le} LIMIT 1`,
        tx`SELECT 1 FROM ligne_facture_prov WHERE idligne_expedition = ${le} LIMIT 1`,
      ])
      if (def.length > 0 || prov.length > 0) return 'facture'
    }
    const avant = r2(Number(r.metrage) || 0)
    const apres = r2(net)
    if (avant === apres) return 'inchange'
    // Never below the roll's « Ml non facturés » (lib/ml-non-factures.ts):
    // left at the gross length and reported, rather than billing a negative part.
    if (!metrageCompatible(apres, Number(r.ml_non_factures) || 0)) return 'sous_non_factures'
    const poids = r2(Number(r.poids) || 0)
    await tx`UPDATE stock_fini SET metrage = ${apres} WHERE idstock_fini = ${id}`
    await tx`
      INSERT INTO stock_fini_mesure_journal
        (idstock_fini, idutilisateur, auteur, poids_avant, poids_apres, metrage_avant, metrage_apres)
      VALUES (${id}, ${auteur.idutilisateur}, ${`${auteur.nom} · net MATEL (étiquettes)`}, ${poids}, ${poids}, ${avant}, ${apres})`
    return 'applique'
  }) as Promise<NetEtiquette>
}
