// ── Valorisation du stock widget ──────────────────────────────────────────
// Valeur d'achat et valeur dépréciée des rouleaux finis en stock, le taux de
// provision qui en résulte, et la répartition par ancienneté qui l'explique.
//
// POURQUOI CE WIDGET EXISTE
//
// C'est le chiffre que le tableau de bord ne pouvait pas montrer. L'Analyse
// financière lit `upload_compta`, qui ne porte ni la production stockée ni les
// provisions : un stock passé de 37 % à 49 % de provision en un an (2024 → 2025)
// n'apparaissait nulle part dans l'app. Le mécanisme légataire qui le calculait
// (`inventaire_compta`) s'est arrêté le 28/06/2025 et rien ne l'avait remplacé.
//
// ⚠️ PORTÉE — rouleaux FINIS uniquement. L'inventaire légataire couvre quatre
// types (Fil / TM dispo / TM en cours / Fini) ; seules les règles du fini ont
// été retrouvées. Au 28/12/2024 le fini pesait 179 142 € sur 373 439 € de stock
// net, soit moins de la moitié. Le titre du widget dit « fini » et la mention de
// portée reste affichée : ce n'est PAS la valeur du stock.
//
// Gated server-side by `dashboard_stock_valorisation`.

import { useQuery } from '@tanstack/react-query'
import { Loader2, AlertTriangle, Info } from 'lucide-react'
import { CardContent } from '@/components/ui/card'
import { FiniRollIcon } from '@/components/icons/FiniRollIcon'
import { useElementSize } from '@/hooks/useElementSize'
import { apiFetch } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { cn } from '@/lib/utils'
import { WidgetFrame } from './WidgetFrame'

interface AgeBucket {
  key: 'second_choix' | 'moins_1_an' | 'de_1_a_2_ans' | 'plus_2_ans'
  label: string
  taux: number
  rouleaux: number
  poids: number
  brut: number
  net: number
}
interface ValorisationResponse {
  date: string
  type: 'fini'
  rouleaux: number
  poids: number
  brut: number
  net: number
  provision: number
  taux_provision: number | null
  buckets: AgeBucket[]
  pieces_incompletes: number
}

/** Company-level totals — centimes would be noise. */
function euro0(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—'
  return `${fmtNum(Math.round(v))} €`
}

function formatArrete(d: string | null | undefined): string {
  if (!d || d.length !== 8) return ''
  return `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}`
}

/** Une teinte par tranche d'ancienneté — la barre EST l'explication du taux de
 *  provision, donc les couleurs vont du sain au déprécié. Volontairement pas la
 *  palette « statut » (§37) : ce n'est pas un état de rouleau, c'est un âge. */
const BUCKET_TONE: Record<AgeBucket['key'], { bar: string; dot: string }> = {
  moins_1_an: { bar: 'bg-emerald-500', dot: 'bg-emerald-500' },
  de_1_a_2_ans: { bar: 'bg-amber-500', dot: 'bg-amber-500' },
  plus_2_ans: { bar: 'bg-red-500', dot: 'bg-red-500' },
  second_choix: { bar: 'bg-zinc-400', dot: 'bg-zinc-400' },
}

export function ValorisationStockWidget() {
  const query = useQuery<ValorisationResponse>({
    queryKey: ['stock-valorisation'],
    queryFn: () => apiFetch('/rapports/stock/valorisation'),
    staleTime: 5 * 60_000,
  })

  const data = query.data
  // Sized against the WIDGET, not the viewport (§ AnalyseFinanciere) — the card
  // can be dragged narrow on a wide screen.
  const [bodyRef, bodySize] = useElementSize<HTMLDivElement>()
  const tight = bodySize.w > 0 && bodySize.w < 470

  const buckets = data?.buckets ?? []
  const brut = data?.brut ?? 0
  const taux = data?.taux_provision

  return (
    <WidgetFrame
      icon={FiniRollIcon}
      title="Valorisation du stock fini"
      actions={
        data?.date ? (
          <span className="text-[11px] tabular-nums text-white/70">au {formatArrete(data.date)}</span>
        ) : null
      }
    >
      <CardContent ref={bodyRef} className={cn('flex h-full flex-col space-y-4', tight ? 'p-3' : 'p-5')}>
        {query.isLoading ? (
          <div className="flex flex-1 items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-accent" />
          </div>
        ) : query.isError ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-destructive">
            <AlertTriangle className="h-8 w-8" />
            <p className="text-sm">Impossible de charger la valorisation du stock.</p>
          </div>
        ) : !data || data.rouleaux === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
            <FiniRollIcon className="h-10 w-10 opacity-30" />
            <p className="text-sm">Aucun rouleau fini en stock.</p>
          </div>
        ) : (
          <>
            <div className={cn('grid gap-3', tight ? 'grid-cols-1' : 'grid-cols-3')}>
              <FigureTile label="Valeur d'achat" value={data.brut} strong />
              <FigureTile label="Valeur actuelle" value={data.net} />
              <FigureTile
                label="Taux de provision"
                text={taux == null ? '—' : `${fmtNum(taux * 100, 1)} %`}
                sub={`${euro0(data.provision)} dépréciés`}
              />
            </div>

            {/* La barre d'ancienneté — c'est elle qui explique le taux ci-dessus,
                donc elle est le corps du widget, pas une annexe. */}
            <div className="flex flex-1 min-h-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-white">
              <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-zinc-200/50 px-3 py-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Ancienneté
                </span>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {fmtNum(data.rouleaux)} rouleaux · {fmtNum(Math.round(data.poids))} kg
                </span>
              </div>

              <div className="flex flex-1 min-h-0 flex-col gap-3 overflow-y-auto scrollbar-transparent p-3">
                {/* Stacked proportions of the GROSS value — the net would hide
                    exactly what the user needs to see (the old stock is big and
                    nearly worthless, so it vanishes from a net-weighted bar). */}
                <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-zinc-100">
                  {buckets.map((b) =>
                    brut > 0 && b.brut > 0 ? (
                      <div
                        key={b.key}
                        className={BUCKET_TONE[b.key].bar}
                        style={{ width: `${(b.brut / brut) * 100}%` }}
                        title={`${b.label} — ${euro0(b.brut)}`}
                      />
                    ) : null,
                  )}
                </div>

                <div className="space-y-1.5">
                  {buckets.map((b) => (
                    <div key={b.key} className="flex items-center gap-2 text-xs">
                      <span className={cn('h-2 w-2 flex-shrink-0 rounded-full', BUCKET_TONE[b.key].dot)} />
                      <span className="min-w-0 flex-1 truncate">{b.label}</span>
                      <span className="flex-shrink-0 tabular-nums text-muted-foreground">
                        {b.taux > 0 ? `−${fmtNum(b.taux * 100)} %` : '—'}
                      </span>
                      <span className="w-24 flex-shrink-0 text-right tabular-nums">{euro0(b.brut)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <p className="-mt-1 flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground">
              <Info className="mt-px h-3 w-3 flex-shrink-0 opacity-60" />
              <span>
                Rouleaux finis uniquement — hors fil et tombé de métier.
                {data.pieces_incompletes > 0 &&
                  ` ${fmtNum(data.pieces_incompletes)} ${
                    data.pieces_incompletes > 1 ? 'pièces' : 'pièce'
                  } sans prix d'achat fil : valeur sous-estimée.`}
              </span>
            </p>
          </>
        )}
      </CardContent>
    </WidgetFrame>
  )
}

/** Same shape as the Analyse financière tiles — the two widgets sit side by side
 *  on the dashboard and must read as one family. */
function FigureTile({
  label, value, text, sub, strong,
}: {
  label: string
  value?: number
  text?: string
  sub?: string
  strong?: boolean
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
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn('mt-1 tabular-nums', strong ? 'text-2xl font-bold' : 'text-xl font-semibold')}>
        {text ?? euro0(value)}
      </p>
      {sub && <p className="mt-0.5 text-[11px] tabular-nums text-muted-foreground">{sub}</p>}
    </div>
  )
}
