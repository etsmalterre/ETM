// Tolerance gauge — the one of ETM's Qualité › Suivi lots (apps/web
// QualiteSuiviLots.tsx `ToleranceGauge`), ported to the bench: a track with the
// accepted band in green, its bounds written under the band's edges, and the
// typed value as a needle, green inside, red outside (the colour comes from
// the tablet's own rule, `hors`, so the gauge never contradicts the field).
//   • two bounds (laize, poids): min → max band;
//   • min only (stabs: a retrait passes when ≥ the référentiel): band from the
//     threshold to the right, 0 ticked when in view;
//   • 0 → max (vrillage).
import { fmt } from '@/components/Champs'
import { cn } from '@/lib/utils'

export interface BornesJauge {
  min: number | null
  max: number | null
}

export function Jauge({ valeur, bornes, hors, dec = 1, className }: {
  valeur: number | null
  bornes: BornesJauge
  hors: boolean | null
  dec?: number
  className?: string
}) {
  if (bornes.min == null && bornes.max == null) return null
  const aMax = bornes.max != null
  const lo = bornes.min ?? 0
  const hi = bornes.max ?? lo

  // The display domain pads the band so the needle stays visible on / past an edge.
  let de: number
  let a: number
  if (aMax) {
    const marge = Math.max((hi - lo) * 0.3, Math.abs(lo) * 0.05, 1)
    de = lo - marge
    a = hi + marge
  } else if (lo < 0) {
    // A retrait threshold (stab −5): from a little below it to a little past 0,
    // so a stretch (positive) still shows on the track.
    de = lo * 1.4
    a = -lo * 0.6
  } else {
    const ecart = Math.max(Math.abs((valeur ?? lo) - lo), lo * 0.4, 1)
    de = Math.max(lo - ecart, 0)
    a = lo + ecart * 1.5
  }
  const etendue = Math.max(a - de, 1e-6)
  const pct = (v: number) => Math.min(100, Math.max(0, ((v - de) / etendue) * 100))

  const debut = pct(lo)
  const fin = aMax ? pct(hi) : 100
  const zero = de < 0 && a > 0 && lo !== 0 && hi !== 0
  const couleur = hors === true ? 'bg-destructive' : hors === false ? 'bg-success' : 'bg-zinc-400'

  return (
    <div className={cn('w-full', className)}>
      <div className="relative h-2 rounded-full bg-zinc-200">
        <div className="absolute inset-y-0 rounded-full bg-success/30" style={{ left: `${debut}%`, right: `${100 - fin}%` }} />
        <div className="absolute top-1/2 h-3 w-px -translate-x-1/2 -translate-y-1/2 bg-success/50" style={{ left: `${debut}%` }} />
        {aMax && <div className="absolute top-1/2 h-3 w-px -translate-x-1/2 -translate-y-1/2 bg-success/50" style={{ left: `${fin}%` }} />}
        {zero && <div className="absolute top-1/2 h-2 w-px -translate-x-1/2 -translate-y-1/2 bg-zinc-400" style={{ left: `${pct(0)}%` }} />}
        {valeur != null && (
          <div
            className={cn('absolute top-1/2 h-4 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white', couleur)}
            style={{ left: `${pct(valeur)}%` }}
          />
        )}
      </div>
      <div className="relative mt-0.5 h-3.5 text-xs tabular-nums text-muted-foreground">
        <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${debut}%` }}>{fmt(lo, dec)}</span>
        {zero && <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${pct(0)}%` }}>0</span>}
        {aMax && <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${fin}%` }}>{fmt(hi, dec)}</span>}
      </div>
    </div>
  )
}
