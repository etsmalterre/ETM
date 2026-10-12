// « Hors réf » — a TRM-knitted piece whose OF fed a yarn the écru reference's
// composition does not list (the régleur's « Ajouter un fil », most often to
// burn internal stock). The API decides (`hors_ref` on the piece payloads,
// lib/hors-ref-trm.ts); a fini roll inherits it from its écru piece(s).
//
// Same look as TRM's badge (components/of/HorsRefBadge.tsx): NEUTRAL accent,
// never a warning colour — a variation is a decision, not an anomaly. Internal
// only: never on a document that leaves the company (BL, confirmation…).
import { BobineIcon } from '@/components/icons/BobineIcon'
import { cn } from '@/lib/utils'

export interface FilHorsRef {
  IDref_fil: number
  IDcolori_fil: number
  /** « REF coloris » */
  label: string
}

function tooltip(fils: FilHorsRef[]): string {
  return `Tricoté avec un fil absent de la composition de la référence : ${fils.map((f) => f.label).join(', ')}`
}

/** The chip. `tone="dark"` on a navy drawer band (§27.5bis), where the light
 *  accent tint would vanish. Renders nothing when the piece has no such yarn. */
export function HorsRefBadge({ fils, tone = 'light', className }: {
  fils: FilHorsRef[] | null | undefined
  tone?: 'light' | 'dark'
  className?: string
}) {
  if (!fils || fils.length === 0) return null
  return (
    <span
      title={tooltip(fils)}
      className={cn(
        'inline-flex items-center rounded-full border px-1.5 py-0 text-[10px] font-medium whitespace-nowrap',
        tone === 'dark'
          ? 'border-gold/50 bg-gold/15 text-gold'
          : 'border-accent/30 bg-accent/10 text-accent',
        className,
      )}
    >
      hors réf
    </span>
  )
}

/** The yarns themselves, for a Provenance card. */
export function HorsRefNote({ fils, className }: {
  fils: FilHorsRef[] | null | undefined
  className?: string
}) {
  if (!fils || fils.length === 0) return null
  return (
    <div className={cn('flex items-start gap-2 rounded-md border border-accent/30 bg-accent/10 px-2.5 py-1.5', className)}>
      <BobineIcon className="h-3.5 w-3.5 text-accent flex-shrink-0 mt-0.5" />
      <div className="min-w-0 text-xs">
        <span className="font-semibold text-accent">Fil hors réf</span>
        <span className="text-muted-foreground"> — tricoté avec </span>
        <span className="font-medium">{fils.map((f) => f.label).join(', ')}</span>
        <span className="text-muted-foreground">, absent de la composition de la référence.</span>
      </div>
    </div>
  )
}
