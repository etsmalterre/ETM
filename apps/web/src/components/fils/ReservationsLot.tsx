// Fils › Stock › lot drawer « Réservations » (2026-10-23, API lib/lancement-tricotage.ts
// `repartitionLot`): where the lot's stock is promised — knitting now (open OFs), knitting
// orders not started yet, yarn reserved for client lines — and what is left free. The same
// terms the launch dialog subtracts, so « libre » here is the figure a launch offers.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, Loader2 } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { donutPath } from '@/lib/donut'
import { fmtNum } from '@/lib/format'
import { cn } from '@/lib/utils'

type Kind = 'of' | 'commande' | 'client' | 'libre'

interface Part {
  kind: Kind
  kg: number
  details: { label: string; sub: string; kg: number }[]
}

// Categorical slots in the CA widget's validated order; « Libre » is the remainder, so grey.
const META: Record<Kind, { label: string; color: string }> = {
  of: { label: 'En tricotage (OF en cours)', color: '#2a78d6' },
  commande: { label: 'Commandes de tricotage à lancer', color: '#eb6834' },
  client: { label: 'Réservé pour des commandes client', color: '#1baf7a' },
  libre: { label: 'Libre', color: '#d4d4d8' },
}

export function ReservationsLot({ lotId }: { lotId: number }) {
  const [hover, setHover] = useState<Kind | null>(null)
  const { data, isLoading } = useQuery<{ stock: number; parts: Part[]; exces: number }>({
    queryKey: ['stock-fil', 'reservations', lotId],
    queryFn: () => apiFetch(`/stock/fil/${lotId}/reservations`),
    staleTime: 0,
    refetchOnMount: 'always',
  })

  if (isLoading || !data) {
    return <div className="flex justify-center py-3"><Loader2 className="h-4 w-4 animate-spin text-accent" /></div>
  }
  if (data.parts.length === 0) {
    return <p className="text-xs text-muted-foreground italic">Lot vide</p>
  }

  const base = data.parts.reduce((s, p) => s + p.kg, 0)
  let acc = 0
  const arcs = data.parts.map((p) => {
    const from = acc / base
    acc += p.kg
    return { p, from, to: acc / base }
  })
  const libre = data.parts.find((p) => p.kind === 'libre')?.kg ?? 0
  const active = hover ? data.parts.find((p) => p.kind === hover) ?? null : null

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-3">
        <div className="relative h-[104px] w-[104px] flex-shrink-0">
          <svg viewBox="-50 -50 100 100" className="h-full w-full" role="img" aria-label="Répartition du stock du lot">
            {arcs.length === 1 ? (
              <circle r={36.5} fill="none" stroke={META[arcs[0].p.kind].color} strokeWidth={19} />
            ) : (
              arcs.map(({ p, from, to }) => (
                <path
                  key={p.kind}
                  d={donutPath(from, to, 46, 27)}
                  fill={META[p.kind].color}
                  stroke="#fff"
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                  opacity={hover && hover !== p.kind ? 0.4 : 1}
                  onMouseEnter={() => setHover(p.kind)}
                  onMouseLeave={() => setHover(null)}
                />
              ))
            )}
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            <span className="text-[9px] font-medium text-muted-foreground">{active ? 'kg' : 'Libre'}</span>
            <span className="text-sm font-bold tabular-nums leading-tight">{fmtNum(active ? active.kg : libre, 0)}</span>
            <span className="text-[9px] text-muted-foreground">{active ? `${fmtNum((active.kg / base) * 100, 0)} %` : 'kg'}</span>
          </div>
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          {data.parts.map((p) => (
            <div
              key={p.kind}
              onMouseEnter={() => setHover(p.kind)}
              onMouseLeave={() => setHover(null)}
              className={cn('flex items-baseline gap-1.5 text-xs rounded px-1 -mx-1', hover === p.kind && 'bg-zinc-100')}
            >
              <span className="h-2.5 w-2.5 flex-shrink-0 rounded-sm self-center" style={{ backgroundColor: META[p.kind].color }} />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{META[p.kind].label}</span>
              <span className={cn('tabular-nums', p.kind === 'libre' && 'font-semibold')}>{fmtNum(p.kg, 1)} kg</span>
            </div>
          ))}
        </div>
      </div>

      {data.parts.some((p) => p.details.length > 0) && (
        <div className="space-y-1.5 border-t border-border/40 pt-2">
          {data.parts.filter((p) => p.details.length > 0).map((p) => (
            <div key={p.kind}>
              {p.details.map((d, i) => (
                <div key={i} className="flex items-baseline gap-1.5 text-[11px]">
                  <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full self-center" style={{ backgroundColor: META[p.kind].color }} />
                  <span className="font-medium">{d.label}</span>
                  {d.sub && <span className="min-w-0 truncate text-muted-foreground">· {d.sub}</span>}
                  <span className="ml-auto tabular-nums">{fmtNum(d.kg, 1)} kg</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {data.exces > 0 && (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
          {fmtNum(data.exces, 1)} kg promis au-delà du stock : une commande manquera de ce fil, réaffectez-la sur un autre lot.
        </p>
      )}
    </div>
  )
}
