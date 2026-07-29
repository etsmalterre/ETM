import { useState, useMemo, useCallback, useEffect, useRef, useDeferredValue, memo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Search,
  Loader2,
  AlertCircle,
  Pencil,
  X,
  Save,
  Trash2,
  ArrowUp,
  ArrowDown,
  Plus,
  Box,
  Boxes,
  Layers,
  Ruler,
  Palette,
  Tag,
  BadgeEuro,
  Archive,
  Warehouse,
  FileText,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { UnsavedChangesDialog } from '@/components/shared/UnsavedChangesDialog'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import { PopoverSelect, SearchableCombobox } from '@/components/ui/popover-select'
import { CardKV, MobileSortRow } from '@/components/stock/StockCardParts'
import { useHasPermission } from '@/contexts/PermissionsContext'
import { cn } from '@/lib/utils'
import { apiFetch, API_URL } from '@/lib/api'
import { fmtNum } from '@/lib/format'

// Divers › Stock — the quantity on hand for every "référence diverse", one row
// per VARIATION COMBINATION (legacy FEN_Stock_Divers.wdw + the little
// FEN_Gestion_Stock_Divers add/edit modal).
//
// The legacy modal locks the reference and both variations once a row exists and
// only lets the quantity through: moving stock to another combination is a
// delete + create, not an edit. The drawer reproduces that — quantity is the one
// editable field, the combination is displayed read-only.
//
// The variation / price vocabulary is shared with Divers › Références
// (`DiversReferences.tsx`); keep the two in sync.

// ── Domain vocabulary ──────────────────────────────────

const VARIATION_TYPES = ['Aucun', 'Couleur', 'Taille', 'Reference'] as const
type VariationType = (typeof VARIATION_TYPES)[number]

function variationTypeLabel(t: VariationType): string {
  if (t === 'Aucun') return 'Aucune'
  if (t === 'Reference') return 'Référence'
  return t
}

function axisIcon(t: VariationType) {
  if (t === 'Couleur') return Palette
  if (t === 'Taille') return Ruler
  if (t === 'Reference') return Tag
  return Layers
}

// ── Types ──────────────────────────────────────────────

interface StockDiversRow {
  IDstock_divers: number
  IDref_divers: number
  quantite: number
  unite: number
  unite_label: string
  IDVariation1: number
  IDVariation2: number
  variation1_label: string | null
  variation2_label: string | null
  ref_designation: string | null
  ref_archive: number
  sTypeVariation1: VariationType
  sTypeVariation2: VariationType
  prix: number | null
  valeur: number | null
}

interface StockDiversDetail extends StockDiversRow {
  ref_observations: string | null
  ref_unite_label: string
  ref_stock_total: number
  ref_combinaisons: number
}

interface VariationOption {
  id: number
  designation: string
  niveau: number
}

interface RefDiversOption {
  IDref_divers: number
  designation: string | null
  unite: number
  unite_label: string
  sTypeVariation1: VariationType
  sTypeVariation2: VariationType
  variations1: VariationOption[]
  variations2: VariationOption[]
}

// ── API helpers ────────────────────────────────────────

/** Write helper for this screen's mutations. `apiFetch` throws a bare
 *  `API <status>` without reading the body, which would hide the French
 *  messages the route returns on its 400/409 guards ("Cette combinaison est
 *  déjà en stock…"). This issues the request ONCE and carries the server's
 *  message onto the thrown Error so the dialogs can show it verbatim. */
async function apiMutate<T = unknown>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init.headers },
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const err: Error & { status?: number } = new Error(
      (body && typeof body.error === 'string' && body.error) || `API ${res.status}`,
    )
    err.status = res.status
    throw err
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

function useStockDiversList() {
  return useQuery<StockDiversRow[]>({
    queryKey: ['stock-divers'],
    queryFn: () => apiFetch<StockDiversRow[]>('/stock-divers'),
  })
}

function useStockDiversDetail(id: number | null) {
  return useQuery<StockDiversDetail>({
    queryKey: ['stock-divers', 'detail', id],
    queryFn: () => apiFetch<StockDiversDetail>(`/stock-divers/${id}`),
    enabled: id !== null,
  })
}

function useRefDiversLookup(enabled: boolean) {
  return useQuery<RefDiversOption[]>({
    queryKey: ['stock-divers', 'lookups', 'references'],
    queryFn: () => apiFetch<RefDiversOption[]>('/stock-divers/lookups/references'),
    enabled,
  })
}

// ── Helpers ────────────────────────────────────────────

/** The combination as one readable line — "Noir · L/XL", or a dash when the
 *  reference carries no variation axis at all. */
function combinationLabel(row: Pick<StockDiversRow, 'variation1_label' | 'variation2_label'>): string {
  const parts = [row.variation1_label, row.variation2_label].filter((v): v is string => !!v && v.trim() !== '')
  return parts.length > 0 ? parts.join(' · ') : 'Sans variation'
}

function formatPrix(v: number | null): string {
  return v == null ? '—' : `${fmtNum(v, 2)} €`
}

// ── Sort handling ──────────────────────────────────────

type SortKey =
  | 'ref_designation'
  | 'variation1_label'
  | 'variation2_label'
  | 'quantite'
  | 'unite_label'
  | 'prix'
  | 'valeur'

interface SortState {
  key: SortKey
  dir: 'asc' | 'desc'
}

const COLUMN_DEFS: { key: SortKey; label: string; width: string; align?: 'left' | 'right' }[] = [
  { key: 'ref_designation', label: 'Référence', width: '26%' },
  { key: 'variation1_label', label: 'Variation 1', width: '15%' },
  { key: 'variation2_label', label: 'Variation 2', width: '15%' },
  { key: 'quantite', label: 'Quantité', width: '10%', align: 'right' },
  { key: 'unite_label', label: 'Unité', width: '8%' },
  { key: 'prix', label: 'Prix unitaire', width: '12%', align: 'right' },
  { key: 'valeur', label: 'Valeur', width: '14%', align: 'right' },
]

const ROW_COLLATOR = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' })

function compareRows(a: StockDiversRow, b: StockDiversRow, key: SortKey): number {
  const va = a[key]
  const vb = b[key]
  if (va == null && vb == null) return 0
  if (va == null) return 1
  if (vb == null) return -1
  if (typeof va === 'number' && typeof vb === 'number') return va - vb
  return ROW_COLLATOR.compare(String(va), String(vb))
}

// ── Main Page ──────────────────────────────────────────

export function DiversStock() {
  const queryClient = useQueryClient()
  const [searchQuery, setSearchQuery] = useState('')
  const [refFilter, setRefFilter] = useState(0)
  const [hideZero, setHideZero] = useState(false)
  const [sort, setSort] = useState<SortState>({ key: 'ref_designation', dir: 'asc' })
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const canCreate = useHasPermission('create_stock_divers')

  const { data: rows, isLoading, isError, error } = useStockDiversList()
  const deferredSearch = useDeferredValue(searchQuery)

  // Reference filter options — only the references that actually carry stock,
  // so the list never offers a pick that yields zero rows.
  const refOptions = useMemo(() => {
    const byId = new Map<number, { IDref_divers: number; designation: string; lignes: number }>()
    for (const r of rows ?? []) {
      const hit = byId.get(r.IDref_divers)
      if (hit) hit.lignes += 1
      else
        byId.set(r.IDref_divers, {
          IDref_divers: r.IDref_divers,
          designation: r.ref_designation ?? `Réf #${r.IDref_divers}`,
          lignes: 1,
        })
    }
    return [...byId.values()].sort((a, b) => ROW_COLLATOR.compare(a.designation, b.designation))
  }, [rows])

  // Keep the filter honest if the picked reference disappears from the data.
  useEffect(() => {
    if (refFilter !== 0 && rows && !refOptions.some((o) => o.IDref_divers === refFilter)) setRefFilter(0)
  }, [refFilter, refOptions, rows])

  const filteredSorted = useMemo(() => {
    let out = rows ?? []
    if (refFilter > 0) out = out.filter((r) => r.IDref_divers === refFilter)
    if (hideZero) out = out.filter((r) => r.quantite !== 0)
    const terms = deferredSearch.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length > 0) {
      out = out.filter((r) => {
        const haystacks = [r.ref_designation, r.variation1_label, r.variation2_label, r.unite_label]
          .filter((f): f is string => !!f)
          .map((f) => f.toLowerCase())
        return terms.every((t) => haystacks.some((h) => h.includes(t)))
      })
    }
    return [...out].sort((a, b) => {
      const cmp = compareRows(a, b, sort.key)
      if (cmp !== 0) return sort.dir === 'asc' ? cmp : -cmp
      // Stable secondary ordering so the combinations of one reference always
      // read in the same order whatever the active sort.
      const ref = ROW_COLLATOR.compare(a.ref_designation ?? '', b.ref_designation ?? '')
      if (ref !== 0) return ref
      return ROW_COLLATOR.compare(combinationLabel(a), combinationLabel(b))
    })
  }, [rows, refFilter, hideZero, deferredSearch, sort])

  // When a single reference is in view its axes are known, so the generic
  // "Variation 1 / 2" headers can name what the column actually holds.
  const columns = useMemo(() => {
    const axes = refFilter > 0 ? filteredSorted[0] : undefined
    if (!axes) return COLUMN_DEFS
    return COLUMN_DEFS.map((c) => {
      if (c.key === 'variation1_label' && axes.sTypeVariation1 !== 'Aucun')
        return { ...c, label: variationTypeLabel(axes.sTypeVariation1) }
      if (c.key === 'variation2_label' && axes.sTypeVariation2 !== 'Aucun')
        return { ...c, label: variationTypeLabel(axes.sTypeVariation2) }
      return c
    })
  }, [refFilter, filteredSorted])

  const handleSort = useCallback((key: SortKey) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
  }, [])

  // Drawer dirty tracking — populated by the drawer via refs (§28.3.c).
  const [drawerDirty, setDrawerDirty] = useState(false)
  const drawerSaveRef = useRef<() => Promise<void>>(async () => {})
  const drawerDiscardRef = useRef<() => void>(() => {})

  const guard = useUnsavedGuard({
    isDirty: drawerDirty,
    save: async () => { await drawerSaveRef.current() },
    onDiscard: () => drawerDiscardRef.current(),
  })

  const handleClose = useCallback(() => {
    guard.guardAction(() => setSelectedId(null))
  }, [guard.guardAction])

  const handleRowClick = useCallback((rowId: number) => {
    guard.guardAction(() => {
      setSelectedId((prev) => (prev === rowId ? null : rowId))
    })
  }, [guard.guardAction])

  const onMutationSuccess = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['stock-divers'] })
  }, [queryClient])

  // Totalizer over the currently-visible rows. Quantities span three units
  // (Kg / Ml / Pièce) so they are totalled per unit, never summed together;
  // the valorisation is a single figure because it is always euros.
  const lineCount = filteredSorted.length
  const totalsByUnit = useMemo(() => {
    const acc = new Map<string, number>()
    for (const r of filteredSorted) {
      const key = r.unite_label || '—'
      acc.set(key, (acc.get(key) ?? 0) + r.quantite)
    }
    return [...acc.entries()].filter(([, q]) => q !== 0).sort((a, b) => b[1] - a[1])
  }, [filteredSorted])
  const totalValeur = useMemo(
    () => filteredSorted.reduce((sum, r) => sum + (r.valeur ?? 0), 0),
    [filteredSorted],
  )

  return (
    <div className="h-full flex flex-col gap-3 min-h-0">
      {/* Toolbar — below sm the reference filter + checkbox are forced onto their
          own full-width row (sm:contents dissolves the wrapper at sm+), so the
          "Nouveau" action always keeps the top-right corner. */}
      <div className="flex-shrink-0 flex flex-wrap items-center gap-3">
        <div className="relative order-1 flex-1 min-w-0">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Rechercher (référence, variation, unité…)"
            className="h-9 w-full pl-8 pr-3 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {/* Below sm this wrapper is a full-width row of its own and its children
            stack (a w-56 combobox + the long checkbox label overflow a 345px
            viewport side by side). At sm+ display:contents dissolves the wrapper
            so both rejoin the toolbar flex with their own sm:order — desktop
            pixels unchanged. */}
        <div className="order-4 w-full flex flex-wrap items-center gap-3 sm:contents">
          <div className="w-full sm:w-56 flex-shrink-0 sm:order-3">
            <SearchableCombobox<{ IDref_divers: number; designation: string; lignes: number }>
              options={refOptions}
              value={refFilter}
              onChange={setRefFilter}
              getId={(r) => r.IDref_divers}
              getPrimary={(r) => r.designation}
              getSecondary={(r) => `${r.lignes} ligne${r.lignes > 1 ? 's' : ''}`}
              placeholder="Toutes les références"
            />
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer select-none flex-shrink-0 sm:order-4">
            <input
              type="checkbox"
              checked={hideZero}
              onChange={(e) => setHideZero(e.target.checked)}
              className="h-4 w-4 rounded border-input text-accent focus:ring-2 focus:ring-ring cursor-pointer"
            />
            <span className="whitespace-nowrap">Masquer les quantités nulles</span>
          </label>
        </div>

        {canCreate && (
          <div className="flex items-center gap-2 flex-shrink-0 order-2 sm:order-5">
            <Button size="sm" onClick={() => setCreateOpen(true)} title="Nouveau">
              <Plus className="h-3.5 w-3.5 sm:mr-1" />
              <span className="hidden sm:inline">Nouveau</span>
            </Button>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 min-h-0 flex flex-col rounded-lg border border-border/60 bg-white shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-8 w-8 animate-spin text-accent" />
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center justify-center h-full text-destructive gap-2">
            <AlertCircle className="h-8 w-8" />
            <p className="text-sm">{(error as Error)?.message || 'Erreur de chargement'}</p>
          </div>
        ) : filteredSorted.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
            <Boxes className="h-12 w-12 opacity-30" />
            <p className="text-sm">Aucune ligne de stock</p>
          </div>
        ) : (
          <>
            {/* Desktop table (md+) — split header/body sharing one colgroup */}
            <div className="hidden md:flex md:flex-col flex-1 min-h-0">
              <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
                <colgroup>
                  {columns.map((c) => (
                    <col key={c.key} style={{ width: c.width }} />
                  ))}
                </colgroup>
                <thead className="bg-zinc-200/60 border-b border-border/60">
                  <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                    {columns.map((c) => (
                      <SortHeader
                        key={c.key}
                        label={c.label}
                        sortKey={c.key}
                        sort={sort}
                        onSort={handleSort}
                        align={c.align}
                      />
                    ))}
                  </tr>
                </thead>
              </table>

              <div className="flex-1 min-h-0 overflow-auto scrollbar-transparent">
                <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
                  <colgroup>
                    {columns.map((c) => (
                      <col key={c.key} style={{ width: c.width }} />
                    ))}
                  </colgroup>
                  <tbody>
                    {filteredSorted.map((r) => (
                      <StockRow
                        key={r.IDstock_divers}
                        row={r}
                        selected={r.IDstock_divers === selectedId}
                        onRowClick={handleRowClick}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Mobile card list (< md) — same rows, selection and sort state */}
            <div className="md:hidden flex-1 min-h-0 flex flex-col">
              <MobileSortRow columns={columns} sort={sort} onSortChange={setSort} />
              <div className="flex-1 min-h-0 overflow-y-auto scrollbar-transparent p-2 space-y-2 bg-zinc-100/80">
                {filteredSorted.map((r) => (
                  <StockDiversCard
                    key={r.IDstock_divers}
                    row={r}
                    selected={r.IDstock_divers === selectedId}
                    onRowClick={handleRowClick}
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Totalizer — quantities per unit on the left, valorisation on the right.
          Below sm the labels drop out (the units speak for themselves) so the
          bar stays on one line. */}
      {!isLoading && !isError && filteredSorted.length > 0 && (
        <div className="flex-shrink-0 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-zinc-100/80 shadow-sm px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Box className="h-4 w-4 text-accent" />
            <span className="font-semibold tabular-nums">{lineCount}</span>
            <span className="text-muted-foreground">ligne{lineCount > 1 ? 's' : ''}</span>
            {totalsByUnit.length > 0 && (
              <span className="flex flex-wrap items-center gap-1.5 sm:ml-3 sm:pl-3 sm:border-l border-border/60">
                {totalsByUnit.map(([unit, q], i) => (
                  <span key={unit} className="flex items-center gap-1.5">
                    {i > 0 && <span className="text-muted-foreground/50">·</span>}
                    <span className="font-medium tabular-nums">{fmtNum(q, q % 1 === 0 ? 0 : 2)}</span>
                    <span className="text-muted-foreground">{unit}</span>
                  </span>
                ))}
              </span>
            )}
          </div>
          <div className="flex items-baseline gap-1.5 sm:gap-2">
            <span className="hidden sm:inline text-xs uppercase tracking-wide text-muted-foreground whitespace-nowrap">
              Valorisation
            </span>
            <span className="text-sm sm:text-base font-bold tabular-nums whitespace-nowrap">
              {fmtNum(totalValeur, 2)} €
            </span>
          </div>
        </div>
      )}

      <StockDiversDrawer
        id={selectedId}
        onClose={handleClose}
        onMutationSuccess={onMutationSuccess}
        onDeleted={() => setSelectedId(null)}
        onDirtyChange={setDrawerDirty}
        saveRef={drawerSaveRef}
        discardRef={drawerDiscardRef}
      />

      <UnsavedChangesDialog open={guard.showDialog} onAction={guard.handleAction} isSaving={guard.isSaving} />

      <CreateStockDiversDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(newId) => {
          setCreateOpen(false)
          onMutationSuccess()
          if (newId != null) setSelectedId(newId)
        }}
      />
    </div>
  )
}

// ── Table row (memoized) ──────────────────────────────

const StockRow = memo(function StockRow({
  row,
  selected,
  onRowClick,
}: {
  row: StockDiversRow
  selected: boolean
  onRowClick: (id: number) => void
}) {
  return (
    <tr
      data-stock-row
      onClick={() => onRowClick(row.IDstock_divers)}
      className={cn(
        'border-b border-border/40 cursor-pointer transition-colors',
        selected ? 'bg-accent/10' : 'hover:bg-accent/5',
      )}
    >
      <td className="px-2 py-2 font-medium truncate" title={row.ref_designation ?? undefined}>
        <span className="flex items-center gap-1.5 min-w-0">
          <span className="truncate">{row.ref_designation ?? '—'}</span>
          {!!row.ref_archive && (
            <Badge variant="outline" className="text-[10px] py-0 flex-shrink-0 gap-1 text-muted-foreground">
              <Archive className="h-2.5 w-2.5" />
              Archivée
            </Badge>
          )}
        </span>
      </td>
      <td className="px-2 py-2 truncate" title={row.variation1_label ?? undefined}>
        {row.variation1_label ?? <span className="text-muted-foreground">—</span>}
      </td>
      <td className="px-2 py-2 truncate" title={row.variation2_label ?? undefined}>
        {row.variation2_label ?? <span className="text-muted-foreground">—</span>}
      </td>
      <td
        className={cn(
          'px-2 py-2 text-right tabular-nums font-semibold',
          row.quantite === 0 && 'text-muted-foreground font-normal',
        )}
      >
        {fmtNum(row.quantite, row.quantite % 1 === 0 ? 0 : 2)}
      </td>
      <td className="px-2 py-2 truncate text-muted-foreground">{row.unite_label || '—'}</td>
      <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{formatPrix(row.prix)}</td>
      <td className="px-2 py-2 text-right tabular-nums">{formatPrix(row.valeur)}</td>
    </tr>
  )
})

// ── Mobile card (below md) ─────────────────────────────

const StockDiversCard = memo(function StockDiversCard({
  row,
  selected,
  onRowClick,
}: {
  row: StockDiversRow
  selected: boolean
  onRowClick: (id: number) => void
}) {
  return (
    <div
      data-stock-row
      onClick={() => onRowClick(row.IDstock_divers)}
      className={cn(
        'rounded-lg border p-3 cursor-pointer transition-colors shadow-sm',
        selected ? 'bg-accent/10 border-accent ring-1 ring-accent' : 'bg-white border-border/60 hover:border-accent/40',
      )}
    >
      <div className="flex items-center gap-2">
        <p className="text-sm font-medium truncate flex-1 min-w-0">{row.ref_designation ?? '—'}</p>
        {!!row.ref_archive && (
          <Badge variant="outline" className="text-[10px] py-0 flex-shrink-0 gap-1 text-muted-foreground">
            <Archive className="h-2.5 w-2.5" />
            Archivée
          </Badge>
        )}
      </div>
      <p className="text-xs text-muted-foreground mt-0.5 truncate">{combinationLabel(row)}</p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 mt-2">
        <CardKV
          label="Quantité"
          value={`${fmtNum(row.quantite, row.quantite % 1 === 0 ? 0 : 2)} ${row.unite_label}`}
          mono
          strong
        />
        <CardKV label="Valeur" value={formatPrix(row.valeur)} mono />
        <CardKV label="Prix unitaire" value={formatPrix(row.prix)} mono />
      </div>
    </div>
  )
})

// ── Sort header cell ───────────────────────────────────

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
  align = 'left',
}: {
  label: string
  sortKey: SortKey
  sort: SortState
  onSort: (k: SortKey) => void
  align?: 'left' | 'right'
}) {
  const active = sort.key === sortKey
  return (
    <th
      onClick={() => onSort(sortKey)}
      className={cn(
        'px-2 py-2.5 font-semibold cursor-pointer select-none whitespace-nowrap',
        align === 'right' ? 'text-right' : 'text-left',
        active && 'text-accent',
      )}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active && (sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </span>
    </th>
  )
}

// ── Side drawer ────────────────────────────────────────

interface DrawerProps {
  id: number | null
  onClose: () => void
  onMutationSuccess: () => void
  onDeleted: () => void
  onDirtyChange: (dirty: boolean) => void
  saveRef: React.MutableRefObject<() => Promise<void>>
  discardRef: React.MutableRefObject<() => void>
}

function StockDiversDrawer({
  id,
  onClose,
  onMutationSuccess,
  onDeleted,
  onDirtyChange,
  saveRef,
  discardRef,
}: DrawerProps) {
  const { data: detail, isLoading } = useStockDiversDetail(id)
  const canEdit = useHasPermission('edit_stock_divers')
  const drawerRef = useRef<HTMLDivElement>(null)
  const [searchParams] = useSearchParams()
  const embed = searchParams.get('embed') === 'true'

  const [isEditing, setIsEditing] = useState(false)
  const [editQuantite, setEditQuantite] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const originalDraftRef = useRef<{ quantite: string } | null>(null)

  useEffect(() => {
    setIsEditing(false)
    setError(null)
  }, [id])

  useEffect(() => {
    if (id === null) return
    function handleMouseDown(e: MouseEvent) {
      const target = e.target as Node | null
      if (!target) return
      if (drawerRef.current?.contains(target)) return
      // Table rows and mobile cards both carry data-stock-row — they switch the
      // selection themselves.
      if ((target as Element).closest?.('[data-stock-row]')) return
      onClose()
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [id, onClose])

  const startEdit = useCallback(() => {
    if (!detail) return
    const snapshot = { quantite: String(detail.quantite) }
    setEditQuantite(snapshot.quantite)
    originalDraftRef.current = snapshot
    setError(null)
    setIsEditing(true)
  }, [detail])

  const parsedQuantite = useMemo(() => {
    const v = Number(editQuantite.replace(',', '.'))
    return Number.isFinite(v) ? v : NaN
  }, [editQuantite])

  const saveMutation = useMutation({
    mutationFn: () =>
      apiMutate(`/stock-divers/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ quantite: parsedQuantite }),
      }),
    onSuccess: () => {
      onMutationSuccess()
      setIsEditing(false)
      setError(null)
    },
    onError: (err: Error) => setError(err.message || 'Erreur lors de l’enregistrement'),
  })

  const deleteMutation = useMutation({
    mutationFn: () => apiMutate(`/stock-divers/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setIsEditing(false)
      setConfirmDelete(false)
      onMutationSuccess()
      onDeleted()
    },
    onError: (err: Error) => {
      setConfirmDelete(false)
      setError(err.message || 'Erreur lors de la suppression')
    },
  })

  const isDirty = useMemo(() => {
    if (!isEditing) return false
    const o = originalDraftRef.current
    if (!o) return false
    return editQuantite !== o.quantite
  }, [isEditing, editQuantite])

  useEffect(() => { onDirtyChange(isDirty) }, [isDirty, onDirtyChange])
  useEffect(() => () => { onDirtyChange(false) }, [onDirtyChange])

  useEffect(() => {
    saveRef.current = async () => { await saveMutation.mutateAsync() }
  })
  useEffect(() => {
    discardRef.current = () => setIsEditing(false)
  })

  const open = id !== null
  const canSave = !isNaN(parsedQuantite) && editQuantite.trim() !== ''
  const delta = detail && !isNaN(parsedQuantite) ? Math.round((parsedQuantite - detail.quantite) * 1000) / 1000 : 0

  const Axis1Icon = axisIcon(detail?.sTypeVariation1 ?? 'Aucun')
  const Axis2Icon = axisIcon(detail?.sTypeVariation2 ?? 'Aucun')
  const hasAxes =
    !!detail && (detail.sTypeVariation1 !== 'Aucun' || detail.sTypeVariation2 !== 'Aucun')

  return (
    <div
      ref={drawerRef}
      className={cn(
        'fixed right-0 bottom-0 w-full max-w-[440px] bg-white border-l border-border/60 shadow-xl z-30 transition-transform duration-300 flex flex-col',
        embed ? 'top-0' : 'top-14',
        open ? 'translate-x-0' : 'translate-x-full',
      )}
    >
      <div className="flex-1 min-h-0 flex flex-col bg-zinc-100/80">
        {/* Header band — the widget treatment (mps_designer §27.5bis / §43):
            navy surface, flat gold tile, white title, gold hairline under. */}
        <div className="flex-shrink-0 flex items-center gap-2.5 border-b-2 border-gold bg-primary px-4 py-2.5">
          <div
            className={cn(
              'h-8 w-8 flex-shrink-0 rounded-lg flex items-center justify-center shadow-sm transition-colors',
              isEditing ? 'bg-white text-primary' : 'bg-gold text-gold-foreground',
            )}
          >
            <Box className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            {isLoading || !detail ? (
              <div className="h-5 w-40 bg-white/20 animate-pulse rounded" />
            ) : (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-base font-heading font-bold tracking-tight truncate text-primary-foreground">
                    {detail.ref_designation ?? '—'}
                  </h2>
                  {/* An unfilled outline chip is invisible on navy — the
                      neutral chip is white-on-white/15 instead (§27.5bis). */}
                  {!!detail.ref_archive && (
                    <span className="inline-flex items-center gap-1 flex-shrink-0 rounded-full border border-white/25 bg-white/15 px-1.5 py-0 text-[10px] font-medium text-white">
                      <Archive className="h-2.5 w-2.5" />
                      Archivée
                    </span>
                  )}
                </div>
                <p className="text-xs text-white/70 truncate">{combinationLabel(detail)}</p>
              </>
            )}
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {detail &&
              (isEditing ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="px-2 text-white/80 hover:bg-white/15 hover:text-white"
                    onClick={() => setIsEditing(false)}
                    title="Annuler"
                  >
                    <X className="h-3.5 w-3.5 sm:mr-1.5" />
                    <span className="hidden sm:inline">Annuler</span>
                  </Button>
                  <Button
                    variant="gold"
                    size="sm"
                    onClick={() => saveMutation.mutate()}
                    disabled={!canSave || saveMutation.isPending}
                    title="Enregistrer"
                  >
                    {saveMutation.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 sm:mr-1.5 animate-spin" />
                    ) : (
                      <Save className="h-3.5 w-3.5 sm:mr-1.5" />
                    )}
                    <span className="hidden sm:inline">Enregistrer</span>
                  </Button>
                </>
              ) : (
                canEdit && (
                  <Button variant="gold" size="sm" onClick={startEdit} title="Modifier">
                    <Pencil className="h-3.5 w-3.5 sm:mr-1.5" />
                    <span className="hidden sm:inline">Modifier</span>
                  </Button>
                )
              ))}
            {/* Mobile-only close — at full drawer width there is no "outside" to tap */}
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 flex-shrink-0 md:hidden text-white/80 hover:bg-white/15 hover:text-white"
              onClick={onClose}
              title="Fermer"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3 scrollbar-transparent">
          {isLoading || !detail ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-accent" />
            </div>
          ) : (
            <>
              {error && (
                <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-sm text-destructive">
                  <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                  <span>{error}</span>
                </div>
              )}

              {/* Stock — the only editable card, mirroring the legacy modal */}
              <DrawerCard icon={<Warehouse className="h-4 w-4 text-accent" />} title="Stock" highlight={isEditing}>
                <div className="space-y-2">
                  <KV
                    label="Quantité"
                    value={
                      isEditing ? (
                        <input
                          type="number"
                          step="any"
                          value={editQuantite}
                          onChange={(e) => setEditQuantite(e.target.value)}
                          className="h-7 w-[120px] px-2 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring text-right"
                        />
                      ) : (
                        <span className="font-semibold tabular-nums">
                          {fmtNum(detail.quantite, detail.quantite % 1 === 0 ? 0 : 2)}
                        </span>
                      )
                    }
                  />
                  <KV label="Unité" value={detail.unite_label || '—'} />
                  {isEditing && delta !== 0 && (
                    <p
                      className={cn(
                        'text-[11px] text-right tabular-nums',
                        delta > 0 ? 'text-emerald-700' : 'text-orange-700',
                      )}
                    >
                      {delta > 0 ? '+' : ''}
                      {fmtNum(delta, delta % 1 === 0 ? 0 : 2)} {detail.unite_label} par rapport au stock enregistré
                    </p>
                  )}
                </div>
              </DrawerCard>

              {/* Combination — read-only: moving stock to another combination is
                  a delete + create, exactly as in the legacy modal. */}
              <DrawerCard
                icon={<Layers className="h-4 w-4 text-accent" />}
                title="Combinaison"
                highlight={isEditing}
              >
                {hasAxes ? (
                  <div className="space-y-2">
                    {detail.sTypeVariation1 !== 'Aucun' && (
                      <KV
                        label={variationTypeLabel(detail.sTypeVariation1)}
                        value={
                          <span className="inline-flex items-center gap-1.5">
                            <Axis1Icon className="h-3.5 w-3.5 text-muted-foreground" />
                            {detail.variation1_label ?? '—'}
                          </span>
                        }
                      />
                    )}
                    {detail.sTypeVariation2 !== 'Aucun' && (
                      <KV
                        label={variationTypeLabel(detail.sTypeVariation2)}
                        value={
                          <span className="inline-flex items-center gap-1.5">
                            <Axis2Icon className="h-3.5 w-3.5 text-muted-foreground" />
                            {detail.variation2_label ?? '—'}
                          </span>
                        }
                      />
                    )}
                    {isEditing && (
                      <p className="text-[11px] text-muted-foreground italic">
                        La combinaison n’est pas modifiable : supprimez la ligne et recréez-la pour la déplacer.
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground italic">
                    Cette référence ne comporte aucune variation.
                  </p>
                )}
              </DrawerCard>

              {/* Valorisation */}
              <DrawerCard icon={<BadgeEuro className="h-4 w-4 text-accent" />} title="Valorisation">
                <div className="space-y-1.5">
                  <KV label="Prix unitaire" value={formatPrix(detail.prix)} mono />
                  <KV
                    label="Valeur de la ligne"
                    value={<span className="font-semibold tabular-nums">{formatPrix(detail.valeur)}</span>}
                  />
                  {detail.prix == null && (
                    <p className="text-[11px] text-muted-foreground italic">
                      Aucun tarif défini pour cette combinaison.
                    </p>
                  )}
                </div>
              </DrawerCard>

              {/* Reference-level context */}
              <DrawerCard icon={<Box className="h-4 w-4 text-accent" />} title="Référence">
                <div className="space-y-1.5">
                  <KV
                    label="Stock total"
                    value={
                      <span className="tabular-nums">
                        {fmtNum(detail.ref_stock_total, detail.ref_stock_total % 1 === 0 ? 0 : 2)}{' '}
                        {detail.ref_unite_label}
                      </span>
                    }
                  />
                  <KV
                    label="Combinaisons"
                    value={<span className="tabular-nums">{detail.ref_combinaisons}</span>}
                  />
                  {!!detail.ref_observations?.trim() && (
                    <div className="flex items-start gap-1.5 pt-1.5 border-t border-border/40 mt-1.5">
                      <FileText className="h-3 w-3 text-muted-foreground/50 flex-shrink-0 mt-0.5" />
                      <p className="text-[11px] text-muted-foreground italic whitespace-pre-line">
                        {detail.ref_observations.trim()}
                      </p>
                    </div>
                  )}
                </div>
              </DrawerCard>

              {/* Delete sits at the bottom of the body rather than in the header:
                  it is the way out of a combination that should not exist, not a
                  sibling of Annuler / Enregistrer — and the 440px header has no
                  room for a fourth control without truncating the title. */}
              {isEditing && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmDelete(true)}
                  className="w-full text-destructive hover:text-destructive hover:bg-destructive/5 border border-dashed border-destructive/30 hover:border-destructive/50"
                >
                  <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                  Supprimer la ligne de stock
                </Button>
              )}
            </>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Supprimer la ligne de stock"
        description={
          detail
            ? `${detail.ref_designation ?? 'Cette référence'} · ${combinationLabel(detail)} sera retirée du stock. Cette action est irréversible.`
            : undefined
        }
        isPending={deleteMutation.isPending}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => deleteMutation.mutate()}
      />
    </div>
  )
}

// ── Drawer card primitives ─────────────────────────────

function DrawerCard({
  icon,
  title,
  highlight,
  children,
}: {
  icon: React.ReactNode
  title: string
  highlight?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'rounded-lg border border-border/60 bg-card p-3 shadow-sm',
        highlight && 'border-l-4 border-l-accent/70 bg-accent/[0.03]',
      )}
    >
      <div className="flex items-center gap-2 mb-2">
        {icon}
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      {children}
    </div>
  )
}

function KV({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('text-sm text-right truncate', mono && 'tabular-nums')}>{value}</span>
    </div>
  )
}

// ── Create dialog ──────────────────────────────────────
// Mirrors the legacy "Ajouter" modal: pick a reference, then one value per
// active variation axis, then the quantity. Axes that the reference leaves at
// "Aucun" are not rendered at all — same as legacy.

function CreateStockDiversDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (newId: number | null) => void
}) {
  const [IDref_divers, setIDrefDivers] = useState(0)
  const [IDVariation1, setIDVariation1] = useState(0)
  const [IDVariation2, setIDVariation2] = useState(0)
  const [quantite, setQuantite] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refsQuery = useRefDiversLookup(open)
  const ref = useMemo(
    () => (refsQuery.data ?? []).find((r) => r.IDref_divers === IDref_divers) ?? null,
    [refsQuery.data, IDref_divers],
  )

  useEffect(() => {
    if (open) {
      setIDrefDivers(0)
      setIDVariation1(0)
      setIDVariation2(0)
      setQuantite('')
      setError(null)
    }
  }, [open])

  // Variation values belong to a reference — clear the picks when it changes.
  useEffect(() => {
    setIDVariation1(0)
    setIDVariation2(0)
  }, [IDref_divers])

  const axis1 = ref?.sTypeVariation1 ?? 'Aucun'
  const axis2 = ref?.sTypeVariation2 ?? 'Aucun'
  const parsedQuantite = useMemo(() => {
    const v = Number(quantite.replace(',', '.'))
    return Number.isFinite(v) ? v : NaN
  }, [quantite])

  const canSubmit =
    IDref_divers > 0 &&
    (axis1 === 'Aucun' || IDVariation1 > 0) &&
    (axis2 === 'Aucun' || IDVariation2 > 0) &&
    quantite.trim() !== '' &&
    !isNaN(parsedQuantite)

  const createMutation = useMutation({
    mutationFn: () =>
      apiMutate<{ IDstock_divers: number | null }>('/stock-divers', {
        method: 'POST',
        body: JSON.stringify({
          IDref_divers,
          IDVariation1: axis1 === 'Aucun' ? 0 : IDVariation1,
          IDVariation2: axis2 === 'Aucun' ? 0 : IDVariation2,
          quantite: parsedQuantite,
        }),
      }),
    onSuccess: (res) => onCreated(res?.IDstock_divers ?? null),
    onError: (err: Error) => setError(err.message || 'Erreur lors de la création'),
  })

  const inputClass =
    'w-full h-9 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90dvh] overflow-y-auto" onClose={() => onOpenChange(false)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Box className="h-5 w-5 text-accent" />
            Nouvelle ligne de stock
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
          <div className="col-span-full">
            <label className="text-xs text-muted-foreground mb-1 block">Référence *</label>
            <SearchableCombobox<RefDiversOption>
              options={refsQuery.data ?? []}
              value={IDref_divers}
              onChange={setIDrefDivers}
              getId={(r) => r.IDref_divers}
              getPrimary={(r) => r.designation ?? ''}
              getSecondary={(r) => r.unite_label || undefined}
              placeholder="Rechercher une référence"
              loading={refsQuery.isLoading}
            />
          </div>

          {axis1 !== 'Aucun' && (
            <div className="col-span-full">
              <label className="text-xs text-muted-foreground mb-1 block">{variationTypeLabel(axis1)} *</label>
              <PopoverSelect
                options={(ref?.variations1 ?? []).map((v) => ({ id: v.id, primary: v.designation }))}
                value={IDVariation1}
                onChange={setIDVariation1}
                emptyLabel={
                  (ref?.variations1 ?? []).length === 0 ? 'Aucune valeur définie' : '— Sélectionner —'
                }
              />
            </div>
          )}

          {axis2 !== 'Aucun' && (
            <div className="col-span-full">
              <label className="text-xs text-muted-foreground mb-1 block">{variationTypeLabel(axis2)} *</label>
              <PopoverSelect
                options={(ref?.variations2 ?? []).map((v) => ({ id: v.id, primary: v.designation }))}
                value={IDVariation2}
                onChange={setIDVariation2}
                emptyLabel={
                  (ref?.variations2 ?? []).length === 0 ? 'Aucune valeur définie' : '— Sélectionner —'
                }
              />
            </div>
          )}

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">
              Quantité{ref ? ` (${ref.unite_label})` : ''} *
            </label>
            <input
              type="number"
              step="any"
              value={quantite}
              onChange={(e) => setQuantite(e.target.value)}
              className={inputClass}
            />
          </div>
        </div>

        {ref && axis1 === 'Aucun' && axis2 === 'Aucun' && (
          <p className="mt-3 text-xs text-muted-foreground italic">
            Cette référence ne comporte aucune variation : elle n’a qu’une seule ligne de stock.
          </p>
        )}

        {error && (
          <div className="mt-3 flex items-start gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
            {error}
          </div>
        )}

        <DialogFooter className="mt-4 gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={createMutation.isPending}>
            Annuler
          </Button>
          <Button onClick={() => createMutation.mutate()} disabled={!canSubmit || createMutation.isPending}>
            {createMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5 mr-1.5" />
            )}
            Créer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
