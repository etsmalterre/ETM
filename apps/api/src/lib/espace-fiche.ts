// A customer's own record, as the espace client's « Mon compte » page shows it — read by
// GET /api/site/espace/clients/:id/fiche (routes/webservice-site.ts). Read-only: a customer asks Malterre
// to change it, the ADV keys the change into ETM (Clients › Gestion).
//
// Only what the customer may see about themselves. Never add: client.commentaire (« Fiche client »),
// journal_commercial, pct_remise / pct_ajeol, rib / domiciliation, the accounting code, the contact and
// address commentaire (staff notes), bloqué / archivé.

import { query, fixEncoding } from './hfsql-auto.js'
import { isAdresseADefinir } from './adresse-a-definir.js'

export interface FicheClient {
  IDClient: number
  nom: string
  /** 411… customer account, the number on Malterre's invoices. */
  compte: string
  siren: string
  num_tva: string
  tel: string
  /** « VIREMENT », « TRAITE »… (mode_paiement.libelle), "" when unset. */
  mode_paiement: string
  /** « 45 jours, fin de mois »… (echeance.libelle), "" when unset. */
  echeance: string
  adresses: FicheAdresse[]
  contacts: FicheContact[]
}

export interface FicheAdresse {
  IDadresse: number
  nom: string
  adresse1: string
  adresse2: string
  adresse3: string
  cp: string
  ville: string
  pays: string
  facturation: boolean
  livraison: boolean
}

export interface FicheContact {
  IDcontact: number
  prenom: string
  nom: string
  tel: string
  email: string
  /** The client's main contact (contact.est_defaut). */
  principal: boolean
  /** Receives these documents by e-mail from ETM. */
  recoit: { commandes: boolean; bl: boolean; factures: boolean }
}

const str = (v: unknown) => String(v ?? '').trim()
const flag = (v: unknown) => Number(v) === 1

/** Visible addresses, the placeholder « à définir » left out; billing first, then delivery, then by name. Pure. */
export function adressesFiche(rows: Record<string, unknown>[]): FicheAdresse[] {
  return rows
    .filter((r) => flag(r.est_visible) && !isAdresseADefinir(r.IDadresse) && !/^[àa] d[ée]finir$/i.test(str(r.nom)))
    .map((r) => ({
      IDadresse: Number(r.IDadresse),
      nom: str(r.nom),
      adresse1: str(r.adresse1),
      adresse2: str(r.adresse2),
      adresse3: str(r.adresse3),
      cp: str(r.cp),
      ville: str(r.ville),
      pays: str(r.pays),
      facturation: flag(r.est_defaut_facturation),
      livraison: flag(r.est_defaut_livraison),
    }))
    .filter((a) => a.adresse1 || a.ville)
    .sort((a, b) =>
      Number(b.facturation) - Number(a.facturation) ||
      Number(b.livraison) - Number(a.livraison) ||
      a.nom.localeCompare(b.nom, 'fr'))
}

/** Visible contacts with a name or an e-mail; the main one first, then by name. Pure. */
export function contactsFiche(rows: Record<string, unknown>[]): FicheContact[] {
  return rows
    .filter((r) => flag(r.est_visible))
    .map((r) => ({
      IDcontact: Number(r.IDcontact),
      prenom: str(r.prenom),
      nom: str(r.nom),
      tel: str(r.tel),
      email: str(r.mail).toLowerCase(),
      principal: flag(r.est_defaut),
      recoit: { commandes: flag(r.envoi_commande), bl: flag(r.envoi_bl), factures: flag(r.envoi_facture) },
    }))
    .filter((c) => c.nom || c.prenom || c.email)
    .sort((a, b) => Number(b.principal) - Number(a.principal) || `${a.nom} ${a.prenom}`.localeCompare(`${b.nom} ${b.prenom}`, 'fr'))
}

/** The record of one ETS Malterre client (IDsociete 1, visible); null otherwise. */
export async function ficheClient(id: number): Promise<FicheClient | null> {
  // client holds a binary memo and accented columns → explicit columns only.
  const [row] = await fixEncoding(
    await query<Record<string, unknown>>(
      `SELECT IDclient, nom, tel, num_tva, compte, siren, IDmode_paiement, IDecheance, IDsociete, est_visible
       FROM client WHERE IDclient = ${id}`,
    ),
    'client', 'IDclient', ['nom', 'tel', 'num_tva'],
  )
  if (!row || Number(row.IDsociete) !== 1 || !flag(row.est_visible)) return null

  // contact / adresse: SELECT * is safe (no accented column names).
  const [adresses, contacts, mode, echeance] = await Promise.all([
    query<Record<string, unknown>>(`SELECT * FROM adresse WHERE IDclient = ${id}`)
      .then((r) => fixEncoding(r, 'adresse', 'IDadresse', ['nom', 'adresse1', 'adresse2', 'adresse3', 'ville', 'pays'])),
    query<Record<string, unknown>>(`SELECT * FROM contact WHERE IDclient = ${id}`)
      .then((r) => fixEncoding(r, 'contact', 'IDcontact', ['nom', 'prenom', 'tel', 'mail'])),
    Number(row.IDmode_paiement) > 0
      ? query<{ libelle: string }>(`SELECT libelle FROM mode_paiement WHERE IDmode_paiement = ${Number(row.IDmode_paiement)}`)
      : [],
    Number(row.IDecheance) > 0
      ? query<Record<string, unknown>>(`SELECT IDecheance, libelle FROM echeance WHERE IDecheance = ${Number(row.IDecheance)}`)
          .then((r) => fixEncoding(r, 'echeance', 'IDecheance', ['libelle']))
      : [],
  ])

  return {
    IDClient: id,
    nom: str(row.nom),
    compte: str(row.compte),
    siren: str(row.siren).replace(/\s+/g, ''),
    num_tva: str(row.num_tva).replace(/\s+/g, '').toUpperCase(),
    tel: str(row.tel),
    mode_paiement: str(mode[0]?.libelle),
    echeance: str(echeance[0]?.libelle),
    adresses: adressesFiche(adresses),
    contacts: contactsFiche(contacts),
  }
}
