// Qualité › Actions — ports legacy FI_Action_Qualité.wdw.
//
// A "action qualité" is a tracked quality topic (Titre + Description). It owns
// zero or more *mentions*: automatic comments that print on every matching bon
// de commande sous-traitant, scoped by (type sst, sous-traitant, référence,
// coloris). Each mention accumulates conformité verdicts, recorded per lot from
// Qualité › Suivi lots — surfaced read-only here as "Conformité des commandes".
//
// Layout: **Fiche** (mps_designer §4) — left list, multi-section centre panel,
// right sidebar with tabs + a binary status footer (§29.3) for terminé.
//
// Product rule: an action NEVER auto-archives. The "objectif de conformités" is
// advisory — reaching it lights up a cue, but closing the action stays an
// explicit click on the footer. (Explicit user decision; do not "helpfully" add
// auto-closing later.)

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Award,
  Calendar,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  Factory,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Save,
  Target,
  Trash2,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PopoverSelect, SearchableCombobox } from '@/components/ui/popover-select'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'
import { UnsavedChangesDialog } from '@/components/shared/UnsavedChangesDialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import { apiFetch } from '@/lib/api'
import { useHasPermission } from '@/contexts/PermissionsContext'
import { formatHfsqlDate } from '@/lib/dates'
import { cn } from '@/lib/utils'

// ── Types ────────────────────────────────────────────────

type Conformite = 'non_controle' | 'conforme' | 'non_conforme' | 'aucun'
type StatusFilter = 'en_cours' | 'termine' | 'tous'

interface ActionListRow {
  IDaction_qualite: number
  titre: string
  description: string
  date_creation: string
  termine: 0 | 1
  mentions_count: number
  conforme_count: number
  non_conforme_count: number
  objectif: number | null
  objectif_atteint: boolean
}

interface MentionRow {
  IDmention_qualite: number
  IDaction_qualite: number
  IDtype_sst: number
  IDsous_traitant: number
  sous_traitant_nom: string
  IDreference: number
  reference: string
  IDColoris: number
  coloris: string
  mention: string
}

interface CommandeRow {
  IDcommande_sous_traitant: number
  IDligne_commande_sous_traitant: number
  IDmention_qualite: number
  sous_traitant_nom: string
  conformite: Conformite
}

interface ActionDetail {
  IDaction_qualite: number
  titre: string
  description: string
  date_creation: string
  termine: 0 | 1
  objectif: number | null
  objectif_atteint: boolean
  conforme_count: number
  non_conforme_count: number
  non_controle_count: number
  mentions: MentionRow[]
  commandes: CommandeRow[]
}

interface RefLookup {
  id: number
  reference: string
  designation: string
  avec_teinture: number | null
}

interface SstLookup {
  IDsous_traitant: number
  nom: string
}

interface ColorisLookup {
  id: number
  reference: string
}

// ── Shared bits ──────────────────────────────────────────

const inputClass =
  'w-full h-8 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring'
const editSectionClass = 'border-l-4 border-l-accent/70 bg-accent/[0.03]'

const STATUS_FILTERS: { key: StatusFilter; label: string }[] = [
  { key: 'en_cours', label: 'En cours' },
  { key: 'termine', label: 'Terminées' },
  { key: 'tous', label: 'Toutes' },
]

/** Legacy row 35 has an empty Titre (created and abandoned in 2022). Never let a
 *  list row or a heading render blank. */
function actionLabel(titre: string, id: number): string {
  const t = (titre ?? '').trim()
  return t.length > 0 ? t : `Action N° ${id}`
}

const TYPE_LABEL: Record<number, string> = { 1: 'Tricoteur', 2: 'Ennoblisseur' }

// Conformité colour language, shared by the detail table and the counters.
// Mirrors the read-only status-pill idiom (mps_designer §37): one hue per state,
// soft fill for dense tables.
const CONFORMITE_META: Record<Conformite, { label: string; soft: string; dot: string }> = {
  conforme: {
    label: 'Conforme',
    soft: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    dot: 'bg-emerald-500',
  },
  non_conforme: {
    label: 'Non conforme',
    soft: 'bg-red-100 text-red-700 border-red-200',
    dot: 'bg-red-500',
  },
  non_controle: {
    label: 'Non contrôlé',
    soft: 'bg-zinc-100 text-zinc-700 border-zinc-200',
    dot: 'bg-zinc-400',
  },
  aucun: {
    label: 'Aucun',
    soft: 'bg-zinc-100 text-zinc-500 border-zinc-200',
    dot: 'bg-zinc-300',
  },
}

export function ConformitePill({ value, className }: { value: Conformite; className?: string }) {
  const meta = CONFORMITE_META[value] ?? CONFORMITE_META.non_controle
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium',
        meta.soft,
        className,
      )}
    >
      {meta.label}
    </span>
  )
}

// ── Page ─────────────────────────────────────────────────

export function QualiteActions() {
  const queryClient = useQueryClient()
  const canManage = useHasPermission('responsable_qualite')

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('en_cours')
  const [isEditing, setIsEditing] = useState(false)
  const [sidebarTab, setSidebarTab] = useState<'suivi' | 'infos'>('suivi')
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [autoEditForId, setAutoEditForId] = useState<number | null>(null)

  // Edit draft — titre/description live on HFSQL, objectif in the JSON side
  // store, but the user edits and saves them as one form.
  const [editTitre, setEditTitre] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editObjectif, setEditObjectif] = useState('')
  const originalDraftRef = useRef<{ titre: string; description: string; objectif: string } | null>(null)

  // Mention dialog state (a sub-form → feeds the dirty flag, §28.3.a)
  const [mentionDialogOpen, setMentionDialogOpen] = useState(false)
  const [editingMention, setEditingMention] = useState<MentionRow | null>(null)
  const [deleteMentionTarget, setDeleteMentionTarget] = useState<MentionRow | null>(null)

  const { data: rows, isLoading, isError } = useQuery<ActionListRow[]>({
    queryKey: ['actions-qualite', statusFilter],
    queryFn: () => apiFetch(`/actions-qualite?status=${statusFilter}`),
  })

  const { data: detail, isLoading: detailLoading } = useQuery<ActionDetail>({
    queryKey: ['action-qualite', selectedId],
    queryFn: () => apiFetch(`/actions-qualite/${selectedId}`),
    enabled: selectedId !== null,
  })

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['actions-qualite'] })
    queryClient.invalidateQueries({ queryKey: ['action-qualite', selectedId] })
  }, [queryClient, selectedId])

  const startEdit = useCallback(() => {
    if (!detail) return
    const snapshot = {
      titre: detail.titre,
      description: detail.description,
      objectif: detail.objectif === null ? '' : String(detail.objectif),
    }
    setEditTitre(snapshot.titre)
    setEditDescription(snapshot.description)
    setEditObjectif(snapshot.objectif)
    originalDraftRef.current = snapshot
    setIsEditing(true)
  }, [detail])

  const cancelEdit = useCallback(() => {
    setIsEditing(false)
    setMentionDialogOpen(false)
    setEditingMention(null)
    originalDraftRef.current = null
  }, [])

  const saveMut = useMutation({
    mutationFn: async () => {
      if (selectedId === null) return
      await apiFetch(`/actions-qualite/${selectedId}`, {
        method: 'PUT',
        body: JSON.stringify({ titre: editTitre.trim(), description: editDescription }),
      })
      // The objectif lives outside HFSQL — a second call, but the user still
      // experiences one Enregistrer.
      const parsed = editObjectif.trim() === '' ? null : Number(editObjectif)
      await apiFetch(`/actions-qualite/${selectedId}/objectif`, {
        method: 'PUT',
        body: JSON.stringify({ objectif: parsed }),
      })
    },
    onSuccess: () => {
      invalidateAll()
      setIsEditing(false)
      originalDraftRef.current = null
    },
  })

  const termineMut = useMutation({
    mutationFn: (termine: 0 | 1) =>
      apiFetch(`/actions-qualite/${selectedId}/etat`, {
        method: 'POST',
        body: JSON.stringify({ termine }),
      }),
    onSuccess: invalidateAll,
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/actions-qualite/${id}`, { method: 'DELETE' }),
    // Read the cache BEFORE invalidating so the next selection isn't picked
    // from a stale list that still holds the deleted row (§25.2).
    onSuccess: (_data, deletedId) => {
      const cached =
        queryClient.getQueryData<ActionListRow[]>(['actions-qualite', statusFilter]) ?? []
      const remaining = cached.filter((r) => r.IDaction_qualite !== deletedId)
      queryClient.invalidateQueries({ queryKey: ['actions-qualite'] })
      setIsEditing(false)
      setDeleteOpen(false)
      setSelectedId(remaining.length > 0 ? remaining[0].IDaction_qualite : null)
    },
  })

  const deleteMentionMut = useMutation({
    mutationFn: (mentionId: number) =>
      apiFetch(`/actions-qualite/${selectedId}/mentions/${mentionId}`, { method: 'DELETE' }),
    onSuccess: () => {
      invalidateAll()
      setDeleteMentionTarget(null)
    },
  })

  const isDirty = useMemo(() => {
    if (!isEditing) return false
    const o = originalDraftRef.current
    if (!o) return false
    if (editTitre !== o.titre) return true
    if (editDescription !== o.description) return true
    if (editObjectif !== o.objectif) return true
    // An open mention dialog counts as unsaved work.
    if (mentionDialogOpen) return true
    return false
  }, [isEditing, editTitre, editDescription, editObjectif, mentionDialogOpen])

  const guard = useUnsavedGuard({
    isDirty,
    save: async () => { await saveMut.mutateAsync() },
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

  const filtered = useMemo(() => {
    const list = rows ?? []
    const q = searchQuery.trim().toLowerCase()
    if (!q) return list
    return list.filter((r) =>
      [r.titre, r.description, String(r.IDaction_qualite)].join(' ').toLowerCase().includes(q),
    )
  }, [rows, searchQuery])

  useAutoSelectFirst({
    rows: filtered,
    selectedId,
    getId: (r) => r.IDaction_qualite,
    select: setSelectedId,
    suspended: isEditing || autoEditForId !== null,
  })

  // A freshly created action opens straight in edit mode (§25.1).
  useEffect(() => {
    if (autoEditForId !== null && detail?.IDaction_qualite === autoEditForId) {
      startEdit()
      setAutoEditForId(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEditForId, detail])

  return (
    <>
      <MasterDetailLayout
        hasSelection={selectedId !== null}
        onBack={handleBack}
        sidebarTitle="Suivi"
        list={
          <ActionList
            rows={filtered}
            isLoading={isLoading}
            isError={isError}
            selectedId={selectedId}
            onSelect={handleSelect}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            statusFilter={statusFilter}
            onStatusFilterChange={handleStatusFilter}
            isEditing={isEditing}
            canManage={canManage}
            onCreate={() => setCreateOpen(true)}
          />
        }
        detailHeader={
          detail ? (
            <ActionHeader
              detail={detail}
              isEditing={isEditing}
              saving={saveMut.isPending}
              canManage={canManage}
              editTitre={editTitre}
              onTitreChange={setEditTitre}
              onStartEdit={startEdit}
              onCancelEdit={cancelEdit}
              onSave={() => saveMut.mutate()}
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
            <ActionDetailMain
              detail={detail}
              isEditing={isEditing}
              editDescription={editDescription}
              onDescriptionChange={setEditDescription}
              onAddMention={() => {
                setEditingMention(null)
                setMentionDialogOpen(true)
              }}
              onEditMention={(m) => {
                setEditingMention(m)
                setMentionDialogOpen(true)
              }}
              onDeleteMention={(m) => setDeleteMentionTarget(m)}
            />
          ) : selectedId === null && !isLoading ? (
            <EmptyDetailState />
          ) : null
        }
        sidebar={
          detail ? (
            <ActionSidebar
              detail={detail}
              isEditing={isEditing}
              editObjectif={editObjectif}
              onObjectifChange={setEditObjectif}
              activeTab={sidebarTab}
              onTabChange={setSidebarTab}
              canManage={canManage}
              onToggleTermine={() => termineMut.mutate(detail.termine === 1 ? 0 : 1)}
              isToggling={termineMut.isPending}
            />
          ) : null
        }
      />

      <UnsavedChangesDialog
        open={guard.showDialog}
        onAction={guard.handleAction}
        isSaving={guard.isSaving}
      />

      <CreateActionDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(newId) => {
          setCreateOpen(false)
          queryClient.invalidateQueries({ queryKey: ['actions-qualite'] })
          setSelectedId(newId)
          setAutoEditForId(newId)
        }}
      />

      <MentionDialog
        open={mentionDialogOpen}
        actionId={selectedId}
        mention={editingMention}
        onClose={() => {
          setMentionDialogOpen(false)
          setEditingMention(null)
        }}
        onSaved={() => {
          setMentionDialogOpen(false)
          setEditingMention(null)
          invalidateAll()
        }}
      />

      <ConfirmDialog
        open={deleteOpen}
        title="Supprimer l'action qualité"
        description={
          detail
            ? `« ${actionLabel(detail.titre, detail.IDaction_qualite)} » sera supprimée, ainsi que ses ${detail.mentions.length} mention(s) et tous les contrôles de conformité associés. Cette action est irréversible.`
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

      <ConfirmDialog
        open={deleteMentionTarget !== null}
        title="Supprimer la mention"
        description={
          deleteMentionTarget
            ? `La mention sur ${deleteMentionTarget.reference || 'cette référence'} sera supprimée, ainsi que les contrôles de conformité déjà enregistrés pour elle.`
            : undefined
        }
        isPending={deleteMentionMut.isPending}
        onCancel={() => setDeleteMentionTarget(null)}
        onConfirm={() => {
          if (deleteMentionTarget) deleteMentionMut.mutate(deleteMentionTarget.IDmention_qualite)
        }}
      />
    </>
  )
}

// ── Left list ────────────────────────────────────────────

function ActionList({
  rows, isLoading, isError, selectedId, onSelect, searchQuery, onSearchChange,
  statusFilter, onStatusFilterChange, isEditing, canManage, onCreate,
}: {
  rows: ActionListRow[]
  isLoading: boolean
  isError: boolean
  selectedId: number | null
  onSelect: (id: number) => void
  searchQuery: string
  onSearchChange: (v: string) => void
  statusFilter: StatusFilter
  onStatusFilterChange: (f: StatusFilter) => void
  isEditing: boolean
  canManage: boolean
  onCreate: () => void
}) {
  return (
    <div className="flex flex-col h-full rounded-lg border shadow-sm bg-zinc-100/80">
      <div className="p-3 border-b rounded-t-lg bg-zinc-200/50 space-y-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Rechercher une action"
            className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex flex-wrap gap-1">
          {STATUS_FILTERS.map((opt) => (
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
          <div className="flex items-center justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-accent" />
          </div>
        ) : isError ? (
          <div className="flex flex-col items-center justify-center py-10 text-destructive">
            <AlertTriangle className="h-8 w-8 mb-2" />
            <p className="text-sm">Erreur de chargement</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
            <ClipboardCheck className="h-12 w-12 mb-3 opacity-50" />
            <p className="text-sm">Aucune action</p>
          </div>
        ) : (
          rows.map((r) => {
            const isSelected = selectedId === r.IDaction_qualite
            return (
              <div
                key={r.IDaction_qualite}
                onClick={() => onSelect(r.IDaction_qualite)}
                className={cn(
                  'p-3 border rounded-lg cursor-pointer transition-all bg-white',
                  isSelected
                    ? 'border-accent ring-1 ring-accent'
                    : 'border-border hover:border-accent/50',
                )}
              >
                <div className="flex items-start gap-2">
                  <ClipboardCheck className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
                  <p className="font-medium text-sm truncate flex-1">
                    {actionLabel(r.titre, r.IDaction_qualite)}
                  </p>
                </div>
                {!!r.description.trim() && (
                  <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                    {r.description.trim()}
                  </p>
                )}
                <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                  {r.termine === 1 ? (
                    <Badge variant="outline" className="text-[10px] py-0 gap-1 border bg-success text-white border-success">
                      <CheckCircle2 className="h-2.5 w-2.5" />
                      Terminée
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] py-0 gap-1 border bg-primary text-white border-primary">
                      <Clock className="h-2.5 w-2.5" />
                      En cours
                    </Badge>
                  )}
                  {r.mentions_count > 0 && (
                    <Badge variant="secondary" className="text-[10px] py-0 gap-1">
                      <MessageSquare className="h-2.5 w-2.5" />
                      {r.mentions_count}
                    </Badge>
                  )}
                  {/* Objectif reached is a cue, never an automatic close. */}
                  {r.objectif_atteint && r.termine === 0 && (
                    <Badge
                      variant="outline"
                      className="text-[10px] py-0 gap-1 border bg-emerald-100 text-emerald-800 border-emerald-200"
                    >
                      <Target className="h-2.5 w-2.5" />
                      Objectif atteint
                    </Badge>
                  )}
                  <span className="text-[11px] text-muted-foreground ml-auto tabular-nums">
                    {r.date_creation ? formatHfsqlDate(r.date_creation) : ''}
                  </span>
                </div>
              </div>
            )
          })
        )}
      </div>

      <div className="p-3 border-t text-xs text-muted-foreground flex items-center justify-between rounded-b-lg bg-zinc-200/50">
        <span>
          {rows.length} action{rows.length > 1 ? 's' : ''}
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

// ── Detail header ────────────────────────────────────────

function ActionHeader({
  detail, isEditing, saving, canManage, editTitre, onTitreChange,
  onStartEdit, onCancelEdit, onSave, onDelete,
}: {
  detail: ActionDetail
  isEditing: boolean
  saving: boolean
  canManage: boolean
  editTitre: string
  onTitreChange: (v: string) => void
  onStartEdit: () => void
  onCancelEdit: () => void
  onSave: () => void
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
          <ClipboardCheck className="h-5 w-5" />
        </div>

        <div className="min-w-0 flex-1">
          {isEditing ? (
            <div className="flex items-center gap-3">
              <input
                type="text"
                value={editTitre}
                onChange={(e) => onTitreChange(e.target.value)}
                placeholder="Titre de l'action"
                className="flex-1 text-xl font-heading font-bold h-10 px-3 rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <Badge className="bg-accent text-accent-foreground flex-shrink-0 gap-1 shadow-sm">
                <Pencil className="h-3 w-3" />
                Mode edition
              </Badge>
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-heading font-bold tracking-tight truncate">
                {actionLabel(detail.titre, detail.IDaction_qualite)}
              </h1>
              <div className="flex gap-1.5 mt-1 flex-wrap items-center">
                <Badge variant="secondary" className="text-xs">
                  N° {detail.IDaction_qualite}
                </Badge>
                {!!detail.date_creation && (
                  <span className="text-xs text-muted-foreground flex items-center gap-1">
                    <Calendar className="h-3 w-3" />
                    {formatHfsqlDate(detail.date_creation)}
                  </span>
                )}
              </div>
            </>
          )}
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {isEditing ? (
            <>
              <Button variant="outline" size="sm" onClick={onCancelEdit} disabled={saving}>
                <X className="h-3.5 w-3.5 mr-1.5" />
                Annuler
              </Button>
              <Button size="sm" onClick={onSave} disabled={saving || !editTitre.trim()}>
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Save className="h-3.5 w-3.5 mr-1.5" />
                )}
                Enregistrer
              </Button>
            </>
          ) : canManage ? (
            <>
              <Button
                variant="outline"
                size="icon"
                className="h-9 w-9 text-destructive hover:text-destructive"
                title="Supprimer l'action"
                onClick={onDelete}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
              <Button variant="gold" size="sm" onClick={onStartEdit}>
                <Pencil className="h-3.5 w-3.5 mr-1.5" />
                Modifier
              </Button>
            </>
          ) : null}
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

// ── Centre panel ─────────────────────────────────────────

function ActionDetailMain({
  detail, isEditing, editDescription, onDescriptionChange,
  onAddMention, onEditMention, onDeleteMention,
}: {
  detail: ActionDetail
  isEditing: boolean
  editDescription: string
  onDescriptionChange: (v: string) => void
  onAddMention: () => void
  onEditMention: (m: MentionRow) => void
  onDeleteMention: (m: MentionRow) => void
}) {
  return (
    <div className="flex-1 min-h-0 overflow-auto space-y-4 px-1 pb-1 scrollbar-transparent">
      {/* Description */}
      <Card className={cn('card-premium', isEditing && editSectionClass)}>
        <CardHeader className="flex flex-row items-center gap-2 pb-2">
          <MessageSquare className="h-4 w-4 text-accent" />
          <CardTitle className="text-sm font-semibold">Description</CardTitle>
        </CardHeader>
        <CardContent>
          {isEditing ? (
            <textarea
              rows={5}
              value={editDescription}
              onChange={(e) => onDescriptionChange(e.target.value)}
              placeholder="Contexte, constat, décision..."
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
            />
          ) : detail.description.trim() ? (
            <p className="text-sm text-muted-foreground whitespace-pre-line">
              {detail.description.trim()}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground italic">Aucune description</p>
          )}
        </CardContent>
      </Card>

      {/* Mentions */}
      <Card className={cn('card-premium', isEditing && editSectionClass)}>
        <CardHeader className="flex flex-row items-center gap-2 pb-2">
          <AlertTriangle className="h-4 w-4 text-accent" />
          <CardTitle className="text-sm font-semibold">
            Commentaires automatiques sur les commandes sous-traitant
          </CardTitle>
          {isEditing && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0 text-accent hover:text-accent hover:bg-accent/10 flex-shrink-0"
              title="Ajouter une mention"
              onClick={onAddMention}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          )}
          <Badge variant="secondary" className="text-xs ml-auto flex-shrink-0">
            {detail.mentions.length}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-[11px] text-muted-foreground">
            Ces mentions s'impriment automatiquement sur le bon de commande de chaque commande
            sous-traitant correspondante, tant que l'action est en cours.
          </p>
          {detail.mentions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <AlertTriangle className="h-12 w-12 mb-3 opacity-40" />
              <p className="text-sm">Aucune mention</p>
              {isEditing && (
                <Button variant="outline" size="sm" className="mt-3" onClick={onAddMention}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                  Ajouter une mention
                </Button>
              )}
            </div>
          ) : (
            <>
              {detail.mentions.map((m) => (
                <MentionCard
                  key={m.IDmention_qualite}
                  mention={m}
                  isEditing={isEditing}
                  onEdit={() => onEditMention(m)}
                  onDelete={() => onDeleteMention(m)}
                />
              ))}
              {isEditing && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onAddMention}
                  className="w-full text-muted-foreground hover:text-accent hover:bg-accent/5 border border-dashed border-border/60 hover:border-accent/40"
                >
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                  Ajouter une mention
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Conformité des commandes */}
      <Card className="card-premium">
        <CardHeader className="flex flex-row items-center gap-2 pb-2">
          <Award className="h-4 w-4 text-accent" />
          <CardTitle className="text-sm font-semibold">Conformité des commandes</CardTitle>
          <Badge variant="secondary" className="text-xs ml-auto flex-shrink-0">
            {detail.commandes.length}
          </Badge>
        </CardHeader>
        <CardContent>
          <p className="text-[11px] text-muted-foreground mb-2">
            Se renseigne depuis Qualité › Suivi lots, sur le lot correspondant.
          </p>
          {detail.commandes.length === 0 ? (
            <p className="text-sm text-muted-foreground italic py-4 text-center">
              Aucune commande sous-traitant ne correspond encore à ces mentions
            </p>
          ) : (
            <div className="rounded-lg border border-border/60 bg-card overflow-hidden">
              <div className="max-h-80 overflow-auto scrollbar-transparent">
                <table className="w-full text-sm" style={{ tableLayout: 'fixed' }}>
                  <colgroup>
                    <col style={{ width: '25%' }} />
                    <col style={{ width: '42%' }} />
                    <col style={{ width: '33%' }} />
                  </colgroup>
                  <thead className="bg-zinc-200/60 border-b border-border/60 sticky top-0">
                    <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="px-3 py-2 text-left font-semibold">Commande N°</th>
                      <th className="px-3 py-2 text-left font-semibold">Sous-traitant</th>
                      <th className="px-3 py-2 text-left font-semibold">Conformité</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.commandes.map((c) => (
                      <tr
                        key={`${c.IDligne_commande_sous_traitant}-${c.IDmention_qualite}`}
                        className="border-b border-border/40 last:border-b-0"
                      >
                        <td className="px-3 py-2 tabular-nums">{c.IDcommande_sous_traitant}</td>
                        <td className="px-3 py-2 truncate" title={c.sous_traitant_nom}>
                          {c.sous_traitant_nom || '—'}
                        </td>
                        <td className="px-3 py-2">
                          <ConformitePill value={c.conformite} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/** Centre-panel item card (§7): zinc surface + amber left edge (neutral). */
function MentionCard({
  mention, isEditing, onEdit, onDelete,
}: {
  mention: MentionRow
  isEditing: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const scope = mention.sous_traitant_nom || `Tous les ${(TYPE_LABEL[mention.IDtype_sst] ?? 'sous-traitant').toLowerCase()}s`
  return (
    <div
      onClick={isEditing ? onEdit : undefined}
      className={cn(
        'group rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3 border-l-amber-400/60',
        isEditing && 'cursor-pointer hover:bg-zinc-100 hover:border-accent/40 transition-colors',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-amber-400/10">
            <Factory className="h-3.5 w-3.5 text-amber-600" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{scope}</p>
            <p className="text-[11px] text-muted-foreground truncate">
              {TYPE_LABEL[mention.IDtype_sst] ?? `Type ${mention.IDtype_sst}`}
              {mention.reference ? ` · ${mention.reference}` : ''}
              {` · ${mention.coloris || 'Tous les coloris'}`}
            </p>
          </div>
        </div>
        {isEditing && (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 text-destructive hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
            title="Supprimer la mention"
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        )}
      </div>
      {!!mention.mention.trim() && (
        <div className="flex items-start gap-1.5 mt-2 ml-9">
          <MessageSquare className="h-3 w-3 text-muted-foreground/50 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-muted-foreground italic whitespace-pre-line">
            {mention.mention.trim()}
          </p>
        </div>
      )}
    </div>
  )
}

function EmptyDetailState() {
  return (
    <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
      <div className="icon-box-gold h-16 w-16 flex items-center justify-center mb-4">
        <ClipboardCheck className="h-8 w-8" />
      </div>
      <p className="text-sm">Sélectionnez une action qualité</p>
    </div>
  )
}

// ── Right sidebar ────────────────────────────────────────

const SIDEBAR_TABS = [
  { key: 'suivi' as const, label: 'Suivi', icon: Target },
  { key: 'infos' as const, label: 'Infos', icon: ClipboardCheck },
]

function ActionSidebar({
  detail, isEditing, editObjectif, onObjectifChange, activeTab, onTabChange,
  canManage, onToggleTermine, isToggling,
}: {
  detail: ActionDetail
  isEditing: boolean
  editObjectif: string
  onObjectifChange: (v: string) => void
  activeTab: 'suivi' | 'infos'
  onTabChange: (t: 'suivi' | 'infos') => void
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
          {activeTab === 'suivi' ? (
            <SuiviTab
              detail={detail}
              isEditing={isEditing}
              editObjectif={editObjectif}
              onObjectifChange={onObjectifChange}
            />
          ) : (
            <InfosTab detail={detail} />
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

function SuiviTab({
  detail, isEditing, editObjectif, onObjectifChange,
}: {
  detail: ActionDetail
  isEditing: boolean
  editObjectif: string
  onObjectifChange: (v: string) => void
}) {
  // Progress is measured on the objectif being edited when in edit mode, so the
  // bar responds live while the user types a new target.
  const objectif = isEditing
    ? (editObjectif.trim() === '' ? null : Number(editObjectif))
    : detail.objectif
  const validObjectif = objectif !== null && Number.isFinite(objectif) && objectif > 0 ? objectif : null
  const pct = validObjectif
    ? Math.min(100, Math.round((detail.conforme_count / validObjectif) * 100))
    : 0
  const atteint = validObjectif !== null && detail.conforme_count >= validObjectif

  return (
    <>
      <div className={cn('p-3 rounded-lg border bg-card shadow-sm', isEditing && editSectionClass)}>
        <div className="flex items-center gap-2 mb-2">
          <Target className="h-3.5 w-3.5 text-accent" />
          <h3 className="text-sm font-semibold">Objectif de conformités</h3>
        </div>

        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xs text-muted-foreground">Contrôles conformes visés</span>
          {isEditing ? (
            <input
              type="number"
              min={1}
              max={999}
              value={editObjectif}
              onChange={(e) => onObjectifChange(e.target.value)}
              placeholder="—"
              className="h-7 w-[104px] px-2 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring text-right"
            />
          ) : (
            <span className="text-sm text-right tabular-nums">
              {detail.objectif ?? 'Non défini'}
            </span>
          )}
        </div>

        {validObjectif !== null && (
          <div className="mt-3">
            <div className="flex items-baseline justify-between mb-1">
              <span className="text-xs text-muted-foreground">Progression</span>
              <span className="text-sm font-semibold tabular-nums">
                {detail.conforme_count} / {validObjectif}
              </span>
            </div>
            <div className="h-2 rounded-full bg-zinc-200 overflow-hidden">
              <div
                className={cn('h-full rounded-full transition-all', atteint ? 'bg-emerald-500' : 'bg-accent')}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        )}

        {/* The objectif is deliberately advisory: it never closes the action. */}
        {atteint && detail.termine === 0 && (
          <div className="mt-3 flex items-start gap-1.5 rounded-md border border-emerald-200 bg-emerald-50 p-2">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 flex-shrink-0 mt-0.5" />
            <p className="text-[11px] text-emerald-800">
              Objectif atteint. Vous pouvez clôturer cette action quand vous le jugez opportun.
            </p>
          </div>
        )}
        {validObjectif === null && !isEditing && (
          <p className="text-[11px] text-muted-foreground mt-2 italic">
            Définissez un objectif pour suivre la progression de cette action.
          </p>
        )}
      </div>

      <div className="p-3 rounded-lg border bg-card shadow-sm">
        <div className="flex items-center gap-2 mb-2">
          <Award className="h-3.5 w-3.5 text-accent" />
          <h3 className="text-sm font-semibold">Contrôles</h3>
        </div>
        <div className="space-y-1.5">
          <CounterRow label="Conforme" value={detail.conforme_count} tone="conforme" />
          <CounterRow label="Non conforme" value={detail.non_conforme_count} tone="non_conforme" />
          <CounterRow label="Non contrôlé" value={detail.non_controle_count} tone="non_controle" />
        </div>
      </div>
    </>
  )
}

function CounterRow({ label, value, tone }: { label: string; value: number; tone: Conformite }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground flex items-center gap-1.5">
        <span className={cn('h-2 w-2 rounded-full', CONFORMITE_META[tone].dot)} />
        {label}
      </span>
      <span className="text-sm text-right tabular-nums font-medium">{value}</span>
    </div>
  )
}

function InfosTab({ detail }: { detail: ActionDetail }) {
  return (
    <div className="p-3 rounded-lg border bg-card shadow-sm">
      <div className="flex items-center gap-2 mb-2">
        <ClipboardCheck className="h-3.5 w-3.5 text-accent" />
        <h3 className="text-sm font-semibold">Informations</h3>
      </div>
      <div className="space-y-1.5">
        <KV label="N°" value={String(detail.IDaction_qualite)} />
        <KV
          label="Créée le"
          value={detail.date_creation ? formatHfsqlDate(detail.date_creation) : '—'}
        />
        <KV label="Mentions" value={String(detail.mentions.length)} />
        <KV label="Commandes concernées" value={String(detail.commandes.length)} />
        <KV label="Statut" value={detail.termine === 1 ? 'Terminée' : 'En cours'} />
      </div>
    </div>
  )
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm text-right truncate tabular-nums">{value}</span>
    </div>
  )
}

/** Binary status footer (mps_designer §29.3). Closing an action is always this
 *  click — never a side effect of reaching the objectif. */
function StatusFooter({
  termine, onToggle, isToggling, disabled,
}: {
  termine: 0 | 1
  onToggle: () => void
  isToggling: boolean
  disabled: boolean
}) {
  const isDone = termine === 1
  const Icon = isDone ? CheckCircle2 : Clock
  const label = isDone ? 'Terminée' : 'En cours'
  const actionLabelText = isDone ? 'Rouvrir' : 'Clôturer'
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
        title={isDone ? 'Rouvrir cette action' : 'Clôturer cette action'}
        className="px-3.5 bg-white/15 hover:bg-white/25 active:bg-white/30 disabled:bg-white/5 disabled:opacity-60 disabled:cursor-not-allowed text-white text-xs font-semibold border-l border-white/25 flex items-center gap-1.5 transition-colors"
      >
        {isToggling ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <ActionIcon className="h-3.5 w-3.5" />
        )}
        {actionLabelText}
      </button>
    </div>
  )
}

// ── Create dialog ────────────────────────────────────────

function CreateActionDialog({
  open, onClose, onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (id: number) => void
}) {
  const [titre, setTitre] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setTitre('')
      setError(null)
    }
  }, [open])

  const createMut = useMutation({
    mutationFn: (): Promise<{ IDaction_qualite: number }> =>
      apiFetch('/actions-qualite', {
        method: 'POST',
        body: JSON.stringify({ titre: titre.trim(), description: '' }),
      }),
    onSuccess: (data) => onCreated(data.IDaction_qualite),
    onError: (e: Error) => setError(e.message || 'Erreur lors de la création'),
  })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardCheck className="h-5 w-5 text-accent" />
            Nouvelle action qualité
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Titre</label>
            <input
              type="text"
              value={titre}
              autoFocus
              onChange={(e) => setTitre(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && titre.trim()) createMut.mutate()
              }}
              placeholder="Ex. Attention aux stabilités"
              className={inputClass}
            />
          </div>
          {error && (
            <p className="text-xs text-destructive mt-3">{error}</p>
          )}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose} disabled={createMut.isPending}>
            Annuler
          </Button>
          <Button onClick={() => createMut.mutate()} disabled={!titre.trim() || createMut.isPending}>
            {createMut.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Créer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Mention create/edit dialog ───────────────────────────
//
// Mirrors the legacy "Commentaire automatique commande sous-traitant" popup:
// Tricoteurs / Ennoblisseurs switch, then sous-traitant + référence + coloris,
// then the text. Changing the type resets the downstream ids because the
// référence and coloris catalogs are different per type.

function MentionDialog({
  open, actionId, mention, onClose, onSaved,
}: {
  open: boolean
  actionId: number | null
  mention: MentionRow | null
  onClose: () => void
  onSaved: () => void
}) {
  const [typeSst, setTypeSst] = useState<1 | 2>(2)
  const [sstId, setSstId] = useState(0)
  const [refId, setRefId] = useState(0)
  const [colorisId, setColorisId] = useState(0)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Hydrate once per open so typing isn't clobbered by a re-render.
  useEffect(() => {
    if (!open) return
    setTypeSst((mention?.IDtype_sst === 1 ? 1 : 2) as 1 | 2)
    setSstId(mention?.IDsous_traitant ?? 0)
    setRefId(mention?.IDreference ?? 0)
    setColorisId(mention?.IDColoris ?? 0)
    setText(mention?.mention ?? '')
    setError(null)
  }, [open, mention])

  const { data: ssts } = useQuery<SstLookup[]>({
    queryKey: ['aq-lookup-sst', typeSst],
    queryFn: () => apiFetch(`/actions-qualite/lookups/sous-traitants?type=${typeSst}`),
    enabled: open,
  })

  const { data: refs, isLoading: refsLoading } = useQuery<RefLookup[]>({
    queryKey: ['aq-lookup-refs', typeSst],
    queryFn: () => apiFetch(`/actions-qualite/lookups/references?type=${typeSst}`),
    enabled: open,
  })

  const { data: coloris, isLoading: colorisLoading } = useQuery<ColorisLookup[]>({
    queryKey: ['aq-lookup-coloris', typeSst, refId],
    queryFn: () => apiFetch(`/actions-qualite/lookups/coloris?type=${typeSst}&reference=${refId}`),
    enabled: open && refId > 0,
  })

  const saveMut = useMutation({
    mutationFn: () => {
      const body = JSON.stringify({
        IDtype_sst: typeSst,
        IDsous_traitant: sstId,
        IDreference: refId,
        IDColoris: colorisId,
        mention: text.trim(),
      })
      return mention
        ? apiFetch(`/actions-qualite/${actionId}/mentions/${mention.IDmention_qualite}`, {
            method: 'PUT',
            body,
          })
        : apiFetch(`/actions-qualite/${actionId}/mentions`, { method: 'POST', body })
    },
    onSuccess: onSaved,
    onError: (e: Error) => setError(e.message || 'Erreur lors de l\'enregistrement'),
  })

  const canSave = refId > 0 && text.trim().length > 0 && !saveMut.isPending

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90dvh] overflow-y-auto" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-accent" />
            {mention ? 'Modifier la mention' : 'Ajouter une mention'}
          </DialogTitle>
        </DialogHeader>

        <div className="mt-4 space-y-3">
          {/* Type — drives which catalogs the fields below read from. */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Type de sous-traitant</label>
            <div className="flex gap-1">
              {([2, 1] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => {
                    if (t === typeSst) return
                    setTypeSst(t)
                    // The id spaces differ per type — keeping them would point
                    // at an unrelated référence/coloris.
                    setSstId(0)
                    setRefId(0)
                    setColorisId(0)
                  }}
                  className={cn(
                    'flex-1 px-3 py-1.5 text-xs rounded-md transition-colors border',
                    typeSst === t
                      ? 'bg-accent text-accent-foreground shadow-sm font-medium border-accent'
                      : 'text-muted-foreground hover:bg-accent/10 border-input',
                  )}
                >
                  {t === 2 ? 'Ennoblisseurs' : 'Tricoteurs'}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Sous-traitant</label>
            <PopoverSelect
              options={(ssts ?? []).map((s) => ({ id: s.IDsous_traitant, primary: s.nom }))}
              value={sstId}
              onChange={setSstId}
              emptyLabel={`Tous les ${typeSst === 2 ? 'ennoblisseurs' : 'tricoteurs'}`}
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              {typeSst === 1 ? 'Tombé de métier' : 'Référence'}
            </label>
            <SearchableCombobox
              options={refs ?? []}
              value={refId}
              onChange={(id) => {
                setRefId(id)
                // Coloris belong to the référence — never carry one across.
                setColorisId(0)
              }}
              getId={(r) => r.id}
              getPrimary={(r) => r.reference}
              getSecondary={(r) => r.designation}
              placeholder={typeSst === 1 ? 'Rechercher un tombé de métier' : 'Rechercher une référence'}
              loading={refsLoading}
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Coloris</label>
            <PopoverSelect
              options={(coloris ?? []).map((c) => ({ id: c.id, primary: c.reference }))}
              value={colorisId}
              onChange={setColorisId}
              emptyLabel="Tous les coloris"
              disabled={refId === 0 || colorisLoading}
              disabledTitle="Choisissez d'abord une référence"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              Mention à inclure dans les commandes sous-traitant
            </label>
            <textarea
              rows={5}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Ex. ATTENTION: THERMOFIXER SANS TROP TIRER"
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
            />
          </div>

          {error && <p className="text-xs text-destructive mt-3">{error}</p>}
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose} disabled={saveMut.isPending}>
            Annuler
          </Button>
          <Button onClick={() => saveMut.mutate()} disabled={!canSave}>
            {saveMut.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
