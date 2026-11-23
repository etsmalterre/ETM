// Expe › Transports: the departures (lib/expe-departs.ts) grouped into
// transports, each with its status. Decided with Vincent 2026-11-23: one card
// per TRANSPORT, never per avis. Measured on 12 months: 848 avis with rolls
// make about 503 pickups, 63 % of the avis travel with another one, up to 10
// in one truck.
//
// What travels together (computed, until the `envoi` tables record the real
// grouping): the avis of the same day, for the same client, to the same
// delivery address, leaving from the same place. Client + address + one
// pickup place is the rule of the grouped demande de transport
// (routes/expeditions.ts buildDemandeTransportPdfData); the same day is this
// file's own. An avis with no delivery address, the « À définir » placeholder,
// no registered client or no known place never groups: nothing says where it
// goes or where it leaves from.
//
// THE STATUS IS COMPUTED, never stored (docs/plan.md §3). Five steps were
// decided; two have a source of fact today, so two are computed:
//   en_preparation   an avis of the transport has not been e-mailed yet
//   pret_a_partir    every avis has been e-mailed (envoi_email): the client
//                    has its avis and, for a departure from a sous-traitant,
//                    the sous-traitant holding the rolls got it in Cci
// « Départ demandé », « En transit » and « Livré » come with the facts Expe
// will record (envoi_evenement). Until then a transport stays « prêt à
// partir » whatever happened to it afterwards.

import type { Depart, Destination, LieuDepart } from './expe-departs.js'

export type StatutTransport = 'en_preparation' | 'pret_a_partir'

export interface AvisTransporte {
  kind: 'formelle' | 'divers'
  id: number
  commande_numero: number | null
  nb_colis: number
  poids: number
  metrage: number
  facture: boolean
  envoye_le: string | null
  destinataires: number
}

export interface AdresseEnlevement {
  nom: string | null
  adresse1: string | null
  adresse2: string | null
  adresse3: string | null
  cp: string | null
  ville: string | null
  pays: string | null
}

export interface Transport {
  /** Stable while the grouping rule holds; changes when an avis joins or leaves. */
  cle: string
  statut: StatutTransport
  /** 'YYYY-MM-DD', the avis date. */
  date: string | null
  client: string
  lieu: LieuDepart
  /** Pickup address of the place, filled by the route (null: unknown place). */
  enlevement: AdresseEnlevement | null
  destination: Destination | null
  /** The carrier when every avis names the same one, '' otherwise (as the
   *  grouped demande de transport prints it). */
  transporteur: string
  avis: AvisTransporte[]
  nb_rouleaux: number
  nb_cartons: number
  poids: number
  /** When the last avis was e-mailed: the moment the transport became ready. */
  pret_le: string | null
}

/** The grouping key of a departure, or null when it travels alone. */
export function cleGroupe(d: Depart): string | null {
  if (!d.date || !(d.idclient > 0) || d.lieu.id === null) return null
  if (!(d.idadresse > 0) || d.destination?.a_definir) return null
  return `${d.date}_c${d.idclient}_a${d.idadresse}_l${d.lieu.id}`
}

export function statutDe(avis: readonly Pick<AvisTransporte, 'envoye_le'>[]): StatutTransport {
  return avis.length > 0 && avis.every((a) => !!a.envoye_le) ? 'pret_a_partir' : 'en_preparation'
}

function transportDe(cle: string, departs: Depart[]): Transport {
  const premier = departs[0]
  const avis: AvisTransporte[] = departs
    .map((d) => ({
      kind: d.kind, id: d.id, commande_numero: d.commande_numero, nb_colis: d.nb_colis, poids: d.poids,
      metrage: d.metrage, facture: d.facture, envoye_le: d.envoye_le, destinataires: d.destinataires,
    }))
    .sort((a, b) => a.id - b.id)
  const transporteurs = new Set(departs.map((d) => d.transporteur).filter(Boolean))
  const statut = statutDe(avis)
  const somme = (kind: Depart['kind']) => departs.filter((d) => d.kind === kind).reduce((n, d) => n + d.nb_colis, 0)
  return {
    cle,
    statut,
    date: premier.date,
    client: premier.client,
    lieu: premier.lieu,
    enlevement: null,
    destination: premier.destination,
    transporteur: transporteurs.size === 1 ? [...transporteurs][0] : '',
    avis,
    nb_rouleaux: somme('formelle'),
    nb_cartons: somme('divers'),
    poids: departs.reduce((n, d) => n + d.poids, 0),
    pret_le: statut === 'pret_a_partir'
      ? avis.reduce<string | null>((max, a) => (a.envoye_le && (!max || a.envoye_le > max) ? a.envoye_le : max), null)
      : null,
  }
}

/** Group the departures into transports, most recent first. */
export function grouperEnTransports(departs: readonly Depart[]): Transport[] {
  const groupes = new Map<string, Depart[]>()
  for (const d of departs) {
    const cle = cleGroupe(d) ?? `seul_${d.cle}`
    const liste = groupes.get(cle) ?? []
    liste.push(d)
    groupes.set(cle, liste)
  }
  return [...groupes.entries()]
    .map(([cle, liste]) => transportDe(cle, liste))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || b.avis[0].id - a.avis[0].id)
}
