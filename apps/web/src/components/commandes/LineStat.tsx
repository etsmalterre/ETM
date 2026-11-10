import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/** Dotted underline: the value has a detail on hover. */
export const SOULIGNE_INFO = 'underline decoration-dotted decoration-muted-foreground/60 underline-offset-2'

/** One figure of an order line card (label above, value below): the shared vocabulary of the client
 *  line (Clients › Commandes) and the sous-traitant line (Sous-traitants › Commandes) — Commandé ·
 *  Expédié / Reçu · Prix u. · Montant, the date pinned right. */
export function LineStat({ label, value, className, valueClass, title, children }: {
  label: string
  value: ReactNode
  className?: string
  valueClass?: string
  title?: string
  /** a small line under the value (a delay, a delivery date) */
  children?: ReactNode
}) {
  return (
    <div className={className} title={title}>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">{label}</p>
      <p className={cn('text-xs font-semibold tabular-nums', valueClass)}>{value}</p>
      {children}
    </div>
  )
}
