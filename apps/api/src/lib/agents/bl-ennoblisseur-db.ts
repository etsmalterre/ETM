// Agent « BL Ennoblisseur » — the database half: which sst order line a BL belongs
// to, whether every piece on it is one we sent there, and the two writes the
// WebDev service `localapi.malterre` used to do for n8n (load_bl_doc +
// load_bl_data):
//   - the PDF as a `ged` row of type 3 (« BL retour ennoblisseur ») on the order,
//     named `<lot>.pdf` (MA109152.pdf, BON3976.pdf, TA530425.pdf — bl-profils.ts);
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
import type { BlExtraction, Controle } from './bl-extraction.js'
import { nomGed, PROFILS, type ProfilEnnoblisseur, type TypeDocument } from './bl-profils.js'
import { mpsPg } from '../mps-pg.js'
import { consumedEcruIds } from '../fini-sources.js'
import {
  candidatProbable, commandesImprimees, controlesAilleurs, ecartsRecus, listeCommandes, messageEcartsRecus, messageIntrouvables,
  messagePlusieursCommandes, type ArticleLigne, type EcartRecu, type Valeurs,
} from './bl-diagnostics.js'

/** ged.IDtype_doc — « BL retour ennoblisseur » (whitelist in routes/commandes-sous-traitant.ts). */
export const GED_TYPE_BL_ENNOBLISSEUR = 3

/** non_affectee = an écru affected to no order (3560/3, 2026-10-06), told apart from one on another order. */
export type StatutPiece = 'ok' | 'affectee_ailleurs' | 'non_affectee' | 'inconnue'

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
  /** ged name without extension: the lot, `<lot>-dispo` for a TAD mise à dispo. */
  nomGed: string
  pieces: PieceResolue[]
  /** Rows of this lot already in data_bl_tricotbot for the line, as cleDeLigne() keys. */
  dejaImportees: string[]
  /** A ged row with the same name already exists on the order. */
  gedExistant: number | null
  controles: Controle[]
  /** A reprise BL: its pieces are rolls already received on the line
   *  (lib/reprises.ts). `idreprise` = the open reprise they belong to, null when
   *  none was recorded (the run warns). Absent on runs before 2026-10-12. */
  reprise?: { idreprise: number | null; rang: number | null; pieces: string[] } | null
  /** Rolls already received, no reprise open, that the stock holds with other
   *  figures than this BL's (v4). Absent before 2026-10-30. */
  ecartsRecus?: EcartRecu[]
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

/** The weight written into data_bl_tricotbot: the dyer's for MATEL, 0 for the
 *  others (Malterre weighs the rolls — the réception dialog keeps its own value
 *  on a 0). Every dedupe key is built on it. */
export const poidsEcrit = (profil: ProfilEnnoblisseur, poids: number | null) => (profil.ecritPoids ? poids ?? 0 : 0)

/** Find the order, pick its line, check every piece. Read-only. */
export async function resoudreBl(e: BlExtraction, profil: ProfilEnnoblisseur, type: TypeDocument = 'bl'): Promise<Resolution> {
  const controles: Controle[] = []
  const bloque = (code: string, message: string) => controles.push({ code, gravite: 'bloquant', message })
  const lot = profil.lot(e)
  const res: Resolution = {
    commandeId: null, sousTraitantId: null, lignes: [], ligneId: null, lot, nomGed: lot ? nomGed(lot, type, e.numero_bordereau) : '',
    pieces: [], dejaImportees: [], gedExistant: null, controles, reprise: null,
  }
  const cmds = commandesImprimees(e.numero_commande)
  if (!cmds) return res
  const cmd = cmds[0]
  const plusieurs = cmds.length > 1

  const cs = await query<{ IDcommande_sous_traitant: number; IDsous_traitant: number }>(
    `SELECT IDcommande_sous_traitant, IDsous_traitant FROM commande_sous_traitant WHERE IDcommande_sous_traitant IN (${cmds.join(',')})`,
  )
  const sstDe = new Map(cs.map((c) => [Number(c.IDcommande_sous_traitant), Number(c.IDsous_traitant) || 0]))
  const inconnuesCmd = cmds.filter((n) => !sstDe.has(n))
  if (inconnuesCmd.length) {
    bloque('commande_inconnue', `La commande sous-traitant n° ${listeCommandes(inconnuesCmd)} n’existe pas.`)
    return res
  }
  res.commandeId = cmd
  res.sousTraitantId = sstDe.get(cmd) ?? 0
  const autreSst = cmds.filter((n) => sstDe.get(n) !== profil.idSousTraitant)
  if (autreSst.length) {
    bloque('commande_autre_sst', `La commande n° ${listeCommandes(autreSst)} n’est pas une commande ${profil.nom}.`)
  }

  type LigneArticle = { IDligne_commande_sous_traitant: number; IDcommande_sous_traitant: number; IDreference: number; IDColoris: number }
  const article = (l: LigneArticle): ArticleLigne => ({
    ligne: Number(l.IDligne_commande_sous_traitant),
    commande: Number(l.IDcommande_sous_traitant),
    idSousTraitant: sstDe.get(Number(l.IDcommande_sous_traitant)) ?? 0,
    reference: Number(l.IDreference) || 0,
    coloris: Number(l.IDColoris) || 0,
  })
  const articles = (await query<LigneArticle>(
    `SELECT IDligne_commande_sous_traitant, IDcommande_sous_traitant, IDreference, IDColoris FROM ligne_commande_sous_traitant
     WHERE IDcommande_sous_traitant IN (${cmds.join(',')}) ORDER BY IDligne_commande_sous_traitant`,
  )).map(article)
  const commandeDe = new Map(articles.map((a) => [a.ligne, a.commande]))
  // A BL common to several orders (« 9040+9045 ») resolves its pieces over all
  // their lines; `lignes` stays the first order's (the run's order).
  res.lignes = articles.filter((a) => a.commande === cmd).map((a) => a.ligne)
  if (res.lignes.length === 0) {
    bloque('commande_sans_ligne', `La commande n° ${cmd} n’a aucune ligne.`)
    return res
  }
  const lignesSet = new Set(articles.map((a) => a.ligne))

  // Where each printed numero lives: an écru affected to a line of this order
  // (first reception) or a fini roll received on it (a corrected BL after a
  // reprise lists the fini numeros, with their -1/-2 cut suffixes).
  const numeros = [...new Set(e.pieces.flatMap((p) => p.composants))].filter((n) => /^[\d/+-]+$/.test(n))
  const ligneDe = new Map<string, number>()
  /** Numero → roll already received on a line of this order (a reprise BL). */
  const finiRecu = new Map<string, number>()
  /** Numero → that roll's figures as they stand in stock. */
  const valeursRecues = new Map<string, Valeurs>()
  /** Numero found off these lines → the line it is on, 0 = an écru affected to none. */
  const ailleurs = new Map<string, number>()
  const noterAilleurs = (n: string, l: number) => { if (!ailleurs.get(n)) ailleurs.set(n, l) }
  for (const part of chunks(numeros, 50)) {
    const inList = part.map((n) => `'${esc(n)}'`).join(',')
    const ecrus = await query<{ numero: string; IDref_commande_affectation: number }>(
      `SELECT numero, IDref_commande_affectation FROM stock_ecru WHERE numero IN (${inList})`,
    )
    for (const r of ecrus) {
      const l = Number(r.IDref_commande_affectation) || 0
      if (lignesSet.has(l)) ligneDe.set(String(r.numero).trim(), l)
      else noterAilleurs(String(r.numero).trim(), l)
    }
    const finis = await query<{ IDstock_fini: number; numero: string; IDref_commande_source: number; poids: number | null; metrage: number | null }>(
      `SELECT IDstock_fini, numero, IDref_commande_source, poids, metrage FROM stock_fini WHERE numero IN (${inList})`,
    )
    for (const r of finis) {
      const l = Number(r.IDref_commande_source) || 0
      if (lignesSet.has(l)) {
        ligneDe.set(String(r.numero).trim(), l)
        finiRecu.set(String(r.numero).trim(), Number(r.IDstock_fini))
        valeursRecues.set(String(r.numero).trim(), { poids: r.poids == null ? null : Number(r.poids), metrage: r.metrage == null ? null : Number(r.metrage) })
      }
      else noterAilleurs(String(r.numero).trim(), l)
    }
  }

  for (const p of e.pieces) {
    const composants = p.composants.map((n) => ({ numero: n, ligne: ligneDe.get(n) ?? 0 }))
    const hors = composants.filter((x) => x.ligne === 0)
    let statut: StatutPiece = 'ok'
    if (hors.some((x) => (ailleurs.get(x.numero) ?? 0) > 0)) statut = 'affectee_ailleurs'
    else if (hors.some((x) => ailleurs.has(x.numero))) statut = 'non_affectee'
    else if (hors.length) statut = 'inconnue'
    res.pieces.push({ numero_piece: p.numero_piece, statut, composants })
  }

  // Pieces not found at all: the order's écrus still awaited a typo away
  // (BL 109400A: 3570/50 printed, 3572/50 on the order) are named, never used.
  const inconnues = e.pieces.filter((_, i) => res.pieces[i].statut === 'inconnue')
  if (inconnues.length) {
    const ecrus = await query<{ IDstock_ecru: number; numero: string; poids: number | null }>(
      `SELECT IDstock_ecru, numero, poids FROM stock_ecru WHERE IDref_commande_affectation IN (${[...lignesSet].join(',')})`,
    )
    const consommes = await consumedEcruIds(ecrus.map((r) => Number(r.IDstock_ecru)))
    const imprimes = new Set(numeros)
    const candidats = ecrus
      .filter((r) => !consommes.has(Number(r.IDstock_ecru)) && !imprimes.has(String(r.numero).trim()))
      .map((r) => ({ numero: String(r.numero).trim(), poids: Number(r.poids) || null }))
    bloque('pieces_inconnues', messageIntrouvables(
      inconnues.map((p) => ({ numero: p.numero_piece, probable: p.composants.length === 1 ? candidatProbable(p.composants[0], p.poids, candidats) : null })),
      plusieurs ? null : cmd,
    ))
  }

  // Pieces off these lines: name the other order (and spot a misnumbered BL).
  const horsLignes = res.pieces.filter((p) => p.statut === 'affectee_ailleurs' || p.statut === 'non_affectee')
  if (horsLignes.length) {
    const lignesAutres = [...new Set([...ailleurs.values()].filter((l) => l > 0))]
    const autres: ArticleLigne[] = []
    for (const part of chunks(lignesAutres, 50)) {
      const rows = await query<LigneArticle>(
        `SELECT IDligne_commande_sous_traitant, IDcommande_sous_traitant, IDreference, IDColoris FROM ligne_commande_sous_traitant
         WHERE IDligne_commande_sous_traitant IN (${part.join(',')})`,
      )
      const cmdsAutres = [...new Set(rows.map((r) => Number(r.IDcommande_sous_traitant)))].filter((n) => !sstDe.has(n))
      if (cmdsAutres.length) {
        const sst = await query<{ IDcommande_sous_traitant: number; IDsous_traitant: number }>(
          `SELECT IDcommande_sous_traitant, IDsous_traitant FROM commande_sous_traitant WHERE IDcommande_sous_traitant IN (${cmdsAutres.join(',')})`,
        )
        for (const r of sst) sstDe.set(Number(r.IDcommande_sous_traitant), Number(r.IDsous_traitant) || 0)
      }
      autres.push(...rows.map(article))
    }
    const cmdDeLigne = new Map(autres.map((a) => [a.ligne, a.commande]))
    const places = horsLignes.map((p) => {
      const l = p.composants.map((x) => ailleurs.get(x.numero) ?? 0).find((x) => x > 0) ?? 0
      return { numero: p.numero_piece, ligne: l, commande: cmdDeLigne.get(l) ?? 0 }
    })
    const imprimee = articles.filter((a) => a.commande === cmd)
    for (const c of controlesAilleurs(places, e.pieces.length, cmd, { imprimee, autres })) bloque(c.code, c.message)
  }

  // A BL common to several orders: say which piece goes where, write nothing
  // (decision Vincent 2026-10-12: rare — 4 lots in ~1 300 orders — a person
  // receives it order by order under the same lot).
  if (plusieurs) {
    const repartition = cmds.map((c) => ({
      commande: c,
      pieces: res.pieces.filter((p) => p.statut === 'ok' && p.composants.every((x) => commandeDe.get(x.ligne) === c)).map((p) => p.numero_piece),
    }))
    bloque('plusieurs_commandes', messagePlusieursCommandes(cmds, repartition, lot))
    return res
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
  // A piece on another line of THIS order (the BL's line is the majority one).
  for (const p of res.pieces) {
    if (p.statut === 'ok' && res.ligneId != null && p.composants.some((x) => x.ligne !== res.ligneId)) p.statut = 'affectee_ailleurs'
  }

  // A reprise BL (decision 2026-10-12): the pieces are rolls already received.
  // The lot stays the dyer's number; the BL pre-fills the reprise réception and
  // its PDF is filed under its own name (it used to collide with the first BL's
  // ged and was never filed). No open reprise = recorded too late: warn, still
  // pre-fill, so the réception is not left without the dyer's figures.
  const recues = [...new Set(e.pieces.flatMap((p) => p.composants).filter((n) => finiRecu.has(n)))]
  let repriseDepuis: string | null = null
  let sansReprise: Controle | null = null
  let horsReprise: string[] = []
  if (recues.length > 0) {
    const ids = recues.map((n) => finiRecu.get(n)!)
    const ouvertes = await mpsPg()<{ idreprise: number; rang: number; idstock_fini: number; depuis: string | null }[]>`
      SELECT r.id AS idreprise, r.rang, rp.idstock_fini, to_char(r.envoye_le AT TIME ZONE 'Europe/Paris', 'YYYYMMDD') AS depuis
      FROM reprise_piece rp JOIN reprise r ON r.id = rp.idreprise
      WHERE rp.idstock_fini = ANY(${ids}) AND r.statut = 'ouverte'`.catch(() => [])
    const couvertes = new Set(ouvertes.map((o) => Number(o.idstock_fini)))
    const hors = recues.filter((n) => !couvertes.has(finiRecu.get(n)!))
    const rep = ouvertes[0]
    res.reprise = { idreprise: rep && hors.length === 0 ? Number(rep.idreprise) : null, rang: rep ? Number(rep.rang) : null, pieces: recues }
    repriseDepuis = rep && hors.length === 0 ? rep.depuis : null
    horsReprise = hors
    if (hors.length > 0) {
      sansReprise = {
        code: 'reprise_non_enregistree',
        gravite: 'avertissement',
        message: `Pièce(s) déjà réceptionnée(s) sans reprise enregistrée : ${hors.join(', ')}. Sélectionnez-les dans l’onglet Réception et « Envoyer en reprise » avant de réceptionner.`,
      }
    }
  }
  /** Latest figures this lot's previous BLs pre-filled, per piece. */
  const avant = new Map<string, Valeurs>()

  if (res.ligneId != null && lot) {
    // A reprise BL repeating the first BL's figures is still new: only rows
    // written since the reprise was opened count as already imported.
    const depuis = repriseDepuis && /^\d{8}$/.test(repriseDepuis) ? ` AND DATE >= '${repriseDepuis}'` : ''
    const deja = await query<{ num_piece: string; poids: number; metrage: number }>(
      `SELECT num_piece, poids, metrage FROM data_bl_tricotbot WHERE IDligne_commande_sous_traitant = ${res.ligneId} AND lot = '${esc(lot)}'${depuis}
       ORDER BY IDdata_bl_tricotbot`,
    )
    res.dejaImportees = [...new Set(deja.map((d) => cleDeLigne(String(d.num_piece ?? ''), d.poids, d.metrage)))]
    for (const d of deja) avant.set(String(d.num_piece ?? '').trim(), { poids: d.poids, metrage: d.metrage })
  }
  // Rolls already received, no open reprise, and every figure already
  // imported: the same document again, not a reprise — a resent BL, or TAD's
  // BL after its mise à dispo (the shipment to the client, sent once the rolls
  // are received; v3, 2026-10-12). Filed under its own name, no warning.
  if (res.reprise && res.reprise.idreprise == null) {
    const deja = new Set(res.dejaImportees)
    if (e.pieces.every((p) => deja.has(cleDeLigne(p.numero_piece, poidsEcrit(profil, p.poids), p.metrage)))) {
      res.reprise = null
      sansReprise = null
    }
  }
  // No reprise open: a rectified BL (109368, 3546/11 19,8 → 109,8 m) or a late
  // one looks the same as an unrecorded reprise. The stock decides (v4): it
  // already carries the BL's figures = nothing to do; otherwise each difference
  // is named with the gesture for either case.
  if (sansReprise && res.reprise) {
    const recus = new Map([...valeursRecues].filter(([n]) => horsReprise.includes(n)))
    const ecarts = ecartsRecus(e.pieces, recus, avant, profil.ecritPoids)
    if (ecarts.length) {
      res.ecartsRecus = ecarts
      sansReprise = { code: 'recu_autres_valeurs', gravite: 'avertissement', message: messageEcartsRecus(ecarts) }
    } else {
      res.reprise = null
      sansReprise = null
    }
  }
  if (sansReprise) controles.push(sansReprise)
  if (res.reprise && res.nomGed) res.nomGed = `${res.nomGed}-reprise${res.reprise.rang ?? ''}`
  // A rectified BL (a figure changed since the lot's previous BL) is another
  // paper: filed beside the first one, never folded into its ged (v4).
  else if (res.nomGed && e.pieces.some((p) => {
    const a = avant.get(p.numero_piece)
    return a && cleDeLigne(p.numero_piece, a.poids, a.metrage) !== cleDeLigne(p.numero_piece, poidsEcrit(profil, p.poids), p.metrage)
  })) res.nomGed = `${res.nomGed}-rectifie`
  if (res.nomGed) {
    const [g] = await query<{ IDged: number }>(
      `SELECT IDged FROM ged WHERE IDcommande_sous_traitant = ${cmd} AND IDtype_doc = ${GED_TYPE_BL_ENNOBLISSEUR} AND nom = '${esc(res.nomGed)}.pdf'`,
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

/** File the document's PDF on the order (type « BL retour ennoblisseur »), one
 *  ged per scanned page: `MA109152.pdf`, then `MA109152-2.pdf`… Idempotent: a
 *  ged of the same name is reused. Also used alone on a document whose pieces
 *  are all imported already — TAD's BL after its mise à dispo is the proof of
 *  shipment and must be on the order (v3, 2026-10-12). */
export async function classerPdf(r: Resolution, pdfs: readonly Buffer[]): Promise<number | null> {
  if (r.commandeId == null || !(r.nomGed || r.lot)) return r.gedExistant
  // Resolutions stored before 2026-09-28 have no nomGed: the lot was the name.
  const base = r.nomGed || r.lot
  let gedId = r.gedExistant
  for (let i = 0; i < pdfs.length; i++) {
    const nom = i === 0 ? `${base}.pdf` : `${base}-${i + 1}.pdf`
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
  return gedId
}

/** Write the PDF and the pieces. Idempotent: an existing ged of the same name
 *  is reused, and pieces of this lot already on the line with identical values
 *  are skipped (a re-processed mail must never duplicate rows; a CORRECTED BL
 *  that changes a value is written — the réception dialog keeps the newest row
 *  per piece). */
export async function ecrireBl(
  e: BlExtraction, r: Resolution, pdfs: readonly Buffer[], jourYmd: string, profil: ProfilEnnoblisseur,
): Promise<Ecriture> {
  if (r.commandeId == null || r.ligneId == null || !r.lot) throw new Error('BL non résolu : rien à écrire')
  const gedId = await classerPdf(r, pdfs)
  const deja = new Set(r.dejaImportees)
  // A cut piece has two rows under one number and the réception dialog keeps
  // the LAST row per number: write the unweighed part first so the weighed
  // one wins, as it did with n8n (which dropped the 0 kg row).
  const ordre = [...e.pieces].sort((a, b) => Number((a.poids ?? 0) > 0) - Number((b.poids ?? 0) > 0))
  const ids: number[] = []
  let n = 0
  for (const p of ordre) {
    const poids = poidsEcrit(profil, p.poids)
    if (deja.has(cleDeLigne(p.numero_piece, poids, p.metrage))) continue
    await query(
      `INSERT INTO data_bl_tricotbot (IDligne_commande_sous_traitant, lot, poids, metrage, observation, num_piece, DATE)
       VALUES (${r.ligneId}, '${esc(r.lot)}', ${poids}, ${p.metrage ?? 0}, ${sqlText(p.observations)}, '${esc(p.numero_piece)}', '${jourYmd}')`,
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
  // The reprise's return BL (lib/reprises.ts): the dyer's paper, on the reprise.
  if (r.reprise?.idreprise && gedId) {
    await mpsPg()`UPDATE reprise SET idged_retour = ${gedId} WHERE id = ${r.reprise.idreprise} AND idged_retour IS NULL`
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

/** The e-mail addresses of the dyers the agent reads (Sous-traitants › Gestion ›
 *  Contacts): a new MATEL address is picked up without touching the code. */
export async function contactsEnnoblisseurs(): Promise<Array<{ mail: string; idSousTraitant: number }>> {
  const rows = await query<{ mail: string | null; IDsous_traitant: number }>(
    `SELECT mail, IDsous_traitant FROM contact WHERE IDsous_traitant IN (${PROFILS.map((p) => p.idSousTraitant).join(',')})`,
  )
  return rows
    .map((r) => ({ mail: String(r.mail ?? '').trim(), idSousTraitant: Number(r.IDsous_traitant) }))
    .filter((c) => c.mail.includes('@'))
}

/** A roll as it stands in stock, for the run dialog's « en stock » comparison. */
export interface RouleauEnStock {
  numero: string
  poids: number | null
  metrage: number | null
  observation_sst: string
}

/** The fini rolls of this lot received on this sst line, as they stand now
 *  (2026-10-29: a BL blocked « à vérifier » writes no pre-fill, the rolls are
 *  then typed by hand and no Tricobot retour links them to the run). Raw rows:
 *  the dialog folds a roll cut afterwards (`<numero>-N`, lib/roll-cut.ts) back
 *  into its piece only when the BL itself does not list that numero. */
export async function rouleauxEnStock(ligneId: number, lot: string): Promise<RouleauEnStock[]> {
  const cible = lot.toUpperCase().replace(/\s+/g, '')
  const rows = await mpsPg()<{ numero: string | null; lot: string | null; poids: number | null; metrage: number | null; observation_sst: string | null }[]>`
    SELECT numero, lot, poids, metrage, observation_sst FROM stock_fini WHERE idref_commande_source = ${ligneId}`
  return rows
    .filter((r) => (r.lot ?? '').toUpperCase().replace(/\s+/g, '') === cible && String(r.numero ?? '').trim() !== '')
    .map((r) => ({
      numero: String(r.numero).trim(),
      poids: r.poids == null ? null : Number(r.poids),
      metrage: r.metrage == null ? null : Number(r.metrage),
      observation_sst: (r.observation_sst ?? '').trim(),
    }))
}
