import { MapPinOff } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Tooltip of every BL / email / demande-de-transport control disabled by
 *  the placeholder (the API answers 409 `adresse_a_definir` anyway). */
export const ADRESSE_A_DEFINIR_BLOQUE =
  "Adresse de livraison « À définir » : choisissez la vraie adresse sur l'avis avant d'éditer le BL ou la demande de transport."

/** Rendering of the legacy « À définir » delivery address (LIVA #1189) in an
 *  address card — amber, because it needs action before the goods leave:
 *  the API refuses the BL and the demande de transport while it stands. */
export function AdresseADefinirNotice({ hint, className }: { hint: string; className?: string }) {
  return (
    <div className={cn('flex items-start gap-2 rounded-md border border-dashed border-amber-500/50 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-800', className)}>
      <MapPinOff className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
      <div className="min-w-0">
        <p className="font-semibold">À définir</p>
        <p className="mt-0.5">{hint}</p>
      </div>
    </div>
  )
}
