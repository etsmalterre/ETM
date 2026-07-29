import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
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
  Plus,
  X,
  Save,
  ArrowUp,
  ArrowDown,
  Leaf,
  Recycle,
  ShieldCheck,
  Calendar,
  MapPin,
  Factory,
  Package,
  MessageSquare,
  Eye,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { BobineIcon } from '@/components/icons/BobineIcon'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { PopoverSelect, SearchableCombobox } from '@/components/ui/popover-select'
import { cn } from '@/lib/utils'
import { formatHfsqlDate, hfsqlDateToInput, inputDateToHfsql } from '@/lib/dates'
import { apiFetch, API_URL } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { useHasPermission } from '@/contexts/PermissionsContext'
import { CardKV, MobileSortRow } from '@/components/stock/StockCardParts'

// ── Types ──────────────────────────────────────────────

interface StockRow {
  IDstock_fil: number
  IDfournisseur: number | null
  IDref_fil: number | null
  IDcolori_fil: number | null
  IDref_fil_commande: number | null
  IDMagasin: number | null
  stock: number | null
  stock_initial: number | null
  lot: string | null
  lot_frs: string | null
  emplacement: string | null
  date_entree: string | null
  dernier_mouvement: string | null
  dernier_pointage: string | null
  niveau: number | null
  termine: number | null
  controle: number | null
  commentaire: string | null
  observation_freinte: string | null
  ref_fil: string | null
  titrage: number | null
  bio: number | null
  recycle: number | null
  colori_reference: string | null
  fournisseur_nom: string | null
  magasin_nom: string | null
}

interface StockDetail extends StockRow {
  IDcommande_fil: number | null
  has_certif_bio: boolean
  has_certif_recycle: boolean
}

interface FournisseurOption {
  IDfournisseur: number
  nom: string
}

interface RefFilOption {
  IDref_fil: number
  IDcolori_fil: number
  reference: string // ref_fil.reference (base yarn name)
  colori_reference: string // colori_fil.reference (color name)
  bio?: number | null
  recycle?: number | null
  // Bridge may mangle accented column name
  [key: string]: unknown
}

// ── API helpers ────────────────────────────────────────
// Shared apiFetch + API_URL — see apps/web/src/lib/api.ts

function useStockList(filters: { hideFinished: boolean }) {
  const params = new URLSearchParams()
  if (!filters.hideFinished) params.set('termine', 'all')
  const qs = params.toString()
  return useQuery<StockRow[]>({
    queryKey: ['stock-fil', filters],
    queryFn: () => apiFetch<StockRow[]>(`/stock/fil${qs ? `?${qs}` : ''}`),
  })
}

function useStockDetail(id: number | null) {
  return useQuery<StockDetail>({
    queryKey: ['stock-fil', 'detail', id],
    queryFn: () => apiFetch<StockDetail>(`/stock/fil/${id}`),
    enabled: id !== null,
  })
}

// ── Helpers ────────────────────────────────────────────

function formatKg(v: number | null): string {
  if (v == null) return '—'
  return `${v.toFixed(1)} kg`
}

function ageDays(dateEntree: string | null): number | null {
  if (!dateEntree || dateEntree.length !== 8) return null
  const d = new Date(`${dateEntree.slice(0, 4)}-${dateEntree.slice(4, 6)}-${dateEntree.slice(6, 8)}`)
  if (isNaN(d.getTime())) return null
  const diff = Date.now() - d.getTime()
  return Math.floor(diff / (1000 * 60 * 60 * 24))
}

// ── Sort handling ──────────────────────────────────────

type SortKey =
  | 'ref_fil'
  | 'colori_reference'
  | 'lot'
  | 'lot_frs'
  | 'fournisseur_nom'
  | 'stock'
  | 'stock_initial'
  | 'emplacement'
  | 'date_entree'
  | 'commentaire'

interface SortState {
  key: SortKey
  dir: 'asc' | 'desc'
}

// Column widths shared by header and body tables (must match for alignment)
const COLUMNS: { key: SortKey; label: string; width: string; align?: 'left' | 'right' }[] = [
  { key: 'ref_fil', label: 'Référence', width: '12%' },
  { key: 'colori_reference', label: 'Coloris', width: '10%' },
  { key: 'lot', label: 'Lot interne', width: '7%' },
  { key: 'lot_frs', label: 'Lot fournisseur', width: '9%' },
  { key: 'fournisseur_nom', label: 'Fournisseur', width: '13%' },
  { key: 'stock', label: 'Stock', width: '7%', align: 'right' },
  { key: 'stock_initial', label: 'Stock initial', width: '7%', align: 'right' },
  { key: 'emplacement', label: 'Emplacement', width: '9%' },
  { key: 'date_entree', label: 'Date entrée', width: '9%' },
  { key: 'commentaire', label: 'Commentaire', width: '14%' },
]
const ICON_COL_WIDTH = '3%'

function compareRows(a: StockRow, b: StockRow, key: SortKey): number {
  const va = a[key]
  const vb = b[key]
  if (va == null && vb == null) return 0
  if (va == null) return 1
  if (vb == null) return -1
  if (typeof va === 'number' && typeof vb === 'number') return va - vb
  return String(va).localeCompare(String(vb), 'fr', { numeric: true, sensitivity: 'base' })
}

// ── Main Page ──────────────────────────────────────────

export function FilsStock() {
  const queryClient = useQueryClient()
  const [searchQuery, setSearchQuery] = useState('')
  const [hideFinished, setHideFinished] = useState(true)
  const [sort, setSort] = useState<SortState>({ key: 'date_entree', dir: 'desc' })
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  // Permission gate — admins always pass; non-admins need create_stock_fil
  const canCreate = useHasPermission('create_stock_fil')

  const { data: rows, isLoading, isError, error } = useStockList({ hideFinished })

  const filteredSorted = useMemo(() => {
    let out = rows ?? []
    // Split the query on whitespace and require EVERY term to match SOME
    // column (AND across terms, OR across columns). This lets one search combine
    // criteria from different columns — e.g. "1/34 chanvre ecru" matches a row
    // whose ref_fil is "1/34 chanvre" AND whose coloris is "ecru". A single
    // term behaves exactly as the old substring search.
    const terms = searchQuery.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length > 0) {
      out = out.filter((r) => {
        const haystacks = [r.ref_fil, r.colori_reference, r.lot, r.lot_frs, r.emplacement, r.fournisseur_nom, r.commentaire]
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
  }, [rows, searchQuery, sort])

  const handleSort = useCallback((key: SortKey) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
  }, [])

  // Totalizer over the currently-visible (filtered) rows
  const lotCount = filteredSorted.length
  const totalStock = filteredSorted.reduce((sum, r) => sum + (r.stock ?? 0), 0)

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
  }, [guard])

  const handleRowClick = useCallback((rowId: number) => {
    guard.guardAction(() => {
      setSelectedId((prev) => (prev === rowId ? null : rowId))
    })
  }, [guard])

  const onMutationSuccess = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['stock-fil'] })
  }, [queryClient])

  return (
    <div className="h-full flex flex-col gap-3 min-h-0">

      {/* Toolbar — below sm: search + Nouveau share row 1 (create action stays top-right),
          the filter checkbox wraps to row 2. Desktop order/pixels unchanged. */}
      <div className="flex-shrink-0 flex flex-wrap items-center gap-3">
        <div className="relative order-1 flex-1 min-w-0">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Rechercher (réf, coloris, lot, fournisseur, emplacement, commentaire…)"
            className="h-9 w-full pl-8 pr-3 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        <label className="flex items-center gap-2 text-sm cursor-pointer select-none flex-shrink-0 order-3 sm:order-2 w-full sm:w-auto">
          <input
            type="checkbox"
            checked={hideFinished}
            onChange={(e) => setHideFinished(e.target.checked)}
            className="h-4 w-4 rounded border-input text-accent focus:ring-2 focus:ring-ring cursor-pointer"
          />
          <span>Masquer les lots terminés</span>
        </label>

        {canCreate && (
          <Button size="sm" onClick={() => setCreateOpen(true)} className="flex-shrink-0 order-2 sm:order-3" title="Nouveau">
            <Plus className="h-3.5 w-3.5 sm:mr-1" />
            <span className="hidden sm:inline">Nouveau</span>
          </Button>
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
            <p className="text-sm">Aucun lot en stock</p>
          </div>
        ) : (
          <>
            {/* Desktop table (md+) — split header/body sharing one colgroup */}
            <div className="hidden md:flex md:flex-col flex-1 min-h-0">
            {/* Header table (non-scrolling) */}
            <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
              <colgroup>
                {COLUMNS.map((c) => (
                  <col key={c.key} style={{ width: c.width }} />
                ))}
                <col style={{ width: ICON_COL_WIDTH }} />
              </colgroup>
              <thead className="bg-zinc-200/60 border-b border-border/60">
                <tr className="text-xs uppercase tracking-wide text-muted-foreground">
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
                  <th className="px-3 py-2.5 text-left font-semibold"></th>
                </tr>
              </thead>
            </table>

            {/* Body table (scrolling) */}
            <div className="flex-1 min-h-0 overflow-auto scrollbar-transparent">
              <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
                <colgroup>
                  {COLUMNS.map((c) => (
                    <col key={c.key} style={{ width: c.width }} />
                  ))}
                  <col style={{ width: ICON_COL_WIDTH }} />
                </colgroup>
                <tbody>
                  {filteredSorted.map((r) => {
                    const isSelected = r.IDstock_fil === selectedId
                    return (
                      <tr
                        key={r.IDstock_fil}
                        data-stock-row
                        onClick={() => handleRowClick(r.IDstock_fil)}
                        className={cn(
                          'border-b border-border/40 cursor-pointer transition-colors',
                          isSelected ? 'bg-accent/10' : 'hover:bg-accent/5'
                        )}
                      >
                        <td className="px-3 py-2 font-medium truncate">{r.ref_fil ?? '—'}</td>
                        <td className="px-3 py-2 truncate">{r.colori_reference ?? '—'}</td>
                        <td className="px-3 py-2 tabular-nums truncate">{r.lot ?? '—'}</td>
                        <td className="px-3 py-2 tabular-nums text-muted-foreground truncate">{r.lot_frs ?? '—'}</td>
                        <td className="px-3 py-2 truncate">{r.fournisseur_nom ?? '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">{formatKg(r.stock)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{formatKg(r.stock_initial)}</td>
                        <td className="px-3 py-2 truncate">{r.emplacement ?? '—'}</td>
                        <td className="px-3 py-2 tabular-nums text-muted-foreground">
                          {r.date_entree ? formatHfsqlDate(r.date_entree) : '—'}
                        </td>
                        <td
                          className="px-3 py-2 text-muted-foreground truncate"
                          title={r.commentaire ?? undefined}
                        >
                          {r.commentaire?.trim() || ''}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="flex items-center justify-end gap-1">
                            {!!r.bio && <Leaf className="h-3.5 w-3.5 text-green-600" />}
                            {!!r.recycle && <Recycle className="h-3.5 w-3.5 text-blue-600" />}
                            {!!r.termine && <Badge variant="outline" className="text-[10px] py-0">T</Badge>}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            </div>

            {/* Mobile card list (< md) — same rows, selection and sort state as the table */}
            <div className="md:hidden flex-1 min-h-0 flex flex-col">
              <MobileSortRow columns={COLUMNS} sort={sort} onSortChange={setSort} />
              <div className="flex-1 min-h-0 overflow-y-auto scrollbar-transparent p-2 space-y-2 bg-zinc-100/80">
                {filteredSorted.map((r) => (
                  <StockLotCard
                    key={r.IDstock_fil}
                    row={r}
                    isSelected={r.IDstock_fil === selectedId}
                    onClick={() => handleRowClick(r.IDstock_fil)}
                  />
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Totalizer — standalone summary bar, detached from the table */}
      {!isLoading && !isError && filteredSorted.length > 0 && (
        <div className="flex-shrink-0 flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-zinc-100/80 shadow-sm px-4 py-2.5">
          <div className="flex items-center gap-2 text-sm">
            <Boxes className="h-4 w-4 text-accent" />
            <span className="font-semibold">{lotCount}</span>
            <span className="text-muted-foreground">lot{lotCount > 1 ? 's' : ''}</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">Stock total</span>
            <span className="text-base font-bold tabular-nums">{fmtNum(totalStock, 1)} kg</span>
          </div>
        </div>
      )}

      <StockDetailDrawer
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

      <NewStockFilDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(newId) => {
          onMutationSuccess()
          setSelectedId(newId)
        }}
      />
    </div>
  )
}

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
        'px-3 py-2.5 font-semibold cursor-pointer select-none whitespace-nowrap',
        align === 'right' ? 'text-right' : 'text-left',
        active && 'text-accent'
      )}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active && (sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </span>
    </th>
  )
}

// ── Mobile card (below md) ─────────────────────────────
// One stock lot as a touch-friendly card. Same data, click handler and
// data-stock-row marker as the table row — only the markup differs.

function StockLotCard({ row, isSelected, onClick }: { row: StockRow; isSelected: boolean; onClick: () => void }) {
  return (
    <div
      data-stock-row
      onClick={onClick}
      className={cn(
        'rounded-lg border p-3 cursor-pointer transition-colors shadow-sm',
        isSelected ? 'bg-accent/10 border-accent ring-1 ring-accent' : 'bg-white border-border/60 hover:border-accent/40'
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium truncate">{row.ref_fil ?? '—'}</p>
        <div className="flex items-center gap-1 flex-shrink-0">
          {!!row.bio && <Leaf className="h-3.5 w-3.5 text-green-600" />}
          {!!row.recycle && <Recycle className="h-3.5 w-3.5 text-blue-600" />}
          {!!row.termine && <Badge variant="outline" className="text-[10px] py-0">T</Badge>}
        </div>
      </div>
      <p className="text-xs text-muted-foreground mt-0.5 truncate">{row.colori_reference ?? '—'}</p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 mt-2">
        <CardKV label="Lot" value={row.lot ?? '—'} mono />
        <CardKV label="Stock" value={formatKg(row.stock)} mono strong />
        <CardKV label="Fournisseur" value={row.fournisseur_nom ?? '—'} />
        <CardKV label="Emplacement" value={row.emplacement ?? '—'} />
      </div>
      {!!(row.date_entree || row.commentaire?.trim()) && (
        <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-border/40 text-[11px] text-muted-foreground">
          <span className="truncate italic">{row.commentaire?.trim() ?? ''}</span>
          <span className="flex-shrink-0 tabular-nums">{row.date_entree ? formatHfsqlDate(row.date_entree) : ''}</span>
        </div>
      )}
    </div>
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

function StockDetailDrawer({ id, onClose, onMutationSuccess, onDirtyChange, saveRef, discardRef }: DrawerProps) {
  const { data: detail, isLoading } = useStockDetail(id)
  const drawerRef = useRef<HTMLDivElement>(null)
  const [searchParams] = useSearchParams()
  const embed = searchParams.get('embed') === 'true'

  const [isEditing, setIsEditing] = useState(false)
  const [editCommentaire, setEditCommentaire] = useState('')
  const [editFreinte, setEditFreinte] = useState('')
  const [editEmplacement, setEditEmplacement] = useState('')
  const [editPointage, setEditPointage] = useState('')

  // Snapshot for dirty comparison
  const originalDraftRef = useRef<{
    commentaire: string
    freinte: string
    emplacement: string
    pointage: string
  } | null>(null)

  // Reset edit state when selecting a different lot
  useEffect(() => {
    setIsEditing(false)
  }, [id])

  // Close on outside click (but ignore clicks on table rows — they switch selection)
  useEffect(() => {
    if (id === null) return
    function handleMouseDown(e: MouseEvent) {
      const target = e.target as Node | null
      if (!target) return
      if (drawerRef.current?.contains(target)) return
      // Ignore clicks on stock rows (table rows or mobile cards) — they handle selection themselves
      if ((target as Element).closest?.('[data-stock-row]')) return
      onClose()
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [id, onClose])

  const startEdit = useCallback(() => {
    if (!detail) return
    const snapshot = {
      commentaire: detail.commentaire ?? '',
      freinte: detail.observation_freinte ?? '',
      emplacement: detail.emplacement ?? '',
      pointage: hfsqlDateToInput(detail.dernier_pointage),
    }
    setEditCommentaire(snapshot.commentaire)
    setEditFreinte(snapshot.freinte)
    setEditEmplacement(snapshot.emplacement)
    setEditPointage(snapshot.pointage)
    originalDraftRef.current = snapshot
    setIsEditing(true)
  }, [detail])

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/stock/fil/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          commentaire: editCommentaire,
          observation_freinte: editFreinte,
          emplacement: editEmplacement,
          dernier_pointage: editPointage ? inputDateToHfsql(editPointage) : '',
        }),
      }),
    onSuccess: () => {
      onMutationSuccess()
      setIsEditing(false)
    },
  })

  // Compute dirty state and surface it to the page via callback + refs.
  const isDirty = useMemo(() => {
    if (!isEditing) return false
    const o = originalDraftRef.current
    if (!o) return false
    if (editCommentaire !== o.commentaire) return true
    if (editFreinte !== o.freinte) return true
    if (editEmplacement !== o.emplacement) return true
    if (editPointage !== o.pointage) return true
    return false
  }, [isEditing, editCommentaire, editFreinte, editEmplacement, editPointage])

  useEffect(() => { onDirtyChange(isDirty) }, [isDirty, onDirtyChange])
  useEffect(() => () => { onDirtyChange(false) }, [onDirtyChange])

  // Keep save + discard callbacks up-to-date so the page-level guard can
  // invoke them from the unsaved-changes dialog.
  useEffect(() => {
    saveRef.current = async () => { await saveMutation.mutateAsync() }
  })
  useEffect(() => {
    discardRef.current = () => setIsEditing(false)
  })

  const open = id !== null
  const age = detail ? ageDays(detail.date_entree) : null

  return (
    <div
      ref={drawerRef}
      className={cn(
        'fixed right-0 bottom-0 w-full max-w-[440px] bg-white border-l border-border/60 shadow-xl z-30 transition-transform duration-300 flex flex-col',
        embed ? 'top-0' : 'top-14',
        open ? 'translate-x-0' : 'translate-x-full'
      )}
    >
      {/* Inner bg layer — matches the Fournisseurs right panel composition:
          zinc-100/80 over white; header gets an additional zinc-200/50 overlay. */}
      <div className="flex-1 min-h-0 flex flex-col bg-zinc-100/80">
      {/* Header band — the widget treatment (mps_designer §27.5bis / §43):
          navy surface, flat gold tile, white title, gold hairline under. */}
      <div className="flex-shrink-0 flex items-center gap-2.5 border-b-2 border-gold bg-primary px-4 py-2.5">
        <div
          className={cn(
            'h-8 w-8 flex-shrink-0 rounded-lg flex items-center justify-center shadow-sm transition-colors',
            isEditing ? 'bg-white text-primary' : 'bg-gold text-gold-foreground'
          )}
        >
          <BobineIcon className="h-[18px] w-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          {isLoading || !detail ? (
            <div className="h-5 w-40 bg-white/20 animate-pulse rounded" />
          ) : (
            <>
              <div className="flex items-center gap-2 flex-wrap">
                <h2 className="text-base font-heading font-bold tracking-tight truncate text-primary-foreground">
                  {detail.ref_fil ?? '—'}
                </h2>
                {!!detail.bio && (
                  <Badge className="bg-green-100 text-green-700 border-green-200 gap-1 text-[10px] py-0">
                    <Leaf className="h-2.5 w-2.5" />
                    Bio
                  </Badge>
                )}
                {!!detail.recycle && (
                  <Badge className="bg-blue-100 text-blue-700 border-blue-200 gap-1 text-[10px] py-0">
                    <Recycle className="h-2.5 w-2.5" />
                    Recyclé
                  </Badge>
                )}
              </div>
              <p className="text-xs text-white/70 truncate">
                {detail.colori_reference ?? '—'} • Lot {detail.lot ?? '—'}
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
              <Button variant="gold" size="sm" onClick={startEdit} title="Modifier">
                <Pencil className="h-3.5 w-3.5 sm:mr-1.5" />
                <span className="hidden sm:inline">Modifier</span>
              </Button>
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
            {/* Stock card */}
            <DrawerCard icon={<Package className="h-4 w-4 text-accent" />} title="Stock" highlight={isEditing}>
              <div className="space-y-1.5">
                <KV label="Stock actuel" value={<span className="font-semibold tabular-nums">{formatKg(detail.stock)}</span>} />
                <KV label="Stock initial" value={<span className="tabular-nums">{formatKg(detail.stock_initial)}</span>} />
              </div>
            </DrawerCard>

            {/* Provenance */}
            <DrawerCard icon={<Factory className="h-4 w-4 text-accent" />} title="Provenance" highlight={isEditing}>
              <div className="space-y-1.5">
                <KV label="Fournisseur" value={detail.fournisseur_nom ?? '—'} />
                <KV label="Lot fournisseur" value={detail.lot_frs ?? '—'} mono />
                <KV
                  label="Date d'entrée"
                  value={detail.date_entree ? formatHfsqlDate(detail.date_entree) : '—'}
                />
                {detail.IDcommande_fil ? (
                  <KV label="Commande N°" value={String(detail.IDcommande_fil)} mono />
                ) : null}
              </div>
            </DrawerCard>

            {/* Stockage */}
            <DrawerCard icon={<MapPin className="h-4 w-4 text-accent" />} title="Stockage" highlight={isEditing}>
              <div className="space-y-1.5">
                <KV
                  label="Emplacement"
                  value={
                    isEditing ? (
                      <input
                        type="text"
                        value={editEmplacement}
                        onChange={(e) => setEditEmplacement(e.target.value)}
                        className="h-7 px-2 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring text-right"
                      />
                    ) : (
                      detail.emplacement || '—'
                    )
                  }
                />
                <KV label="Magasin" value={detail.magasin_nom ?? '—'} />
                <KV
                  label="Dernier mouvement"
                  value={detail.dernier_mouvement ? formatHfsqlDate(detail.dernier_mouvement) : '—'}
                />
                <KV
                  label="Dernier pointage"
                  value={
                    isEditing ? (
                      <input
                        type="date"
                        value={editPointage}
                        onChange={(e) => setEditPointage(e.target.value)}
                        className="h-7 px-2 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
                      />
                    ) : detail.dernier_pointage ? (
                      formatHfsqlDate(detail.dernier_pointage)
                    ) : (
                      '—'
                    )
                  }
                />

                {age != null && (
                  <KV
                    label="Âge"
                    value={
                      <span className="inline-flex items-center gap-1">
                        <Calendar className="h-3 w-3 text-muted-foreground" />
                        {age} jour{age > 1 ? 's' : ''}
                      </span>
                    }
                  />
                )}
              </div>
            </DrawerCard>

            {/* Notes */}
            <DrawerCard icon={<MessageSquare className="h-4 w-4 text-accent" />} title="Notes" highlight={isEditing}>
              <div className="space-y-2">
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Commentaire</p>
                  {isEditing ? (
                    <textarea
                      value={editCommentaire}
                      onChange={(e) => setEditCommentaire(e.target.value)}
                      rows={3}
                      className="w-full px-2.5 py-1.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                    />
                  ) : detail.commentaire?.trim() ? (
                    <p className="text-sm whitespace-pre-wrap">{detail.commentaire.trim()}</p>
                  ) : (
                    <p className="text-sm text-muted-foreground italic">—</p>
                  )}
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Observation freinte</p>
                  {isEditing ? (
                    <textarea
                      value={editFreinte}
                      onChange={(e) => setEditFreinte(e.target.value)}
                      rows={2}
                      className="w-full px-2.5 py-1.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                    />
                  ) : detail.observation_freinte?.trim() ? (
                    <p className="text-sm whitespace-pre-wrap">{detail.observation_freinte.trim()}</p>
                  ) : (
                    <p className="text-sm text-muted-foreground italic">—</p>
                  )}
                </div>
              </div>
            </DrawerCard>

            {/* Certificats */}
            {(detail.has_certif_bio || detail.has_certif_recycle) && (
              <DrawerCard icon={<ShieldCheck className="h-4 w-4 text-accent" />} title="Certificats du lot">
                <div className="flex flex-col gap-2">
                  {detail.has_certif_bio && (
                    <a
                      href={`${API_URL}/stock/fil/${detail.IDstock_fil}/certif/bio`}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-green-200 bg-green-50 hover:bg-green-100 transition-colors"
                    >
                      <span className="flex items-center gap-2 text-sm font-medium text-green-700">
                        <Leaf className="h-4 w-4" />
                        Certificat bio
                      </span>
                      <Eye className="h-3.5 w-3.5 text-green-600" />
                    </a>
                  )}
                  {detail.has_certif_recycle && (
                    <a
                      href={`${API_URL}/stock/fil/${detail.IDstock_fil}/certif/recycle`}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-blue-200 bg-blue-50 hover:bg-blue-100 transition-colors"
                    >
                      <span className="flex items-center gap-2 text-sm font-medium text-blue-700">
                        <Recycle className="h-4 w-4" />
                        Certificat recyclé
                      </span>
                      <Eye className="h-3.5 w-3.5 text-blue-600" />
                    </a>
                  )}
                </div>
              </DrawerCard>
            )}
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
        highlight && 'border-l-4 border-l-accent/70 bg-accent/[0.03]'
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

// ── New lot dialog ─────────────────────────────────────

interface NewStockFilDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (newId: number) => void
}

function todayInputDate(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function NewStockFilDialog({ open, onOpenChange, onCreated }: NewStockFilDialogProps) {
  const [IDfournisseur, setIDfournisseur] = useState<number | ''>('')
  const [IDref_fil, setIDrefFil] = useState<number | ''>('')
  const [IDcolori_fil, setIDcolori] = useState<number | ''>('')
  const [lot, setLot] = useState('')
  const [lotFrs, setLotFrs] = useState('')
  const [stockInitial, setStockInitial] = useState('')
  const [emplacement, setEmplacement] = useState('')
  const [dateEntree, setDateEntree] = useState(todayInputDate())
  const [commentaire, setCommentaire] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Reset form when the dialog opens
  useEffect(() => {
    if (open) {
      setIDfournisseur('')
      setIDrefFil('')
      setIDcolori('')
      setLot('')
      setLotFrs('')
      setStockInitial('')
      setEmplacement('')
      setDateEntree(todayInputDate())
      setCommentaire('')
      setError(null)
    }
  }, [open])

  const fournisseursQuery = useQuery<FournisseurOption[]>({
    queryKey: ['fournisseurs', 'options'],
    queryFn: () => apiFetch<FournisseurOption[]>('/fournisseurs'),
    enabled: open,
  })

  const fournisseurDetailQuery = useQuery<{ refsFil: RefFilOption[] }>({
    queryKey: ['fournisseur', 'detail', IDfournisseur],
    queryFn: () => apiFetch<{ refsFil: RefFilOption[] }>(`/fournisseurs/${IDfournisseur}`),
    enabled: open && typeof IDfournisseur === 'number',
  })

  const refs = fournisseurDetailQuery.data?.refsFil ?? []

  // Unique ref_fil entries (one per IDref_fil) for the first select
  const uniqueRefs = useMemo(() => {
    const seen = new Map<number, { IDref_fil: number; reference: string }>()
    for (const r of refs) {
      if (!seen.has(r.IDref_fil)) {
        seen.set(r.IDref_fil, { IDref_fil: r.IDref_fil, reference: r.reference })
      }
    }
    return Array.from(seen.values()).sort((a, b) =>
      a.reference.localeCompare(b.reference, 'fr', { sensitivity: 'base' })
    )
  }, [refs])

  // Coloris options filtered by the chosen ref_fil
  const colorisForRef = useMemo(() => {
    if (typeof IDref_fil !== 'number') return []
    return refs
      .filter((r) => r.IDref_fil === IDref_fil)
      .sort((a, b) =>
        a.colori_reference.localeCompare(b.colori_reference, 'fr', { sensitivity: 'base' })
      )
  }, [refs, IDref_fil])

  // Reset ref and coloris when fournisseur changes
  useEffect(() => {
    setIDrefFil('')
    setIDcolori('')
  }, [IDfournisseur])

  // Reset coloris when ref changes
  useEffect(() => {
    setIDcolori('')
  }, [IDref_fil])

  const createMutation = useMutation({
    mutationFn: async () => {
      if (typeof IDref_fil !== 'number' || typeof IDcolori_fil !== 'number') {
        throw new Error('Référence et coloris requis')
      }
      return apiFetch<{ IDstock_fil: number | null }>('/stock/fil', {
        method: 'POST',
        body: JSON.stringify({
          IDfournisseur,
          IDref_fil,
          IDcolori_fil,
          lot,
          lot_frs: lotFrs,
          stock_initial: parseFloat(stockInitial) || 0,
          emplacement,
          date_entree: inputDateToHfsql(dateEntree),
          commentaire,
        }),
      })
    },
    onSuccess: (res) => {
      onOpenChange(false)
      if (res?.IDstock_fil) onCreated(res.IDstock_fil)
      else onCreated(-1)
    },
    onError: (err: Error) => {
      setError(err.message || 'Erreur lors de la création')
    },
  })

  const canSubmit =
    typeof IDfournisseur === 'number' &&
    typeof IDref_fil === 'number' &&
    typeof IDcolori_fil === 'number' &&
    stockInitial.trim() !== '' &&
    !isNaN(parseFloat(stockInitial))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90dvh] overflow-y-auto" onClose={() => onOpenChange(false)}>
        <DialogHeader>
          <DialogTitle className="font-heading">Nouveau lot de fil</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
          <div className="col-span-full">
            <label className="text-xs text-muted-foreground mb-1 block">Fournisseur *</label>
            <SearchableCombobox<{ IDfournisseur: number; nom: string }>
              options={fournisseursQuery.data ?? []}
              value={typeof IDfournisseur === 'number' ? IDfournisseur : 0}
              onChange={(id) => setIDfournisseur(id > 0 ? id : '')}
              getId={(f) => f.IDfournisseur}
              getPrimary={(f) => f.nom}
              placeholder="Sélectionner un fournisseur"
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Référence *</label>
            <PopoverSelect
              options={uniqueRefs.map((r) => ({ id: r.IDref_fil, primary: r.reference }))}
              value={typeof IDref_fil === 'number' ? IDref_fil : 0}
              onChange={(id) => setIDrefFil(id > 0 ? id : '')}
              disabled={typeof IDfournisseur !== 'number' || fournisseurDetailQuery.isLoading}
              emptyLabel={
                typeof IDfournisseur !== 'number'
                  ? '— Choisir un fournisseur —'
                  : fournisseurDetailQuery.isLoading
                    ? 'Chargement…'
                    : uniqueRefs.length === 0
                      ? 'Aucune référence'
                      : '— Sélectionner —'
              }
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Coloris *</label>
            <PopoverSelect
              options={colorisForRef.map((r) => ({ id: r.IDcolori_fil, primary: r.colori_reference }))}
              value={typeof IDcolori_fil === 'number' ? IDcolori_fil : 0}
              onChange={(id) => setIDcolori(id > 0 ? id : '')}
              disabled={typeof IDref_fil !== 'number'}
              emptyLabel={
                typeof IDref_fil !== 'number'
                  ? '— Choisir une référence —'
                  : colorisForRef.length === 0
                    ? 'Aucun coloris'
                    : '— Sélectionner —'
              }
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Lot interne</label>
            <input
              type="text"
              value={lot}
              onChange={(e) => setLot(e.target.value)}
              className="w-full h-9 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Lot fournisseur</label>
            <input
              type="text"
              value={lotFrs}
              onChange={(e) => setLotFrs(e.target.value)}
              className="w-full h-9 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Stock initial (kg) *</label>
            <input
              type="number"
              step="0.1"
              min="0"
              value={stockInitial}
              onChange={(e) => setStockInitial(e.target.value)}
              className="w-full h-9 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Date d'entrée</label>
            <input
              type="date"
              value={dateEntree}
              onChange={(e) => setDateEntree(e.target.value)}
              className="w-full h-9 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="col-span-full">
            <label className="text-xs text-muted-foreground mb-1 block">Emplacement</label>
            <input
              type="text"
              value={emplacement}
              onChange={(e) => setEmplacement(e.target.value)}
              className="w-full h-9 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          <div className="col-span-full">
            <label className="text-xs text-muted-foreground mb-1 block">Commentaire</label>
            <textarea
              value={commentaire}
              onChange={(e) => setCommentaire(e.target.value)}
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
