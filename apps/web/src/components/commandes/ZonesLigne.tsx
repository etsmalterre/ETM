// Clients › Commandes › line drawer: the two zones of the Fil / Tricotage / Ennoblissement tabs
// (decision Vincent 2026-10-28). A client line carries two distinct things:
//   - its MATTER: what is reserved to it at this stage (yarn, écru, fini), almost always possible;
//     shown as ONE clickable block (need, held, the sources held under it) whose click opens the
//     selector to reserve or release — free stock is never listed in the zone;
//   - its ORDERS: the supplier / partner orders that move the matter on, which make the line's
//     status advance (attente fil, en tricotage, en ennoblissement…).
// Top = the matter, bottom = the orders, identical in every tab. Reserving and ordering are two
// gestures (decision Vincent 2026-10-28): an order from the line takes only matter reserved to it (+ free
// matter on top « pour le stock »), so the bottom zone's buttons are active only where reserved matter
// sits, and greyed with the reason otherwise (BoutonsCommande).
import type { ComponentType, ReactNode } from 'react'
import { ClipboardList, PackageCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function ZoneLigne({ kind, titre, aide, resume, actions, children }: {
  kind: 'matiere' | 'commandes'
  titre: string
  /** hover of the title: how the zone works, read once (not repeated in the empty state) */
  aide?: string
  /** one line next to the title: what the stage still needs, how much is held… */
  resume?: ReactNode
  /** right of the title: « Réserver », « Réserver tout le fil »… */
  actions?: ReactNode
  children: ReactNode
}) {
  const Icon: ComponentType<{ className?: string }> = kind === 'matiere' ? PackageCheck : ClipboardList
  return (
    <section className={cn(kind === 'commandes' && 'pt-3 border-t border-border/60')}>
      <div className="flex items-center gap-2 mb-1.5 min-h-6">
        <Icon className="h-3.5 w-3.5 flex-shrink-0 text-primary/70" />
        <h3 title={aide} className="flex-shrink-0 text-[10px] uppercase tracking-wide text-primary/70 font-semibold">{titre}</h3>
        {resume && <div className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground tabular-nums">{resume}</div>}
        {actions && <div className={cn('flex-shrink-0 flex items-center gap-1', !resume && 'ml-auto')}>{actions}</div>}
      </div>
      {children}
    </section>
  )
}

/** The empty state of a zone: one muted line, and what to do. */
export function ZoneVide({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-border/70 bg-white/50 px-3 py-2.5 text-xs text-muted-foreground italic">
      {children}
    </p>
  )
}

/** The zone header's action button (« Réserver »…): small accent ghost, as « Réserver tout le fil ». */
export const zoneActionClass = 'h-6 px-2 text-[11px] text-accent hover:text-accent hover:bg-accent/10'

/** The bottom zone's order buttons: one per place holding matter reserved to the line (« Ennoblir chez
 *  MATEL »), active only when that matter allows the order (greyed, hover = what is missing there).
 *  Nothing reserved anywhere = no button (Vincent 2026-10-28): the top zone is the way to reserve. */
export function BoutonsCommande({ icon: Icon, verbe, lieux }: {
  icon: ComponentType<{ className?: string }>
  verbe: string
  lieux: { key: number; nom: string; actif: boolean; titre: string; onClick: () => void }[]
}) {
  return (
    <>
      {lieux.map((l) => (
        // A span carries the hover of a disabled button (a disabled button gets no pointer events).
        <span key={l.key} title={l.titre} className="inline-flex">
          <Button variant="ghost" size="sm" disabled={!l.actif} onClick={l.onClick} className={zoneActionClass}>
            <Icon className="h-3 w-3 mr-1" />{verbe}{lieux.length > 1 || l.nom ? ` chez ${l.nom}` : ''}
          </Button>
        </span>
      ))}
    </>
  )
}
