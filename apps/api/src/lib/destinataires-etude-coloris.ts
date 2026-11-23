// Who, at the client, an étude coloris soumission is addressed to (LIVA #1388).
//
// The sheet goes to the lab, which staples its samples on it and posts the
// parcel to the client. The people it is for are the client's contacts ticked
// « Soumission étude coloris » (Clients › Gestion › Contacts,
// `contact.envoi_etude_coloris`, migration 0083) — NOT `envoi_soumission`, which
// is the lot soumissions' tick. Their names print in the sheet's « À l'attention
// de » block; nobody ticked = the client's address alone, as before.

import { mpsPg } from './mps-pg.js'

export interface ContactDestinataire {
  prenom: string | null
  nom: string | null
}

/** « Prénom Nom » of each contact, in the order given, without blanks nor doubles. Pure. */
export function nomsDestinataires(contacts: readonly ContactDestinataire[]): string[] {
  const noms: string[] = []
  const vus = new Set<string>()
  for (const c of contacts) {
    const nom = [c.prenom, c.nom].map((s) => (s ?? '').trim()).filter(Boolean).join(' ')
    if (!nom || vus.has(nom.toLowerCase())) continue
    vus.add(nom.toLowerCase())
    noms.push(nom)
  }
  return noms
}

/** The client's visible contacts ticked « Soumission étude coloris », principal first. */
export async function destinatairesEtudeColoris(idClient: number): Promise<string[]> {
  if (!(idClient > 0)) return []
  const rows = await mpsPg()<ContactDestinataire[]>`
    SELECT prenom::text AS prenom, nom::text AS nom
    FROM contact
    WHERE idclient = ${idClient} AND envoi_etude_coloris = 1 AND COALESCE(est_visible, 1) <> 0
    ORDER BY COALESCE(est_defaut, 0) DESC, idcontact`
  return nomsDestinataires(rows)
}
