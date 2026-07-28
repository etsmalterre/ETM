// Qualité › Dossiers — non-conformity dossiers (legacy FI_Dossier_QualitéV2).
//
// Classeur layout (mps_designer §39): the 3-panel Fiche shell with a master-tab
// row in the center panel, because the two datasets a quality manager consults
// are large and read one at a time:
//   • Dossier      — the non-conformity itself (client, défaut, description,
//                    affectation to an écru piece or a yarn lot)
//   • Traçabilité  — what the affected piece was made of and who made it:
//                    Fil (yarns + purchase orders) / Tricotage / Ennoblissement
// Right sidebar tabs: Journal / Documents / FNC (fiche de non-conformité — the
// message sent to the sister company and its answer). Status footer pill is the
// binary terminé flag (§29.3).
//
// Left-list urgency (§41): a dossier only goes red/amber when it actually has an
// échéance — legacy leaves it null on almost every row, so the §30 "missing date
// = late" rule would paint the whole list red. Registered meaning:
//   red   = échéance atteinte ou dépassée
//   amber = échéance dans les 3 jours

import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  FileWarning,
  Search,
  Loader2,
  AlertCircle,
  Pencil,
  X,
  Save,
  Plus,
  Trash2,
  Printer,
  AtSign,
  Mail,
  Clock,
  CheckCircle2,
  ClipboardList,
  Send,
  FileText,
  Building2,
  User,
  Tag,
  Calendar,
  Link2,
  Layers,
  Factory,
  Droplets,
  Package,
  History,
  ChevronDown,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { PopoverSelect, SearchableCombobox } from '@/components/ui/popover-select'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'
import { UnsavedChangesDialog } from '@/components/shared/UnsavedChangesDialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import { apiFetch, API_URL } from '@/lib/api'
import { useHasPermission } from '@/contexts/PermissionsContext'
import { fmtNum } from '@/lib/format'
import { formatHfsqlDate, hfsqlDateToInput, inputDateToHfsql } from '@/lib/dates'
import { cn } from '@/lib/utils'

// ── Types ────────────────────────────────────────────────

interface ListRow {
  IDdossier_qualite: number
  client_nom: string
  defaut_label: string
  date: string | null
  echeance: string | null
  termine: 0 | 1
  reference: string
  type_reference: string
  fnc_envoye: string | null
  has_reponse: 0 | 1
}

interface DossierDetail {
  IDdossier_qualite: number
  action: string
  description: string
  date: string | null
  echeance: string | null
  IDclient: number
  IDdefaut_textile: number
  termine: 0 | 1
  type_reference: string
  reference: string
  journal: string
  IDsociete_fnc: number
  message_fnc: string
  envoi_fnc: string | null
  client_nom: string
  defaut_nom: string
  defaut_categorie: string
  fnc_resolution: string
  fnc_commentaire: string
}

interface Lookups {
  clients: { IDclient: number; nom: string }[]
  defauts: { IDdefaut_textile: number; nom: string; categorie: string }[]
  resolutions: { IDresolution_qualite: number; libelle: string }[]
  societes_fnc: { value: number; label: string }[]
}

interface TracaDoc {
  IDged: number
  nom: string
  type_nom: string | null
}

interface TracaFil {
  IDstock_fil: number
  ref_fil: string
  coloris: string
  lot: string
  pourcentage: number | null
  fournisseur_nom: string
  IDcommande_fil: number | null
  commande_date: string | null
  documents: TracaDoc[]
}

interface TracaSst {
  IDcommande_sous_traitant: number
  sous_traitant_nom: string
  date_commande: string | null
  quantite: number
  prix: number
  lots: string[]
  documents: TracaDoc[]
}

interface Tracabilite {
  kind: 'piece' | 'lot_fil' | 'none'
  titre: string | null
  sous_titre: string | null
  piece: {
    IDstock_ecru: number
    numero: string
    lot: string
    poids: number
    metrage: number
    IDordre_fabrication: number
  } | null
  fils: TracaFil[]
  tricotage: TracaSst | null
  ennoblissement: TracaSst | null
}

interface DocQualite {
  IDdoc_qualite: number
  nom: string
  has_file: 0 | 1
}

type StatusFilter = 'en_cours' | 'termine' | 'tous'
type MainTab = 'dossier' | 'tracabilite'
type SidebarTab = 'journal' | 'documents' | 'fnc'
type TracaTab = 'fil' | 'tricotage' | 'ennoblissement'

const FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'en_cours', label: 'En cours' },
  { key: 'termine', label: 'Terminé' },
  { key: 'tous', label: 'Tous' },
]

const MAIN_TABS: { key: MainTab; label: string; icon: typeof ClipboardList }[] = [
  { key: 'dossier', label: 'Dossier', icon: ClipboardList },
  { key: 'tracabilite', label: 'Traçabilité', icon: Link2 },
]

const SIDEBAR_TABS: { key: SidebarTab; label: string; icon: typeof History }[] = [
  { key: 'journal', label: 'Journal', icon: History },
  { key: 'documents', label: 'Documents', icon: FileText },
  { key: 'fnc', label: 'FNC', icon: Send },
]

// Affectation — Type_Reference is a string discriminator on the free-text
// `reference` column. PopoverSelect is id-keyed, so map through small ids.
const AFFECTATION_OPTIONS = [
  { id: 1, type: '-1', primary: 'Aucune' },
  { id: 2, type: '1', primary: 'Numéro de pièce', secondary: 'rouleau écru' },
  { id: 3, type: '2', primary: 'Lot de fil', secondary: 'stock fil' },
]
function affectationIdOf(type: string): number {
  return AFFECTATION_OPTIONS.find((o) => o.type === type)?.id ?? 1
}
function affectationTypeOf(id: number): string {
  return AFFECTATION_OPTIONS.find((o) => o.id === id)?.type ?? '-1'
}

const editSectionClass = 'border-l-4 border-l-accent/70 bg-accent/[0.03]'
const inputClass =
  'w-full h-8 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring'
const textareaClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y'

/** Urgency from the dossier échéance. Unlike §30, a *missing* échéance is NOT
 *  urgent here — legacy leaves it null on nearly every row. */
function echeanceUrgency(echeance: string | null, termine: 0 | 1): 'late' | 'soon' | null {
  if (termine === 1) return null
  if (!echeance || !/^\d{8}$/.test(echeance)) return null
  const target = new Date(
    Number(echeance.slice(0, 4)),
    Number(echeance.slice(4, 6)) - 1,
    Number(echeance.slice(6, 8)),
  )
  target.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86_400_000)
  if (diffDays <= 0) return 'late'
  if (diffDays <= 3) return 'soon'
  return null
}

// ── Edit state ───────────────────────────────────────────

interface EditState {
  description: string
  journal: string
  date: string
  echeance: string
  IDclient: number
  IDdefaut_textile: number
  type_reference: string
  reference: string
  message_fnc: string
  fnc_resolution: string
  fnc_commentaire: string
  IDsociete_fnc: number
  envoi_fnc: string
}

function snapshotEdit(d: DossierDetail): EditState {
  return {
    description: d.description,
    journal: d.journal,
    date: hfsqlDateToInput(d.date),
    echeance: hfsqlDateToInput(d.echeance),
    IDclient: d.IDclient,
    IDdefaut_textile: d.IDdefaut_textile,
    type_reference: d.type_reference || '-1',
    reference: d.reference,
    message_fnc: d.message_fnc,
    fnc_resolution: d.fnc_resolution,
    fnc_commentaire: d.fnc_commentaire,
    IDsociete_fnc: d.IDsociete_fnc || 1,
    envoi_fnc: hfsqlDateToInput(d.envoi_fnc),
  }
}

// ── Page ─────────────────────────────────────────────────

export function QualiteDossiers() {
  const queryClient = useQueryClient()
  const canManage = useHasPermission('responsable_qualite')

  // "Tous" is the everyday view here, not "En cours": dossiers are closed as
  // soon as the FNC round-trip completes, so the open bucket is empty most of
  // the time and defaulting to it would open the screen on a blank list.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('tous')
  const [searchQuery, setSearchQuery] = useState('')
  const [urgencyFilter, setUrgencyFilter] = useState<'late' | 'soon' | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [edit, setEdit] = useState<EditState | null>(null)
  const originalRef = useRef<EditState | null>(null)
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('journal')
  const [createOpen, setCreateOpen] = useState(false)
  const [autoEditForId, setAutoEditForId] = useState<number | null>(null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [emailOpen, setEmailOpen] = useState(false)

  // ── Queries ────────────────────────────────────────────
  const { data: lookups } = useQuery({
    queryKey: ['dossiers-qualite-lookups'],
    queryFn: () => apiFetch<Lookups>('/dossiers-qualite/lookups'),
    staleTime: 5 * 60_000,
  })

  const { data: rows, isLoading, isError } = useQuery({
    queryKey: ['dossiers-qualite', statusFilter],
    queryFn: () => apiFetch<ListRow[]>(`/dossiers-qualite?status=${statusFilter}`),
  })

  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: ['dossier-qualite', selectedId],
    queryFn: () => apiFetch<DossierDetail>(`/dossiers-qualite/${selectedId}`),
    enabled: selectedId !== null,
  })

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['dossiers-qualite'] })
    queryClient.invalidateQueries({ queryKey: ['dossier-qualite', selectedId] })
    queryClient.invalidateQueries({ queryKey: ['dossier-qualite-traca', selectedId] })
  }, [queryClient, selectedId])

  // ── Edit lifecycle ─────────────────────────────────────
  const startEdit = useCallback(() => {
    if (!detail) return
    const snap = snapshotEdit(detail)
    setEdit(snap)
    originalRef.current = snap
    setIsEditing(true)
  }, [detail])

  const cancelEdit = useCallback(() => {
    setIsEditing(false)
    setEdit(null)
    originalRef.current = null
  }, [])

  const isDirty = useMemo(() => {
    if (!isEditing || !edit || !originalRef.current) return false
    return JSON.stringify(edit) !== JSON.stringify(originalRef.current)
  }, [isEditing, edit])

  const setField = useCallback(<K extends keyof EditState>(key: K, value: EditState[K]) => {
    setEdit((prev) => (prev ? { ...prev, [key]: value } : prev))
  }, [])

  // ── Mutations ──────────────────────────────────────────
  const saveMut = useMutation({
    mutationFn: () => {
      if (!edit) throw new Error('no edit state')
      return apiFetch(`/dossiers-qualite/${selectedId}`, {
        method: 'PUT',
        body: JSON.stringify({
          description: edit.description,
          journal: edit.journal,
          date: inputDateToHfsql(edit.date),
          echeance: edit.echeance ? inputDateToHfsql(edit.echeance) : null,
          IDclient: edit.IDclient,
          IDdefaut_textile: edit.IDdefaut_textile,
          type_reference: edit.type_reference,
          reference: edit.reference,
          message_fnc: edit.message_fnc,
          fnc_resolution: edit.fnc_resolution,
          fnc_commentaire: edit.fnc_commentaire,
          IDsociete_fnc: edit.IDsociete_fnc,
          envoi_fnc: edit.envoi_fnc ? inputDateToHfsql(edit.envoi_fnc) : null,
        }),
      })
    },
    onSuccess: () => {
      invalidateAll()
      cancelEdit()
    },
  })

  const termineMut = useMutation({
    mutationFn: (termine: 0 | 1) =>
      apiFetch(`/dossiers-qualite/${selectedId}/termine`, {
        method: 'PUT',
        body: JSON.stringify({ termine }),
      }),
    onSuccess: () => invalidateAll(),
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/dossiers-qualite/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, deletedId) => {
      const cached = queryClient.getQueryData<ListRow[]>(['dossiers-qualite', statusFilter]) ?? []
      const remaining = cached.filter((r) => r.IDdossier_qualite !== deletedId)
      queryClient.invalidateQueries({ queryKey: ['dossiers-qualite'] })
      setDeleteOpen(false)
      setSelectedId(remaining.length > 0 ? remaining[0].IDdossier_qualite : null)
    },
  })

  // ── Guard ──────────────────────────────────────────────
  const guard = useUnsavedGuard({
    isDirty,
    save: async () => {
      await saveMut.mutateAsync()
    },
    onDiscard: cancelEdit,
  })

  const handleSelect = useCallback(
    (id: number) => {
      guard.guardAction(() => {
        cancelEdit()
        setSelectedId(id)
      })
    },
    [guard, cancelEdit],
  )

  const handleBack = useCallback(() => {
    guard.guardAction(() => {
      cancelEdit()
      setSelectedId(null)
    })
  }, [guard, cancelEdit])

  const handleStatusFilter = useCallback(
    (f: StatusFilter) => {
      guard.guardAction(() => {
        cancelEdit()
        setStatusFilter(f)
        setSelectedId(null)
      })
    },
    [guard, cancelEdit],
  )

  // ── Filtering + auto-select ────────────────────────────
  const urgencyCounts = useMemo(() => {
    let late = 0
    let soon = 0
    for (const r of rows ?? []) {
      const u = echeanceUrgency(r.echeance, r.termine)
      if (u === 'late') late++
      else if (u === 'soon') soon++
    }
    return { late, soon }
  }, [rows])

  // The pill hides at count 0 — drop an armed filter whose bucket emptied so
  // the list can't get stuck showing nothing (mps_designer §41.4).
  const activeUrgency =
    urgencyFilter && urgencyCounts[urgencyFilter] > 0 ? urgencyFilter : null

  const filtered = useMemo(() => {
    let list = rows ?? []
    if (activeUrgency) {
      list = list.filter((r) => echeanceUrgency(r.echeance, r.termine) === activeUrgency)
    }
    const q = searchQuery.trim().toLowerCase()
    if (!q) return list
    return list.filter((r) =>
      [String(r.IDdossier_qualite), r.client_nom, r.defaut_label, r.reference]
        .join(' ')
        .toLowerCase()
        .includes(q),
    )
  }, [rows, searchQuery, activeUrgency])

  useAutoSelectFirst({
    rows: filtered,
    selectedId,
    getId: (r) => r.IDdossier_qualite,
    select: setSelectedId,
    suspended: isEditing,
  })

  // Freshly-created dossiers open straight in edit mode (§25.1).
  useEffect(() => {
    if (autoEditForId !== null && detail?.IDdossier_qualite === autoEditForId) {
      startEdit()
      setAutoEditForId(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEditForId, detail])

  // ── Render ─────────────────────────────────────────────
  return (
    <>
      <MasterDetailLayout
        hasSelection={selectedId !== null}
        onBack={handleBack}
        sidebarTitle="Suivi"
        list={
          <DossierList
            rows={filtered}
            totalCount={rows?.length ?? 0}
            isLoading={isLoading}
            isError={isError}
            selectedId={selectedId}
            onSelect={handleSelect}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            statusFilter={statusFilter}
            onStatusFilterChange={handleStatusFilter}
            urgencyCounts={urgencyCounts}
            activeUrgency={activeUrgency}
            onUrgencyToggle={(u) => setUrgencyFilter((prev) => (prev === u ? null : u))}
            isEditing={isEditing}
            canManage={canManage}
            onCreate={() => setCreateOpen(true)}
          />
        }
        detailHeader={
          detail ? (
            <DossierHeader
              detail={detail}
              isEditing={isEditing}
              saving={saveMut.isPending}
              canManage={canManage}
              onStartEdit={startEdit}
              onCancelEdit={cancelEdit}
              onSave={() => saveMut.mutate()}
              onPrint={() =>
                window.open(`${API_URL}/dossiers-qualite/${detail.IDdossier_qualite}/fnc/pdf`, '_blank')
              }
              onEmail={() => setEmailOpen(true)}
              onDelete={() => setDeleteOpen(true)}
            />
          ) : detailLoading ? (
            <div className="flex items-center justify-center h-24">
              <Loader2 className="h-6 w-6 animate-spin text-accent" />
            </div>
          ) : null
        }
        detail={
          detail ? (
            <DetailMain
              detail={detail}
              lookups={lookups}
              isEditing={isEditing}
              edit={edit}
              onField={setField}
            />
          ) : selectedId === null && !isLoading ? (
            <EmptyDetailState />
          ) : null
        }
        sidebar={
          detail ? (
            <DossierSidebar
              detail={detail}
              lookups={lookups}
              isEditing={isEditing}
              edit={edit}
              onField={setField}
              activeTab={sidebarTab}
              onTabChange={setSidebarTab}
              canManage={canManage}
              onToggleTermine={() => termineMut.mutate(detail.termine === 1 ? 0 : 1)}
              isToggling={termineMut.isPending}
            />
          ) : null
        }
      />

      <UnsavedChangesDialog open={guard.showDialog} onAction={guard.handleAction} isSaving={guard.isSaving} />

      <CreateDossierDialog
        open={createOpen}
        lookups={lookups}
        onClose={() => setCreateOpen(false)}
        onCreated={(newId) => {
          setCreateOpen(false)
          queryClient.invalidateQueries({ queryKey: ['dossiers-qualite'] })
          setSelectedId(newId)
          setAutoEditForId(newId)
        }}
      />

      <ConfirmDialog
        open={deleteOpen}
        title="Supprimer le dossier"
        description={
          detail
            ? `Le dossier N° ${detail.IDdossier_qualite} (${detail.client_nom || 'sans client'}) sera supprimé définitivement.`
            : undefined
        }
        isPending={deleteMut.isPending}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={() => {
          if (selectedId !== null) {
            setIsEditing(false)
            deleteMut.mutate(selectedId)
          }
        }}
      />

      <Dialog open={emailOpen} onOpenChange={setEmailOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AtSign className="h-5 w-5 text-accent" />
              Envoyer la FNC
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Mail className="h-12 w-12 mb-3 opacity-40" />
            <p className="text-sm font-medium">En developpement</p>
            <p className="text-xs mt-1">Cette fonctionnalite sera disponible prochainement.</p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

// ── Left list ────────────────────────────────────────────

function DossierList({
  rows,
  totalCount,
  isLoading,
  isError,
  selectedId,
  onSelect,
  searchQuery,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  urgencyCounts,
  activeUrgency,
  onUrgencyToggle,
  isEditing,
  canManage,
  onCreate,
}: {
  rows: ListRow[]
  totalCount: number
  isLoading: boolean
  isError: boolean
  selectedId: number | null
  onSelect: (id: number) => void
  searchQuery: string
  onSearchChange: (v: string) => void
  statusFilter: StatusFilter
  onStatusFilterChange: (f: StatusFilter) => void
  urgencyCounts: { late: number; soon: number }
  activeUrgency: 'late' | 'soon' | null
  onUrgencyToggle: (u: 'late' | 'soon') => void
  isEditing: boolean
  canManage: boolean
  onCreate: () => void
}) {
  return (
    <div className="flex flex-col h-full rounded-lg border shadow-sm bg-zinc-100/80">
      <div className="p-3 border-b rounded-t-lg bg-zinc-200/50 space-y-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder="Rechercher un dossier…"
              className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          {urgencyCounts.late > 0 && (
            <UrgencyPill
              count={urgencyCounts.late}
              tone="late"
              active={activeUrgency === 'late'}
              onToggle={() => onUrgencyToggle('late')}
            />
          )}
          {urgencyCounts.soon > 0 && (
            <UrgencyPill
              count={urgencyCounts.soon}
              tone="soon"
              active={activeUrgency === 'soon'}
              onToggle={() => onUrgencyToggle('soon')}
            />
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          {FILTERS.map((opt) => (
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

      <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-transparent">
        {isLoading ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="h-6 w-6 animate-spin text-accent" />
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center justify-center h-32 text-destructive">
            <AlertCircle className="h-6 w-6 mb-2" />
            <p className="text-sm">Erreur de chargement</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
            <FileWarning className="h-12 w-12 opacity-50 mb-2" />
            <p className="text-sm">Aucun dossier</p>
          </div>
        ) : (
          rows.map((r) => {
            const isSelected = selectedId === r.IDdossier_qualite
            const urgency = echeanceUrgency(r.echeance, r.termine)
            const selectedRingClass =
              urgency === 'late'
                ? 'border-red-500 ring-1 ring-red-500'
                : urgency === 'soon'
                  ? 'border-amber-500 ring-1 ring-amber-500'
                  : 'border-accent ring-1 ring-accent'
            return (
              <div
                key={r.IDdossier_qualite}
                onClick={() => onSelect(r.IDdossier_qualite)}
                className={cn(
                  'p-3 border rounded-lg cursor-pointer transition-all bg-white',
                  isSelected ? selectedRingClass : 'border-border hover:border-accent/50',
                  urgency === 'late' && 'shadow-[inset_4px_0_0_0_rgb(239_68_68)]',
                  urgency === 'soon' && 'shadow-[inset_4px_0_0_0_rgb(245_158_11)]',
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs font-semibold tabular-nums text-muted-foreground flex-shrink-0">
                    N° {r.IDdossier_qualite}
                  </span>
                  <span className="font-medium text-sm truncate">{r.client_nom || '—'}</span>
                  {r.termine === 1 && (
                    <CheckCircle2 className="h-3.5 w-3.5 text-green-600 ml-auto flex-shrink-0" />
                  )}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <p className="text-xs text-muted-foreground truncate">{r.defaut_label || '—'}</p>
                  <span className="text-[11px] text-muted-foreground ml-auto flex-shrink-0 tabular-nums">
                    {r.date ? formatHfsqlDate(r.date) : ''}
                  </span>
                </div>
                {!!r.reference && (
                  <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-muted-foreground">
                    <Package className="h-3 w-3 opacity-60" />
                    <span className="truncate">{r.reference}</span>
                    {/* Only meaningful while the dossier is still open — every
                        closed dossier has an answer, so the badge would be
                        noise on the whole list. */}
                    {r.has_reponse === 1 && r.termine === 0 && (
                      <Badge variant="secondary" className="text-[10px] py-0 ml-auto">
                        Répondue
                      </Badge>
                    )}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      <div className="p-3 border-t text-xs text-muted-foreground flex items-center justify-between rounded-b-lg bg-zinc-200/50">
        <span>
          {totalCount} dossier{totalCount > 1 ? 's' : ''}
        </span>
        {!isEditing && canManage && (
          <Button
            size="sm"
            variant="ghost"
            className="text-accent hover:text-accent hover:bg-accent/10"
            onClick={onCreate}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            Nouveau
          </Button>
        )}
      </div>
    </div>
  )
}

function UrgencyPill({
  count,
  tone,
  active,
  onToggle,
}: {
  count: number
  tone: 'late' | 'soon'
  active: boolean
  onToggle: () => void
}) {
  const title = tone === 'late' ? 'Échéance dépassée' : 'Échéance dans 3 jours'
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      title={title}
      className={cn(
        'h-7 min-w-[1.75rem] px-1.5 inline-flex items-center justify-center rounded-md text-xs font-semibold tabular-nums border transition-colors flex-shrink-0',
        tone === 'late'
          ? active
            ? 'bg-red-500 text-white border-red-500 shadow-sm'
            : 'bg-red-500/10 text-red-800 border-red-500/30 hover:bg-red-500/20'
          : active
            ? 'bg-amber-500 text-white border-amber-500 shadow-sm'
            : 'bg-amber-500/10 text-amber-800 border-amber-500/30 hover:bg-amber-500/20',
      )}
    >
      {count}
    </button>
  )
}

// ── Detail header ────────────────────────────────────────

function DossierHeader({
  detail,
  isEditing,
  saving,
  canManage,
  onStartEdit,
  onCancelEdit,
  onSave,
  onPrint,
  onEmail,
  onDelete,
}: {
  detail: DossierDetail
  isEditing: boolean
  saving: boolean
  canManage: boolean
  onStartEdit: () => void
  onCancelEdit: () => void
  onSave: () => void
  onPrint: () => void
  onEmail: () => void
  onDelete: () => void
}) {
  return (
    <div className="flex-shrink-0 pt-0.5">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            'h-11 w-11 rounded-lg flex items-center justify-center flex-shrink-0',
            isEditing ? 'bg-accent/15' : 'icon-box-gold',
          )}
        >
          <FileWarning className="h-5 w-5" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-heading font-bold tracking-tight truncate">
              N° {detail.IDdossier_qualite}
              {detail.client_nom ? ` · ${detail.client_nom}` : ''}
            </h1>
            {isEditing && (
              <Badge className="bg-accent text-accent-foreground flex-shrink-0 gap-1 shadow-sm">
                <Pencil className="h-3 w-3" />
                Mode edition
              </Badge>
            )}
          </div>
          <div className="flex gap-1.5 mt-1 flex-wrap">
            {!!detail.defaut_nom && (
              <Badge variant="secondary" className="text-xs">
                {detail.defaut_nom}
                {detail.defaut_categorie ? ` · ${detail.defaut_categorie}` : ''}
              </Badge>
            )}
            {!!detail.envoi_fnc && (
              <Badge variant="outline" className="text-xs gap-1">
                <Send className="h-2.5 w-2.5" />
                FNC envoyée le {formatHfsqlDate(detail.envoi_fnc)}
              </Badge>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {isEditing ? (
            <>
              <Button variant="outline" size="sm" onClick={onCancelEdit} disabled={saving}>
                <X className="h-3.5 w-3.5 mr-1.5" />
                Annuler
              </Button>
              <Button size="sm" onClick={onSave} disabled={saving}>
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5 mr-1.5" />
                )}
                Enregistrer
              </Button>
            </>
          ) : (
            <>
              {canManage && (
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9 text-destructive hover:text-destructive"
                  title="Supprimer"
                  onClick={onDelete}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
              <Button variant="outline" size="icon" className="h-9 w-9" title="Imprimer la FNC" onClick={onPrint}>
                <Printer className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="icon" className="h-9 w-9" title="Envoyer un email" onClick={onEmail}>
                <AtSign className="h-4 w-4" />
              </Button>
              {canManage && (
                <Button variant="gold" size="sm" onClick={onStartEdit}>
                  <Pencil className="h-3.5 w-3.5 mr-1.5" />
                  Modifier
                </Button>
              )}
            </>
          )}
        </div>
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

function EmptyDetailState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground">
      <div className="icon-box-gold h-16 w-16 rounded-xl flex items-center justify-center mb-3">
        <FileWarning className="h-7 w-7" />
      </div>
      <p className="text-sm">Sélectionnez un dossier pour voir son détail</p>
    </div>
  )
}

// ── Center panel — master tabs (Classeur, §39) ───────────

function DetailMain({
  detail,
  lookups,
  isEditing,
  edit,
  onField,
}: {
  detail: DossierDetail
  lookups: Lookups | undefined
  isEditing: boolean
  edit: EditState | null
  onField: <K extends keyof EditState>(key: K, value: EditState[K]) => void
}) {
  const [activeTab, setActiveTab] = useState<MainTab>('dossier')

  // Land on the dossier tab whenever the selection changes.
  useEffect(() => {
    setActiveTab('dossier')
  }, [detail.IDdossier_qualite])

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-shrink-0 flex items-center gap-1 border-b border-border/60 pb-2">
        {MAIN_TABS.map((t) => {
          const Icon = t.icon
          const active = activeTab === t.key
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveTab(t.key)}
              className={cn(
                'flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap',
                active
                  ? 'bg-accent text-accent-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-accent/10 hover:text-accent',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          )
        })}
      </div>

      <div className="flex-1 min-h-0 overflow-auto space-y-4 pt-3 px-1 pb-1 scrollbar-transparent">
        {activeTab === 'dossier' && (
          <DossierTab detail={detail} lookups={lookups} isEditing={isEditing} edit={edit} onField={onField} />
        )}
        {activeTab === 'tracabilite' && <TracabiliteTab dossierId={detail.IDdossier_qualite} />}
      </div>
    </div>
  )
}

// ── Dossier tab ──────────────────────────────────────────

function SectionCard({
  icon: Icon,
  title,
  highlight,
  children,
}: {
  icon: typeof Tag
  title: string
  highlight?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border/50 bg-card shadow-md p-4',
        highlight && editSectionClass,
      )}
    >
      <div className="flex items-center gap-2 mb-3">
        <Icon className="h-4 w-4 text-accent" />
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      {children}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1 min-w-0">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  )
}

function ReadValue({ value }: { value: string }) {
  return <p className="text-sm h-8 flex items-center truncate">{value || '—'}</p>
}

function DossierTab({
  detail,
  lookups,
  isEditing,
  edit,
  onField,
}: {
  detail: DossierDetail
  lookups: Lookups | undefined
  isEditing: boolean
  edit: EditState | null
  onField: <K extends keyof EditState>(key: K, value: EditState[K]) => void
}) {
  const defautOptions = useMemo(
    () =>
      (lookups?.defauts ?? []).map((d) => ({
        id: d.IDdefaut_textile,
        primary: d.nom,
        secondary: d.categorie || undefined,
      })),
    [lookups],
  )

  const affectationType = isEditing && edit ? edit.type_reference : detail.type_reference || '-1'
  const affectationLabel =
    AFFECTATION_OPTIONS.find((o) => o.type === affectationType)?.primary ?? 'Aucune'

  return (
    <>
      <SectionCard icon={AlertCircle} title="Non-conformité" highlight={isEditing}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Client">
            {isEditing && edit ? (
              <SearchableCombobox
                options={lookups?.clients ?? []}
                value={edit.IDclient}
                onChange={(id) => onField('IDclient', id)}
                getId={(c) => c.IDclient}
                getPrimary={(c) => c.nom}
                placeholder="Rechercher un client"
              />
            ) : (
              <ReadValue value={detail.client_nom} />
            )}
          </Field>
          <Field label="Défaut">
            {isEditing && edit ? (
              <PopoverSelect
                options={defautOptions}
                value={edit.IDdefaut_textile}
                onChange={(id) => onField('IDdefaut_textile', id)}
                emptyLabel="— aucun —"
              />
            ) : (
              <ReadValue
                value={
                  detail.defaut_nom
                    ? `${detail.defaut_nom}${detail.defaut_categorie ? ` · ${detail.defaut_categorie}` : ''}`
                    : ''
                }
              />
            )}
          </Field>
          <Field label="Date">
            {isEditing && edit ? (
              <input
                type="date"
                value={edit.date}
                onChange={(e) => onField('date', e.target.value)}
                className={inputClass}
              />
            ) : (
              <ReadValue value={detail.date ? formatHfsqlDate(detail.date) : ''} />
            )}
          </Field>
          <Field label="Échéance">
            {isEditing && edit ? (
              <input
                type="date"
                value={edit.echeance}
                onChange={(e) => onField('echeance', e.target.value)}
                className={inputClass}
              />
            ) : (
              <ReadValue value={detail.echeance ? formatHfsqlDate(detail.echeance) : ''} />
            )}
          </Field>
        </div>

        <div className="space-y-1 mt-3">
          <label className="text-xs font-medium text-muted-foreground">Description</label>
          {isEditing && edit ? (
            <textarea
              rows={6}
              value={edit.description}
              onChange={(e) => onField('description', e.target.value)}
              className={textareaClass}
            />
          ) : detail.description ? (
            <p className="text-sm text-muted-foreground whitespace-pre-line">{detail.description}</p>
          ) : (
            <p className="text-sm text-muted-foreground italic">Aucune description</p>
          )}
        </div>
      </SectionCard>

      <SectionCard icon={Link2} title="Affectation" highlight={isEditing}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            {isEditing && edit ? (
              <PopoverSelect
                options={AFFECTATION_OPTIONS}
                value={affectationIdOf(edit.type_reference)}
                onChange={(id) => onField('type_reference', affectationTypeOf(id))}
                hideEmpty
              />
            ) : (
              <ReadValue value={affectationLabel} />
            )}
          </Field>
          <Field label="Référence">
            {isEditing && edit ? (
              <input
                type="text"
                value={edit.reference}
                onChange={(e) => onField('reference', e.target.value)}
                placeholder={edit.type_reference === '2' ? 'Lot de fil…' : 'N° de pièce…'}
                disabled={edit.type_reference === '-1'}
                className={cn(inputClass, edit.type_reference === '-1' && 'opacity-50')}
              />
            ) : (
              <ReadValue value={detail.reference} />
            )}
          </Field>
        </div>
        <p className="text-[11px] text-muted-foreground mt-2.5">
          La référence relie le dossier à une pièce écru ou à un lot de fil. Sa traçabilité complète
          est dans l'onglet Traçabilité.
        </p>
      </SectionCard>
    </>
  )
}

// ── Traçabilité tab ──────────────────────────────────────

const TRACA_TABS: { key: TracaTab; label: string; icon: typeof Layers }[] = [
  { key: 'fil', label: 'Fil', icon: Layers },
  { key: 'tricotage', label: 'Tricotage', icon: Factory },
  { key: 'ennoblissement', label: 'Ennoblissement', icon: Droplets },
]

function TracabiliteTab({ dossierId }: { dossierId: number }) {
  const [tab, setTab] = useState<TracaTab>('fil')
  const { data, isLoading } = useQuery({
    queryKey: ['dossier-qualite-traca', dossierId],
    queryFn: () => apiFetch<Tracabilite>(`/dossiers-qualite/${dossierId}/tracabilite`),
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-40">
        <Loader2 className="h-6 w-6 animate-spin text-accent" />
      </div>
    )
  }

  if (!data || data.kind === 'none') {
    return (
      <div className="flex flex-col items-center justify-center h-48 text-muted-foreground">
        <Link2 className="h-12 w-12 opacity-40 mb-3" />
        <p className="text-sm font-medium">Aucune traçabilité</p>
        <p className="text-xs mt-1 text-center max-w-sm">
          Renseignez une affectation (numéro de pièce ou lot de fil) valide dans l'onglet Dossier
          pour remonter la chaîne de production.
        </p>
      </div>
    )
  }

  return (
    <>
      {/* Identity strip — the piece / lot the dossier is attached to. */}
      <div className="rounded-xl border border-gold/20 bg-gradient-to-r from-gold/12 to-transparent p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-base font-heading font-bold tracking-tight truncate">{data.titre}</p>
            {!!data.sous_titre && (
              <p className="text-xs text-muted-foreground truncate mt-0.5">{data.sous_titre}</p>
            )}
          </div>
          {data.piece && (
            <div className="flex items-center gap-4 flex-shrink-0 text-right">
              <MiniStat label="Pièce" value={data.piece.numero} />
              <MiniStat label="Lot" value={data.piece.lot || '—'} />
              <MiniStat label="Poids" value={`${fmtNum(data.piece.poids, 1)} kg`} />
              {data.piece.IDordre_fabrication > 0 && (
                <MiniStat label="OF" value={String(data.piece.IDordre_fabrication)} />
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1">
        {TRACA_TABS.map((t) => {
          const Icon = t.icon
          const active = tab === t.key
          const disabled =
            (t.key === 'tricotage' && !data.tricotage) ||
            (t.key === 'ennoblissement' && !data.ennoblissement)
          return (
            <button
              key={t.key}
              type="button"
              disabled={disabled}
              onClick={() => setTab(t.key)}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors',
                active
                  ? 'bg-accent text-accent-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-accent/10',
                disabled && 'opacity-40 cursor-not-allowed hover:bg-transparent',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          )
        })}
      </div>

      {tab === 'fil' && <FilList fils={data.fils} />}
      {tab === 'tricotage' && <SstBlockCard block={data.tricotage} kind="tricotage" />}
      {tab === 'ennoblissement' && <SstBlockCard block={data.ennoblissement} kind="ennoblissement" />}
    </>
  )
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold tabular-nums truncate">{value}</p>
    </div>
  )
}

function DocChips({ documents }: { documents: TracaDoc[] }) {
  if (documents.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5 mt-2 ml-9">
      {documents.map((d) => (
        <span
          key={d.IDged}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-border/60 bg-white text-[10px] text-muted-foreground"
          title={d.type_nom ?? undefined}
        >
          <FileText className="h-2.5 w-2.5" />
          {d.nom}
        </span>
      ))}
    </div>
  )
}

function FilList({ fils }: { fils: TracaFil[] }) {
  if (fils.length === 0) {
    return <p className="text-sm text-muted-foreground italic px-1">Aucun fil incorporé connu.</p>
  }
  return (
    <div className="space-y-2">
      {fils.map((f) => (
        <div
          key={f.IDstock_fil}
          className="group rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3 border-l-amber-400/60"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-amber-400/10">
                <Layers className="h-3.5 w-3.5 text-amber-600" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{f.ref_fil || '—'}</p>
                <p className="text-[11px] text-muted-foreground truncate">
                  {[f.coloris, f.lot ? `Lot ${f.lot}` : ''].filter(Boolean).join(' · ')}
                </p>
              </div>
            </div>
            {f.pourcentage !== null && (
              <Badge variant="secondary" className="text-xs flex-shrink-0 tabular-nums">
                {fmtNum(f.pourcentage)} %
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-3 mt-2 ml-9 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1 truncate">
              <Building2 className="h-3 w-3 opacity-60" />
              {f.fournisseur_nom || '—'}
            </span>
            {f.IDcommande_fil !== null && (
              <span className="ml-auto inline-flex items-center gap-1 flex-shrink-0 tabular-nums">
                <Calendar className="h-3 w-3 opacity-60" />
                Commande N° {f.IDcommande_fil}
                {f.commande_date ? ` · ${formatHfsqlDate(f.commande_date)}` : ''}
              </span>
            )}
          </div>
          <DocChips documents={f.documents} />
        </div>
      ))}
    </div>
  )
}

function SstBlockCard({ block, kind }: { block: TracaSst | null; kind: 'tricotage' | 'ennoblissement' }) {
  if (!block) {
    return (
      <p className="text-sm text-muted-foreground italic px-1">
        Aucune commande {kind === 'tricotage' ? 'de tricotage' : "d'ennoblissement"} rattachée à cette
        pièce.
      </p>
    )
  }
  const Icon = kind === 'tricotage' ? Factory : Droplets
  // Tricoteur lines are quoted in kg of écru; ennoblisseur lines in Ml.
  const unit = kind === 'tricotage' ? 'kg' : 'Ml'
  return (
    <div className="rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3 border-l-amber-400/60">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-amber-400/10">
            <Icon className="h-3.5 w-3.5 text-amber-600" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{block.sous_traitant_nom || '—'}</p>
            <p className="text-[11px] text-muted-foreground truncate">
              Commande N° {block.IDcommande_sous_traitant}
              {block.date_commande ? ` · ${formatHfsqlDate(block.date_commande)}` : ''}
            </p>
          </div>
        </div>
        <Badge variant="secondary" className="text-xs flex-shrink-0 tabular-nums">
          {fmtNum(block.quantite, 1)} {unit}
        </Badge>
      </div>
      {block.lots.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2 ml-9">
          {block.lots.map((l) => (
            <span
              key={l}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-border/60 bg-white text-[10px] text-muted-foreground"
            >
              <Package className="h-2.5 w-2.5" />
              {l}
            </span>
          ))}
        </div>
      )}
      <DocChips documents={block.documents} />
    </div>
  )
}

// ── Right sidebar ────────────────────────────────────────

function DossierSidebar({
  detail,
  lookups,
  isEditing,
  edit,
  onField,
  activeTab,
  onTabChange,
  canManage,
  onToggleTermine,
  isToggling,
}: {
  detail: DossierDetail
  lookups: Lookups | undefined
  isEditing: boolean
  edit: EditState | null
  onField: <K extends keyof EditState>(key: K, value: EditState[K]) => void
  activeTab: SidebarTab
  onTabChange: (t: SidebarTab) => void
  canManage: boolean
  onToggleTermine: () => void
  isToggling: boolean
}) {
  return (
    <div className="w-96 flex-shrink-0 flex flex-col gap-3 min-h-0">
      <div className="flex-1 min-h-0 rounded-xl border flex flex-col overflow-hidden bg-zinc-100/80">
        <div className="flex border-b p-1 gap-1 rounded-t-xl bg-zinc-200/50">
          {SIDEBAR_TABS.map((t) => {
            const Icon = t.icon
            const active = activeTab === t.key
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => onTabChange(t.key)}
                className={cn(
                  'flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md transition-colors',
                  active
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

        <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-transparent">
          {activeTab === 'journal' && (
            <JournalTab detail={detail} isEditing={isEditing} edit={edit} onField={onField} />
          )}
          {activeTab === 'documents' && <DocumentsTab dossierId={detail.IDdossier_qualite} />}
          {activeTab === 'fnc' && (
            <FncTab
              detail={detail}
              lookups={lookups}
              isEditing={isEditing}
              edit={edit}
              onField={onField}
            />
          )}
        </div>
      </div>

      <StatusFooter
        termine={detail.termine}
        onToggle={onToggleTermine}
        isToggling={isToggling}
        disabled={isEditing || !canManage}
      />
    </div>
  )
}

function StatusFooter({
  termine,
  onToggle,
  isToggling,
  disabled,
}: {
  termine: 0 | 1
  onToggle: () => void
  isToggling: boolean
  disabled: boolean
}) {
  const isDone = termine === 1
  const Icon = isDone ? CheckCircle2 : Clock
  const label = isDone ? 'Terminé' : 'En cours'
  const actionLabel = isDone ? 'Rouvrir' : 'Clôturer'
  const ActionIcon = isDone ? Clock : CheckCircle2

  return (
    <div
      className={cn(
        'flex-shrink-0 rounded-xl border shadow-sm overflow-hidden flex items-stretch h-11',
        isDone ? 'bg-success border-success' : 'bg-primary border-primary',
      )}
    >
      <div className="flex items-center gap-2 px-3 flex-1 text-white min-w-0">
        <Icon className="h-4 w-4 flex-shrink-0" />
        <span className="text-sm font-bold uppercase tracking-wide truncate">{label}</span>
      </div>
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled || isToggling}
        title={isDone ? 'Marquer en cours' : 'Marquer terminé'}
        className="px-3.5 bg-white/15 hover:bg-white/25 active:bg-white/30 disabled:bg-white/5 disabled:opacity-60 disabled:cursor-not-allowed text-white text-xs font-semibold border-l border-white/25 flex items-center gap-1.5 transition-colors"
      >
        {isToggling ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <ActionIcon className="h-3.5 w-3.5" />
        )}
        {actionLabel}
      </button>
    </div>
  )
}

// ── Journal tab ──────────────────────────────────────────

function JournalTab({
  detail,
  isEditing,
  edit,
  onField,
}: {
  detail: DossierDetail
  isEditing: boolean
  edit: EditState | null
  onField: <K extends keyof EditState>(key: K, value: EditState[K]) => void
}) {
  return (
    <>
      <div className={cn('p-3 rounded-lg border bg-card shadow-sm', isEditing && editSectionClass)}>
        <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
          <History className="h-3.5 w-3.5" />
          Suivi du dossier
        </p>
        {isEditing && edit ? (
          <textarea
            rows={14}
            value={edit.journal}
            onChange={(e) => onField('journal', e.target.value)}
            className={textareaClass}
            placeholder="Notes de suivi…"
          />
        ) : detail.journal ? (
          <p className="text-sm text-muted-foreground whitespace-pre-line">{detail.journal}</p>
        ) : (
          <p className="text-sm text-muted-foreground italic">Aucune note</p>
        )}
      </div>

      {/* Pre-2023 dossiers kept the running commentary in `action`; read-only so
          the history stays visible without inviting edits to a dead column. */}
      {!!detail.action && (
        <div className="p-3 rounded-lg border bg-card shadow-sm">
          <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
            <ClipboardList className="h-3.5 w-3.5" />
            Historique (archive)
          </p>
          <p className="text-sm text-muted-foreground whitespace-pre-line">{detail.action}</p>
        </div>
      )}
    </>
  )
}

// ── Documents tab ────────────────────────────────────────

function DocumentsTab({ dossierId }: { dossierId: number }) {
  const [viewDoc, setViewDoc] = useState<DocQualite | null>(null)
  const { data, isLoading } = useQuery({
    queryKey: ['dossier-qualite-docs', dossierId],
    queryFn: () =>
      apiFetch<{ documents: DocQualite[]; degraded: boolean }>(`/dossiers-qualite/${dossierId}/documents`),
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-24">
        <Loader2 className="h-5 w-5 animate-spin text-accent" />
      </div>
    )
  }

  if (data?.degraded) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-muted-foreground text-center px-4">
        <FileText className="h-10 w-10 opacity-30 mb-3" />
        <p className="text-sm font-medium">Documents indisponibles</p>
        <p className="text-xs mt-1">
          Les pièces jointes de ce dossier ne sont consultables que dans l'application historique.
        </p>
      </div>
    )
  }

  const docs = data?.documents ?? []
  if (docs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
        <FileText className="h-10 w-10 opacity-30 mb-3" />
        <p className="text-sm">Aucun document</p>
      </div>
    )
  }

  return (
    <>
      {docs.map((d) => (
        <div
          key={d.IDdoc_qualite}
          onClick={() => setViewDoc(d)}
          className="group p-3 rounded-lg border bg-card shadow-sm cursor-pointer hover:border-accent/40 transition-colors flex items-center gap-2"
        >
          <FileText className="h-4 w-4 text-accent flex-shrink-0" />
          <span className="text-sm truncate">{d.nom || `Document ${d.IDdoc_qualite}`}</span>
        </div>
      ))}
      <DocViewDialog dossierId={dossierId} doc={viewDoc} onClose={() => setViewDoc(null)} />
    </>
  )
}

function DocViewDialog({
  dossierId,
  doc,
  onClose,
}: {
  dossierId: number
  doc: DocQualite | null
  onClose: () => void
}) {
  // null = probing, false = no file, otherwise the served content type. Most
  // quality attachments are phone photos, which an iframe renders unscaled in
  // the top-left corner — <img object-contain> fits them properly.
  const [contentType, setContentType] = useState<string | null | false>(null)
  const url = doc ? `${API_URL}/dossiers-qualite/${dossierId}/documents/${doc.IDdoc_qualite}/fichier` : ''

  useEffect(() => {
    if (!doc) return
    setContentType(null)
    fetch(url, { method: 'HEAD', credentials: 'include' })
      .then((r) => setContentType(r.ok ? (r.headers.get('content-type') ?? '') : false))
      .catch(() => setContentType(false))
  }, [doc?.IDdoc_qualite, url, doc])

  if (!doc) return null

  const isImage = typeof contentType === 'string' && contentType.startsWith('image/')
  const hasFile = typeof contentType === 'string'

  return (
    <Dialog open={!!doc} onOpenChange={() => onClose()}>
      {hasFile ? (
        <div
          className="relative z-50 w-[70vw] max-w-4xl h-[92vh]"
          onClick={(e) => e.stopPropagation()}
        >
          {isImage ? (
            <div className="w-full h-full rounded-lg bg-zinc-900 flex items-center justify-center overflow-hidden">
              <img src={url} alt={doc.nom} className="max-w-full max-h-full object-contain" />
            </div>
          ) : (
            <iframe src={`${url}#view=FitH`} className="w-full h-full rounded-lg bg-white" title={doc.nom} />
          )}
        </div>
      ) : (
        <DialogContent className="max-w-sm" onClose={onClose}>
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            {contentType === null ? (
              <Loader2 className="h-6 w-6 animate-spin text-accent" />
            ) : (
              <>
                <FileText className="h-12 w-12 opacity-30 mb-2" />
                <p className="text-sm">Aucun document attaché</p>
              </>
            )}
          </div>
        </DialogContent>
      )}
    </Dialog>
  )
}

// ── FNC tab ──────────────────────────────────────────────

function FncTab({
  detail,
  lookups,
  isEditing,
  edit,
  onField,
}: {
  detail: DossierDetail
  lookups: Lookups | undefined
  isEditing: boolean
  edit: EditState | null
  onField: <K extends keyof EditState>(key: K, value: EditState[K]) => void
}) {
  const societes = lookups?.societes_fnc ?? []
  const societeLabel =
    societes.find((s) => s.value === detail.IDsociete_fnc)?.label ?? '—'

  const resolutionOptions = useMemo(
    () => (lookups?.resolutions ?? []).map((r) => ({ id: r.IDresolution_qualite, primary: r.libelle })),
    [lookups],
  )
  const currentResolutionId =
    (lookups?.resolutions ?? []).find(
      (r) => r.libelle === (isEditing && edit ? edit.fnc_resolution : detail.fnc_resolution),
    )?.IDresolution_qualite ?? 0

  return (
    <>
      <div className={cn('p-3 rounded-lg border bg-card shadow-sm', isEditing && editSectionClass)}>
        <div className="flex items-center justify-between gap-2 mb-2">
          <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
            <Send className="h-3.5 w-3.5" />
            Destinataire
          </p>
          {!!detail.envoi_fnc && !isEditing && (
            <span className="text-xs font-semibold text-green-600">
              Envoyé le {formatHfsqlDate(detail.envoi_fnc)}
            </span>
          )}
        </div>
        {isEditing && edit ? (
          <div className="space-y-2">
            <PopoverSelect
              options={societes.map((s) => ({ id: s.value, primary: s.label }))}
              value={edit.IDsociete_fnc}
              onChange={(id) => onField('IDsociete_fnc', id)}
              hideEmpty
            />
            <Field label="Date d'envoi">
              <input
                type="date"
                value={edit.envoi_fnc}
                onChange={(e) => onField('envoi_fnc', e.target.value)}
                className={inputClass}
              />
            </Field>
          </div>
        ) : (
          <p className="text-sm flex items-center gap-1.5">
            <Building2 className="h-3.5 w-3.5 text-muted-foreground" />
            {societeLabel}
          </p>
        )}
      </div>

      <div className={cn('p-3 rounded-lg border bg-card shadow-sm', isEditing && editSectionClass)}>
        <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
          <User className="h-3.5 w-3.5" />
          Message
        </p>
        {isEditing && edit ? (
          <textarea
            rows={5}
            value={edit.message_fnc}
            onChange={(e) => onField('message_fnc', e.target.value)}
            className={textareaClass}
          />
        ) : detail.message_fnc ? (
          <p className="text-sm text-muted-foreground whitespace-pre-line">{detail.message_fnc}</p>
        ) : (
          <p className="text-sm text-muted-foreground italic">Aucun message</p>
        )}
      </div>

      <div className={cn('p-3 rounded-lg border bg-card shadow-sm', isEditing && editSectionClass)}>
        <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Réponse
        </p>
        {isEditing && edit ? (
          <div className="space-y-2">
            <Field label="Résolution">
              <PopoverSelect
                options={resolutionOptions}
                value={currentResolutionId}
                onChange={(id) =>
                  onField(
                    'fnc_resolution',
                    (lookups?.resolutions ?? []).find((r) => r.IDresolution_qualite === id)?.libelle ?? '',
                  )
                }
                emptyLabel="— aucune —"
              />
            </Field>
            <Field label="Commentaires">
              <textarea
                rows={6}
                value={edit.fnc_commentaire}
                onChange={(e) => onField('fnc_commentaire', e.target.value)}
                className={textareaClass}
              />
            </Field>
          </div>
        ) : detail.fnc_resolution || detail.fnc_commentaire ? (
          <>
            {!!detail.fnc_resolution && (
              <p className="text-sm font-semibold text-accent mb-1">{detail.fnc_resolution}</p>
            )}
            {!!detail.fnc_commentaire && (
              <p className="text-sm text-muted-foreground whitespace-pre-line">
                {detail.fnc_commentaire}
              </p>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground italic">En attente de réponse</p>
        )}
      </div>
    </>
  )
}

// ── Nouveau dossier dialog ───────────────────────────────

function CreateDossierDialog({
  open,
  lookups,
  onClose,
  onCreated,
}: {
  open: boolean
  lookups: Lookups | undefined
  onClose: () => void
  onCreated: (id: number) => void
}) {
  const [IDclient, setIDclient] = useState(0)
  const [IDdefaut, setIDdefaut] = useState(0)
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      setIDclient(0)
      setIDdefaut(0)
      setDescription('')
      setError(null)
    }
  }, [open])

  const createMut = useMutation({
    mutationFn: () =>
      apiFetch<{ IDdossier_qualite: number }>('/dossiers-qualite', {
        method: 'POST',
        body: JSON.stringify({ IDclient, IDdefaut_textile: IDdefaut, description }),
      }),
    onSuccess: (r) => onCreated(r.IDdossier_qualite),
    onError: () => setError("Impossible de créer le dossier."),
  })

  const defautOptions = useMemo(
    () =>
      (lookups?.defauts ?? []).map((d) => ({
        id: d.IDdefaut_textile,
        primary: d.nom,
        secondary: d.categorie || undefined,
      })),
    [lookups],
  )

  const canSubmit = IDclient > 0 && IDdefaut > 0 && description.trim() !== ''

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileWarning className="h-5 w-5 text-accent" />
            Nouveau dossier qualité
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <Field label="Client">
            <SearchableCombobox
              options={lookups?.clients ?? []}
              value={IDclient}
              onChange={setIDclient}
              getId={(c) => c.IDclient}
              getPrimary={(c) => c.nom}
              placeholder="Rechercher un client"
            />
          </Field>
          <Field label="Défaut">
            <PopoverSelect
              options={defautOptions}
              value={IDdefaut}
              onChange={setIDdefaut}
              emptyLabel="— choisir —"
            />
          </Field>
          <Field label="Description">
            <textarea
              rows={4}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className={textareaClass}
              placeholder="Nature de la non-conformité…"
            />
          </Field>
          {error && <p className="text-xs text-destructive mt-3">{error}</p>}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose} disabled={createMut.isPending}>
            Annuler
          </Button>
          <Button onClick={() => createMut.mutate()} disabled={!canSubmit || createMut.isPending}>
            {createMut.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
            Créer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
