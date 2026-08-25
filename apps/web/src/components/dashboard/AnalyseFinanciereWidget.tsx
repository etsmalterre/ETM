// ── Analyse financière widget ─────────────────────────────────────────────
// Ports the legacy "Analyse Financière" window: the year's cumulative curves
// (CA, marge brute, charges fixes, charges variables) plus the CA / marge brute
// / EBE reached at the last accountant upload.
//
// Every figure is a CUMULATIVE year-to-date balance, so a point is the last
// upload of its month — the curves only ever climb through the year, and the
// gap between marge brute and charges fixes IS the EBE.
//
// ⚠️ PORTÉE — ce que ces figures NE contiennent PAS, et pourquoi c'est affiché :
// `upload_compta.produits` exclut la **production stockée** (vérifié sur deux
// exercices : 2024 la portait à 178 359 € pour un résultat d'exploitation de
// 180 614 €, soit la totalité du résultat ; 2025 à 1 509 €), et les
// **provisions** sont sous l'EBE par définition. Un exercice où la production
// dépasse les ventes voit donc son EBE intermédiaire amputé, et la clôture
// annuelle le redresse. C'est ce qui a fait lire juillet 2026 comme un
// effondrement (-133 k€) alors que 146 k€ de production non vendue en portaient
// 82 % — d'où la mention permanente sous les tuiles, et non une infobulle.
//
// Gated server-side by `dashboard_finance`; the widget is only mounted when the
// user holds it (registry.tsx → useDashboardLayout).

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { LineChart, Loader2, AlertTriangle, Info } from 'lucide-react'
import { CardContent } from '@/components/ui/card'
import { PopoverSelect } from '@/components/ui/popover-select'
import { useElementSize } from '@/hooks/useElementSize'
import { apiFetch } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { cn } from '@/lib/utils'
// Shared with the Évolution du CA chart so both axes tick the same way.
import { niceScale } from '@/lib/chart-scale'
import { WidgetFrame } from './WidgetFrame'

// ── Types (mirror /api/rapports/finance/analyse) ──────────────

interface AnalysePoint {
  /** 1-12. Only months carrying an upload are present. */
  mois: number
  date: string
  ca: number
  charges_fixes: number
  charges_variables: number
  marge_brute: number
  ebe: number
}
interface AnalyseResponse {
  annees: number[]
  annee: number | null
  date_arrete: string | null
  points: AnalysePoint[]
  totaux: { ca: number; marge_brute: number; ebe: number } | null
}

type SeriesKey = 'ca' | 'marge_brute' | 'charges_variables' | 'charges_fixes'

/** Chart palette — the one place hex values are legitimate (SVG strokes have no
 *  Tailwind token, and the brand steps are too light to plot on white).
 *
 *  Slot 1 is the brand accent blue; the other three are darker steps of the
 *  design system's terracotta / green / gold hues, snapped until the dataviz
 *  validator passed on a white surface: lightness band, chroma floor, CVD
 *  separation and 3:1 contrast all PASS. The one WARN left is the
 *  marge brute ↔ charges fixes pair at ΔE 6.5 under protanopia, which is legal
 *  only with a second, non-colour channel — hence the dashes: produits are
 *  solid, charges are dashed, in the chart AND in the legend. Do not "simplify"
 *  the dashes away.
 *
 *  Re-run on any reordering (adjacency is what the check measures):
 *    node scripts/validate_palette.js "#3B7DC9,#C2410C,#17915B,#B8860B" --mode light
 *
 *  The order is the CALCULATION order — CA − charges variables = marge brute,
 *  − charges fixes = EBE — so the legend and the tooltip read like the maths
 *  rather than like the chart's z-order. Colours stay bound to their series. */
const SERIES: { key: SeriesKey; label: string; color: string; dash?: string }[] = [
  { key: 'ca', label: 'CA', color: '#3B7DC9' },
  { key: 'charges_variables', label: 'Charges variables', color: '#C2410C', dash: '6 4' },
  { key: 'marge_brute', label: 'Marge brute', color: '#17915B' },
  { key: 'charges_fixes', label: 'Charges fixes', color: '#B8860B', dash: '2 4' },
]

/** Series colour by key — the tooltip lays its rows out by hand. */
const COLOR: Record<SeriesKey, string> = SERIES.reduce(
  (acc, s) => ({ ...acc, [s.key]: s.color }),
  {} as Record<SeriesKey, string>,
)

const MOIS = ['jan', 'fév', 'mar', 'avr', 'mai', 'juin', 'juil', 'août', 'sep', 'oct', 'nov', 'déc']

/** "1 908 171 €" — these are company-level totals; centimes would be noise. */
function euro0(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—'
  return `${fmtNum(Math.round(v))} €`
}

/** Axis tick label — thousands, so the axis stays two glyphs wide. */
function euroTick(v: number): string {
  if (v === 0) return '0'
  if (Math.abs(v) >= 1_000_000) return `${fmtNum(v / 1_000_000, 1)} M€`
  return `${fmtNum(Math.round(v / 1000))} k€`
}

/** Share of CA, the legacy panel's "+31,2 %" under marge brute and EBE. */
function partDuCa(value: number, ca: number): number | null {
  if (!ca) return null
  return (value / ca) * 100
}

function formatArrete(d: string | null): string {
  if (!d || d.length !== 8) return ''
  return `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}`
}

export function AnalyseFinanciereWidget() {
  const [annee, setAnnee] = useState<number | null>(null)

  const query = useQuery<AnalyseResponse>({
    queryKey: ['finance-analyse', annee],
    queryFn: () => apiFetch(`/rapports/finance/analyse${annee ? `?annee=${annee}` : ''}`),
    staleTime: 5 * 60_000,
  })

  const data = query.data
  const points = data?.points ?? []
  const totaux = data?.totaux
  const anneeOptions = (data?.annees ?? []).map((y) => ({ id: y, primary: String(y) }))
  const shownAnnee = data?.annee ?? annee ?? new Date().getFullYear()

  // Sized against the WIDGET, not the viewport: the card can be dragged narrow
  // on a wide screen, where a `sm:` breakpoint would still show three tiles.
  const [bodyRef, bodySize] = useElementSize<HTMLDivElement>()
  const bw = bodySize.w
  const tight = bw > 0 && bw < 470
  /** Three tiles sharing a narrow row — shrink the figures rather than wrap. */
  const denseTiles = bw >= 470 && bw < 620

  return (
    <WidgetFrame
      icon={LineChart}
      title="Analyse financière"
      actions={
        <PopoverSelect
          options={anneeOptions.length > 0 ? anneeOptions : [{ id: shownAnnee, primary: String(shownAnnee) }]}
          value={shownAnnee}
          onChange={setAnnee}
          hideEmpty
          size="sm"
          widthClass={tight ? 'w-[78px]' : 'w-[104px]'}
        />
      }
    >
      {/* h-full, not min-h-full — a definite height is what bounds the `flex-1`
          chart below, so the card never grows past the size the user gave it. */}
      <CardContent ref={bodyRef} className={cn('flex h-full flex-col space-y-4', tight ? 'p-3' : 'p-5')}>
        {/* Figures of the day — the legacy right-hand panel. */}
        <div className={cn('grid gap-3', tight ? 'grid-cols-1' : 'grid-cols-3')}>
          <FigureTile label="CA" value={totaux?.ca} strong tight={tight} />
          <FigureTile
            label="Marge brute"
            value={totaux?.marge_brute}
            pct={totaux ? partDuCa(totaux.marge_brute, totaux.ca) : null}
            tight={denseTiles}
          />
          <FigureTile
            label="EBE"
            value={totaux?.ebe}
            pct={totaux ? partDuCa(totaux.ebe, totaux.ca) : null}
            tight={denseTiles}
          />
        </div>

        {/* Portée des figures — voir le commentaire en tête de fichier. Toujours
            visible, pas une infobulle : c'est précisément l'absence de cette
            mention qui a fait lire l'EBE de juillet 2026 comme un effondrement
            alors que 146 k€ de production non vendue l'amputaient. */}
        <p className="-mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground">
          <Info className="mt-px h-3 w-3 flex-shrink-0 opacity-60" />
          <span>Hors production stockée et provisions, comptabilisées à la clôture annuelle.</span>
        </p>

        {/* Evolution */}
        <div className="flex flex-1 min-h-[180px] flex-col overflow-hidden rounded-lg border border-border/60 bg-white">
          <div className="flex flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/60 bg-zinc-200/50 px-3 py-1.5">
            {SERIES.map((s) => (
              <span key={s.key} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <svg width="16" height="6" aria-hidden>
                  <line
                    x1="0" y1="3" x2="16" y2="3"
                    stroke={s.color} strokeWidth={2} strokeDasharray={s.dash} strokeLinecap="round"
                  />
                </svg>
                {s.label}
              </span>
            ))}
            {data?.date_arrete && (
              <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
                au {formatArrete(data.date_arrete)}
              </span>
            )}
          </div>

          {query.isLoading ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-accent" />
            </div>
          ) : query.isError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-destructive">
              <AlertTriangle className="h-8 w-8" />
              <p className="text-sm">Impossible de charger l'analyse financière.</p>
            </div>
          ) : points.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
              <LineChart className="h-10 w-10 opacity-30" />
              <p className="text-sm">Aucun relevé comptable sur cette année.</p>
            </div>
          ) : (
            <EvolutionChart points={points} />
          )}
        </div>
      </CardContent>
    </WidgetFrame>
  )
}

// ── Chart ─────────────────────────────────────────────────────

const PAD = { top: 10, right: 14, bottom: 20, left: 54 }

function EvolutionChart({ points }: { points: AnalysePoint[] }) {
  const [box, size] = useElementSize<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)

  const w = size.w
  const h = size.h
  const innerW = Math.max(0, w - PAD.left - PAD.right)
  const innerH = Math.max(0, h - PAD.top - PAD.bottom)

  const scale = useMemo(() => {
    let min = 0
    let max = 0
    for (const p of points) {
      for (const s of SERIES) {
        min = Math.min(min, p[s.key])
        max = Math.max(max, p[s.key])
      }
    }
    return niceScale(min, max)
  }, [points])

  // The x axis always spans the 12 months, so a part-year reads as a part-year
  // instead of stretching three uploads across the whole card.
  const x = (mois: number) => PAD.left + ((mois - 1) / 11) * innerW
  const y = (v: number) => PAD.top + innerH - ((v - scale.lo) / (scale.hi - scale.lo)) * innerH

  // Room for every month label, or every other one on a narrow card.
  const labelStep = innerW < 360 ? 2 : 1
  const hovered = hover === null ? null : points[hover] ?? null

  return (
    <div ref={box} className="relative flex-1 min-h-0">
      {w > 0 && h > 0 && (
        <svg width={w} height={h} className="block">
          {/* Grid + y ticks */}
          <g className="text-border">
            {scale.ticks.map((t) => (
              <line
                key={t}
                x1={PAD.left} x2={PAD.left + innerW} y1={y(t)} y2={y(t)}
                stroke="currentColor" strokeWidth={1} opacity={t === 0 ? 1 : 0.55}
              />
            ))}
          </g>
          <g className="text-muted-foreground">
            {scale.ticks.map((t) => (
              <text
                key={t}
                x={PAD.left - 6} y={y(t) + 3}
                textAnchor="end" fontSize={10} fill="currentColor" className="tabular-nums"
              >
                {euroTick(t)}
              </text>
            ))}
            {MOIS.map((m, i) =>
              i % labelStep === 0 ? (
                <text
                  key={m} x={x(i + 1)} y={PAD.top + innerH + 14}
                  textAnchor="middle" fontSize={10} fill="currentColor"
                >
                  {m}
                </text>
              ) : null,
            )}
          </g>

          {/* Crosshair under the marks so it never hides a line */}
          {hovered && (
            <line
              x1={x(hovered.mois)} x2={x(hovered.mois)} y1={PAD.top} y2={PAD.top + innerH}
              className="text-accent" stroke="currentColor" strokeWidth={1} opacity={0.7}
            />
          )}

          {/* Series */}
          {SERIES.map((s) => (
            <path
              key={s.key}
              d={points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.mois)},${y(p[s.key])}`).join(' ')}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeDasharray={s.dash}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}

          {/* End markers, and the hovered month's values */}
          {SERIES.map((s) => {
            const end = points[points.length - 1]
            return (
              <g key={`dot-${s.key}`}>
                <circle cx={x(end.mois)} cy={y(end[s.key])} r={4} fill={s.color} stroke="#fff" strokeWidth={2} />
                {hovered && hovered !== end && (
                  <circle cx={x(hovered.mois)} cy={y(hovered[s.key])} r={4} fill={s.color} stroke="#fff" strokeWidth={2} />
                )}
              </g>
            )
          })}

          {/* Hit layer — one band per point, wider than the marks themselves */}
          <rect
            x={PAD.left} y={PAD.top} width={innerW} height={innerH} fill="transparent"
            onMouseMove={(e) => {
              const rect = (e.currentTarget as SVGRectElement).getBoundingClientRect()
              const rel = e.clientX - rect.left
              const mois = 1 + (rel / Math.max(innerW, 1)) * 11
              let best = 0
              for (let i = 1; i < points.length; i++) {
                if (Math.abs(points[i].mois - mois) < Math.abs(points[best].mois - mois)) best = i
              }
              setHover(best)
            }}
            onMouseLeave={() => setHover(null)}
          />
        </svg>
      )}

      {hovered && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-border/60 bg-white/95 px-2 py-1.5 shadow-md backdrop-blur-sm"
          style={{
            // Flip to the left of the crosshair once it would overflow the card.
            left: Math.min(x(hovered.mois) + 10, Math.max(w - 190, 0)),
            top: PAD.top,
          }}
        >
          <p className="mb-1 text-[11px] font-semibold">
            {MOIS[hovered.mois - 1]} · {formatArrete(hovered.date)}
          </p>
          {/* Read top to bottom, it is the calculation: CA − charges variables
              = marge brute, − charges fixes = EBE. The rules sit above the two
              subtotals for the same reason. */}
          <TipRow color={COLOR.ca} label="CA" value={hovered.ca} />
          <TipRow color={COLOR.charges_variables} label="Charges variables" value={hovered.charges_variables} minus />
          <TipRow color={COLOR.marge_brute} label="Marge brute" value={hovered.marge_brute} subtotal />
          <TipRow color={COLOR.charges_fixes} label="Charges fixes" value={hovered.charges_fixes} minus />
          <TipRow label="EBE" value={hovered.ebe} subtotal />
        </div>
      )}
    </div>
  )
}

/** One line of the tooltip's calculation. `minus` marks a deduction, `subtotal`
 *  the line it lands on (ruled off above, and bold). */
function TipRow({
  color, label, value, minus, subtotal,
}: {
  color?: string
  label: string
  value: number
  minus?: boolean
  subtotal?: boolean
}) {
  return (
    <p
      className={cn(
        'flex items-center gap-1.5 whitespace-nowrap text-[11px]',
        subtotal && 'mt-1 border-t border-border/60 pt-1',
      )}
    >
      <span
        className="h-1.5 w-3 flex-shrink-0 rounded-full"
        style={color ? { background: color } : undefined}
      />
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('ml-auto pl-3 tabular-nums', subtotal ? 'font-semibold' : 'font-medium')}>
        {minus && <span className="text-muted-foreground">− </span>}
        {euro0(value)}
      </span>
    </p>
  )
}

// ── Figure tiles ──────────────────────────────────────────────

function FigureTile({
  label, value, pct, strong, tight,
}: {
  label: string
  value?: number
  pct?: number | null
  strong?: boolean
  tight?: boolean
}) {
  const negative = value != null && value < 0
  return (
    <div
      className={cn(
        'rounded-xl border p-3',
        strong
          ? 'border-gold/30 bg-gradient-to-br from-gold/15 via-gold/[0.06] to-transparent'
          : 'border-border/60 bg-muted/30',
      )}
    >
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p
        className={cn(
          'mt-1 tabular-nums',
          strong
            ? cn('font-bold', tight ? 'text-xl' : 'text-2xl')
            : cn('font-semibold', tight ? 'text-lg' : 'text-xl'),
          negative && 'text-destructive',
        )}
      >
        {value == null ? '—' : euro0(value)}
      </p>
      {pct != null && (
        <p className="text-[11px] tabular-nums text-muted-foreground">
          {fmtNum(pct, 1)} % du CA
        </p>
      )}
    </div>
  )
}
