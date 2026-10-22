// Sous-traitants › Commandes, Info tab « Affectations »: for whom the matter of
// a sst order is meant — which client(s), or stock.
//
// The order header cannot say it: `commande_sous_traitant.IDcommande_client` is
// set only when the order was launched from a client line (#1249), and a line
// carries no client pointer at all. The answer is in the PIECES:
//   · ennoblisseur / écru lines: the écru handed to the dyer
//     (`stock_ecru.IDref_commande_affectation`) still undyed, plus the fini rolls
//     received back (`stock_fini.IDref_commande_source`) — a dyed écru is read
//     through its fini roll, never twice (consumedEcruIds);
//   · tricoteur lines: the écru knitted for the line (`IDref_commande_source`);
//   · rectiligne lines: no roll, nothing to read.
// A piece reserved to a client line (`IDligne_commande_client`) is that
// client's; a donated piece is « don »; any other is stock. An order with no
// piece yet falls back on its header's client, else it is for stock.

import { mpsPg } from './mps-pg.js'
import { consumedEcruIds } from './fini-sources.js'

export type DestinationKind = 'client' | 'stock' | 'don'

export interface AffectationSst {
  kind: DestinationKind
  IDclient: number
  nom: string
  commandes: Array<{ IDcommande_client: number; numero: string | null }>
  pieces: number
  poids: number
  metrage: number
}

export interface PieceDestination {
  idligneCommandeClient: number
  donation: boolean
  poids: number
  metrage: number
}

/** Pure: groups the pieces by destination. `clientDeLigne` maps a client line to
 *  its order + client; a line it does not know (deleted) counts as stock. */
export function grouperAffectations(
  pieces: readonly PieceDestination[],
  clientDeLigne: ReadonlyMap<number, { IDcommande_client: number; numero: string | null; IDclient: number; nom: string }>,
): AffectationSst[] {
  const out = new Map<string, AffectationSst>()
  const get = (key: string, init: () => AffectationSst) => {
    let a = out.get(key)
    if (!a) { a = init(); out.set(key, a) }
    return a
  }
  for (const p of pieces) {
    const c = p.donation ? undefined : clientDeLigne.get(p.idligneCommandeClient)
    const a = p.donation
      ? get('don', () => ({ kind: 'don', IDclient: 0, nom: 'Don', commandes: [], pieces: 0, poids: 0, metrage: 0 }))
      : c
        ? get(`c${c.IDclient}`, () => ({ kind: 'client', IDclient: c.IDclient, nom: c.nom, commandes: [], pieces: 0, poids: 0, metrage: 0 }))
        : get('stock', () => ({ kind: 'stock', IDclient: 0, nom: 'Stock', commandes: [], pieces: 0, poids: 0, metrage: 0 }))
    if (c && !a.commandes.some((x) => x.IDcommande_client === c.IDcommande_client)) {
      a.commandes.push({ IDcommande_client: c.IDcommande_client, numero: c.numero })
    }
    a.pieces += 1
    a.poids += p.poids
    a.metrage += p.metrage
  }
  const rang: Record<DestinationKind, number> = { client: 0, don: 1, stock: 2 }
  const list = [...out.values()]
  for (const a of list) a.commandes.sort((x, y) => (x.numero ?? '').localeCompare(y.numero ?? '', 'fr', { numeric: true }))
  // Clients first, the biggest share first; then don, then stock.
  return list.sort((a, b) => rang[a.kind] - rang[b.kind] || b.poids - a.poids || a.nom.localeCompare(b.nom, 'fr'))
}

export async function affectationsCommandeSst(idCommande: number, idCommandeClientEntete: number): Promise<AffectationSst[]> {
  const sql = mpsPg()
  const lignes = await sql<{ id: number; type: number }[]>`
    SELECT idligne_commande_sous_traitant AS id, COALESCE(type, 0)::int AS type
    FROM ligne_commande_sous_traitant WHERE idcommande_sous_traitant = ${idCommande}`
  const tricot = lignes.filter((l) => l.type === 1).map((l) => Number(l.id))
  const affect = lignes.filter((l) => l.type !== 1 && l.type !== 4).map((l) => Number(l.id))
  const toutes = lignes.map((l) => Number(l.id))

  type Row = { id: number; lcc: number; don: number; poids: number; metrage: number }
  const [ecruAffecte, ecruTricote, fini] = await Promise.all([
    affect.length === 0 ? [] as Row[] : sql<Row[]>`
      SELECT idstock_ecru AS id, COALESCE(idligne_commande_client, 0)::int AS lcc, COALESCE(idcommande_donation, 0)::int AS don,
             COALESCE(poids, 0)::float AS poids, COALESCE(metrage, 0)::float AS metrage
      FROM stock_ecru WHERE idref_commande_affectation = ANY(${affect})`,
    tricot.length === 0 ? [] as Row[] : sql<Row[]>`
      SELECT idstock_ecru AS id, COALESCE(idligne_commande_client, 0)::int AS lcc, COALESCE(idcommande_donation, 0)::int AS don,
             COALESCE(poids, 0)::float AS poids, COALESCE(metrage, 0)::float AS metrage
      FROM stock_ecru WHERE idref_commande_source = ANY(${tricot})`,
    toutes.length === 0 ? [] as Row[] : sql<Row[]>`
      SELECT idstock_fini AS id, COALESCE(idligne_commande_client, 0)::int AS lcc, COALESCE(idcommande_donation, 0)::int AS don,
             COALESCE(poids, 0)::float AS poids, COALESCE(metrage, 0)::float AS metrage
      FROM stock_fini WHERE idref_commande_source = ANY(${toutes})`,
  ])
  // A dyed écru now lives as its fini roll (own child or merged component).
  const teints = await consumedEcruIds(ecruAffecte.map((r) => Number(r.id)))
  const rows = [...ecruAffecte.filter((r) => !teints.has(Number(r.id))), ...ecruTricote, ...fini]
  const pieces: PieceDestination[] = rows.map((r) => ({
    idligneCommandeClient: Number(r.lcc),
    donation: Number(r.don) > 0,
    poids: Number(r.poids) || 0,
    metrage: Number(r.metrage) || 0,
  }))

  const lccIds = [...new Set(pieces.map((p) => p.idligneCommandeClient).filter((x) => x > 0))]
  const clientDeLigne = new Map<number, { IDcommande_client: number; numero: string | null; IDclient: number; nom: string }>()
  const lireCommandes = async (where: 'ligne' | 'entete', ids: number[]) => {
    if (ids.length === 0) return [] as { lcc: number; cc: number; numero: string | null; idclient: number; nom: string | null }[]
    return where === 'ligne'
      ? sql<{ lcc: number; cc: number; numero: string | null; idclient: number; nom: string | null }[]>`
          SELECT lcc.idligne_commande_client AS lcc, cc.idcommande_client AS cc, cc.numero::text AS numero, cl.idclient, cl.nom
          FROM ligne_commande_client lcc
          JOIN commande_client cc ON cc.idcommande_client = lcc.idcommande_client
          JOIN client cl ON cl.idclient = cc.idclient
          WHERE lcc.idligne_commande_client = ANY(${ids})`
      : sql<{ lcc: number; cc: number; numero: string | null; idclient: number; nom: string | null }[]>`
          SELECT 0 AS lcc, cc.idcommande_client AS cc, cc.numero::text AS numero, cl.idclient, cl.nom
          FROM commande_client cc JOIN client cl ON cl.idclient = cc.idclient
          WHERE cc.idcommande_client = ANY(${ids})`
  }
  for (const r of await lireCommandes('ligne', lccIds)) {
    clientDeLigne.set(Number(r.lcc), { IDcommande_client: Number(r.cc), numero: r.numero, IDclient: Number(r.idclient), nom: (r.nom ?? '').trim() })
  }
  if (pieces.length > 0) return grouperAffectations(pieces, clientDeLigne)

  // No piece yet: the header's client when the order was launched from a client line.
  const [entete] = await lireCommandes('entete', idCommandeClientEntete > 0 ? [idCommandeClientEntete] : [])
  if (entete) {
    return [{
      kind: 'client', IDclient: Number(entete.idclient), nom: (entete.nom ?? '').trim(),
      commandes: [{ IDcommande_client: Number(entete.cc), numero: entete.numero }], pieces: 0, poids: 0, metrage: 0,
    }]
  }
  return [{ kind: 'stock', IDclient: 0, nom: 'Stock', commandes: [], pieces: 0, poids: 0, metrage: 0 }]
}
