import { useState, useMemo, useCallback, useEffect, useRef, useTransition, useDeferredValue, memo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { UnsavedChangesDialog } from '@/components/shared/UnsavedChangesDialog'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import {
  Boxes,
  Loader2,
  AlertCircle,
  Pencil,
  X,
  Check,
  Save,
  ArrowUp,
  ArrowDown,
  Activity,
  Send,
  MapPin,
  Factory,
  Package,
  MessageSquare,
  Sparkles,
  Gift,
  Trash2,
  Scissors,
  Printer,
  Layers,
  Plus,
  Minus,
  Paintbrush,
  FileSpreadsheet,
  Columns3,
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
import { FiniRollIcon } from '@/components/icons/FiniRollIcon'
import { TmRollIcon } from '@/components/icons/TmRollIcon'
import { BobineIcon } from '@/components/icons/BobineIcon'
import { KnitIcon } from '@/components/icons/KnitIcon'
import { cn } from '@/lib/utils'
import { formatHfsqlDate, hfsqlDateToInput, inputDateToHfsql } from '@/lib/dates'
import { fmtNum } from '@/lib/format'
import { apiFetch, API_URL } from '@/lib/api'
import { EtatPill } from '@/lib/etat-stock-fini'
import { STOCK_QUERY_FRESHNESS } from '@/lib/cache-sync'
import { useHasPermission } from '@/contexts/PermissionsContext'
import { useUser } from '@/contexts/UserContext'
import { PopoverSelect, SearchableCombobox } from '@/components/ui/popover-select'
import { CardKV, MobileSortRow } from '@/components/stock/StockCardParts'
import {
  SmartSearchInput,
  filterRowsByChips,
  type SearchChip,
} from '@/components/stock/SmartSearchInput'

// ── Types ──────────────────────────────────────────────

interface StockFiniRow {
  IDstock_fini: number
  IDref_fini: number | null
  IDColoris: number | null
  IDetat_stock_fini: number | null
  IDligne_commande_client: number | null
  IDref_commande_source: number | null
  IDstock_ecru: number | null
  IDmagasin: number | null
  IDligne_expedition: number | null
  IDProprietaire: number | null
  IDcommande_donation: number | null
  poids: number | null
  metrage: number | null
  lot: string | null
  numero: string | null
  observations: string | null
  observation_sst: string | null
  second_choix: number | null
  date_saisie: string | null
  destockage: number | null
  don: number | null
  pointage: string | null
  emplacement: string | null
  conteneur: string | null
  ref_fini: string | null
  designation: string | null
  coloris_reference: string | null
  etat_libelle: string | null
  magasin_nom: string | null
  contexture_nom: string | null
  grammage: number | null
  client_nom: string | null
  commande_numero: number | null
}

interface EtatOption {
  IDetat_stock_fini: number
  libelle: string
}

// ── API helpers ────────────────────────────────────────

// stock_fini.IDmagasin = 0 (HFSQL's "no FK") means the roll is stored at the
// factory — surface that as "Malterre" instead of an empty dash. Normalized
// here, at the query layer, so the table, the drawer, sorting AND the
// "Magasin :" search chip all agree on the label.
function withDefaultMagasin(r: StockFiniRow): StockFiniRow {
  return r.magasin_nom ? r : { ...r, magasin_nom: 'Malterre' }
}

function useStockFiniList(filters: { hideShipped: boolean }) {
  const params = new URLSearchParams()
  if (!filters.hideShipped) params.set('expedie', 'all')
  const qs = params.toString()
  return useQuery<StockFiniRow[]>({
    queryKey: ['stock-fini', filters],
    queryFn: () => apiFetch<StockFiniRow[]>(`/stock/fini${qs ? `?${qs}` : ''}`),
    select: (rows) => rows.map(withDefaultMagasin),
    ...STOCK_QUERY_FRESHNESS,
  })
}

function useStockFiniDetail(id: number | null) {
  return useQuery<StockFiniRow>({
    queryKey: ['stock-fini', 'detail', id],
    queryFn: () => apiFetch<StockFiniRow>(`/stock/fini/${id}`),
    enabled: id !== null,
    select: withDefaultMagasin,
    ...STOCK_QUERY_FRESHNESS,
  })
}

function useEtatsLookup() {
  return useQuery<EtatOption[]>({
    queryKey: ['stock-fini', 'etats'],
    queryFn: () => apiFetch<EtatOption[]>('/stock/fini/lookups/etats'),
  })
}

interface ProvenanceFil {
  ref_fil: string | null
  fournisseur: string | null
  IDcommande_fil: number | null
}

interface SstOrigin {
  sst_nom: string | null
  IDcommande: number
}

interface StockFiniProvenance {
  tricotage: SstOrigin | null
  ennoblissement: SstOrigin | null
  fils: ProvenanceFil[]
}

function useStockFiniProvenance(id: number | null) {
  return useQuery<StockFiniProvenance>({
    queryKey: ['stock-fini', 'provenance', id],
    queryFn: () => apiFetch<StockFiniProvenance>(`/stock/fini/${id}/provenance`),
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

function formatGrammage(v: number | null): string {
  if (v == null) return '—'
  return `${fmtNum(v, 0)} g/m²`
}

// ── Excel export column catalog ─────────────────────────
// Ported from RapportCommandesSst.tsx: one entry per exportable column with a
// stable `key` (persists the user's selection), header label, value getter and
// Excel column width. The user picks columns in a dialog; the choice is
// remembered per user in localStorage.

/** Parse a date string into a real JS `Date` (local midnight) so SheetJS
 *  writes a true date cell and Excel sorts chronologically. Handles both
 *  HFSQL "YYYYMMDD" and the "YYYY-MM-DD hh:mm:ss.SSS" shape the Windows ODBC
 *  driver returns for stock_fini.date_saisie. */
function dateVal(v: string | null): Date | null {
  if (!v) return null
  if (/^\d{8}$/.test(v)) {
    return new Date(Number(v.slice(0, 4)), Number(v.slice(4, 6)) - 1, Number(v.slice(6, 8)))
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const d = new Date(v)
  return isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Round to 2 decimals, keeping numbers as numbers so Excel can sum them. */
const round2cell = (v: number | null): number | '' => (v == null ? '' : Math.round(v * 100) / 100)

interface ExportColumn {
  key: string
  label: string
  width: number
  /** 'date' columns emit real `Date` cells so Excel sorts them chronologically. */
  kind?: 'date'
  value: (r: StockFiniRow) => string | number | Date | null
}
const EXPORT_COLUMNS: ExportColumn[] = [
  { key: 'reference', label: 'Référence', width: 12, value: (r) => r.ref_fini || '' },
  { key: 'coloris', label: 'Coloris', width: 20, value: (r) => r.coloris_reference || '' },
  { key: 'contexture', label: 'Contexture', width: 14, value: (r) => r.contexture_nom || '' },
  { key: 'grammage', label: 'Grammage (g/m²)', width: 14, value: (r) => r.grammage ?? '' },
  { key: 'numero', label: 'Numéro', width: 10, value: (r) => r.numero || '' },
  { key: 'poids', label: 'Poids (kg)', width: 10, value: (r) => round2cell(r.poids) },
  { key: 'metrage', label: 'Métrage (m)', width: 11, value: (r) => round2cell(r.metrage) },
  { key: 'lot', label: 'Lot', width: 12, value: (r) => r.lot || '' },
  { key: 'client', label: 'Client', width: 22, value: (r) => r.client_nom || '' },
  { key: 'magasin', label: 'Magasin', width: 14, value: (r) => r.magasin_nom || '' },
  { key: 'commande', label: 'N° Cmd', width: 8, value: (r) => r.commande_numero ?? '' },
  { key: 'etat', label: 'État', width: 12, value: (r) => r.etat_libelle || '' },
  { key: 'emplacement', label: 'Emplacement', width: 12, value: (r) => r.emplacement || '' },
  { key: 'conteneur', label: 'Conteneur', width: 12, value: (r) => r.conteneur || '' },
  { key: 'date_saisie', label: 'Date saisie', width: 11, kind: 'date', value: (r) => dateVal(r.date_saisie) },
  // HFSQL stores " " for "no text" — trim so those cells are truly empty.
  { key: 'observations', label: 'Observations', width: 40, value: (r) => r.observations?.trim() || '' },
  { key: 'observation_sst', label: 'Observation sous-traitant', width: 30, value: (r) => r.observation_sst?.trim() || '' },
  { key: 'second_choix', label: '2ᵉ choix', width: 9, value: (r) => (r.second_choix ? 'Oui' : '') },
  { key: 'don', label: 'Don', width: 6, value: (r) => (r.don ? 'Oui' : '') },
  { key: 'destockage', label: 'Déstockage', width: 11, value: (r) => (r.destockage ? 'Oui' : '') },
]
const EXPORT_COLUMN_KEYS = EXPORT_COLUMNS.map((c) => c.key)

// Persisted column selection, keyed by user id so people sharing (or
// switching users on) a PC don't overwrite each other's choice. Temporary:
// localStorage only — replace with a server-side per-user preference once
// proper user management lands post-migration.
const EXPORT_PREF_KEY_BASE = 'mps:finis-stock:export-columns'
const exportPrefKey = (userId: number | null) =>
  userId == null ? EXPORT_PREF_KEY_BASE : `${EXPORT_PREF_KEY_BASE}:${userId}`

function loadExportSelection(userId: number | null): string[] {
  try {
    const raw =
      localStorage.getItem(exportPrefKey(userId)) ??
      localStorage.getItem(EXPORT_PREF_KEY_BASE)
    if (!raw) return EXPORT_COLUMN_KEYS
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return EXPORT_COLUMN_KEYS
    // Keep only keys that still exist (and in canonical column order), so a
    // stored selection survives future column additions/removals gracefully.
    const stored = new Set(parsed.filter((k): k is string => typeof k === 'string'))
    const kept = EXPORT_COLUMN_KEYS.filter((k) => stored.has(k))
    return kept.length > 0 ? kept : EXPORT_COLUMN_KEYS
  } catch {
    return EXPORT_COLUMN_KEYS
  }
}

function saveExportSelection(userId: number | null, keys: string[]): void {
  try {
    localStorage.setItem(exportPrefKey(userId), JSON.stringify(keys))
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

// ── Sort handling ──────────────────────────────────────

type SortKey =
  | 'ref_fini'
  | 'coloris_reference'
  | 'contexture_nom'
  | 'grammage'
  | 'numero'
  | 'poids'
  | 'metrage'
  | 'lot'
  | 'client_nom'
  | 'magasin_nom'
  | 'commande_numero'
  | 'etat_libelle'
  | 'emplacement'
  | 'date_saisie'
  | 'observations'

interface SortState {
  key: SortKey
  dir: 'asc' | 'desc'
}

// Column set mirrors the legacy WinDev stock fini grid (Référence → 2nd choix),
// plus the État column the new app adds. Widths are proportional ratios —
// table-layout: fixed normalizes them across the shared header/body colgroups.
const COLUMNS: { key: SortKey; label: string; width: string; align?: 'left' | 'right' }[] = [
  { key: 'ref_fini', label: 'Référence', width: '8%' },
  { key: 'coloris_reference', label: 'Coloris', width: '11%' },
  { key: 'contexture_nom', label: 'Contexture', width: '8%' },
  { key: 'grammage', label: 'Grammage', width: '6%', align: 'right' },
  { key: 'numero', label: 'Numéro', width: '6%' },
  { key: 'poids', label: 'Poids', width: '6%', align: 'right' },
  { key: 'metrage', label: 'Métrage', width: '6%', align: 'right' },
  { key: 'lot', label: 'Lot', width: '7%' },
  { key: 'client_nom', label: 'Client', width: '9%' },
  { key: 'magasin_nom', label: 'Magasin', width: '7%' },
  { key: 'commande_numero', label: 'N° Cmd', width: '6%', align: 'right' },
  { key: 'etat_libelle', label: 'État', width: '9%' },
  { key: 'emplacement', label: 'Emplacement', width: '7%' },
  { key: 'date_saisie', label: 'Date saisie', width: '7%' },
  { key: 'observations', label: 'Observations', width: '8%' },
]
const ICON_COL_WIDTH = '3%'
const SELECT_COL_WIDTH = '4%' // leading selection box column, edit mode only

// ── Field-scoped search chips ──────────────────────────
// The toolbar search accepts field-scoped chips ("Emplacement : BD") on top of
// the free-text multi-term search. Widget + chip semantics live in the shared
// `SmartSearchInput` (see its header comment); this screen only declares which
// of its columns can be scoped.
const SEARCH_FIELDS = [
  { key: 'ref_fini', label: 'Référence' },
  { key: 'coloris_reference', label: 'Coloris' },
  { key: 'lot', label: 'Lot' },
  { key: 'numero', label: 'Numéro' },
  { key: 'client_nom', label: 'Client' },
  { key: 'magasin_nom', label: 'Magasin' },
  { key: 'etat_libelle', label: 'État' },
  { key: 'emplacement', label: 'Emplacement' },
  { key: 'conteneur', label: 'Conteneur' },
  { key: 'contexture_nom', label: 'Contexture' },
  { key: 'observations', label: 'Observations' },
] as const
type SearchFieldKey = (typeof SEARCH_FIELDS)[number]['key']

/** Lower-cased text columns of a row, for the any-column match. */
function rowHaystacks(r: StockFiniRow): string[] {
  return [
    r.ref_fini,
    r.coloris_reference,
    r.contexture_nom,
    r.lot,
    r.numero,
    r.emplacement,
    r.conteneur,
    r.client_nom,
    r.magasin_nom,
    r.observations,
    r.observation_sst,
  ]
    .filter((f): f is string => !!f)
    .map((f) => f.toLowerCase())
}

// One shared collator — constructing the Intl collation options on every
// String.localeCompare() call (≈14k calls to sort 1.4k rows) is a measurable
// per-sort cost; a cached Intl.Collator.compare is far cheaper.
const ROW_COLLATOR = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' })

function compareRows(a: StockFiniRow, b: StockFiniRow, key: SortKey): number {
  const va = a[key]
  const vb = b[key]
  if (va == null && vb == null) return 0
  if (va == null) return 1
  if (vb == null) return -1
  if (typeof va === 'number' && typeof vb === 'number') return va - vb
  return ROW_COLLATOR.compare(String(va), String(vb))
}

// ── Main Page ──────────────────────────────────────────

export function FinisStock() {
  const queryClient = useQueryClient()
  const [searchQuery, setSearchQuery] = useState('')
  // Field-scoped chips (see SEARCH_FIELDS above).
  const [searchChips, setSearchChips] = useState<SearchChip<SearchFieldKey>[]>([])
  const [hideShipped, setHideShipped] = useState(true)
  const [sort, setSort] = useState<SortState>({ key: 'date_saisie', dir: 'desc' })
  const [selectedId, setSelectedId] = useState<number | null>(null)

  // Permission gates — admins always pass; non-admins need the matching key.
  // The API enforces the same keys independently.
  const canCut = useHasPermission('cut_stock_fini')
  const canCreate = useHasPermission('create_stock_fini')
  const canSurteindre = useHasPermission('surteindre_stock_fini')
  // Batch edit ("Édition groupée") writes emplacement/observations, so it needs
  // edit_stock_fini plus at least one of the two matching sub-permissions.
  const canEditRolls = useHasPermission('edit_stock_fini')
  const hasStockageSub = useHasPermission('edit_stock_fini_stockage')
  const hasNotesSub = useHasPermission('edit_stock_fini_notes')
  const canBatchStockage = canEditRolls && hasStockageSub
  const canBatchNotes = canEditRolls && hasNotesSub
  const canBatchEdit = canBatchStockage || canBatchNotes
  const [createOpen, setCreateOpen] = useState(false)

  // Edit mode — multi-roll selection.
  const [isEditing, setIsEditing] = useState(false)
  const [selectedRollIds, setSelectedRollIds] = useState<Set<number>>(new Set())
  const lastSelectedRollIdRef = useRef<number | null>(null)
  const [cutOpen, setCutOpen] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)
  const [surteindreOpen, setSurteindreOpen] = useState(false)
  // The edit-mode toggle re-renders the whole (large) table; mark it as a
  // transition so the click stays responsive instead of freezing the UI.
  const [, startModeTransition] = useTransition()

  const { data: rows, isLoading, isError, error } = useStockFiniList({ hideShipped })

  // Defer the search term so each keystroke updates the input instantly while
  // the (expensive) 1.4k-row filter+sort+reconcile runs at lower priority.
  const deferredSearch = useDeferredValue(searchQuery)

  const filteredSorted = useMemo(() => {
    // Field-scoped chips first (each chip ANDs, restricted to its column),
    // then the free text: split on whitespace and require EVERY term to match
    // SOME column (AND across terms, OR across columns). This lets one search
    // combine criteria from different columns — e.g. "029A marine" matches a
    // row whose ref_fini is "029A" AND whose coloris is "marine".
    let out = filterRowsByChips(rows ?? [], searchChips, rowHaystacks)
    const terms = deferredSearch.trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (terms.length > 0) {
      out = out.filter((r) => {
        const haystacks = rowHaystacks(r)
        return terms.every((t) => haystacks.some((h) => h.includes(t)))
      })
    }
    out = [...out].sort((a, b) => {
      const cmp = compareRows(a, b, sort.key)
      return sort.dir === 'asc' ? cmp : -cmp
    })
    return out
  }, [rows, deferredSearch, searchChips, sort])

  const handleSort = useCallback((key: SortKey) => {
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
  }, [])

  // Excel export of the currently visible (chips + search-filtered + sorted)
  // rows. Clicking "Exporter" opens a column-picker dialog; the actual export
  // (SheetJS lazy-loaded so it stays out of the main bundle) runs on confirm,
  // limited to the columns the user selected. The selection is remembered.
  const [exporting, setExporting] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const { user } = useUser()
  const userId = user?.IDutilisateur ?? null
  const [exportCols, setExportCols] = useState<string[]>(() => loadExportSelection(userId))

  // Re-read the saved selection if the logged-in user changes (user picker /
  // admin impersonation) without the page remounting.
  useEffect(() => {
    setExportCols(loadExportSelection(userId))
  }, [userId])

  const handleExport = useCallback(async () => {
    if (filteredSorted.length === 0) return
    // Keep canonical column order regardless of click order, and never export
    // an empty workbook (guarded again at the button, belt-and-suspenders).
    const cols = EXPORT_COLUMNS.filter((c) => exportCols.includes(c.key))
    if (cols.length === 0) return
    setExporting(true)
    try {
      const XLSX = await import('xlsx')
      const aoa: (string | number | Date | null)[][] = [
        cols.map((c) => c.label),
        ...filteredSorted.map((r) => cols.map((c) => c.value(r))),
      ]
      // cellDates → Date values become real date cells so Excel sorts them
      // chronologically instead of lexically on the French display string.
      const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true })
      ws['!cols'] = cols.map((c) => ({ wch: c.width }))
      cols.forEach((c, colIdx) => {
        if (c.kind !== 'date') return
        for (let rowIdx = 1; rowIdx <= filteredSorted.length; rowIdx++) {
          const cell = ws[XLSX.utils.encode_cell({ r: rowIdx, c: colIdx })]
          if (cell && cell.t === 'd') cell.z = 'dd/mm/yyyy'
        }
      })
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'Stock finis')
      const stamp = new Date().toISOString().slice(0, 10)
      XLSX.writeFile(wb, `Stock_finis_${stamp}.xlsx`)
      saveExportSelection(userId, exportCols)
      setExportOpen(false)
    } catch (err) {
      console.error('Export Excel échoué:', err)
    } finally {
      setExporting(false)
    }
  }, [filteredSorted, exportCols, userId])

  const toggleExportCol = useCallback((key: string) => {
    setExportCols((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    )
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

  // Depend on the STABLE guard.guardAction, not the whole `guard` object —
  // useUnsavedGuard returns a fresh object literal every render, so listing
  // `[guard]` here would change these callbacks' identity on every render and
  // defeat the React.memo on StockRow (forcing all ~1.4k rows to re-render on
  // every parent render).
  const handleClose = useCallback(() => {
    guard.guardAction(() => setSelectedId(null))
  }, [guard.guardAction])

  const handleRowClick = useCallback((rowId: number) => {
    guard.guardAction(() => {
      setSelectedId((prev) => (prev === rowId ? null : rowId))
    })
  }, [guard.guardAction])

  // Anchor-based multi-select (mirrors the "Affecté" tab of the sst drawer):
  // plain click toggles the row and becomes the anchor; Shift+click applies the
  // inclusive range between the anchor and the clicked row, in the current
  // sort/filter order. The range operation is add-or-remove depending on the
  // clicked row's current state: Shift+clicking an already-selected row
  // deselects the whole range (so re-clicking the end of a range clears it).
  const handleSelectRoll = useCallback((id: number, shiftKey: boolean) => {
    const ids = filteredSorted.map((r) => r.IDstock_fini)
    const anchor = lastSelectedRollIdRef.current
    if (shiftKey && anchor !== null && anchor !== id) {
      const a = ids.indexOf(anchor)
      const b = ids.indexOf(id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setSelectedRollIds((prev) => {
          const next = new Set(prev)
          const deselect = prev.has(id) // clicked end already selected → clear the range
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

  // Single, stable per-row click handler. Reading the mode from a ref (mirrored
  // each render) keeps this callback's identity stable across edit-mode toggles
  // and selection changes, so StockRow's memo isn't busted and toggling edit
  // mode does NOT pass a changed prop to every row. The row's view ↔ edit
  // presentation is driven purely by CSS (a data-editing attribute on <tbody>),
  // so flipping edit mode re-renders zero rows.
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
    // Close the drawer first (guarded, so unsaved drawer edits prompt).
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
    queryClient.invalidateQueries({ queryKey: ['stock-fini'] })
  }, [queryClient])

  // The single selected roll (only when exactly one is selected) — drives the
  // "Couper" button + cut dialog.
  const selectedRow =
    selectedRollIds.size === 1
      ? filteredSorted.find((r) => r.IDstock_fini === [...selectedRollIds][0]) ?? null
      : null

  // Totalizer over the currently-visible (filtered) rows
  const rollCount = filteredSorted.length
  const totalPoids = filteredSorted.reduce((sum, r) => sum + (r.poids ?? 0), 0)
  const totalMetrage = filteredSorted.reduce((sum, r) => sum + (r.metrage ?? 0), 0)

  // Selection summary (edit mode) — shown inside the totalizer card.
  const selectedRows = isEditing
    ? filteredSorted.filter((r) => selectedRollIds.has(r.IDstock_fini))
    : []
  const selCount = selectedRows.length
  const selPoids = selectedRows.reduce((sum, r) => sum + (r.poids ?? 0), 0)
  const selMetrage = selectedRows.reduce((sum, r) => sum + (r.metrage ?? 0), 0)

  // Surteinture acts on one ref/coloris batch at a time, so the selection must be
  // homogeneous (same ref + coloris). A single roll is allowed, like the legacy app.
  const selectionHomogeneous =
    selCount >= 1 &&
    selectedRows.every(
      (r) =>
        r.IDref_fini === selectedRows[0].IDref_fini &&
        (r.coloris_reference ?? '') === (selectedRows[0].coloris_reference ?? ''),
    )

  return (
    <div className="h-full flex flex-col gap-3 min-h-0">
      {/* Toolbar — below sm: search + actions share row 1 (actions stay top-right),
          badge and filter checkbox wrap below. Desktop order/pixels unchanged. */}
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
        <SmartSearchInput<SearchFieldKey>
          className="order-1 sm:order-2 flex-1 min-w-0"
          value={searchQuery}
          onValueChange={setSearchQuery}
          chips={searchChips}
          onChipsChange={setSearchChips}
          fields={SEARCH_FIELDS}
          placeholder="Rechercher (réf, coloris, contexture, lot, numéro, client, magasin, emplacement, observations…)"
        />

        <label className="flex items-center gap-2 text-sm cursor-pointer select-none flex-shrink-0 order-4 sm:order-3 w-full sm:w-auto">
          <input
            type="checkbox"
            checked={hideShipped}
            onChange={(e) => setHideShipped(e.target.checked)}
            className="h-4 w-4 rounded border-input text-accent focus:ring-2 focus:ring-ring cursor-pointer"
          />
          <span>Masquer les rouleaux expédiés</span>
        </label>

        {!isEditing ? (
          <div className="flex items-center gap-2 flex-shrink-0 order-2 sm:order-4">
            <Button
              variant="outline"
              size="icon"
              onClick={() => setExportOpen(true)}
              disabled={filteredSorted.length === 0}
              title="Exporter Excel"
              className="h-8 w-8 bg-white flex-shrink-0"
            >
              <FileSpreadsheet className="h-4 w-4" />
            </Button>
            {canCreate && (
              <Button size="sm" onClick={() => setCreateOpen(true)} title="Nouveau">
                <Plus className="h-3.5 w-3.5 sm:mr-1" />
                <span className="hidden sm:inline">Nouveau</span>
              </Button>
            )}
            <Button variant="gold" size="sm" onClick={enterEditMode} title="Modifier">
              <Pencil className="h-3.5 w-3.5 sm:mr-1.5" />
              <span className="hidden sm:inline">Modifier</span>
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-2 flex-shrink-0 order-2 sm:order-4">
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
            {canBatchEdit && selectedRollIds.size > 1 && (
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
            {canSurteindre && selectionHomogeneous && (
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 flex-shrink-0"
                title="Surteindre les rouleaux sélectionnés"
                onClick={() => setSurteindreOpen(true)}
              >
                <Paintbrush className="h-4 w-4" />
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
            <table className="w-full text-xs" style={{ tableLayout: 'fixed' }}>
              <colgroup>
                {/* Selection column: always present (kept structurally stable so
                    toggling edit mode doesn't mount/unmount a cell on every row),
                    collapsed to 0 width in view mode. */}
                <col style={{ width: isEditing ? SELECT_COL_WIDTH : '0' }} />
                {COLUMNS.map((c) => (
                  <col key={c.key} style={{ width: c.width }} />
                ))}
                <col style={{ width: ICON_COL_WIDTH }} />
              </colgroup>
              <thead className="bg-zinc-200/60 border-b border-border/60">
                <tr className="text-xs text-muted-foreground">
                  <th className={isEditing ? 'px-3 py-2.5' : 'p-0'}></th>
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
              <table className="w-full text-xs" style={{ tableLayout: 'fixed' }}>
                <colgroup>
                  <col style={{ width: isEditing ? SELECT_COL_WIDTH : '0' }} />
                  {COLUMNS.map((c) => (
                    <col key={c.key} style={{ width: c.width }} />
                  ))}
                  <col style={{ width: ICON_COL_WIDTH }} />
                </colgroup>
                <tbody className="group" data-editing={isEditing ? 'true' : 'false'}>
                  {filteredSorted.map((r) => (
                    <StockRow
                      key={r.IDstock_fini}
                      row={r}
                      selected={
                        isEditing ? selectedRollIds.has(r.IDstock_fini) : r.IDstock_fini === selectedId
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
                  <StockFiniCard
                    key={r.IDstock_fini}
                    row={r}
                    selected={
                      isEditing ? selectedRollIds.has(r.IDstock_fini) : r.IDstock_fini === selectedId
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
          Below sm the "Poids/Métrage total" labels disappear (the kg/Ml units
          are self-explanatory) and values shrink one step so the whole bar
          stays on ONE line even at 345px. The edit-mode selection summary gets
          its own row. Desktop (sm+) unchanged. */}
      {!isLoading && !isError && filteredSorted.length > 0 && (
        <div className="flex-shrink-0 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 bg-zinc-100/80 shadow-sm px-4 py-2.5">
          <div className={cn('flex flex-wrap items-center gap-2 text-sm', selCount > 0 && 'w-full sm:w-auto')}>
            <Package className="h-4 w-4 text-accent" />
            <span className="font-semibold">{rollCount}</span>
            <span className="text-muted-foreground">rouleau{rollCount > 1 ? 'x' : ''}</span>
            {selCount > 0 && (
              <span className="w-full sm:w-auto sm:ml-3 sm:pl-3 sm:border-l border-border/60 flex flex-wrap items-center gap-1.5 text-accent">
                <Check className="h-3.5 w-3.5" />
                <span className="font-semibold tabular-nums">{selCount}</span>
                <span>sélectionné{selCount > 1 ? 's' : ''}</span>
                <span className="text-muted-foreground/50">·</span>
                <span className="font-medium tabular-nums">{fmtNum(selPoids, 1)} kg</span>
                <span className="text-muted-foreground/50">·</span>
                <span className="font-medium tabular-nums">{fmtNum(selMetrage, 1)} Ml</span>
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 sm:gap-5">
            <div className="flex items-baseline gap-1.5 sm:gap-2">
              <span className="hidden sm:inline text-xs uppercase tracking-wide text-muted-foreground whitespace-nowrap">Poids total</span>
              <span className="text-sm sm:text-base font-bold tabular-nums whitespace-nowrap">{fmtNum(totalPoids, 1)} kg</span>
            </div>
            <div className="flex items-baseline gap-1.5 sm:gap-2 border-l border-border/60 pl-3 sm:pl-5">
              <span className="hidden sm:inline text-xs uppercase tracking-wide text-muted-foreground whitespace-nowrap">Métrage total</span>
              <span className="text-sm sm:text-base font-bold tabular-nums whitespace-nowrap">{fmtNum(totalMetrage, 1)} Ml</span>
            </div>
          </div>
        </div>
      )}

      <StockFiniDrawer
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
        canStockage={canBatchStockage}
        canNotes={canBatchNotes}
        onClose={() => setBatchOpen(false)}
        onSuccess={() => {
          onMutationSuccess()
          setBatchOpen(false)
          setSelectedRollIds(new Set())
          lastSelectedRollIdRef.current = null
        }}
      />

      <SurteindreDialog
        open={surteindreOpen}
        ids={[...selectedRollIds]}
        refLabel={selectedRows[0]?.ref_fini ?? null}
        colorisLabel={selectedRows[0]?.coloris_reference ?? null}
        onClose={() => setSurteindreOpen(false)}
        onSuccess={() => {
          onMutationSuccess()
          setSurteindreOpen(false)
          exitEditMode()
        }}
      />

      <CreateFiniRollDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(newId) => {
          setCreateOpen(false)
          onMutationSuccess()
          if (newId && newId > 0) setSelectedId(newId)
        }}
      />

      {/* Column-picker dialog for the Excel export (same UX as Rapport sst) */}
      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent className="max-w-md" onClose={() => setExportOpen(false)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Columns3 className="h-5 w-5 text-accent" />
              Colonnes à exporter
            </DialogTitle>
          </DialogHeader>

          <div className="mt-4 space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                {exportCols.length} colonne{exportCols.length > 1 ? 's' : ''} sélectionnée
                {exportCols.length > 1 ? 's' : ''}
              </p>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-accent hover:text-accent hover:bg-accent/10"
                  onClick={() => setExportCols(EXPORT_COLUMN_KEYS)}
                >
                  Tout sélectionner
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs text-muted-foreground"
                  onClick={() => setExportCols([])}
                >
                  Tout désélectionner
                </Button>
              </div>
            </div>

            <div className="max-h-[50vh] overflow-y-auto scrollbar-transparent rounded-md border border-border/60 divide-y divide-border/40">
              {EXPORT_COLUMNS.map((c) => {
                const checked = exportCols.includes(c.key)
                return (
                  <label
                    key={c.key}
                    className="flex items-center gap-2.5 px-3 py-2 text-sm cursor-pointer select-none hover:bg-accent/5 transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleExportCol(c.key)}
                      className="h-4 w-4 rounded border-input text-accent focus:ring-2 focus:ring-ring cursor-pointer"
                    />
                    <span>{c.label}</span>
                  </label>
                )
              })}
            </div>
          </div>

          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setExportOpen(false)}>
              Annuler
            </Button>
            <Button onClick={handleExport} disabled={exporting || exportCols.length === 0}>
              {exporting ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <FileSpreadsheet className="h-3.5 w-3.5 mr-1.5" />
              )}
              Exporter
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

// ── Cut-roll dialog ────────────────────────────────────
// Split one physical roll into N rolls. Pieces 1..N-1 are editable; the LAST
// piece is auto-computed as the remainder so the weight & length totals always
// equal the original (value conservation). Piece 1 keeps the original numero;
// the others preview as "<base>-2", "<base>-3", …

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
  row: StockFiniRow | null
  onClose: () => void
  onSuccess: () => void
}) {
  // `editable` holds the first N-1 pieces (the user-controlled ones). The last
  // piece is always derived. Two editable entries → 3 pieces total by default? No:
  // we start with ONE editable + the auto remainder = 2 pieces total.
  const [editable, setEditable] = useState<CutPieceDraft[]>([{ poids: '', metrage: '' }])

  const origId = row?.IDstock_fini ?? null
  // Reset the draft whenever the dialog opens for a different roll.
  useEffect(() => {
    if (open) setEditable([{ poids: '', metrage: '' }])
  }, [open, origId])

  const origPoids = Number(row?.poids) || 0
  const origMetrage = Number(row?.metrage) || 0
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
  const valid = !negative && editable.every((p) => p.poids.trim() !== '' && p.metrage.trim() !== '')

  const cutMutation = useMutation({
    mutationFn: () => {
      const pieces = [
        ...editable.map((p) => ({ poids: num(p.poids), metrage: num(p.metrage) })),
        { poids: Math.max(0, lastPoids), metrage: Math.max(0, lastMetrage) },
      ]
      return apiFetch(`/stock/fini/${origId}/cut`, {
        method: 'POST',
        body: JSON.stringify({ pieces }),
      })
    },
    onSuccess: () => onSuccess(),
  })

  const pieceLabel = (idx: number) => (idx === 0 ? row?.numero || base : `${base}-${idx + 1}`)
  const totalPieces = editable.length + 1

  // Cross-multiplication (règle de trois): a cut preserves the original roll's
  // linear density, so poids and metrage stay proportional. Editing one field
  // auto-fills the other from the original ratio. Guarded against a zero
  // original dimension (can't derive a ratio from 0).
  const round2 = (v: number) => Math.round(v * 100) / 100
  const mPerKg = origPoids > 0 ? origMetrage / origPoids : 0
  const kgPerM = origMetrage > 0 ? origPoids / origMetrage : 0

  const setPoids = (idx: number, value: string) =>
    setEditable((prev) =>
      prev.map((p, i) => {
        if (i !== idx) return p
        if (value.trim() === '') return { poids: '', metrage: origPoids > 0 ? '' : p.metrage }
        const metrage = origPoids > 0 ? String(round2(num(value) * mPerKg)) : p.metrage
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
              {row?.ref_fini ?? '—'}
              {row?.coloris_reference ? ` · ${row.coloris_reference}` : ''}
            </div>
            <div className="text-xs text-muted-foreground tabular-nums mt-0.5">
              Original : {fmtNum(origPoids, 1)} kg · {fmtNum(origMetrage, 1)} m
            </div>
          </div>

          {/* Piece rows */}
          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2 px-1 text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
              <span>Numéro</span>
              <span className="w-24 text-right">Poids (kg)</span>
              <span className="w-24 text-right">Métrage (m)</span>
              <span className="w-6" />
            </div>

            {editable.map((p, idx) => (
              <div key={idx} className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2">
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
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  value={p.metrage}
                  onChange={(e) => setMetrage(idx, e.target.value)}
                  className="h-8 w-24 px-2 text-sm text-right rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
                />
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
            <div className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-2">
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
              <span
                className={cn(
                  'h-8 w-24 px-2 inline-flex items-center justify-end text-sm tabular-nums rounded-md border bg-zinc-100/60',
                  lastMetrage < -0.0001 ? 'border-destructive text-destructive' : 'border-border/60 text-muted-foreground',
                )}
              >
                {fmtNum(lastMetrage, 1)}
              </span>
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
                  {totalPieces} morceaux · {fmtNum(origPoids, 1)} kg · {fmtNum(origMetrage, 1)} m
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
// "Édition groupée": apply an emplacement and/or observation to every selected
// roll at once. Each field is gated by a toggle — only enabled fields are
// written (an enabled-but-empty field clears the value), so the user can set
// one field without wiping the other.

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
  canStockage,
  canNotes,
  onClose,
  onSuccess,
}: {
  open: boolean
  ids: number[]
  /** edit_stock_fini_stockage — gates the Emplacement field */
  canStockage: boolean
  /** edit_stock_fini_notes — gates the Observation field */
  canNotes: boolean
  onClose: () => void
  onSuccess: () => void
}) {
  const [editEmplacement, setEditEmplacement] = useState(false)
  const [emplacement, setEmplacement] = useState('')
  const [editObservations, setEditObservations] = useState(false)
  const [observations, setObservations] = useState('')

  const count = ids.length

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (open) {
      setEditEmplacement(false)
      setEmplacement('')
      setEditObservations(false)
      setObservations('')
    }
  }, [open])

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch('/stock/fini/batch', {
        method: 'PATCH',
        body: JSON.stringify({
          ids,
          ...(canStockage && editEmplacement ? { emplacement } : {}),
          ...(canNotes && editObservations ? { observations } : {}),
        }),
      }),
    onSuccess: () => onSuccess(),
  })

  const valid = ((canStockage && editEmplacement) || (canNotes && editObservations)) && count > 0

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
              rouleau{count > 1 ? 'x' : ''} sélectionné{count > 1 ? 's' : ''}
            </span>
          </div>

          <p className="text-xs text-muted-foreground">
            Activez un champ pour l'appliquer à tous les rouleaux sélectionnés. Un champ activé
            mais vide efface la valeur existante.
          </p>

          {/* Emplacement — needs the Stockage sub-permission */}
          {canStockage && (
          <div
            className={cn(
              'rounded-lg border p-3',
              editEmplacement ? 'border-l-4 border-l-accent/70 bg-accent/[0.03]' : 'border-border/60',
            )}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <MapPin className="h-3.5 w-3.5 text-accent" />
                Emplacement
              </div>
              <SwitchPill value={editEmplacement} onChange={setEditEmplacement} />
            </div>
            {editEmplacement && (
              <input
                type="text"
                value={emplacement}
                onChange={(e) => setEmplacement(e.target.value)}
                placeholder="Nouvel emplacement"
                className="mt-2 h-8 w-full px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
              />
            )}
          </div>
          )}

          {/* Observation — needs the Notes sub-permission */}
          {canNotes && (
          <div
            className={cn(
              'rounded-lg border p-3',
              editObservations ? 'border-l-4 border-l-accent/70 bg-accent/[0.03]' : 'border-border/60',
            )}
          >
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
          )}

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

// ── Surteinture (over-dye) dialog ──────────────────────
// Send finished rolls back to dyeing: the modal shows the finished pieces that
// will be deleted (left) and their tombé-de-métier (écru) rows that will be
// modified (right). Validating appends a trace observation to each écru, can
// change its coloris + magasin, and deletes the finished rolls so the écru
// returns to available stock for a fresh dyeing cycle. Mirrors the legacy
// FEN_Surteinture window. Selection is constrained to one ref + coloris.
interface SurteindrePreviewRow {
  IDstock_fini: number
  skipped: boolean
  fini: { numero: string; poids: number; metrage: number; lot: string; client: string }
  ecru: {
    IDstock_ecru: number
    numero: string
    ref_ecru: string
    coloris: string
    poids: number
    magasin_nom: string
    client: string
  } | null
  computedObservation: string
}
interface SurteindrePreview {
  rows: SurteindrePreviewRow[]
}

function SurteindreDialog({
  open,
  ids,
  refLabel,
  colorisLabel,
  onClose,
  onSuccess,
}: {
  open: boolean
  ids: number[]
  refLabel: string | null
  colorisLabel: string | null
  onClose: () => void
  onSuccess: () => void
}) {
  const count = ids.length

  const idsKey = ids.join(',')
  const previewQuery = useQuery<SurteindrePreview>({
    queryKey: ['stock-fini', 'surteindre-preview', idsKey],
    queryFn: () =>
      apiFetch<SurteindrePreview>('/stock/fini/surteindre/preview', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      }),
    enabled: open && count > 0,
  })

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch('/stock/fini/surteindre', {
        method: 'POST',
        body: JSON.stringify({ ids }),
      }),
    onSuccess: () => onSuccess(),
  })

  const rows = previewQuery.data?.rows ?? []
  const skippedCount = rows.filter((r) => r.skipped).length
  const actionableCount = rows.length - skippedCount
  const valid = actionableCount > 0 && !previewQuery.isLoading

  return (
    <Dialog open={open && count > 0} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-7xl w-[95vw] max-h-[90dvh] overflow-y-auto" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Paintbrush className="h-5 w-5 text-accent" />
            Surteinture
            {(refLabel || colorisLabel) && (
              <span className="text-muted-foreground font-normal">
                — {refLabel ?? ''}
                {colorisLabel ? ` · ${colorisLabel}` : ''}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="mt-4">
          {previewQuery.isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-accent" />
            </div>
          ) : previewQuery.isError ? (
            <div className="flex flex-col items-center justify-center py-12 text-destructive gap-2">
              <AlertCircle className="h-6 w-6" />
              <p className="text-sm">
                {(previewQuery.error as Error)?.message || 'Erreur de chargement'}
              </p>
            </div>
          ) : (
            <div className="flex gap-4">
              {/* Left: finished pieces to delete */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-2">
                  <FiniRollIcon className="h-4 w-4 text-accent" />
                  <h3 className="text-sm font-semibold">Pièces fini à supprimer</h3>
                </div>
                <div className="rounded-lg border border-border/60 overflow-hidden">
                  <div className="max-h-[60vh] overflow-auto scrollbar-transparent">
                    <table className="w-full text-sm">
                      <thead className="bg-zinc-200/60 text-xs uppercase tracking-wide text-muted-foreground">
                        <tr>
                          <th className="px-2.5 py-2 text-left font-semibold">Numéro</th>
                          <th className="px-2.5 py-2 text-right font-semibold">Poids</th>
                          <th className="px-2.5 py-2 text-right font-semibold">Métrage</th>
                          <th className="px-2.5 py-2 text-left font-semibold">Lot</th>
                          <th className="px-2.5 py-2 text-left font-semibold">Client</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr
                            key={r.IDstock_fini}
                            className={cn(
                              'border-b border-border/40 line-through text-destructive/70 decoration-destructive/60',
                              r.skipped && 'opacity-40',
                            )}
                          >
                            <td className="px-2.5 py-1.5 truncate">{r.fini.numero || '—'}</td>
                            <td className="px-2.5 py-1.5 text-right tabular-nums">
                              {fmtNum(r.fini.poids, 2)} kg
                            </td>
                            <td className="px-2.5 py-1.5 text-right tabular-nums">
                              {fmtNum(r.fini.metrage, 2)} m
                            </td>
                            <td className="px-2.5 py-1.5 truncate">{r.fini.lot || '—'}</td>
                            <td className="px-2.5 py-1.5 truncate">{r.fini.client || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              {/* Right: tombé-de-métier pieces to modify */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-2">
                  <TmRollIcon className="h-4 w-4 text-accent" />
                  <h3 className="text-sm font-semibold">Pièces tombé de métier à modifier</h3>
                </div>
                <div className="rounded-lg border border-border/60 overflow-hidden">
                  <div className="max-h-[60vh] overflow-auto scrollbar-transparent">
                    <table className="w-full text-sm">
                      <thead className="bg-zinc-200/60 text-xs uppercase tracking-wide text-muted-foreground">
                        <tr>
                          <th className="px-2.5 py-2 text-left font-semibold">Numéro</th>
                          <th className="px-2.5 py-2 text-left font-semibold">Réf</th>
                          <th className="px-2.5 py-2 text-left font-semibold">Coloris</th>
                          <th className="px-2.5 py-2 text-right font-semibold">Poids</th>
                          <th className="px-2.5 py-2 text-left font-semibold">Magasin</th>
                          <th className="px-2.5 py-2 text-left font-semibold">Observation</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((r) => (
                          <tr key={r.IDstock_fini} className="border-b border-border/40">
                            {r.ecru ? (
                              <>
                                <td className="px-2.5 py-1.5 truncate">{r.ecru.numero || '—'}</td>
                                <td className="px-2.5 py-1.5 truncate">{r.ecru.ref_ecru || '—'}</td>
                                <td className="px-2.5 py-1.5 truncate">{r.ecru.coloris || '—'}</td>
                                <td className="px-2.5 py-1.5 text-right tabular-nums">
                                  {fmtNum(r.ecru.poids, 2)} kg
                                </td>
                                <td className="px-2.5 py-1.5 truncate">{r.ecru.magasin_nom || '—'}</td>
                                <td
                                  className="px-2.5 py-1.5 truncate text-muted-foreground"
                                  title={r.computedObservation}
                                >
                                  {r.computedObservation}
                                </td>
                              </>
                            ) : (
                              <td
                                colSpan={6}
                                className="px-2.5 py-1.5 text-destructive/70 italic"
                              >
                                Aucun tombé de métier lié — ignoré
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          )}

          {skippedCount > 0 && !previewQuery.isLoading && (
            <p className="mt-3 text-xs text-destructive/80 flex items-center gap-1.5">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
              {skippedCount} rouleau{skippedCount > 1 ? 'x' : ''} sans tombé de métier lié
              {skippedCount > 1 ? ' seront ignorés' : ' sera ignoré'}.
            </p>
          )}

          {mutation.isError && (
            <p className="mt-3 text-sm text-destructive">
              {(mutation.error as Error)?.message || 'Erreur lors de la surteinture'}
            </p>
          )}
        </div>

        <DialogFooter className="mt-4">
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
              Annuler
            </Button>
            <Button onClick={() => mutation.mutate()} disabled={!valid || mutation.isPending}>
              {mutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
              ) : (
                <Check className="h-4 w-4 mr-1.5" />
              )}
              Valider
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Create finished-roll dialog ────────────────────────
// Manually register a new physical finished roll (Finis > Stock "Nouveau",
// gated by the create_stock_fini permission). Référence + Coloris + Poids are
// required; coloris options are polymorphic by the ref's avec_teinture and come
// from /lookups/coloris (the returned id is already the right IDColoris).

interface RefFiniOption {
  IDref_fini: number
  reference: string | null
  designation: string | null
  avec_teinture: number
}
interface ColorisOption {
  id: number
  reference: string | null
}
interface MagasinOption {
  IDsous_traitant: number
  nom: string | null
}

function CreateFiniRollDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (newId: number | null) => void
}) {
  const [IDref_fini, setIDrefFini] = useState(0)
  const [IDColoris, setIDColoris] = useState(0)
  const [lot, setLot] = useState('')
  const [numero, setNumero] = useState('')
  const [poids, setPoids] = useState('')
  const [metrage, setMetrage] = useState('')
  const [IDetat, setIDetat] = useState(1) // default "En Contrôle"
  const [IDmagasin, setIDmagasin] = useState(0)
  const [emplacement, setEmplacement] = useState('')
  const [observations, setObservations] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refsQuery = useQuery<RefFiniOption[]>({
    queryKey: ['stock-fini', 'lookups', 'refs'],
    queryFn: () => apiFetch<RefFiniOption[]>('/stock/fini/lookups/refs'),
    enabled: open,
  })
  const colorisQuery = useQuery<ColorisOption[]>({
    queryKey: ['stock-fini', 'lookups', 'coloris', IDref_fini],
    queryFn: () => apiFetch<ColorisOption[]>(`/stock/fini/lookups/coloris?ref_fini=${IDref_fini}`),
    enabled: open && IDref_fini > 0,
  })
  const { data: etats } = useEtatsLookup()
  const magasinsQuery = useQuery<MagasinOption[]>({
    queryKey: ['stock-fini', 'lookups', 'magasins'],
    queryFn: () => apiFetch<MagasinOption[]>('/stock/fini/lookups/magasins'),
    enabled: open,
  })

  // Reset every field when the dialog (re)opens.
  useEffect(() => {
    if (open) {
      setIDrefFini(0)
      setIDColoris(0)
      setLot('')
      setNumero('')
      setPoids('')
      setMetrage('')
      setIDetat(1)
      setIDmagasin(0)
      setEmplacement('')
      setObservations('')
      setError(null)
    }
  }, [open])

  // Coloris belongs to a ref — clear the pick when the ref changes.
  useEffect(() => { setIDColoris(0) }, [IDref_fini])

  const num = (s: string) => {
    const v = Number(String(s).replace(',', '.'))
    return Number.isFinite(v) ? v : NaN
  }
  const canSubmit =
    IDref_fini > 0 && IDColoris > 0 && poids.trim() !== '' && !isNaN(num(poids)) && num(poids) >= 0

  const createMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ IDstock_fini: number | null }>('/stock/fini', {
        method: 'POST',
        body: JSON.stringify({
          IDref_fini,
          IDColoris,
          lot,
          numero,
          poids: num(poids),
          metrage: metrage.trim() === '' ? 0 : num(metrage),
          IDetat_stock_fini: IDetat,
          IDmagasin,
          emplacement,
          observations,
        }),
      }),
    onSuccess: (res) => onCreated(res?.IDstock_fini ?? null),
    onError: (err: Error) => setError(err.message || 'Erreur lors de la création'),
  })

  const inputClass =
    'w-full h-9 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90dvh] overflow-y-auto" onClose={() => onOpenChange(false)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FiniRollIcon className="h-5 w-5 text-accent" />
            Nouveau rouleau fini
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-4">
          <div className="col-span-full">
            <label className="text-xs text-muted-foreground mb-1 block">Référence *</label>
            <SearchableCombobox<RefFiniOption>
              options={refsQuery.data ?? []}
              value={IDref_fini}
              onChange={setIDrefFini}
              getId={(r) => r.IDref_fini}
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
              value={IDColoris}
              onChange={setIDColoris}
              disabled={IDref_fini === 0}
              emptyLabel={
                IDref_fini === 0
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
            <label className="text-xs text-muted-foreground mb-1 block">Métrage (m)</label>
            <input
              type="number"
              step="0.1"
              min="0"
              value={metrage}
              onChange={(e) => setMetrage(e.target.value)}
              className={inputClass}
            />
          </div>

          <div>
            <label className="text-xs text-muted-foreground mb-1 block">État</label>
            <PopoverSelect
              options={(etats ?? []).map((e) => ({ id: e.IDetat_stock_fini, primary: e.libelle }))}
              value={IDetat}
              onChange={setIDetat}
              hideEmpty
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

          <div className="col-span-full">
            <label className="text-xs text-muted-foreground mb-1 block">Emplacement</label>
            <input
              type="text"
              value={emplacement}
              onChange={(e) => setEmplacement(e.target.value)}
              className={inputClass}
            />
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
// Extracted + React.memo'd. Crucially, the row does NOT take `isEditing` as a
// prop: its only changing prop is `selected`, so selecting a roll re-renders
// only the affected row, and toggling edit mode re-renders ZERO rows. The
// view ↔ edit presentation (checkbox visibility, cell padding, select-none) is
// driven entirely by CSS via the `data-editing` attribute on the parent
// <tbody className="group">, so flipping edit mode is a single attribute change
// + cheap browser reflow rather than a 1.4k-component React reconciliation.
// The click handler is a single stable callback that reads the mode from a ref.

const StockRow = memo(function StockRow({
  row,
  selected,
  onRowClick,
}: {
  row: StockFiniRow
  selected: boolean
  onRowClick: (id: number, shiftKey: boolean) => void
}) {
  return (
    <tr
      data-stock-row
      onClick={(e) => onRowClick(row.IDstock_fini, e.shiftKey)}
      className={cn(
        'border-b border-border/40 cursor-pointer transition-colors group-data-[editing=true]:select-none',
        selected ? 'bg-accent/10' : 'hover:bg-accent/5',
      )}
    >
      <td className="p-0 group-data-[editing=true]:px-3 group-data-[editing=true]:py-2">
        <div
          className={cn(
            'h-5 w-5 rounded border items-center justify-center transition-colors hidden group-data-[editing=true]:flex',
            selected ? 'bg-accent border-accent text-accent-foreground' : 'bg-white border-input',
          )}
        >
          {selected && <Check className="h-3.5 w-3.5" />}
        </div>
      </td>
      <td className="px-2 py-1.5 font-medium truncate">{row.ref_fini ?? '—'}</td>
      <td className="px-2 py-1.5 truncate" title={row.coloris_reference ?? undefined}>{row.coloris_reference ?? '—'}</td>
      <td className="px-2 py-1.5 truncate text-muted-foreground" title={row.contexture_nom ?? undefined}>{row.contexture_nom ?? '—'}</td>
      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{formatGrammage(row.grammage)}</td>
      <td className="px-2 py-1.5 tabular-nums truncate text-muted-foreground">{row.numero ?? '—'}</td>
      <td className="px-2 py-1.5 text-right tabular-nums">{formatKg(row.poids)}</td>
      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{formatMeters(row.metrage)}</td>
      <td className="px-2 py-1.5 tabular-nums truncate">{row.lot ?? '—'}</td>
      <td className="px-2 py-1.5 truncate" title={row.client_nom ?? undefined}>{row.client_nom ?? '—'}</td>
      <td className="px-2 py-1.5 truncate text-muted-foreground">{row.magasin_nom ?? '—'}</td>
      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{row.commande_numero ?? '—'}</td>
      <td className="px-2 py-1.5">
        {row.etat_libelle ? (
          <EtatPill libelle={row.etat_libelle} />
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-2 py-1.5 truncate">{row.emplacement ?? '—'}</td>
      <td className="px-2 py-1.5 tabular-nums text-muted-foreground">
        {row.date_saisie ? formatHfsqlDate(row.date_saisie) : '—'}
      </td>
      <td className="px-2 py-1.5 text-muted-foreground truncate" title={row.observations ?? undefined}>
        {row.observations?.trim() || ''}
      </td>
      <td className="px-2 py-1.5 text-right">
        <div className="flex items-center justify-end gap-1">
          {!!row.second_choix && (
            <Badge variant="outline" className="text-[10px] py-0 border-red-300 text-red-700">2C</Badge>
          )}
          {!!row.don && <Gift className="h-3.5 w-3.5 text-amber-600" />}
          {!!row.destockage && <Trash2 className="h-3.5 w-3.5 text-zinc-500" />}
        </div>
      </td>
    </tr>
  )
})

// ── Mobile card (below md) ─────────────────────────────
// Same memo discipline as StockRow: `selected` is the only changing prop, and
// the edit-mode checkbox is CSS-driven via the container's data-editing group
// attribute, so edit-mode toggles re-render zero cards.

const StockFiniCard = memo(function StockFiniCard({
  row,
  selected,
  onRowClick,
}: {
  row: StockFiniRow
  selected: boolean
  onRowClick: (id: number, shiftKey: boolean) => void
}) {
  return (
    <div
      data-stock-row
      onClick={(e) => onRowClick(row.IDstock_fini, e.shiftKey)}
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
        <p className="text-sm font-medium truncate flex-1 min-w-0">{row.ref_fini ?? '—'}</p>
        <div className="flex items-center gap-1 flex-shrink-0">
          {!!row.second_choix && (
            <Badge variant="outline" className="text-[10px] py-0 border-red-300 text-red-700">2C</Badge>
          )}
          {!!row.don && <Gift className="h-3.5 w-3.5 text-amber-600" />}
          {!!row.destockage && <Trash2 className="h-3.5 w-3.5 text-zinc-500" />}
          {row.etat_libelle && <EtatPill libelle={row.etat_libelle} />}
        </div>
      </div>
      <p className="text-xs text-muted-foreground mt-0.5 truncate">{row.coloris_reference ?? '—'}</p>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 mt-2">
        <CardKV label="Numéro" value={row.numero ?? '—'} mono />
        <CardKV label="Poids" value={formatKg(row.poids)} mono strong />
        <CardKV label="Métrage" value={row.metrage != null ? `${fmtNum(row.metrage, 1)} Ml` : '—'} mono />
        <CardKV label="Lot" value={row.lot ?? '—'} mono />
        <CardKV label="Client" value={row.client_nom ?? '—'} />
        <CardKV label="Emplacement" value={row.emplacement ?? '—'} />
      </div>
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
        // align-bottom + normal wrapping lets two-word labels (N° Commande,
        // Date saisie) wrap at the space onto two lines instead of bleeding into
        // the neighbour (table-layout: fixed clips column width, not text).
        // Headers are normal-case (no uppercase/tracking) so single words stay
        // narrow enough to fit on one line without ugly mid-word breaks.
        'px-2 py-2 font-semibold cursor-pointer select-none align-bottom leading-tight',
        align === 'right' ? 'text-right' : 'text-left',
        active && 'text-accent',
      )}
    >
      {label}
      {active &&
        (sort.dir === 'asc' ? (
          <ArrowUp className="inline-block h-3 w-3 ml-1 align-middle" />
        ) : (
          <ArrowDown className="inline-block h-3 w-3 ml-1 align-middle" />
        ))}
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

function StockFiniDrawer({ id, onClose, onMutationSuccess, onDirtyChange, saveRef, discardRef }: DrawerProps) {
  const { data: detail, isLoading } = useStockFiniDetail(id)
  const { data: provenance } = useStockFiniProvenance(id)
  // Per-section sub-permissions of edit_stock_fini — each drawer card is only
  // editable when the parent AND its own sub-key are granted. The API enforces
  // the same pairs on PATCH /stock/fini/:id.
  const canEdit = useHasPermission('edit_stock_fini')
  const hasStockage = useHasPermission('edit_stock_fini_stockage')
  const hasEtat = useHasPermission('edit_stock_fini_etat')
  const hasAffectation = useHasPermission('edit_stock_fini_affectation')
  const hasNotes = useHasPermission('edit_stock_fini_notes')
  const canEditStockage = canEdit && hasStockage
  const canEditEtat = canEdit && hasEtat
  const canEditAffectation = canEdit && hasAffectation
  const canEditNotes = canEdit && hasNotes
  const canEditAny = canEditStockage || canEditEtat || canEditAffectation || canEditNotes
  const drawerRef = useRef<HTMLDivElement>(null)
  const [searchParams] = useSearchParams()
  const embed = searchParams.get('embed') === 'true'

  const [isEditing, setIsEditing] = useState(false)
  const [editObservations, setEditObservations] = useState('')
  const [editObservationSst, setEditObservationSst] = useState('')
  const [editEmplacement, setEditEmplacement] = useState('')
  const [editConteneur, setEditConteneur] = useState('')
  const [editPointage, setEditPointage] = useState('')
  const [editSecondChoix, setEditSecondChoix] = useState(false)
  const [editDestockage, setEditDestockage] = useState(false)
  const [editDon, setEditDon] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const originalDraftRef = useRef<{
    observations: string
    observation_sst: string
    emplacement: string
    conteneur: string
    pointage: string
    secondChoix: boolean
    destockage: boolean
    don: boolean
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
      observation_sst: detail.observation_sst ?? '',
      emplacement: detail.emplacement ?? '',
      conteneur: detail.conteneur ?? '',
      pointage: hfsqlDateToInput(detail.pointage),
      secondChoix: !!detail.second_choix,
      destockage: !!detail.destockage,
      don: !!detail.don,
    }
    setEditObservations(snapshot.observations)
    setEditObservationSst(snapshot.observation_sst)
    setEditEmplacement(snapshot.emplacement)
    setEditConteneur(snapshot.conteneur)
    setEditPointage(snapshot.pointage)
    setEditSecondChoix(snapshot.secondChoix)
    setEditDestockage(snapshot.destockage)
    setEditDon(snapshot.don)
    originalDraftRef.current = snapshot
    setSaveError(null)
    setIsEditing(true)
  }, [detail])

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/stock/fini/${id}`, {
        method: 'PATCH',
        // Only send the field groups the user may edit — the API 403s on any
        // field whose edit_stock_fini_* sub-permission is missing.
        body: JSON.stringify({
          ...(canEditNotes
            ? { observations: editObservations, observation_sst: editObservationSst }
            : {}),
          ...(canEditStockage
            ? {
                emplacement: editEmplacement,
                conteneur: editConteneur,
                pointage: editPointage ? inputDateToHfsql(editPointage) : '',
              }
            : {}),
          ...(canEditEtat ? { second_choix: editSecondChoix } : {}),
          ...(canEditAffectation ? { destockage: editDestockage, don: editDon } : {}),
        }),
      }),
    onMutate: () => setSaveError(null),
    onSuccess: () => {
      onMutationSuccess()
      setIsEditing(false)
    },
    onError: () => setSaveError("L'enregistrement a échoué. Réessayez ou contactez l'administrateur."),
  })

  const isDirty = useMemo(() => {
    if (!isEditing) return false
    const o = originalDraftRef.current
    if (!o) return false
    if (editObservations !== o.observations) return true
    if (editObservationSst !== o.observation_sst) return true
    if (editEmplacement !== o.emplacement) return true
    if (editConteneur !== o.conteneur) return true
    if (editPointage !== o.pointage) return true
    if (editSecondChoix !== o.secondChoix) return true
    if (editDestockage !== o.destockage) return true
    if (editDon !== o.don) return true
    return false
  }, [
    isEditing,
    editObservations,
    editObservationSst,
    editEmplacement,
    editConteneur,
    editPointage,
    editSecondChoix,
    editDestockage,
    editDon,
  ])

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
        <div className="flex-shrink-0 border-b-2 border-gold bg-primary px-4 py-2.5">
          <div className="flex items-center gap-2.5">
            <div
              className={cn(
                'h-8 w-8 flex-shrink-0 rounded-lg flex items-center justify-center shadow-sm transition-colors',
                isEditing ? 'bg-white text-primary' : 'bg-gold text-gold-foreground',
              )}
            >
              <FiniRollIcon className="h-[18px] w-[18px]" />
            </div>
            <div className="min-w-0 flex-1">
              {isLoading || !detail ? (
                <div className="h-5 w-40 bg-white/20 animate-pulse rounded" />
              ) : (
                <>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-base font-heading font-bold tracking-tight truncate text-primary-foreground">
                      {detail.numero ?? '—'}
                    </h2>
                    {!!detail.second_choix && (
                      <Badge className="bg-red-100 text-red-700 border-red-200 gap-1 text-[10px] py-0">
                        2ᵉ choix
                      </Badge>
                    )}
                    {!!detail.don && (
                      <Badge className="bg-amber-100 text-amber-800 border-amber-200 gap-1 text-[10px] py-0">
                        <Gift className="h-2.5 w-2.5" />
                        Don
                      </Badge>
                    )}
                    {!!detail.IDligne_expedition && (
                      <Badge className="bg-zinc-200 text-zinc-700 border-zinc-300 gap-1 text-[10px] py-0">
                        <Send className="h-2.5 w-2.5" />
                        Expédiée
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-white/70 truncate">
                    {[
                      detail.ref_fini,
                      detail.coloris_reference,
                      detail.lot ? `Lot ${detail.lot}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ') || '—'}
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
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-white/80 hover:bg-white/15 hover:text-white"
                      title="Imprimer l'étiquette"
                      onClick={() =>
                        window.open(`${API_URL}/stock/fini/${detail.IDstock_fini}/label`, '_blank')
                      }
                    >
                      <Printer className="h-4 w-4" />
                    </Button>
                    {canEditAny && (
                      <Button variant="gold" size="sm" onClick={startEdit} title="Modifier">
                        <Pencil className="h-3.5 w-3.5 sm:mr-1.5" />
                        <span className="hidden sm:inline">Modifier</span>
                      </Button>
                    )}
                  </>
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
          {/* Light-on-navy: text-destructive is unreadable against the band. */}
          {isEditing && saveError && (
            <div className="mt-2 flex items-center gap-2 text-sm text-red-200">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              {saveError}
            </div>
          )}
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
              <DrawerCard icon={<Package className="h-4 w-4 text-accent" />} title="Stock">
                <div className="space-y-1.5">
                  <KV label="Poids" value={<span className="font-semibold tabular-nums">{formatKg(detail.poids)}</span>} />
                  <KV label="Métrage" value={<span className="tabular-nums">{formatMeters(detail.metrage)}</span>} />
                  {!!detail.designation && (
                    <KV label="Désignation" value={detail.designation} />
                  )}
                </div>
              </DrawerCard>

              {/* État + qualité */}
              <DrawerCard icon={<Activity className="h-4 w-4 text-accent" />} title="État" highlight={isEditing && canEditEtat}>
                <div className="space-y-2">
                  <KV
                    label="Statut"
                    value={
                      detail.etat_libelle ? <EtatPill libelle={detail.etat_libelle} /> : '—'
                    }
                  />
                  <KV
                    label="2ᵉ choix"
                    value={
                      isEditing && canEditEtat ? (
                        <input
                          type="checkbox"
                          checked={editSecondChoix}
                          onChange={(e) => setEditSecondChoix(e.target.checked)}
                          className="h-4 w-4 rounded border-input text-accent focus:ring-2 focus:ring-ring cursor-pointer"
                        />
                      ) : detail.second_choix ? (
                        <Sparkles className="h-3.5 w-3.5 text-red-600" />
                      ) : (
                        <span className="text-muted-foreground">Non</span>
                      )
                    }
                  />
                </div>
              </DrawerCard>

              {/* Provenance */}
              <DrawerCard icon={<Factory className="h-4 w-4 text-accent" />} title="Provenance">
                <div className="space-y-2.5">
                  {/* Fils — yarns knit into this roll, with supplier + fil order N° */}
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

                  {/* Tricotage — the knitting order that produced the écru base */}
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

                  {/* Ennoblissement — the dyeing order (hidden if same as tricotage) */}
                  {!!provenance?.ennoblissement &&
                    provenance.ennoblissement.IDcommande !== provenance?.tricotage?.IDcommande && (
                      <ProvenanceRow
                        icon={<Paintbrush className="h-3.5 w-3.5 text-accent" />}
                        title="Ennoblissement"
                        detail={[
                          provenance.ennoblissement.sst_nom,
                          `Commande N° ${provenance.ennoblissement.IDcommande}`,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      />
                    )}

                  <div className="space-y-1.5 pt-1.5 border-t border-border/40">
                    <KV
                      label="Date réception"
                      value={detail.date_saisie ? formatHfsqlDate(detail.date_saisie) : '—'}
                    />
                  </div>
                </div>
              </DrawerCard>

              {/* Stockage */}
              <DrawerCard icon={<MapPin className="h-4 w-4 text-accent" />} title="Stockage" highlight={isEditing && canEditStockage}>
                <div className="space-y-1.5">
                  <KV
                    label="Emplacement"
                    value={
                      isEditing && canEditStockage ? (
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
                  <KV
                    label="Conteneur"
                    value={
                      isEditing && canEditStockage ? (
                        <input
                          type="text"
                          value={editConteneur}
                          onChange={(e) => setEditConteneur(e.target.value)}
                          className="h-7 px-2 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring text-right"
                        />
                      ) : (
                        detail.conteneur || '—'
                      )
                    }
                  />
                  <KV label="Magasin" value={detail.magasin_nom ?? '—'} />
                  <KV
                    label="Pointage"
                    value={
                      isEditing && canEditStockage ? (
                        <input
                          type="date"
                          value={editPointage}
                          onChange={(e) => setEditPointage(e.target.value)}
                          className="h-7 px-2 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                      ) : detail.pointage ? (
                        formatHfsqlDate(detail.pointage)
                      ) : (
                        '—'
                      )
                    }
                  />
                </div>
              </DrawerCard>

              {/* Affectation */}
              <DrawerCard icon={<Send className="h-4 w-4 text-accent" />} title="Affectation" highlight={isEditing && canEditAffectation}>
                <div className="space-y-1.5">
                  <KV
                    label="Commande client"
                    value={
                      detail.IDligne_commande_client
                        ? <span className="tabular-nums">Allouée à #{detail.IDligne_commande_client}</span>
                        : <span className="text-muted-foreground">—</span>
                    }
                  />
                  <KV
                    label="Expédition"
                    value={
                      detail.IDligne_expedition
                        ? <span className="tabular-nums">#{detail.IDligne_expedition}</span>
                        : <span className="text-muted-foreground">—</span>
                    }
                  />
                  <KV
                    label="Donation"
                    value={
                      isEditing && canEditAffectation ? (
                        <input
                          type="checkbox"
                          checked={editDon}
                          onChange={(e) => setEditDon(e.target.checked)}
                          className="h-4 w-4 rounded border-input text-accent focus:ring-2 focus:ring-ring cursor-pointer"
                        />
                      ) : detail.don ? (
                        <Gift className="h-3.5 w-3.5 text-amber-600" />
                      ) : (
                        <span className="text-muted-foreground">Non</span>
                      )
                    }
                  />
                  <KV
                    label="Déstockage"
                    value={
                      isEditing && canEditAffectation ? (
                        <input
                          type="checkbox"
                          checked={editDestockage}
                          onChange={(e) => setEditDestockage(e.target.checked)}
                          className="h-4 w-4 rounded border-input text-accent focus:ring-2 focus:ring-ring cursor-pointer"
                        />
                      ) : detail.destockage ? (
                        <Trash2 className="h-3.5 w-3.5 text-zinc-600" />
                      ) : (
                        <span className="text-muted-foreground">Non</span>
                      )
                    }
                  />
                </div>
              </DrawerCard>

              {/* Notes */}
              <DrawerCard icon={<MessageSquare className="h-4 w-4 text-accent" />} title="Notes" highlight={isEditing && canEditNotes}>
                <div className="space-y-2">
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Observations</p>
                    {isEditing && canEditNotes ? (
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
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Observation sous-traitant</p>
                    {isEditing && canEditNotes ? (
                      <textarea
                        value={editObservationSst}
                        onChange={(e) => setEditObservationSst(e.target.value)}
                        rows={2}
                        className="w-full px-2.5 py-1.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                      />
                    ) : detail.observation_sst?.trim() ? (
                      <p className="text-sm whitespace-pre-wrap">{detail.observation_sst.trim()}</p>
                    ) : (
                      <p className="text-sm text-muted-foreground italic">—</p>
                    )}
                  </div>
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
// and a muted detail line (supplier · order N°). Used in the drawer's
// Provenance card.
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
