// ── Valorisation du stock widget — EN SOMMEIL ─────────────────────────────
//
// ⚠️ CE COMPOSANT N'EST PLUS MONTÉ. Son entrée a été retirée de
// `registry.tsx` le 2026-08-26 : il répondait à « combien vaut mon stock »,
// une question de bilan à cadence annuelle, et affichait un taux de provision
// sans point de comparaison — donc ininterprétable au quotidien. Décision
// Vincent : « j'attends que le besoin s'exprime vraiment ». Le fichier est
// gardé volontairement, pas oublié : le rétablir est UNE entrée dans
// `registry.tsx` (le commentaire là-bas porte le mode d'emploi et la piste
// « falaise » à retenir si le besoin revient).
//
// ⚠️ Ne pas en déduire que la chaîne serveur est morte : `valorisation-stock.ts`
// alimente l'estimation de variation de stock de l'EBE via `variation-stock.ts`.
//
// Valeur d'achat et valeur dépréciée du stock, le taux de provision qui en
// résulte, et le détail par type — fil, tombé de métier disponible, tombé de
// métier en ennoblissement, rouleaux finis.
//
// POURQUOI CE WIDGET EXISTE
//
// C'est le chiffre que le tableau de bord ne pouvait pas montrer. L'Analyse
// financière lit `upload_compta`, qui ne porte ni la production stockée ni les
// provisions : un stock passé de 37 % à 49 % de provision en un an (2024 → 2025)
// n'apparaissait nulle part. Le mécanisme légataire qui le calculait
// (`inventaire_compta`) s'est arrêté le 28/06/2025 et rien ne l'avait remplacé.
//
// ⚠️ PORTÉE — L'ESCRIME MANQUE, et le widget le dit. Ces articles n'ont pas
// d'inventaire dans l'ERP ; fin 2025 ils pesaient 57 600 € brut / 13 935 € net,
// soit l'écart exact entre le total des quatre types et le bilan. C'est donc un
// manque chiffré, pas une inconnue — à intégrer plus tard.
//
// Le taux de provision est rendu par une barre net/brut plutôt que par un feu
// tricolore : les seuils « bon / mauvais » sont une décision de gestion qui
// n'a pas été prise, et inventer un vert à 30 % dirait au lecteur une chose que
// personne n'a arbitrée. La barre montre la proportion et le laisse juger.
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

type TypeStock = 'fil' | 'tm_dispo' | 'tm_en_cours' | 'fini'

interface Bucket {
  key: string
  label: string
  taux: number
  lignes: number
  poids: number
  brut: number
  net: number
}
interface ValorisationType {
  type: TypeStock
  label: string
  lignes: number
  poids: number
  brut: number
  net: number
  provision: number
  taux_provision: number | null
  buckets: Bucket[]
  incompletes: number
}
interface ValorisationResponse {
  date: string
  types: ValorisationType[]
  total: {
    poids: number
    brut: number
    net: number
    provision: number
    taux_provision: number | null
  }
}

/** Totaux d'entreprise — les centimes seraient du bruit. */
function euro0(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—'
  return `${fmtNum(Math.round(v))} €`
}

function formatArrete(d: string | null | undefined): string {
  if (!d || d.length !== 8) return ''
  return `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}`
}

/** Une teinte par type, stable, pour que la barre de répartition et les lignes
 *  du détail se lisent ensemble. Pas la palette « statut » (§37) : ce sont des
 *  catégories de stock, pas des états. */
const TONE: Record<TypeStock, string> = {
  fil: 'bg-sky-500',
  tm_dispo: 'bg-amber-500',
  tm_en_cours: 'bg-teal-500',
  fini: 'bg-violet-500',
}

export function ValorisationStockWidget() {
  const query = useQuery<ValorisationResponse>({
    queryKey: ['stock-valorisation'],
    queryFn: () => apiFetch('/rapports/stock/valorisation'),
    staleTime: 5 * 60_000,
  })

  const data = query.data
  // Mesuré sur le WIDGET, pas le viewport : la carte peut être rétrécie sur un
  // grand écran, où un breakpoint `sm:` montrerait encore trois tuiles.
  const [bodyRef, bodySize] = useElementSize<HTMLDivElement>()
  const tight = bodySize.w > 0 && bodySize.w < 470

  const types = data?.types ?? []
  const brut = data?.total.brut ?? 0
  const incompletes = types.reduce((t, x) => t + x.incompletes, 0)

  return (
    <WidgetFrame
      icon={FiniRollIcon}
      title="Valorisation du stock"
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
        ) : !data || data.total.brut === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-muted-foreground">
            <FiniRollIcon className="h-10 w-10 opacity-30" />
            <p className="text-sm">Aucun stock valorisé.</p>
          </div>
        ) : (
          <>
            <div className={cn('grid gap-3', tight ? 'grid-cols-1' : 'grid-cols-3')}>
              <FigureTile label="Valeur d'achat" value={data.total.brut} strong />
              <FigureTile label="Valeur actuelle" value={data.total.net} />
              <FigureTile
                label="Taux de provision"
                text={data.total.taux_provision == null ? '—' : `${fmtNum(data.total.taux_provision * 100, 1)} %`}
                sub={`${euro0(data.total.provision)} dépréciés`}
              />
            </div>

            <div className="flex flex-1 min-h-0 flex-col overflow-hidden rounded-lg border border-border/60 bg-white">
              <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-border/60 bg-zinc-200/50 px-3 py-1.5">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Par type de stock
                </span>
                <span className="text-[11px] tabular-nums text-muted-foreground">
                  {fmtNum(Math.round(data.total.poids))} kg
                </span>
              </div>

              <div className="flex flex-1 min-h-0 flex-col gap-3 overflow-y-auto scrollbar-transparent p-3">
                {/* Répartition de la valeur d'ACHAT entre les types — le net
                    masquerait justement le stock ancien, gros et presque sans
                    valeur, qui est ce qu'il faut voir. */}
                <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-zinc-100">
                  {types.map((t) =>
                    brut > 0 && t.brut > 0 ? (
                      <div
                        key={t.type}
                        className={TONE[t.type]}
                        style={{ width: `${(t.brut / brut) * 100}%` }}
                        title={`${t.label} — ${euro0(t.brut)}`}
                      />
                    ) : null,
                  )}
                </div>

                <div className="space-y-2.5">
                  {types.map((t) => (
                    <TypeRow key={t.type} t={t} />
                  ))}
                </div>
              </div>
            </div>

            <p className="-mt-1 flex items-start gap-1.5 text-[11px] leading-snug text-muted-foreground">
              <Info className="mt-px h-3 w-3 flex-shrink-0 opacity-60" />
              <span>
                Hors escrime, absent de l'ERP (57 600 € brut fin 2025).
                {incompletes > 0 &&
                  ` ${fmtNum(incompletes)} ${incompletes > 1 ? 'lignes' : 'ligne'} sans prix d'achat complet : valeur sous-estimée.`}
              </span>
            </p>
          </>
        )}
      </CardContent>
    </WidgetFrame>
  )
}

/** Une ligne par type : identité à gauche, valeurs à droite, et une barre
 *  net/brut qui rend le taux de provision lisible d'un coup d'œil. */
function TypeRow({ t }: { t: ValorisationType }) {
  const part = t.brut > 0 ? t.net / t.brut : 0
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2 text-xs">
        <span className={cn('h-2 w-2 flex-shrink-0 translate-y-[-1px] rounded-full', TONE[t.type])} />
        <span className="min-w-0 flex-1 truncate font-medium">{t.label}</span>
        <span className="flex-shrink-0 tabular-nums text-muted-foreground">
          {fmtNum(Math.round(t.poids))} kg
        </span>
        <span className="w-24 flex-shrink-0 text-right tabular-nums">{euro0(t.brut)}</span>
      </div>
      <div className="flex items-center gap-2 pl-4">
        {/* La part restante (net) est pleine, la part dépréciée est le fond. */}
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-200">
          <div className={cn('h-full rounded-full', TONE[t.type])} style={{ width: `${part * 100}%` }} />
        </div>
        <span className="w-32 flex-shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
          net {euro0(t.net)}
        </span>
        <span className="w-14 flex-shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
          −{t.taux_provision == null ? '—' : fmtNum(t.taux_provision * 100, 0)} %
        </span>
      </div>
    </div>
  )
}

/** Même forme que les tuiles de l'Analyse financière — les deux widgets se
 *  côtoient sur le tableau de bord et doivent se lire comme une famille. */
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
