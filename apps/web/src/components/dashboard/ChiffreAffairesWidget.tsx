// ── Chiffre d'affaires widget ─────────────────────────────────────────────
// Ports the legacy "Comparatif CA" dashboard block: every client ranked by
// revenue for the selected year, with the previous year's revenue and rank
// delta alongside.
//
// Both endpoints are gated server-side by the `dashboard_ca` permission; the
// widget itself is only mounted when the user holds it (see Dashboard.tsx).

import { useState } from 'react'
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
  years: number[]
  rows: CaClientRow[]
  total: number
  total_prev: number
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
  const currentYear = new Date().getFullYear()
  const [year, setYear] = useState(currentYear)

  const caQuery = useQuery<CaClientsResponse>({
    queryKey: ['ca-clients', year],
    queryFn: () => apiFetch(`/rapports/ca-clients?year=${year}`),
    staleTime: 5 * 60_000,
  })

  const data = caQuery.data
  const rows = data?.rows ?? []

  const yearOptions = (data?.years ?? [year]).map((y) => ({ id: y, primary: String(y) }))
  const prevYear = data?.previous_year ?? year - 1
  const totalVariation = variationPct(data?.total ?? 0, data?.total_prev ?? 0)

  return (
    <WidgetFrame
      icon={TrendingUp}
      title="Chiffre d'affaires"
      actions={
        <PopoverSelect
          options={yearOptions}
          value={year}
          onChange={setYear}
          hideEmpty
          size="sm"
          widthClass="w-[104px]"
        />
      }
    >
      <CardContent className="flex min-h-full flex-col space-y-4 p-5">
        {/* Year totals + variation */}
        <div className="grid gap-3 sm:grid-cols-3">
          <TotalTile label={`CA ${year}`} value={data?.total} strong />
          <TotalTile label={`CA ${prevYear}`} value={data?.total_prev} />
          <VariationTile pct={totalVariation} delta={(data?.total ?? 0) - (data?.total_prev ?? 0)} />
        </div>

        {/* Ranking */}
        <div className={cn(
          'flex flex-col rounded-lg border border-border/60 bg-white overflow-hidden',
          RANKING_FILLED,
        )}>
          {caQuery.isLoading ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="h-6 w-6 animate-spin text-accent" />
            </div>
          ) : caQuery.isError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-destructive">
              <AlertTriangle className="h-8 w-8" />
              <p className="text-sm">Impossible de charger le chiffre d'affaires.</p>
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
              <TrendingUp className="h-10 w-10 opacity-30" />
              <p className="text-sm">Aucun chiffre d'affaires sur cette période.</p>
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-auto scrollbar-transparent">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-zinc-200/80 backdrop-blur-sm">
                  <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 text-left font-semibold w-[92px]">Rang</th>
                    <th className="px-3 py-2 text-left font-semibold">Client</th>
                    <th className="px-3 py-2 text-right font-semibold whitespace-nowrap">{year}</th>
                    <th className="px-3 py-2 text-right font-semibold whitespace-nowrap">{prevYear}</th>
                    <th className="px-3 py-2 text-right font-semibold w-[104px]">Évolution</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <CaRow key={r.IDclient} row={r} />
                  ))}
                </tbody>
                {/* Totals stay in the table so they line up under their columns. */}
                <tfoot className="sticky bottom-0 z-10 bg-zinc-200/80 backdrop-blur-sm">
                  <tr className="border-t border-border">
                    <td className="px-3 py-2 text-xs font-bold uppercase tracking-wide" colSpan={2}>
                      Total
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-bold whitespace-nowrap">
                      {euro(data?.total)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-semibold text-muted-foreground whitespace-nowrap">
                      {euro(data?.total_prev)}
                    </td>
                    <td className="px-3 py-2" />
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

function CaRow({ row }: { row: CaClientRow }) {
  const pct = variationPct(row.ca, row.ca_prev)
  const up = row.ca > row.ca_prev
  return (
    <tr className="border-t border-border/40 hover:bg-accent/5 transition-colors">
      <td className="px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          <span className="tabular-nums text-xs text-muted-foreground w-5 text-right">{row.rang}</span>
          <RankDelta rang={row.rang} rangPrev={row.rang_prev} />
        </div>
      </td>
      <td className="px-3 py-1.5">
        <span className="block truncate font-medium" title={row.nom}>{row.nom}</span>
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums font-medium whitespace-nowrap">
        {euro(row.ca)}
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground whitespace-nowrap">
        {euro(row.ca_prev)}
      </td>
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

// ── Header tiles ──────────────────────────────────────────────

function TotalTile({ label, value, strong }: { label: string; value?: number; strong?: boolean }) {
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
      <p className={cn('mt-1 tabular-nums', strong ? 'text-2xl font-bold' : 'text-xl font-semibold text-muted-foreground')}>
        {value == null ? '—' : euro(value)}
      </p>
    </div>
  )
}

function VariationTile({ pct, delta }: { pct: number | null; delta: number }) {
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
            'text-2xl font-bold tabular-nums flex items-center gap-1',
            pct === null ? 'text-muted-foreground' : up ? 'text-success' : 'text-destructive',
          )}
        >
          <Icon className="h-5 w-5" />
          {pct === null ? '—' : `${pct > 0 ? '+' : ''}${fmtNum(pct, 1)} %`}
        </p>
      </div>
      <p className="text-[11px] text-muted-foreground tabular-nums">
        {delta >= 0 ? '+' : ''}{euro(delta)}
      </p>
    </div>
  )
}

