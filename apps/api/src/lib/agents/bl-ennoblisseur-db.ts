// Agent « BL Ennoblisseur » — the database half: which sst order line a BL belongs
// to, whether every piece on it is one we sent there, and the two writes the
// WebDev service `localapi.malterre` used to do for n8n (load_bl_doc +
// load_bl_data):
//   - the PDF as a `ged` row of type 3 (« BL retour ennoblisseur ») on the order,
//     named `MA<lot>.pdf`;
//   - one `data_bl_tricotbot` row per piece — the table the réception dialog of
//     Sous-traitants › Commandes pre-fills from (GET …/lignes/:id/tricobot).
//
// Improvements over the WebDev service, measured on the 2026-09-22 benchmark:
//   - merged rolls (« 3510/11+3510/2 ») are written — WebDev never wrote one;
//   - no piece is lost — WebDev dropped rows Gemini had read (cause unknown);
//   - a piece that is not ours stops the BL instead of being written.

import { query } from '../hfsql-auto.js'
import { esc } from '../sst-shared.js'
import { sqlText } from '../clients-common.js'
import { insertGedSst } from '../ged-sst.js'
import { MATEL_IDSOUS_TRAITANT } from '../pricing-sst.js'
import { lotDuBordereau, type BlExtraction, type Controle } from './bl-extraction.js'

/** ged.IDtype_doc — « BL retour ennoblisseur » (whitelist in routes/commandes-sous-traitant.ts). */
export const GED_TYPE_BL_ENNOBLISSEUR = 3

export type StatutPiece = 'ok' | 'affectee_ailleurs' | 'inconnue'

export interface PieceResolue {
  numero_piece: string
  statut: StatutPiece
  /** Per component: the line it is affected to (écru) or received on (fini), 0 = none found. */
  composants: Array<{ numero: string; ligne: number }>
}

export interface Resolution {
  commandeId: number | null
  sousTraitantId: number | null
  lignes: number[]
  ligneId: number | null
  lot: string
  pieces: PieceResolue[]
  /** Rows of this lot already in data_bl_tricotbot for the line, as cleDeLigne() keys. */
  dejaImportees: string[]
  /** A ged row with the same name already exists on the order. */
  gedExistant: number | null
  controles: Controle[]
}

/** Identity of a data_bl_tricotbot row: same piece, same poids, same métrage
 *  (the columns are single-precision floats, hence the rounding). A corrected
 *  BL that changes a value under the same lot is a NEW row, not a duplicate. */
export function cleDeLigne(numero: string, poids: unknown, metrage: unknown): string {
  const r = (v: unknown) => (Math.round((Number(v) || 0) * 100) / 100).toFixed(2)
  return `${numero.replace(/\s/g, '')}|${r(poids)}|${r(metrage)}`
}

const chunks = <T,>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

/** Find the order, pick its line, check every piece. Read-only. */
export async function resoudreBl(e: BlExtraction): Promise<Resolution> {
  const controles: Controle[] = []
  const bloque = (code: string, message: string) => controles.push({ code, gravite: 'bloquant', message })
  const lot = lotDuBordereau(e.numero_bordereau)
  const res: Resolution = {
    commandeId: null, sousTraitantId: null, lignes: [], ligneId: null, lot,
    pieces: [], dejaImportees: [], gedExistant: null, controles,
  }
  const cmd = /^\d{4,6}$/.test(e.numero_commande) ? parseInt(e.numero_commande, 10) : NaN
  if (!Number.isFinite(cmd)) return res

  const [c] = await query<{ IDcommande_sous_traitant: number; IDsous_traitant: number }>(
    `SELECT IDcommande_sous_traitant, IDsous_traitant FROM commande_sous_traitant WHERE IDcommande_sous_traitant = ${cmd}`,
  )
  if (!c) {
    bloque('commande_inconnue', `La commande sous-traitant n° ${cmd} n’existe pas.`)
    return res
  }
  res.commandeId = cmd
  res.sousTraitantId = Number(c.IDsous_traitant) || 0
  if (res.sousTraitantId !== MATEL_IDSOUS_TRAITANT) {
    bloque('commande_pas_matel', `La commande n° ${cmd} n’est pas une commande MATEL.`)
  }

  const lignes = await query<{ IDligne_commande_sous_traitant: number }>(
    `SELECT IDligne_commande_sous_traitant FROM ligne_commande_sous_traitant
     WHERE IDcommande_sous_traitant = ${cmd} ORDER BY IDligne_commande_sous_traitant`,
  )
  res.lignes = lignes.map((l) => Number(l.IDligne_commande_sous_traitant))
  if (res.lignes.length === 0) {
    bloque('commande_sans_ligne', `La commande n° ${cmd} n’a aucune ligne.`)
    return res
  }
  const lignesSet = new Set(res.lignes)

  // Where each printed numero lives: an écru affected to a line of this order
  // (first reception) or a fini roll received on it (a corrected BL after a
  // reprise lists the fini numeros, with their -1/-2 cut suffixes).
  const numeros = [...new Set(e.pieces.flatMap((p) => p.composants))].filter((n) => /^[\d/+-]+$/.test(n))
  const ligneDe = new Map<string, number>()
  const ailleurs = new Set<string>()
  for (const part of chunks(numeros, 50)) {
    const inList = part.map((n) => `'${esc(n)}'`).join(',')
    const ecrus = await query<{ numero: string; IDref_commande_affectation: number }>(
      `SELECT numero, IDref_commande_affectation FROM stock_ecru WHERE numero IN (${inList})`,
    )
    for (const r of ecrus) {
      const l = Number(r.IDref_commande_affectation) || 0
      if (lignesSet.has(l)) ligneDe.set(String(r.numero).trim(), l)
      else ailleurs.add(String(r.numero).trim())
    }
    const finis = await query<{ numero: string; IDref_commande_source: number }>(
      `SELECT numero, IDref_commande_source FROM stock_fini WHERE numero IN (${inList})`,
    )
    for (const r of finis) {
      const l = Number(r.IDref_commande_source) || 0
      if (lignesSet.has(l)) ligneDe.set(String(r.numero).trim(), l)
      else ailleurs.add(String(r.numero).trim())
    }
  }

  // The line: the one most pieces belong to; the printed « Ligne n » breaks a tie.
  const votes = new Map<number, number>()
  for (const n of numeros) {
    const l = ligneDe.get(n)
    if (l) votes.set(l, (votes.get(l) ?? 0) + 1)
  }
  const classement = [...votes].sort((a, b) => b[1] - a[1])
  if (classement.length === 0) {
    res.ligneId = res.lignes.length === 1 ? res.lignes[0] : null
  } else if (classement.length === 1 || classement[0][1] > classement[1][1]) {
    res.ligneId = classement[0][0]
  } else {
    const parIndex = e.ligne != null ? res.lignes[e.ligne - 1] : undefined
    res.ligneId = parIndex && classement.some(([l, v]) => l === parIndex && v === classement[0][1]) ? parIndex : null
  }
  if (res.ligneId == null) bloque('ligne_indeterminee', 'Impossible de savoir à quelle ligne de la commande ce BL correspond.')
  if (classement.length > 1) {
    bloque('plusieurs_lignes', 'Les pièces du BL sont affectées à plusieurs lignes de la commande.')
  }

  for (const p of e.pieces) {
    const composants = p.composants.map((n) => ({ numero: n, ligne: ligneDe.get(n) ?? 0 }))
    let statut: StatutPiece = 'ok'
    if (composants.some((x) => x.ligne === 0)) statut = composants.some((x) => ailleurs.has(x.numero)) ? 'affectee_ailleurs' : 'inconnue'
    else if (res.ligneId != null && composants.some((x) => x.ligne !== res.ligneId)) statut = 'affectee_ailleurs'
    res.pieces.push({ numero_piece: p.numero_piece, statut, composants })
  }
  const inconnues = res.pieces.filter((p) => p.statut === 'inconnue').map((p) => p.numero_piece)
  const autres = res.pieces.filter((p) => p.statut === 'affectee_ailleurs').map((p) => p.numero_piece)
  if (inconnues.length) bloque('pieces_inconnues', `Pièce(s) introuvable(s) dans le stock : ${inconnues.join(', ')}.`)
  if (autres.length) bloque('pieces_autre_ligne', `Pièce(s) affectée(s) à une autre commande : ${autres.join(', ')}.`)

  if (res.ligneId != null && lot) {
    const deja = await query<{ num_piece: string; poids: number; metrage: number }>(
      `SELECT num_piece, poids, metrage FROM data_bl_tricotbot WHERE IDligne_commande_sous_traitant = ${res.ligneId} AND lot = '${esc(lot)}'`,
    )
    res.dejaImportees = [...new Set(deja.map((d) => cleDeLigne(String(d.num_piece ?? ''), d.poids, d.metrage)))]
  }
  if (lot) {
    const [g] = await query<{ IDged: number }>(
      `SELECT IDged FROM ged WHERE IDcommande_sous_traitant = ${cmd} AND IDtype_doc = ${GED_TYPE_BL_ENNOBLISSEUR} AND nom = '${esc(lot)}.pdf'`,
    )
    res.gedExistant = g ? Number(g.IDged) : null
  }
  return res
}

export interface Ecriture {
  gedId: number | null
  lignesEcrites: number
  /** IDdata_bl_tricotbot of the rows written — what an « échec » removes.
   *  Absent on runs written before 2026-09-23 (retirerPieces() then matches). */
  ids?: number[]
  /** Set once an « échec » removed the rows. */
  retire?: { le: string; lignes: number } | null
}

/** Write the PDF and the pieces. Idempotent: an existing ged of the same name
 *  is reused, and pieces of this lot already on the line with identical values
 *  are skipped (a re-processed mail must never duplicate rows; a CORRECTED BL
 *  that changes a value is written — the réception dialog keeps the newest row
 *  per piece). */
export async function ecrireBl(e: BlExtraction, r: Resolution, pdfs: readonly Buffer[], jourYmd: string): Promise<Ecriture> {
  if (r.commandeId == null || r.ligneId == null || !r.lot) throw new Error('BL non résolu : rien à écrire')
  // One ged per scanned page: `MA109152.pdf`, then `MA109152-2.pdf`…
  let gedId = r.gedExistant
  for (let i = 0; i < pdfs.length; i++) {
    const nom = i === 0 ? `${r.lot}.pdf` : `${r.lot}-${i + 1}.pdf`
    if (i === 0 && r.gedExistant != null) continue
    if (i > 0) {
      const [g] = await query<{ IDged: number }>(
        `SELECT IDged FROM ged WHERE IDcommande_sous_traitant = ${r.commandeId} AND IDtype_doc = ${GED_TYPE_BL_ENNOBLISSEUR} AND nom = '${esc(nom)}'`,
      )
      if (g) continue
    }
    const id = await insertGedSst({ commandeId: r.commandeId, nom, idTypeDoc: GED_TYPE_BL_ENNOBLISSEUR, fichier: pdfs[i] })
    if (i === 0) gedId = id
  }
  const deja = new Set(r.dejaImportees)
  // A cut piece has two rows under one number and the réception dialog keeps
  // the LAST row per number: write the unweighed part first so the weighed
  // one wins, as it did with n8n (which dropped the 0 kg row).
  const ordre = [...e.pieces].sort((a, b) => Number((a.poids ?? 0) > 0) - Number((b.poids ?? 0) > 0))
  const ids: number[] = []
  let n = 0
  for (const p of ordre) {
    if (deja.has(cleDeLigne(p.numero_piece, p.poids, p.metrage))) continue
    await query(
      `INSERT INTO data_bl_tricotbot (IDligne_commande_sous_traitant, lot, poids, metrage, observation, num_piece, DATE)
       VALUES (${r.ligneId}, '${esc(r.lot)}', ${p.poids ?? 0}, ${p.metrage ?? 0}, ${sqlText(p.observations)}, '${esc(p.numero_piece)}', '${jourYmd}')`,
    )
    n++
    // No RETURNING on HFSQL: the row just written is the newest of its piece
    // (a cut piece's second row included — its first row is already older).
    const [row] = await query<{ id: number | null }>(
      `SELECT MAX(IDdata_bl_tricotbot) AS id FROM data_bl_tricotbot
       WHERE IDligne_commande_sous_traitant = ${r.ligneId} AND lot = '${esc(r.lot)}' AND num_piece = '${esc(p.numero_piece)}'`,
    )
    if (row?.id) ids.push(Number(row.id))
  }
  return { gedId, lignesEcrites: n, ids }
}

/** « Échec » on a written BL: remove the pieces it pre-filled, so the réception
 *  dialog no longer offers values the user judged wrong. The PDF stays filed on
 *  the order — it is the dyer's real document (decision 2026-09-23). Rows come
 *  from the ids recorded at write time; a run written before they were recorded
 *  falls back to its own pieces (same line, lot, piece, poids and métrage)
 *  minus those an earlier run had already written. Returns the rows removed. */
export async function retirerPieces(
  e: BlExtraction,
  r: Pick<Resolution, 'ligneId' | 'lot' | 'dejaImportees'>,
  ecriture: Ecriture,
): Promise<number> {
  if (r.ligneId == null || !r.lot) return 0
  let ids = ecriture.ids ?? []
  if (!ecriture.ids) {
    const deja = new Set(r.dejaImportees)
    const miennes = new Set(e.pieces.map((p) => cleDeLigne(p.numero_piece, p.poids, p.metrage)).filter((k) => !deja.has(k)))
    const rows = await query<{ IDdata_bl_tricotbot: number; num_piece: string | null; poids: number | null; metrage: number | null }>(
      `SELECT IDdata_bl_tricotbot, num_piece, poids, metrage FROM data_bl_tricotbot
       WHERE IDligne_commande_sous_traitant = ${r.ligneId} AND lot = '${esc(r.lot)}'`,
    )
    ids = rows.filter((x) => miennes.has(cleDeLigne(String(x.num_piece ?? ''), x.poids, x.metrage))).map((x) => Number(x.IDdata_bl_tricotbot))
  }
  // Only rows still there and on this line: never delete on a stored id alone.
  let retirees = 0
  for (const part of chunks(ids.filter((x) => Number.isInteger(x) && x > 0), 50)) {
    const presents = await query<{ IDdata_bl_tricotbot: number }>(
      `SELECT IDdata_bl_tricotbot FROM data_bl_tricotbot
       WHERE IDligne_commande_sous_traitant = ${r.ligneId} AND IDdata_bl_tricotbot IN (${part.join(',')})`,
    )
    if (!presents.length) continue
    await query(`DELETE FROM data_bl_tricotbot WHERE IDdata_bl_tricotbot IN (${presents.map((x) => Number(x.IDdata_bl_tricotbot)).join(',')})`)
    retirees += presents.length
  }
  return retirees
}
