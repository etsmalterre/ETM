// Transferts — bons de transfert between Ets Malterre and sous-traitant sites.
// Shared implementation for the two nav entries:
//   /transferts/rouleaux → kind 'rouleaux' (écru "tombé de métier" + fini rolls)
//   /transferts/fils     → kind 'fils'     (stock_fil lots)
//
// Master-detail (Fiche) modeled on ClientsExpeditions.tsx. The center panel is
// the single-list of transferred pieces (§7 single-list shape) with an
// in-screen picker drawer (§31) listing the available stock at the SOURCE
// magasin. Adding/removing a piece moves its stock to the destination/back to
// the source IMMEDIATELY (user-confirmed legacy semantics) — so the picker
// works in view mode and source/destination are locked once lines exist.

import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { UnsavedChangesDialog } from '@/components/shared/UnsavedChangesDialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import {
  Truck,
  Search,
  Loader2,
  AlertCircle,
  MapPin,
  Pencil,
  Plus,
  X,
  Save,
  Trash2,
  AtSign,
  Printer,
  Info,
  ArrowRight,
  CheckCircle2,
  CheckSquare,
  MessageSquare,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { TmRollIcon } from '@/components/icons/TmRollIcon'
import { FiniRollIcon } from '@/components/icons/FiniRollIcon'
import { BobineIcon } from '@/components/icons/BobineIcon'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { PopoverSelect } from '@/components/ui/popover-select'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'
import { SendEmailDialog } from '@/components/email/SendEmailDialog'
import { postEmail } from '@/lib/email'
import { cn } from '@/lib/utils'
import { formatHfsqlDate, hfsqlDateToInput, inputDateToHfsql } from '@/lib/dates'
import { fmtNum } from '@/lib/format'
import { apiFetch, API_URL } from '@/lib/api'
import { useHasPermission } from '@/contexts/PermissionsContext'

// ── Types ──────────────────────────────────────────────

const LIST_PAGE_SIZE = 100

export type TransfertKind = 'rouleaux' | 'fils'

interface TransfertListRow {
  id: number
  kind: TransfertKind
  IDmagasin_source: number
  source_nom: string
  IDmagasin_destination: number
  destination_nom: string
  transporteur_nom: string
  date: string | null
  nb_pieces: number
}

interface AdresseLite {
  IDadresse: number
  nom: string | null
  adresse1: string | null
  adresse2: string | null
  adresse3: string | null
  cp: string | null
  ville: string | null
  pays: string | null
}
interface AdresseLookup extends AdresseLite {
  est_defaut: number
}

interface RouleauxLine {
  IDpiece_transfert: number
  type: 'tm' | 'fini'
  stock_id: number
  reference: string
  designation: string
  composition: string
  coloris_reference: string
  numero: string
  lot: string
  poids: number
  metrage: number
  second_choix: number
}
interface FilLine {
  IDpiece_transfert: number
  type: 'fil'
  stock_id: number
  lot: string
  reference: string
  coloris_reference: string
  poids: number
  fournisseur_nom: string
  commentaire: string | null
}
type TransfertLine = RouleauxLine | FilLine

interface TransfertDetail {
  id: number
  kind: TransfertKind
  IDmagasin_source: number
  source_nom: string
  IDmagasin_destination: number
  destination_nom: string
  IDadresse_destination: number
  adresse_destination: AdresseLite | null
  IDtransporteur: number
  transporteur_nom: string
  date: string | null
  commentaire: string | null
  lines: TransfertLine[]
}

interface AvailableRoll {
  stock_id: number
  reference: string
  coloris_reference: string
  numero: string
  lot: string
  poids: number
  metrage: number
  second_choix: number
}
interface AvailableFilLot {
  stock_id: number
  lot: string
  reference: string
  coloris_reference: string
  poids: number
  fournisseur_nom: string
  commentaire: string | null
}
interface AvailablePayload {
  ecru?: AvailableRoll[]
  fini?: AvailableRoll[]
  fil?: AvailableFilLot[]
  cap: number
}

interface MagasinLite { id: number; nom: string }
interface TransporteurLite { IDtransporteur: number; nom: string }

// ── Shared styling ─────────────────────────────────────

const inputClass = 'w-full h-8 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring'
const editSectionClass = 'border-l-4 border-l-accent/70 bg-accent/[0.03]'

const ETS_MALTERRE: MagasinLite = { id: 0, nom: 'Ets Malterre' }

/** Label of the §7.1 row-add affordance. The dialog it opens both adds pieces
 *  from the source stock and retires pieces already on the bon, so it names the
 *  manager rather than a single action. Same string in both render states. */
const EDIT_BON_LABEL = 'Éditer le bon de transfert'

// ── Main Page ──────────────────────────────────────────

export function TransfertsScreen({ kind }: { kind: TransfertKind }) {
  const queryClient = useQueryClient()
  // One permission per kind — Rouleaux and Fils are granted independently.
  // Covers création, modification, ajout / retrait des pièces et suppression;
  // without it the screen is read-only.
  const canManage = useHasPermission(`gestion_transfert_${kind}`)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [autoEditForId, setAutoEditForId] = useState<number | null>(null)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [emailOpen, setEmailOpen] = useState(false)

  // In-screen picker drawer (page-level so startEdit can close it — §31.2/.3).
  const [pickerOpen, setPickerOpen] = useState(false)

  // Edit-mode header draft.
  const [editIDSource, setEditIDSource] = useState(0)
  const [editIDDestination, setEditIDDestination] = useState(0)
  const [editIDAdresse, setEditIDAdresse] = useState(0)
  const [editIDTransporteur, setEditIDTransporteur] = useState(0)
  const [editDate, setEditDate] = useState('')
  const [editCommentaire, setEditCommentaire] = useState('')

  const originalDraftRef = useRef<Record<string, string | number> | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery.trim()), 250)
    return () => clearTimeout(t)
  }, [searchQuery])

  // Reset the page state when the nav switches between Rouleaux and Fils —
  // the component instance is shared by both routes.
  useEffect(() => {
    setSelectedId(null)
    setSearchQuery('')
    setDebouncedQuery('')
    setIsEditing(false)
    setPickerOpen(false)
  }, [kind])

  const {
    data: rowPages, isLoading, isError, error, isFetching,
    fetchNextPage, hasNextPage, isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: ['transferts', kind, debouncedQuery],
    queryFn: ({ pageParam }): Promise<TransfertListRow[]> =>
      apiFetch(`/transferts?kind=${kind}&q=${encodeURIComponent(debouncedQuery)}&limit=${LIST_PAGE_SIZE}${pageParam ? `&before=${pageParam}` : ''}`),
    initialPageParam: 0,
    getNextPageParam: (lastPage: TransfertListRow[]) =>
      debouncedQuery || lastPage.length < LIST_PAGE_SIZE ? undefined : lastPage[lastPage.length - 1].id,
  })

  const { data: detail, isLoading: detailLoading } = useQuery<TransfertDetail>({
    queryKey: ['transfert', kind, selectedId],
    queryFn: () => apiFetch(`/transferts/${kind}/${selectedId}`),
    enabled: selectedId !== null,
  })

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['transferts'] })
    queryClient.invalidateQueries({ queryKey: ['transfert', kind, selectedId] })
  }, [queryClient, kind, selectedId])

  const startEdit = useCallback(() => {
    if (!detail) return
    const snapshot: Record<string, string | number> = {
      IDsource: detail.IDmagasin_source ?? 0,
      IDdestination: detail.IDmagasin_destination ?? 0,
      IDadresse: detail.IDadresse_destination ?? 0,
      IDtransporteur: detail.IDtransporteur ?? 0,
      date: hfsqlDateToInput(detail.date),
      commentaire: detail.commentaire ?? '',
    }
    setEditIDSource(snapshot.IDsource as number)
    setEditIDDestination(snapshot.IDdestination as number)
    setEditIDAdresse(snapshot.IDadresse as number)
    setEditIDTransporteur(snapshot.IDtransporteur as number)
    setEditDate(snapshot.date as string)
    setEditCommentaire(snapshot.commentaire as string)
    originalDraftRef.current = snapshot
    setPickerOpen(false) // the picker always starts closed on a fresh edit
    setIsEditing(true)
  }, [detail])

  const cancelEdit = useCallback(() => { setPickerOpen(false); setIsEditing(false) }, [])

  const isDirty = useMemo(() => {
    if (!isEditing) return false
    const o = originalDraftRef.current
    if (!o) return false
    if (editIDSource !== o.IDsource) return true
    if (editIDDestination !== o.IDdestination) return true
    if (editIDAdresse !== o.IDadresse) return true
    if (editIDTransporteur !== o.IDtransporteur) return true
    if (editDate !== o.date) return true
    if (editCommentaire !== o.commentaire) return true
    return false
  }, [isEditing, editIDSource, editIDDestination, editIDAdresse, editIDTransporteur, editDate, editCommentaire])

  const saveHeaderMut = useMutation({
    // `keepEditing` is used by the picker: adding pieces moves stock to the
    // bon's PERSISTED destination, so an unsaved header draft has to be
    // flushed first — but without kicking the user out of edit mode.
    mutationFn: (_opts?: { keepEditing?: boolean }) => apiFetch(`/transferts/${kind}/${selectedId}`, {
      method: 'PUT',
      body: JSON.stringify({
        IDmagasin_source: editIDSource,
        IDmagasin_destination: editIDDestination,
        IDadresse_destination: editIDAdresse || 0,
        IDtransporteur: editIDTransporteur || 0,
        date: inputDateToHfsql(editDate),
        commentaire: editCommentaire,
      }),
    }),
    onSuccess: (_data, opts) => {
      invalidateAll()
      if (opts?.keepEditing) {
        // Re-baseline the snapshot so the unsaved-changes guard sees a clean form.
        originalDraftRef.current = {
          IDsource: editIDSource,
          IDdestination: editIDDestination,
          IDadresse: editIDAdresse,
          IDtransporteur: editIDTransporteur,
          date: editDate,
          commentaire: editCommentaire,
        }
      } else {
        setPickerOpen(false)
        setIsEditing(false)
      }
    },
  })

  /** Open the stock picker, flushing a dirty header draft first so the pieces
   *  land in the magasin the user actually sees selected. */
  const handlePickerOpenChange = useCallback((open: boolean) => {
    if (!open) { setPickerOpen(false); return }
    if (!isDirty) { setPickerOpen(true); return }
    saveHeaderMut.mutateAsync({ keepEditing: true }).then(
      () => setPickerOpen(true),
      () => { /* save failed — stay put, the header is still dirty */ },
    )
  }, [isDirty, saveHeaderMut])

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/transferts/${kind}/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, deletedId) => {
      // Infinite query: the cache entry is { pages, pageParams }, not a flat array.
      const cached = queryClient.getQueryData<{ pages: TransfertListRow[][] }>(['transferts', kind, debouncedQuery])
      const remaining = (cached?.pages ?? []).flat().filter((r) => r.id !== deletedId)
      queryClient.invalidateQueries({ queryKey: ['transferts'] })
      setIsEditing(false)
      setDeleteConfirmOpen(false)
      setSelectedId(remaining.length > 0 ? remaining[0].id : null)
    },
  })

  useEffect(() => {
    if (autoEditForId !== null && detail?.id === autoEditForId) {
      startEdit()
      setAutoEditForId(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEditForId, detail])

  const guard = useUnsavedGuard({
    isDirty,
    save: async () => { await saveHeaderMut.mutateAsync(undefined) },
    onDiscard: () => { setPickerOpen(false); setIsEditing(false) },
  })

  const handleSelect = useCallback((id: number) => {
    guard.guardAction(() => { setIsEditing(false); setPickerOpen(false); setSelectedId(id) })
  }, [guard])

  const list = useMemo(() => (rowPages?.pages ?? []).flat(), [rowPages])

  useAutoSelectFirst({
    rows: list,
    selectedId,
    getId: (r) => r.id,
    select: setSelectedId,
    suspended: isEditing || isFetching,
  })

  const kindLabel = kind === 'rouleaux' ? 'rouleaux' : 'lots de fil'

  return (
    <>
      <MasterDetailLayout
        list={
          <TransfertListPanel
            kind={kind}
            rows={list}
            isLoading={isLoading}
            isError={isError}
            error={error as Error | null}
            selectedId={selectedId}
            onSelect={handleSelect}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onNew={() => setCreateOpen(true)}
            canManage={canManage}
            isEditing={isEditing}
            hasMore={!!hasNextPage}
            onLoadMore={() => fetchNextPage()}
            isLoadingMore={isFetchingNextPage}
          />
        }
        detailHeader={
          <DetailHeader
            transfert={detail ?? null}
            isLoading={detailLoading && selectedId !== null}
            isEditing={isEditing}
            canManage={canManage}
            onStartEdit={startEdit}
            onCancelEdit={cancelEdit}
            onSave={() => saveHeaderMut.mutate(undefined)}
            isSaving={saveHeaderMut.isPending}
            onDelete={() => setDeleteConfirmOpen(true)}
            onPrintClick={() => {
              if (selectedId !== null) window.open(`${API_URL}/transferts/${kind}/${selectedId}/pdf`, '_blank')
            }}
            onEmailClick={() => setEmailOpen(true)}
          />
        }
        detail={
          <DetailMain
            kind={kind}
            transfert={detail ?? null}
            isLoading={detailLoading && selectedId !== null}
            hasSelection={selectedId !== null}
            isEditing={isEditing}
            canManage={canManage}
            pickerOpen={pickerOpen}
            onPickerOpenChange={handlePickerOpenChange}
            onMutationSuccess={invalidateAll}
          />
        }
        sidebar={selectedId !== null ? (
          <DetailSidebar
            kind={kind}
            transfert={detail ?? null}
            isLoading={detailLoading}
            isEditing={isEditing}
            editIDSource={editIDSource} onEditIDSourceChange={setEditIDSource}
            editIDDestination={editIDDestination} onEditIDDestinationChange={setEditIDDestination}
            editIDAdresse={editIDAdresse} onEditIDAdresseChange={setEditIDAdresse}
            editIDTransporteur={editIDTransporteur} onEditIDTransporteurChange={setEditIDTransporteur}
            editDate={editDate} onEditDateChange={setEditDate}
            editCommentaire={editCommentaire} onEditCommentaireChange={setEditCommentaire}
          />
        ) : null}
        sidebarTitle="Informations"
        hasSelection={selectedId !== null}
        onBack={() => guard.guardAction(() => { setIsEditing(false); setPickerOpen(false); setSelectedId(null) })}
      />

      <UnsavedChangesDialog open={guard.showDialog} onAction={guard.handleAction} isSaving={guard.isSaving} />

      <CreateTransfertDialog
        open={createOpen}
        kind={kind}
        onClose={() => setCreateOpen(false)}
        onCreated={(newId) => {
          setCreateOpen(false)
          queryClient.invalidateQueries({ queryKey: ['transferts'] })
          setSelectedId(newId)
          setAutoEditForId(newId)
        }}
      />

      <ConfirmDialog
        open={deleteConfirmOpen}
        title="Supprimer le bon de transfert"
        description={`Le bon sera supprimé et les ${kindLabel} qu'il contient retourneront au magasin source. Cette action est irréversible.`}
        confirmLabel="Supprimer"
        isPending={deleteMut.isPending}
        onCancel={() => setDeleteConfirmOpen(false)}
        onConfirm={() => { if (selectedId !== null) deleteMut.mutate(selectedId) }}
      />

      {selectedId !== null && (
        <SendEmailDialog
          open={emailOpen}
          onClose={() => setEmailOpen(false)}
          contextLabel={detail?.destination_nom ?? undefined}
          queryKey={['transfert-email-defaults', kind, selectedId]}
          loadDefaults={() => apiFetch(`/transferts/${kind}/${selectedId}/email-defaults`)}
          pdfUrl={`${API_URL}/transferts/${kind}/${selectedId}/pdf`}
          pdfAttachmentLabel={`bordereau-transfert-${selectedId}.pdf`}
          onSend={(p) => postEmail(`${API_URL}/transferts/${kind}/${selectedId}/email`, p, { includeAttachPdf: true })}
        />
      )}
    </>
  )
}

// ── Left Panel: List ───────────────────────────────────

function TransfertListPanel({
  kind, rows, isLoading, isError, error,
  selectedId, onSelect,
  searchQuery, onSearchChange,
  onNew, canManage, isEditing,
  hasMore, onLoadMore, isLoadingMore,
}: {
  kind: TransfertKind
  rows: TransfertListRow[]
  isLoading: boolean
  isError: boolean
  error: Error | null
  selectedId: number | null
  onSelect: (id: number) => void
  searchQuery: string
  onSearchChange: (q: string) => void
  onNew: () => void
  canManage: boolean
  isEditing: boolean
  hasMore: boolean
  onLoadMore: () => void
  isLoadingMore: boolean
}) {
  return (
    <div className="flex flex-col h-full rounded-lg border shadow-sm bg-zinc-100/80">
      <div className="p-3 border-b rounded-t-lg bg-zinc-200/50">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Rechercher (n°, magasin...)"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            autoComplete="off"
            className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          />
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
            <Truck className="h-12 w-12 mb-3 opacity-50" />
            <p className="text-sm">Aucun transfert</p>
          </div>
        ) : (<>
          {rows.map((row) => {
            const isSelected = selectedId === row.id
            return (
              <div
                key={row.id}
                onClick={() => onSelect(row.id)}
                className={cn(
                  'p-3 border rounded-lg cursor-pointer transition-all bg-white',
                  isSelected ? 'border-accent ring-1 ring-accent' : 'border-border hover:border-accent/50',
                )}
              >
                <div className="flex items-center gap-2">
                  <Truck className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  <span className="font-medium text-sm">N° {row.id}</span>
                  {row.date && <span className="ml-auto text-[11px] text-muted-foreground">{formatHfsqlDate(row.date)}</span>}
                </div>
                <div className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground min-w-0">
                  <span className="truncate">{row.source_nom || '—'}</span>
                  <ArrowRight className="h-3 w-3 flex-shrink-0 text-accent" />
                  <span className="truncate">{row.destination_nom || '—'}</span>
                </div>
                <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground">
                  <span className="truncate">{row.transporteur_nom || '—'}</span>
                  <span className="ml-auto text-muted-foreground/80 tabular-nums">
                    {row.nb_pieces} {kind === 'rouleaux' ? `pièce${row.nb_pieces > 1 ? 's' : ''}` : `lot${row.nb_pieces > 1 ? 's' : ''}`}
                  </span>
                </div>
              </div>
            )
          })}
          {hasMore && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onLoadMore}
              disabled={isLoadingMore}
              className="w-full text-muted-foreground hover:text-foreground"
            >
              {isLoadingMore ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
              Charger plus
            </Button>
          )}
        </>)}
      </div>

      <div className="p-3 border-t text-xs text-muted-foreground flex items-center justify-between rounded-b-lg bg-zinc-200/50">
        <span>{rows.length} transfert{rows.length > 1 ? 's' : ''}</span>
        {!isEditing && canManage && (
          <Button size="sm" variant="ghost" className="text-accent hover:text-accent hover:bg-accent/10" onClick={onNew}>
            <Plus className="h-3.5 w-3.5 mr-1" />Nouveau
          </Button>
        )}
      </div>
    </div>
  )
}

// ── Detail Header ──────────────────────────────────────

function DetailHeader({
  transfert, isLoading, isEditing, canManage,
  onStartEdit, onCancelEdit, onSave, isSaving,
  onDelete, onPrintClick, onEmailClick,
}: {
  transfert: TransfertDetail | null
  isLoading: boolean
  isEditing: boolean
  canManage: boolean
  onStartEdit: () => void
  onCancelEdit: () => void
  onSave: () => void
  isSaving: boolean
  onDelete: () => void
  onPrintClick: () => void
  onEmailClick: () => void
}) {
  if (!transfert && !isLoading) return null
  return (
    <div className="flex-shrink-0 pt-0.5">
      <div className="flex items-center gap-3">
        <div className={cn('h-11 w-11 rounded-lg flex items-center justify-center', isEditing ? 'bg-accent/15' : 'icon-box-gold')}>
          <Truck className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          {isLoading ? (
            <div className="h-8 w-48 bg-muted animate-pulse rounded" />
          ) : (
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-heading font-bold tracking-tight truncate">
                Transfert N° {transfert?.id}
                <span className="text-muted-foreground font-normal"> · {transfert?.source_nom || '—'} → {transfert?.destination_nom || '—'}</span>
              </h1>
              <div className="flex items-center gap-2 flex-shrink-0">
                {transfert?.date && <Badge variant="secondary" className="text-xs">{formatHfsqlDate(transfert.date)}</Badge>}
                {isEditing && (
                  <Badge className="bg-accent text-accent-foreground gap-1 shadow-sm"><Pencil className="h-3 w-3" />Mode edition</Badge>
                )}
              </div>
            </div>
          )}
        </div>
        {!isLoading && transfert && (
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
                  <Save className="h-3.5 w-3.5 mr-1.5" />{isSaving ? 'Enregistrement...' : 'Enregistrer'}
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="icon" className="h-9 w-9" title="Imprimer" onClick={onPrintClick}>
                  <Printer className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="icon" className="h-9 w-9" title="Envoyer un email" onClick={onEmailClick}>
                  <AtSign className="h-4 w-4" />
                </Button>
                {canManage && (
                  <Button variant="gold" size="sm" onClick={onStartEdit}>
                    <Pencil className="h-3.5 w-3.5 mr-1.5" />Modifier
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </div>
      <div className={cn('h-1 w-24 mt-3 rounded-full', isEditing ? 'bg-accent' : 'bg-gradient-to-r from-accent via-accent to-accent/30')} />
    </div>
  )
}

// ── Center: pieces list + picker drawer (§31) ──────────

function DetailMain({
  kind, transfert, isLoading, hasSelection, isEditing, canManage,
  pickerOpen, onPickerOpenChange, onMutationSuccess,
}: {
  kind: TransfertKind
  transfert: TransfertDetail | null
  isLoading: boolean
  hasSelection: boolean
  isEditing: boolean
  canManage: boolean
  pickerOpen: boolean
  onPickerOpenChange: (open: boolean) => void
  onMutationSuccess: () => void
}) {
  if (!hasSelection) return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="icon-box-gold h-16 w-16 mx-auto"><Truck className="h-8 w-8" /></div>
        <p className="text-muted-foreground text-sm">Sélectionnez un transfert dans la liste</p>
      </div>
    </div>
  )
  if (isLoading) return <div className="flex-1 flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-accent" /></div>
  if (!transfert) return null

  return (
    <LinesSection
      kind={kind}
      transfert={transfert}
      isEditing={isEditing}
      canManage={canManage}
      pickerOpen={pickerOpen}
      onPickerOpenChange={onPickerOpenChange}
      onMutationSuccess={onMutationSuccess}
    />
  )
}

function LinesSection({
  kind, transfert, isEditing, canManage, pickerOpen, onPickerOpenChange, onMutationSuccess,
}: {
  kind: TransfertKind
  transfert: TransfertDetail
  isEditing: boolean
  canManage: boolean
  pickerOpen: boolean
  onPickerOpenChange: (open: boolean) => void
  onMutationSuccess: () => void
}) {
  const queryClient = useQueryClient()
  // Pieces are only mutable in edit mode — adding or retiring one moves stock
  // between magasins immediately, so it stays behind the same deliberate gate
  // as the rest of the bon.
  const canMutatePieces = isEditing && canManage
  const lines = transfert.lines

  const removeMut = useMutation({
    mutationFn: (pieceId: number) => apiFetch(`/transferts/${kind}/${transfert.id}/pieces/${pieceId}`, { method: 'DELETE' }),
    onSuccess: (payload: { lines: TransfertLine[] }) => {
      queryClient.setQueryData<TransfertDetail>(['transfert', kind, transfert.id], (old) => old ? { ...old, lines: payload.lines } : old)
      queryClient.invalidateQueries({ queryKey: ['transferts'] })
      queryClient.invalidateQueries({ queryKey: ['transfert-available', kind, transfert.id] })
    },
  })

  const totals = useMemo(() => ({
    nb: lines.length,
    poids: lines.reduce((s, l) => s + (Number(l.poids) || 0), 0),
    metrage: lines.reduce((s, l) => s + (l.type === 'fil' ? 0 : Number((l as RouleauxLine).metrage) || 0), 0),
  }), [lines])

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-auto space-y-2 p-1 scrollbar-transparent">
        {lines.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            {kind === 'rouleaux' ? <FiniRollIcon className="h-12 w-12 mb-3 opacity-40" /> : <BobineIcon className="h-12 w-12 mb-3 opacity-40" />}
            <p className="text-sm">{kind === 'rouleaux' ? 'Aucune pièce sur ce bon' : 'Aucun lot de fil sur ce bon'}</p>
            {canMutatePieces && (
              <Button variant="outline" size="sm" className="mt-3" onClick={() => onPickerOpenChange(true)}>
                <Pencil className="h-3.5 w-3.5 mr-1.5" />{EDIT_BON_LABEL}
              </Button>
            )}
            {!canMutatePieces && canManage && (
              <p className="text-xs mt-1">Passez en mode édition pour en ajouter.</p>
            )}
          </div>
        ) : (
          lines.map((line) => (
            <LineCard
              key={line.IDpiece_transfert}
              line={line}
              canRemove={canMutatePieces}
              onRemove={() => removeMut.mutate(line.IDpiece_transfert)}
              isRemoving={removeMut.isPending}
            />
          ))
        )}

        {/* Row-add affordance, §7.1: last child of the scroll container so it
            always sits right under the last row. */}
        {canMutatePieces && lines.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onPickerOpenChange(true)}
            className="w-full text-muted-foreground hover:text-accent hover:bg-accent/5 border border-dashed border-border/60 hover:border-accent/40"
          >
            <Pencil className="h-3.5 w-3.5 mr-1.5" />{EDIT_BON_LABEL}
          </Button>
        )}
      </div>

      {/* Picker — available stock at the source magasin, in a modal.
          Mounted only while open so the search and selection reset each time. */}
      {pickerOpen && canMutatePieces && (
        <PickerDialog
          kind={kind}
          transfert={transfert}
          onClose={() => onPickerOpenChange(false)}
          onMutationSuccess={onMutationSuccess}
          onRemovePiece={(pieceId) => removeMut.mutate(pieceId)}
          isRemovingPiece={removeMut.isPending}
        />
      )}

      {/* Totals footer pinned at the bottom */}
      <div className="flex-shrink-0 mt-3 pt-3 border-t border-border/60 flex items-center gap-4">
        <span className="text-sm text-muted-foreground tabular-nums">
          {totals.nb} {kind === 'rouleaux' ? `pièce${totals.nb > 1 ? 's' : ''}` : `lot${totals.nb > 1 ? 's' : ''}`}
        </span>
        <span className="text-sm font-semibold tabular-nums">{fmtNum(totals.poids, 1)} kg</span>
        {kind === 'rouleaux' && (
          <span className="text-sm font-semibold tabular-nums">{fmtNum(totals.metrage, 1)} Ml</span>
        )}
      </div>
    </div>
  )
}

function LineCard({
  line, canRemove, onRemove, isRemoving,
}: {
  line: TransfertLine
  canRemove: boolean
  onRemove: () => void
  isRemoving: boolean
}) {
  const isFil = line.type === 'fil'
  const Icon = isFil ? BobineIcon : line.type === 'tm' ? TmRollIcon : FiniRollIcon
  const title = [line.reference, line.coloris_reference].filter(Boolean).join(' · ') || '—'
  const subtitle = isFil
    ? [`Lot ${line.lot || '—'}`, (line as FilLine).fournisseur_nom].filter(Boolean).join(' · ')
    : [`N° ${(line as RouleauxLine).numero || '—'}`, (line as RouleauxLine).lot ? `Lot ${(line as RouleauxLine).lot}` : ''].filter(Boolean).join(' · ')
  const commentaire = isFil ? (line as FilLine).commentaire : null

  return (
    <div className={cn('group rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3', 'border-l-amber-400/60')}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-amber-400/10">
            <Icon className="h-3.5 w-3.5 text-amber-600" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{title}</p>
            <p className="text-[11px] text-muted-foreground truncate">{subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {!isFil && !!(line as RouleauxLine).second_choix && (
            <Badge variant="outline" className="text-[10px] py-0">2e choix</Badge>
          )}
          <span className="text-sm font-semibold tabular-nums">{fmtNum(line.poids, 1)} kg</span>
          {!isFil && (Number((line as RouleauxLine).metrage) || 0) > 0 && (
            <span className="text-xs text-muted-foreground tabular-nums">{fmtNum((line as RouleauxLine).metrage, 1)} Ml</span>
          )}
          {/* Always visible in edit mode: it's the only way to retire a piece,
              and a hover-reveal action is unreachable on the factory touchscreen. */}
          {canRemove && (
            <Button
              variant="ghost" size="icon"
              className="h-6 w-6 text-destructive hover:text-destructive hover:bg-destructive/10"
              title="Retirer du bon (retourne au magasin source)"
              disabled={isRemoving}
              onClick={(e) => { e.stopPropagation(); onRemove() }}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          )}
        </div>
      </div>
      {commentaire?.trim() && (
        <div className="flex items-start gap-1.5 mt-2 ml-9">
          <MessageSquare className="h-3 w-3 text-muted-foreground/50 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-muted-foreground italic">{commentaire.trim()}</p>
        </div>
      )}
    </div>
  )
}

// ── Picker dialog ──────────────────────────────────────

type PickerTab = 'ecru' | 'fini' | 'fil'

/** A row of the picker list: either stock still available at the source, or a
 *  piece already on the bon (rendered ticked — unticking retires it). */
interface PickerRow {
  stockId: number
  onBon: boolean
  /** piece_transfert id, present only when `onBon` — that's what DELETE takes. */
  pieceId: number
  title: string
  subtitle: string
  poids: number
  secondChoix: boolean
}

/** Accent-insensitive contains match, so the on-bon rows narrow with the same
 *  query the API applies to the available ones. */
function matchesQuery(row: PickerRow, query: string): boolean {
  if (!query) return true
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  return norm(`${row.title} ${row.subtitle}`).includes(norm(query))
}

function PickerDialog({
  kind, transfert, onClose, onMutationSuccess, onRemovePiece, isRemovingPiece,
}: {
  kind: TransfertKind
  transfert: TransfertDetail
  onClose: () => void
  onMutationSuccess: () => void
  onRemovePiece: (pieceId: number) => void
  isRemovingPiece: boolean
}) {
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<PickerTab>(kind === 'rouleaux' ? 'ecru' : 'fil')
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  // Selection is kept PER TAB and survives tab switches — a bon commonly mixes
  // tombé de métier and fini pieces, so ticking rolls on both tabs then hitting
  // Valider once must add them all. The ids can't share one Set: each tab reads
  // a different stock table (stock_ecru / stock_fini / stock_fil) and ids
  // collide across them, so a flat set would post e.g. a stock_ecru id as
  // 'fini' and transfer the wrong roll. Valider posts one group per tab.
  const [selectedByTab, setSelectedByTab] = useState<Record<PickerTab, Set<number>>>(
    () => ({ ecru: new Set(), fini: new Set(), fil: new Set() }),
  )
  const selected = selectedByTab[activeTab]
  const [addError, setAddError] = useState<string | null>(null)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])

  useEffect(() => { setAddError(null) }, [activeTab])

  const { data: available, isLoading } = useQuery<AvailablePayload>({
    queryKey: ['transfert-available', kind, transfert.id, debouncedQ],
    queryFn: () => apiFetch(`/transferts/${kind}/${transfert.id}/available?q=${encodeURIComponent(debouncedQ)}`),
  })

  const candidates: Array<AvailableRoll | AvailableFilLot> = useMemo(() => {
    if (!available) return []
    if (kind === 'fils') return available.fil ?? []
    return activeTab === 'ecru' ? (available.ecru ?? []) : (available.fini ?? [])
  }, [available, kind, activeTab])

  // Pieces already on the bon for the active tab. They sit at the DESTINATION
  // magasin, so the /available endpoint never returns them — they're merged in
  // from the detail payload and rendered ticked at the top of the list.
  const onBonRows: PickerRow[] = useMemo(() => {
    const wanted = activeTab === 'ecru' ? 'tm' : activeTab === 'fini' ? 'fini' : 'fil'
    return transfert.lines
      .filter((l) => l.type === wanted)
      .map((l) => {
        const isFil = l.type === 'fil'
        const roll = l as RouleauxLine
        return {
          stockId: l.stock_id,
          onBon: true,
          pieceId: l.IDpiece_transfert,
          title: [l.reference, l.coloris_reference].filter(Boolean).join(' · ') || '—',
          subtitle: isFil
            ? [`Lot ${l.lot || '—'}`, (l as FilLine).fournisseur_nom].filter(Boolean).join(' · ')
            : [`N° ${roll.numero || '—'}`, roll.lot ? `Lot ${roll.lot}` : ''].filter(Boolean).join(' · '),
          poids: Number(l.poids) || 0,
          secondChoix: !isFil && !!roll.second_choix,
        }
      })
      .filter((r) => matchesQuery(r, debouncedQ))
  }, [transfert.lines, activeTab, debouncedQ])

  const availableRows: PickerRow[] = useMemo(() => candidates.map((c) => {
    const isFil = kind === 'fils'
    const roll = c as AvailableRoll
    const filLot = c as AvailableFilLot
    return {
      stockId: c.stock_id,
      onBon: false,
      pieceId: 0,
      title: [c.reference, c.coloris_reference].filter(Boolean).join(' · ') || '—',
      subtitle: isFil
        ? [`Lot ${filLot.lot || '—'}`, filLot.fournisseur_nom].filter(Boolean).join(' · ')
        : [`N° ${roll.numero || '—'}`, roll.lot ? `Lot ${roll.lot}` : ''].filter(Boolean).join(' · '),
      poids: Number(c.poids) || 0,
      secondChoix: !isFil && !!roll.second_choix,
    }
  }), [candidates, kind])

  // On-bon first: they're the bon's current content, the rest is what can join it.
  const rows: PickerRow[] = useMemo(() => [...onBonRows, ...availableRows], [onBonRows, availableRows])

  // Weight lookup across every candidate ever loaded this session — the
  // selection survives a search narrowing and a tab switch, so the summary must
  // too. Keyed `tab:stockId` because ids collide across the stock tables.
  const poidsByIdRef = useRef(new Map<string, number>())
  useEffect(() => {
    for (const c of candidates) poidsByIdRef.current.set(`${activeTab}:${c.stock_id}`, Number(c.poids) || 0)
  }, [candidates, activeTab])

  const addMut = useMutation({
    // One PUT per tab: the endpoint takes a single `type`, and each tab's ids
    // belong to a different stock table. Sequential, so the second group sees
    // the stock already moved by the first.
    mutationFn: async (groups: Array<{ type: PickerTab; stockIds: number[] }>) => {
      let lines: TransfertLine[] | null = null
      let added = 0
      let skipped = 0
      let lastError: string | null = null
      for (const g of groups) {
        try {
          const r: { lines: TransfertLine[]; added: number; skipped: number } =
            await apiFetch(`/transferts/${kind}/${transfert.id}/pieces`, { method: 'PUT', body: JSON.stringify(g) })
          lines = r.lines
          added += r.added
          skipped += r.skipped
        } catch (e) {
          // A group whose pieces all left the source magasin meanwhile answers
          // 409 — count it as skipped instead of aborting the other group.
          skipped += g.stockIds.length
          lastError = e instanceof Error ? e.message : 'Erreur'
        }
      }
      if (lines === null) throw new Error(lastError ?? 'Erreur')
      return { lines, added, skipped }
    },
    onSuccess: (payload: { lines: TransfertLine[]; added: number; skipped: number }) => {
      queryClient.setQueryData<TransfertDetail>(['transfert', kind, transfert.id], (old) => old ? { ...old, lines: payload.lines } : old)
      queryClient.invalidateQueries({ queryKey: ['transferts'] })
      queryClient.invalidateQueries({ queryKey: ['transfert-available', kind, transfert.id] })
      setSelectedByTab({ ecru: new Set(), fini: new Set(), fil: new Set() })
      onMutationSuccess()
      // Valider closes the dialog — unless some pieces couldn't be applied, in
      // which case we stay open so the warning is actually read.
      if (payload.skipped > 0) {
        const p = payload.skipped > 1 ? 's' : ''
        setAddError(
          `${payload.added} ajoutée${payload.added > 1 ? 's' : ''}. ${payload.skipped} ignorée${p} : ` +
          `plus au magasin ${transfert.source_nom || 'source'} au moment de la validation (déplacée${p} entre-temps).`,
        )
      } else {
        setAddError(null)
        onClose()
      }
    },
    onError: (e: unknown) => setAddError(e instanceof Error ? e.message : 'Erreur'),
  })

  const toggle = useCallback((id: number) => {
    setSelectedByTab((prev) => {
      const next = new Set(prev[activeTab])
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { ...prev, [activeTab]: next }
    })
  }, [activeTab])

  const selectAllVisible = useCallback(() => {
    setSelectedByTab((prev) => {
      const next = new Set(prev[activeTab])
      const allSelected = candidates.length > 0 && candidates.every((c) => next.has(c.stock_id))
      if (allSelected) candidates.forEach((c) => next.delete(c.stock_id))
      else candidates.forEach((c) => next.add(c.stock_id))
      return { ...prev, [activeTab]: next }
    })
  }, [candidates, activeTab])

  // Queued totals span every tab — the footer has to account for rolls ticked
  // on the tab the user isn't looking at, or Valider looks like a no-op.
  const selectedTotal = useMemo(() => {
    let count = 0
    let poids = 0
    for (const tab of Object.keys(selectedByTab) as PickerTab[]) {
      for (const id of selectedByTab[tab]) {
        count += 1
        poids += poidsByIdRef.current.get(`${tab}:${id}`) ?? 0
      }
    }
    return { count, poids }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedByTab, candidates])

  const tabs: { key: PickerTab; label: string }[] = kind === 'rouleaux'
    ? [{ key: 'ecru', label: 'Tombé de métier' }, { key: 'fini', label: 'Fini' }]
    : [{ key: 'fil', label: 'Stock fil disponible' }]

  const capped = candidates.length >= (available?.cap ?? Infinity)

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-3xl h-[80vh] flex flex-col" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-5 w-5 text-accent" />
            {EDIT_BON_LABEL}
          </DialogTitle>
          <DialogDescription>
            Ajouts et retraits déplacent le stock immédiatement entre {transfert.source_nom || '—'} et {transfert.destination_nom || '—'}.
          </DialogDescription>
        </DialogHeader>

        <div className="mt-4 flex-1 min-h-0 flex flex-col rounded-lg border border-border/60 overflow-hidden bg-zinc-100/80">
          {/* Top strip: tabs + search */}
          <div className="flex-shrink-0 flex items-center border-b bg-zinc-200/50 p-1 gap-1">
            {tabs.map((t) => {
              const active = activeTab === t.key
              const TabIcon = t.key === 'ecru' ? TmRollIcon : t.key === 'fini' ? FiniRollIcon : BobineIcon
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setActiveTab(t.key)}
                  className={cn(
                    'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer',
                    active ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10',
                  )}
                >
                  <TabIcon className="h-3.5 w-3.5" />
                  <span>{t.label}</span>
                </button>
              )
            })}
            <div className="ml-auto flex items-center pr-1">
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <input
                  type="text"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="N°, lot, référence…"
                  autoComplete="off"
                  className="h-7 w-44 pl-7 pr-2 text-xs rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
          </div>

          {/* Rows: what's already on the bon (ticked, at the top) then what can
              still be added from the source magasin. */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5 scrollbar-transparent">
            {isLoading ? (
              <div className="flex items-center justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-accent" /></div>
            ) : rows.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                <Search className="h-8 w-8 mb-2 opacity-40" />
                <p className="text-xs">Aucun stock disponible chez {transfert.source_nom || '—'}</p>
              </div>
            ) : (<>
              {rows.map((r) => {
                // Ticked means "on the bon" for existing pieces, "queued for the
                // Ajouter button" for available ones.
                const isChecked = r.onBon || selected.has(r.stockId)
                const busy = r.onBon && isRemovingPiece
                return (
                  <div
                    key={r.onBon ? `bon-${r.pieceId}` : `stock-${r.stockId}`}
                    onClick={() => { if (r.onBon) onRemovePiece(r.pieceId); else toggle(r.stockId) }}
                    title={r.onBon ? 'Sur le bon — décochez pour le retirer (retour au magasin source)' : undefined}
                    className={cn(
                      'flex items-center gap-2.5 px-2.5 py-2 rounded-lg border bg-card shadow-sm cursor-pointer transition-colors',
                      isChecked ? 'border-accent ring-1 ring-accent bg-accent/[0.04]' : 'border-border/60 hover:border-accent/40',
                      busy && 'opacity-60 pointer-events-none',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => { if (r.onBon) onRemovePiece(r.pieceId); else toggle(r.stockId) }}
                      onClick={(e) => e.stopPropagation()}
                      className="h-4 w-4 rounded border-input text-accent focus:ring-2 focus:ring-ring cursor-pointer flex-shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{r.title}</p>
                      <p className="text-[11px] text-muted-foreground truncate">{r.subtitle}</p>
                    </div>
                    {r.onBon && (
                      <Badge variant="outline" className="text-[10px] py-0 flex-shrink-0 border-accent/40 text-accent">Sur le bon</Badge>
                    )}
                    {r.secondChoix && (
                      <Badge variant="outline" className="text-[10px] py-0 flex-shrink-0">2e choix</Badge>
                    )}
                    <span className="text-sm tabular-nums flex-shrink-0">{fmtNum(r.poids, 1)} kg</span>
                  </div>
                )
              })}
              {capped && (
                <p className="text-[11px] text-muted-foreground text-center py-1.5">
                  Les {available?.cap} plus récents sont affichés — affinez la recherche pour en voir d'autres.
                </p>
              )}
            </>)}
          </div>

          {/* Bottom strip: select-all over the addable rows + queued summary */}
          <div className="flex-shrink-0 border-t bg-zinc-200/50 px-2.5 py-2 flex items-center gap-2">
            <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-foreground" onClick={selectAllVisible}>
              <CheckSquare className="h-3.5 w-3.5 mr-1.5" />Tout sélectionner
            </Button>
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              {onBonRows.length} sur le bon · {selectedTotal.count} à ajouter ({fmtNum(selectedTotal.poids, 1)} kg)
            </span>
          </div>
        </div>

        <DialogFooter className="mt-4 items-center gap-2 sm:justify-between sm:space-x-0">
          <span className="text-xs text-destructive truncate">{addError}</span>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button variant="outline" onClick={onClose}>Fermer</Button>
            <Button
              disabled={addMut.isPending}
              onClick={() => {
                // Nothing queued (or only untick-removals, which already applied)
                // — Valider is just a confirm-and-close in that case.
                const groups = (Object.keys(selectedByTab) as PickerTab[])
                  .filter((t) => selectedByTab[t].size > 0)
                  .map((t) => ({ type: t, stockIds: Array.from(selectedByTab[t]) }))
                if (groups.length === 0) { onClose(); return }
                addMut.mutate(groups)
              }}
            >
              {addMut.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />}
              Valider
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Right sidebar ──────────────────────────────────────

function DetailSidebar({
  kind, transfert, isLoading, isEditing,
  editIDSource, onEditIDSourceChange,
  editIDDestination, onEditIDDestinationChange,
  editIDAdresse, onEditIDAdresseChange,
  editIDTransporteur, onEditIDTransporteurChange,
  editDate, onEditDateChange,
  editCommentaire, onEditCommentaireChange,
}: {
  kind: TransfertKind
  transfert: TransfertDetail | null
  isLoading: boolean
  isEditing: boolean
  editIDSource: number; onEditIDSourceChange: (v: number) => void
  editIDDestination: number; onEditIDDestinationChange: (v: number) => void
  editIDAdresse: number; onEditIDAdresseChange: (v: number) => void
  editIDTransporteur: number; onEditIDTransporteurChange: (v: number) => void
  editDate: string; onEditDateChange: (v: string) => void
  editCommentaire: string; onEditCommentaireChange: (v: string) => void
}) {
  const { data: magasins } = useQuery<MagasinLite[]>({
    queryKey: ['transferts-magasins'], queryFn: () => apiFetch('/transferts/lookups/magasins'), enabled: isEditing,
  })
  const { data: transporteurs } = useQuery<TransporteurLite[]>({
    queryKey: ['transferts-transporteurs'], queryFn: () => apiFetch('/transferts/lookups/transporteurs'), enabled: isEditing,
  })
  const adresseMagasin = isEditing ? editIDDestination : (transfert?.IDmagasin_destination ?? 0)
  const { data: adresses } = useQuery<AdresseLookup[]>({
    queryKey: ['transferts-adresses', adresseMagasin],
    queryFn: () => apiFetch(`/transferts/lookups/adresses?magasin=${adresseMagasin}`),
    enabled: isEditing && adresseMagasin >= 0,
  })

  // When the destination changes in edit mode, snap the address to the new
  // destination's default once its addresses load.
  const prevDestRef = useRef(editIDDestination)
  useEffect(() => {
    if (!isEditing) { prevDestRef.current = editIDDestination; return }
    if (prevDestRef.current !== editIDDestination) {
      prevDestRef.current = editIDDestination
      onEditIDAdresseChange(0)
    }
  }, [isEditing, editIDDestination, onEditIDAdresseChange])
  useEffect(() => {
    if (isEditing && editIDAdresse === 0 && adresses && adresses.length > 0) {
      onEditIDAdresseChange(adresses[0].IDadresse)
    }
  }, [isEditing, editIDAdresse, adresses, onEditIDAdresseChange])

  if (isLoading) return (
    <div className="w-96 flex-shrink-0 flex flex-col gap-3 min-h-0">
      <div className="flex-1 bg-muted/30 rounded-xl border p-4 space-y-4">
        {[1, 2, 3].map((i) => <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />)}
      </div>
    </div>
  )
  if (!transfert) return null

  const hasLines = transfert.lines.length > 0
  const magasinOptions: MagasinLite[] = [ETS_MALTERRE, ...(magasins ?? [])]

  return (
    <div className="w-96 flex-shrink-0 flex flex-col gap-3 min-h-0">
      <div className="flex-1 min-h-0 rounded-xl border flex flex-col overflow-hidden bg-zinc-100/80">
        <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-transparent">
          <div className={cn('p-3 rounded-lg border bg-card shadow-sm space-y-2', isEditing && editSectionClass)}>
            <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 mb-1"><Info className="h-3.5 w-3.5" />Transfert</p>
            <KV label="Magasin source" value={isEditing ? (
              <MagasinSelect
                options={magasinOptions}
                value={editIDSource}
                onChange={onEditIDSourceChange}
                disabled={hasLines}
                disabledTitle="Le bon contient des pièces — retirez-les avant de changer la source."
              />
            ) : (transfert.source_nom || '—')} />
            <KV label="Magasin destination" value={isEditing ? (
              <MagasinSelect
                options={magasinOptions}
                value={editIDDestination}
                onChange={onEditIDDestinationChange}
                disabled={hasLines}
                disabledTitle="Le bon contient des pièces — retirez-les avant de changer la destination."
              />
            ) : (transfert.destination_nom || '—')} />
            <KV label="Date" value={isEditing ? (
              <input type="date" value={editDate} onChange={(e) => onEditDateChange(e.target.value)}
                className="h-7 px-2 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring text-right" />
            ) : (transfert.date ? formatHfsqlDate(transfert.date) : '—')} />
            <KV label="Transporteur" value={isEditing ? (
              <PopoverSelect size="sm" options={(transporteurs ?? []).map((t) => ({ id: t.IDtransporteur, primary: t.nom }))}
                value={editIDTransporteur} onChange={onEditIDTransporteurChange} emptyLabel="—" />
            ) : (transfert.transporteur_nom || '—')} />
            <KV label="Contenu" value={kind === 'rouleaux' ? 'Rouleaux (TM / fini)' : 'Lots de fil'} />
          </div>

          <AdresseCard
            adresse={transfert.adresse_destination}
            isEditing={isEditing}
            options={adresses ?? []}
            selectedId={editIDAdresse}
            onSelect={onEditIDAdresseChange}
          />

          <div className={cn('p-3 rounded-lg border bg-card shadow-sm', isEditing && editSectionClass)}>
            <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5 mb-2"><MessageSquare className="h-3.5 w-3.5" />Commentaire</p>
            {isEditing ? (
              <textarea value={editCommentaire} onChange={(e) => onEditCommentaireChange(e.target.value)} rows={3}
                placeholder="Commentaire interne…"
                className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y" />
            ) : (
              transfert.commentaire?.trim()
                ? <p className="text-sm text-muted-foreground whitespace-pre-line">{transfert.commentaire}</p>
                : <p className="text-sm text-muted-foreground italic">Aucun commentaire</p>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** PopoverSelect over the magasins list. Magasin id 0 (Ets Malterre) is a
 *  legitimate value but PopoverSelect reserves 0 as the "none" sentinel — the
 *  options are offset by +1 and mapped back on change. */
function MagasinSelect({
  options, value, onChange, disabled, disabledTitle,
}: {
  options: MagasinLite[]
  value: number
  onChange: (id: number) => void
  disabled?: boolean
  disabledTitle?: string
}) {
  return (
    <PopoverSelect
      size="sm"
      options={options.map((m) => ({ id: m.id + 1, primary: m.nom }))}
      value={value + 1}
      onChange={(v) => onChange(v - 1)}
      hideEmpty
      disabled={disabled}
      disabledTitle={disabledTitle}
    />
  )
}

// ── Address card + picker ──────────────────────────────

function AdresseCard({
  adresse, isEditing, options, selectedId, onSelect,
}: {
  adresse: AdresseLite | null
  isEditing: boolean
  options: AdresseLookup[]
  selectedId: number
  onSelect: (id: number) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const displayAdresse: AdresseLite | null = isEditing ? (options.find((o) => o.IDadresse === selectedId) ?? adresse) : adresse
  return (
    <div className={cn('p-3 rounded-lg border bg-card shadow-sm', isEditing && editSectionClass)}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" />Adresse de destination</p>
        {isEditing && options.length > 1 && (
          <Button variant="outline" size="sm" className="h-6 px-2 text-[11px] gap-1" onClick={() => setPickerOpen(true)}>
            <Search className="h-3 w-3" />Choisir
          </Button>
        )}
      </div>
      {displayAdresse ? (
        <div className="text-xs text-muted-foreground space-y-0.5">
          {displayAdresse.nom && <p className="font-medium text-foreground">{displayAdresse.nom}</p>}
          {displayAdresse.adresse1 && <p>{displayAdresse.adresse1}</p>}
          {displayAdresse.adresse2 && <p>{displayAdresse.adresse2}</p>}
          {displayAdresse.adresse3 && <p>{displayAdresse.adresse3}</p>}
          {(displayAdresse.cp || displayAdresse.ville) && <p>{[displayAdresse.cp, displayAdresse.ville].filter(Boolean).join(' ')}</p>}
          {displayAdresse.pays && <p>{displayAdresse.pays}</p>}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground italic">Aucune adresse</p>
      )}
      <AdressePickerDialog open={pickerOpen} onClose={() => setPickerOpen(false)}
        options={options} selectedId={selectedId} onSelect={(id) => { onSelect(id); setPickerOpen(false) }} />
    </div>
  )
}

function AdressePickerDialog({
  open, onClose, options, selectedId, onSelect,
}: {
  open: boolean
  onClose: () => void
  options: AdresseLookup[]
  selectedId: number
  onSelect: (id: number) => void
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg space-y-4" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><MapPin className="h-5 w-5 text-accent" />Choisir une adresse de destination</DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto space-y-2 px-1">
          {options.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <MapPin className="h-10 w-10 mb-2 opacity-40" /><p className="text-sm">Aucune adresse disponible</p>
            </div>
          ) : options.map((a) => {
            const isSelected = a.IDadresse === selectedId
            return (
              <button
                key={a.IDadresse}
                type="button"
                onClick={() => onSelect(a.IDadresse)}
                className={cn('w-full text-left p-3 rounded-lg border transition-all',
                  isSelected ? 'border-accent bg-accent/5 ring-1 ring-accent' : 'border-border bg-card hover:border-accent/50 hover:bg-accent/[0.02]')}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium text-sm truncate">{a.nom || `Adresse #${a.IDadresse}`}</p>
                      {!!a.est_defaut && <Badge variant="outline" className="text-[10px] py-0">Défaut</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                      {a.adresse1 && <p className="truncate">{a.adresse1}</p>}
                      {(a.cp || a.ville) && <p>{[a.cp, a.ville].filter(Boolean).join(' ')}</p>}
                      {a.pays && <p>{a.pays}</p>}
                    </div>
                  </div>
                  {isSelected && <CheckCircle2 className="h-4 w-4 text-accent flex-shrink-0 mt-0.5" />}
                </div>
              </button>
            )
          })}
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Annuler</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Create dialog ──────────────────────────────────────

function CreateTransfertDialog({
  open, kind, onClose, onCreated,
}: {
  open: boolean
  kind: TransfertKind
  onClose: () => void
  onCreated: (newId: number) => void
}) {
  const [sourceId, setSourceId] = useState(0)
  const [destinationId, setDestinationId] = useState(-1) // -1 = not picked yet
  const [transporteurId, setTransporteurId] = useState(0)
  const [date, setDate] = useState<string>(() => new Date().toISOString().slice(0, 10))
  const [error, setError] = useState<string | null>(null)

  const { data: magasins } = useQuery<MagasinLite[]>({
    queryKey: ['transferts-magasins'], queryFn: () => apiFetch('/transferts/lookups/magasins'), enabled: open,
  })
  const { data: transporteurs } = useQuery<TransporteurLite[]>({
    queryKey: ['transferts-transporteurs'], queryFn: () => apiFetch('/transferts/lookups/transporteurs'), enabled: open,
  })

  useEffect(() => {
    if (open) {
      setSourceId(0) // legacy default: Ets Malterre ships out
      setDestinationId(-1)
      setTransporteurId(0)
      setDate(new Date().toISOString().slice(0, 10))
      setError(null)
    }
  }, [open])

  // Legacy default carrier is "Divers" — preselect it once the lookup loads.
  useEffect(() => {
    if (open && transporteurId === 0 && transporteurs) {
      const divers = transporteurs.find((t) => t.nom.trim().toLowerCase() === 'divers')
      if (divers) setTransporteurId(divers.IDtransporteur)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, transporteurs])

  const createMut = useMutation({
    mutationFn: () => apiFetch(`/transferts/${kind}`, {
      method: 'POST',
      body: JSON.stringify({
        IDmagasin_source: sourceId,
        IDmagasin_destination: destinationId,
        IDtransporteur: transporteurId || 0,
        date: inputDateToHfsql(date),
      }),
    }),
    onSuccess: (data: { id: number }) => onCreated(data.id),
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Erreur'),
  })

  const magasinOptions: MagasinLite[] = [ETS_MALTERRE, ...(magasins ?? [])]
  const canSave = destinationId >= 0 && sourceId !== destinationId

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Truck className="h-5 w-5 text-accent" />
            {kind === 'rouleaux' ? 'Nouveau transfert de rouleaux' : 'Nouveau transfert de fils'}
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Magasin source</label>
            <PopoverSelect
              options={magasinOptions.map((m) => ({ id: m.id + 1, primary: m.nom }))}
              value={sourceId + 1}
              onChange={(v) => setSourceId(v - 1)}
              hideEmpty
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Magasin destination</label>
            <PopoverSelect
              options={magasinOptions.map((m) => ({ id: m.id + 1, primary: m.nom }))}
              value={destinationId + 1}
              onChange={(v) => setDestinationId(v - 1)}
              emptyLabel="Choisir la destination"
            />
            {destinationId >= 0 && destinationId === sourceId && (
              <p className="text-[11px] text-destructive">La source et la destination doivent être différentes.</p>
            )}
            <p className="text-[11px] text-muted-foreground">L'adresse de destination sera pré-remplie avec l'adresse par défaut.</p>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Transporteur</label>
            <PopoverSelect
              options={(transporteurs ?? []).map((t) => ({ id: t.IDtransporteur, primary: t.nom }))}
              value={transporteurId}
              onChange={setTransporteurId}
              emptyLabel="—"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Date</label>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={cn(inputClass, 'h-9')} />
          </div>

          {error && (
            <div className="flex items-start gap-1.5 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" /><span>{error}</span>
            </div>
          )}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={() => createMut.mutate()} disabled={!canSave || createMut.isPending}>
            {createMut.isPending ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Création...</> : <><Save className="h-3.5 w-3.5 mr-1.5" />Créer</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Shared bits ────────────────────────────────────────

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm text-right truncate">{value}</span>
    </div>
  )
}
