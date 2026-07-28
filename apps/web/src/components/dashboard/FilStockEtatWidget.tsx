// ── État des stocks de fil widget ─────────────────────────────
// Pick a ref_fil + coloris → summary of en stock / commandé / besoin /
// disponible. Backed by GET /api/stock/fil/etat. Référence list comes from
// /references-fil; the coloris list from that ref's detail (variantes).

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Boxes, Truck, Scissors, CheckCircle2, AlertTriangle, Loader2, Info } from 'lucide-react'
import * as RTooltip from '@radix-ui/react-tooltip'
import { CardContent } from '@/components/ui/card'
import { SearchableCombobox } from '@/components/ui/popover-select'
import { BobineIcon } from '@/components/icons/BobineIcon'
import { apiFetch } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { cn } from '@/lib/utils'
import { WidgetFrame } from './WidgetFrame'

interface RefFilOption { IDref_fil: number; reference: string | null }
interface ColoriOption { IDcolori_fil: number; reference: string | null }
interface RefDetail { variantes: ColoriOption[] }
interface FilEtat {
  en_stock: number
  nb_lots: number
  en_stock_rows: { lot: string; fournisseur: string; kg: number }[]
  commande: number
  nb_commandes: number
  commande_rows: { commande: number; fournisseur: string; ordered: number; recu: number; kg: number }[]
  besoin: number
  nb_affectations: number
  besoin_rows: { lot: string; commande_sst: number; kg: number }[]
  disponible: number
}

export function FilStockEtatWidget() {
  const [refFilId, setRefFilId] = useState(0)
  const [coloriId, setColoriId] = useState(0)

  const refsQuery = useQuery<RefFilOption[]>({
    queryKey: ['references-fil'],
    queryFn: () => apiFetch('/references-fil'),
    staleTime: 5 * 60_000,
  })
  const refDetailQuery = useQuery<RefDetail>({
    queryKey: ['references-fil', refFilId],
    queryFn: () => apiFetch(`/references-fil/${refFilId}`),
    enabled: refFilId > 0,
  })
  const etatQuery = useQuery<FilEtat>({
    queryKey: ['fil-etat', refFilId, coloriId],
    queryFn: () => apiFetch(`/stock/fil/etat?ref_fil=${refFilId}&colori_fil=${coloriId}`),
    enabled: refFilId > 0 && coloriId > 0,
  })

  const refs = refsQuery.data ?? []
  const variantes = refDetailQuery.data?.variantes ?? []
  const etat = etatQuery.data
  const ready = refFilId > 0 && coloriId > 0
  const refLabel = refs.find((r) => r.IDref_fil === refFilId)?.reference ?? ''
  const coloriLabel = variantes.find((v) => v.IDcolori_fil === coloriId)?.reference ?? ''
  // Footer totals for the "Commandé" tooltip breakdown (ordered / received).
  const cmdOrderedTotal = (etat?.commande_rows ?? []).reduce((s, r) => s + r.ordered, 0)
  const cmdRecuTotal = (etat?.commande_rows ?? []).reduce((s, r) => s + r.recu, 0)

  return (
    <WidgetFrame
      icon={BobineIcon}
      title="État des stocks de fil"
    >
      <RTooltip.Provider delayDuration={120} skipDelayDuration={400}>
        <CardContent className="space-y-5 p-5">
          {/* Selectors */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Référence fil</label>
              <SearchableCombobox
                options={refs}
                value={refFilId}
                onChange={(id) => { setRefFilId(id); setColoriId(0) }}
                getId={(r) => r.IDref_fil}
                getPrimary={(r) => r.reference ?? `#${r.IDref_fil}`}
                loading={refsQuery.isLoading}
                placeholder="Rechercher une référence"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Coloris</label>
              <SearchableCombobox
                options={variantes}
                value={coloriId}
                onChange={setColoriId}
                getId={(v) => v.IDcolori_fil}
                getPrimary={(v) => v.reference ?? `#${v.IDcolori_fil}`}
                disabled={refFilId === 0}
                loading={refDetailQuery.isLoading}
                placeholder={refFilId === 0 ? "Choisissez d'abord une référence" : 'Choisir un coloris'}
              />
            </div>
          </div>

          {/* Result — reserve the data-state height so the card keeps a stable
              size whether or not a selection has been made. */}
          <div className="flex min-h-[236px] flex-col">
            {!ready ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/30 text-center">
                <BobineIcon className="h-10 w-10 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  Sélectionnez une référence et un coloris pour voir l'état du stock.
                </p>
              </div>
            ) : etatQuery.isLoading ? (
              <div className="flex flex-1 items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-accent" />
              </div>
            ) : etat ? (
              <div className="space-y-3">
                {(refLabel || coloriLabel) && (
                  <p className="text-xs text-muted-foreground">
                    <span className="font-semibold text-foreground">{refLabel}</span>
                    {coloriLabel && <span> · {coloriLabel}</span>}
                  </p>
                )}

                {/* Three input quantities */}
                <div className="grid gap-3 sm:grid-cols-3">
                  <Kpi
                    label="En stock"
                    value={etat.en_stock}
                    sub={`${etat.nb_lots} lot${etat.nb_lots > 1 ? 's' : ''}`}
                    icon={Boxes}
                    wrap="border-teal/25 bg-teal/[0.06]"
                    iconBox="icon-box-teal"
                    info={{
                      title: 'En stock',
                      text: 'Stock physique restant pour ce fil, lot par lot.',
                      headers: ['Lot', 'Fournisseur', 'kg'],
                      rows: etat.en_stock_rows.map((r) => [r.lot, r.fournisseur, fmtNum(r.kg, 1)]),
                      totalKg: etat.en_stock,
                    }}
                  />
                  <Kpi
                    label="Commandé"
                    value={etat.commande}
                    sub={`${etat.nb_commandes} en cours`}
                    icon={Truck}
                    wrap="border-accent-blue/25 bg-accent-blue/[0.05]"
                    iconBox="bg-accent-blue/10 text-accent-blue"
                    info={{
                      title: 'Commandé',
                      text: 'Commandes fournisseur en cours, déduction faite des lots déjà réceptionnés (reste à recevoir).',
                      headers: ['N° cmd', 'Commandé', 'Reçu', 'Reste'],
                      numCols: 3,
                      rows: etat.commande_rows.map((r) => [`N°${r.commande}`, fmtNum(r.ordered, 1), fmtNum(r.recu, 1), fmtNum(r.kg, 1)]),
                      colTotals: [fmtNum(cmdOrderedTotal, 1), fmtNum(cmdRecuTotal, 1)],
                      totalKg: etat.commande,
                    }}
                  />
                  <Kpi
                    label="Besoin"
                    value={etat.besoin}
                    sub={`${etat.nb_affectations} affectation${etat.nb_affectations > 1 ? 's' : ''}`}
                    icon={Scissors}
                    wrap="border-terracotta/25 bg-terracotta/[0.06]"
                    iconBox="icon-box-terracotta"
                    info={{
                      title: 'Besoin',
                      text: 'Fil affecté aux commandes de tricotage en cours (non soldées).',
                      headers: ['Lot', 'N° STT', 'kg'],
                      rows: etat.besoin_rows.map((r) => [r.lot, `N°${r.commande_sst}`, fmtNum(r.kg, 1)]),
                      totalKg: etat.besoin,
                    }}
                  />
                </div>

                {/* Disponible — the result */}
                <div className="relative flex items-center gap-4 rounded-xl border border-gold/30 bg-gradient-to-br from-gold/15 via-gold/[0.06] to-transparent p-4">
                  <div className="absolute right-2 top-2">
                    <InfoTip
                      title="Disponible"
                      text="Disponible une fois le besoin de production couvert. Négatif = rupture."
                      headers={['Élément', 'kg']}
                      rows={[
                        ['En stock', `+${fmtNum(etat.en_stock, 1)}`],
                        ['Commandé', `+${fmtNum(etat.commande, 1)}`],
                        ['Besoin', `−${fmtNum(etat.besoin, 1)}`],
                      ]}
                      totalKg={etat.disponible}
                    />
                  </div>
                  <div className={cn(
                    'h-12 w-12 flex-shrink-0 rounded-xl flex items-center justify-center',
                    etat.disponible >= 0 ? 'bg-success/12 text-success' : 'bg-destructive/12 text-destructive',
                  )}>
                    {etat.disponible >= 0
                      ? <CheckCircle2 className="h-6 w-6" />
                      : <AlertTriangle className="h-6 w-6" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Disponible</p>
                    <p className="text-[11px] text-muted-foreground">En stock + commandé − besoin</p>
                  </div>
                  <div className="pr-6 text-right">
                    <p className={cn(
                      'text-3xl font-bold tabular-nums',
                      etat.disponible < 0 ? 'text-destructive' : 'text-success',
                    )}>
                      {fmtNum(etat.disponible, 0)}
                      <span className="ml-1 text-base font-normal text-muted-foreground">kg</span>
                    </p>
                    {etat.disponible < 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold text-destructive">
                        <AlertTriangle className="h-2.5 w-2.5" />Rupture
                      </span>
                    )}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </CardContent>
      </RTooltip.Provider>
    </WidgetFrame>
  )
}

function Kpi({
  label, value, sub, icon: Icon, wrap, iconBox, info,
}: {
  label: string
  value: number
  sub?: string
  icon: React.ElementType
  wrap: string
  iconBox: string
  info?: TipData
}) {
  return (
    <div className={cn('relative rounded-xl border p-3', wrap)}>
      {info && <div className="absolute right-2 top-2"><InfoTip {...info} /></div>}
      <div className="flex items-center gap-2 pr-5">
        <div className={cn('h-8 w-8 flex-shrink-0 rounded-lg flex items-center justify-center', iconBox)}>
          <Icon className="h-4 w-4" />
        </div>
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
      </div>
      <p className="mt-2 text-2xl font-semibold tabular-nums">
        {fmtNum(value, 0)}
        <span className="ml-1 text-sm font-normal text-muted-foreground">kg</span>
      </p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  )
}

interface TipData {
  title: string
  text: string
  headers: string[]
  /** Each row's cells; the trailing `numCols` cells are right-aligned numerics. */
  rows: string[][]
  /** Total for the LAST numeric column (rendered with a " kg" suffix). */
  totalKg: number
  /** How many trailing columns are right-aligned numerics. Defaults to 1. */
  numCols?: number
  /** Footer totals for the leading numeric columns (all but the last). Length = numCols-1. */
  colTotals?: string[]
}

// Hover info icon → portaled, collision-aware Radix tooltip showing a title, a
// short explanation, and a breakdown table of every lot/line that's counted.
function InfoTip({ title, text, headers, rows, totalKg, numCols = 1, colTotals = [] }: TipData) {
  // Index of the first right-aligned numeric column.
  const firstNumeric = headers.length - numCols
  return (
    <RTooltip.Root>
      <RTooltip.Trigger asChild>
        <button
          type="button"
          aria-label={`Détails du calcul — ${title}`}
          className="rounded-full text-muted-foreground/50 transition-colors hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      </RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content
          side="top"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          className="z-50 w-[340px] rounded-lg border border-border/70 bg-popover p-3 shadow-lg animate-in fade-in-0 zoom-in-95"
        >
          <p className="text-xs font-semibold text-foreground">{title}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{text}</p>
          {rows.length > 0 ? (
            <div className="mt-2 max-h-[182px] overflow-y-auto rounded-md border border-border/60">
              <table className="w-full text-[10px]">
                <thead className="sticky top-0 bg-muted text-muted-foreground">
                  <tr>
                    {headers.map((h, i) => (
                      <th key={i} className={cn('px-2 py-1 font-medium', i >= firstNumeric ? 'text-right whitespace-nowrap' : 'text-left')}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, ri) => (
                    <tr key={ri} className="border-t border-border/40">
                      {r.map((c, ci) => (
                        <td
                          key={ci}
                          className={cn(
                            'px-2 py-1 align-top',
                            ci >= firstNumeric
                              ? 'whitespace-nowrap text-right font-medium tabular-nums text-foreground'
                              : 'text-left text-muted-foreground',
                          )}
                        >
                          {c}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-border bg-muted">
                    <td className="px-2 py-1 font-semibold text-foreground" colSpan={Math.max(1, firstNumeric)}>Total</td>
                    {colTotals.map((t, i) => (
                      <td key={i} className="px-2 py-1 text-right font-semibold tabular-nums text-muted-foreground">{t}</td>
                    ))}
                    <td className="px-2 py-1 text-right font-bold tabular-nums text-foreground">{fmtNum(totalKg)} kg</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <p className="mt-2 rounded-md border border-dashed border-border bg-muted/40 py-2 text-center text-[11px] italic text-muted-foreground">
              Aucun élément.
            </p>
          )}
          <RTooltip.Arrow className="fill-popover" width={11} height={6} />
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  )
}
