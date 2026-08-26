// ── Évolution du CA widget ────────────────────────────────────
// Monthly CA, one line per year, with the last 5 years as toggleable pills —
// plus an "Annuel" mode that compares the year totals as bars.
// Backed by GET /api/rapports/ca-evolution (same `caForYear` aggregation as the
// CA table, so the figures agree to the centime).
//
// ── Form (dataviz skill, step 1) ──
// Monthly = change-over-time with identity per year → multi-line.
// Annuel  = magnitude comparison across a handful of categories → bars.
//
// ── Colour (steps 2–3) ──
// Categorical by YEAR (identity), assigned by RECENCY and never cycled, so a
// year keeps its colour no matter which others are toggled on. The NEWEST year
// takes style 0 — solid accent blue — and is drawn at nearly double the stroke
// width, the older ones receding behind it: the running exercise is what the
// reader looks for first, and until 2026-08-26 it was whichever style the
// ascending list happened to leave over (a dashed violet, the least legible of
// the five). Emphasis is width + opacity + solidity, never colour alone.
// Palette VALIDATED, not eyeballed:
//   node scripts/validate_palette.js "#3B7DC9,#C2410C,#17915B,#B8860B,#7C3AED" \
//     --mode light --pairs all
//   → all checks pass; one WARN, #B8860B↔#17915B ΔE 6.5 (protan), which sits in
//     the 6–8 band the skill allows ONLY with secondary encoding. Four
//     alternative palettes were validated and all scored worse (they broke the
//     normal-vision floor), so the WARN is answered rather than dodged: every
//     year also carries a distinct DASH pattern, and the year PILLS above the
//     chart name each year next to its colour — identity is never colour-alone.
//
// ── The legend is gone; a tooltip replaced it (2026-08-26, user request) ──
// The legend under the chart restated what the pills already say and cost a
// whole row on a 420 px card. Hovering a month now opens a card listing every
// visible year's CA for that month, ranked — the read becomes « ce mois-ci, qui
// fait quoi » instead of « voici les couleurs ». The pills stay the colour key.
// "Annuel" has no pills, so each bar carries its total above it (the number the
// legend used to hold) and hovering gives the exact centime.

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { TrendingUp, Loader2 } from 'lucide-react'
import { CardContent } from '@/components/ui/card'
import { useElementSize } from '@/hooks/useElementSize'
import { apiFetch } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { niceScale } from '@/lib/chart-scale'
import { cn } from '@/lib/utils'
import { WidgetFrame } from './WidgetFrame'

interface Serie {
  year: number
  /** null = month not yet invoiced (current year only), never plotted. */
  months: (number | null)[]
  total: number
}
interface EvolutionResponse {
  years: number[]
  series: Serie[]
}

const MOIS = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc']

/** Fixed categorical order — index is position in the year list, so a year's
 *  colour never changes when another is toggled off (dataviz: colour follows
 *  the entity, never its rank). Paired with a dash pattern as the second
 *  channel the CVD WARN requires. */
const SERIES_STYLE = [
  { color: '#3B7DC9', dash: undefined },
  { color: '#C2410C', dash: '6 4' },
  { color: '#17915B', dash: undefined },
  { color: '#B8860B', dash: '2 4' },
  { color: '#7C3AED', dash: '8 3 2 3' },
] as const

function styleFor(index: number) {
  return SERIES_STYLE[index % SERIES_STYLE.length]
}

/** Stroke widths for the lead year and the ones behind it. The gap is
 *  deliberately wide: at 2 vs 2.5 the emphasis reads as a rendering artefact
 *  rather than as a ranking. */
const STROKE_LEAD = 3.25
const STROKE_BACK = 1.75

/** Compact euro for axis ticks — full precision lives in the tooltip. */
function eurShort(v: number): string {
  if (Math.abs(v) >= 1_000_000) return `${fmtNum(v / 1_000_000, 1)} M€`
  if (Math.abs(v) >= 1_000) return `${fmtNum(v / 1000, 0)} k€`
  return `${fmtNum(v, 0)} €`
}
function eur(v: number): string {
  return `${fmtNum(v, 2)} €`
}

// Chart geometry. The SVG is drawn at the container's REAL pixel size rather
// than through a viewBox: a viewBox with preserveAspectRatio="none" stretches
// the month labels horizontally as the widget is resized. Same approach as
// AnalyseFinanciereWidget.
const PAD = { top: 12, right: 12, bottom: 26, left: 56 }

export function EvolutionCaWidget() {
  const [mode, setMode] = useState<'mensuel' | 'annuel'>('mensuel')
  const [hidden, setHidden] = useState<Set<number>>(new Set())
  const [hoverMonth, setHoverMonth] = useState<number | null>(null)
  const [hoverYear, setHoverYear] = useState<number | null>(null)

  const query = useQuery<EvolutionResponse>({
    queryKey: ['ca-evolution'],
    queryFn: () => apiFetch('/rapports/ca-evolution'),
    staleTime: 0,
    refetchOnWindowFocus: false,
  })

  const series = query.data?.series ?? []
  const visible = useMemo(
    () => series.filter((s) => !hidden.has(s.year)),
    [series, hidden],
  )

  // Colour is keyed on the year's RECENCY inside the FULL list — newest first,
  // so the running year always takes style 0 — and never on its rank among the
  // VISIBLE ones, so toggling a year off never repaints the survivors.
  const styleByYear = useMemo(() => {
    const m = new Map<number, { color: string; dash?: string }>()
    series.forEach((s, i) => m.set(s.year, styleFor(series.length - 1 - i)))
    return m
  }, [series])

  /** The most recent year the endpoint returned — the running exercise, drawn
   *  thick and solid. Read off the DATA, not off the clock: in early January
   *  the books can still hold nothing for the new year, and the chart must then
   *  lead with the year it actually draws. */
  const leadYear = useMemo(
    () => (series.length ? Math.max(...series.map((s) => s.year)) : null),
    [series],
  )

  const [plotRef, plot] = useElementSize<HTMLDivElement>()
  const W = plot.w
  const H = plot.h

  // Round ticks (0 / 200 k€ / 400 k€), never the raw maximum — shared with the
  // Analyse financière chart.
  const scale = useMemo(() => {
    const vals = mode === 'mensuel'
      ? visible.flatMap((s) => s.months.filter((m): m is number => m != null))
      : series.map((s) => s.total)
    return niceScale(0, Math.max(0, ...vals))
  }, [mode, visible, series])

  const innerW = Math.max(0, W - PAD.left - PAD.right)
  const innerH = Math.max(0, H - PAD.top - PAD.bottom)
  const span = scale.hi - scale.lo || 1
  const xMonth = (i: number) => PAD.left + (innerW * i) / 11
  const y = (v: number) => PAD.top + innerH - (innerH * (v - scale.lo)) / span

  // ── Tooltip ────────────────────────────────────────────────────────────
  // Replaces the legend that used to sit under the chart. Positioned in the
  // plot's OWN pixel space — the SVG is drawn at the container's real size
  // rather than through a viewBox, so SVG units are CSS pixels and there is no
  // scaling to undo. The card hangs off the crosshair and flips to its other
  // side past the middle, so it never leaves the widget; vertically it centres
  // on the band of hovered points, then clamps inside the plot.
  const tooltip = useMemo(() => {
    if (W === 0 || H === 0) return null
    type Row = { key: number; label: string; value: number; color: string }
    let title: string
    let rows: Row[]
    let anchorX: number
    let ys: number[]

    if (mode === 'mensuel') {
      if (hoverMonth == null) return null
      // Ranked, not chronological: the question a hovered month answers is
      // "who is ahead this month", and the order is the answer.
      rows = visible
        .map((s) => ({
          key: s.year,
          label: String(s.year),
          value: s.months[hoverMonth],
          color: styleByYear.get(s.year)!.color,
        }))
        .filter((r): r is Row => r.value != null)
        .sort((a, b) => b.value - a.value)
      // A month the running year has not reached yet, with every other year
      // hidden: nothing to say, so no empty card.
      if (rows.length === 0) return null
      title = MOIS[hoverMonth]
      anchorX = xMonth(hoverMonth)
      ys = rows.map((r) => y(r.value))
    } else {
      if (hoverYear == null) return null
      const i = series.findIndex((s) => s.year === hoverYear)
      if (i < 0) return null
      const s = series[i]
      rows = [{ key: s.year, label: 'CA facturé', value: s.total, color: styleByYear.get(s.year)!.color }]
      title = String(s.year)
      anchorX = PAD.left + (innerW * (i + 0.5)) / series.length
      ys = [y(s.total)]
    }

    // Card height from its content: ~22px of chrome + 15px per row.
    const half = (22 + rows.length * 15) / 2
    const mid = (Math.min(...ys) + Math.max(...ys)) / 2
    return {
      title,
      rows,
      x: anchorX,
      y: Math.min(Math.max(mid, half + 2), Math.max(half + 2, H - half - 2)),
      flip: anchorX > W / 2,
    }
  }, [mode, hoverMonth, hoverYear, visible, series, styleByYear, W, H, innerW, innerH, scale])

  function toggleYear(year: number) {
    setHidden((prev) => {
      const next = new Set(prev)
      // Never let the last series be switched off — an empty chart reads as a
      // failure rather than a choice.
      if (next.has(year)) next.delete(year)
      else if (series.length - next.size > 1) next.add(year)
      return next
    })
  }

  return (
    <WidgetFrame
      icon={TrendingUp}
      title="Évolution du CA"
      actions={
        <div className="flex flex-shrink-0 items-center gap-0.5 rounded-md bg-white/10 p-0.5">
          {(['mensuel', 'annuel'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'rounded px-2 py-0.5 text-[11px] font-medium capitalize transition-colors',
                mode === m ? 'bg-gold text-gold-foreground' : 'text-white/70 hover:text-white',
              )}
            >
              {m}
            </button>
          ))}
        </div>
      }
    >
      <CardContent className="flex h-full flex-col gap-2 p-3">
        {query.isLoading && (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-accent" />
          </div>
        )}
        {query.isError && (
          <p className="py-8 text-center text-sm text-destructive">
            Impossible de charger l’évolution du CA.
          </p>
        )}

        {!query.isLoading && !query.isError && series.length > 0 && (
          <>
            {/* Year pills — the filter row sits above the chart (dataviz:
                interaction). In "annuel" every year is a bar, so toggling is a
                monthly-only control. */}
            {mode === 'mensuel' && (
              <div className="flex flex-shrink-0 flex-wrap gap-1">
                {series.map((s) => {
                  const st = styleByYear.get(s.year)!
                  const on = !hidden.has(s.year)
                  return (
                    <button
                      key={s.year}
                      type="button"
                      onClick={() => toggleYear(s.year)}
                      aria-pressed={on}
                      title={on ? `Masquer ${s.year}` : `Afficher ${s.year}`}
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[11px] font-semibold tabular-nums transition-colors',
                        on ? 'text-white' : 'text-muted-foreground',
                      )}
                      style={on
                        ? { backgroundColor: st.color }
                        : { backgroundColor: 'transparent', boxShadow: `inset 0 0 0 1px ${st.color}66` }}
                    >
                      {s.year}
                    </button>
                  )
                })}
              </div>
            )}

            <div ref={plotRef} className="relative min-h-0 flex-1">
              {W > 0 && H > 0 && (
              <svg
                width={W} height={H} className="block"
                role="img"
                aria-label={mode === 'mensuel'
                  ? `Évolution mensuelle du chiffre d'affaires pour ${visible.map((s) => s.year).join(', ')}`
                  : "Chiffre d'affaires par année"}
                onMouseLeave={() => { setHoverMonth(null); setHoverYear(null) }}
              >
                {/* Recessive grid */}
                {scale.ticks.map((t) => (
                  <g key={t}>
                    <line
                      x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)}
                      className="text-border" stroke="currentColor" strokeWidth={1}
                      opacity={t === 0 ? 1 : 0.45}
                    />
                    <text
                      x={PAD.left - 6} y={y(t) + 3} textAnchor="end"
                      className="fill-muted-foreground text-[9px] tabular-nums"
                    >
                      {eurShort(t)}
                    </text>
                  </g>
                ))}

                {mode === 'mensuel' ? (
                  <>
                    {MOIS.map((m, i) => (
                      <text
                        key={m} x={xMonth(i)} y={H - 8} textAnchor="middle"
                        className="fill-muted-foreground text-[9px]"
                      >
                        {m}
                      </text>
                    ))}

                    {/* Crosshair for the hovered month */}
                    {hoverMonth != null && (
                      <line
                        x1={xMonth(hoverMonth)} x2={xMonth(hoverMonth)}
                        y1={PAD.top} y2={PAD.top + innerH}
                        className="text-accent" stroke="currentColor" strokeWidth={1} opacity={0.7}
                      />
                    )}

                    {visible.map((s) => {
                      const st = styleByYear.get(s.year)!
                      // The running year is drawn thick, solid and at full
                      // opacity — and last, so it sits on top of the others.
                      const lead = s.year === leadYear
                      // A null month breaks the path rather than dropping the
                      // line to zero.
                      const d = s.months
                        .map((v, i) => (v == null ? null : `${xMonth(i)},${y(v)}`))
                        .reduce<string>((acc, pt, i) => {
                          if (pt == null) return acc
                          const prev = s.months[i - 1]
                          return acc + (i === 0 || prev == null ? `M${pt}` : `L${pt}`)
                        }, '')
                      return (
                        <path
                          key={s.year} d={d} fill="none"
                          stroke={st.color}
                          strokeWidth={lead ? STROKE_LEAD : STROKE_BACK}
                          strokeDasharray={st.dash}
                          opacity={lead ? 1 : 0.72}
                          strokeLinecap="round" strokeLinejoin="round"
                        />
                      )
                    })}

                    {/* Markers on the hovered month — 8px, ringed in surface
                        colour so overlapping years stay separable. */}
                    {hoverMonth != null && visible.map((s) => {
                      const v = s.months[hoverMonth]
                      if (v == null) return null
                      const st = styleByYear.get(s.year)!
                      return (
                        <circle
                          key={s.year} cx={xMonth(hoverMonth)} cy={y(v)} r={s.year === leadYear ? 5 : 4}
                          fill={st.color} stroke="#fff" strokeWidth={2}
                        />
                      )
                    })}

                    {/* Hit targets, wider than the marks */}
                    {MOIS.map((_, i) => (
                      <rect
                        key={i}
                        x={xMonth(i) - innerW / 22} y={PAD.top}
                        width={innerW / 11} height={innerH}
                        fill="transparent"
                        onMouseEnter={() => setHoverMonth(i)}
                      />
                    ))}
                  </>
                ) : (
                  <>
                    {series.map((s, i) => {
                      const bw = (innerW / series.length) * 0.6
                      const cx = PAD.left + (innerW * (i + 0.5)) / series.length
                      const top = y(s.total)
                      const st = styleByYear.get(s.year)!
                      return (
                        <g key={s.year}>
                          <rect
                            x={cx - bw / 2} y={top} width={bw}
                            height={Math.max(0, PAD.top + innerH - top)}
                            rx={4} fill={st.color}
                            opacity={hoverYear == null || hoverYear === s.year ? 1 : 0.5}
                            onMouseEnter={() => setHoverYear(s.year)}
                          />
                          {/* The total the removed legend used to carry. */}
                          <text
                            x={cx} y={Math.max(top - 5, 9)} textAnchor="middle"
                            className="fill-muted-foreground text-[9px] tabular-nums"
                          >
                            {eurShort(s.total)}
                          </text>
                          <text
                            x={cx} y={H - 8} textAnchor="middle"
                            className={cn(
                              'text-[9px] tabular-nums',
                              s.year === leadYear
                                ? 'fill-foreground font-semibold'
                                : 'fill-muted-foreground',
                            )}
                          >
                            {s.year}
                          </text>
                          {/* Hit target over the whole column, not just the
                              bar: a short bar is a 10px-tall target otherwise. */}
                          <rect
                            x={PAD.left + (innerW * i) / series.length} y={PAD.top}
                            width={innerW / series.length} height={innerH}
                            fill="transparent"
                            onMouseEnter={() => setHoverYear(s.year)}
                          />
                        </g>
                      )
                    })}
                  </>
                )}
              </svg>
              )}

              {/* Tooltip — the legend's replacement. Absolutely positioned in
                  the plot box, never clipped by it: `flip` swaps the side past
                  the middle and the y is clamped, so it stays inside the card
                  at every width the user drags it to. */}
              {tooltip && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute z-10 rounded-md border border-border bg-white/95 px-2.5 py-1.5 shadow-md"
                  style={{
                    left: tooltip.x,
                    top: tooltip.y,
                    transform: `translate(${tooltip.flip ? 'calc(-100% - 12px)' : '12px'}, -50%)`,
                  }}
                >
                  <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {tooltip.title}
                  </p>
                  <div className="flex flex-col gap-0.5">
                    {tooltip.rows.map((r) => (
                      <div key={r.key} className="flex items-center gap-3 whitespace-nowrap text-[11px]">
                        <span
                          className="h-2 w-2 flex-shrink-0 rounded-full"
                          style={{ backgroundColor: r.color }}
                        />
                        <span
                          className={cn(
                            'text-muted-foreground',
                            r.key === leadYear && 'font-semibold text-foreground',
                          )}
                        >
                          {r.label}
                        </span>
                        <span className="ml-auto font-medium tabular-nums">{eur(r.value)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* One hint line where the legend used to be — the year pills above
                are the colour key, and the tooltip carries the figures. */}
            <p className="flex-shrink-0 text-[10px] text-muted-foreground">
              {mode === 'mensuel'
                ? 'CA facturé par mois · survolez le graphique pour le détail'
                : 'CA facturé par année · survolez une barre pour le détail'}
            </p>
          </>
        )}
      </CardContent>
    </WidgetFrame>
  )
}
