// Tombé Métier › Échantillons — trial écru fabrics followed apart from the
// running references, until they are archived or become a reference
// (claude_doc/echantillons_plan.md). Same grammar as Références (Classeur,
// spec tiles); the API is routes/echantillons.ts, rules lib/echantillons.ts.
//
// Shared with TRM through `@etm`: local modules are imported RELATIVELY, and
// the only per-app difference is the API mount (`apiBase`), which carries the
// app's own Écrans grant and client ledger.
import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useSearchParams } from 'react-router-dom'
import {
  Search,
  Loader2,
  AlertCircle,
  Pencil,
  Plus,
  X,
  Save,
  Trash2,
  Printer,
  FlaskConical,
  Package,
  Layers,
  Archive,
  ArchiveRestore,
  CheckCircle2,
  ChevronUp,
  ArrowRight,
  Lock,
  BellRing,
} from 'lucide-react'
import { UnsavedChangesDialog } from '@/components/shared/UnsavedChangesDialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
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
import { SpecTile, TileText, TileValue, TextTile, tileInput } from './tombe-metier/spec-tiles'
import { JAUGE_OPTIONS, DIAM_OPTIONS, jaugeLabel, diametreLabel } from './tombe-metier/ordinals'
import { ColorisCompoLineRow, type CompoDraftLine, type RefFilLookup } from './tombe-metier/composition-fil'

// ── Types ──────────────────────────────────────────────

type Statut = 'en_cours' | 'reference' | 'archive'

interface ReferenceCreee { IDref_ecru: number; reference: string; designation: string }

interface EchantillonListRow {
  IDref_echantillon: number
  numero: string
  statut: Statut
  IDcontexture: number
  contexture_nom: string | null
  Jauge: number
  diametre: number
  lfa: number[]
  /** Off the machine (tombé métier) and after the internal wash (pré-industriel): cm, g/m², 0 = not measured. */
  tbm: Mesures
  lave: Mesures
  commentaire: string
  IDclient: number
  client_nom: string | null
  reference: ReferenceCreee | null
  /** Next follow-up: amber 7 days before, red from it (API lib/echantillons.ts). */
  relance: { date: string | null; urgence: Urgence | null; jours: number | null }
  pieces_count: number
}

interface CompoLine {
  IDfil_ref_echantillon: number
  IDref_fil: number
  ref_fil_reference: string | null
  IDcolori_fil: number
  colori_fil_reference: string | null
  pourcentage: number
}

interface Piece {
  IDpiece_echantillon: number
  numero: string
  date: string | null
  IDmachine: number
  machine_nom: string | null
  poids: number
  longueur: number
  laize: number
}

interface EchantillonDetail extends Omit<EchantillonListRow, 'pieces_count'> {
  composition: CompoLine[]
  pieces: Piece[]
  relances: RelanceFaite[]
}

interface ContextureLookup { IDcontexture: number; nom: string | null }
interface ClientLookup { IDclient: number; nom: string | null; ville: string | null }
interface MachineLookup { IDmachine: number; nom: string | null }

type Urgence = 'retard' | 'bientot'
/** Same delay as the API's DELAI_RELANCE_JOURS: the date « Relancé » proposes. */
const DELAI_RELANCE_JOURS = 30
interface RelanceFaite { id: number; le: string; auteur: string; note: string; prochaine_relance: string | null }

interface Draft {
  IDcontexture: number
  Jauge: number
  diametre: number
  lfa: string[]
  tbm: { laize: string; poids: string }
  lave: { laize: string; poids: string }
  commentaire: string
  IDclient: number
  /** YYYY-MM-DD, '' = none. */
  date_relance: string
}

const STATUT_META: Record<Statut, { label: string; filtre: string; icon: typeof FlaskConical; solid: string }> = {
  en_cours: { label: 'En cours', filtre: 'En cours', icon: FlaskConical, solid: 'bg-primary border-primary' },
  reference: { label: 'Devenu référence', filtre: 'Retenus', icon: CheckCircle2, solid: 'bg-success border-success' },
  archive: { label: 'Archivé', filtre: 'Archivés', icon: Archive, solid: 'bg-zinc-500 border-zinc-500' },
}
const STATUTS: Statut[] = ['en_cours', 'reference', 'archive']

interface Mesures { laize: number; poids: number }
const numDraft = (v: number) => (v > 0 ? String(v) : '')
const numBody = (v: string) => Number(v.replace(',', '.')) || 0

const inputClass =
  'w-full h-8 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring'
const editSectionClass = 'border-l-4 border-l-accent/70 bg-accent/[0.03]'

const draftFromDetail = (d: EchantillonDetail): Draft => ({
  IDcontexture: d.IDcontexture,
  Jauge: d.Jauge,
  diametre: d.diametre,
  lfa: d.lfa.map((v) => (v > 0 ? v.toFixed(2) : '')),
  tbm: { laize: numDraft(d.tbm.laize), poids: numDraft(d.tbm.poids) },
  lave: { laize: numDraft(d.lave.laize), poids: numDraft(d.lave.poids) },
  commentaire: d.commentaire,
  IDclient: d.IDclient,
  date_relance: d.relance.date ?? '',
})

/** « Contexture · Jauge 20 · Ø 30" » — what the fabric is, in one line. */
function identite(e: { contexture_nom: string | null; Jauge: number; diametre: number }): string {
  return [
    e.contexture_nom,
    jaugeLabel(e.Jauge) ? `Jauge ${jaugeLabel(e.Jauge)}` : null,
    diametreLabel(e.diametre) ? `Ø ${diametreLabel(e.diametre)}` : null,
  ].filter(Boolean).join(' · ')
}

function messageErreur(err: unknown, defaut: string): string {
  const e = err as Error & { status?: number; body?: { message?: string } }
  if (e?.body?.message) return e.body.message
  if (e?.status === 401) return 'Votre session a expiré. Veuillez vous reconnecter, puis réessayer.'
  return defaut
}

// ── Page ───────────────────────────────────────────────

export function TombeMetierEchantillons({ apiBase = '/echantillons' }: {
  /** ETM `/echantillons`, TRM `/echantillons-trm` (its own grant + clients). */
  apiBase?: string
} = {}) {
  const queryClient = useQueryClient()
  // `?id=…&statut=…` opens a sample (Références › « Issue de l'échantillon »).
  const [searchParams] = useSearchParams()
  const [statut, setStatut] = useState<Statut>(() => {
    const s = searchParams.get('statut') as Statut | null
    return s && STATUTS.includes(s) ? s : 'en_cours'
  })
  const [selectedId, setSelectedId] = useState<number | null>(() => Number(searchParams.get('id')) || null)
  const [searchQuery, setSearchQuery] = useState('')
  // §41: the two pills are independent toggles — both on = red AND amber.
  const [relanceFiltre, setRelanceFiltre] = useState<Record<Urgence, boolean>>({ retard: false, bientot: false })
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const originalDraftRef = useRef<Draft | null>(null)
  const [autoEditForId, setAutoEditForId] = useState<number | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // `?id=` alone (the QR code on the Dymo tag) does not know the sample's
  // filter: hold the auto-select until its detail says which one.
  const [deepLinkId, setDeepLinkId] = useState<number | null>(() =>
    searchParams.get('id') && !searchParams.get('statut') ? Number(searchParams.get('id')) || null : null)
  const [creerOpen, setCreerOpen] = useState(false)

  // Per-key dirty registry (§28.3.b): the composition dialog and the piece
  // dialog can each hold unsaved input.
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

  const { data: rows, isLoading, isError, error } = useQuery<EchantillonListRow[]>({
    queryKey: ['echantillons', apiBase, statut],
    queryFn: () => apiFetch(`${apiBase}?statut=${statut}`),
  })
  const { data: detail, isLoading: detailLoading, isError: detailError } = useQuery<EchantillonDetail>({
    queryKey: ['echantillon', apiBase, selectedId],
    queryFn: () => apiFetch(`${apiBase}/${selectedId}`),
    enabled: selectedId !== null,
  })
  const { data: contextures } = useQuery<ContextureLookup[]>({
    queryKey: ['ref-ecru-lk-contextures'],
    queryFn: () => apiFetch('/references-ecru/lookups/contextures'),
    enabled: isEditing,
    staleTime: 5 * 60_000,
  })
  const { data: clients } = useQuery<ClientLookup[]>({
    queryKey: ['echantillons-lk-clients', apiBase],
    queryFn: () => apiFetch(`${apiBase}/lookups/clients`),
    enabled: isEditing,
    staleTime: 5 * 60_000,
  })

  const searched = useMemo(() => {
    if (!rows) return []
    const tokens = searchQuery.toLowerCase().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return rows
    return rows.filter((r) => {
      const haystack = [r.numero, identite(r), r.client_nom, r.commentaire, r.reference?.reference]
        .filter(Boolean).join(' ').toLowerCase()
      return tokens.every((t) => haystack.includes(t))
    })
  }, [rows, searchQuery])
  // §41 counter pills: counted over the searched list; an armed pill whose
  // bucket emptied stops filtering (it is hidden at 0). Armed pills combine:
  // the list shows every card of every armed colour.
  const comptes = useMemo(() => ({
    retard: searched.filter((r) => r.relance.urgence === 'retard').length,
    bientot: searched.filter((r) => r.relance.urgence === 'bientot').length,
  }), [searched])
  const filtresActifs = useMemo(
    () => ({ retard: relanceFiltre.retard && comptes.retard > 0, bientot: relanceFiltre.bientot && comptes.bientot > 0 }),
    [relanceFiltre, comptes],
  )
  const filtered = useMemo(() => {
    if (!filtresActifs.retard && !filtresActifs.bientot) return searched
    return searched.filter((r) => r.relance.urgence !== null && filtresActifs[r.relance.urgence])
  }, [searched, filtresActifs])

  useAutoSelectFirst({
    rows: filtered,
    selectedId,
    getId: (r) => r.IDref_echantillon,
    select: setSelectedId,
    suspended: isEditing || autoEditForId !== null || deepLinkId !== null,
  })

  useEffect(() => {
    if (deepLinkId === null) return
    if (detail?.IDref_echantillon === deepLinkId) setStatut(detail.statut)
    if (detail?.IDref_echantillon === deepLinkId || detailError) setDeepLinkId(null)
  }, [deepLinkId, detail, detailError])

  const startEdit = useCallback(() => {
    if (!detail) return
    const snap = draftFromDetail(detail)
    setDraft(snap)
    originalDraftRef.current = snap
    setIsEditing(true)
  }, [detail])

  const cancelEdit = useCallback(() => {
    setIsEditing(false)
    setDraft(null)
    originalDraftRef.current = null
  }, [])

  const isDirty = useMemo(() => {
    if (!isEditing || !draft || !originalDraftRef.current) return false
    return JSON.stringify(draft) !== JSON.stringify(originalDraftRef.current) || dirtyKeys.size > 0
  }, [isEditing, draft, dirtyKeys])

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['echantillons', apiBase] })
    queryClient.invalidateQueries({ queryKey: ['echantillon', apiBase] })
  }, [queryClient, apiBase])

  const saveMutation = useMutation({
    mutationFn: () => {
      const d = draft!
      return apiFetch(`${apiBase}/${selectedId}`, {
        method: 'PUT',
        body: JSON.stringify({
          IDcontexture: d.IDcontexture,
          Jauge: d.Jauge,
          diametre: d.diametre,
          lfa: d.lfa.map((v) => Number(v.replace(',', '.')) || 0),
          tbm: { laize: numBody(d.tbm.laize), poids: numBody(d.tbm.poids) },
          lave: { laize: numBody(d.lave.laize), poids: numBody(d.lave.poids) },
          commentaire: d.commentaire,
          IDclient: d.IDclient,
          date_relance: d.date_relance || null,
        }),
      })
    },
    onSuccess: () => {
      invalidate()
      setIsEditing(false)
      originalDraftRef.current = null
    },
    onError: (err) => setActionError(messageErreur(err, "L'enregistrement de l'échantillon a échoué. Veuillez réessayer.")),
  })

  const createMutation = useMutation({
    mutationFn: () => apiFetch<{ IDref_echantillon: number }>(apiBase, { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (data) => {
      setStatut('en_cours')
      queryClient.invalidateQueries({ queryKey: ['echantillons', apiBase] })
      setSelectedId(data.IDref_echantillon)
      setAutoEditForId(data.IDref_echantillon)
    },
    onError: (err) => setActionError(messageErreur(err, "La création de l'échantillon a échoué. Veuillez réessayer.")),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`${apiBase}/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, deletedId) => {
      setDeleteOpen(false)
      setDeleteError(null)
      setIsEditing(false)
      originalDraftRef.current = null
      const cached = queryClient.getQueryData<EchantillonListRow[]>(['echantillons', apiBase, statut]) ?? []
      const remaining = cached.filter((r) => r.IDref_echantillon !== deletedId)
      queryClient.removeQueries({ queryKey: ['echantillon', apiBase, deletedId] })
      queryClient.invalidateQueries({ queryKey: ['echantillons', apiBase] })
      setSelectedId(remaining.length > 0 ? remaining[0].IDref_echantillon : null)
    },
    onError: (err) => setDeleteError(messageErreur(err, 'Suppression impossible.')),
  })

  // Archiver / Rouvrir: the sample moves to another filter, the user follows it.
  const statutMutation = useMutation({
    mutationFn: (action: 'archiver' | 'rouvrir') => apiFetch(`${apiBase}/${selectedId}/${action}`, { method: 'POST' }),
    onSuccess: (_data, action) => {
      invalidate()
      setStatut(action === 'archiver' ? 'archive' : 'en_cours')
    },
    onError: (err) => setActionError(messageErreur(err, 'Le changement de statut a échoué. Veuillez réessayer.')),
  })

  useEffect(() => {
    if (autoEditForId !== null && detail?.IDref_echantillon === autoEditForId) {
      startEdit()
      setAutoEditForId(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEditForId, detail])

  const guard = useUnsavedGuard({
    isDirty,
    save: async () => { await saveMutation.mutateAsync() },
    onDiscard: () => cancelEdit(),
  })

  const handleSelect = useCallback((id: number) => {
    guard.guardAction(() => {
      setIsEditing(false)
      originalDraftRef.current = null
      setSelectedId(id)
    })
  }, [guard])

  // The saved client may sit in the other company's ledger (the legacy
  // samples are TRM's « Ets Malterre »): keep it pickable so the field never
  // shows blank.
  const clientOptions = useMemo(() => {
    const list = clients ?? []
    if (detail && detail.IDclient > 0 && !list.some((c) => c.IDclient === detail.IDclient)) {
      return [{ IDclient: detail.IDclient, nom: detail.client_nom, ville: null }, ...list]
    }
    return list
  }, [clients, detail])

  return (
    <>
      <MasterDetailLayout
        list={
          <EchantillonList
            rows={filtered}
            comptes={comptes}
            relanceFiltre={filtresActifs}
            onRelanceFiltre={(u) => setRelanceFiltre((prev) => ({ ...prev, [u]: !prev[u] }))}
            isLoading={isLoading}
            isError={isError}
            error={error as Error | null}
            selectedId={selectedId}
            onSelect={handleSelect}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            statut={statut}
            onStatutChange={(s) => guard.guardAction(() => { setIsEditing(false); setStatut(s) })}
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
            onStartEdit={startEdit}
            onCancelEdit={cancelEdit}
            onSave={() => saveMutation.mutate()}
            isSaving={saveMutation.isPending}
            onDelete={() => { setDeleteError(null); setDeleteOpen(true) }}
            onPrint={() => { if (selectedId !== null) window.open(`${API_URL}${apiBase}/${selectedId}/etiquette`, '_blank') }}
            onCreerReference={() => setCreerOpen(true)}
          />
        }
        detail={
          <DetailMain
            apiBase={apiBase}
            detail={detail ?? null}
            isLoading={detailLoading && selectedId !== null}
            hasSelection={selectedId !== null}
            isEditing={isEditing}
            draft={draft}
            onDraftChange={setDraft}
            contextures={contextures ?? []}
            clients={clientOptions}
            onMutationSuccess={invalidate}
            reportDirty={reportDirty}
          />
        }
        sidebar={selectedId !== null ? (
          <DetailSidebar
            detail={detail ?? null}
            apiBase={apiBase}
            isEditing={isEditing}
            draft={draft}
            onDraftChange={setDraft}
            onMutationSuccess={invalidate}
            onArchiver={() => statutMutation.mutate('archiver')}
            onRouvrir={() => statutMutation.mutate('rouvrir')}
            onCreerReference={() => setCreerOpen(true)}
            isChanging={statutMutation.isPending}
          />
        ) : null}
        sidebarTitle="Informations"
        hasSelection={selectedId !== null}
        onBack={() => guard.guardAction(() => { setIsEditing(false); setSelectedId(null) })}
      />

      <UnsavedChangesDialog open={guard.showDialog} onAction={guard.handleAction} isSaving={guard.isSaving} />

      <ConfirmDialog
        open={deleteOpen}
        title="Supprimer l'échantillon"
        description={deleteError ?? "Cette action supprimera l'échantillon et sa composition. Elle est irréversible."}
        isPending={deleteMutation.isPending}
        onCancel={() => { setDeleteOpen(false); setDeleteError(null) }}
        onConfirm={() => { if (selectedId !== null) { setIsEditing(false); deleteMutation.mutate(selectedId) } }}
      />

      <Dialog open={actionError !== null} onOpenChange={(o) => { if (!o) setActionError(null) }}>
        <DialogContent className="max-w-md" onClose={() => setActionError(null)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-destructive" />
              Opération impossible
            </DialogTitle>
          </DialogHeader>
          <p className="mt-4 text-sm text-muted-foreground">{actionError}</p>
          <DialogFooter className="mt-4">
            <Button onClick={() => setActionError(null)}>OK</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {creerOpen && detail && (
        <CreerReferenceDialog
          apiBase={apiBase}
          detail={detail}
          onClose={() => setCreerOpen(false)}
          onCreated={() => {
            setCreerOpen(false)
            invalidate()
            queryClient.invalidateQueries({ queryKey: ['refs-ecru'] })
            setStatut('reference')
          }}
        />
      )}

    </>
  )
}

// ── Left: list ─────────────────────────────────────────

function EchantillonList({
  rows, comptes, relanceFiltre, onRelanceFiltre, isLoading, isError, error, selectedId, onSelect, searchQuery, onSearchChange,
  statut, onStatutChange, onNew, isCreating, isEditing,
}: {
  rows: EchantillonListRow[]
  comptes: Record<Urgence, number>
  relanceFiltre: Record<Urgence, boolean>
  onRelanceFiltre: (u: Urgence) => void
  isLoading: boolean
  isError: boolean
  error: Error | null
  selectedId: number | null
  onSelect: (id: number) => void
  searchQuery: string
  onSearchChange: (q: string) => void
  statut: Statut
  onStatutChange: (s: Statut) => void
  onNew: () => void
  isCreating: boolean
  isEditing: boolean
}) {
  const selectedRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => { selectedRef.current?.scrollIntoView({ block: 'nearest' }) }, [selectedId, rows])
  return (
    <div className="flex flex-col h-full rounded-lg border shadow-sm bg-zinc-100/80">
      <div className="p-3 border-b rounded-t-lg bg-zinc-200/50 space-y-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
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
          {(['retard', 'bientot'] as const).map((u) => comptes[u] > 0 && (
            <CompteurRelance key={u} urgence={u} count={comptes[u]} on={relanceFiltre[u]} onToggle={() => onRelanceFiltre(u)} />
          ))}
        </div>
        <div className="flex flex-wrap gap-1">
          {STATUTS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onStatutChange(s)}
              className={cn(
                'px-2 py-1 text-xs rounded-md transition-colors flex-grow basis-[calc(33.333%-0.25rem)]',
                statut === s ? 'bg-accent text-accent-foreground shadow-sm font-medium' : 'text-muted-foreground hover:bg-accent/10',
              )}
            >
              {STATUT_META[s].filtre}
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
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <FlaskConical className="h-12 w-12 mb-3 opacity-50" />
            <p className="text-sm">Aucun échantillon</p>
          </div>
        ) : (
          rows.map((r) => {
            const ident = identite(r)
            const premiereLigne = r.commentaire.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
            const urgence = r.relance.urgence
            const selected = selectedId === r.IDref_echantillon
            return (
              <div
                key={r.IDref_echantillon}
                ref={selectedId === r.IDref_echantillon ? selectedRef : undefined}
                onClick={() => onSelect(r.IDref_echantillon)}
                className={cn(
                  'p-3 border rounded-lg cursor-pointer transition-all bg-white',
                  // §30/§41: the urgency colour takes the liseré AND the selection ring.
                  selected
                    ? urgence === 'retard' ? 'border-red-500 ring-1 ring-red-500'
                      : urgence === 'bientot' ? 'border-amber-500 ring-1 ring-amber-500'
                      : 'border-accent ring-1 ring-accent'
                    : urgence === 'retard' ? 'border-border hover:border-red-500/50'
                      : urgence === 'bientot' ? 'border-border hover:border-amber-500/50'
                      : 'border-border hover:border-accent/50',
                  urgence === 'retard' && 'shadow-[inset_4px_0_0_0_rgb(239_68_68)]',
                  urgence === 'bientot' && 'shadow-[inset_4px_0_0_0_rgb(245_158_11)]',
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <FlaskConical className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  <p className="font-medium text-sm truncate flex-1 tabular-nums">{r.numero}</p>
                  {r.reference && (
                    <span className="flex-shrink-0 inline-flex items-center gap-0.5 rounded-full border border-success/30 bg-success/10 px-1.5 py-0 text-[10px] font-medium text-success">
                      <ArrowRight className="h-2.5 w-2.5" />Réf. {r.reference.reference}
                    </span>
                  )}
                </div>
                {ident && <p className="text-xs text-muted-foreground mt-0.5 truncate">{ident}</p>}
                {premiereLigne && <p className="text-xs text-muted-foreground/80 italic mt-0.5 line-clamp-2">{premiereLigne}</p>}
                {urgence && (
                  <p className={cn('text-[11px] font-medium mt-1', urgence === 'retard' ? 'text-red-600' : 'text-amber-700')}>
                    {raisonRelance(r.relance)}
                  </p>
                )}
                <div className="flex items-center justify-between gap-2 mt-1 text-[11px] text-muted-foreground">
                  <span className="truncate">{r.client_nom ?? ''}</span>
                  <span className="flex-shrink-0 tabular-nums">
                    {r.pieces_count} pièce{r.pieces_count !== 1 ? 's' : ''}
                  </span>
                </div>
              </div>
            )
          })
        )}
      </div>
      <div className="p-3 border-t text-xs text-muted-foreground flex items-center justify-between rounded-b-lg bg-zinc-200/50">
        <span>{rows.length} échantillon{rows.length !== 1 ? 's' : ''}</span>
        {!isEditing && statut === 'en_cours' && (
          <Button size="sm" variant="ghost" onClick={onNew} disabled={isCreating} className="text-accent hover:text-accent hover:bg-accent/10">
            <Plus className="h-3.5 w-3.5 mr-1" />
            Nouveau
          </Button>
        )}
      </div>
    </div>
  )
}

/** « Relance en retard de 3 j » / « Relance aujourd'hui » / « Relance dans 4 j (28/10/2026) ». */
function raisonRelance(r: EchantillonListRow['relance']): string {
  if (r.jours == null || !r.date) return ''
  if (r.jours < 0) return `Relance en retard de ${-r.jours} j`
  if (r.jours === 0) return "Relance aujourd'hui"
  return `Relance dans ${r.jours} j (${formatHfsqlDate(r.date)})`
}

/** §41 counter pill, flush right of the search: hidden at 0, solid when armed. */
function CompteurRelance({ urgence, count, on, onToggle }: { urgence: Urgence; count: number; on: boolean; onToggle: () => void }) {
  const rouge = urgence === 'retard'
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={on}
      title={rouge ? 'Relance due ou en retard' : 'Relance dans les 7 jours'}
      className={cn(
        'h-7 min-w-[1.75rem] px-1.5 inline-flex items-center justify-center rounded-md text-xs font-semibold tabular-nums border transition-colors flex-shrink-0',
        rouge
          ? on ? 'bg-red-500 text-white border-red-500 shadow-sm' : 'bg-red-500/10 text-red-700 border-red-500/30 hover:bg-red-500/20'
          : on ? 'bg-amber-500 text-white border-amber-500 shadow-sm' : 'bg-amber-500/10 text-amber-800 border-amber-500/30 hover:bg-amber-500/20',
      )}
    >
      {count}
    </button>
  )
}

// ── Center: header ─────────────────────────────────────

function DetailHeader({
  detail, isLoading, isEditing, onStartEdit, onCancelEdit, onSave, isSaving, onDelete, onPrint, onCreerReference,
}: {
  detail: EchantillonDetail | null
  isLoading: boolean
  isEditing: boolean
  onStartEdit: () => void
  onCancelEdit: () => void
  onSave: () => void
  isSaving: boolean
  onDelete: () => void
  onPrint: () => void
  onCreerReference: () => void
}) {
  if (!detail && !isLoading) return null
  const ouvert = detail?.statut === 'en_cours'
  const sousTitre = detail ? [detail.client_nom, identite(detail)].filter(Boolean).join(' — ') : ''
  return (
    <div className="flex-shrink-0 pt-0.5">
      <div className="flex items-center gap-3">
        <div className={cn('h-11 w-11 rounded-lg flex items-center justify-center', isEditing ? 'bg-accent/15 text-accent' : 'icon-box-gold')}>
          <FlaskConical className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          {isLoading ? (
            <div className="h-8 w-48 bg-muted animate-pulse rounded" />
          ) : (
            <div className="flex items-center gap-3 min-w-0">
              <div className="min-w-0">
                <h1 className="text-2xl font-heading font-bold tracking-tight truncate tabular-nums">Échantillon {detail?.numero}</h1>
                {sousTitre && <p className="text-sm text-muted-foreground truncate mt-0.5">{sousTitre}</p>}
              </div>
              {isEditing && (
                <Badge className="bg-accent text-accent-foreground flex-shrink-0 gap-1 shadow-sm">
                  <Pencil className="h-3 w-3" />
                  Mode edition
                </Badge>
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
                <Button variant="outline" size="icon" className="h-9 w-9" title="Imprimer l'étiquette (Dymo)" onClick={onPrint}>
                  <Printer className="h-4 w-4" />
                </Button>
                {ouvert && (
                  <Button variant="outline" size="icon" className="h-9 w-9" onClick={onCreerReference} title="Créer la référence tombé métier à partir de cet échantillon">
                    <TmRollIcon className="h-[22px] w-[22px]" />
                  </Button>
                )}
                <Button
                  variant="gold"
                  size="sm"
                  onClick={onStartEdit}
                  disabled={!ouvert}
                  title={ouvert ? undefined : "L'échantillon n'est plus en cours : rouvrez-le pour le modifier."}
                >
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

// ── Center: Classeur tabs (§39) ────────────────────────

const MAIN_TABS = [
  { key: 'specifications', label: 'Spécifications', icon: Package },
  { key: 'pieces', label: "Pièces d'essai", icon: Layers },
] as const
type MainTab = (typeof MAIN_TABS)[number]['key']

function DetailMain({
  apiBase, detail, isLoading, hasSelection, isEditing, draft, onDraftChange, contextures, clients, onMutationSuccess, reportDirty,
}: {
  apiBase: string
  detail: EchantillonDetail | null
  isLoading: boolean
  hasSelection: boolean
  isEditing: boolean
  draft: Draft | null
  onDraftChange: (d: Draft) => void
  contextures: ContextureLookup[]
  clients: ClientLookup[]
  onMutationSuccess: () => void
  reportDirty: (key: string, dirty: boolean) => void
}) {
  const [activeTab, setActiveTab] = useState<MainTab>('specifications')
  useEffect(() => { setActiveTab('specifications') }, [detail?.IDref_echantillon])

  if (!hasSelection) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="icon-box-gold h-16 w-16 mx-auto">
            <FlaskConical className="h-8 w-8" />
          </div>
          <p className="text-muted-foreground text-sm">Sélectionnez un échantillon dans la liste</p>
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

  const counts: Partial<Record<MainTab, number>> = { pieces: detail.pieces.length }

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
              {count != null && count > 0 && <span className="text-xs tabular-nums opacity-70">{count}</span>}
            </button>
          )
        })}
      </div>
      <div className="flex-1 min-h-0 overflow-auto space-y-2 pt-3 px-1 pb-1 scrollbar-transparent">
        {activeTab === 'specifications' && (
          <SpecsCard
            apiBase={apiBase}
            detail={detail}
            isEditing={isEditing && draft !== null}
            draft={draft}
            onDraftChange={onDraftChange}
            contextures={contextures}
            clients={clients}
            onMutationSuccess={onMutationSuccess}
            reportDirty={reportDirty}
          />
        )}
        {activeTab === 'pieces' && (
          <PiecesTab apiBase={apiBase} detail={detail} isEditing={isEditing} onMutationSuccess={onMutationSuccess} reportDirty={reportDirty} />
        )}
      </div>
    </div>
  )
}

// ── Spécifications ─────────────────────────────────────

function SpecsCard({
  apiBase, detail, isEditing, draft, onDraftChange, contextures, clients, onMutationSuccess, reportDirty,
}: {
  apiBase: string
  detail: EchantillonDetail
  isEditing: boolean
  draft: Draft | null
  onDraftChange: (d: Draft) => void
  contextures: ContextureLookup[]
  clients: ClientLookup[]
  onMutationSuccess: () => void
  reportDirty: (key: string, dirty: boolean) => void
}) {
  const d = draft
  const ident = identite(detail)
  return (
    <Card className={cn('card-premium', isEditing && editSectionClass)}>
      <CardContent className="pt-4 pb-4 space-y-3">
        {/* Identity band: contexture, jauge, diamètre */}
        <div className="rounded-lg border border-border/60 bg-zinc-100/80 px-3 py-2 flex items-center gap-2.5">
          <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-amber-400/10">
            <TmRollIcon className="h-4 w-4 text-amber-600" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Contexture · Jauge · Ø</p>
            {isEditing && d ? (
              <div className="mt-1 grid grid-cols-4 gap-2">
                <div className="col-span-2">
                  <PopoverSelect
                    options={contextures.map((c) => ({ id: c.IDcontexture, primary: c.nom ?? `#${c.IDcontexture}` }))}
                    value={d.IDcontexture}
                    onChange={(id) => onDraftChange({ ...d, IDcontexture: id })}
                    emptyLabel="Contexture"
                  />
                </div>
                <PopoverSelect
                  options={JAUGE_OPTIONS.map((o) => ({ id: o.ord, primary: o.label }))}
                  value={d.Jauge}
                  onChange={(id) => onDraftChange({ ...d, Jauge: id })}
                  emptyLabel="Jauge"
                />
                <PopoverSelect
                  options={DIAM_OPTIONS.map((o) => ({ id: o.ord, primary: o.label }))}
                  value={d.diametre}
                  onChange={(id) => onDraftChange({ ...d, diametre: id })}
                  emptyLabel="Ø"
                />
              </div>
            ) : (
              <p className="text-sm font-semibold truncate">{ident || <span className="text-muted-foreground italic font-normal">Non renseignées</span>}</p>
            )}
          </div>
        </div>

        <SpecTile label="Client">
          {isEditing && d ? (
            <SearchableCombobox<ClientLookup>
              options={clients}
              value={d.IDclient}
              onChange={(id) => onDraftChange({ ...d, IDclient: id })}
              getId={(c) => c.IDclient}
              getPrimary={(c) => c.nom ?? `#${c.IDclient}`}
              placeholder="Rechercher un client"
            />
          ) : (
            <TileText value={detail.client_nom} />
          )}
        </SpecTile>

        {/* LFA per tour: the very tile of the reference's Réglages (one tile,
            four cells, « — » when empty, written « 7.50 » like ref_ecru's
            lfa_tour_N, which « Créer la référence » fills from these). */}
        <SpecTile label="LFA / tour">
          <div className="grid grid-cols-4 gap-1.5">
            {[0, 1, 2, 3].map((i) =>
              isEditing && d ? (
                <input
                  key={i}
                  type="text"
                  inputMode="decimal"
                  aria-label={`LFA tour ${i + 1}`}
                  value={d.lfa[i]}
                  onChange={(e) => { const lfa = [...d.lfa]; lfa[i] = e.target.value; onDraftChange({ ...d, lfa }) }}
                  className={cn(inputClass, 'text-center px-1 tabular-nums')}
                />
              ) : (
                <div key={i} className="h-8 flex items-center justify-center text-sm font-semibold rounded-md border border-border/60 bg-white tabular-nums">
                  {detail.lfa[i] > 0 ? detail.lfa[i].toFixed(2) : <span className="text-muted-foreground/50 font-normal">—</span>}
                </div>
              ),
            )}
          </div>
        </SpecTile>

        {/* The fabric's measures: off the machine, then after the internal
            wash every sample gets — the « pré-industriel » finished figures. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <MesuresTile
            label="Tombé métier"
            mesures={detail.tbm}
            draft={isEditing && d ? d.tbm : null}
            onChange={(tbm) => d && onDraftChange({ ...d, tbm })}
          />
          <MesuresTile
            label="Après lavage · pré-industriel"
            mesures={detail.lave}
            draft={isEditing && d ? d.lave : null}
            onChange={(lave) => d && onDraftChange({ ...d, lave })}
            avant={detail.tbm}
          />
        </div>

        <CompositionTile apiBase={apiBase} detail={detail} isEditing={isEditing} onMutationSuccess={onMutationSuccess} reportDirty={reportDirty} />

        <TextTile
          label="Commentaire"
          value={detail.commentaire}
          isEditing={isEditing && d !== null}
          draft={d?.commentaire ?? ''}
          rows={6}
          onChange={(v) => d && onDraftChange({ ...d, commentaire: v })}
        />
      </CardContent>
    </Card>
  )
}

/** « 165 cm · 260 g/m² » — empty when nothing is measured. */
function mesuresTexte(m: Mesures): string {
  return [m.laize > 0 ? `${fmtNum(m.laize, Number.isInteger(m.laize) ? 0 : 1)} cm` : null, m.poids > 0 ? `${fmtNum(m.poids, Number.isInteger(m.poids) ? 0 : 1)} g/m²` : null]
    .filter(Boolean).join(' · ')
}

/** Signed change from `avant` to `apres`, in %: « −4,2 % ». Null unless both are measured. */
function ecart(avant: number, apres: number): string | null {
  if (!(avant > 0) || !(apres > 0)) return null
  const pct = Math.round(((apres - avant) / avant) * 1000) / 10
  return `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${fmtNum(Math.abs(pct), 1)} %`
}

/** One tile, two measures (laize cm, poids g/m²) — the « Tombé métier » and
 *  « Après lavage » pair. The washed one shows how far each moved from the
 *  machine (`avant`), the shrinkage the wash revealed. */
function MesuresTile({ label, mesures, draft, onChange, avant }: {
  label: string
  mesures: Mesures
  draft: { laize: string; poids: string } | null
  onChange: (m: { laize: string; poids: string }) => void
  avant?: Mesures
}) {
  const champs = [
    { key: 'laize' as const, nom: 'Laize', unit: 'cm' },
    { key: 'poids' as const, nom: 'Poids', unit: 'g/m²' },
  ]
  return (
    <SpecTile label={label}>
      <div className="grid grid-cols-2 gap-2">
        {champs.map((c) => {
          const delta = avant ? ecart(avant[c.key], mesures[c.key]) : null
          return (
            <div key={c.key} className="min-w-0">
              <p className="text-[10px] text-muted-foreground">{c.nom}</p>
              {draft ? (
                <div className="flex items-center gap-1">
                  <input
                    type="text"
                    inputMode="decimal"
                    aria-label={`${label} — ${c.nom}`}
                    value={draft[c.key]}
                    onChange={(e) => onChange({ ...draft, [c.key]: e.target.value })}
                    className={tileInput}
                  />
                  <span className="text-xs text-muted-foreground flex-shrink-0">{c.unit}</span>
                </div>
              ) : (
                <>
                  <TileValue value={mesures[c.key] || null} unit={c.unit} />
                  {delta && <p className="text-[11px] text-muted-foreground tabular-nums mt-0.5" title="Écart avec le tombé métier">{delta} vs TBM</p>}
                </>
              )}
            </div>
          )
        })}
      </div>
    </SpecTile>
  )
}

function CompositionTile({ apiBase, detail, isEditing, onMutationSuccess, reportDirty }: {
  apiBase: string
  detail: EchantillonDetail
  isEditing: boolean
  onMutationSuccess: () => void
  reportDirty: (key: string, dirty: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const total = detail.composition.reduce((s, c) => s + c.pourcentage, 0)
  const totalOk = detail.composition.length === 0 || Math.abs(total - 100) < 0.01
  return (
    <div className="rounded-lg border border-border/60 bg-zinc-100/80 px-3 py-2.5 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Composition</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {detail.composition.length} fil{detail.composition.length !== 1 ? 's' : ''}
        </span>
        {detail.composition.length > 0 && (
          <Badge
            variant="secondary"
            className={cn('text-xs tabular-nums', !totalOk && 'bg-destructive/10 text-destructive ring-1 ring-destructive/20')}
            title={totalOk ? 'Total composition' : 'La composition doit totaliser 100 %'}
          >
            Σ {fmtNum(Math.round(total * 100) / 100, Number.isInteger(total) ? 0 : 2)} %
          </Badge>
        )}
        {isEditing && (
          <Button variant="ghost" size="sm" className="ml-auto h-7 text-accent hover:text-accent hover:bg-accent/10" onClick={() => setOpen(true)}>
            <Pencil className="h-3.5 w-3.5 mr-1.5" />Modifier la composition
          </Button>
        )}
      </div>
      {detail.composition.length === 0 ? (
        <p className="text-sm text-muted-foreground italic py-1">Aucun fil</p>
      ) : (
        detail.composition.map((c) => (
          <div key={c.IDfil_ref_echantillon} className="rounded-lg border-l-4 border border-border/60 border-l-amber-400/60 bg-white p-2.5 flex items-center gap-2">
            <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-amber-400/10">
              <FlaskConical className="h-3.5 w-3.5 text-amber-600" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">{c.ref_fil_reference ?? '—'}</p>
              <p className="text-[11px] text-muted-foreground truncate">{c.colori_fil_reference ?? 'coloris non précisé'}</p>
            </div>
            <span className="text-sm font-semibold tabular-nums flex-shrink-0">{fmtNum(c.pourcentage, Number.isInteger(c.pourcentage) ? 0 : 2)} %</span>
          </div>
        ))
      )}
      {open && (
        <CompositionDialog
          apiBase={apiBase}
          detail={detail}
          onClose={() => setOpen(false)}
          onSaved={() => { setOpen(false); onMutationSuccess() }}
          reportDirty={reportDirty}
        />
      )}
    </div>
  )
}

function CompositionDialog({ apiBase, detail, onClose, onSaved, reportDirty }: {
  apiBase: string
  detail: EchantillonDetail
  onClose: () => void
  onSaved: () => void
  reportDirty: (key: string, dirty: boolean) => void
}) {
  const keyRef = useRef(0)
  const nextKey = () => ++keyRef.current
  const [lines, setLines] = useState<CompoDraftLine[]>(() =>
    detail.composition.map((l) => ({ key: nextKey(), IDref_fil: l.IDref_fil, IDcolori_fil: l.IDcolori_fil, pourcentage: String(l.pourcentage) })),
  )
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const { data: refsFil } = useQuery<RefFilLookup[]>({
    queryKey: ['ref-ecru-lk-refsfil'],
    queryFn: () => apiFetch('/references-ecru/lookups/refs-fil'),
    staleTime: 5 * 60_000,
  })

  const reportDirtyRef = useRef(reportDirty)
  useEffect(() => { reportDirtyRef.current = reportDirty })
  useEffect(() => {
    reportDirtyRef.current('ech-composition', true)
    return () => { reportDirtyRef.current('ech-composition', false) }
  }, [])

  const total = lines.reduce((s, l) => s + (Number(l.pourcentage) || 0), 0)
  const totalOk = lines.length === 0 || Math.abs(total - 100) < 0.01
  const complete = lines.every((l) => l.IDref_fil > 0 && Number(l.pourcentage) > 0)
  const canSave = totalOk && complete

  const saveMut = useMutation({
    mutationFn: () => apiFetch(`${apiBase}/${detail.IDref_echantillon}/composition`, {
      method: 'PUT',
      body: JSON.stringify({
        lignes: lines.map((l) => ({ IDref_fil: l.IDref_fil, IDcolori_fil: l.IDcolori_fil, pourcentage: Number(l.pourcentage) })),
      }),
    }),
    onSuccess: onSaved,
    onError: (err) => setErrorMsg(messageErreur(err, "L'enregistrement a échoué. Veuillez réessayer.")),
  })

  const update = (key: number, patch: Partial<CompoDraftLine>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const addLine = () => setLines((ls) => [...ls, { key: nextKey(), IDref_fil: 0, IDcolori_fil: 0, pourcentage: '' }])

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-3xl" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FlaskConical className="h-5 w-5 text-accent" />
            Composition de l'échantillon {detail.numero}
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <p className="text-xs text-muted-foreground">
            C'est cette composition, coloris des fils compris, que reprendra la référence créée depuis l'échantillon.
          </p>
          {lines.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <FlaskConical className="h-10 w-10 mb-2 opacity-40" />
              <p className="text-sm">Aucun fil</p>
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
                  refsFil={refsFil ?? []}
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

// ── Pièces d'essai ─────────────────────────────────────

interface PieceForm { numero: string; date: string; IDmachine: number; poids: string; longueur: string; laize: string }

const aujourdhui = () => new Date().toISOString().slice(0, 10)

function PiecesTab({ apiBase, detail, isEditing, onMutationSuccess, reportDirty }: {
  apiBase: string
  detail: EchantillonDetail
  isEditing: boolean
  onMutationSuccess: () => void
  reportDirty: (key: string, dirty: boolean) => void
}) {
  // null = closed, 'new' = creating, a piece = editing it.
  const [form, setForm] = useState<Piece | 'new' | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Piece | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const deleteMut = useMutation({
    mutationFn: (pieceId: number) => apiFetch(`${apiBase}/${detail.IDref_echantillon}/pieces/${pieceId}`, { method: 'DELETE' }),
    onSuccess: () => { setDeleteTarget(null); onMutationSuccess() },
    onError: (err) => setDeleteError(messageErreur(err, 'Suppression impossible.')),
  })

  const pieces = detail.pieces
  const poidsTotal = pieces.reduce((s, p) => s + p.poids, 0)

  return (
    <>
      {pieces.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
          <Layers className="h-12 w-12 mb-3 opacity-40" />
          <p className="text-sm">Aucune pièce d'essai</p>
          {isEditing && (
            <Button variant="outline" size="sm" className="mt-3" onClick={() => setForm('new')}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter une pièce
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-border/60 bg-card shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-zinc-200/60 border-b border-border/60">
                <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-3 py-2.5 text-left font-semibold">N°</th>
                  <th className="px-3 py-2.5 text-left font-semibold">Date</th>
                  <th className="px-3 py-2.5 text-left font-semibold">Métier</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Poids</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Longueur</th>
                  <th className="px-3 py-2.5 text-right font-semibold">Laize</th>
                  {isEditing && <th className="w-10" />}
                </tr>
              </thead>
              <tbody>
                {pieces.map((p) => (
                  <tr
                    key={p.IDpiece_echantillon}
                    onClick={isEditing ? () => setForm(p) : undefined}
                    className={cn('group border-b border-border/40 last:border-b-0', isEditing && 'cursor-pointer hover:bg-accent/5')}
                  >
                    <td className="px-3 py-2 font-medium">{p.numero || '—'}</td>
                    <td className="px-3 py-2 tabular-nums">{p.date ? formatHfsqlDate(p.date) : '—'}</td>
                    <td className="px-3 py-2">{p.machine_nom ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{p.poids > 0 ? `${fmtNum(p.poids, 1)} kg` : '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{p.longueur > 0 ? `${fmtNum(p.longueur, 1)} m` : '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{p.laize > 0 ? `${fmtNum(p.laize)} cm` : '—'}</td>
                    {isEditing && (
                      <td className="px-1 py-2 text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-destructive hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Supprimer"
                          onClick={(e) => { e.stopPropagation(); setDeleteError(null); setDeleteTarget(p) }}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-zinc-100/80 border-t border-border/60">
                <tr className="text-xs text-muted-foreground">
                  <td className="px-3 py-2" colSpan={3}>{pieces.length} pièce{pieces.length !== 1 ? 's' : ''}</td>
                  <td className="px-3 py-2 text-right tabular-nums font-semibold text-foreground">{fmtNum(poidsTotal, 1)} kg</td>
                  <td colSpan={isEditing ? 3 : 2} />
                </tr>
              </tfoot>
            </table>
          </div>
          {isEditing && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setForm('new')}
              className="w-full text-muted-foreground hover:text-accent hover:bg-accent/5 border border-dashed border-border/60 hover:border-accent/40"
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter une pièce
            </Button>
          )}
        </>
      )}

      {form !== null && (
        <PieceDialog
          apiBase={apiBase}
          echantillonId={detail.IDref_echantillon}
          piece={form === 'new' ? null : form}
          numeroPropose={String(pieces.length + 1)}
          onClose={() => setForm(null)}
          onSaved={() => { setForm(null); onMutationSuccess() }}
          reportDirty={reportDirty}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Supprimer la pièce"
        description={deleteError ?? (deleteTarget ? `La pièce ${deleteTarget.numero || ''} sera supprimée.` : undefined)}
        isPending={deleteMut.isPending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => { if (deleteTarget) deleteMut.mutate(deleteTarget.IDpiece_echantillon) }}
      />
    </>
  )
}

function PieceDialog({ apiBase, echantillonId, piece, numeroPropose, onClose, onSaved, reportDirty }: {
  apiBase: string
  echantillonId: number
  piece: Piece | null
  numeroPropose: string
  onClose: () => void
  onSaved: () => void
  reportDirty: (key: string, dirty: boolean) => void
}) {
  const num = (v: number) => (v > 0 ? String(v) : '')
  const [form, setForm] = useState<PieceForm>(() => piece
    ? { numero: piece.numero, date: piece.date ?? '', IDmachine: piece.IDmachine, poids: num(piece.poids), longueur: num(piece.longueur), laize: num(piece.laize) }
    : { numero: numeroPropose, date: aujourdhui(), IDmachine: 0, poids: '', longueur: '', laize: '' })
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const { data: machines } = useQuery<MachineLookup[]>({
    queryKey: ['ref-ecru-lk-machines'],
    queryFn: () => apiFetch('/references-ecru/lookups/machines'),
    staleTime: 5 * 60_000,
  })

  const reportDirtyRef = useRef(reportDirty)
  useEffect(() => { reportDirtyRef.current = reportDirty })
  useEffect(() => {
    reportDirtyRef.current('ech-piece', true)
    return () => { reportDirtyRef.current('ech-piece', false) }
  }, [])

  const toNum = (s: string) => Number(s.replace(',', '.')) || 0
  const saveMut = useMutation({
    mutationFn: () => apiFetch(
      piece ? `${apiBase}/${echantillonId}/pieces/${piece.IDpiece_echantillon}` : `${apiBase}/${echantillonId}/pieces`,
      {
        method: piece ? 'PUT' : 'POST',
        body: JSON.stringify({
          numero: form.numero.trim(),
          date: form.date || null,
          IDmachine: form.IDmachine,
          poids: toNum(form.poids),
          longueur: toNum(form.longueur),
          laize: toNum(form.laize),
        }),
      },
    ),
    onSuccess: onSaved,
    onError: (err) => setErrorMsg(messageErreur(err, "L'enregistrement de la pièce a échoué. Veuillez réessayer.")),
  })

  const field = (key: 'poids' | 'longueur' | 'laize', label: string) => (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <input type="text" inputMode="decimal" value={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.value })} className={cn(inputClass, 'text-right tabular-nums')} />
    </div>
  )

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md max-h-[90dvh] overflow-y-auto" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-accent" />
            {piece ? 'Modifier la pièce' : 'Ajouter une pièce'}
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">N° de pièce</label>
            <input value={form.numero} onChange={(e) => setForm({ ...form, numero: e.target.value })} className={inputClass} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Date</label>
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className={inputClass} />
          </div>
          <div className="space-y-1 col-span-full">
            <label className="text-xs font-medium text-muted-foreground">Métier</label>
            <SearchableCombobox<MachineLookup>
              options={machines ?? []}
              value={form.IDmachine}
              onChange={(id) => setForm({ ...form, IDmachine: id })}
              getId={(m) => m.IDmachine}
              getPrimary={(m) => m.nom ?? `#${m.IDmachine}`}
              placeholder="Rechercher un métier"
            />
          </div>
          {field('poids', 'Poids (kg)')}
          {field('longueur', 'Longueur (m)')}
          {field('laize', 'Laize (cm)')}
        </div>
        {errorMsg && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={() => { setErrorMsg(null); saveMut.mutate() }} disabled={saveMut.isPending}>
            {saveMut.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Right: sidebar + status pill (§29) ─────────────────

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm text-right truncate">{value}</span>
    </div>
  )
}

/** The follow-up of an open sample: next relance date (editable in edit
 *  mode), how pressing it is, « Relancé » to record one and push the date,
 *  and the journal of relances done (kept after the sample is closed). */
function RelanceCard({ apiBase, detail, isEditing, draft, onDraftChange, onMutationSuccess }: {
  apiBase: string
  detail: EchantillonDetail
  isEditing: boolean
  draft: Draft | null
  onDraftChange: (d: Draft) => void
  onMutationSuccess: () => void
}) {
  const [open, setOpen] = useState(false)
  const r = detail.relance
  const ouvert = detail.statut === 'en_cours'
  const ton = r.urgence === 'retard' ? 'text-red-600' : r.urgence === 'bientot' ? 'text-amber-700' : 'text-foreground'
  return (
    <div className={cn(
      'p-3 rounded-lg border bg-card shadow-sm space-y-2',
      isEditing && 'border-l-4 border-l-accent/70 bg-accent/[0.03]',
      !isEditing && r.urgence === 'retard' && 'border-l-4 border-l-red-500',
      !isEditing && r.urgence === 'bientot' && 'border-l-4 border-l-amber-500',
    )}>
      <div className="flex items-center gap-2">
        <BellRing className="h-3.5 w-3.5 text-accent" />
        <p className="text-xs font-semibold text-muted-foreground flex-1">Relance</p>
        {ouvert && !isEditing && (
          <Button size="sm" variant="outline" className="h-7" onClick={() => setOpen(true)} title="Enregistrer la relance faite et reporter la suivante">
            <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />Relancé
          </Button>
        )}
      </div>
      {ouvert && (
        isEditing && draft ? (
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">Prochaine relance</span>
            <input
              type="date"
              value={draft.date_relance}
              onChange={(e) => onDraftChange({ ...draft, date_relance: e.target.value })}
              className="h-7 px-2 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        ) : (
          <div>
            <p className={cn('text-sm font-semibold', ton)}>
              {r.date ? formatHfsqlDate(r.date) : 'Aucune date'}
            </p>
            {r.date && <p className={cn('text-[11px]', r.urgence ? ton : 'text-muted-foreground')}>{raisonRelance(r)}</p>}
          </div>
        )
      )}
      {detail.relances.length > 0 && (
        <div className="pt-2 border-t border-border/60 space-y-1.5">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
            {detail.relances.length} relance{detail.relances.length !== 1 ? 's' : ''} faite{detail.relances.length !== 1 ? 's' : ''}
          </p>
          {detail.relances.map((h) => (
            <div key={h.id} className="text-xs">
              <p className="text-muted-foreground tabular-nums">
                {new Date(h.le).toLocaleDateString('fr-FR')} · {h.auteur}
              </p>
              {h.note.trim() && <p className="whitespace-pre-line">{h.note.trim()}</p>}
            </div>
          ))}
        </div>
      )}
      {open && <RelanceDialog apiBase={apiBase} detail={detail} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); onMutationSuccess() }} />}
    </div>
  )
}

/** « Relancé » : what was done (free note) and when to come back — today
 *  + 30 by default, the date the API would pick anyway. */
function RelanceDialog({ apiBase, detail, onClose, onSaved }: {
  apiBase: string
  detail: EchantillonDetail
  onClose: () => void
  onSaved: () => void
}) {
  const [note, setNote] = useState('')
  const [prochaine, setProchaine] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() + DELAI_RELANCE_JOURS)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const [error, setError] = useState<string | null>(null)
  const saveMut = useMutation({
    mutationFn: () => apiFetch(`${apiBase}/${detail.IDref_echantillon}/relances`, {
      method: 'POST',
      body: JSON.stringify({ note, prochaine_relance: prochaine || null }),
    }),
    onSuccess: onSaved,
    onError: (err) => setError(messageErreur(err, "L'enregistrement de la relance a échoué. Veuillez réessayer.")),
  })
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BellRing className="h-5 w-5 text-accent" />
            Relance — échantillon {detail.numero}
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Ce qui a été fait</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={3}
              autoFocus
              placeholder="Mail à Kenny, attend son retour sur la main…"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Prochaine relance</label>
            <input type="date" value={prochaine} onChange={(e) => setProchaine(e.target.value)} className={inputClass} />
          </div>
        </div>
        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={() => { setError(null); saveMut.mutate() }} disabled={saveMut.isPending}>
            {saveMut.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function DetailSidebar({ detail, apiBase, isEditing, draft, onDraftChange, onMutationSuccess, onArchiver, onRouvrir, onCreerReference, isChanging }: {
  detail: EchantillonDetail | null
  apiBase: string
  isEditing: boolean
  draft: Draft | null
  onDraftChange: (d: Draft) => void
  onMutationSuccess: () => void
  onArchiver: () => void
  onRouvrir: () => void
  onCreerReference: () => void
  isChanging: boolean
}) {
  if (!detail) {
    return (
      <div className="w-96 flex-shrink-0 bg-muted/30 rounded-xl border p-4 space-y-4">
        {[1, 2].map((i) => <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />)}
      </div>
    )
  }
  const dates = detail.pieces.map((p) => p.date).filter((d): d is string => !!d).sort()
  const poidsTotal = detail.pieces.reduce((s, p) => s + p.poids, 0)
  return (
    <div className="w-96 flex-shrink-0 flex flex-col gap-3 min-h-0">
      <div className="flex-1 min-h-0 rounded-xl border flex flex-col overflow-hidden bg-zinc-100/80">
        <div className="flex border-b p-1 gap-1 rounded-t-xl bg-zinc-200/50">
          <div className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md bg-accent text-accent-foreground shadow-sm">
            <FlaskConical className="h-3.5 w-3.5" />Informations
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-transparent">
          {(detail.statut === 'en_cours' || detail.relances.length > 0) && (
            <RelanceCard
              apiBase={apiBase}
              detail={detail}
              isEditing={isEditing}
              draft={draft}
              onDraftChange={onDraftChange}
              onMutationSuccess={onMutationSuccess}
            />
          )}
          {detail.reference && (
            <div className="p-3 rounded-lg border bg-card shadow-sm space-y-2">
              <p className="text-xs font-semibold text-muted-foreground">Référence créée</p>
              <Link
                to={`/tombe-metier/references?id=${detail.reference.IDref_ecru}`}
                className="flex items-center gap-2 rounded-md border border-success/30 bg-success/10 px-2.5 py-2 hover:bg-success/15 transition-colors"
              >
                <TmRollIcon className="h-4 w-4 text-success flex-shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-success">Référence {detail.reference.reference}</span>
                  {detail.reference.designation && <span className="block text-xs text-muted-foreground truncate">{detail.reference.designation}</span>}
                </span>
                <ArrowRight className="h-4 w-4 text-success flex-shrink-0" />
              </Link>
            </div>
          )}
          <div className="p-3 rounded-lg border bg-card shadow-sm space-y-2">
            <p className="text-xs font-semibold text-muted-foreground">Pièces d'essai</p>
            <KV label="Pièces tricotées" value={<span className="tabular-nums">{detail.pieces.length}</span>} />
            <KV label="Poids total" value={<span className="tabular-nums">{fmtNum(poidsTotal, 1)} kg</span>} />
            <KV label="Première pièce" value={dates.length > 0 ? formatHfsqlDate(dates[0]) : '—'} />
            <KV label="Dernière pièce" value={dates.length > 0 ? formatHfsqlDate(dates[dates.length - 1]) : '—'} />
          </div>
          <div className="p-3 rounded-lg border bg-card shadow-sm space-y-2">
            <p className="text-xs font-semibold text-muted-foreground">Métadonnées</p>
            <KV label="Numéro" value={<span className="tabular-nums">{detail.numero}</span>} />
            <KV label="Client" value={detail.client_nom ?? '—'} />
            <KV label="Fils (composition)" value={<span className="tabular-nums">{detail.composition.length}</span>} />
          </div>
        </div>
      </div>
      <StatutFooter
        statut={detail.statut}
        disabled={isEditing}
        isChanging={isChanging}
        onArchiver={onArchiver}
        onRouvrir={onRouvrir}
        onCreerReference={onCreerReference}
      />
    </div>
  )
}

/** §29 pill. En cours → menu (Créer la référence… / Archiver); Archivé →
 *  Rouvrir; Devenu référence → no action: one passage, the reference carries on. */
function StatutFooter({ statut, disabled, isChanging, onArchiver, onRouvrir, onCreerReference }: {
  statut: Statut
  disabled: boolean
  isChanging: boolean
  onArchiver: () => void
  onRouvrir: () => void
  onCreerReference: () => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [menuOpen])
  const meta = STATUT_META[statut]
  const Icon = meta.icon
  const actionClass =
    'px-3.5 bg-white/15 hover:bg-white/25 active:bg-white/30 disabled:bg-white/5 disabled:opacity-60 disabled:cursor-not-allowed text-white text-xs font-semibold border-l border-white/25 flex items-center gap-1.5 transition-colors'
  return (
    <div ref={rootRef} className="flex-shrink-0 relative">
      <div className={cn('rounded-xl border shadow-sm overflow-hidden flex items-stretch h-11', meta.solid)}>
        <div className="flex items-center gap-2 px-3 flex-1 text-white min-w-0">
          <Icon className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm font-bold uppercase tracking-wide truncate">{meta.label}</span>
        </div>
        {statut === 'en_cours' && (
          <button type="button" onClick={() => setMenuOpen((v) => !v)} disabled={disabled || isChanging} title="Changer le statut" className={actionClass}>
            {isChanging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronUp className={cn('h-3.5 w-3.5 transition-transform', menuOpen && 'rotate-180')} />}
            Changer
          </button>
        )}
        {statut === 'archive' && (
          <button type="button" onClick={onRouvrir} disabled={disabled || isChanging} title="Remettre l'échantillon en cours" className={actionClass}>
            {isChanging ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArchiveRestore className="h-3.5 w-3.5" />}
            Rouvrir
          </button>
        )}
        {statut === 'reference' && (
          <div className="px-3.5 text-white/70 border-l border-white/25 flex items-center" title="Un échantillon devenu référence ne se rouvre pas">
            <Lock className="h-3.5 w-3.5" />
          </div>
        )}
      </div>
      {menuOpen && (
        <div className="absolute bottom-full right-0 mb-1 w-full min-w-[220px] rounded-lg border bg-white shadow-lg overflow-hidden z-50">
          <button
            type="button"
            onClick={() => { setMenuOpen(false); onCreerReference() }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors hover:bg-zinc-100"
          >
            <TmRollIcon className="h-4 w-4 text-success" />
            Créer la référence…
          </button>
          <button
            type="button"
            onClick={() => { setMenuOpen(false); onArchiver() }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors hover:bg-zinc-100"
          >
            <Archive className="h-4 w-4 text-muted-foreground" />
            Archiver
          </button>
        </div>
      )}
    </div>
  )
}

// ── Créer la référence (§18.D bilan dialog) ────────────

function CreerReferenceDialog({ apiBase, detail, onClose, onCreated }: {
  apiBase: string
  detail: EchantillonDetail
  onClose: () => void
  onCreated: () => void
}) {
  const [reference, setReference] = useState('')
  const [designation, setDesignation] = useState('')
  const [error, setError] = useState<string | null>(null)
  const { data: proposee, isLoading } = useQuery<{ reference: string }>({
    queryKey: ['echantillon-reference-proposee', apiBase, detail.IDref_echantillon],
    queryFn: () => apiFetch(`${apiBase}/${detail.IDref_echantillon}/reference-proposee`),
    staleTime: 0,
  })
  // Fill the proposal once it arrives, without clobbering what was typed.
  useEffect(() => {
    if (proposee && reference === '') setReference(proposee.reference)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposee])

  const total = detail.composition.reduce((s, c) => s + c.pourcentage, 0)
  const compositionOk = detail.composition.length === 0 || Math.abs(total - 100) < 0.01
  const lfa = detail.lfa.some((v) => v > 0) ? detail.lfa.map((v) => (v > 0 ? v.toFixed(2) : '—')).join(' · ') : ''

  const createMut = useMutation({
    mutationFn: () => apiFetch(`${apiBase}/${detail.IDref_echantillon}/creer-reference`, {
      method: 'POST',
      body: JSON.stringify({ reference: reference.trim(), designation: designation.trim() }),
    }),
    onSuccess: onCreated,
    onError: (err) => setError(messageErreur(err, 'La création de la référence a échoué. Veuillez réessayer.')),
  })

  const repris: [string, string][] = [
    ['Contexture · Jauge · Ø', identite(detail) || '—'],
    ['Client', detail.client_nom ?? '—'],
    ['LFA / tour', lfa || '—'],
    ['Laize · poids TBM', mesuresTexte(detail.tbm) || '—'],
  ]

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-2xl p-0 border-0 bg-primary overflow-hidden max-h-[90dvh] flex flex-col">
        <div className="flex-shrink-0 flex items-center gap-2.5 border-b-2 border-gold bg-primary px-4 py-2.5 rounded-t-lg">
          <div className="h-8 w-8 flex-shrink-0 rounded-lg flex items-center justify-center shadow-sm bg-gold text-gold-foreground">
            <TmRollIcon className="h-[18px] w-[18px]" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-heading font-bold tracking-tight truncate text-primary-foreground">Créer la référence</h2>
            <p className="text-xs text-white/70 truncate">Depuis l'échantillon {detail.numero}</p>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8 text-white/80 hover:bg-white/15 hover:text-white" title="Fermer" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto bg-zinc-100 p-4 space-y-3 scrollbar-transparent">
          <div className="rounded-lg border-l-4 border-l-accent/70 border border-border/60 bg-card p-3 shadow-sm">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Référence</label>
                <div className="relative">
                  <input value={reference} onChange={(e) => setReference(e.target.value)} className={cn(inputClass, 'font-semibold tabular-nums')} autoFocus />
                  {isLoading && <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-accent" />}
                </div>
              </div>
              <div className="space-y-1 sm:col-span-2">
                <label className="text-xs font-medium text-muted-foreground">Désignation</label>
                <input value={designation} onChange={(e) => setDesignation(e.target.value)} className={inputClass} />
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-border/60 bg-card p-3 shadow-sm space-y-2">
            <h3 className="text-sm font-semibold">Repris de l'échantillon</h3>
            {repris.map(([label, value]) => <KV key={label} label={label} value={value} />)}
            <div className="pt-1">
              <p className="text-xs text-muted-foreground mb-1">Composition</p>
              {detail.composition.length === 0 ? (
                <p className="text-sm text-muted-foreground italic">Aucun fil — à saisir sur la référence</p>
              ) : (
                <ul className="space-y-0.5">
                  {detail.composition.map((c) => (
                    <li key={c.IDfil_ref_echantillon} className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="truncate">{c.ref_fil_reference ?? '—'}{c.colori_fil_reference ? <span className="text-muted-foreground"> · {c.colori_fil_reference}</span> : null}</span>
                      <span className="tabular-nums flex-shrink-0">{fmtNum(c.pourcentage, Number.isInteger(c.pourcentage) ? 0 : 2)} %</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {compositionOk ? (
            <div className="rounded-lg border-l-4 border-l-amber-400/60 border border-border/60 bg-card p-3 shadow-sm flex items-start gap-2.5">
              <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-amber-400/10">
                <Lock className="h-3.5 w-3.5 text-amber-600" />
              </div>
              <p className="text-xs text-muted-foreground">
                L'échantillon sera clos et lié à la nouvelle référence ; il ne pourra plus être rouvert.
                Le reste de la fiche (prix, laize, poids, réglages…) se complète sur Tombé Métier › Références.
              </p>
            </div>
          ) : (
            <div className="rounded-lg border-l-4 border-l-destructive/60 border border-border/60 bg-card p-3 shadow-sm flex items-start gap-2.5">
              <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-destructive/10">
                <AlertCircle className="h-3.5 w-3.5 text-destructive/70" />
              </div>
              <p className="text-xs text-destructive">
                La composition totalise {fmtNum(Math.round(total * 100) / 100, 2)} % : corrigez-la (100 %) avant de créer la référence.
              </p>
            </div>
          )}
        </div>

        <div className="flex-shrink-0 flex items-center gap-3 border-t border-border/60 bg-zinc-200 px-4 py-3 rounded-b-lg">
          {error && (
            <div className="flex items-center gap-2 text-sm text-destructive min-w-0">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              <span className="truncate" title={error}>{error}</span>
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">
            <Button variant="outline" onClick={onClose}>Annuler</Button>
            <Button onClick={() => { setError(null); createMut.mutate() }} disabled={!compositionOk || reference.trim() === '' || createMut.isPending}>
              {createMut.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <TmRollIcon className="h-3.5 w-3.5 mr-1.5" />}
              Créer la référence
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
