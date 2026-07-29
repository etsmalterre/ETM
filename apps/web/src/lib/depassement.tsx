// ── Dépassement vs N-1 ─────────────────────────────────
//
// Shared by Rapports › Finance and the "Charges" dashboard widget, so the
// N/N-1 ratio means and looks the same in both. What the user scans for: what
// now costs more than it did last year. The ratio drives a traffic light —
// under N-1 is green, up to +20 % amber, beyond red.
//
// Classification reads the *rounded* percentage (the one rendered on screen)
// so the colour can never disagree with the number next to it. An empty N-1
// gets no verdict — there is nothing to exceed — and no percentage is rendered.

import { cn } from '@/lib/utils'

export type Depassement = 'sous' | 'proche' | 'depasse'

export function depassement(pourcentage: number, precedent: number): Depassement | null {
  if (precedent <= 0) return null
  if (pourcentage < 100) return 'sous'
  if (pourcentage <= 120) return 'proche'
  return 'depasse'
}

/** Soft pill palette — same intensity language as the stock-fini état pills. */
export const DEPASSEMENT_PILL: Record<Depassement, string> = {
  sous: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  proche: 'bg-amber-100 text-amber-800 border-amber-200',
  depasse: 'bg-red-100 text-red-700 border-red-200',
}

export const DEPASSEMENT_TITLE: Record<Depassement, string> = {
  sous: 'Sous le montant de l’année précédente',
  proche: 'Dépassement jusqu’à +20 %',
  depasse: 'Dépassement de plus de 20 %',
}

/** No N-1 amount but a real amount this year: the compte opened this year, so
 *  it has no ratio at all. Tinted grey to read as "hors comparaison" rather
 *  than as an empty cell. A compte at zero on both years is not "new" — it is
 *  simply dormant, and stays neutral. */
export function estNouveau(montant: number, precedent: number): boolean {
  return precedent <= 0 && montant !== 0
}

/** Only the attention states tint a row — a green row stays white so the
 *  comptes en dépassement are the ones that pop out of the table. */
export const DEPASSEMENT_ROW: Record<Depassement, string> = {
  sous: 'hover:bg-accent/5',
  proche: 'bg-amber-50 hover:bg-amber-100/70',
  depasse: 'bg-red-50 hover:bg-red-100/70',
}

export function formatPct(v: number): string {
  return `${Math.round(v)} %`
}

export function PctPill({
  pourcentage, precedent, className,
}: {
  pourcentage: number
  precedent: number
  className?: string
}) {
  const d = depassement(pourcentage, precedent)
  // No N-1 amount = a compte that opened this year. The ratio is 0, but
  // printing "0 %" reads as "spent nothing" — render nothing.
  if (!d) return null
  return (
    <span
      title={DEPASSEMENT_TITLE[d]}
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium tabular-nums',
        DEPASSEMENT_PILL[d],
        className,
      )}
    >
      {formatPct(pourcentage)}
    </span>
  )
}
