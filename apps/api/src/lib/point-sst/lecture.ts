// Point sous-traitant — reads the facts regles.ts decides on, for one dyer.
// Native PostgreSQL (lib/mps-pg.ts): flat queries, merged in JS. The lots'
// steps are the Suivi lots cycle's (lib/cycle-ennoblissement.ts, v7): the point
// never classifies a lot on its own.

import { mpsPg } from '../mps-pg.js'
import { consumedEcruIds } from '../fini-sources.js'
import { plusJours, type LigneFait } from './regles.js'
import { echeanceDelai } from '../delai-sst.js'
import { etapeLot, lireCommandesEnnoblissement, type LotFait } from '../cycle-ennoblissement.js'

/** Lots received this long ago or less are still asked about (§2). */
const CONTROLE_FENETRE_J = 45
/** envoi_email.IDtype_doc of a soumission lot client (sous_traitants_status_model.md). */
const TYPE_DOC_SOUMISSION = 15

/** Dates come from SQL as to_char(…, 'YYYY-MM-DD'): no time zone parsing anywhere. */
const iso = (d: unknown): string | null => (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null)

export async function lireFaits(idsousTraitant: number, jour: string): Promise<{ lignes: LigneFait[] }> {
  const sql = mpsPg()
  const depuis = plusJours(jour, -365)
  const lignesRows = await sql<{ idcommande: number; idligne: number; idcommande_client: number | null; sstatut: string | null; date_livraison: string | null; quantite: number; reference: string; coloris: string }[]>`
    SELECT c.idcommande_sous_traitant AS idcommande, l.idligne_commande_sous_traitant AS idligne, c.idcommande_client,
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

  // The orders' cycle: each lot's step, and the délai question — §5 asks from the
  // délai's échéance, the card's own rule (lib/delai-sst.ts, LIVA #1314).
  const cycle = await lireCommandesEnnoblissement(idsCommande)
  const [recus, soumis, clientsEntete, clientsPieces, ecruLignes] = await Promise.all([
    sql<{ idligne: number; n: number; metrage: number; dernier: unknown }[]>`
      SELECT idref_commande_source AS idligne, COUNT(*)::int AS n, COALESCE(SUM(metrage), 0)::float AS metrage, to_char(MAX(date_saisie), 'YYYY-MM-DD') AS dernier
      FROM stock_fini WHERE idref_commande_source IN ${sql(idsLigne)} GROUP BY idref_commande_source`,
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
    // The écru handed to the dyer per line: complete once all of it came back dyed (v5).
    sql<{ idligne: number; idecru: number }[]>`
      SELECT idref_commande_affectation AS idligne, idstock_ecru AS idecru
      FROM stock_ecru WHERE idref_commande_affectation IN ${sql(idsLigne)}`,
  ])
  // « Came back » = own fini roll OR component of a merged roll: the one reader.
  const revenus = await consumedEcruIds(ecruLignes.map((r) => Number(r.idecru)))
  const ecruParLigne = new Map<number, { affectes: number; revenus: number }>()
  for (const r of ecruLignes) {
    const e = ecruParLigne.get(Number(r.idligne)) ?? { affectes: 0, revenus: 0 }
    e.affectes += 1
    if (revenus.has(Number(r.idecru))) e.revenus += 1
    ecruParLigne.set(Number(r.idligne), e)
  }

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
  // Each open lot sorted by its step on Suivi lots. A lot known only from a soumission
  // mail (no suivilot row, before LIVA #1313) belongs to every line of its order.
  const depuisControle = plusJours(jour, -CONTROLE_FENETRE_J)
  const lotsParLigne = new Map<number, Lots>()
  for (const l of lignes) {
    const lots = videLots()
    for (const lot of cycle.get(l.idcommande)?.lots ?? []) {
      if ((lot.idligne ?? 0) > 0 && lot.idligne !== l.idligne) continue
      rangerLot(lots, lot, depuisControle)
    }
    for (const a of Object.values(lots)) if (Array.isArray(a)) a.sort()
    lotsParLigne.set(l.idligne, lots)
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
      ecruAffectes: ecruParLigne.get(l.idligne)?.affectes ?? 0,
      ecruRevenus: ecruParLigne.get(l.idligne)?.revenus ?? 0,
      dernierRecu: iso(recu?.dernier),
      dernierSoumis,
      clientSoumission: !!dernierSoumis || [...clients].some((c) => clientsSoumission.has(c)),
      ...(lotsParLigne.get(l.idligne) ?? videLots()),
      relance: (() => { const f = cycle.get(l.idcommande)?.delaiFaits; return f ? echeanceDelai(f) : null })(),
    }
  })
  return { lignes: faits }
}


type Lots = Pick<LigneFait, 'lotsSansControle' | 'lotsAControler' | 'lotsEnReprise' | 'repriseTeinture' | 'lotsColorisSoumis' | 'lotsColorisValide' | 'lotsReteinture'>

const videLots = (): Lots => ({
  lotsSansControle: [], lotsAControler: [], lotsEnReprise: [], repriseTeinture: false,
  lotsColorisSoumis: [], lotsColorisValide: [], lotsReteinture: [],
})

/** One lot into the point's lists, by its Suivi lots step (etapeLot). §2 / « ours to
 *  control » keep their window: a lot received more than CONTROLE_FENETRE_J days ago
 *  is no longer asked about. */
export function rangerLot(lots: Lots, lot: LotFait, depuisControle: string): void {
  const nom = lot.lot.trim()
  if (!nom) return
  const ajouter = (a: string[]) => { if (!a.includes(nom)) a.push(nom) }
  switch (etapeLot(lot)) {
    case 'valide': return
    case 'en_reprise':
      ajouter(lots.lotsEnReprise)
      if (lot.repriseNature === 'teinture') lots.repriseTeinture = true
      return
    case 'coloris_soumis': return ajouter(lots.lotsColorisSoumis)
    case 'reteinture': return ajouter(lots.lotsReteinture)
    case 'ok_ramer_a_envoyer':
    case 'en_rame': return ajouter(lots.lotsColorisValide)
    default:
      if (!lot.reception || lot.reception < depuisControle) return
      ajouter(lot.mesuresTeinturier ? lots.lotsAControler : lots.lotsSansControle)
  }
}
