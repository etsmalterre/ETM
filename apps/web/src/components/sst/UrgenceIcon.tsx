import { Siren } from 'lucide-react'
import { cn } from '@/lib/utils'

// THE sign of an urgency asked of a partner (Vincent 2026-11-16: one special, recognisable icon
// in every Malterre app). A BARE siren, navy: no frame, no background (a fuchsia pastille, then a
// navy one, were tried and rejected the same day), and never red nor amber — those mean « Malterre
// must / could act now » (mps_designer §41), while an urgency that awaits its answer is neutral
// for us. So the siren says « this was pressed », and the text beside it turns red only when the
// answer is overdue. Change the look here, nowhere else.

/** The urgency asked of the knitter on a line (API lib/urgence-sst.ts, Vincent 2026-11-16). Here
 *  rather than with the dialog: TRM reads it through `@etm` and has no use for the dialog's imports.
 *  'attente' its answer is awaited, 'a_relancer' the answer did not come on its day (ours to chase),
 *  'repondue' the knitter gave or moved its délai since — the line stays « urgente ».
 *  Dates 'YYYY-MM-DD'. */
export interface UrgenceLigne {
  etat: 'attente' | 'a_relancer' | 'repondue'
  demandeeLe: string
  reponseAttendue: string
  relances: number
  /** its own clock: working days since the latest ask, over the days the knitter gets to answer */
  jours: number
  accordes: number
  dateSouhaitee: string | null
  /** the délai the line had when it was asked; null = none */
  delaiAvant: string | null
  note: string | null
  par: string | null
}

/** The urgency colour, as text (the inline icon, a label). */
export const URGENCE_TEXTE = 'text-primary'

/** The inline icon, beside a text. `className` sizes it (h-3 w-3 by default). */
export function UrgenceIcon({ className, title }: { className?: string; title?: string }) {
  return (
    <span className="inline-flex flex-shrink-0" title={title}>
      <Siren className={cn('h-3 w-3', URGENCE_TEXTE, className)} aria-label="Urgence" />
    </span>
  )
}
