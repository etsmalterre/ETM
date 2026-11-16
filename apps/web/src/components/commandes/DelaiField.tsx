import { useRef } from 'react'
import { cn } from '@/lib/utils'
import { formatHfsqlDate, inputDateToHfsql } from '@/lib/dates'

const PICKER_DATE = typeof HTMLInputElement !== 'undefined' && 'showPicker' in HTMLInputElement.prototype

/** A partner's délai in a line form, framed like a client line's « Prête le » (Vincent 2026-11-10):
 *  the date is read, « Changer » opens the calendar straight away, the engagement (the first date
 *  given) sits under it, amber once the délai slipped past it. Without showPicker (old browser) a
 *  plain date field. Shared by Sous-traitants › Commandes and Fils › Commandes. */
export function DelaiField({
  value, engagement, onChange,
  label = 'Délai',
  aide = 'Le délai donné par le sous-traitant : le premier est son engagement',
  vide = 'Pas encore de délai',
}: {
  /** YYYY-MM-DD, '' = none */
  value: string
  /** YYYYMMDD the first date given */
  engagement?: string | null
  onChange: (v: string) => void
  label?: string
  /** the label's hover */
  aide?: string
  /** what reads while no date is given */
  vide?: string
}) {
  const ref = useRef<HTMLInputElement>(null)
  const date = inputDateToHfsql(value)
  const saisie = /^\d{8}$/.test(date) ? date : ''
  const eng = engagement && /^\d{8}$/.test(engagement) ? engagement : null
  const glisse = !!eng && !!saisie && saisie > eng
  const ligneEngagement = eng && (
    <div className={cn('text-xs truncate', glisse ? 'text-amber-700' : 'text-muted-foreground')}>
      Engagement {formatHfsqlDate(eng)}
    </div>
  )
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground cursor-help" title={aide}>{label}</label>
      {PICKER_DATE ? (
        <div className={cn('px-3 flex items-center gap-2 rounded-md border border-dashed border-input bg-muted/40 text-sm', eng ? 'py-1.5' : 'h-9')}>
          <div className="min-w-0 leading-tight">
            {saisie
              ? <div>Le <span className="font-semibold tabular-nums">{formatHfsqlDate(saisie)}</span></div>
              : <div className="text-muted-foreground italic">{vide}</div>}
            {ligneEngagement}
          </div>
          <span className="ml-auto relative flex items-center flex-shrink-0">
            <input ref={ref} type="date" tabIndex={-1} aria-hidden value={value}
              className="absolute inset-0 w-full h-full opacity-0 pointer-events-none"
              onChange={(e) => { if (e.target.value) onChange(e.target.value) }} />
            <button type="button"
              onClick={() => { try { ref.current?.showPicker() } catch { /* no picker */ } }}
              className="relative text-xs font-medium text-accent-blue hover:underline">
              {saisie ? 'Changer' : 'Choisir la date'}
            </button>
          </span>
        </div>
      ) : (
        <>
          <input type="date" value={value} onChange={(e) => onChange(e.target.value)} autoComplete="off"
            className="w-full h-9 px-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring" />
          {ligneEngagement}
        </>
      )}
    </div>
  )
}
