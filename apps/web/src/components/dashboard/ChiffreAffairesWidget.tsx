// ── Chiffre d'affaires widget ─────────────────────────────────────────────
// Ports the legacy "Comparatif CA" dashboard block: every client ranked by
// revenue for the selected year, with the previous year's revenue and rank
// delta alongside.
//
// Both endpoints are gated server-side by the `dashboard_ca` permission; the
// widget itself is only mounted when the user holds it (see Dashboard.tsx).

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Sparkles,
  Loader2,
  AlertTriangle,
} from 'lucide-react'
import { CardContent } from '@/components/ui/card'
import { PopoverSelect } from '@/components/ui/popover-select'
import { useElementSize } from '@/hooks/useElementSize'
import { apiFetch } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { cn } from '@/lib/utils'
import { WidgetFrame } from './WidgetFrame'

// ── Types (mirror /api/rapports/ca-*) ─────────────────────────

interface CaClientRow {
  IDclient: number
  nom: string
  ca: number
  ca_prev: number
  rang: number
  /** Rank in the previous year, or null when the client billed nothing then. */
  rang_prev: number | null
}
interface CaClientsResponse {
  year: number
  previous_year: number
  /** Which slice of both years the figures cover — see PERIODS. */
  period: PeriodKey
  /** `MMDD` cutoff shared by both years in `ytd`, null in `full`. */
  through: string | null
  years: number[]
  rows: CaClientRow[]
  total: number
  total_prev: number
}

// ── Comparison period ─────────────────────────────────────────
// "Année complète" is the legacy comparison (whole year vs whole year, so the
// running year is compared against 12 months it hasn't lived yet). "Même
// période" cuts both years at today's day of the year, which is the only honest
// read of an evolution mid-year — and is therefore the DEFAULT since
// 2026-08-26 (user request). The legacy read stays one click away; it is the
// right one on a closed exercise, where the two modes coincide anyway.

type PeriodKey = 'full' | 'ytd'

const PERIOD_IDS: Record<PeriodKey, number> = { full: 1, ytd: 2 }

// ── Table views ───────────────────────────────────────────────
// One control mixing filters and sorts: they answer the same question ("which
// clients do I want to look at?") and a widget header has no room for two.

type ViewKey = 'rank' | 'growth' | 'decline' | 'new' | 'lost' | 'split'

const VIEWS: { id: number; key: ViewKey; label: string; description: string }[] = [
  { id: 1, key: 'rank', label: 'Classement CA', description: 'Du plus gros CA au plus faible' },
  { id: 2, key: 'growth', label: 'Meilleures progressions', description: 'Hausses de rang, hors nouveaux' },
  { id: 3, key: 'decline', label: 'Plus fortes baisses', description: 'Baisses de rang, hors perdus' },
  { id: 4, key: 'new', label: 'Nouveaux clients', description: 'Rien facturé la période précédente' },
  { id: 5, key: 'lost', label: 'Clients perdus', description: 'Rien facturé sur la période' },
  { id: 6, key: 'split', label: 'Répartition', description: 'Camembert du CA par client' },
]

/** Places climbed since the previous period. Only meaningful once the client
 *  had a rank to climb from — callers filter `rang_prev === null` out first. */
function rankDelta(r: CaClientRow): number {
  return (r.rang_prev ?? r.rang) - r.rang
}

/** Filter + sort the server ranking for the selected view.
 *
 *  Growth and decline measure movement in the RANKING, not in euros, and each
 *  drops the category that has its own view and no comparable movement: a new
 *  client didn't climb (it had no rank), a lost one didn't slip (it left the
 *  ranking). Ties break on the figure that made the move. */
function applyView(rows: CaClientRow[], view: ViewKey): CaClientRow[] {
  switch (view) {
    case 'growth':
      return rows
        .filter((r) => r.rang_prev !== null)
        .sort((a, b) => rankDelta(b) - rankDelta(a) || b.ca - a.ca)
    case 'decline':
      return rows
        .filter((r) => r.rang_prev !== null && r.ca !== 0)
        .sort((a, b) => rankDelta(a) - rankDelta(b) || b.ca_prev - a.ca_prev)
    case 'new':
      return rows.filter((r) => r.ca !== 0 && r.ca_prev === 0)
    case 'lost':
      return rows.filter((r) => r.ca === 0 && r.ca_prev !== 0)
    default:
      return rows
  }
}

/** Sum euro amounts through integer centimes — same drift guard as the API. */
function sumEuros(values: number[]): number {
  return values.reduce((s, v) => s + Math.round(v * 100), 0) / 100
}

/** "12 345,67 €" — always two decimals, plain-space thousands (§26bis). */
function euro(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—'
  return `${fmtNum(v, 2)} €`
}

/** Year-over-year variation in percent. Null when there's no base to compare. */
function variationPct(ca: number, caPrev: number): number | null {
  if (caPrev === 0) return null
  return ((ca - caPrev) / Math.abs(caPrev)) * 100
}

// The ranking fills whatever room the card's height leaves after the tiles —
// that is what the bottom-edge drag acts on.
const RANKING_FILLED = 'flex-1 min-h-[120px]'

export function ChiffreAffairesWidget() {
  const today = new Date()
  const currentYear = today.getFullYear()
  const [year, setYear] = useState(currentYear)
  const [period, setPeriod] = useState<PeriodKey>('ytd')
  const [view, setView] = useState<ViewKey>('rank')

  const caQuery = useQuery<CaClientsResponse>({
    queryKey: ['ca-clients', year, period],
    queryFn: () => apiFetch(`/rapports/ca-clients?year=${year}&period=${period}`),
    staleTime: 5 * 60_000,
  })

  const data = caQuery.data
  const rows = data?.rows ?? []
  const visible = useMemo(() => applyView(rows, view), [rows, view])

  const yearOptions = (data?.years ?? [year]).map((y) => ({ id: y, primary: String(y) }))
  const prevYear = data?.previous_year ?? year - 1
  const totalVariation = variationPct(data?.total ?? 0, data?.total_prev ?? 0)

  // "au 29/07" — the cutoff both years share in cumul mode. Computed locally so
  // the picker reads right before the first response lands.
  const cutoffLabel = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}`
  const periodOptions = [
    {
      id: PERIOD_IDS.full,
      primary: 'Année complète',
      description: "Du 1er janvier au 31 décembre, face à l'année précédente entière",
    },
    {
      id: PERIOD_IDS.ytd,
      // No `secondary: 'au 29/07'` on the trigger — it truncates there, and the
      // tiles right below already carry the cutoff.
      primary: 'Même période',
      description: `Du 1er janvier au ${cutoffLabel}, face à la même période l'année précédente`,
    },
  ]
  const periodSub = period === 'ytd' ? `au ${cutoffLabel}` : undefined

  // Everything below adapts to the WIDGET's width, not the viewport's: the user
  // drags this card to any width on a 1920px screen, so a `sm:` breakpoint
  // would keep three tiles side by side in a 300px card (and wrap the amounts
  // onto three lines each). Zero means "not measured yet" — assume roomy, which
  // is the desktop default, rather than flashing the cramped layout.
  const [bodyRef, bodySize] = useElementSize<HTMLDivElement>()
  const bw = bodySize.w
  // Thresholds come from the widest thing each layout has to hold: an amount
  // like "2 684 442,74 €" is ~135px at text-xl, so three tiles plus their
  // padding need ~470px before they stop wrapping mid-number.
  const tight = bw > 0 && bw < 470
  /** Three tiles sharing a narrow row — shrink the figures rather than wrap. */
  const denseTiles = bw >= 470 && bw < 620
  const showPrevColumn = bw === 0 || bw >= 470
  const showEvolutionColumn = bw === 0 || bw >= 350

  return (
    <WidgetFrame
      icon={TrendingUp}
      title="Chiffre d'affaires"
      actions={
        <div className="flex items-center gap-1.5">
          <PopoverSelect
            options={periodOptions}
            value={PERIOD_IDS[period]}
            onChange={(id) => setPeriod(id === PERIOD_IDS.ytd ? 'ytd' : 'full')}
            hideEmpty
            size="sm"
            widthClass={tight ? 'w-[124px]' : 'w-[158px]'}
          />
          <PopoverSelect
            options={yearOptions}
            value={year}
            onChange={setYear}
            hideEmpty
            size="sm"
            widthClass={tight ? 'w-[78px]' : 'w-[104px]'}
          />
        </div>
      }
    >
      {/* h-full, not min-h-full: with an auto height the ranking box below
          grows to its 144 rows and the whole widget scrolls, which leaves the
          table's own scroller (and its sticky header and totals) unused. A
          definite height is what makes `flex-1` inside actually bound. */}
      <CardContent ref={bodyRef} className={cn('flex h-full flex-col space-y-4', tight ? 'p-3' : 'p-5')}>
        {/* Period totals + variation */}
        <div className={cn('grid gap-3', tight ? 'grid-cols-1' : 'grid-cols-3')}>
          <TotalTile label={`CA ${year}`} sub={periodSub} value={data?.total} strong tight={denseTiles} />
          <TotalTile label={`CA ${prevYear}`} sub={periodSub} value={data?.total_prev} tight={denseTiles} />
          <VariationTile
            pct={totalVariation}
            delta={(data?.total ?? 0) - (data?.total_prev ?? 0)}
            tight={denseTiles}
          />
        </div>

        {/* Ranking */}
        <div className={cn(
          'flex flex-col rounded-lg border border-border/60 bg-white overflow-hidden',
          RANKING_FILLED,
        )}>
          {/* View picker — narrows / re-sorts the ranking below it. */}
          <div className="flex-shrink-0 flex items-center gap-2 border-b border-border/60 bg-zinc-200/50 px-2 py-1.5">
            <PopoverSelect
              options={VIEWS.map((v) => ({ id: v.id, primary: v.label, description: v.description }))}
              value={VIEWS.find((v) => v.key === view)?.id ?? 1}
              onChange={(id) => setView(VIEWS.find((v) => v.id === id)?.key ?? 'rank')}
              hideEmpty
              size="sm"
              widthClass="w-[216px]"
            />
            {!caQuery.isLoading && !caQuery.isError && (
              <span className="ml-auto pr-1 text-xs tabular-nums text-muted-foreground">
                {visible.length} client{visible.length > 1 ? 's' : ''}
              </span>
            )}
          </div>

          {caQuery.isLoading ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-accent" />
            </div>
          ) : caQuery.isError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-destructive">
              <AlertTriangle className="h-8 w-8" />
              <p className="text-sm">Impossible de charger le chiffre d'affaires.</p>
            </div>
          ) : visible.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
              <TrendingUp className="h-10 w-10 opacity-30" />
              <p className="text-sm">
                {rows.length === 0
                  ? "Aucun chiffre d'affaires sur cette période."
                  : 'Aucun client dans cette vue.'}
              </p>
            </div>
          ) : view === 'split' ? (
            <RepartitionChart rows={visible} />
          ) : (
            <div className="min-w-0 flex-1 min-h-0 overflow-auto scrollbar-transparent">
              {/* table-fixed + colgroup, per mps_designer §27.3: with the
                  default auto layout a long client name sets the table's
                  min-content width and the € columns push straight out of the
                  card. Fixed columns make the name truncate instead. */}
              <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
                <colgroup>
                  <col style={{ width: tight ? 72 : 92 }} />
                  <col />
                  <col style={{ width: tight ? 96 : 118 }} />
                  {showPrevColumn && <col style={{ width: 118 }} />}
                  {showEvolutionColumn && <col style={{ width: tight ? 84 : 104 }} />}
                </colgroup>
                <thead className="sticky top-0 z-10 bg-zinc-200/80 backdrop-blur-sm">
                  <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 text-left font-semibold">Rang</th>
                    <th className="px-3 py-2 text-left font-semibold">Client</th>
                    <th className="px-3 py-2 text-right font-semibold whitespace-nowrap">{year}</th>
                    {showPrevColumn && (
                      <th className="px-3 py-2 text-right font-semibold whitespace-nowrap">{prevYear}</th>
                    )}
                    {showEvolutionColumn && (
                      <th className="px-3 py-2 text-right font-semibold">Évol.</th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <CaRow
                      key={r.IDclient}
                      row={r}
                      showPrev={showPrevColumn}
                      showEvolution={showEvolutionColumn}
                    />
                  ))}
                </tbody>
                {/* Totals stay in the table so they line up under their columns,
                    and they follow the view: a filtered table showing the
                    period's grand total would just look like an arithmetic bug
                    (the tiles above keep the unfiltered figures). */}
                <tfoot className="sticky bottom-0 z-10 bg-zinc-200/80 backdrop-blur-sm">
                  <tr className="border-t border-border">
                    <td className="px-3 py-2 text-xs font-bold uppercase tracking-wide" colSpan={2}>
                      Total
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-bold whitespace-nowrap">
                      {euro(sumEuros(visible.map((r) => r.ca)))}
                    </td>
                    {showPrevColumn && (
                      <td className="px-3 py-2 text-right tabular-nums font-semibold text-muted-foreground whitespace-nowrap">
                        {euro(sumEuros(visible.map((r) => r.ca_prev)))}
                      </td>
                    )}
                    {showEvolutionColumn && <td className="px-3 py-2" />}
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </CardContent>
    </WidgetFrame>
  )
}

// ── Ranking row ───────────────────────────────────────────────

function CaRow({
  row, showPrev, showEvolution,
}: {
  row: CaClientRow
  showPrev: boolean
  showEvolution: boolean
}) {
  const pct = variationPct(row.ca, row.ca_prev)
  const up = row.ca > row.ca_prev
  return (
    <tr className="border-t border-border/40 hover:bg-accent/5 transition-colors">
      <td className="px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          {/* Always the CA rank, even when the view sorts on something else. */}
          <span className="tabular-nums text-xs text-muted-foreground w-5 text-right" title="Rang CA">
            {row.rang}
          </span>
          <RankDelta rang={row.rang} rangPrev={row.rang_prev} />
        </div>
      </td>
      <td className="px-3 py-1.5">
        <span className="block truncate font-medium" title={row.nom}>{row.nom}</span>
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums font-medium whitespace-nowrap">
        {euro(row.ca)}
      </td>
      {showPrev && (
        <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground whitespace-nowrap">
          {euro(row.ca_prev)}
        </td>
      )}
      {showEvolution && (
        <td className="px-3 py-1.5 text-right">
          {pct === null ? (
            <span className="text-xs italic text-muted-foreground">nouveau</span>
          ) : (
            <span
              className={cn(
                'inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums',
                up ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive',
              )}
            >
              {up ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
              {pct > 0 ? '+' : ''}{fmtNum(pct, 0)} %
            </span>
          )}
        </td>
      )}
    </tr>
  )
}

/** Rank movement vs the previous year — the legacy "Rang" arrow column. */
function RankDelta({ rang, rangPrev }: { rang: number; rangPrev: number | null }) {
  if (rangPrev === null) {
    return (
      <span
        className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-semibold bg-accent/15 text-accent"
        title="Nouveau client sur la période"
      >
        <Sparkles className="h-2.5 w-2.5" />N
      </span>
    )
  }
  // Positive delta = climbed the ranking (rank number went down).
  const delta = rangPrev - rang
  if (delta === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-semibold bg-muted text-muted-foreground" title="Rang inchangé">
        <Minus className="h-2.5 w-2.5" />0
      </span>
    )
  }
  const up = delta > 0
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-semibold tabular-nums',
        up ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive',
      )}
      title={`Rang ${rangPrev} → ${rang}`}
    >
      {up ? <TrendingUp className="h-2.5 w-2.5" /> : <TrendingDown className="h-2.5 w-2.5" />}
      {up ? '+' : ''}{delta}
    </span>
  )
}

// ── Répartition (donut) ───────────────────────────────────────
// The "Répartition" view swaps the table for a share-of-CA donut, cut the way
// the business reads its client base: every client at 10 000 € or more gets its
// own slice, the 5 000 – 10 000 € clients share one, and the tail below 5 000 €
// shares another. The two buckets are the "Other" fold — they wear grey, never
// a palette hue, so the eye separates named clients from the tail instantly.
//
// There are no labels around the ring: they cost more width than the slices are
// worth in a dashboard card. Identity comes from the hover read-out in the hole,
// which names the slice with its amount and its share.

/** Categorical palette (light steps) in its validated order: worst adjacent
 *  CVD ΔE 9.1, normal-vision 19.6.
 *
 *  Past eight clients the palette takes a second lap at a lighter step —
 *  composite encoding (hue × shade), the method's answer to "more series than
 *  slots". Never a generated ninth hue: no colour-blind reader could separate
 *  it from an existing one. The grey buckets always close the ring, so the
 *  wrap-around pair is never two laps of the same hue. */
const PIE_COLORS = [
  '#2a78d6', '#eb6834', '#1baf7a', '#eda100',
  '#e87ba4', '#008300', '#4a3aa7', '#e34948',
]
/** Buckets: a fold, not a series — grey, outside the palette. */
const PIE_BUCKET_MID = '#a1a1aa' // zinc-400
const PIE_BUCKET_LOW = '#d4d4d8' // zinc-300

/** A client at or above this bills enough to be worth naming on its own. */
const SEUIL_INDIVIDUEL = 10_000
/** Below this the client joins the long tail. */
const SEUIL_BUCKET = 5_000

interface Slice {
  key: string
  label: string
  value: number
  color: string
  /** How many clients the slice stands for — 1 except on the buckets. */
  count: number
}

/** Slot i, lightened on the second lap so a 9th client never repeats a colour
 *  exactly. `mix` 0 = the hue itself, 1 = white. */
function sliceColor(i: number): string {
  const base = PIE_COLORS[i % PIE_COLORS.length]
  const lap = Math.floor(i / PIE_COLORS.length)
  if (lap === 0) return base
  return mixWithWhite(base, Math.min(0.28 * lap, 0.56))
}

function mixWithWhite(hex: string, mix: number): string {
  const v = parseInt(hex.slice(1), 16)
  const ch = [(v >> 16) & 255, (v >> 8) & 255, v & 255]
    .map((c) => Math.round(c + (255 - c) * mix))
    .map((c) => c.toString(16).padStart(2, '0'))
  return `#${ch.join('')}`
}

function RepartitionChart({ rows }: { rows: CaClientRow[] }) {
  const [hover, setHover] = useState<string | null>(null)

  // `rows` arrives ranked by CA, so the individual slices come out ranked too.
  // Clients at or below 0 € (avoirs) still count inside the bottom bucket, which
  // is what keeps the slices adding up to the period's total.
  const slices = useMemo<Slice[]>(() => {
    const out: Slice[] = []
    const mid: CaClientRow[] = []
    const low: CaClientRow[] = []
    for (const r of rows) {
      if (r.ca >= SEUIL_INDIVIDUEL) {
        out.push({ key: String(r.IDclient), label: r.nom, value: r.ca, color: sliceColor(out.length), count: 1 })
      } else if (r.ca >= SEUIL_BUCKET) {
        mid.push(r)
      } else {
        low.push(r)
      }
    }
    const bucket = (key: string, label: string, rs: CaClientRow[], color: string) => {
      const value = sumEuros(rs.map((r) => r.ca))
      // A bucket whose tail nets out negative has no arc to draw.
      if (rs.length === 0 || value <= 0) return
      out.push({ key, label, value, color, count: rs.length })
    }
    bucket('mid', '5 000 € à 10 000 €', mid, PIE_BUCKET_MID)
    bucket('low', 'Moins de 5 000 €', low, PIE_BUCKET_LOW)
    return out
  }, [rows])

  const base = sumEuros(slices.map((s) => s.value))
  const arcs = useMemo(() => {
    let acc = 0
    return slices.map((s) => {
      const from = acc / base
      acc += s.value
      return { slice: s, from, to: acc / base }
    })
  }, [slices, base])

  const active = hover ? slices.find((s) => s.key === hover) ?? null : null

  // The ring is drawn at an explicit square size taken from the box it sits in,
  // never `h-full w-auto`: a 1:1 SVG told to fill a tall, narrow card comes out
  // wider than the card and the widget starts scrolling sideways. Measured box
  // → smaller side → the donut always fits the space the widget gives it.
  //
  // The read-out is sized off the same number: on a wide card it becomes the
  // hero figure the hole is asking for, and it shrinks with the ring rather
  // than overflowing when the card is dragged down to a corner.
  const [box, size] = useElementSize<HTMLDivElement>()
  const ring = Math.min(size.w, size.h)
  const holeWidth = ring * 0.5
  const px = (factor: number, min: number, max: number) =>
    Math.round(Math.min(Math.max(ring * factor, min), max))

  return (
    <div ref={box} className="relative flex flex-1 min-h-0 items-center justify-center overflow-hidden p-3">
      <svg
        width={ring}
        height={ring}
        viewBox="-50 -50 100 100"
        className="block flex-shrink-0"
        role="img"
        aria-label="Répartition du CA par client"
      >
        {slices.length === 1 ? (
          <circle r={36.5} fill="none" stroke={slices[0].color} strokeWidth={19} />
        ) : (
          arcs.map(({ slice, from, to }) => (
            <path
              key={slice.key}
              d={donutPath(from, to, 46, 27)}
              fill={slice.color}
              // 2px of surface between touching slices — the separator is the
              // gap, never an outline drawn around the mark. Non-scaling so it
              // stays 2px whatever size the card gives the ring.
              stroke="#fff"
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
              opacity={hover && hover !== slice.key ? 0.4 : 1}
              onMouseEnter={() => setHover(slice.key)}
              onMouseLeave={() => setHover(null)}
            />
          ))
        )}
      </svg>

      {/* Hole — the total, or whatever the pointer is on */}
      <div
        className="pointer-events-none absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center gap-0.5 text-center"
        style={{ width: holeWidth }}
      >
        <p
          className="max-w-full truncate font-medium text-muted-foreground"
          style={{ fontSize: px(0.035, 10, 14) }}
          title={active?.label}
        >
          {active ? active.label : 'CA total'}
        </p>
        <p
          className="font-bold leading-tight"
          style={{ fontSize: px(0.06, 14, 24) }}
        >
          {euro(active ? active.value : base)}
        </p>
        {active && (
          <p
            className="font-semibold tabular-nums text-accent-blue"
            style={{ fontSize: px(0.04, 10, 16) }}
          >
            {fmtNum(sharePct(active.value, base), 1)} %
            {active.count > 1 && (
              <span className="font-normal text-muted-foreground"> · {active.count} clients</span>
            )}
          </p>
        )}
      </div>
    </div>
  )
}

function sharePct(value: number, base: number): number {
  return base === 0 ? 0 : (value / base) * 100
}

/** Donut segment between two fractions of the circle, starting at 12 o'clock
 *  and running clockwise. Radii are viewBox units, centre at (0, 0). */
function donutPath(from: number, to: number, outer: number, inner: number): string {
  const a0 = from * 2 * Math.PI - Math.PI / 2
  const a1 = to * 2 * Math.PI - Math.PI / 2
  const large = to - from > 0.5 ? 1 : 0
  const p = (a: number, r: number) => `${(Math.cos(a) * r).toFixed(3)},${(Math.sin(a) * r).toFixed(3)}`
  return [
    `M${p(a0, outer)}`,
    `A${outer},${outer} 0 ${large} 1 ${p(a1, outer)}`,
    `L${p(a1, inner)}`,
    `A${inner},${inner} 0 ${large} 0 ${p(a0, inner)}`,
    'Z',
  ].join(' ')
}

// ── Header tiles ──────────────────────────────────────────────

function TotalTile({
  label, sub, value, strong, tight,
}: {
  label: string
  sub?: string
  value?: number
  strong?: boolean
  tight?: boolean
}) {
  return (
    <div
      className={cn(
        'rounded-xl border p-3',
        strong
          ? 'border-gold/30 bg-gradient-to-br from-gold/15 via-gold/[0.06] to-transparent'
          : 'border-border/60 bg-muted/30',
      )}
    >
      <p className="text-xs font-medium text-muted-foreground">
        {label}
        {sub && <span className="ml-1 font-normal opacity-70">{sub}</span>}
      </p>
      <p
        className={cn(
          'mt-1 tabular-nums',
          strong
            ? cn('font-bold', tight ? 'text-xl' : 'text-2xl')
            : cn('font-semibold text-muted-foreground', tight ? 'text-lg' : 'text-xl'),
        )}
      >
        {value == null ? '—' : euro(value)}
      </p>
    </div>
  )
}

function VariationTile({ pct, delta, tight }: { pct: number | null; delta: number; tight?: boolean }) {
  const up = delta >= 0
  const Icon = pct === null ? Minus : up ? TrendingUp : TrendingDown
  return (
    <div
      className={cn(
        'rounded-xl border p-3',
        pct === null ? 'border-border/60 bg-muted/30' : up ? 'border-success/25 bg-success/[0.06]' : 'border-destructive/25 bg-destructive/[0.05]',
      )}
    >
      <p className="text-xs font-medium text-muted-foreground">Évolution</p>
      <div className="mt-1 flex items-baseline gap-2">
        <p
          className={cn(
            'font-bold tabular-nums flex items-center gap-1 whitespace-nowrap',
            tight ? 'text-xl' : 'text-2xl',
            pct === null ? 'text-muted-foreground' : up ? 'text-success' : 'text-destructive',
          )}
        >
          <Icon className={cn('flex-shrink-0', tight ? 'h-4 w-4' : 'h-5 w-5')} />
          {pct === null ? '—' : `${pct > 0 ? '+' : ''}${fmtNum(pct, 1)} %`}
        </p>
      </div>
      <p className="text-[11px] text-muted-foreground tabular-nums">
        {delta >= 0 ? '+' : ''}{euro(delta)}
      </p>
    </div>
  )
}

