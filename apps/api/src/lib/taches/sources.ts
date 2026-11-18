// The red families of the notification centre (Vincent 2026-11-18).
//
// A task = something red on a list: someone at Malterre must act now. Each
// family here reads the RED items of one list with that list's own rule (the
// function its route exports), never a second way to say an item is red. The
// relevé (releve.ts) writes them in the register (registre.ts), which keeps
// since when each has been red.
//
// A family is also a subscription of the notification centre: `id` is its
// entry in lib/abonnements-etm.ts (name, description, permission).
//
// Adding a family = an exported « …Rouges() » next to the list route, one
// entry here, one in ABONNEMENTS_ETM and its key in permission-keys.ts.

import {
  ABONNEMENT_COMMANDES_CLIENT, ABONNEMENT_COMMANDES_FIL, ABONNEMENT_ENNOBLISSEMENT, ABONNEMENT_FACTURES_SST,
  ABONNEMENT_SUIVI_LOTS, ABONNEMENT_SUPERVISEUR, ABONNEMENT_TRICOTAGE,
} from '../abonnements-etm.js'
import { pointsATraiter } from '../agents/superviseur/points.js'
import { commandesRouges } from '../../routes/commandes-client.js'
import { commandesFilRouges } from '../../routes/commandes-fil.js'
import { commandesSstRouges } from '../../routes/commandes-sous-traitant.js'
import { facturesATraiter } from '../../routes/factures-sst.js'
import { lotsRouges } from '../../routes/suivi-lots.js'
import type { TacheRelevee } from './registre.js'

export interface SourceRouge {
  /** Its subscription (lib/abonnements-etm.ts). */
  id: number
  /** Its key in the register (`tache_rouge.source`): stable, never renamed. */
  cle: string
  /** `true`: its feed rows are the register's own (a red task card). `false`: the family has its own
   *  cards and gestures in the feed (Superviseur points, invoices); the register only dates them. */
  cartes: boolean
  /** The items red NOW. Throws when it cannot read: the register is then left as it was. */
  relever(): Promise<TacheRelevee[]>
}

export const SOURCES_ROUGES: readonly SourceRouge[] = [
  {
    id: ABONNEMENT_COMMANDES_CLIENT,
    cle: 'commandes_client',
    cartes: true,
    relever: async () => (await commandesRouges()).map((c) => ({
      cle: String(c.id),
      titre: [`Commande client N° ${c.numero ?? c.id}`, c.client].filter(Boolean).join(' · '),
      raison: c.raison,
      lien: `/clients/commandes?commande=${c.id}`,
    })),
  },
  {
    id: ABONNEMENT_ENNOBLISSEMENT,
    cle: 'ennoblissement',
    cartes: true,
    relever: async () => (await commandesSstRouges('ennoblissement')).map((c) => ({
      cle: String(c.id),
      titre: [`Ennoblissement N° ${c.id}`, c.sousTraitant].filter(Boolean).join(' · '),
      raison: c.raison,
      lien: `/sous-traitants/ennoblissement?commande=${c.id}`,
    })),
  },
  {
    id: ABONNEMENT_TRICOTAGE,
    cle: 'tricotage',
    cartes: true,
    relever: async () => (await commandesSstRouges('tricotage')).map((c) => ({
      cle: String(c.id),
      titre: [`Tricotage N° ${c.id}`, c.sousTraitant].filter(Boolean).join(' · '),
      raison: c.raison,
      lien: `/sous-traitants/tricotage?commande=${c.id}`,
    })),
  },
  {
    id: ABONNEMENT_SUIVI_LOTS,
    cle: 'suivi_lots',
    cartes: true,
    relever: async () => (await lotsRouges()).map((l) => ({
      cle: String(l.id),
      titre: [`Lot ${l.lot}`, l.sousTraitant].filter(Boolean).join(' · '),
      raison: l.raison,
      // Without `statut` the screen opens on « Terminés » and the lot is not in its list.
      lien: `/qualite/suivi-lots?lot=${l.id}&statut=en_cours`,
    })),
  },
  {
    id: ABONNEMENT_COMMANDES_FIL,
    cle: 'commandes_fil',
    cartes: true,
    relever: async () => (await commandesFilRouges()).map((c) => ({
      cle: String(c.id),
      titre: [`Commande de fil N° ${c.id}`, c.fournisseur].filter(Boolean).join(' · '),
      raison: c.raison,
      lien: `/fils/commandes?commande=${c.id}`,
    })),
  },
  // The two families that already had their cards: dated here so that they too become « late ».
  {
    id: ABONNEMENT_SUPERVISEUR,
    cle: 'superviseur',
    cartes: false,
    relever: async () => (await pointsATraiter()).map((p) => ({
      cle: p.cle,
      titre: `Superviseur · ${p.titre}`,
      raison: p.message,
      lien: p.lien,
    })),
  },
  {
    id: ABONNEMENT_FACTURES_SST,
    cle: 'factures_sst',
    cartes: false,
    relever: async () => (await facturesATraiter()).map((f) => ({
      cle: String(f.id),
      titre: `Facture ${f.numero} · ${f.sous_traitant}`,
      raison: 'Facture à contrôler',
      lien: `/sous-traitants/factures?facture=${f.id}`,
    })),
  },
]

export const sourceDe = (id: number): SourceRouge | undefined => SOURCES_ROUGES.find((s) => s.id === id)
export const sourceParCle = (cle: string): SourceRouge | undefined => SOURCES_ROUGES.find((s) => s.cle === cle)
