// ── Fils en commande widget (LIVA #1267) ──────────────────────
// Every yarn order line still awaited — open line of an open commande, the
// legacy « Commandes de fils » scope — with its phase and the date it is
// expected. Same endpoint and same phase colours as Rapports › Commandes de
// fils (GET /api/rapports/commandes-fil), so the widget and the report never
// disagree; a line click opens the commande in Fils › Commandes.
//
// Sorted by what needs attention first: the date that matters for the phase
// (the relance date while no délai is announced, the delivery date after),
// missing dates on top — an open line with no date at all is the problem the
// report already colours red.

import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Loader2, RotateCw, Inbox, Truck } from 'lucide-react'
import { CardContent } from '@/components/ui/card'
import { apiFetch } from '@/lib/api'
import { formatHfsqlDate } from '@/lib/dates'
import { fmtNum } from '@/lib/format'
import { PhasePill, type RapportFilLine } from '@/lib/phase-commande-fil'
import { cn } from '@/lib/utils'
import { WidgetFrame } from './WidgetFrame'

/** The date the line is waiting on — null when none is known. */
function echeance(l: RapportFilLine): string | null {
  return l.phase === 'attente_delai' ? l.date_notif : (l.date_livraison ?? l.date_notif)
}

function kg(v: number): string {
  return `${fmtNum(v, Number.isInteger(v) ? 0 : 1)} kg`
}

export function CommandesFilWidget() {
  const navigate = useNavigate()

  // Same key as the report screen's default view, so either warms the other.
  // Fresh on every arrival: receptions land all day.
  const query = useQuery<RapportFilLine[]>({
    queryKey: ['rapport-commandes-fil', { terminees: false }],
    queryFn: () => apiFetch('/rapports/commandes-fil?terminees=0'),
    staleTime: 0,
    refetchOnMount: 'always',
  })

  const lignes = useMemo(() => {
    const rows = (query.data ?? []).filter((l) => l.phase !== 'terminee')
    // Received-but-not-closed lines wait for nothing: last. Then no date first,
    // then the earliest date.
    const rank = (l: RapportFilLine) => (l.phase === 'recue' ? 2 : echeance(l) ? 1 : 0)
    return [...rows].sort((a, b) =>
      rank(a) - rank(b) ||
      (echeance(a) ?? '').localeCompare(echeance(b) ?? '') ||
      a.IDcommande_fil - b.IDcommande_fil ||
      a.IDref_fil_commande - b.IDref_fil_commande,
    )
  }, [query.data])

  const restant = lignes.reduce((s, l) => s + l.qte_restante, 0)
  const enRetard = lignes.filter((l) => l.urgency === 'late').length

  return (
    <WidgetFrame
      icon={Truck}
      title="Fils en commande"
      actions={
        <button
          type="button"
          onClick={() => query.refetch()}
          disabled={query.isFetching}
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
        {!query.isLoading && !query.isError && lignes.length > 0 && (
          <div className="flex flex-shrink-0 flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border border-border/60 bg-zinc-100/80 px-3 py-2">
            <p className="text-sm">
              <span className="font-semibold tabular-nums">{lignes.length}</span>{' '}
              ligne{lignes.length > 1 ? 's' : ''} en attente
            </p>
            <p className="text-sm text-muted-foreground">
              <span className="font-semibold tabular-nums text-foreground">{kg(restant)}</span> à recevoir
            </p>
            {enRetard > 0 && (
              <span className="ml-auto rounded-md border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-xs font-semibold text-red-700">
                {enRetard} en retard
              </span>
            )}
          </div>
        )}

        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto scrollbar-transparent p-1">
          {query.isLoading && (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-6 w-6 animate-spin text-accent" />
            </div>
          )}

          {query.isError && (
            <p className="py-8 text-center text-sm text-destructive">
              Impossible de charger les commandes de fil.
            </p>
          )}

          {!query.isLoading && !query.isError && lignes.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
              <Inbox className="mb-3 h-12 w-12 opacity-40" />
              <p className="text-sm">Aucun fil en commande</p>
            </div>
          )}

          {lignes.map((l) => {
            const date = echeance(l)
            const lien = `/fils/commandes?commande=${l.IDcommande_fil}`
            return (
              <div
                key={l.IDref_fil_commande}
                role="button"
                tabIndex={0}
                onClick={() => navigate(lien)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigate(lien) }
                }}
                title={`Ouvrir la commande N° ${l.IDcommande_fil}`}
                className={cn(
                  'cursor-pointer rounded-lg border border-border/60 bg-white p-2.5 transition-colors hover:border-accent/50',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  // §30 urgency strip, computed by the API.
                  l.urgency === 'late' && 'shadow-[inset_4px_0_0_0_rgb(239_68_68)]',
                  l.urgency === 'soon' && 'shadow-[inset_4px_0_0_0_rgb(245_158_11)]',
                )}
              >
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium leading-snug">
                      {l.reference || '—'}
                      {l.coloris && <span className="font-normal text-muted-foreground"> · {l.coloris}</span>}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {l.fournisseur_nom || 'Fournisseur inconnu'} · N° {l.IDcommande_fil}
                    </p>
                  </div>
                  <PhasePill phase={l.phase} />
                </div>
                <div className="mt-1.5 flex items-baseline gap-2 text-xs">
                  <span className="tabular-nums text-muted-foreground">
                    {l.phase === 'partielle'
                      ? <>{kg(l.qte_recue)} reçus sur {kg(l.qte_commandee)}</>
                      : <>{kg(l.qte_commandee)}</>}
                  </span>
                  <span
                    className={cn(
                      'ml-auto whitespace-nowrap tabular-nums',
                      l.urgency === 'late' ? 'font-semibold text-red-700'
                        : l.urgency === 'soon' ? 'font-semibold text-amber-700'
                          : 'text-muted-foreground',
                    )}
                  >
                    {l.phase === 'recue'
                      ? 'Reçue, à clôturer'
                      : !date
                        ? 'Aucune date'
                        : l.phase === 'attente_delai'
                          ? `Relance le ${formatHfsqlDate(date)}`
                          : `Livraison le ${formatHfsqlDate(date)}`}
                    {l.retard_jours != null && l.retard_jours > 0 && ` (+${l.retard_jours} j)`}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </CardContent>
    </WidgetFrame>
  )
}
