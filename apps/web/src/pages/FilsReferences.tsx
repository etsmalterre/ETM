import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
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
  Package,
  FlaskConical,
  Warehouse,
  ShoppingCart,
  MessageSquare,
  Palette,
  Factory,
  Tag,
  FileText,
  Upload,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PopoverSelect, SearchableCombobox } from '@/components/ui/popover-select'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'
import { BobineIcon } from '@/components/icons/BobineIcon'
import { cn } from '@/lib/utils'
import { apiFetch, API_URL } from '@/lib/api'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { fmtNum } from '@/lib/format'
import { formatHfsqlDate } from '@/lib/dates'
import { StockConsoTab, StatutBadge, useConsommationFil, type ConsoColoris } from '@/components/fils/StockConsoTab'

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
  /** Supplier delivery time in weeks (0 = not filled in). */
  delai_appro: number
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

/** §18.A form dialog shared by the sub-entity forms of the fiche (matière,
 *  coloris, offre): title + icon, body, error banner, Annuler / Enregistrer. */
function SubFormDialog({
  open,
  title,
  icon: Icon,
  onClose,
  onSave,
  canSave,
  isSaving,
  errorMsg,
  children,
}: {
  open: boolean
  title: string
  icon: typeof Info
  onClose: () => void
  onSave: () => void
  canSave: boolean
  isSaving: boolean
  errorMsg?: string | null
  children: React.ReactNode
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !isSaving) onClose() }}>
      <DialogContent className="max-w-lg max-h-[90dvh] overflow-y-auto" onClose={isSaving ? undefined : onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon className="h-5 w-5 text-accent" />
            {title}
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">{children}</div>
        {errorMsg && (
          <div className="mt-3 flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            {errorMsg}
          </div>
        )}
        <DialogFooter className="mt-4 gap-2">
          <Button variant="outline" onClick={onClose} disabled={isSaving}>
            Annuler
          </Button>
          <Button onClick={onSave} disabled={!canSave || isSaving}>
            {isSaving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
    queryClient.invalidateQueries({ queryKey: ['ref-fil-consommation', selectedId] })
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

// ── Center panel: Classeur master tabs (§39) ───────────
// Same shape as Finis › Références: one dataset at a time gets the full
// panel height instead of six collapsible cards stacked on top of each other.
const MAIN_TABS = [
  { key: 'specifications', label: 'Spécifications', icon: Package },
  { key: 'stock', label: 'Stock & conso', icon: Warehouse },
  { key: 'commandes', label: 'Commandes', icon: ShoppingCart },
  { key: 'offres', label: 'Offres', icon: Tag },
] as const
type MainTab = (typeof MAIN_TABS)[number]['key']

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
  const [activeTab, setActiveTab] = useState<MainTab>('specifications')
  // Land on the technical sheet whenever the selection changes.
  useEffect(() => { setActiveTab('specifications') }, [detail?.IDref_fil])

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

  const counts: Partial<Record<MainTab, number>> = {
    stock: detail.stock_lots,
    commandes: detail.commande_lignes,
    offres: (detail.offres ?? []).length,
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Master tabs — header-submenu style pills on the natural background */}
      <div className="flex-shrink-0 flex items-center gap-1 border-b border-border/60 pb-2 overflow-x-auto scrollbar-transparent">
        {MAIN_TABS.map((t) => {
          const Icon = t.icon
          const active = activeTab === t.key
          const count = counts[t.key]
          return (
            <button key={t.key} type="button" onClick={() => setActiveTab(t.key)}
              className={cn('flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap',
                active ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10 hover:text-accent')}>
              <Icon className="h-3.5 w-3.5" />{t.label}
              {/* Counts come from the already-loaded detail — no extra fetch. */}
              {count != null && <span className="text-xs tabular-nums opacity-70">{count}</span>}
            </button>
          )
        })}
      </div>
      {/* px-1/pb-1 keep focus rings and hover borders clear of the overflow clip (§31.5) */}
      <div className="flex-1 min-h-0 overflow-auto space-y-3 pt-3 px-1 pb-1 scrollbar-transparent">
        {activeTab === 'specifications' && (
          <>
            <SpecsCard detail={detail} isEditing={isEditing} draft={draft} onDraftChange={onDraftChange} unites={unites} />
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
          </>
        )}
        {activeTab === 'stock' && <StockConsoTab refFilId={detail.IDref_fil} refReference={detail.reference} />}
        {activeTab === 'commandes' && <CommandesAggregateCard detail={detail} />}
        {activeTab === 'offres' && (
          <OffresHistoryCard
            detail={detail}
            isEditing={isEditing}
            refFilId={refFilId}
            onMutationSuccess={onMutationSuccess}
            reportDirty={reportDirty}
          />
        )}
      </div>
    </div>
  )
}

/** A spec tile: uppercase caption on top, the value big underneath — same
 *  tile as Finis › Références. */
function SpecTile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border/60 bg-zinc-100/80 px-3 py-2.5 min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold truncate">{label}</p>
      <div className="mt-1">{children}</div>
    </div>
  )
}

function TileFigure({ value, unit }: { value: string | null; unit?: string | null }) {
  if (value == null) return <span className="text-2xl font-bold text-muted-foreground/60 leading-none">—</span>
  return (
    <span className="text-2xl font-bold tabular-nums leading-none">
      {value}
      {unit ? <span className="text-xs text-muted-foreground font-normal ml-1">{unit}</span> : null}
    </span>
  )
}

/** The §7.1 add-row button at the bottom of a tab's list (edit mode only). */
function AddRowButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      className="w-full text-muted-foreground hover:text-accent hover:bg-accent/5 border border-dashed border-border/60 hover:border-accent/40"
    >
      <Plus className="h-3.5 w-3.5 mr-1.5" />
      {label}
    </Button>
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
      <CardContent className="pt-4 pb-4">
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
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <SpecTile label="Titrage">
                <TileFigure
                  value={detail.titrage != null && detail.titrage > 0 ? fmtNum(detail.titrage, 0) : null}
                  unit={uniteNom}
                />
              </SpecTile>
              <SpecTile label="Fil / Brin">
                <TileFigure value={`${detail.nb_fil ?? '—'} / ${detail.nb_brin ?? '—'}`} />
              </SpecTile>
              <SpecTile label="Prix de base">
                <TileFigure
                  value={detail.prix_kg != null && detail.prix_kg > 0 ? fmtNum(detail.prix_kg, 2) : null}
                  unit="€/kg"
                />
              </SpecTile>
            </div>
            {(!!detail.bio || !!detail.recycle) && (
              <div className="flex gap-1.5 flex-wrap">
                {!!detail.bio && (
                  <Badge className="badge-success text-xs py-0.5 px-2 gap-1">
                    <Leaf className="h-3 w-3" />
                    Bio
                  </Badge>
                )}
                {!!detail.recycle && (
                  <Badge className="bg-teal-500/10 text-teal-700 ring-1 ring-teal-500/20 text-xs py-0.5 px-2 gap-1">
                    <Recycle className="h-3 w-3" />
                    Recyclé
                  </Badge>
                )}
              </div>
            )}
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

/** Segment colours of the composition bar, in row order. */
const COMPO_COLORS = ['bg-amber-500', 'bg-teal-500', 'bg-sky-500', 'bg-rose-400', 'bg-violet-400', 'bg-zinc-400']

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

  const startCreate = () => {
    setShowForm(true)
    setEditingId(null)
    setErrorMsg(null)
    setForm({ IDmatiere: 0, pourcentage: '', bio: false, recycle: false })
  }

  return (
    <>
      <Card className={cn('card-premium', isEditing && editSectionClass)}>
        <CardContent className="pt-4 pb-4 space-y-3">
          <div className="flex items-center gap-2">
            <FlaskConical className="h-4 w-4 text-accent" />
            <h3 className="text-sm font-semibold">Composition</h3>
            {detail.composition.length > 0 && (
              <span
                className={cn(
                  'ml-auto text-xs font-semibold tabular-nums rounded-full px-2 py-0.5',
                  totalOk ? 'bg-green-500/10 text-green-700' : 'bg-destructive/10 text-destructive',
                )}
                title={totalOk ? undefined : 'La composition doit totaliser 100%'}
              >
                {fmtNum(totalPct, 1)} %
              </span>
            )}
          </div>

          {detail.composition.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">Aucune matière</p>
          ) : (
            <>
              {/* Proportion bar — one segment per matière, same colour as its row dot */}
              <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-zinc-200/70">
                {detail.composition.map((c, i) => (
                  <div
                    key={c.IDasso_fil_matiere}
                    className={cn('h-full', COMPO_COLORS[i % COMPO_COLORS.length])}
                    style={{ width: `${Math.max(0, (Number(c.pourcentage) || 0) * 100)}%` }}
                    title={`${c.matiere_libelle ?? '—'} · ${pct(c.pourcentage)}`}
                  />
                ))}
              </div>
              <div className="divide-y divide-border/50">
                {detail.composition.map((c, i) => (
                  <div key={c.IDasso_fil_matiere} className="group flex items-center gap-2.5 py-2">
                    <span className={cn('h-2.5 w-2.5 rounded-full flex-shrink-0', COMPO_COLORS[i % COMPO_COLORS.length])} />
                    <span className="text-sm font-medium truncate">{c.matiere_libelle ?? '—'}</span>
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
                    <span className="ml-auto text-sm font-semibold tabular-nums">{pct(c.pourcentage)}</span>
                    {isEditing && (
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => startEditRow(c)}
                          className="p-0.5 text-muted-foreground hover:text-foreground"
                          title="Modifier"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={() => setDeleteTarget(c)}
                          className="p-0.5 text-destructive hover:text-destructive/80"
                          title="Supprimer"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
          {isEditing && <AddRowButton label="Ajouter une matière" onClick={startCreate} />}
        </CardContent>
      </Card>
      <CompositionForm
        open={isEditing && (showForm || editingId !== null)}
        form={form}
        onFormChange={setForm}
        matieres={matieres ?? []}
        onCancel={resetForm}
        onSave={() => (editingId !== null ? updateMut.mutate(editingId) : createMut.mutate())}
        isSaving={createMut.isPending || updateMut.isPending}
        errorMsg={errorMsg}
        title={editingId !== null ? 'Modifier la matière' : 'Nouvelle matière'}
      />
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
  open,
  form,
  onFormChange,
  matieres,
  onCancel,
  onSave,
  isSaving,
  errorMsg,
  title,
}: {
  open: boolean
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
    <SubFormDialog
      open={open}
      title={title}
      icon={FlaskConical}
      onClose={onCancel}
      onSave={onSave}
      canSave={canSave}
      isSaving={isSaving}
      errorMsg={errorMsg}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
    </SubFormDialog>
  )
}

// ── Variantes Card ─────────────────────────────────────

// stock_mini / delai_appro are NOT part of this form: they are set from the
// Stock & conso dialog (PUT …/reappro), their only writer.
interface VarianteDraft {
  reference: string
  prix_kg: string
  commentaire: string
}

function emptyVarianteDraft(): VarianteDraft {
  return { reference: '', prix_kg: '', commentaire: '' }
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
  // is shared. Loaded only in edit mode, where the « Ajouter un fournisseur » picker needs it.
  const { data: allFournisseurs } = useQuery<Array<{ IDfournisseur: number; nom: string | null }>>({
    queryKey: ['fournisseurs'],
    queryFn: () => apiFetch('/fournisseurs'),
    enabled: isEditing,
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
    // Drop a previous save error so the next dialog opens clean.
    createMut.reset()
    updateMut.reset()
  }

  const draftToBody = (f: VarianteDraft) => ({
    reference: f.reference.trim(),
    prix_kg: f.prix_kg === '' ? 0 : Number(f.prix_kg),
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
      commentaire: v.commentaire ?? '',
    })
  }

  // Status and « disponible » come from the consumption endpoint — the same
  // rule as the alert: available stock (stock + ordered − reserved) against
  // the minimum, never the bare shelf stock (280/48 écru: 163,7 kg on the
  // shelf under a 180 kg minimum, but 500 kg on order).
  const { data: consoData } = useConsommationFil(refFilId)
  const consoById = new Map<number, ConsoColoris>()
  for (const c of consoData?.coloris ?? []) consoById.set(c.IDcolori_fil, c)
  const aCommanderCount = (consoData?.coloris ?? []).filter((c) => c.statut === 'commander').length

  return (
    <>
      {/* A section of the Spécifications tab, built like the Composition one. */}
      <Card className={cn('card-premium', isEditing && editSectionClass)}>
        <CardContent className="pt-4 pb-4 space-y-3">
          <div className="flex items-center gap-2">
            <Palette className="h-4 w-4 text-accent" />
            <h3 className="text-sm font-semibold">Coloris</h3>
            <span className="text-xs text-muted-foreground tabular-nums">{detail.variantes.length}</span>
            {aCommanderCount > 0 && (
              <span className="ml-auto inline-flex items-center gap-1 text-xs font-semibold rounded-full px-2 py-0.5 bg-destructive/10 text-destructive">
                <AlertCircle className="h-3 w-3" />
                {aCommanderCount} à commander
              </span>
            )}
          </div>
          {detail.variantes.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">Aucun coloris</p>
          ) : (
            <div className="divide-y divide-border/50">
              {detail.variantes.map((v, i) => {
                const conso = consoById.get(v.IDcolori_fil)
                const mini = Number(v.stock_mini) || 0
                const underMini = conso?.statut === 'commander'
                return (
                  <div key={v.IDcolori_fil} className="group py-2.5 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      {/* Identity — name, alert, suppliers */}
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div
                          className={cn(
                            'h-8 w-8 rounded-md flex items-center justify-center flex-shrink-0',
                            underMini ? 'bg-destructive/10' : 'bg-amber-400/10',
                          )}
                        >
                          <Palette className={cn('h-4 w-4', underMini ? 'text-destructive/70' : 'text-amber-600')} />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <p className="text-sm font-semibold truncate">{v.reference ?? '—'}</p>
                            {conso && <StatutBadge statut={conso.statut} />}
                          </div>
                          {(isEditing || v.fournisseurs.length > 0) && (
                            <div className="mt-1 flex flex-wrap items-center gap-1">
                              {v.fournisseurs.length === 0 ? (
                                <span className="text-xs text-muted-foreground italic">Aucun fournisseur lié</span>
                              ) : (
                                v.fournisseurs.map((f) => (
                                  <span
                                    key={f.IDfournisseur}
                                    className="inline-flex items-center gap-1 rounded-full bg-zinc-100 border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground"
                                  >
                                    <Factory className="h-2.5 w-2.5" />
                                    {f.nom ?? '—'}
                                    {isEditing && (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          unlinkFrsMut.mutate({ coloriId: v.IDcolori_fil, fournisseurId: f.IDfournisseur })
                                        }
                                        disabled={unlinkFrsMut.isPending}
                                        className="rounded-full hover:bg-destructive/20 hover:text-destructive p-0.5 -mr-1 transition-colors"
                                        title="Retirer ce fournisseur"
                                      >
                                        <X className="h-2.5 w-2.5" />
                                      </button>
                                    )}
                                  </span>
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
                                    .filter((f) => !v.fournisseurs.some((linked) => linked.IDfournisseur === f.IDfournisseur))
                                    .map((f) => ({ id: f.IDfournisseur, primary: f.nom ?? `#${f.IDfournisseur}` }))}
                                />
                              )}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Key figures — compact, right-aligned, same columns on every card */}
                      <div className="grid grid-cols-3 gap-5 flex-shrink-0">
                        <ColorisFigure showLabel={i === 0} label="Prix" value={v.prix_kg != null && v.prix_kg > 0 ? `${fmtNum(v.prix_kg, 2)} €/kg` : '—'} />
                        <ColorisFigure
                          showLabel={i === 0}
                          label="Disponible"
                          value={conso ? `${fmtNum(conso.disponible, 1)} kg` : '…'}
                          tone={underMini ? 'danger' : undefined}
                        />
                        <ColorisFigure
                          showLabel={i === 0}
                          label="Stock mini"
                          value={mini > 0 ? `${fmtNum(mini, 0)} kg` : '—'}
                          sub={conso?.semaines_mini != null ? `≈ ${fmtNum(conso.semaines_mini, 0)} sem.` : undefined}
                        />
                      </div>

                      {isEditing && (
                        <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={() => startEditRow(v)}
                            className="p-0.5 text-muted-foreground hover:text-foreground"
                            title="Modifier"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={() => {
                              setDeleteTarget(v)
                              setErrorMsg(null)
                            }}
                            className="p-0.5 text-destructive hover:text-destructive/80"
                            title="Supprimer"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </div>

                    {!!v.commentaire?.trim() && (
                      <div className="flex items-start gap-1.5 mt-1.5 ml-11">
                        <MessageSquare className="h-3 w-3 text-muted-foreground/50 flex-shrink-0 mt-0.5" />
                        <p className="text-[11px] text-muted-foreground italic">{v.commentaire.trim()}</p>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
          {isEditing && (
            <AddRowButton
              label="Ajouter un coloris"
              onClick={() => {
                setShowForm(true)
                setEditingId(null)
                setForm(emptyVarianteDraft())
              }}
            />
          )}
        </CardContent>
      </Card>
      <VarianteForm
        open={isEditing && (showForm || editingId !== null)}
        form={form}
        onFormChange={setForm}
        onCancel={resetForm}
        onSave={() => (editingId !== null ? updateMut.mutate(editingId) : createMut.mutate())}
        isSaving={createMut.isPending || updateMut.isPending}
        errorMsg={saveErrorMessage(editingId !== null ? updateMut.error : createMut.error)}
        title={editingId !== null ? 'Modifier le coloris' : 'Nouveau coloris'}
      />
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

/** One labelled figure on a coloris card (price, stock, minimum). */
function ColorisFigure({ label, value, tone, sub, showLabel = true }: { label: string; value: string; tone?: 'danger'; sub?: string; showLabel?: boolean }) {
  return (
    // Fixed width + right alignment so the figures form columns across cards.
    <div className="w-24 text-right">
      {showLabel && (
        <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold truncate">{label}</p>
      )}
      <p className={cn('text-sm font-semibold tabular-nums truncate', tone === 'danger' && 'text-destructive')} title={label}>
        {value}
      </p>
      {sub && <p className="text-[10px] text-muted-foreground tabular-nums">{sub}</p>}
    </div>
  )
}

/** The server's French reason for a failed save (`apiFetch` puts the JSON
 *  body on `err.body`), or a generic line. */
function saveErrorMessage(err: unknown): string | null {
  if (!err) return null
  const body = (err as { body?: { message?: unknown; error?: unknown } }).body
  return String(body?.message ?? body?.error ?? "L'enregistrement a échoué")
}

function deleteError(errorMsg: string | null, target: Variante | null): string | undefined {
  if (errorMsg) return errorMsg
  if (!target) return undefined
  return `${target.reference ?? '—'} sera supprimée de la référence.`
}

function VarianteForm({
  open,
  form,
  onFormChange,
  onCancel,
  onSave,
  isSaving,
  errorMsg,
  title,
}: {
  open: boolean
  form: VarianteDraft
  onFormChange: (f: VarianteDraft) => void
  onCancel: () => void
  onSave: () => void
  isSaving: boolean
  errorMsg: string | null
  title: string
}) {
  const canSave = form.reference.trim().length > 0
  return (
    <SubFormDialog
      open={open}
      title={title}
      icon={Palette}
      onClose={onCancel}
      onSave={onSave}
      canSave={canSave}
      isSaving={isSaving}
      errorMsg={errorMsg}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
      <p className="text-[11px] text-muted-foreground">
        Le stock mini et le délai d'approvisionnement se règlent dans l'onglet <span className="font-medium text-foreground">Stock & conso</span>,
        face à la projection.
      </p>
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Commentaire</label>
        <textarea
          value={form.commentaire}
          onChange={(e) => onFormChange({ ...form, commentaire: e.target.value })}
          rows={2}
          className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
        />
      </div>
    </SubFormDialog>
  )
}

// ── Commandes tab ──────────────────────────────────────
// Read-only purchase history. A row opens the commande in Fils › Commandes.

function CommandesAggregateCard({ detail }: { detail: RefFilDetail }) {
  const navigate = useNavigate()
  const history = detail.commande_history ?? []
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <SpecTile label="Total commandé">
          <TileFigure value={fmtNum(detail.commande_total_kg, 1)} unit="kg" />
        </SpecTile>
        <SpecTile label="Lignes">
          <TileFigure value={fmtNum(detail.commande_lignes)} />
        </SpecTile>
        <SpecTile label="Encore attendu">
          <TileFigure value={fmtNum(detail.commande_reste_kg, 1)} unit="kg" />
        </SpecTile>
      </div>
      {history.length === 0 ? (
        <p className="text-sm text-muted-foreground italic px-1">Aucune commande</p>
      ) : (
        <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-200/60 border-b border-border/60">
              <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 text-left font-semibold">N°</th>
                <th className="px-3 py-2 text-left font-semibold">Date</th>
                <th className="px-3 py-2 text-left font-semibold">Fournisseur</th>
                <th className="px-3 py-2 text-left font-semibold">Coloris</th>
                <th className="px-3 py-2 text-right font-semibold">Quantité</th>
                <th className="px-3 py-2 text-right font-semibold">Prix</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr
                  key={h.IDref_fil_commande}
                  className="border-b border-border/40 last:border-b-0 hover:bg-accent/5 transition-colors cursor-pointer"
                  onClick={() => navigate(`/fils/commandes?id=${h.IDcommande_fil}`)}
                >
                  <td className="px-3 py-2 tabular-nums font-medium whitespace-nowrap">N°{h.IDcommande_fil}</td>
                  <td className="px-3 py-2 tabular-nums text-muted-foreground whitespace-nowrap">
                    {h.date_commande ? formatHfsqlDate(h.date_commande) : '—'}
                  </td>
                  <td className="px-3 py-2 truncate max-w-[180px]">{h.fournisseur_nom ?? '—'}</td>
                  <td className="px-3 py-2 text-muted-foreground truncate max-w-[120px]">{h.colori_reference ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold whitespace-nowrap">{fmtNum(h.quantite, 0)} kg</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground whitespace-nowrap">
                    {h.prix_unitaire != null && h.prix_unitaire > 0 ? `${fmtNum(h.prix_unitaire, 2)} €/kg` : '—'}
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {h.etat === 1 ? (
                      <Badge variant="success" className="text-[10px] py-0 px-1.5">Terminée</Badge>
                    ) : (
                      <Badge variant="default" className="text-[10px] py-0 px-1.5">En cours</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

// ── Offres tab ────────────────────────────────────────
// Supplier price quotes per ref_fil. Visible in both modes (employees record
// new quotes during edit mode). Add via dialog, delete via hover-trash.

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
    enabled: isEditing,
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

  // Summary tiles: cheapest quote ever recorded, and the most recent one by date.
  const priced = offres.filter((o) => o.prix != null && o.prix > 0)
  const best = priced.reduce<OffreFilRow | null>((b, o) => (b == null || o.prix! < b.prix! ? o : b), null)
  const latest = offres.reduce<OffreFilRow | null>(
    (l, o) => (l == null || String(o.date ?? '') > String(l.date ?? '') ? o : l),
    null,
  )

  return (
    <>
      {offres.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <SpecTile label="Meilleur prix">
            <TileFigure value={best?.prix != null ? fmtNum(best.prix, 2) : null} unit="€/kg" />
            <p className="mt-1 text-[11px] text-muted-foreground truncate">{best?.fournisseur_nom ?? '—'}</p>
          </SpecTile>
          <SpecTile label="Dernière offre">
            <TileFigure value={latest?.prix != null ? fmtNum(latest.prix, 2) : null} unit="€/kg" />
            <p className="mt-1 text-[11px] text-muted-foreground truncate">
              {latest?.fournisseur_nom ?? '—'}
              {latest?.date ? ` · ${formatHfsqlDate(latest.date)}` : ''}
            </p>
          </SpecTile>
          <SpecTile label="Fournisseurs">
            <TileFigure value={fmtNum(new Set(offres.map((o) => o.IDfournisseur)).size)} />
            <p className="mt-1 text-[11px] text-muted-foreground truncate">
              {offres.length} offre{offres.length > 1 ? 's' : ''}
            </p>
          </SpecTile>
        </div>
      )}
      {offres.length === 0 ? (
        <p className="text-sm text-muted-foreground italic px-1">Aucune offre enregistrée</p>
      ) : (
        <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-200/60 border-b border-border/60">
              <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 text-left font-semibold">Date</th>
                <th className="px-3 py-2 text-left font-semibold">Fournisseur</th>
                <th className="px-3 py-2 text-left font-semibold">Coloris</th>
                <th className="px-3 py-2 text-right font-semibold">Quantité</th>
                <th className="px-3 py-2 text-right font-semibold">Prix</th>
                {isEditing && <th className="w-8" />}
              </tr>
            </thead>
            <tbody>
              {offres.map((o) => (
                <tr key={o.IDoffre_fil} className="group border-b border-border/40 last:border-b-0 align-top">
                  <td className="px-3 py-2 tabular-nums text-muted-foreground whitespace-nowrap">
                    {o.date ? formatHfsqlDate(o.date) : '—'}
                  </td>
                  <td className="px-3 py-2">
                    <p className="font-medium">{o.fournisseur_nom ?? '—'}</p>
                    {!!o.observation?.trim() && (
                      <p className="mt-0.5 flex items-start gap-1 text-[11px] text-muted-foreground italic">
                        <MessageSquare className="h-3 w-3 text-muted-foreground/50 flex-shrink-0 mt-0.5" />
                        {o.observation.trim()}
                      </p>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{o.colori_reference ?? 'Tous'}</td>
                  <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                    {o.quantite != null && o.quantite > 0 ? `${fmtNum(o.quantite, 0)} kg` : '—'}
                  </td>
                  <td
                    className={cn(
                      'px-3 py-2 text-right tabular-nums font-semibold whitespace-nowrap',
                      best && o.IDoffre_fil === best.IDoffre_fil && 'text-green-700',
                    )}
                  >
                    {o.prix != null ? `${fmtNum(o.prix, 2)} €/kg` : '—'}
                  </td>
                  {isEditing && (
                    <td className="px-1 py-2 text-right">
                      <button
                        onClick={() => setDeleteTarget(o)}
                        className="opacity-0 group-hover:opacity-100 p-0.5 text-destructive hover:text-destructive/80 transition-opacity"
                        title="Supprimer"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {isEditing && (
        <AddRowButton
          label="Ajouter une offre"
          onClick={() => {
            setShowForm(true)
            setErrorMsg(null)
          }}
        />
      )}
      <SubFormDialog
        open={showForm && isEditing}
        title="Nouvelle offre"
        icon={Tag}
        onClose={resetForm}
        onSave={() => createMut.mutate()}
        canSave={canSubmit}
        isSaving={createMut.isPending}
        errorMsg={errorMsg}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
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
      </SubFormDialog>
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
  const [activeTab, setActiveTab] = useState<SidebarTab>('info')
  // Land on Informations whenever another reference is selected.
  useEffect(() => { setActiveTab('info') }, [detail?.IDref_fil])

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
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveTab(t.key)}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md transition-colors',
                activeTab === t.key
                  ? 'bg-accent text-accent-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-accent/10',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          )
        })}
      </div>
      {activeTab === 'documents' ? (
        <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-transparent">
          <DocsTab refFilId={detail.IDref_fil} isEditing={isEditing} />
        </div>
      ) : (
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
      )}
    </div>
  )
}

// ── Sidebar Tab: Documents ─────────────────────────────
//
// Fiche technique, certificats… of the yarn (ged rows keyed on IDref_fil —
// apps/api/src/lib/ref-fil-documents.ts). Same three components as the
// FilsCommandes DocsTab (mps_designer §34), without the per-lot linkage.

type SidebarTab = 'info' | 'documents'
const SIDEBAR_TABS: Array<{ key: SidebarTab; label: string; icon: typeof Info }> = [
  { key: 'info', label: 'Informations', icon: Info },
  { key: 'documents', label: 'Documents', icon: FileText },
]

interface RefFilDocument {
  IDged: number
  nom: string | null
  commentaire: string | null
  IDtype_doc: number
  type_nom: string | null
}

interface RefFilDocType {
  IDtype_doc: number
  nom: string
}

const docTitle = (d: RefFilDocument) => d.nom?.trim() || `Document #${d.IDged}`

function DocsTab({ refFilId, isEditing }: { refFilId: number; isEditing: boolean }) {
  const queryClient = useQueryClient()
  const docsQueryKey = ['ref-fil-docs', refFilId] as const

  const { data, isLoading, error } = useQuery<RefFilDocument[]>({
    queryKey: docsQueryKey,
    queryFn: () => apiFetch(`/references-fil/${refFilId}/documents`),
  })

  const [viewDoc, setViewDoc] = useState<RefFilDocument | null>(null)
  const [editingDoc, setEditingDoc] = useState<RefFilDocument | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteDocConfirm, setDeleteDocConfirm] = useState<RefFilDocument | null>(null)

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['ref-fil-docs', refFilId] })
  }, [queryClient, refFilId])

  const deleteMut = useMutation({
    mutationFn: (idged: number) =>
      apiFetch(`/references-fil/${refFilId}/documents/${idged}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  })

  return (
    <>
      {isLoading && (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
        </div>
      )}

      {!!error && (
        <div className="flex items-center gap-1.5 py-3 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5" />
          <span>Erreur de chargement</span>
        </div>
      )}

      {!isLoading && !error && !data?.length && (
        <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
          <FileText className="h-10 w-10 mb-3 opacity-40" />
          <p className="text-sm font-medium">Aucun document</p>
          <p className="text-[11px] mt-1 text-center">
            Fiches techniques, certificats et autres documents du fil apparaîtront ici.
          </p>
        </div>
      )}

      {!!data?.length && (
        <div className="space-y-2">
          {data.map((doc) => {
            const title = docTitle(doc)
            return (
              <div
                key={doc.IDged}
                onClick={() => isEditing ? setEditingDoc(doc) : setViewDoc(doc)}
                className={cn(
                  'group p-3 rounded-lg border bg-card shadow-sm cursor-pointer hover:border-accent/40 transition-colors',
                  isEditing && editSectionClass,
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-amber-400/10">
                    <FileText className="h-3.5 w-3.5 text-amber-600" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate" title={title}>{title}</p>
                    {!!doc.type_nom && (
                      <p className="text-[11px] text-muted-foreground truncate">{doc.type_nom}</p>
                    )}
                  </div>
                  {isEditing && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-destructive hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                      onClick={(e) => {
                        e.stopPropagation()
                        setDeleteDocConfirm(doc)
                      }}
                      title="Supprimer"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  )}
                </div>
                {!!doc.commentaire?.trim() && (
                  <div className="flex items-start gap-1.5 mt-2 ml-9">
                    <MessageSquare className="h-3 w-3 text-muted-foreground/50 flex-shrink-0 mt-0.5" />
                    <p className="text-[11px] text-muted-foreground italic whitespace-pre-line">{doc.commentaire.trim()}</p>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {isEditing && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full mt-2 text-muted-foreground hover:text-foreground"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="h-4 w-4 mr-1.5" />Ajouter un document
        </Button>
      )}

      <DocViewDialog refFilId={refFilId} doc={viewDoc} onClose={() => setViewDoc(null)} />

      <DocCreateEditDialog
        open={createOpen || editingDoc !== null}
        refFilId={refFilId}
        doc={editingDoc}
        onClose={() => { setCreateOpen(false); setEditingDoc(null) }}
        onSuccess={() => { setCreateOpen(false); setEditingDoc(null); invalidate() }}
      />

      <ConfirmDialog
        open={deleteDocConfirm !== null}
        title="Supprimer le document"
        description={deleteDocConfirm ? `« ${docTitle(deleteDocConfirm)} » sera supprimé définitivement.` : undefined}
        confirmLabel="Supprimer"
        isPending={deleteMut.isPending}
        onCancel={() => setDeleteDocConfirm(null)}
        onConfirm={() => {
          if (deleteDocConfirm) {
            deleteMut.mutate(deleteDocConfirm.IDged, {
              onSuccess: () => setDeleteDocConfirm(null),
            })
          }
        }}
      />
    </>
  )
}

function DocCreateEditDialog({
  open, refFilId, doc, onClose, onSuccess,
}: {
  open: boolean
  refFilId: number
  doc: RefFilDocument | null // null = create mode
  onClose: () => void
  onSuccess: () => void
}) {
  const isNew = doc === null
  const [nom, setNom] = useState('')
  const [idTypeDoc, setIdTypeDoc] = useState<number>(0)
  const [commentaire, setCommentaire] = useState('')
  const [newFile, setNewFile] = useState<File | null>(null)
  const [newFileUrl, setNewFileUrl] = useState<string | null>(null)
  const [removeFichier, setRemoveFichier] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data: typeDocs } = useQuery<RefFilDocType[]>({
    queryKey: ['ref-fil-types-doc'],
    queryFn: () => apiFetch('/references-fil/lookups/types-doc'),
    enabled: open,
    staleTime: Infinity,
  })

  // Reset the form whenever the dialog opens (or the target doc changes).
  useEffect(() => {
    if (!open) return
    setNom(doc?.nom ?? '')
    setIdTypeDoc(doc?.IDtype_doc ?? 0)
    setCommentaire(doc?.commentaire ?? '')
    setNewFile(null)
    if (newFileUrl) URL.revokeObjectURL(newFileUrl)
    setNewFileUrl(null)
    setRemoveFichier(false)
    setError(null)
    setIsSaving(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, doc?.IDged])

  // A new document defaults to « Fiche technique » (the first type).
  useEffect(() => {
    if (open && isNew && idTypeDoc === 0 && typeDocs?.length) setIdTypeDoc(typeDocs[0].IDtype_doc)
  }, [open, isNew, idTypeDoc, typeDocs])

  // Clean up the blob URL when the dialog closes.
  useEffect(() => {
    if (!open && newFileUrl) {
      URL.revokeObjectURL(newFileUrl)
      setNewFileUrl(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const handleFilePick = (f: File) => {
    if (newFileUrl) URL.revokeObjectURL(newFileUrl)
    setNewFile(f)
    setNewFileUrl(URL.createObjectURL(f))
    setRemoveFichier(false)
    // Name the document after its file unless the user already typed one.
    if (!nom.trim()) setNom(f.name)
  }

  const handleRemoveFile = () => {
    if (newFileUrl) URL.revokeObjectURL(newFileUrl)
    setNewFile(null)
    setNewFileUrl(null)
    setRemoveFichier(true)
  }

  const handleSave = async () => {
    if (isNew && !newFile) {
      setError('Choisissez un fichier.')
      return
    }
    setError(null)
    setIsSaving(true)
    try {
      const formData = new FormData()
      formData.append('nom', nom)
      formData.append('commentaire', commentaire)
      formData.append('IDtype_doc', String(idTypeDoc))
      if (newFile) formData.append('fichier', newFile)
      if (removeFichier && !newFile) formData.append('remove_fichier', '1')

      const url = isNew
        ? `${API_URL}/references-fil/${refFilId}/documents`
        : `${API_URL}/references-fil/${refFilId}/documents/${doc!.IDged}`
      // Raw fetch: apiFetch forces JSON, which would clobber the multipart boundary.
      const res = await fetch(url, { method: isNew ? 'POST' : 'PUT', body: formData, credentials: 'include' })
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string } | null
        throw new Error(body?.error || `Erreur HTTP ${res.status}`)
      }
      onSuccess()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue')
      setIsSaving(false)
    }
  }

  // Preview: the freshly picked file, else the stored blob, else nothing.
  const previewUrl = newFileUrl
    ? newFileUrl
    : !isNew && !removeFichier && doc
      ? `${API_URL}/references-fil/${refFilId}/documents/${doc.IDged}/fichier#view=FitH`
      : null

  if (!open) return null

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-5xl h-[85vh] flex flex-col" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-accent" />
            {isNew ? 'Ajouter un document' : 'Modifier le document'}
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 min-h-0 flex gap-4">
          {/* Left: form fields */}
          <div className="w-80 flex-shrink-0 overflow-y-auto space-y-3 px-1">
            <LabeledInput label="Nom" value={nom} onChange={setNom} placeholder="Nom du fichier par défaut" />
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Type de document</label>
              <PopoverSelect
                options={(typeDocs ?? []).map((t) => ({ id: t.IDtype_doc, primary: t.nom }))}
                value={idTypeDoc}
                onChange={setIdTypeDoc}
                hideEmpty
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Commentaire</label>
              <textarea
                value={commentaire}
                onChange={(e) => setCommentaire(e.target.value)}
                rows={4}
                placeholder="Prix, délai, MOQ…"
                className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
              />
            </div>
            {!!error && (
              <div className="flex items-start gap-1.5 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                <span className="break-all">{error}</span>
              </div>
            )}
          </div>

          {/* Right: viewer + file controls + action buttons */}
          <div className="flex-1 min-w-0 flex flex-col gap-2">
            <div className="flex-1 min-h-0 rounded-lg border border-border/60 bg-zinc-50 overflow-hidden">
              {previewUrl ? (
                <iframe src={previewUrl} className="w-full h-full" title="Document" />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center text-muted-foreground">
                  <FileText className="h-12 w-12 mb-2 opacity-30" />
                  <p className="text-sm">Aucun fichier</p>
                  <p className="text-[11px]">Choisissez un fichier ci-dessous</p>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <label className="cursor-pointer">
                <input
                  type="file"
                  className="hidden"
                  /* No `accept` filter: any file type (PDF, image, Excel…). */
                  onClick={(e) => { (e.target as HTMLInputElement).value = '' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) handleFilePick(f)
                  }}
                />
                <span className={cn(inputClass, 'inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/5 w-auto px-3')}>
                  <Upload className="h-3.5 w-3.5" />
                  {newFile ? newFile.name : 'Choisir un fichier'}
                </span>
              </label>
              {(newFile || (!isNew && !removeFichier && doc)) && (
                <Button variant="ghost" size="sm" className="h-8 px-2" onClick={handleRemoveFile} title="Retirer le fichier">
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
              <div className="flex items-center gap-2 ml-auto">
                <Button variant="outline" size="sm" onClick={onClose} disabled={isSaving}>Annuler</Button>
                <Button size="sm" onClick={handleSave} disabled={isSaving}>
                  {isSaving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                  <Save className="h-3.5 w-3.5 mr-1.5" />
                  Enregistrer
                </Button>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function DocViewDialog({
  refFilId, doc, onClose,
}: { refFilId: number; doc: RefFilDocument | null; onClose: () => void }) {
  const [fichierOk, setFichierOk] = useState<boolean | null>(null)

  // HEAD pre-check: an empty blob answers 404 and must not open a blank iframe.
  useEffect(() => {
    if (!doc) { setFichierOk(null); return }
    setFichierOk(null)
    fetch(`${API_URL}/references-fil/${refFilId}/documents/${doc.IDged}/fichier`, {
      method: 'HEAD',
      credentials: 'include',
    })
      .then((r) => setFichierOk(r.ok))
      .catch(() => setFichierOk(false))
  }, [doc?.IDged, refFilId])

  if (!doc) return null

  return (
    <Dialog open={!!doc} onOpenChange={() => onClose()}>
      {fichierOk ? (
        <div className="relative z-50 w-[60vw] max-w-3xl h-[95vh]" onClick={(e) => e.stopPropagation()}>
          <iframe
            src={`${API_URL}/references-fil/${refFilId}/documents/${doc.IDged}/fichier#view=FitH`}
            className="w-full h-full rounded-lg"
            title={docTitle(doc)}
          />
        </div>
      ) : (
        <DialogContent className="max-w-sm" onClose={onClose}>
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <div className="text-center space-y-2">
              <FileText className="h-12 w-12 mx-auto opacity-30" />
              <p className="text-sm">{fichierOk === null ? 'Chargement...' : 'Aucun document attaché'}</p>
            </div>
          </div>
        </DialogContent>
      )}
    </Dialog>
  )
}
