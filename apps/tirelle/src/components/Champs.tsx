// Bench-size inputs: read at arm's length, typed with one finger on the
// tablet's numeric keyboard. Out-of-tolerance values turn red as they are
// typed, with the same rules the API applies (lib/tirelle-labo.ts
// horsTolerance → Qualité › Analyse's horsBornes / horsRetrait).
import { cn } from '@/lib/utils'
import type { Tolerances } from '@/lib/tirelle-api'
import { Jauge, type BornesJauge } from '@/components/Jauge'

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
  grand,
  jauge,
  placeSigne,
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
  /** Bench size: a taller field and bigger digits (the lab screen's two columns). */
  grand?: boolean
  /** Suivi lots' tolerance gauge: given (even null), the measure is one line —
   *  label, a narrow field, the gauge (or the tolerance text) on the rest. */
  jauge?: BornesJauge | null
  /** No sign of its own but lined up under measures that have one (vrillage under the stabs). */
  placeSigne?: boolean
}) {
  const x = lireNombre(valeur)
  const signee = x == null ? null : signe === '-' ? -x : x
  const avecJauge = !!jauge && (jauge.min != null || jauge.max != null)
  const texteAide = (aide || hors === true) && (
    <span className={cn('min-w-0 truncate text-sm', hors === true ? 'text-destructive font-semibold' : 'text-muted-foreground')}>
      {hors === true ? `Hors tolérance${aide ? ` (${aide})` : ''}` : aide}
    </span>
  )
  const boutonsSigne = signe && onSigne && (
    <div className="flex rounded-xl border border-border overflow-hidden flex-shrink-0">
      {(['-', '+'] as const).map((s) => (
        <button
          key={s}
          type="button"
          disabled={disabled}
          onClick={() => onSigne(s)}
          className={cn(
            grand ? 'w-16 text-3xl' : 'w-12 text-2xl',
            'font-bold transition-colors',
            signe === s ? 'bg-primary text-primary-foreground' : 'bg-background text-muted-foreground active:bg-muted',
          )}
          aria-pressed={signe === s}
          title={s === '-' ? 'Retrait (négatif)' : 'Allongement (positif)'}
        >
          {s === '-' ? '−' : '+'}
        </button>
      ))}
    </div>
  )
  const champ = (largeur: string) => (
    <div className={cn('relative min-w-0', largeur)}>
      <input
        type="text"
        inputMode="decimal"
        autoComplete="off"
        autoFocus={autoFocus}
        disabled={disabled}
        value={valeur}
        aria-label={label}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.,]/g, ''))}
        className={cn(
          'w-full min-w-0 rounded-xl border-2 bg-background pl-4 pr-16 font-bold tabular-nums',
          grand ? 'h-[72px] text-4xl' : 'h-14 text-3xl',
          'focus:outline-none focus:ring-4 focus:ring-gold/40 disabled:opacity-60',
          hors === true ? 'border-destructive text-destructive' : hors === false ? 'border-success' : 'border-border',
        )}
      />
      <span className="absolute right-4 top-1/2 -translate-y-1/2 text-lg text-muted-foreground pointer-events-none">{unite}</span>
    </div>
  )

  // With a gauge (even an empty one): one line — label, a field sized to its
  // figure, then the gauge on the rest of the width (Vincent 2026-11-09).
  if (jauge !== undefined) {
    return (
      <div className="flex items-center gap-3 min-w-0">
        <label className="w-20 flex-shrink-0 text-sm font-semibold text-muted-foreground uppercase tracking-wide">{label}</label>
        {boutonsSigne || (placeSigne && <div className={cn('flex-shrink-0', grand ? 'w-[130px]' : 'w-[98px]')} />)}
        {champ('w-48 flex-shrink-0')}
        <div className="flex-1 min-w-0 pl-3">
          {avecJauge ? <Jauge valeur={signee} bornes={jauge!} hors={hors} /> : texteAide}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-1 min-w-0">
      {/* The tolerance on the label's line, not under the field: the whole step
          fits the tablet in landscape without scrolling. */}
      <div className="flex items-baseline justify-between gap-2">
        <label className="text-sm font-semibold text-muted-foreground uppercase tracking-wide flex-shrink-0">{label}</label>
        {texteAide}
      </div>
      <div className="flex items-stretch gap-2">
        {boutonsSigne}
        {champ('flex-1')}
      </div>
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
