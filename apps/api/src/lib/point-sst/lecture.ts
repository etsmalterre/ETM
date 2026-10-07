// Point sous-traitant — reads the facts regles.ts decides on, for one dyer.
// Native PostgreSQL (lib/mps-pg.ts): flat queries, merged in JS.

import { mpsPg } from '../mps-pg.js'
import { plusJours, type LigneFait } from './regles.js'

/** Lots received this long ago or less are still asked about (§2). */
const CONTROLE_FENETRE_J = 45
/** Lot states still open: 1 En contrôle, 2 En reprise, 5 Attente de décision (3 Validé, 4 Expédié). */
const LOT_OUVERT = [1, 2, 5]
const LOT_EN_REPRISE = 2
/** envoi_email.IDtype_doc of a soumission lot client (sous_traitants_status_model.md). */
const TYPE_DOC_SOUMISSION = 15

/** Dates come from SQL as to_char(…, 'YYYY-MM-DD'): no time zone parsing anywhere. */
const iso = (d: unknown): string | null => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null)

export async function lireFaits(idsousTraitant: number, jour: string): Promise<{ lignes: LigneFait[] }> {
  const sql = mpsPg()
  const depuis = plusJours(jour, -365)
  const lignesRows = await sql<{ idcommande: number; idligne: number; idcommande_client: number | null; sstatut: string | null; date_livraison: string | null; relance: string | null; quantite: number; reference: string; coloris: string }[]>`
    SELECT c.idcommande_sous_traitant AS idcommande, l.idligne_commande_sous_traitant AS idligne, c.idcommande_client,
           to_char(COALESCE(l.date_notif, c.date_notif), 'YYYY-MM-DD') AS relance,
           l.sstatut::text AS sstatut, to_char(l.date_livraison, 'YYYY-MM-DD') AS date_livraison, COALESCE(l.quantite, 0) AS quantite,
           COALESCE(rf.reference, '') AS reference,
           COALESCE(CASE WHEN COALESCE(rf.avec_teinture, 1) = 0 THEN ce.reference ELSE COALESCE(rfc.reference, ce.reference) END, '') AS coloris
    FROM commande_sous_traitant c
    JOIN ligne_commande_sous_traitant l ON l.idcommande_sous_traitant = c.idcommande_sous_traitant
    LEFT JOIN ref_fini rf ON rf.idref_fini = l.idreference
    LEFT JOIN ref_fini_colori rfc ON rfc.idref_fini_colori = l.idcoloris AND COALESCE(rf.avec_teinture, 1) <> 0
    LEFT JOIN colori_ecru ce ON ce.idcolori_ecru = l.idcoloris AND COALESCE(rf.avec_teinture, 1) = 0
    WHERE c.idsous_traitant = ${idsousTraitant}
      AND COALESCE(c.est_soldee, 0) = 0
      AND l.type = 2
      AND COALESCE(l.sstatut::text, '') NOT LIKE 'Termin%'
      AND c.date_commande >= ${depuis}::date`
  const lignes = lignesRows.map((r) => ({ ...r, idcommande: Number(r.idcommande), idligne: Number(r.idligne), idcommande_client: Number(r.idcommande_client) || 0 }))
  if (lignes.length === 0) return { lignes: [] }

  const idsLigne = lignes.map((l) => l.idligne)
  const idsCommande = [...new Set(lignes.map((l) => l.idcommande))]

  const [recus, lots, soumis, clientsEntete, clientsPieces] = await Promise.all([
    sql<{ idligne: number; n: number; metrage: number; dernier: unknown }[]>`
      SELECT idref_commande_source AS idligne, COUNT(*)::int AS n, COALESCE(SUM(metrage), 0)::float AS metrage, to_char(MAX(date_saisie), 'YYYY-MM-DD') AS dernier
      FROM stock_fini WHERE idref_commande_source IN ${sql(idsLigne)} GROUP BY idref_commande_source`,
    sql<{ idligne: number; lot: string; etat: number; sans_mesures: boolean; recent: boolean }[]>`
      SELECT idligne_commande_sous_traitant AS idligne, lot, idetatlot::int AS etat,
             (COALESCE(laize_sst, 0) = 0 OR COALESCE(poids_sst, 0) = 0) AS sans_mesures,
             (date >= ${plusJours(jour, -CONTROLE_FENETRE_J)}::date) AS recent
      FROM suivilot
      WHERE idligne_commande_sous_traitant IN ${sql(idsLigne)} AND idetatlot IN ${sql(LOT_OUVERT)}
      ORDER BY lot`,
    sql<{ idcommande: number; dernier: unknown }[]>`
      SELECT idreference AS idcommande, to_char(MAX(date), 'YYYY-MM-DD') AS dernier FROM envoi_email
      WHERE idtype_doc = ${TYPE_DOC_SOUMISSION} AND idreference IN ${sql(idsCommande)} GROUP BY idreference`,
    // The client: the sst header when it was launched from a client line…
    sql<{ idcommande_client: number; idclient: number }[]>`
      SELECT idcommande_client, idclient FROM commande_client
      WHERE idcommande_client IN ${sql([0, ...lignes.map((l) => l.idcommande_client).filter((x) => x > 0)])}`,
    // …else through the écru handed to the dyer for the line (#1249: the header is often 0).
    sql<{ idligne: number; idclient: number }[]>`
      SELECT DISTINCT se.idref_commande_affectation AS idligne, cc.idclient
      FROM stock_ecru se
      JOIN ligne_commande_client lcc ON lcc.idligne_commande_client = se.idligne_commande_client
      JOIN commande_client cc ON cc.idcommande_client = lcc.idcommande_client
      WHERE se.idref_commande_affectation IN ${sql(idsLigne)} AND se.idligne_commande_client > 0`,
  ])

  const clientsParLigne = new Map<number, Set<number>>()
  const ajouterClient = (idligne: number, idclient: number) => {
    if (!(idclient > 0)) return
    const s = clientsParLigne.get(idligne) ?? new Set<number>()
    s.add(idclient)
    clientsParLigne.set(idligne, s)
  }
  const clientDeCommande = new Map(clientsEntete.map((r) => [Number(r.idcommande_client), Number(r.idclient)]))
  for (const l of lignes) ajouterClient(l.idligne, clientDeCommande.get(l.idcommande_client) ?? 0)
  for (const r of clientsPieces) ajouterClient(Number(r.idligne), Number(r.idclient))

  const tousClients = [...new Set([...clientsParLigne.values()].flatMap((s) => [...s]))]
  const clientsSoumission = new Set<number>(
    tousClients.length === 0 ? [] : (await sql<{ idclient: number }[]>`
      SELECT DISTINCT idclient FROM contact
      WHERE idclient IN ${sql(tousClients)} AND COALESCE(envoi_soumission, 0) = 1 AND COALESCE(est_visible, 1) = 1`).map((r) => Number(r.idclient)),
  )

  const recuParLigne = new Map(recus.map((r) => [Number(r.idligne), r]))
  const soumisParCommande = new Map(soumis.map((r) => [Number(r.idcommande), iso(r.dernier)]))
  // §2: received recently, dyer measures missing, not in reprise. §5: in reprise (état 2), whatever its age.
  // Received recently WITH the measures, still open: the next step is ours (§3 is not asked).
  const sansControle = new Map<number, string[]>()
  const aControler = new Map<number, string[]>()
  const enReprise = new Map<number, string[]>()
  const ranger = (m: Map<number, string[]>, idligne: number, lot: string) => {
    const a = m.get(idligne) ?? []
    if (!a.includes(lot)) a.push(lot)
    m.set(idligne, a)
  }
  for (const r of lots) {
    const lot = String(r.lot ?? '').trim()
    if (!lot) continue
    if (Number(r.etat) === LOT_EN_REPRISE) ranger(enReprise, Number(r.idligne), lot)
    else if (r.sans_mesures && r.recent) ranger(sansControle, Number(r.idligne), lot)
    else if (r.recent) ranger(aControler, Number(r.idligne), lot)
  }

  const faits: LigneFait[] = lignes.map((l) => {
    const recu = recuParLigne.get(l.idligne)
    const dernierSoumis = soumisParCommande.get(l.idcommande) ?? null
    const clients = clientsParLigne.get(l.idligne) ?? new Set<number>()
    return {
      idcommande: l.idcommande,
      idligne: l.idligne,
      reference: String(l.reference ?? '').trim(),
      coloris: String(l.coloris ?? '').trim(),
      sstatut: String(l.sstatut ?? ''),
      dateLivraison: iso(l.date_livraison),
      quantite: Number(l.quantite) || 0,
      nbRecus: Number(recu?.n ?? 0),
      metrageRecu: Number(recu?.metrage ?? 0),
      dernierRecu: iso(recu?.dernier),
      dernierSoumis,
      clientSoumission: !!dernierSoumis || [...clients].some((c) => clientsSoumission.has(c)),
      lotsSansControle: sansControle.get(l.idligne) ?? [],
      lotsEnReprise: enReprise.get(l.idligne) ?? [],
      lotsAControler: aControler.get(l.idligne) ?? [],
      relance: iso(l.relance),
    }
  })
  return { lignes: faits }
}

