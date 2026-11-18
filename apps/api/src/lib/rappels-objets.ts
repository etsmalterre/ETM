// The objects a reminder can be put on (lib/rappels.ts, Vincent 2026-11-18):
// for each type, how the object reads (the label frozen on the reminder),
// where it opens (the deep link of the web app) and which screen holds it,
// the write guard: whoever may open the screen may put a reminder on what it
// shows (Écrans = what a user sees; no new permission key, CLAUDE.md § 14).
//
// Adding a type = one entry here, its value in the CHECK of `rappel.objet_type`
// (a new migration) and the « Rappel » button on its screen.

import { mpsPg } from './mps-pg.js'
import { familleOfTypeSst } from './sst-tricotage.js'

export const TYPES_OBJET = ['lot_fini', 'lot_fil', 'piece_ecru', 'piece_fini', 'commande_fil', 'commande_client', 'commande_sst'] as const
export type TypeObjet = (typeof TYPES_OBJET)[number]

export const estTypeObjet = (v: unknown): v is TypeObjet => typeof v === 'string' && (TYPES_OBJET as readonly string[]).includes(v)

export interface ObjetRappel {
  /** How the object reads on the reminder: « Lot MA109539 · MATEL ». */
  libelle: string
  /** Where it opens in the web app. */
  lien: string
  /** The Écrans grant that guards writing a reminder on it: [menu, screen]. */
  ecran: readonly [menu: string, ecran: string]
}

const propre = (v: unknown) => (v ?? '').toString().trim()
const joint = (...parts: Array<string | null | undefined>) => parts.map((p) => propre(p)).filter(Boolean).join(' · ')

/** The object as it is now, or null when it does not exist (a reminder on nothing is refused). */
export async function lireObjet(type: TypeObjet, id: number): Promise<ObjetRappel | null> {
  const sql = mpsPg()
  switch (type) {
    case 'lot_fini': {
      const [r] = await sql<{ lot: string | null; sst: string | null }[]>`
        SELECT s.lot::text AS lot, st.nom::text AS sst FROM suivilot s
          LEFT JOIN sous_traitant st ON st.idsous_traitant = s.idsous_traitant
         WHERE s.idsuivilot = ${id}`
      // `statut=tous`: the lot may be validated by the time the reminder is due.
      return r ? { libelle: joint(`Lot ${propre(r.lot)}`, r.sst), lien: `/qualite/suivi-lots?lot=${id}&statut=tous`, ecran: ['/qualite', '/qualite/suivi-lots'] } : null
    }
    case 'lot_fil': {
      const [r] = await sql<{ lot: string | null; ref: string | null }[]>`
        SELECT s.lot::text AS lot, rf.reference::text AS ref FROM stock_fil s
          LEFT JOIN ref_fil rf ON rf.idref_fil = s.idref_fil
         WHERE s.idstock_fil = ${id}`
      return r ? { libelle: joint(`Lot de fil ${propre(r.lot)}`, r.ref), lien: `/fils/stock?lot=${id}`, ecran: ['/fils', '/fils/stock'] } : null
    }
    case 'piece_ecru': {
      const [r] = await sql<{ numero: string | null; ref: string | null }[]>`
        SELECT s.numero::text AS numero, re.reference::text AS ref FROM stock_ecru s
          LEFT JOIN ref_ecru re ON re.idref_ecru = s.idref_ecru
         WHERE s.idstock_ecru = ${id}`
      return r ? { libelle: joint(`Pièce tombé de métier ${propre(r.numero)}`, r.ref), lien: `/tombe-metier/stock?piece=${id}`, ecran: ['/tombe-metier', '/tombe-metier/stock'] } : null
    }
    case 'piece_fini': {
      const [r] = await sql<{ numero: string | null; lot: string | null; ref: string | null }[]>`
        SELECT s.numero::text AS numero, s.lot::text AS lot, rf.reference::text AS ref FROM stock_fini s
          LEFT JOIN ref_fini rf ON rf.idref_fini = s.idref_fini
         WHERE s.idstock_fini = ${id}`
      return r ? { libelle: joint(`Pièce finie ${propre(r.numero)}`, r.ref, r.lot ? `lot ${propre(r.lot)}` : ''), lien: `/finis/stock?piece=${id}`, ecran: ['/finis', '/finis/stock'] } : null
    }
    case 'commande_fil': {
      const [r] = await sql<{ frs: string | null }[]>`
        SELECT f.nom::text AS frs FROM commande_fil c
          LEFT JOIN fournisseur f ON f.idfournisseur = c.idfournisseur
         WHERE c.idcommande_fil = ${id}`
      return r ? { libelle: joint(`Commande de fil N° ${id}`, r.frs), lien: `/fils/commandes?commande=${id}`, ecran: ['/fils', '/fils/commandes'] } : null
    }
    case 'commande_client': {
      // ETM's ledger only (IDsociete 1, never a TRM mirror): the screen opens nothing else.
      const [r] = await sql<{ numero: number | null; client: string | null }[]>`
        SELECT c.numero, cl.nom::text AS client FROM commande_client c
          LEFT JOIN client cl ON cl.idclient = c.idclient
         WHERE c.idcommande_client = ${id} AND c.idsociete = 1 AND COALESCE(c.idcommande_etm, 0) = 0`
      return r ? { libelle: joint(`Commande client N° ${r.numero ?? id}`, r.client), lien: `/clients/commandes?commande=${id}`, ecran: ['/clients', '/clients/commandes'] } : null
    }
    case 'commande_sst': {
      const [r] = await sql<{ sst: string | null; idtype_sst: number | null }[]>`
        SELECT st.nom::text AS sst, st.idtype_sst FROM commande_sous_traitant c
          LEFT JOIN sous_traitant st ON st.idsous_traitant = c.idsous_traitant
         WHERE c.idcommande_sous_traitant = ${id}`
      if (!r) return null
      const tricotage = familleOfTypeSst(r.idtype_sst) === 'tricotage'
      const menu = tricotage ? 'tricotage' : 'ennoblissement'
      return {
        libelle: joint(`${tricotage ? 'Tricotage' : 'Ennoblissement'} N° ${id}`, r.sst),
        lien: `/sous-traitants/${menu}?commande=${id}`,
        ecran: ['/sous-traitants', `/sous-traitants/${menu}`],
      }
    }
  }
}

/** Where a stored reminder opens, without reading its object again (the feed lists many). A sst order
 *  goes through the redirect that picks its menu by the sous-traitant's type. */
export function lienObjet(type: TypeObjet, id: number): string {
  switch (type) {
    case 'lot_fini': return `/qualite/suivi-lots?lot=${id}&statut=tous`
    case 'lot_fil': return `/fils/stock?lot=${id}`
    case 'piece_ecru': return `/tombe-metier/stock?piece=${id}`
    case 'piece_fini': return `/finis/stock?piece=${id}`
    case 'commande_fil': return `/fils/commandes?commande=${id}`
    case 'commande_client': return `/clients/commandes?commande=${id}`
    case 'commande_sst': return `/sous-traitants/commandes?commande=${id}`
  }
}
