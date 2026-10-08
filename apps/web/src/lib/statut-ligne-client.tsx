// Computed status of a client order line (API lib/statut-ligne-client.ts), shown on
// Clients › Commandes next to the free commentaire, which it replaces as a status
// (« soldé », « PAE », « en STT »… typed by hand). One hue per état; tricotage and
// ennoblisseur reuse the sous-traitant type hues (sst-type.tsx) so the line reads
// with the same colour as the subcontractor it is waiting on.
import type { ComponentType, ReactNode } from 'react'
import { Archive, CircleDashed, Droplets, Factory, PackageCheck, Truck } from 'lucide-react'
import { cn } from '@/lib/utils'

export type EtatLigneClient = 'soldee' | 'expediee' | 'pae' | 'ennoblisseur' | 'tricotage' | 'a_lancer'

export interface StatutLigneClient {
  etat: EtatLigneClient
  /** shipped share of the quantity (null when the quantity is 0) */
  part: number | null
  preuves: string[]
}

/** Mirror of the API's SEUIL_EXPEDIE: below it, a shipped share is shown on the pill. */
const SEUIL_EXPEDIE = 0.9

export const STATUT_LIGNE_META: Record<EtatLigneClient, { label: string; icon: ComponentType<{ className?: string }>; classes: string }> = {
  a_lancer: { label: 'À lancer', icon: CircleDashed, classes: 'bg-zinc-100 text-zinc-700 border-zinc-300' },
  tricotage: { label: 'En tricotage', icon: Factory, classes: 'bg-amber-500/15 text-amber-800 border-amber-500/30' },
  ennoblisseur: { label: 'Chez l’ennoblisseur', icon: Droplets, classes: 'bg-sky-500/10 text-sky-700 border-sky-500/25' },
  pae: { label: 'Prête à expédier', icon: PackageCheck, classes: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
  expediee: { label: 'Expédiée', icon: Truck, classes: 'bg-green-600 text-white border-green-600' },
  soldee: { label: 'Soldée', icon: Archive, classes: 'bg-zinc-500 text-white border-zinc-500' },
}

export function StatutLignePill({ statut, className }: { statut: StatutLigneClient; className?: string }) {
  const meta = STATUT_LIGNE_META[statut.etat]
  const Icon = meta.icon
  const p = statut.part
  const partielle = p !== null && p > 0 && p < SEUIL_EXPEDIE
  const label = statut.etat === 'a_lancer' && partielle ? 'Reste à lancer' : meta.label
  const title = [meta.label, ...statut.preuves].join('\n')
  return (
    <span
      title={title}
      className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium whitespace-nowrap', meta.classes, className)}
    >
      <Icon className="h-3 w-3" />
      {label}
      {partielle && <span className="opacity-75 tabular-nums">· {Math.round(p * 100)} % exp.</span>}
    </span>
  )
}

/** Where an order stands, on the same scale (API avancementCommande): its least advanced line
 *  still to deliver. Shown on the Clients › Commandes list cards. */
export function AvancementPill({ etat, className }: { etat: EtatLigneClient; className?: string }) {
  const meta = STATUT_LIGNE_META[etat]
  const Icon = meta.icon
  return (
    <span
      title={etat === 'expediee' || etat === 'soldee' ? meta.label : `Ligne la moins avancée : ${meta.label}`}
      className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium whitespace-nowrap', meta.classes, className)}
    >
      <Icon className="h-3 w-3" />
      {meta.label}
    </span>
  )
}

/** A line status as a search tag of the Clients › Commandes list: the line pill's hue and icon,
 *  with room for the bar's remove cross. */
export function EtatLigneTag({ etat, children }: { etat: EtatLigneClient; children?: ReactNode }) {
  const meta = STATUT_LIGNE_META[etat]
  const Icon = meta.icon
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium whitespace-nowrap', meta.classes)}>
      <Icon className="h-3 w-3" />
      {meta.label}
      {children}
    </span>
  )
}
