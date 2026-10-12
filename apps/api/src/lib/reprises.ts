// Reprise of finished rolls at the dyer — recorded by ETM, never typed onto the
// lot (decision Vincent 2026-10-12, plan .dev-logs/BRIEF-reprise-lots.md).
//
// Until then the only trace of a reprise was an « R » added by hand to the lot
// (MA109102 → MA109102R; prod 2026-10-12: 96 lots since 2019, with -R, r,
// REPRIS, R2, R3, TER variants). It could not be automated: the dyer never
// prints the R, so Tricobot's reading of a reprise BL was scored as wrong, and
// the cycle had to guess from the text.
//
// Now:
//   - the lot keeps the dyer's number, always (writers refuse a reprise
//     suffix: refusLotSuffixe());
//   - « Reprendre » (Qualité › Suivi lots, whole lot) or « Envoyer en reprise »
//     (Sous-traitants › Réception, chosen rolls) OPENS a reprise: one `reprise`
//     row per (line, lot) episode, rank 1, 2…, with one `reprise_piece` per
//     roll, rolls in état 2, the lot in état 2, the lot's measures kept in
//     `lot_avant`;
//   - the reprise réception (PATCH of each roll back to état 1) records the
//     roll's new poids / métrage and CLOSES the reprise once no roll of it is
//     still at the dyer;
//   - correcting a reception typo is a different gesture (« Corriger la
//     réception »), never a reprise — on 2026-10-12 « Reprendre » was used two
//     minutes after a reception only to fix a mistyped lot.
// Everything else (lot step « En reprise », « repris ×N », soumission after the
// return, Tricobot's reprise BL) is read from these rows.
//
// Native PostgreSQL (lib/mps-pg.ts); each gesture commits in one transaction.

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'

export interface Auteur { id: number; nom: string }

// ── The old suffixes ─────────────────────────────────────

/** A reprise suffix typed after the dyer's digits: R / r / -R / R1…R9 /
 *  REPRIS / BIS / TER, optionally after a letter the dyer or a person used to
 *  tell two lots apart (« MA106117BR2 »). A lone letter (A/B/C) is NOT a
 *  reprise and is left alone (decision 2026-10-12). Pure. */
const SUFFIXE = /^(.*?\d{5,}[A-Za-z]?)\s*[-_ ]?\s*(REPRIS|BIS|TER|R(\d)?)$/i

export interface SuffixeReprise {
  /** The lot without the suffix, upper-cased (« ma100941r » → « MA100941 »). */
  base: string
  /** Which reprise of the lot it was: R / R1 / REPRIS = 1, R2 / BIS = 2, R3 / TER = 3. */
  rang: number
  /** Written « MA<digits>R » exactly — the variants are listed for review. */
  canonique: boolean
}

export function suffixeReprise(lot: string): SuffixeReprise | null {
  const t = (lot ?? '').trim()
  const m = SUFFIXE.exec(t)
  if (!m) return null
  const s = m[2].toUpperCase()
  const rang = s === 'TER' ? 3 : s === 'BIS' ? 2 : s === 'REPRIS' ? 1 : m[3] ? Number(m[3]) : 1
  if (rang < 1) return null
  return { base: m[1].trim().toUpperCase(), rang, canonique: /^MA\d{5,}R$/.test(t) }
}

/** The message refusing a lot typed WITH a reprise suffix, or null. A lot left
 *  as it already is passes (an old roll not yet cleaned by the history script). */
export function refusLotSuffixe(nouveau: string | null | undefined, actuel?: string | null): string | null {
  const n = (nouveau ?? '').trim()
  if (!n || n === (actuel ?? '').trim()) return null
  const s = suffixeReprise(n)
  if (!s) return null
  return `Le lot reste le numéro de l’ennoblisseur (${s.base}) : la reprise est enregistrée par ETM, sans « R » ajouté au lot.`
}

// ── Gestures ─────────────────────────────────────────────

export class RepriseRefusee extends Error {
  constructor(public code: string, message: string) { super(message) }
}

interface RouleauLigne { idstock_fini: number; lot: string; poids: number; metrage: number; etat: number; expedie: boolean }

async function rouleauxDeLigne(tx: Sql, ligneId: number, ids: number[] | null, lot: string | null): Promise<RouleauLigne[]> {
  const rows = ids
    ? await tx<{ idstock_fini: number; lot: string | null; poids: number; metrage: number; etat: number; le: number }[]>`
        SELECT idstock_fini, trim(lot::text) AS lot, poids, metrage, COALESCE(idetat_stock_fini, 0) AS etat, COALESCE(idligne_expedition, 0) AS le
        FROM stock_fini WHERE idstock_fini = ANY(${ids}) AND idref_commande_source = ${ligneId} FOR UPDATE`
    : await tx<{ idstock_fini: number; lot: string | null; poids: number; metrage: number; etat: number; le: number }[]>`
        SELECT idstock_fini, trim(lot::text) AS lot, poids, metrage, COALESCE(idetat_stock_fini, 0) AS etat, COALESCE(idligne_expedition, 0) AS le
        FROM stock_fini WHERE idref_commande_source = ${ligneId} AND trim(lot::text) = ${lot ?? ''} FOR UPDATE`
  return rows.map((r) => ({
    idstock_fini: Number(r.idstock_fini), lot: String(r.lot ?? ''), poids: Number(r.poids) || 0, metrage: Number(r.metrage) || 0,
    etat: Number(r.etat), expedie: Number(r.le) > 0 || Number(r.etat) === 4,
  }))
}

/** The lot's measures before the rework (the control is redone on return). */
async function mesuresLot(tx: Sql, ligneId: number, lot: string): Promise<Record<string, unknown> | null> {
  const [s] = await tx<Record<string, unknown>[]>`
    SELECT idsuivilot, idetatlot, laize_sst, poids_sst, rendement_sst, stabl_sst, stabh_sst,
           laize_tirelle, poids_tirelle, rendement_tirelle, stabl_tirelle, stabh_tirelle
    FROM suivilot WHERE idligne_commande_sous_traitant = ${ligneId} AND trim(lot::text) = ${lot}
    ORDER BY idsuivilot LIMIT 1`
  return s ?? null
}

async function rangSuivant(tx: Sql, ligneId: number, lot: string): Promise<number> {
  const [r] = await tx<{ m: number | null }[]>`
    SELECT max(rang) AS m FROM reprise WHERE idligne_commande_sous_traitant = ${ligneId} AND lot = ${lot}`
  return (Number(r?.m) || 0) + 1
}

export interface RepriseOuverte { id: number; lot: string; rang: number; rouleaux: number }

/** Send rolls back to the dyer: the whole lot (`rouleaux` null) or the chosen
 *  rolls of a line, grouped by lot. A lot already in reprise takes the new
 *  rolls into its open reprise. Shipped rolls are refused (a whole-lot
 *  reprise skips them). */
export async function ouvrirReprise(opts: {
  ligneId: number
  lot?: string | null
  rouleaux?: number[] | null
  motif: string
  par: Auteur
}): Promise<RepriseOuverte[]> {
  const motif = opts.motif.trim()
  if (!motif) throw new RepriseRefusee('motif_requis', 'Indiquez le motif de la reprise.')
  return mpsPg().begin(async (t) => {
    const tx = t as unknown as Sql
    const ids = opts.rouleaux?.length ? [...new Set(opts.rouleaux)] : null
    let rouleaux = await rouleauxDeLigne(tx, opts.ligneId, ids, ids ? null : (opts.lot ?? '').trim())
    if (ids) {
      if (rouleaux.length !== ids.length) throw new RepriseRefusee('rouleau_autre_ligne', 'Un rouleau choisi n’appartient pas à cette ligne.')
      const exp = rouleaux.filter((r) => r.expedie)
      if (exp.length) throw new RepriseRefusee('rouleau_expedie', 'Un rouleau expédié ne part pas en reprise.')
    } else {
      rouleaux = rouleaux.filter((r) => !r.expedie)
    }
    rouleaux = rouleaux.filter((r) => r.lot)
    if (rouleaux.length === 0) throw new RepriseRefusee('aucun_rouleau', 'Aucun rouleau à envoyer en reprise.')

    const parLot = new Map<string, RouleauLigne[]>()
    for (const r of rouleaux) parLot.set(r.lot, [...(parLot.get(r.lot) ?? []), r])
    const out: RepriseOuverte[] = []
    for (const [lot, rs] of parLot) {
      let [rep] = await tx<{ id: number; rang: number }[]>`
        SELECT id, rang FROM reprise WHERE idligne_commande_sous_traitant = ${opts.ligneId} AND lot = ${lot} AND statut = 'ouverte' FOR UPDATE`
      if (!rep) {
        const rang = await rangSuivant(tx, opts.ligneId, lot)
        const avant = await mesuresLot(tx, opts.ligneId, lot)
        ;[rep] = await tx<{ id: number; rang: number }[]>`
          INSERT INTO reprise (idligne_commande_sous_traitant, lot, rang, statut, origine, motif, envoye_le, envoye_par_id, envoye_par, lot_avant)
          VALUES (${opts.ligneId}, ${lot}, ${rang}, 'ouverte', 'geste', ${motif}, now(), ${opts.par.id}, ${opts.par.nom}, ${avant ? tx.json(avant as never) : null})
          RETURNING id, rang`
      }
      for (const r of rs) {
        await tx`
          INSERT INTO reprise_piece (idreprise, idstock_fini, poids_avant, metrage_avant)
          VALUES (${rep.id}, ${r.idstock_fini}, ${r.poids}, ${r.metrage})
          ON CONFLICT (idreprise, idstock_fini) DO NOTHING`
      }
      await tx`UPDATE stock_fini SET idetat_stock_fini = 2 WHERE idstock_fini = ANY(${rs.map((r) => r.idstock_fini)})`
      await tx`UPDATE suivilot SET idetatlot = 2 WHERE idligne_commande_sous_traitant = ${opts.ligneId} AND trim(lot::text) = ${lot}`
      out.push({ id: Number(rep.id), lot, rang: Number(rep.rang), rouleaux: rs.length })
    }
    return out
  }) as Promise<RepriseOuverte[]>
}

/** A roll back from the dyer (reprise réception, état 2 → 1): record its new
 *  measures, and close the reprise when no roll of it is still at the dyer.
 *  A roll in état 2 without an open reprise (put there before 2026-10-12)
 *  gets one, without a motif. Call AFTER the roll's UPDATE. */
export async function retourRouleau(opts: {
  idstockFini: number
  ligneId: number
  par: Auteur
}): Promise<{ idreprise: number; close: boolean } | null> {
  return mpsPg().begin(async (t) => {
    const tx = t as unknown as Sql
    const [roll] = await tx<{ lot: string | null; poids: number; metrage: number }[]>`
      SELECT trim(lot::text) AS lot, poids, metrage FROM stock_fini WHERE idstock_fini = ${opts.idstockFini}`
    if (!roll) return null
    let [p] = await tx<{ idreprise: number }[]>`
      SELECT rp.idreprise FROM reprise_piece rp JOIN reprise r ON r.id = rp.idreprise
      WHERE rp.idstock_fini = ${opts.idstockFini} AND r.statut = 'ouverte' AND rp.revenu_le IS NULL
      ORDER BY rp.idreprise DESC LIMIT 1 FOR UPDATE OF r`
    if (!p) {
      const lot = String(roll.lot ?? '')
      if (!lot) return null
      let [rep] = await tx<{ id: number }[]>`
        SELECT id FROM reprise WHERE idligne_commande_sous_traitant = ${opts.ligneId} AND lot = ${lot} AND statut = 'ouverte' FOR UPDATE`
      if (!rep) {
        const rang = await rangSuivant(tx, opts.ligneId, lot)
        ;[rep] = await tx<{ id: number }[]>`
          INSERT INTO reprise (idligne_commande_sous_traitant, lot, rang, statut, origine)
          VALUES (${opts.ligneId}, ${lot}, ${rang}, 'ouverte', 'geste') RETURNING id`
      }
      await tx`
        INSERT INTO reprise_piece (idreprise, idstock_fini) VALUES (${rep.id}, ${opts.idstockFini})
        ON CONFLICT (idreprise, idstock_fini) DO NOTHING`
      p = { idreprise: rep.id }
    }
    await tx`
      UPDATE reprise_piece SET poids_apres = ${Number(roll.poids) || 0}, metrage_apres = ${Number(roll.metrage) || 0}, revenu_le = now()
      WHERE idreprise = ${p.idreprise} AND idstock_fini = ${opts.idstockFini}`
    // Still at the dyer: a piece not back whose roll is still in état 2.
    const [reste] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM reprise_piece rp JOIN stock_fini sf ON sf.idstock_fini = rp.idstock_fini
      WHERE rp.idreprise = ${p.idreprise} AND rp.revenu_le IS NULL AND sf.idetat_stock_fini = 2`
    const close = Number(reste?.n) === 0
    if (close) {
      await tx`
        UPDATE reprise SET statut = 'close', retour_le = now(), retour_par_id = ${opts.par.id}, retour_par = ${opts.par.nom}
        WHERE id = ${p.idreprise}`
    }
    return { idreprise: Number(p.idreprise), close }
  }) as Promise<{ idreprise: number; close: boolean } | null>
}

// ── Reads ────────────────────────────────────────────────

/** Per roll: how many reprises it went through, and whether one is open. */
export async function reprisesParRouleau(ids: number[]): Promise<Map<number, { nombre: number; ouverte: boolean }>> {
  const out = new Map<number, { nombre: number; ouverte: boolean }>()
  const uniques = [...new Set(ids.filter((x) => x > 0))]
  if (uniques.length === 0) return out
  const rows = await mpsPg()<{ id: number; nombre: number; ouverte: boolean }[]>`
    SELECT rp.idstock_fini AS id, count(*)::int AS nombre, bool_or(r.statut = 'ouverte') AS ouverte
    FROM reprise_piece rp JOIN reprise r ON r.id = rp.idreprise
    WHERE rp.idstock_fini = ANY(${uniques}) GROUP BY rp.idstock_fini`
  for (const r of rows) out.set(Number(r.id), { nombre: Number(r.nombre), ouverte: !!r.ouverte })
  return out
}

export interface RepriseLot {
  id: number
  rang: number
  statut: 'ouverte' | 'close'
  origine: 'geste' | 'historique'
  motif: string | null
  envoye_le: string | null
  envoye_par: string | null
  retour_le: string | null
  retour_par: string | null
  /** The suffixed lot text a historical reprise replaced (« MA109102R »). */
  lot_saisi: string | null
  rouleaux: number
}

/** The reprises of a lot on its line, oldest first. */
export async function reprisesDuLot(ligneId: number, lot: string): Promise<RepriseLot[]> {
  const rows = await mpsPg()<(Omit<RepriseLot, 'rouleaux'> & { rouleaux: number })[]>`
    SELECT r.id, r.rang, r.statut, r.origine, r.motif,
           to_char(r.envoye_le AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD"T"HH24:MI') AS envoye_le, r.envoye_par,
           to_char(r.retour_le AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD"T"HH24:MI') AS retour_le, r.retour_par,
           r.lot_saisi, (SELECT count(*)::int FROM reprise_piece rp WHERE rp.idreprise = r.id) AS rouleaux
    FROM reprise r WHERE r.idligne_commande_sous_traitant = ${ligneId} AND r.lot = ${lot.trim()}
    ORDER BY r.rang`
  return rows.map((r) => ({ ...r, id: Number(r.id), rang: Number(r.rang), rouleaux: Number(r.rouleaux) }))
}

export interface FaitReprisesLot {
  nombre: number
  ouverte: boolean
  /** Day the latest reprise came back. 'YYYY-MM-DD' (null: none, or historical). */
  dernierRetour: string | null
}

/** Per `${ligne}:${lot}`: the reprise facts the Ennoblissement cycle reads. */
export async function faitsReprises(ligneIds: number[]): Promise<Map<string, FaitReprisesLot>> {
  const out = new Map<string, FaitReprisesLot>()
  const uniques = [...new Set(ligneIds.filter((x) => x > 0))]
  if (uniques.length === 0) return out
  const rows = await mpsPg()<{ ligne: number; lot: string; nombre: number; ouverte: boolean; retour: string | null }[]>`
    SELECT idligne_commande_sous_traitant AS ligne, lot, count(*)::int AS nombre, bool_or(statut = 'ouverte') AS ouverte,
           to_char(max(retour_le) AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS retour
    FROM reprise WHERE idligne_commande_sous_traitant = ANY(${uniques}) GROUP BY 1, 2`
  for (const r of rows) out.set(`${Number(r.ligne)}:${r.lot}`, { nombre: Number(r.nombre), ouverte: !!r.ouverte, dernierRetour: r.retour })
  return out
}

/** The lot as a client reads it on a soumission: « MA109102 (reprise) » once it
 *  came back from a reprise — the number itself never changes (decision
 *  2026-10-12; 80 soumissions since 2024 named an « R » lot to the client). */
export async function libelleLotClient(commandeId: number, lot: string): Promise<string> {
  const l = (lot ?? '').trim()
  if (!l || !(commandeId > 0)) return l
  try {
    const [r] = await mpsPg()<{ n: number }[]>`
      SELECT count(*)::int AS n FROM reprise r
      JOIN ligne_commande_sous_traitant lc ON lc.idligne_commande_sous_traitant = r.idligne_commande_sous_traitant
      WHERE lc.idcommande_sous_traitant = ${commandeId} AND r.lot = ${l}`
    return Number(r?.n) > 0 ? `${l} (reprise)` : l
  } catch {
    return l
  }
}
