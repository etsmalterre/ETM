import { useState, useMemo, useEffect, useCallback, useRef, type ComponentType } from 'react'
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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
  ChevronDown,
  CheckCircle2,
  Circle,
  Package,
  Ruler,
  Palette,
  Droplets,
  Droplet,
  Warehouse,
  FileText,
  FlaskConical,
  Archive,
  Lock,
  BadgeEuro,
  Printer,
  Tag,
  Users,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PopoverSelect, SearchableCombobox } from '@/components/ui/popover-select'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'
import { FiniRollIcon } from '@/components/icons/FiniRollIcon'
import { TmRollIcon } from '@/components/icons/TmRollIcon'
import { cn } from '@/lib/utils'
import { apiFetch, API_URL } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { formatHfsqlDate } from '@/lib/dates'

// ── Types ──────────────────────────────────────────────

interface RefFiniListRow {
  IDref_fini: number
  reference: string | null
  designation: string | null
  avec_teinture: number
  en_developpement: number
  coloris_count: number
  stock_lots: number
  stock_total_kg: number
}

interface Coloris {
  id: number
  reference: string | null
  IDteinture: number | null
}

interface Traitement {
  IDtraitement: number
  designation: string | null
}

interface EcruRef {
  IDref_ecru: number
  reference: string | null
  designation: string | null
}

interface RefFiniDetail {
  IDref_fini: number
  IDref_ecru: number
  IDcolori_ecru: number
  reference: string | null
  designation: string | null
  conditionnement: string | null
  observations: string | null
  observation_technique: string | null
  description_commercial: string | null
  responsable: string | null
  avec_teinture: number
  rendement: number | null
  freinte: number | null
  temp_lavage: number | null
  poids_Moy: number | null
  poids_Min: number | null
  poids_Max: number | null
  laizeHT_Moy: number | null
  laizeHT_Min: number | null
  laizeHT_Max: number | null
  laizeUtile_Moy: number | null
  laizeUtile_Min: number | null
  laizeUtile_Max: number | null
  stab_hauteur: number | null
  stab_largeur: number | null
  allongementH_Min: number | null
  allongementH_Moy: number | null
  allongementH_Max: number | null
  allongementL_Min: number | null
  allongementL_Moy: number | null
  allongementL_Max: number | null
  controle_sst_rendement: number
  controle_sst_stab: number
  controle_sst_allongement: number
  en_developpement: number
  archive: number
  catalogue_prive: number
  date_creation: string | null
  date_modification: string | null
  ecru: EcruRef | null
  coloris: Coloris[]
  coloris_mode: 'dye' | 'wash'
  traitements: Traitement[]
  stock_total_kg: number
  stock_total_m: number
  stock_lots: number
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
  suffix,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  step?: string
  suffix?: string
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">
        {label}
        {suffix ? <span className="text-muted-foreground/60"> ({suffix})</span> : null}
      </label>
      <input
        type={type}
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
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

/** Read-mode spec value: bold tabular number + optional unit, or em-dash. */
function teintureLabel(avec: number): string {
  if (avec === 1) return 'Simple teinture'
  if (avec === 2) return 'Double teinture'
  return 'Écru / lavage'
}

// ── API helpers ────────────────────────────────────────

function useRefsFini() {
  return useQuery<RefFiniListRow[]>({
    queryKey: ['refs-fini'],
    queryFn: () => apiFetch('/references-fini'),
  })
}

function useRefFiniDetail(id: number | null) {
  return useQuery<RefFiniDetail>({
    queryKey: ['ref-fini', id],
    queryFn: () => apiFetch(`/references-fini/${id}`),
    enabled: id !== null,
  })
}

function useEcruLookup(enabled: boolean) {
  return useQuery<EcruRef[]>({
    queryKey: ['ref-fini-lookups-ecru'],
    queryFn: () => apiFetch('/references-fini/lookups/ecru'),
    enabled,
    staleTime: 5 * 60_000,
  })
}

// ── Draft ──────────────────────────────────────────────

interface HeaderDraft {
  reference: string
  designation: string
  conditionnement: string
  responsable: string
  observations: string
  observation_technique: string
  description_commercial: string
  IDref_ecru: number
  rendement: string
  freinte: string
  temp_lavage: string
  poids_Moy: string
  poids_Min: string
  poids_Max: string
  laizeHT_Moy: string
  laizeHT_Min: string
  laizeHT_Max: string
  laizeUtile_Moy: string
  laizeUtile_Min: string
  laizeUtile_Max: string
  stab_hauteur: string
  stab_largeur: string
  allongementH_Min: string
  allongementH_Moy: string
  allongementH_Max: string
  allongementL_Min: string
  allongementL_Moy: string
  allongementL_Max: string
  controle_sst_rendement: boolean
  controle_sst_stab: boolean
  controle_sst_allongement: boolean
  en_developpement: boolean
}

const numStr = (n: number | null | undefined): string => (n == null ? '' : String(n))

function emptyDraft(): HeaderDraft {
  return {
    reference: '',
    designation: '',
    conditionnement: '',
    responsable: '',
    observations: '',
    observation_technique: '',
    description_commercial: '',
    IDref_ecru: 0,
    rendement: '',
    freinte: '',
    temp_lavage: '',
    poids_Moy: '',
    poids_Min: '',
    poids_Max: '',
    laizeHT_Moy: '',
    laizeHT_Min: '',
    laizeHT_Max: '',
    laizeUtile_Moy: '',
    laizeUtile_Min: '',
    laizeUtile_Max: '',
    stab_hauteur: '',
    stab_largeur: '',
    allongementH_Min: '',
    allongementH_Moy: '',
    allongementH_Max: '',
    allongementL_Min: '',
    allongementL_Moy: '',
    allongementL_Max: '',
    controle_sst_rendement: false,
    controle_sst_stab: false,
    controle_sst_allongement: false,
    en_developpement: false,
  }
}

function draftFromDetail(d: RefFiniDetail): HeaderDraft {
  return {
    reference: d.reference ?? '',
    designation: d.designation ?? '',
    conditionnement: d.conditionnement ?? '',
    responsable: d.responsable ?? '',
    observations: d.observations ?? '',
    observation_technique: d.observation_technique ?? '',
    description_commercial: d.description_commercial ?? '',
    IDref_ecru: Number(d.IDref_ecru) || 0,
    rendement: numStr(d.rendement),
    freinte: numStr(d.freinte),
    temp_lavage: numStr(d.temp_lavage),
    poids_Moy: numStr(d.poids_Moy),
    poids_Min: numStr(d.poids_Min),
    poids_Max: numStr(d.poids_Max),
    laizeHT_Moy: numStr(d.laizeHT_Moy),
    laizeHT_Min: numStr(d.laizeHT_Min),
    laizeHT_Max: numStr(d.laizeHT_Max),
    laizeUtile_Moy: numStr(d.laizeUtile_Moy),
    laizeUtile_Min: numStr(d.laizeUtile_Min),
    laizeUtile_Max: numStr(d.laizeUtile_Max),
    stab_hauteur: numStr(d.stab_hauteur),
    stab_largeur: numStr(d.stab_largeur),
    allongementH_Min: numStr(d.allongementH_Min),
    allongementH_Moy: numStr(d.allongementH_Moy),
    allongementH_Max: numStr(d.allongementH_Max),
    allongementL_Min: numStr(d.allongementL_Min),
    allongementL_Moy: numStr(d.allongementL_Moy),
    allongementL_Max: numStr(d.allongementL_Max),
    controle_sst_rendement: !!d.controle_sst_rendement,
    controle_sst_stab: !!d.controle_sst_stab,
    controle_sst_allongement: !!d.controle_sst_allongement,
    en_developpement: !!d.en_developpement,
  }
}

function draftToBody(d: HeaderDraft) {
  const num = (s: string) => (s.trim() === '' ? null : Number(s))
  return {
    reference: d.reference.trim(),
    designation: d.designation,
    conditionnement: d.conditionnement,
    responsable: d.responsable,
    observations: d.observations,
    observation_technique: d.observation_technique,
    description_commercial: d.description_commercial,
    IDref_ecru: d.IDref_ecru || 0,
    rendement: num(d.rendement),
    freinte: num(d.freinte),
    temp_lavage: num(d.temp_lavage),
    poids_Moy: num(d.poids_Moy),
    poids_Min: num(d.poids_Min),
    poids_Max: num(d.poids_Max),
    laizeHT_Moy: num(d.laizeHT_Moy),
    laizeHT_Min: num(d.laizeHT_Min),
    laizeHT_Max: num(d.laizeHT_Max),
    laizeUtile_Moy: num(d.laizeUtile_Moy),
    laizeUtile_Min: num(d.laizeUtile_Min),
    laizeUtile_Max: num(d.laizeUtile_Max),
    stab_hauteur: num(d.stab_hauteur),
    stab_largeur: num(d.stab_largeur),
    allongementH_Min: num(d.allongementH_Min),
    allongementH_Moy: num(d.allongementH_Moy),
    allongementH_Max: num(d.allongementH_Max),
    allongementL_Min: num(d.allongementL_Min),
    allongementL_Moy: num(d.allongementL_Moy),
    allongementL_Max: num(d.allongementL_Max),
    controle_sst_rendement: d.controle_sst_rendement,
    controle_sst_stab: d.controle_sst_stab,
    controle_sst_allongement: d.controle_sst_allongement,
    en_developpement: d.en_developpement,
  }
}

// ── Page ───────────────────────────────────────────────

export function FinisReferences() {
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState<HeaderDraft>(emptyDraft())
  const originalDraftRef = useRef<HeaderDraft | null>(null)

  const [autoEditForId, setAutoEditForId] = useState<number | null>(null)
  const [tarifsDialogOpen, setTarifsDialogOpen] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)

  const { data: refs, isLoading, isError, error } = useRefsFini()
  const { data: detail, isLoading: detailLoading } = useRefFiniDetail(selectedId)
  const { data: ecruOptions } = useEcruLookup(isEditing)

  const filtered = useMemo(() => {
    if (!refs) return []
    if (!searchQuery.trim()) return refs
    const terms = searchQuery.toLowerCase().split(/\s+/).filter(Boolean)
    return refs.filter((r) => {
      const haystack = `${r.reference ?? ''} ${r.designation ?? ''}`.toLowerCase()
      return terms.every((t) => haystack.includes(t))
    })
  }, [refs, searchQuery])

  // Keep the selection valid against the search-filtered list: narrowing the
  // search re-targets the top row instead of leaving the previous ref on screen.
  useAutoSelectFirst({
    rows: filtered,
    selectedId,
    getId: (r) => r.IDref_fini,
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
    return JSON.stringify(draft) !== JSON.stringify(o)
  }, [isEditing, draft])

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['refs-fini'] })
    queryClient.invalidateQueries({ queryKey: ['ref-fini', selectedId] })
  }, [queryClient, selectedId])

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/references-fini/${selectedId}`, {
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
      apiFetch<{ IDref_fini: number | null }>(`/references-fini`, {
        method: 'POST',
        body: JSON.stringify({ reference: 'Nouvelle référence' }),
      }),
    onSuccess: (data) => {
      setCreateError(null)
      queryClient.invalidateQueries({ queryKey: ['refs-fini'] })
      if (data.IDref_fini != null) {
        setSelectedId(data.IDref_fini)
        setAutoEditForId(data.IDref_fini)
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
    mutationFn: () => apiFetch(`/references-fini/${selectedId}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleteConfirmOpen(false)
      setDeleteError(null)
      const cached = queryClient.getQueryData<RefFiniListRow[]>(['refs-fini']) ?? []
      const remaining = cached.filter((r) => r.IDref_fini !== selectedId)
      queryClient.invalidateQueries({ queryKey: ['refs-fini'] })
      setSelectedId(remaining.length > 0 ? remaining[0].IDref_fini : null)
    },
    onError: async (err: Error & { status?: number }) => {
      let msg = 'Suppression impossible.'
      try {
        const res = await fetch(
          `${import.meta.env.VITE_API_URL || 'http://localhost:3002/api'}/references-fini/${selectedId}`,
          { method: 'DELETE', credentials: 'include' },
        )
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          if (body?.error) msg = String(body.error)
        }
      } catch {
        /* keep default */
      }
      setDeleteError(msg)
    },
  })

  // §25.1 auto-edit after create
  useEffect(() => {
    if (autoEditForId !== null && detail?.IDref_fini === autoEditForId) {
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
          <RefFiniList
            refs={filtered}
            totalCount={filtered.length}
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
            onCancelEdit={cancelEdit}
            onSave={() => saveMutation.mutate()}
            isSaving={saveMutation.isPending}
            onDelete={() => {
              setDeleteError(null)
              setDeleteConfirmOpen(true)
            }}
            onPrintDoc={(doc) => {
              if (selectedId === null) return
              if (doc === 'technique') {
                window.open(`${API_URL}/references-fini/${selectedId}/pdf`, '_blank')
              } else if (doc === 'etiquette') {
                // Always with the QR code, always one tag (user decision 2026-09-08):
                // no options dialog, the row prints.
                window.open(`${API_URL}/references-fini/${selectedId}/etiquette`, '_blank')
              } else {
                setTarifsDialogOpen(true)
              }
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
            onMutationSuccess={invalidateAll}
            ecruOptions={ecruOptions ?? []}
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
      <TarifsPrintDialog
        open={tarifsDialogOpen}
        onClose={() => setTarifsDialogOpen(false)}
        refId={selectedId}
        coloris={detail?.coloris ?? []}
      />
      <UnsavedChangesDialog open={guard.showDialog} onAction={guard.handleAction} isSaving={guard.isSaving} />
      <ConfirmDialog
        open={deleteConfirmOpen}
        title="Supprimer la référence"
        description={
          deleteError ??
          'Cette action supprimera définitivement la référence de produit fini. Elle est irréversible.'
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
      <AlertDialog open={createError !== null} onOpenChange={(o) => { if (!o) setCreateError(null) }}>
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

function RefFiniList({
  refs,
  totalCount,
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
  refs: RefFiniListRow[]
  totalCount: number
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
            <FiniRollIcon className="h-12 w-12 mb-3 opacity-50" />
            <p className="text-sm">Aucune référence</p>
          </div>
        ) : (
          refs.map((r) => (
            <div
              key={r.IDref_fini}
              onClick={() => onSelect(r.IDref_fini)}
              className={cn(
                'p-3 border rounded-lg cursor-pointer transition-all bg-white',
                selectedId === r.IDref_fini
                  ? 'border-accent ring-1 ring-accent'
                  : 'border-border hover:border-accent/50',
              )}
            >
              <div className="flex items-center gap-2 min-w-0">
                <FiniRollIcon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <p className="font-medium text-sm truncate flex-1">{r.reference || '—'}</p>
                {r.avec_teinture !== 0 ? (
                  <span
                    className="flex items-center flex-shrink-0 text-accent-blue"
                    aria-label={teintureLabel(r.avec_teinture)}
                    title={teintureLabel(r.avec_teinture)}
                  >
                    <Droplet className="h-3.5 w-3.5" />
                    {r.avec_teinture === 2 && <Droplet className="h-3.5 w-3.5 -ml-2" />}
                  </span>
                ) : null}
                {!!r.en_developpement && (
                  <FlaskConical className="h-3.5 w-3.5 text-amber-600 flex-shrink-0" aria-label="En développement" />
                )}
              </div>
              {r.designation && (
                <p className="text-xs text-muted-foreground mt-0.5 truncate">{r.designation}</p>
              )}
              <div className="flex items-center justify-between gap-2 mt-1 text-[11px] text-muted-foreground">
                <span className="truncate">
                  {r.coloris_count} coloris
                </span>
                {r.stock_total_kg > 0 && (
                  <span className="flex-shrink-0 tabular-nums">{fmtNum(r.stock_total_kg, 0)} kg</span>
                )}
              </div>
            </div>
          ))
        )}
      </div>
      <div className="p-3 border-t text-xs text-muted-foreground flex items-center justify-between rounded-b-lg bg-zinc-200/50">
        <span>
          {totalCount} référence{totalCount !== 1 ? 's' : ''}
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
  onPrintDoc,
}: {
  detail: RefFiniDetail | null
  isLoading: boolean
  isEditing: boolean
  draft: HeaderDraft
  onDraftChange: (d: HeaderDraft) => void
  onStartEdit: () => void
  onCancelEdit: () => void
  onSave: () => void
  isSaving: boolean
  onDelete: () => void
  onPrintDoc: (doc: PrintDocKind) => void
}) {
  if (!detail && !isLoading) return null
  return (
    <div className="flex-shrink-0 pt-0.5">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            'h-11 w-11 rounded-lg flex items-center justify-center',
            isEditing ? 'bg-accent/15 text-accent' : 'icon-box-gold',
          )}
        >
          <FiniRollIcon className="h-5 w-5" />
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
              <h1 className="text-2xl font-heading font-bold tracking-tight truncate">
                {detail?.reference || '—'}
              </h1>
              {detail?.designation && (
                <p className="text-sm text-muted-foreground truncate mt-0.5">{detail.designation}</p>
              )}
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
                <DocMenuButton
                  icon={Printer}
                  title="Imprimer"
                  items={[
                    { key: 'technique', label: 'Fiche technique', icon: FileText },
                    { key: 'tarifs', label: 'Fiche tarifs', icon: BadgeEuro },
                    { key: 'etiquette', label: 'Étiquette', icon: Tag },
                  ]}
                  onSelect={onPrintDoc}
                />
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

// ── Print: doc menu + fiche tarifs options dialog ──────

type PrintDocKind = 'technique' | 'tarifs' | 'etiquette'

/** Icon button opening a small popover menu — the print header button uses it
 *  to pick which document to generate. Pattern: DocMenuButton in
 *  ClientsCommandes.tsx / PrintMenuButton in ClientsExpeditions.tsx. */
function DocMenuButton({ icon: TriggerIcon, title, items, onSelect }: {
  icon: ComponentType<{ className?: string }>
  title: string
  items: Array<{ key: PrintDocKind; label: string; icon: ComponentType<{ className?: string }> }>
  onSelect: (key: PrintDocKind) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Click outside to close the menu.
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])

  return (
    <div ref={rootRef} className="relative">
      <Button variant="outline" size="icon" className="h-9 w-9" title={title} onClick={() => setMenuOpen((v) => !v)}>
        <TriggerIcon className="h-4 w-4" />
      </Button>
      {menuOpen && (
        <div className="absolute top-full right-0 mt-1 w-64 rounded-lg border bg-white shadow-lg overflow-hidden z-50">
          {items.map((item) => {
            const ItemIcon = item.icon
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => { onSelect(item.key); setMenuOpen(false) }}
                className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors hover:bg-zinc-100"
              >
                <ItemIcon className="h-4 w-4 text-muted-foreground" />
                {item.label}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

/** §35 toggle row used by the fiche tarifs options dialog. */
function TrancheToggleRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string
  hint: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border border-border/60 bg-white shadow-sm">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs font-semibold">
          <BadgeEuro className="h-3.5 w-3.5 text-accent" />
          <span>{label}</span>
        </div>
        <p className="text-[10px] text-muted-foreground mt-0.5">{hint}</p>
      </div>
      <Pill value={value} onChange={onChange} />
    </div>
  )
}

/** Pre-generation options for the fiche tarifs: which coloris to print, plus
 *  the 15 and 30 rouleaux tranches (each opt-in on top of the standard grid,
 *  which goes up to 10 rouleaux). */
function TarifsPrintDialog({
  open,
  onClose,
  refId,
  coloris,
}: {
  open: boolean
  onClose: () => void
  refId: number | null
  coloris: Coloris[]
}) {
  const [include15, setInclude15] = useState(false)
  const [include30, setInclude30] = useState(false)
  const [selectedColoris, setSelectedColoris] = useState<Set<number>>(new Set())

  // Reset the options every time the dialog opens. Coloris default to all
  // selected, so the plain "open → Générer" path prints what it always did.
  useEffect(() => {
    if (open) {
      setInclude15(false)
      setInclude30(false)
      setSelectedColoris(new Set(coloris.map((c) => c.id)))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, refId])

  if (refId === null) return null

  const allSelected = coloris.length > 0 && selectedColoris.size === coloris.length
  const noneSelected = selectedColoris.size === 0

  const toggleColoris = (id: number) => {
    setSelectedColoris((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const openFicheTarifs = () => {
    const params = new URLSearchParams({
      rlx15: include15 ? '1' : '0',
      rlx30: include30 ? '1' : '0',
    })
    // Omit the param when everything is picked so the default request stays
    // identical to the pre-selection behaviour.
    if (!allSelected) params.set('coloris', [...selectedColoris].join(','))
    window.open(`${API_URL}/references-fini/${refId}/tarifs/pdf?${params.toString()}`, '_blank')
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md max-h-[90dvh] overflow-y-auto" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BadgeEuro className="h-5 w-5 text-accent" />
            Fiche tarifs
          </DialogTitle>
        </DialogHeader>

        <div className="mt-4 space-y-2">
          <div className="rounded-lg border border-border/60 bg-white shadow-sm overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-3 py-2.5 border-b border-border/60">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-xs font-semibold">
                  <Palette className="h-3.5 w-3.5 text-accent" />
                  <span>Coloris à imprimer</span>
                </div>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {coloris.length === 0
                    ? 'Aucun coloris sur cette référence'
                    : noneSelected
                      ? 'Sélectionnez au moins un coloris'
                      : `${selectedColoris.size} / ${coloris.length} coloris sélectionné${selectedColoris.size > 1 ? 's' : ''}`}
                </p>
              </div>
              {coloris.length > 0 && (
                <button
                  type="button"
                  onClick={() =>
                    setSelectedColoris(allSelected ? new Set() : new Set(coloris.map((c) => c.id)))
                  }
                  className="flex-shrink-0 text-xs font-medium text-accent hover:underline"
                >
                  {allSelected ? 'Tout désélectionner' : 'Tout sélectionner'}
                </button>
              )}
            </div>
            {coloris.length > 0 && (
              <div className="max-h-56 overflow-y-auto scrollbar-transparent p-1.5 space-y-0.5">
                {coloris.map((c) => (
                  <label
                    key={c.id}
                    className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm cursor-pointer select-none hover:bg-accent/5"
                  >
                    <input
                      type="checkbox"
                      checked={selectedColoris.has(c.id)}
                      onChange={() => toggleColoris(c.id)}
                      className="h-4 w-4 rounded border-input text-accent focus:ring-2 focus:ring-ring cursor-pointer flex-shrink-0"
                    />
                    <span className="truncate">{c.reference || `#${c.id}`}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <TrancheToggleRow
            label="Inclure la tranche 15 rouleaux"
            hint={include15 ? 'La ligne 15 rouleaux sera imprimée' : 'Ligne 15 rouleaux masquée'}
            value={include15}
            onChange={setInclude15}
          />
          <TrancheToggleRow
            label="Inclure la tranche 30 rouleaux"
            hint={include30 ? 'La ligne 30 rouleaux sera imprimée' : 'Ligne 30 rouleaux masquée'}
            value={include30}
            onChange={setInclude30}
          />
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <Button
            onClick={openFicheTarifs}
            disabled={coloris.length > 0 && noneSelected}
            title={coloris.length > 0 && noneSelected ? 'Sélectionnez au moins un coloris' : undefined}
          >
            <Printer className="h-3.5 w-3.5 mr-1.5" />
            Générer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  ecruOptions,
}: {
  detail: RefFiniDetail | null
  isLoading: boolean
  hasSelection: boolean
  isEditing: boolean
  draft: HeaderDraft
  onDraftChange: (d: HeaderDraft) => void
  onMutationSuccess: () => void
  ecruOptions: EcruRef[]
}) {
  if (!hasSelection) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="icon-box-gold h-16 w-16 mx-auto">
            <FiniRollIcon className="h-8 w-8" />
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
      <SpecsCard detail={detail} isEditing={isEditing} draft={draft} onDraftChange={onDraftChange} ecruOptions={ecruOptions} />
      <ColorisCard detail={detail} isEditing={isEditing} />
      <TraitementsCard detail={detail} isEditing={isEditing} onMutationSuccess={onMutationSuccess} />
      {!isEditing && <StockCard detail={detail} isEditing={isEditing} />}
    </div>
  )
}

// ── Specs Card ─────────────────────────────────────────

/** A spec tile: uppercase caption on top, the value big underneath — the
 *  "instant picture" layout (one figure per tile, six tiles in two rows). */
function SpecTile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border/60 bg-zinc-100/80 px-3 py-2.5 min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold truncate">
        {label}
      </p>
      <div className="mt-1">{children}</div>
    </div>
  )
}

/** Read-mode single figure inside a SpecTile. */
function TileValue({ value, unit }: { value: number | null; unit?: string }) {
  if (value == null) return <span className="text-2xl font-bold text-muted-foreground/60 leading-none">—</span>
  return (
    <span className="text-2xl font-bold tabular-nums leading-none">
      {fmtNum(value, Number.isInteger(value) ? 0 : 2)}
      {unit ? <span className="text-xs text-muted-foreground font-normal ml-1">{unit}</span> : null}
    </span>
  )
}

/** Read-mode min / moy / max inside a SpecTile: the average is the big
 *  figure, the bounds sit under it in small type. */
function TileRange({ min, moy, max, unit }: { min: number | null; moy: number | null; max: number | null; unit?: string }) {
  const fmt = (v: number | null) => (v == null ? '—' : fmtNum(v, Number.isInteger(v) ? 0 : 2))
  const hasBounds = min != null || max != null
  return (
    <div>
      <TileValue value={moy} unit={unit} />
      <p className="mt-1 text-[11px] text-muted-foreground tabular-nums">
        {hasBounds ? (
          <>
            <span className="text-muted-foreground/70">min</span> {fmt(min)}
            <span className="mx-1.5 text-muted-foreground/40">·</span>
            <span className="text-muted-foreground/70">max</span> {fmt(max)}
          </>
        ) : (
          <span className="text-muted-foreground/50">min / max non renseignés</span>
        )}
      </p>
    </div>
  )
}

/** Edit-mode min / moy / max inputs inside a SpecTile. */
function TileRangeInputs({
  min, moy, max, onChange,
}: {
  min: string; moy: string; max: string
  onChange: (next: { min: string; moy: string; max: string }) => void
}) {
  const cell = 'h-8 w-full px-1.5 text-sm text-center tabular-nums rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring'
  return (
    <div className="grid grid-cols-3 gap-1">
      {([['min', min], ['moy', moy], ['max', max]] as const).map(([k, v]) => (
        <div key={k} className="min-w-0">
          <input
            type="number"
            value={v}
            placeholder={k === 'moy' ? 'Moy' : k === 'min' ? 'Min' : 'Max'}
            onChange={(e) => onChange({ min, moy, max, [k]: e.target.value })}
            className={cn(cell, k === 'moy' && 'font-semibold')}
          />
          <p className="mt-0.5 text-[9px] uppercase tracking-wide text-center text-muted-foreground/70">{k}</p>
        </div>
      ))}
    </div>
  )
}

/** Full-width prose tile: caption + multi-line text in view mode, a
 *  textarea in edit mode. Hidden in view mode when the value is empty. */
function TextTile({
  label, value, isEditing, draft, rows, onChange,
}: {
  label: string; value: string | null; isEditing: boolean; draft: string; rows: number; onChange: (v: string) => void
}) {
  if (!isEditing && !value?.trim()) return null
  return (
    <SpecTile label={label}>
      {isEditing ? (
        <textarea
          value={draft}
          onChange={(e) => onChange(e.target.value)}
          rows={rows}
          className="w-full rounded-md border border-input bg-white px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
        />
      ) : (
        <p className="text-sm whitespace-pre-line leading-snug">{value!.trim()}</p>
      )}
    </SpecTile>
  )
}

function SpecsCard({
  detail,
  isEditing,
  draft,
  onDraftChange,
  ecruOptions,
}: {
  detail: RefFiniDetail
  isEditing: boolean
  draft: HeaderDraft
  onDraftChange: (d: HeaderDraft) => void
  ecruOptions: EcruRef[]
}) {
  const dyed = detail.avec_teinture !== 0
  const tileInput = 'h-8 w-full px-2 text-sm tabular-nums rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring'
  return (
    <Card className={cn('card-premium', isEditing && editSectionClass)}>
      <CardHeader className="flex flex-row items-center gap-2 p-4 space-y-0 pb-2">
        <Package className="h-4 w-4 text-accent" />
        <CardTitle className="text-sm font-semibold">Spécifications</CardTitle>
        <Badge
          className={cn(
            'ml-auto text-[10px] py-0 px-1.5 gap-1',
            dyed
              ? 'bg-accent-blue/10 text-accent-blue ring-1 ring-accent-blue/20'
              : 'bg-teal-500/10 text-teal-700 ring-1 ring-teal-500/20',
          )}
        >
          <Droplet className="h-2.5 w-2.5" />
          {teintureLabel(detail.avec_teinture)}
        </Badge>
      </CardHeader>
      <CardContent className="pb-4 space-y-3">
        {isEditing && (
          <LabeledInput
            label="Désignation"
            value={draft.designation}
            onChange={(v) => onDraftChange({ ...draft, designation: v })}
          />
        )}

        {/* Référence écru — the base fabric this fini is made from */}
        <div className="rounded-lg border border-border/60 bg-zinc-100/80 px-3 py-2 flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-amber-400/10">
            <TmRollIcon className="h-4 w-4 text-amber-600" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Référence écru</p>
            {isEditing ? (
              <div className="mt-1">
                <SearchableCombobox<EcruRef>
                  options={ecruOptions}
                  value={draft.IDref_ecru}
                  onChange={(id) => onDraftChange({ ...draft, IDref_ecru: id })}
                  getId={(e) => e.IDref_ecru}
                  getPrimary={(e) => e.reference ?? `#${e.IDref_ecru}`}
                  getSecondary={(e) => e.designation ?? undefined}
                  placeholder="Rechercher une référence écru"
                />
              </div>
            ) : detail.ecru ? (
              <p className="text-sm truncate">
                <span className="font-semibold">{detail.ecru.reference ?? '—'}</span>
                {detail.ecru.designation && (
                  <span className="text-muted-foreground"> — {detail.ecru.designation}</span>
                )}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground italic">Aucune référence écru liée</p>
            )}
          </div>
        </div>

        {/* Row 1 — the three scalar figures */}
        <div className="grid grid-cols-3 gap-2">
          <SpecTile label="Rendement">
            {isEditing ? (
              <input type="number" step="0.01" value={draft.rendement} onChange={(e) => onDraftChange({ ...draft, rendement: e.target.value })} className={tileInput} />
            ) : (
              <TileValue value={detail.rendement} unit="Ml/kg" />
            )}
          </SpecTile>
          <SpecTile label="Freinte">
            {isEditing ? (
              <input type="number" step="0.01" value={draft.freinte} onChange={(e) => onDraftChange({ ...draft, freinte: e.target.value })} className={tileInput} />
            ) : (
              <TileValue value={detail.freinte} />
            )}
          </SpecTile>
          <SpecTile label="Temp. lavage">
            {isEditing ? (
              <input type="number" value={draft.temp_lavage} onChange={(e) => onDraftChange({ ...draft, temp_lavage: e.target.value })} className={tileInput} />
            ) : (
              <TileValue value={detail.temp_lavage} unit="°C" />
            )}
          </SpecTile>
        </div>

        {/* Row 2 — the three min / moy / max ranges */}
        <div className="grid grid-cols-3 gap-2">
          <SpecTile label="Poids">
            {isEditing ? (
              <TileRangeInputs
                min={draft.poids_Min} moy={draft.poids_Moy} max={draft.poids_Max}
                onChange={(n) => onDraftChange({ ...draft, poids_Min: n.min, poids_Moy: n.moy, poids_Max: n.max })}
              />
            ) : (
              <TileRange min={detail.poids_Min} moy={detail.poids_Moy} max={detail.poids_Max} unit="g/m²" />
            )}
          </SpecTile>
          <SpecTile label="Laize hors-tout">
            {isEditing ? (
              <TileRangeInputs
                min={draft.laizeHT_Min} moy={draft.laizeHT_Moy} max={draft.laizeHT_Max}
                onChange={(n) => onDraftChange({ ...draft, laizeHT_Min: n.min, laizeHT_Moy: n.moy, laizeHT_Max: n.max })}
              />
            ) : (
              <TileRange min={detail.laizeHT_Min} moy={detail.laizeHT_Moy} max={detail.laizeHT_Max} unit="cm" />
            )}
          </SpecTile>
          <SpecTile label="Laize utile">
            {isEditing ? (
              <TileRangeInputs
                min={draft.laizeUtile_Min} moy={draft.laizeUtile_Moy} max={draft.laizeUtile_Max}
                onChange={(n) => onDraftChange({ ...draft, laizeUtile_Min: n.min, laizeUtile_Moy: n.moy, laizeUtile_Max: n.max })}
              />
            ) : (
              <TileRange min={detail.laizeUtile_Min} moy={detail.laizeUtile_Moy} max={detail.laizeUtile_Max} unit="cm" />
            )}
          </SpecTile>
        </div>

        {/* Stabilité & élasticité — same tile language, its own thin divider */}
        <div className="flex items-center gap-2 pt-1">
          <Ruler className="h-3.5 w-3.5 text-accent" />
          <span className="text-xs font-semibold text-muted-foreground">Stabilité &amp; élasticité</span>
          <div className="flex-1 h-px bg-border/60" />
        </div>
        <div className="grid grid-cols-4 gap-2">
          <SpecTile label="Stabilité H">
            {isEditing ? (
              <input type="number" step="0.01" value={draft.stab_hauteur} onChange={(e) => onDraftChange({ ...draft, stab_hauteur: e.target.value })} className={tileInput} />
            ) : (
              <TileValue value={detail.stab_hauteur} unit="%" />
            )}
          </SpecTile>
          <SpecTile label="Stabilité L">
            {isEditing ? (
              <input type="number" step="0.01" value={draft.stab_largeur} onChange={(e) => onDraftChange({ ...draft, stab_largeur: e.target.value })} className={tileInput} />
            ) : (
              <TileValue value={detail.stab_largeur} unit="%" />
            )}
          </SpecTile>
          <SpecTile label="Allongement H">
            {isEditing ? (
              <TileRangeInputs
                min={draft.allongementH_Min} moy={draft.allongementH_Moy} max={draft.allongementH_Max}
                onChange={(n) => onDraftChange({ ...draft, allongementH_Min: n.min, allongementH_Moy: n.moy, allongementH_Max: n.max })}
              />
            ) : (
              <TileRange min={detail.allongementH_Min} moy={detail.allongementH_Moy} max={detail.allongementH_Max} unit="%" />
            )}
          </SpecTile>
          <SpecTile label="Allongement L">
            {isEditing ? (
              <TileRangeInputs
                min={draft.allongementL_Min} moy={draft.allongementL_Moy} max={draft.allongementL_Max}
                onChange={(n) => onDraftChange({ ...draft, allongementL_Min: n.min, allongementL_Moy: n.moy, allongementL_Max: n.max })}
              />
            ) : (
              <TileRange min={detail.allongementL_Min} moy={detail.allongementL_Moy} max={detail.allongementL_Max} unit="%" />
            )}
          </SpecTile>
        </div>

        {/* Contrôles à réception — the three sst flags, always all three shown */}
        <SpecTile label="Contrôles à réception (sous-traitant)">
          {isEditing ? (
            <div className="grid grid-cols-3 gap-2">
              {([
                ['controle_sst_rendement', 'Rendement'],
                ['controle_sst_stab', 'Stabilité'],
                ['controle_sst_allongement', 'Allongement'],
              ] as const).map(([k, label]) => (
                <label key={k} className="flex items-center justify-between gap-2 rounded-md border border-border/60 bg-white px-2.5 py-1.5">
                  <span className="text-sm">{label}</span>
                  <Pill value={draft[k]} onChange={(v) => onDraftChange({ ...draft, [k]: v })} />
                </label>
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {([
                [detail.controle_sst_rendement, 'Rendement'],
                [detail.controle_sst_stab, 'Stabilité'],
                [detail.controle_sst_allongement, 'Allongement'],
              ] as const).map(([on, label]) => (
                <span
                  key={label}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
                    on ? 'bg-accent/10 text-accent border-accent/25' : 'bg-transparent text-muted-foreground/60 border-border/60',
                  )}
                >
                  {on ? <CheckCircle2 className="h-3 w-3" /> : <Circle className="h-3 w-3" />}
                  {label}
                </span>
              ))}
            </div>
          )}
        </SpecTile>

        {/* Prose fields — full-width tiles. The legacy texts are multi-line
            (CRLF-separated on every reference), so they are shown line by line
            and edited in textareas. Empty ones are hidden in view mode. */}
        <TextTile label="Conditionnement" value={detail.conditionnement} isEditing={isEditing} draft={draft.conditionnement} rows={3} onChange={(v) => onDraftChange({ ...draft, conditionnement: v })} />
        <TextTile label="Observations (production)" value={detail.observations} isEditing={isEditing} draft={draft.observations} rows={3} onChange={(v) => onDraftChange({ ...draft, observations: v })} />
        <TextTile label="Observation technique" value={detail.observation_technique} isEditing={isEditing} draft={draft.observation_technique} rows={2} onChange={(v) => onDraftChange({ ...draft, observation_technique: v })} />
        <TextTile label="Description commerciale" value={detail.description_commercial} isEditing={isEditing} draft={draft.description_commercial} rows={2} onChange={(v) => onDraftChange({ ...draft, description_commercial: v })} />
      </CardContent>
    </Card>
  )
}

// ── Coloris Card (read-only, polymorphic) ──────────────

function ColorisCard({ detail, isEditing }: { detail: RefFiniDetail; isEditing: boolean }) {
  const [open, setOpen] = useState(false)
  const dyed = detail.coloris_mode === 'dye'
  return (
    <Card className={cn('card-premium', isEditing && editSectionClass)}>
      <CardHeader
        className="flex flex-row items-center gap-2 p-4 space-y-0 pb-2 cursor-pointer select-none"
        onClick={() => setOpen(!open)}
      >
        <Palette className="h-4 w-4 text-accent" />
        <CardTitle className="text-sm font-semibold">Coloris</CardTitle>
        <Badge
          className={cn(
            'text-[10px] py-0 px-1.5 ml-auto',
            dyed
              ? 'bg-accent-blue/10 text-accent-blue ring-1 ring-accent-blue/20'
              : 'bg-teal-500/10 text-teal-700 ring-1 ring-teal-500/20',
          )}
        >
          {dyed ? 'Teinture' : 'Écru'}
        </Badge>
        <Badge variant="secondary" className="text-xs">
          {detail.coloris.length}
        </Badge>
        <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </CardHeader>
      {open && (
        <CardContent className="space-y-2 pb-3">
          {detail.coloris.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">Aucun coloris</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {detail.coloris.map((c) => (
                <Badge
                  key={c.id}
                  variant="secondary"
                  className="text-[11px] py-0.5 px-2 gap-1 font-normal"
                >
                  <Palette className="h-2.5 w-2.5 text-muted-foreground" />
                  {c.reference ?? '—'}
                </Badge>
              ))}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground/70 italic flex items-center gap-1.5 pt-1">
            <Lock className="h-3 w-3" />
            Les coloris se gèrent dans Finis › Études coloris.
          </p>
        </CardContent>
      )}
    </Card>
  )
}

// ── Traitements Card ───────────────────────────────────
// The treatments attached to a reference (`traitement_ref_fini`, a strict set).
// Read-only badges in view mode; in edit mode each badge gets a remove button
// and a picker adds one — both persist immediately, like the Tarifs screen's
// treatment list (LIVA #1136: the card shipped read-only, with no way to add).

interface TraitementLookup {
  IDtraitement: number
  designation: string | null
  ordre: number
}

function TraitementsCard({
  detail, isEditing, onMutationSuccess,
}: {
  detail: RefFiniDetail; isEditing: boolean; onMutationSuccess: () => void
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Traitement | null>(null)
  const [addError, setAddError] = useState<string | null>(null)

  // The add picker lives inside the collapsed body — unfold it when editing
  // starts so the affordance is visible without a second click.
  useEffect(() => {
    if (isEditing) setOpen(true)
  }, [isEditing])

  const { data: catalog } = useQuery<TraitementLookup[]>({
    queryKey: ['ref-fini-lookup-traitements'],
    queryFn: () => apiFetch('/references-fini/lookups/traitements'),
    enabled: isEditing,
    staleTime: 5 * 60_000,
  })

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['ref-fini', detail.IDref_fini] })
    onMutationSuccess()
  }, [queryClient, detail.IDref_fini, onMutationSuccess])

  const addMut = useMutation({
    mutationFn: (IDtraitement: number) =>
      apiFetch(`/references-fini/${detail.IDref_fini}/traitements`, {
        method: 'POST',
        body: JSON.stringify({ IDtraitement }),
      }),
    onMutate: () => setAddError(null),
    onSuccess: invalidate,
    onError: (err: Error & { status?: number }) => {
      setAddError(
        err.status === 409
          ? 'Ce traitement est déjà associé à la référence.'
          : "Impossible d'ajouter ce traitement.",
      )
    },
  })
  const deleteMut = useMutation({
    mutationFn: (IDtraitement: number) =>
      apiFetch(`/references-fini/${detail.IDref_fini}/traitements/${IDtraitement}`, { method: 'DELETE' }),
    onSuccess: () => { invalidate(); setDeleteTarget(null) },
  })

  // Only offer what is not attached yet — the junction is a set.
  const attached = useMemo(() => new Set(detail.traitements.map((t) => t.IDtraitement)), [detail.traitements])
  const options = useMemo(
    () => (catalog ?? [])
      .filter((t) => !attached.has(t.IDtraitement))
      .map((t) => ({ id: t.IDtraitement, primary: t.designation ?? `#${t.IDtraitement}` })),
    [catalog, attached],
  )

  return (
    <>
      <Card className={cn('card-premium', isEditing && editSectionClass)}>
        <CardHeader
          className="flex flex-row items-center gap-2 p-4 space-y-0 pb-2 cursor-pointer select-none"
          onClick={() => setOpen(!open)}
        >
          <Droplets className="h-4 w-4 text-accent" />
          <CardTitle className="text-sm font-semibold">Traitements</CardTitle>
          <Badge variant="secondary" className="text-xs ml-auto">
            {detail.traitements.length}
          </Badge>
          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </CardHeader>
        {open && (
          <CardContent className="pb-3 space-y-2">
            {detail.traitements.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">Aucun traitement</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {detail.traitements.map((t) =>
                  isEditing ? (
                    <Badge
                      key={t.IDtraitement}
                      className="bg-accent/10 text-accent hover:bg-accent/20 border-accent/20 gap-1"
                    >
                      {t.designation ?? `#${t.IDtraitement}`}
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(t)}
                        className="ml-0.5 rounded-full hover:bg-destructive/20 hover:text-destructive p-0.5 -mr-1 transition-colors"
                        title="Retirer ce traitement"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ) : (
                    <Badge key={t.IDtraitement} variant="secondary" className="text-[11px] py-0.5 px-2 gap-1 font-normal">
                      <Droplets className="h-2.5 w-2.5 text-muted-foreground" />
                      {t.designation ?? '—'}
                    </Badge>
                  ),
                )}
              </div>
            )}
            {isEditing && (
              <div className="pt-1 flex items-center gap-2 flex-wrap">
                <PopoverSelect
                  size="sm"
                  value={0}
                  onChange={(id) => { if (id > 0) addMut.mutate(id) }}
                  emptyLabel="+ Ajouter un traitement"
                  options={options}
                  disabled={addMut.isPending || (catalog !== undefined && options.length === 0)}
                  disabledTitle={options.length === 0 ? 'Tous les traitements sont déjà associés' : undefined}
                />
                {addMut.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />}
                {addError && (
                  <span className="text-[11px] text-destructive flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" />{addError}
                  </span>
                )}
              </div>
            )}
          </CardContent>
        )}
      </Card>
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Retirer le traitement"
        description={deleteTarget ? `« ${deleteTarget.designation ?? `#${deleteTarget.IDtraitement}`} » ne sera plus appliqué à cette référence.` : undefined}
        confirmLabel="Retirer"
        isPending={deleteMut.isPending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => { if (deleteTarget) deleteMut.mutate(deleteTarget.IDtraitement) }}
      />
    </>
  )
}

// ── Stock Card (read-only aggregate) ───────────────────

function StockCard({ detail, isEditing }: { detail: RefFiniDetail; isEditing: boolean }) {
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
            <div className="space-y-3">
              <div className="flex flex-wrap items-baseline gap-x-10 gap-y-2">
                <div className="flex items-baseline gap-2">
                  <span className="text-xs text-muted-foreground">Total poids</span>
                  <span className="text-lg font-semibold tabular-nums">{fmtNum(detail.stock_total_kg, 1)} kg</span>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="text-xs text-muted-foreground">Total métrage</span>
                  <span className="text-lg font-semibold tabular-nums">{fmtNum(detail.stock_total_m, 1)} Ml</span>
                </div>
              </div>
              {detail.reference && (
                <a
                  href={`/finis/stock?q=${encodeURIComponent(detail.reference)}`}
                  className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline"
                >
                  <Warehouse className="h-3.5 w-3.5" />
                  Voir les lots dans Stock Finis
                </a>
              )}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}

// ── Right Panel: Sidebar ───────────────────────────────

type SidebarTab = 'informations' | 'tarif'

// ── Clients card — who has already ordered this reference (LIVA #1155) ──

interface RefFiniClientRow {
  IDclient: number
  nom: string
  nb_commandes: number
  nb_lignes: number
  metrage: number
  poids: number
  derniere_date: string | null
  dernier_numero: number | null
}

/** Informations-tab card listing the ETM clients that ordered the reference,
 *  biggest volume first — the memory aid Isabelle had on the legacy fiche. Read
 *  only; lazily loaded per reference. */
function ClientsCard({ refId }: { refId: number }) {
  const { data, isLoading, isError } = useQuery<RefFiniClientRow[]>({
    queryKey: ['ref-fini-clients', refId],
    queryFn: () => apiFetch(`/references-fini/${refId}/clients`),
  })
  const rows = data ?? []
  return (
    <div className="p-3 rounded-lg border bg-card shadow-sm space-y-2">
      <div className="flex items-center gap-1.5">
        <Users className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-xs font-semibold text-muted-foreground">Clients</p>
        {rows.length > 0 && (
          <Badge variant="secondary" className="text-[10px] py-0 ml-auto tabular-nums">{rows.length}</Badge>
        )}
      </div>
      {isLoading ? (
        <div className="flex justify-center py-2">
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
        </div>
      ) : isError ? (
        <p className="text-xs text-destructive">Erreur de chargement</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">Aucun client n'a encore commandé cette référence</p>
      ) : (
        <div className="divide-y divide-border/50">
          {rows.map((c) => {
            const qty = [
              c.metrage > 0 ? `${fmtNum(c.metrage, 1)} Ml` : null,
              c.poids > 0 ? `${fmtNum(c.poids, 1)} Kg` : null,
            ].filter(Boolean).join(' · ')
            const last = c.derniere_date ? formatHfsqlDate(c.derniere_date) : null
            return (
              <div key={c.IDclient} className="py-1.5 first:pt-0 last:pb-0">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium truncate">{c.nom}</span>
                  <span className="text-xs tabular-nums text-muted-foreground flex-shrink-0">{qty || '—'}</span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {c.nb_commandes} commande{c.nb_commandes > 1 ? 's' : ''}
                  {c.dernier_numero != null && (
                    <>
                      {' · dernière '}
                      <span className="tabular-nums">N°{c.dernier_numero}</span>
                      {last && <> le <span className="tabular-nums">{last}</span></>}
                    </>
                  )}
                </p>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Tarif (cost-price) tab — port of the legacy FI_Tarifs / PrixDeVenteV4 ──

interface TarifDetailLine {
  label: string
  valueKg: number
}

interface TarifTranche {
  rolls: number
  isMetrage: boolean
  qte_ml: number
  poids_ref: number
  moFil: number
  detailFil: TarifDetailLine[]
  moTricotage: number
  detailTricotage: TarifDetailLine | null
  moTraitements: number
  detailTraitement: TarifDetailLine[]
  moTeinte: number
  detailTeinture: TarifDetailLine | null
  moRevient: number
  rCoeff: number
  tauxFraisDePort: number
  moPortAuKg: number
  moPortAuMl: number
  moPrixDeVenteAuKg: number
  moPrixDeVenteAuMl: number
}

interface TarifResult {
  IDref_fini: number
  IDcoloris: number
  avec_teinture: number
  rendement: number
  ref_ecru: { IDref_ecru: number; reference: string | null; poids: number; prix: number } | null
  tranches: TarifTranche[]
}

/** Gold-banded cost-component header with its €/Kg total, mirroring the legacy
 *  orange section bars. */
function CostSection({ title, total, children }: { title: string; total?: string; children?: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md bg-gold/15 border border-gold/25">
        <span className="text-xs font-semibold uppercase tracking-wide text-accent">{title}</span>
        {total != null && <span className="text-xs font-bold tabular-nums text-accent">{total}</span>}
      </div>
      {children && <div className="px-2.5 space-y-1">{children}</div>}
    </div>
  )
}

/** One sub-line under a cost section: descriptive label left, €/Kg value right. */
function CostLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-2 text-[11px] leading-snug">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground/80 flex-shrink-0 whitespace-nowrap">{value}</span>
    </div>
  )
}

/** Tarif tab: a coloris selector, a volume-tier grid (€/Ml per order quantity),
 *  and the full cost-price breakdown for the selected tier. Read-only. */
function TarifTab({ detail }: { detail: RefFiniDetail }) {
  const [colorisId, setColorisId] = useState<number>(detail.coloris[0]?.id ?? 0)
  const [selectedTranche, setSelectedTranche] = useState(0)

  const { data, isLoading, isError } = useQuery<TarifResult>({
    queryKey: ['ref-fini-tarif', detail.IDref_fini, colorisId],
    queryFn: () => apiFetch(`/references-fini/${detail.IDref_fini}/tarif?coloris=${colorisId}`),
    enabled: colorisId > 0,
  })

  const tranches = data?.tranches ?? []
  const current = tranches[Math.min(selectedTranche, Math.max(tranches.length - 1, 0))] ?? null
  const eurKg = (v: number) => `${fmtNum(v, 2)} €/Kg`

  return (
    <div className="space-y-3">
      {/* Coloris selector */}
      <div className="p-3 rounded-lg border bg-card shadow-sm space-y-2">
        <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
          <Palette className="h-3.5 w-3.5" />
          Coloris
        </p>
        {detail.coloris.length > 0 ? (
          <SearchableCombobox<Coloris>
            options={detail.coloris}
            value={colorisId}
            onChange={(id) => {
              setColorisId(id)
              setSelectedTranche(0)
            }}
            getId={(c) => c.id}
            getPrimary={(c) => c.reference ?? `#${c.id}`}
            placeholder="Rechercher un coloris"
          />
        ) : (
          <p className="text-sm text-muted-foreground italic">Aucun coloris</p>
        )}
      </div>

      {colorisId <= 0 ? (
        <p className="text-sm text-muted-foreground italic px-1">
          Sélectionnez un coloris pour calculer le tarif.
        </p>
      ) : isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-accent" />
        </div>
      ) : isError ? (
        <p className="text-sm text-destructive px-1">Erreur lors du calcul du tarif.</p>
      ) : tranches.length === 0 ? (
        <p className="text-sm text-muted-foreground italic px-1">
          {data && !(data.rendement > 0)
            ? 'Rendement non défini sur la référence — tarif indisponible.'
            : data && !data.ref_ecru
              ? 'Aucune référence écru liée — tarif indisponible.'
              : 'Tarif indisponible pour ce coloris.'}
        </p>
      ) : (
        <>
          {/* Volume-tier grid */}
          <div className="rounded-lg border border-border/60 overflow-hidden bg-card shadow-sm">
            <table className="w-full text-xs" style={{ tableLayout: 'fixed' }}>
              <colgroup>
                <col style={{ width: '26%' }} />
                <col style={{ width: '34%' }} />
                <col style={{ width: '40%' }} />
              </colgroup>
              <thead className="bg-zinc-100/80 border-b border-border/60 text-[10px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-2 py-1.5 text-left font-semibold">Qté (Rlx)</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Qté (Ml)</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Prix / Ml</th>
                </tr>
              </thead>
              <tbody>
                {tranches.map((t, i) => (
                  <tr
                    key={i}
                    onClick={() => setSelectedTranche(i)}
                    className={cn(
                      'border-b border-border/40 last:border-b-0 cursor-pointer transition-colors',
                      selectedTranche === i ? 'bg-accent/10' : 'hover:bg-accent/5',
                    )}
                  >
                    <td className="px-2 py-1.5 tabular-nums">{t.isMetrage ? '< 1' : t.rolls}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {t.isMetrage ? '< ' : ''}
                      {fmtNum(t.qte_ml)}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums font-medium">
                      {fmtNum(t.moPrixDeVenteAuMl, 2)} €
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Cost breakdown for the selected tranche */}
          {current && (
            <div className="p-3 rounded-lg border bg-card shadow-sm space-y-2.5">
              <CostSection title="Fil" total={eurKg(current.moFil)}>
                {current.detailFil.map((l, i) => (
                  <CostLine key={i} label={l.label} value={eurKg(l.valueKg)} />
                ))}
              </CostSection>

              <CostSection title="Tricotage" total={eurKg(current.moTricotage)}>
                {current.detailTricotage && (
                  <CostLine label={current.detailTricotage.label} value={eurKg(current.detailTricotage.valueKg)} />
                )}
              </CostSection>

              <CostSection title="Traitement" total={eurKg(current.moTraitements)}>
                {current.detailTraitement.length > 0 ? (
                  current.detailTraitement.map((l, i) => (
                    <CostLine key={i} label={l.label} value={eurKg(l.valueKg)} />
                  ))
                ) : (
                  <p className="text-[11px] text-muted-foreground italic">Aucun traitement</p>
                )}
              </CostSection>

              {detail.avec_teinture !== 0 && (
                <CostSection title="Teinture" total={eurKg(current.moTeinte)}>
                  {current.detailTeinture && (
                    <CostLine label={current.detailTeinture.label} value={eurKg(current.detailTeinture.valueKg)} />
                  )}
                </CostSection>
              )}

              <CostSection title="Prix de vente">
                <CostLine label="Prix de revient au Kg" value={eurKg(current.moRevient)} />
                <CostLine label="Coefficient" value={String(Math.round(current.rCoeff * 100))} />
                <CostLine
                  label={`Prix de vente au Kg · ${fmtNum(current.moPortAuKg, 2)} € de frais (${Math.round(
                    current.tauxFraisDePort * 100,
                  )}%) de port inclus`}
                  value={`${fmtNum(current.moPrixDeVenteAuKg, 2)} €/Kg`}
                />
                <CostLine
                  label={`Prix de vente au Ml · ${fmtNum(current.moPortAuMl, 2)} € de frais (${Math.round(
                    current.tauxFraisDePort * 100,
                  )}%) de port inclus`}
                  value={`${fmtNum(current.moPrixDeVenteAuMl, 2)} €/Ml`}
                />
              </CostSection>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function DetailSidebar({
  detail,
  isEditing,
  draft,
  onDraftChange,
}: {
  detail: RefFiniDetail | null
  isEditing: boolean
  draft: HeaderDraft
  onDraftChange: (d: HeaderDraft) => void
}) {
  const [activeTab, setActiveTab] = useState<SidebarTab>('informations')
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
        {([
          { key: 'informations', label: 'Informations', icon: Info },
          { key: 'tarif', label: 'Tarif', icon: BadgeEuro },
        ] as { key: SidebarTab; label: string; icon: React.ElementType }[]).map((tab) => {
          const Icon = tab.icon
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md transition-colors',
                activeTab === tab.key
                  ? 'bg-accent text-accent-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-accent/10',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          )
        })}
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-transparent">
        {activeTab === 'tarif' && <TarifTab key={detail.IDref_fini} detail={detail} />}
        {activeTab === 'informations' && (
        <div className="space-y-3">
        {!isEditing && (
          <div className="p-3 rounded-lg border bg-card shadow-sm space-y-2">
            <p className="text-xs font-semibold text-muted-foreground">Statistiques</p>
            <KV label="Coloris" value={<span className="tabular-nums">{detail.coloris.length}</span>} />
            <KV label="Traitements" value={<span className="tabular-nums">{detail.traitements.length}</span>} />
            <KV label="Stock actuel" value={<span className="tabular-nums">{fmtNum(detail.stock_total_kg, 1)} kg</span>} />
            <KV label="Lots en stock" value={<span className="tabular-nums">{detail.stock_lots}</span>} />
          </div>
        )}

        {/* Métadonnées */}
        <div className={cn('p-3 rounded-lg border bg-card shadow-sm space-y-2', isEditing && editSectionClass)}>
          <p className="text-xs font-semibold text-muted-foreground">Métadonnées</p>
          <KV label="Teinture" value={teintureLabel(detail.avec_teinture)} />
          <KV
            label="Responsable"
            value={
              isEditing ? (
                <input
                  type="text"
                  value={draft.responsable}
                  onChange={(e) => onDraftChange({ ...draft, responsable: e.target.value })}
                  className="h-7 px-2 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring text-right w-[200px]"
                />
              ) : (
                detail.responsable?.trim() || '—'
              )
            }
          />
          <KV
            label="Créée le"
            value={detail.date_creation ? formatHfsqlDate(detail.date_creation) : '—'}
          />
          <KV
            label="Modifiée le"
            value={detail.date_modification ? formatHfsqlDate(detail.date_modification) : '—'}
          />
          <div className="flex items-center justify-between gap-2 pt-1">
            <span className="text-xs text-muted-foreground flex items-center gap-1.5">
              <FlaskConical className="h-3.5 w-3.5" />
              En développement
            </span>
            {isEditing ? (
              <Pill value={draft.en_developpement} onChange={(v) => onDraftChange({ ...draft, en_developpement: v })} />
            ) : (
              <span className="text-sm">{detail.en_developpement ? 'Oui' : 'Non'}</span>
            )}
          </div>
          {(!!detail.catalogue_prive || !!detail.archive) && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {!!detail.catalogue_prive && (
                <Badge variant="secondary" className="text-[10px] py-0 gap-1">
                  <Lock className="h-2.5 w-2.5" />
                  Catalogue privé
                </Badge>
              )}
              {!!detail.archive && (
                <Badge variant="outline" className="text-[10px] py-0 gap-1 text-muted-foreground">
                  <Archive className="h-2.5 w-2.5" />
                  Archivée
                </Badge>
              )}
            </div>
          )}
        </div>

        {/* Clients ayant commandé la référence (#1155) — read-only, view mode */}
        {!isEditing && <ClientsCard refId={detail.IDref_fini} />}
        </div>
        )}
      </div>
    </div>
  )
}
