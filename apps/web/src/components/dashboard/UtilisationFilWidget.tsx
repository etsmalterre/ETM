// ── Utilisation fil widget ────────────────────────────────────
// Port of the legacy FI_Utilisation_fil.wdw dashboard panel: pick a yarn (and
// optionally one of its coloris) and see which écru references are knitted
// from it. Backed by GET /api/references-fil/:id/utilisation.
//
// Legacy had a "Filtre" text box + a "Filtrer" button that narrowed the Fil
// dropdown. That round trip exists because a WinDev combo can't search; ours
// can, so the search lives inside the SearchableCombobox and the button is
// gone — same job, one interaction instead of three.

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Loader2, Search, Layers, Archive } from 'lucide-react'
import { CardContent } from '@/components/ui/card'
import { PopoverSelect, SearchableCombobox } from '@/components/ui/popover-select'
import { BobineIcon } from '@/components/icons/BobineIcon'
import { apiFetch } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { cn } from '@/lib/utils'
import { WidgetFrame } from './WidgetFrame'

interface RefFilOption { IDref_fil: number; reference: string | null }

interface ColorisGroup { id: number; nom: string; ids: number[]; refs: number }
interface UsageRow {
  IDref_ecru: number
  reference: string
  designation: string
  archived: boolean
  pourcentage: number | null
}
interface UsageResponse {
  ref_fil: { IDref_fil: number; reference: string }
  coloris: ColorisGroup[]
  selected_coloris: { id: number; nom: string } | null
  total_refs: number
  rows: UsageRow[]
}

export function UtilisationFilWidget() {
  const [filId, setFilId] = useState(0)
  const [coloriId, setColoriId] = useState(0)

  // Same query key as the other yarn widgets — one fetch of the catalog serves
  // the whole dashboard.
  const refsQuery = useQuery<RefFilOption[]>({
    queryKey: ['references-fil'],
    queryFn: () => apiFetch('/references-fil'),
  })

  const usageQuery = useQuery<UsageResponse>({
    queryKey: ['utilisation-fil', filId, coloriId],
    queryFn: () => apiFetch(
      `/references-fil/${filId}/utilisation${coloriId > 0 ? `?colori=${coloriId}` : ''}`,
    ),
    enabled: filId > 0,
  })

  const coloris = usageQuery.data?.coloris ?? []
  const rows = usageQuery.data?.rows ?? []
  const totalRefs = usageQuery.data?.total_refs ?? 0

  const coloriOptions = useMemo(
    () => coloris.map((c) => ({ id: c.id, primary: c.nom, secondary: `${c.refs}` })),
    [coloris],
  )

  // A coloris chosen for one yarn is meaningless for the next one, and leaving
  // it set would silently filter the new list.
  function handleFilChange(next: number) {
    setFilId(next)
    setColoriId(0)
  }

  return (
    <WidgetFrame icon={BobineIcon} title="Utilisation fil">
      <CardContent className="flex h-full flex-col gap-3 p-3">
        {/* Pickers */}
        <div className="flex flex-shrink-0 flex-col gap-2">
          <div className="flex items-center gap-2">
            <label className="w-14 flex-shrink-0 text-xs font-medium text-muted-foreground">Fil</label>
            {/* Default size on both pickers, never "sm": the compact variant
                hard-codes its own width (w-[220px]) on its root, so it would
                overflow this flex-1 wrapper instead of filling it — the exact
                trap mps_designer §11bis calls out. */}
            <div className="min-w-0 flex-1">
              <SearchableCombobox
                options={refsQuery.data ?? []}
                value={filId}
                onChange={handleFilChange}
                getId={(r) => r.IDref_fil}
                getPrimary={(r) => r.reference ?? ''}
                placeholder="Rechercher une référence de fil"
                loading={refsQuery.isLoading}
              />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <label className="w-14 flex-shrink-0 text-xs font-medium text-muted-foreground">Coloris</label>
            <div className="min-w-0 flex-1">
              <PopoverSelect
                options={coloriOptions}
                value={coloriId}
                onChange={setColoriId}
                emptyLabel={`Tous les coloris${totalRefs > 0 ? ` (${totalRefs})` : ''}`}
                disabled={filId === 0 || coloriOptions.length === 0}
                disabledTitle={filId === 0
                  ? "Choisissez d'abord un fil"
                  : 'Aucun coloris de ce fil n’est utilisé dans une composition'}
              />
            </div>
          </div>
        </div>

        {/* Result list */}
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          {filId > 0 && !usageQuery.isLoading && !usageQuery.isError && (
            <p className="flex-shrink-0 text-xs text-muted-foreground">
              {rows.length === 0
                ? 'Aucune référence'
                : `${rows.length} référence${rows.length > 1 ? 's' : ''}`}
              {/* Say what the coloris filter is hiding — otherwise the count
                  just shrinks and the user can't tell why. */}
              {coloriId > 0 && totalRefs > rows.length && (
                <span className="ml-1 text-muted-foreground/70">
                  sur {totalRefs} pour ce fil
                </span>
              )}
            </p>
          )}

          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto scrollbar-transparent p-1">
            {filId === 0 && (
              <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                <Search className="mb-3 h-12 w-12 opacity-40" />
                <p className="text-sm">Choisissez un fil</p>
                <p className="mt-1 text-xs">Les références qui l’utilisent s’afficheront ici.</p>
              </div>
            )}

            {filId > 0 && usageQuery.isLoading && (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="h-6 w-6 animate-spin text-accent" />
              </div>
            )}

            {filId > 0 && usageQuery.isError && (
              <p className="py-8 text-center text-sm text-destructive">
                Impossible de charger l’utilisation de ce fil.
              </p>
            )}

            {filId > 0 && !usageQuery.isLoading && !usageQuery.isError && rows.length === 0 && (
              <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
                <Layers className="mb-3 h-12 w-12 opacity-40" />
                <p className="text-sm">Aucune référence n’utilise ce fil</p>
                {coloriId > 0 && totalRefs > 0 && (
                  <p className="mt-1 text-xs">
                    {totalRefs} référence{totalRefs > 1 ? 's' : ''} sans filtre de coloris.
                  </p>
                )}
              </div>
            )}

            {rows.map((r) => (
              <div
                key={r.IDref_ecru}
                className={cn(
                  'flex items-center gap-2 rounded-lg border border-border/60 border-l-4 bg-zinc-100/80 p-2.5',
                  r.archived ? 'border-l-border opacity-70' : 'border-l-amber-400/60',
                )}
              >
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 truncate text-sm font-medium" title={r.reference}>
                    {r.reference}
                    {/* Legacy lists archived références silently; flagging them
                        costs nothing and stops a dead ref reading as live. */}
                    {r.archived && (
                      <span className="inline-flex flex-shrink-0 items-center gap-0.5 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                        <Archive className="h-2.5 w-2.5" />
                        archivée
                      </span>
                    )}
                  </p>
                  {r.designation && (
                    <p className="truncate text-[11px] text-muted-foreground" title={r.designation}>
                      {r.designation}
                    </p>
                  )}
                </div>
                {r.pourcentage != null && (
                  <span className="flex-shrink-0 text-xs font-semibold tabular-nums text-amber-700">
                    {fmtNum(r.pourcentage)} %
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </WidgetFrame>
  )
}
