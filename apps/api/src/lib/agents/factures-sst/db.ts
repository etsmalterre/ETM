// Agent « Factures Ennoblisseur » — the database half: what ETM knows about each
// lot of an invoice (order, pieces, weight, expected price), and the writes:
//   - the invoice ONCE in `facture_sst` (with its PDF) and one
//     `ligne_facture_sst` row per printed line, each lot line pointing at the
//     sst order line it bills (migration 0008, lib/mps-schema.ts);
//   - the invoice number on those order lines (`ligne_commande_sous_traitant.
//     num_facture`, what Pierre-Emmanuel typed in the legacy Suivi lots — kept
//     so the 2 950 lines he pointed and the new ones read the same), only
//     where it is empty and only when the reading passed its checks.
//
// Native PostgreSQL (lib/mps-pg.ts): written after the cutover.

import type { Sql } from 'postgres'
import { mpsPg } from '../../mps-pg.js'
import { noter, resumeRecue } from './historique.js'
import { calcTarifSSTBreakdown, SIMPLE_TEINTURE_IDTEINTURE, type PrixBreakdown } from '../../pricing-sst.js'
import type { FactureLue, Fournisseur } from './extraction.js'
import type { FactureVerifiee, LotEtm } from './controle.js'

const fr = (n: number) => n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** « Teinture 4,82 × 1,03 + Préfixage 0,58 » — how ETM's price is made. */
async function expliquer(bd: PrixBreakdown, sql: Sql): Promise<string> {
  const ids = [...bd.treatments.map((t) => t.IDtraitement), ...(bd.base?.kind === 'combination' ? bd.base.covered : [])]
  const noms = new Map<number, string>()
  if (ids.length) {
    const rows = await sql<{ idtraitement: number; designation: string | null }[]>`
      SELECT idtraitement, designation FROM traitement WHERE idtraitement = ANY(${ids})`
    for (const r of rows) noms.set(Number(r.idtraitement), String(r.designation ?? '').trim())
  }
  const nom = (id: number) => noms.get(id) || `traitement ${id}`
  const parts: string[] = []
  if (bd.base?.kind === 'dye-only') {
    parts.push(`${bd.base.IDteinture === SIMPLE_TEINTURE_IDTEINTURE ? 'simple teinture (écru)' : 'teinture'} ${fr(bd.base.raw_prix)}${bd.base.applied_prix !== bd.base.raw_prix ? ` × ${fr(bd.matel_multiplier)} (rendement ${fr(bd.rendement)})` : ''}`)
  } else if (bd.base?.kind === 'combination') {
    parts.push(`${bd.base.covered.map(nom).join(' + ')} ${fr(bd.base.raw_prix)}`)
  }
  for (const t of bd.treatments) {
    if (!(t.applied_prix > 0)) continue
    parts.push(`${nom(t.IDtraitement)} ${fr(t.raw_prix)}${t.matel_applied ? ` × ${fr(bd.matel_multiplier)}` : ''}`)
  }
  if (bd.unpriced_treatments.length) parts.push(`sans tarif : ${bd.unpriced_treatments.map(nom).join(', ')}`)
  return `${parts.join(' + ')}, tranche ${fr(bd.xPoids)} kg`
}

/** Why a computed price misses part of the tariff, null when complete. */
export function incomplet(bd: PrixBreakdown): string | null {
  const raisons: string[] = []
  if (bd.avec_teinture !== 0 && !bd.base) raisons.push(bd.IDteinture ? 'pas de prix de teinture pour ce coloris' : 'coloris sans teinture renseignée')
  if (bd.unpriced_treatments.length) raisons.push(`${bd.unpriced_treatments.length} traitement${bd.unpriced_treatments.length > 1 ? 's' : ''} sans tarif`)
  return raisons.length ? raisons.join(', ') : null
}

/** The ETM lot code a typed lot stands for: the dyer prefix and its number,
 *  whatever was typed around them — « MA 108060 », « MA108060C »,
 *  « MA107971 - SURTEINTU » (Suivi lots, 2026-10-02) all mean MA108060 /
 *  MA107971. '' when it is no such lot. */
export function codeLot(typed: string | null | undefined): string {
  const m = /^([A-Z]+)(\d+)/.exec(String(typed ?? '').toUpperCase().replace(/\s+/g, ''))
  return m ? `${m[1]}${m[2]}` : ''
}

/** ILIKE patterns that catch every spelling codeLot() folds (filtered in JS). */
const motifs = (codes: readonly string[]) =>
  codes.flatMap((c) => {
    const m = /^([A-Z]+)(\d+)$/.exec(c)
    return m ? [`${m[1]}${m[2]}%`, `${m[1]} ${m[2]}%`] : [`${c}%`]
  })

/**
 * ETM's view of each lot code of the invoice. A lot is found in Suivi lots,
 * else through the received rolls, else through the dyer's BL (BL
 * Ennoblisseur's data_bl_tricotbot) — a lot nobody opened in Suivi lots.
 *
 * Its pieces are the ÉCRU pieces sent in it: the components of every received
 * roll carrying the lot (a merged roll counts all of them — MA108968: 11 rolls
 * of 17 pieces, 17 billed) plus the écru still at the dyer carrying it. Its
 * weight: the received rolls' weight plus the écru still out — MATEL bills
 * what it was sent (108409 = 351,4 received + 19,7 out, as billed).
 *
 * The weight band of the expected price is the LOT's: a lot is never cheaper
 * than at its own weight, so this is the highest legitimate price — MATEL
 * sometimes bands a small lot with its order line, sometimes not (FA2828 vs
 * FA2960), and the generous reading keeps that from making false gaps.
 *
 * @param factureKg  billed Kg per lot — the weight band when ETM has no piece.
 */
export async function lotsEtm(f: FactureLue, fournisseur: Fournisseur, factureKg: ReadonlyMap<string, number>): Promise<Map<string, LotEtm | null>> {
  const sql = mpsPg()
  const codes = [...new Set(f.lignes.filter((l) => l.genre === 'lot').map((l) => fournisseur.lotEtm(l.lot)).filter(Boolean))]
  const out = new Map<string, LotEtm | null>(codes.map((c) => [c, null]))
  if (!codes.length) return out
  const voulus = new Set(codes)
  const codeDe = (lot: string | null) => {
    const c = codeLot(lot)
    return voulus.has(c) ? c : null
  }
  const pats = motifs(codes)

  // Which order line each lot is on.
  const parLot = new Map<string, { idsuivilot: number; idligne: number }>()
  const suivis = await sql<{ lot: string; idsuivilot: number; idligne: number }[]>`
    SELECT lot::text AS lot, idsuivilot, idligne_commande_sous_traitant AS idligne
    FROM suivilot WHERE lot::text ILIKE ANY(${pats}) ORDER BY idsuivilot DESC`
  for (const s of suivis) {
    const code = codeDe(s.lot)
    if (code && !parLot.has(code) && Number(s.idligne) > 0) parLot.set(code, { idsuivilot: Number(s.idsuivilot), idligne: Number(s.idligne) })
  }
  const sansSuivi = () => motifs(codes.filter((c) => !parLot.has(c)))
  if (codes.some((c) => !parLot.has(c))) {
    for (const r of await sql<{ lot: string; idligne: number }[]>`
      SELECT DISTINCT lot::text AS lot, idref_commande_source AS idligne
      FROM stock_fini WHERE lot::text ILIKE ANY(${sansSuivi()}) AND idref_commande_source > 0`) {
      const code = codeDe(r.lot)
      if (code && !parLot.has(code)) parLot.set(code, { idsuivilot: 0, idligne: Number(r.idligne) })
    }
  }
  if (codes.some((c) => !parLot.has(c))) {
    for (const r of await sql<{ lot: string; idligne: number }[]>`
      SELECT DISTINCT lot::text AS lot, idligne_commande_sous_traitant AS idligne
      FROM data_bl_tricotbot WHERE lot::text ILIKE ANY(${sansSuivi()}) AND idligne_commande_sous_traitant > 0`) {
      const code = codeDe(r.lot)
      if (code && !parLot.has(code)) parLot.set(code, { idsuivilot: 0, idligne: Number(r.idligne) })
    }
  }

  const idsLigne = [...new Set([...parLot.values()].map((v) => v.idligne))]
  const lignes = idsLigne.length
    ? await sql<{ idligne: number; idcommande: number; idsous_traitant: number; idreference: number; idcoloris: number; type_ligne: number }[]>`
      SELECT l.idligne_commande_sous_traitant AS idligne, l.idcommande_sous_traitant AS idcommande,
             COALESCE(c.idsous_traitant, 0) AS idsous_traitant, COALESCE(l.idreference, 0) AS idreference,
             COALESCE(l.idcoloris, 0) AS idcoloris, COALESCE(l.type, 0) AS type_ligne
      FROM ligne_commande_sous_traitant l
      LEFT JOIN commande_sous_traitant c ON c.idcommande_sous_traitant = l.idcommande_sous_traitant
      WHERE l.idligne_commande_sous_traitant = ANY(${idsLigne})`
    : []
  const ligneDe = new Map(lignes.map((l) => [Number(l.idligne), l]))

  // Pieces: received rolls (with their merged components) + écru still out.
  const rouleaux = await sql<{ lot: string; idstock_fini: number; idstock_ecru: number; poids: number | null }[]>`
    SELECT lot::text AS lot, idstock_fini, COALESCE(idstock_ecru, 0) AS idstock_ecru, poids
    FROM stock_fini WHERE lot::text ILIKE ANY(${pats})`
  const idsFini = rouleaux.map((r) => Number(r.idstock_fini))
  const composants = idsFini.length
    ? await sql<{ idstock_fini: number; idstock_ecru: number }[]>`
      SELECT idstock_fini, idstock_ecru FROM stock_fini_source WHERE idstock_fini = ANY(${idsFini})`
    : []
  const composantsDe = new Map<number, number[]>()
  for (const c of composants) composantsDe.set(Number(c.idstock_fini), [...(composantsDe.get(Number(c.idstock_fini)) ?? []), Number(c.idstock_ecru)])
  const ecrus = await sql<{ lot: string; idstock_ecru: number; poids: number | null }[]>`
    SELECT lot::text AS lot, idstock_ecru, poids FROM stock_ecru WHERE lot::text ILIKE ANY(${pats})`
  const acc = new Map<string, { poids: number; ecru: Set<number>; rouleaux: number }>()
  const de = (code: string) => {
    let a = acc.get(code)
    if (!a) acc.set(code, (a = { poids: 0, ecru: new Set(), rouleaux: 0 }))
    return a
  }
  for (const r of rouleaux) {
    const code = codeDe(r.lot)
    if (!code) continue
    const a = de(code)
    a.poids += Number(r.poids) || 0
    a.rouleaux++
    const ids = composantsDe.get(Number(r.idstock_fini)) ?? []
    if (Number(r.idstock_ecru) > 0) ids.push(Number(r.idstock_ecru))
    if (ids.length === 0) ids.push(-Number(r.idstock_fini)) // a roll with no écru link still is a piece
    for (const id of ids) a.ecru.add(id)
  }
  for (const e of ecrus) {
    const code = codeDe(e.lot)
    if (!code) continue
    const a = de(code)
    if (a.ecru.has(Number(e.idstock_ecru))) continue // already received in a roll
    a.ecru.add(Number(e.idstock_ecru))
    a.poids += Number(e.poids) || 0
  }

  const deja = await sql<{ lot: string; numero: string }[]>`
    SELECT DISTINCT l.lot, f.numero FROM ligne_facture_sst l JOIN facture_sst f ON f.idfacture_sst = l.idfacture_sst
    WHERE f.idsous_traitant = ${fournisseur.idSousTraitant} AND f.numero <> ${f.numero_facture}
      AND l.genre = 'lot' AND l.lot = ANY(${codes})`
  const autres = new Map<string, string[]>()
  for (const d of deja) autres.set(d.lot, [...(autres.get(d.lot) ?? []), d.numero])

  for (const [code, v] of parLot) {
    const l = ligneDe.get(v.idligne)
    if (!l) continue
    const a = acc.get(code)
    const p = a ? Math.round(a.poids * 1000) / 1000 : null
    let prixAttendu: number | null = null
    let explicationPrix = ''
    let tarifIncomplet: string | null = null
    if (fournisseur.controlePrix && Number(l.type_ligne) === 2 && Number(l.idreference) > 0) {
      // The smaller of ETM's and the billed weight: a part of a lot billed on
      // its own is banded on its own (FA2854: 20 kg of MA108093's 206,75).
      const billed = factureKg.get(code) || 0
      const xPoids = p && billed ? Math.min(p, billed) : p || billed
      const bd = await calcTarifSSTBreakdown({ xPoids, IDsous_traitant: Number(l.idsous_traitant), IDref_fini: Number(l.idreference), IDref_fini_colori: Number(l.idcoloris) })
      if (bd && bd.total > 0) {
        prixAttendu = bd.total
        explicationPrix = await expliquer(bd, sql)
        tarifIncomplet = incomplet(bd)
      }
    }
    out.set(code, {
      lot: code, idsuivilot: v.idsuivilot, idligne: v.idligne, idcommande: Number(l.idcommande), idSousTraitant: Number(l.idsous_traitant),
      poids: p, pieces: a ? a.ecru.size : null, prixAttendu, explicationPrix, tarifIncomplet, autresFactures: autres.get(code) ?? [],
    })
  }
  return out
}

/** The invoice already stored for this dyer (same number), or null. */
export async function factureExistante(idSousTraitant: number, numero: string): Promise<number | null> {
  const [r] = await mpsPg()<{ id: number }[]>`
    SELECT idfacture_sst AS id FROM facture_sst WHERE idsous_traitant = ${idSousTraitant} AND numero = ${numero}`
  return r ? Number(r.id) : null
}

export interface EcritureFacture {
  idFacture: number
  /** Order lines whose num_facture this run filled (an échec clears them). */
  numFactureEcrits: number[]
}

/** Store the invoice, its lines and the invoice number on the order lines, in one transaction. */
export async function ecrireFacture(opts: {
  fournisseur: Fournisseur
  facture: FactureLue
  verification: FactureVerifiee
  pdf: Buffer
  pdfNom: string
  messageId: string | null
  runId: string
  /** False when the reading failed its checks: stored for a person, nothing pointed on the orders. */
  pointer: boolean
}): Promise<EcritureFacture> {
  const { facture: f, verification: v } = opts
  return mpsPg().begin(async (t) => {
    const sql = t as unknown as Sql
    const [h] = await sql<{ id: number }[]>`
      INSERT INTO facture_sst (idsous_traitant, numero, date_facture, date_echeance, total_ht, total_ttc, pdf, pdf_nom,
                               message_id, run_id, statut, ecart_montant, controles)
      VALUES (${opts.fournisseur.idSousTraitant}, ${f.numero_facture}, ${f.date_facture || null}, ${f.date_echeance || null},
              ${f.total_ht}, ${f.total_ttc}, ${opts.pdf}, ${opts.pdfNom}, ${opts.messageId}, ${opts.runId},
              ${v.statut}, ${v.ecartMontant}, ${sql.json(v.controles as never)})
      RETURNING idfacture_sst AS id`
    const idFacture = Number(h.id)
    for (let i = 0; i < v.lignes.length; i++) {
      const l = v.lignes[i]
      await sql`
        INSERT INTO ligne_facture_sst (idfacture_sst, ordre, genre, designation, traitements, qualite, lot, numero_commande,
          quantite, unite, pieces, prix_unitaire, montant, idligne_commande_sous_traitant, idcommande_sous_traitant, idsuivilot,
          poids_etm, pieces_etm, prix_attendu, ecart_montant, verdict, nature, controles)
        VALUES (${idFacture}, ${i + 1}, ${l.ligne.genre}, ${l.ligne.description}, ${l.ligne.traitements}, ${l.ligne.qualite},
          ${l.lotEtm}, ${l.ligne.numero_commande}, ${l.ligne.quantite}, ${l.ligne.unite}, ${l.ligne.pieces}, ${l.ligne.prix_unitaire},
          ${l.ligne.montant}, ${l.etm?.idligne ?? 0}, ${l.etm?.idcommande ?? 0}, ${l.etm?.idsuivilot ?? 0}, ${l.etm?.poids ?? null},
          ${l.etm?.pieces ?? null}, ${l.etm?.prixAttendu ?? null}, ${l.ecartMontant}, ${l.verdict}, ${l.nature}, ${sql.json(l.controles as never)})`
    }
    let numFactureEcrits: number[] = []
    const ids = [...new Set(v.lignes.map((l) => l.etm?.idligne ?? 0).filter((n) => n > 0))]
    if (opts.pointer && ids.length) {
      const rows = await sql<{ id: number }[]>`
        UPDATE ligne_commande_sous_traitant SET num_facture = ${f.numero_facture}
        WHERE idligne_commande_sous_traitant = ANY(${ids}) AND COALESCE(num_facture, '') = ''
        RETURNING idligne_commande_sous_traitant AS id`
      numFactureEcrits = rows.map((r) => Number(r.id))
    }
    await noter(sql, { idFacture, type: 'recue', resume: resumeRecue(v.statut, v.lignes.filter((l) => l.verdict === 'ecart').length) })
    return { idFacture, numFactureEcrits }
  })
}
