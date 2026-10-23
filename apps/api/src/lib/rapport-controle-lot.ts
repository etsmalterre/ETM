// Rapport de contrôle (RC) — sent per LOT and per CLIENT from Qualité › Suivi
// lots (LIVA #1304, decision Vincent 2026-10-22). It used to ride on the BL
// email of every shipment of a client switched « inclure rapports contrôle »;
// it now leaves once the lot is controlled, to the client its pieces are
// affected to, and holds only that client's pieces.
//
// Rules:
//  - A lot can be reported to a client only through its fini rolls affected to
//    one of that client's orders (stock_fini.IDligne_commande_client). A lot
//    with no affected roll offers no RC.
//  - A client switched « rapport de contrôle » (client.inclureRapportQualite)
//    is OWED one while it holds pieces of the lot not shipped yet and has had
//    no RC for the lot since the lot's last return from reprise (the measures
//    changed). Owed RCs block « Valider le lot » (lib/cycle-ennoblissement.ts);
//    on an already validated lot they are a task, the lot never goes back.
//  - Pieces already shipped are past: shipments before 2026-10-22 carried the
//    RC on their BL, and only a « Validé » roll ships (#1235).
//  - Any other client of the lot may be sent one by hand; never owed.
//  - A client DISPENSED of the lot's RC (rapport_controle_dispense, migration
//    0034, why required) is never owed one for it.
// Every send is a row of rapport_controle_envoi (migration 0029), append-only.

import { mpsPg } from './mps-pg.js'
import { faitsReprises } from './reprises.js'
import type { RapportControlePdfData } from './pdf/RapportControlePdf.js'

export interface ClientDuLot {
  idclient: number
  nom: string
  /** client.inclureRapportQualite = 1 */
  rcActif: boolean
  /** Rolls of the lot affected to this client (donations excluded). */
  pieces: number
  /** …of which not shipped yet. */
  piecesNonExpediees: number
  /** Last RC sent to this client for the lot, 'YYYY-MM-DD HH:MM' (Paris), any date. */
  dernierEnvoi: string | null
  /** Why the client is dispensed of this lot's RC, or null. */
  dispense: string | null
  /** An RC is owed (see the rules above). */
  du: boolean
}

export const cleLotLigne = (ligne: number, lot: string) => `${ligne}:${lot.trim()}`

/** The clients of each (sst line, lot), keyed by cleLotLigne(). */
export async function clientsDesLots(lots: Array<{ ligne: number; lot: string }>): Promise<Map<string, ClientDuLot[]>> {
  const out = new Map<string, ClientDuLot[]>()
  const voulus = new Set(lots.filter((l) => l.ligne > 0 && l.lot.trim()).map((l) => cleLotLigne(l.ligne, l.lot)))
  if (voulus.size === 0) return out
  const lignes = [...new Set(lots.map((l) => l.ligne).filter((x) => x > 0))]
  const sql = mpsPg()

  const [rouleaux, envois, reprises, dispenses] = await Promise.all([
    sql<{ ligne: number; lot: string; idclient: number; nom: string | null; rc: number; expedie: boolean }[]>`
      SELECT sf.idref_commande_source AS ligne, trim(sf.lot::text) AS lot, cc.idclient, c.nom::text AS nom,
             COALESCE(c.inclurerapportqualite, 0)::int AS rc,
             COALESCE(sf.idligne_expedition, 0) > 0 AS expedie
      FROM stock_fini sf
      JOIN ligne_commande_client lcc ON lcc.idligne_commande_client = sf.idligne_commande_client
      JOIN commande_client cc ON cc.idcommande_client = lcc.idcommande_client
      JOIN client c ON c.idclient = cc.idclient
      WHERE sf.idref_commande_source = ANY(${lignes}) AND sf.idligne_commande_client > 0
        AND COALESCE(sf.idcommande_donation, 0) = 0`,
    sql<{ ligne: number; lot: string; idclient: number; dernier: string; jour: string }[]>`
      SELECT idligne_commande_sous_traitant AS ligne, lot, idclient,
             to_char(max(envoye_le) AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD HH24:MI') AS dernier,
             to_char(max(envoye_le) AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS jour
      FROM rapport_controle_envoi WHERE idligne_commande_sous_traitant = ANY(${lignes})
      GROUP BY 1, 2, 3`,
    faitsReprises(lignes),
    sql<{ ligne: number; lot: string; idclient: number; motif: string }[]>`
      SELECT idligne_commande_sous_traitant AS ligne, lot, idclient, motif
      FROM rapport_controle_dispense WHERE idligne_commande_sous_traitant = ANY(${lignes})`,
  ])

  const envoiPar = new Map(envois.map((e) => [`${cleLotLigne(Number(e.ligne), e.lot)}:${Number(e.idclient)}`, e]))
  const dispensePar = new Map(dispenses.map((d) => [`${cleLotLigne(Number(d.ligne), d.lot)}:${Number(d.idclient)}`, d.motif]))
  const parCle = new Map<string, Map<number, ClientDuLot>>()
  for (const r of rouleaux) {
    const cle = cleLotLigne(Number(r.ligne), r.lot ?? '')
    if (!voulus.has(cle)) continue
    const clients = parCle.get(cle) ?? new Map<number, ClientDuLot>()
    parCle.set(cle, clients)
    const id = Number(r.idclient)
    const c = clients.get(id) ?? {
      idclient: id, nom: (r.nom ?? '').trim(), rcActif: Number(r.rc) === 1,
      pieces: 0, piecesNonExpediees: 0, dernierEnvoi: null, dispense: null, du: false,
    }
    c.pieces++
    if (!r.expedie) c.piecesNonExpediees++
    clients.set(id, c)
  }
  for (const [cle, clients] of parCle) {
    const retour = reprises.get(cle)?.dernierRetour ?? null
    const liste = [...clients.values()].map((c) => {
      const envoi = envoiPar.get(`${cle}:${c.idclient}`)
      // An RC sent before the lot came back from reprise reported the old dye.
      const valable = envoi && (!retour || envoi.jour >= retour)
      const dispense = dispensePar.get(`${cle}:${c.idclient}`) ?? null
      return { ...c, dernierEnvoi: envoi?.dernier ?? null, dispense, du: c.rcActif && c.piecesNonExpediees > 0 && !valable && !dispense }
    })
    out.set(cle, liste.sort((a, b) => a.nom.localeCompare(b.nom, 'fr')))
  }
  return out
}

// ── The document ────────────────────────────────────────

const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
const nul0 = (v: unknown): number | null => (Number(v) ? Number(v) : null)

export interface RapportControleLot {
  data: RapportControlePdfData
  idsuivilot: number
  ligne: number
  lot: string
  idclient: number
  clientNom: string
  /** The client's rolls the report lists (stock_fini ids). */
  pieces: number[]
  /** The client's order ref (commande_client.ref_client), for the email. */
  refClient: string | null
  reference: string
}

/** The RC of one lot for one client: the lot's tirelle measures against the
 *  reference's tolerances, and the client's pieces only. null = the lot is
 *  unknown or the client holds none of its pieces. */
export async function rapportControleLot(idsuivilot: number, idclient: number): Promise<RapportControleLot | null> {
  const sql = mpsPg()
  const [s] = await sql<{
    ligne: number; lot: string; idref_fini: number; idref_fini_colori: number; idcoloris: number
    laize: number; poids: number; stabh: number; stabl: number
  }[]>`
    SELECT idligne_commande_sous_traitant AS ligne, trim(lot::text) AS lot, COALESCE(idref_fini, 0) AS idref_fini,
           COALESCE(idref_fini_colori, 0) AS idref_fini_colori, COALESCE(idcoloris, 0) AS idcoloris,
           COALESCE(laize_tirelle, 0) AS laize, COALESCE(poids_tirelle, 0) AS poids,
           COALESCE(stabh_tirelle, 0) AS stabh, COALESCE(stabl_tirelle, 0) AS stabl
    FROM suivilot WHERE idsuivilot = ${idsuivilot}`
  if (!s || !(Number(s.ligne) > 0) || !s.lot) return null

  const rouleaux = await sql<{ id: number; numero: string | null; poids: number; metrage: number; numero_cc: string | null; ref_client: string | null; nom: string | null }[]>`
    SELECT sf.idstock_fini AS id, sf.numero::text AS numero, COALESCE(sf.poids, 0) AS poids, COALESCE(sf.metrage, 0) AS metrage,
           cc.numero::text AS numero_cc, cc.ref_client::text AS ref_client, c.nom::text AS nom
    FROM stock_fini sf
    JOIN ligne_commande_client lcc ON lcc.idligne_commande_client = sf.idligne_commande_client
    JOIN commande_client cc ON cc.idcommande_client = lcc.idcommande_client
    JOIN client c ON c.idclient = cc.idclient
    WHERE sf.idref_commande_source = ${Number(s.ligne)} AND trim(sf.lot::text) = ${s.lot}
      AND cc.idclient = ${idclient} AND COALESCE(sf.idcommande_donation, 0) = 0
    ORDER BY sf.numero, sf.idstock_fini`
  if (rouleaux.length === 0) return null

  const [rf] = Number(s.idref_fini) > 0
    ? await sql<{ reference: string | null; designation: string | null; avec_teinture: number; lmin: number; lmax: number; pmin: number; pmax: number; sh: number; sl: number }[]>`
        SELECT reference::text AS reference, designation::text AS designation, COALESCE(avec_teinture, 0) AS avec_teinture,
               laizeht_min AS lmin, laizeht_max AS lmax, poids_min AS pmin, poids_max AS pmax,
               stab_hauteur AS sh, stab_largeur AS sl
        FROM ref_fini WHERE idref_fini = ${Number(s.idref_fini)}`
    : []
  // A fini's coloris lives in ref_fini_colori when dyed, in colori_ecru when only washed (#1158).
  const [col] = Number(rf?.avec_teinture) > 0
    ? (Number(s.idref_fini_colori) > 0
        ? await sql<{ reference: string | null }[]>`SELECT reference::text AS reference FROM ref_fini_colori WHERE idref_fini_colori = ${Number(s.idref_fini_colori)}`
        : [])
    : (Number(s.idcoloris) > 0
        ? await sql<{ reference: string | null }[]>`SELECT reference::text AS reference FROM colori_ecru WHERE idcolori_ecru = ${Number(s.idcoloris)}`
        : [])

  const reference = (rf?.reference ?? '').trim()
  const titre = [reference, (col?.reference ?? '').trim()].filter(Boolean).join(' - ') || `Lot ${s.lot}`
  const commandes = [...new Set(rouleaux.map((r) => (r.numero_cc ?? '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'fr', { numeric: true }))
  const refClient = [...new Set(rouleaux.map((r) => (r.ref_client ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean))].join(', ') || null
  const clientNom = (rouleaux[0].nom ?? '').trim()
  const d = new Date()

  const data: RapportControlePdfData = {
    lot: s.lot,
    dateLong: `${d.getDate()} ${MOIS[d.getMonth()]} ${d.getFullYear()}`,
    clientNom,
    commandes,
    refClient,
    articles: [{
      titre,
      sousTitre: (rf?.designation ?? '').trim() || null,
      lots: [{
        lot: s.lot,
        hasSuivilot: true,
        rows: [
          { parametre: 'Laize HT', min: nul0(rf?.lmin), max: nul0(rf?.lmax), releve: nul0(s.laize) },
          { parametre: 'Poids', min: nul0(rf?.pmin), max: nul0(rf?.pmax), releve: nul0(s.poids) },
          { parametre: 'Stab H', min: nul0(rf?.sh), max: null, releve: nul0(s.stabh) },
          { parametre: 'Stab L', min: nul0(rf?.sl), max: null, releve: nul0(s.stabl) },
        ],
      }],
      pieces: rouleaux.map((r) => ({ numero: (r.numero ?? '').trim() || `#${r.id}`, poids: Number(r.poids), metrage: Number(r.metrage) })),
    }],
  }
  return {
    data, idsuivilot, ligne: Number(s.ligne), lot: s.lot, idclient, clientNom,
    pieces: rouleaux.map((r) => Number(r.id)), refClient, reference,
  }
}

/** Journal one send (append-only). */
export async function journaliserEnvoiRc(rc: RapportControleLot, par: { id: number; nom: string }, destinataires: string[]): Promise<void> {
  await mpsPg()`
    INSERT INTO rapport_controle_envoi (idsuivilot, idligne_commande_sous_traitant, lot, idclient, envoye_par_id, envoye_par, destinataires, pieces)
    VALUES (${rc.idsuivilot}, ${rc.ligne}, ${rc.lot}, ${rc.idclient}, ${par.id}, ${par.nom}, ${destinataires.join(', ')}, ${rc.pieces})`
}
