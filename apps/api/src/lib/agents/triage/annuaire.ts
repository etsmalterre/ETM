// Agent « Triage » — who wrote: the sender's company from ETM's contacts, for
// the prompt (« Expéditeur connu : client LE SLIP FRANÇAIS ») and for the
// sub-category the code derives (never the model). MFProd added this after
// its first corrections: a supplier's out-of-office read as « Interne ».
//
// Exact address first (contact.mail, transporteur.mail, prospect.email), then
// the company domain when it points to ONE company (a new MATEL address is
// MATEL); never a public provider's domain (wanadoo, gmail…). Native
// PostgreSQL (lib/mps-pg.ts), re-read at most hourly.

import { mpsPg } from '../../mps-pg.js'

export type TypeOrganisation = 'interne' | 'client' | 'sous_traitant' | 'fournisseur' | 'transporteur' | 'prospect'

export interface Organisation {
  type: TypeOrganisation
  id: number
  nom: string
  /** How it was found: the exact address, or its company domain. */
  par: 'adresse' | 'domaine'
}

export interface EntreeAnnuaire {
  mail: string
  type: TypeOrganisation
  id: number
  nom: string
}

/** Mail providers shared by many people: matched on the full address only. */
const DOMAINES_GENERIQUES = /^(wanadoo|orange|free|sfr|laposte|gmail|googlemail|hotmail|outlook|live|yahoo|icloud|aol|neuf|bbox|numericable|gmx|proton|protonmail)\./i

/** The group's own domains (ETS Malterre, Tricotage Malterre, Malterre Fencing…). */
const DOMAINE_INTERNE = /(^|\.)([a-z-]*malterre[a-z-]*)\.(com|fr)$/i

export const adresseDe = (de: string): string => ((/<([^>]+)>/.exec(de)?.[1] ?? de).trim().toLowerCase())
const domaineDe = (a: string): string => a.slice(a.lastIndexOf('@') + 1)

export const LIBELLE_TYPE: Record<TypeOrganisation, string> = {
  interne: 'interne (groupe Malterre)',
  client: 'client',
  sous_traitant: 'sous-traitant / ennoblisseur',
  fournisseur: 'fournisseur',
  transporteur: 'transporteur',
  prospect: 'prospect',
}

// A contact listed on several kinds of company: the most specific wins.
const PRIORITE: Record<TypeOrganisation, number> = { interne: 0, sous_traitant: 1, fournisseur: 2, transporteur: 3, client: 4, prospect: 5 }

/** The company behind a From header, or null. Pure (tests). */
export function identifier(de: string, annuaire: readonly EntreeAnnuaire[]): Organisation | null {
  const a = adresseDe(de)
  if (!a.includes('@')) return null
  const domaine = domaineDe(a)
  if (DOMAINE_INTERNE.test(domaine)) return { type: 'interne', id: 0, nom: 'ETS Malterre', par: 'domaine' }
  const tri = (xs: EntreeAnnuaire[]) => [...xs].sort((x, y) => PRIORITE[x.type] - PRIORITE[y.type])
  const exact = tri(annuaire.filter((e) => e.mail === a))
  if (exact.length) return { type: exact[0].type, id: exact[0].id, nom: exact[0].nom, par: 'adresse' }
  if (DOMAINES_GENERIQUES.test(domaine)) return null
  const memeDomaine = annuaire.filter((e) => domaineDe(e.mail) === domaine)
  const societes = new Set(memeDomaine.map((e) => `${e.type}:${e.id}`))
  if (societes.size !== 1) return null
  return { type: memeDomaine[0].type, id: memeDomaine[0].id, nom: memeDomaine[0].nom, par: 'domaine' }
}

async function chargerAnnuaire(): Promise<EntreeAnnuaire[]> {
  const sql = mpsPg()
  const [contacts, transporteurs, prospects] = await Promise.all([
    sql<Array<{ mail: string; idclient: number; idsous_traitant: number; idfournisseur: number; client: string | null; interne: number | null; sst: string | null; fournisseur: string | null }>>`
      SELECT c.mail, c.idclient, c.idsous_traitant, c.idfournisseur,
             cl.nom AS client, cl.client_interne AS interne, s.nom AS sst, f.nom AS fournisseur
      FROM contact c
      LEFT JOIN client cl ON cl.idclient = c.idclient AND c.idclient > 0
      LEFT JOIN sous_traitant s ON s.idsous_traitant = c.idsous_traitant AND c.idsous_traitant > 0
      LEFT JOIN fournisseur f ON f.idfournisseur = c.idfournisseur AND c.idfournisseur > 0
      WHERE c.mail LIKE '%@%'`,
    sql<Array<{ mail: string; idtransporteur: number; nom: string | null }>>`
      SELECT mail, idtransporteur, nom FROM transporteur WHERE mail LIKE '%@%'`,
    sql<Array<{ email: string; idprospect: number; societe: string | null; nom: string | null; prenom: string | null }>>`
      SELECT email, idprospect, societe, nom, prenom FROM prospect WHERE email LIKE '%@%'`,
  ])
  const out: EntreeAnnuaire[] = []
  // A contact field may hold several addresses (« a@x.fr; b@x.fr »).
  const adresses = (v: string) => (v.match(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []).map((x) => x.toLowerCase())
  const nom = (v: string | null | undefined, repli: string) => String(v ?? '').trim() || repli
  for (const c of contacts) {
    for (const mail of adresses(c.mail)) {
      if (c.idsous_traitant > 0) out.push({ mail, type: 'sous_traitant', id: c.idsous_traitant, nom: nom(c.sst, `Sous-traitant #${c.idsous_traitant}`) })
      if (c.idfournisseur > 0) out.push({ mail, type: 'fournisseur', id: c.idfournisseur, nom: nom(c.fournisseur, `Fournisseur #${c.idfournisseur}`) })
      if (c.idclient > 0) out.push({ mail, type: c.interne ? 'interne' : 'client', id: c.idclient, nom: nom(c.client, `Client #${c.idclient}`) })
    }
  }
  for (const t of transporteurs) for (const mail of adresses(t.mail)) out.push({ mail, type: 'transporteur', id: t.idtransporteur, nom: nom(t.nom, `Transporteur #${t.idtransporteur}`) })
  for (const p of prospects) {
    for (const mail of adresses(p.email)) {
      out.push({ mail, type: 'prospect', id: p.idprospect, nom: nom(p.societe, nom([p.prenom, p.nom].filter(Boolean).join(' '), `Prospect #${p.idprospect}`)) })
    }
  }
  return out
}

let cache: { le: number; annuaire: Promise<EntreeAnnuaire[]> } | null = null

/** ETM's address book, re-read at most hourly (a contact added in a fiche is picked up without a restart). */
export function annuaire(): Promise<EntreeAnnuaire[]> {
  if (!cache || Date.now() - cache.le > 3_600_000) {
    const p = chargerAnnuaire()
    cache = { le: Date.now(), annuaire: p }
    p.catch(() => { cache = null })
  }
  return cache.annuaire
}
