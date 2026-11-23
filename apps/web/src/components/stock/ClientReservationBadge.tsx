import { AlertTriangle, Building2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

/** Client-reservation tag of a roll: who the piece is promised to. Carries the
 *  order number: a client often has several orders open and the name alone
 *  sent people looking on the wrong one (LIVA #1258). Born in Sous-traitants ›
 *  Commandes, shared with Transferts since #1390: one tag for « réservé à un
 *  client » on every list of rolls, never a copy. Renders nothing for a free
 *  piece. */
export function ClientReservationBadge({ clientNom, commandeNumero, misfit = false }: {
  clientNom?: string | null
  commandeNumero?: number | null
  /** Reserved for another article/coloris than this dyer line makes (LIVA #1261). */
  misfit?: boolean
}) {
  if (!clientNom) return null
  const reserved = commandeNumero ? `Rouleau réservé à la commande N° ${commandeNumero} de ${clientNom}` : 'Rouleau réservé à ce client'
  return (
    <Badge
      variant={misfit ? 'outline' : 'secondary'}
      className={cn(
        'text-xs py-1 px-2 gap-1 flex-shrink-0',
        misfit && 'border-destructive/40 bg-destructive/10 text-destructive',
      )}
      title={misfit ? `${reserved}, pour une autre référence ou un autre coloris que cette teinture` : reserved}
    >
      {misfit ? <AlertTriangle className="h-3 w-3" /> : <Building2 className="h-3 w-3" />}
      {clientNom}
      {!!commandeNumero && <span className={cn('font-normal', misfit ? 'text-destructive/80' : 'text-muted-foreground')}>· N° {commandeNumero}</span>}
    </Badge>
  )
}
