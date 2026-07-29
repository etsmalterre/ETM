import { useState, useMemo, useCallback, useEffect, useRef, useTransition, useDeferredValue, memo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { UnsavedChangesDialog } from '@/components/shared/UnsavedChangesDialog'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import {
  Boxes,
  Search,
  Loader2,
  AlertCircle,
  Pencil,
  X,
  Check,
  Save,
  ArrowUp,
  ArrowDown,
  Factory,
  MapPin,
  Package,
  MessageSquare,
  ShieldAlert,
  UserCheck,
  Send,
  Scissors,
  Layers,
  Plus,
  Minus,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { FabricRollIcon } from '@/components/icons/FabricRollIcon'
import { BobineIcon } from '@/components/icons/BobineIcon'
import { KnitIcon } from '@/components/icons/KnitIcon'
import { cn } from '@/lib/utils'
import { formatHfsqlDate } from '@/lib/dates'
import { fmtNum } from '@/lib/format'
import { apiFetch } from '@/lib/api'
import { useHasPermission } from '@/contexts/PermissionsContext'
import { PopoverSelect, SearchableCombobox } from '@/components/ui/popover-select'
import { CardKV, MobileSortRow } from '@/components/stock/StockCardParts'

// ── Types ──────────────────────────────────────────────

interface DefautQualite {
  IDdefaut_qualite: number
  description: string | null
  type_defaut: string | null
  taille_cm: number | null
}

interface StockEcruRow {
  IDstock_ecru: number
  IDref_ecru: number | null
  IDcolori_ecru: number | null
  IDmagasin: number | null
  IDordre_fabrication: number | null
  IDref_commande_source: number | null
  IDref_commande_affectation: number | null
  IDligne_commande_client: number | null
  poids: number | null
  metrage: number | null
  lot: string | null
  numero: string | null
  observations: string | null
  visiteur: string | null
  second_choix: number | null
  date_saisie: string | null
  ref_ecru: string | null
  coloris_reference: string | null
  magasin_nom: string | null
  commande_numero: string | null
  client_nom: string | null
  defauts: string | null
  defects?: DefautQualite[]
}

interface MagasinOption {
  IDsous_traitant: number
  nom: string | null
}

// Provenance (supply-chain origins of one écru roll) — mirrors finis/stock.
interface ProvenanceFil {
  ref_fil: string | null
  fournisseur: string | null
  IDcommande_fil: number | null
}
interface SstOrigin {
  sst_nom: string | null
  IDcommande: number
}
interface StockEcruProvenance {
  // The tricoteur sst commande that knit this écru. (No "ennoblissement" step —
  // dyeing is the écru's destination, not its origin.)
  tricotage: SstOrigin | null
  // Yarns affected to that tricoteur line, with supplier + fil order N°.
  fils: ProvenanceFil[]
}

// Status filter codes — mapped to the API `statut` query param. Ids are 1-based
// because PopoverSelect treats id 0 as the "none" sentinel (shows emptyLabel).
type StatutCode = 1 | 2 | 3
const STATUT_PARAM: Record<StatutCode, string> = { 1: 'disponible', 2: 'teinture', 3: 'tous' }
const STATUT_OPTIONS = [
  { id: 1, primary: 'Disponible' },
  { id: 2, primary: 'En teinture' },
  { id: 3, primary: 'Tous' },
]

// ── API helpers ────────────────────────────────────────

function useStockEcruList(filters: { statut: StatutCode; secondChoix: boolean }) {
  const params = new URLSearchParams()
  params.set('statut', STATUT_PARAM[filters.statut])
  if (filters.secondChoix) params.set('second_choix', '1')
  const qs = params.toString()
  return useQuery<StockEcruRow[]>({
    queryKey: ['stock-ecru', filters],
    queryFn: () => apiFetch<StockEcruRow[]>(`/stock/ecru${qs ? `?${qs}` : ''}`),
  })
}

function useStockEcruDetail(id: number | null) {
  return useQuery<StockEcruRow>({
    queryKey: ['stock-ecru', 'detail', id],
    queryFn: () => apiFetch<StockEcruRow>(`/stock/ecru/${id}`),
    enabled: id !== null,
  })
}

function useMagasinsLookup(enabled: boolean) {
  return useQuery<MagasinOption[]>({
    queryKey: ['stock-ecru', 'lookups', 'magasins'],
    queryFn: () => apiFetch<MagasinOption[]>('/stock/ecru/lookups/magasins'),
    enabled,
  })
}

function useStockEcruProvenance(id: number | null) {
  return useQuery<StockEcruProvenance>({
    queryKey: ['stock-ecru', 'provenance', id],
    queryFn: () => apiFetch<StockEcruProvenance>(`/stock/ecru/${id}/provenance`),
    enabled: id !== null,
  })
}

// ── Helpers ────────────────────────────────────────────

function formatKg(v: number | null): string {
  if (v == null) return '—'
  return `${v.toFixed(1)} kg`
}

function formatMeters(v: number | null): string {
  if (v == null) return '—'
  return `${v.toFixed(1)} m`
}

// ── Sort handling ──────────────────────────────────────

type SortKey =
  | 'ref_ecru'
  | 'coloris_reference'
  | 'numero'
  | 'poids'
  | 'lot'
  | 'magasin_nom'
  | 'commande_numero'
  | 'client_nom'
  | 'date_saisie'
  | 'second_choix'
  | 'visiteur'
  | 'observations'
  | 'defauts'

interface SortState {
  key: SortKey
  dir: 'asc' | 'desc'
}

const COLUMNS: { key: SortKey; label: string; width: string; align?: 'left' | 'right' }[] = [
  { key: 'ref_ecru', label: 'Référence', width: '7%' },
  { key: 'coloris_reference', label: 'Coloris', width: '8%' },
  { key: 'numero', label: 'Numéro', width: '6%' },
  { key: 'poids', label: 'Poids', width: '5%', align: 'right' },
  { key: 'lot', label: 'Lot', width: '7%' },
  { key: 'magasin_nom', label: 'Magasin', width: '8%' },
  { key: 'commande_numero', label: 'N° Cmd', width: '5%' },
  { key: 'client_nom', label: 'Client', width: '10%' },
  { key: 'date_saisie', label: 'Date saisie', width: '7%' },
  { key: 'second_choix', label: '2ᵉ', width: '3%' },
  { key: 'visiteur', label: 'Visiteur', width: '8%' },
  { key: 'observations', label: 'Observations', width: '13%' },
  { key: 'defauts', label: 'Défauts', width: '13%' },
]
const SELECT_COL_WIDTH = '4%' // leading selection box column, edit mode only

const ROW_COLLATOR = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' })

function compareRows(a: StockEcruRow, b: StockEcruRow, key: SortKey): number {
  const va = a[key]
  const vb = b[key]
  if (va == null && vb == null) return 0
  if (va == null) return 1
  if (vb == null) return -1
  if (typeof va === 'number' && typeof vb === 'number') return va - vb
  return ROW_COLLATOR.compare(String(va), String(vb))
}

// ── Main Page ──────────────────────────────────────────

export function TombeMetierStock() {
  const queryClient = useQueryClient()
  const [searchQuery, setSearchQuery] = useState('')
  const [statut, setStatut] = useState<StatutCode>(1)
  const [secondChoix, setSecondChoix] = useState(false)
  const [sort, setSort] = useState<SortState>({ key: 'date_saisie', dir: 'desc' })
  const [selectedId, setSelectedId] = useState<number | null>(null)

  // Permission gates — admins always pass; the API enforces the same keys.
  const canCut = useHasPermission('cut_stock_ecru')
  const canCreate = useHasPermission('create_stock_ecru')
  const canEdit = useHasPermission('edit_stock_ecru')
  const [createOpen, setCreateOpen] = useState(false)

  // Edit mode — multi-roll selection.
  const [isEditing, setIsEditing] = useState(false)
  const [selectedRollIds, setSelectedRollIds] = useState<Set<number>>(new Set())
  const lastSelectedRollIdRef = useRef<number | null>(null)
  const [cutOpen, setCutOpen] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)
  const [, startModeTransition] = useTransition()

  const { data: rows, isLoading, isError, error } = useStockEcruList({ statut, secondChoix })

  const deferredSearch = useDeferredValue(searchQuery)

  const filteredSorted = useMemo(() => {
    let out = rows ?? []
    const terms = deferredSearch.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length > 0) {
      out = out.filter((r) => {
        const haystacks = [
          r.ref_ecru,
          r.coloris_reference,
          r.lot,
          r.numero,
          r.magasin_nom,
          r.commande_numero,
          r.client_nom,
          r.visiteur,
          r.observations,
          r.defauts,
        ]
          .filter((f): f is string => !!f)
          .map((f) => f.toLowerCase())
        return terms.every((t) => haystacks.some((h) => h.includes(t)))
      })
    }
    out = [...out].sort((a, b) => {
      const cmp = compareRows(a, b, sort.key)
      return sort.dir === 'asc' ? cmp : -cmp
    })
    return out
  }, [rows, deferredSearch, sort])

  const handleSort = useCallback((key: SortKey) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
  }, [])

  // Drawer dirty tracking — populated by the drawer via refs.
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

  const handleSelectRoll = useCallback((id: number, shiftKey: boolean) => {
    const ids = filteredSorted.map((r) => r.IDstock_ecru)
    const anchor = lastSelectedRollIdRef.current
    if (shiftKey && anchor !== null && anchor !== id) {
      const a = ids.indexOf(anchor)
      const b = ids.indexOf(id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setSelectedRollIds((prev) => {
          const next = new Set(prev)
          const deselect = prev.has(id)
          for (let i = lo; i <= hi; i++) {
            if (deselect) next.delete(ids[i])
            else next.add(ids[i])
          }
          return next
        })
        return
      }
    }
    setSelectedRollIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    lastSelectedRollIdRef.current = id
  }, [filteredSorted])

  const isEditingRef = useRef(isEditing)
  isEditingRef.current = isEditing
  const onRowClick = useCallback(
    (id: number, shiftKey: boolean) => {
      if (isEditingRef.current) handleSelectRoll(id, shiftKey)
      else handleRowClick(id)
    },
    [handleSelectRoll, handleRowClick],
  )

  const enterEditMode = useCallback(() => {
    guard.guardAction(() => {
      setSelectedId(null)
      startModeTransition(() => setIsEditing(true))
    })
  }, [guard])

  const exitEditMode = useCallback(() => {
    lastSelectedRollIdRef.current = null
    startModeTransition(() => {
      setIsEditing(false)
      setSelectedRollIds(new Set())
    })
  }, [])

  const onMutationSuccess = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['stock-ecru'] })
  }, [queryClient])

  // The single selected roll (only when exactly one is selected) — drives the
  // "Couper" button + cut dialog.
  const selectedRow =
    selectedRollIds.size === 1
      ? filteredSorted.find((r) => r.IDstock_ecru === [...selectedRollIds][0]) ?? null
      : null

  // Totalizer over the currently-visible (filtered) rows.
  const rollCount = filteredSorted.length
  const totalPoids = filteredSorted.reduce((sum, r) => sum + (r.poids ?? 0), 0)

  // Selection summary (edit mode).
  const selectedRows = isEditing
    ? filteredSorted.filter((r) => selectedRollIds.has(r.IDstock_ecru))
    : []
  const selCount = selectedRows.length
  const selPoids = selectedRows.reduce((sum, r) => sum + (r.poids ?? 0), 0)

  return (
    <div className="h-full flex flex-col gap-3 min-h-0">
      {/* Toolbar — below sm: search + actions share row 1 (actions stay top-right),
          badge, statut filter and checkbox wrap below. Desktop order/pixels unchanged. */}
      <div className="flex-shrink-0 flex flex-wrap items-center gap-3">
        {/* Badge wrapper takes the full row below sm so it doesn't crush the search */}
        {isEditing && (
          <div className="order-3 sm:order-1 w-full sm:w-auto flex-shrink-0">
            <Badge className="bg-accent text-accent-foreground gap-1 shadow-sm">
              <Pencil className="h-3 w-3" />
              Mode édition
            </Badge>
          </div>
        )}
        <div className="relative order-1 sm:order-2 flex-1 min-w-0">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Rechercher (réf, coloris, lot, numéro, magasin, client, visiteur, observations…)"
            className="h-9 w-full pl-8 pr-3 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {/* Below sm this wrapper is a full-width row of its own, so the statut
            select + checkbox can NEVER share row 1 and push the action buttons
            off the top-right corner. At sm+ display:contents dissolves the
            wrapper — both children join the toolbar flex directly with their
            own sm:order, keeping desktop pixels identical. */}
        <div className="order-4 w-full flex items-center gap-3 sm:contents">
          <div className="w-40 flex-shrink-0 sm:order-3">
            <PopoverSelect
              options={STATUT_OPTIONS}
              value={statut}
              onChange={(v) => setStatut(v as StatutCode)}
              hideEmpty
            />
          </div>

          <label className="flex items-center gap-2 text-sm cursor-pointer select-none flex-shrink-0 sm:order-4">
            <input
              type="checkbox"
              checked={secondChoix}
              onChange={(e) => setSecondChoix(e.target.checked)}
              className="h-4 w-4 rounded border-input text-accent focus:ring-2 focus:ring-ring cursor-pointer"
            />
            <span>2ᵉ choix</span>
          </label>
        </div>

        {!isEditing ? (
          <div className="flex items-center gap-2 flex-shrink-0 order-2 sm:order-5">
            {canCreate && (
              <Button size="sm" onClick={() => setCreateOpen(true)} title="Nouveau">
                <Plus className="h-3.5 w-3.5 sm:mr-1" />
                <span className="hidden sm:inline">Nouveau</span>
              </Button>
            )}
            {/* Edit mode is the gateway to batch-edit (edit perm) AND cut (cut
                perm) — show it if the user can do either; hide it entirely if
                they can do neither. */}
            {(canEdit || canCut) && (
              <Button variant="gold" size="sm" onClick={enterEditMode} title="Modifier">
                <Pencil className="h-3.5 w-3.5 sm:mr-1.5" />
                <span className="hidden sm:inline">Modifier</span>
              </Button>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-shrink-0 order-2 sm:order-5">
            {canCut && selectedRollIds.size === 1 && (
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 flex-shrink-0"
                title="Couper le rouleau"
                onClick={() => setCutOpen(true)}
              >
                <Scissors className="h-4 w-4" />
              </Button>
            )}
            {canEdit && selectedRollIds.size > 1 && (
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 flex-shrink-0"
                title="Édition groupée"
                onClick={() => setBatchOpen(true)}
              >
                <Pencil className="h-4 w-4" />
              </Button>
            )}
            <Button size="sm" onClick={exitEditMode} title="Terminer">
              <X className="h-3.5 w-3.5 sm:mr-1.5" />
              <span className="hidden sm:inline">Terminer</span>
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
            <p className="text-sm">Aucun rouleau en stock</p>
          </div>
        ) : (
          <>
            {/* Desktop table (md+) — split header/body sharing one colgroup */}
            <div className="hidden md:flex md:flex-col flex-1 min-h-0">
            {/* Header table (non-scrolling) */}
            <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: isEditing ? SELECT_COL_WIDTH : '0' }} />
                {COLUMNS.map((c) => (
                  <col key={c.key} style={{ width: c.width }} />
                ))}
              </colgroup>
              <thead className="bg-zinc-200/60 border-b border-border/60">
                <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                  <th className={isEditing ? 'px-2 py-2.5' : 'p-0'}></th>
                  {COLUMNS.map((c) => (
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

            {/* Body table (scrolling) */}
            <div className="flex-1 min-h-0 overflow-auto scrollbar-transparent">
              <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
                <colgroup>
                  <col style={{ width: isEditing ? SELECT_COL_WIDTH : '0' }} />
                  {COLUMNS.map((c) => (
                    <col key={c.key} style={{ width: c.width }} />
                  ))}
                </colgroup>
                <tbody className="group" data-editing={isEditing ? 'true' : 'false'}>
                  {filteredSorted.map((r) => (
                    <StockRow
                      key={r.IDstock_ecru}
                      row={r}
                      selected={
                        isEditing ? selectedRollIds.has(r.IDstock_ecru) : r.IDstock_ecru === selectedId
                      }
                      onRowClick={onRowClick}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            </div>

            {/* Mobile card list (< md) — same rows, selection, sort and edit-mode
                state as the table. data-editing drives the card checkboxes via CSS
                (same trick as the tbody) so toggling edit mode re-renders no card. */}
            <div className="md:hidden flex-1 min-h-0 flex flex-col">
              <MobileSortRow columns={COLUMNS} sort={sort} onSortChange={setSort} />
              <div
                className="group flex-1 min-h-0 overflow-y-auto scrollbar-transparent p-2 space-y-2 bg-zinc-100/80"
                data-editing={isEditing ? 'true' : 'false'}
              >
                {filteredSorted.map((r) => (
                  <StockEcruCard
                    key={r.IDstock_ecru}
                    row={r}
                    selected={
                      isEditing ? selectedRollIds.has(r.IDstock_ecru) : r.IDstock_ecru === selectedId
                    }
                    onRowClick={onRowClick}
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Totalizer — standalone summary bar, detached from the table.
          Below sm the "Poids total" label disappears (the kg unit is
          self-explanatory) and the value shrinks one step so the whole bar
          stays on ONE line even at 345px. The edit-mode selection summary gets
          its own row. Desktop (sm+) unchanged. */}
      {!isLoading && !isError && filteredSorted.length > 0 && (
        <div className="flex-shrink-0 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-zinc-100/80 shadow-sm px-4 py-2.5">
          <div className={cn('flex flex-wrap items-center gap-2 text-sm', selCount > 0 && 'w-full sm:w-auto')}>
            <Package className="h-4 w-4 text-accent" />
            <span className="font-semibold">{rollCount}</span>
            <span className="text-muted-foreground">pièce{rollCount > 1 ? 's' : ''}</span>
            {selCount > 0 && (
              <span className="w-full sm:w-auto sm:ml-3 sm:pl-3 sm:border-l border-border/60 flex flex-wrap items-center gap-1.5 text-accent">
                <Check className="h-3.5 w-3.5" />
                <span className="font-semibold tabular-nums">{selCount}</span>
                <span>sélectionnée{selCount > 1 ? 's' : ''}</span>
                <span className="text-muted-foreground/50">·</span>
                <span className="font-medium tabular-nums">{fmtNum(selPoids, 1)} kg</span>
              </span>
            )}
          </div>
          <div className="flex items-baseline gap-1.5 sm:gap-2">
            <span className="hidden sm:inline text-xs uppercase tracking-wide text-muted-foreground whitespace-nowrap">Poids total</span>
            <span className="text-sm sm:text-base font-bold tabular-nums whitespace-nowrap">{fmtNum(totalPoids, 1)} kg</span>
          </div>
        </div>
      )}

      <StockEcruDrawer
        id={selectedId}
        onClose={handleClose}
        onMutationSuccess={onMutationSuccess}
        onDirtyChange={setDrawerDirty}
        saveRef={drawerSaveRef}
        discardRef={drawerDiscardRef}
      />

      <UnsavedChangesDialog
        open={guard.showDialog}
        onAction={guard.handleAction}
        isSaving={guard.isSaving}
      />

      <CutRollDialog
        open={cutOpen}
        row={selectedRow}
        onClose={() => setCutOpen(false)}
        onSuccess={() => {
          onMutationSuccess()
          setCutOpen(false)
          setSelectedRollIds(new Set())
          lastSelectedRollIdRef.current = null
        }}
      />

      <BatchEditDialog
        open={batchOpen}
        ids={[...selectedRollIds]}
        onClose={() => setBatchOpen(false)}
        onSuccess={() => {
          onMutationSuccess()
          setBatchOpen(false)
          setSelectedRollIds(new Set())
          lastSelectedRollIdRef.current = null
        }}
      />

      <CreateEcruRollDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(newId) => {
          setCreateOpen(false)
          onMutationSuccess()
          if (newId && newId > 0) setSelectedId(newId)
        }}
      />
    </div>
  )
}

// ── Cut-roll dialog ────────────────────────────────────
// Split one physical écru roll into N rolls. Pieces 1..N-1 are editable; the
// LAST piece is auto-computed as the remainder so the weight & length totals
// always equal the original. Piece 1 keeps the original numero; the others
// preview as "<base>-2", "<base>-3", …

interface CutPieceDraft {
  poids: string
  metrage: string
}

function CutRollDialog({
  open,
  row,
  onClose,
  onSuccess,
}: {
  open: boolean
  row: StockEcruRow | null
  onClose: () => void
  onSuccess: () => void
}) {
  const [editable, setEditable] = useState<CutPieceDraft[]>([{ poids: '', metrage: '' }])

  const origId = row?.IDstock_ecru ?? null
  useEffect(() => {
    if (open) setEditable([{ poids: '', metrage: '' }])
  }, [open, origId])

  const origPoids = Number(row?.poids) || 0
  const origMetrage = Number(row?.metrage) || 0
  // Écru rolls are tracked by weight; metrage is usually 0, so only surface the
  // metrage column when the original roll actually carries a length.
  const hasMetrage = origMetrage > 0
  const base = ((row?.numero ?? '').trim() || (origId != null ? `#${origId}` : '')).slice(0, 18)

  const num = (s: string) => {
    const v = Number(String(s).replace(',', '.'))
    return Number.isFinite(v) ? v : 0
  }
  const sumEditPoids = editable.reduce((s, p) => s + num(p.poids), 0)
  const sumEditMetrage = editable.reduce((s, p) => s + num(p.metrage), 0)
  const lastPoids = origPoids - sumEditPoids
  const lastMetrage = origMetrage - sumEditMetrage

  const negative = lastPoids < -0.0001 || lastMetrage < -0.0001
  const valid = !negative && editable.every((p) => p.poids.trim() !== '' && (!hasMetrage || p.metrage.trim() !== ''))

  const cutMutation = useMutation({
    mutationFn: () => {
      const pieces = [
        ...editable.map((p) => ({ poids: num(p.poids), metrage: hasMetrage ? num(p.metrage) : 0 })),
        { poids: Math.max(0, lastPoids), metrage: hasMetrage ? Math.max(0, lastMetrage) : 0 },
      ]
      return apiFetch(`/stock/ecru/${origId}/cut`, {
        method: 'POST',
        body: JSON.stringify({ pieces }),
      })
    },
    onSuccess: () => onSuccess(),
  })

  const pieceLabel = (idx: number) => (idx === 0 ? row?.numero || base : `${base}-${idx + 1}`)
  const totalPieces = editable.length + 1

  // Cross-multiplication (règle de trois): a cut preserves the roll's linear
  // density, so poids and metrage stay proportional when metrage is tracked.
  const round2 = (v: number) => Math.round(v * 100) / 100
  const mPerKg = origPoids > 0 ? origMetrage / origPoids : 0
  const kgPerM = origMetrage > 0 ? origPoids / origMetrage : 0

  const setPoids = (idx: number, value: string) =>
    setEditable((prev) =>
      prev.map((p, i) => {
        if (i !== idx) return p
        if (value.trim() === '') return { poids: '', metrage: hasMetrage ? '' : p.metrage }
        const metrage = hasMetrage ? String(round2(num(value) * mPerKg)) : p.metrage
        return { poids: value, metrage }
      }),
    )
  const setMetrage = (idx: number, value: string) =>
    setEditable((prev) =>
      prev.map((p, i) => {
        if (i !== idx) return p
        if (value.trim() === '') return { metrage: '', poids: origMetrage > 0 ? '' : p.poids }
        const poids = origMetrage > 0 ? String(round2(num(value) * kgPerM)) : p.poids
        return { metrage: value, poids }
      }),
    )
  const addPiece = () =>
    setEditable((prev) => (prev.length + 1 < 10 ? [...prev, { poids: '', metrage: '' }] : prev))
  const removePiece = (idx: number) =>
    setEditable((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev))

  const gridCols = hasMetrage ? 'grid-cols-[1fr_auto_auto_auto]' : 'grid-cols-[1fr_auto_auto]'

  return (
    <Dialog open={open && !!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90dvh] overflow-y-auto" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scissors className="h-5 w-5 text-accent" />
            Couper le rouleau{row?.numero ? ` ${row.numero}` : ''}
          </DialogTitle>
        </DialogHeader>

        <div className="mt-4 space-y-3">
          {/* Original summary */}
          <div className="rounded-lg border border-border/60 bg-zinc-100/80 px-3 py-2 text-sm">
            <div className="font-medium truncate">
              {row?.ref_ecru ?? '—'}
              {row?.coloris_reference ? ` · ${row.coloris_reference}` : ''}
            </div>
            <div className="text-xs text-muted-foreground tabular-nums mt-0.5">
              Original : {fmtNum(origPoids, 1)} kg{hasMetrage ? ` · ${fmtNum(origMetrage, 1)} m` : ''}
            </div>
          </div>

          {/* Piece rows */}
          <div className="space-y-2">
            <div className={cn('grid items-center gap-2 px-1 text-[10px] uppercase tracking-wide text-muted-foreground font-semibold', gridCols)}>
              <span>Numéro</span>
              <span className="w-24 text-right">Poids (kg)</span>
              {hasMetrage && <span className="w-24 text-right">Métrage (m)</span>}
              <span className="w-6" />
            </div>

            {editable.map((p, idx) => (
              <div key={idx} className={cn('grid items-center gap-2', gridCols)}>
                <span className="text-sm tabular-nums truncate">{pieceLabel(idx)}</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={p.poids}
                  onChange={(e) => setPoids(idx, e.target.value)}
                  className="h-8 w-24 px-2 text-sm text-right rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
                />
                {hasMetrage && (
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    value={p.metrage}
                    onChange={(e) => setMetrage(idx, e.target.value)}
                    className="h-8 w-24 px-2 text-sm text-right rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-muted-foreground hover:text-destructive"
                  title="Retirer ce morceau"
                  disabled={editable.length <= 1}
                  onClick={() => removePiece(idx)}
                >
                  <Minus className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}

            {/* Auto-balanced last piece */}
            <div className={cn('grid items-center gap-2', gridCols)}>
              <span className="text-sm tabular-nums truncate text-muted-foreground">
                {pieceLabel(editable.length)}
                <span className="ml-1.5 text-[10px] uppercase tracking-wide">auto</span>
              </span>
              <span
                className={cn(
                  'h-8 w-24 px-2 inline-flex items-center justify-end text-sm tabular-nums rounded-md border bg-zinc-100/60',
                  lastPoids < -0.0001 ? 'border-destructive text-destructive' : 'border-border/60 text-muted-foreground',
                )}
              >
                {fmtNum(lastPoids, 1)}
              </span>
              {hasMetrage && (
                <span
                  className={cn(
                    'h-8 w-24 px-2 inline-flex items-center justify-end text-sm tabular-nums rounded-md border bg-zinc-100/60',
                    lastMetrage < -0.0001 ? 'border-destructive text-destructive' : 'border-border/60 text-muted-foreground',
                  )}
                >
                  {fmtNum(lastMetrage, 1)}
                </span>
              )}
              <span className="w-6" />
            </div>
          </div>

          {/* Add piece + totals */}
          <div className="flex items-center justify-between pt-1">
            <Button
              variant="ghost"
              size="sm"
              className="text-accent hover:text-accent hover:bg-accent/10"
              disabled={totalPieces >= 10}
              onClick={addPiece}
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              Ajouter un morceau
            </Button>
            <div className="text-xs text-muted-foreground tabular-nums flex items-center gap-1.5">
              {negative ? (
                <span className="text-destructive font-medium">Le dernier morceau serait négatif</span>
              ) : (
                <>
                  <Check className="h-3.5 w-3.5 text-success" />
                  {totalPieces} morceaux · {fmtNum(origPoids, 1)} kg
                </>
              )}
            </div>
          </div>

          {cutMutation.isError && (
            <p className="text-sm text-destructive mt-3">
              {(cutMutation.error as Error)?.message || 'Erreur lors de la découpe'}
            </p>
          )}
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose} disabled={cutMutation.isPending}>
            Annuler
          </Button>
          <Button onClick={() => cutMutation.mutate()} disabled={!valid || cutMutation.isPending}>
            {cutMutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <Scissors className="h-4 w-4 mr-1.5" />
            )}
            Couper
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Batch edit dialog ──────────────────────────────────
// "Édition groupée": apply observations / visiteur / magasin / 2ᵉ choix to every
// selected roll at once. Each field is gated by a toggle — only enabled fields
// are written (an enabled-but-empty text field clears the value).

function SwitchPill({
  value,
  onChange,
  disabled,
}: {
  value: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={cn(
        'relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        value ? 'bg-accent shadow-inner' : 'bg-zinc-300 hover:bg-zinc-400/80',
      )}
    >
      <span
        className={cn(
          'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ease-out',
          value ? 'translate-x-[18px]' : 'translate-x-0.5',
        )}
      />
    </button>
  )
}

function BatchEditDialog({
  open,
  ids,
  onClose,
  onSuccess,
}: {
  open: boolean
  ids: number[]
  onClose: () => void
  onSuccess: () => void
}) {
  const [editObservations, setEditObservations] = useState(false)
  const [observations, setObservations] = useState('')
  const [editVisiteur, setEditVisiteur] = useState(false)
  const [visiteur, setVisiteur] = useState('')
  const [editMagasin, setEditMagasin] = useState(false)
  const [IDmagasin, setIDmagasin] = useState(0)
  const [editSecondChoix, setEditSecondChoix] = useState(false)
  const [secondChoixValue, setSecondChoixValue] = useState(false)

  const magasinsQuery = useMagasinsLookup(open)
  const count = ids.length

  useEffect(() => {
    if (open) {
      setEditObservations(false)
      setObservations('')
      setEditVisiteur(false)
      setVisiteur('')
      setEditMagasin(false)
      setIDmagasin(0)
      setEditSecondChoix(false)
      setSecondChoixValue(false)
    }
  }, [open])

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch('/stock/ecru/batch', {
        method: 'PATCH',
        body: JSON.stringify({
          ids,
          ...(editObservations ? { observations } : {}),
          ...(editVisiteur ? { visiteur } : {}),
          ...(editMagasin ? { IDmagasin } : {}),
          ...(editSecondChoix ? { second_choix: secondChoixValue } : {}),
        }),
      }),
    onSuccess: () => onSuccess(),
  })

  const valid = (editObservations || editVisiteur || editMagasin || editSecondChoix) && count > 0

  return (
    <Dialog open={open && count > 0} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md max-h-[90dvh] overflow-y-auto" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-accent" />
            Édition groupée
          </DialogTitle>
        </DialogHeader>

        <div className="mt-4 space-y-3">
          <div className="rounded-lg border border-border/60 bg-zinc-100/80 px-3 py-2 text-sm flex items-center gap-2">
            <Check className="h-4 w-4 text-accent" />
            <span className="font-semibold tabular-nums">{count}</span>
            <span className="text-muted-foreground">
              pièce{count > 1 ? 's' : ''} sélectionnée{count > 1 ? 's' : ''}
            </span>
          </div>

          <p className="text-xs text-muted-foreground">
            Activez un champ pour l'appliquer à toutes les pièces sélectionnées. Un champ activé
            mais vide efface la valeur existante.
          </p>

          {/* Visiteur */}
          <div className={cn('rounded-lg border p-3', editVisiteur ? 'border-l-4 border-l-accent/70 bg-accent/[0.03]' : 'border-border/60')}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <UserCheck className="h-3.5 w-3.5 text-accent" />
                Visiteur
              </div>
              <SwitchPill value={editVisiteur} onChange={setEditVisiteur} />
            </div>
            {editVisiteur && (
              <input
                type="text"
                value={visiteur}
                onChange={(e) => setVisiteur(e.target.value)}
                placeholder="Nom du visiteur"
                className="mt-2 h-8 w-full px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
              />
            )}
          </div>

          {/* Magasin */}
          <div className={cn('rounded-lg border p-3', editMagasin ? 'border-l-4 border-l-accent/70 bg-accent/[0.03]' : 'border-border/60')}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <MapPin className="h-3.5 w-3.5 text-accent" />
                Magasin
              </div>
              <SwitchPill value={editMagasin} onChange={setEditMagasin} />
            </div>
            {editMagasin && (
              <div className="mt-2">
                <SearchableCombobox<MagasinOption>
                  options={magasinsQuery.data ?? []}
                  value={IDmagasin}
                  onChange={setIDmagasin}
                  getId={(m) => m.IDsous_traitant}
                  getPrimary={(m) => m.nom ?? ''}
                  placeholder="Rechercher un magasin"
                  loading={magasinsQuery.isLoading}
                />
              </div>
            )}
          </div>

          {/* Observation */}
          <div className={cn('rounded-lg border p-3', editObservations ? 'border-l-4 border-l-accent/70 bg-accent/[0.03]' : 'border-border/60')}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <MessageSquare className="h-3.5 w-3.5 text-accent" />
                Observation
              </div>
              <SwitchPill value={editObservations} onChange={setEditObservations} />
            </div>
            {editObservations && (
              <textarea
                rows={3}
                value={observations}
                onChange={(e) => setObservations(e.target.value)}
                placeholder="Nouvelle observation"
                className="mt-2 w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
              />
            )}
          </div>

          {/* 2ᵉ choix */}
          <div className={cn('rounded-lg border p-3', editSecondChoix ? 'border-l-4 border-l-accent/70 bg-accent/[0.03]' : 'border-border/60')}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <ShieldAlert className="h-3.5 w-3.5 text-accent" />
                2ᵉ choix
              </div>
              <SwitchPill value={editSecondChoix} onChange={setEditSecondChoix} />
            </div>
            {editSecondChoix && (
              <label className="mt-2 flex items-center gap-2 text-sm cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={secondChoixValue}
                  onChange={(e) => setSecondChoixValue(e.target.checked)}
                  className="h-4 w-4 rounded border-input text-accent focus:ring-2 focus:ring-ring cursor-pointer"
                />
                <span>Marquer comme 2ᵉ choix</span>
              </label>
            )}
          </div>

          {mutation.isError && (
            <p className="text-sm text-destructive">
              {(mutation.error as Error)?.message || "Erreur lors de l'enregistrement"}
            </p>
          )}
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
            Annuler
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={!valid || mutation.isPending}>
            {mutation.isPending ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-1.5" />
            )}
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Create écru-roll dialog ────────────────────────────
// Manually register a new physical écru roll (Tombé Métier > Stock "Nouveau",
// gated by create_stock_ecru). Référence + Coloris + Poids are required.

interface RefEcruOption {
  IDref_ecru: number
  reference: string | null
  designation: string | null
}
interface ColorisOption {
  id: number
  reference: string | null
}

function CreateEcruRollDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (newId: number | null) => void
}) {
  const [IDref_ecru, setIDrefEcru] = useState(0)
  const [IDcolori_ecru, setIDcoloriEcru] = useState(0)
  const [lot, setLot] = useState('')
  const [numero, setNumero] = useState('')
  const [poids, setPoids] = useState('')
  const [IDmagasin, setIDmagasin] = useState(0)
  const [visiteur, setVisiteur] = useState('')
  const [secondChoix, setSecondChoix] = useState(false)
  const [observations, setObservations] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refsQuery = useQuery<RefEcruOption[]>({
    queryKey: ['stock-ecru', 'lookups', 'refs'],
    queryFn: () => apiFetch<RefEcruOption[]>('/stock/ecru/lookups/refs'),
    enabled: open,
  })
  const colorisQuery = useQuery<ColorisOption[]>({
    queryKey: ['stock-ecru', 'lookups', 'coloris', IDref_ecru],
    queryFn: () => apiFetch<ColorisOption[]>(`/stock/ecru/lookups/coloris?ref_ecru=${IDref_ecru}`),
    enabled: open && IDref_ecru > 0,
  })
  const magasinsQuery = useMagasinsLookup(open)

  useEffect(() => {
    if (open) {
      setIDrefEcru(0)
      setIDcoloriEcru(0)
      setLot('')
      setNumero('')
      setPoids('')
      setIDmagasin(0)
      setVisiteur('')
      setSecondChoix(false)
      setObservations('')
      setError(null)
    }
  }, [open])

  // Coloris belongs to a ref — clear the pick when the ref changes.
  useEffect(() => { setIDcoloriEcru(0) }, [IDref_ecru])

  const num = (s: string) => {
    const v = Number(String(s).replace(',', '.'))
    return Number.isFinite(v) ? v : NaN
  }
  const canSubmit =
    IDref_ecru > 0 && IDcolori_ecru > 0 && poids.trim() !== '' && !isNaN(num(poids)) && num(poids) >= 0

  const createMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ IDstock_ecru: number | null }>('/stock/ecru', {
        method: 'POST',
        body: JSON.stringify({
          IDref_ecru,
          IDcolori_ecru,
          lot,
          numero,
          poids: num(poids),
          IDmagasin,
          visiteur,
          second_choix: secondChoix,
          observations,
        }),
      }),
    onSuccess: (res) => onCreated(res?.IDstock_ecru ?? null),
    onError: (err: Error) => setError(err.message || 'Erreur lors de la création'),
  })

  const inputClass =
    'w-full h-9 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90dvh] overflow-y-auto" onClose={() => onOpenChange(false)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FabricRollIcon className="h-5 w-5 text-accent" />
            Nouveau rouleau écru
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
          <div className="col-span-full">
            <label className="text-xs text-muted-foreground mb-1 block">Référence *</label>
            <SearchableCombobox<RefEcruOption>
              options={refsQuery.data ?? []}
              value={IDref_ecru}
              onChange={setIDrefEcru}
              getId={(r) => r.IDref_ecru}
              getPrimary={(r) => r.reference ?? ''}
              getSecondary={(r) => r.designation ?? undefined}
              placeholder="Rechercher une référence"
              loading={refsQuery.isLoading}
            />
          </div>

          <div className="col-span-full">
            <label className="text-xs text-muted-foreground mb-1 block">Coloris *</label>
            <PopoverSelect
              options={(colorisQuery.data ?? []).map((c) => ({ id: c.id, primary: c.reference ?? '' }))}
              value={IDcolori_ecru}
              onChange={setIDcoloriEcru}
              disabled={IDref_ecru === 0}
              emptyLabel={
                IDref_ecru === 0
                  ? '— Choisir une référence —'
                  : colorisQuery.isLoading
                    ? 'Chargement…'
                    : (colorisQuery.data ?? []).length === 0
                      ? 'Aucun coloris'
                      : '— Sélectionner —'
              }
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Lot</label>
            <input type="text" value={lot} onChange={(e) => setLot(e.target.value)} className={inputClass} />
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Numéro</label>
            <input type="text" value={numero} onChange={(e) => setNumero(e.target.value)} className={inputClass} />
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Poids (kg) *</label>
            <input
              type="number"
              step="0.1"
              min="0"
              value={poids}
              onChange={(e) => setPoids(e.target.value)}
              className={inputClass}
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Magasin</label>
            <SearchableCombobox<MagasinOption>
              options={magasinsQuery.data ?? []}
              value={IDmagasin}
              onChange={setIDmagasin}
              getId={(m) => m.IDsous_traitant}
              getPrimary={(m) => m.nom ?? ''}
              placeholder="Rechercher un magasin"
              loading={magasinsQuery.isLoading}
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Visiteur</label>
            <input type="text" value={visiteur} onChange={(e) => setVisiteur(e.target.value)} className={inputClass} />
          </div>

          <div className="flex items-end pb-1.5">
            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input
                type="checkbox"
                checked={secondChoix}
                onChange={(e) => setSecondChoix(e.target.checked)}
                className="h-4 w-4 rounded border-input text-accent focus:ring-2 focus:ring-ring cursor-pointer"
              />
              <span>2ᵉ choix</span>
            </label>
          </div>

          <div className="col-span-full">
            <label className="text-xs text-muted-foreground mb-1 block">Observations</label>
            <textarea
              value={observations}
              onChange={(e) => setObservations(e.target.value)}
              rows={2}
              className="w-full px-2.5 py-1.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring resize-none"
            />
          </div>
        </div>

        {error && (
          <div className="mt-3 flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4" />
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

// ── Table row (memoized) ──────────────────────────────

const StockRow = memo(function StockRow({
  row,
  selected,
  onRowClick,
}: {
  row: StockEcruRow
  selected: boolean
  onRowClick: (id: number, shiftKey: boolean) => void
}) {
  return (
    <tr
      data-stock-row
      onClick={(e) => onRowClick(row.IDstock_ecru, e.shiftKey)}
      className={cn(
        'border-b border-border/40 cursor-pointer transition-colors group-data-[editing=true]:select-none',
        selected ? 'bg-accent/10' : 'hover:bg-accent/5',
      )}
    >
      <td className="p-0 group-data-[editing=true]:px-2 group-data-[editing=true]:py-2">
        <div
          className={cn(
            'h-5 w-5 rounded border items-center justify-center transition-colors hidden group-data-[editing=true]:flex',
            selected ? 'bg-accent border-accent text-accent-foreground' : 'bg-white border-input',
          )}
        >
          {selected && <Check className="h-3.5 w-3.5" />}
        </div>
      </td>
      <td className="px-2 py-2 font-medium truncate">{row.ref_ecru ?? '—'}</td>
      <td className="px-2 py-2 truncate">{row.coloris_reference ?? '—'}</td>
      <td className="px-2 py-2 tabular-nums truncate text-muted-foreground">{row.numero ?? '—'}</td>
      <td className="px-2 py-2 text-right tabular-nums font-medium">{formatKg(row.poids)}</td>
      <td className="px-2 py-2 tabular-nums truncate">{row.lot ?? '—'}</td>
      <td className="px-2 py-2 truncate text-muted-foreground">{row.magasin_nom ?? '—'}</td>
      <td className="px-2 py-2 tabular-nums truncate text-muted-foreground">{row.commande_numero ?? '—'}</td>
      <td className="px-2 py-2 truncate">{row.client_nom ?? '—'}</td>
      <td className="px-2 py-2 tabular-nums text-muted-foreground">
        {row.date_saisie ? formatHfsqlDate(row.date_saisie) : '—'}
      </td>
      <td className="px-2 py-2">
        {!!row.second_choix && (
          <Badge variant="outline" className="text-[10px] py-0 border-red-300 text-red-700">2ᵉ</Badge>
        )}
      </td>
      <td className="px-2 py-2 truncate text-muted-foreground" title={row.visiteur ?? undefined}>
        {row.visiteur?.trim() || '—'}
      </td>
      <td className="px-2 py-2 text-muted-foreground truncate" title={row.observations ?? undefined}>
        {row.observations?.trim() || ''}
      </td>
      <td className="px-2 py-2 text-muted-foreground truncate" title={row.defauts ?? undefined}>
        {row.defauts?.trim() ? <span className="text-red-700">{row.defauts.trim()}</span> : ''}
      </td>
    </tr>
  )
})

// ── Mobile card (below md) ─────────────────────────────
// Same memo discipline as StockRow: `selected` is the only changing prop, and
// the edit-mode checkbox is CSS-driven via the container's data-editing group
// attribute, so edit-mode toggles re-render zero cards.

const StockEcruCard = memo(function StockEcruCard({
  row,
  selected,
  onRowClick,
}: {
  row: StockEcruRow
  selected: boolean
  onRowClick: (id: number, shiftKey: boolean) => void
}) {
  return (
    <div
      data-stock-row
      onClick={(e) => onRowClick(row.IDstock_ecru, e.shiftKey)}
      className={cn(
        'rounded-lg border p-3 cursor-pointer transition-colors shadow-sm group-data-[editing=true]:select-none',
        selected ? 'bg-accent/10 border-accent ring-1 ring-accent' : 'bg-white border-border/60 hover:border-accent/40',
      )}
    >
      <div className="flex items-center gap-2">
        <div
          className={cn(
            'h-5 w-5 rounded border flex-shrink-0 items-center justify-center transition-colors hidden group-data-[editing=true]:flex',
            selected ? 'bg-accent border-accent text-accent-foreground' : 'bg-white border-input',
          )}
        >
          {selected && <Check className="h-3.5 w-3.5" />}
        </div>
        <p className="text-sm font-medium truncate flex-1 min-w-0">{row.ref_ecru ?? '—'}</p>
        <div className="flex items-center gap-1 flex-shrink-0">
          {!!row.second_choix && (
            <Badge variant="outline" className="text-[10px] py-0 border-red-300 text-red-700">2ᵉ</Badge>
          )}
          {!!row.IDref_commande_affectation && (
            <Badge className="bg-sky-100 text-sky-700 border-sky-200 gap-1 text-[10px] py-0">
              <Send className="h-2.5 w-2.5" />
              Teinture
            </Badge>
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground mt-0.5 truncate">{row.coloris_reference ?? '—'}</p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 mt-2">
        <CardKV label="Numéro" value={row.numero ?? '—'} mono />
        <CardKV label="Poids" value={formatKg(row.poids)} mono strong />
        <CardKV label="Lot" value={row.lot ?? '—'} mono />
        <CardKV label="Magasin" value={row.magasin_nom ?? '—'} />
        <CardKV label="N° Cmd" value={row.commande_numero ?? '—'} mono />
        <CardKV label="Client" value={row.client_nom ?? '—'} />
      </div>
      {!!row.defauts?.trim() && (
        <p className="text-[11px] text-red-700 mt-2 truncate" title={row.defauts.trim()}>
          {row.defauts.trim()}
        </p>
      )}
      {!!(row.date_saisie || row.observations?.trim()) && (
        <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-border/40 text-[11px] text-muted-foreground">
          <span className="truncate italic">{row.observations?.trim() ?? ''}</span>
          <span className="flex-shrink-0 tabular-nums">{row.date_saisie ? formatHfsqlDate(row.date_saisie) : ''}</span>
        </div>
      )}
    </div>
  )
})

// ── Sort header cell ───────────────────────────────────

interface SortHeaderProps {
  label: string
  sortKey: SortKey
  sort: SortState
  onSort: (k: SortKey) => void
  align?: 'left' | 'right'
}
function SortHeader({ label, sortKey, sort, onSort, align = 'left' }: SortHeaderProps) {
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
  onDirtyChange: (dirty: boolean) => void
  saveRef: React.MutableRefObject<() => Promise<void>>
  discardRef: React.MutableRefObject<() => void>
}

function StockEcruDrawer({ id, onClose, onMutationSuccess, onDirtyChange, saveRef, discardRef }: DrawerProps) {
  const { data: detail, isLoading } = useStockEcruDetail(id)
  const { data: provenance } = useStockEcruProvenance(id)
  const canEdit = useHasPermission('edit_stock_ecru')
  const drawerRef = useRef<HTMLDivElement>(null)
  const [searchParams] = useSearchParams()
  const embed = searchParams.get('embed') === 'true'

  const [isEditing, setIsEditing] = useState(false)
  const magasinsQuery = useMagasinsLookup(isEditing)
  const [editObservations, setEditObservations] = useState('')
  const [editVisiteur, setEditVisiteur] = useState('')
  const [editSecondChoix, setEditSecondChoix] = useState(false)
  const [editIDmagasin, setEditIDmagasin] = useState(0)

  const originalDraftRef = useRef<{
    observations: string
    visiteur: string
    secondChoix: boolean
    IDmagasin: number
  } | null>(null)

  useEffect(() => {
    setIsEditing(false)
  }, [id])

  useEffect(() => {
    if (id === null) return
    function handleMouseDown(e: MouseEvent) {
      const target = e.target as Node | null
      if (!target) return
      if (drawerRef.current?.contains(target)) return
      // Table rows or mobile cards both carry data-stock-row — they switch selection themselves
      if ((target as Element).closest?.('[data-stock-row]')) return
      onClose()
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [id, onClose])

  const startEdit = useCallback(() => {
    if (!detail) return
    const snapshot = {
      observations: detail.observations ?? '',
      visiteur: detail.visiteur ?? '',
      secondChoix: !!detail.second_choix,
      IDmagasin: Number(detail.IDmagasin) || 0,
    }
    setEditObservations(snapshot.observations)
    setEditVisiteur(snapshot.visiteur)
    setEditSecondChoix(snapshot.secondChoix)
    setEditIDmagasin(snapshot.IDmagasin)
    originalDraftRef.current = snapshot
    setIsEditing(true)
  }, [detail])

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/stock/ecru/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          observations: editObservations,
          visiteur: editVisiteur,
          second_choix: editSecondChoix,
          IDmagasin: editIDmagasin,
        }),
      }),
    onSuccess: () => {
      onMutationSuccess()
      setIsEditing(false)
    },
  })

  const isDirty = useMemo(() => {
    if (!isEditing) return false
    const o = originalDraftRef.current
    if (!o) return false
    if (editObservations !== o.observations) return true
    if (editVisiteur !== o.visiteur) return true
    if (editSecondChoix !== o.secondChoix) return true
    if (editIDmagasin !== o.IDmagasin) return true
    return false
  }, [isEditing, editObservations, editVisiteur, editSecondChoix, editIDmagasin])

  useEffect(() => { onDirtyChange(isDirty) }, [isDirty, onDirtyChange])
  useEffect(() => () => { onDirtyChange(false) }, [onDirtyChange])

  useEffect(() => {
    saveRef.current = async () => { await saveMutation.mutateAsync() }
  })
  useEffect(() => {
    discardRef.current = () => setIsEditing(false)
  })

  const open = id !== null

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
            <FabricRollIcon className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            {isLoading || !detail ? (
              <div className="h-5 w-40 bg-white/20 animate-pulse rounded" />
            ) : (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-base font-heading font-bold tracking-tight truncate text-primary-foreground">
                    {detail.ref_ecru ?? '—'}
                  </h2>
                  {!!detail.second_choix && (
                    <Badge className="bg-red-100 text-red-700 border-red-200 gap-1 text-[10px] py-0">
                      2ᵉ choix
                    </Badge>
                  )}
                  {!!detail.IDref_commande_affectation && (
                    <Badge className="bg-sky-100 text-sky-700 border-sky-200 gap-1 text-[10px] py-0">
                      <Send className="h-2.5 w-2.5" />
                      En teinture
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-white/70 truncate">
                  {detail.coloris_reference ?? '—'}
                  {detail.lot ? ` · Lot ${detail.lot}` : ''}
                  {detail.numero ? ` · N° ${detail.numero}` : ''}
                </p>
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
                    disabled={saveMutation.isPending}
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
            {/* Mobile-only close — at full drawer width there is no "outside" left to tap */}
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
              {/* Stock */}
              <DrawerCard icon={<Package className="h-4 w-4 text-accent" />} title="Stock">
                <div className="space-y-1.5">
                  <KV label="Poids" value={<span className="font-semibold tabular-nums">{formatKg(detail.poids)}</span>} />
                  {Number(detail.metrage) > 0 && (
                    <KV label="Métrage" value={<span className="tabular-nums">{formatMeters(detail.metrage)}</span>} />
                  )}
                </div>
              </DrawerCard>

              {/* Qualité */}
              <DrawerCard icon={<ShieldAlert className="h-4 w-4 text-accent" />} title="Qualité" highlight={isEditing}>
                <div className="space-y-2">
                  <KV
                    label="2ᵉ choix"
                    value={
                      isEditing ? (
                        <input
                          type="checkbox"
                          checked={editSecondChoix}
                          onChange={(e) => setEditSecondChoix(e.target.checked)}
                          className="h-4 w-4 rounded border-input text-accent focus:ring-2 focus:ring-ring cursor-pointer"
                        />
                      ) : detail.second_choix ? (
                        <span className="text-red-600 font-medium">Oui</span>
                      ) : (
                        <span className="text-muted-foreground">Non</span>
                      )
                    }
                  />
                  <KV
                    label="Visiteur"
                    value={
                      isEditing ? (
                        <input
                          type="text"
                          value={editVisiteur}
                          onChange={(e) => setEditVisiteur(e.target.value)}
                          className="h-7 px-2 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring text-right max-w-[200px]"
                        />
                      ) : (
                        detail.visiteur?.trim() || '—'
                      )
                    }
                  />
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Défauts</p>
                    {detail.defects && detail.defects.length > 0 ? (
                      <ul className="space-y-0.5">
                        {detail.defects.map((d) => (
                          <li key={d.IDdefaut_qualite} className="text-sm text-red-700 flex items-start gap-1.5">
                            <span className="mt-1 h-1 w-1 rounded-full bg-red-500 flex-shrink-0" />
                            <span>
                              {[d.type_defaut?.trim(), d.taille_cm && Number(d.taille_cm) > 0 ? `${Number(d.taille_cm)} cm` : '']
                                .filter(Boolean)
                                .join(' ') || d.description?.trim() || 'Défaut'}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-muted-foreground italic">Aucun défaut</p>
                    )}
                  </div>
                </div>
              </DrawerCard>

              {/* Réservation client */}
              <DrawerCard icon={<Send className="h-4 w-4 text-accent" />} title="Réservation client">
                <div className="space-y-1.5">
                  <KV
                    label="N° commande"
                    value={
                      detail.commande_numero
                        ? <span className="tabular-nums">{detail.commande_numero}</span>
                        : <span className="text-muted-foreground">—</span>
                    }
                  />
                  <KV label="Client" value={detail.client_nom ?? <span className="text-muted-foreground">—</span>} />
                </div>
              </DrawerCard>

              {/* Provenance */}
              <DrawerCard icon={<Factory className="h-4 w-4 text-accent" />} title="Provenance">
                <div className="space-y-2.5">
                  {/* Fils — yarns knit into this écru roll, with supplier + fil order N° */}
                  {!!provenance && provenance.fils.length > 0 && (
                    <div className="space-y-1.5">
                      {provenance.fils.map((f, i) => (
                        <ProvenanceRow
                          key={i}
                          icon={<BobineIcon className="h-3.5 w-3.5 text-accent" />}
                          title={f.ref_fil || 'Fil'}
                          detail={[
                            f.fournisseur,
                            f.IDcommande_fil ? `Commande N° ${f.IDcommande_fil}` : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        />
                      ))}
                    </div>
                  )}

                  {/* Tricotage — the knitting (tricoteur) sst order that produced this écru */}
                  {!!provenance?.tricotage && (
                    <ProvenanceRow
                      icon={<KnitIcon className="h-3.5 w-3.5 text-accent" />}
                      title="Tricotage"
                      detail={[
                        provenance.tricotage.sst_nom,
                        `Commande N° ${provenance.tricotage.IDcommande}`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    />
                  )}

                  <div className="space-y-1.5 pt-1.5 border-t border-border/40">
                    <KV
                      label="Date saisie"
                      value={detail.date_saisie ? formatHfsqlDate(detail.date_saisie) : '—'}
                    />
                  </div>
                </div>
              </DrawerCard>

              {/* Stockage */}
              <DrawerCard icon={<MapPin className="h-4 w-4 text-accent" />} title="Stockage" highlight={isEditing}>
                <div className="space-y-1.5">
                  <KV
                    label="Magasin"
                    value={
                      isEditing ? (
                        <SearchableCombobox<MagasinOption>
                          options={magasinsQuery.data ?? []}
                          value={editIDmagasin}
                          onChange={setEditIDmagasin}
                          getId={(m) => m.IDsous_traitant}
                          getPrimary={(m) => m.nom ?? ''}
                          placeholder="Magasin"
                          loading={magasinsQuery.isLoading}
                          size="sm"
                        />
                      ) : (
                        detail.magasin_nom ?? '—'
                      )
                    }
                  />
                </div>
              </DrawerCard>

              {/* Notes */}
              <DrawerCard icon={<MessageSquare className="h-4 w-4 text-accent" />} title="Notes" highlight={isEditing}>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Observations</p>
                  {isEditing ? (
                    <textarea
                      value={editObservations}
                      onChange={(e) => setEditObservations(e.target.value)}
                      rows={3}
                      className="w-full px-2.5 py-1.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                    />
                  ) : detail.observations?.trim() ? (
                    <p className="text-sm whitespace-pre-wrap">{detail.observations.trim()}</p>
                  ) : (
                    <p className="text-sm text-muted-foreground italic">—</p>
                  )}
                </div>
              </DrawerCard>
            </>
          )}
        </div>
      </div>
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

// One provenance origin: a leading icon, a primary label (yarn ref / step name)
// and a muted detail line (supplier · order N°). Used in the drawer's Provenance
// card. Mirrors the same component in FinisStock.tsx.
function ProvenanceRow({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode
  title: string
  detail: string
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="flex-shrink-0 mt-0.5">{icon}</span>
      <div className="min-w-0">
        <p className="text-sm font-medium truncate">{title}</p>
        {!!detail && <p className="text-[11px] text-muted-foreground truncate">{detail}</p>}
      </div>
    </div>
  )
}
