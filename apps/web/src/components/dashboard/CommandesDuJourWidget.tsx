// ── Commandes du jour widget ──────────────────────────────────
// The client orders taken today and the chiffre d'affaires they represent.
// Backed by GET /api/commandes-client/du-jour.
//
// ── Freshness ──
// This is a "what has landed today" widget, so stale data is worse than no
// data: `staleTime: 0` + `refetchOnMount: 'always'` means every arrival on the
// tableau de bord refetches, even if React Query still holds a cached answer
// from earlier in the session. Widgets unmount when you navigate away from the
// dashboard, so mounting IS "the user came back". Window focus refetching (the
// library default) covers leaving the tab open all afternoon.

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMutation } from '@tanstack/react-query'
import {
  ShoppingCart, Loader2, RotateCw, Inbox, Gift, CheckCircle2,
} from 'lucide-react'
import { CardContent } from '@/components/ui/card'
import { apiFetch } from '@/lib/api'
import { formatHfsqlDate } from '@/lib/dates'
import { fmtNum } from '@/lib/format'
import { cn } from '@/lib/utils'
import { WidgetFrame } from './WidgetFrame'

interface CommandeDuJour {
  IDcommande_client: number
  numero: number | null
  client: string
  montant: number
  donation: boolean
  est_soldee: boolean
}
interface DuJourResponse {
  date: string
  count: number
  total_ht: number
  donation_count: number
  last_order_date: string | null
  truncated: boolean
  commandes: CommandeDuJour[]
}

export function CommandesDuJourWidget() {
  const queryClient = useQueryClient()

  const query = useQuery<DuJourResponse>({
    queryKey: ['commandes-du-jour'],
    queryFn: () => apiFetch('/commandes-client/du-jour'),
    staleTime: 0,
    refetchOnMount: 'always',
  })

  const refreshMut = useMutation({
    mutationFn: async () => {
      await queryClient.invalidateQueries({ queryKey: ['commandes-du-jour'] })
    },
  })

  const data = query.data
  const commandes = data?.commandes ?? []

  return (
    <WidgetFrame
      icon={ShoppingCart}
      title="Commandes du jour"
      actions={
        <button
          type="button"
          onClick={() => refreshMut.mutate()}
          disabled={refreshMut.isPending || query.isFetching}
          title="Actualiser"
          className="flex-shrink-0 rounded-md p-1.5 text-white/70 transition-colors hover:bg-white/15 hover:text-white disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
          {query.isFetching
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <RotateCw className="h-4 w-4" />}
        </button>
      }
    >
      <CardContent className="flex h-full flex-col gap-3 p-3">
        {/* The figure the widget exists for, stated before the list. Stacked
            rather than side-by-side with the count: a six-figure total put
            beside anything else wraps to "273 / 180,32 / €" the moment the
            widget is dragged narrow. `whitespace-nowrap` keeps the amount on
            one line whatever the column width. */}
        <div className="flex-shrink-0 rounded-lg border border-border/60 bg-zinc-100/80 p-3">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Chiffre d’affaires du jour
          </p>
          <p className="whitespace-nowrap text-2xl font-bold tabular-nums leading-tight">
            {query.isLoading ? '—' : `${fmtNum(data?.total_ht ?? 0, 2)} €`}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {query.isLoading
              ? ''
              : `${data?.count ?? 0} commande${(data?.count ?? 0) > 1 ? 's' : ''}`}
            {data?.date && (
              <span className="text-muted-foreground/70"> · {formatHfsqlDate(data.date)}</span>
            )}
          </p>
        </div>

        {/* Donations are listed but kept out of the CA — say so, otherwise the
            total looks like it disagrees with the rows. */}
        {(data?.donation_count ?? 0) > 0 && (
          <p className="flex-shrink-0 text-[11px] italic text-muted-foreground">
            Dont {data!.donation_count} don{data!.donation_count > 1 ? 's' : ''}, hors chiffre d’affaires.
          </p>
        )}

        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto scrollbar-transparent p-1">
          {query.isLoading && (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-accent" />
            </div>
          )}

          {query.isError && (
            <p className="py-8 text-center text-sm text-destructive">
              Impossible de charger les commandes du jour.
            </p>
          )}

          {!query.isLoading && !query.isError && commandes.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
              <Inbox className="mb-3 h-12 w-12 opacity-40" />
              <p className="text-sm">Aucune commande aujourd’hui</p>
              {/* Without this, an empty widget is indistinguishable from a
                  broken one. */}
              {data?.last_order_date && (
                <p className="mt-1 text-xs">
                  Dernière commande le {formatHfsqlDate(data.last_order_date)}.
                </p>
              )}
            </div>
          )}

          {commandes.map((c) => (
            <div
              key={c.IDcommande_client}
              className={cn(
                'flex items-center gap-2 rounded-lg border border-border/60 border-l-4 bg-zinc-100/80 p-2.5',
                c.donation ? 'border-l-border' : 'border-l-amber-400/60',
              )}
            >
              {/* One line per order: number, client, and what it's worth. The
                  réf client and line count were a second line of detail nobody
                  scans a day's orders for. */}
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium leading-snug">
                  <span className="tabular-nums">N° {c.numero ?? '—'}</span>
                  <span className="truncate font-normal text-muted-foreground">{c.client}</span>
                  {c.donation && (
                    <span className="inline-flex flex-shrink-0 items-center gap-0.5 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                      <Gift className="h-2.5 w-2.5" />
                      don
                    </span>
                  )}
                  {c.est_soldee && (
                    <span className="inline-flex flex-shrink-0 items-center gap-0.5 rounded bg-success/10 px-1 py-0.5 text-[10px] text-success">
                      <CheckCircle2 className="h-2.5 w-2.5" />
                      soldée
                    </span>
                  )}
                </p>
              </div>
              <p className="flex-shrink-0 text-sm font-semibold tabular-nums">
                {fmtNum(c.montant, 2)} €
              </p>
            </div>
          ))}

          {data?.truncated && (
            <p className="pt-1 text-center text-xs italic text-muted-foreground">
              Seules les {commandes.length} commandes les plus récentes sont affichées.
            </p>
          )}
        </div>
      </CardContent>
    </WidgetFrame>
  )
}
