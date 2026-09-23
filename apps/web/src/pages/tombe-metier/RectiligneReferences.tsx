// Tombé Métier › Références, « Rectiligne » mode (LIVA #1185) — the cols and
// bandes TRM knits on its flat-bed machine. Port of the legacy
// FI_Ref_TombéMetier rectiligne branch (SEL_TypeRef), FEN_Gestion_Guide_Fil
// and FEN_Gestion_Coloris_Guide_Fil. API: routes/references-rectiligne.ts,
// rules: lib/rectiligne.ts.
//
// ⚠️ This file is rendered by TRM too (TombeMetierReferences.tsx is imported
// through `@etm`), where `@/…` resolves to TRM's own src. Only import `@/`
// modules the circular screen already imports — both apps have them.
import { useState, useMemo, useEffect, useCallback, useRef, type ReactNode, type ComponentType } from 'react'
import { useQuery, useQueries, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Search, Loader2, AlertCircle, Pencil, Plus, X, Save, Trash2, Info, Copy, Archive, ArchiveRestore,
  Palette, Layers, Printer, AtSign, Mail, Spline, ClipboardList,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { PopoverSelect, SearchableCombobox } from '@/components/ui/popover-select'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { UnsavedChangesDialog } from '@/components/shared/UnsavedChangesDialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import { cn } from '@/lib/utils'
import { apiFetch } from '@/lib/api'
import { fmtNum } from '@/lib/format'
import { formatHfsqlDate } from '@/lib/dates'

// ── Types ──────────────────────────────────────────────

interface RectiListRow {
  IDref_rectiligne: number
  reference: string
  designation: string
  prix: number
  unite: number
  archive: number
  coloris_count: number
  montage_count: number
}

interface Guide {
  IDguide_fil_rectiligne: number
  montage: number
  IDref_fil: number
  fil: string
  nb_fil: number
  /** percent (99.5) */
  pct: number
}

interface ColorisFil { IDguide_fil_rectiligne: number; IDcolori_fil: number; colori: string }
interface Coloris { IDcoloris_rectiligne: number; coloris: string; fils: ColorisFil[] }

interface RectiDetail {
  IDref_rectiligne: number
  reference: string
  designation: string
  programme: string
  nb_aiguilles: number
  prix: number
  unite: number
  commentaire: string
  archive: number
  montages: number[]
  guides: Guide[]
  coloris: Coloris[]
  usage: { sst: number; trm: number }
  commandes: Array<{ IDcommande_sous_traitant: number; date_commande: string; coloris: string; quantite: number; prix: number }>
}

interface RefFil { IDref_fil: number; reference: string }
interface ColoriFil { IDcolori_fil: number; reference: string }

interface Draft {
  reference: string
  designation: string
  programme: string
  nb_aiguilles: string
  prix: string
  unite: number
  commentaire: string
}

export type RefKind = 'circulaire' | 'rectiligne'

/** ref_rectiligne.unite — same enum as the order lines (1 Kg, 3 Ml, 4 unité,
 *  5 m²); 32 of the 33 references are 4, R005 « Côte 1/1 toute laize » is 1. */
const UNITES = [
  { id: 4, primary: 'Pièce (U)', short: 'U' },
  { id: 1, primary: 'Kilo (Kg)', short: 'Kg' },
  { id: 3, primary: 'Mètre linéaire (Ml)', short: 'Ml' },
  { id: 5, primary: 'Mètre carré (m²)', short: 'm²' },
]
const uniteShort = (u: number) => UNITES.find((x) => x.id === u)?.short ?? 'U'

const inputClass =
  'w-full h-8 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring'
const editSectionClass = 'border-l-4 border-l-accent/70 bg-accent/[0.03]'

/** Server's French reason off an apiFetch error (`err.body.message`). */
function apiMessage(err: unknown, fallback: string): string {
  const body = (err as { body?: { message?: unknown } } | null)?.body
  return typeof body?.message === 'string' ? body.message : fallback
}

// ── Circulaire / Rectiligne switch (legacy SEL_TypeRef) ─

/** The two catalogs of Tombé Métier › Références. Rendered at the top of the
 *  left list of both modes; each mode routes the click through its own
 *  unsaved-changes guard. */
export function RefKindSwitch({ kind, onChange }: { kind: RefKind; onChange: (k: RefKind) => void }) {
  const opts: { key: RefKind; label: string }[] = [
    { key: 'circulaire', label: 'Circulaire' },
    { key: 'rectiligne', label: 'Rectiligne' },
  ]
  return (
    <div className="flex gap-1 rounded-md bg-white/70 p-0.5 border border-border/60">
      {opts.map((o) => (
        <button
          key={o.key}
          type="button"
          onClick={() => { if (o.key !== kind) onChange(o.key) }}
          className={cn(
            'flex-1 px-2 py-1 text-xs rounded transition-colors',
            kind === o.key ? 'bg-primary text-primary-foreground shadow-sm font-medium' : 'text-muted-foreground hover:bg-accent/10',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ── Page ───────────────────────────────────────────────

const emptyDraft = (): Draft => ({ reference: '', designation: '', programme: '', nb_aiguilles: '', prix: '', unite: 4, commentaire: '' })
const draftOf = (d: RectiDetail): Draft => ({
  reference: d.reference,
  designation: d.designation,
  programme: d.programme,
  nb_aiguilles: d.nb_aiguilles ? String(d.nb_aiguilles) : '',
  prix: d.prix ? String(d.prix) : '',
  unite: d.unite || 4,
  commentaire: d.commentaire,
})

export function RectiligneReferences({ onKindChange }: { onKindChange: (k: RefKind) => void }) {
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [archivedFilter, setArchivedFilter] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState<Draft>(emptyDraft())
  const originalDraftRef = useRef<Draft | null>(null)
  const [autoEditForId, setAutoEditForId] = useState<number | null>(null)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [printOpen, setPrintOpen] = useState(false)
  const [emailOpen, setEmailOpen] = useState(false)

  const { data: refs, isLoading, isError, error } = useQuery<RectiListRow[]>({
    queryKey: ['refs-rectiligne', archivedFilter ? 'archive' : 'en_cours'],
    queryFn: () => apiFetch(`/references-rectiligne?archived=${archivedFilter ? 1 : 0}`),
  })
  const { data: detail, isLoading: detailLoading } = useQuery<RectiDetail>({
    queryKey: ['ref-rectiligne', selectedId],
    queryFn: () => apiFetch(`/references-rectiligne/${selectedId}`),
    enabled: selectedId !== null,
  })

  const filtered = useMemo(() => {
    if (!refs) return []
    const tokens = searchQuery.toLowerCase().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return refs
    return refs.filter((r) => {
      const hay = `${r.reference} ${r.designation}`.toLowerCase()
      return tokens.every((t) => hay.includes(t))
    })
  }, [refs, searchQuery])

  useAutoSelectFirst({
    rows: filtered,
    selectedId,
    getId: (r) => r.IDref_rectiligne,
    select: setSelectedId,
    suspended: isEditing || autoEditForId !== null,
  })

  const startEdit = useCallback(() => {
    if (!detail) return
    const snap = draftOf(detail)
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
    if (!isEditing || !originalDraftRef.current) return false
    return JSON.stringify(draft) !== JSON.stringify(originalDraftRef.current)
  }, [isEditing, draft])

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['ref-rectiligne', selectedId] })
    queryClient.invalidateQueries({ queryKey: ['refs-rectiligne'] })
  }, [queryClient, selectedId])

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/references-rectiligne/${selectedId}`, {
        method: 'PUT',
        body: JSON.stringify({
          reference: draft.reference.trim(),
          designation: draft.designation,
          programme: draft.programme,
          nb_aiguilles: Number(draft.nb_aiguilles) || 0,
          prix: Number(String(draft.prix).replace(',', '.')) || 0,
          unite: draft.unite,
          commentaire: draft.commentaire,
        }),
      }),
    onSuccess: () => {
      invalidate()
      setIsEditing(false)
      originalDraftRef.current = null
    },
    onError: (err) => setSaveError(apiMessage(err, "L'enregistrement de la référence a échoué. Veuillez réessayer.")),
  })

  const selectCreated = useCallback((id: number | null) => {
    setArchivedFilter(false)
    queryClient.invalidateQueries({ queryKey: ['refs-rectiligne'] })
    if (id) {
      setSelectedId(id)
      setAutoEditForId(id)
    }
  }, [queryClient])

  const createMutation = useMutation({
    mutationFn: () => apiFetch<{ IDref_rectiligne: number }>(`/references-rectiligne`, { method: 'POST', body: '{}' }),
    onSuccess: (d) => selectCreated(d.IDref_rectiligne),
  })
  const duplicateMutation = useMutation({
    mutationFn: () => apiFetch<{ IDref_rectiligne: number }>(`/references-rectiligne/${selectedId}/duplicate`, { method: 'POST' }),
    onSuccess: (d) => selectCreated(d.IDref_rectiligne),
  })

  /** Leave the current row after it left the visible list (archive / delete):
   *  read the cache BEFORE invalidating (§25.2). */
  const selectNextAfter = useCallback((goneId: number) => {
    const cached = queryClient.getQueryData<RectiListRow[]>(['refs-rectiligne', archivedFilter ? 'archive' : 'en_cours']) ?? []
    const remaining = cached.filter((r) => r.IDref_rectiligne !== goneId)
    queryClient.invalidateQueries({ queryKey: ['refs-rectiligne'] })
    setSelectedId(remaining.length > 0 ? remaining[0].IDref_rectiligne : null)
  }, [queryClient, archivedFilter])

  const archiveMutation = useMutation({
    mutationFn: (archive: boolean) =>
      apiFetch(`/references-rectiligne/${selectedId}/${archive ? 'archive' : 'unarchive'}`, { method: 'POST' }),
    onSuccess: () => {
      if (selectedId !== null) {
        queryClient.invalidateQueries({ queryKey: ['ref-rectiligne', selectedId] })
        selectNextAfter(selectedId)
      }
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/references-rectiligne/${id}`, { method: 'DELETE' }),
    onSuccess: (_d, id) => {
      setDeleteConfirmOpen(false)
      setIsEditing(false)
      originalDraftRef.current = null
      queryClient.removeQueries({ queryKey: ['ref-rectiligne', id] })
      selectNextAfter(id)
    },
    onError: (err) => setDeleteError(apiMessage(err, 'Suppression impossible.')),
  })

  // §25.1 auto-edit after create / duplicate
  useEffect(() => {
    if (autoEditForId !== null && detail?.IDref_rectiligne === autoEditForId) {
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

  return (
    <>
      <MasterDetailLayout
        list={
          <RectiList
            refs={filtered}
            isLoading={isLoading}
            isError={isError}
            error={error as Error | null}
            selectedId={selectedId}
            onSelect={handleSelect}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            archivedFilter={archivedFilter}
            onArchivedFilterChange={(v) => guard.guardAction(() => { setIsEditing(false); setArchivedFilter(v) })}
            kindSwitch={<RefKindSwitch kind="rectiligne" onChange={(k) => guard.guardAction(() => { setIsEditing(false); onKindChange(k) })} />}
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
            onChanged={invalidate}
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
        description={deleteError ?? 'Cette action supprimera la référence rectiligne, ses montages, ses guides-fil et ses coloris. Elle est irréversible.'}
        isPending={deleteMutation.isPending}
        onCancel={() => { setDeleteConfirmOpen(false); setDeleteError(null) }}
        onConfirm={() => { if (selectedId !== null) deleteMutation.mutate(selectedId) }}
      />

      <MessageDialog open={saveError !== null} title="Enregistrement impossible" message={saveError} onClose={() => setSaveError(null)} />
      <PlaceholderDialog open={printOpen} onClose={() => setPrintOpen(false)} title="Imprimer" TriggerIcon={Printer} CenterIcon={Printer} />
      <PlaceholderDialog open={emailOpen} onClose={() => setEmailOpen(false)} title="Envoyer un email" TriggerIcon={AtSign} CenterIcon={Mail} />
    </>
  )
}

// ── Left list ──────────────────────────────────────────

function RectiList({
  refs, isLoading, isError, error, selectedId, onSelect, searchQuery, onSearchChange,
  archivedFilter, onArchivedFilterChange, kindSwitch, onNew, isCreating, isEditing,
}: {
  refs: RectiListRow[]
  isLoading: boolean
  isError: boolean
  error: Error | null
  selectedId: number | null
  onSelect: (id: number) => void
  searchQuery: string
  onSearchChange: (q: string) => void
  archivedFilter: boolean
  onArchivedFilterChange: (v: boolean) => void
  kindSwitch: ReactNode
  onNew: () => void
  isCreating: boolean
  isEditing: boolean
}) {
  const selectedRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => { selectedRef.current?.scrollIntoView({ block: 'nearest' }) }, [selectedId, refs])
  const activeKey = archivedFilter ? 'archive' : 'en_cours'
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
          {([['en_cours', 'En cours'], ['archive', 'Archivé']] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => onArchivedFilterChange(key === 'archive')}
              className={cn(
                'px-2 py-1 text-xs rounded-md transition-colors flex-grow basis-[calc(50%-0.25rem)]',
                activeKey === key ? 'bg-accent text-accent-foreground shadow-sm font-medium' : 'text-muted-foreground hover:bg-accent/10',
              )}
            >
              {label}
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
        ) : refs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Spline className="h-12 w-12 mb-3 opacity-50" />
            <p className="text-sm">Aucune référence</p>
          </div>
        ) : (
          refs.map((r) => (
            <div
              key={r.IDref_rectiligne}
              ref={selectedId === r.IDref_rectiligne ? selectedRef : undefined}
              onClick={() => onSelect(r.IDref_rectiligne)}
              className={cn(
                'p-3 border rounded-lg cursor-pointer transition-all bg-white',
                selectedId === r.IDref_rectiligne ? 'border-accent ring-1 ring-accent' : 'border-border hover:border-accent/50',
              )}
            >
              <div className="flex items-center gap-2 min-w-0">
                <Spline className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <p className="font-medium text-sm truncate flex-1">{r.reference || '—'}</p>
              </div>
              {r.designation && <p className="text-xs text-muted-foreground mt-0.5 truncate">{r.designation}</p>}
              <div className="flex items-center justify-between gap-2 mt-1 text-[11px] text-muted-foreground">
                <span className="truncate">{r.coloris_count} coloris</span>
                {r.prix > 0 && <span className="flex-shrink-0 tabular-nums">{fmtNum(r.prix, 2)} €/{uniteShort(r.unite)}</span>}
              </div>
            </div>
          ))
        )}
      </div>
      <div className="p-3 border-t text-xs text-muted-foreground flex items-center justify-between rounded-b-lg bg-zinc-200/50">
        <span>{refs.length} référence{refs.length !== 1 ? 's' : ''}</span>
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

// ── Detail header ──────────────────────────────────────

function DetailHeader({
  detail, isLoading, isEditing, draft, onDraftChange, onStartEdit, onCancelEdit, onSave, isSaving,
  onDelete, onArchive, isArchiving, onDuplicate, isDuplicating, onPrint, onEmail,
}: {
  detail: RectiDetail | null
  isLoading: boolean
  isEditing: boolean
  draft: Draft
  onDraftChange: (d: Draft) => void
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
          <Spline className="h-5 w-5" />
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
              {detail?.designation && <p className="text-sm text-muted-foreground truncate mt-0.5">{detail.designation}</p>}
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
                <Button size="sm" onClick={onSave} disabled={isSaving || !draft.reference.trim()}>
                  <Save className="h-3.5 w-3.5 mr-1.5" />
                  {isSaving ? 'Enregistrement...' : 'Enregistrer'}
                </Button>
                <Button variant="outline" size="icon" className="h-9 w-9 text-destructive hover:text-destructive hover:bg-destructive/10" title="Supprimer" onClick={onDelete}>
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
                <Button variant="outline" size="icon" className="h-9 w-9" title={archived ? 'Désarchiver' : 'Archiver'} onClick={onArchive} disabled={isArchiving}>
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

// ── Detail body ────────────────────────────────────────

function DetailMain({
  detail, isLoading, hasSelection, isEditing, draft, onDraftChange, onChanged,
}: {
  detail: RectiDetail | null
  isLoading: boolean
  hasSelection: boolean
  isEditing: boolean
  draft: Draft
  onDraftChange: (d: Draft) => void
  onChanged: () => void
}) {
  // The montage shown by the guides and coloris cards. Hooks before the early
  // returns (§28.6); snaps back to the first montage when the ref changes.
  const [montage, setMontage] = useState<number>(1)
  useEffect(() => {
    if (detail && !detail.montages.includes(montage)) setMontage(detail.montages[0] ?? 1)
  }, [detail, montage])

  if (!hasSelection) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center space-y-3">
          <div className="icon-box-gold h-16 w-16 mx-auto flex items-center justify-center">
            <Spline className="h-8 w-8" />
          </div>
          <p className="text-muted-foreground text-sm">Sélectionnez une référence dans la liste</p>
        </div>
      </div>
    )
  }
  if (isLoading) {
    return <div className="flex-1 flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-accent" /></div>
  }
  if (!detail) return null
  return (
    <div className="flex-1 min-h-0 overflow-auto space-y-4 pr-1">
      <IdentificationCard detail={detail} isEditing={isEditing} draft={draft} onDraftChange={onDraftChange} />
      <MontageCard detail={detail} isEditing={isEditing} montage={montage} onMontageChange={setMontage} onChanged={onChanged} />
      <ColorisCard detail={detail} isEditing={isEditing} montage={montage} onChanged={onChanged} />
    </div>
  )
}

function IdentificationCard({ detail, isEditing, draft, onDraftChange }: {
  detail: RectiDetail
  isEditing: boolean
  draft: Draft
  onDraftChange: (d: Draft) => void
}) {
  return (
    <Card className={cn('card-premium', isEditing && editSectionClass)}>
      <CardHeader className="flex flex-row items-center gap-2 p-4 space-y-0 pb-2">
        <Info className="h-4 w-4 text-accent" />
        <CardTitle className="text-sm font-semibold">Identification</CardTitle>
      </CardHeader>
      <CardContent className="pb-4">
        {isEditing ? (
          <div className="space-y-3">
            <LabeledInput label="Désignation" value={draft.designation} onChange={(v) => onDraftChange({ ...draft, designation: v })} />
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
              <LabeledInput label="Programme" value={draft.programme} onChange={(v) => onDraftChange({ ...draft, programme: v })} />
              <LabeledInput label="Nb aiguilles" type="number" value={draft.nb_aiguilles} onChange={(v) => onDraftChange({ ...draft, nb_aiguilles: v })} />
              <LabeledInput label="Prix" suffix={`€/${uniteShort(draft.unite)}`} type="number" step="0.01" value={draft.prix} onChange={(v) => onDraftChange({ ...draft, prix: v })} />
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Unité</label>
                <PopoverSelect
                  options={UNITES.map((u) => ({ id: u.id, primary: u.primary }))}
                  value={draft.unite}
                  onChange={(id) => onDraftChange({ ...draft, unite: id || 4 })}
                  hideEmpty
                />
              </div>
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
              <Inline label="Programme" value={detail.programme || '—'} />
              <Inline label="Nb aiguilles" value={detail.nb_aiguilles ? fmtNum(detail.nb_aiguilles) : '—'} />
              <Inline label="Prix" value={detail.prix ? `${fmtNum(detail.prix, 2)} €/${uniteShort(detail.unite)}` : '—'} strong />
              <Inline label="Unité" value={UNITES.find((u) => u.id === detail.unite)?.primary ?? '—'} />
            </div>
            {detail.commentaire.trim() && (
              <p className="text-sm text-muted-foreground whitespace-pre-line pt-1">{detail.commentaire}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// ── Montage & guides-fil ───────────────────────────────

function MontageCard({ detail, isEditing, montage, onMontageChange, onChanged }: {
  detail: RectiDetail
  isEditing: boolean
  montage: number
  onMontageChange: (m: number) => void
  onChanged: () => void
}) {
  const [newMontageOpen, setNewMontageOpen] = useState(false)
  const [nbGuides, setNbGuides] = useState('2')
  const [editingGuide, setEditingGuide] = useState<Guide | null>(null)
  const [deleteGuide, setDeleteGuide] = useState<Guide | null>(null)
  const [deleteMontageOpen, setDeleteMontageOpen] = useState(false)
  const id = detail.IDref_rectiligne
  const guides = detail.guides.filter((g) => g.montage === montage)
  const totalPct = guides.reduce((s, g) => s + g.pct, 0)

  const addMontage = useMutation({
    mutationFn: (n: number) => apiFetch<{ montage: number }>(`/references-rectiligne/${id}/montages`, { method: 'POST', body: JSON.stringify({ nb_guides: n }) }),
    onSuccess: (d) => { setNewMontageOpen(false); onChanged(); onMontageChange(d.montage) },
  })
  const removeMontage = useMutation({
    mutationFn: () => apiFetch(`/references-rectiligne/${id}/montages/${montage}`, { method: 'DELETE' }),
    onSuccess: () => { setDeleteMontageOpen(false); onChanged() },
  })
  const addGuide = useMutation({
    mutationFn: () => apiFetch(`/references-rectiligne/${id}/montages/${montage}/guides`, { method: 'POST' }),
    onSuccess: onChanged,
  })
  const removeGuide = useMutation({
    mutationFn: (gid: number) => apiFetch(`/references-rectiligne/guides/${gid}`, { method: 'DELETE' }),
    onSuccess: () => { setDeleteGuide(null); onChanged() },
  })

  return (
    <Card className={cn('card-premium', isEditing && editSectionClass)}>
      <CardHeader className="flex flex-row items-center gap-2 p-4 space-y-0 pb-2">
        <Layers className="h-4 w-4 text-accent" />
        <CardTitle className="text-sm font-semibold">Guides-fil</CardTitle>
        {detail.montages.length > 1 && (
          <div className="flex gap-1 ml-2">
            {detail.montages.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onMontageChange(m)}
                className={cn(
                  'px-2 py-0.5 text-xs rounded-md transition-colors',
                  m === montage ? 'bg-accent text-accent-foreground shadow-sm font-medium' : 'text-muted-foreground hover:bg-accent/10',
                )}
              >
                Montage {m}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto flex items-center gap-2">
          {guides.length > 0 && (
            <Badge
              variant="outline"
              className={cn(
                'text-[10px] py-0 tabular-nums',
                Math.abs(totalPct - 100) < 0.01 ? 'border-green-500/30 bg-green-500/10 text-green-700' : 'border-amber-500/30 bg-amber-500/10 text-amber-800',
              )}
              title="Somme des pourcentages du montage"
            >
              Σ {fmtNum(totalPct, 2)} %
            </Badge>
          )}
          {isEditing && (
            <>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-accent hover:text-accent hover:bg-accent/10" onClick={() => { setNbGuides('2'); setNewMontageOpen(true) }}>
                <Plus className="h-3.5 w-3.5 mr-1" />Montage
              </Button>
              {guides.length > 0 && (
                <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive hover:text-destructive" title={`Supprimer le montage ${montage}`} onClick={() => setDeleteMontageOpen(true)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </>
          )}
        </div>
      </CardHeader>
      <CardContent className="pb-4 space-y-2">
        {guides.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">
            Aucun guide-fil{isEditing ? ' — créez un montage pour définir les fils.' : '.'}
          </p>
        ) : (
          guides.map((g, i) => (
            <div
              key={g.IDguide_fil_rectiligne}
              onClick={isEditing ? () => setEditingGuide(g) : undefined}
              className={cn(
                'group rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3 flex items-center gap-3',
                g.IDref_fil > 0 ? 'border-l-amber-400/60' : 'border-l-destructive/60',
                isEditing && 'cursor-pointer hover:border-accent/40',
              )}
            >
              <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-amber-400/10 text-xs font-semibold text-amber-700 tabular-nums">
                {i + 1}
              </div>
              <div className="min-w-0 flex-1">
                <p className={cn('text-sm font-medium truncate', !g.IDref_fil && 'text-destructive italic')}>
                  {g.IDref_fil > 0 ? g.fil || `Fil #${g.IDref_fil}` : 'Choisir le fil'}
                </p>
                <p className="text-[11px] text-muted-foreground">{g.nb_fil} {g.nb_fil > 1 ? 'fils' : 'fil'}</p>
              </div>
              <span className="text-sm font-semibold tabular-nums flex-shrink-0">{fmtNum(g.pct, 2)} %</span>
              {isEditing && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 text-destructive hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                  title="Supprimer le guide"
                  onClick={(e) => { e.stopPropagation(); setDeleteGuide(g) }}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              )}
            </div>
          ))
        )}
        {isEditing && guides.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => addGuide.mutate()}
            disabled={addGuide.isPending}
            className="w-full text-muted-foreground hover:text-accent hover:bg-accent/5 border border-dashed border-border/60 hover:border-accent/40"
          >
            <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter un guide
          </Button>
        )}
      </CardContent>

      {/* « + montage » — legacy « Combien de guides fil voulez-vous utiliser ? » */}
      <Dialog open={newMontageOpen} onOpenChange={setNewMontageOpen}>
        <DialogContent className="max-w-sm" onClose={() => setNewMontageOpen(false)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Layers className="h-5 w-5 text-accent" />Nouveau montage</DialogTitle>
          </DialogHeader>
          <div className="mt-4">
            <LabeledInput label="Combien de guides-fil ?" type="number" value={nbGuides} onChange={setNbGuides} />
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setNewMontageOpen(false)}>Annuler</Button>
            <Button
              onClick={() => addMontage.mutate(Math.min(20, Math.max(1, Number(nbGuides) || 1)))}
              disabled={addMontage.isPending || !(Number(nbGuides) >= 1)}
            >
              {addMontage.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1.5" />}
              Créer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <GuideDialog guide={editingGuide} onClose={() => setEditingGuide(null)} onSaved={() => { setEditingGuide(null); onChanged() }} />

      <ConfirmDialog
        open={deleteGuide !== null}
        title="Supprimer le guide"
        description="Le guide et les couleurs de fil que les coloris lui attribuaient seront supprimés."
        isPending={removeGuide.isPending}
        onCancel={() => setDeleteGuide(null)}
        onConfirm={() => { if (deleteGuide) removeGuide.mutate(deleteGuide.IDguide_fil_rectiligne) }}
      />
      <ConfirmDialog
        open={deleteMontageOpen}
        title={`Supprimer le montage ${montage}`}
        description="Ses guides-fil et les couleurs de fil que les coloris leur attribuaient seront supprimés."
        isPending={removeMontage.isPending}
        onCancel={() => setDeleteMontageOpen(false)}
        onConfirm={() => removeMontage.mutate()}
      />
    </Card>
  )
}

/** FEN_Gestion_Guide_Fil — one guide's yarn, count of ends and share. */
function GuideDialog({ guide, onClose, onSaved }: { guide: Guide | null; onClose: () => void; onSaved: () => void }) {
  const [refFil, setRefFil] = useState(0)
  const [nbFil, setNbFil] = useState('1')
  const [pct, setPct] = useState('0')
  const [error, setError] = useState<string | null>(null)
  const { data: fils } = useQuery<RefFil[]>({
    queryKey: ['rectiligne-refs-fil'],
    queryFn: () => apiFetch('/references-rectiligne/lookups/refs-fil'),
    enabled: guide !== null,
    staleTime: 5 * 60 * 1000,
  })
  useEffect(() => {
    if (!guide) return
    setRefFil(guide.IDref_fil)
    setNbFil(String(guide.nb_fil || 1))
    setPct(String(guide.pct))
    setError(null)
  }, [guide])
  const save = useMutation({
    mutationFn: () =>
      apiFetch(`/references-rectiligne/guides/${guide?.IDguide_fil_rectiligne}`, {
        method: 'PUT',
        body: JSON.stringify({
          IDref_fil: refFil,
          nb_fil: Math.max(1, Math.round(Number(nbFil) || 1)),
          pct: Number(String(pct).replace(',', '.')) || 0,
        }),
      }),
    onSuccess: onSaved,
    onError: (err) => setError(apiMessage(err, "L'enregistrement du guide a échoué.")),
  })
  const changesFil = guide !== null && guide.IDref_fil > 0 && refFil !== guide.IDref_fil
  return (
    <Dialog open={guide !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Layers className="h-5 w-5 text-accent" />Guide-fil</DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Fil</label>
            <SearchableCombobox<RefFil>
              options={fils ?? []}
              value={refFil}
              onChange={setRefFil}
              getId={(f) => f.IDref_fil}
              getPrimary={(f) => f.reference}
              placeholder="Rechercher un fil"
              loading={!fils}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <LabeledInput label="Nombre de fils" type="number" value={nbFil} onChange={setNbFil} />
            <LabeledInput label="Pourcentage" suffix="%" type="number" step="0.1" value={pct} onChange={setPct} />
          </div>
          {changesFil && (
            <p className="text-[11px] text-amber-800 bg-amber-50 border border-amber-400/40 rounded-md px-3 py-2">
              Changer de fil efface la couleur que chaque coloris avait choisie pour ce guide.
            </p>
          )}
          {error && <p className="text-sm text-destructive flex items-center gap-1.5"><AlertCircle className="h-4 w-4" />{error}</p>}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || refFil <= 0}>
            {save.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Coloris ────────────────────────────────────────────

function ColorisCard({ detail, isEditing, montage, onChanged }: {
  detail: RectiDetail
  isEditing: boolean
  montage: number
  onChanged: () => void
}) {
  // null = closed, 0 = new, id = edit
  const [editing, setEditing] = useState<Coloris | 'new' | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Coloris | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const guides = detail.guides.filter((g) => g.montage === montage)
  const ready = guides.length > 0 && guides.every((g) => g.IDref_fil > 0)
  const notReady = guides.length === 0
    ? 'Définissez les guides-fil avant de créer un coloris.'
    : 'Choisissez le fil de chaque guide du montage avant de créer un coloris.'

  const remove = useMutation({
    mutationFn: (cid: number) => apiFetch(`/references-rectiligne/coloris/${cid}`, { method: 'DELETE' }),
    onSuccess: () => { setDeleteTarget(null); setDeleteError(null); onChanged() },
    onError: (err) => setDeleteError(apiMessage(err, 'Suppression impossible.')),
  })

  return (
    <Card className={cn('card-premium', isEditing && editSectionClass)}>
      <CardHeader className="flex flex-row items-center gap-2 p-4 space-y-0 pb-2">
        <Palette className="h-4 w-4 text-accent" />
        <CardTitle className="text-sm font-semibold">Coloris</CardTitle>
        <Badge variant="secondary" className="text-xs ml-auto">{detail.coloris.length}</Badge>
      </CardHeader>
      <CardContent className="pb-4 space-y-2">
        {detail.coloris.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
            <Palette className="h-10 w-10 mb-2 opacity-40" />
            <p className="text-sm">Aucun coloris</p>
            {isEditing && (
              <Button variant="outline" size="sm" className="mt-3" onClick={() => setEditing('new')} disabled={!ready} title={ready ? undefined : notReady}>
                <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter un coloris
              </Button>
            )}
          </div>
        ) : (
          detail.coloris.map((c) => {
            const byGuide = new Map(c.fils.map((f) => [f.IDguide_fil_rectiligne, f.colori]))
            return (
              <div
                key={c.IDcoloris_rectiligne}
                onClick={isEditing ? () => { if (ready) setEditing(c) } : undefined}
                title={isEditing && !ready ? notReady : undefined}
                className={cn(
                  'group rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3 border-l-amber-400/60',
                  isEditing && ready && 'cursor-pointer hover:border-accent/40',
                )}
              >
                <div className="flex items-center gap-2">
                  <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-amber-400/10">
                    <Palette className="h-3.5 w-3.5 text-amber-600" />
                  </div>
                  <p className="text-sm font-medium truncate flex-1">{c.coloris || '—'}</p>
                  {isEditing && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-destructive hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                      title="Supprimer le coloris"
                      onClick={(e) => { e.stopPropagation(); setDeleteError(null); setDeleteTarget(c) }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  )}
                </div>
                {guides.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2 ml-9">
                    {guides.map((g, i) => {
                      const colori = byGuide.get(g.IDguide_fil_rectiligne)
                      return (
                        <span
                          key={g.IDguide_fil_rectiligne}
                          className={cn(
                            'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px]',
                            colori ? 'bg-white border-border/60 text-foreground' : 'bg-destructive/5 border-destructive/30 text-destructive',
                          )}
                          title={g.fil}
                        >
                          <span className="text-muted-foreground tabular-nums">{i + 1}</span>
                          {colori || 'couleur ?'}
                        </span>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })
        )}
        {isEditing && detail.coloris.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEditing('new')}
            disabled={!ready}
            title={ready ? undefined : notReady}
            className="w-full text-muted-foreground hover:text-accent hover:bg-accent/5 border border-dashed border-border/60 hover:border-accent/40"
          >
            <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter un coloris
          </Button>
        )}
      </CardContent>

      <ColorisDialog
        target={editing}
        refId={detail.IDref_rectiligne}
        montage={montage}
        guides={guides}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); onChanged() }}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Supprimer le coloris"
        description={deleteError ?? `Le coloris « ${deleteTarget?.coloris ?? ''} » et ses couleurs de fil seront supprimés.`}
        isPending={remove.isPending}
        onCancel={() => { setDeleteTarget(null); setDeleteError(null) }}
        onConfirm={() => { if (deleteTarget) remove.mutate(deleteTarget.IDcoloris_rectiligne) }}
      />
    </Card>
  )
}

/** FEN_Gestion_Coloris_Guide_Fil — the coloris name and, for every guide of
 *  the montage, which colour of its yarn it carries. */
function ColorisDialog({ target, refId, montage, guides, onClose, onSaved }: {
  target: Coloris | 'new' | null
  refId: number
  montage: number
  guides: Guide[]
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState('')
  const [picks, setPicks] = useState<Record<number, number>>({})
  const [error, setError] = useState<string | null>(null)
  const open = target !== null
  useEffect(() => {
    if (!target) return
    setError(null)
    if (target === 'new') {
      setName('')
      setPicks({})
    } else {
      setName(target.coloris)
      setPicks(Object.fromEntries(target.fils.map((f) => [f.IDguide_fil_rectiligne, f.IDcolori_fil])))
    }
  }, [target])

  // One colour list per distinct yarn of the montage.
  const filIds = useMemo(() => Array.from(new Set(guides.map((g) => g.IDref_fil).filter((x) => x > 0))), [guides])
  const colorLists = useQueries({
    queries: filIds.map((f) => ({
      queryKey: ['rectiligne-colori-fil', f],
      queryFn: () => apiFetch<ColoriFil[]>(`/references-rectiligne/lookups/colori-fil?ref_fil=${f}`),
      enabled: open,
      staleTime: 5 * 60 * 1000,
    })),
  })
  const colorsByFil = new Map(filIds.map((f, i) => [f, colorLists[i]?.data]))

  const save = useMutation({
    mutationFn: () => {
      const body = JSON.stringify({
        coloris: name.trim(),
        montage,
        fils: guides.map((g) => ({ IDguide_fil_rectiligne: g.IDguide_fil_rectiligne, IDcolori_fil: picks[g.IDguide_fil_rectiligne] ?? 0 })),
      })
      return target === 'new'
        ? apiFetch(`/references-rectiligne/${refId}/coloris`, { method: 'POST', body })
        : apiFetch(`/references-rectiligne/coloris/${(target as Coloris).IDcoloris_rectiligne}`, { method: 'PUT', body })
    },
    onSuccess: onSaved,
    onError: (err) => setError(apiMessage(err, "L'enregistrement du coloris a échoué.")),
  })

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg max-h-[90dvh] overflow-y-auto" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Palette className="h-5 w-5 text-accent" />
            {target === 'new' ? 'Ajouter un coloris' : 'Modifier le coloris'}
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <LabeledInput label="Coloris de la référence" value={name} onChange={setName} />
          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">Couleur de fil par guide</p>
            {guides.map((g, i) => {
              const colors = colorsByFil.get(g.IDref_fil)
              return (
                <div key={g.IDguide_fil_rectiligne} className="flex items-center gap-2 rounded-md border border-border/60 bg-zinc-50 px-2.5 py-2">
                  <span className="text-xs font-semibold text-amber-700 tabular-nums w-4">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm truncate">{g.fil}</p>
                    <p className="text-[11px] text-muted-foreground tabular-nums">{g.nb_fil} {g.nb_fil > 1 ? 'fils' : 'fil'} · {fmtNum(g.pct, 2)} %</p>
                  </div>
                  <div className="w-[190px] flex-shrink-0">
                    {colors === undefined ? (
                      <Loader2 className="h-4 w-4 animate-spin text-accent ml-auto" />
                    ) : (
                      <PopoverSelect
                        size="sm"
                        widthClass="w-[190px]"
                        options={colors.map((c) => ({ id: c.IDcolori_fil, primary: c.reference }))}
                        value={picks[g.IDguide_fil_rectiligne] ?? 0}
                        onChange={(id) => setPicks((p) => ({ ...p, [g.IDguide_fil_rectiligne]: id }))}
                        emptyLabel="— Choisir —"
                      />
                    )}
                  </div>
                </div>
              )
            })}
          </div>
          {error && <p className="text-sm text-destructive flex items-center gap-1.5"><AlertCircle className="h-4 w-4" />{error}</p>}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !name.trim()}>
            {save.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Right sidebar ──────────────────────────────────────

function DetailSidebar({ detail }: { detail: RectiDetail | null }) {
  if (!detail) {
    return (
      <div className="w-96 flex-shrink-0 rounded-xl border flex items-center justify-center bg-zinc-100/80">
        <Loader2 className="h-6 w-6 animate-spin text-accent" />
      </div>
    )
  }
  const u = uniteShort(detail.unite)
  return (
    <div className="w-96 flex-shrink-0 rounded-xl border flex flex-col overflow-hidden bg-zinc-100/80">
      <div className="flex border-b p-1 gap-1 rounded-t-xl bg-zinc-200/50">
        <button type="button" className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md bg-accent text-accent-foreground shadow-sm">
          <Info className="h-3.5 w-3.5" />
          Informations
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-3 scrollbar-transparent">
        <div className="p-3 rounded-lg border bg-card shadow-sm space-y-2">
          <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
            <ClipboardList className="h-3.5 w-3.5" />
            Utilisation
          </p>
          <KV label="Lignes de commande sous-traitant" value={<span className="tabular-nums">{detail.usage.sst}</span>} />
          <KV label="Lignes de commande TRM (hors miroirs)" value={<span className="tabular-nums">{detail.usage.trm}</span>} />
          {detail.usage.sst + detail.usage.trm > 0 && (
            <p className="text-[11px] text-muted-foreground pt-1">Utilisée : elle peut être archivée, pas supprimée.</p>
          )}
        </div>
        <div className="p-3 rounded-lg border bg-card shadow-sm">
          <p className="text-xs font-semibold text-muted-foreground mb-2">Dernières commandes</p>
          {detail.commandes.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">Aucune commande</p>
          ) : (
            <div className="space-y-1.5">
              {detail.commandes.map((c, i) => (
                <div key={i} className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="min-w-0 truncate">
                    <span className="font-medium tabular-nums">N°{c.IDcommande_sous_traitant}</span>
                    <span className="text-muted-foreground"> · {c.date_commande ? formatHfsqlDate(c.date_commande) : '—'}{c.coloris ? ` · ${c.coloris}` : ''}</span>
                  </span>
                  <span className="tabular-nums flex-shrink-0">{fmtNum(c.quantite)} {u}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="p-3 rounded-lg border bg-card shadow-sm space-y-2">
          <p className="text-xs font-semibold text-muted-foreground">Métadonnées</p>
          <KV label="Montages" value={<span className="tabular-nums">{detail.montages.length}</span>} />
          <KV label="Coloris" value={<span className="tabular-nums">{detail.coloris.length}</span>} />
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

// ── Small shared pieces ────────────────────────────────

function LabeledInput({ label, value, onChange, type = 'text', step, suffix }: {
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

function Inline({ label, value, strong }: { label: string; value: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('text-sm tabular-nums', strong && 'font-semibold')}>{value}</span>
    </div>
  )
}

function KV({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm text-right truncate">{value}</span>
    </div>
  )
}

function MessageDialog({ open, title, message, onClose }: { open: boolean; title: string; message: string | null; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><AlertCircle className="h-5 w-5 text-destructive" />{title}</DialogTitle>
        </DialogHeader>
        <p className="mt-4 text-sm text-muted-foreground">{message}</p>
        <DialogFooter className="mt-4"><Button onClick={onClose}>OK</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** §18 A-bis placeholder — same literal strings as every other screen. */
function PlaceholderDialog({ open, onClose, title, TriggerIcon, CenterIcon }: {
  open: boolean
  onClose: () => void
  title: string
  TriggerIcon: ComponentType<{ className?: string }>
  CenterIcon: ComponentType<{ className?: string }>
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><TriggerIcon className="h-5 w-5 text-accent" />{title}</DialogTitle>
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
