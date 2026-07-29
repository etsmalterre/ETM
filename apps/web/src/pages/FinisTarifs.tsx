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
  BadgeEuro,
  Droplet,
  Ruler,
  Sparkles,
  MessageSquare,
  Copy,
  FileInput,
  FilePlus2,
  Archive,
  ArchiveRestore,
  CheckCircle2,
  Calculator,
  Clock,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PopoverSelect, SearchableCombobox } from '@/components/ui/popover-select'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { UnsavedChangesDialog } from '@/components/shared/UnsavedChangesDialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'
import { BobineIcon } from '@/components/icons/BobineIcon'
import { FiniRollIcon } from '@/components/icons/FiniRollIcon'
import { cn } from '@/lib/utils'
import { apiFetch } from '@/lib/api'
import { fmtNum } from '@/lib/format'

// Finis › Tarifs — the price SIMULATOR (legacy `FI_Tarifs.wdw`).
//
// A simulation (`ref_tarif`) is a costing sandbox: the user types the physical
// parameters, picks a yarn composition and a treatment list, and reads the
// resulting sale price across nine order-quantity tranches. Nothing feeds the
// real catalog — which is why the screen lets you tweak everything, including
// each yarn's €/Kg, without touching `ref_fil`.
//
// Layout: "Fiche" (§4 MasterDetailLayout).
//   left    simulations, En cours / Archivées filter
//   center  composition · paramètres · ennoblissement · commentaire
//   right   Tarif (9 tranches + cost breakdown) / Simulation libre, plus the
//           §29 status footer pill
//
// While editing, the right panel prices the UNSAVED draft through
// `POST /tarifs-fini/:id/preview` — the numbers move as you drag the freinte
// around, which is the whole point. Composition and treatment edits persist
// immediately (same model as the FilsGestion contacts/adresses sub-forms).

// ── Types ──────────────────────────────────────────────

type StatusFilter = 'en_cours' | 'archive' | 'tous'
type PortMode = 'pct' | 'kg'
type TeintureMode = 'sans' | 'simple' | 'double'
type SidebarTab = 'tarif' | 'simulation'

interface TarifListRow {
  IDref_tarif: number
  reference: string | null
  ok_tarif: number
  IDteinture: number
  teinture_mode: TeintureMode
  teinture_shade: string | null
  laize: number
  poids: number
  rendement: number
  fils_count: number
}

interface TarifFil {
  IDasso_fil_tarif: number
  IDref_fil: number
  ref_label: string | null
  IDcolori_fil: number
  colori_label: string | null
  pourcentage: number
  prix: number
}

interface TarifTraitement {
  IDasso_traitement_tarif: number
  IDtraitement: number
  designation: string | null
}

interface TarifDetail {
  IDref_tarif: number
  reference: string
  commentaire: string
  laize: number
  poids: number
  rendement: number
  freinte: number
  prix_tricotage: number
  poids_rouleau: number
  port_mode: PortMode
  port_fixe: number
  port_pct: number
  multiplicateur: number
  IDteinture: number
  ok_tarif: number
  fils: TarifFil[]
  traitements: TarifTraitement[]
}

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
  IDref_tarif: number
  rendement: number
  rendement_calcul: number
  tranches: TarifTranche[]
  libre: TarifTranche | null
  blockers: string[]
}

interface FilLookup {
  IDref_fil: number
  reference: string | null
  prix_kg: number
  coloris: Array<{ id: number; reference: string | null; prix_kg: number }>
}

interface TraitementLookup {
  IDtraitement: number
  designation: string | null
  ordre: number
}

interface TeintureLookup {
  IDteinture: number
  designation_interne: string | null
  designation_externe: string | null
  simple_teinture: number
}

interface RefFinieLookup {
  IDref_fini: number
  reference: string | null
  designation: string | null
}

/** Everything the user can change on the header/parameters form. Kept as
 *  strings so half-typed numbers ("0.", "-") don't fight the input. */
interface ParamsDraft {
  reference: string
  commentaire: string
  laize: string
  poids: string
  rendement: string
  /** Percentage points — the API stores a 0..1 ratio. */
  freinte: string
  prix_tricotage: string
  poids_rouleau: string
  port_mode: PortMode
  port_fixe: string
  port_pct: string
  /** Percentage points — the API stores a 0..1 ratio. */
  multiplicateur: string
  IDteinture: number
}

// ── Helpers ────────────────────────────────────────────

const inputClass =
  'w-full h-8 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring'
const editSectionClass = 'border-l-4 border-l-accent/70 bg-accent/[0.03]'

/** Parse a user-typed number, tolerating the French comma. NaN → 0. */
function parseNum(v: string): number {
  const n = Number(String(v).replace(',', '.').trim())
  return Number.isFinite(n) ? n : 0
}

/** Render a number for an edit input: French decimal comma, no thousand
 *  separators, no trailing zeros — the value the user reads is the value they
 *  can retype (`parseNum` accepts both separators either way). */
function numToInput(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return ''
  return String(Math.round(v * 10000) / 10000).replace('.', ',')
}

function draftFromDetail(d: TarifDetail): ParamsDraft {
  return {
    reference: d.reference ?? '',
    commentaire: d.commentaire ?? '',
    laize: numToInput(d.laize),
    poids: numToInput(d.poids),
    rendement: numToInput(d.rendement),
    freinte: numToInput(Math.round(d.freinte * 10000) / 100),
    prix_tricotage: numToInput(d.prix_tricotage),
    poids_rouleau: numToInput(d.poids_rouleau),
    port_mode: d.port_mode,
    port_fixe: numToInput(d.port_fixe),
    port_pct: numToInput(d.port_pct),
    multiplicateur: numToInput(Math.round(d.multiplicateur * 10000) / 100),
    IDteinture: d.IDteinture,
  }
}

/** The parameter subset the pricing preview needs, derived from the draft. */
function previewParams(draft: ParamsDraft) {
  return {
    rendement: parseNum(draft.rendement),
    poids_rouleau: parseNum(draft.poids_rouleau),
    prix_tricotage: parseNum(draft.prix_tricotage),
    port_mode: draft.port_mode,
    port_fixe: parseNum(draft.port_fixe),
    port_pct: parseNum(draft.port_pct),
    multiplicateur: parseNum(draft.multiplicateur) / 100,
    IDteinture: draft.IDteinture,
  }
}

/** Debounce a value. The live preview hits HFSQL, which is shared with the
 *  legacy WinDev app — one request per keystroke is not acceptable. */
function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

/** Resolve (mode, shade) from a stored IDteinture using the dye catalog. */
function teintureModeOf(IDteinture: number, teintures: TeintureLookup[]): { mode: TeintureMode; shade: string } {
  const t = teintures.find((x) => x.IDteinture === IDteinture)
  if (!t) return { mode: 'sans', shade: 'Tous Coloris' }
  return {
    mode: t.simple_teinture === 1 ? 'simple' : 'double',
    shade: t.designation_interne ?? 'Tous Coloris',
  }
}

/** Inverse of `teintureModeOf`. Falls back to the first dye of the requested
 *  level when the exact shade is missing from the catalog. */
function teintureIdFor(mode: TeintureMode, shade: string, teintures: TeintureLookup[]): number {
  if (mode === 'sans') return 0
  const wantSimple = mode === 'simple' ? 1 : 0
  const sameLevel = teintures.filter((t) => t.simple_teinture === wantSimple)
  const exact = sameLevel.find((t) => (t.designation_interne ?? '') === shade)
  return (exact ?? sameLevel[0])?.IDteinture ?? 0
}

const TEINTURE_MODE_LABEL: Record<TeintureMode, string> = {
  sans: 'Sans teinture',
  simple: 'Simple teinture',
  double: 'Double teinture',
}

// ── Queries ────────────────────────────────────────────

function useTarifs() {
  return useQuery<TarifListRow[]>({ queryKey: ['tarifs-fini'], queryFn: () => apiFetch('/tarifs-fini') })
}

function useTarifDetail(id: number | null) {
  return useQuery<TarifDetail>({
    queryKey: ['tarif-fini', id],
    queryFn: () => apiFetch(`/tarifs-fini/${id}`),
    enabled: id !== null,
  })
}

function useFilsLookup() {
  return useQuery<FilLookup[]>({
    queryKey: ['tarif-fini-lookup-fils'],
    queryFn: () => apiFetch('/tarifs-fini/lookups/fils'),
    staleTime: 5 * 60 * 1000,
  })
}

function useTraitementsLookup() {
  return useQuery<TraitementLookup[]>({
    queryKey: ['tarif-fini-lookup-traitements'],
    queryFn: () => apiFetch('/tarifs-fini/lookups/traitements'),
    staleTime: 5 * 60 * 1000,
  })
}

function useTeinturesLookup() {
  return useQuery<TeintureLookup[]>({
    queryKey: ['tarif-fini-lookup-teintures'],
    queryFn: () => apiFetch('/tarifs-fini/lookups/teintures'),
    staleTime: 5 * 60 * 1000,
  })
}

// ── Main Page ──────────────────────────────────────────

export function FinisTarifs() {
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('en_cours')
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState<ParamsDraft | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [autoEditForId, setAutoEditForId] = useState<number | null>(null)
  const [subFormsDirty, setSubFormsDirty] = useState(false)

  const originalDraftRef = useRef<ParamsDraft | null>(null)

  const { data: tarifs, isLoading, isError, error } = useTarifs()
  const { data: detail, isLoading: detailLoading } = useTarifDetail(selectedId)
  const { data: teintures } = useTeinturesLookup()

  const filtered = useMemo(() => {
    if (!tarifs) return []
    let rows = tarifs
    if (statusFilter === 'en_cours') rows = rows.filter((t) => t.ok_tarif !== 1)
    else if (statusFilter === 'archive') rows = rows.filter((t) => t.ok_tarif === 1)
    const q = searchQuery.trim().toLowerCase()
    if (q) rows = rows.filter((t) => (t.reference ?? '').toLowerCase().includes(q))
    return rows
  }, [tarifs, searchQuery, statusFilter])

  // Keep the selection valid against the search/status-filtered list.
  useAutoSelectFirst({
    rows: filtered,
    selectedId,
    getId: (t) => t.IDref_tarif,
    select: setSelectedId,
    suspended: isEditing || autoEditForId !== null,
  })

  const startEdit = useCallback(() => {
    if (!detail) return
    const snapshot = draftFromDetail(detail)
    setDraft(snapshot)
    originalDraftRef.current = snapshot
    setIsEditing(true)
  }, [detail])

  const cancelEdit = useCallback(() => {
    setIsEditing(false)
    setDraft(null)
  }, [])

  // Freshly-created simulations open straight in edit mode (§25.1).
  useEffect(() => {
    if (autoEditForId !== null && detail?.IDref_tarif === autoEditForId) {
      startEdit()
      setAutoEditForId(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEditForId, detail])

  const isDirty = useMemo(() => {
    if (!isEditing) return false
    const o = originalDraftRef.current
    if (!o || !draft) return false
    if (subFormsDirty) return true
    return (Object.keys(o) as Array<keyof ParamsDraft>).some((k) => o[k] !== draft[k])
  }, [isEditing, draft, subFormsDirty])

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['tarifs-fini'] })
    queryClient.invalidateQueries({ queryKey: ['tarif-fini', selectedId] })
    queryClient.invalidateQueries({ queryKey: ['tarif-fini-calc', selectedId] })
  }, [queryClient, selectedId])

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!draft) throw new Error('Aucune modification à enregistrer')
      return apiFetch(`/tarifs-fini/${selectedId}`, {
        method: 'PUT',
        body: JSON.stringify({
          reference: draft.reference.trim() || 'Simulation',
          commentaire: draft.commentaire,
          laize: parseNum(draft.laize),
          poids: parseNum(draft.poids),
          rendement: parseNum(draft.rendement),
          freinte: parseNum(draft.freinte) / 100,
          prix_tricotage: parseNum(draft.prix_tricotage),
          poids_rouleau: parseNum(draft.poids_rouleau),
          port_mode: draft.port_mode,
          port_fixe: parseNum(draft.port_fixe),
          port_pct: parseNum(draft.port_pct),
          multiplicateur: parseNum(draft.multiplicateur) / 100,
          IDteinture: draft.IDteinture,
        }),
      })
    },
    onSuccess: () => {
      invalidateAll()
      setIsEditing(false)
      setDraft(null)
    },
  })

  const archiveMutation = useMutation({
    mutationFn: (ok: number) =>
      apiFetch(`/tarifs-fini/${selectedId}/archive`, { method: 'PATCH', body: JSON.stringify({ ok_tarif: ok }) }),
    onSuccess: () => invalidateAll(),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/tarifs-fini/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, deletedId) => {
      // Read the cache BEFORE invalidating so the next selection isn't computed
      // from the stale-while-revalidate list still holding the deleted row (§25.2).
      const cached = queryClient.getQueryData<TarifListRow[]>(['tarifs-fini']) ?? []
      const remaining = cached
        .filter((t) => t.IDref_tarif !== deletedId)
        .filter((t) =>
          statusFilter === 'en_cours' ? t.ok_tarif !== 1 : statusFilter === 'archive' ? t.ok_tarif === 1 : true,
        )
      queryClient.invalidateQueries({ queryKey: ['tarifs-fini'] })
      setDeleteOpen(false)
      setSelectedId(remaining.length > 0 ? remaining[0].IDref_tarif : null)
    },
  })

  const guard = useUnsavedGuard({
    isDirty,
    save: async () => { await saveMutation.mutateAsync() },
    onDiscard: cancelEdit,
  })

  const handleSelect = useCallback((id: number) => {
    guard.guardAction(() => {
      cancelEdit()
      setSelectedId(id)
    })
  }, [guard, cancelEdit])

  // In edit mode the right panel prices the draft; otherwise the saved row.
  const effectiveParams = useMemo(() => {
    if (isEditing && draft) return previewParams(draft)
    if (detail) return previewParams(draftFromDetail(detail))
    return null
  }, [isEditing, draft, detail])

  return (
    <>
      <MasterDetailLayout
        list={
          <TarifList
            tarifs={filtered}
            isLoading={isLoading}
            isError={isError}
            error={error as Error | null}
            selectedId={selectedId}
            onSelect={handleSelect}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            onNew={() => setCreateOpen(true)}
            isEditing={isEditing}
          />
        }
        detailHeader={
          <DetailHeader
            detail={detail ?? null}
            isLoading={detailLoading && selectedId !== null}
            isEditing={isEditing}
            reference={draft?.reference ?? ''}
            onReferenceChange={(v) => setDraft((d) => (d ? { ...d, reference: v } : d))}
            onStartEdit={startEdit}
            onCancelEdit={cancelEdit}
            onSave={() => saveMutation.mutate()}
            isSaving={saveMutation.isPending}
            onDelete={() => setDeleteOpen(true)}
            teintures={teintures ?? []}
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
            teintures={teintures ?? []}
            onMutationSuccess={invalidateAll}
            onSubFormsDirtyChange={setSubFormsDirty}
          />
        }
        sidebar={
          selectedId !== null ? (
            <DetailSidebar
              tarifId={selectedId}
              detail={detail ?? null}
              params={effectiveParams}
              isEditing={isEditing}
              onToggleArchive={() => archiveMutation.mutate(detail?.ok_tarif === 1 ? 0 : 1)}
              isArchiving={archiveMutation.isPending}
            />
          ) : null
        }
        sidebarTitle="Tarif"
        hasSelection={selectedId !== null}
        onBack={() => guard.guardAction(() => { cancelEdit(); setSelectedId(null) })}
      />

      <UnsavedChangesDialog open={guard.showDialog} onAction={guard.handleAction} isSaving={guard.isSaving} />

      <CreateTarifDialog
        open={createOpen}
        currentId={selectedId}
        currentLabel={detail?.reference ?? null}
        onClose={() => setCreateOpen(false)}
        onCreated={(newId) => {
          setCreateOpen(false)
          queryClient.invalidateQueries({ queryKey: ['tarifs-fini'] })
          // A new simulation is always "en cours" — make sure it's visible.
          if (statusFilter === 'archive') setStatusFilter('en_cours')
          setSelectedId(newId)
          setAutoEditForId(newId)
        }}
      />

      <ConfirmDialog
        open={deleteOpen}
        title="Supprimer la simulation"
        description={
          detail
            ? `« ${detail.reference} » sera supprimée, avec sa composition et ses traitements. Cette action est irréversible.`
            : undefined
        }
        isPending={deleteMutation.isPending}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => {
          if (selectedId !== null) {
            setIsEditing(false)
            setDraft(null)
            deleteMutation.mutate(selectedId)
          }
        }}
      />
    </>
  )
}

// ── Left Panel: List ───────────────────────────────────

function TeintureChip({ mode, shade, size = 'sm' }: { mode: TeintureMode; shade?: string | null; size?: 'sm' | 'md' }) {
  // Hue per dye level, same idea as the sous-traitant type chip (§36): a
  // category tag the user scans, not a status.
  const classes =
    mode === 'sans'
      ? 'bg-stone-500/10 text-stone-700 border-stone-500/25'
      : mode === 'simple'
        ? 'bg-sky-500/10 text-sky-700 border-sky-500/25'
        : 'bg-violet-500/10 text-violet-700 border-violet-500/25'
  const label = mode === 'sans' ? 'Sans teinture' : `${mode === 'simple' ? 'Simple' : 'Double'}${shade ? ` · ${shade}` : ''}`
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded border font-medium whitespace-nowrap',
        size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs',
        classes,
      )}
    >
      <Droplet className={size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3'} />
      {label}
    </span>
  )
}

function TarifList({
  tarifs, isLoading, isError, error, selectedId, onSelect,
  searchQuery, onSearchChange, statusFilter, onStatusFilterChange, onNew, isEditing,
}: {
  tarifs: TarifListRow[]; isLoading: boolean; isError: boolean; error: Error | null
  selectedId: number | null; onSelect: (id: number) => void
  searchQuery: string; onSearchChange: (q: string) => void
  statusFilter: StatusFilter; onStatusFilterChange: (f: StatusFilter) => void
  onNew: () => void; isEditing: boolean
}) {
  const filterOptions: { key: StatusFilter; label: string }[] = [
    { key: 'en_cours', label: 'En cours' },
    { key: 'archive', label: 'Archivées' },
    { key: 'tous', label: 'Toutes' },
  ]
  return (
    <div className="flex flex-col h-full rounded-lg border shadow-sm bg-zinc-100/80">
      <div className="p-3 border-b rounded-t-lg bg-zinc-200/50 space-y-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Rechercher une simulation..."
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
              onClick={() => onStatusFilterChange(opt.key)}
              className={cn(
                'px-2 py-1 text-xs rounded-md transition-colors flex-grow basis-[calc(33.333%-0.25rem)]',
                statusFilter === opt.key
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
          <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
        ) : isError ? (
          <div className="flex flex-col items-center justify-center py-8 text-destructive">
            <AlertCircle className="h-6 w-6 mb-2" />
            <p className="text-sm">{error?.message || 'Erreur'}</p>
          </div>
        ) : tarifs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <BadgeEuro className="h-12 w-12 mb-3 opacity-50" />
            <p className="text-sm">Aucune simulation</p>
          </div>
        ) : (
          tarifs.map((t) => (
            <div
              key={t.IDref_tarif}
              onClick={() => onSelect(t.IDref_tarif)}
              className={cn(
                'relative p-3 border rounded-lg cursor-pointer transition-all',
                selectedId === t.IDref_tarif
                  ? 'border-accent bg-white ring-1 ring-accent'
                  : 'border-border bg-white hover:border-accent/50',
              )}
            >
              {t.ok_tarif === 1 && (
                <Badge variant="outline" className="absolute top-2 right-2 text-[10px] py-0 gap-1 text-muted-foreground">
                  <Archive className="h-2.5 w-2.5" />Archivée
                </Badge>
              )}
              <div className="flex items-center gap-2 pr-16">
                <FiniRollIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                <p className="font-medium text-sm truncate">{t.reference || `Simulation #${t.IDref_tarif}`}</p>
              </div>
              <div className="flex items-center gap-1.5 mt-1.5 ml-6 flex-wrap">
                <TeintureChip mode={t.teinture_mode} shade={t.teinture_shade} />
                <span className="text-[11px] text-muted-foreground">
                  {t.poids > 0 ? `${fmtNum(t.poids)} g/m²` : '— g/m²'}
                  {t.laize > 0 ? ` · ${fmtNum(t.laize)} cm` : ''}
                  {t.fils_count > 0 ? ` · ${t.fils_count} fil${t.fils_count > 1 ? 's' : ''}` : ''}
                </span>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="p-3 border-t text-xs text-muted-foreground flex items-center justify-between rounded-b-lg bg-zinc-200/50">
        <span>{tarifs.length} simulation{tarifs.length !== 1 ? 's' : ''}</span>
        {!isEditing && (
          <Button size="sm" variant="ghost" onClick={onNew} className="text-accent hover:text-accent hover:bg-accent/10">
            <Plus className="h-3.5 w-3.5 mr-1" />Nouveau
          </Button>
        )}
      </div>
    </div>
  )
}

// ── Center: Detail Header ──────────────────────────────

function DetailHeader({
  detail, isLoading, isEditing, reference, onReferenceChange,
  onStartEdit, onCancelEdit, onSave, isSaving, onDelete, teintures,
}: {
  detail: TarifDetail | null; isLoading: boolean; isEditing: boolean
  reference: string; onReferenceChange: (v: string) => void
  onStartEdit: () => void; onCancelEdit: () => void; onSave: () => void; isSaving: boolean
  onDelete: () => void; teintures: TeintureLookup[]
}) {
  if (!detail && !isLoading) return null
  const teint = detail ? teintureModeOf(detail.IDteinture, teintures) : null
  return (
    <div className="flex-shrink-0 pt-0.5">
      <div className="flex items-center gap-3">
        <div className={cn('h-11 w-11 rounded-lg flex items-center justify-center', isEditing ? 'bg-accent/15' : 'icon-box-gold')}>
          <BadgeEuro className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          {isLoading ? (
            <div className="h-8 w-48 bg-muted animate-pulse rounded" />
          ) : isEditing ? (
            <div className="flex items-center gap-3">
              <input
                value={reference}
                onChange={(e) => onReferenceChange(e.target.value)}
                autoFocus
                className="flex-1 text-xl font-heading font-bold h-10 px-3 rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <Badge className="bg-accent text-accent-foreground flex-shrink-0 gap-1 shadow-sm">
                <Pencil className="h-3 w-3" />Mode edition
              </Badge>
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-heading font-bold tracking-tight truncate">{detail?.reference}</h1>
              {detail && teint && (
                <div className="flex gap-1.5 mt-1 flex-wrap items-center">
                  <TeintureChip mode={teint.mode} shade={teint.mode === 'sans' ? null : teint.shade} size="md" />
                  {detail.rendement > 0 && (
                    <Badge variant="secondary" className="text-xs">{fmtNum(detail.rendement, 2)} Ml/Kg</Badge>
                  )}
                  {detail.ok_tarif === 1 && (
                    <Badge variant="outline" className="text-xs gap-1 text-muted-foreground">
                      <Archive className="h-3 w-3" />Archivée
                    </Badge>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        {!isLoading && detail && (
          <div className="flex items-center gap-2 flex-shrink-0">
            {isEditing ? (
              <>
                <Button variant="outline" size="sm" onClick={onCancelEdit}><X className="h-3.5 w-3.5 mr-1.5" />Annuler</Button>
                <Button size="sm" onClick={onSave} disabled={isSaving}>
                  <Save className="h-3.5 w-3.5 mr-1.5" />{isSaving ? 'Enregistrement...' : 'Enregistrer'}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9 text-destructive hover:text-destructive"
                  title="Supprimer la simulation"
                  onClick={onDelete}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
                <Button variant="gold" size="sm" onClick={onStartEdit}><Pencil className="h-3.5 w-3.5 mr-1.5" />Modifier</Button>
              </>
            )}
          </div>
        )}
      </div>
      <div className={cn('h-1 w-24 mt-3 rounded-full', isEditing ? 'bg-accent' : 'bg-gradient-to-r from-accent via-accent to-accent/30')} />
    </div>
  )
}

// ── Center: shared bits ────────────────────────────────

/** Label above a compact numeric field, with an optional unit suffix inside. */
function FieldNum({
  label, value, unit, onChange, disabled,
}: {
  label: string; value: string; unit?: string; onChange: (v: string) => void; disabled: boolean
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <div className="relative">
        <input
          type="text"
          inputMode="decimal"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={cn(inputClass, 'tabular-nums disabled:bg-muted/40 disabled:text-foreground', unit && 'pr-10')}
        />
        {unit && (
          <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground pointer-events-none">
            {unit}
          </span>
        )}
      </div>
    </div>
  )
}

/** Borderless segmented row — same language as the left-list status filter. */
function Segmented<T extends string>({
  value, options, onChange, disabled,
}: {
  value: T; options: Array<{ key: T; label: string }>; onChange: (v: T) => void; disabled: boolean
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((opt) => (
        <button
          key={opt.key}
          type="button"
          disabled={disabled}
          onClick={() => onChange(opt.key)}
          className={cn(
            'px-2.5 py-1 text-xs rounded-md transition-colors flex-grow',
            value === opt.key
              ? 'bg-accent text-accent-foreground shadow-sm font-medium'
              : 'text-muted-foreground hover:bg-accent/10',
            disabled && 'cursor-default opacity-90 hover:bg-transparent',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// ── Center: Detail Main ────────────────────────────────

function DetailMain({
  detail, isLoading, hasSelection, isEditing, draft, onDraftChange,
  teintures, onMutationSuccess, onSubFormsDirtyChange,
}: {
  detail: TarifDetail | null; isLoading: boolean; hasSelection: boolean; isEditing: boolean
  draft: ParamsDraft | null; onDraftChange: (updater: (d: ParamsDraft | null) => ParamsDraft | null) => void
  teintures: TeintureLookup[]; onMutationSuccess: () => void
  onSubFormsDirtyChange: (dirty: boolean) => void
}) {
  if (!hasSelection) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="icon-box-gold h-16 w-16 mx-auto"><BadgeEuro className="h-8 w-8" /></div>
          <p className="text-muted-foreground text-sm">Sélectionnez une simulation dans la liste</p>
        </div>
      </div>
    )
  }
  if (isLoading) return <div className="flex-1 flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-accent" /></div>
  if (!detail) return null

  // In view mode the fields mirror the saved row; in edit mode the live draft.
  const view = draft ?? draftFromDetail(detail)
  const set = (patch: Partial<ParamsDraft>) => onDraftChange((d) => (d ? { ...d, ...patch } : d))
  const teint = teintureModeOf(view.IDteinture, teintures)

  return (
    <div className="flex-1 min-h-0 overflow-auto space-y-4 px-1 pb-1 scrollbar-transparent">
      <CompositionCard
        detail={detail}
        isEditing={isEditing}
        onMutationSuccess={onMutationSuccess}
        onDirtyChange={onSubFormsDirtyChange}
      />

      <Card className={cn('card-premium', isEditing && editSectionClass)}>
        <CardHeader className="flex flex-row items-center gap-2 pb-2">
          <Ruler className="h-4 w-4 text-accent" />
          <CardTitle className="text-sm font-semibold">Paramètres</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            <FieldNum label="Prix de tricotage" unit="€/Kg" value={view.prix_tricotage} disabled={!isEditing} onChange={(v) => set({ prix_tricotage: v })} />
            <FieldNum label="Poids rouleau" unit="Kg" value={view.poids_rouleau} disabled={!isEditing} onChange={(v) => set({ poids_rouleau: v })} />
            <FieldNum label="Rendement" unit="Ml/Kg" value={view.rendement} disabled={!isEditing} onChange={(v) => set({ rendement: v })} />
            <FieldNum label="Laize" unit="cm" value={view.laize} disabled={!isEditing} onChange={(v) => set({ laize: v })} />
            <FieldNum label="Poids" unit="g/m²" value={view.poids} disabled={!isEditing} onChange={(v) => set({ poids: v })} />
            <FieldNum label="Freinte" unit="%" value={view.freinte} disabled={!isEditing} onChange={(v) => set({ freinte: v })} />
          </div>

          <div className="pt-1 border-t border-border/40">
            <p className="text-xs font-medium text-muted-foreground mb-1.5 mt-2">Frais de port</p>
            <div className="grid grid-cols-2 gap-2 items-end">
              <div className="space-y-1">
                <Segmented<PortMode>
                  value={view.port_mode}
                  disabled={!isEditing}
                  onChange={(m) => set({ port_mode: m })}
                  options={[
                    { key: 'pct', label: 'Pourcentage' },
                    { key: 'kg', label: 'Au Kg' },
                  ]}
                />
              </div>
              {view.port_mode === 'pct' ? (
                <FieldNum label="Taux de port" unit="%" value={view.port_pct} disabled={!isEditing} onChange={(v) => set({ port_pct: v })} />
              ) : (
                <FieldNum label="Port forfaitaire" unit="€/Kg" value={view.port_fixe} disabled={!isEditing} onChange={(v) => set({ port_fixe: v })} />
              )}
            </div>
            {view.port_mode === 'pct' && (
              <p className="text-[11px] text-muted-foreground mt-1.5">
                La tranche 30 rouleaux applique 3 % de port, comme sur l&apos;ancien écran.
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <EnnoblissementCard
        detail={detail}
        isEditing={isEditing}
        view={view}
        teint={teint}
        teintures={teintures}
        onSet={set}
        onMutationSuccess={onMutationSuccess}
      />

      <Card className={cn('card-premium', isEditing && editSectionClass)}>
        <CardHeader className="flex flex-row items-center gap-2 pb-2">
          <MessageSquare className="h-4 w-4 text-accent" />
          <CardTitle className="text-sm font-semibold">Commentaire</CardTitle>
        </CardHeader>
        <CardContent>
          {isEditing ? (
            <textarea
              rows={3}
              value={view.commentaire}
              onChange={(e) => set({ commentaire: e.target.value })}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
            />
          ) : view.commentaire.trim() ? (
            <p className="text-sm text-muted-foreground whitespace-pre-line">{view.commentaire}</p>
          ) : (
            <p className="text-sm text-muted-foreground italic">Aucun commentaire</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ── Center: Composition ────────────────────────────────

interface FilFormState {
  IDref_fil: number
  IDcolori_fil: number
  pourcentage: string
  prix: string
}

const EMPTY_FIL_FORM: FilFormState = { IDref_fil: 0, IDcolori_fil: 0, pourcentage: '', prix: '' }

function CompositionCard({
  detail, isEditing, onMutationSuccess, onDirtyChange,
}: {
  detail: TarifDetail; isEditing: boolean; onMutationSuccess: () => void
  onDirtyChange: (dirty: boolean) => void
}) {
  const queryClient = useQueryClient()
  const { data: fils } = useFilsLookup()
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<FilFormState>(EMPTY_FIL_FORM)
  const [deleteTarget, setDeleteTarget] = useState<TarifFil | null>(null)

  // Surface "a sub-form is open" to the page's unsaved guard (§28.3.a). The ref
  // indirection keeps the unmount reset pointing at the latest callback.
  const onDirtyChangeRef = useRef(onDirtyChange)
  useEffect(() => { onDirtyChangeRef.current = onDirtyChange })
  useEffect(() => { onDirtyChangeRef.current(showForm || editingId !== null) }, [showForm, editingId])
  useEffect(() => () => { onDirtyChangeRef.current(false) }, [])

  // Leaving edit mode closes any open row form.
  useEffect(() => {
    if (!isEditing) { setShowForm(false); setEditingId(null) }
  }, [isEditing])

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['tarif-fini', detail.IDref_tarif] })
    onMutationSuccess()
  }, [queryClient, detail.IDref_tarif, onMutationSuccess])

  const addMut = useMutation({
    mutationFn: (body: unknown) =>
      apiFetch(`/tarifs-fini/${detail.IDref_tarif}/fils`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { invalidate(); setShowForm(false); setForm(EMPTY_FIL_FORM) },
  })
  const updateMut = useMutation({
    mutationFn: ({ lineId, body }: { lineId: number; body: unknown }) =>
      apiFetch(`/tarifs-fini/${detail.IDref_tarif}/fils/${lineId}`, { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => { invalidate(); setEditingId(null); setForm(EMPTY_FIL_FORM) },
  })
  const deleteMut = useMutation({
    mutationFn: (lineId: number) =>
      apiFetch(`/tarifs-fini/${detail.IDref_tarif}/fils/${lineId}`, { method: 'DELETE' }),
    onSuccess: () => { invalidate(); setDeleteTarget(null) },
  })

  const totalPct = detail.fils.reduce((s, f) => s + f.pourcentage, 0)
  const totalOk = Math.abs(totalPct - 100) < 0.01
  const totalPrix = detail.fils.reduce((s, f) => s + (f.prix * f.pourcentage) / 100, 0)

  const startAdd = () => {
    setEditingId(null)
    setForm(EMPTY_FIL_FORM)
    setShowForm(true)
  }
  const startEditLine = (f: TarifFil) => {
    setShowForm(false)
    setForm({
      IDref_fil: f.IDref_fil,
      IDcolori_fil: f.IDcolori_fil,
      pourcentage: numToInput(f.pourcentage),
      prix: numToInput(f.prix),
    })
    setEditingId(f.IDasso_fil_tarif)
  }
  const submitForm = () => {
    const body = {
      IDref_fil: form.IDref_fil,
      IDcolori_fil: form.IDcolori_fil,
      pourcentage: parseNum(form.pourcentage),
      prix: parseNum(form.prix),
    }
    if (body.IDref_fil <= 0) return
    if (editingId !== null) updateMut.mutate({ lineId: editingId, body })
    else addMut.mutate(body)
  }

  return (
    <>
      <Card className={cn('card-premium', isEditing && editSectionClass)}>
        <CardHeader className="flex flex-row items-center gap-2 pb-2">
          <BobineIcon className="h-4 w-4 text-accent" />
          <CardTitle className="text-sm font-semibold">Composition</CardTitle>
          <Badge
            variant="outline"
            className={cn(
              'text-xs ml-auto tabular-nums',
              totalOk ? 'text-green-700 border-green-500/40 bg-green-500/10' : 'text-amber-800 border-amber-500/40 bg-amber-500/10',
            )}
            title={totalOk ? 'La composition totalise 100 %' : 'La composition ne totalise pas 100 %'}
          >
            {fmtNum(totalPct, 2)} %
          </Badge>
        </CardHeader>
        <CardContent className="space-y-2">
          {detail.fils.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <BobineIcon className="h-12 w-12 mb-3 opacity-40" />
              <p className="text-sm">Aucun fil</p>
              {isEditing && !showForm && (
                <Button variant="outline" size="sm" className="mt-3" onClick={startAdd}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter un fil
                </Button>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-border/60 overflow-hidden bg-white">
              <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
                <colgroup>
                  <col style={{ width: '42%' }} />
                  <col style={{ width: '24%' }} />
                  <col style={{ width: '15%' }} />
                  <col style={{ width: '12%' }} />
                  <col style={{ width: '7%' }} />
                </colgroup>
                <thead className="bg-zinc-200/60 border-b border-border/60 text-[10px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-2.5 py-2 text-left font-semibold">Référence</th>
                    <th className="px-2.5 py-2 text-left font-semibold">Coloris</th>
                    <th className="px-2.5 py-2 text-right font-semibold">Prix</th>
                    <th className="px-2.5 py-2 text-right font-semibold">%</th>
                    <th className="px-2.5 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {detail.fils.map((f) => (
                    <tr
                      key={f.IDasso_fil_tarif}
                      onClick={isEditing ? () => startEditLine(f) : undefined}
                      className={cn(
                        'group border-b border-border/40 last:border-b-0 transition-colors',
                        isEditing && 'cursor-pointer hover:bg-accent/5',
                        editingId === f.IDasso_fil_tarif && 'bg-accent/10',
                      )}
                    >
                      <td className="px-2.5 py-1.5 truncate" title={f.ref_label ?? undefined}>{f.ref_label || `#${f.IDref_fil}`}</td>
                      <td className="px-2.5 py-1.5 truncate text-muted-foreground" title={f.colori_label ?? undefined}>
                        {f.colori_label || '—'}
                      </td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums">{fmtNum(f.prix, 2)} €</td>
                      <td className="px-2.5 py-1.5 text-right tabular-nums font-medium">{fmtNum(f.pourcentage, 2)}</td>
                      <td className="px-2.5 py-1.5 text-right">
                        {isEditing && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-destructive hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={(e) => { e.stopPropagation(); setDeleteTarget(f) }}
                            title="Retirer ce fil"
                          >
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="flex items-center justify-between gap-3 px-2.5 py-1.5 border-t border-border/60 bg-zinc-100/80 text-xs">
                <span className="text-muted-foreground">Coût matière</span>
                <span className="tabular-nums font-semibold">{fmtNum(totalPrix, 2)} €/Kg</span>
              </div>
            </div>
          )}

          {!totalOk && detail.fils.length > 0 && (
            <p className="text-[11px] text-amber-800">
              La composition totalise {fmtNum(totalPct, 2)} % — le coût matière est calculé au prorata saisi.
            </p>
          )}

          {(showForm || editingId !== null) && (
            <FilForm
              form={form}
              onChange={setForm}
              fils={fils ?? []}
              isPending={addMut.isPending || updateMut.isPending}
              isEdit={editingId !== null}
              onCancel={() => { setShowForm(false); setEditingId(null); setForm(EMPTY_FIL_FORM) }}
              onSubmit={submitForm}
            />
          )}

          {isEditing && !showForm && editingId === null && detail.fils.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={startAdd}
              className="w-full text-muted-foreground hover:text-accent hover:bg-accent/5 border border-dashed border-border/60 hover:border-accent/40"
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter un fil
            </Button>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Retirer le fil"
        description={deleteTarget ? `${deleteTarget.ref_label ?? ''} sera retiré de la composition.` : undefined}
        confirmLabel="Retirer"
        isPending={deleteMut.isPending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => { if (deleteTarget) deleteMut.mutate(deleteTarget.IDasso_fil_tarif) }}
      />
    </>
  )
}

function FilForm({
  form, onChange, fils, isPending, isEdit, onCancel, onSubmit,
}: {
  form: FilFormState; onChange: (f: FilFormState) => void; fils: FilLookup[]
  isPending: boolean; isEdit: boolean; onCancel: () => void; onSubmit: () => void
}) {
  const selected = fils.find((f) => f.IDref_fil === form.IDref_fil) ?? null
  const colorisOptions = (selected?.coloris ?? []).map((c) => ({
    id: c.id,
    primary: c.reference || `#${c.id}`,
    secondary: c.prix_kg > 0 ? `${fmtNum(c.prix_kg, 2)} €` : undefined,
  }))

  /** Picking a yarn seeds the price from the catalog — the user is then free to
   *  override it, which is what makes this a simulation and not a lookup. */
  const pickFil = (id: number) => {
    const f = fils.find((x) => x.IDref_fil === id)
    onChange({ ...form, IDref_fil: id, IDcolori_fil: 0, prix: f ? numToInput(f.prix_kg) : form.prix })
  }
  const pickColoris = (id: number) => {
    const c = selected?.coloris.find((x) => x.id === id)
    onChange({
      ...form,
      IDcolori_fil: id,
      prix: c && c.prix_kg > 0 ? numToInput(c.prix_kg) : numToInput(selected?.prix_kg ?? 0),
    })
  }

  return (
    <div className="rounded-lg border border-accent/25 bg-accent/[0.03] p-4 space-y-3">
      <p className="text-xs font-semibold text-accent uppercase tracking-wide">
        {isEdit ? 'Modifier le fil' : 'Ajouter un fil'}
      </p>
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Référence de fil</label>
        <SearchableCombobox<FilLookup>
          options={fils}
          value={form.IDref_fil}
          onChange={pickFil}
          getId={(f) => f.IDref_fil}
          getPrimary={(f) => f.reference ?? `#${f.IDref_fil}`}
          getSecondary={(f) => (f.prix_kg > 0 ? `${fmtNum(f.prix_kg, 2)} €/Kg` : null)}
          placeholder="Rechercher un fil"
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Coloris</label>
          <PopoverSelect
            options={colorisOptions}
            value={form.IDcolori_fil}
            onChange={pickColoris}
            emptyLabel="— aucun —"
            disabled={form.IDref_fil <= 0}
            disabledTitle="Choisissez d'abord une référence de fil"
          />
        </div>
        <FieldNum label="Prix" unit="€/Kg" value={form.prix} disabled={false} onChange={(v) => onChange({ ...form, prix: v })} />
        <FieldNum label="Pourcentage" unit="%" value={form.pourcentage} disabled={false} onChange={(v) => onChange({ ...form, pourcentage: v })} />
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" size="sm" onClick={onCancel}>Annuler</Button>
        <Button size="sm" onClick={onSubmit} disabled={isPending || form.IDref_fil <= 0}>
          {isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
          Enregistrer
        </Button>
      </div>
    </div>
  )
}

// ── Center: Ennoblissement ─────────────────────────────

function EnnoblissementCard({
  detail, isEditing, view, teint, teintures, onSet, onMutationSuccess,
}: {
  detail: TarifDetail; isEditing: boolean; view: ParamsDraft
  teint: { mode: TeintureMode; shade: string }; teintures: TeintureLookup[]
  onSet: (patch: Partial<ParamsDraft>) => void; onMutationSuccess: () => void
}) {
  const queryClient = useQueryClient()
  const { data: traitements } = useTraitementsLookup()
  const [deleteTarget, setDeleteTarget] = useState<TarifTraitement | null>(null)

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['tarif-fini', detail.IDref_tarif] })
    onMutationSuccess()
  }, [queryClient, detail.IDref_tarif, onMutationSuccess])

  const addMut = useMutation({
    mutationFn: (IDtraitement: number) =>
      apiFetch(`/tarifs-fini/${detail.IDref_tarif}/traitements`, {
        method: 'POST',
        body: JSON.stringify({ IDtraitement }),
      }),
    onSuccess: invalidate,
  })
  const deleteMut = useMutation({
    mutationFn: (lineId: number) =>
      apiFetch(`/tarifs-fini/${detail.IDref_tarif}/traitements/${lineId}`, { method: 'DELETE' }),
    onSuccess: () => { invalidate(); setDeleteTarget(null) },
  })

  const shadeOptions = useMemo(() => {
    const wantSimple = teint.mode === 'simple' ? 1 : 0
    const seen = new Set<string>()
    const out: Array<{ key: string; label: string }> = []
    for (const t of teintures) {
      if (t.simple_teinture !== wantSimple) continue
      const s = t.designation_interne ?? ''
      if (!s || seen.has(s)) continue
      seen.add(s)
      out.push({ key: s, label: s })
    }
    return out
  }, [teintures, teint.mode])

  return (
    <>
      <Card className={cn('card-premium', isEditing && editSectionClass)}>
        <CardHeader className="flex flex-row items-center gap-2 pb-2">
          <Sparkles className="h-4 w-4 text-accent" />
          <CardTitle className="text-sm font-semibold">Ennoblissement</CardTitle>
          <Badge variant="secondary" className="text-xs ml-auto">{detail.traitements.length}</Badge>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Teinture</label>
              <Segmented<TeintureMode>
                value={teint.mode}
                disabled={!isEditing}
                onChange={(m) => onSet({ IDteinture: teintureIdFor(m, teint.shade, teintures) })}
                options={[
                  { key: 'sans', label: 'Sans' },
                  { key: 'simple', label: 'Simple' },
                  { key: 'double', label: 'Double' },
                ]}
              />
            </div>
            {teint.mode !== 'sans' && shadeOptions.length > 0 && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Nuance</label>
                <Segmented<string>
                  value={teint.shade}
                  disabled={!isEditing}
                  onChange={(s) => onSet({ IDteinture: teintureIdFor(teint.mode, s, teintures) })}
                  options={shadeOptions}
                />
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1 border-t border-border/40">
            <div className="mt-2">
              <FieldNum
                label="Multiplicateur ennoblissement"
                unit="%"
                value={view.multiplicateur}
                disabled={!isEditing}
                onChange={(v) => onSet({ multiplicateur: v })}
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Majoration appliquée à tous les traitements et à la teinture, en plus des 5 % de conditionnement.
              </p>
            </div>
          </div>

          <div className="pt-1 border-t border-border/40">
            <p className="text-xs font-medium text-muted-foreground mb-1.5 mt-2">Traitements appliqués</p>
            {detail.traitements.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">Aucun traitement</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {detail.traitements.map((t) => (
                  <Badge
                    key={t.IDasso_traitement_tarif}
                    className="bg-accent/10 text-accent hover:bg-accent/20 border-accent/20 gap-1"
                  >
                    {t.designation ?? `#${t.IDtraitement}`}
                    {isEditing && (
                      <button
                        type="button"
                        onClick={() => setDeleteTarget(t)}
                        className="ml-0.5 rounded-full hover:bg-destructive/20 hover:text-destructive p-0.5 -mr-1 transition-colors"
                        title="Retirer ce traitement"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </Badge>
                ))}
              </div>
            )}
            {isEditing && (
              <div className="mt-2.5 flex items-center gap-2">
                <PopoverSelect
                  size="sm"
                  value={0}
                  onChange={(id) => { if (id > 0) addMut.mutate(id) }}
                  emptyLabel="+ Ajouter un traitement"
                  options={(traitements ?? []).map((t) => ({
                    id: t.IDtraitement,
                    primary: t.designation ?? `#${t.IDtraitement}`,
                  }))}
                />
                {addMut.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />}
                <span className="text-[11px] text-muted-foreground">
                  Un même traitement peut être appliqué plusieurs fois.
                </span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Retirer le traitement"
        description={deleteTarget ? `${deleteTarget.designation ?? ''} ne sera plus facturé sur cette simulation.` : undefined}
        confirmLabel="Retirer"
        isPending={deleteMut.isPending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => { if (deleteTarget) deleteMut.mutate(deleteTarget.IDasso_traitement_tarif) }}
      />
    </>
  )
}

// ── Right Panel ────────────────────────────────────────

/** Gold-banded cost-component header with its €/Kg total — same rendering as
 *  the Finis › Références tarif tab so both screens read identically. */
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

function CostLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-2 text-[11px] leading-snug">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground/80 flex-shrink-0 whitespace-nowrap">{value}</span>
    </div>
  )
}

function TrancheBreakdown({ tranche }: { tranche: TarifTranche }) {
  const eurKg = (v: number) => `${fmtNum(v, 2)} €/Kg`
  // Derived from the priced tranche rather than the draft, so the section can't
  // appear a debounce-tick before the numbers behind it.
  const showTeinture = tranche.detailTeinture !== null
  return (
    <div className="p-3 rounded-lg border bg-card shadow-sm space-y-2.5">
      <CostSection title="Fil" total={eurKg(tranche.moFil)}>
        {tranche.detailFil.length > 0 ? (
          tranche.detailFil.map((l, i) => <CostLine key={i} label={l.label} value={eurKg(l.valueKg)} />)
        ) : (
          <p className="text-[11px] text-muted-foreground italic">Aucun fil</p>
        )}
      </CostSection>

      <CostSection title="Tricotage" total={eurKg(tranche.moTricotage)}>
        {tranche.detailTricotage && (
          <CostLine label={tranche.detailTricotage.label} value={eurKg(tranche.detailTricotage.valueKg)} />
        )}
      </CostSection>

      <CostSection title="Traitement" total={eurKg(tranche.moTraitements)}>
        {tranche.detailTraitement.length > 0 ? (
          tranche.detailTraitement.map((l, i) => <CostLine key={i} label={l.label} value={eurKg(l.valueKg)} />)
        ) : (
          <p className="text-[11px] text-muted-foreground italic">Aucun traitement</p>
        )}
      </CostSection>

      {showTeinture && (
        <CostSection title="Teinture" total={eurKg(tranche.moTeinte)}>
          {tranche.detailTeinture && (
            <CostLine label={tranche.detailTeinture.label} value={eurKg(tranche.detailTeinture.valueKg)} />
          )}
        </CostSection>
      )}

      <CostSection title="Prix de vente">
        <CostLine label="Prix de revient au Kg" value={eurKg(tranche.moRevient)} />
        <CostLine label="Coefficient" value={String(Math.round(tranche.rCoeff * 100))} />
        <CostLine
          label={
            tranche.tauxFraisDePort > 0
              ? `Prix de vente au Kg · ${fmtNum(tranche.moPortAuKg, 2)} € de frais (${Math.round(tranche.tauxFraisDePort * 100)}%) de port inclus`
              : `Prix de vente au Kg · ${fmtNum(tranche.moPortAuKg, 2)} € de port inclus`
          }
          value={`${fmtNum(tranche.moPrixDeVenteAuKg, 2)} €/Kg`}
        />
        <CostLine
          label={
            tranche.tauxFraisDePort > 0
              ? `Prix de vente au Ml · ${fmtNum(tranche.moPortAuMl, 2)} € de frais (${Math.round(tranche.tauxFraisDePort * 100)}%) de port inclus`
              : `Prix de vente au Ml · ${fmtNum(tranche.moPortAuMl, 2)} € de port inclus`
          }
          value={`${fmtNum(tranche.moPrixDeVenteAuMl, 2)} €/Ml`}
        />
      </CostSection>
    </div>
  )
}

/** Human wording for the reasons the engine couldn't price a simulation. */
const BLOCKER_LABEL: Record<string, string> = {
  rendement: 'le rendement (Ml/Kg)',
  poids_rouleau: 'le poids d’un rouleau (Kg)',
}

function DetailSidebar({
  tarifId, detail, params, isEditing, onToggleArchive, isArchiving,
}: {
  tarifId: number
  detail: TarifDetail | null
  params: ReturnType<typeof previewParams> | null
  isEditing: boolean
  onToggleArchive: () => void
  isArchiving: boolean
}) {
  const [activeTab, setActiveTab] = useState<SidebarTab>('tarif')
  const [selectedTranche, setSelectedTranche] = useState(0)
  const [librePoids, setLibrePoids] = useState('')
  const [libreCoeff, setLibreCoeff] = useState('')
  const [librePrix, setLibrePrix] = useState('')
  /** Committed on "Calculer" so typing doesn't fire a request per keystroke. */
  const [libreApplied, setLibreApplied] = useState<{ poids: number; coefficient?: number; prix_cible_ml?: number } | null>(null)

  // Land on the tarif tab whenever the selection changes.
  useEffect(() => {
    setActiveTab('tarif')
    setSelectedTranche(0)
    setLibreApplied(null)
  }, [tarifId])

  // Debounced while editing so dragging a field doesn't fire a request per
  // keystroke; instant in view mode, where the value only changes on selection.
  // The KEY is what gets debounced and the body is parsed back out of it, so the
  // cache entry can never disagree with the parameters actually priced.
  const paramsKey = useDebounced(params ? JSON.stringify(params) : null, isEditing ? 400 : 0)
  const libreKey = libreApplied ? JSON.stringify(libreApplied) : null

  const { data, isLoading, isError } = useQuery<TarifResult>({
    // Keyed on the effective parameters so editing re-prices live.
    queryKey: ['tarif-fini-calc', tarifId, paramsKey, libreKey],
    queryFn: () =>
      apiFetch(`/tarifs-fini/${tarifId}/preview`, {
        method: 'POST',
        body: JSON.stringify({
          params: paramsKey ? JSON.parse(paramsKey) : undefined,
          libre: libreApplied ?? undefined,
        }),
      }),
    enabled: paramsKey !== null,
    placeholderData: (prev) => prev,
  })

  const tranches = data?.tranches ?? []
  const current = tranches[Math.min(selectedTranche, Math.max(tranches.length - 1, 0))] ?? null
  const isArchived = detail?.ok_tarif === 1

  const runLibre = () => {
    const poids = parseNum(librePoids)
    if (!(poids > 0)) return
    const coeff = parseNum(libreCoeff)
    const prix = parseNum(librePrix)
    setLibreApplied({
      poids,
      coefficient: coeff > 0 ? coeff : undefined,
      prix_cible_ml: coeff > 0 ? undefined : prix > 0 ? prix : undefined,
    })
  }

  const tabs: { key: SidebarTab; label: string; icon: typeof BadgeEuro }[] = [
    { key: 'tarif', label: 'Tarif', icon: BadgeEuro },
    { key: 'simulation', label: 'Simulation', icon: Calculator },
  ]

  return (
    <div className="w-96 flex-shrink-0 flex flex-col gap-3 min-h-0">
      <div className="flex-1 min-h-0 rounded-xl border flex flex-col overflow-hidden bg-zinc-100/80">
        <div className="flex border-b p-1 gap-1 rounded-t-xl bg-zinc-200/50">
          {tabs.map((t) => {
            const Icon = t.icon
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setActiveTab(t.key)}
                className={cn(
                  'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md transition-colors',
                  activeTab === t.key ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10',
                )}
              >
                <Icon className="h-3.5 w-3.5" />{t.label}
              </button>
            )
          })}
        </div>

        <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-transparent">
          {isEditing && (
            <p className="text-[11px] text-accent flex items-center gap-1.5">
              <Pencil className="h-3 w-3 flex-shrink-0" />
              Tarif calculé sur les paramètres en cours de saisie.
            </p>
          )}

          {isLoading && !data ? (
            <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
          ) : isError ? (
            <p className="text-sm text-destructive px-1">Erreur lors du calcul du tarif.</p>
          ) : tranches.length === 0 ? (
            <p className="text-sm text-muted-foreground italic px-1">
              {data && data.blockers.length > 0
                ? `Renseignez ${data.blockers.map((b) => BLOCKER_LABEL[b] ?? b).join(' et ')} pour calculer le tarif.`
                : 'Tarif indisponible.'}
            </p>
          ) : activeTab === 'tarif' ? (
            <>
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
                          {t.isMetrage ? '< ' : ''}{fmtNum(t.qte_ml)}
                        </td>
                        <td className="px-2 py-1.5 text-right tabular-nums font-medium">
                          {fmtNum(t.moPrixDeVenteAuMl, 2)} €
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {current && <TrancheBreakdown tranche={current} />}
            </>
          ) : (
            <>
              <div className="p-3 rounded-lg border bg-card shadow-sm space-y-2.5">
                <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
                  <Calculator className="h-3.5 w-3.5" />Simulation libre
                </p>
                <p className="text-[11px] text-muted-foreground leading-snug">
                  Chiffrez n&apos;importe quel poids, hors des 9 tranches standard. Renseignez un coefficient
                  pour obtenir le prix, ou un prix cible pour obtenir le coefficient nécessaire.
                </p>
                <FieldNum label="Poids à traiter" unit="Kg" value={librePoids} disabled={false} onChange={setLibrePoids} />
                <div className="grid grid-cols-2 gap-2">
                  <FieldNum
                    label="Coefficient"
                    unit="%"
                    value={libreCoeff}
                    disabled={false}
                    onChange={(v) => { setLibreCoeff(v); if (v.trim()) setLibrePrix('') }}
                  />
                  <FieldNum
                    label="Prix cible"
                    unit="€/Ml"
                    value={librePrix}
                    disabled={libreCoeff.trim() !== ''}
                    onChange={setLibrePrix}
                  />
                </div>
                <Button size="sm" className="w-full" onClick={runLibre} disabled={!(parseNum(librePoids) > 0)}>
                  <Calculator className="h-3.5 w-3.5 mr-1.5" />Calculer
                </Button>
              </div>

              {data?.libre ? (
                <>
                  <div className="p-3 rounded-lg border bg-card shadow-sm space-y-1.5">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs text-muted-foreground">Poids traité</span>
                      <span className="text-sm tabular-nums">{fmtNum(data.libre.poids_ref)} Kg</span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs text-muted-foreground">Quantité</span>
                      <span className="text-sm tabular-nums">{fmtNum(data.libre.qte_ml)} Ml</span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs text-muted-foreground">Coefficient</span>
                      <span className="text-sm tabular-nums font-semibold">{fmtNum(data.libre.rCoeff * 100, 1)} %</span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2 pt-1.5 border-t border-border/40">
                      <span className="text-xs text-muted-foreground">Prix de revient</span>
                      <span className="text-sm tabular-nums">{fmtNum(data.libre.moRevient, 2)} €/Kg</span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs text-muted-foreground">Prix de vente</span>
                      <span className="text-sm tabular-nums">{fmtNum(data.libre.moPrixDeVenteAuKg, 2)} €/Kg</span>
                    </div>
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-semibold">Prix de vente</span>
                      <span className="text-base tabular-nums font-bold text-accent">
                        {fmtNum(data.libre.moPrixDeVenteAuMl, 2)} €/Ml
                      </span>
                    </div>
                  </div>
                  <TrancheBreakdown tranche={data.libre} />
                </>
              ) : (
                <p className="text-sm text-muted-foreground italic px-1">
                  Saisissez un poids puis lancez le calcul.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {/* §29 status pill — En cours / Archivée */}
      <div
        className={cn(
          'flex-shrink-0 rounded-xl border shadow-sm overflow-hidden flex items-stretch h-11',
          isArchived ? 'bg-success border-success' : 'bg-primary border-primary',
        )}
      >
        <div className="flex items-center gap-2 px-3 flex-1 text-white min-w-0">
          {isArchived ? <CheckCircle2 className="h-4 w-4 flex-shrink-0" /> : <Clock className="h-4 w-4 flex-shrink-0" />}
          <span className="text-sm font-bold uppercase tracking-wide truncate">
            {isArchived ? 'Archivée' : 'En cours'}
          </span>
        </div>
        <button
          type="button"
          onClick={onToggleArchive}
          disabled={isEditing || isArchiving || !detail}
          title={isArchived ? 'Remettre en cours' : 'Archiver la simulation'}
          className="px-3.5 bg-white/15 hover:bg-white/25 active:bg-white/30 disabled:bg-white/5 disabled:opacity-60 disabled:cursor-not-allowed text-white text-xs font-semibold border-l border-white/25 flex items-center gap-1.5 transition-colors"
        >
          {isArchiving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : isArchived ? (
            <ArchiveRestore className="h-3.5 w-3.5" />
          ) : (
            <Archive className="h-3.5 w-3.5" />
          )}
          {isArchived ? 'Réactiver' : 'Archiver'}
        </button>
      </div>
    </div>
  )
}

// ── Create dialog ──────────────────────────────────────

type CreateMode = 'from_fini' | 'duplicate' | 'blank'

function CreateTarifDialog({
  open, currentId, currentLabel, onClose, onCreated,
}: {
  open: boolean
  currentId: number | null
  currentLabel: string | null
  onClose: () => void
  onCreated: (id: number) => void
}) {
  const [mode, setMode] = useState<CreateMode>('from_fini')
  const [refFiniId, setRefFiniId] = useState(0)
  const [reference, setReference] = useState('')
  const [touchedReference, setTouchedReference] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data: refsFinies, isLoading: refsLoading } = useQuery<RefFinieLookup[]>({
    queryKey: ['tarif-fini-lookup-refs-finies'],
    queryFn: () => apiFetch('/tarifs-fini/lookups/refs-finies'),
    enabled: open,
    staleTime: 5 * 60 * 1000,
  })

  // Reset on each open; default to duplicating when nothing else makes sense.
  useEffect(() => {
    if (!open) return
    setMode('from_fini')
    setRefFiniId(0)
    setReference('')
    setTouchedReference(false)
    setError(null)
  }, [open])

  // Suggest the legacy naming ("Copie de 081A") until the user types their own.
  useEffect(() => {
    if (touchedReference) return
    if (mode === 'from_fini') {
      const r = refsFinies?.find((x) => x.IDref_fini === refFiniId)
      setReference(r?.reference ? `Copie de ${r.reference}` : '')
    } else if (mode === 'duplicate') {
      setReference(currentLabel ? `Copie de ${currentLabel}` : '')
    } else {
      setReference('Nouvelle simulation')
    }
  }, [mode, refFiniId, refsFinies, currentLabel, touchedReference])

  const createMut = useMutation({
    mutationFn: () =>
      apiFetch('/tarifs-fini', {
        method: 'POST',
        body: JSON.stringify({
          mode,
          reference: reference.trim(),
          source_id: mode === 'from_fini' ? refFiniId : mode === 'duplicate' ? (currentId ?? undefined) : undefined,
        }),
      }),
    onSuccess: (data: TarifDetail) => onCreated(data.IDref_tarif),
    // apiFetch throws a bare "API 400" — surface something a user can act on.
    onError: () => setError('La simulation n’a pas pu être créée. Vérifiez la source et le nom saisis.'),
  })

  const modes: Array<{ key: CreateMode; label: string; description: string; icon: typeof FileInput; disabled?: boolean }> = [
    {
      key: 'from_fini',
      label: 'Depuis une référence finie',
      description: 'Reprend la composition, les traitements, le rendement et le prix de tricotage de la référence.',
      icon: FileInput,
    },
    {
      key: 'duplicate',
      label: 'Dupliquer la simulation courante',
      description: currentLabel ? `Copie « ${currentLabel} » à l'identique.` : 'Sélectionnez d’abord une simulation.',
      icon: Copy,
      disabled: currentId === null,
    },
    {
      key: 'blank',
      label: 'Simulation vierge',
      description: 'Part de zéro : poids rouleau 20 Kg, port 5 %, sans teinture.',
      icon: FilePlus2,
    },
  ]

  const canSubmit =
    reference.trim().length > 0
    && !createMut.isPending
    && (mode !== 'from_fini' || refFiniId > 0)
    && (mode !== 'duplicate' || currentId !== null)

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-lg max-h-[90dvh] overflow-y-auto" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BadgeEuro className="h-5 w-5 text-accent" />
            Nouvelle simulation
          </DialogTitle>
        </DialogHeader>

        <div className="mt-4 space-y-3">
          <div className="space-y-1.5">
            {modes.map((m) => {
              const Icon = m.icon
              const active = mode === m.key
              return (
                <button
                  key={m.key}
                  type="button"
                  disabled={m.disabled}
                  onClick={() => { setMode(m.key); setTouchedReference(false) }}
                  className={cn(
                    'w-full flex items-start gap-2.5 px-3 py-2.5 rounded-lg border text-left transition-colors',
                    active ? 'border-accent bg-accent/[0.06] ring-1 ring-accent' : 'border-border/60 bg-white hover:border-accent/40',
                    m.disabled && 'opacity-50 cursor-not-allowed hover:border-border/60',
                  )}
                >
                  <Icon className={cn('h-4 w-4 mt-0.5 flex-shrink-0', active ? 'text-accent' : 'text-muted-foreground')} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{m.label}</p>
                    <p className="text-[11px] text-muted-foreground leading-snug">{m.description}</p>
                  </div>
                </button>
              )
            })}
          </div>

          {mode === 'from_fini' && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Référence finie</label>
              <SearchableCombobox<RefFinieLookup>
                options={refsFinies ?? []}
                value={refFiniId}
                onChange={setRefFiniId}
                getId={(r) => r.IDref_fini}
                getPrimary={(r) => r.reference ?? `#${r.IDref_fini}`}
                getSecondary={(r) => r.designation}
                loading={refsLoading}
                placeholder="Rechercher une référence finie"
              />
            </div>
          )}

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Nom de la simulation</label>
            <input
              type="text"
              value={reference}
              onChange={(e) => { setReference(e.target.value); setTouchedReference(true) }}
              className="w-full h-9 px-3 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={() => { setError(null); createMut.mutate() }} disabled={!canSubmit}>
            {createMut.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Plus className="h-4 w-4 mr-1.5" />}
            Créer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
