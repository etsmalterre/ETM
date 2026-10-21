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
  Sparkles,
  Copy,
  FileInput,
  FilePlus2,
  Archive,
  ArchiveRestore,
  CheckCircle2,
  Calculator,
  Clock,
  FlaskConical,
  Building2,
  SlidersHorizontal,
  Info,
  RefreshCw,
  Truck,
  Ruler,
  TrendingDown,
  TrendingUp,
  Layers,
  MessageSquare,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
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

// Finis › Tarifs — the price SIMULATOR (legacy `FI_Tarifs.wdw`, reworked on
// LIVA #1298).
//
// Two jobs (Vincent, 2026-10-21):
//   • « Depuis un échantillon » — give a client we do R&D with a price before
//     going further: the sample's yarns arrive with today's purchase prices,
//     the rendement from its washed measures; the user sets knitting and
//     ennoblissement.
//   • « Depuis une référence client » — bring a reference's price down: the
//     study starts at the reference's exact catalogue price, and every lever
//     (yarn prices, frais de gestion on yarn, knitting, ennoblissement,
//     transport) shows its effect as a gain per tranche against the
//     catalogue AND against what the client really pays.
//
// Layout: « Classeur » (§39) — left: simulations; center: master tabs Tarif /
// Composition / Simulation libre; right: Leviers / Infos + the §29 status
// pill. While editing, the tarif is priced on the UNSAVED levers through
// `POST /tarifs-fini/:id/preview` (debounced); yarn lines and treatments
// persist as soon as they are edited (same model as sub-forms elsewhere).

// ── Types ──────────────────────────────────────────────

type StatusFilter = 'en_cours' | 'archive' | 'tous'
type PortMode = 'pct' | 'kg'
type TeintureMode = 'sans' | 'simple' | 'double'
type SourceKind = 'reference' | 'echantillon' | 'libre'
type Unite = 'Ml' | 'Kg'

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
  source_kind: SourceKind
  ref_fini: string | null
  client: string | null
  echantillon: string | null
  date_creation: string | null
}

interface TarifFil {
  IDasso_fil_tarif: number
  IDref_fil: number
  ref_label: string | null
  IDcolori_fil: number
  colori_label: string | null
  pourcentage: number
  /** Purchase €/Kg, without the frais de gestion. */
  prix_achat: number
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
  freinte: number
  ok_tarif: number
  date_creation: string | null
  source_kind: SourceKind
  IDref_fini: number
  ref_fini: string | null
  IDcoloris: number
  coloris: string | null
  IDclient: number
  client: string | null
  IDref_echantillon: number
  echantillon: string | null
  rendement: number
  poids_rouleau: number
  prix_tricotage: number
  port_mode: PortMode
  port_fixe: number
  port_pct: number
  mult_auto: boolean
  multiplicateur: number
  ajust_ennoblissement: number
  frais_gestion_fil: number
  gots: boolean
  IDteinture: number
  fils: TarifFil[]
  traitements: TarifTraitement[]
}

interface TarifDetailLine {
  label: string
  valueKg: number
  gestionKg?: number
}

interface TarifTranche {
  rolls: number
  isMetrage: boolean
  qte_ml: number
  qte_kg: number
  poids_ref: number
  moFil: number
  moGestionFil: number
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

interface PrixPair { ml: number; kg: number }

interface Comparaison {
  catalogue: { tranches: PrixPair[] } | null
  client: {
    mode: 'standard' | 'coefficient' | 'contrat'
    coefficient: number
    prix_unit: Unite
    contrat_debut: string | null
    contrat_fin: string | null
    contrat_expire: boolean
    note: string | null
    tranches: Array<PrixPair | null>
  } | null
}

interface FilLookup {
  IDref_fil: number
  reference: string | null
  prix_kg: number
  prix_achat: number
  coloris: Array<{ id: number; reference: string | null; prix_kg: number; prix_achat: number }>
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
  prix_gots: number
}

interface RefFinieLookup {
  IDref_fini: number
  reference: string | null
  designation: string | null
}

interface EchantillonLookup {
  IDref_echantillon: number
  numero: string
  statut: 'en_cours' | 'reference' | 'archive'
  client: string | null
  contexture: string | null
  commentaire: string | null
  nb_fils: number
  rendement: number
}

/** Everything the user can change on the levers / header. Kept as strings so
 *  half-typed numbers ("0.", "-") don't fight the input. */
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
  mult_auto: boolean
  /** Percentage points — the API stores a 0..1 ratio. */
  multiplicateur: string
  ajust_ennoblissement: string
  frais_gestion_fil: string
  gots: boolean
  IDteinture: number
  IDclient: number
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
 *  separators, no trailing zeros (`parseNum` accepts both separators). */
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
    mult_auto: d.mult_auto,
    multiplicateur: numToInput(Math.round(d.multiplicateur * 10000) / 100),
    ajust_ennoblissement: numToInput(d.ajust_ennoblissement),
    frais_gestion_fil: numToInput(d.frais_gestion_fil),
    gots: d.gots,
    IDteinture: d.IDteinture,
    IDclient: d.IDclient,
  }
}

/** The lever set the pricing preview takes. The rendement is sent RAW while
 *  its field is untouched: the catalogue rounds the raw stored value to 2 dp
 *  for the €/Ml, and its 4-dp display would round differently (2,6449999 vs
 *  2,645) — a study must start at the reference's exact price. */
function previewParams(draft: ParamsDraft, detail: TarifDetail) {
  const shown = numToInput(detail.rendement)
  return {
    rendement: draft.rendement === shown ? detail.rendement : parseNum(draft.rendement),
    poids_rouleau: parseNum(draft.poids_rouleau),
    prix_tricotage: parseNum(draft.prix_tricotage),
    port_mode: draft.port_mode,
    port_fixe: parseNum(draft.port_fixe),
    port_pct: parseNum(draft.port_pct),
    mult_auto: draft.mult_auto,
    multiplicateur: parseNum(draft.multiplicateur) / 100,
    ajust_ennoblissement: parseNum(draft.ajust_ennoblissement),
    frais_gestion_fil: parseNum(draft.frais_gestion_fil),
    gots: draft.gots,
    IDteinture: draft.IDteinture,
  }
}

/** Debounce a value — the preview is a real pricing run per change. */
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
  return { mode: t.simple_teinture === 1 ? 'simple' : 'double', shade: t.designation_interne ?? 'Tous Coloris' }
}

/** Inverse of `teintureModeOf`; falls back to the first dye of the level. */
function teintureIdFor(mode: TeintureMode, shade: string, teintures: TeintureLookup[]): number {
  if (mode === 'sans') return 0
  const wantSimple = mode === 'simple' ? 1 : 0
  const sameLevel = teintures.filter((t) => t.simple_teinture === wantSimple)
  const exact = sameLevel.find((t) => (t.designation_interne ?? '') === shade)
  return (exact ?? sameLevel[0])?.IDteinture ?? 0
}

/** MATEL's rendement grid (legacy `MultiplicateurMatel`, API
 *  lib/pricing-sst.ts) — shown next to the « Automatique » switch so the user
 *  sees which multiplier the catalogue applies. Display only: the API prices. */
function multiplicateurMatel(rendement: number): number {
  const bands: Array<[number, number]> = [
    [3, 1], [3.5, 1.02], [4, 1.03], [4.5, 1.04], [5, 1.05], [5.5, 1.11],
    [6, 1.17], [6.5, 1.24], [7, 1.32], [7.5, 1.41], [8, 1.5],
  ]
  for (const [seuil, m] of bands) if (rendement <= seuil) return m
  return 2
}

/** Gain over a baseline, in % of the baseline — positive = cheaper. */
function gainPct(base: number | null | undefined, simule: number): number | null {
  if (base == null || !(base > 0)) return null
  return Math.round(((base - simule) / base) * 1000) / 10
}

function frDate(iso: string | null): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return ''
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
}

function frDigits(d: string | null): string {
  return d && /^\d{8}$/.test(d) ? `${d.slice(6, 8)}/${d.slice(4, 6)}/${d.slice(0, 4)}` : ''
}

const SOURCE_META: Record<SourceKind, { label: string; icon: typeof Building2; classes: string }> = {
  reference: { label: 'Référence client', icon: Building2, classes: 'bg-primary/10 text-primary border-primary/25' },
  echantillon: { label: 'Échantillon', icon: FlaskConical, classes: 'bg-teal/10 text-teal border-teal/30' },
  libre: { label: 'Libre', icon: Calculator, classes: 'bg-stone-500/10 text-stone-700 border-stone-500/25' },
}

/** Category tag of a simulation's source (hue per kind, like §36). */
function SourceChip({ kind, size = 'sm' }: { kind: SourceKind; size?: 'sm' | 'md' }) {
  const m = SOURCE_META[kind]
  const Icon = m.icon
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded border font-medium whitespace-nowrap',
      size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs',
      m.classes,
    )}>
      <Icon className={size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3'} />{m.label}
    </span>
  )
}

function TeintureChip({ mode, shade, size = 'sm' }: { mode: TeintureMode; shade?: string | null; size?: 'sm' | 'md' }) {
  const classes =
    mode === 'sans'
      ? 'bg-stone-500/10 text-stone-700 border-stone-500/25'
      : mode === 'simple'
        ? 'bg-sky-500/10 text-sky-700 border-sky-500/25'
        : 'bg-violet-500/10 text-violet-700 border-violet-500/25'
  const label = mode === 'sans' ? 'Sans teinture' : `${mode === 'simple' ? 'Simple' : 'Double'}${shade ? ` · ${shade}` : ''}`
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded border font-medium whitespace-nowrap',
      size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-xs',
      classes,
    )}>
      <Droplet className={size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3'} />{label}
    </span>
  )
}

/** A gain as a coloured chip: green = cheaper than the baseline, red = dearer. */
function GainChip({ value, size = 'sm' }: { value: number | null; size?: 'sm' | 'lg' }) {
  if (value == null) return <span className="text-muted-foreground/60">—</span>
  const tone = value > 0.05
    ? 'bg-green-500/10 text-green-700 border-green-500/30'
    : value < -0.05
      ? 'bg-red-500/10 text-red-700 border-red-500/30'
      : 'bg-zinc-100 text-muted-foreground border-border'
  const Icon = value > 0.05 ? TrendingDown : value < -0.05 ? TrendingUp : null
  return (
    <span className={cn(
      'inline-flex items-center gap-1 rounded-md border font-semibold tabular-nums whitespace-nowrap',
      size === 'lg' ? 'px-2 py-0.5 text-sm' : 'px-1.5 py-0.5 text-xs',
      tone,
    )}>
      {Icon && <Icon className={size === 'lg' ? 'h-3.5 w-3.5' : 'h-3 w-3'} />}
      {value > 0 ? '−' : value < 0 ? '+' : ''}{fmtNum(Math.abs(value), 1)} %
    </span>
  )
}

const BLOCKER_LABEL: Record<string, string> = {
  rendement: 'le rendement (Ml/Kg)',
  poids_rouleau: 'le poids d’un rouleau (Kg)',
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
    if (q) {
      rows = rows.filter((t) =>
        [t.reference, t.ref_fini, t.client, t.echantillon].some((v) => (v ?? '').toLowerCase().includes(q)))
    }
    return rows
  }, [tarifs, searchQuery, statusFilter])

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
    queryClient.invalidateQueries({ queryKey: ['tarif-fini-comparaison', selectedId] })
  }, [queryClient, selectedId])

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!draft || !detail) throw new Error('Aucune modification à enregistrer')
      return apiFetch(`/tarifs-fini/${selectedId}`, {
        method: 'PUT',
        body: JSON.stringify({
          ...previewParams(draft, detail),
          reference: draft.reference.trim() || 'Simulation',
          commentaire: draft.commentaire,
          laize: parseNum(draft.laize),
          poids: parseNum(draft.poids),
          freinte: parseNum(draft.freinte) / 100,
          IDclient: draft.IDclient,
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

  const duplicateMutation = useMutation({
    mutationFn: () =>
      apiFetch('/tarifs-fini', {
        method: 'POST',
        body: JSON.stringify({ mode: 'duplicate', source_id: selectedId, reference: `${detail?.reference ?? 'Simulation'} (scénario)` }),
      }) as Promise<TarifDetail>,
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['tarifs-fini'] })
      if (statusFilter === 'archive') setStatusFilter('en_cours')
      setSelectedId(created.IDref_tarif)
      setAutoEditForId(created.IDref_tarif)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/tarifs-fini/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, deletedId) => {
      // Read the cache BEFORE invalidating (§25.2).
      const cached = queryClient.getQueryData<TarifListRow[]>(['tarifs-fini']) ?? []
      const remaining = cached
        .filter((t) => t.IDref_tarif !== deletedId)
        .filter((t) => (statusFilter === 'en_cours' ? t.ok_tarif !== 1 : statusFilter === 'archive' ? t.ok_tarif === 1 : true))
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

  // In edit mode the tarif prices the draft; otherwise the saved row.
  const effectiveParams = useMemo(() => {
    if (!detail) return null
    return previewParams(isEditing && draft ? draft : draftFromDetail(detail), detail)
  }, [isEditing, draft, detail])

  // The client the comparison is priced for — the draft's while editing.
  const comparisonClient = isEditing && draft ? draft.IDclient : (detail?.IDclient ?? 0)

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
            onDuplicate={() => duplicateMutation.mutate()}
            isDuplicating={duplicateMutation.isPending}
            teintures={teintures ?? []}
          />
        }
        detail={
          <DetailMain
            detail={detail ?? null}
            isLoading={detailLoading && selectedId !== null}
            hasSelection={selectedId !== null}
            isEditing={isEditing}
            params={effectiveParams}
            comparisonClient={comparisonClient}
            onMutationSuccess={invalidateAll}
            onSubFormsDirtyChange={setSubFormsDirty}
          />
        }
        sidebar={
          selectedId !== null && detail ? (
            <DetailSidebar
              detail={detail}
              isEditing={isEditing}
              draft={draft}
              onDraftChange={setDraft}
              teintures={teintures ?? []}
              onMutationSuccess={invalidateAll}
              onToggleArchive={() => archiveMutation.mutate(detail.ok_tarif === 1 ? 0 : 1)}
              isArchiving={archiveMutation.isPending}
            />
          ) : null
        }
        sidebarTitle="Leviers"
        hasSelection={selectedId !== null}
        onBack={() => guard.guardAction(() => { cancelEdit(); setSelectedId(null) })}
      />

      <UnsavedChangesDialog open={guard.showDialog} onAction={guard.handleAction} isSaving={guard.isSaving} />

      <CreateTarifDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(newId) => {
          setCreateOpen(false)
          queryClient.invalidateQueries({ queryKey: ['tarifs-fini'] })
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
            placeholder="Simulation, référence, client…"
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
          tarifs.map((t) => {
            const origine = t.source_kind === 'reference'
              ? [t.ref_fini, t.client].filter(Boolean).join(' · ')
              : t.source_kind === 'echantillon'
                ? [t.echantillon, t.client].filter(Boolean).join(' · ')
                : null
            return (
              <div
                key={t.IDref_tarif}
                onClick={() => onSelect(t.IDref_tarif)}
                className={cn(
                  'p-3 border rounded-lg cursor-pointer transition-all',
                  selectedId === t.IDref_tarif
                    ? 'border-accent bg-white ring-1 ring-accent'
                    : 'border-border bg-white hover:border-accent/50',
                )}
              >
                <div className="flex items-center gap-2">
                  <FiniRollIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  <p className="font-medium text-sm truncate flex-1">{t.reference || `Simulation #${t.IDref_tarif}`}</p>
                  {t.ok_tarif === 1 && <Archive className="h-3 w-3 text-muted-foreground flex-shrink-0" />}
                </div>
                <div className="flex items-center gap-1.5 mt-1.5 ml-6 flex-wrap">
                  <SourceChip kind={t.source_kind} />
                  {origine && <span className="text-[11px] text-muted-foreground truncate max-w-[150px]" title={origine}>{origine}</span>}
                </div>
                <div className="flex items-center gap-1.5 mt-1 ml-6 text-[11px] text-muted-foreground">
                  <span className="truncate">
                    {t.teinture_mode === 'sans' ? 'Sans teinture' : t.teinture_mode === 'simple' ? 'Simple teinture' : 'Double teinture'}
                    {t.fils_count > 0 ? ` · ${t.fils_count} fil${t.fils_count > 1 ? 's' : ''}` : ''}
                  </span>
                  {t.date_creation && <span className="ml-auto flex-shrink-0 tabular-nums">{frDate(t.date_creation)}</span>}
                </div>
              </div>
            )
          })
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
  onStartEdit, onCancelEdit, onSave, isSaving, onDelete, onDuplicate, isDuplicating, teintures,
}: {
  detail: TarifDetail | null; isLoading: boolean; isEditing: boolean
  reference: string; onReferenceChange: (v: string) => void
  onStartEdit: () => void; onCancelEdit: () => void; onSave: () => void; isSaving: boolean
  onDelete: () => void; onDuplicate: () => void; isDuplicating: boolean; teintures: TeintureLookup[]
}) {
  if (!detail && !isLoading) return null
  const teint = detail ? teintureModeOf(detail.IDteinture, teintures) : null
  const origine = detail
    ? detail.source_kind === 'reference'
      ? [detail.ref_fini, detail.coloris, detail.client].filter(Boolean).join(' · ')
      : detail.source_kind === 'echantillon'
        ? [detail.echantillon, detail.client].filter(Boolean).join(' · ')
        : null
    : null
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
                  <SourceChip kind={detail.source_kind} size="md" />
                  {origine && <span className="text-xs text-muted-foreground truncate max-w-[320px]" title={origine}>{origine}</span>}
                  <TeintureChip mode={teint.mode} shade={teint.mode === 'sans' ? null : teint.shade} size="md" />
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
                  {isSaving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
                  Enregistrer
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  title="Nouveau scénario : copie de cette simulation, à modifier"
                  onClick={onDuplicate}
                  disabled={isDuplicating}
                >
                  {isDuplicating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
                </Button>
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

// ── Shared bits ────────────────────────────────────────

/** Label above a compact numeric field, with an optional unit suffix inside. */
function FieldNum({
  label, value, unit, onChange, disabled, hint, onBlur,
}: {
  label: string; value: string; unit?: string; onChange: (v: string) => void; disabled: boolean
  hint?: string; onBlur?: () => void
}) {
  return (
    <div className="space-y-1 min-w-0">
      <label className="text-xs font-medium text-muted-foreground truncate block" title={hint}>{label}</label>
      <div className="relative">
        <input
          type="text"
          inputMode="decimal"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          className={cn(inputClass, 'tabular-nums disabled:bg-muted/40 disabled:text-foreground', unit && 'pr-11')}
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

/** §35 inline switch. */
function Switch({ value, onChange, disabled, title }: { value: boolean; onChange: (v: boolean) => void; disabled: boolean; title?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!value)}
      className={cn(
        'relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        value ? 'bg-accent shadow-inner' : 'bg-zinc-300 hover:bg-zinc-400/80',
      )}
    >
      <span className={cn(
        'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ease-out',
        value ? 'translate-x-[18px]' : 'translate-x-0.5',
      )} />
    </button>
  )
}

/** A spec tile (Finis › Références grammar): caption on top, the figure big. */
function Tile({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('rounded-lg border border-border/60 bg-zinc-100/80 px-3 py-2.5 min-w-0', className)}>
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold truncate">{label}</p>
      <div className="mt-1">{children}</div>
    </div>
  )
}

function TileFigure({ value, unit, tone }: { value: string; unit?: string; tone?: string }) {
  return (
    <span className={cn('text-2xl font-bold tabular-nums leading-none', tone)}>
      {value}{unit && <span className="text-xs text-muted-foreground font-normal ml-1">{unit}</span>}
    </span>
  )
}

// ── Center: Detail Main (Classeur) ─────────────────────

const MAIN_TABS = [
  { key: 'tarif', label: 'Tarif', icon: BadgeEuro },
  { key: 'composition', label: 'Composition', icon: Layers },
  { key: 'libre', label: 'Simulation libre', icon: Calculator },
] as const
type MainTab = (typeof MAIN_TABS)[number]['key']

function DetailMain({
  detail, isLoading, hasSelection, isEditing, params, comparisonClient, onMutationSuccess, onSubFormsDirtyChange,
}: {
  detail: TarifDetail | null; isLoading: boolean; hasSelection: boolean; isEditing: boolean
  params: ReturnType<typeof previewParams> | null
  comparisonClient: number
  onMutationSuccess: () => void
  onSubFormsDirtyChange: (dirty: boolean) => void
}) {
  const [activeTab, setActiveTab] = useState<MainTab>('tarif')
  const [libreApplied, setLibreApplied] = useState<{ poids: number; coefficient?: number; prix_cible_ml?: number } | null>(null)
  const tarifId = detail?.IDref_tarif ?? null
  useEffect(() => { setActiveTab('tarif'); setLibreApplied(null) }, [tarifId])

  // Debounced while editing so moving a lever doesn't fire a request per
  // keystroke. The KEY is what gets debounced and the body is parsed back out
  // of it, so the cache entry can never disagree with what was priced.
  const paramsKey = useDebounced(params ? JSON.stringify(params) : null, isEditing ? 350 : 0)
  const libreKey = libreApplied ? JSON.stringify(libreApplied) : null
  const { data: tarif, isLoading: tarifLoading, isError: tarifError, isFetching } = useQuery<TarifResult>({
    queryKey: ['tarif-fini-calc', tarifId, paramsKey, libreKey],
    queryFn: () =>
      apiFetch(`/tarifs-fini/${tarifId}/preview`, {
        method: 'POST',
        body: JSON.stringify({ params: paramsKey ? JSON.parse(paramsKey) : undefined, libre: libreApplied ?? undefined }),
      }),
    enabled: tarifId !== null && paramsKey !== null,
    placeholderData: (prev) => prev,
  })

  const hasReference = (detail?.IDref_fini ?? 0) > 0
  const { data: comparaison } = useQuery<Comparaison>({
    queryKey: ['tarif-fini-comparaison', tarifId, comparisonClient],
    queryFn: () => apiFetch(`/tarifs-fini/${tarifId}/comparaison?client=${comparisonClient}`),
    enabled: tarifId !== null && hasReference,
    placeholderData: (prev) => prev,
  })

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

  const counts: Partial<Record<MainTab, number>> = { composition: detail.fils.length + detail.traitements.length }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-shrink-0 flex items-center gap-1 border-b border-border/60 pb-2">
        {MAIN_TABS.map((t) => {
          const Icon = t.icon
          const active = activeTab === t.key
          const count = counts[t.key]
          return (
            <button key={t.key} type="button" onClick={() => setActiveTab(t.key)}
              className={cn('flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap',
                active ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10 hover:text-accent')}>
              <Icon className="h-3.5 w-3.5" />{t.label}
              {count != null && <span className="text-xs tabular-nums opacity-70">{count}</span>}
            </button>
          )
        })}
        {isEditing && (
          <span className="ml-auto flex items-center gap-1.5 text-[11px] text-accent pr-1">
            {isFetching ? <Loader2 className="h-3 w-3 animate-spin" /> : <Pencil className="h-3 w-3" />}
            Tarif calculé sur les leviers en cours de saisie
          </span>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-auto space-y-3 pt-3 px-1 pb-1 scrollbar-transparent">
        {tarifLoading && !tarif ? (
          <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
        ) : tarifError ? (
          <p className="text-sm text-destructive">Erreur lors du calcul du tarif.</p>
        ) : activeTab === 'tarif' ? (
          <TarifTab detail={detail} tarif={tarif ?? null} comparaison={hasReference ? comparaison ?? null : null} />
        ) : activeTab === 'composition' ? (
          <CompositionTab
            detail={detail}
            isEditing={isEditing}
            tranche={tarif?.tranches[1] ?? null}
            onMutationSuccess={onMutationSuccess}
            onDirtyChange={onSubFormsDirtyChange}
          />
        ) : (
          <LibreTab tarif={tarif ?? null} onApply={setLibreApplied} />
        )}
      </div>
    </div>
  )
}

// ── Tarif tab: the comparison ──────────────────────────

function TarifTab({ detail, tarif, comparaison }: { detail: TarifDetail; tarif: TarifResult | null; comparaison: Comparaison | null }) {
  const [selected, setSelected] = useState(1)
  const clientUnit = comparaison?.client?.prix_unit ?? 'Ml'
  const [unit, setUnit] = useState<Unite>(clientUnit)
  useEffect(() => { setUnit(clientUnit); setSelected(1) }, [detail.IDref_tarif, clientUnit])

  const tranches = tarif?.tranches ?? []
  if (tranches.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <BadgeEuro className="h-12 w-12 mb-3 opacity-40" />
        <p className="text-sm">
          {tarif && tarif.blockers.length > 0
            ? `Renseignez ${tarif.blockers.map((b) => BLOCKER_LABEL[b] ?? b).join(' et ')} dans les leviers pour calculer le tarif.`
            : 'Tarif indisponible.'}
        </p>
      </div>
    )
  }

  const pick = (p: PrixPair | null | undefined) => (p ? (unit === 'Ml' ? p.ml : p.kg) : null)
  const simAt = (t: TarifTranche) => (unit === 'Ml' ? t.moPrixDeVenteAuMl : t.moPrixDeVenteAuKg)
  const catalogue = comparaison?.catalogue?.tranches ?? null
  const client = comparaison?.client ?? null
  const withComparison = catalogue !== null
  const current = tranches[Math.min(selected, tranches.length - 1)]
  const iCur = Math.min(selected, tranches.length - 1)
  const catCur = pick(catalogue?.[iCur])
  const cliCur = pick(client?.tranches[iCur])
  const simCur = simAt(current)

  return (
    <>
      {/* Headline: the selected tranche, simulated vs baselines */}
      <div className={cn('grid gap-2', withComparison ? (client ? 'grid-cols-2 lg:grid-cols-4' : 'grid-cols-2 lg:grid-cols-3') : 'grid-cols-2 lg:grid-cols-4')}>
        <Tile label={`Prix simulé · ${current.isMetrage ? '< 1 rouleau' : `${current.rolls} rouleau${current.rolls > 1 ? 'x' : ''}`}`}>
          <TileFigure value={fmtNum(simCur, 2)} unit={`€/${unit}`} tone="text-accent" />
        </Tile>
        {withComparison ? (
          <>
            <Tile label="Prix catalogue">
              <div className="flex items-baseline gap-2 flex-wrap">
                <TileFigure value={catCur != null ? fmtNum(catCur, 2) : '—'} unit={`€/${unit}`} />
                <GainChip value={gainPct(catCur, simCur)} />
              </div>
            </Tile>
            {client && (
              <Tile label={`Prix client · ${client.mode === 'contrat' ? 'contrat' : client.mode === 'coefficient' ? `coef. ${fmtNum(client.coefficient)} %` : 'standard'}`}>
                <div className="flex items-baseline gap-2 flex-wrap">
                  <TileFigure value={cliCur != null ? fmtNum(cliCur, 2) : '—'} unit={`€/${unit}`} />
                  <GainChip value={gainPct(cliCur, simCur)} />
                </div>
              </Tile>
            )}
          </>
        ) : (
          <>
            <Tile label="Prix de revient"><TileFigure value={fmtNum(current.moRevient, 2)} unit="€/Kg" /></Tile>
            <Tile label="Marge"><TileFigure value={fmtNum(current.rCoeff * 100, 0)} unit="%" /></Tile>
          </>
        )}
        <Tile label="Rendement">
          <TileFigure value={fmtNum(tarif?.rendement_calcul ?? 0, 2)} unit="Ml/Kg" />
        </Tile>
      </div>

      {withComparison && (
        <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
          <TrendingDown className="h-3.5 w-3.5 flex-shrink-0 text-green-700" />
          Écart du prix simulé : en vert, moins cher que la référence comparée (le gain pour le client) ; en rouge, plus cher.
        </p>
      )}
      {client?.note && (
        <p className={cn('text-[11px] flex items-start gap-1.5', client.contrat_expire ? 'text-destructive' : 'text-muted-foreground')}>
          <Info className="h-3.5 w-3.5 flex-shrink-0 mt-px" />{client.note}
        </p>
      )}
      {client?.mode === 'contrat' && !client.contrat_expire && client.contrat_fin && (
        <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
          <Info className="h-3.5 w-3.5 flex-shrink-0" />
          Contrat du {frDigits(client.contrat_debut)} au {frDigits(client.contrat_fin)} — prix négociés en €/{client.prix_unit}.
        </p>
      )}

      {/* Tranche table */}
      <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border/60 bg-zinc-200/50">
          <p className="text-xs font-semibold flex items-center gap-1.5"><BadgeEuro className="h-3.5 w-3.5 text-accent" />Tarif par tranche</p>
          <div className="w-32">
            <Segmented<Unite> value={unit} onChange={setUnit} disabled={false} options={[{ key: 'Ml', label: '€ / Ml' }, { key: 'Kg', label: '€ / Kg' }]} />
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-zinc-100/80 border-b border-border/60 text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Quantité</th>
                {withComparison ? (
                  <>
                    <th className="px-3 py-2 text-right font-semibold">Catalogue</th>
                    {client && <th className="px-3 py-2 text-right font-semibold">Client</th>}
                    <th className="px-3 py-2 text-right font-semibold">Simulé</th>
                    <th className="px-3 py-2 text-right font-semibold">Écart / catalogue</th>
                    {client && <th className="px-3 py-2 text-right font-semibold">Écart / client</th>}
                  </>
                ) : (
                  <>
                    <th className="px-3 py-2 text-right font-semibold">Revient</th>
                    <th className="px-3 py-2 text-right font-semibold">Marge</th>
                    <th className="px-3 py-2 text-right font-semibold">Prix de vente</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {tranches.map((t, i) => {
                const sim = simAt(t)
                const cat = pick(catalogue?.[i])
                const cli = pick(client?.tranches[i])
                return (
                  <tr
                    key={i}
                    onClick={() => setSelected(i)}
                    className={cn(
                      'border-b border-border/40 last:border-b-0 cursor-pointer transition-colors',
                      selected === i ? 'bg-accent/10' : 'hover:bg-accent/5',
                    )}
                  >
                    <td className="px-3 py-1.5 whitespace-nowrap">
                      <span className="font-medium tabular-nums">{t.isMetrage ? '< 1' : t.rolls} rlx</span>
                      <span className="text-xs text-muted-foreground tabular-nums ml-2">
                        {t.isMetrage ? '< ' : ''}{unit === 'Ml' ? `${fmtNum(t.qte_ml)} Ml` : `${fmtNum(t.qte_kg)} Kg`}
                      </span>
                    </td>
                    {withComparison ? (
                      <>
                        <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{cat != null ? `${fmtNum(cat, 2)} €` : '—'}</td>
                        {client && <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{cli != null ? `${fmtNum(cli, 2)} €` : '—'}</td>}
                        <td className="px-3 py-1.5 text-right tabular-nums font-semibold">{fmtNum(sim, 2)} €</td>
                        <td className="px-3 py-1.5 text-right"><GainChip value={gainPct(cat, sim)} /></td>
                        {client && <td className="px-3 py-1.5 text-right"><GainChip value={gainPct(cli, sim)} /></td>}
                      </>
                    ) : (
                      <>
                        <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{fmtNum(t.moRevient, 2)} €/Kg</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{fmtNum(t.rCoeff * 100, 0)} %</td>
                        <td className="px-3 py-1.5 text-right tabular-nums font-semibold">{fmtNum(sim, 2)} €</td>
                      </>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <PriceStructure tranche={current} />
      <TrancheBreakdown tranche={current} fraisGestion={detail.frais_gestion_fil} />
    </>
  )
}

/** One horizontal bar: where each € of the €/Kg sale price goes. */
function PriceStructure({ tranche }: { tranche: TarifTranche }) {
  const vente = tranche.moPrixDeVenteAuKg
  if (!(vente > 0)) return null
  const achatFil = tranche.moFil - tranche.moGestionFil
  const ennob = tranche.moTraitements + tranche.moTeinte
  const marge = Math.max(0, vente - tranche.moRevient - tranche.moPortAuKg)
  const parts = [
    { key: 'fil', label: 'Fil (achat)', value: achatFil, cls: 'bg-primary' },
    { key: 'gestion', label: 'Gestion fil', value: tranche.moGestionFil, cls: 'bg-primary/40' },
    { key: 'tric', label: 'Tricotage', value: tranche.moTricotage, cls: 'bg-teal' },
    { key: 'ennob', label: 'Ennoblissement', value: ennob, cls: 'bg-terracotta' },
    { key: 'port', label: 'Transport', value: tranche.moPortAuKg, cls: 'bg-zinc-400' },
    { key: 'marge', label: 'Marge', value: marge, cls: 'bg-gold' },
  ].filter((p) => p.value > 0.004)
  return (
    <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3 space-y-2">
      <p className="text-xs font-semibold flex items-center gap-1.5">
        <SlidersHorizontal className="h-3.5 w-3.5 text-accent" />Structure du prix
        <span className="ml-auto text-[11px] font-normal text-muted-foreground tabular-nums">{fmtNum(vente, 2)} €/Kg</span>
      </p>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-zinc-100">
        {parts.map((p) => (
          <div key={p.key} className={cn('h-full', p.cls)} style={{ width: `${(p.value / vente) * 100}%` }} title={`${p.label} : ${fmtNum(p.value, 2)} €/Kg`} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {parts.map((p) => (
          <span key={p.key} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className={cn('h-2 w-2 rounded-full', p.cls)} />
            {p.label}
            <span className="tabular-nums text-foreground/80">{fmtNum(p.value, 2)} €</span>
            <span className="tabular-nums">({fmtNum((p.value / vente) * 100, 0)} %)</span>
          </span>
        ))}
      </div>
    </div>
  )
}

/** Gold-banded cost-component header with its €/Kg total — same rendering as
 *  the Finis › Références tarif tab. */
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

function CostLine({ label, value, sub }: { label: string; value: string; sub?: boolean }) {
  return (
    <div className={cn('flex items-start justify-between gap-2 text-[11px] leading-snug', sub && 'pl-3 italic')}>
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground/80 flex-shrink-0 whitespace-nowrap">{value}</span>
    </div>
  )
}

function TrancheBreakdown({ tranche, fraisGestion }: { tranche: TarifTranche; fraisGestion: number }) {
  const eurKg = (v: number) => `${fmtNum(v, 2)} €/Kg`
  return (
    <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3 space-y-2.5">
      <p className="text-xs font-semibold flex items-center gap-1.5">
        <Calculator className="h-3.5 w-3.5 text-accent" />Détail du prix
        <span className="ml-auto text-[11px] font-normal text-muted-foreground">
          {tranche.isMetrage ? '< 1 rouleau' : `${tranche.rolls} rouleau${tranche.rolls > 1 ? 'x' : ''}`} · {fmtNum(tranche.poids_ref)} Kg traités
        </span>
      </p>
      <CostSection title="Fil" total={eurKg(tranche.moFil)}>
        {tranche.detailFil.length > 0 ? (
          <>
            {tranche.detailFil.map((l, i) => <CostLine key={i} label={l.label} value={eurKg(l.valueKg)} />)}
            {tranche.moGestionFil > 0 && (
              <CostLine sub label={`dont frais de gestion fil (${fmtNum(fraisGestion, 1)} % sur l’achat)`} value={eurKg(tranche.moGestionFil)} />
            )}
          </>
        ) : (
          <p className="text-[11px] text-muted-foreground italic">Aucun fil</p>
        )}
      </CostSection>
      <CostSection title="Tricotage" total={eurKg(tranche.moTricotage)}>
        {tranche.detailTricotage && <CostLine label={tranche.detailTricotage.label} value={eurKg(tranche.detailTricotage.valueKg)} />}
      </CostSection>
      <CostSection title="Traitement" total={eurKg(tranche.moTraitements)}>
        {tranche.detailTraitement.length > 0
          ? tranche.detailTraitement.map((l, i) => <CostLine key={i} label={l.label} value={eurKg(l.valueKg)} />)
          : <p className="text-[11px] text-muted-foreground italic">Aucun traitement</p>}
      </CostSection>
      {tranche.detailTeinture && (
        <CostSection title="Teinture" total={eurKg(tranche.moTeinte)}>
          <CostLine label={tranche.detailTeinture.label} value={eurKg(tranche.detailTeinture.valueKg)} />
        </CostSection>
      )}
      <CostSection title="Prix de vente">
        <CostLine label="Prix de revient au Kg" value={eurKg(tranche.moRevient)} />
        <CostLine label="Marge" value={`${Math.round(tranche.rCoeff * 100)} %`} />
        <CostLine
          label={tranche.tauxFraisDePort > 0
            ? `Prix de vente au Kg · ${fmtNum(tranche.moPortAuKg, 2)} € de port (${fmtNum(tranche.tauxFraisDePort * 100, 1)} %) inclus`
            : `Prix de vente au Kg · ${fmtNum(tranche.moPortAuKg, 2)} € de port inclus`}
          value={`${fmtNum(tranche.moPrixDeVenteAuKg, 2)} €/Kg`}
        />
        <CostLine
          label={tranche.tauxFraisDePort > 0
            ? `Prix de vente au Ml · ${fmtNum(tranche.moPortAuMl, 2)} € de port (${fmtNum(tranche.tauxFraisDePort * 100, 1)} %) inclus`
            : `Prix de vente au Ml · ${fmtNum(tranche.moPortAuMl, 2)} € de port inclus`}
          value={`${fmtNum(tranche.moPrixDeVenteAuMl, 2)} €/Ml`}
        />
      </CostSection>
    </div>
  )
}

// ── Composition tab ────────────────────────────────────

interface FilFormState {
  IDref_fil: number
  IDcolori_fil: number
  pourcentage: string
  prix_achat: string
}

const EMPTY_FIL_FORM: FilFormState = { IDref_fil: 0, IDcolori_fil: 0, pourcentage: '', prix_achat: '' }

function CompositionTab({
  detail, isEditing, tranche, onMutationSuccess, onDirtyChange,
}: {
  detail: TarifDetail; isEditing: boolean; tranche: TarifTranche | null
  onMutationSuccess: () => void; onDirtyChange: (dirty: boolean) => void
}) {
  const queryClient = useQueryClient()
  const { data: fils } = useFilsLookup()
  const { data: traitements } = useTraitementsLookup()
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<FilFormState>(EMPTY_FIL_FORM)
  const [deleteTarget, setDeleteTarget] = useState<TarifFil | null>(null)
  const [deleteTrt, setDeleteTrt] = useState<TarifTraitement | null>(null)

  // Surface "a sub-form is open" to the page's unsaved guard (§28.3.a).
  const onDirtyChangeRef = useRef(onDirtyChange)
  useEffect(() => { onDirtyChangeRef.current = onDirtyChange })
  useEffect(() => { onDirtyChangeRef.current(formOpen) }, [formOpen])
  useEffect(() => () => { onDirtyChangeRef.current(false) }, [])
  useEffect(() => { if (!isEditing) { setFormOpen(false); setEditingId(null) } }, [isEditing])

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['tarif-fini', detail.IDref_tarif] })
    onMutationSuccess()
  }, [queryClient, detail.IDref_tarif, onMutationSuccess])

  const saveFil = useMutation({
    mutationFn: ({ lineId, body }: { lineId: number | null; body: unknown }) =>
      lineId !== null
        ? apiFetch(`/tarifs-fini/${detail.IDref_tarif}/fils/${lineId}`, { method: 'PUT', body: JSON.stringify(body) })
        : apiFetch(`/tarifs-fini/${detail.IDref_tarif}/fils`, { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => { invalidate(); setFormOpen(false); setEditingId(null); setForm(EMPTY_FIL_FORM) },
  })
  const deleteFil = useMutation({
    mutationFn: (lineId: number) => apiFetch(`/tarifs-fini/${detail.IDref_tarif}/fils/${lineId}`, { method: 'DELETE' }),
    onSuccess: () => { invalidate(); setDeleteTarget(null) },
  })
  const refreshPrices = useMutation({
    mutationFn: () => apiFetch(`/tarifs-fini/${detail.IDref_tarif}/fils/actualiser`, { method: 'POST' }),
    onSuccess: invalidate,
  })
  const addTrt = useMutation({
    mutationFn: (IDtraitement: number) =>
      apiFetch(`/tarifs-fini/${detail.IDref_tarif}/traitements`, { method: 'POST', body: JSON.stringify({ IDtraitement }) }),
    onSuccess: invalidate,
  })
  const deleteTrtMut = useMutation({
    mutationFn: (lineId: number) => apiFetch(`/tarifs-fini/${detail.IDref_tarif}/traitements/${lineId}`, { method: 'DELETE' }),
    onSuccess: () => { invalidate(); setDeleteTrt(null) },
  })

  const gestion = detail.frais_gestion_fil
  const totalPct = detail.fils.reduce((s, f) => s + f.pourcentage, 0)
  const totalOk = Math.abs(totalPct - 100) < 0.01

  const openAdd = () => { setEditingId(null); setForm(EMPTY_FIL_FORM); setFormOpen(true) }
  const openEdit = (f: TarifFil) => {
    setForm({ IDref_fil: f.IDref_fil, IDcolori_fil: f.IDcolori_fil, pourcentage: numToInput(f.pourcentage), prix_achat: numToInput(f.prix_achat) })
    setEditingId(f.IDasso_fil_tarif)
    setFormOpen(true)
  }
  const submit = () => {
    if (form.IDref_fil <= 0) return
    saveFil.mutate({
      lineId: editingId,
      body: { IDref_fil: form.IDref_fil, IDcolori_fil: form.IDcolori_fil, pourcentage: parseNum(form.pourcentage), prix_achat: parseNum(form.prix_achat) },
    })
  }

  return (
    <>
      {/* Yarns */}
      <div className={cn('rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden', isEditing && editSectionClass)}>
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60 bg-zinc-200/50">
          <BobineIcon className="h-4 w-4 text-accent" />
          <p className="text-sm font-semibold">Fils</p>
          <Badge
            variant="outline"
            className={cn('text-xs tabular-nums', totalOk ? 'text-green-700 border-green-500/40 bg-green-500/10' : 'text-amber-800 border-amber-500/40 bg-amber-500/10')}
            title={totalOk ? 'La composition totalise 100 %' : 'La composition ne totalise pas 100 %'}
          >
            {fmtNum(totalPct, 2)} %
          </Badge>
          {isEditing && detail.fils.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-7 text-xs text-muted-foreground hover:text-accent"
              onClick={() => refreshPrices.mutate()}
              disabled={refreshPrices.isPending}
              title="Reprendre le prix d’achat du jour de chaque fil (Fils › Références)"
            >
              {refreshPrices.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
              Prix fil du jour
            </Button>
          )}
        </div>
        {detail.fils.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <BobineIcon className="h-12 w-12 mb-3 opacity-40" />
            <p className="text-sm">Aucun fil</p>
            {isEditing && (
              <Button variant="outline" size="sm" className="mt-3" onClick={openAdd}>
                <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter un fil
              </Button>
            )}
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-zinc-100/80 border-b border-border/60 text-[10px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Fil</th>
                <th className="px-3 py-2 text-right font-semibold">%</th>
                <th className="px-3 py-2 text-right font-semibold">Achat</th>
                <th className="px-3 py-2 text-right font-semibold">+ Gestion {fmtNum(gestion, 1)} %</th>
                <th className="px-3 py-2 text-right font-semibold">Coût / Kg tissu</th>
                {isEditing && <th className="w-8" />}
              </tr>
            </thead>
            <tbody>
              {detail.fils.map((f) => {
                const prixKg = Math.round(f.prix_achat * (1 + gestion / 100) * 10000) / 10000
                return (
                  <tr
                    key={f.IDasso_fil_tarif}
                    onClick={isEditing ? () => openEdit(f) : undefined}
                    className={cn('group border-b border-border/40 last:border-b-0', isEditing && 'cursor-pointer hover:bg-accent/5')}
                  >
                    <td className="px-3 py-1.5 min-w-0">
                      <p className="truncate font-medium" title={f.ref_label ?? undefined}>{f.ref_label || `#${f.IDref_fil}`}</p>
                      {f.colori_label && <p className="text-[11px] text-muted-foreground truncate">{f.colori_label}</p>}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtNum(f.pourcentage, 2)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtNum(f.prix_achat, 2)} €</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">{fmtNum(prixKg, 2)} €</td>
                    <td className="px-3 py-1.5 text-right tabular-nums font-semibold">{fmtNum((prixKg * f.pourcentage) / 100, 2)} €</td>
                    {isEditing && (
                      <td className="px-1 py-1.5 text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-destructive hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={(e) => { e.stopPropagation(); setDeleteTarget(f) }}
                          title="Retirer ce fil"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
            {tranche && (
              <tfoot className="bg-zinc-100/80 border-t border-border/60 text-xs">
                <tr>
                  <td className="px-3 py-1.5 text-muted-foreground" colSpan={4}>
                    Coût matière{tranche.moGestionFil > 0 ? ` — dont ${fmtNum(tranche.moGestionFil, 2)} € de frais de gestion` : ''}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums font-semibold">{fmtNum(tranche.moFil, 2)} €/Kg</td>
                  {isEditing && <td />}
                </tr>
              </tfoot>
            )}
          </table>
        )}
        {isEditing && detail.fils.length > 0 && (
          <div className="p-2 border-t border-border/40">
            <Button
              variant="ghost"
              size="sm"
              onClick={openAdd}
              className="w-full text-muted-foreground hover:text-accent hover:bg-accent/5 border border-dashed border-border/60 hover:border-accent/40"
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter un fil
            </Button>
          </div>
        )}
      </div>
      {!totalOk && detail.fils.length > 0 && (
        <p className="text-[11px] text-amber-800">
          La composition totalise {fmtNum(totalPct, 2)} % — le coût matière est calculé au prorata saisi.
        </p>
      )}

      {/* Treatments */}
      <div className={cn('rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden', isEditing && editSectionClass)}>
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border/60 bg-zinc-200/50">
          <Sparkles className="h-4 w-4 text-accent" />
          <p className="text-sm font-semibold">Traitements</p>
          <Badge variant="secondary" className="text-xs">{detail.traitements.length}</Badge>
          <span className="ml-auto text-[11px] text-muted-foreground">Teinture, multiplicateur et ajustement : onglet Leviers</span>
        </div>
        <div className="p-3 space-y-2.5">
          {detail.traitements.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">Aucun traitement</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {detail.traitements.map((t, i) => {
                const l = tranche?.detailTraitement[i]
                return (
                  <Badge key={t.IDasso_traitement_tarif} className="bg-accent/10 text-accent hover:bg-accent/20 border-accent/20 gap-1.5">
                    {t.designation ?? `#${t.IDtraitement}`}
                    {l && <span className="tabular-nums font-normal opacity-80">{fmtNum(l.valueKg, 2)} €/Kg</span>}
                    {isEditing && (
                      <button
                        type="button"
                        onClick={() => setDeleteTrt(t)}
                        className="ml-0.5 rounded-full hover:bg-destructive/20 hover:text-destructive p-0.5 -mr-1 transition-colors"
                        title="Retirer ce traitement"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </Badge>
                )
              })}
            </div>
          )}
          {isEditing && (
            <div className="flex items-center gap-2">
              <PopoverSelect
                size="sm"
                value={0}
                onChange={(id) => { if (id > 0) addTrt.mutate(id) }}
                emptyLabel="+ Ajouter un traitement"
                options={(traitements ?? []).map((t) => ({ id: t.IDtraitement, primary: t.designation ?? `#${t.IDtraitement}` }))}
              />
              {addTrt.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />}
              <span className="text-[11px] text-muted-foreground">Un même traitement peut être appliqué plusieurs fois.</span>
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">Montants à la tranche 1 rouleau.</p>
        </div>
      </div>

      <FilDialog
        open={formOpen}
        isEdit={editingId !== null}
        form={form}
        onChange={setForm}
        fils={fils ?? []}
        gestion={gestion}
        isPending={saveFil.isPending}
        onCancel={() => { setFormOpen(false); setEditingId(null); setForm(EMPTY_FIL_FORM) }}
        onSubmit={submit}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Retirer le fil"
        description={deleteTarget ? `${deleteTarget.ref_label ?? ''} sera retiré de la composition.` : undefined}
        confirmLabel="Retirer"
        isPending={deleteFil.isPending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => { if (deleteTarget) deleteFil.mutate(deleteTarget.IDasso_fil_tarif) }}
      />
      <ConfirmDialog
        open={deleteTrt !== null}
        title="Retirer le traitement"
        description={deleteTrt ? `${deleteTrt.designation ?? ''} ne sera plus compté dans cette simulation.` : undefined}
        confirmLabel="Retirer"
        isPending={deleteTrtMut.isPending}
        onCancel={() => setDeleteTrt(null)}
        onConfirm={() => { if (deleteTrt) deleteTrtMut.mutate(deleteTrt.IDasso_traitement_tarif) }}
      />
    </>
  )
}

function FilDialog({
  open, isEdit, form, onChange, fils, gestion, isPending, onCancel, onSubmit,
}: {
  open: boolean; isEdit: boolean; form: FilFormState; onChange: (f: FilFormState) => void; fils: FilLookup[]
  gestion: number; isPending: boolean; onCancel: () => void; onSubmit: () => void
}) {
  const selected = fils.find((f) => f.IDref_fil === form.IDref_fil) ?? null
  const colorisOptions = (selected?.coloris ?? []).map((c) => ({
    id: c.id,
    primary: c.reference || `#${c.id}`,
    secondary: c.prix_achat > 0 ? `${fmtNum(c.prix_achat, 2)} € achat` : undefined,
  }))
  // Picking a yarn seeds its PURCHASE price from Fils › Références (base
  // price minus the frais de gestion); the user may then negotiate it.
  const pickFil = (id: number) => {
    const f = fils.find((x) => x.IDref_fil === id)
    onChange({ ...form, IDref_fil: id, IDcolori_fil: 0, prix_achat: f ? numToInput(Math.round(f.prix_achat * 100) / 100) : form.prix_achat })
  }
  const pickColoris = (id: number) => {
    const c = selected?.coloris.find((x) => x.id === id)
    const achat = c && c.prix_kg > 0 ? c.prix_achat : (selected?.prix_achat ?? 0)
    onChange({ ...form, IDcolori_fil: id, prix_achat: numToInput(Math.round(achat * 100) / 100) })
  }
  const achat = parseNum(form.prix_achat)
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onCancel() }}>
      <DialogContent className="max-w-lg" onClose={onCancel}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BobineIcon className="h-5 w-5 text-accent" />{isEdit ? 'Modifier le fil' : 'Ajouter un fil'}
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Référence de fil</label>
            <SearchableCombobox<FilLookup>
              options={fils}
              value={form.IDref_fil}
              onChange={pickFil}
              getId={(f) => f.IDref_fil}
              getPrimary={(f) => f.reference ?? `#${f.IDref_fil}`}
              getSecondary={(f) => (f.prix_achat > 0 ? `${fmtNum(f.prix_achat, 2)} € achat` : null)}
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
            <FieldNum label="Prix d’achat" unit="€/Kg" value={form.prix_achat} disabled={false} onChange={(v) => onChange({ ...form, prix_achat: v })} />
            <FieldNum label="Pourcentage" unit="%" value={form.pourcentage} disabled={false} onChange={(v) => onChange({ ...form, pourcentage: v })} />
          </div>
          {achat > 0 && (
            <p className="text-[11px] text-muted-foreground">
              Avec {fmtNum(gestion, 1)} % de frais de gestion : {fmtNum(achat * (1 + gestion / 100), 2)} €/Kg dans le coût.
            </p>
          )}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onCancel}>Annuler</Button>
          <Button onClick={onSubmit} disabled={isPending || form.IDref_fil <= 0}>
            {isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Save className="h-4 w-4 mr-1.5" />}Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Simulation libre tab ───────────────────────────────

function LibreTab({ tarif, onApply }: { tarif: TarifResult | null; onApply: (v: { poids: number; coefficient?: number; prix_cible_ml?: number } | null) => void }) {
  const [poids, setPoids] = useState('')
  const [coeff, setCoeff] = useState('')
  const [prix, setPrix] = useState('')
  const run = () => {
    const p = parseNum(poids)
    if (!(p > 0)) return
    const c = parseNum(coeff)
    const t = parseNum(prix)
    onApply({ poids: p, coefficient: c > 0 ? c : undefined, prix_cible_ml: c > 0 ? undefined : t > 0 ? t : undefined })
  }
  const libre = tarif?.libre ?? null
  return (
    <>
      <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3 space-y-3">
        <p className="text-[11px] text-muted-foreground leading-snug">
          Chiffrez n’importe quel poids, hors des 9 tranches standard. Renseignez une marge pour obtenir le prix,
          ou un prix cible pour connaître la marge qu’il laisse.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
          <FieldNum label="Poids à traiter" unit="Kg" value={poids} disabled={false} onChange={setPoids} />
          <FieldNum label="Marge" unit="%" value={coeff} disabled={false} onChange={(v) => { setCoeff(v); if (v.trim()) setPrix('') }} />
          <FieldNum label="Prix cible" unit="€/Ml" value={prix} disabled={coeff.trim() !== ''} onChange={setPrix} />
        </div>
        <Button size="sm" onClick={run} disabled={!(parseNum(poids) > 0)}>
          <Calculator className="h-3.5 w-3.5 mr-1.5" />Calculer
        </Button>
      </div>
      {libre ? (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            <Tile label="Quantité"><TileFigure value={fmtNum(libre.qte_ml)} unit="Ml" /></Tile>
            <Tile label="Marge"><TileFigure value={fmtNum(libre.rCoeff * 100, 1)} unit="%" /></Tile>
            <Tile label="Prix de vente"><TileFigure value={fmtNum(libre.moPrixDeVenteAuKg, 2)} unit="€/Kg" /></Tile>
            <Tile label="Prix de vente"><TileFigure value={fmtNum(libre.moPrixDeVenteAuMl, 2)} unit="€/Ml" tone="text-accent" /></Tile>
          </div>
          <PriceStructure tranche={libre} />
          <TrancheBreakdown tranche={libre} fraisGestion={0} />
        </>
      ) : (
        <p className="text-sm text-muted-foreground italic px-1">Saisissez un poids puis lancez le calcul.</p>
      )}
    </>
  )
}

// ── Right Panel: Leviers / Infos ───────────────────────

type SidebarTab = 'leviers' | 'infos'

function DetailSidebar({
  detail, isEditing, draft, onDraftChange, teintures, onMutationSuccess, onToggleArchive, isArchiving,
}: {
  detail: TarifDetail
  isEditing: boolean
  draft: ParamsDraft | null
  onDraftChange: (updater: (d: ParamsDraft | null) => ParamsDraft | null) => void
  teintures: TeintureLookup[]
  onMutationSuccess: () => void
  onToggleArchive: () => void
  isArchiving: boolean
}) {
  const [activeTab, setActiveTab] = useState<SidebarTab>('leviers')
  useEffect(() => { setActiveTab('leviers') }, [detail.IDref_tarif])
  const isArchived = detail.ok_tarif === 1
  const view = draft ?? draftFromDetail(detail)
  const set = (patch: Partial<ParamsDraft>) => onDraftChange((d) => (d ? { ...d, ...patch } : d))

  const tabs: { key: SidebarTab; label: string; icon: typeof BadgeEuro }[] = [
    { key: 'leviers', label: 'Leviers', icon: SlidersHorizontal },
    { key: 'infos', label: 'Infos', icon: Info },
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
          {activeTab === 'leviers'
            ? <LeviersPanel detail={detail} view={view} set={set} isEditing={isEditing} teintures={teintures} onMutationSuccess={onMutationSuccess} />
            : <InfosPanel detail={detail} view={view} set={set} isEditing={isEditing} />}
        </div>
      </div>

      {/* §29 status pill — En cours / Archivée */}
      <div className={cn('flex-shrink-0 rounded-xl border shadow-sm overflow-hidden flex items-stretch h-11', isArchived ? 'bg-success border-success' : 'bg-primary border-primary')}>
        <div className="flex items-center gap-2 px-3 flex-1 text-white min-w-0">
          {isArchived ? <CheckCircle2 className="h-4 w-4 flex-shrink-0" /> : <Clock className="h-4 w-4 flex-shrink-0" />}
          <span className="text-sm font-bold uppercase tracking-wide truncate">{isArchived ? 'Archivée' : 'En cours'}</span>
        </div>
        <button
          type="button"
          onClick={onToggleArchive}
          disabled={isEditing || isArchiving}
          title={isArchived ? 'Remettre en cours' : 'Archiver la simulation'}
          className="px-3.5 bg-white/15 hover:bg-white/25 active:bg-white/30 disabled:bg-white/5 disabled:opacity-60 disabled:cursor-not-allowed text-white text-xs font-semibold border-l border-white/25 flex items-center gap-1.5 transition-colors"
        >
          {isArchiving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : isArchived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
          {isArchived ? 'Réactiver' : 'Archiver'}
        </button>
      </div>
    </div>
  )
}

/** A white sidebar card (§8.1) with a gold icon + title. */
function LeverCard({ icon, title, isEditing, children, aside }: { icon: React.ReactNode; title: string; isEditing: boolean; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <div className={cn('p-3 rounded-lg border bg-card shadow-sm space-y-2.5', isEditing && editSectionClass)}>
      <div className="flex items-center gap-2">
        {icon}
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
        {aside && <div className="ml-auto">{aside}</div>}
      </div>
      {children}
    </div>
  )
}

function LeviersPanel({
  detail, view, set, isEditing, teintures, onMutationSuccess,
}: {
  detail: TarifDetail; view: ParamsDraft; set: (p: Partial<ParamsDraft>) => void
  isEditing: boolean; teintures: TeintureLookup[]; onMutationSuccess: () => void
}) {
  const queryClient = useQueryClient()
  const teint = teintureModeOf(view.IDteinture, teintures)
  const rendement = parseNum(view.rendement)
  const matel = multiplicateurMatel(rendement)
  const teintureGots = teintures.find((t) => t.IDteinture === view.IDteinture)?.prix_gots ?? 0

  // Each yarn's purchase price is a lever too — persisted on blur, like every
  // composition edit.
  const [prixFil, setPrixFil] = useState<Record<number, string>>({})
  useEffect(() => { setPrixFil({}) }, [detail.IDref_tarif, isEditing])
  const updatePrix = useMutation({
    mutationFn: ({ f, prix }: { f: TarifFil; prix: number }) =>
      apiFetch(`/tarifs-fini/${detail.IDref_tarif}/fils/${f.IDasso_fil_tarif}`, {
        method: 'PUT',
        body: JSON.stringify({ IDref_fil: f.IDref_fil, IDcolori_fil: f.IDcolori_fil, pourcentage: f.pourcentage, prix_achat: prix }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tarif-fini', detail.IDref_tarif] })
      onMutationSuccess()
    },
  })
  const commitPrix = (f: TarifFil) => {
    const v = prixFil[f.IDasso_fil_tarif]
    if (v === undefined) return
    const p = parseNum(v)
    if (Math.abs(p - f.prix_achat) > 0.0001) updatePrix.mutate({ f, prix: p })
  }

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
      {!isEditing && (
        <p className="text-[11px] text-muted-foreground flex items-start gap-1.5 px-0.5">
          <Pencil className="h-3 w-3 flex-shrink-0 mt-px" />
          « Modifier » pour jouer sur les leviers : le tarif se recalcule à chaque changement.
        </p>
      )}

      <LeverCard
        icon={<BobineIcon className="h-4 w-4 text-accent" />}
        title="Fil"
        isEditing={isEditing}
        aside={updatePrix.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" /> : undefined}
      >
        {detail.fils.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">Aucun fil — onglet Composition.</p>
        ) : (
          <div className="space-y-1.5">
            {detail.fils.map((f) => (
              <div key={f.IDasso_fil_tarif} className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium truncate" title={f.ref_label ?? undefined}>{f.ref_label ?? `#${f.IDref_fil}`}</p>
                  <p className="text-[10px] text-muted-foreground truncate">{fmtNum(f.pourcentage, 2)} %{f.colori_label ? ` · ${f.colori_label}` : ''}</p>
                </div>
                <div className="relative w-28 flex-shrink-0">
                  <input
                    type="text"
                    inputMode="decimal"
                    disabled={!isEditing || updatePrix.isPending}
                    value={prixFil[f.IDasso_fil_tarif] ?? numToInput(Math.round(f.prix_achat * 100) / 100)}
                    onChange={(e) => setPrixFil((p) => ({ ...p, [f.IDasso_fil_tarif]: e.target.value }))}
                    onBlur={() => commitPrix(f)}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                    title="Prix d’achat du fil, hors frais de gestion"
                    className={cn(inputClass, 'h-7 text-xs tabular-nums pr-12 disabled:bg-muted/40 disabled:text-foreground')}
                  />
                  <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">€ achat</span>
                </div>
              </div>
            ))}
          </div>
        )}
        {detail.fils.some((f) => !(f.prix_achat > 0)) && (
          <p className="text-[11px] text-amber-800">
            Un fil n’a pas de prix dans Fils › Références : saisissez son prix d’achat.
          </p>
        )}
        <FieldNum
          label="Frais de gestion sur l’achat"
          unit="%"
          value={view.frais_gestion_fil}
          disabled={!isEditing}
          onChange={(v) => set({ frais_gestion_fil: v })}
          hint="5 % par défaut : le prix de base d’un fil = offre retenue × 1,05"
        />
      </LeverCard>

      <LeverCard icon={<FiniRollIcon className="h-4 w-4 text-accent" />} title="Tricotage" isEditing={isEditing}>
        <div className="grid grid-cols-2 gap-2">
          <FieldNum label="Prix" unit="€/Kg" value={view.prix_tricotage} disabled={!isEditing} onChange={(v) => set({ prix_tricotage: v })} />
          <FieldNum label="Poids rouleau" unit="Kg" value={view.poids_rouleau} disabled={!isEditing} onChange={(v) => set({ poids_rouleau: v })} />
        </div>
        {parseNum(view.prix_tricotage) === 0 && (
          <p className="text-[11px] text-amber-800">Prix de tricotage à renseigner.</p>
        )}
      </LeverCard>

      <LeverCard icon={<Sparkles className="h-4 w-4 text-accent" />} title="Ennoblissement" isEditing={isEditing}>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Teinture</label>
          <Segmented<TeintureMode>
            value={teint.mode}
            disabled={!isEditing}
            onChange={(m) => set({ IDteinture: teintureIdFor(m, teint.shade, teintures) })}
            options={[{ key: 'sans', label: 'Sans' }, { key: 'simple', label: 'Simple' }, { key: 'double', label: 'Double' }]}
          />
        </div>
        {teint.mode !== 'sans' && shadeOptions.length > 0 && (
          <Segmented<string>
            value={teint.shade}
            disabled={!isEditing}
            onChange={(s) => set({ IDteinture: teintureIdFor(teint.mode, s, teintures) })}
            options={shadeOptions}
          />
        )}
        <div className="flex items-center justify-between gap-3 pt-1">
          <div className="min-w-0">
            <p className="text-xs font-medium">Multiplicateur MATEL</p>
            <p className="text-[10px] text-muted-foreground">
              {view.mult_auto ? `Selon le rendement : × ${fmtNum(matel, 2)}` : 'Saisi à la main'}
            </p>
          </div>
          <Switch value={view.mult_auto} disabled={!isEditing} onChange={(v) => set({ mult_auto: v })} title="Multiplicateur automatique selon le rendement" />
        </div>
        {!view.mult_auto && (
          <FieldNum
            label="Multiplicateur manuel"
            unit="%"
            value={view.multiplicateur}
            disabled={!isEditing}
            onChange={(v) => set({ multiplicateur: v })}
            hint="Majoration appliquée à tous les traitements et à la teinture"
          />
        )}
        <FieldNum
          label="Ajustement des prix ennoblisseur"
          unit="%"
          value={view.ajust_ennoblissement}
          disabled={!isEditing}
          onChange={(v) => set({ ajust_ennoblissement: v })}
          hint="Ex. -10 pour un prix négocié 10 % moins cher avec la teinturerie"
        />
        {teint.mode !== 'sans' && (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-medium">Supplément GOTS</p>
              <p className="text-[10px] text-muted-foreground">{teintureGots > 0 ? `${fmtNum(teintureGots, 2)} €/Kg sur la teinture` : 'Aucun supplément pour cette teinture'}</p>
            </div>
            <Switch value={view.gots} disabled={!isEditing} onChange={(v) => set({ gots: v })} title="Teinture certifiée GOTS" />
          </div>
        )}
      </LeverCard>

      <LeverCard icon={<Truck className="h-4 w-4 text-accent" />} title="Transport" isEditing={isEditing}>
        <Segmented<PortMode>
          value={view.port_mode}
          disabled={!isEditing}
          onChange={(m) => set({ port_mode: m })}
          options={[{ key: 'pct', label: 'Pourcentage' }, { key: 'kg', label: 'Au Kg' }]}
        />
        {view.port_mode === 'pct' ? (
          <>
            <FieldNum label="Taux de port" unit="%" value={view.port_pct} disabled={!isEditing} onChange={(v) => set({ port_pct: v })} />
            <p className="text-[11px] text-muted-foreground">La tranche 30 rouleaux reste à 3 %.</p>
          </>
        ) : (
          <FieldNum label="Port forfaitaire" unit="€/Kg" value={view.port_fixe} disabled={!isEditing} onChange={(v) => set({ port_fixe: v })} />
        )}
      </LeverCard>

      <LeverCard icon={<Ruler className="h-4 w-4 text-accent" />} title="Tissu" isEditing={isEditing}>
        <FieldNum
          label="Rendement"
          unit="Ml/Kg"
          value={view.rendement}
          disabled={!isEditing}
          onChange={(v) => set({ rendement: v })}
          hint={detail.source_kind === 'echantillon' ? 'Estimé depuis la laize et le poids au m² après lavage de l’échantillon' : undefined}
        />
        {detail.source_kind === 'echantillon' && (
          <p className="text-[11px] text-muted-foreground">
            {detail.rendement > 0
              ? 'Estimé depuis les mesures après lavage de l’échantillon.'
              : 'Mesures après lavage absentes de l’échantillon : saisissez le rendement estimé.'}
          </p>
        )}
      </LeverCard>
    </>
  )
}

function InfosPanel({ detail, view, set, isEditing }: { detail: TarifDetail; view: ParamsDraft; set: (p: Partial<ParamsDraft>) => void; isEditing: boolean }) {
  const { data: clients, isLoading: clientsLoading } = useQuery<Array<{ IDclient: number; nom: string }>>({
    queryKey: ['tarif-fini-lookup-clients-ref', detail.IDref_fini],
    queryFn: () => apiFetch(`/tarifs-fini/lookups/refs-finies/${detail.IDref_fini}/clients`),
    enabled: isEditing && detail.IDref_fini > 0,
    staleTime: 5 * 60 * 1000,
  })
  const Kv = ({ label, value }: { label: string; value: React.ReactNode }) => (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm text-right truncate">{value}</span>
    </div>
  )
  return (
    <>
      <LeverCard icon={<FileInput className="h-4 w-4 text-accent" />} title="Origine" isEditing={isEditing}>
        <div className="flex"><SourceChip kind={detail.source_kind} size="md" /></div>
        {detail.source_kind === 'reference' && (
          <>
            <Kv label="Référence" value={detail.ref_fini ?? '—'} />
            <Kv label="Coloris" value={detail.coloris ?? '—'} />
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">Client comparé</span>
              {isEditing ? (
                <PopoverSelect
                  size="sm"
                  value={view.IDclient}
                  onChange={(id) => set({ IDclient: id })}
                  emptyLabel="— aucun —"
                  options={[
                    ...(clients ?? []).map((c) => ({ id: c.IDclient, primary: c.nom })),
                    ...(detail.IDclient > 0 && !(clients ?? []).some((c) => c.IDclient === detail.IDclient)
                      ? [{ id: detail.IDclient, primary: detail.client ?? `#${detail.IDclient}` }]
                      : []),
                  ]}
                  disabled={clientsLoading}
                />
              ) : (
                <span className="text-sm text-right truncate">{detail.client ?? '—'}</span>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">
              Le gain par tranche se lit contre le prix catalogue de la référence et contre le prix que paie ce client
              (contrat, coefficient fixe ou tarif standard).
            </p>
          </>
        )}
        {detail.source_kind === 'echantillon' && (
          <>
            <Kv label="Échantillon" value={detail.echantillon ?? '—'} />
            <Kv label="Client" value={detail.client ?? '—'} />
          </>
        )}
        {detail.source_kind === 'libre' && (
          <p className="text-[11px] text-muted-foreground">Simulation saisie librement, sans référence ni échantillon.</p>
        )}
        {detail.date_creation && <Kv label="Créée le" value={frDate(detail.date_creation)} />}
      </LeverCard>

      <LeverCard icon={<Ruler className="h-4 w-4 text-accent" />} title="Dimensions" isEditing={isEditing}>
        <div className="grid grid-cols-3 gap-2">
          <FieldNum label="Laize" unit="cm" value={view.laize} disabled={!isEditing} onChange={(v) => set({ laize: v })} />
          <FieldNum label="Poids" unit="g/m²" value={view.poids} disabled={!isEditing} onChange={(v) => set({ poids: v })} />
          <FieldNum label="Freinte" unit="%" value={view.freinte} disabled={!isEditing} onChange={(v) => set({ freinte: v })} />
        </div>
      </LeverCard>

      <LeverCard icon={<MessageSquare className="h-4 w-4 text-accent" />} title="Commentaire" isEditing={isEditing}>
        {isEditing ? (
          <textarea
            rows={4}
            value={view.commentaire}
            onChange={(e) => set({ commentaire: e.target.value })}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
          />
        ) : view.commentaire.trim() ? (
          <p className="text-sm text-muted-foreground whitespace-pre-line">{view.commentaire}</p>
        ) : (
          <p className="text-sm text-muted-foreground italic">Aucun commentaire</p>
        )}
      </LeverCard>
    </>
  )
}

// ── Create dialog ──────────────────────────────────────

type CreateMode = 'from_echantillon' | 'from_fini' | 'blank'

function CreateTarifDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: number) => void }) {
  const [mode, setMode] = useState<CreateMode>('from_fini')
  const [refFiniId, setRefFiniId] = useState(0)
  const [colorisId, setColorisId] = useState(0)
  const [clientId, setClientId] = useState(0)
  const [echantillonId, setEchantillonId] = useState(0)
  const [reference, setReference] = useState('')
  const [touchedReference, setTouchedReference] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { data: refsFinies, isLoading: refsLoading } = useQuery<RefFinieLookup[]>({
    queryKey: ['tarif-fini-lookup-refs-finies'],
    queryFn: () => apiFetch('/tarifs-fini/lookups/refs-finies'),
    enabled: open && mode === 'from_fini',
    staleTime: 5 * 60 * 1000,
  })
  const { data: coloris } = useQuery<Array<{ id: number; reference: string }>>({
    queryKey: ['tarif-fini-lookup-coloris', refFiniId],
    queryFn: () => apiFetch(`/tarifs-fini/lookups/refs-finies/${refFiniId}/coloris`),
    enabled: open && mode === 'from_fini' && refFiniId > 0,
  })
  const { data: clients } = useQuery<Array<{ IDclient: number; nom: string }>>({
    queryKey: ['tarif-fini-lookup-clients-ref', refFiniId],
    queryFn: () => apiFetch(`/tarifs-fini/lookups/refs-finies/${refFiniId}/clients`),
    enabled: open && mode === 'from_fini' && refFiniId > 0,
  })
  const { data: echantillons, isLoading: echLoading } = useQuery<EchantillonLookup[]>({
    queryKey: ['tarif-fini-lookup-echantillons'],
    queryFn: () => apiFetch('/tarifs-fini/lookups/echantillons'),
    enabled: open && mode === 'from_echantillon',
    staleTime: 60 * 1000,
  })

  useEffect(() => {
    if (!open) return
    setMode('from_fini')
    setRefFiniId(0)
    setColorisId(0)
    setClientId(0)
    setEchantillonId(0)
    setReference('')
    setTouchedReference(false)
    setError(null)
  }, [open])

  // A reference with a single coloris / client picks it.
  useEffect(() => { setColorisId(coloris && coloris.length === 1 ? coloris[0].id : 0) }, [coloris])
  useEffect(() => { setClientId(clients && clients.length === 1 ? clients[0].IDclient : 0) }, [clients])

  const ech = echantillons?.find((e) => e.IDref_echantillon === echantillonId) ?? null

  // Suggest a name until the user types their own.
  useEffect(() => {
    if (touchedReference) return
    if (mode === 'from_fini') {
      const r = refsFinies?.find((x) => x.IDref_fini === refFiniId)
      const c = clients?.find((x) => x.IDclient === clientId)
      setReference(r?.reference ? `Étude ${r.reference}${c ? ` — ${c.nom}` : ''}` : '')
    } else if (mode === 'from_echantillon') {
      setReference(ech ? `${ech.numero}${ech.client ? ` — ${ech.client}` : ''}` : '')
    } else {
      setReference('Nouvelle simulation')
    }
  }, [mode, refFiniId, refsFinies, clientId, clients, ech, touchedReference])

  const createMut = useMutation({
    mutationFn: () =>
      apiFetch('/tarifs-fini', {
        method: 'POST',
        body: JSON.stringify({
          mode,
          reference: reference.trim(),
          source_id: mode === 'from_fini' ? refFiniId : mode === 'from_echantillon' ? echantillonId : undefined,
          IDcoloris: mode === 'from_fini' ? colorisId : undefined,
          IDclient: mode === 'from_fini' ? clientId : undefined,
        }),
      }),
    onSuccess: (data: TarifDetail) => onCreated(data.IDref_tarif),
    onError: () => setError('La simulation n’a pas pu être créée. Vérifiez la source et le nom saisis.'),
  })

  const modes: Array<{ key: CreateMode; label: string; description: string; icon: typeof FileInput }> = [
    {
      key: 'from_fini',
      label: 'Depuis une référence client',
      description: 'Étude de prix : part du prix catalogue exact de la référence, comparé au prix du client.',
      icon: Building2,
    },
    {
      key: 'from_echantillon',
      label: 'Depuis un échantillon',
      description: 'Estimation pour un client en R&D : fils et prix d’achat du jour, rendement après lavage.',
      icon: FlaskConical,
    },
    { key: 'blank', label: 'Simulation vierge', description: 'Part de zéro : poids rouleau 20 Kg, port 5 %, sans teinture.', icon: FilePlus2 },
  ]

  const canSubmit =
    reference.trim().length > 0
    && !createMut.isPending
    && (mode !== 'from_fini' || (refFiniId > 0 && colorisId > 0))
    && (mode !== 'from_echantillon' || echantillonId > 0)

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose() }}>
      <DialogContent className="max-w-lg max-h-[90dvh] overflow-y-auto" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><BadgeEuro className="h-5 w-5 text-accent" />Nouvelle simulation</DialogTitle>
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
                  onClick={() => { setMode(m.key); setTouchedReference(false) }}
                  className={cn(
                    'w-full flex items-start gap-2.5 px-3 py-2.5 rounded-lg border text-left transition-colors',
                    active ? 'border-accent bg-accent/[0.06] ring-1 ring-accent' : 'border-border/60 bg-white hover:border-accent/40',
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
            <>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Référence finie</label>
                <SearchableCombobox<RefFinieLookup>
                  options={refsFinies ?? []}
                  value={refFiniId}
                  onChange={(id) => { setRefFiniId(id); setColorisId(0); setClientId(0) }}
                  getId={(r) => r.IDref_fini}
                  getPrimary={(r) => r.reference ?? `#${r.IDref_fini}`}
                  getSecondary={(r) => r.designation}
                  loading={refsLoading}
                  placeholder="Rechercher une référence finie"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Coloris</label>
                  <PopoverSelect
                    options={(coloris ?? []).map((c) => ({ id: c.id, primary: c.reference }))}
                    value={colorisId}
                    onChange={setColorisId}
                    emptyLabel="— choisir —"
                    disabled={refFiniId <= 0}
                    disabledTitle="Choisissez d'abord une référence"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Client (prix à comparer)</label>
                  <PopoverSelect
                    options={(clients ?? []).map((c) => ({ id: c.IDclient, primary: c.nom }))}
                    value={clientId}
                    onChange={setClientId}
                    emptyLabel="— aucun —"
                    disabled={refFiniId <= 0}
                    disabledTitle="Choisissez d'abord une référence"
                  />
                </div>
              </div>
            </>
          )}

          {mode === 'from_echantillon' && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Échantillon</label>
              <SearchableCombobox<EchantillonLookup>
                options={echantillons ?? []}
                value={echantillonId}
                onChange={setEchantillonId}
                getId={(e) => e.IDref_echantillon}
                getPrimary={(e) => `${e.numero}${e.client ? ` · ${e.client}` : ''}`}
                getSecondary={(e) => [e.contexture, e.statut === 'archive' ? 'archivé' : e.statut === 'reference' ? 'devenu référence' : null].filter(Boolean).join(' · ') || null}
                loading={echLoading}
                placeholder="Rechercher un échantillon"
              />
              {ech && (
                <p className={cn('text-[11px] mt-1', ech.rendement > 0 && ech.nb_fils > 0 ? 'text-muted-foreground' : 'text-amber-800')}>
                  {ech.nb_fils > 0 ? `${ech.nb_fils} fil${ech.nb_fils > 1 ? 's' : ''}` : 'Aucun fil saisi sur l’échantillon'}
                  {' · '}
                  {ech.rendement > 0
                    ? `rendement estimé ${fmtNum(ech.rendement, 2)} Ml/Kg (mesures après lavage)`
                    : 'pas de mesures après lavage : rendement à saisir'}
                </p>
              )}
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
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>
          )}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={() => { setError(null); createMut.mutate() }} disabled={!canSubmit}>
            {createMut.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Plus className="h-4 w-4 mr-1.5" />}Créer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
