// Bench-size inputs: read at arm's length, typed with one finger on the
// tablet's numeric keyboard. Out-of-tolerance values turn red as they are
// typed, with the same rules the API applies (lib/tirelle-labo.ts
// horsTolerance → Qualité › Analyse's horsBornes / horsRetrait).
import { cn } from '@/lib/utils'
import type { Tolerances } from '@/lib/tirelle-api'

/** « 155,5 » → 155.5; empty or junk → null. */
export function lireNombre(s: string): number | null {
  const t = s.trim().replace(',', '.')
  if (t === '' || t === '-') return null
  const x = Number(t)
  return Number.isFinite(x) ? x : null
}

export function fmt(n: number | null | undefined, d = 1): string {
  if (n == null || !Number.isFinite(n)) return ''
  return String(Math.round(n * 10 ** d) / 10 ** d).replace('.', ',')
}

/** Inside [min, max]; a 0 bound is « not set ». */
export function horsBornes(v: number | null, b: { min: number; max: number }): boolean | null {
  if (v == null || v <= 0 || (b.min <= 0 && b.max <= 0)) return null
  return (b.min > 0 && v < b.min) || (b.max > 0 && v > b.max)
}

/** Shrinkage is negative: a retrait passes when it is ≥ the référentiel. */
export function horsRetrait(v: number | null, ref: number | null): boolean | null {
  if (v == null || ref == null || ref === 0) return null
  return v < ref
}

export function texteBornes(b: { min: number; max: number }, unite: string): string | null {
  if (b.min > 0 && b.max > 0) return `${fmt(b.min)} à ${fmt(b.max)} ${unite}`
  if (b.min > 0) return `≥ ${fmt(b.min)} ${unite}`
  if (b.max > 0) return `≤ ${fmt(b.max)} ${unite}`
  return null
}

export function ChampNombre({
  label,
  unite,
  valeur,
  onChange,
  aide,
  hors,
  signe,
  onSigne,
  disabled,
  autoFocus,
}: {
  label: string
  unite: string
  valeur: string
  onChange: (v: string) => void
  /** The tolerance, under the field. */
  aide?: string | null
  hors: boolean | null
  /** Stabilités: the sign is a toggle (the tablet's numeric keyboard has no minus). */
  signe?: '-' | '+'
  onSigne?: (s: '-' | '+') => void
  disabled?: boolean
  autoFocus?: boolean
}) {
  return (
    <div className="space-y-1.5 min-w-0">
      <label className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">{label}</label>
      <div className="flex items-stretch gap-2">
        {signe && onSigne && (
          <div className="flex rounded-xl border border-border overflow-hidden flex-shrink-0">
            {(['-', '+'] as const).map((s) => (
              <button
                key={s}
                type="button"
                disabled={disabled}
                onClick={() => onSigne(s)}
                className={cn(
                  'w-12 text-2xl font-bold transition-colors',
                  signe === s ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground active:bg-muted',
                )}
                aria-pressed={signe === s}
                title={s === '-' ? 'Retrait (négatif)' : 'Allongement (positif)'}
              >
                {s === '-' ? '−' : '+'}
              </button>
            ))}
          </div>
        )}
        <div className="relative flex-1 min-w-0">
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            autoFocus={autoFocus}
            disabled={disabled}
            value={valeur}
            onChange={(e) => onChange(e.target.value.replace(/[^0-9.,]/g, ''))}
            className={cn(
              'w-full h-16 rounded-xl border-2 bg-background pl-4 pr-16 text-3xl font-bold tabular-nums',
              'focus:outline-none focus:ring-4 focus:ring-gold/40 disabled:opacity-60',
              hors === true ? 'border-destructive text-destructive' : hors === false ? 'border-success' : 'border-border',
            )}
          />
          <span className="absolute right-4 top-1/2 -translate-y-1/2 text-lg text-muted-foreground pointer-events-none">{unite}</span>
        </div>
      </div>
      {(aide || hors === true) && (
        <p className={cn('text-sm', hors === true ? 'text-destructive font-semibold' : 'text-muted-foreground')}>
          {hors === true ? `Hors tolérance${aide ? ` (${aide})` : ''}` : `Tolérance : ${aide}`}
        </p>
      )}
    </div>
  )
}

export function aidesTolerance(t: Tolerances) {
  return {
    laize: texteBornes(t.laize, 'cm'),
    poids: texteBornes(t.poids, 'g/m²'),
    stabh: t.stabh != null ? `≥ ${fmt(t.stabh)} %` : null,
    stabl: t.stabl != null ? `≥ ${fmt(t.stabl)} %` : null,
    vrillage: `≤ ${fmt(t.vrillageMax)} %`,
  }
}
