// Expe: the ETM departures, read from the documents that already exist (repo
// expe, docs/plan.md step 1). Nothing is written here. lib/expe-transports.ts
// groups these rows into transports and computes their status.
//
// A departure is the goods of one avis leaving from one place.
//   - avis d'expédition (expedition, IDsociete = 1): the place is where its
//     rolls sit, stock_fini / stock_ecru.IDmagasin (0 = the factory, else the
//     sous-traitant holding them). Same fact as the demande de transport's
//     « Enlèvement chez » (routes/expeditions.ts, #1111). Measured on 12
//     months (2026-11-23): 848 avis with rolls, every one in a single place
//     (MATEL 670, factory 133, Bontemps 23, Feat Coop 14, TAD 7). An avis whose
//     rolls sit in two places would be two pickups, so it gives two rows.
//   - an avis without any roll (7 in 12 months) has no known place: lieu null.
//   - avis divers (expedition_divers, ETM only, no stock link): cartons packed
//     at the factory.
//
// The one dated fact that exists today besides the avis itself: its e-mail
// (envoi_email, type_doc 14 avis / 16 avis divers, one row per recipient).
// Measured the same day: 723 avis of 855 were mailed, 655 on the avis date,
// and 629 of the 710 leaving from a sous-traitant went to a MATEL address too.

import { mpsPg } from './mps-pg.js'
import { ADRESSE_A_DEFINIR_LABEL, isAdresseADefinir } from './adresse-a-definir.js'
import { normalizePays } from './pays.js'

/** envoi_email.IDtype_doc of the two avis (routes/expeditions.ts). */
const TYPE_DOC_AVIS = 14
const TYPE_DOC_AVIS_DIVERS = 16

/** Where the goods are picked up. `id` 0 = the factory, > 0 = the
 *  sous-traitant holding them, null = unknown (an avis without rolls). */
export interface LieuDepart {
  id: number | null
  nom: string
}

export const LIEU_USINE: LieuDepart = { id: 0, nom: 'Usine' }
export const LIEU_INCONNU: LieuDepart = { id: null, nom: 'Lieu à préciser' }

export interface Destination {
  nom: string
  adresse1: string
  adresse2: string
  adresse3: string
  cp: string
  ville: string
  pays: string
  /** The placeholder address 795: the goods cannot leave before it is chosen. */
  a_definir: boolean
}

export interface Depart {
  /** Stable row key: one avis can give several pickups. */
  cle: string
  kind: 'formelle' | 'divers'
  /** The document number (the avis has no other). */
  id: number
  /** 'YYYY-MM-DD' */
  date: string | null
  idclient: number
  client: string
  commande_numero: number | null
  lieu: LieuDepart
  idadresse: number
  destination: Destination | null
  transporteur: string
  /** Rolls picked up here (avis), cartons (divers). */
  nb_colis: number
  poids: number
  metrage: number
  facture: boolean
  /** First e-mail of the avis, 'YYYY-MM-DD HH:MM:SS' (local time), or null. */
  envoye_le: string | null
  /** Recipients of that first e-mail. */
  destinataires: number
}

export const JOURS_PAR_DEFAUT = 30
const JOURS_MAX = 365

/** The window asked by the client, as a whole number of days in 1..365. */
export function lireJours(brut: unknown): number {
  const n = parseInt(String(brut ?? ''), 10)
  if (!Number.isFinite(n) || n < 1) return JOURS_PAR_DEFAUT
  return Math.min(n, JOURS_MAX)
}

export interface AvisBrut {
  id: number
  date: string | null
  idadresse: number | null
  idclient: number | null
  est_facture: number | null
  commande_numero: number | null
  client: string | null
  transporteur: string | null
  adr_nom: string | null
  adr_adresse1: string | null
  adr_adresse2: string | null
  adr_adresse3: string | null
  adr_cp: string | null
  adr_ville: string | null
  adr_pays: string | null
  envoye_le: string | null
  destinataires: number | null
}

export interface RouleauxBrut {
  idexpedition: number
  idmagasin: number
  magasin: string | null
  nb: number
  poids: number | null
  metrage: number | null
}

const txt = (v: unknown): string => (v == null ? '' : String(v).trim())
const num = (v: unknown): number => { const x = Number(v); return Number.isFinite(x) ? x : 0 }

type AdresseBrute = Pick<AvisBrut, 'idadresse' | 'adr_nom' | 'adr_adresse1' | 'adr_adresse2' | 'adr_adresse3' | 'adr_cp' | 'adr_ville' | 'adr_pays'>

export function destinationDe(a: AdresseBrute): Destination | null {
  if (isAdresseADefinir(a.idadresse)) {
    return { nom: ADRESSE_A_DEFINIR_LABEL, adresse1: '', adresse2: '', adresse3: '', cp: '', ville: '', pays: '', a_definir: true }
  }
  if (!(num(a.idadresse) > 0)) return null
  return {
    nom: txt(a.adr_nom),
    adresse1: txt(a.adr_adresse1), adresse2: txt(a.adr_adresse2), adresse3: txt(a.adr_adresse3),
    cp: txt(a.adr_cp), ville: txt(a.adr_ville), pays: normalizePays(a.adr_pays),
    a_definir: false,
  }
}

export function lieuDe(idmagasin: number, nom: string | null): LieuDepart {
  if (!(idmagasin > 0)) return LIEU_USINE
  return { id: idmagasin, nom: txt(nom) || `Magasin ${idmagasin}` }
}

/** 'YYYY-MM-DD HH:MM:SS' of a timestamp read as text, or null. */
function horodatage(v: unknown): string | null {
  const s = txt(v)
  return s ? s.slice(0, 19) : null
}

function communDe(a: AvisBrut) {
  return {
    id: Number(a.id),
    date: a.date,
    idclient: num(a.idclient),
    commande_numero: a.commande_numero != null ? Number(a.commande_numero) : null,
    idadresse: num(a.idadresse),
    destination: destinationDe(a),
    transporteur: txt(a.transporteur),
    facture: num(a.est_facture) === 1,
    envoye_le: horodatage(a.envoye_le),
    destinataires: num(a.destinataires),
  }
}

/** One row per (avis, place its rolls sit in); an avis without rolls keeps one
 *  row with an unknown place. */
export function departsDesAvis(avis: readonly AvisBrut[], rouleaux: readonly RouleauxBrut[]): Depart[] {
  const parAvis = new Map<number, RouleauxBrut[]>()
  for (const r of rouleaux) {
    const liste = parAvis.get(Number(r.idexpedition)) ?? []
    liste.push(r)
    parAvis.set(Number(r.idexpedition), liste)
  }
  const out: Depart[] = []
  for (const a of avis) {
    const commun = { ...communDe(a), kind: 'formelle' as const, client: txt(a.client) }
    const lieux = parAvis.get(commun.id) ?? []
    if (lieux.length === 0) {
      out.push({ ...commun, cle: `formelle-${commun.id}`, lieu: LIEU_INCONNU, nb_colis: 0, poids: 0, metrage: 0 })
      continue
    }
    for (const r of lieux) {
      const idmagasin = num(r.idmagasin)
      out.push({
        ...commun,
        cle: lieux.length === 1 ? `formelle-${commun.id}` : `formelle-${commun.id}-${idmagasin}`,
        lieu: lieuDe(idmagasin, r.magasin),
        nb_colis: num(r.nb),
        poids: num(r.poids),
        metrage: num(r.metrage),
      })
    }
  }
  return out
}

/** An avis divers: cartons packed at the factory. Its client is the
 *  registered one, else the free text typed on the avis (as ETM's list). */
export function departDivers(d: AvisBrut & { ref_client: string | null; nb: number | null }): Depart {
  const commun = communDe(d)
  return {
    ...commun,
    cle: `divers-${commun.id}`,
    kind: 'divers',
    client: txt(d.client) || txt(d.ref_client),
    lieu: LIEU_USINE,
    nb_colis: num(d.nb),
    poids: 0,
    metrage: 0,
  }
}

/** Most recent first; the document number breaks a same-day tie. */
export function trierDeparts(departs: Depart[]): Depart[] {
  return departs.sort((a, b) =>
    (b.date ?? '').localeCompare(a.date ?? '') || b.id - a.id || a.lieu.nom.localeCompare(b.lieu.nom, 'fr'))
}

/** The ETM departures of the last `jours` days (avis date). */
export async function listerDeparts(jours: number): Promise<Depart[]> {
  const sql = mpsPg()

  const avis = await sql<AvisBrut[]>`
    SELECT e.idexpedition AS id, e.date::text AS date, e.idadresse, e.est_facture,
           cc.idclient, cc.numero AS commande_numero, c.nom::text AS client, t.nom::text AS transporteur,
           a.nom::text AS adr_nom, a.adresse1::text AS adr_adresse1, a.adresse2::text AS adr_adresse2,
           a.adresse3::text AS adr_adresse3, a.cp::text AS adr_cp, a.ville::text AS adr_ville, a.pays::text AS adr_pays,
           m.envoye_le::text AS envoye_le, m.destinataires
      FROM expedition e
      LEFT JOIN commande_client cc ON cc.idcommande_client = e.idcommande_client
      LEFT JOIN client c ON c.idclient = cc.idclient
      LEFT JOIN transporteur t ON t.idtransporteur = e.idtransporteur
      LEFT JOIN adresse a ON a.idadresse = e.idadresse
      LEFT JOIN LATERAL (
        SELECT min(x.date) AS envoye_le,
               (count(*) FILTER (WHERE x.date = (SELECT min(y.date) FROM envoi_email y
                                                  WHERE y.idtype_doc = ${TYPE_DOC_AVIS} AND y.idreference = e.idexpedition)))::int AS destinataires
          FROM envoi_email x
         WHERE x.idtype_doc = ${TYPE_DOC_AVIS} AND x.idreference = e.idexpedition
      ) m ON true
     WHERE e.idsociete = 1 AND e.date >= current_date - ${jours}::int`

  const ids = avis.map((a) => Number(a.id))
  const rouleaux = ids.length === 0 ? [] : await sql<RouleauxBrut[]>`
    SELECT le.idexpedition, r.idmagasin, st.nom::text AS magasin,
           count(*)::int AS nb, sum(r.poids)::float8 AS poids, sum(r.metrage)::float8 AS metrage
      FROM ligne_expedition le
      JOIN (
        SELECT idligne_expedition, coalesce(idmagasin, 0) AS idmagasin, poids, metrage
          FROM stock_fini WHERE idligne_expedition > 0
        UNION ALL
        SELECT idligne_expedition_etm, coalesce(idmagasin, 0), poids, metrage
          FROM stock_ecru WHERE idligne_expedition_etm > 0
      ) r ON r.idligne_expedition = le.idligne_expedition
      LEFT JOIN sous_traitant st ON st.idsous_traitant = r.idmagasin
     WHERE le.idexpedition IN ${sql(ids)}
     GROUP BY le.idexpedition, r.idmagasin, st.nom`

  const divers = await sql<(AvisBrut & { ref_client: string | null; nb: number })[]>`
    SELECT d.idexpedition_divers AS id, d.date::text AS date, d.idadresse, d.est_facture, d.idclient,
           cc.numero AS commande_numero, c.nom::text AS client, d.ref_client::text AS ref_client,
           t.nom::text AS transporteur,
           a.nom::text AS adr_nom, a.adresse1::text AS adr_adresse1, a.adresse2::text AS adr_adresse2,
           a.adresse3::text AS adr_adresse3, a.cp::text AS adr_cp, a.ville::text AS adr_ville, a.pays::text AS adr_pays,
           m.envoye_le::text AS envoye_le, m.destinataires,
           (SELECT count(*)::int FROM ligne_expedition_divers l WHERE l.idexpedition_divers = d.idexpedition_divers) AS nb
      FROM expedition_divers d
      LEFT JOIN commande_client cc ON cc.idcommande_client = d.idcommande_client AND d.idcommande_client > 0
      LEFT JOIN client c ON c.idclient = d.idclient AND d.idclient > 0
      LEFT JOIN transporteur t ON t.idtransporteur = d.idtransporteur
      LEFT JOIN adresse a ON a.idadresse = d.idadresse
      LEFT JOIN LATERAL (
        SELECT min(x.date) AS envoye_le,
               (count(*) FILTER (WHERE x.date = (SELECT min(y.date) FROM envoi_email y
                                                  WHERE y.idtype_doc = ${TYPE_DOC_AVIS_DIVERS} AND y.idreference = d.idexpedition_divers)))::int AS destinataires
          FROM envoi_email x
         WHERE x.idtype_doc = ${TYPE_DOC_AVIS_DIVERS} AND x.idreference = d.idexpedition_divers
      ) m ON true
     WHERE d.date >= current_date - ${jours}::int`

  return trierDeparts([...departsDesAvis(avis, rouleaux), ...divers.map(departDivers)])
}
