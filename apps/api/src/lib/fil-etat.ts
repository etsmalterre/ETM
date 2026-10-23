// Yarn-stock summary for one (ref_fil, colori_fil): en stock / commandé /
// besoin / disponible. Moved verbatim out of GET /api/stock/fil/etat (the
// « État des stocks de fil » dashboard widget) so the Superviseur agent's
// « fil à commander » check reads the SAME numbers the widget shows.
// "Fil à commander" = disponible < 0.

import { query, fixEncoding } from './hfsql-auto.js'
import { filEtmSql } from './fil-gere-etm.js'
import { computeBesoin, type AssoRow, type MirrorLine, type OfRow, type PieceRow, type OfFilRow, type LineRow, type BesoinRow } from './fil-etat-besoin.js'
import { reservationsDuFil, etatReservation, compteDansReserve } from './reservation-fil.js'
import { mpsPg } from './mps-pg.js'

export async function calculerEtatFil(refFil: number, coloriFil: number) {
  // En stock — physical on-hand rolls (stock > 0), with their source
  // fournisseur. `terminé` is accented (bridge can't tokenize it in WHERE);
  // consumed rolls carry stock=0 so `stock > 0` already excludes them.
  // Only the lots ETM manages — a TRM client's yarn of the same ref is not ours
  // to count (LIVA #1293).
  const stockRows = await query<{ lot: string | null; stock: number | null; IDfournisseur: number }>(
    `SELECT lot, stock, IDfournisseur FROM stock_fil
     WHERE IDref_fil = ${refFil} AND IDcolori_fil = ${coloriFil} AND stock > 0 AND ${filEtmSql()}
     ORDER BY stock DESC`,
  )
  const en_stock = stockRows.reduce((s, r) => s + (Number(r.stock) || 0), 0)
  const nb_lots = stockRows.length

  // Commandé — incoming order lines not yet received (etat = 0). The
  // fournisseur lives on the commande_fil header, not the line.
  const cmdRows = await query<{ IDref_fil_commande: number; IDcommande_fil: number; quantite: number | null }>(
    `SELECT IDref_fil_commande, IDcommande_fil, quantite FROM ref_fil_commande
     WHERE IDref_fil = ${refFil} AND IDcolori_fil = ${coloriFil} AND etat = 0
     ORDER BY IDcommande_fil DESC`,
  )
  const nb_commandes = cmdRows.length

  // Received-against-line — sum of stock_initial of every stock_fil roll
  // linked back to the order line via IDref_fil_commande (the same aggregate
  // the commande detail surfaces as "N lots · X kg"). A partially-received
  // line stays etat = 0, so without this its full ordered quantity would
  // still count as "commandé" even though some has already landed in stock.
  // Subtracting it also avoids double-counting: received rolls already sit in
  // `en_stock`, so a gross "commandé" would inflate `disponible`.
  const lineIds = cmdRows.map((r) => Number(r.IDref_fil_commande)).filter((x) => x > 0)
  const recuByLine = new Map<number, number>()
  if (lineIds.length > 0) {
    const recuRows = await query<{ IDref_fil_commande: number; stock_initial: number | null }>(
      `SELECT IDref_fil_commande, stock_initial FROM stock_fil WHERE IDref_fil_commande IN (${lineIds.join(',')})`,
    )
    for (const rr of recuRows) {
      const lid = Number(rr.IDref_fil_commande)
      recuByLine.set(lid, (recuByLine.get(lid) ?? 0) + (Number(rr.stock_initial) || 0))
    }
  }

  const cmdIds = Array.from(new Set(cmdRows.map((r) => Number(r.IDcommande_fil)).filter((x) => x > 0)))
  const cmdFournisseur = new Map<number, number>()
  if (cmdIds.length > 0) {
    const headerRows = await query<{ IDcommande_fil: number; IDfournisseur: number }>(
      `SELECT IDcommande_fil, IDfournisseur FROM commande_fil WHERE IDcommande_fil IN (${cmdIds.join(',')})`,
    )
    for (const h of headerRows) cmdFournisseur.set(Number(h.IDcommande_fil), Number(h.IDfournisseur) || 0)
  }

  // Resolve fournisseur names with a flat query + fixEncoding (names are
  // accented; a JOIN + CONVERT would collapse the result set on the bridge).
  const frsIds = Array.from(new Set([
    ...stockRows.map((r) => Number(r.IDfournisseur)).filter((x) => x > 0),
    ...Array.from(cmdFournisseur.values()).filter((x) => x > 0),
  ]))
  const frsName = new Map<number, string>()
  if (frsIds.length > 0) {
    const frsRows = await query<{ IDfournisseur: number; nom: string | null }>(
      `SELECT IDfournisseur, nom FROM fournisseur WHERE IDfournisseur IN (${frsIds.join(',')})`,
    )
    for (const f of await fixEncoding(frsRows as any[], 'fournisseur', 'IDfournisseur', ['nom'])) {
      frsName.set(Number((f as any).IDfournisseur), ((f as any).nom ?? '').toString().trim())
    }
  }

  const en_stock_rows = stockRows.map((r) => ({
    lot: (r.lot ?? '').toString().trim() || '—',
    fournisseur: frsName.get(Number(r.IDfournisseur)) || '—',
    kg: Number(r.stock) || 0,
  }))
  const commande_rows = cmdRows.map((r) => {
    const ordered = Number(r.quantite) || 0
    const recu = recuByLine.get(Number(r.IDref_fil_commande)) ?? 0
    const reste = Math.max(0, ordered - recu)
    return {
      commande: Number(r.IDcommande_fil) || 0,
      fournisseur: frsName.get(cmdFournisseur.get(Number(r.IDcommande_fil)) ?? 0) || '—',
      ordered,
      recu,
      kg: reste,
    }
  })
  // Outstanding quantity still to receive — gross ordered minus what's landed.
  const commande = commande_rows.reduce((s, r) => s + r.kg, 0)

  // Besoin — yarn reserved on OPEN tricoteur lines, MINUS what their OFs
  // already knitted (LIVA #1139: visitage decrements stock_fil.stock at
  // every pesage while the reservation never moves, so a knitted kilo was
  // subtracted twice). The arithmetic lives in lib/fil-etat-besoin.ts; this
  // block only walks the chain sst line → TRM mirror line → OF → pieces.
  // All-ASCII columns, no CONVERT → the JOINs are bridge-safe. Lots are ASCII.
  const besoinRows = await query<{ ligne: number; cmd_sst: number; lot: string | null; quantite: number | null }>(
    `SELECT a.IDligne_commande_sous_traitant AS ligne, cst.IDcommande_sous_traitant AS cmd_sst,
            sf.lot AS lot, a.quantite AS quantite
     FROM asso_fil_lignecmdsst a
     JOIN stock_fil sf ON a.IDstock_fil = sf.IDstock_fil
     JOIN ligne_commande_sous_traitant lcs ON a.IDligne_commande_sous_traitant = lcs.IDligne_commande_sous_traitant
     JOIN commande_sous_traitant cst ON lcs.IDcommande_sous_traitant = cst.IDcommande_sous_traitant
     WHERE sf.IDref_fil = ${refFil} AND sf.IDcolori_fil = ${coloriFil} AND cst.est_soldee = 0
     ORDER BY a.IDasso_fil_ligneCmdSST`,
  )
  const asso: AssoRow[] = besoinRows.map((r) => ({
    ligne: Number(r.ligne) || 0,
    commande_sst: Number(r.cmd_sst) || 0,
    lot: (r.lot ?? '').toString(),
    quantite: Number(r.quantite) || 0,
  }))
  // The other way round (LIVA #1159): open Tricotage Malterre lines whose
  // OFs already consume this fil (`asso_fil_of`) with NO affectation on it —
  // the OF dialog picks its lots on its own, so the reservation step is
  // routinely skipped. Walked from the OF end: asso_fil_of → OF → TRM line
  // → mirror sst line → open commande. computeBesoin derives their reserve.
  const lineRows = await query<{ ligne: number; cmd_sst: number; quantite: number | null }>(
    `SELECT DISTINCT lcs.IDligne_commande_sous_traitant AS ligne, cst.IDcommande_sous_traitant AS cmd_sst,
            lcs.quantite AS quantite
     FROM asso_fil_of a
     JOIN stock_fil sf ON a.IDstock_fil = sf.IDstock_fil
     JOIN ordre_fabrication o ON a.IDordre_fabrication = o.IDordre_fabrication
     JOIN ligne_commande_client l ON o.IDligne_commande_client = l.IDligne_commande_client
     JOIN ligne_commande_sous_traitant lcs ON l.IDligne_commande_ETM = lcs.IDligne_commande_sous_traitant
     JOIN commande_sous_traitant cst ON lcs.IDcommande_sous_traitant = cst.IDcommande_sous_traitant
     WHERE sf.IDref_fil = ${refFil} AND sf.IDcolori_fil = ${coloriFil} AND cst.est_soldee = 0`,
  )
  const lines: LineRow[] = lineRows.map((r) => ({
    ligne: Number(r.ligne) || 0,
    commande_sst: Number(r.cmd_sst) || 0,
    quantite: Number(r.quantite) || 0,
  }))
  const sstLineIds = Array.from(new Set([...asso.map((a) => a.ligne), ...lines.map((l) => l.ligne)].filter((x) => x > 0)))
  let mirrors: MirrorLine[] = []
  let ofs: OfRow[] = []
  let pieces: PieceRow[] = []
  let ofFil: OfFilRow[] = []
  if (sstLineIds.length > 0) {
    mirrors = (await query<MirrorLine>(
      `SELECT IDligne_commande_client, IDligne_commande_ETM FROM ligne_commande_client
       WHERE IDligne_commande_ETM IN (${sstLineIds.join(',')})`,
    )).map((m) => ({ IDligne_commande_client: Number(m.IDligne_commande_client) || 0, IDligne_commande_ETM: Number(m.IDligne_commande_ETM) || 0 }))
    const trmLineIds = mirrors.map((m) => m.IDligne_commande_client).filter((x) => x > 0)
    if (trmLineIds.length > 0) {
      ofs = (await query<OfRow>(
        `SELECT IDordre_fabrication, IDligne_commande_client, quantite FROM ordre_fabrication
         WHERE IDligne_commande_client IN (${trmLineIds.join(',')})`,
      )).map((o) => ({
        IDordre_fabrication: Number(o.IDordre_fabrication) || 0,
        IDligne_commande_client: Number(o.IDligne_commande_client) || 0,
        quantite: Number(o.quantite) || 0,
      }))
      const ofIds = ofs.map((o) => o.IDordre_fabrication).filter((x) => x > 0)
      if (ofIds.length > 0) {
        // Every roll counts, déclassés included — that is what visitage
        // decremented. No IDsociete filter: shipping to ETM re-homes the piece.
        pieces = (await query<PieceRow>(
          `SELECT IDordre_fabrication, poids FROM stock_ecru WHERE IDordre_fabrication IN (${ofIds.join(',')})`,
        )).map((p) => ({ IDordre_fabrication: Number(p.IDordre_fabrication) || 0, poids: Number(p.poids) || 0 }))
        ofFil = (await query<{ IDordre_fabrication: number; pourcentage: number | null; lot: string | null }>(
          `SELECT a.IDordre_fabrication, a.pourcentage, sf.lot FROM asso_fil_of a
           JOIN stock_fil sf ON a.IDstock_fil = sf.IDstock_fil
           WHERE a.IDordre_fabrication IN (${ofIds.join(',')})
             AND sf.IDref_fil = ${refFil} AND sf.IDcolori_fil = ${coloriFil}`,
        )).map((f) => ({
          IDordre_fabrication: Number(f.IDordre_fabrication) || 0,
          pourcentage: Number(f.pourcentage) || 0,
          lot: (f.lot ?? '').toString(),
        }))
      }
    }
  }
  const calc = computeBesoin({ asso, mirrors, ofs, pieces, ofFil, lines })
  const besoin_rows: (BesoinRow & { commande_client?: number })[] = calc.rows
  let { besoin, reserve: besoin_reserve } = calc
  const besoin_produit = calc.produit

  // Yarn reserved for client order lines before any knitting order holds it (lib/reservation-fil.ts):
  // on a supplier order or on a received lot.
  // Once a knitting order holds it as an asso row it is counted above — never twice.
  const resas = (await reservationsDuFil(refFil, coloriFil)).filter((r) => compteDansReserve(etatReservation(r)))
  if (resas.length > 0) {
    const numeros = new Map((await mpsPg()<{ lid: number; numero: number }[]>`
      SELECT l.idligne_commande_client AS lid, c.numero FROM ligne_commande_client l
        JOIN commande_client c ON c.idcommande_client = l.idcommande_client
       WHERE l.idligne_commande_client IN ${mpsPg()(resas.map((r) => r.idligne_commande_client))}`)
      .map((r) => [Number(r.lid), Number(r.numero)]))
    const lots = new Map((await mpsPg()<{ id: number; lot: string | null }[]>`
      SELECT idstock_fil AS id, lot FROM stock_fil WHERE idstock_fil IN ${mpsPg()([0, ...resas.map((r) => r.idstock_fil)])}`)
      .map((r) => [Number(r.id), String(r.lot ?? '').trim()]))
    for (const r of resas) {
      const kg = Number(r.quantite) || 0
      besoin_rows.push({
        commande_sst: r.idligne_commande_sous_traitant, ligne: 0,
        lot: r.idstock_fil > 0 ? (lots.get(r.idstock_fil) || '—') : 'en commande',
        reserve: kg, produit: 0, suivi: false, kg, source: 'reservation',
        commande_client: numeros.get(r.idligne_commande_client) ?? 0,
      })
      besoin += kg
      besoin_reserve += kg
    }
    besoin = Math.round(besoin * 10) / 10
    besoin_reserve = Math.round(besoin_reserve * 10) / 10
  }
  const nb_affectations = besoin_rows.length

  return {
    ref_fil: refFil,
    colori_fil: coloriFil,
    en_stock,
    nb_lots,
    en_stock_rows,
    commande,
    nb_commandes,
    commande_rows,
    besoin,
    besoin_reserve,
    besoin_produit,
    nb_affectations,
    besoin_rows,
    disponible: en_stock + commande - besoin,
  }
}

export type EtatFil = Awaited<ReturnType<typeof calculerEtatFil>>
