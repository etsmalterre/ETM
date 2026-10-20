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
  Package,
  Warehouse,
  Droplets,
  CheckCircle2,
  Circle,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PopoverSelect, SearchableCombobox } from '@/components/ui/popover-select'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'
import { TmRollIcon } from '@/components/icons/TmRollIcon'
import { cn } from '@/lib/utils'
import { apiFetch, API_URL } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { formatHfsqlDate } from '@/lib/dates'
import { Link, useSearchParams } from 'react-router-dom'
// Relative on purpose: TRM renders this file through `@etm`, where `@/` is
// TRM's own src (see the header of RectiligneReferences.tsx).
import { RectiligneReferences, RefKindSwitch, type RefKind } from './tombe-metier/RectiligneReferences'
import { SpecTile, TileValue, TileText, TextTile, tileInput } from './tombe-metier/spec-tiles'

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
  /** What still points at this coloris (the server refuses the delete). */
  in_use: 'rolls' | 'orders' | 'ofs' | 'ref_fini' | 'chute' | null
  /** The coloris's own recipe — what orders, OFs and the sst affectation
   *  use, ahead of the reference's (LIVA #1205). Empty = follows the reference. */
  composition: ColorisCompoLine[]
  /** Other yarns or shares than the reference's composition. */
  composition_ecart: boolean
  /** Knitted (rolls) or launched (OFs) in this coloris: recipe frozen. */
  composition_lock: 'rolls' | 'ofs' | null
}

interface ColorisCompoLine {
  IDcomposition_ecru: number
  IDref_fil: number
  ref_fil_reference: string | null
  IDcolori_fil: number
  colori_fil_reference: string | null
  pourcentage: number | null
}

const COLORIS_COMPO_LOCK_TITLE: Record<NonNullable<ColorisRow['composition_lock']>, string> = {
  rolls: 'Des rouleaux ont été tricotés dans ce coloris — composition figée',
  ofs: 'Un ordre de fabrication existe dans ce coloris — composition figée',
}

const COLORIS_LOCK_TITLE: Record<NonNullable<ColorisRow['in_use']>, string> = {
  rolls: 'Coloris utilisé par des rouleaux — suppression impossible',
  orders: 'Coloris utilisé par une commande — suppression impossible',
  ofs: 'Coloris utilisé par un ordre de fabrication — suppression impossible',
  ref_fini: 'Coloris utilisé par une référence finie — suppression impossible',
  chute: 'Composition du coloris utilisée par le schéma de liage — suppression impossible',
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
// `client` is partitioned by IDsociete: ETM's lookup lists société 1, and TRM
// injects its own ledger's lookup through the `clientsLookupPath` prop (#1201).
const DEFAULT_CLIENTS_LOOKUP = '/references-ecru/lookups/clients'
function useClients(enabled: boolean, path: string) {
  return useQuery<ClientLookup[]>({
    queryKey: ['ref-ecru-lk-clients', path],
    queryFn: () => apiFetch(path),
    enabled,
    staleTime: 5 * 60_000,
  })
}
// ── Per-app variant ────────────────────────────────────
// ETM and TRM render this very screen (TRM through `@etm`). What differs is
// data each company owns or screens only one app has; never a fork, a prop
// (CLAUDE.md § Tombé Métier): which tab a user lands on, whose stock the
// sidebar counts, where « voir le stock » / a fini link lead, which company
// signs the printed fiche technique.
export interface RefEcruScreenVariant {
  defaultTab: RefEcruMainTab
  /** GET returning StockParReference for `${stockPath}/${IDref_ecru}`. */
  stockPath: string
  stockHref: ((reference: string) => string) | null
  finiHref: ((reference: string) => string) | null
  /** Route segment of the fiche technique PDF under /references-ecru/:id. */
  ficheTechnique: 'fiche-technique' | 'fiche-technique-trm'
}
const ETM_VARIANT: RefEcruScreenVariant = {
  defaultTab: 'specifications',
  stockPath: '/stock/ecru/par-reference',
  stockHref: (reference) => `/tombe-metier/stock?ref=${encodeURIComponent(reference)}`,
  finiHref: (reference) => `/finis/references?q=${encodeURIComponent(reference)}`,
  ficheTechnique: 'fiche-technique',
}
const ScreenVariantContext = createContext<RefEcruScreenVariant>(ETM_VARIANT)

interface StockQuantite { pieces: number; kg: number }
interface StockParReference extends StockQuantite {
  disponible: StockQuantite
  coloris: Array<StockQuantite & { IDcolori_ecru: number; disponible: StockQuantite }>
}
/** Live stock of one reference; staleTime 0: other sessions move pieces. */
function useStockParReference(refId: number) {
  const { stockPath } = useContext(ScreenVariantContext)
  return useQuery<StockParReference>({
    queryKey: ['ref-ecru-stock', stockPath, refId],
    queryFn: () => apiFetch(`${stockPath}/${refId}`),
    staleTime: 0,
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

/**
 * Tombé Métier › Références — two catalogs behind one switch, as in the legacy
 * FI_Ref_TombéMetier (SEL_TypeRef): the circular-knit écru references and the
 * rectiligne ones (cols / bandes, LIVA #1185). The mode lives in the URL
 * (`?type=rectiligne`) so an order line can deep-link to its reference; each
 * mode is its own component with its own unsaved-changes guard, and the switch
 * in each list header goes through that guard before flipping.
 */
export function TombeMetierReferences({ obsOfEditor, clientsLookupPath = DEFAULT_CLIENTS_LOOKUP, variant }: {
  obsOfEditor?: ComponentType<ObsOfEditorProps>
  clientsLookupPath?: string
  /** TRM overrides what is its own (see RefEcruScreenVariant). */
  variant?: Partial<RefEcruScreenVariant>
} = {}) {
  const screenVariant = useMemo(() => ({ ...ETM_VARIANT, ...variant }), [variant])
  const [searchParams, setSearchParams] = useSearchParams()
  const kind: RefKind = searchParams.get('type') === 'rectiligne' ? 'rectiligne' : 'circulaire'
  const setKind = useCallback((k: RefKind) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev)
      if (k === 'rectiligne') next.set('type', 'rectiligne')
      else next.delete('type')
      return next
    }, { replace: true })
  }, [setSearchParams])
  return (
    <ScreenVariantContext.Provider value={screenVariant}>
      {kind === 'rectiligne'
        ? <RectiligneReferences onKindChange={setKind} />
        : <CirculaireReferences obsOfEditor={obsOfEditor} clientsLookupPath={clientsLookupPath} onKindChange={setKind} />}
    </ScreenVariantContext.Provider>
  )
}

function CirculaireReferences({ obsOfEditor, clientsLookupPath, onKindChange }: {
  obsOfEditor?: ComponentType<ObsOfEditorProps>
  clientsLookupPath: string
  onKindChange: (k: RefKind) => void
}) {
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
  const { ficheTechnique } = useContext(ScreenVariantContext)
  const [emailOpen, setEmailOpen] = useState(false)

  const { data: refs, isLoading, isError, error } = useRefsEcru(archivedFilter)
  const { data: detail, isLoading: detailLoading } = useRefEcruDetail(selectedId)
  const { data: contextures } = useContextures(isEditing)
  const { data: clients } = useClients(isEditing, clientsLookupPath)
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
            kindSwitch={<RefKindSwitch kind="circulaire" onChange={(k) => guard.guardAction(() => { setIsEditing(false); onKindChange(k) })} />}
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
            onPrint={() => { if (selectedId !== null) window.open(`${API_URL}/references-ecru/${selectedId}/${ficheTechnique}`, '_blank') }}
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
        sidebar={selectedId !== null ? <DetailSidebar detail={detail ?? null} /> : null}
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

      <PlaceholderDialog open={emailOpen} onClose={() => setEmailOpen(false)} title="Envoyer un email" TriggerIcon={AtSign} CenterIcon={Mail} />
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
  kindSwitch,
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
  kindSwitch: React.ReactNode
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
        {kindSwitch}
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

// ── Center panel: Classeur master tabs (§39) ───────────
// One dataset at a time gets the full panel height, as on Finis › Références:
// Spécifications is the fabric sheet, Composition and Coloris the two
// catalogs hanging off it, then the knitting side: Réglages (LFA, pignons,
// réglages par métier), Liage, Obs OF. Counts come from the loaded detail.
export const MAIN_TABS = [
  { key: 'specifications', label: 'Spécifications', icon: Package },
  { key: 'composition', label: 'Composition', icon: FlaskConical },
  { key: 'coloris', label: 'Coloris', icon: Palette },
  { key: 'reglages', label: 'Réglages', icon: Cog },
  { key: 'liage', label: 'Liage', icon: Grid3x3 },
  { key: 'obs', label: 'Obs OF', icon: ClipboardList },
] as const
export type RefEcruMainTab = (typeof MAIN_TABS)[number]['key']

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
  const { defaultTab } = useContext(ScreenVariantContext)
  const [activeTab, setActiveTab] = useState<RefEcruMainTab>(defaultTab)
  // Land on the app's default tab whenever the selection changes (§39).
  useEffect(() => { setActiveTab(defaultTab) }, [detail?.IDref_ecru, defaultTab])

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

  const counts: Partial<Record<RefEcruMainTab, number>> = {
    composition: detail.composition_lines.length,
    coloris: detail.coloris.length,
    reglages: detail.machines.length,
    liage: detail.chutes.length,
    obs: detail.obs_of.length,
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Six tabs: tighter than §39's px-4 so they fit the centre panel at
          1400 px; the row still scrolls (scrollbar hidden) when narrower. */}
      <div className="flex-shrink-0 flex items-center gap-0.5 border-b border-border/60 pb-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {MAIN_TABS.map((t) => {
          const Icon = t.icon
          const active = activeTab === t.key
          const count = counts[t.key]
          return (
            <button key={t.key} type="button" onClick={() => setActiveTab(t.key)}
              className={cn('flex flex-shrink-0 items-center gap-1.5 px-2.5 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap',
                active ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10 hover:text-accent')}>
              <Icon className="h-3.5 w-3.5" />{t.label}
              {/* Counts come from the already-loaded detail, no extra fetch. */}
              {count != null && count > 0 && <span className="text-xs tabular-nums opacity-70">{count}</span>}
            </button>
          )
        })}
      </div>
      {/* px-1/pb-1 keep focus rings and hover borders clear of the overflow clip (§31.5) */}
      <div className="flex-1 min-h-0 overflow-auto space-y-2 pt-3 px-1 pb-1 scrollbar-transparent">
        {activeTab === 'specifications' && (
          <SpecsCard detail={detail} isEditing={isEditing} draft={draft} onDraftChange={onDraftChange} clients={clients} contextures={contextures} />
        )}
        {activeTab === 'composition' && (
          <CompositionCard detail={detail} isEditing={isEditing} refId={detail.IDref_ecru} refsFil={refsFil} onMutationSuccess={onMutationSuccess} reportDirty={reportDirty} />
        )}
        {activeTab === 'coloris' && (
          <ColorisCard detail={detail} isEditing={isEditing} refId={detail.IDref_ecru} refsFil={refsFil} onMutationSuccess={onMutationSuccess} reportDirty={reportDirty} />
        )}
        {activeTab === 'reglages' && (
          <ReglagesCard detail={detail} isEditing={isEditing} draft={draft} onDraftChange={onDraftChange} machinesLk={machinesLk} onMutationSuccess={onMutationSuccess} reportDirty={reportDirty} />
        )}
        {activeTab === 'liage' && (
          <Card className={cn('card-premium', isEditing && editSectionClass)}>
            <CardContent className="pt-4 pb-4">
              <SchemaLiageTab detail={detail} isEditing={isEditing} onMutationSuccess={onMutationSuccess} reportDirty={reportDirty} />
            </CardContent>
          </Card>
        )}
        {activeTab === 'obs' && <ObsOfTab detail={detail} isEditing={isEditing} onMutationSuccess={onMutationSuccess} />}
      </div>
    </div>
  )
}

// ── Spécifications (tiles, same grammar as Finis › Références) ──

const PARTICULARITES = [
  ['maille_ouverture', "Maille d'ouverture"],
  ['ouvert_visiteuse', 'Ouvert au large'],
  ['sonneter', 'Sonneter'],
] as const

function SpecsCard({
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
  const num = (key: keyof HeaderDraft, step = '0.01') => (
    <input type="number" step={step} value={draft[key] as string} onChange={(e) => onDraftChange({ ...draft, [key]: e.target.value })} className={tileInput} />
  )
  const identity = [
    detail.contexture_nom,
    jaugeLabel(detail.Jauge) ? `Jauge ${jaugeLabel(detail.Jauge)}` : null,
    diametreLabel(detail.diametre) ? `Ø ${diametreLabel(detail.diametre)}` : null,
  ].filter(Boolean).join(' · ')

  return (
    <Card className={cn('card-premium', isEditing && editSectionClass)}>
      <CardContent className="pt-4 pb-4 space-y-3">
        {isEditing && (
          <LabeledInput label="Désignation" value={draft.designation} onChange={(v) => onDraftChange({ ...draft, designation: v })} />
        )}

        {/* Identity band: what the fabric is: contexture, jauge, diamètre */}
        <div className="rounded-lg border border-border/60 bg-zinc-100/80 px-3 py-2 flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-amber-400/10">
            <TmRollIcon className="h-4 w-4 text-amber-600" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold flex items-center gap-1">
              Contexture · Jauge · Ø
              {fieldsLocked && isEditing && <Lock className="h-3 w-3" aria-label="Verrouillé" />}
            </p>
            {isEditing ? (
              <div className="mt-1 grid grid-cols-4 gap-2" title={fieldsLocked ? lockTitle : undefined}>
                <div className="col-span-2">
                  <PopoverSelect
                    options={contextures.map((c) => ({ id: c.IDcontexture, primary: c.nom ?? `#${c.IDcontexture}` }))}
                    value={draft.IDcontexture}
                    onChange={(id) => onDraftChange({ ...draft, IDcontexture: id })}
                    emptyLabel="Contexture"
                    disabled={fieldsLocked}
                    disabledTitle={lockTitle}
                  />
                </div>
                <PopoverSelect
                  options={JAUGE_OPTIONS.map((o) => ({ id: o.ord, primary: o.label }))}
                  value={Number(draft.Jauge) || 0}
                  onChange={(id) => onDraftChange({ ...draft, Jauge: id ? String(id) : '' })}
                  emptyLabel="Jauge"
                  disabled={fieldsLocked}
                  disabledTitle={lockTitle}
                />
                <PopoverSelect
                  options={DIAM_OPTIONS.map((o) => ({ id: o.ord, primary: o.label }))}
                  value={Number(draft.diametre) || 0}
                  onChange={(id) => onDraftChange({ ...draft, diametre: id ? String(id) : '' })}
                  emptyLabel="Ø"
                  disabled={fieldsLocked}
                  disabledTitle={lockTitle}
                />
              </div>
            ) : (
              <p className="text-sm font-semibold truncate">{identity || <span className="text-muted-foreground italic font-normal">Non renseignées</span>}</p>
            )}
          </div>
          {isEditing ? (
            <div className="flex flex-col gap-1.5 flex-shrink-0" title={fieldsLocked ? lockTitle : undefined}>
              <label className="flex items-center gap-2 text-xs font-medium">
                <Pill value={draft.bio} onChange={(v) => onDraftChange({ ...draft, bio: v })} disabled={fieldsLocked} />
                <span className="flex items-center gap-1"><Leaf className="h-3 w-3 text-green-600" />Bio</span>
              </label>
              <label className="flex items-center gap-2 text-xs font-medium">
                <Pill value={draft.recycle} onChange={(v) => onDraftChange({ ...draft, recycle: v })} disabled={fieldsLocked} />
                <span className="flex items-center gap-1"><Recycle className="h-3 w-3 text-teal-600" />Recyclé</span>
              </label>
            </div>
          ) : (
            (!!detail.bio || !!detail.recycle) && (
              <div className="flex items-center gap-1.5 flex-shrink-0">
                {!!detail.bio && <Badge className="badge-success text-[10px] py-0 px-1.5 gap-0.5"><Leaf className="h-2.5 w-2.5" />Bio</Badge>}
                {!!detail.recycle && <Badge className="bg-teal-500/10 text-teal-700 ring-1 ring-teal-500/20 text-[10px] py-0 px-1.5 gap-0.5"><Recycle className="h-2.5 w-2.5" />Recyclé</Badge>}
              </div>
            )
          )}
        </div>
        {isEditing && fieldsLocked && (
          <div className="flex items-start gap-2 rounded-md border border-amber-400/40 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
            <Lock className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
            <span>Contexture, jauge, diamètre, bio et recyclé sont verrouillés car des rouleaux ou des commandes existent pour cette référence.</span>
          </div>
        )}

        {/* Row 1: who it is for, and its façon price */}
        <div className="grid grid-cols-3 gap-2">
          <SpecTile label="Client">
            {isEditing ? (
              <SearchableCombobox<ClientLookup>
                options={clients}
                value={draft.IDclient}
                onChange={(id) => onDraftChange({ ...draft, IDclient: id })}
                getId={(c) => c.IDclient}
                getPrimary={(c) => c.nom ?? `#${c.IDclient}`}
                getSecondary={(c) => c.ville ?? undefined}
                placeholder="Rechercher un client"
              />
            ) : (
              <TileText value={detail.client_nom} />
            )}
          </SpecTile>
          <SpecTile label="Réf. client">
            {isEditing ? (
              <input value={draft.reference_client} onChange={(e) => onDraftChange({ ...draft, reference_client: e.target.value })} className={tileInput} />
            ) : (
              <TileText value={detail.reference_client} />
            )}
          </SpecTile>
          <SpecTile label="Prix façon">
            {isEditing ? num('prix') : <TileValue value={detail.prix} unit="€/kg" digits={2} />}
          </SpecTile>
        </div>

        {/* Row 2: the fabric off the machine */}
        <div className="grid grid-cols-3 gap-2">
          <SpecTile label="Laize TBM">{isEditing ? num('laize_tbm') : <TileValue value={detail.laize_tbm} unit="cm" />}</SpecTile>
          <SpecTile label="Poids TBM">{isEditing ? num('poids_m2_tbm') : <TileValue value={detail.poids_m2_tbm} unit="g/m²" />}</SpecTile>
          <SpecTile label="Rendement">{isEditing ? num('rendement') : <TileValue value={detail.rendement} />}</SpecTile>
        </div>

        {/* Row 3: the piece and the machine pace */}
        <div className="grid grid-cols-3 gap-2">
          <SpecTile label="Poids pièce">{isEditing ? num('poids') : <TileValue value={detail.poids} unit="kg" />}</SpecTile>
          <SpecTile label="Vitesse cible">{isEditing ? num('vitesse_cible', '0.1') : <TileValue value={detail.vitesse_cible} unit="tr/min" />}</SpecTile>
          <SpecTile label="Écarteur">{isEditing ? num('ecarteur') : <TileValue value={detail.ecarteur} />}</SpecTile>
        </div>

        {/* Tombé du métier + the three particularities, all shown on/off */}
        <SpecTile label="Tombé du métier · particularités">
          {isEditing ? (
            <div className="flex flex-wrap gap-2 items-center">
              <div className="w-36">
                <PopoverSelect
                  options={TOMBE_OPTIONS.map((o) => ({ id: o.id, primary: o.label }))}
                  value={tombeId(draft.tombe_metier)}
                  onChange={(id) => onDraftChange({ ...draft, tombe_metier: tombeValue(id) })}
                  emptyLabel="Tombé"
                />
              </div>
              {PARTICULARITES.map(([k, label]) => (
                <label key={k} className="flex items-center gap-2 rounded-md border border-border/60 bg-white px-2.5 py-1.5">
                  <span className="text-sm whitespace-nowrap">{label}</span>
                  <Pill value={draft[k]} onChange={(v) => onDraftChange({ ...draft, [k]: v })} />
                </label>
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-sm font-semibold mr-2">{tombeValue(tombeId(detail.tombe_metier)) || '—'}</span>
              {PARTICULARITES.map(([k, label]) => {
                const on = !!detail[k]
                return (
                  <span
                    key={k}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
                      on ? 'bg-accent/10 text-accent border-accent/25' : 'bg-transparent text-muted-foreground/60 border-border/60',
                    )}
                  >
                    {on ? <CheckCircle2 className="h-3 w-3" /> : <Circle className="h-3 w-3" />}
                    {label}
                  </span>
                )
              })}
            </div>
          )}
        </SpecTile>

        <TextTile label="Commentaire" value={detail.commentaire} isEditing={isEditing} draft={draft.commentaire} rows={2} onChange={(v) => onDraftChange({ ...draft, commentaire: v })} />
        <TextTile label="Observations" value={detail.observations} isEditing={isEditing} draft={draft.observations} rows={3} onChange={(v) => onDraftChange({ ...draft, observations: v })} />

        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground pt-1">
          <Calendar className="h-3 w-3" />
          Fiche technique mise à jour le {detail.date_maj_ft ? formatHfsqlDate(detail.date_maj_ft) : '—'}
        </div>
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
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<CompoForm>({ IDref_fil: 0, pourcentage: '', commentaire: '' })
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
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
        <CardContent className="pt-4 pb-3 space-y-2">
            {/* Caption row: yarn count + the 100 % check */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground tabular-nums">
                {detail.composition_lines.length} fil{detail.composition_lines.length !== 1 ? 's' : ''}
              </span>
              {detail.composition_lines.length > 0 && (
                <Badge
                  variant="secondary"
                  className={cn('text-xs tabular-nums', !totalOk && 'bg-destructive/10 text-destructive ring-1 ring-destructive/20')}
                  title={totalOk ? 'Total composition' : 'La composition doit totaliser 100 %'}
                >
                  Σ {fmtNum(Math.round(total * 100) / 100, Number.isInteger(total) ? 0 : 2)} %
                </Badge>
              )}
              {locked && <Lock className="h-3.5 w-3.5 text-muted-foreground ml-auto" aria-label="Verrouillée" />}
            </div>
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
              <p className="text-sm text-muted-foreground italic py-2">Aucun fil</p>
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
                            <button onClick={() => startEditRow(c)} className="p-0.5 text-muted-foreground hover:text-foreground transition-colors" title="Modifier">
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button onClick={() => setDeleteTarget(c)} className="p-0.5 text-destructive hover:text-destructive transition-colors" title="Supprimer">
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
            {canEdit && !showForm && editingId === null && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setShowForm(true); setEditingId(null); setForm({ IDref_fil: 0, pourcentage: '', commentaire: '' }) }}
                className="w-full text-muted-foreground hover:text-accent hover:bg-accent/5 border border-dashed border-border/60 hover:border-accent/40"
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter un fil
              </Button>
            )}
        </CardContent>
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
  const [compoTarget, setCompoTarget] = useState<ColorisRow | null>(null)
  const ecartCount = detail.coloris.filter((c) => c.composition_ecart).length
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<ColorisForm>({ reference: '', commentaire: '', suivis: false })
  const [deleteTarget, setDeleteTarget] = useState<ColorisRow | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [q, setQ] = useState('')
  // A filter typed for one ref silently emptying the next one reads as « no coloris ».
  useEffect(() => { setQ('') }, [refId])
  const { data: stock } = useStockParReference(refId)
  const stockByColoris = useMemo(() => new Map((stock?.coloris ?? []).map((c) => [c.IDcolori_ecru, c])), [stock])

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
    onError: (err: Error & { body?: { error?: string } }) => {
      setErrorMsg(err.body?.error ? String(err.body.error) : 'Suppression impossible.')
    },
  })

  const startEditRow = (c: ColorisRow) => {
    setEditingId(c.IDcolori_ecru)
    setShowForm(false)
    setForm({ reference: c.reference ?? '', commentaire: c.commentaire ?? '', suivis: !!c.suivis })
  }
  const startCreate = () => { setShowForm(true); setEditingId(null); setForm({ reference: '', commentaire: '', suivis: false }) }

  const rows = useMemo(() => {
    const t = q.trim().toLowerCase()
    if (!t) return detail.coloris
    return detail.coloris.filter((c) => [c.reference, c.commentaire].some((v) => (v ?? '').toLowerCase().includes(t)))
  }, [detail.coloris, q])
  const inStock = detail.coloris.filter((c) => (stockByColoris.get(c.IDcolori_ecru)?.pieces ?? 0) > 0).length
  const editingRow = editingId !== null ? detail.coloris.find((c) => c.IDcolori_ecru === editingId) ?? null : null

  return (
    <>
      <Card className={cn('card-premium', isEditing && editSectionClass)}>
        <CardContent className="pt-4 pb-3 space-y-3">
          {/* Caption row: counts, cost, écart, filter */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground tabular-nums">
              {detail.coloris.length} coloris
              {inStock > 0 && <> · <span className="font-medium text-foreground">{inStock}</span> en stock</>}
            </span>
            {ecartCount > 0 && (
              <Badge
                variant="outline"
                className="text-[11px] py-0 px-2 gap-1 bg-amber-500/15 text-amber-800 border-amber-500/30"
                title="La composition de ces coloris diffère de celle de la référence — c'est elle que suivent les commandes et les OF"
              >
                <AlertCircle className="h-3 w-3" />
                {ecartCount} ≠ composition
              </Badge>
            )}
            {detail.coloris.length > 8 && (
              <div className="relative ml-auto w-56 max-w-full">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <input
                  type="text"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Filtrer les coloris"
                  className="h-8 w-full pl-8 pr-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            )}
          </div>

          {(showForm || editingRow) && isEditing && (
            <ColorisFormView
              form={form}
              onFormChange={setForm}
              onCancel={resetForm}
              onSave={() => (editingRow ? updateMut.mutate(editingRow.IDcolori_ecru) : createMut.mutate())}
              isSaving={createMut.isPending || updateMut.isPending}
              title={editingRow ? `Modifier le coloris ${editingRow.reference ?? ''}` : 'Ajouter un coloris'}
            />
          )}

          {detail.coloris.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <Palette className="h-10 w-10 mb-2 opacity-40" />
              <p className="text-sm">Aucun coloris</p>
              {isEditing && !showForm && (
                <Button variant="outline" size="sm" className="mt-3" onClick={startCreate}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter un coloris
                </Button>
              )}
            </div>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">Aucun coloris ne correspond au filtre</p>
          ) : (
            <div className="rounded-lg border border-border/60 overflow-hidden">
              <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
                <colgroup>
                  <col style={{ width: '30%' }} />
                  <col />
                  <col style={{ width: '9.5rem' }} />
                  {isEditing && <col style={{ width: '5.5rem' }} />}
                </colgroup>
                <thead className="bg-zinc-200/60 border-b border-border/60">
                  <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 text-left font-semibold">Coloris</th>
                    <th className="px-3 py-2 text-left font-semibold">Composition</th>
                    <th className="px-3 py-2 text-right font-semibold whitespace-nowrap">Stock</th>
                    {isEditing && <th className="px-2 py-2" />}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => {
                    const inUse = c.in_use != null
                    const s = stockByColoris.get(c.IDcolori_ecru)
                    return (
                      <tr
                        key={c.IDcolori_ecru}
                        className={cn(
                          'border-b border-border/40 last:border-b-0 hover:bg-accent/5 transition-colors align-top',
                          editingId === c.IDcolori_ecru && 'bg-accent/10',
                        )}
                      >
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <Palette className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                            <span className="font-medium truncate" title={c.reference ?? undefined}>{c.reference ?? '—'}</span>
                          </div>
                          {c.commentaire?.trim() && <p className="text-[11px] text-muted-foreground truncate ml-5" title={c.commentaire}>{c.commentaire}</p>}
                        </td>
                        <td className="px-3 py-2 min-w-0">
                          <div className="flex items-center gap-1.5 min-w-0">
                            {c.composition_ecart && (
                              <Badge
                                variant="outline"
                                className="text-[10px] py-0 px-1.5 flex-shrink-0 bg-amber-500/15 text-amber-800 border-amber-500/30"
                                title="Ce coloris ne suit pas la composition de la référence — c'est sa composition que suivent les commandes et les OF"
                              >
                                ≠ composition
                              </Badge>
                            )}
                            <div className="min-w-0 flex-1"><ColorisCompoSummary lines={c.composition} /></div>
                          </div>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                          {stock === undefined ? (
                            <span className="text-muted-foreground/40">…</span>
                          ) : s && s.pieces > 0 ? (
                            <span title={`${s.disponible.pieces} pièce${s.disponible.pieces > 1 ? 's' : ''} disponible${s.disponible.pieces > 1 ? 's' : ''} · ${fmtNum(s.disponible.kg, 1)} kg`}>
                              <span className="font-semibold">{fmtNum(s.kg, 1)} kg</span>
                              <span className="text-[11px] text-muted-foreground"> · {s.pieces} p.</span>
                            </span>
                          ) : (
                            <span className="text-muted-foreground/40">—</span>
                          )}
                        </td>
                        {isEditing && (
                          <td className="px-2 py-1.5">
                            <div className="flex items-center justify-end gap-1.5">
                              <button
                                onClick={() => { if (!c.composition_lock) setCompoTarget(c) }}
                                aria-disabled={!!c.composition_lock}
                                className={cn('p-0.5 transition-colors', c.composition_lock ? 'text-muted-foreground/40 cursor-not-allowed' : 'text-muted-foreground hover:text-foreground')}
                                title={c.composition_lock ? COLORIS_COMPO_LOCK_TITLE[c.composition_lock] : 'Composition du coloris'}
                              >
                                <FlaskConical className="h-3.5 w-3.5" />
                              </button>
                              <button onClick={() => startEditRow(c)} className="p-0.5 text-muted-foreground hover:text-foreground transition-colors" title="Modifier">
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => { if (!inUse) { setErrorMsg(null); setDeleteTarget(c) } }}
                                aria-disabled={inUse}
                                className={cn('p-0.5 transition-colors', inUse ? 'text-muted-foreground/40 cursor-not-allowed' : 'text-destructive hover:text-destructive')}
                                title={c.in_use ? COLORIS_LOCK_TITLE[c.in_use] : 'Supprimer'}
                              >
                                {inUse ? <Lock className="h-3.5 w-3.5" /> : <Trash2 className="h-3.5 w-3.5" />}
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {isEditing && detail.coloris.length > 0 && !showForm && editingId === null && (
            <Button
              variant="ghost"
              size="sm"
              onClick={startCreate}
              className="w-full text-muted-foreground hover:text-accent hover:bg-accent/5 border border-dashed border-border/60 hover:border-accent/40"
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter un coloris
            </Button>
          )}
        </CardContent>
      </Card>
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Supprimer le coloris"
        description={deleteTarget ? `${deleteTarget.reference ?? '—'} sera supprimé.` : undefined}
        error={errorMsg}
        isPending={deleteMut.isPending}
        onCancel={() => { setDeleteTarget(null); setErrorMsg(null) }}
        onConfirm={() => { if (deleteTarget) deleteMut.mutate(deleteTarget.IDcolori_ecru) }}
      />
      {compoTarget && (
        <ColorisCompositionDialog
          refId={refId}
          coloris={compoTarget}
          base={detail.composition_lines}
          refsFil={refsFil}
          onClose={() => setCompoTarget(null)}
          onSaved={() => { onMutationSuccess(); setCompoTarget(null) }}
          reportDirty={reportDirty}
        />
      )}
    </>
  )
}

/** One line under the coloris name: its own recipe, or that it follows the
 *  reference's. */
function ColorisCompoSummary({ lines }: { lines: ColorisCompoLine[] }) {
  if (lines.length === 0) {
    return <p className="text-[11px] text-muted-foreground italic">Suit la composition de la référence</p>
  }
  const text = lines
    .map((l) => `${fmtPct(l.pourcentage)} ${l.ref_fil_reference ?? '—'}${l.colori_fil_reference ? ` · ${l.colori_fil_reference}` : ''}`)
    .join('  —  ')
  return <p className="text-[11px] text-muted-foreground truncate tabular-nums" title={text}>{text}</p>
}

// ── Coloris composition dialog (LIVA #1205) ────────────
//
// The recipe of ONE coloris, yarn colours included — the one orders, OFs and
// the sst affectation read ahead of the reference's. Saved as a whole
// (PUT …/coloris/:id/composition); an empty list hands the coloris back to
// the reference's composition.

interface ColorisFilLookup { IDcolori_fil: number; reference: string; stock_kg: number }
interface CompoDraftLine { key: number; IDref_fil: number; IDcolori_fil: number; pourcentage: string }

function useColorisFil(refFil: number) {
  return useQuery<ColorisFilLookup[]>({
    queryKey: ['references-ecru', 'lookups', 'colori-fil', refFil],
    queryFn: () => apiFetch(`/references-ecru/lookups/colori-fil?ref_fil=${refFil}`),
    enabled: refFil > 0,
    staleTime: 60_000,
  })
}

function ColorisCompositionDialog({
  refId,
  coloris,
  base,
  refsFil,
  onClose,
  onSaved,
  reportDirty,
}: {
  refId: number
  coloris: ColorisRow
  base: CompositionRow[]
  refsFil: RefFilLookup[]
  onClose: () => void
  onSaved: () => void
  reportDirty: (key: string, dirty: boolean) => void
}) {
  const keyRef = useRef(0)
  const nextKey = () => ++keyRef.current
  const [lines, setLines] = useState<CompoDraftLine[]>(() =>
    coloris.composition.map((l) => ({ key: nextKey(), IDref_fil: l.IDref_fil, IDcolori_fil: l.IDcolori_fil, pourcentage: String(l.pourcentage ?? '') })),
  )
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const queryClient = useQueryClient()

  const reportDirtyRef = useRef(reportDirty)
  useEffect(() => { reportDirtyRef.current = reportDirty })
  useEffect(() => {
    reportDirtyRef.current('ecru-coloris-composition', true)
    return () => { reportDirtyRef.current('ecru-coloris-composition', false) }
  }, [])

  const total = lines.reduce((s, l) => s + (Number(l.pourcentage) || 0), 0)
  const totalOk = lines.length === 0 || Math.abs(total - 100) < 0.01
  const complete = lines.every((l) => l.IDref_fil > 0 && l.IDcolori_fil > 0 && Number(l.pourcentage) > 0)
  const canSave = totalOk && complete

  const saveMut = useMutation({
    mutationFn: () => apiFetch(`/references-ecru/${refId}/coloris/${coloris.IDcolori_ecru}/composition`, {
      method: 'PUT',
      body: JSON.stringify({
        lines: lines.map((l) => ({ IDref_fil: l.IDref_fil, IDcolori_fil: l.IDcolori_fil, pourcentage: Number(l.pourcentage) })),
      }),
    }),
    onSuccess: onSaved,
    onError: (err: Error & { body?: { error?: string } }) =>
      setErrorMsg(err.body?.error ?? "L'enregistrement a échoué. Veuillez réessayer."),
  })

  // « Reprendre la composition de la référence »: its yarns and shares, and
  // for each yarn the colour carrying this coloris's name when exactly one
  // does (the one with stock wins a tie) — otherwise left to choose.
  const [seeding, setSeeding] = useState(false)
  const seedFromBase = async () => {
    setSeeding(true)
    setErrorMsg(null)
    try {
      const wantedName = (coloris.reference ?? '').trim().toLowerCase()
      const next: CompoDraftLine[] = []
      for (const b of base) {
        const options = await queryClient.fetchQuery<ColorisFilLookup[]>({
          queryKey: ['references-ecru', 'lookups', 'colori-fil', b.IDref_fil],
          queryFn: () => apiFetch(`/references-ecru/lookups/colori-fil?ref_fil=${b.IDref_fil}`),
          staleTime: 60_000,
        })
        const named = options.filter((o) => o.reference.trim().toLowerCase() === wantedName)
        const stocked = named.filter((o) => o.stock_kg > 0)
        const pick = named.length === 1 ? named[0] : stocked.length === 1 ? stocked[0] : null
        next.push({ key: nextKey(), IDref_fil: b.IDref_fil, IDcolori_fil: pick?.IDcolori_fil ?? 0, pourcentage: String(b.pourcentage ?? '') })
      }
      setLines(next)
    } catch {
      setErrorMsg('Impossible de lire les coloris des fils. Veuillez réessayer.')
    } finally {
      setSeeding(false)
    }
  }

  const update = (key: number, patch: Partial<CompoDraftLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const addLine = () => setLines((ls) => [...ls, { key: nextKey(), IDref_fil: 0, IDcolori_fil: 0, pourcentage: '' }])

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-3xl" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FlaskConical className="h-5 w-5 text-accent" />
            Composition du coloris « {coloris.reference ?? '—'} »
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            C'est cette composition, coloris des fils compris, que suivent les commandes, le stock de fil proposé et les ordres de fabrication de ce coloris.
            Sans ligne, le coloris suit la composition de la référence.
          </p>
          {base.length > 0 && (
            <Button variant="outline" size="sm" onClick={seedFromBase} disabled={seeding}>
              {seeding ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Copy className="h-3.5 w-3.5 mr-1.5" />}
              Reprendre la composition de la référence
            </Button>
          )}
          {lines.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <FlaskConical className="h-10 w-10 mb-2 opacity-40" />
              <p className="text-sm">Suit la composition de la référence</p>
              <Button variant="outline" size="sm" className="mt-3" onClick={addLine}>
                <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter un fil
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="hidden sm:grid grid-cols-[minmax(0,5fr)_minmax(0,4fr)_5rem_1.5rem] gap-2 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                <span>Fil</span><span>Coloris du fil</span><span className="text-right">%</span><span />
              </div>
              {lines.map((l) => (
                <ColorisCompoLineRow
                  key={l.key}
                  line={l}
                  refsFil={refsFil}
                  onChange={(patch) => update(l.key, patch)}
                  onRemove={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                />
              ))}
              <Button
                variant="ghost"
                size="sm"
                onClick={addLine}
                className="w-full text-muted-foreground hover:text-accent hover:bg-accent/5 border border-dashed border-border/60 hover:border-accent/40"
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter un fil
              </Button>
            </div>
          )}
        </div>
        {errorMsg && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}
        <DialogFooter className="mt-4 sm:items-center">
          {lines.length > 0 && (
            <Badge
              variant="secondary"
              className={cn('text-xs tabular-nums sm:mr-auto self-start sm:self-auto', !totalOk && 'bg-destructive/10 text-destructive ring-1 ring-destructive/20')}
              title={totalOk ? 'Total composition' : 'La composition doit totaliser 100 %'}
            >
              Total {fmtNum(Math.round(total * 100) / 100, Number.isInteger(total) ? 0 : 2)}%
            </Badge>
          )}
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={() => { setErrorMsg(null); saveMut.mutate() }} disabled={!canSave || saveMut.isPending}>
            {saveMut.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ColorisCompoLineRow({
  line,
  refsFil,
  onChange,
  onRemove,
}: {
  line: CompoDraftLine
  refsFil: RefFilLookup[]
  onChange: (patch: Partial<CompoDraftLine>) => void
  onRemove: () => void
}) {
  const { data: colorisFil, isLoading } = useColorisFil(line.IDref_fil)
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_5rem_1.5rem] sm:grid-cols-[minmax(0,5fr)_minmax(0,4fr)_5rem_1.5rem] gap-2 items-center rounded-lg border border-border/60 bg-zinc-100/80 p-2">
      <div className="min-w-0 col-span-2 sm:col-span-1">
        <SearchableCombobox<RefFilLookup>
          options={refsFil}
          value={line.IDref_fil}
          onChange={(id) => onChange({ IDref_fil: id, IDcolori_fil: 0 })}
          getId={(r) => r.IDref_fil}
          getPrimary={(r) => r.reference ?? `#${r.IDref_fil}`}
          placeholder="Rechercher un fil"
        />
      </div>
      <button onClick={onRemove} className="sm:hidden p-0.5 text-destructive hover:text-destructive transition-colors justify-self-center" title="Retirer">
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      <div className="min-w-0">
        <SearchableCombobox<ColorisFilLookup>
          options={colorisFil ?? []}
          value={line.IDcolori_fil}
          onChange={(id) => onChange({ IDcolori_fil: id })}
          getId={(c) => c.IDcolori_fil}
          getPrimary={(c) => c.reference || `#${c.IDcolori_fil}`}
          getSecondary={(c) => (c.stock_kg > 0 ? `${fmtNum(c.stock_kg, 1)} kg en stock` : 'pas de stock')}
          placeholder={line.IDref_fil > 0 ? 'Choisir le coloris' : "Choisir d'abord le fil"}
          loading={isLoading && line.IDref_fil > 0}
          disabled={line.IDref_fil <= 0}
        />
      </div>
      <input
        type="number"
        step="0.1"
        min="0"
        max="100"
        value={line.pourcentage}
        onChange={(e) => onChange({ pourcentage: e.target.value })}
        className={cn(inputClass, 'text-right tabular-nums')}
        aria-label="Pourcentage"
      />
      <button onClick={onRemove} className="hidden sm:block p-0.5 text-destructive hover:text-destructive transition-colors justify-self-center" title="Retirer">
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </div>
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

// ── Réglages tab (LFA / tour, pignons, réglages par métier) ──

function ReglagesCard({
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
  const quad = (label: string, keys: readonly (keyof HeaderDraft & keyof RefEcruDetail)[]) => (
    <SpecTile label={label}>
      <div className="grid grid-cols-4 gap-1.5">
        {keys.map((k) =>
          isEditing ? (
            <input key={k} value={draft[k] as string} onChange={(e) => onDraftChange({ ...draft, [k]: e.target.value })} className={cn(inputClass, 'text-center px-1')} />
          ) : (
            <div key={k} className="h-8 flex items-center justify-center text-sm font-semibold rounded-md border border-border/60 bg-white tabular-nums">
              {(detail[k] as string | null)?.trim() || <span className="text-muted-foreground/50 font-normal">—</span>}
            </div>
          ),
        )}
      </div>
    </SpecTile>
  )
  return (
    <Card className={cn('card-premium', isEditing && editSectionClass)}>
      <CardContent className="pt-4 pb-4 space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {quad('LFA / tour', ['lfa_tour_1', 'lfa_tour_2', 'lfa_tour_3', 'lfa_tour_4'])}
          {quad('Pignons', ['poulies_1', 'poulies_2', 'poulies_3', 'poulies_4'])}
        </div>
        <MachineGrid detail={detail} isEditing={isEditing} machinesLk={machinesLk} onMutationSuccess={onMutationSuccess} reportDirty={reportDirty} />
      </CardContent>
    </Card>
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

// ── Right Panel: Sidebar (Informations / Coût) ─────────

type SidebarTab = 'informations' | 'cout'

function DetailSidebar({ detail }: { detail: RefEcruDetail | null }) {
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
          { key: 'cout', label: 'Coût', icon: Calculator },
        ] as { key: SidebarTab; label: string; icon: React.ElementType }[]).map((tab) => {
          const Icon = tab.icon
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={cn(
                'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md transition-colors',
                activeTab === tab.key ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {tab.label}
            </button>
          )
        })}
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-transparent">
        {activeTab === 'informations' && <InformationsTab detail={detail} />}
        {activeTab === 'cout' && <CoutTab key={detail.IDref_ecru} detail={detail} />}
      </div>
    </div>
  )
}

function InformationsTab({ detail }: { detail: RefEcruDetail }) {
  return (
    <>
      <StockActuelCard detail={detail} />
      <FinisIssusCard refId={detail.IDref_ecru} />
      <div className="p-3 rounded-lg border bg-card shadow-sm space-y-2">
        <p className="text-xs font-semibold text-muted-foreground">Statistiques</p>
        <KV label="Rouleaux tricotés" value={<span className="tabular-nums">{fmtNum(detail.rolls_count)}</span>} />
        <KV label="Poids tricoté" value={<span className="tabular-nums">{fmtNum(detail.rolls_poids_total, 1)} kg</span>} />
        <KV label="Coloris" value={<span className="tabular-nums">{detail.coloris.length}</span>} />
        <KV label="Fils (composition)" value={<span className="tabular-nums">{detail.composition_lines.length}</span>} />
        <KV label="Réglages machine" value={<span className="tabular-nums">{detail.machines.length}</span>} />
        <KV label="Chutes (liage)" value={<span className="tabular-nums">{detail.chutes.length}</span>} />
      </div>
      <div className="p-3 rounded-lg border bg-card shadow-sm space-y-2">
        <p className="text-xs font-semibold text-muted-foreground">Métadonnées</p>
        <KV label="Client" value={detail.client_nom?.trim() || '—'} />
        <KV label="Réf. client" value={detail.reference_client?.trim() || '—'} />
        <KV label="Fiche technique MAJ" value={detail.date_maj_ft ? formatHfsqlDate(detail.date_maj_ft) : '—'} />
        {(!!detail.archive || !!detail.has_rolls || !!detail.has_orders) && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {(!!detail.has_rolls || !!detail.has_orders) && (
              <Badge variant="secondary" className="text-[10px] py-0 gap-1" title="Contexture, jauge, diamètre, composition figés">
                <Lock className="h-2.5 w-2.5" />
                Verrouillée
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
    </>
  )
}

/** What this reference has in stock right now, each app its own stock
 *  (ScreenVariantContext.stockPath), never the other company's pieces. */
function StockActuelCard({ detail }: { detail: RefEcruDetail }) {
  const { stockHref } = useContext(ScreenVariantContext)
  const { data: stock, isError } = useStockParReference(detail.IDref_ecru)
  const href = stockHref && detail.reference ? stockHref(detail.reference) : null
  return (
    <div className="p-3 rounded-lg border bg-card shadow-sm space-y-2">
      <div className="flex items-center gap-1.5">
        <Warehouse className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-xs font-semibold text-muted-foreground">Stock actuel</p>
        {stock && (
          <Badge variant="secondary" className="text-[10px] py-0 ml-auto tabular-nums">
            {stock.pieces} pièce{stock.pieces !== 1 ? 's' : ''}
          </Badge>
        )}
      </div>
      {isError ? (
        <p className="text-sm text-destructive">Stock indisponible</p>
      ) : !stock ? (
        <div className="h-8 flex items-center"><Loader2 className="h-4 w-4 animate-spin text-accent" /></div>
      ) : stock.pieces === 0 ? (
        <p className="text-sm text-muted-foreground italic">Aucune pièce en stock</p>
      ) : (
        <>
          <p className="text-2xl font-bold tabular-nums text-accent leading-none">
            {fmtNum(stock.kg, 1)} <span className="text-sm font-normal text-muted-foreground">kg</span>
          </p>
          <KV
            label="Disponible"
            value={<span className="tabular-nums">{stock.disponible.pieces} p. · {fmtNum(stock.disponible.kg, 1)} kg</span>}
          />
          {href && (
            <Link to={href} className="inline-flex items-center gap-1.5 text-xs text-accent hover:underline pt-1">
              <Warehouse className="h-3.5 w-3.5" />
              Voir les pièces dans Tombé Métier › Stock
            </Link>
          )}
        </>
      )}
    </div>
  )
}

interface FiniLie { IDref_fini: number; reference: string | null; designation: string | null; avec_teinture: number; archive: number }

/** The finished references made from this écru: the reverse of the
 *  « Référence écru » row on Finis › Références. */
function FinisIssusCard({ refId }: { refId: number }) {
  const { finiHref } = useContext(ScreenVariantContext)
  const [showArchived, setShowArchived] = useState(false)
  useEffect(() => { setShowArchived(false) }, [refId])
  const { data: finis, isError } = useQuery<FiniLie[]>({
    queryKey: ['ref-ecru-finis', refId],
    queryFn: () => apiFetch(`/references-ecru/${refId}/finis`),
  })
  const active = (finis ?? []).filter((f) => !f.archive)
  const archived = (finis ?? []).filter((f) => !!f.archive)
  const shown = showArchived ? [...active, ...archived] : active
  return (
    <div className="p-3 rounded-lg border bg-card shadow-sm space-y-2">
      <div className="flex items-center gap-1.5">
        <Droplets className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-xs font-semibold text-muted-foreground">Finis issus de cet écru</p>
        {finis && <Badge variant="secondary" className="text-[10px] py-0 ml-auto tabular-nums">{active.length}</Badge>}
      </div>
      {isError ? (
        <p className="text-sm text-destructive">Liste indisponible</p>
      ) : !finis ? (
        <div className="h-8 flex items-center"><Loader2 className="h-4 w-4 animate-spin text-accent" /></div>
      ) : finis.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">Aucune référence finie</p>
      ) : (
        <div className="space-y-1">
          {shown.map((f) => {
            const body = (
              <>
                <span className={cn('font-medium flex-shrink-0', !!f.archive && 'text-muted-foreground')}>{f.reference ?? '—'}</span>
                <span className="text-xs text-muted-foreground truncate flex-1">{f.designation ?? ''}</span>
                <span className="text-[10px] text-muted-foreground flex-shrink-0">{f.avec_teinture ? 'Teint' : 'Lavé'}</span>
              </>
            )
            const cls = 'flex items-baseline gap-2 text-sm rounded-md px-1.5 py-1 -mx-1.5'
            return finiHref && f.reference ? (
              <Link key={f.IDref_fini} to={finiHref(f.reference)} className={cn(cls, 'hover:bg-accent/10')} title="Ouvrir dans Finis › Références">
                {body}
              </Link>
            ) : (
              <div key={f.IDref_fini} className={cls}>{body}</div>
            )
          })}
          {archived.length > 0 && (
            <button type="button" onClick={() => setShowArchived((v) => !v)} className="text-xs text-muted-foreground hover:text-foreground transition-colors pt-1">
              {showArchived ? 'Masquer les archivées' : `Afficher les archivées (${archived.length})`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** Coût de revient (matière + façon) and the TRM knitting cost breakdown,
 *  shown in place (it used to sit behind a « Détail du calcul » dialog). */
function CoutTab({ detail }: { detail: RefEcruDetail }) {
  const [qtyInput, setQtyInput] = useState('1000')
  const [debouncedQty, setDebouncedQty] = useState(1000)
  useEffect(() => {
    const t = setTimeout(() => {
      const n = Number(qtyInput)
      setDebouncedQty(Number.isFinite(n) && n >= 1 ? n : 1000)
    }, 300)
    return () => clearTimeout(t)
  }, [qtyInput])
  const { data: bd, isFetching } = useCoutTricotage(detail.IDref_ecru, debouncedQty, true)
  const floorWins = bd ? bd.floor >= bd.salePrice : false
  return (
    <>
      {detail.cout_kg != null && (
        <div className="p-3 rounded-lg border bg-card shadow-sm">
          <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 mb-1">
            <Layers className="h-3.5 w-3.5" />
            Coût de revient
          </p>
          <p className="text-2xl font-bold tabular-nums text-accent">{fmtNum(detail.cout_kg, 2)} <span className="text-sm font-normal text-muted-foreground">€/kg</span></p>
          <p className="text-[11px] text-muted-foreground mt-0.5">Matière (composition × prix des fils) + façon {detail.prix != null ? `${fmtNum(detail.prix, 2)} €/kg` : ''}</p>
        </div>
      )}
      <div className="p-3 rounded-lg border bg-card shadow-sm space-y-3">
        <div className="flex items-center gap-1.5">
          <TmRollIcon className="h-3.5 w-3.5 text-muted-foreground" />
          <p className="text-xs font-semibold text-muted-foreground">Coût de tricotage</p>
          {isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin text-accent ml-auto" />}
        </div>
        <div className="flex items-center justify-between gap-2">
          <label className="text-xs text-muted-foreground">Quantité</label>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              min={1}
              step="1"
              value={qtyInput}
              onChange={(e) => setQtyInput(e.target.value)}
              className="h-7 w-24 px-2 text-sm text-right tabular-nums rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <span className="text-xs text-muted-foreground">kg</span>
          </div>
        </div>
        {bd === undefined ? (
          <div className="h-8 flex items-center"><Loader2 className="h-4 w-4 animate-spin text-accent" /></div>
        ) : !bd.computable ? (
          <p className="text-xs text-muted-foreground rounded-md border border-border/60 bg-muted/40 px-2.5 py-2">
            Aucune donnée machine pour cette référence : le coût de tricotage ne peut pas être calculé. Le prix retenu est le prix plancher de la fiche.
          </p>
        ) : (
          <>
            <p className="text-[11px] text-muted-foreground">
              Métier : <span className="tabular-nums">{fmtNum(bd.inputs.gxNbToursKg, 2)}</span> trs/kg · <span className="tabular-nums">{bd.inputs.nbAiguilles}</span> aiguilles
            </p>
            {bd.sections.map((sec) => (
              <div key={sec.key}>
                <p className="text-[10px] font-semibold text-accent uppercase tracking-wide mb-1">{sec.label}</p>
                <div className="space-y-0.5">
                  {sec.rows.map((r) => (
                    <div key={r.key} className="flex items-baseline justify-between gap-2">
                      <span className="text-xs text-muted-foreground min-w-0 truncate" title={r.info ? `${r.label} · ${r.info}` : r.label}>{r.label}</span>
                      <span className="text-xs tabular-nums flex-shrink-0">{fmtNum(r.eurPerKg, 4)}</span>
                    </div>
                  ))}
                </div>
                <div className="flex items-baseline justify-between gap-2 mt-1 pt-1 border-t border-border/50">
                  <span className="text-xs font-semibold">Sous-total</span>
                  <span className="text-xs font-semibold tabular-nums">{fmtNum(sec.subtotalPerKg, 4)} €/kg</span>
                </div>
              </div>
            ))}
          </>
        )}
        {bd !== undefined && (
          <div className="border-t pt-2 space-y-1">
            {bd.computable && (
              <>
                <KV label="Coût total" value={<span className="font-bold tabular-nums text-accent">{fmtNum(bd.costPerKg, 2)} €/kg</span>} />
                <KV label="Prix de vente (marge 30 %)" value={<span className="tabular-nums">{fmtNum(bd.salePrice, 2)} €/kg</span>} />
              </>
            )}
            <KV label="Prix plancher (fiche)" value={<span className="tabular-nums">{fmtNum(bd.floor, 2)} €/kg</span>} />
            <KV
              label={floorWins ? 'Prix retenu (plancher)' : 'Prix retenu'}
              value={<span className="font-bold tabular-nums">{fmtNum(bd.retainedPrice, 2)} €/kg</span>}
            />
          </div>
        )}
      </div>
    </>
  )
}
