// « Ml non facturés » on a finished roll (decision Vincent 2026-10-06).
//
// A roll may carry a stretch the client will not pay for (« Taches bleues sur
// les 10 premiers mètres »). Before this, the only way to get the right
// invoice was to lie about the roll: lower its métrage (3560/70: 38 → 28,
// and Tricobot scored an unfair échec), cut a fictive piece (3296/78-1), or
// move it to a sample client. Now:
//   - `stock_fini.metrage` stays the physical truth (stock, BL, gauges);
//   - `stock_fini.ml_non_factures` + `ml_non_factures_motif` hold the gesture;
//   - the client invoice bills metrage − ml_non_factures (quantiteFacturee) and
//     prints « dont 10 Ml non facturés — pièce 3560/70 : taches » under the
//     line (mentionNonFactures), frozen in the line's designation;
//   - a line sold by the Kg deducts the same share of the roll's weight
//     (poids × nf / metrage);
//   - one right, `edit_ml_non_factures` (closed by default, a commercial
//     gesture — not edit_stock_fini_mesures, which corrects a measurement);
//   - refused once the roll is on an invoice, provisional or definitive
//     (after that it is an avoir), and on a donated roll;
//   - every change journaled in `stock_fini_ml_non_facture_journal`.
// Kept generic on purpose: the coming « demande d'avoir à l'ennoblisseur »
// will read the same field.
//
// Native PostgreSQL (lib/mps-pg.ts): the UPDATE and its journal row commit in
// ONE transaction.

import type { Sql } from 'postgres'
import { mpsPg } from './mps-pg.js'

const r2 = (n: number) => Math.round(n * 100) / 100

// ── Pure rules ──────────────────────────────────────────────────────────────

export type RefusMlNonFactures = 'facture' | 'donne'

export type MlNonFacturesModifiable =
  | { ok: true }
  | { ok: false; raison: RefusMlNonFactures; message: string }

export interface EtatMlNonFactures {
  /** The roll's shipment line is on an invoice (provisional or definitive). */
  facture: boolean
  idcommande_donation: number
}

/** Whether the « Ml non facturés » of this roll may change now. Pure. */
export function mlNonFacturesModifiable(e: EtatMlNonFactures): MlNonFacturesModifiable {
  if (e.facture) {
    return { ok: false, raison: 'facture', message: 'Rouleau déjà facturé : la quantité est figée sur la facture, passez par un avoir.' }
  }
  if (e.idcommande_donation > 0) {
    return { ok: false, raison: 'donne', message: 'Rouleau donné : il n’est pas facturé.' }
  }
  return { ok: true }
}

export type SaisieMlNonFactures =
  | { ok: true; ml: number; motif: string | null }
  | { ok: false; message: string }

/** Validate a typed value against the roll's physical length. A zero clears
 *  the motif; a positive value needs one. Pure. */
export function validerSaisie(ml: unknown, motif: unknown, metrage: number): SaisieMlNonFactures {
  const v = typeof ml === 'string' ? Number(ml.replace(',', '.')) : Number(ml)
  if (ml === null || ml === '' || !Number.isFinite(v) || v < 0) {
    return { ok: false, message: 'Les Ml non facturés doivent être un nombre positif ou nul.' }
  }
  const val = r2(v)
  if (val > r2(metrage)) {
    return { ok: false, message: `Les Ml non facturés (${fmt(val)}) dépassent le métrage du rouleau (${fmt(metrage)} Ml).` }
  }
  if (val === 0) return { ok: true, ml: 0, motif: null }
  const m = typeof motif === 'string' ? motif.trim() : ''
  if (!m) return { ok: false, message: 'Indiquez le motif des Ml non facturés (ex. « taches »).' }
  return { ok: true, ml: val, motif: m }
}

export interface RouleauFacturable {
  numero?: string | null
  poids: number | null
  metrage: number | null
  ml_non_factures?: number | null
  ml_non_factures_motif?: string | null
}

/** The part of one roll that is billed, in the line's dimension. A Kg line
 *  deducts the same share of the weight as of the length. Pure. */
export function partFacturee(r: RouleauFacturable, dim: 'metrage' | 'poids'): number {
  const metrage = Number(r.metrage) || 0
  const poids = Number(r.poids) || 0
  const nf = Math.min(Math.max(Number(r.ml_non_factures) || 0, 0), metrage)
  if (dim === 'metrage') return metrage - nf
  if (nf === 0 || metrage <= 0) return poids
  return poids - kgNonFactures(poids, metrage, nf)
}

function kgNonFactures(poids: number, metrage: number, nf: number): number {
  return metrage > 0 ? r2((poids * nf) / metrage) : 0
}

/** Quantity billed for a shipment line: Σ of the rolls' billed parts, rounded
 *  to the hundredth like the legacy sum. Pure. */
export function quantiteFacturee(rouleaux: RouleauFacturable[], dim: 'metrage' | 'poids'): number {
  return r2(rouleaux.reduce((s, r) => s + partFacturee(r, dim), 0))
}

/** French number, no trailing zeros: 10 → « 10 », 7.5 → « 7,5 ». */
function fmt(n: number): string {
  return r2(n).toLocaleString('fr-FR', { maximumFractionDigits: 2, useGrouping: false })
}

/** Lines printed under the invoice line, one per roll with a non-billed
 *  stretch — « dont 10 Ml non facturés — pièce 3560/70 : taches » (Kg line:
 *  « dont 10 Ml (≈ 7,37 Kg) non facturés — … »). Empty when none. Pure. */
export function mentionNonFactures(rouleaux: RouleauFacturable[], dim: 'metrage' | 'poids'): string[] {
  const out: string[] = []
  for (const r of rouleaux) {
    const metrage = Number(r.metrage) || 0
    const nf = Math.min(Math.max(Number(r.ml_non_factures) || 0, 0), metrage)
    if (nf <= 0) continue
    const kg = dim === 'poids' ? ` (≈ ${fmt(kgNonFactures(Number(r.poids) || 0, metrage, nf))} Kg)` : ''
    const piece = (r.numero ?? '').toString().trim()
    const motif = (r.ml_non_factures_motif ?? '').toString().trim()
    let s = `dont ${fmt(nf)} Ml${kg} non facturés`
    if (piece) s += ` — pièce ${piece}`
    if (motif) s += `${piece ? ' : ' : ' — '}${motif}`
    out.push(s)
  }
  return out
}

/** A new physical length (cut remainder, #1245 correction, SP net) must stay
 *  ≥ the roll's non-billed Ml, or the invoice would bill a negative part. */
export function metrageCompatible(nouveauMetrage: number, mlNonFactures: number): boolean {
  return r2(nouveauMetrage) >= r2(Number(mlNonFactures) || 0)
}

// ── Database ────────────────────────────────────────────────────────────────

export interface JournalMlNonFactures {
  id: number
  le: string
  auteur: string
  ml_avant: number
  ml_apres: number
  motif_avant: string | null
  motif_apres: string | null
  origine: string
}

export class MlNonFacturesRefuse extends Error {
  constructor(public raison: RefusMlNonFactures | 'saisie', message: string) {
    super(message)
  }
}
export class RouleauIntrouvable extends Error {}

/** Whether a shipment line is invoiced: on an invoice line, provisional or
 *  definitive, OR its avis flagged `est_facture = 1` — 216 legacy avis carry
 *  the flag with no invoice line pointing at them (dev copy, 2026-10-06), and
 *  the generation itself only ever reads the flag. */
async function estFacture(tx: Sql, idligneExpedition: number): Promise<boolean> {
  if (!(idligneExpedition > 0)) return false
  const [def, prov, avis] = await Promise.all([
    tx`SELECT 1 FROM ligne_facture WHERE idligne_expedition = ${idligneExpedition} LIMIT 1`,
    tx`SELECT 1 FROM ligne_facture_prov WHERE idligne_expedition = ${idligneExpedition} LIMIT 1`,
    tx`SELECT 1 FROM ligne_expedition le JOIN expedition e ON e.idexpedition = le.idexpedition
       WHERE le.idligne_expedition = ${idligneExpedition} AND e.est_facture = 1 LIMIT 1`,
  ])
  return def.length > 0 || prov.length > 0 || avis.length > 0
}

/** Current value, whether it may change, and the journal (newest first). */
export async function lireMlNonFactures(id: number): Promise<{
  ml_non_factures: number
  motif: string | null
  modifiable: MlNonFacturesModifiable
  journal: JournalMlNonFactures[]
} | null> {
  const s = mpsPg()
  const rows = await s<{ ml_non_factures: number; ml_non_factures_motif: string | null; idligne_expedition: number; idcommande_donation: number }[]>`
    SELECT ml_non_factures, ml_non_factures_motif, idligne_expedition, idcommande_donation
    FROM stock_fini WHERE idstock_fini = ${id}`
  if (rows.length === 0) return null
  const r = rows[0]
  const [facture, journal] = await Promise.all([
    estFacture(s, Number(r.idligne_expedition) || 0),
    s<JournalMlNonFactures[]>`
      SELECT id, le, auteur, ml_avant, ml_apres, motif_avant, motif_apres, origine
      FROM stock_fini_ml_non_facture_journal WHERE idstock_fini = ${id} ORDER BY le DESC, id DESC`,
  ])
  return {
    ml_non_factures: Number(r.ml_non_factures) || 0,
    motif: r.ml_non_factures_motif ?? null,
    modifiable: mlNonFacturesModifiable({ facture, idcommande_donation: Number(r.idcommande_donation) || 0 }),
    journal: journal.map((j) => ({
      ...j,
      id: Number(j.id),
      le: new Date(j.le).toISOString(),
      ml_avant: Number(j.ml_avant),
      ml_apres: Number(j.ml_apres),
    })),
  }
}

/** Write the value + its journal row in one transaction. Returns false when
 *  nothing changed (no journal row either). Throws MlNonFacturesRefuse /
 *  RouleauIntrouvable. `origine` says which screen wrote it. */
export async function ecrireMlNonFactures(
  id: number,
  saisie: { ml: unknown; motif: unknown },
  auteur: { idutilisateur: number; nom: string },
  origine: 'reception' | 'rouleau' | 'commande' = 'rouleau',
): Promise<boolean> {
  return mpsPg().begin(async (t) => {
    const tx = t as unknown as Sql // postgres.js typing: TransactionSql loses its call signatures
    const rows = await tx<{ metrage: number; ml_non_factures: number; ml_non_factures_motif: string | null; idligne_expedition: number; idcommande_donation: number }[]>`
      SELECT metrage, ml_non_factures, ml_non_factures_motif, idligne_expedition, idcommande_donation
      FROM stock_fini WHERE idstock_fini = ${id} FOR UPDATE`
    if (rows.length === 0) throw new RouleauIntrouvable()
    const r = rows[0]
    const verdict = mlNonFacturesModifiable({
      facture: await estFacture(tx, Number(r.idligne_expedition) || 0),
      idcommande_donation: Number(r.idcommande_donation) || 0,
    })
    if (!verdict.ok) throw new MlNonFacturesRefuse(verdict.raison, verdict.message)
    const v = validerSaisie(saisie.ml, saisie.motif, Number(r.metrage) || 0)
    if (!v.ok) throw new MlNonFacturesRefuse('saisie', v.message)

    const mlAvant = r2(Number(r.ml_non_factures) || 0)
    const motifAvant = r.ml_non_factures_motif ?? null
    if (v.ml === mlAvant && (v.motif ?? null) === (motifAvant || null)) return false

    await tx`UPDATE stock_fini SET ml_non_factures = ${v.ml}, ml_non_factures_motif = ${v.motif} WHERE idstock_fini = ${id}`
    await tx`
      INSERT INTO stock_fini_ml_non_facture_journal
        (idstock_fini, idutilisateur, auteur, ml_avant, ml_apres, motif_avant, motif_apres, origine)
      VALUES (${id}, ${auteur.idutilisateur}, ${auteur.nom}, ${mlAvant}, ${v.ml}, ${motifAvant}, ${v.motif}, ${origine})`
    return true
  }) as Promise<boolean>
}

/** The rolls' non-billed Ml, for refusing a length change below it. */
export async function mlNonFacturesDe(id: number): Promise<number> {
  const rows = await mpsPg()<{ ml_non_factures: number }[]>`
    SELECT ml_non_factures FROM stock_fini WHERE idstock_fini = ${id}`
  return Number(rows[0]?.ml_non_factures) || 0
}
