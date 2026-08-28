import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { UnsavedChangesDialog } from '@/components/shared/UnsavedChangesDialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Search,
  Loader2,
  AlertCircle,
  Pencil,
  Plus,
  X,
  Save,
  Trash2,
  Info,
  Leaf,
  Recycle,
  ChevronDown,
  Package,
  FlaskConical,
  Warehouse,
  ShoppingCart,
  MessageSquare,
  Palette,
  Factory,
  Tag,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PopoverSelect, SearchableCombobox } from '@/components/ui/popover-select'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'
import { BobineIcon } from '@/components/icons/BobineIcon'
import { cn } from '@/lib/utils'
import { apiFetch } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { formatHfsqlDate } from '@/lib/dates'

// ── Types ──────────────────────────────────────────────

interface RefFilListRow {
  IDref_fil: number
  reference: string
  prix_kg: number | null
  commentaire: string | null
  bio: number
  recycle: number
  titrage: number | null
  nb_fil: number | null
  nb_brin: number | null
  IDunite_titrage: number | null
  variantes_count: number
  fournisseurs_count: number
}

interface Variante {
  IDcolori_fil: number
  IDref_fil: number
  reference: string | null
  prix_kg: number | null
  stock_mini: number | null
  commentaire: string | null
  fournisseurs_count: number
  fournisseurs: { IDfournisseur: number; nom: string | null }[]
}

interface Composition {
  IDasso_fil_matiere: number
  IDRef_fil: number
  IDmatiere: number
  pourcentage: number | null
  bio: number
  recycle: number
  matiere_libelle: string | null
}

interface StockPerVariante {
  IDcolori_fil: number
  total_kg: number
  lots: number
}

interface FournisseurRef {
  IDfournisseur: number
  nom: string | null
}

interface CommandeHistoryRow {
  IDref_fil_commande: number
  IDcommande_fil: number
  quantite: number
  prix_unitaire: number | null
  IDcolori_fil: number
  colori_reference: string | null
  date_commande: string | null
  etat: number
  IDfournisseur: number
  fournisseur_nom: string | null
}

interface OffreFilRow {
  IDoffre_fil: number
  IDfournisseur: number
  fournisseur_nom: string | null
  IDcolori_fil: number
  colori_reference: string | null
  prix: number | null
  quantite: number | null
  date: string | null
  observation: string | null
}

interface RefFilDetail extends RefFilListRow {
  variantes: Variante[]
  composition: Composition[]
  stock_total_kg: number
  stock_lots: number
  stock_per_variante: StockPerVariante[]
  commande_total_kg: number
  commande_lignes: number
  /** Still expected from suppliers: open lines of open commandes, minus what
   *  already landed. NOT commande_total_kg, which is the whole purchase history
   *  (×28 too big across the catalog — ticket #1090). */
  commande_reste_kg: number
  commande_lignes_ouvertes: number
  commande_history: CommandeHistoryRow[]
  offres: OffreFilRow[]
  fournisseurs: FournisseurRef[]
}

interface MatiereLookup {
  IDmatiere_premiere: number
  libelle: string
}

interface UniteLookup {
  IDunite_titrage: number
  nomenclature: string
}

// ── Shared styling ─────────────────────────────────────

const inputClass =
  'w-full h-8 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring'
const editSectionClass = 'border-l-4 border-l-accent/70 bg-accent/[0.03]'

// ── Shared bits ────────────────────────────────────────

function LabeledInput({
  label,
  value,
  onChange,
  type = 'text',
  step,
  placeholder,
}: {
  label: string
  value: string | number
  onChange: (v: string) => void
  type?: string
  step?: string
  placeholder?: string
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <input
        type={type}
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={inputClass}
      />
    </div>
  )
}

/** §35 inline pill toggle switch. */
function Pill({
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

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm text-right truncate">{value}</span>
    </div>
  )
}

/** Format a stored pourcentage (0..1) as a percent value for display. */
function pct(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${fmtNum(v * 100, 1)}%`
}

function titrageLabel(t: number | null, unite: string | null, nbFil: number | null, nbBrin: number | null): string {
  const parts: string[] = []
  if (t != null && t > 0) parts.push(`${fmtNum(t, 0)}${unite ? ` ${unite}` : ''}`)
  if (nbFil != null && nbFil > 0 && nbBrin != null && nbBrin > 0) parts.push(`${nbFil}/${nbBrin}`)
  return parts.join(' · ')
}

// ── API helpers ────────────────────────────────────────

function useRefsFil() {
  return useQuery<RefFilListRow[]>({
    queryKey: ['refs-fil'],
    queryFn: () => apiFetch('/references-fil'),
  })
}

function useRefFilDetail(id: number | null) {
  return useQuery<RefFilDetail>({
    queryKey: ['ref-fil', id],
    queryFn: () => apiFetch(`/references-fil/${id}`),
    enabled: id !== null,
  })
}

function useMatieresLookup() {
  return useQuery<MatiereLookup[]>({
    queryKey: ['ref-fil-lookups-matieres'],
    queryFn: () => apiFetch('/references-fil/lookups/matieres'),
    staleTime: 5 * 60_000,
  })
}

function useUnitesLookup() {
  return useQuery<UniteLookup[]>({
    queryKey: ['ref-fil-lookups-unites'],
    queryFn: () => apiFetch('/references-fil/lookups/unites-titrage'),
    staleTime: 5 * 60_000,
  })
}

// ── Page ───────────────────────────────────────────────

interface HeaderDraft {
  reference: string
  commentaire: string
  prix_kg: string
  titrage: string
  nb_fil: string
  nb_brin: string
  IDunite_titrage: number
  bio: boolean
  recycle: boolean
}

function emptyDraft(): HeaderDraft {
  return {
    reference: '',
    commentaire: '',
    prix_kg: '',
    titrage: '',
    nb_fil: '',
    nb_brin: '',
    IDunite_titrage: 0,
    bio: false,
    recycle: false,
  }
}

function draftFromDetail(d: RefFilDetail): HeaderDraft {
  return {
    reference: d.reference ?? '',
    commentaire: d.commentaire ?? '',
    prix_kg: d.prix_kg != null ? String(d.prix_kg) : '',
    titrage: d.titrage != null ? String(d.titrage) : '',
    nb_fil: d.nb_fil != null ? String(d.nb_fil) : '',
    nb_brin: d.nb_brin != null ? String(d.nb_brin) : '',
    IDunite_titrage: Number(d.IDunite_titrage) || 0,
    bio: !!d.bio,
    recycle: !!d.recycle,
  }
}

function draftToBody(d: HeaderDraft) {
  const num = (s: string) => (s === '' ? 0 : Number(s))
  return {
    reference: d.reference.trim(),
    commentaire: d.commentaire,
    prix_kg: num(d.prix_kg),
    titrage: num(d.titrage),
    nb_fil: num(d.nb_fil),
    nb_brin: num(d.nb_brin),
    IDunite_titrage: d.IDunite_titrage || 0,
    bio: d.bio,
    recycle: d.recycle,
  }
}

export function FilsReferences() {
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState<HeaderDraft>(emptyDraft())

  const originalDraftRef = useRef<HeaderDraft | null>(null)

  // Per-key dirty registry (§28.3.b) — composition card + variantes card + notes edit
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

  // Auto-edit after create (§25.1)
  const [autoEditForId, setAutoEditForId] = useState<number | null>(null)

  // Placeholder dialogs
  // Delete confirm
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  // Create failure feedback (the POST has no inline surface — surface it here)
  const [createError, setCreateError] = useState<string | null>(null)

  const { data: refs, isLoading, isError, error } = useRefsFil()
  const { data: detail, isLoading: detailLoading } = useRefFilDetail(selectedId)
  const { data: unites } = useUnitesLookup()

  const compositionTotalPct = useMemo(() => {
    if (!detail) return 0
    return detail.composition.reduce(
      (s, c) => s + (Number(c.pourcentage) || 0) * 100,
      0,
    )
  }, [detail])
  const compositionOk = Math.abs(compositionTotalPct - 100) < 0.01

  const [saveBlockedReason, setSaveBlockedReason] = useState<string | null>(null)
  useEffect(() => {
    if (!isEditing && saveBlockedReason) setSaveBlockedReason(null)
    else if (compositionOk && saveBlockedReason) setSaveBlockedReason(null)
  }, [compositionOk, isEditing, saveBlockedReason])

  /** Guard for any action that exits edit mode (Enregistrer or Annuler). Returns
   *  true when blocked — caller should not proceed. Surfaces the alert dialog. */
  const blockExitIfBadComposition = useCallback((): boolean => {
    if (compositionOk) return false
    const fmt = Math.round(compositionTotalPct * 1000) / 1000
    setSaveBlockedReason(
      `La composition doit totaliser 100% (actuellement ${fmt}%). Corrigez la composition avant de quitter le mode édition.`,
    )
    return true
  }, [compositionOk, compositionTotalPct])

  const filtered = useMemo(() => {
    if (!refs) return []
    if (!searchQuery.trim()) return refs
    const q = searchQuery.toLowerCase()
    return refs.filter(
      (r) =>
        r.reference.toLowerCase().includes(q) ||
        (r.commentaire ?? '').toLowerCase().includes(q),
    )
  }, [refs, searchQuery])

  // Keep the selection valid against the search-filtered list: narrowing the
  // search re-targets the top row instead of leaving the previous ref on screen.
  useAutoSelectFirst({
    rows: filtered,
    selectedId,
    getId: (r) => r.IDref_fil,
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
    originalDraftRef.current = null
  }, [])

  const isDirty = useMemo(() => {
    if (!isEditing) return false
    const o = originalDraftRef.current
    if (!o) return false
    if (draft.reference !== o.reference) return true
    if (draft.commentaire !== o.commentaire) return true
    if (draft.prix_kg !== o.prix_kg) return true
    if (draft.titrage !== o.titrage) return true
    if (draft.nb_fil !== o.nb_fil) return true
    if (draft.nb_brin !== o.nb_brin) return true
    if (draft.IDunite_titrage !== o.IDunite_titrage) return true
    if (draft.bio !== o.bio) return true
    if (draft.recycle !== o.recycle) return true
    if (subFormsDirty) return true
    return false
  }, [isEditing, draft, subFormsDirty])

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['refs-fil'] })
    queryClient.invalidateQueries({ queryKey: ['ref-fil', selectedId] })
  }, [queryClient, selectedId])

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/references-fil/${selectedId}`, {
        method: 'PUT',
        body: JSON.stringify(draftToBody(draft)),
      }),
    onSuccess: () => {
      invalidateAll()
      setIsEditing(false)
      originalDraftRef.current = null
    },
  })

  const createMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ IDref_fil: number | null }>(`/references-fil`, {
        method: 'POST',
        body: JSON.stringify({
          reference: 'Nouvelle référence',
          bio: false,
          recycle: false,
        }),
      }),
    onSuccess: (data) => {
      setCreateError(null)
      queryClient.invalidateQueries({ queryKey: ['refs-fil'] })
      if (data.IDref_fil != null) {
        setSelectedId(data.IDref_fil)
        setAutoEditForId(data.IDref_fil)
      }
    },
    onError: (err: Error & { status?: number }) => {
      setCreateError(
        err.status === 401
          ? 'Votre session a expiré. Veuillez vous reconnecter, puis réessayer.'
          : 'La création de la référence a échoué. Veuillez réessayer.',
      )
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => apiFetch(`/references-fil/${selectedId}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleteConfirmOpen(false)
      setDeleteError(null)
      const cached = queryClient.getQueryData<RefFilListRow[]>(['refs-fil']) ?? []
      const remaining = cached.filter((r) => r.IDref_fil !== selectedId)
      queryClient.invalidateQueries({ queryKey: ['refs-fil'] })
      setSelectedId(remaining.length > 0 ? remaining[0].IDref_fil : null)
    },
    onError: async (err: Error & { status?: number }) => {
      // Try to surface the API's French error message
      let msg = 'Suppression impossible.'
      try {
        const res = await fetch(
          `${import.meta.env.VITE_API_URL || 'http://localhost:3002/api'}/references-fil/${selectedId}`,
          { method: 'DELETE', credentials: 'include' },
        )
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          if (body?.error) msg = String(body.error)
        }
      } catch {
        // keep default
      }
      setDeleteError(msg)
    },
  })

  // §25.1 auto-edit after create
  useEffect(() => {
    if (autoEditForId !== null && detail?.IDref_fil === autoEditForId) {
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
    shouldBlockExit: isEditing && !compositionOk,
    onExitBlocked: () => {
      blockExitIfBadComposition()
    },
  })

  const handleSelect = useCallback(
    (id: number) => {
      guard.guardAction(() => {
        setIsEditing(false)
        originalDraftRef.current = null
        setSelectedId(id)
      })
    },
    [guard],
  )

  return (
    <>
      <MasterDetailLayout
        list={
          <RefFilList
            refs={filtered}
            isLoading={isLoading}
            isError={isError}
            error={error as Error | null}
            selectedId={selectedId}
            onSelect={handleSelect}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
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
            onCancelEdit={() => {
              if (blockExitIfBadComposition()) return
              setDirtyKeys(new Set())
              cancelEdit()
            }}
            onSave={() => {
              if (blockExitIfBadComposition()) return
              saveMutation.mutate()
            }}
            isSaving={saveMutation.isPending}
            onDelete={() => {
              setDeleteError(null)
              setDeleteConfirmOpen(true)
            }}
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
            unites={unites ?? []}
            refFilId={selectedId}
            onMutationSuccess={invalidateAll}
            reportDirty={reportDirty}
          />
        }
        sidebar={
          selectedId !== null ? (
            <DetailSidebar
              detail={detail ?? null}
              isEditing={isEditing}
              draft={draft}
              onDraftChange={setDraft}
            />
          ) : null
        }
        sidebarTitle="Informations"
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
          'Cette action supprimera définitivement la référence de fil. Elle est irréversible.'
        }
        isPending={deleteMutation.isPending}
        onCancel={() => {
          setDeleteConfirmOpen(false)
          setDeleteError(null)
        }}
        onConfirm={() => {
          setIsEditing(false)
          deleteMutation.mutate()
        }}
      />
      <AlertDialog
        open={saveBlockedReason !== null}
        onOpenChange={(o) => { if (!o) setSaveBlockedReason(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-destructive" />
              Composition incomplète
            </AlertDialogTitle>
            <AlertDialogDescription>{saveBlockedReason}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:gap-2 mt-4">
            <Button onClick={() => setSaveBlockedReason(null)}>OK</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={createError !== null}
        onOpenChange={(o) => { if (!o) setCreateError(null) }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-destructive" />
              Création impossible
            </AlertDialogTitle>
            <AlertDialogDescription>{createError}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:gap-2 mt-4">
            <Button onClick={() => setCreateError(null)}>OK</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

// ── Left Panel: List ───────────────────────────────────

function RefFilList({
  refs,
  isLoading,
  isError,
  error,
  selectedId,
  onSelect,
  searchQuery,
  onSearchChange,
  onNew,
  isCreating,
  isEditing,
}: {
  refs: RefFilListRow[]
  isLoading: boolean
  isError: boolean
  error: Error | null
  selectedId: number | null
  onSelect: (id: number) => void
  searchQuery: string
  onSearchChange: (q: string) => void
  onNew: () => void
  isCreating: boolean
  isEditing: boolean
}) {
  return (
    <div className="flex flex-col h-full rounded-lg border shadow-sm bg-zinc-100/80">
      <div className="p-3 border-b rounded-t-lg bg-zinc-200/50">
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
            <BobineIcon className="h-12 w-12 mb-3 opacity-50" />
            <p className="text-sm">Aucune référence</p>
          </div>
        ) : (
          refs.map((r) => (
            <div
              key={r.IDref_fil}
              onClick={() => onSelect(r.IDref_fil)}
              className={cn(
                'p-3 border rounded-lg cursor-pointer transition-all bg-white',
                selectedId === r.IDref_fil
                  ? 'border-accent ring-1 ring-accent'
                  : 'border-border hover:border-accent/50',
              )}
            >
              <div className="flex items-center gap-2 min-w-0">
                <BobineIcon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <p className="font-medium text-sm truncate flex-1">{r.reference}</p>
                {!!r.bio && (
                  <Leaf className="h-3.5 w-3.5 text-green-600 flex-shrink-0" aria-label="Bio" />
                )}
                {!!r.recycle && (
                  <Recycle className="h-3.5 w-3.5 text-teal-600 flex-shrink-0" aria-label="Recyclé" />
                )}
              </div>
              <div className="flex items-center justify-between gap-2 mt-1 text-[11px] text-muted-foreground">
                <span className="truncate">
                  {r.variantes_count} coloris · {r.fournisseurs_count} fournisseur
                  {r.fournisseurs_count !== 1 ? 's' : ''}
                </span>
                {r.prix_kg != null && r.prix_kg > 0 && (
                  <span className="flex-shrink-0 tabular-nums">{fmtNum(r.prix_kg, 2)} €/kg</span>
                )}
              </div>
            </div>
          ))
        )}
      </div>
      <div className="p-3 border-t text-xs text-muted-foreground flex items-center justify-between rounded-b-lg bg-zinc-200/50">
        <span>
          {refs.length} référence{refs.length !== 1 ? 's' : ''}
        </span>
        {!isEditing && (
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
}: {
  detail: RefFilDetail | null
  isLoading: boolean
  isEditing: boolean
  draft: HeaderDraft
  onDraftChange: (d: HeaderDraft) => void
  onStartEdit: () => void
  onCancelEdit: () => void
  onSave: () => void
  isSaving: boolean
  onDelete: () => void
}) {
  if (!detail && !isLoading) return null
  return (
    <div className="flex-shrink-0 pt-0.5">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            'h-11 w-11 rounded-lg flex items-center justify-center',
            isEditing ? 'bg-accent/15' : 'icon-box-gold',
          )}
        >
          <BobineIcon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          {isLoading ? (
            <div className="h-8 w-48 bg-muted animate-pulse rounded" />
          ) : isEditing ? (
            <div className="flex items-center gap-3">
              <input
                value={draft.reference}
                onChange={(e) => onDraftChange({ ...draft, reference: e.target.value })}
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
              <h1 className="text-2xl font-heading font-bold tracking-tight truncate">{detail?.reference}</h1>
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
  unites,
  refFilId,
  onMutationSuccess,
  reportDirty,
}: {
  detail: RefFilDetail | null
  isLoading: boolean
  hasSelection: boolean
  isEditing: boolean
  draft: HeaderDraft
  onDraftChange: (d: HeaderDraft) => void
  unites: UniteLookup[]
  refFilId: number | null
  onMutationSuccess: () => void
  reportDirty: (key: string, dirty: boolean) => void
}) {
  if (!hasSelection) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="icon-box-gold h-16 w-16 mx-auto">
            <BobineIcon className="h-8 w-8" />
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

  return (
    <div className="flex-1 min-h-0 overflow-auto space-y-4 pr-1">
      <SpecsCard
        detail={detail}
        isEditing={isEditing}
        draft={draft}
        onDraftChange={onDraftChange}
        unites={unites}
      />
      <CompositionCard
        detail={detail}
        isEditing={isEditing}
        refFilId={refFilId}
        onMutationSuccess={onMutationSuccess}
        reportDirty={reportDirty}
      />
      <VariantesCard
        detail={detail}
        isEditing={isEditing}
        refFilId={refFilId}
        onMutationSuccess={onMutationSuccess}
        reportDirty={reportDirty}
      />
      {!isEditing && <StockAggregateCard detail={detail} isEditing={isEditing} />}
      {!isEditing && <CommandesAggregateCard detail={detail} isEditing={isEditing} />}
      <OffresHistoryCard
        detail={detail}
        isEditing={isEditing}
        refFilId={refFilId}
        onMutationSuccess={onMutationSuccess}
        reportDirty={reportDirty}
      />
    </div>
  )
}

// ── Specs Card ─────────────────────────────────────────

function SpecsCard({
  detail,
  isEditing,
  draft,
  onDraftChange,
  unites,
}: {
  detail: RefFilDetail
  isEditing: boolean
  draft: HeaderDraft
  onDraftChange: (d: HeaderDraft) => void
  unites: UniteLookup[]
}) {
  const uniteNom = unites.find((u) => u.IDunite_titrage === detail.IDunite_titrage)?.nomenclature ?? null
  return (
    <Card className={cn('card-premium', isEditing && editSectionClass)}>
      <CardHeader className="flex flex-row items-center gap-2 p-4 space-y-0 pb-2">
        <Package className="h-4 w-4 text-accent" />
        <CardTitle className="text-sm font-semibold">Spécifications</CardTitle>
        <div className="ml-auto flex gap-1.5 flex-wrap">
          {!!detail.bio && (
            <Badge className="badge-success text-[10px] py-0 px-1.5 gap-1">
              <Leaf className="h-2.5 w-2.5" />
              Bio
            </Badge>
          )}
          {!!detail.recycle && (
            <Badge className="bg-teal-500/10 text-teal-700 ring-1 ring-teal-500/20 text-[10px] py-0 px-1.5 gap-1">
              <Recycle className="h-2.5 w-2.5" />
              Recyclé
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="pb-4">
        {isEditing ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <LabeledInput
                label="Titrage"
                type="number"
                step="0.1"
                value={draft.titrage}
                onChange={(v) => onDraftChange({ ...draft, titrage: v })}
              />
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Unité de titrage</label>
                <PopoverSelect
                  options={unites.map((u) => ({ id: u.IDunite_titrage, primary: u.nomenclature }))}
                  value={draft.IDunite_titrage}
                  onChange={(id) => onDraftChange({ ...draft, IDunite_titrage: id })}
                  emptyLabel="—"
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2">
              <LabeledInput
                label="Nb fil"
                type="number"
                value={draft.nb_fil}
                onChange={(v) => onDraftChange({ ...draft, nb_fil: v })}
              />
              <LabeledInput
                label="Nb brin"
                type="number"
                value={draft.nb_brin}
                onChange={(v) => onDraftChange({ ...draft, nb_brin: v })}
              />
              <LabeledInput
                label="Prix (€/kg)"
                type="number"
                step="0.01"
                value={draft.prix_kg}
                onChange={(v) => onDraftChange({ ...draft, prix_kg: v })}
              />
            </div>
            <div className="flex items-center gap-6 pt-1">
              <label className="flex items-center gap-2 text-xs font-medium">
                <Pill value={draft.bio} onChange={(v) => onDraftChange({ ...draft, bio: v })} />
                <span className="flex items-center gap-1">
                  <Leaf className="h-3 w-3 text-green-600" />
                  Bio
                </span>
              </label>
              <label className="flex items-center gap-2 text-xs font-medium">
                <Pill value={draft.recycle} onChange={(v) => onDraftChange({ ...draft, recycle: v })} />
                <span className="flex items-center gap-1">
                  <Recycle className="h-3 w-3 text-teal-600" />
                  Recyclé
                </span>
              </label>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-baseline gap-x-10 gap-y-2">
            <div className="flex items-baseline gap-2">
              <span className="text-xs text-muted-foreground">Titrage</span>
              <span className="text-lg font-semibold tabular-nums">
                {detail.titrage != null && detail.titrage > 0
                  ? `${fmtNum(detail.titrage, 0)}${uniteNom ? ` ${uniteNom}` : ''}`
                  : '—'}
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-xs text-muted-foreground">Fil / Brin</span>
              <span className="text-lg font-semibold tabular-nums">
                {`${detail.nb_fil ?? '—'} / ${detail.nb_brin ?? '—'}`}
              </span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-xs text-muted-foreground">Prix de base</span>
              <span className="text-lg font-semibold tabular-nums">
                {detail.prix_kg != null && detail.prix_kg > 0
                  ? `${fmtNum(detail.prix_kg, 2)} €/kg`
                  : '—'}
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── Composition Card ───────────────────────────────────

interface CompositionDraft {
  IDmatiere: number
  pourcentage: string // percent as displayed (0..100)
  bio: boolean
  recycle: boolean
}

function CompositionCard({
  detail,
  isEditing,
  refFilId,
  onMutationSuccess,
  reportDirty,
}: {
  detail: RefFilDetail
  isEditing: boolean
  refFilId: number | null
  onMutationSuccess: () => void
  reportDirty: (key: string, dirty: boolean) => void
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<CompositionDraft>({ IDmatiere: 0, pourcentage: '', bio: false, recycle: false })
  const [deleteTarget, setDeleteTarget] = useState<Composition | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const { data: matieres } = useMatieresLookup()

  // Surface dirty state to page
  const reportDirtyRef = useRef(reportDirty)
  useEffect(() => {
    reportDirtyRef.current = reportDirty
  })
  useEffect(() => {
    reportDirtyRef.current('ref-fil-composition', showForm || editingId !== null)
  }, [showForm, editingId])
  useEffect(
    () => () => {
      reportDirtyRef.current('ref-fil-composition', false)
    },
    [],
  )

  const resetForm = () => {
    setForm({ IDmatiere: 0, pourcentage: '', bio: false, recycle: false })
    setShowForm(false)
    setEditingId(null)
    setErrorMsg(null)
  }

  const createMut = useMutation({
    mutationFn: () =>
      apiFetch(`/references-fil/${refFilId}/compositions`, {
        method: 'POST',
        body: JSON.stringify({
          IDmatiere: form.IDmatiere,
          pourcentage: (Number(form.pourcentage) || 0) / 100,
          bio: form.bio,
          recycle: form.recycle,
        }),
      }),
    onSuccess: () => {
      onMutationSuccess()
      resetForm()
    },
    onError: async () => {
      // Best-effort: fetch the real message
      try {
        const res = await fetch(
          `${import.meta.env.VITE_API_URL || 'http://localhost:3002/api'}/references-fil/${refFilId}/compositions`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              IDmatiere: form.IDmatiere,
              pourcentage: (Number(form.pourcentage) || 0) / 100,
              bio: form.bio,
              recycle: form.recycle,
            }),
          },
        )
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          setErrorMsg(String(body?.error ?? 'Erreur'))
        }
      } catch {
        setErrorMsg('Erreur réseau')
      }
    },
  })

  const updateMut = useMutation({
    mutationFn: (assoId: number) =>
      apiFetch(`/references-fil/${refFilId}/compositions/${assoId}`, {
        method: 'PUT',
        body: JSON.stringify({
          IDmatiere: form.IDmatiere,
          pourcentage: (Number(form.pourcentage) || 0) / 100,
          bio: form.bio,
          recycle: form.recycle,
        }),
      }),
    onSuccess: () => {
      onMutationSuccess()
      resetForm()
    },
  })

  const deleteMut = useMutation({
    mutationFn: (assoId: number) =>
      apiFetch(`/references-fil/${refFilId}/compositions/${assoId}`, { method: 'DELETE' }),
    onSuccess: () => {
      onMutationSuccess()
      setDeleteTarget(null)
    },
  })
  void queryClient

  const startEditRow = (c: Composition) => {
    setEditingId(c.IDasso_fil_matiere)
    setShowForm(false)
    setErrorMsg(null)
    // Round to 3 decimals to strip the float32 round-trip artifact
    // (HFSQL stores REAL, so 0.99 comes back as 0.9900000095).
    const pctValue = Math.round((c.pourcentage ?? 0) * 100 * 1000) / 1000
    setForm({
      IDmatiere: c.IDmatiere,
      pourcentage: String(pctValue),
      bio: !!c.bio,
      recycle: !!c.recycle,
    })
  }

  const totalPct = detail.composition.reduce((s, c) => s + (Number(c.pourcentage) || 0) * 100, 0)
  const totalOk = Math.abs(totalPct - 100) < 0.01

  return (
    <>
      <Card className={cn('card-premium', isEditing && editSectionClass)}>
        <CardHeader
          className="flex flex-row items-center gap-2 p-4 space-y-0 pb-2 cursor-pointer select-none"
          onClick={() => setOpen(!open)}
        >
          <FlaskConical className="h-4 w-4 text-accent" />
          <CardTitle className="text-sm font-semibold">Composition</CardTitle>
          {isEditing && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0 text-accent hover:text-accent hover:bg-accent/10"
              onClick={(e) => {
                e.stopPropagation()
                setShowForm(true)
                setEditingId(null)
                setErrorMsg(null)
                setForm({ IDmatiere: 0, pourcentage: '', bio: false, recycle: false })
                if (!open) setOpen(true)
              }}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          )}
          {!totalOk && (
            <Badge
              className="text-xs ml-auto bg-destructive/10 text-destructive ring-1 ring-destructive/20"
              title="La composition doit totaliser 100%"
            >
              {Math.round(totalPct * 1000) / 1000}%
            </Badge>
          )}
          <Badge variant="secondary" className={cn('text-xs', totalOk && 'ml-auto')}>
            {detail.composition.length}
          </Badge>
          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </CardHeader>
        {open && (
          <CardContent className="space-y-2 pb-3">
            {detail.composition.length === 0 && !showForm && (
              <p className="text-sm text-muted-foreground italic">Aucune matière</p>
            )}
            {detail.composition.map((c) => {
              const isRowEditing = editingId === c.IDasso_fil_matiere
              return (
                <div key={c.IDasso_fil_matiere}>
                  {isRowEditing && isEditing ? (
                    <CompositionForm
                      form={form}
                      onFormChange={setForm}
                      matieres={matieres ?? []}
                      onCancel={resetForm}
                      onSave={() => updateMut.mutate(c.IDasso_fil_matiere)}
                      isSaving={updateMut.isPending}
                      errorMsg={errorMsg}
                      title="Modifier la matière"
                    />
                  ) : (
                    <div
                      className={cn(
                        'group rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3 border-l-amber-400/60',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-amber-400/10">
                            <FlaskConical className="h-3.5 w-3.5 text-amber-600" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{c.matiere_libelle ?? '—'}</p>
                            <p className="text-[11px] text-muted-foreground truncate tabular-nums">
                              {pct(c.pourcentage)}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          {!!c.bio && (
                            <Badge className="badge-success text-[10px] py-0 px-1.5 gap-0.5">
                              <Leaf className="h-2.5 w-2.5" />
                              Bio
                            </Badge>
                          )}
                          {!!c.recycle && (
                            <Badge className="bg-teal-500/10 text-teal-700 ring-1 ring-teal-500/20 text-[10px] py-0 px-1.5 gap-0.5">
                              <Recycle className="h-2.5 w-2.5" />
                              Recyclé
                            </Badge>
                          )}
                          {isEditing && (
                            <>
                              <button
                                onClick={() => startEditRow(c)}
                                className="opacity-0 group-hover:opacity-100 p-0.5 text-muted-foreground hover:text-foreground transition-opacity"
                                title="Modifier"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => setDeleteTarget(c)}
                                className="opacity-0 group-hover:opacity-100 p-0.5 text-destructive hover:text-destructive/80 transition-opacity"
                                title="Supprimer"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
            {showForm && isEditing && (
              <CompositionForm
                form={form}
                onFormChange={setForm}
                matieres={matieres ?? []}
                onCancel={resetForm}
                onSave={() => createMut.mutate()}
                isSaving={createMut.isPending}
                errorMsg={errorMsg}
                title="Nouvelle matière"
              />
            )}
            {detail.composition.length > 0 && (
              <div
                className={cn(
                  'mt-2 pt-2 border-t border-border/50 flex items-center justify-between text-xs font-semibold',
                  totalOk ? 'text-green-600' : 'text-amber-600',
                )}
              >
                <span>Total</span>
                <span className="tabular-nums">{fmtNum(totalPct, 1)}%</span>
              </div>
            )}
          </CardContent>
        )}
      </Card>
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Supprimer la matière"
        description={
          deleteTarget
            ? `${deleteTarget.matiere_libelle ?? '—'} (${pct(deleteTarget.pourcentage)}) sera retirée de la composition.`
            : undefined
        }
        isPending={deleteMut.isPending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) deleteMut.mutate(deleteTarget.IDasso_fil_matiere)
        }}
      />
    </>
  )
}

function CompositionForm({
  form,
  onFormChange,
  matieres,
  onCancel,
  onSave,
  isSaving,
  errorMsg,
  title,
}: {
  form: CompositionDraft
  onFormChange: (f: CompositionDraft) => void
  matieres: MatiereLookup[]
  onCancel: () => void
  onSave: () => void
  isSaving: boolean
  errorMsg: string | null
  title: string
}) {
  const canSave = form.IDmatiere > 0 && Number(form.pourcentage) > 0
  return (
    <div className="rounded-lg border border-accent/25 bg-accent/[0.03] p-4 space-y-3">
      <p className="text-xs font-semibold text-accent uppercase tracking-wide">{title}</p>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Matière</label>
          <PopoverSelect
            options={matieres.map((m) => ({ id: m.IDmatiere_premiere, primary: m.libelle }))}
            value={form.IDmatiere}
            onChange={(id) => onFormChange({ ...form, IDmatiere: id })}
            emptyLabel="— Choisir —"
          />
        </div>
        <LabeledInput
          label="Pourcentage (%)"
          type="number"
          step="0.1"
          value={form.pourcentage}
          onChange={(v) => onFormChange({ ...form, pourcentage: v })}
        />
      </div>
      <div className="flex items-center gap-6">
        <label className="flex items-center gap-2 text-xs font-medium">
          <Pill value={form.bio} onChange={(v) => onFormChange({ ...form, bio: v })} />
          <span className="flex items-center gap-1">
            <Leaf className="h-3 w-3 text-green-600" />
            Bio
          </span>
        </label>
        <label className="flex items-center gap-2 text-xs font-medium">
          <Pill value={form.recycle} onChange={(v) => onFormChange({ ...form, recycle: v })} />
          <span className="flex items-center gap-1">
            <Recycle className="h-3 w-3 text-teal-600" />
            Recyclé
          </span>
        </label>
      </div>
      {errorMsg && <p className="text-xs text-destructive">{errorMsg}</p>}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" size="sm" onClick={onCancel}>
          Annuler
        </Button>
        <Button size="sm" onClick={onSave} disabled={!canSave || isSaving}>
          {isSaving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
          Enregistrer
        </Button>
      </div>
    </div>
  )
}

// ── Variantes Card ─────────────────────────────────────

interface VarianteDraft {
  reference: string
  prix_kg: string
  stock_mini: string
  commentaire: string
}

function emptyVarianteDraft(): VarianteDraft {
  return { reference: '', prix_kg: '', stock_mini: '', commentaire: '' }
}

function VariantesCard({
  detail,
  isEditing,
  refFilId,
  onMutationSuccess,
  reportDirty,
}: {
  detail: RefFilDetail
  isEditing: boolean
  refFilId: number | null
  onMutationSuccess: () => void
  reportDirty: (key: string, dirty: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<VarianteDraft>(emptyVarianteDraft())
  const [deleteTarget, setDeleteTarget] = useState<Variante | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const reportDirtyRef = useRef(reportDirty)
  useEffect(() => {
    reportDirtyRef.current = reportDirty
  })
  useEffect(() => {
    reportDirtyRef.current('ref-fil-variantes', showForm || editingId !== null)
  }, [showForm, editingId])
  useEffect(
    () => () => {
      reportDirtyRef.current('ref-fil-variantes', false)
    },
    [],
  )

  // Fournisseurs catalog — reused with the FilsGestion query key so the cache
  // is shared. Loaded only once the card is opened (via `enabled: open`).
  const { data: allFournisseurs } = useQuery<Array<{ IDfournisseur: number; nom: string | null }>>({
    queryKey: ['fournisseurs'],
    queryFn: () => apiFetch('/fournisseurs'),
    enabled: open && isEditing,
  })

  const linkFrsMut = useMutation({
    mutationFn: (args: { coloriId: number; fournisseurId: number }) =>
      apiFetch(
        `/references-fil/${refFilId}/variantes/${args.coloriId}/fournisseurs/${args.fournisseurId}`,
        { method: 'POST' },
      ),
    onSuccess: () => onMutationSuccess(),
  })

  const unlinkFrsMut = useMutation({
    mutationFn: (args: { coloriId: number; fournisseurId: number }) =>
      apiFetch(
        `/references-fil/${refFilId}/variantes/${args.coloriId}/fournisseurs/${args.fournisseurId}`,
        { method: 'DELETE' },
      ),
    onSuccess: () => onMutationSuccess(),
  })

  const resetForm = () => {
    setShowForm(false)
    setEditingId(null)
    setForm(emptyVarianteDraft())
    setErrorMsg(null)
  }

  const draftToBody = (f: VarianteDraft) => ({
    reference: f.reference.trim(),
    prix_kg: f.prix_kg === '' ? 0 : Number(f.prix_kg),
    stock_mini: f.stock_mini === '' ? 0 : Number(f.stock_mini),
    commentaire: f.commentaire,
  })

  const createMut = useMutation({
    mutationFn: () =>
      apiFetch(`/references-fil/${refFilId}/variantes`, {
        method: 'POST',
        body: JSON.stringify(draftToBody(form)),
      }),
    onSuccess: () => {
      onMutationSuccess()
      resetForm()
    },
  })

  const updateMut = useMutation({
    mutationFn: (coloriId: number) =>
      apiFetch(`/references-fil/${refFilId}/variantes/${coloriId}`, {
        method: 'PUT',
        body: JSON.stringify(draftToBody(form)),
      }),
    onSuccess: () => {
      onMutationSuccess()
      resetForm()
    },
  })

  const deleteMut = useMutation({
    mutationFn: (coloriId: number) =>
      apiFetch(`/references-fil/${refFilId}/variantes/${coloriId}`, { method: 'DELETE' }),
    onSuccess: () => {
      onMutationSuccess()
      setDeleteTarget(null)
      setErrorMsg(null)
    },
    onError: async () => {
      if (!deleteTarget) return
      try {
        const res = await fetch(
          `${import.meta.env.VITE_API_URL || 'http://localhost:3002/api'}/references-fil/${refFilId}/variantes/${deleteTarget.IDcolori_fil}`,
          { method: 'DELETE', credentials: 'include' },
        )
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          setErrorMsg(String(body?.error ?? 'Erreur'))
        }
      } catch {
        setErrorMsg('Erreur réseau')
      }
    },
  })

  const startEditRow = (v: Variante) => {
    setEditingId(v.IDcolori_fil)
    setShowForm(false)
    setForm({
      reference: v.reference ?? '',
      prix_kg: v.prix_kg != null ? String(v.prix_kg) : '',
      stock_mini: v.stock_mini != null ? String(v.stock_mini) : '',
      commentaire: v.commentaire ?? '',
    })
  }

  return (
    <>
      <Card className={cn('card-premium', isEditing && editSectionClass)}>
        <CardHeader
          className="flex flex-row items-center gap-2 p-4 space-y-0 pb-2 cursor-pointer select-none"
          onClick={() => setOpen(!open)}
        >
          <Palette className="h-4 w-4 text-accent" />
          <CardTitle className="text-sm font-semibold">Coloris</CardTitle>
          {isEditing && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0 text-accent hover:text-accent hover:bg-accent/10"
              onClick={(e) => {
                e.stopPropagation()
                setShowForm(true)
                setEditingId(null)
                setForm(emptyVarianteDraft())
                if (!open) setOpen(true)
              }}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          )}
          <Badge variant="secondary" className="text-xs ml-auto">
            {detail.variantes.length}
          </Badge>
          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </CardHeader>
        {open && (
          <CardContent className="space-y-2 pb-3">
            {detail.variantes.length === 0 && !showForm && (
              <p className="text-sm text-muted-foreground italic">Aucun coloris</p>
            )}
            {detail.variantes.map((v) => {
              const isRowEditing = editingId === v.IDcolori_fil
              return (
                <div key={v.IDcolori_fil}>
                  {isRowEditing && isEditing ? (
                    <VarianteForm
                      form={form}
                      onFormChange={setForm}
                      onCancel={resetForm}
                      onSave={() => updateMut.mutate(v.IDcolori_fil)}
                      isSaving={updateMut.isPending}
                      title="Modifier le coloris"
                    />
                  ) : (
                    <div
                      className={cn(
                        'group rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3',
                        'border-l-amber-400/60',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-amber-400/10">
                            <Palette className="h-3.5 w-3.5 text-amber-600" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{v.reference ?? '—'}</p>
                            <p className="text-[11px] text-muted-foreground truncate tabular-nums">
                              {v.prix_kg != null && v.prix_kg > 0 ? `${fmtNum(v.prix_kg, 2)} €/kg` : '— €/kg'}
                              {' · '}
                              Stock mini {fmtNum(v.stock_mini ?? 0, 0)} kg
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <Badge variant="secondary" className="text-[10px] py-0 px-1.5 gap-1">
                            <Factory className="h-2.5 w-2.5" />
                            {v.fournisseurs_count}
                          </Badge>
                          {isEditing && (
                            <>
                              <button
                                onClick={() => startEditRow(v)}
                                className="opacity-0 group-hover:opacity-100 p-0.5 text-muted-foreground hover:text-foreground transition-opacity"
                                title="Modifier"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => {
                                  setDeleteTarget(v)
                                  setErrorMsg(null)
                                }}
                                className="opacity-0 group-hover:opacity-100 p-0.5 text-destructive hover:text-destructive/80 transition-opacity"
                                title="Supprimer"
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                      {!!v.commentaire?.trim() && (
                        <div className="flex items-start gap-1.5 mt-2 ml-9">
                          <MessageSquare className="h-3 w-3 text-muted-foreground/50 flex-shrink-0 mt-0.5" />
                          <p className="text-[11px] text-muted-foreground italic">{v.commentaire.trim()}</p>
                        </div>
                      )}
                      {(isEditing || v.fournisseurs.length > 0) && (
                        <div className="mt-2 ml-9 flex flex-wrap items-center gap-1.5">
                          <Factory className="h-3 w-3 text-muted-foreground/60 flex-shrink-0" />
                          {v.fournisseurs.length === 0 ? (
                            <span className="text-[11px] text-muted-foreground italic">
                              Aucun fournisseur lié
                            </span>
                          ) : (
                            v.fournisseurs.map((f) => (
                              <Badge
                                key={f.IDfournisseur}
                                variant="secondary"
                                className="text-[10px] py-0 px-1.5 gap-1"
                              >
                                {f.nom ?? '—'}
                                {isEditing && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      unlinkFrsMut.mutate({
                                        coloriId: v.IDcolori_fil,
                                        fournisseurId: f.IDfournisseur,
                                      })
                                    }
                                    disabled={unlinkFrsMut.isPending}
                                    className="ml-0.5 rounded-full hover:bg-destructive/20 hover:text-destructive p-0.5 -mr-1 transition-colors"
                                    title="Retirer ce fournisseur"
                                  >
                                    <X className="h-2.5 w-2.5" />
                                  </button>
                                )}
                              </Badge>
                            ))
                          )}
                          {isEditing && (
                            <PopoverSelect
                              size="sm"
                              // Action-trigger pattern: the value never sticks. The
                              // emptyLabel doubles as the button label; selecting an
                              // option fires the link mutation immediately.
                              value={0}
                              onChange={(fid) => {
                                if (!fid) return
                                linkFrsMut.mutate({ coloriId: v.IDcolori_fil, fournisseurId: fid })
                              }}
                              disabled={linkFrsMut.isPending || !allFournisseurs}
                              emptyLabel="+ Ajouter un fournisseur"
                              options={(allFournisseurs ?? [])
                                .filter(
                                  (f) =>
                                    !v.fournisseurs.some(
                                      (linked) => linked.IDfournisseur === f.IDfournisseur,
                                    ),
                                )
                                .map((f) => ({
                                  id: f.IDfournisseur,
                                  primary: f.nom ?? `#${f.IDfournisseur}`,
                                }))}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            {showForm && isEditing && (
              <VarianteForm
                form={form}
                onFormChange={setForm}
                onCancel={resetForm}
                onSave={() => createMut.mutate()}
                isSaving={createMut.isPending}
                title="Nouveau coloris"
              />
            )}
          </CardContent>
        )}
      </Card>
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Supprimer le coloris"
        description={
          deleteError(errorMsg, deleteTarget)
        }
        isPending={deleteMut.isPending}
        onCancel={() => {
          setDeleteTarget(null)
          setErrorMsg(null)
        }}
        onConfirm={() => {
          if (deleteTarget) deleteMut.mutate(deleteTarget.IDcolori_fil)
        }}
      />
    </>
  )
}

function deleteError(errorMsg: string | null, target: Variante | null): string | undefined {
  if (errorMsg) return errorMsg
  if (!target) return undefined
  return `${target.reference ?? '—'} sera supprimée de la référence.`
}

function VarianteForm({
  form,
  onFormChange,
  onCancel,
  onSave,
  isSaving,
  title,
}: {
  form: VarianteDraft
  onFormChange: (f: VarianteDraft) => void
  onCancel: () => void
  onSave: () => void
  isSaving: boolean
  title: string
}) {
  const canSave = form.reference.trim().length > 0
  return (
    <div className="rounded-lg border border-accent/25 bg-accent/[0.03] p-4 space-y-3">
      <p className="text-xs font-semibold text-accent uppercase tracking-wide">{title}</p>
      <div className="grid grid-cols-2 gap-2">
        <LabeledInput
          label="Référence coloris"
          value={form.reference}
          onChange={(v) => onFormChange({ ...form, reference: v })}
        />
        <LabeledInput
          label="Prix (€/kg)"
          type="number"
          step="0.01"
          value={form.prix_kg}
          onChange={(v) => onFormChange({ ...form, prix_kg: v })}
        />
      </div>
      <LabeledInput
        label="Stock minimum (kg)"
        type="number"
        value={form.stock_mini}
        onChange={(v) => onFormChange({ ...form, stock_mini: v })}
      />
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Commentaire</label>
        <textarea
          value={form.commentaire}
          onChange={(e) => onFormChange({ ...form, commentaire: e.target.value })}
          rows={2}
          className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
        />
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" size="sm" onClick={onCancel}>
          Annuler
        </Button>
        <Button size="sm" onClick={onSave} disabled={!canSave || isSaving}>
          {isSaving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
          Enregistrer
        </Button>
      </div>
    </div>
  )
}

// ── Stock Aggregate Card ───────────────────────────────

function StockAggregateCard({
  detail,
  isEditing,
}: {
  detail: RefFilDetail
  isEditing: boolean
}) {
  const byVariante = new Map<number, { total_kg: number; lots: number }>()
  for (const s of detail.stock_per_variante) byVariante.set(s.IDcolori_fil, s)
  const [open, setOpen] = useState(false)
  return (
    <Card className={cn('card-premium', isEditing && editSectionClass)}>
      <CardHeader
        className="flex flex-row items-center gap-2 p-4 space-y-0 pb-2 cursor-pointer select-none"
        onClick={() => setOpen(!open)}
      >
        <Warehouse className="h-4 w-4 text-accent" />
        <CardTitle className="text-sm font-semibold">Stock actuel</CardTitle>
        <Badge variant="secondary" className="text-xs ml-auto">
          {detail.stock_lots} lot{detail.stock_lots !== 1 ? 's' : ''}
        </Badge>
        <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </CardHeader>
      {open && (
      <CardContent className="pb-4">
        {detail.stock_lots === 0 ? (
          <p className="text-sm text-muted-foreground italic">Aucun stock en cours</p>
        ) : (
          <>
            <div className="flex items-baseline justify-between mb-3">
              <span className="text-xs text-muted-foreground">Total</span>
              <span className="text-lg font-semibold tabular-nums">
                {fmtNum(detail.stock_total_kg, 1)} kg
              </span>
            </div>
            <div className="space-y-1.5">
              {detail.variantes
                .filter((v) => byVariante.has(v.IDcolori_fil))
                .map((v) => {
                  const s = byVariante.get(v.IDcolori_fil)!
                  return (
                    <a
                      key={v.IDcolori_fil}
                      href={`/fils/stock?q=${encodeURIComponent(
                        `${detail.reference} ${v.reference ?? ''}`,
                      )}`}
                      className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-md hover:bg-accent/5 transition-colors text-sm"
                    >
                      <span className="truncate">{v.reference ?? '—'}</span>
                      <span className="text-xs text-muted-foreground tabular-nums flex-shrink-0">
                        {fmtNum(s.total_kg, 1)} kg · {s.lots} lot{s.lots !== 1 ? 's' : ''}
                      </span>
                    </a>
                  )
                })}
            </div>
          </>
        )}
      </CardContent>
      )}
    </Card>
  )
}

// ── Commandes Aggregate Card ───────────────────────────

function CommandesAggregateCard({
  detail,
  isEditing,
}: {
  detail: RefFilDetail
  isEditing: boolean
}) {
  const [open, setOpen] = useState(false)
  const history = detail.commande_history ?? []
  return (
    <Card className={cn('card-premium', isEditing && editSectionClass)}>
      <CardHeader
        className="flex flex-row items-center gap-2 p-4 space-y-0 pb-2 cursor-pointer select-none"
        onClick={() => setOpen(!open)}
      >
        <ShoppingCart className="h-4 w-4 text-accent" />
        <CardTitle className="text-sm font-semibold">Historique commandes</CardTitle>
        <Badge variant="secondary" className="text-xs ml-auto">
          {detail.commande_lignes} ligne{detail.commande_lignes !== 1 ? 's' : ''}
        </Badge>
        <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </CardHeader>
      {open && (
        <CardContent className="pb-4">
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">Aucune commande</p>
          ) : (
            <>
              <div className="flex items-baseline justify-between mb-3">
                <span className="text-xs text-muted-foreground">Total commandé</span>
                <span className="text-lg font-semibold tabular-nums">{fmtNum(detail.commande_total_kg, 1)} kg</span>
              </div>
              <div className="space-y-1.5">
                {history.map((h) => (
                  <a
                    key={h.IDref_fil_commande}
                    href={`/fils/commandes?id=${h.IDcommande_fil}`}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent/5 transition-colors text-sm"
                  >
                    <span className="tabular-nums text-muted-foreground flex-shrink-0">
                      N°{h.IDcommande_fil}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums flex-shrink-0">
                      {h.date_commande ? formatHfsqlDate(h.date_commande) : '—'}
                    </span>
                    <span className="truncate flex-1">
                      {h.fournisseur_nom ?? '—'}
                      {h.colori_reference && (
                        <span className="text-muted-foreground"> · {h.colori_reference}</span>
                      )}
                    </span>
                    {h.etat === 1 && (
                      <Badge variant="secondary" className="text-[10px] py-0 px-1.5 flex-shrink-0">
                        Terminée
                      </Badge>
                    )}
                    <span className="text-xs tabular-nums flex-shrink-0">
                      {fmtNum(h.quantite, 0)} kg
                      {h.prix_unitaire != null && h.prix_unitaire > 0 && (
                        <span className="text-muted-foreground"> · {fmtNum(h.prix_unitaire, 2)} €/kg</span>
                      )}
                    </span>
                  </a>
                ))}
              </div>
            </>
          )}
        </CardContent>
      )}
    </Card>
  )
}

// ── Offres History Card ────────────────────────────────
// Supplier price quotes per ref_fil. Visible in both modes (employees record
// new quotes during edit mode). Add via inline form, delete via hover-trash.

interface OffreDraft {
  IDfournisseur: number
  IDcolori_fil: number
  date: string // YYYY-MM-DD (HTML input format)
  prix: string
  quantite: string
  observation: string
}

function emptyOffreDraft(): OffreDraft {
  const today = new Date()
  const yyyy = today.getFullYear()
  const mm = String(today.getMonth() + 1).padStart(2, '0')
  const dd = String(today.getDate()).padStart(2, '0')
  return {
    IDfournisseur: 0,
    IDcolori_fil: 0,
    date: `${yyyy}-${mm}-${dd}`,
    prix: '',
    quantite: '',
    observation: '',
  }
}

function OffresHistoryCard({
  detail,
  isEditing,
  refFilId,
  onMutationSuccess,
  reportDirty,
}: {
  detail: RefFilDetail
  isEditing: boolean
  refFilId: number | null
  onMutationSuccess: () => void
  reportDirty: (key: string, dirty: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState<OffreDraft>(emptyOffreDraft())
  const [deleteTarget, setDeleteTarget] = useState<OffreFilRow | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const offres = detail.offres ?? []

  const reportDirtyRef = useRef(reportDirty)
  useEffect(() => {
    reportDirtyRef.current = reportDirty
  })
  useEffect(() => {
    reportDirtyRef.current('ref-fil-offres', showForm)
  }, [showForm])
  useEffect(
    () => () => {
      reportDirtyRef.current('ref-fil-offres', false)
    },
    [],
  )

  const { data: allFournisseurs } = useQuery<Array<{ IDfournisseur: number; nom: string | null }>>({
    queryKey: ['fournisseurs'],
    queryFn: () => apiFetch('/fournisseurs'),
    enabled: open && isEditing,
  })

  const resetForm = () => {
    setForm(emptyOffreDraft())
    setShowForm(false)
    setErrorMsg(null)
  }

  const createMut = useMutation({
    mutationFn: () =>
      apiFetch(`/references-fil/${refFilId}/offres`, {
        method: 'POST',
        body: JSON.stringify({
          IDfournisseur: form.IDfournisseur,
          IDcolori_fil: form.IDcolori_fil || 0,
          date: form.date.replace(/-/g, ''),
          prix: Number(form.prix) || 0,
          quantite: form.quantite ? Number(form.quantite) : 0,
          observation: form.observation || undefined,
        }),
      }),
    onSuccess: () => {
      onMutationSuccess()
      resetForm()
    },
    onError: async () => {
      try {
        const res = await fetch(
          `${import.meta.env.VITE_API_URL || 'http://localhost:3002/api'}/references-fil/${refFilId}/offres`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              IDfournisseur: form.IDfournisseur,
              IDcolori_fil: form.IDcolori_fil || 0,
              date: form.date.replace(/-/g, ''),
              prix: Number(form.prix) || 0,
              quantite: form.quantite ? Number(form.quantite) : 0,
              observation: form.observation || undefined,
            }),
          },
        )
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          setErrorMsg(String(body?.error ?? 'Erreur'))
        }
      } catch {
        setErrorMsg('Erreur réseau')
      }
    },
  })

  const deleteMut = useMutation({
    mutationFn: (offreId: number) =>
      apiFetch(`/references-fil/${refFilId}/offres/${offreId}`, { method: 'DELETE' }),
    onSuccess: () => {
      onMutationSuccess()
      setDeleteTarget(null)
    },
  })

  const canSubmit =
    form.IDfournisseur > 0 && Number(form.prix) > 0 && /^\d{4}-\d{2}-\d{2}$/.test(form.date)

  return (
    <>
      <Card className={cn('card-premium', isEditing && editSectionClass)}>
        <CardHeader
          className="flex flex-row items-center gap-2 p-4 space-y-0 pb-2 cursor-pointer select-none"
          onClick={() => setOpen(!open)}
        >
          <Tag className="h-4 w-4 text-accent" />
          <CardTitle className="text-sm font-semibold">Historique des offres</CardTitle>
          {isEditing && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0 text-accent hover:text-accent hover:bg-accent/10"
              onClick={(e) => {
                e.stopPropagation()
                setShowForm(true)
                setErrorMsg(null)
                if (!open) setOpen(true)
              }}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          )}
          <Badge variant="secondary" className="text-xs ml-auto">
            {offres.length}
          </Badge>
          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </CardHeader>
        {open && (
          <CardContent className="space-y-2 pb-4">
            {showForm && isEditing && (
              <div className="rounded-lg border border-accent/25 bg-accent/[0.03] p-3 space-y-2">
                <p className="text-xs font-semibold text-accent uppercase tracking-wide">
                  Nouvelle offre
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Fournisseur</label>
                    <SearchableCombobox<{ IDfournisseur: number; nom: string | null }>
                      options={allFournisseurs ?? []}
                      value={form.IDfournisseur}
                      onChange={(id) => setForm({ ...form, IDfournisseur: id })}
                      getId={(f) => f.IDfournisseur}
                      getPrimary={(f) => f.nom ?? `#${f.IDfournisseur}`}
                      placeholder="Choisir un fournisseur"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">
                      Coloris (optionnel)
                    </label>
                    <PopoverSelect
                      options={detail.variantes.map((v) => ({
                        id: v.IDcolori_fil,
                        primary: v.reference ?? `#${v.IDcolori_fil}`,
                      }))}
                      value={form.IDcolori_fil}
                      onChange={(id) => setForm({ ...form, IDcolori_fil: id })}
                      emptyLabel="Tous les coloris"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Date</label>
                    <input
                      type="date"
                      value={form.date}
                      onChange={(e) => setForm({ ...form, date: e.target.value })}
                      className={inputClass}
                    />
                  </div>
                  <LabeledInput
                    label="Prix (€/kg)"
                    type="number"
                    step="0.01"
                    value={form.prix}
                    onChange={(v) => setForm({ ...form, prix: v })}
                  />
                  <LabeledInput
                    label="Quantité (kg)"
                    type="number"
                    value={form.quantite}
                    onChange={(v) => setForm({ ...form, quantite: v })}
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    Observation (optionnel)
                  </label>
                  <textarea
                    value={form.observation}
                    onChange={(e) => setForm({ ...form, observation: e.target.value })}
                    rows={2}
                    className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
                  />
                </div>
                {errorMsg && <p className="text-xs text-destructive">{errorMsg}</p>}
                <div className="flex justify-end gap-2 pt-1">
                  <Button variant="outline" size="sm" onClick={resetForm}>
                    <X className="h-3.5 w-3.5 mr-1.5" />
                    Annuler
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => createMut.mutate()}
                    disabled={!canSubmit || createMut.isPending}
                  >
                    <Save className="h-3.5 w-3.5 mr-1.5" />
                    Enregistrer
                  </Button>
                </div>
              </div>
            )}
            {offres.length === 0 && !showForm ? (
              <p className="text-sm text-muted-foreground italic">Aucune offre enregistrée</p>
            ) : (
              <div className="space-y-1.5">
                {offres.map((o) => (
                  <div
                    key={o.IDoffre_fil}
                    className={cn(
                      'group rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3',
                      'border-l-amber-400/60',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-amber-400/10">
                          <Tag className="h-3.5 w-3.5 text-amber-600" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">
                            {o.fournisseur_nom ?? '—'}
                          </p>
                          <p className="text-[11px] text-muted-foreground tabular-nums">
                            {o.date ? formatHfsqlDate(o.date) : '—'}
                            {o.colori_reference && (
                              <span> · {o.colori_reference}</span>
                            )}
                            {o.quantite != null && o.quantite > 0 && (
                              <span> · {fmtNum(o.quantite, 0)} kg</span>
                            )}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <span className="text-sm font-semibold tabular-nums">
                          {o.prix != null ? `${fmtNum(o.prix, 2)} €/kg` : '—'}
                        </span>
                        {isEditing && (
                          <button
                            onClick={() => setDeleteTarget(o)}
                            className="opacity-0 group-hover:opacity-100 p-0.5 text-destructive hover:text-destructive/80 transition-opacity"
                            title="Supprimer"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                    {!!o.observation?.trim() && (
                      <div className="flex items-start gap-1.5 mt-2 ml-9">
                        <MessageSquare className="h-3 w-3 text-muted-foreground/50 flex-shrink-0 mt-0.5" />
                        <p className="text-[11px] text-muted-foreground italic">
                          {o.observation.trim()}
                        </p>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        )}
      </Card>
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Supprimer l'offre"
        description={
          deleteTarget
            ? `${deleteTarget.fournisseur_nom ?? '—'} · ${
                deleteTarget.date ? formatHfsqlDate(deleteTarget.date) : '—'
              } sera supprimée.`
            : undefined
        }
        isPending={deleteMut.isPending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) deleteMut.mutate(deleteTarget.IDoffre_fil)
        }}
      />
    </>
  )
}

// ── Right Panel: Sidebar ───────────────────────────────

function DetailSidebar({
  detail,
  isEditing,
  draft,
  onDraftChange,
}: {
  detail: RefFilDetail | null
  isEditing: boolean
  draft: HeaderDraft
  onDraftChange: (d: HeaderDraft) => void
}) {
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
        <button
          type="button"
          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md transition-colors bg-accent text-accent-foreground shadow-sm"
        >
          <Info className="h-3.5 w-3.5" />
          Informations
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-transparent">
        {!isEditing && (
          <div className="p-3 rounded-lg border bg-card shadow-sm space-y-2">
            <p className="text-xs font-semibold text-muted-foreground">Statistiques</p>
            <KV
              label="Coloris"
              value={<span className="tabular-nums">{detail.variantes.length}</span>}
            />
            <KV
              label="Fournisseurs distincts"
              value={<span className="tabular-nums">{detail.fournisseurs.length}</span>}
            />
            <KV
              label="Stock actuel"
              value={<span className="tabular-nums">{fmtNum(detail.stock_total_kg, 1)} kg</span>}
            />
            <KV
              label="En commande"
              value={
                <span className="tabular-nums">
                  {fmtNum(detail.commande_reste_kg ?? 0, 1)} kg
                  {(detail.commande_lignes_ouvertes ?? 0) > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {' · '}
                      {detail.commande_lignes_ouvertes} ligne
                      {detail.commande_lignes_ouvertes !== 1 ? 's' : ''}
                    </span>
                  )}
                </span>
              }
            />
          </div>
        )}
        {!isEditing && (
          <div className="p-3 rounded-lg border bg-card shadow-sm space-y-2">
            <p className="text-xs font-semibold text-muted-foreground">Fournisseurs</p>
            {detail.fournisseurs.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">Aucun fournisseur lié</p>
            ) : (
              <div className="space-y-1">
                {detail.fournisseurs.map((f) => (
                  <a
                    key={f.IDfournisseur}
                    href="/fils/gestion"
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-accent/5 transition-colors text-sm"
                  >
                    <Factory className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                    <span className="truncate">{f.nom ?? '—'}</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        )}
        <div
          className={cn(
            'p-3 rounded-lg border bg-card shadow-sm space-y-2',
            isEditing && editSectionClass,
          )}
        >
          <p className="text-xs font-semibold text-muted-foreground">Notes</p>
          {isEditing ? (
            <textarea
              value={draft.commentaire}
              onChange={(e) => onDraftChange({ ...draft, commentaire: e.target.value })}
              rows={4}
              className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
            />
          ) : detail.commentaire?.trim() ? (
            <p className="text-sm text-muted-foreground whitespace-pre-line">{detail.commentaire}</p>
          ) : (
            <p className="text-sm text-muted-foreground italic">Aucune note</p>
          )}
        </div>
      </div>
    </div>
  )
}
