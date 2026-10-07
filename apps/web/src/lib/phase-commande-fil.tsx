// Yarn-order line phase — shared by Rapports › Commandes de fils and the
// tableau de bord « Fils en commande » widget, so a line reads the same colour
// in both places. The phase is computed by the API (GET /rapports/commandes-fil):
// a yarn line only carries etat 0/1, the rest comes from the délai and the
// stock lots received against it.

import {
  ClipboardList,
  Hourglass,
  Clock,
  PackageOpen,
  PackageCheck,
  CheckCircle2,
  type LucideIcon,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

export type PhaseCommandeFil = 'terminee' | 'recue' | 'partielle' | 'attente_delai' | 'en_cours'

/** One row of GET /rapports/commandes-fil (one per ref_fil_commande line). */
export interface RapportFilLine {
  IDref_fil_commande: number
  IDcommande_fil: number
  phase: PhaseCommandeFil
  fournisseur_nom: string
  reference: string
  coloris: string
  qte_commandee: number
  qte_recue: number
  qte_restante: number
  nb_lots: number
  prix_unitaire: number
  montant: number
  date_commande: string | null
  date_livraison: string | null
  date_notif: string | null
  retard_jours: number | null
  commentaire: string
  journal: string
  urgency: 'late' | 'soon' | null
  etat_ligne: number
  etat_commande: number
}

interface PhaseMeta {
  label: string
  icon: LucideIcon
  solid: string
}

// Colors mirror the SST report's LINE_STATUT_META so both reports read the same way.
const PHASE_META: Record<PhaseCommandeFil, PhaseMeta> = {
  attente_delai: { label: 'Attente délai', icon: Hourglass, solid: 'bg-yellow-500 border-yellow-500' },
  en_cours: { label: 'En cours', icon: Clock, solid: 'bg-primary border-primary' },
  partielle: { label: 'Réception partielle', icon: PackageOpen, solid: 'bg-sky-500 border-sky-500' },
  // Fully delivered but the line is still open — the user hasn't clôturé it.
  recue: { label: 'Reçue', icon: PackageCheck, solid: 'bg-teal-500 border-teal-500' },
  terminee: { label: 'Terminée', icon: CheckCircle2, solid: 'bg-success border-success' },
}

export function phaseMeta(phase: PhaseCommandeFil): PhaseMeta {
  return PHASE_META[phase] ?? { label: '—', icon: ClipboardList, solid: 'bg-zinc-500 border-zinc-500' }
}

export function PhasePill({ phase }: { phase: PhaseCommandeFil }) {
  const meta = phaseMeta(phase)
  const Icon = meta.icon
  return (
    <Badge variant="outline" className={cn('text-[10px] py-0 gap-1 border text-white whitespace-nowrap', meta.solid)}>
      <Icon className="h-2.5 w-2.5 flex-shrink-0" />
      {meta.label}
    </Badge>
  )
}
