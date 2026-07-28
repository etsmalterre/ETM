import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Search,
  Loader2,
  AlertCircle,
  Pencil,
  Plus,
  X,
  Save,
  Trash2,
  Box,
  Archive,
  ArchiveRestore,
  ChevronDown,
  Layers,
  BadgeEuro,
  Warehouse,
  ShoppingCart,
  Printer,
  AtSign,
  Mail,
  Ruler,
  Palette,
  Tag,
  FileText,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { PopoverSelect } from '@/components/ui/popover-select'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { UnsavedChangesDialog } from '@/components/shared/UnsavedChangesDialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'
import { cn } from '@/lib/utils'
import { apiFetch, API_URL } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { formatHfsqlDate } from '@/lib/dates'

// ── Domain vocabulary ──────────────────────────────────
//
// A "référence diverse" carries up to two variation AXES (sTypeVariation1 /
// sTypeVariation2 — Couleur, Taille or Référence). Each axis holds a list of
// VALUES (ref_divers_variation rows, `niveau` = the axis). Prices live either on
// the reference itself (no axis at all) or in tarif_divers, one row per
// combination — with the single (0, 0) row meaning "one price for all".

const VARIATION_TYPES = ['Aucun', 'Couleur', 'Taille', 'Reference'] as const
type VariationType = (typeof VARIATION_TYPES)[number]

function variationTypeLabel(t: VariationType): string {
  if (t === 'Aucun') return 'Aucune'
  if (t === 'Reference') return 'Référence'
  return t
}

/** Plural, lowercase — used by the "Toutes les couleurs" tarif row. */
function variationTypePlural(t: VariationType): string {
  if (t === 'Reference') return 'références'
  if (t === 'Couleur') return 'couleurs'
  if (t === 'Taille') return 'tailles'
  return 'variations'
}

/** PopoverSelect is id-keyed and treats 0 as "none" — which maps cleanly onto
 *  "Aucun" being the first entry of VARIATION_TYPES. */
const TYPE_OPTIONS = VARIATION_TYPES.slice(1).map((t, i) => ({
  id: i + 1,
  primary: variationTypeLabel(t),
}))
const typeToId = (t: VariationType) => VARIATION_TYPES.indexOf(t)
const idToType = (id: number): VariationType => VARIATION_TYPES[id] ?? 'Aucun'

const UNITE_OPTIONS = [
  { id: 1, primary: 'Kg' },
  { id: 3, primary: 'Ml' },
  { id: 4, primary: 'Pièce' },
  { id: 5, primary: 'm²' },
]

function axisIcon(t: VariationType) {
  if (t === 'Couleur') return Palette
  if (t === 'Taille') return Ruler
  if (t === 'Reference') return Tag
  return Layers
}

// ── Types ──────────────────────────────────────────────

interface RefDiversListRow {
  IDref_divers: number
  designation: string | null
  unite: number
  unite_label: string
  archive: number
  sTypeVariation1: VariationType
  sTypeVariation2: VariationType
  variations_count: number
  stock_total: number
  prix_affiche: number | null
  tarif_detaille: number
}

interface Variation {
  IDref_divers_variation: number
  IDref_divers: number
  designation: string | null
  niveau: number
  prix: number | null
  unite: number
}

interface Tarif {
  IDtarif_divers: number
  prix: number
  IDVariation1: number
  IDVariation2: number
}

interface StockRow {
  IDstock_divers: number
  quantite: number
  unite: number
  unite_label: string
  IDVariation1: number
  IDVariation2: number
  variation1_label: string | null
  variation2_label: string | null
}

interface CommandeRow {
  IDligne_commande_client: number
  IDcommande_client: number
  numero: number
  date_commande: string | null
  client_nom: string | null
  quantite: number
  unite_label: string
  prix: number
  variation1_label: string | null
  variation2_label: string | null
}

interface RefDiversDetail {
  IDref_divers: number
  designation: string | null
  prix_unitaire: number
  observations: string | null
  unite: number
  unite_label: string
  archive: number
  sTypeVariation1: VariationType
  sTypeVariation2: VariationType
  variations: Variation[]
  tarifs: Tarif[]
  tarif_mode: 'global' | 'detail'
  tarif_global: number | null
  stock: StockRow[]
  stock_total: number
  commandes: CommandeRow[]
  usage: {
    stock: number
    tarifs: number
    variations: number
    lignes_commande: number
    lignes_devis: number
    expeditions: number
  }
}

// ── Shared styling ─────────────────────────────────────

const inputClass =
  'w-full h-8 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring'
const editSectionClass = 'border-l-4 border-l-accent/70 bg-accent/[0.03]'

function LabeledField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm text-right truncate">{value}</span>
    </div>
  )
}

/** Best-effort read of the API's French error message for a failed mutation. */
async function readApiError(path: string, init: RequestInit, fallback: string): Promise<string> {
  try {
    const res = await fetch(`${API_URL}${path}`, { credentials: 'include', ...init })
    if (!res.ok) {
      const body = await res.json().catch(() => null)
      if (body?.error) return String(body.error)
    }
  } catch {
    /* keep fallback */
  }
  return fallback
}

// ── API hooks ──────────────────────────────────────────

function useRefsDivers(archived: boolean) {
  return useQuery<RefDiversListRow[]>({
    queryKey: ['refs-divers', archived],
    queryFn: () => apiFetch(`/references-divers?archived=${archived ? 1 : 0}`),
  })
}

function useRefDiversDetail(id: number | null) {
  return useQuery<RefDiversDetail>({
    queryKey: ['ref-divers', id],
    queryFn: () => apiFetch(`/references-divers/${id}`),
    enabled: id !== null,
  })
}

// ── Header draft ───────────────────────────────────────

interface HeaderDraft {
  designation: string
  prix_unitaire: string
  observations: string
  unite: number
  sTypeVariation1: VariationType
  sTypeVariation2: VariationType
}

function emptyDraft(): HeaderDraft {
  return {
    designation: '',
    prix_unitaire: '',
    observations: '',
    unite: 4,
    sTypeVariation1: 'Aucun',
    sTypeVariation2: 'Aucun',
  }
}

function draftFromDetail(d: RefDiversDetail): HeaderDraft {
  return {
    designation: d.designation ?? '',
    prix_unitaire: d.prix_unitaire ? String(d.prix_unitaire) : '',
    observations: d.observations ?? '',
    unite: d.unite,
    sTypeVariation1: d.sTypeVariation1,
    sTypeVariation2: d.sTypeVariation2,
  }
}

function draftToBody(d: HeaderDraft) {
  return {
    designation: d.designation.trim(),
    prix_unitaire: d.prix_unitaire === '' ? 0 : Number(d.prix_unitaire.replace(',', '.')) || 0,
    observations: d.observations,
    unite: d.unite,
    sTypeVariation1: d.sTypeVariation1,
    sTypeVariation2: d.sTypeVariation2,
  }
}

// ── Page ───────────────────────────────────────────────

export function DiversReferences() {
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [archivedFilter, setArchivedFilter] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState<HeaderDraft>(emptyDraft())
  const originalDraftRef = useRef<HeaderDraft | null>(null)

  // Per-key dirty registry (§28.3.b) — the variation axis forms.
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set())
  const reportDirty = useCallback((key: string, dirty: boolean) => {
    setDirtyKeys((prev) => {
      if (dirty === prev.has(key)) return prev
      const next = new Set(prev)
      if (dirty) next.add(key)
      else next.delete(key)
      return next
    })
  }, [])
  const subFormsDirty = dirtyKeys.size > 0

  const [autoEditForId, setAutoEditForId] = useState<number | null>(null)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [placeholder, setPlaceholder] = useState<'print' | 'email' | null>(null)

  const { data: refs, isLoading, isError, error } = useRefsDivers(archivedFilter)
  const { data: detail, isLoading: detailLoading } = useRefDiversDetail(selectedId)

  const filtered = useMemo(() => {
    if (!refs) return []
    const q = searchQuery.trim().toLowerCase()
    if (!q) return refs
    return refs.filter((r) => (r.designation ?? '').toLowerCase().includes(q))
  }, [refs, searchQuery])

  useAutoSelectFirst({
    rows: filtered,
    selectedId,
    getId: (r) => r.IDref_divers,
    select: setSelectedId,
    suspended: isEditing || autoEditForId !== null,
  })

  const startEdit = useCallback(() => {
    if (!detail) return
    const snap = draftFromDetail(detail)
    setDraft(snap)
    originalDraftRef.current = snap
    setIsEditing(true)
  }, [detail])

  const cancelEdit = useCallback(() => {
    setIsEditing(false)
    setDraft(emptyDraft())
    setDirtyKeys(new Set())
    originalDraftRef.current = null
  }, [])

  const isDirty = useMemo(() => {
    if (!isEditing) return false
    const o = originalDraftRef.current
    if (!o) return false
    if (draft.designation !== o.designation) return true
    if (draft.prix_unitaire !== o.prix_unitaire) return true
    if (draft.observations !== o.observations) return true
    if (draft.unite !== o.unite) return true
    if (draft.sTypeVariation1 !== o.sTypeVariation1) return true
    if (draft.sTypeVariation2 !== o.sTypeVariation2) return true
    if (subFormsDirty) return true
    return false
  }, [isEditing, draft, subFormsDirty])

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['refs-divers'] })
    queryClient.invalidateQueries({ queryKey: ['ref-divers', selectedId] })
  }, [queryClient, selectedId])

  /** Hydrate the detail cache with a fresh tarif list without a round-trip
   *  (§31.6) — the price grid mutates one cell at a time. */
  const applyTarifs = useCallback(
    (tarifs: Tarif[]) => {
      queryClient.setQueryData<RefDiversDetail>(['ref-divers', selectedId], (old) => {
        if (!old) return old
        const globalRow = tarifs.find((t) => t.IDVariation1 === 0 && t.IDVariation2 === 0)
        return {
          ...old,
          tarifs,
          tarif_mode: tarifs.some((t) => t.IDVariation1 !== 0 || t.IDVariation2 !== 0) ? 'detail' : 'global',
          tarif_global: globalRow ? globalRow.prix : null,
        }
      })
      queryClient.invalidateQueries({ queryKey: ['refs-divers'] })
    },
    [queryClient, selectedId],
  )

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/references-divers/${selectedId}`, {
        method: 'PUT',
        body: JSON.stringify(draftToBody(draft)),
      }),
    onSuccess: () => {
      invalidateAll()
      setIsEditing(false)
      setDirtyKeys(new Set())
      originalDraftRef.current = null
    },
    onError: async () => {
      setSaveError(
        await readApiError(
          `/references-divers/${selectedId}`,
          { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draftToBody(draft)) },
          "L'enregistrement a échoué. Veuillez réessayer.",
        ),
      )
    },
  })

  const createMutation = useMutation({
    mutationFn: () => apiFetch<{ IDref_divers: number | null }>('/references-divers', { method: 'POST' }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['refs-divers'] })
      if (data.IDref_divers != null) {
        setSelectedId(data.IDref_divers)
        setAutoEditForId(data.IDref_divers)
      }
    },
  })

  const archiveMutation = useMutation({
    mutationFn: (archive: boolean) =>
      apiFetch(`/references-divers/${selectedId}/${archive ? 'archive' : 'unarchive'}`, { method: 'POST' }),
    onSuccess: () => {
      const cached = queryClient.getQueryData<RefDiversListRow[]>(['refs-divers', archivedFilter]) ?? []
      const remaining = cached.filter((r) => r.IDref_divers !== selectedId)
      queryClient.invalidateQueries({ queryKey: ['refs-divers'] })
      queryClient.invalidateQueries({ queryKey: ['ref-divers', selectedId] })
      // The row leaves the current filter — land on its neighbour.
      setSelectedId(remaining.length > 0 ? remaining[0].IDref_divers : null)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/references-divers/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, deletedId) => {
      setDeleteConfirmOpen(false)
      setDeleteError(null)
      const cached = queryClient.getQueryData<RefDiversListRow[]>(['refs-divers', archivedFilter]) ?? []
      const remaining = cached.filter((r) => r.IDref_divers !== deletedId)
      queryClient.invalidateQueries({ queryKey: ['refs-divers'] })
      setSelectedId(remaining.length > 0 ? remaining[0].IDref_divers : null)
    },
    onError: async (_err, deletedId) => {
      setDeleteError(
        await readApiError(`/references-divers/${deletedId}`, { method: 'DELETE' }, 'Suppression impossible.'),
      )
    },
  })

  // §25.1 auto-edit after create
  useEffect(() => {
    if (autoEditForId !== null && detail?.IDref_divers === autoEditForId) {
      startEdit()
      setAutoEditForId(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEditForId, detail])

  const guard = useUnsavedGuard({
    isDirty,
    save: async () => {
      await saveMutation.mutateAsync()
    },
    onDiscard: () => cancelEdit(),
  })

  const handleSelect = useCallback(
    (id: number) => {
      guard.guardAction(() => {
        setIsEditing(false)
        setDirtyKeys(new Set())
        originalDraftRef.current = null
        setSelectedId(id)
      })
    },
    [guard],
  )

  const handleFilterChange = useCallback(
    (archived: boolean) => {
      guard.guardAction(() => {
        setIsEditing(false)
        setDirtyKeys(new Set())
        originalDraftRef.current = null
        setArchivedFilter(archived)
        setSelectedId(null)
      })
    },
    [guard],
  )

  return (
    <>
      <MasterDetailLayout
        list={
          <RefDiversList
            refs={filtered}
            totalCount={refs?.length ?? 0}
            isLoading={isLoading}
            isError={isError}
            error={error as Error | null}
            selectedId={selectedId}
            onSelect={handleSelect}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            archivedFilter={archivedFilter}
            onArchivedFilterChange={handleFilterChange}
            onNew={() => createMutation.mutate()}
            isCreating={createMutation.isPending}
            isEditing={isEditing}
          />
        }
        detailHeader={
          <DetailHeader
            detail={detail ?? null}
            isLoading={detailLoading && selectedId !== null}
            isEditing={isEditing}
            draft={draft}
            onDraftChange={setDraft}
            onStartEdit={startEdit}
            onCancelEdit={cancelEdit}
            onSave={() => saveMutation.mutate()}
            isSaving={saveMutation.isPending}
            onDelete={() => {
              setDeleteError(null)
              setDeleteConfirmOpen(true)
            }}
            onArchive={() => archiveMutation.mutate(!detail?.archive)}
            isArchiving={archiveMutation.isPending}
            onPrint={() => setPlaceholder('print')}
            onEmail={() => setPlaceholder('email')}
          />
        }
        detail={
          <DetailMain
            detail={detail ?? null}
            isLoading={detailLoading && selectedId !== null}
            hasSelection={selectedId !== null}
            isEditing={isEditing}
            draft={draft}
            onDraftChange={setDraft}
            onMutationSuccess={invalidateAll}
            onTarifsUpdated={applyTarifs}
            reportDirty={reportDirty}
          />
        }
        sidebar={selectedId !== null ? <DetailSidebar detail={detail ?? null} /> : null}
        sidebarTitle="Stock & utilisation"
        hasSelection={selectedId !== null}
        onBack={() =>
          guard.guardAction(() => {
            setIsEditing(false)
            setSelectedId(null)
          })
        }
      />
      <UnsavedChangesDialog open={guard.showDialog} onAction={guard.handleAction} isSaving={guard.isSaving} />
      <ConfirmDialog
        open={deleteConfirmOpen}
        title="Supprimer la référence"
        description={
          deleteError ??
          'Cette action supprimera la référence, ses variations et ses tarifs. Elle est irréversible.'
        }
        isPending={deleteMutation.isPending}
        onCancel={() => {
          setDeleteConfirmOpen(false)
          setDeleteError(null)
        }}
        onConfirm={() => {
          if (selectedId !== null) {
            setIsEditing(false)
            deleteMutation.mutate(selectedId)
          }
        }}
      />
      <AlertDialog open={saveError !== null} onOpenChange={(o) => { if (!o) setSaveError(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-destructive" />
              Enregistrement impossible
            </AlertDialogTitle>
            <AlertDialogDescription>{saveError}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:gap-2 mt-4">
            <Button onClick={() => setSaveError(null)}>OK</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <PlaceholderDialog kind={placeholder} onClose={() => setPlaceholder(null)} />
    </>
  )
}

// ── "En developpement" placeholder dialog (§18 A-bis) ──

function PlaceholderDialog({ kind, onClose }: { kind: 'print' | 'email' | null; onClose: () => void }) {
  const TitleIcon = kind === 'email' ? AtSign : Printer
  const CenterIcon = kind === 'email' ? Mail : Printer
  return (
    <Dialog open={kind !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TitleIcon className="h-5 w-5 text-accent" />
            {kind === 'email' ? 'Envoyer un email' : 'Imprimer'}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
          <CenterIcon className="h-12 w-12 mb-3 opacity-40" />
          <p className="text-sm font-medium">En developpement</p>
          <p className="text-xs mt-1">Cette fonctionnalite sera disponible prochainement.</p>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Left Panel: List ───────────────────────────────────

function RefDiversList({
  refs,
  totalCount,
  isLoading,
  isError,
  error,
  selectedId,
  onSelect,
  searchQuery,
  onSearchChange,
  archivedFilter,
  onArchivedFilterChange,
  onNew,
  isCreating,
  isEditing,
}: {
  refs: RefDiversListRow[]
  totalCount: number
  isLoading: boolean
  isError: boolean
  error: Error | null
  selectedId: number | null
  onSelect: (id: number) => void
  searchQuery: string
  onSearchChange: (q: string) => void
  archivedFilter: boolean
  onArchivedFilterChange: (v: boolean) => void
  onNew: () => void
  isCreating: boolean
  isEditing: boolean
}) {
  const filterOptions: { key: 'en_cours' | 'archive'; label: string }[] = [
    { key: 'en_cours', label: 'En cours' },
    { key: 'archive', label: 'Archivé' },
  ]
  const activeKey = archivedFilter ? 'archive' : 'en_cours'
  const selectedRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedId, refs])

  return (
    <div className="flex flex-col h-full rounded-lg border shadow-sm bg-zinc-100/80">
      <div className="p-3 border-b rounded-t-lg bg-zinc-200/50 space-y-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Rechercher..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            autoComplete="off"
            className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {filterOptions.map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => onArchivedFilterChange(opt.key === 'archive')}
              className={cn(
                'px-2 py-1 text-xs rounded-md transition-colors flex-grow basis-[calc(50%-0.25rem)]',
                activeKey === opt.key
                  ? 'bg-accent text-accent-foreground shadow-sm font-medium'
                  : 'text-muted-foreground hover:bg-accent/10',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-auto p-3 space-y-2 scrollbar-transparent">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-accent" />
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center justify-center py-8 text-destructive">
            <AlertCircle className="h-6 w-6 mb-2" />
            <p className="text-sm">{error?.message || 'Erreur'}</p>
          </div>
        ) : refs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Box className="h-12 w-12 mb-3 opacity-50" />
            <p className="text-sm">Aucune référence</p>
          </div>
        ) : (
          refs.map((r) => {
            const axes = [r.sTypeVariation1, r.sTypeVariation2].filter((t) => t !== 'Aucun')
            return (
              <div
                key={r.IDref_divers}
                ref={selectedId === r.IDref_divers ? selectedRef : undefined}
                onClick={() => onSelect(r.IDref_divers)}
                className={cn(
                  'p-3 border rounded-lg cursor-pointer transition-all bg-white',
                  selectedId === r.IDref_divers
                    ? 'border-accent ring-1 ring-accent'
                    : 'border-border hover:border-accent/50',
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Box className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <p className="font-medium text-sm truncate flex-1">{r.designation || '—'}</p>
                  {r.stock_total > 0 && (
                    <span className="flex-shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {fmtNum(r.stock_total, 0)} {r.unite_label}
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2 mt-1 text-[11px] text-muted-foreground">
                  <span className="truncate">
                    {axes.length === 0
                      ? 'Sans variation'
                      : `${axes.map(variationTypeLabel).join(' · ')} — ${r.variations_count} valeur${r.variations_count > 1 ? 's' : ''}`}
                  </span>
                  <span className="flex-shrink-0 tabular-nums">
                    {r.tarif_detaille
                      ? 'Tarifs détaillés'
                      : r.prix_affiche != null
                        ? `${fmtNum(r.prix_affiche, 2)} €`
                        : ''}
                  </span>
                </div>
              </div>
            )
          })
        )}
      </div>
      <div className="p-3 border-t text-xs text-muted-foreground flex items-center justify-between rounded-b-lg bg-zinc-200/50">
        <span>
          {totalCount} référence{totalCount !== 1 ? 's' : ''}
        </span>
        {!isEditing && !archivedFilter && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onNew}
            disabled={isCreating}
            className="text-accent hover:text-accent hover:bg-accent/10"
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            Nouveau
          </Button>
        )}
      </div>
    </div>
  )
}

// ── Center: Detail Header ──────────────────────────────

function DetailHeader({
  detail,
  isLoading,
  isEditing,
  draft,
  onDraftChange,
  onStartEdit,
  onCancelEdit,
  onSave,
  isSaving,
  onDelete,
  onArchive,
  isArchiving,
  onPrint,
  onEmail,
}: {
  detail: RefDiversDetail | null
  isLoading: boolean
  isEditing: boolean
  draft: HeaderDraft
  onDraftChange: (d: HeaderDraft) => void
  onStartEdit: () => void
  onCancelEdit: () => void
  onSave: () => void
  isSaving: boolean
  onDelete: () => void
  onArchive: () => void
  isArchiving: boolean
  onPrint: () => void
  onEmail: () => void
}) {
  if (!detail && !isLoading) return null
  const archived = !!detail?.archive
  const axes = detail ? [detail.sTypeVariation1, detail.sTypeVariation2].filter((t) => t !== 'Aucun') : []
  return (
    <div className="flex-shrink-0 pt-0.5">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            'h-11 w-11 rounded-lg flex items-center justify-center',
            isEditing ? 'bg-accent/15 text-accent' : 'icon-box-gold',
          )}
        >
          <Box className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          {isLoading ? (
            <div className="h-8 w-48 bg-muted animate-pulse rounded" />
          ) : isEditing ? (
            <div className="flex items-center gap-3">
              <input
                value={draft.designation}
                onChange={(e) => onDraftChange({ ...draft, designation: e.target.value })}
                autoFocus
                className="flex-1 text-xl font-heading font-bold h-10 px-3 rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <Badge className="bg-accent text-accent-foreground flex-shrink-0 gap-1 shadow-sm">
                <Pencil className="h-3 w-3" />
                Mode edition
              </Badge>
            </div>
          ) : (
            <div>
              <h1 className="text-2xl font-heading font-bold tracking-tight truncate">
                {detail?.designation || '—'}
              </h1>
              <div className="flex gap-1.5 mt-1 flex-wrap">
                {!!detail?.unite_label && (
                  <Badge variant="secondary" className="text-xs">
                    {detail.unite_label}
                  </Badge>
                )}
                {axes.map((t) => (
                  <Badge key={t} variant="outline" className="text-xs">
                    {variationTypeLabel(t)}
                  </Badge>
                ))}
                {archived && (
                  <Badge variant="outline" className="text-xs gap-1 text-muted-foreground">
                    <Archive className="h-2.5 w-2.5" />
                    Archivée
                  </Badge>
                )}
              </div>
            </div>
          )}
        </div>
        {!isLoading && detail && (
          <div className="flex items-center gap-2 flex-shrink-0">
            {isEditing ? (
              <>
                <Button variant="outline" size="sm" onClick={onCancelEdit}>
                  <X className="h-3.5 w-3.5 mr-1.5" />
                  Annuler
                </Button>
                <Button size="sm" onClick={onSave} disabled={isSaving}>
                  <Save className="h-3.5 w-3.5 mr-1.5" />
                  {isSaving ? 'Enregistrement...' : 'Enregistrer'}
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9 text-destructive hover:text-destructive hover:bg-destructive/10"
                  title="Supprimer"
                  onClick={onDelete}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="icon" className="h-9 w-9" title="Imprimer" onClick={onPrint}>
                  <Printer className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="icon" className="h-9 w-9" title="Envoyer un email" onClick={onEmail}>
                  <AtSign className="h-4 w-4" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  title={archived ? 'Désarchiver' : 'Archiver'}
                  onClick={onArchive}
                  disabled={isArchiving}
                >
                  {isArchiving ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : archived ? (
                    <ArchiveRestore className="h-4 w-4" />
                  ) : (
                    <Archive className="h-4 w-4" />
                  )}
                </Button>
                <Button variant="gold" size="sm" onClick={onStartEdit}>
                  <Pencil className="h-3.5 w-3.5 mr-1.5" />
                  Modifier
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      <div
        className={cn(
          'h-1 w-24 mt-3 rounded-full',
          isEditing ? 'bg-accent' : 'bg-gradient-to-r from-accent via-accent to-accent/30',
        )}
      />
    </div>
  )
}

// ── Center: Detail Main ────────────────────────────────

function DetailMain({
  detail,
  isLoading,
  hasSelection,
  isEditing,
  draft,
  onDraftChange,
  onMutationSuccess,
  onTarifsUpdated,
  reportDirty,
}: {
  detail: RefDiversDetail | null
  isLoading: boolean
  hasSelection: boolean
  isEditing: boolean
  draft: HeaderDraft
  onDraftChange: (d: HeaderDraft) => void
  onMutationSuccess: () => void
  onTarifsUpdated: (t: Tarif[]) => void
  reportDirty: (key: string, dirty: boolean) => void
}) {
  if (!hasSelection) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="icon-box-gold h-16 w-16 mx-auto flex items-center justify-center">
            <Box className="h-8 w-8" />
          </div>
          <p className="text-muted-foreground text-sm">Sélectionnez une référence dans la liste</p>
        </div>
      </div>
    )
  }
  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-accent" />
      </div>
    )
  }
  if (!detail) return null

  // In edit mode the axes follow the draft so the Variations card reacts
  // immediately when the user turns an axis on; in view mode they follow the
  // persisted row.
  const type1 = isEditing ? draft.sTypeVariation1 : detail.sTypeVariation1
  const type2 = isEditing ? draft.sTypeVariation2 : detail.sTypeVariation2
  const hasVariations = type1 !== 'Aucun' || type2 !== 'Aucun'

  return (
    <div className="flex-1 min-h-0 overflow-auto space-y-4 px-1 pb-1">
      <IdentificationCard
        detail={detail}
        isEditing={isEditing}
        draft={draft}
        onDraftChange={onDraftChange}
        hasVariations={hasVariations}
      />
      <VariationsCard
        detail={detail}
        isEditing={isEditing}
        type1={type1}
        type2={type2}
        draft={draft}
        onDraftChange={onDraftChange}
        onMutationSuccess={onMutationSuccess}
        reportDirty={reportDirty}
      />
      {hasVariations && (
        <TarifsCard
          detail={detail}
          isEditing={isEditing}
          type1={type1}
          type2={type2}
          onTarifsUpdated={onTarifsUpdated}
        />
      )}
      <ObservationsCard detail={detail} isEditing={isEditing} draft={draft} onDraftChange={onDraftChange} />
    </div>
  )
}

// ── Identification Card ────────────────────────────────

function IdentificationCard({
  detail,
  isEditing,
  draft,
  onDraftChange,
  hasVariations,
}: {
  detail: RefDiversDetail
  isEditing: boolean
  draft: HeaderDraft
  onDraftChange: (d: HeaderDraft) => void
  hasVariations: boolean
}) {
  return (
    <Card className={cn('card-premium', isEditing && editSectionClass)}>
      <CardHeader className="flex flex-row items-center gap-2 p-4 pb-2 space-y-0">
        <Box className="h-4 w-4 text-accent" />
        <CardTitle className="text-sm font-semibold">Identification</CardTitle>
      </CardHeader>
      <CardContent className="pb-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <LabeledField label="Unité">
            {isEditing ? (
              <PopoverSelect
                options={UNITE_OPTIONS}
                value={UNITE_OPTIONS.some((o) => o.id === draft.unite) ? draft.unite : 0}
                onChange={(id) => onDraftChange({ ...draft, unite: id })}
                emptyLabel="— non définie —"
              />
            ) : (
              <p className="text-sm h-8 flex items-center">{detail.unite_label || '—'}</p>
            )}
          </LabeledField>
          {/* Legacy hides the flat price as soon as the reference carries
              variations — pricing then lives entirely in the Tarifs card. */}
          {hasVariations ? (
            <LabeledField label="Tarification">
              <p className="text-sm h-8 flex items-center">
                {detail.tarif_mode === 'global'
                  ? detail.tarif_global != null
                    ? `Prix global — ${fmtNum(detail.tarif_global, 2)} €`
                    : 'Prix global'
                  : `Par variation — ${detail.tarifs.length} combinaison${detail.tarifs.length > 1 ? 's' : ''}`}
              </p>
            </LabeledField>
          ) : (
            <LabeledField label="Prix unitaire (€)">
              {isEditing ? (
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={draft.prix_unitaire}
                  onChange={(e) => onDraftChange({ ...draft, prix_unitaire: e.target.value })}
                  className={cn(inputClass, 'tabular-nums')}
                />
              ) : (
                <p className="text-sm h-8 flex items-center tabular-nums">
                  {detail.prix_unitaire ? `${fmtNum(detail.prix_unitaire, 2)} €` : '—'}
                </p>
              )}
            </LabeledField>
          )}
        </div>
        {hasVariations && detail.prix_unitaire > 0 && (
          <p className="text-[11px] text-muted-foreground mt-3">
            Prix unitaire historique de la fiche : {fmtNum(detail.prix_unitaire, 2)} € — les tarifs ci-dessous font foi.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

// ── Variations Card ────────────────────────────────────

function VariationsCard({
  detail,
  isEditing,
  type1,
  type2,
  draft,
  onDraftChange,
  onMutationSuccess,
  reportDirty,
}: {
  detail: RefDiversDetail
  isEditing: boolean
  type1: VariationType
  type2: VariationType
  draft: HeaderDraft
  onDraftChange: (d: HeaderDraft) => void
  onMutationSuccess: () => void
  reportDirty: (key: string, dirty: boolean) => void
}) {
  const [open, setOpen] = useState(true)
  useEffect(() => {
    setOpen(true)
  }, [detail.IDref_divers])

  const orphans = detail.variations.filter((v) => v.niveau !== 1 && v.niveau !== 2)
  const count = detail.variations.filter((v) => v.niveau === 1 || v.niveau === 2).length

  return (
    <Card className={cn('card-premium', isEditing && editSectionClass)}>
      <CardHeader
        className="flex flex-row items-center gap-2 p-4 pb-2 space-y-0 cursor-pointer select-none"
        onClick={() => setOpen(!open)}
      >
        <Layers className="h-4 w-4 text-accent" />
        <CardTitle className="text-sm font-semibold">Variations</CardTitle>
        <Badge variant="secondary" className="text-xs ml-auto">
          {count}
        </Badge>
        <ChevronDown
          className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')}
        />
      </CardHeader>
      {open && (
        <CardContent className="space-y-3 pb-4">
          {/* View mode only surfaces the axes that are actually in use — an
              "Aucune" block would be pure noise on the ~370 flat references. */}
          {!isEditing && type1 === 'Aucun' && type2 === 'Aucun' && (
            <p className="text-sm text-muted-foreground italic">Aucune variation</p>
          )}
          {(isEditing || type1 !== 'Aucun') && (
            <AxisBlock
              refId={detail.IDref_divers}
              niveau={1}
              type={type1}
              variations={detail.variations.filter((v) => v.niveau === 1)}
              isEditing={isEditing}
              onTypeChange={(t) => onDraftChange({ ...draft, sTypeVariation1: t })}
              onMutationSuccess={onMutationSuccess}
              reportDirty={reportDirty}
            />
          )}
          {(isEditing || type2 !== 'Aucun') && (
            <AxisBlock
              refId={detail.IDref_divers}
              niveau={2}
              type={type2}
              variations={detail.variations.filter((v) => v.niveau === 2)}
              isEditing={isEditing}
              onTypeChange={(t) => onDraftChange({ ...draft, sTypeVariation2: t })}
              onMutationSuccess={onMutationSuccess}
              reportDirty={reportDirty}
              disabled={type1 === 'Aucun'}
            />
          )}
          {orphans.length > 0 && (
            <p className="text-[11px] text-muted-foreground italic">
              {orphans.length} valeur{orphans.length > 1 ? 's' : ''} héritée
              {orphans.length > 1 ? 's' : ''} de l'ancien modèle (sans axe) — invisible
              {orphans.length > 1 ? 's' : ''} dans l'application historique.
            </p>
          )}
        </CardContent>
      )}
    </Card>
  )
}

interface AxisForm {
  designation: string
}

function AxisBlock({
  refId,
  niveau,
  type,
  variations,
  isEditing,
  onTypeChange,
  onMutationSuccess,
  reportDirty,
  disabled = false,
}: {
  refId: number
  niveau: 1 | 2
  type: VariationType
  variations: Variation[]
  isEditing: boolean
  onTypeChange: (t: VariationType) => void
  onMutationSuccess: () => void
  reportDirty: (key: string, dirty: boolean) => void
  disabled?: boolean
}) {
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<AxisForm>({ designation: '' })
  const [deleteTarget, setDeleteTarget] = useState<Variation | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const dirtyKey = `divers-variation-${niveau}`
  const reportDirtyRef = useRef(reportDirty)
  useEffect(() => {
    reportDirtyRef.current = reportDirty
  })
  useEffect(() => {
    reportDirtyRef.current(dirtyKey, showForm || editingId !== null)
  }, [showForm, editingId, dirtyKey])
  useEffect(
    () => () => {
      reportDirtyRef.current(dirtyKey, false)
    },
    [dirtyKey],
  )

  const resetForm = () => {
    setForm({ designation: '' })
    setShowForm(false)
    setEditingId(null)
    setErrorMsg(null)
  }

  const createMut = useMutation({
    mutationFn: () =>
      apiFetch(`/references-divers/${refId}/variations`, {
        method: 'POST',
        body: JSON.stringify({ designation: form.designation, niveau }),
      }),
    onSuccess: () => {
      onMutationSuccess()
      resetForm()
    },
    onError: async () => {
      setErrorMsg(
        await readApiError(
          `/references-divers/${refId}/variations`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ designation: form.designation, niveau }),
          },
          "L'ajout a échoué.",
        ),
      )
    },
  })

  const updateMut = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/references-divers/${refId}/variations/${id}`, {
        method: 'PUT',
        body: JSON.stringify({ designation: form.designation }),
      }),
    onSuccess: () => {
      onMutationSuccess()
      resetForm()
    },
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/references-divers/${refId}/variations/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      onMutationSuccess()
      setDeleteTarget(null)
      setErrorMsg(null)
    },
    onError: async (_e, id) => {
      setErrorMsg(
        await readApiError(
          `/references-divers/${refId}/variations/${id}`,
          { method: 'DELETE' },
          'Suppression impossible.',
        ),
      )
    },
  })

  const Icon = axisIcon(type)
  const active = type !== 'Aucun'

  return (
    <>
      <div
        className={cn(
          'rounded-lg border border-border/60 bg-zinc-100/80 p-3',
          !active && 'opacity-70',
        )}
      >
        <div className="flex items-center gap-2">
          <div
            className={cn(
              'h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0',
              active ? 'bg-amber-400/10' : 'bg-muted',
            )}
          >
            <Icon className={cn('h-3.5 w-3.5', active ? 'text-amber-600' : 'text-muted-foreground')} />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
              Variation {niveau}
            </p>
            {!isEditing && <p className="text-sm font-medium">{variationTypeLabel(type)}</p>}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {isEditing && (
              <PopoverSelect
                size="sm"
                options={TYPE_OPTIONS}
                value={typeToId(type)}
                onChange={(id) => onTypeChange(idToType(id))}
                emptyLabel="Aucune"
                disabled={disabled}
                disabledTitle="Activez d'abord la variation 1"
              />
            )}
            {active && (
              <Badge variant="secondary" className="text-xs">
                {variations.length}
              </Badge>
            )}
          </div>
        </div>

        {active && (
          <div className="mt-3 space-y-2">
            {variations.length === 0 && !showForm && (
              <p className="text-xs text-muted-foreground italic">Aucune valeur</p>
            )}
            <div className="flex flex-wrap gap-1.5">
              {variations.map((v) =>
                editingId === v.IDref_divers_variation && isEditing ? null : (
                  <span
                    key={v.IDref_divers_variation}
                    className="group inline-flex items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-2.5 py-1 text-xs text-amber-800"
                  >
                    {v.designation || '—'}
                    {isEditing && (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(v.IDref_divers_variation)
                            setShowForm(false)
                            setForm({ designation: v.designation ?? '' })
                          }}
                          className="ml-0.5 opacity-0 group-hover:opacity-100 transition-opacity hover:text-foreground"
                          title="Modifier"
                        >
                          <Pencil className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setErrorMsg(null)
                            setDeleteTarget(v)
                          }}
                          className="opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive"
                          title="Supprimer"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </>
                    )}
                  </span>
                ),
              )}
              {isEditing && !showForm && editingId === null && (
                <button
                  type="button"
                  onClick={() => {
                    setShowForm(true)
                    setForm({ designation: '' })
                  }}
                  className="inline-flex items-center gap-1 rounded-full border border-dashed border-accent/40 px-2.5 py-1 text-xs text-accent hover:bg-accent/10 transition-colors"
                >
                  <Plus className="h-3 w-3" />
                  Ajouter
                </button>
              )}
            </div>

            {isEditing && (showForm || editingId !== null) && (
              <div className="rounded-lg border border-accent/25 bg-accent/[0.03] p-3 space-y-2">
                <p className="text-xs font-semibold text-accent uppercase tracking-wide">
                  {editingId !== null ? 'Modifier la valeur' : `Ajouter une valeur — ${variationTypeLabel(type)}`}
                </p>
                <input
                  value={form.designation}
                  autoFocus
                  onChange={(e) => setForm({ designation: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && form.designation.trim()) {
                      if (editingId !== null) updateMut.mutate(editingId)
                      else createMut.mutate()
                    }
                    if (e.key === 'Escape') resetForm()
                  }}
                  placeholder={type === 'Taille' ? 'ex. 8 Mètres' : 'ex. NOIR 5685'}
                  className={inputClass}
                />
                {errorMsg && <p className="text-xs text-destructive">{errorMsg}</p>}
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={resetForm}>
                    Annuler
                  </Button>
                  <Button
                    size="sm"
                    disabled={!form.designation.trim() || createMut.isPending || updateMut.isPending}
                    onClick={() => {
                      if (editingId !== null) updateMut.mutate(editingId)
                      else createMut.mutate()
                    }}
                  >
                    {createMut.isPending || updateMut.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <Save className="h-3.5 w-3.5 mr-1.5" />
                    )}
                    Enregistrer
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Supprimer la valeur"
        description={
          errorMsg ??
          (deleteTarget
            ? `${deleteTarget.designation ?? '—'} sera supprimée, ainsi que ses tarifs.`
            : undefined)
        }
        isPending={deleteMut.isPending}
        onCancel={() => {
          setDeleteTarget(null)
          setErrorMsg(null)
        }}
        onConfirm={() => {
          if (deleteTarget) deleteMut.mutate(deleteTarget.IDref_divers_variation)
        }}
      />
    </>
  )
}

// ── Tarifs Card ────────────────────────────────────────

const comboKey = (v1: number, v2: number) => `${v1}:${v2}`

function TarifsCard({
  detail,
  isEditing,
  type1,
  type2,
  onTarifsUpdated,
}: {
  detail: RefDiversDetail
  isEditing: boolean
  type1: VariationType
  type2: VariationType
  onTarifsUpdated: (t: Tarif[]) => void
}) {
  const [open, setOpen] = useState(true)
  const [modeTarget, setModeTarget] = useState<'global' | 'detail' | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  // Local mirror of the price cells — committed one at a time on blur.
  const [values, setValues] = useState<Record<string, string>>({})

  useEffect(() => {
    setOpen(true)
  }, [detail.IDref_divers])

  useEffect(() => {
    const next: Record<string, string> = {}
    for (const t of detail.tarifs) next[comboKey(t.IDVariation1, t.IDVariation2)] = String(t.prix ?? 0)
    setValues(next)
  }, [detail.tarifs])

  const axis1 = useMemo(() => detail.variations.filter((v) => v.niveau === 1), [detail.variations])
  const axis2 = useMemo(() => detail.variations.filter((v) => v.niveau === 2), [detail.variations])

  const rows = useMemo(() => {
    const out: Array<{ key: string; v1: number; v2: number; l1: string; l2: string }> = []
    if (axis1.length > 0 && axis2.length > 0) {
      for (const a of axis1)
        for (const b of axis2)
          out.push({
            key: comboKey(a.IDref_divers_variation, b.IDref_divers_variation),
            v1: a.IDref_divers_variation,
            v2: b.IDref_divers_variation,
            l1: a.designation ?? '—',
            l2: b.designation ?? '—',
          })
    } else if (axis1.length > 0) {
      for (const a of axis1)
        out.push({
          key: comboKey(a.IDref_divers_variation, 0),
          v1: a.IDref_divers_variation,
          v2: 0,
          l1: a.designation ?? '—',
          l2: '',
        })
    } else if (axis2.length > 0) {
      for (const b of axis2)
        out.push({
          key: comboKey(0, b.IDref_divers_variation),
          v1: 0,
          v2: b.IDref_divers_variation,
          l1: '',
          l2: b.designation ?? '—',
        })
    }
    return out
  }, [axis1, axis2])

  const upsertMut = useMutation({
    mutationFn: (vars: { v1: number; v2: number; prix: number }) =>
      apiFetch<{ tarifs: Tarif[] }>(`/references-divers/${detail.IDref_divers}/tarifs`, {
        method: 'PUT',
        body: JSON.stringify({ IDVariation1: vars.v1, IDVariation2: vars.v2, prix: vars.prix }),
      }),
    onSuccess: (payload) => onTarifsUpdated(payload.tarifs),
  })

  const modeMut = useMutation({
    mutationFn: (mode: 'global' | 'detail') =>
      apiFetch<{ tarifs: Tarif[] }>(`/references-divers/${detail.IDref_divers}/tarif-mode`, {
        method: 'POST',
        body: JSON.stringify({ mode }),
      }),
    onSuccess: (payload) => {
      onTarifsUpdated(payload.tarifs)
      setModeTarget(null)
      setErrorMsg(null)
    },
    onError: async (_e, mode) => {
      setErrorMsg(
        await readApiError(
          `/references-divers/${detail.IDref_divers}/tarif-mode`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }) },
          'Changement de mode impossible.',
        ),
      )
    },
  })

  const commit = (key: string, v1: number, v2: number) => {
    const raw = (values[key] ?? '').replace(',', '.')
    const n = raw === '' ? 0 : Number(raw)
    if (!Number.isFinite(n) || n < 0) return
    const saved = detail.tarifs.find((t) => comboKey(t.IDVariation1, t.IDVariation2) === key)
    if (saved && Math.abs(saved.prix - n) < 0.005) return
    if (!saved && n === 0) return
    upsertMut.mutate({ v1, v2, prix: Math.round(n * 100) / 100 })
  }

  const mode = detail.tarif_mode
  const axesLabel = [
    axis1.length > 0 ? variationTypePlural(type1) : null,
    axis2.length > 0 ? variationTypePlural(type2) : null,
  ].filter(Boolean) as string[]
  const noValues = rows.length === 0

  return (
    <>
      <Card className={cn('card-premium', isEditing && editSectionClass)}>
        <CardHeader
          className="flex flex-row items-center gap-2 p-4 pb-2 space-y-0 cursor-pointer select-none"
          onClick={() => setOpen(!open)}
        >
          <BadgeEuro className="h-4 w-4 text-accent" />
          <CardTitle className="text-sm font-semibold">Tarifs</CardTitle>
          <Badge variant="secondary" className="text-xs ml-auto">
            {mode === 'global' ? 'Global' : `${detail.tarifs.length} combinaison${detail.tarifs.length > 1 ? 's' : ''}`}
          </Badge>
          <ChevronDown
            className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')}
          />
        </CardHeader>
        {open && (
          <CardContent className="space-y-3 pb-4">
            {/* Saisie du prix — legacy combo, rebuilt as a segmented switch */}
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-xs font-medium text-muted-foreground">Saisie du prix</span>
              <div className="flex gap-1">
                {(['global', 'detail'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    disabled={!isEditing || modeMut.isPending}
                    onClick={() => {
                      if (m !== mode) {
                        setErrorMsg(null)
                        setModeTarget(m)
                      }
                    }}
                    className={cn(
                      'px-2.5 py-1 text-xs rounded-md transition-colors',
                      mode === m
                        ? 'bg-accent text-accent-foreground shadow-sm font-medium'
                        : 'text-muted-foreground hover:bg-accent/10',
                      !isEditing && 'cursor-default',
                    )}
                  >
                    {m === 'global' ? 'Global' : 'Par variation'}
                  </button>
                ))}
              </div>
              {modeMut.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />}
            </div>

            {mode === 'global' ? (
              <div className="rounded-lg border border-border/60 bg-zinc-100/80 p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      Toutes les {axesLabel.length > 0 ? axesLabel.join(' / ') : 'variations'}
                    </p>
                    <p className="text-[11px] text-muted-foreground">Un seul prix pour toutes les combinaisons</p>
                  </div>
                  {isEditing ? (
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={values[comboKey(0, 0)] ?? ''}
                      onChange={(e) => setValues((p) => ({ ...p, [comboKey(0, 0)]: e.target.value }))}
                      onBlur={() => commit(comboKey(0, 0), 0, 0)}
                      className="h-8 w-32 px-2.5 text-sm text-right tabular-nums rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  ) : (
                    <span className="text-sm font-semibold tabular-nums">
                      {detail.tarif_global != null ? `${fmtNum(detail.tarif_global, 2)} €` : '—'}
                    </span>
                  )}
                </div>
              </div>
            ) : noValues ? (
              <p className="text-sm text-muted-foreground italic">
                Ajoutez des valeurs de variation pour saisir les tarifs.
              </p>
            ) : (
              <div className="rounded-lg border border-border/60 bg-white overflow-hidden">
                <div className="max-h-80 overflow-auto scrollbar-transparent">
                  <table className="w-full text-sm">
                    <thead className="bg-zinc-200/60 sticky top-0">
                      <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                        {axis1.length > 0 && (
                          <th className="px-3 py-2 text-left font-semibold">{variationTypeLabel(type1)}</th>
                        )}
                        {axis2.length > 0 && (
                          <th className="px-3 py-2 text-left font-semibold">{variationTypeLabel(type2)}</th>
                        )}
                        <th className="px-3 py-2 text-right font-semibold w-32">Prix (€)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.key} className="border-t border-border/40">
                          {axis1.length > 0 && <td className="px-3 py-1.5 truncate">{r.l1}</td>}
                          {axis2.length > 0 && <td className="px-3 py-1.5 truncate">{r.l2}</td>}
                          <td className="px-3 py-1.5 text-right">
                            {isEditing ? (
                              <input
                                type="number"
                                step="0.01"
                                min="0"
                                value={values[r.key] ?? ''}
                                onChange={(e) => setValues((p) => ({ ...p, [r.key]: e.target.value }))}
                                onBlur={() => commit(r.key, r.v1, r.v2)}
                                className="h-7 w-24 px-2 text-sm text-right tabular-nums rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
                              />
                            ) : (
                              <span className="tabular-nums">
                                {values[r.key] != null && values[r.key] !== ''
                                  ? `${fmtNum(Number(values[r.key]), 2)} €`
                                  : '—'}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {isEditing && mode === 'detail' && rows.length > 0 && (
              <p className="text-[11px] text-muted-foreground">
                Chaque prix est enregistré dès que vous quittez la case.
              </p>
            )}
          </CardContent>
        )}
      </Card>
      <ConfirmDialog
        open={modeTarget !== null}
        title={modeTarget === 'global' ? 'Passer à un prix global' : 'Détailler les tarifs'}
        description={
          errorMsg ??
          (modeTarget === 'global'
            ? 'Les tarifs par variation seront remplacés par un prix unique. Cette action est irréversible.'
            : 'Un tarif sera créé pour chaque combinaison de variations, à partir du prix global actuel.')
        }
        confirmLabel={modeTarget === 'global' ? 'Passer en global' : 'Détailler'}
        variant="default"
        isPending={modeMut.isPending}
        onCancel={() => {
          setModeTarget(null)
          setErrorMsg(null)
        }}
        onConfirm={() => {
          if (modeTarget) modeMut.mutate(modeTarget)
        }}
      />
    </>
  )
}

// ── Observations Card ──────────────────────────────────

function ObservationsCard({
  detail,
  isEditing,
  draft,
  onDraftChange,
}: {
  detail: RefDiversDetail
  isEditing: boolean
  draft: HeaderDraft
  onDraftChange: (d: HeaderDraft) => void
}) {
  if (!isEditing && !detail.observations?.trim()) return null
  return (
    <Card className={cn('card-premium', isEditing && editSectionClass)}>
      <CardHeader className="flex flex-row items-center gap-2 p-4 pb-2 space-y-0">
        <FileText className="h-4 w-4 text-accent" />
        <CardTitle className="text-sm font-semibold">Observations</CardTitle>
      </CardHeader>
      <CardContent className="pb-4">
        {isEditing ? (
          <textarea
            rows={4}
            value={draft.observations}
            onChange={(e) => onDraftChange({ ...draft, observations: e.target.value })}
            className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
          />
        ) : (
          <p className="text-sm text-muted-foreground whitespace-pre-line">{detail.observations}</p>
        )}
      </CardContent>
    </Card>
  )
}

// ── Right Panel: Sidebar ───────────────────────────────

const SIDEBAR_TABS = [
  { key: 'stock', label: 'Stock', icon: Warehouse },
  { key: 'commandes', label: 'Commandes', icon: ShoppingCart },
] as const
type SidebarTab = (typeof SIDEBAR_TABS)[number]['key']

function DetailSidebar({ detail }: { detail: RefDiversDetail | null }) {
  const [tab, setTab] = useState<SidebarTab>('stock')
  useEffect(() => {
    setTab('stock')
  }, [detail?.IDref_divers])

  if (!detail) {
    return (
      <div className="w-96 flex-shrink-0 rounded-xl border flex items-center justify-center bg-zinc-100/80">
        <Loader2 className="h-6 w-6 animate-spin text-accent" />
      </div>
    )
  }

  return (
    <div className="w-96 flex-shrink-0 rounded-xl border flex flex-col overflow-hidden bg-zinc-100/80">
      <div className="flex border-b p-1 gap-1 rounded-t-xl bg-zinc-200/50">
        {SIDEBAR_TABS.map((t) => {
          const Icon = t.icon
          const active = tab === t.key
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md transition-colors',
                active ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          )
        })}
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-transparent">
        {tab === 'stock' ? <StockTab detail={detail} /> : <CommandesTab detail={detail} />}
      </div>
    </div>
  )
}

function StockTab({ detail }: { detail: RefDiversDetail }) {
  return (
    <>
      <div className="p-3 rounded-lg border bg-card shadow-sm">
        <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 mb-1">
          <Warehouse className="h-3.5 w-3.5" />
          Stock total
        </p>
        <p className="text-2xl font-bold tabular-nums text-accent">
          {fmtNum(detail.stock_total, 2)}{' '}
          <span className="text-sm font-normal text-muted-foreground">{detail.unite_label}</span>
        </p>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          {detail.stock.length} ligne{detail.stock.length !== 1 ? 's' : ''} de stock
        </p>
      </div>
      {detail.stock.length === 0 ? (
        <p className="text-sm text-muted-foreground italic px-1">Aucun stock enregistré</p>
      ) : (
        detail.stock.map((s) => {
          const labels = [s.variation1_label, s.variation2_label].filter(Boolean) as string[]
          return (
            <div key={s.IDstock_divers} className="p-3 rounded-lg border bg-card shadow-sm">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium truncate">
                  {labels.length > 0 ? labels.join(' · ') : 'Sans variation'}
                </p>
                <span className="text-sm font-semibold tabular-nums flex-shrink-0">
                  {fmtNum(s.quantite, 2)} {s.unite_label || detail.unite_label}
                </span>
              </div>
            </div>
          )
        })
      )}
    </>
  )
}

function CommandesTab({ detail }: { detail: RefDiversDetail }) {
  if (detail.commandes.length === 0) {
    return <p className="text-sm text-muted-foreground italic px-1">Aucune commande client</p>
  }
  return (
    <>
      <div className="p-3 rounded-lg border bg-card shadow-sm space-y-2">
        <p className="text-xs font-semibold text-muted-foreground">Utilisation</p>
        <KV label="Lignes de commande" value={<span className="tabular-nums">{detail.usage.lignes_commande}</span>} />
        <KV label="Lignes de devis" value={<span className="tabular-nums">{detail.usage.lignes_devis}</span>} />
        <KV label="Lignes d'expédition" value={<span className="tabular-nums">{detail.usage.expeditions}</span>} />
        {detail.usage.lignes_commande > detail.commandes.length && (
          <p className="text-[11px] text-muted-foreground pt-1">
            {detail.commandes.length} dernières lignes affichées
          </p>
        )}
      </div>
      {detail.commandes.map((c) => {
        const labels = [c.variation1_label, c.variation2_label].filter(Boolean) as string[]
        return (
          <div key={c.IDligne_commande_client} className="p-3 rounded-lg border bg-card shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium truncate">{c.client_nom || '—'}</p>
              <span className="text-[11px] text-muted-foreground flex-shrink-0 tabular-nums">
                N°{c.numero}
              </span>
            </div>
            {labels.length > 0 && (
              <p className="text-[11px] text-muted-foreground truncate mt-0.5">{labels.join(' · ')}</p>
            )}
            <div className="flex items-center justify-between gap-2 mt-1 text-[11px] text-muted-foreground">
              <span className="tabular-nums">
                {fmtNum(c.quantite, 2)} {c.unite_label} × {fmtNum(c.prix, 2)} €
              </span>
              <span className="flex-shrink-0">
                {c.date_commande ? formatHfsqlDate(c.date_commande) : '—'}
              </span>
            </div>
          </div>
        )
      })}
    </>
  )
}
