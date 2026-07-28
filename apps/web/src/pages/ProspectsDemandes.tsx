import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { UnsavedChangesDialog } from '@/components/shared/UnsavedChangesDialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import {
  UserPlus,
  UserCheck,
  Search,
  Loader2,
  AlertCircle,
  Plus,
  Pencil,
  Save,
  X,
  Trash2,
  MapPin,
  Info,
  StickyNote,
  Mail,
  Phone,
  Building2,
  Truck,
  Sparkles,
  Clock,
  CheckCircle2,
  ChevronUp,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { PopoverSelect } from '@/components/ui/popover-select'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'
import { cn } from '@/lib/utils'
import { formatHfsqlDate, hfsqlDateToInput, inputDateToHfsql } from '@/lib/dates'
import { apiFetch } from '@/lib/api'

// ── Types ──────────────────────────────────────────────

type ProspectStatus = 1 | 2 | 3
type StatusFilter = 'all' | 'nouveau' | 'en_attente' | 'terminee'

interface Demande {
  IDprospect: number
  prenom: string
  nom: string
  email: string
  societe: string
  adresse: string
  code_postal: string
  ville: string
  pays: string
  telephone: string
  status_catalogue: ProspectStatus
  date: string
  observation: string
  notes_interne: string
  expe_catalogue: string
  tracking_number: string
  IDtransporteur: number
  traite: number
  IDclient: number
}

interface DemandeDetail extends Demande {
  transporteur_nom: string | null
  client_nom: string | null
}

interface TransporteurLite {
  IDtransporteur: number
  nom: string
}

// ── Shared styling ─────────────────────────────────────

const inputClass = 'w-full h-8 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring'
const editSectionClass = 'border-l-4 border-l-accent/70 bg-accent/[0.03]'

// ── Status metadata ────────────────────────────────────

const STATUS_META: Record<ProspectStatus, {
  label: string
  icon: typeof Clock
  /** Solid bg + matching border for the footer pill and list-card pill. */
  solidBg: string
}> = {
  1: { label: 'Nouveau', icon: Sparkles, solidBg: 'bg-primary border-primary' },
  2: { label: 'En attente', icon: Clock, solidBg: 'bg-amber-500 border-amber-500' },
  3: { label: 'Terminée', icon: CheckCircle2, solidBg: 'bg-success border-success' },
}

const STATUS_ORDER: ProspectStatus[] = [1, 2, 3]

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'nouveau', label: 'Nouveau' },
  { key: 'en_attente', label: 'En attente' },
  { key: 'terminee', label: 'Terminées' },
  { key: 'all', label: 'Toutes' },
]

// ── Helpers ────────────────────────────────────────────

/** Display name for a demande: full name, else company, else fallback. */
function demandeName(d: { prenom: string; nom: string; societe: string; IDprospect: number }): string {
  const full = `${d.prenom} ${d.nom}`.trim()
  if (full) return full
  if (d.societe.trim()) return d.societe.trim()
  return `Demande #${d.IDprospect}`
}

function fmtDate(raw: string): string {
  return /^\d{8}$/.test(raw) ? formatHfsqlDate(raw) : '—'
}

// ── Main Page ──────────────────────────────────────────

export function ProspectsDemandes() {
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('nouveau')
  const [isEditing, setIsEditing] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [convertOpen, setConvertOpen] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [autoEditForId, setAutoEditForId] = useState<number | null>(null)

  // Edit-mode draft state.
  const [editPrenom, setEditPrenom] = useState('')
  const [editNom, setEditNom] = useState('')
  const [editEmail, setEditEmail] = useState('')
  const [editSociete, setEditSociete] = useState('')
  const [editTelephone, setEditTelephone] = useState('')
  const [editAdresse, setEditAdresse] = useState('')
  const [editCodePostal, setEditCodePostal] = useState('')
  const [editVille, setEditVille] = useState('')
  const [editPays, setEditPays] = useState('')
  const [editObservation, setEditObservation] = useState('')
  const [editNotesInterne, setEditNotesInterne] = useState('')
  const [editDate, setEditDate] = useState('')
  const [editExpeCatalogue, setEditExpeCatalogue] = useState('')
  const [editTrackingNumber, setEditTrackingNumber] = useState('')
  const [editIDTransporteur, setEditIDTransporteur] = useState(0)
  const [editTraite, setEditTraite] = useState(0)

  const originalDraftRef = useRef<Record<string, string | number> | null>(null)

  const { data: demandes, isLoading, isError, error } = useQuery<Demande[]>({
    queryKey: ['prospects', statusFilter],
    queryFn: () => apiFetch(`/prospects?status=${statusFilter}`),
  })

  const { data: detail, isLoading: detailLoading } = useQuery<DemandeDetail>({
    queryKey: ['prospect', selectedId],
    queryFn: () => apiFetch(`/prospects/${selectedId}`),
    enabled: selectedId !== null,
  })

  const { data: transporteurs } = useQuery<TransporteurLite[]>({
    queryKey: ['prospect-transporteurs'],
    queryFn: () => apiFetch('/prospects/lookups/transporteurs'),
    staleTime: 5 * 60 * 1000,
  })

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['prospects'] })
    queryClient.invalidateQueries({ queryKey: ['prospect', selectedId] })
  }, [queryClient, selectedId])

  const startEdit = useCallback(() => {
    if (!detail) return
    const snapshot = {
      prenom: detail.prenom,
      nom: detail.nom,
      email: detail.email,
      societe: detail.societe,
      telephone: detail.telephone,
      adresse: detail.adresse,
      codePostal: detail.code_postal,
      ville: detail.ville,
      pays: detail.pays,
      observation: detail.observation,
      notesInterne: detail.notes_interne,
      date: hfsqlDateToInput(detail.date),
      expeCatalogue: hfsqlDateToInput(detail.expe_catalogue),
      trackingNumber: detail.tracking_number,
      IDtransporteur: detail.IDtransporteur,
      traite: detail.traite,
    }
    setEditPrenom(snapshot.prenom)
    setEditNom(snapshot.nom)
    setEditEmail(snapshot.email)
    setEditSociete(snapshot.societe)
    setEditTelephone(snapshot.telephone)
    setEditAdresse(snapshot.adresse)
    setEditCodePostal(snapshot.codePostal)
    setEditVille(snapshot.ville)
    setEditPays(snapshot.pays)
    setEditObservation(snapshot.observation)
    setEditNotesInterne(snapshot.notesInterne)
    setEditDate(snapshot.date)
    setEditExpeCatalogue(snapshot.expeCatalogue)
    setEditTrackingNumber(snapshot.trackingNumber)
    setEditIDTransporteur(snapshot.IDtransporteur)
    setEditTraite(snapshot.traite)
    originalDraftRef.current = snapshot
    setIsEditing(true)
  }, [detail])

  const cancelEdit = useCallback(() => setIsEditing(false), [])

  const isDirty = useMemo(() => {
    if (!isEditing) return false
    const o = originalDraftRef.current
    if (!o) return false
    return (
      editPrenom !== o.prenom ||
      editNom !== o.nom ||
      editEmail !== o.email ||
      editSociete !== o.societe ||
      editTelephone !== o.telephone ||
      editAdresse !== o.adresse ||
      editCodePostal !== o.codePostal ||
      editVille !== o.ville ||
      editPays !== o.pays ||
      editObservation !== o.observation ||
      editNotesInterne !== o.notesInterne ||
      editDate !== o.date ||
      editExpeCatalogue !== o.expeCatalogue ||
      editTrackingNumber !== o.trackingNumber ||
      editIDTransporteur !== o.IDtransporteur ||
      editTraite !== o.traite
    )
  }, [
    isEditing, editPrenom, editNom, editEmail, editSociete, editTelephone,
    editAdresse, editCodePostal, editVille, editPays, editObservation,
    editNotesInterne, editDate, editExpeCatalogue, editTrackingNumber,
    editIDTransporteur, editTraite,
  ])

  const saveMut = useMutation({
    mutationFn: () => apiFetch(`/prospects/${selectedId}`, {
      method: 'PUT',
      body: JSON.stringify({
        prenom: editPrenom,
        nom: editNom,
        email: editEmail,
        societe: editSociete,
        telephone: editTelephone,
        adresse: editAdresse,
        code_postal: editCodePostal,
        ville: editVille,
        pays: editPays,
        observation: editObservation,
        notes_interne: editNotesInterne,
        date: inputDateToHfsql(editDate),
        expe_catalogue: inputDateToHfsql(editExpeCatalogue),
        tracking_number: editTrackingNumber,
        IDtransporteur: editIDTransporteur || 0,
        traite: editTraite ? 1 : 0,
      }),
    }),
    onSuccess: () => { invalidateAll(); setIsEditing(false) },
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/prospects/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, deletedId) => {
      const cached = queryClient.getQueryData<Demande[]>(['prospects', statusFilter]) ?? []
      const remaining = cached.filter((d) => d.IDprospect !== deletedId)
      queryClient.invalidateQueries({ queryKey: ['prospects'] })
      setIsEditing(false)
      setDeleteConfirmOpen(false)
      setSelectedId(remaining.length > 0 ? remaining[0].IDprospect : null)
    },
  })

  const statusMut = useMutation({
    mutationFn: (next: ProspectStatus) => apiFetch(`/prospects/${selectedId}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status_catalogue: next }),
    }),
    onSuccess: invalidateAll,
  })

  const convertMut = useMutation({
    mutationFn: () => apiFetch(`/prospects/${selectedId}/convert`, { method: 'POST' }),
    onSuccess: () => { invalidateAll(); setConvertOpen(false) },
  })

  // Auto-enter edit mode after a new demande is created.
  useEffect(() => {
    if (autoEditForId !== null && detail?.IDprospect === autoEditForId) {
      startEdit()
      setAutoEditForId(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEditForId, detail])

  const guard = useUnsavedGuard({
    isDirty,
    save: async () => { await saveMut.mutateAsync() },
    onDiscard: () => setIsEditing(false),
  })

  const handleSelect = useCallback((id: number) => {
    guard.guardAction(() => {
      setIsEditing(false)
      setSelectedId(id)
    })
  }, [guard])

  const handleStatusFilterChange = useCallback((s: StatusFilter) => {
    guard.guardAction(() => {
      setIsEditing(false)
      setStatusFilter(s)
      setSelectedId(null)
    })
  }, [guard])

  const filtered = useMemo(() => {
    if (!demandes) return []
    if (!searchQuery.trim()) return demandes
    const q = searchQuery.toLowerCase()
    return demandes.filter((d) =>
      `${d.prenom} ${d.nom} ${d.societe} ${d.email} ${d.ville}`.toLowerCase().includes(q)
    )
  }, [demandes, searchQuery])

  // Keep the selection valid against the (possibly search-filtered) list: when
  // the selected row isn't among the current results, select the one at the top.
  // Covers both the initial load and search narrowing the list. Skip while
  // editing so we never discard unsaved changes out from under the user.
  useAutoSelectFirst({
    rows: filtered,
    selectedId,
    getId: (d) => d.IDprospect,
    select: setSelectedId,
    suspended: isEditing,
  })

  return (
    <>
      <MasterDetailLayout
        list={
          <DemandeList
            rows={filtered}
            isLoading={isLoading}
            isError={isError}
            error={error as Error | null}
            selectedId={selectedId}
            onSelect={handleSelect}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            statusFilter={statusFilter}
            onStatusFilterChange={handleStatusFilterChange}
            onNew={() => setCreateOpen(true)}
            isEditing={isEditing}
          />
        }
        detailHeader={
          <DetailHeader
            demande={detail ?? null}
            isLoading={detailLoading && selectedId !== null}
            isEditing={isEditing}
            onStartEdit={startEdit}
            onCancelEdit={cancelEdit}
            onSave={() => saveMut.mutate()}
            isSaving={saveMut.isPending}
            onDelete={() => setDeleteConfirmOpen(true)}
            onConvert={() => setConvertOpen(true)}
          />
        }
        detail={
          <DetailMain
            demande={detail ?? null}
            isLoading={detailLoading && selectedId !== null}
            hasSelection={selectedId !== null}
            isEditing={isEditing}
            editPrenom={editPrenom} onEditPrenom={setEditPrenom}
            editNom={editNom} onEditNom={setEditNom}
            editEmail={editEmail} onEditEmail={setEditEmail}
            editSociete={editSociete} onEditSociete={setEditSociete}
            editTelephone={editTelephone} onEditTelephone={setEditTelephone}
            editObservation={editObservation} onEditObservation={setEditObservation}
          />
        }
        sidebar={selectedId !== null ? (
          <DetailSidebar
            demande={detail ?? null}
            isLoading={detailLoading}
            isEditing={isEditing}
            transporteurs={transporteurs ?? []}
            editDate={editDate} onEditDate={setEditDate}
            editExpeCatalogue={editExpeCatalogue} onEditExpeCatalogue={setEditExpeCatalogue}
            editTrackingNumber={editTrackingNumber} onEditTrackingNumber={setEditTrackingNumber}
            editIDTransporteur={editIDTransporteur} onEditIDTransporteur={setEditIDTransporteur}
            editTraite={editTraite} onEditTraite={setEditTraite}
            editNotesInterne={editNotesInterne} onEditNotesInterne={setEditNotesInterne}
            editAdresse={editAdresse} onEditAdresse={setEditAdresse}
            editCodePostal={editCodePostal} onEditCodePostal={setEditCodePostal}
            editVille={editVille} onEditVille={setEditVille}
            editPays={editPays} onEditPays={setEditPays}
            onChangeStatut={(s) => statusMut.mutate(s)}
            isChangingStatut={statusMut.isPending}
          />
        ) : null}
        sidebarTitle="Informations"
        hasSelection={selectedId !== null}
        onBack={() => guard.guardAction(() => { setIsEditing(false); setSelectedId(null) })}
      />

      <UnsavedChangesDialog
        open={guard.showDialog}
        onAction={guard.handleAction}
        isSaving={guard.isSaving}
      />

      <CreateDemandeDialog
        open={createOpen}
        transporteurs={transporteurs ?? []}
        onClose={() => setCreateOpen(false)}
        onCreated={(newId) => {
          setCreateOpen(false)
          queryClient.invalidateQueries({ queryKey: ['prospects'] })
          setSelectedId(newId)
          setAutoEditForId(newId)
        }}
      />

      <ConvertClientDialog
        open={convertOpen}
        demande={detail ?? null}
        isPending={convertMut.isPending}
        error={convertMut.error as Error | null}
        onCancel={() => { convertMut.reset(); setConvertOpen(false) }}
        onConfirm={() => convertMut.mutate()}
      />

      <ConfirmDialog
        open={deleteConfirmOpen}
        title="Supprimer la demande"
        description="Cette action supprimera définitivement cette demande de catalogue. Elle est irréversible."
        confirmLabel="Supprimer"
        isPending={deleteMut.isPending}
        onCancel={() => setDeleteConfirmOpen(false)}
        onConfirm={() => { if (selectedId !== null) deleteMut.mutate(selectedId) }}
      />
    </>
  )
}

// ── Left Panel: List ───────────────────────────────────

function DemandeStatusPill({ status, className }: { status: ProspectStatus; className?: string }) {
  const meta = STATUS_META[status]
  const Icon = meta.icon
  return (
    <Badge variant="outline" className={cn('text-[10px] py-0 gap-1 border text-white', meta.solidBg, className)}>
      <Icon className="h-2.5 w-2.5" />{meta.label}
    </Badge>
  )
}

function DemandeList({
  rows, isLoading, isError, error,
  selectedId, onSelect,
  searchQuery, onSearchChange,
  statusFilter, onStatusFilterChange,
  onNew, isEditing,
}: {
  rows: Demande[]
  isLoading: boolean
  isError: boolean
  error: Error | null
  selectedId: number | null
  onSelect: (id: number) => void
  searchQuery: string
  onSearchChange: (q: string) => void
  statusFilter: StatusFilter
  onStatusFilterChange: (s: StatusFilter) => void
  onNew: () => void
  isEditing: boolean
}) {
  return (
    <div className="flex flex-col h-full rounded-lg border shadow-sm bg-zinc-100/80">
      <div className="p-3 border-b rounded-t-lg bg-zinc-200/50 space-y-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Rechercher (nom, société, ville...)"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            autoComplete="off"
            className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex gap-1">
          {STATUS_FILTERS.map((opt) => (
            <button
              key={opt.key}
              onClick={() => onStatusFilterChange(opt.key)}
              className={cn(
                'flex-1 px-2 py-1 text-xs rounded-md transition-colors',
                statusFilter === opt.key
                  ? 'bg-accent text-accent-foreground shadow-sm font-medium'
                  : 'text-muted-foreground hover:bg-accent/10'
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
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <UserPlus className="h-12 w-12 mb-3 opacity-50" />
            <p className="text-sm">Aucune demande</p>
          </div>
        ) : rows.map((row) => {
          const isSelected = selectedId === row.IDprospect
          return (
            <div
              key={row.IDprospect}
              onClick={() => onSelect(row.IDprospect)}
              className={cn(
                'p-3 border rounded-lg cursor-pointer transition-all bg-white',
                isSelected ? 'border-accent ring-1 ring-accent' : 'border-border hover:border-accent/50'
              )}
            >
              <div className="flex items-center gap-2">
                <UserPlus className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="font-medium text-sm truncate">{demandeName(row)}</span>
                <DemandeStatusPill status={row.status_catalogue} className="ml-auto flex-shrink-0" />
              </div>
              <p className="text-xs text-muted-foreground mt-1 truncate">
                {[row.societe, row.ville].filter(Boolean).join(' · ') || '—'}
              </p>
              <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground">
                <span>{fmtDate(row.date)}</span>
                {!!row.IDclient && (
                  <span className="ml-auto inline-flex items-center gap-1 text-green-600">
                    <UserCheck className="h-3 w-3" />Client
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="p-3 border-t text-xs text-muted-foreground flex items-center justify-between rounded-b-lg bg-zinc-200/50">
        <span>{rows.length} demande{rows.length !== 1 ? 's' : ''}</span>
        {!isEditing && (
          <Button size="sm" variant="ghost" onClick={onNew} className="text-accent hover:text-accent hover:bg-accent/10">
            <Plus className="h-3.5 w-3.5 mr-1" />Nouvelle
          </Button>
        )}
      </div>
    </div>
  )
}

// ── Center: Detail Header ──────────────────────────────

function DetailHeader({
  demande, isLoading, isEditing,
  onStartEdit, onCancelEdit, onSave, isSaving,
  onDelete, onConvert,
}: {
  demande: DemandeDetail | null
  isLoading: boolean
  isEditing: boolean
  onStartEdit: () => void
  onCancelEdit: () => void
  onSave: () => void
  isSaving: boolean
  onDelete: () => void
  onConvert: () => void
}) {
  if (!demande && !isLoading) return null
  const isConverted = !!demande?.IDclient

  return (
    <div className="flex-shrink-0 pt-0.5">
      <div className="flex items-center gap-3">
        <div className={cn('h-11 w-11 rounded-lg flex items-center justify-center', isEditing ? 'bg-accent/15' : 'icon-box-gold')}>
          <UserPlus className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          {isLoading ? (
            <div className="h-8 w-48 bg-muted animate-pulse rounded" />
          ) : (
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-heading font-bold tracking-tight truncate">
                {demande ? demandeName(demande) : ''}
              </h1>
              <div className="flex items-center gap-2 flex-shrink-0">
                {demande && /^\d{8}$/.test(demande.date) && (
                  <Badge variant="secondary" className="text-xs">{formatHfsqlDate(demande.date)}</Badge>
                )}
                {isConverted && (
                  <Badge variant="success" className="text-xs gap-1">
                    <UserCheck className="h-3 w-3" />Client
                  </Badge>
                )}
                {isEditing && (
                  <Badge className="bg-accent text-accent-foreground gap-1 shadow-sm">
                    <Pencil className="h-3 w-3" />Mode edition
                  </Badge>
                )}
              </div>
            </div>
          )}
        </div>
        {!isLoading && demande && (
          <div className="flex items-center gap-2 flex-shrink-0">
            {isEditing ? (
              <>
                <Button variant="outline" size="icon" className="h-9 w-9 text-destructive hover:text-destructive" title="Supprimer" onClick={onDelete}>
                  <Trash2 className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="sm" onClick={onCancelEdit}>
                  <X className="h-3.5 w-3.5 mr-1.5" />Annuler
                </Button>
                <Button size="sm" onClick={onSave} disabled={isSaving}>
                  <Save className="h-3.5 w-3.5 mr-1.5" />
                  {isSaving ? 'Enregistrement...' : 'Enregistrer'}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9"
                  title={isConverted ? 'Déjà converti en client' : 'Convertir en client'}
                  disabled={isConverted}
                  onClick={onConvert}
                >
                  <UserCheck className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="icon" className="h-9 w-9 text-destructive hover:text-destructive" title="Supprimer" onClick={onDelete}>
                  <Trash2 className="h-4 w-4" />
                </Button>
                <Button variant="gold" size="sm" onClick={onStartEdit}>
                  <Pencil className="h-3.5 w-3.5 mr-1.5" />Modifier
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

function LabeledInput({
  label, value, onChange, type = 'text', placeholder, className,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  placeholder?: string
  className?: string
}) {
  return (
    <div className={cn('space-y-1', className)}>
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        className={inputClass}
      />
    </div>
  )
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="text-xs text-muted-foreground flex-shrink-0">{label}</span>
      <span className="text-sm text-right break-words min-w-0">{value || '—'}</span>
    </div>
  )
}

function SectionCard({
  title, icon: Icon, isEditing, children,
}: {
  title: string
  icon: typeof Info
  isEditing: boolean
  children: React.ReactNode
}) {
  return (
    <div className={cn('rounded-xl border bg-card shadow-sm p-4', isEditing && editSectionClass)}>
      <div className="flex items-center gap-2 mb-3">
        <Icon className="h-4 w-4 text-accent" />
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      {children}
    </div>
  )
}

function DetailMain({
  demande, isLoading, hasSelection, isEditing,
  editPrenom, onEditPrenom,
  editNom, onEditNom,
  editEmail, onEditEmail,
  editSociete, onEditSociete,
  editTelephone, onEditTelephone,
  editObservation, onEditObservation,
}: {
  demande: DemandeDetail | null
  isLoading: boolean
  hasSelection: boolean
  isEditing: boolean
  editPrenom: string; onEditPrenom: (v: string) => void
  editNom: string; onEditNom: (v: string) => void
  editEmail: string; onEditEmail: (v: string) => void
  editSociete: string; onEditSociete: (v: string) => void
  editTelephone: string; onEditTelephone: (v: string) => void
  editObservation: string; onEditObservation: (v: string) => void
}) {
  if (!hasSelection) return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="icon-box-gold h-16 w-16 mx-auto"><UserPlus className="h-8 w-8" /></div>
        <p className="text-muted-foreground text-sm">Sélectionnez une demande dans la liste</p>
      </div>
    </div>
  )
  if (isLoading) return <div className="flex-1 flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-accent" /></div>
  if (!demande) return null

  return (
    <div className="flex-1 min-h-0 overflow-auto space-y-4 scrollbar-transparent pr-1">
      <SectionCard title="Coordonnées" icon={Info} isEditing={isEditing}>
        {isEditing ? (
          <div className="grid grid-cols-2 gap-2">
            <LabeledInput label="Prénom" value={editPrenom} onChange={onEditPrenom} />
            <LabeledInput label="Nom" value={editNom} onChange={onEditNom} />
            <LabeledInput label="Société" value={editSociete} onChange={onEditSociete} className="col-span-2" />
            <LabeledInput label="Email" value={editEmail} onChange={onEditEmail} type="email" />
            <LabeledInput label="Téléphone" value={editTelephone} onChange={onEditTelephone} />
          </div>
        ) : (
          <div className="space-y-0.5">
            <KV label="Prénom" value={demande.prenom} />
            <KV label="Nom" value={demande.nom} />
            <KV label="Société" value={demande.societe} />
            <KV
              label="Email"
              value={demande.email ? (
                <span className="inline-flex items-center gap-1.5"><Mail className="h-3 w-3 text-muted-foreground" />{demande.email}</span>
              ) : ''}
            />
            <KV
              label="Téléphone"
              value={demande.telephone ? (
                <span className="inline-flex items-center gap-1.5"><Phone className="h-3 w-3 text-muted-foreground" />{demande.telephone}</span>
              ) : ''}
            />
          </div>
        )}
      </SectionCard>

      <SectionCard title="Observation" icon={StickyNote} isEditing={isEditing}>
        {isEditing ? (
          <textarea
            value={editObservation}
            onChange={(e) => onEditObservation(e.target.value)}
            rows={4}
            placeholder="Observation sur la demande..."
            className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
          />
        ) : demande.observation.trim() ? (
          <p className="text-sm text-muted-foreground whitespace-pre-line">{demande.observation}</p>
        ) : (
          <p className="text-sm text-muted-foreground italic">Aucune observation</p>
        )}
      </SectionCard>
    </div>
  )
}

// ── Right: Sidebar ─────────────────────────────────────

type SidebarTab = 'infos' | 'adresse'

function DetailSidebar({
  demande, isLoading, isEditing, transporteurs,
  editDate, onEditDate,
  editExpeCatalogue, onEditExpeCatalogue,
  editTrackingNumber, onEditTrackingNumber,
  editIDTransporteur, onEditIDTransporteur,
  editTraite, onEditTraite,
  editNotesInterne, onEditNotesInterne,
  editAdresse, onEditAdresse,
  editCodePostal, onEditCodePostal,
  editVille, onEditVille,
  editPays, onEditPays,
  onChangeStatut, isChangingStatut,
}: {
  demande: DemandeDetail | null
  isLoading: boolean
  isEditing: boolean
  transporteurs: TransporteurLite[]
  editDate: string; onEditDate: (v: string) => void
  editExpeCatalogue: string; onEditExpeCatalogue: (v: string) => void
  editTrackingNumber: string; onEditTrackingNumber: (v: string) => void
  editIDTransporteur: number; onEditIDTransporteur: (v: number) => void
  editTraite: number; onEditTraite: (v: number) => void
  editNotesInterne: string; onEditNotesInterne: (v: string) => void
  editAdresse: string; onEditAdresse: (v: string) => void
  editCodePostal: string; onEditCodePostal: (v: string) => void
  editVille: string; onEditVille: (v: string) => void
  editPays: string; onEditPays: (v: string) => void
  onChangeStatut: (s: ProspectStatus) => void
  isChangingStatut: boolean
}) {
  const [activeTab, setActiveTab] = useState<SidebarTab>('infos')

  if (isLoading || !demande) {
    return (
      <div className="w-96 flex-shrink-0 flex items-center justify-center rounded-xl border bg-zinc-100/80">
        <Loader2 className="h-6 w-6 animate-spin text-accent" />
      </div>
    )
  }

  const transporteurOptions = transporteurs.map((t) => ({ id: t.IDtransporteur, primary: t.nom }))
  const tabs: { key: SidebarTab; label: string; icon: typeof Info }[] = [
    { key: 'infos', label: 'Infos', icon: Truck },
    { key: 'adresse', label: 'Adresse', icon: MapPin },
  ]

  return (
    <div className="w-96 flex-shrink-0 flex flex-col gap-3 min-h-0">
      <div className="flex-1 min-h-0 rounded-xl border flex flex-col overflow-hidden bg-zinc-100/80">
        <div className="flex border-b p-1 gap-1 rounded-t-xl bg-zinc-200/50">
          {tabs.map((tab) => {
            const Icon = tab.icon
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={cn(
                  'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md transition-colors',
                  activeTab === tab.key
                    ? 'bg-accent text-accent-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-accent/10',
                )}
              >
                <Icon className="h-3.5 w-3.5" />{tab.label}
              </button>
            )
          })}
        </div>
        <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-transparent">
          {activeTab === 'infos' && (
            <>
              <div className={cn('rounded-lg border bg-card shadow-sm p-3', isEditing && editSectionClass)}>
                {isEditing ? (
                  <div className="space-y-3">
                    <LabeledInput label="Date de la demande" type="date" value={editDate} onChange={onEditDate} />
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Transporteur</label>
                      <PopoverSelect
                        options={transporteurOptions}
                        value={editIDTransporteur}
                        onChange={onEditIDTransporteur}
                        emptyLabel="— aucun —"
                      />
                    </div>
                    <LabeledInput label="Date d'expédition du catalogue" type="date" value={editExpeCatalogue} onChange={onEditExpeCatalogue} />
                    <LabeledInput label="N° de suivi" value={editTrackingNumber} onChange={onEditTrackingNumber} />
                    <label className="flex items-center gap-2 text-sm cursor-pointer select-none pt-1">
                      <input
                        type="checkbox"
                        checked={!!editTraite}
                        onChange={(e) => onEditTraite(e.target.checked ? 1 : 0)}
                        className="h-4 w-4 rounded border-input text-accent focus:ring-2 focus:ring-ring cursor-pointer"
                      />
                      <span>Demande traitée</span>
                    </label>
                  </div>
                ) : (
                  <div className="space-y-0.5">
                    <KV label="Date de la demande" value={fmtDate(demande.date)} />
                    <KV label="Transporteur" value={demande.transporteur_nom} />
                    <KV label="Expédition catalogue" value={fmtDate(demande.expe_catalogue)} />
                    <KV label="N° de suivi" value={demande.tracking_number} />
                    <KV
                      label="Traitée"
                      value={
                        <Badge variant={demande.traite ? 'success' : 'secondary'} className="text-[10px] py-0">
                          {demande.traite ? 'Oui' : 'Non'}
                        </Badge>
                      }
                    />
                    <KV
                      label="Client"
                      value={demande.IDclient ? (
                        <span className="inline-flex items-center gap-1.5 text-green-600">
                          <UserCheck className="h-3 w-3" />{demande.client_nom || `#${demande.IDclient}`}
                        </span>
                      ) : ''}
                    />
                  </div>
                )}
              </div>
              <div className={cn('rounded-lg border bg-card shadow-sm p-3', isEditing && editSectionClass)}>
                <div className="flex items-center gap-2 mb-2">
                  <StickyNote className="h-3.5 w-3.5 text-accent" />
                  <h3 className="text-xs font-semibold">Journal</h3>
                </div>
                {isEditing ? (
                  <textarea
                    value={editNotesInterne}
                    onChange={(e) => onEditNotesInterne(e.target.value)}
                    rows={6}
                    placeholder="Journal interne (non visible par le prospect)..."
                    className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
                  />
                ) : demande.notes_interne.trim() ? (
                  <p className="text-sm text-muted-foreground whitespace-pre-line">{demande.notes_interne}</p>
                ) : (
                  <p className="text-sm text-muted-foreground italic">Aucune entrée</p>
                )}
              </div>
            </>
          )}
          {activeTab === 'adresse' && (
            <div className={cn('rounded-lg border bg-card shadow-sm p-3', isEditing && editSectionClass)}>
              {isEditing ? (
                <div className="grid grid-cols-3 gap-2">
                  <LabeledInput label="Adresse" value={editAdresse} onChange={onEditAdresse} className="col-span-3" />
                  <LabeledInput label="Code postal" value={editCodePostal} onChange={onEditCodePostal} />
                  <LabeledInput label="Ville" value={editVille} onChange={onEditVille} className="col-span-2" />
                  <LabeledInput label="Pays" value={editPays} onChange={onEditPays} className="col-span-3" />
                </div>
              ) : (
                <div className="space-y-0.5">
                  <KV label="Adresse" value={demande.adresse} />
                  <KV label="Code postal" value={demande.code_postal} />
                  <KV label="Ville" value={demande.ville} />
                  <KV label="Pays" value={demande.pays} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <ProspectStatutFooter
        current={demande.status_catalogue}
        onChange={onChangeStatut}
        isChanging={isChangingStatut}
        disabled={isEditing}
      />
    </div>
  )
}

// ── Sidebar status footer (§29.4 multi-state) ──────────

function ProspectStatutFooter({
  current, onChange, isChanging, disabled,
}: {
  current: ProspectStatus
  onChange: (next: ProspectStatus) => void
  isChanging: boolean
  disabled: boolean
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const meta = STATUS_META[current]
  const Icon = meta.icon

  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setMenuOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuOpen])

  useEffect(() => {
    if (disabled) setMenuOpen(false)
  }, [disabled])

  return (
    <div ref={rootRef} className="flex-shrink-0 relative">
      <div className={cn('rounded-xl border shadow-sm overflow-hidden flex items-stretch h-11', meta.solidBg)}>
        <div className="flex items-center gap-2 px-3 flex-1 text-white min-w-0">
          <Icon className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm font-bold uppercase tracking-wide truncate">{meta.label}</span>
        </div>
        <button
          type="button"
          onClick={() => setMenuOpen((v) => !v)}
          disabled={disabled || isChanging}
          title="Changer le statut"
          className="px-3.5 bg-white/15 hover:bg-white/25 active:bg-white/30 disabled:bg-white/5 disabled:opacity-60 disabled:cursor-not-allowed text-white text-xs font-semibold border-l border-white/25 flex items-center gap-1.5 transition-colors"
        >
          {isChanging ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ChevronUp className={cn('h-3.5 w-3.5 transition-transform', menuOpen && 'rotate-180')} />
          )}
          Changer
        </button>
      </div>
      {menuOpen && (
        <div className="absolute bottom-full right-0 mb-1 w-full min-w-[220px] rounded-lg border bg-white shadow-lg overflow-hidden z-50">
          {STATUS_ORDER.map((s) => {
            const m = STATUS_META[s]
            const active = current === s
            const SIcon = m.icon
            return (
              <button
                key={s}
                type="button"
                onClick={() => {
                  if (!active) onChange(s)
                  setMenuOpen(false)
                }}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors',
                  active ? 'bg-accent/10 text-accent cursor-default' : 'hover:bg-zinc-100',
                )}
              >
                <SIcon className="h-4 w-4" />
                {m.label}
                {active && <CheckCircle2 className="h-4 w-4 ml-auto text-accent" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Create dialog ──────────────────────────────────────

function CreateDemandeDialog({
  open, transporteurs, onClose, onCreated,
}: {
  open: boolean
  transporteurs: TransporteurLite[]
  onClose: () => void
  onCreated: (newId: number) => void
}) {
  const [prenom, setPrenom] = useState('')
  const [nom, setNom] = useState('')
  const [email, setEmail] = useState('')
  const [telephone, setTelephone] = useState('')
  const [societe, setSociete] = useState('')
  const [adresse, setAdresse] = useState('')
  const [codePostal, setCodePostal] = useState('')
  const [ville, setVille] = useState('')
  const [pays, setPays] = useState('')
  const [observation, setObservation] = useState('')
  const [IDtransporteur, setIDtransporteur] = useState(0)
  const [date, setDate] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      const now = new Date()
      const y = now.getFullYear()
      const m = String(now.getMonth() + 1).padStart(2, '0')
      const d = String(now.getDate()).padStart(2, '0')
      setPrenom(''); setNom(''); setEmail(''); setTelephone(''); setSociete('')
      setAdresse(''); setCodePostal(''); setVille(''); setPays('')
      setObservation(''); setIDtransporteur(0)
      setDate(`${y}-${m}-${d}`)
      setError(null)
    }
  }, [open])

  const canSubmit = nom.trim().length > 0 || societe.trim().length > 0 || email.trim().length > 0

  const mut = useMutation({
    mutationFn: () => apiFetch<DemandeDetail>('/prospects', {
      method: 'POST',
      body: JSON.stringify({
        prenom: prenom.trim(),
        nom: nom.trim(),
        email: email.trim(),
        telephone: telephone.trim(),
        societe: societe.trim(),
        adresse: adresse.trim(),
        code_postal: codePostal.trim(),
        ville: ville.trim(),
        pays: pays.trim(),
        observation: observation.trim(),
        IDtransporteur: IDtransporteur || 0,
        date: inputDateToHfsql(date),
      }),
    }),
    onSuccess: (data) => {
      setError(null)
      onCreated(data.IDprospect)
    },
    onError: (err: Error) => setError(err.message),
  })

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent className="max-w-xl" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-5 w-5 text-accent" />
            Nouvelle demande
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 mt-4">
          <div className="grid grid-cols-2 gap-2">
            <LabeledInput label="Prénom" value={prenom} onChange={setPrenom} />
            <LabeledInput label="Nom" value={nom} onChange={setNom} />
          </div>
          <LabeledInput label="Société" value={societe} onChange={setSociete} />
          <div className="grid grid-cols-2 gap-2">
            <LabeledInput label="Email" value={email} onChange={setEmail} type="email" />
            <LabeledInput label="Téléphone" value={telephone} onChange={setTelephone} />
          </div>
          <LabeledInput label="Adresse" value={adresse} onChange={setAdresse} />
          <div className="grid grid-cols-3 gap-2">
            <LabeledInput label="Code postal" value={codePostal} onChange={setCodePostal} />
            <LabeledInput label="Ville" value={ville} onChange={setVille} className="col-span-2" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <LabeledInput label="Pays" value={pays} onChange={setPays} />
            <LabeledInput label="Date de la demande" type="date" value={date} onChange={setDate} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Transporteur</label>
            <PopoverSelect
              options={transporteurs.map((t) => ({ id: t.IDtransporteur, primary: t.nom }))}
              value={IDtransporteur}
              onChange={setIDtransporteur}
              emptyLabel="— aucun —"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Observation</label>
            <textarea
              value={observation}
              onChange={(e) => setObservation(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
            />
          </div>
        </div>
        {error && <p className="text-sm text-destructive mt-3">{error}</p>}
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={() => mut.mutate()} disabled={!canSubmit || mut.isPending}>
            {mut.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Plus className="h-4 w-4 mr-1.5" />}
            Créer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Convert-to-client dialog ───────────────────────────

function ConvertClientDialog({
  open, demande, isPending, error, onCancel, onConfirm,
}: {
  open: boolean
  demande: DemandeDetail | null
  isPending: boolean
  error: Error | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const clientNom = demande
    ? (demande.societe.trim() || `${demande.prenom} ${demande.nom}`.trim() || `Prospect #${demande.IDprospect}`)
    : ''

  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onCancel() : undefined)}>
      <DialogContent className="max-w-md" onClose={onCancel}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCheck className="h-5 w-5 text-accent" />
            Convertir en client
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Un nouveau client va être créé à partir de cette demande. La demande sera marquée comme terminée.
          </p>
          <div className="rounded-lg border bg-zinc-50 p-3">
            <p className="text-xs text-muted-foreground">Nom du client</p>
            <p className="text-sm font-semibold mt-0.5">{clientNom || '—'}</p>
          </div>
          {error && <p className="text-sm text-destructive">{error.message}</p>}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onCancel}>Annuler</Button>
          <Button onClick={onConfirm} disabled={isPending}>
            {isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <UserCheck className="h-4 w-4 mr-1.5" />}
            Convertir
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
