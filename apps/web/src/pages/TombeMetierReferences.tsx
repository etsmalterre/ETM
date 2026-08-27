import { useState, useMemo, useEffect, useCallback, useRef, useContext, createContext, type ComponentType } from 'react'
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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
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
  Copy,
  Archive,
  ArchiveRestore,
  Printer,
  AtSign,
  Mail,
  Leaf,
  Recycle,
  FlaskConical,
  Palette,
  Cog,
  Grid3x3,
  ClipboardList,
  Layers,
  Calendar,
  Lock,
  Calculator,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PopoverSelect, SearchableCombobox } from '@/components/ui/popover-select'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'
import { TmRollIcon } from '@/components/icons/TmRollIcon'
import { cn } from '@/lib/utils'
import { apiFetch } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { formatHfsqlDate } from '@/lib/dates'

// ── Types ──────────────────────────────────────────────

interface RefEcruListRow {
  IDref_ecru: number
  reference: string | null
  designation: string | null
  contexture_nom: string | null
  bio: number
  recycle: number
  archive: number
  prix: number | null
  Jauge: number | null
  diametre: number | null
  coloris_count: number
}

interface CompositionRow {
  IDcomposition_ecru: number
  IDref_fil: number
  IDcolori_fil: number
  ref_fil_reference: string | null
  prix_kg: number | null
  pourcentage: number | null
  commentaire: string | null
}

interface ColorisRow {
  IDcolori_ecru: number
  reference: string | null
  commentaire: string | null
  suivis: number
  rolls: boolean
  orders: boolean
  has_specific_composition: boolean
}

interface MachineRow {
  IDref_ecru_machine: number
  IDmachine: number
  machine_nom: string | null
  repere_1: string | null
  repere_2: string | null
  repere_3: string | null
  repere_4: string | null
  repere_5: string | null
  hauteur_pl: string | null
  abattage: string | null
  trs_10kg_chute: number | null
  nb_chutes: number | null
  compteur_saisie: number
  compteur_calcule: number
}

interface ChuteRow {
  IDchute_liage: number
  num_chute: number
  IDcomposition_ecru1: number
  IDcomposition_ecru2: number
  lfa1: number | null
  lfa2: number | null
}

interface CellRow {
  IDschema_liage: number
  IDchute_liage: number
  num_symbole: number
  IDsymbole_liage: number
}

interface SymboleRow {
  IDsymbole_liage: number
  icone: string | null
}

export interface ObsOfRow {
  IDobs_ref_ecru: number
  IDmachine: number
  machine_nom: string | null
  IDcolori_ecru: number
  colori_reference: string | null
  observation: string | null
  date: string | null
}

/** Props of the injectable « Obs OF » editor — see `ObsOfEditorContext`. */
export interface ObsOfEditorProps {
  refId: number
  refLabel: string
  rows: ObsOfRow[]
  /** The screen's edit mode — an injected editor only writes inside it (§8). */
  isEditing: boolean
  /** Refetch the reference detail (the rows above ride in its payload). */
  onChanged: () => void
}

// `obs_ref_ecru` rows are the régleur's standing knitting notes, scoped per
// métier and per coloris. ETM shows them read-only — it buys its écru, it has
// no métiers of its own — while TRM writes them from two screens. Rather than
// fork this file (or hardcode a TRM endpoint in it), TRM injects its whole
// editable panel; without it the tab stays exactly as it was.
const ObsOfEditorContext = createContext<ComponentType<ObsOfEditorProps> | null>(null)

interface RefEcruDetail {
  IDref_ecru: number
  reference: string | null
  designation: string | null
  composition: string | null
  IDclient: number
  reference_client: string | null
  prix: number | null
  poids: number | null
  IDcontexture: number
  Jauge: number | null
  diametre: number | null
  bio: number
  recycle: number
  archive: number
  commentaire: string | null
  observations: string | null
  tombe_metier: string | null
  date_maj_ft: string | null
  lfa_tour_1: string | null
  lfa_tour_2: string | null
  lfa_tour_3: string | null
  lfa_tour_4: string | null
  poulies_1: string | null
  poulies_2: string | null
  poulies_3: string | null
  poulies_4: string | null
  ecarteur: number | null
  laize_tbm: number | null
  poids_m2_tbm: number | null
  rendement: number | null
  vitesse_cible: number | null
  nb_chutes: number | null
  nb_aiguilles: number | null
  maille_ouverture: number
  ouvert_visiteuse: number
  sonneter: number
  contexture_nom: string | null
  client_nom: string | null
  composition_lines: CompositionRow[]
  cout_kg: number | null
  coloris: ColorisRow[]
  machines: MachineRow[]
  chutes: ChuteRow[]
  cells: CellRow[]
  symboles: SymboleRow[]
  obs_of: ObsOfRow[]
  has_rolls: boolean
  has_orders: boolean
  rolls_count: number
  rolls_poids_total: number
}

// Coût de tricotage (PrixDeRevientTRM) breakdown — mirror of the API shape.
interface CoutRow { key: string; label: string; eurPerKg: number; info?: string }
interface CoutSection { key: 'structure' | 'production' | 'main_oeuvre'; label: string; rows: CoutRow[]; subtotalPerKg: number }
interface CoutTricotageBreakdown {
  computable: boolean
  IDref_ecru: number
  qty: number
  inputs: { gxNbToursKg: number; gxMinParKg: number; nbAiguilles: number; prodAnnuel: number; jaugeCode: number; diametreCode: number }
  sections: CoutSection[]
  costPerKg: number
  salePrice: number
  floor: number
  retainedPrice: number
}

interface ContextureLookup { IDcontexture: number; nom: string | null }
interface ClientLookup { IDclient: number; nom: string | null; ville: string | null }
interface RefFilLookup { IDref_fil: number; reference: string | null; prix_kg: number | null }
interface MachineLookup { IDmachine: number; nom: string | null; Jauge: number | null }

// ── Shared styling ─────────────────────────────────────

const inputClass =
  'w-full h-8 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring'
const editSectionClass = 'border-l-4 border-l-accent/70 bg-accent/[0.03]'

// ── Small shared components ────────────────────────────

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
      <input type={type} step={step} value={value} onChange={(e) => onChange(e.target.value)} className={inputClass} />
    </div>
  )
}

/** §35 inline pill toggle switch. */
function Pill({ value, onChange, disabled }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
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

const numStr = (n: number | null | undefined): string => (n == null ? '' : String(n))
const fmtPct = (v: number | null | undefined) => (v == null ? '—' : `${fmtNum(v, Number.isInteger(v) ? 0 : 2)} %`)

// Both Jauge and Diamètre are stored on ref_ecru as 1-based ordinals indexing
// legacy combo lists, with index 1 = "_" placeholder and -1/0/null = unset.
// Display the mapped value, never the raw ordinal.
//
// Jauge (gtaJauge) = needles-per-inch — a plain number, NO inch unit.
const JAUGE_OPTIONS: { ord: number; label: string }[] = [
  { ord: 2, label: '14' },
  { ord: 3, label: '18' },
  { ord: 4, label: '20' },
  { ord: 5, label: '28' },
]
// Diamètre (gtaDiametreMachine) = machine diameter in inches (shown with ").
const DIAM_OPTIONS: { ord: number; label: string }[] = [
  { ord: 2, label: '26"' },
  { ord: 3, label: '30"' },
]
const ordLabel = (options: { ord: number; label: string }[]) => (ord: number | null | undefined): string | null => {
  if (ord == null) return null
  if (ord === 1) return '_'
  return options.find((o) => o.ord === ord)?.label ?? null
}
const jaugeLabel = ordLabel(JAUGE_OPTIONS)
const diametreLabel = ordLabel(DIAM_OPTIONS)

// "Tombé du métier" is a free-text column storing one of two fixed values
// ("Rouleaux" / "Plis"); legacy junk ("-1", "") maps to the empty placeholder.
const TOMBE_OPTIONS: { id: number; value: string; label: string }[] = [
  { id: 1, value: 'Rouleaux', label: 'Rouleaux' },
  { id: 2, value: 'Plis', label: 'Plis' },
]
const tombeId = (v: string | null | undefined): number => TOMBE_OPTIONS.find((o) => o.value === (v ?? '').trim())?.id ?? 0
const tombeValue = (id: number): string => TOMBE_OPTIONS.find((o) => o.id === id)?.value ?? ''

// ── API hooks ──────────────────────────────────────────

function useRefsEcru(archived: boolean) {
  return useQuery<RefEcruListRow[]>({
    queryKey: ['refs-ecru', archived ? 'archive' : 'en_cours'],
    queryFn: () => apiFetch(`/references-ecru?archived=${archived ? 1 : 0}`),
  })
}

function useRefEcruDetail(id: number | null) {
  return useQuery<RefEcruDetail>({
    queryKey: ['ref-ecru', id],
    queryFn: () => apiFetch(`/references-ecru/${id}`),
    enabled: id !== null,
  })
}

function useCoutTricotage(id: number | null, qty: number, enabled: boolean) {
  return useQuery<CoutTricotageBreakdown>({
    queryKey: ['ref-ecru-cout-tricotage', id, qty],
    queryFn: () => apiFetch(`/references-ecru/${id}/cout-tricotage?qty=${qty}`),
    enabled: enabled && id !== null,
    placeholderData: (prev) => prev, // keep last breakdown while qty changes → no flicker
  })
}

function useContextures(enabled: boolean) {
  return useQuery<ContextureLookup[]>({
    queryKey: ['ref-ecru-lk-contextures'],
    queryFn: () => apiFetch('/references-ecru/lookups/contextures'),
    enabled,
    staleTime: 5 * 60_000,
  })
}
function useClients(enabled: boolean) {
  return useQuery<ClientLookup[]>({
    queryKey: ['ref-ecru-lk-clients'],
    queryFn: () => apiFetch('/references-ecru/lookups/clients'),
    enabled,
    staleTime: 5 * 60_000,
  })
}
function useRefsFilLookup(enabled: boolean) {
  return useQuery<RefFilLookup[]>({
    queryKey: ['ref-ecru-lk-refsfil'],
    queryFn: () => apiFetch('/references-ecru/lookups/refs-fil'),
    enabled,
    staleTime: 5 * 60_000,
  })
}
function useMachinesLookup(enabled: boolean) {
  return useQuery<MachineLookup[]>({
    queryKey: ['ref-ecru-lk-machines'],
    queryFn: () => apiFetch('/references-ecru/lookups/machines'),
    enabled,
    staleTime: 5 * 60_000,
  })
}

// ── Header draft ───────────────────────────────────────

interface HeaderDraft {
  reference: string
  designation: string
  reference_client: string
  IDclient: number
  IDcontexture: number
  prix: string
  poids: string
  Jauge: string
  diametre: string
  bio: boolean
  recycle: boolean
  commentaire: string
  observations: string
  tombe_metier: string
  lfa_tour_1: string
  lfa_tour_2: string
  lfa_tour_3: string
  lfa_tour_4: string
  poulies_1: string
  poulies_2: string
  poulies_3: string
  poulies_4: string
  ecarteur: string
  laize_tbm: string
  poids_m2_tbm: string
  rendement: string
  vitesse_cible: string
  nb_chutes: string
  nb_aiguilles: string
  maille_ouverture: boolean
  ouvert_visiteuse: boolean
  sonneter: boolean
}

function emptyDraft(): HeaderDraft {
  return {
    reference: '', designation: '', reference_client: '', IDclient: 0, IDcontexture: 0,
    prix: '', poids: '', Jauge: '', diametre: '', bio: false, recycle: false,
    commentaire: '', observations: '', tombe_metier: '',
    lfa_tour_1: '', lfa_tour_2: '', lfa_tour_3: '', lfa_tour_4: '',
    poulies_1: '', poulies_2: '', poulies_3: '', poulies_4: '',
    ecarteur: '', laize_tbm: '', poids_m2_tbm: '', rendement: '', vitesse_cible: '',
    nb_chutes: '', nb_aiguilles: '', maille_ouverture: false, ouvert_visiteuse: false, sonneter: false,
  }
}

function draftFromDetail(d: RefEcruDetail): HeaderDraft {
  return {
    reference: d.reference ?? '',
    designation: d.designation ?? '',
    reference_client: d.reference_client ?? '',
    IDclient: Number(d.IDclient) || 0,
    IDcontexture: Number(d.IDcontexture) || 0,
    prix: numStr(d.prix),
    poids: numStr(d.poids),
    Jauge: numStr(d.Jauge),
    diametre: numStr(d.diametre),
    bio: !!d.bio,
    recycle: !!d.recycle,
    commentaire: d.commentaire ?? '',
    observations: d.observations ?? '',
    tombe_metier: d.tombe_metier ?? '',
    lfa_tour_1: d.lfa_tour_1 ?? '', lfa_tour_2: d.lfa_tour_2 ?? '', lfa_tour_3: d.lfa_tour_3 ?? '', lfa_tour_4: d.lfa_tour_4 ?? '',
    poulies_1: d.poulies_1 ?? '', poulies_2: d.poulies_2 ?? '', poulies_3: d.poulies_3 ?? '', poulies_4: d.poulies_4 ?? '',
    ecarteur: numStr(d.ecarteur),
    laize_tbm: numStr(d.laize_tbm),
    poids_m2_tbm: numStr(d.poids_m2_tbm),
    rendement: numStr(d.rendement),
    vitesse_cible: numStr(d.vitesse_cible),
    nb_chutes: numStr(d.nb_chutes),
    nb_aiguilles: numStr(d.nb_aiguilles),
    maille_ouverture: !!d.maille_ouverture,
    ouvert_visiteuse: !!d.ouvert_visiteuse,
    sonneter: !!d.sonneter,
  }
}

function draftToBody(d: HeaderDraft) {
  const num = (s: string) => (s.trim() === '' ? null : Number(s))
  return {
    reference: d.reference.trim(),
    designation: d.designation,
    reference_client: d.reference_client,
    IDclient: d.IDclient || 0,
    IDcontexture: d.IDcontexture || 0,
    prix: num(d.prix),
    poids: num(d.poids),
    Jauge: num(d.Jauge),
    diametre: num(d.diametre),
    bio: d.bio,
    recycle: d.recycle,
    commentaire: d.commentaire,
    observations: d.observations,
    tombe_metier: d.tombe_metier,
    lfa_tour_1: d.lfa_tour_1, lfa_tour_2: d.lfa_tour_2, lfa_tour_3: d.lfa_tour_3, lfa_tour_4: d.lfa_tour_4,
    poulies_1: d.poulies_1, poulies_2: d.poulies_2, poulies_3: d.poulies_3, poulies_4: d.poulies_4,
    ecarteur: num(d.ecarteur),
    laize_tbm: num(d.laize_tbm),
    poids_m2_tbm: num(d.poids_m2_tbm),
    rendement: num(d.rendement),
    vitesse_cible: num(d.vitesse_cible),
    nb_chutes: num(d.nb_chutes),
    nb_aiguilles: num(d.nb_aiguilles),
    maille_ouverture: d.maille_ouverture,
    ouvert_visiteuse: d.ouvert_visiteuse,
    sonneter: d.sonneter,
  }
}

// ── Page ───────────────────────────────────────────────

export function TombeMetierReferences({ obsOfEditor }: { obsOfEditor?: ComponentType<ObsOfEditorProps> } = {}) {
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [archivedFilter, setArchivedFilter] = useState(false) // false = En cours, true = Archivé
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState<HeaderDraft>(emptyDraft())
  const originalDraftRef = useRef<HeaderDraft | null>(null)

  // Per-key dirty registry (§28.3.b)
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
  const [createError, setCreateError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [printOpen, setPrintOpen] = useState(false)
  const [emailOpen, setEmailOpen] = useState(false)
  const [coutDialogOpen, setCoutDialogOpen] = useState(false)

  const { data: refs, isLoading, isError, error } = useRefsEcru(archivedFilter)
  const { data: detail, isLoading: detailLoading } = useRefEcruDetail(selectedId)
  const { data: contextures } = useContextures(isEditing)
  const { data: clients } = useClients(isEditing)
  const { data: refsFil } = useRefsFilLookup(isEditing)
  const { data: machinesLk } = useMachinesLookup(isEditing)

  const filtered = useMemo(() => {
    if (!refs) return []
    const tokens = searchQuery.toLowerCase().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return refs
    // AND across space-separated tokens; each token must match somewhere in the
    // row's searchable text (reference, designation, contexture, jauge, diamètre).
    return refs.filter((r) => {
      const haystack = [
        r.reference,
        r.designation,
        r.contexture_nom,
        jaugeLabel(r.Jauge),
        diametreLabel(r.diametre),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return tokens.every((t) => haystack.includes(t))
    })
  }, [refs, searchQuery])

  // Auto-select first visible row; re-selects when the filter/search narrows the list.
  // Skip while a just-created row is pending: its id is set before the list refetch
  // lands, so it isn't in `filtered` yet and we'd otherwise clobber the selection.
  useAutoSelectFirst({
    rows: filtered,
    selectedId,
    getId: (r) => r.IDref_ecru,
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
    if (JSON.stringify(draft) !== JSON.stringify(o)) return true
    if (subFormsDirty) return true
    return false
  }, [isEditing, draft, subFormsDirty])

  // Composition must total 100% (pourcentage stored 0..100). An empty
  // composition is allowed (not yet entered); a non-empty one must be exactly
  // 100. Editing is locked entirely once rolls/orders exist, so don't block
  // exit in that case (the user can't fix the total anyway).
  const compositionLocked = !!detail?.has_rolls || !!detail?.has_orders
  const compositionTotalPct = useMemo(
    () => (detail?.composition_lines ?? []).reduce((s, c) => s + (Number(c.pourcentage) || 0), 0),
    [detail],
  )
  const compositionOk =
    (detail?.composition_lines?.length ?? 0) === 0 || Math.abs(compositionTotalPct - 100) < 0.01

  const [saveBlockedReason, setSaveBlockedReason] = useState<string | null>(null)
  useEffect(() => {
    if ((!isEditing || compositionOk) && saveBlockedReason) setSaveBlockedReason(null)
  }, [compositionOk, isEditing, saveBlockedReason])

  /** Guard for any action that exits edit mode (Enregistrer / Annuler). Returns
   *  true when blocked — caller must not proceed. Surfaces the alert. */
  const blockExitIfBadComposition = useCallback((): boolean => {
    if (compositionOk || compositionLocked) return false
    const fmt = Math.round(compositionTotalPct * 1000) / 1000
    setSaveBlockedReason(
      `La composition doit totaliser 100 % (actuellement ${fmt} %). Corrigez la composition avant de quitter le mode édition.`,
    )
    return true
  }, [compositionOk, compositionLocked, compositionTotalPct])

  const invalidateDetail = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['ref-ecru', selectedId] })
    queryClient.invalidateQueries({ queryKey: ['refs-ecru'] })
  }, [queryClient, selectedId])

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/references-ecru/${selectedId}`, { method: 'PUT', body: JSON.stringify(draftToBody(draft)) }),
    onSuccess: () => {
      invalidateDetail()
      setIsEditing(false)
      originalDraftRef.current = null
    },
    onError: (err: Error & { status?: number }) => {
      setSaveError(
        err.status === 409
          ? 'Cette référence existe déjà. Choisissez un autre numéro.'
          : err.status === 401
            ? 'Votre session a expiré. Veuillez vous reconnecter, puis réessayer.'
            : "L'enregistrement de la référence a échoué. Veuillez réessayer.",
      )
    },
  })

  const createMutation = useMutation({
    mutationFn: () =>
      // Reference is auto-generated server-side (next free 3-digit number).
      apiFetch<{ IDref_ecru: number | null }>(`/references-ecru`, {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: (data) => {
      setCreateError(null)
      setArchivedFilter(false)
      queryClient.invalidateQueries({ queryKey: ['refs-ecru'] })
      if (data.IDref_ecru != null) {
        setSelectedId(data.IDref_ecru)
        setAutoEditForId(data.IDref_ecru)
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
    // Take the id as an arg (not from closure) so onSuccess can't drift if the
    // selection changes mid-flight.
    mutationFn: (id: number) => apiFetch(`/references-ecru/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, deletedId) => {
      setDeleteConfirmOpen(false)
      setDeleteError(null)
      setIsEditing(false)
      originalDraftRef.current = null
      const cached = queryClient.getQueryData<RefEcruListRow[]>(['refs-ecru', archivedFilter ? 'archive' : 'en_cours']) ?? []
      const remaining = cached.filter((r) => r.IDref_ecru !== deletedId)
      // Purge the deleted ref's detail cache so its data can't linger on screen.
      queryClient.removeQueries({ queryKey: ['ref-ecru', deletedId] })
      queryClient.invalidateQueries({ queryKey: ['refs-ecru'] })
      setSelectedId(remaining.length > 0 ? remaining[0].IDref_ecru : null)
    },
    onError: async (err: Error & { status?: number }, deletedId) => {
      let msg = 'Suppression impossible.'
      try {
        const res = await fetch(
          `${import.meta.env.VITE_API_URL || 'http://localhost:3002/api'}/references-ecru/${deletedId}`,
          { method: 'DELETE', credentials: 'include' },
        )
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          if (body?.error) msg = String(body.error)
        }
      } catch { /* keep default */ }
      void err
      setDeleteError(msg)
    },
  })

  const archiveMutation = useMutation({
    mutationFn: (archive: boolean) =>
      apiFetch(`/references-ecru/${selectedId}/${archive ? 'archive' : 'unarchive'}`, { method: 'POST' }),
    onSuccess: () => {
      const cached = queryClient.getQueryData<RefEcruListRow[]>(['refs-ecru', archivedFilter ? 'archive' : 'en_cours']) ?? []
      const remaining = cached.filter((r) => r.IDref_ecru !== selectedId)
      queryClient.invalidateQueries({ queryKey: ['refs-ecru'] })
      queryClient.invalidateQueries({ queryKey: ['ref-ecru', selectedId] })
      setSelectedId(remaining.length > 0 ? remaining[0].IDref_ecru : null)
    },
  })

  const duplicateMutation = useMutation({
    mutationFn: () => apiFetch<{ IDref_ecru: number | null }>(`/references-ecru/${selectedId}/duplicate`, { method: 'POST' }),
    onSuccess: (data) => {
      setArchivedFilter(false)
      queryClient.invalidateQueries({ queryKey: ['refs-ecru'] })
      if (data.IDref_ecru != null) {
        setSelectedId(data.IDref_ecru)
        setAutoEditForId(data.IDref_ecru)
      }
    },
  })

  // §25.1 auto-edit after create / duplicate
  useEffect(() => {
    if (autoEditForId !== null && detail?.IDref_ecru === autoEditForId) {
      startEdit()
      setAutoEditForId(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEditForId, detail])

  const guard = useUnsavedGuard({
    isDirty,
    save: async () => { await saveMutation.mutateAsync() },
    onDiscard: () => cancelEdit(),
    shouldBlockExit: isEditing && !compositionOk && !compositionLocked,
    onExitBlocked: () => { blockExitIfBadComposition() },
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
    <ObsOfEditorContext.Provider value={obsOfEditor ?? null}>
      <MasterDetailLayout
        list={
          <RefEcruList
            refs={filtered}
            totalCount={filtered.length}
            isLoading={isLoading}
            isError={isError}
            error={error as Error | null}
            selectedId={selectedId}
            onSelect={handleSelect}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            archivedFilter={archivedFilter}
            onArchivedFilterChange={(v) => guard.guardAction(() => { setIsEditing(false); setArchivedFilter(v) })}
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
            onCancelEdit={() => { if (!blockExitIfBadComposition()) cancelEdit() }}
            onSave={() => { if (!blockExitIfBadComposition()) saveMutation.mutate() }}
            isSaving={saveMutation.isPending}
            onDelete={() => { setDeleteError(null); setDeleteConfirmOpen(true) }}
            onArchive={() => archiveMutation.mutate(!detail?.archive)}
            isArchiving={archiveMutation.isPending}
            onDuplicate={() => duplicateMutation.mutate()}
            isDuplicating={duplicateMutation.isPending}
            onPrint={() => setPrintOpen(true)}
            onEmail={() => setEmailOpen(true)}
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
            clients={clients ?? []}
            contextures={contextures ?? []}
            refsFil={refsFil ?? []}
            machinesLk={machinesLk ?? []}
            onMutationSuccess={invalidateDetail}
            reportDirty={reportDirty}
          />
        }
        sidebar={selectedId !== null ? <DetailSidebar detail={detail ?? null} refId={selectedId} onOpenCoutDetail={() => setCoutDialogOpen(true)} /> : null}
        sidebarTitle="Informations"
        hasSelection={selectedId !== null}
        onBack={() => guard.guardAction(() => { setIsEditing(false); setSelectedId(null) })}
      />

      <UnsavedChangesDialog open={guard.showDialog} onAction={guard.handleAction} isSaving={guard.isSaving} />

      <ConfirmDialog
        open={deleteConfirmOpen}
        title="Supprimer la référence"
        description={
          deleteError ??
          'Cette action supprimera la référence écru ainsi que sa composition, ses coloris, ses réglages machine et son schéma de liage. Elle est irréversible.'
        }
        isPending={deleteMutation.isPending}
        onCancel={() => { setDeleteConfirmOpen(false); setDeleteError(null) }}
        onConfirm={() => { if (selectedId !== null) { setIsEditing(false); deleteMutation.mutate(selectedId) } }}
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

      <AlertDialog open={saveBlockedReason !== null} onOpenChange={(o) => { if (!o) setSaveBlockedReason(null) }}>
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

      <PlaceholderDialog open={printOpen} onClose={() => setPrintOpen(false)} title="Imprimer" TriggerIcon={Printer} CenterIcon={Printer} />
      <PlaceholderDialog open={emailOpen} onClose={() => setEmailOpen(false)} title="Envoyer un email" TriggerIcon={AtSign} CenterIcon={Mail} />
      <CoutTricotageDialog
        open={coutDialogOpen}
        onClose={() => setCoutDialogOpen(false)}
        refId={selectedId}
        refLabel={detail?.reference ?? null}
      />
    </ObsOfEditorContext.Provider>
  )
}

// ── "En developpement" placeholder dialog (§18 A-bis) ──

function PlaceholderDialog({
  open,
  onClose,
  title,
  TriggerIcon,
  CenterIcon,
}: {
  open: boolean
  onClose: () => void
  title: string
  TriggerIcon: typeof Printer
  CenterIcon: typeof Printer
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TriggerIcon className="h-5 w-5 text-accent" />
            {title}
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

// ── Coût de tricotage breakdown dialog (read-only) ─────

function CoutTricotageDialog({
  open,
  onClose,
  refId,
  refLabel,
}: {
  open: boolean
  onClose: () => void
  refId: number | null
  refLabel: string | null
}) {
  const [qtyInput, setQtyInput] = useState('1000')
  const [debouncedQty, setDebouncedQty] = useState(1000)

  // Reset to the default quantity each time the dialog opens.
  useEffect(() => { if (open) { setQtyInput('1000'); setDebouncedQty(1000) } }, [open])

  // Debounce the qty input so we don't refetch on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      const n = Number(qtyInput)
      setDebouncedQty(Number.isFinite(n) && n >= 1 ? n : 1000)
    }, 300)
    return () => clearTimeout(t)
  }, [qtyInput])

  const { data: bd, isFetching } = useCoutTricotage(refId, debouncedQty, open)
  const floorWins = bd ? bd.floor >= bd.salePrice : false

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-2xl" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TmRollIcon className="h-5 w-5 text-accent" />
            Coût de tricotage{refLabel ? ` — ${refLabel}` : ''}
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          {/* Quantity */}
          <div className="flex items-end gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Quantité (kg)</label>
              <input
                type="number"
                min={1}
                step="1"
                value={qtyInput}
                onChange={(e) => setQtyInput(e.target.value)}
                className={cn(inputClass, 'w-32 tabular-nums')}
              />
            </div>
            {isFetching && <Loader2 className="h-4 w-4 animate-spin text-accent mb-2" />}
            {!!bd?.computable && (
              <p className="text-[11px] text-muted-foreground mb-1.5">
                Métier : <span className="tabular-nums">{fmtNum(bd.inputs.gxNbToursKg, 2)}</span> trs/kg · <span className="tabular-nums">{bd.inputs.nbAiguilles}</span> aiguilles
              </p>
            )}
          </div>

          {!!bd && !bd.computable && (
            <div className="rounded-md border border-border/60 bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
              Aucune donnée machine pour cette référence — le coût de tricotage ne peut pas être calculé. Le prix retenu est le prix plancher de la fiche.
            </div>
          )}

          {!!bd?.computable && bd.sections.map((sec) => (
            <div key={sec.key}>
              <p className="text-xs font-semibold text-accent uppercase tracking-wide mb-1.5">{sec.label}</p>
              <div className="space-y-1">
                {sec.rows.map((r) => (
                  <div key={r.key} className="flex items-baseline justify-between gap-3">
                    <span className="text-sm text-muted-foreground min-w-0">
                      {r.label}
                      {r.info && <span className="block text-[10px] text-muted-foreground/70 truncate">{r.info}</span>}
                    </span>
                    <span className="text-sm tabular-nums flex-shrink-0">{fmtNum(r.eurPerKg, 4)} €/kg</span>
                  </div>
                ))}
              </div>
              <div className="flex items-baseline justify-between gap-2 mt-1.5 pt-1.5 border-t border-border/50">
                <span className="text-xs font-semibold">Sous-total</span>
                <span className="text-sm font-semibold tabular-nums">{fmtNum(sec.subtotalPerKg, 4)} €/kg</span>
              </div>
            </div>
          ))}

          {/* Totals */}
          {!!bd && (
            <div className="border-t pt-3 space-y-1">
              <div className="flex items-baseline justify-between">
                <span className="text-sm font-semibold">Coût total</span>
                <span className="text-base font-bold tabular-nums text-accent">{fmtNum(bd.costPerKg, 2)} €/kg</span>
              </div>
              <div className="flex items-baseline justify-between text-sm text-muted-foreground">
                <span>Prix de vente (marge 30 %)</span>
                <span className="tabular-nums">{fmtNum(bd.salePrice, 2)} €/kg</span>
              </div>
              <div className="flex items-baseline justify-between text-sm text-muted-foreground">
                <span>Prix plancher (fiche)</span>
                <span className="tabular-nums">{fmtNum(bd.floor, 2)} €/kg</span>
              </div>
              <div className="flex items-baseline justify-between pt-1 mt-1 border-t border-border/50">
                <span className="text-sm font-semibold">
                  Prix retenu{floorWins && <span className="ml-1 text-[10px] font-normal text-muted-foreground">(plancher)</span>}
                </span>
                <span className="text-base font-bold tabular-nums">{fmtNum(bd.retainedPrice, 2)} €/kg</span>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Left Panel: List ───────────────────────────────────

function RefEcruList({
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
  refs: RefEcruListRow[]
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
  // Keep the selected card visible — newly created refs sort into the middle of
  // the list, so without this they'd be selected but off-screen.
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
            <TmRollIcon className="h-12 w-12 mb-3 opacity-50" />
            <p className="text-sm">Aucune référence</p>
          </div>
        ) : (
          refs.map((r) => (
            <div
              key={r.IDref_ecru}
              ref={selectedId === r.IDref_ecru ? selectedRef : undefined}
              onClick={() => onSelect(r.IDref_ecru)}
              className={cn(
                'p-3 border rounded-lg cursor-pointer transition-all bg-white',
                selectedId === r.IDref_ecru ? 'border-accent ring-1 ring-accent' : 'border-border hover:border-accent/50',
              )}
            >
              <div className="flex items-center gap-2 min-w-0">
                <TmRollIcon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <p className="font-medium text-sm truncate flex-1">{r.reference || '—'}</p>
                {!!r.bio && <Leaf className="h-3.5 w-3.5 text-green-600 flex-shrink-0" aria-label="Bio" />}
                {!!r.recycle && <Recycle className="h-3.5 w-3.5 text-teal-600 flex-shrink-0" aria-label="Recyclé" />}
              </div>
              {(r.designation || r.contexture_nom) && (
                <p className="text-xs text-muted-foreground mt-0.5 truncate">
                  {r.designation || r.contexture_nom}
                </p>
              )}
              <div className="flex items-center justify-between gap-2 mt-1 text-[11px] text-muted-foreground">
                <span className="truncate">{r.coloris_count} coloris</span>
                {r.prix != null && r.prix > 0 && (
                  <span className="flex-shrink-0 tabular-nums">{fmtNum(r.prix, 2)} €</span>
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
        {!isEditing && !archivedFilter && (
          <Button size="sm" variant="ghost" onClick={onNew} disabled={isCreating} className="text-accent hover:text-accent hover:bg-accent/10">
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
  onDuplicate,
  isDuplicating,
  onPrint,
  onEmail,
}: {
  detail: RefEcruDetail | null
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
  onDuplicate: () => void
  isDuplicating: boolean
  onPrint: () => void
  onEmail: () => void
}) {
  if (!detail && !isLoading) return null
  const archived = !!detail?.archive
  return (
    <div className="flex-shrink-0 pt-0.5">
      <div className="flex items-center gap-3">
        <div className={cn('h-11 w-11 rounded-lg flex items-center justify-center', isEditing ? 'bg-accent/15 text-accent' : 'icon-box-gold')}>
          <TmRollIcon className="h-5 w-5" />
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
              <h1 className="text-2xl font-heading font-bold tracking-tight truncate">{detail?.reference || '—'}</h1>
              {(detail?.designation || detail?.contexture_nom) && (
                <p className="text-sm text-muted-foreground truncate mt-0.5">{detail?.designation || detail?.contexture_nom}</p>
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
                <Button variant="outline" size="icon" className="h-9 w-9" title="Imprimer" onClick={onPrint}>
                  <Printer className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="icon" className="h-9 w-9" title="Envoyer un email" onClick={onEmail}>
                  <AtSign className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="icon" className="h-9 w-9" title="Dupliquer" onClick={onDuplicate} disabled={isDuplicating}>
                  {isDuplicating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Copy className="h-4 w-4" />}
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  title={archived ? 'Désarchiver' : 'Archiver'}
                  onClick={onArchive}
                  disabled={isArchiving}
                >
                  {isArchiving ? <Loader2 className="h-4 w-4 animate-spin" /> : archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
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
      <div className={cn('h-1 w-24 mt-3 rounded-full', isEditing ? 'bg-accent' : 'bg-gradient-to-r from-accent via-accent to-accent/30')} />
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
  clients,
  contextures,
  refsFil,
  machinesLk,
  onMutationSuccess,
  reportDirty,
}: {
  detail: RefEcruDetail | null
  isLoading: boolean
  hasSelection: boolean
  isEditing: boolean
  draft: HeaderDraft
  onDraftChange: (d: HeaderDraft) => void
  clients: ClientLookup[]
  contextures: ContextureLookup[]
  refsFil: RefFilLookup[]
  machinesLk: MachineLookup[]
  onMutationSuccess: () => void
  reportDirty: (key: string, dirty: boolean) => void
}) {
  if (!hasSelection) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="icon-box-gold h-16 w-16 mx-auto">
            <TmRollIcon className="h-8 w-8" />
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
      <IdentificationCard detail={detail} isEditing={isEditing} draft={draft} onDraftChange={onDraftChange} clients={clients} contextures={contextures} />
      <CompositionCard detail={detail} isEditing={isEditing} refId={detail.IDref_ecru} refsFil={refsFil} onMutationSuccess={onMutationSuccess} reportDirty={reportDirty} />
      <ColorisCard detail={detail} isEditing={isEditing} refId={detail.IDref_ecru} onMutationSuccess={onMutationSuccess} reportDirty={reportDirty} />
      <TechnicalTabs detail={detail} isEditing={isEditing} draft={draft} onDraftChange={onDraftChange} machinesLk={machinesLk} onMutationSuccess={onMutationSuccess} reportDirty={reportDirty} />
    </div>
  )
}

// ── Identification Card ────────────────────────────────

function IdentificationCard({
  detail,
  isEditing,
  draft,
  onDraftChange,
  clients,
  contextures,
}: {
  detail: RefEcruDetail
  isEditing: boolean
  draft: HeaderDraft
  onDraftChange: (d: HeaderDraft) => void
  clients: ClientLookup[]
  contextures: ContextureLookup[]
}) {
  // Fabric-defining fields are frozen once rolls or orders exist for this ref.
  const fieldsLocked = !!detail.has_rolls || !!detail.has_orders
  const lockTitle = 'Verrouillé : des rouleaux ou des commandes existent pour cette référence.'
  return (
    <Card className={cn('card-premium', isEditing && editSectionClass)}>
      <CardHeader className="flex flex-row items-center gap-2 p-4 space-y-0 pb-2">
        <Info className="h-4 w-4 text-accent" />
        <CardTitle className="text-sm font-semibold">Identification</CardTitle>
        {detail.contexture_nom && !isEditing && (
          <Badge variant="secondary" className="text-[10px] py-0 ml-auto">{detail.contexture_nom}</Badge>
        )}
      </CardHeader>
      <CardContent className="pb-4">
        {isEditing ? (
          <div className="space-y-3">
            <LabeledInput label="Désignation" value={draft.designation} onChange={(v) => onDraftChange({ ...draft, designation: v })} />
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Client</label>
                <SearchableCombobox<ClientLookup>
                  options={clients}
                  value={draft.IDclient}
                  onChange={(id) => onDraftChange({ ...draft, IDclient: id })}
                  getId={(c) => c.IDclient}
                  getPrimary={(c) => c.nom ?? `#${c.IDclient}`}
                  getSecondary={(c) => c.ville ?? undefined}
                  placeholder="Rechercher un client"
                />
              </div>
              <LabeledInput label="Référence client" value={draft.reference_client} onChange={(v) => onDraftChange({ ...draft, reference_client: v })} />
            </div>
            {fieldsLocked && (
              <div className="flex items-start gap-2 rounded-md border border-amber-400/40 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                <Lock className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                <span>Contexture, jauge, diamètre, bio et recyclé sont verrouillés car des rouleaux ou des commandes existent pour cette référence.</span>
              </div>
            )}
            <div className="grid grid-cols-4 gap-2">
              <div className="space-y-1 col-span-2">
                <label className="text-xs font-medium text-muted-foreground">Contexture</label>
                <PopoverSelect
                  options={contextures.map((c) => ({ id: c.IDcontexture, primary: c.nom ?? `#${c.IDcontexture}` }))}
                  value={draft.IDcontexture}
                  onChange={(id) => onDraftChange({ ...draft, IDcontexture: id })}
                  emptyLabel="— Choisir —"
                  disabled={fieldsLocked}
                  disabledTitle={lockTitle}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Jauge</label>
                <PopoverSelect
                  options={JAUGE_OPTIONS.map((o) => ({ id: o.ord, primary: o.label }))}
                  value={Number(draft.Jauge) || 0}
                  onChange={(id) => onDraftChange({ ...draft, Jauge: id ? String(id) : '' })}
                  emptyLabel="— Choisir —"
                  disabled={fieldsLocked}
                  disabledTitle={lockTitle}
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Ø</label>
                <PopoverSelect
                  options={DIAM_OPTIONS.map((o) => ({ id: o.ord, primary: o.label }))}
                  value={Number(draft.diametre) || 0}
                  onChange={(id) => onDraftChange({ ...draft, diametre: id ? String(id) : '' })}
                  emptyLabel="— Choisir —"
                  disabled={fieldsLocked}
                  disabledTitle={lockTitle}
                />
              </div>
            </div>
            <div className="grid grid-cols-4 gap-2 items-end">
              <LabeledInput label="Prix" suffix="€/kg" type="number" step="0.01" value={draft.prix} onChange={(v) => onDraftChange({ ...draft, prix: v })} />
              <label className="flex items-center gap-2 text-xs font-medium h-8" title={fieldsLocked ? lockTitle : undefined}>
                <Pill value={draft.bio} onChange={(v) => onDraftChange({ ...draft, bio: v })} disabled={fieldsLocked} />
                <span className="flex items-center gap-1"><Leaf className="h-3 w-3 text-green-600" />Bio</span>
              </label>
              <label className="flex items-center gap-2 text-xs font-medium h-8 col-span-2" title={fieldsLocked ? lockTitle : undefined}>
                <Pill value={draft.recycle} onChange={(v) => onDraftChange({ ...draft, recycle: v })} disabled={fieldsLocked} />
                <span className="flex items-center gap-1"><Recycle className="h-3 w-3 text-teal-600" />Recyclé</span>
              </label>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Commentaire</label>
              <textarea
                value={draft.commentaire}
                onChange={(e) => onDraftChange({ ...draft, commentaire: e.target.value })}
                rows={2}
                className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
              />
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-baseline gap-x-10 gap-y-2">
              <div className="flex items-baseline gap-2">
                <span className="text-xs text-muted-foreground">Client</span>
                <span className="text-sm font-medium">{detail.client_nom || '—'}</span>
              </div>
              {detail.reference_client?.trim() && (
                <div className="flex items-baseline gap-2">
                  <span className="text-xs text-muted-foreground">Réf. client</span>
                  <span className="text-sm">{detail.reference_client}</span>
                </div>
              )}
              <div className="flex items-baseline gap-2">
                <span className="text-xs text-muted-foreground">Prix</span>
                <span className="text-sm font-semibold tabular-nums">{detail.prix != null ? `${fmtNum(detail.prix, 2)} €/kg` : '—'}</span>
              </div>
            </div>
            <div className="flex flex-wrap items-baseline gap-x-10 gap-y-2">
              <div className="flex items-baseline gap-2">
                <span className="text-xs text-muted-foreground">Contexture</span>
                <span className="text-sm">{detail.contexture_nom || '—'}</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-xs text-muted-foreground">Jauge</span>
                <span className="text-sm tabular-nums">{jaugeLabel(detail.Jauge) ?? '—'}</span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-xs text-muted-foreground">Ø</span>
                <span className="text-sm tabular-nums">{diametreLabel(detail.diametre) ?? '—'}</span>
              </div>
              {(!!detail.bio || !!detail.recycle) && (
                <div className="flex items-center gap-1.5">
                  {!!detail.bio && <Badge className="badge-success text-[10px] py-0 px-1.5 gap-0.5"><Leaf className="h-2.5 w-2.5" />Bio</Badge>}
                  {!!detail.recycle && <Badge className="bg-teal-500/10 text-teal-700 ring-1 ring-teal-500/20 text-[10px] py-0 px-1.5 gap-0.5"><Recycle className="h-2.5 w-2.5" />Recyclé</Badge>}
                </div>
              )}
            </div>
            {detail.commentaire?.trim() && (
              <p className="text-sm text-muted-foreground whitespace-pre-line pt-1">{detail.commentaire}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── Composition Card (editable) ────────────────────────

interface CompoForm { IDref_fil: number; pourcentage: string; commentaire: string }

function CompositionCard({
  detail,
  isEditing,
  refId,
  refsFil,
  onMutationSuccess,
  reportDirty,
}: {
  detail: RefEcruDetail
  isEditing: boolean
  refId: number
  refsFil: RefFilLookup[]
  onMutationSuccess: () => void
  reportDirty: (key: string, dirty: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<CompoForm>({ IDref_fil: 0, pourcentage: '', commentaire: '' })
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  // Collapse by default each time a different ref is selected.
  useEffect(() => { setOpen(false) }, [refId])
  const [deleteTarget, setDeleteTarget] = useState<CompositionRow | null>(null)

  // Locked once rolls (stock_ecru) or tricoteur orders exist — changing the yarn
  // mix would desync produced stock from its declared composition.
  const locked = !!detail.has_rolls || !!detail.has_orders
  const canEdit = isEditing && !locked
  const lockReason =
    detail.has_rolls && detail.has_orders
      ? 'des rouleaux et des commandes existent'
      : detail.has_rolls
        ? 'des rouleaux ont été créés'
        : 'des commandes ont été créées'

  const reportDirtyRef = useRef(reportDirty)
  useEffect(() => { reportDirtyRef.current = reportDirty })
  useEffect(() => { reportDirtyRef.current('ecru-composition', showForm || editingId !== null) }, [showForm, editingId])
  useEffect(() => () => { reportDirtyRef.current('ecru-composition', false) }, [])

  const resetForm = () => { setForm({ IDref_fil: 0, pourcentage: '', commentaire: '' }); setShowForm(false); setEditingId(null); setErrorMsg(null) }
  const onMutError = (err: Error & { status?: number }) =>
    setErrorMsg(err.status === 409
      ? 'La composition ne peut pas être modifiée : des rouleaux ou des commandes existent déjà pour cette référence.'
      : "L'opération a échoué. Veuillez réessayer.")

  const createMut = useMutation({
    mutationFn: () => apiFetch(`/references-ecru/${refId}/compositions`, {
      method: 'POST',
      body: JSON.stringify({ IDref_fil: form.IDref_fil, pourcentage: Number(form.pourcentage) || 0, commentaire: form.commentaire }),
    }),
    onSuccess: () => { onMutationSuccess(); resetForm() },
    onError: onMutError,
  })
  const updateMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/references-ecru/${refId}/compositions/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ IDref_fil: form.IDref_fil, pourcentage: Number(form.pourcentage) || 0, commentaire: form.commentaire }),
    }),
    onSuccess: () => { onMutationSuccess(); resetForm() },
    onError: onMutError,
  })
  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/references-ecru/${refId}/compositions/${id}`, { method: 'DELETE' }),
    onSuccess: () => { onMutationSuccess(); setDeleteTarget(null) },
    onError: (err: Error & { status?: number }) => { setDeleteTarget(null); onMutError(err) },
  })

  const startEditRow = (c: CompositionRow) => {
    setEditingId(c.IDcomposition_ecru)
    setShowForm(false)
    setForm({ IDref_fil: c.IDref_fil, pourcentage: String(c.pourcentage ?? ''), commentaire: c.commentaire ?? '' })
  }

  const total = detail.composition_lines.reduce((s, c) => s + (Number(c.pourcentage) || 0), 0)
  const totalOk = detail.composition_lines.length === 0 || Math.abs(total - 100) < 0.01

  return (
    <>
      <Card className={cn('card-premium', isEditing && editSectionClass)}>
        <CardHeader className="flex flex-row items-center gap-2 p-4 space-y-0 pb-2 cursor-pointer select-none" onClick={() => setOpen(!open)}>
          <FlaskConical className="h-4 w-4 text-accent" />
          <CardTitle className="text-sm font-semibold">Composition</CardTitle>
          {locked && isEditing && <Lock className="h-3.5 w-3.5 text-muted-foreground" aria-label="Verrouillée" />}
          {canEdit && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0 text-accent hover:text-accent hover:bg-accent/10"
              onClick={(e) => { e.stopPropagation(); setShowForm(true); setEditingId(null); setForm({ IDref_fil: 0, pourcentage: '', commentaire: '' }); if (!open) setOpen(true) }}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          )}
          <Badge
            variant="secondary"
            className={cn('text-xs ml-auto tabular-nums', !totalOk && 'bg-destructive/10 text-destructive ring-1 ring-destructive/20')}
            title={totalOk ? 'Total composition' : 'La composition doit totaliser 100 %'}
          >
            {fmtNum(Math.round(total * 100) / 100, Number.isInteger(total) ? 0 : 2)}%
          </Badge>
          <Badge variant="secondary" className="text-xs">{detail.composition_lines.length}</Badge>
          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </CardHeader>
        {open && (
          <CardContent className="space-y-2 pb-3">
            {isEditing && locked && (
              <div className="flex items-start gap-2 rounded-md border border-amber-400/40 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                <Lock className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                <span>Composition verrouillée car {lockReason} pour cette référence. Elle ne peut plus être modifiée.</span>
              </div>
            )}
            {errorMsg && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                <span>{errorMsg}</span>
              </div>
            )}
            {detail.composition_lines.length === 0 && !showForm && (
              <p className="text-sm text-muted-foreground italic">Aucun fil</p>
            )}
            {detail.composition_lines.map((c) => {
              const isRowEditing = editingId === c.IDcomposition_ecru
              return (
                <div key={c.IDcomposition_ecru}>
                  {isRowEditing && canEdit ? (
                    <CompoFormView
                      form={form}
                      onFormChange={setForm}
                      refsFil={refsFil}
                      onCancel={resetForm}
                      onSave={() => updateMut.mutate(c.IDcomposition_ecru)}
                      isSaving={updateMut.isPending}
                      title="Modifier le fil"
                    />
                  ) : (
                    <div className={cn('group rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3', 'border-l-amber-400/60')}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-amber-400/10">
                            <FlaskConical className="h-3.5 w-3.5 text-amber-600" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{c.ref_fil_reference ?? '—'}</p>
                            <p className="text-[11px] text-muted-foreground truncate tabular-nums">{fmtPct(c.pourcentage)}</p>
                          </div>
                        </div>
                        {canEdit && (
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            <button onClick={() => startEditRow(c)} className="opacity-0 group-hover:opacity-100 p-0.5 text-muted-foreground hover:text-foreground transition-opacity" title="Modifier">
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button onClick={() => setDeleteTarget(c)} className="opacity-0 group-hover:opacity-100 p-0.5 text-destructive hover:text-destructive transition-opacity" title="Supprimer">
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                      {c.commentaire?.trim() && (
                        <p className="text-[11px] text-muted-foreground italic mt-1.5 ml-9">{c.commentaire}</p>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            {showForm && canEdit && (
              <CompoFormView
                form={form}
                onFormChange={setForm}
                refsFil={refsFil}
                onCancel={resetForm}
                onSave={() => createMut.mutate()}
                isSaving={createMut.isPending}
                title="Ajouter un fil"
              />
            )}
          </CardContent>
        )}
      </Card>
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Supprimer le fil"
        description={deleteTarget ? `${deleteTarget.ref_fil_reference ?? '—'} (${fmtPct(deleteTarget.pourcentage)}) sera retiré de la composition.` : undefined}
        isPending={deleteMut.isPending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => { if (deleteTarget) deleteMut.mutate(deleteTarget.IDcomposition_ecru) }}
      />
    </>
  )
}

function CompoFormView({
  form,
  onFormChange,
  refsFil,
  onCancel,
  onSave,
  isSaving,
  title,
}: {
  form: CompoForm
  onFormChange: (f: CompoForm) => void
  refsFil: RefFilLookup[]
  onCancel: () => void
  onSave: () => void
  isSaving: boolean
  title: string
}) {
  const canSave = form.IDref_fil > 0 && Number(form.pourcentage) > 0
  return (
    <div className="rounded-lg border border-accent/25 bg-accent/[0.03] p-4 space-y-3">
      <p className="text-xs font-semibold text-accent uppercase tracking-wide">{title}</p>
      <div className="grid grid-cols-3 gap-2">
        <div className="space-y-1 col-span-2">
          <label className="text-xs font-medium text-muted-foreground">Fil</label>
          <SearchableCombobox<RefFilLookup>
            options={refsFil}
            value={form.IDref_fil}
            onChange={(id) => onFormChange({ ...form, IDref_fil: id })}
            getId={(r) => r.IDref_fil}
            getPrimary={(r) => r.reference ?? `#${r.IDref_fil}`}
            getSecondary={(r) => (r.prix_kg != null ? `${fmtNum(r.prix_kg, 2)} €/kg` : undefined)}
            placeholder="Rechercher un fil"
            size="sm"
          />
        </div>
        <LabeledInput label="Pourcentage (%)" type="number" step="0.1" value={form.pourcentage} onChange={(v) => onFormChange({ ...form, pourcentage: v })} />
      </div>
      <LabeledInput label="Commentaire" value={form.commentaire} onChange={(v) => onFormChange({ ...form, commentaire: v })} />
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" size="sm" onClick={onCancel}>Annuler</Button>
        <Button size="sm" onClick={onSave} disabled={!canSave || isSaving}>
          {isSaving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
          Enregistrer
        </Button>
      </div>
    </div>
  )
}

// ── Coloris Card (editable) ────────────────────────────

interface ColorisForm { reference: string; commentaire: string; suivis: boolean }

function ColorisCard({
  detail,
  isEditing,
  refId,
  onMutationSuccess,
  reportDirty,
}: {
  detail: RefEcruDetail
  isEditing: boolean
  refId: number
  onMutationSuccess: () => void
  reportDirty: (key: string, dirty: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<ColorisForm>({ reference: '', commentaire: '', suivis: false })
  // Collapse by default each time a different ref is selected.
  useEffect(() => { setOpen(false) }, [refId])
  const [deleteTarget, setDeleteTarget] = useState<ColorisRow | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const reportDirtyRef = useRef(reportDirty)
  useEffect(() => { reportDirtyRef.current = reportDirty })
  useEffect(() => { reportDirtyRef.current('ecru-coloris', showForm || editingId !== null) }, [showForm, editingId])
  useEffect(() => () => { reportDirtyRef.current('ecru-coloris', false) }, [])

  const resetForm = () => { setForm({ reference: '', commentaire: '', suivis: false }); setShowForm(false); setEditingId(null); setErrorMsg(null) }

  const createMut = useMutation({
    mutationFn: () => apiFetch(`/references-ecru/${refId}/coloris`, { method: 'POST', body: JSON.stringify(form) }),
    onSuccess: () => { onMutationSuccess(); resetForm() },
  })
  const updateMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/references-ecru/${refId}/coloris/${id}`, { method: 'PUT', body: JSON.stringify(form) }),
    onSuccess: () => { onMutationSuccess(); resetForm() },
  })
  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/references-ecru/${refId}/coloris/${id}`, { method: 'DELETE' }),
    onSuccess: () => { onMutationSuccess(); setDeleteTarget(null); setErrorMsg(null) },
    onError: async () => {
      let msg = 'Suppression impossible.'
      try {
        const res = await fetch(
          `${import.meta.env.VITE_API_URL || 'http://localhost:3002/api'}/references-ecru/${refId}/coloris/${deleteTarget?.IDcolori_ecru}`,
          { method: 'DELETE', credentials: 'include' },
        )
        if (!res.ok) { const b = await res.json().catch(() => null); if (b?.error) msg = String(b.error) }
      } catch { /* keep default */ }
      setErrorMsg(msg)
    },
  })

  const startEditRow = (c: ColorisRow) => {
    setEditingId(c.IDcolori_ecru)
    setShowForm(false)
    setForm({ reference: c.reference ?? '', commentaire: c.commentaire ?? '', suivis: !!c.suivis })
  }

  return (
    <>
      <Card className={cn('card-premium', isEditing && editSectionClass)}>
        <CardHeader className="flex flex-row items-center gap-2 p-4 space-y-0 pb-2 cursor-pointer select-none" onClick={() => setOpen(!open)}>
          <Palette className="h-4 w-4 text-accent" />
          <CardTitle className="text-sm font-semibold">Coloris</CardTitle>
          {isEditing && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0 text-accent hover:text-accent hover:bg-accent/10"
              onClick={(e) => { e.stopPropagation(); setShowForm(true); setEditingId(null); setForm({ reference: '', commentaire: '', suivis: false }); if (!open) setOpen(true) }}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          )}
          {detail.cout_kg != null && (
            <Badge className="text-[11px] py-0 px-2 ml-auto bg-accent/10 text-accent ring-1 ring-accent/20 tabular-nums" title="Coût matière + façon par kg">
              Coût/kg : {fmtNum(detail.cout_kg, 2)} €
            </Badge>
          )}
          <Badge variant="secondary" className={cn('text-xs', detail.cout_kg == null && 'ml-auto')}>{detail.coloris.length}</Badge>
          <ChevronDown className={cn('h-4 w-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
        </CardHeader>
        {open && (
          <CardContent className="space-y-2 pb-3">
            {detail.coloris.length === 0 && !showForm && (
              <p className="text-sm text-muted-foreground italic">Aucun coloris</p>
            )}
            {detail.coloris.map((c) => {
              const isRowEditing = editingId === c.IDcolori_ecru
              const inUse = c.rolls || c.orders || c.has_specific_composition
              const deleteTitle = !inUse
                ? 'Supprimer'
                : c.rolls
                  ? 'Coloris utilisé par des rouleaux — suppression impossible'
                  : c.orders
                    ? 'Coloris utilisé par une commande — suppression impossible'
                    : 'Coloris avec une composition spécifique — suppression impossible'
              return (
                <div key={c.IDcolori_ecru}>
                  {isRowEditing && isEditing ? (
                    <ColorisFormView form={form} onFormChange={setForm} onCancel={resetForm} onSave={() => updateMut.mutate(c.IDcolori_ecru)} isSaving={updateMut.isPending} title="Modifier le coloris" />
                  ) : (
                    <div className={cn('group rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3', 'border-l-amber-400/60')}>
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-amber-400/10">
                            <Palette className="h-3.5 w-3.5 text-amber-600" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-sm font-medium truncate">{c.reference ?? '—'}</p>
                            {c.commentaire?.trim() && <p className="text-[11px] text-muted-foreground truncate">{c.commentaire}</p>}
                          </div>
                        </div>
                        {isEditing && (
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            <button onClick={() => startEditRow(c)} className="opacity-0 group-hover:opacity-100 p-0.5 text-muted-foreground hover:text-foreground transition-opacity" title="Modifier">
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => { if (!inUse) { setErrorMsg(null); setDeleteTarget(c) } }}
                              aria-disabled={inUse}
                              className={cn(
                                'opacity-0 group-hover:opacity-100 p-0.5 transition-opacity',
                                inUse ? 'text-muted-foreground/40 cursor-not-allowed' : 'text-destructive hover:text-destructive',
                              )}
                              title={deleteTitle}
                            >
                              {inUse ? <Lock className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
            {showForm && isEditing && (
              <ColorisFormView form={form} onFormChange={setForm} onCancel={resetForm} onSave={() => createMut.mutate()} isSaving={createMut.isPending} title="Ajouter un coloris" />
            )}
          </CardContent>
        )}
      </Card>
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Supprimer le coloris"
        description={errorMsg ?? (deleteTarget ? `${deleteTarget.reference ?? '—'} sera supprimé.` : undefined)}
        isPending={deleteMut.isPending}
        onCancel={() => { setDeleteTarget(null); setErrorMsg(null) }}
        onConfirm={() => { if (deleteTarget) deleteMut.mutate(deleteTarget.IDcolori_ecru) }}
      />
    </>
  )
}

function ColorisFormView({
  form,
  onFormChange,
  onCancel,
  onSave,
  isSaving,
  title,
}: {
  form: ColorisForm
  onFormChange: (f: ColorisForm) => void
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
        <LabeledInput label="Référence" value={form.reference} onChange={(v) => onFormChange({ ...form, reference: v })} />
        <LabeledInput label="Commentaire" value={form.commentaire} onChange={(v) => onFormChange({ ...form, commentaire: v })} />
      </div>
      <label className="flex items-center gap-2 text-xs font-medium">
        <Pill value={form.suivis} onChange={(v) => onFormChange({ ...form, suivis: v })} />
        <span>Suivi</span>
      </label>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" size="sm" onClick={onCancel}>Annuler</Button>
        <Button size="sm" onClick={onSave} disabled={!canSave || isSaving}>
          {isSaving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
          Enregistrer
        </Button>
      </div>
    </div>
  )
}

// ── Technical Tabs (Données Technique / Obs OF / Schéma de Liage) ──

function TechnicalTabs({
  detail,
  isEditing,
  draft,
  onDraftChange,
  machinesLk,
  onMutationSuccess,
  reportDirty,
}: {
  detail: RefEcruDetail
  isEditing: boolean
  draft: HeaderDraft
  onDraftChange: (d: HeaderDraft) => void
  machinesLk: MachineLookup[]
  onMutationSuccess: () => void
  reportDirty: (key: string, dirty: boolean) => void
}) {
  const [tab, setTab] = useState<'donnees' | 'obs' | 'liage'>('donnees')
  const tabs: { key: 'donnees' | 'obs' | 'liage'; label: string; icon: typeof Cog }[] = [
    { key: 'donnees', label: 'Données technique', icon: Cog },
    { key: 'obs', label: 'Obs OF', icon: ClipboardList },
    { key: 'liage', label: 'Schéma de liage', icon: Grid3x3 },
  ]
  return (
    <Card className={cn('card-premium', isEditing && editSectionClass)}>
      <div className="flex border-b p-1 gap-1">
        {tabs.map((t) => {
          const Icon = t.icon
          const active = tab === t.key
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
                active ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              <span>{t.label}</span>
            </button>
          )
        })}
      </div>
      <CardContent className="pt-4 pb-4">
        {tab === 'donnees' && (
          <DonneesTechnique
            detail={detail}
            isEditing={isEditing}
            draft={draft}
            onDraftChange={onDraftChange}
            machinesLk={machinesLk}
            onMutationSuccess={onMutationSuccess}
            reportDirty={reportDirty}
          />
        )}
        {tab === 'obs' && <ObsOfTab detail={detail} isEditing={isEditing} onMutationSuccess={onMutationSuccess} />}
        {tab === 'liage' && <SchemaLiageTab detail={detail} isEditing={isEditing} onMutationSuccess={onMutationSuccess} reportDirty={reportDirty} />}
      </CardContent>
    </Card>
  )
}

// ── Données Technique tab ──────────────────────────────

function DonneesTechnique({
  detail,
  isEditing,
  draft,
  onDraftChange,
  machinesLk,
  onMutationSuccess,
  reportDirty,
}: {
  detail: RefEcruDetail
  isEditing: boolean
  draft: HeaderDraft
  onDraftChange: (d: HeaderDraft) => void
  machinesLk: MachineLookup[]
  onMutationSuccess: () => void
  reportDirty: (key: string, dirty: boolean) => void
}) {
  return (
    <div className="space-y-4">
      {/* LFA/TOUR + PIGNONS */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">LFA / TOUR</p>
          <div className="grid grid-cols-4 gap-1.5">
            {(['lfa_tour_1', 'lfa_tour_2', 'lfa_tour_3', 'lfa_tour_4'] as const).map((k) =>
              isEditing ? (
                <input key={k} value={draft[k]} onChange={(e) => onDraftChange({ ...draft, [k]: e.target.value })} className={cn(inputClass, 'text-center px-1')} />
              ) : (
                <div key={k} className="h-8 flex items-center justify-center text-sm rounded-md border border-border/60 bg-zinc-50 tabular-nums">{detail[k] || '—'}</div>
              ),
            )}
          </div>
        </div>
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">Pignons</p>
          <div className="grid grid-cols-4 gap-1.5">
            {(['poulies_1', 'poulies_2', 'poulies_3', 'poulies_4'] as const).map((k) =>
              isEditing ? (
                <input key={k} value={draft[k]} onChange={(e) => onDraftChange({ ...draft, [k]: e.target.value })} className={cn(inputClass, 'text-center px-1')} />
              ) : (
                <div key={k} className="h-8 flex items-center justify-center text-sm rounded-md border border-border/60 bg-zinc-50 tabular-nums">{detail[k] || '—'}</div>
              ),
            )}
          </div>
        </div>
      </div>

      {/* Machine grid */}
      <MachineGrid detail={detail} isEditing={isEditing} machinesLk={machinesLk} onMutationSuccess={onMutationSuccess} reportDirty={reportDirty} />

      {/* Scalar technical fields */}
      {isEditing ? (
        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <LabeledInput label="Écarteur" type="number" step="0.01" value={draft.ecarteur} onChange={(v) => onDraftChange({ ...draft, ecarteur: v })} />
            <LabeledInput label="Laize TBM" type="number" step="0.01" value={draft.laize_tbm} onChange={(v) => onDraftChange({ ...draft, laize_tbm: v })} />
            <LabeledInput label="Poids/m² TBM" type="number" step="0.01" value={draft.poids_m2_tbm} onChange={(v) => onDraftChange({ ...draft, poids_m2_tbm: v })} />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <LabeledInput label="Rendement" type="number" step="0.01" value={draft.rendement} onChange={(v) => onDraftChange({ ...draft, rendement: v })} />
            <LabeledInput label="Vitesse cible" suffix="rpm" type="number" step="0.1" value={draft.vitesse_cible} onChange={(v) => onDraftChange({ ...draft, vitesse_cible: v })} />
            <LabeledInput label="Poids pièce" suffix="kg" type="number" step="0.01" value={draft.poids} onChange={(v) => onDraftChange({ ...draft, poids: v })} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Tombé du métier</label>
              <PopoverSelect
                options={TOMBE_OPTIONS.map((o) => ({ id: o.id, primary: o.label }))}
                value={tombeId(draft.tombe_metier)}
                onChange={(id) => onDraftChange({ ...draft, tombe_metier: tombeValue(id) })}
                emptyLabel="— Choisir —"
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-x-8 gap-y-2 pt-1">
            <label className="flex items-center gap-2 text-sm"><Pill value={draft.maille_ouverture} onChange={(v) => onDraftChange({ ...draft, maille_ouverture: v })} />Maille d'ouverture</label>
            <label className="flex items-center gap-2 text-sm"><Pill value={draft.ouvert_visiteuse} onChange={(v) => onDraftChange({ ...draft, ouvert_visiteuse: v })} />Ouvert au large</label>
            <label className="flex items-center gap-2 text-sm"><Pill value={draft.sonneter} onChange={(v) => onDraftChange({ ...draft, sonneter: v })} />Sonneter</label>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Observations</label>
            <textarea value={draft.observations} onChange={(e) => onDraftChange({ ...draft, observations: e.target.value })} rows={3} className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y" />
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2">
            <SpecInline label="Écarteur" value={detail.ecarteur} />
            <SpecInline label="Laize TBM" value={detail.laize_tbm} />
            <SpecInline label="Poids/m² TBM" value={detail.poids_m2_tbm} />
            <SpecInline label="Rendement" value={detail.rendement} />
            <SpecInline label="Vitesse cible" value={detail.vitesse_cible} unit="rpm" />
            <SpecInline label="Poids pièce" value={detail.poids} unit="kg" />
          </div>
          <div className="flex flex-wrap items-center gap-x-8 gap-y-2">
            <div className="flex items-baseline gap-2">
              <span className="text-xs text-muted-foreground">Tombé du métier</span>
              <span className="text-sm">{tombeValue(tombeId(detail.tombe_metier)) || '—'}</span>
            </div>
            <div className="flex items-center gap-1.5">
              {!!detail.maille_ouverture && <Badge variant="secondary" className="text-[10px] py-0">Maille d'ouverture</Badge>}
              {!!detail.ouvert_visiteuse && <Badge variant="secondary" className="text-[10px] py-0">Ouvert au large</Badge>}
              {!!detail.sonneter && <Badge variant="secondary" className="text-[10px] py-0">Sonneter</Badge>}
            </div>
          </div>
          {detail.observations?.trim() && (
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-0.5">Observations</p>
              <p className="text-sm text-muted-foreground whitespace-pre-line">{detail.observations}</p>
            </div>
          )}
        </div>
      )}

      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground pt-1 border-t border-border/50">
        <Calendar className="h-3 w-3" />
        Dernière mise à jour : {detail.date_maj_ft ? formatHfsqlDate(detail.date_maj_ft) : '—'}
      </div>
    </div>
  )
}

function SpecInline({ label, value, unit }: { label: string; value: number | null; unit?: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-semibold tabular-nums">
        {value == null ? '—' : fmtNum(value, Number.isInteger(value) ? 0 : 2)}
        {value != null && unit ? <span className="text-xs text-muted-foreground font-normal"> {unit}</span> : null}
      </span>
    </div>
  )
}

// ── Machine grid ───────────────────────────────────────

interface MachineForm {
  IDmachine: number
  repere_1: string; repere_2: string; repere_3: string; repere_4: string; repere_5: string
  hauteur_pl: string; abattage: string; trs_10kg_chute: string; nb_chutes: string
}

function emptyMachineForm(): MachineForm {
  return { IDmachine: 0, repere_1: '', repere_2: '', repere_3: '', repere_4: '', repere_5: '', hauteur_pl: '', abattage: '', trs_10kg_chute: '', nb_chutes: '' }
}

function MachineGrid({
  detail,
  isEditing,
  machinesLk,
  onMutationSuccess,
  reportDirty,
}: {
  detail: RefEcruDetail
  isEditing: boolean
  machinesLk: MachineLookup[]
  onMutationSuccess: () => void
  reportDirty: (key: string, dirty: boolean) => void
}) {
  const refId = detail.IDref_ecru
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<MachineForm>(emptyMachineForm())
  const [deleteTarget, setDeleteTarget] = useState<MachineRow | null>(null)

  const reportDirtyRef = useRef(reportDirty)
  useEffect(() => { reportDirtyRef.current = reportDirty })
  useEffect(() => { reportDirtyRef.current('ecru-machines', showForm || editingId !== null) }, [showForm, editingId])
  useEffect(() => () => { reportDirtyRef.current('ecru-machines', false) }, [])

  const resetForm = () => { setForm(emptyMachineForm()); setShowForm(false); setEditingId(null) }
  const body = () => ({
    IDmachine: form.IDmachine,
    repere_1: form.repere_1, repere_2: form.repere_2, repere_3: form.repere_3, repere_4: form.repere_4, repere_5: form.repere_5,
    hauteur_pl: form.hauteur_pl, abattage: form.abattage,
    trs_10kg_chute: form.trs_10kg_chute.trim() === '' ? null : Number(form.trs_10kg_chute),
    nb_chutes: form.nb_chutes.trim() === '' ? null : Number(form.nb_chutes),
  })
  const createMut = useMutation({
    mutationFn: () => apiFetch(`/references-ecru/${refId}/machines`, { method: 'POST', body: JSON.stringify(body()) }),
    onSuccess: () => { onMutationSuccess(); resetForm() },
  })
  const updateMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/references-ecru/${refId}/machines/${id}`, { method: 'PUT', body: JSON.stringify(body()) }),
    onSuccess: () => { onMutationSuccess(); resetForm() },
  })
  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/references-ecru/${refId}/machines/${id}`, { method: 'DELETE' }),
    onSuccess: () => { onMutationSuccess(); setDeleteTarget(null) },
  })

  const startEditRow = (m: MachineRow) => {
    setEditingId(m.IDref_ecru_machine)
    setShowForm(false)
    setForm({
      IDmachine: m.IDmachine,
      repere_1: m.repere_1 ?? '', repere_2: m.repere_2 ?? '', repere_3: m.repere_3 ?? '', repere_4: m.repere_4 ?? '', repere_5: m.repere_5 ?? '',
      hauteur_pl: m.hauteur_pl ?? '', abattage: m.abattage ?? '',
      trs_10kg_chute: numStr(m.trs_10kg_chute), nb_chutes: numStr(m.nb_chutes),
    })
  }

  const cols = ['Métier', 'Rep. 1', 'Rep. 2', 'Rep. 3', 'Rep. 4', 'Rep. 5', 'Hauteur Pl', 'Abattage', 'Trs/10Kg/Ch.', 'Nb chutes', 'Cpt. saisie', 'Cpt. calculé']

  return (
    <>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Cog className="h-4 w-4 text-accent" />
          <p className="text-sm font-semibold">Réglages par métier</p>
          <Badge variant="secondary" className="text-xs">{detail.machines.length}</Badge>
          {isEditing && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0 ml-auto text-accent hover:text-accent hover:bg-accent/10"
              onClick={() => { setShowForm(true); setEditingId(null); setForm(emptyMachineForm()) }}
              title="Ajouter un métier"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>

        {detail.machines.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">Aucun réglage machine</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border/60">
            <table className="w-full text-sm" style={{ tableLayout: 'auto' }}>
              <thead className="bg-zinc-200/60 border-b border-border/60">
                <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  {cols.map((c) => (
                    <th key={c} className="px-2.5 py-2 text-left font-semibold whitespace-nowrap">{c}</th>
                  ))}
                  {isEditing && <th className="px-2 py-2" />}
                </tr>
              </thead>
              <tbody>
                {detail.machines.map((m) => (
                  <tr key={m.IDref_ecru_machine} className="border-b border-border/40 last:border-0 hover:bg-accent/5">
                    <td className="px-2.5 py-1.5 font-medium whitespace-nowrap">{m.machine_nom || `#${m.IDmachine}`}</td>
                    <td className="px-2.5 py-1.5 tabular-nums">{m.repere_1 || ''}</td>
                    <td className="px-2.5 py-1.5 tabular-nums">{m.repere_2 || ''}</td>
                    <td className="px-2.5 py-1.5 tabular-nums">{m.repere_3 || ''}</td>
                    <td className="px-2.5 py-1.5 tabular-nums">{m.repere_4 || ''}</td>
                    <td className="px-2.5 py-1.5 tabular-nums">{m.repere_5 || ''}</td>
                    <td className="px-2.5 py-1.5 whitespace-nowrap">{m.hauteur_pl || ''}</td>
                    <td className="px-2.5 py-1.5">{m.abattage || ''}</td>
                    <td className="px-2.5 py-1.5 tabular-nums">{m.trs_10kg_chute != null ? fmtNum(m.trs_10kg_chute, 0) : ''}</td>
                    <td className="px-2.5 py-1.5 tabular-nums">{m.nb_chutes != null ? fmtNum(m.nb_chutes, 0) : ''}</td>
                    <td className="px-2.5 py-1.5 tabular-nums font-medium">{fmtNum(m.compteur_saisie, 0)}</td>
                    <td className="px-2.5 py-1.5 tabular-nums text-muted-foreground">{fmtNum(m.compteur_calcule, 0)}</td>
                    {isEditing && (
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-1">
                          <button onClick={() => startEditRow(m)} className="p-0.5 text-muted-foreground hover:text-foreground" title="Modifier"><Pencil className="h-3.5 w-3.5" /></button>
                          <button onClick={() => setDeleteTarget(m)} className="p-0.5 text-destructive hover:text-destructive" title="Supprimer"><Trash2 className="h-3.5 w-3.5" /></button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <MachineFormDialog
          open={(showForm || editingId !== null) && isEditing}
          form={form}
          onFormChange={setForm}
          machinesLk={machinesLk}
          onCancel={resetForm}
          onSave={() => (editingId !== null ? updateMut.mutate(editingId) : createMut.mutate())}
          isSaving={createMut.isPending || updateMut.isPending}
          title={editingId !== null ? 'Modifier le métier' : 'Ajouter un métier'}
        />
      </div>
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Supprimer le réglage machine"
        description={deleteTarget ? `Le réglage pour ${deleteTarget.machine_nom ?? `#${deleteTarget.IDmachine}`} sera supprimé.` : undefined}
        isPending={deleteMut.isPending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => { if (deleteTarget) deleteMut.mutate(deleteTarget.IDref_ecru_machine) }}
      />
    </>
  )
}

function MachineFormDialog({
  open,
  form,
  onFormChange,
  machinesLk,
  onCancel,
  onSave,
  isSaving,
  title,
}: {
  open: boolean
  form: MachineForm
  onFormChange: (f: MachineForm) => void
  machinesLk: MachineLookup[]
  onCancel: () => void
  onSave: () => void
  isSaving: boolean
  title: string
}) {
  const canSave = form.IDmachine > 0
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel() }}>
      <DialogContent className="max-w-2xl" onClose={onCancel}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cog className="h-5 w-5 text-accent" />
            {title}
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Métier</label>
            <PopoverSelect
              options={machinesLk.map((m) => ({ id: m.IDmachine, primary: m.nom ?? `#${m.IDmachine}`, secondary: m.Jauge != null ? `J${fmtNum(m.Jauge, 0)}` : undefined }))}
              value={form.IDmachine}
              onChange={(id) => onFormChange({ ...form, IDmachine: id })}
              emptyLabel="— Choisir —"
            />
          </div>
          <div className="grid grid-cols-5 gap-2">
            <LabeledInput label="Rep. 1" value={form.repere_1} onChange={(v) => onFormChange({ ...form, repere_1: v })} />
            <LabeledInput label="Rep. 2" value={form.repere_2} onChange={(v) => onFormChange({ ...form, repere_2: v })} />
            <LabeledInput label="Rep. 3" value={form.repere_3} onChange={(v) => onFormChange({ ...form, repere_3: v })} />
            <LabeledInput label="Rep. 4" value={form.repere_4} onChange={(v) => onFormChange({ ...form, repere_4: v })} />
            <LabeledInput label="Rep. 5" value={form.repere_5} onChange={(v) => onFormChange({ ...form, repere_5: v })} />
          </div>
          <div className="grid grid-cols-4 gap-2">
            <LabeledInput label="Hauteur Pl" value={form.hauteur_pl} onChange={(v) => onFormChange({ ...form, hauteur_pl: v })} />
            <LabeledInput label="Abattage" value={form.abattage} onChange={(v) => onFormChange({ ...form, abattage: v })} />
            <LabeledInput label="Trs/10Kg/Ch." type="number" value={form.trs_10kg_chute} onChange={(v) => onFormChange({ ...form, trs_10kg_chute: v })} />
            <LabeledInput label="Nb chutes" type="number" value={form.nb_chutes} onChange={(v) => onFormChange({ ...form, nb_chutes: v })} />
          </div>
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onCancel}>Annuler</Button>
          <Button onClick={onSave} disabled={!canSave || isSaving}>
            {isSaving ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Obs OF tab ─────────────────────────────────────────
//
// Read-only here; TRM injects an editable panel through `ObsOfEditorContext`
// (see the comment on that context). The two never render at once.

function ObsOfTab({ detail, isEditing, onMutationSuccess }: { detail: RefEcruDetail; isEditing: boolean; onMutationSuccess: () => void }) {
  const Editor = useContext(ObsOfEditorContext)
  if (Editor) {
    return (
      <Editor
        refId={detail.IDref_ecru}
        refLabel={detail.reference ?? ''}
        rows={detail.obs_of}
        isEditing={isEditing}
        onChanged={onMutationSuccess}
      />
    )
  }
  if (detail.obs_of.length === 0) {
    return <p className="text-sm text-muted-foreground italic">Aucune observation OF</p>
  }
  return (
    <div className="space-y-2">
      {detail.obs_of.map((o) => (
        <div key={o.IDobs_ref_ecru} className="rounded-lg border border-border/60 bg-zinc-100/80 p-3">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground mb-1">
            {o.date && <span className="inline-flex items-center gap-1"><Calendar className="h-3 w-3" />{formatHfsqlDate(o.date)}</span>}
            {o.machine_nom && <Badge variant="secondary" className="text-[10px] py-0">{o.machine_nom}</Badge>}
            {o.colori_reference && <Badge variant="secondary" className="text-[10px] py-0 gap-1"><Palette className="h-2.5 w-2.5" />{o.colori_reference}</Badge>}
          </div>
          <p className="text-sm whitespace-pre-line">{o.observation || '—'}</p>
        </div>
      ))}
    </div>
  )
}

// ── Schéma de Liage tab ────────────────────────────────

/** Render one knit-binding symbol as a small glyph. icone like "front_stitch.png". */
function SymboleGlyph({ icone, size = 16 }: { icone: string | null; size?: number }) {
  if (!icone) return null
  const isFront = icone.startsWith('front')
  const kind = icone.includes('stitch') ? 'stitch' : icone.includes('float') ? 'float' : icone.includes('tuck') ? 'tuck' : null
  const color = isFront ? '#143D6B' : '#3B7DC9'
  const sw = 1.8
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden>
      {kind === 'stitch' && <polyline points="3,5 9,13 15,5" stroke={color} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />}
      {kind === 'float' && <line x1="3" y1="9" x2="15" y2="9" stroke={color} strokeWidth={sw} strokeLinecap="round" />}
      {kind === 'tuck' && <path d="M4 4 L4 9 Q4 14 9 14 Q14 14 14 9 L14 4" stroke={color} strokeWidth={sw} strokeLinecap="round" fill="none" />}
      {!isFront && <circle cx="9" cy="9" r="8" stroke={color} strokeWidth="0.6" strokeDasharray="2 2" opacity="0.5" />}
    </svg>
  )
}

function symboleLabel(icone: string | null): string {
  if (!icone) return ''
  const face = icone.startsWith('front') ? 'Endroit' : 'Envers'
  const kind = icone.includes('stitch') ? 'maille' : icone.includes('float') ? 'flottée' : icone.includes('tuck') ? 'charge' : ''
  return `${face} · ${kind}`
}

function SchemaLiageTab({
  detail,
  isEditing,
  onMutationSuccess,
  reportDirty,
}: {
  detail: RefEcruDetail
  isEditing: boolean
  onMutationSuccess: () => void
  reportDirty: (key: string, dirty: boolean) => void
}) {
  const refId = detail.IDref_ecru
  const [brush, setBrush] = useState<number>(detail.symboles[0]?.IDsymbole_liage ?? 0) // 0 = eraser
  const [chuteForm, setChuteForm] = useState<{ open: boolean; editId: number | null; lfa1: string; lfa2: string; comp1: number; comp2: number }>({
    open: false, editId: null, lfa1: '', lfa2: '', comp1: 0, comp2: 0,
  })
  const [deleteChute, setDeleteChute] = useState<ChuteRow | null>(null)

  const reportDirtyRef = useRef(reportDirty)
  useEffect(() => { reportDirtyRef.current = reportDirty })
  useEffect(() => { reportDirtyRef.current('ecru-liage', chuteForm.open || chuteForm.editId !== null) }, [chuteForm.open, chuteForm.editId])
  useEffect(() => () => { reportDirtyRef.current('ecru-liage', false) }, [])

  const setCellMut = useMutation({
    mutationFn: (vars: { IDchute_liage: number; num_symbole: number; IDsymbole_liage: number }) =>
      apiFetch(`/references-ecru/${refId}/liage/cells`, { method: 'PUT', body: JSON.stringify(vars) }),
    onSuccess: () => onMutationSuccess(),
  })
  const addChuteMut = useMutation({
    mutationFn: () => apiFetch(`/references-ecru/${refId}/liage/chutes`, {
      method: 'POST',
      body: JSON.stringify({ IDcomposition_ecru1: chuteForm.comp1, IDcomposition_ecru2: chuteForm.comp2, lfa1: chuteForm.lfa1.trim() === '' ? null : Number(chuteForm.lfa1), lfa2: chuteForm.lfa2.trim() === '' ? null : Number(chuteForm.lfa2) }),
    }),
    onSuccess: () => { onMutationSuccess(); setChuteForm({ open: false, editId: null, lfa1: '', lfa2: '', comp1: 0, comp2: 0 }) },
  })
  const updateChuteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/references-ecru/${refId}/liage/chutes/${id}`, {
      method: 'PUT',
      body: JSON.stringify({ IDcomposition_ecru1: chuteForm.comp1, IDcomposition_ecru2: chuteForm.comp2, lfa1: chuteForm.lfa1.trim() === '' ? null : Number(chuteForm.lfa1), lfa2: chuteForm.lfa2.trim() === '' ? null : Number(chuteForm.lfa2) }),
    }),
    onSuccess: () => { onMutationSuccess(); setChuteForm({ open: false, editId: null, lfa1: '', lfa2: '', comp1: 0, comp2: 0 }) },
  })
  const deleteChuteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/references-ecru/${refId}/liage/chutes/${id}`, { method: 'DELETE' }),
    onSuccess: () => { onMutationSuccess(); setDeleteChute(null) },
  })

  const chutes = [...detail.chutes].sort((a, b) => a.num_chute - b.num_chute)
  const cellMap = useMemo(() => {
    const m = new Map<string, number>()
    for (const c of detail.cells) m.set(`${c.IDchute_liage}:${c.num_symbole}`, c.IDsymbole_liage)
    return m
  }, [detail.cells])
  const maxSym = detail.cells.reduce((mx, c) => Math.max(mx, c.num_symbole), 0)
  const numCols = Math.max(maxSym + (isEditing ? 2 : 0), 8)
  const compById = useMemo(() => {
    const m = new Map<number, CompositionRow>()
    for (const c of detail.composition_lines) m.set(c.IDcomposition_ecru, c)
    return m
  }, [detail.composition_lines])

  const paintCell = (IDchute_liage: number, num_symbole: number) => {
    if (!isEditing) return
    const current = cellMap.get(`${IDchute_liage}:${num_symbole}`) ?? 0
    const next = brush === 0 ? 0 : current === brush ? 0 : brush
    setCellMut.mutate({ IDchute_liage, num_symbole, IDsymbole_liage: next })
  }

  const compLabel = (id: number) => (id > 0 ? compById.get(id)?.ref_fil_reference ?? `#${id}` : '—')

  return (
    <div className="space-y-3">
      {/* Palette (edit mode) */}
      {isEditing && (
        <div className="flex items-center gap-2 flex-wrap rounded-lg border border-border/60 bg-zinc-50 p-2">
          <span className="text-xs font-medium text-muted-foreground mr-1">Symbole :</span>
          {detail.symboles.map((s) => (
            <button
              key={s.IDsymbole_liage}
              type="button"
              onClick={() => setBrush(s.IDsymbole_liage)}
              title={symboleLabel(s.icone)}
              className={cn('h-8 w-8 rounded-md border flex items-center justify-center bg-white transition-colors', brush === s.IDsymbole_liage ? 'border-accent ring-2 ring-accent/40' : 'border-border hover:border-accent/50')}
            >
              <SymboleGlyph icone={s.icone} />
            </button>
          ))}
          <button
            type="button"
            onClick={() => setBrush(0)}
            title="Effacer"
            className={cn('h-8 px-2 rounded-md border flex items-center justify-center gap-1 bg-white text-xs transition-colors', brush === 0 ? 'border-accent ring-2 ring-accent/40' : 'border-border hover:border-accent/50')}
          >
            <X className="h-3.5 w-3.5" />Gomme
          </button>
        </div>
      )}

      {chutes.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">Aucune chute. {isEditing ? 'Ajoutez une chute pour construire le schéma.' : ''}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border/60">
          <table className="text-sm border-collapse">
            <thead className="bg-zinc-200/60 border-b border-border/60">
              <tr className="text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-2 py-2 text-left font-semibold whitespace-nowrap">Chute</th>
                <th className="px-2 py-2 text-left font-semibold whitespace-nowrap">Fil 1 · LFA</th>
                <th className="px-2 py-2 text-left font-semibold whitespace-nowrap">Fil 2 · LFA</th>
                {Array.from({ length: numCols }, (_, i) => (
                  <th key={i} className="px-1 py-2 text-center font-semibold w-8">{i + 1}</th>
                ))}
                {isEditing && <th className="px-1 py-2" />}
              </tr>
            </thead>
            <tbody>
              {chutes.map((ch) => (
                <tr key={ch.IDchute_liage} className="border-b border-border/40 last:border-0">
                  <td className="px-2 py-1.5 font-medium tabular-nums whitespace-nowrap">{ch.num_chute}</td>
                  <td className="px-2 py-1.5 text-[11px] text-muted-foreground whitespace-nowrap">
                    {compLabel(ch.IDcomposition_ecru1)}{ch.lfa1 ? ` · ${fmtNum(ch.lfa1, 2)}` : ''}
                  </td>
                  <td className="px-2 py-1.5 text-[11px] text-muted-foreground whitespace-nowrap">
                    {ch.IDcomposition_ecru2 > 0 ? `${compLabel(ch.IDcomposition_ecru2)}${ch.lfa2 ? ` · ${fmtNum(ch.lfa2, 2)}` : ''}` : '—'}
                  </td>
                  {Array.from({ length: numCols }, (_, i) => {
                    const num = i + 1
                    const symId = cellMap.get(`${ch.IDchute_liage}:${num}`) ?? 0
                    const sym = detail.symboles.find((s) => s.IDsymbole_liage === symId)
                    return (
                      <td key={i} className="p-0 border-l border-border/40">
                        <button
                          type="button"
                          disabled={!isEditing}
                          onClick={() => paintCell(ch.IDchute_liage, num)}
                          className={cn('h-8 w-8 flex items-center justify-center', isEditing && 'hover:bg-accent/10 cursor-pointer', !isEditing && 'cursor-default')}
                        >
                          {sym ? <SymboleGlyph icone={sym.icone} /> : null}
                        </button>
                      </td>
                    )
                  })}
                  {isEditing && (
                    <td className="px-1 py-1.5 border-l border-border/40">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => setChuteForm({ open: false, editId: ch.IDchute_liage, lfa1: numStr(ch.lfa1), lfa2: numStr(ch.lfa2), comp1: ch.IDcomposition_ecru1, comp2: ch.IDcomposition_ecru2 })}
                          className="p-0.5 text-muted-foreground hover:text-foreground" title="Modifier la chute"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button onClick={() => setDeleteChute(ch)} className="p-0.5 text-destructive hover:text-destructive" title="Supprimer la chute">
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Legend */}
      {detail.symboles.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
          {detail.symboles.map((s) => (
            <span key={s.IDsymbole_liage} className="inline-flex items-center gap-1">
              <SymboleGlyph icone={s.icone} size={14} />
              {symboleLabel(s.icone)}
            </span>
          ))}
        </div>
      )}

      {/* Add chute */}
      {isEditing && !chuteForm.open && chuteForm.editId === null && (
        <Button size="sm" variant="ghost" className="text-accent hover:text-accent hover:bg-accent/10" onClick={() => setChuteForm({ open: true, editId: null, lfa1: '', lfa2: '', comp1: 0, comp2: 0 })}>
          <Plus className="h-3.5 w-3.5 mr-1" />Ajouter une chute
        </Button>
      )}

      {/* Chute form */}
      {isEditing && (chuteForm.open || chuteForm.editId !== null) && (
        <div className="rounded-lg border border-accent/25 bg-accent/[0.03] p-4 space-y-3">
          <p className="text-xs font-semibold text-accent uppercase tracking-wide">{chuteForm.editId !== null ? 'Modifier la chute' : 'Ajouter une chute'}</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Fil 1 (composition)</label>
              <PopoverSelect
                options={[{ id: 0, primary: '— Aucun —' }, ...detail.composition_lines.map((c) => ({ id: c.IDcomposition_ecru, primary: c.ref_fil_reference ?? `#${c.IDcomposition_ecru}`, secondary: fmtPct(c.pourcentage) }))]}
                value={chuteForm.comp1}
                onChange={(id) => setChuteForm({ ...chuteForm, comp1: id })}
                hideEmpty
                size="sm"
              />
            </div>
            <LabeledInput label="LFA 1" type="number" step="0.01" value={chuteForm.lfa1} onChange={(v) => setChuteForm({ ...chuteForm, lfa1: v })} />
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Fil 2 (composition)</label>
              <PopoverSelect
                options={[{ id: 0, primary: '— Aucun —' }, ...detail.composition_lines.map((c) => ({ id: c.IDcomposition_ecru, primary: c.ref_fil_reference ?? `#${c.IDcomposition_ecru}`, secondary: fmtPct(c.pourcentage) }))]}
                value={chuteForm.comp2}
                onChange={(id) => setChuteForm({ ...chuteForm, comp2: id })}
                hideEmpty
                size="sm"
              />
            </div>
            <LabeledInput label="LFA 2" type="number" step="0.01" value={chuteForm.lfa2} onChange={(v) => setChuteForm({ ...chuteForm, lfa2: v })} />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => setChuteForm({ open: false, editId: null, lfa1: '', lfa2: '', comp1: 0, comp2: 0 })}>Annuler</Button>
            <Button size="sm" onClick={() => (chuteForm.editId !== null ? updateChuteMut.mutate(chuteForm.editId) : addChuteMut.mutate())} disabled={addChuteMut.isPending || updateChuteMut.isPending}>
              {(addChuteMut.isPending || updateChuteMut.isPending) ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
              Enregistrer
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleteChute !== null}
        title="Supprimer la chute"
        description={deleteChute ? `La chute n°${deleteChute.num_chute} et ses symboles seront supprimés.` : undefined}
        isPending={deleteChuteMut.isPending}
        onCancel={() => setDeleteChute(null)}
        onConfirm={() => { if (deleteChute) deleteChuteMut.mutate(deleteChute.IDchute_liage) }}
      />
    </div>
  )
}

// ── Right Panel: Sidebar ───────────────────────────────

function DetailSidebar({
  detail,
  refId,
  onOpenCoutDetail,
}: {
  detail: RefEcruDetail | null
  refId: number | null
  onOpenCoutDetail: () => void
}) {
  // Knitting cost at the default 1000 kg for the card headline (the modal lets
  // the user change the quantity). Hook before the early return (§28.6).
  const { data: cout } = useCoutTricotage(refId, 1000, refId !== null)
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
        <button type="button" className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md transition-colors bg-accent text-accent-foreground shadow-sm">
          <Info className="h-3.5 w-3.5" />
          Informations
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-transparent">
        {detail.cout_kg != null && (
          <div className="p-3 rounded-lg border bg-card shadow-sm">
            <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 mb-1">
              <Layers className="h-3.5 w-3.5" />
              Coût de revient
            </p>
            <p className="text-2xl font-bold tabular-nums text-accent">{fmtNum(detail.cout_kg, 2)} <span className="text-sm font-normal text-muted-foreground">€/kg</span></p>
            <p className="text-[11px] text-muted-foreground mt-0.5">Matière + façon</p>
          </div>
        )}
        <div className="p-3 rounded-lg border bg-card shadow-sm">
          <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 mb-1">
            <TmRollIcon className="h-3.5 w-3.5" />
            Coût de tricotage
          </p>
          {cout === undefined ? (
            <div className="h-8 flex items-center"><Loader2 className="h-4 w-4 animate-spin text-accent" /></div>
          ) : cout.computable ? (
            <>
              <p className="text-2xl font-bold tabular-nums text-accent">{fmtNum(cout.costPerKg, 2)} <span className="text-sm font-normal text-muted-foreground">€/kg</span></p>
              <p className="text-[11px] text-muted-foreground mt-0.5">Prix de vente : <span className="tabular-nums">{fmtNum(cout.salePrice, 2)}</span> €/kg · base 1000 kg</p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground italic mt-0.5">Non calculable (pas de données machine)</p>
          )}
          <Button variant="outline" size="sm" className="mt-2 w-full" onClick={onOpenCoutDetail}>
            <Calculator className="h-3.5 w-3.5 mr-1.5" />
            Détail du calcul
          </Button>
        </div>
        <div className="p-3 rounded-lg border bg-card shadow-sm space-y-2">
          <p className="text-xs font-semibold text-muted-foreground">Statistiques</p>
          <KV label="Rouleaux créés" value={<span className="tabular-nums">{detail.rolls_count}</span>} />
          <KV label="Poids total" value={<span className="tabular-nums">{fmtNum(detail.rolls_poids_total, 1)} kg</span>} />
          <KV label="Coloris" value={<span className="tabular-nums">{detail.coloris.length}</span>} />
          <KV label="Fils (composition)" value={<span className="tabular-nums">{detail.composition_lines.length}</span>} />
          <KV label="Réglages machine" value={<span className="tabular-nums">{detail.machines.length}</span>} />
          <KV label="Chutes (liage)" value={<span className="tabular-nums">{detail.chutes.length}</span>} />
        </div>
        <div className="p-3 rounded-lg border bg-card shadow-sm space-y-2">
          <p className="text-xs font-semibold text-muted-foreground">Métadonnées</p>
          <KV label="Client" value={detail.client_nom || '—'} />
          <KV label="Contexture" value={detail.contexture_nom || '—'} />
          <KV label="Dernière MAJ" value={detail.date_maj_ft ? formatHfsqlDate(detail.date_maj_ft) : '—'} />
          {!!detail.archive && (
            <div className="pt-1">
              <Badge variant="outline" className="text-[10px] py-0 gap-1 text-muted-foreground">
                <Archive className="h-2.5 w-2.5" />
                Archivée
              </Badge>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
