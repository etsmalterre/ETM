import { RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'

// État (stock_fini status) libellé → pill colour classes. Shared between the
// Finis/Stock table, the Sous-traitants/Gestion "rolls on site" table and the
// Clients/Commandes affectation drawer so the status tag reads identically
// across screens. Falls back to neutral zinc for unknown values.
//
// Two variants share the same hue mapping (mps_designer §37):
// - 'soft'  — pastel bg + dark text, for dense table cells and inline chips
// - 'solid' — saturated bg + white text, for roll cards where the état must
//   catch the eye at a fixed position (Clients/Commandes affectation drawer)
export type EtatPillVariant = 'soft' | 'solid'

export function etatPillClass(libelle: string | null, variant: EtatPillVariant = 'soft'): string {
  const solid = variant === 'solid'
  if (!libelle) return solid ? 'bg-zinc-500 text-white border-zinc-500' : 'bg-zinc-100 text-zinc-700 border-zinc-200'
  const l = libelle.toLowerCase()
  if (l.includes('contrôle') || l.includes('controle'))
    return solid ? 'bg-amber-500 text-white border-amber-500' : 'bg-amber-100 text-amber-800 border-amber-200'
  if (l.includes('reprise'))
    return solid ? 'bg-orange-500 text-white border-orange-500' : 'bg-orange-100 text-orange-800 border-orange-200'
  // "Validé" / "Disponible" / "Prêt" are all positive, approved states → green.
  if (l.includes('valid') || l.includes('disponible') || l.includes('prêt') || l.includes('pret'))
    return solid ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-emerald-100 text-emerald-800 border-emerald-200'
  if (l.includes('refus') || l.includes('rebut'))
    return solid ? 'bg-red-600 text-white border-red-600' : 'bg-red-100 text-red-700 border-red-200'
  return solid ? 'bg-zinc-500 text-white border-zinc-500' : 'bg-zinc-100 text-zinc-700 border-zinc-200'
}

// Canonical stock_fini état pill. Every screen displaying a roll's état must
// render this component — never an ad-hoc <Badge> — so the colour language
// (green = validé/disponible, amber = contrôle, orange = reprise, red =
// refusé/rebut) stays identical everywhere. Renders nothing when the libellé
// is empty; call sites decide whether to show a "—" fallback.
export function EtatPill({
  libelle,
  variant = 'soft',
  className,
}: {
  libelle: string | null
  variant?: EtatPillVariant
  className?: string
}) {
  if (!libelle) return null
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border font-medium',
        variant === 'solid' ? 'px-2.5 py-0.5 text-xs font-semibold' : 'px-2 py-0.5 text-[10px]',
        etatPillClass(libelle, variant),
        className,
      )}
    >
      {libelle}
    </span>
  )
}

/** « Repris » / « Repris ×N » on a roll back from reprise (lib/reprises.ts):
 *  the reprise is data, the lot keeps the dyer's number. Hidden while the
 *  roll is at the dyer — its état badge already says « En reprise ». Orange,
 *  the reprise hue of the état pills (§37). */
/** `compact`: icon + count only, for a narrow table cell (Finis › Stock). */
export function RepriseBadge({ nombre, enReprise, compact }: { nombre?: number; enReprise?: boolean; compact?: boolean }) {
  if (!nombre || nombre <= 0 || enReprise) return null
  return (
    <span
      className="inline-flex items-center gap-0.5 rounded-full border border-orange-200 bg-orange-100 px-1.5 py-0 text-[10px] font-medium text-orange-800 flex-shrink-0"
      title={nombre > 1 ? `Rouleau repris ${nombre} fois chez l’ennoblisseur` : 'Rouleau repris chez l’ennoblisseur'}
    >
      <RotateCcw className="h-2.5 w-2.5" />
      {compact ? (nombre > 1 ? `×${nombre}` : null) : nombre > 1 ? `Repris ×${nombre}` : 'Repris'}
    </span>
  )
}
