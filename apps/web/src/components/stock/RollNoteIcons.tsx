import { AlertTriangle, MessageSquare } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

// A roll's notes as small hover icons on the right of its card, the text in
// the tooltip — keeps a list of rolls compact where full-width banners would
// double its height. Shared by Clients › Commandes (Affectation drawer) and
// Transferts (bon lines + picker, #1297) so a roll reads the same everywhere.
// Both are <button>s: on the factory touchscreen a tap focuses them, which is
// what opens the tooltip there, and the click never reaches the row behind.

/** Red triangle: 2e choix and/or the defect text (fini: the dyer's report,
 *  écru: the visitage defects). Renders nothing when there is neither. */
export function RollDefautsIcon({ secondChoix = false, text }: { secondChoix?: boolean; text?: string | null }) {
  const defauts = (text ?? '').trim()
  if (!secondChoix && defauts.length === 0) return null
  return (
    <Tooltip
      side="left"
      content={
        <div className="w-max max-w-[320px] space-y-1.5 py-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-red-700 whitespace-nowrap">
            Défauts
          </p>
          {secondChoix && (
            <p className="text-xs font-bold uppercase tracking-wide text-red-700">2e choix</p>
          )}
          {defauts.length > 0 && (
            <p className="text-sm font-normal whitespace-pre-line">{defauts}</p>
          )}
        </div>
      }
    >
      <button
        type="button"
        aria-label="Défauts"
        onClick={(e) => e.stopPropagation()}
        className="h-6 w-6 rounded-md flex items-center justify-center flex-shrink-0 cursor-pointer border border-red-200 bg-red-50 hover:bg-red-100 transition-colors"
      >
        <AlertTriangle className="h-3.5 w-3.5 text-red-600" />
      </button>
    </Tooltip>
  )
}

/** Blue bubble: the roll's free-text observations. `onClick` makes it the
 *  edit affordance (Clients › Commandes); without it the icon only shows the
 *  text. Renders nothing when the roll has no observations. */
export function RollObservationsIcon({ text, onClick }: { text?: string | null; onClick?: () => void }) {
  const obs = (text ?? '').trim()
  if (obs.length === 0) return null
  return (
    <Tooltip
      side="left"
      content={
        <div className="w-max max-w-[320px] space-y-1.5 py-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-blue-700 whitespace-nowrap">
            Observations
          </p>
          <p className="text-sm font-normal whitespace-pre-line">{obs}</p>
        </div>
      }
    >
      <button
        type="button"
        aria-label="Observations"
        onClick={(e) => { e.stopPropagation(); onClick?.() }}
        className={cn(
          'h-6 w-6 rounded-md flex items-center justify-center flex-shrink-0 border border-blue-200 bg-blue-50 transition-colors',
          onClick ? 'cursor-pointer hover:bg-blue-100' : 'cursor-default',
        )}
      >
        <MessageSquare className="h-3.5 w-3.5 text-blue-600" />
      </button>
    </Tooltip>
  )
}
