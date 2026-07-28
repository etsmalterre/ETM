import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { UnsavedChangesDialog } from '@/components/shared/UnsavedChangesDialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import {
  ShoppingCart,
  Search,
  Loader2,
  AlertCircle,
  MapPin,
  Info,
  BookOpen,
  Pencil,
  Plus,
  X,
  Save,
  Trash2,
  MessageSquare,
  Leaf,
  CheckCircle2,
  Clock,
  Package,
  Link2,
  Unlink,
  Printer,
  AtSign,
  FileText,
  Upload,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { PopoverSelect, SearchableCombobox } from '@/components/ui/popover-select'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'
import { BobineIcon } from '@/components/icons/BobineIcon'
import { SendEmailDialog } from '@/components/email/SendEmailDialog'
import { cn } from '@/lib/utils'
import { formatHfsqlDate, hfsqlDateToInput, inputDateToHfsql } from '@/lib/dates'
import { fmtNum } from '@/lib/format'
import { apiFetch, API_URL } from '@/lib/api'
import { postEmail } from '@/lib/email'

// ── Types ──────────────────────────────────────────────

interface CommandeListRow {
  IDcommande_fil: number
  IDfournisseur: number
  date_commande: string | null
  etat: number | null
  commentaire: string | null
  fournisseur_nom: string
  total_kg: number
  total_eur: number
  nb_lignes: number
  earliest_delivery: string | null
}

interface LigneCommande {
  IDref_fil_commande: number
  IDcommande_fil: number
  IDref_fil: number
  IDcolori_fil: number
  quantite: number | null
  unite: number | null
  prix_unitaire: number | null
  date_livraison: string | null
  etat: number | null
  ref_fil: string | null
  colori_reference: string | null
  ref_fil_bio: number | null
  nb_lots_lies?: number
  total_kg_lie?: number
}

interface StockLotLite {
  IDstock_fil: number
  IDfournisseur: number
  IDref_fil: number
  IDcolori_fil: number
  IDref_fil_commande: number | null
  stock: number | null
  stock_initial: number | null
  lot: string | null
  lot_frs: string | null
  emplacement: string | null
  date_entree: string | null
  niveau: number | null
  termine: number | null
  controle: number | null
  bio: number | null
  ref_fil: string | null
  colori_reference: string | null
  fournisseur_nom: string | null
}

interface LineStockPayload {
  linked: StockLotLite[]
  available: StockLotLite[]
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

interface CommandeDetail {
  IDcommande_fil: number
  IDfournisseur: number
  date_commande: string | null
  etat: number | null
  commentaire: string | null
  journal: string | null
  IDadresse_fournisseur: number | null
  IDadresse_livraison: number | null
  IDmode_paiement: number | null
  IDecheance: number | null
  fournisseur_nom: string
  mode_paiement_libelle: string | null
  echeance_libelle: string | null
  adresse_facturation: AdresseLite | null
  adresse_livraison: AdresseLite | null
  lignes: LigneCommande[]
}

interface ModePaiement {
  IDmode_paiement: number
  libelle: string
}

interface Echeance {
  IDecheance: number
  libelle: string
  nb_jours: number
}

interface FournisseurLite {
  IDfournisseur: number
  nom: string
}

interface RefFilLookup {
  IDcolori_fil: number
  colori_reference: string | null
  colori_prix_kg: number | null
  IDref_fil: number
  ref_fil_reference: string | null
  bio: number | null
  titrage: number | null
}

interface AdresseLookup extends AdresseLite {
  est_defaut: number
  est_defaut_facturation: number
  est_defaut_livraison: number
}

// ── API helpers ────────────────────────────────────────
// Shared apiFetch + API_URL — see apps/web/src/lib/api.ts

// ── Shared styling ─────────────────────────────────────

const inputClass = 'w-full h-8 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring'
const editSectionClass = 'border-l-4 border-l-accent/70 bg-accent/[0.03]'

// ── Status helpers ─────────────────────────────────────

function CommandeEtatBadge({ etat, className }: { etat: number | null; className?: string }) {
  if (etat === 1) return <Badge variant="success" className={cn('text-[10px] py-0 gap-1', className)}><CheckCircle2 className="h-2.5 w-2.5" />Terminée</Badge>
  return <Badge variant="default" className={cn('text-[10px] py-0 gap-1', className)}><Clock className="h-2.5 w-2.5" />En cours</Badge>
}

// Returns a delivery-urgency flag based on the earliest line delivery date.
// 'late'  = today >= delivery date, OR no delivery date specified (red left edge)
// 'soon'  = delivery date is within the next 3 days (amber left edge)
// null    = not urgent, or commande is terminée
function deliveryUrgency(earliestHfsql: string | null, etat: number | null): 'late' | 'soon' | null {
  if (etat === 1) return null
  if (!earliestHfsql || !/^\d{8}$/.test(earliestHfsql)) return 'late'
  const y = Number(earliestHfsql.slice(0, 4))
  const m = Number(earliestHfsql.slice(4, 6)) - 1
  const d = Number(earliestHfsql.slice(6, 8))
  const target = new Date(y, m, d)
  target.setHours(0, 0, 0, 0)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86_400_000)
  if (diffDays <= 0) return 'late'
  if (diffDays <= 3) return 'soon'
  return null
}

function etatColors(etat: number | null) {
  if (etat === 1) {
    return {
      border: 'border-l-green-500/60',
      iconBg: 'bg-green-500/10',
      iconColor: 'text-green-600',
    }
  }
  return {
    border: 'border-l-amber-400/60',
    iconBg: 'bg-amber-400/10',
    iconColor: 'text-amber-600',
  }
}

// ── Main Page ──────────────────────────────────────────

export function FilsCommandes() {
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'en_cours' | 'terminee'>('en_cours')
  const [isEditing, setIsEditing] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [stockDrawerLineId, setStockDrawerLineId] = useState<number | null>(null)
  const [emailModalOpen, setEmailModalOpen] = useState(false)
  // Set by CreateCommandeDialog's onCreated; watched by an effect that flips
  // the screen into edit mode once the detail for the new commande loads.
  const [autoEditForId, setAutoEditForId] = useState<number | null>(null)
  // Page-level in-app delete confirmation (replaces native confirm()).
  const [deleteCommandeConfirmOpen, setDeleteCommandeConfirmOpen] = useState(false)

  // Edit-mode draft state for the header
  const [editDateCommande, setEditDateCommande] = useState('')
  const [editCommentaire, setEditCommentaire] = useState('')
  const [editJournal, setEditJournal] = useState('')
  const [editIDModePaiement, setEditIDModePaiement] = useState<number>(0)
  const [editIDEcheance, setEditIDEcheance] = useState<number>(0)
  const [editIDAdresseFacturation, setEditIDAdresseFacturation] = useState<number>(0)
  const [editIDAdresseLivraison, setEditIDAdresseLivraison] = useState<number>(0)

  // Snapshot of the draft at edit-start, used to compute `isDirty`.
  const originalDraftRef = useRef<{
    dateCommande: string
    commentaire: string
    journal: string
    IDmodePaiement: number
    IDecheance: number
    IDadresseFact: number
    IDadresseLiv: number
  } | null>(null)

  // Surfaced from LignesSection via callback — true if a line edit/new form is open.
  const [linesDirty, setLinesDirty] = useState(false)

  const { data: commandes, isLoading, isError, error } = useQuery<CommandeListRow[]>({
    queryKey: ['commandes-fil', statusFilter],
    queryFn: () => apiFetch(`/commandes-fil?etat=${statusFilter}`),
  })

  const { data: detail, isLoading: detailLoading } = useQuery<CommandeDetail>({
    queryKey: ['commande-fil', selectedId],
    queryFn: () => apiFetch(`/commandes-fil/${selectedId}`),
    enabled: selectedId !== null,
  })

  // Reset the stock-linkage drawer every time the active commande changes.
  // Without this the previous commande's drawer state leaks into the next
  // one: the rows container stays shrunk to max-h-[40%], no drawer renders
  // (the new commande has no matching line id), and the totals footer
  // floats up next to the rows list instead of staying pinned at the bottom.
  useEffect(() => {
    setStockDrawerLineId(null)
  }, [selectedId])

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['commandes-fil'] })
    queryClient.invalidateQueries({ queryKey: ['commande-fil', selectedId] })
  }, [queryClient, selectedId])

  const startEdit = useCallback(() => {
    if (!detail) return
    const snapshot = {
      dateCommande: hfsqlDateToInput(detail.date_commande),
      commentaire: detail.commentaire?.trim() ?? '',
      journal: detail.journal?.trim() ?? '',
      IDmodePaiement: detail.IDmode_paiement ?? 0,
      IDecheance: detail.IDecheance ?? 0,
      IDadresseFact: detail.IDadresse_fournisseur ?? 0,
      IDadresseLiv: detail.IDadresse_livraison ?? 0,
    }
    setEditDateCommande(snapshot.dateCommande)
    setEditCommentaire(snapshot.commentaire)
    setEditJournal(snapshot.journal)
    setEditIDModePaiement(snapshot.IDmodePaiement)
    setEditIDEcheance(snapshot.IDecheance)
    setEditIDAdresseFacturation(snapshot.IDadresseFact)
    setEditIDAdresseLivraison(snapshot.IDadresseLiv)
    originalDraftRef.current = snapshot
    setStockDrawerLineId(null) // Edit mode hides the stock drawer
    setIsEditing(true)
  }, [detail])

  const cancelEdit = useCallback(() => setIsEditing(false), [])

  // Dirty check: any header field differs from the edit-start snapshot,
  // OR any sub-form (new line, line edit) is open.
  const isDirty = useMemo(() => {
    if (!isEditing) return false
    const o = originalDraftRef.current
    if (!o) return false
    if (editDateCommande !== o.dateCommande) return true
    if (editCommentaire !== o.commentaire) return true
    if (editJournal !== o.journal) return true
    if (editIDModePaiement !== o.IDmodePaiement) return true
    if (editIDEcheance !== o.IDecheance) return true
    if (editIDAdresseFacturation !== o.IDadresseFact) return true
    if (editIDAdresseLivraison !== o.IDadresseLiv) return true
    if (linesDirty) return true
    return false
  }, [isEditing, editDateCommande, editCommentaire, editJournal, editIDModePaiement, editIDEcheance, editIDAdresseFacturation, editIDAdresseLivraison, linesDirty])

  const saveHeaderMut = useMutation({
    mutationFn: () => apiFetch(`/commandes-fil/${selectedId}`, {
      method: 'PUT',
      body: JSON.stringify({
        date_commande: inputDateToHfsql(editDateCommande),
        commentaire: editCommentaire,
        journal: editJournal,
        IDmode_paiement: editIDModePaiement || 0,
        IDecheance: editIDEcheance || 0,
        IDadresse_fournisseur: editIDAdresseFacturation || 0,
        IDadresse_livraison: editIDAdresseLivraison || 0,
      }),
    }),
    onSuccess: () => { invalidateAll(); setIsEditing(false) },
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/commandes-fil/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, deletedId) => {
      // Pick the next commande to surface *before* invalidation, while the
      // cached list still contains the full pre-delete set. The
      // auto-select-first effect reads stale data during the refetch gap,
      // so we set the new selection explicitly here instead of nulling it.
      const cached = queryClient.getQueryData<CommandeListRow[]>(['commandes-fil', statusFilter]) ?? []
      const remaining = cached.filter((c) => c.IDcommande_fil !== deletedId)
      queryClient.invalidateQueries({ queryKey: ['commandes-fil'] })
      setIsEditing(false)
      setDeleteCommandeConfirmOpen(false)
      setSelectedId(remaining.length > 0 ? remaining[0].IDcommande_fil : null)
    },
  })

  // Auto-enter edit mode after a new commande is created: CreateCommandeDialog
  // sets `autoEditForId`, then we wait for the detail query to finish loading
  // before calling startEdit — it needs `detail` to snapshot the draft.
  useEffect(() => {
    if (autoEditForId !== null && detail?.IDcommande_fil === autoEditForId) {
      startEdit()
      setAutoEditForId(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEditForId, detail])

  const guard = useUnsavedGuard({
    isDirty,
    save: async () => {
      await saveHeaderMut.mutateAsync()
    },
    onDiscard: () => {
      setIsEditing(false)
    },
  })

  const toggleEtatMut = useMutation({
    mutationFn: (newEtat: number) => apiFetch(`/commandes-fil/${selectedId}`, {
      method: 'PUT',
      body: JSON.stringify({ etat: newEtat }),
    }),
    onSuccess: invalidateAll,
  })

  const handleSelect = useCallback((id: number) => {
    guard.guardAction(() => {
      setIsEditing(false)
      setSelectedId(id)
    })
  }, [guard])

  const handleStatusFilterChange = useCallback((s: 'all' | 'en_cours' | 'terminee') => {
    guard.guardAction(() => {
      setIsEditing(false)
      setStatusFilter(s)
      // Clear selection so the auto-select effect picks the first row of the new list
      setSelectedId(null)
    })
  }, [guard])

  const filtered = useMemo(() => {
    if (!commandes) return []
    if (!searchQuery.trim()) return commandes
    const q = searchQuery.toLowerCase()
    return commandes.filter((c) =>
      String(c.IDcommande_fil).includes(q)
      || (c.fournisseur_nom ?? '').toLowerCase().includes(q)
      || (c.commentaire ?? '').toLowerCase().includes(q)
    )
  }, [commandes, searchQuery])

  // Keep the selection valid against the (possibly search-filtered) list: when
  // the selected commande isn't among the current results, select the one at
  // the top. Covers both the initial load and search narrowing the list — so
  // typing in the search bar auto-selects the first visible commande. Skip
  // while editing so we never discard unsaved changes out from under the user.
  useAutoSelectFirst({
    rows: filtered,
    selectedId,
    getId: (c) => c.IDcommande_fil,
    select: setSelectedId,
    suspended: isEditing,
  })

  return (
    <>
      <MasterDetailLayout
        list={
          <CommandeList
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
            commande={detail ?? null}
            isLoading={detailLoading && selectedId !== null}
            isEditing={isEditing}
            onStartEdit={startEdit}
            onCancelEdit={cancelEdit}
            onSave={() => saveHeaderMut.mutate()}
            isSaving={saveHeaderMut.isPending}
            onDelete={() => setDeleteCommandeConfirmOpen(true)}
            onPrintClick={() => {
              if (selectedId !== null) {
                window.open(`${API_URL}/commandes-fil/${selectedId}/pdf`, '_blank')
              }
            }}
            onEmailClick={() => setEmailModalOpen(true)}
          />
        }
        detail={
          <DetailMain
            commande={detail ?? null}
            isLoading={detailLoading && selectedId !== null}
            hasSelection={selectedId !== null}
            isEditing={isEditing}
            onMutationSuccess={invalidateAll}
            onLinesDirtyChange={setLinesDirty}
            stockDrawerLineId={stockDrawerLineId}
            onOpenStockDrawer={setStockDrawerLineId}
          />
        }
        sidebar={selectedId !== null ? (
          <DetailSidebar
            commande={detail ?? null}
            isLoading={detailLoading}
            isEditing={isEditing}
            editDateCommande={editDateCommande}
            onEditDateCommandeChange={setEditDateCommande}
            editCommentaire={editCommentaire}
            onEditCommentaireChange={setEditCommentaire}
            editJournal={editJournal}
            onEditJournalChange={setEditJournal}
            editIDModePaiement={editIDModePaiement}
            onEditIDModePaiementChange={setEditIDModePaiement}
            editIDEcheance={editIDEcheance}
            onEditIDEcheanceChange={setEditIDEcheance}
            editIDAdresseFacturation={editIDAdresseFacturation}
            onEditIDAdresseFacturationChange={setEditIDAdresseFacturation}
            editIDAdresseLivraison={editIDAdresseLivraison}
            onEditIDAdresseLivraisonChange={setEditIDAdresseLivraison}
            onToggleEtat={() => toggleEtatMut.mutate(detail?.etat === 1 ? 0 : 1)}
            isTogglingEtat={toggleEtatMut.isPending}
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

      <CreateCommandeDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(newId) => {
          setCreateOpen(false)
          queryClient.invalidateQueries({ queryKey: ['commandes-fil'] })
          setSelectedId(newId)
          // Flag the new commande so the effect flips into edit mode as
          // soon as its detail query resolves.
          setAutoEditForId(newId)
        }}
      />

      <ConfirmDialog
        open={deleteCommandeConfirmOpen}
        title="Supprimer la commande"
        description="Cette action supprimera la commande et toutes ses lignes. Elle est irréversible."
        confirmLabel="Supprimer"
        isPending={deleteMut.isPending}
        onCancel={() => setDeleteCommandeConfirmOpen(false)}
        onConfirm={() => {
          if (selectedId !== null) deleteMut.mutate(selectedId)
        }}
      />

      {selectedId !== null && (
        <SendEmailDialog
          open={emailModalOpen}
          onClose={() => setEmailModalOpen(false)}
          contextLabel={detail?.fournisseur_nom ?? undefined}
          queryKey={['commande-fil-email-defaults', selectedId]}
          loadDefaults={() => apiFetch(`/commandes-fil/${selectedId}/email-defaults`)}
          pdfUrl={`${API_URL}/commandes-fil/${selectedId}/pdf`}
          pdfAttachmentLabel={`commande-fournisseur-${selectedId}.pdf`}
          onSend={(p) => postEmail(`${API_URL}/commandes-fil/${selectedId}/email`, p, { includeAttachPdf: true })}
        />
      )}
    </>
  )
}

// ── Left Panel: List ───────────────────────────────────

function CommandeList({
  rows, isLoading, isError, error,
  selectedId, onSelect,
  searchQuery, onSearchChange,
  statusFilter, onStatusFilterChange,
  onNew, isEditing,
}: {
  rows: CommandeListRow[]
  isLoading: boolean
  isError: boolean
  error: Error | null
  selectedId: number | null
  onSelect: (id: number) => void
  searchQuery: string
  onSearchChange: (q: string) => void
  statusFilter: 'all' | 'en_cours' | 'terminee'
  onStatusFilterChange: (s: 'all' | 'en_cours' | 'terminee') => void
  onNew: () => void
  isEditing: boolean
}) {
  return (
    <div className="flex flex-col h-full rounded-lg border shadow-sm bg-zinc-100/80">
      {/* Search + filter header */}
      <div className="p-3 border-b rounded-t-lg bg-zinc-200/50 space-y-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Rechercher (n°, fournisseur...)"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            autoComplete="off"
            className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex gap-1">
          {([
            { key: 'en_cours', label: 'En cours' },
            { key: 'terminee', label: 'Terminées' },
            { key: 'all', label: 'Toutes' },
          ] as const).map((opt) => (
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

      {/* Scrollable list body */}
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
            <ShoppingCart className="h-12 w-12 mb-3 opacity-50" />
            <p className="text-sm">Aucune commande</p>
          </div>
        ) : rows.map((row) => {
          const isSelected = selectedId === row.IDcommande_fil
          const urgency = deliveryUrgency(row.earliest_delivery, row.etat)
          const selectedRingClass =
            urgency === 'late' ? 'border-red-500 ring-1 ring-red-500'
            : urgency === 'soon' ? 'border-amber-500 ring-1 ring-amber-500'
            : 'border-zinc-400 ring-1 ring-zinc-400'
          const hoverClass =
            urgency === 'late' ? 'border-border hover:border-red-500/50'
            : urgency === 'soon' ? 'border-border hover:border-amber-500/50'
            : 'border-border hover:border-zinc-400/60'
          return (
            <div
              key={row.IDcommande_fil}
              onClick={() => onSelect(row.IDcommande_fil)}
              className={cn(
                'p-3 border rounded-lg cursor-pointer transition-all bg-white',
                isSelected ? selectedRingClass : hoverClass,
                // Inset left-edge strip via box-shadow — coexists with ring via --tw-shadow
                urgency === 'late' && 'shadow-[inset_4px_0_0_0_rgb(239_68_68)]',
                urgency === 'soon' && 'shadow-[inset_4px_0_0_0_rgb(245_158_11)]'
              )}
            >
              <div className="flex items-center gap-2">
                <ShoppingCart className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="font-medium text-sm">N° {row.IDcommande_fil}</span>
                <CommandeEtatBadge etat={row.etat} className="ml-auto" />
              </div>
              <p className="text-xs text-muted-foreground mt-1 truncate">{row.fournisseur_nom || '—'}</p>
              <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground">
                {row.date_commande && <span>{formatHfsqlDate(row.date_commande)}</span>}
                {row.total_kg > 0 && (
                  <span className="ml-auto px-1.5 py-0.5 rounded bg-zinc-200/80 tabular-nums">
                    {fmtNum(row.total_kg)} kg
                  </span>
                )}
                {row.total_eur > 0 && (
                  <span className="px-1.5 py-0.5 rounded bg-accent/10 font-medium text-foreground tabular-nums">
                    {fmtNum(row.total_eur)} €
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Footer with count + Nouvelle button */}
      <div className="p-3 border-t text-xs text-muted-foreground flex items-center justify-between rounded-b-lg bg-zinc-200/50">
        <span>{rows.length} commande{rows.length !== 1 ? 's' : ''}</span>
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
  commande, isLoading, isEditing,
  onStartEdit, onCancelEdit, onSave, isSaving,
  onDelete, onPrintClick, onEmailClick,
}: {
  commande: CommandeDetail | null
  isLoading: boolean
  isEditing: boolean
  onStartEdit: () => void
  onCancelEdit: () => void
  onSave: () => void
  isSaving: boolean
  onDelete: () => void
  onPrintClick: () => void
  onEmailClick: () => void
}) {
  if (!commande && !isLoading) return null

  return (
    <div className="flex-shrink-0 pt-0.5">
      <div className="flex items-center gap-3">
        <div className={cn('h-11 w-11 rounded-lg flex items-center justify-center', isEditing ? 'bg-accent/15' : 'icon-box-gold')}>
          <ShoppingCart className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          {isLoading ? (
            <div className="h-8 w-48 bg-muted animate-pulse rounded" />
          ) : (
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-heading font-bold tracking-tight truncate">
                N° {commande?.IDcommande_fil}
                <span className="text-muted-foreground font-normal"> · {commande?.fournisseur_nom || '—'}</span>
              </h1>
              <div className="flex items-center gap-2 flex-shrink-0">
                {commande?.date_commande && (
                  <Badge variant="secondary" className="text-xs">{formatHfsqlDate(commande.date_commande)}</Badge>
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
        {!isLoading && commande && (
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
                <Button variant="outline" size="icon" className="h-9 w-9" title="Imprimer" onClick={onPrintClick}>
                  <Printer className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="icon" className="h-9 w-9" title="Envoyer un email" onClick={onEmailClick}>
                  <AtSign className="h-4 w-4" />
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

function DetailMain({
  commande, isLoading, hasSelection, isEditing, onMutationSuccess, onLinesDirtyChange, stockDrawerLineId, onOpenStockDrawer,
}: {
  commande: CommandeDetail | null
  isLoading: boolean
  hasSelection: boolean
  isEditing: boolean
  onMutationSuccess: () => void
  onLinesDirtyChange: (dirty: boolean) => void
  stockDrawerLineId: number | null
  onOpenStockDrawer: (lineId: number | null) => void
}) {
  if (!hasSelection) return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="icon-box-gold h-16 w-16 mx-auto"><ShoppingCart className="h-8 w-8" /></div>
        <p className="text-muted-foreground text-sm">Sélectionnez une commande dans la liste</p>
      </div>
    </div>
  )
  if (isLoading) return <div className="flex-1 flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-accent" /></div>
  if (!commande) return null

  const totalKg = commande.lignes.reduce((s, l) => s + (l.quantite != null ? Number(l.quantite) : 0), 0)
  const totalEur = commande.lignes.reduce((s, l) => s + (l.quantite != null && l.prix_unitaire != null ? Number(l.quantite) * Number(l.prix_unitaire) : 0), 0)

  return (
    <LignesSection
      commande={commande}
      isEditing={isEditing}
      totalKg={totalKg}
      totalEur={totalEur}
      onMutationSuccess={onMutationSuccess}
      onLinesDirtyChange={onLinesDirtyChange}
      stockDrawerLineId={stockDrawerLineId}
      onOpenStockDrawer={onOpenStockDrawer}
    />
  )
}

// ── Center: Lignes Section ─────────────────────────────

function LignesSection({
  commande, isEditing, totalKg, totalEur, onMutationSuccess, onLinesDirtyChange, stockDrawerLineId, onOpenStockDrawer,
}: {
  commande: CommandeDetail
  isEditing: boolean
  totalKg: number
  totalEur: number
  onMutationSuccess: () => void
  onLinesDirtyChange: (dirty: boolean) => void
  stockDrawerLineId: number | null
  onOpenStockDrawer: (lineId: number | null) => void
}) {
  const [editingLineId, setEditingLineId] = useState<number | null>(null)
  const [showLineForm, setShowLineForm] = useState(false)
  const [deleteLineConfirmId, setDeleteLineConfirmId] = useState<number | null>(null)
  const [lineForm, setLineForm] = useState({
    IDref_fil: 0,
    IDcolori_fil: 0,
    quantite: '',
    prix_unitaire: '',
    date_livraison: '',
  })

  // Lines are locked when the commande is terminée. Header edits remain
  // allowed; to modify lines the user must reopen the commande via the
  // sidebar status pill. Server enforces this too — UI just hides the
  // affordances. See commandes-fil.ts §refuseIfTerminee.
  const linesLocked = commande.etat === 1

  // Close line forms when editing is turned off globally, or when the
  // commande gets auto-closed mid-edit (e.g. user toggled the last line
  // to terminé and the server flipped commande.etat).
  useEffect(() => {
    if (!isEditing || linesLocked) {
      setEditingLineId(null)
      setShowLineForm(false)
    }
  }, [isEditing, linesLocked])

  // Surface sub-form dirty state to the page so the unsaved-changes guard
  // can catch navigation while a line form is open.
  useEffect(() => {
    onLinesDirtyChange(showLineForm || editingLineId !== null)
  }, [showLineForm, editingLineId, onLinesDirtyChange])

  const { data: refLookup } = useQuery<RefFilLookup[]>({
    queryKey: ['commande-fil-refs', commande.IDfournisseur],
    queryFn: () => apiFetch(`/commandes-fil/lookups/refs-fil?fournisseur=${commande.IDfournisseur}`),
    enabled: isEditing && !!commande.IDfournisseur,
  })

  // Group lookup refs by IDref_fil (one entry per ref, with an array of coloris)
  const refsGrouped = useMemo(() => {
    if (!refLookup) return []
    const map = new Map<number, { IDref_fil: number; reference: string; bio: boolean; coloris: { IDcolori_fil: number; reference: string }[] }>()
    for (const r of refLookup) {
      if (!map.has(r.IDref_fil)) {
        map.set(r.IDref_fil, {
          IDref_fil: r.IDref_fil,
          reference: r.ref_fil_reference ?? '—',
          bio: !!r.bio,
          coloris: [],
        })
      }
      map.get(r.IDref_fil)!.coloris.push({
        IDcolori_fil: r.IDcolori_fil,
        reference: r.colori_reference ?? '—',
      })
    }
    return Array.from(map.values())
  }, [refLookup])

  const createLineMut = useMutation({
    mutationFn: () => apiFetch(`/commandes-fil/${commande.IDcommande_fil}/lignes`, {
      method: 'POST',
      body: JSON.stringify({
        IDref_fil: lineForm.IDref_fil,
        IDcolori_fil: lineForm.IDcolori_fil,
        quantite: Number(lineForm.quantite) || 0,
        prix_unitaire: Number(lineForm.prix_unitaire) || 0,
        date_livraison: inputDateToHfsql(lineForm.date_livraison),
      }),
    }),
    onSuccess: () => { onMutationSuccess(); resetLineForm() },
  })

  const updateLineMut = useMutation({
    mutationFn: (lineId: number) => apiFetch(`/commandes-fil/lignes/${lineId}`, {
      method: 'PUT',
      body: JSON.stringify({
        IDref_fil: lineForm.IDref_fil,
        IDcolori_fil: lineForm.IDcolori_fil,
        quantite: Number(lineForm.quantite) || 0,
        prix_unitaire: Number(lineForm.prix_unitaire) || 0,
        date_livraison: inputDateToHfsql(lineForm.date_livraison),
      }),
    }),
    onSuccess: () => { onMutationSuccess(); setEditingLineId(null); resetLineForm() },
  })

  const deleteLineMut = useMutation({
    mutationFn: (lineId: number) => apiFetch(`/commandes-fil/lignes/${lineId}`, { method: 'DELETE' }),
    onSuccess: onMutationSuccess,
  })

  const toggleLineEtatMut = useMutation({
    mutationFn: ({ lineId, etat }: { lineId: number; etat: number }) =>
      apiFetch(`/commandes-fil/lignes/${lineId}`, {
        method: 'PUT',
        body: JSON.stringify({ etat }),
      }),
    onSuccess: onMutationSuccess,
  })

  const resetLineForm = () => {
    setLineForm({ IDref_fil: 0, IDcolori_fil: 0, quantite: '', prix_unitaire: '', date_livraison: '' })
    setShowLineForm(false)
  }

  const startEditLine = (l: LigneCommande) => {
    setShowLineForm(false)
    setEditingLineId(l.IDref_fil_commande)
    setLineForm({
      IDref_fil: l.IDref_fil,
      IDcolori_fil: l.IDcolori_fil,
      quantite: l.quantite != null ? String(l.quantite) : '',
      prix_unitaire: l.prix_unitaire != null ? String(l.prix_unitaire) : '',
      date_livraison: hfsqlDateToInput(l.date_livraison),
    })
  }

  const startAddLine = () => {
    setEditingLineId(null)
    setLineForm({ IDref_fil: 0, IDcolori_fil: 0, quantite: '', prix_unitaire: '', date_livraison: '' })
    setShowLineForm(true)
  }

  const drawerOpen = stockDrawerLineId !== null && !isEditing
  const drawerLigne = drawerOpen
    ? commande.lignes.find((l) => l.IDref_fil_commande === stockDrawerLineId) ?? null
    : null

  return (
    <>
    <div className="flex-1 min-h-0 flex flex-col">
      <div
        className={cn(
          'overflow-auto space-y-2 p-1 scrollbar-transparent',
          drawerOpen ? 'flex-shrink-0 max-h-[40%]' : 'flex-1 min-h-0'
        )}
      >
        {commande.lignes.length === 0 && !showLineForm ? (
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <BobineIcon className="h-12 w-12 mb-3 opacity-40" />
            <p className="text-sm">Aucune ligne</p>
            {isEditing && !linesLocked && (
              <Button variant="outline" size="sm" className="mt-3" onClick={startAddLine}>
                <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter une ligne
              </Button>
            )}
          </div>
        ) : (
          commande.lignes.map((l) => {
            if (isEditing && editingLineId === l.IDref_fil_commande) {
              return (
                <InlineForm
                  key={l.IDref_fil_commande}
                  title="Modifier la ligne"
                  onSave={() => updateLineMut.mutate(l.IDref_fil_commande)}
                  onCancel={() => { setEditingLineId(null); resetLineForm() }}
                  isSaving={updateLineMut.isPending}
                >
                  <LineFormFields form={lineForm} setForm={setLineForm} refsGrouped={refsGrouped} />
                </InlineForm>
              )
            }
            return (
              <LineCard
                key={l.IDref_fil_commande}
                line={l}
                isEditing={isEditing}
                linesLocked={linesLocked}
                isStockDrawerOpen={stockDrawerLineId === l.IDref_fil_commande}
                onEdit={() => startEditLine(l)}
                onDelete={() => setDeleteLineConfirmId(l.IDref_fil_commande)}
                onToggleEtat={() => toggleLineEtatMut.mutate({ lineId: l.IDref_fil_commande, etat: l.etat === 1 ? 0 : 1 })}
                onOpenStockDrawer={onOpenStockDrawer}
              />
            )
          })
        )}

        {isEditing && !linesLocked && showLineForm && (
          <InlineForm
            title="Nouvelle ligne"
            onSave={() => createLineMut.mutate()}
            onCancel={resetLineForm}
            isSaving={createLineMut.isPending}
          >
            <LineFormFields form={lineForm} setForm={setLineForm} refsGrouped={refsGrouped} />
          </InlineForm>
        )}

        {isEditing && !linesLocked && commande.lignes.length > 0 && !showLineForm && editingLineId === null && (
          <Button
            variant="ghost"
            size="sm"
            onClick={startAddLine}
            className="w-full text-muted-foreground hover:text-accent hover:bg-accent/5 border border-dashed border-border/60 hover:border-accent/40"
          >
            <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter une ligne
          </Button>
        )}
      </div>

      {/* In-screen stock linkage drawer — grows into the center panel below the lines list */}
      {drawerOpen && drawerLigne && (
        <div className="flex-1 min-h-0 flex flex-col mt-3 rounded-lg border border-border/60 overflow-hidden bg-zinc-50/80 animate-in slide-in-from-bottom-4 fade-in-0 duration-200">
          <StockLinkDrawer
            commandeId={commande.IDcommande_fil}
            ligne={drawerLigne}
            onClose={() => onOpenStockDrawer(null)}
            onSuccess={onMutationSuccess}
          />
        </div>
      )}

      {/* Totals footer pinned at bottom */}
      {commande.lignes.length > 0 && (
        <div className="flex-shrink-0 mt-3 pt-3 border-t border-border/60 flex items-center justify-between text-sm font-medium">
          <span className="text-muted-foreground text-xs uppercase tracking-wide">
            Total · {commande.lignes.length} ligne{commande.lignes.length > 1 ? 's' : ''}
          </span>
          <div className="flex items-center gap-4 tabular-nums">
            <span>{fmtNum(totalKg, 1)} kg</span>
            <span className="text-accent text-base">{fmtNum(totalEur, 2)} €</span>
          </div>
        </div>
      )}
    </div>

    <ConfirmDialog
      open={deleteLineConfirmId !== null}
      title="Supprimer la ligne"
      description="Cette ligne de commande sera supprimée définitivement."
      confirmLabel="Supprimer"
      isPending={deleteLineMut.isPending}
      onCancel={() => setDeleteLineConfirmId(null)}
      onConfirm={() => {
        if (deleteLineConfirmId !== null) {
          deleteLineMut.mutate(deleteLineConfirmId, {
            onSuccess: () => setDeleteLineConfirmId(null),
          })
        }
      }}
    />
    </>
  )
}

function LineCard({
  line, isEditing, linesLocked, isStockDrawerOpen, onEdit, onDelete, onToggleEtat, onOpenStockDrawer,
}: {
  line: LigneCommande
  isEditing: boolean
  linesLocked: boolean
  isStockDrawerOpen: boolean
  onEdit: () => void
  onDelete: () => void
  onToggleEtat: () => void
  onOpenStockDrawer: (lineId: number | null) => void
}) {
  const { border, iconBg, iconColor } = etatColors(line.etat)
  const lineTotal = (Number(line.quantite) || 0) * (Number(line.prix_unitaire) || 0)
  const nbLotsLies = line.nb_lots_lies ?? 0
  const totalKgLie = line.total_kg_lie ?? 0
  const clickable = !isEditing

  return (
    <div
      className={cn(
        'group rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3',
        border,
        clickable && 'cursor-pointer hover:bg-zinc-100 hover:border-accent/40 transition-colors',
        isStockDrawerOpen && 'ring-1 ring-accent bg-accent/[0.06] border-accent/50'
      )}
      onClick={clickable ? () => onOpenStockDrawer(isStockDrawerOpen ? null : line.IDref_fil_commande) : undefined}
    >
      {/* Top row: icon + ref/coloris + badges/actions */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className={cn('h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0', iconBg)}>
            <BobineIcon className={cn('h-3.5 w-3.5', iconColor)} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">
              {line.ref_fil || '—'}
              {line.colori_reference ? <span className="text-muted-foreground"> / {line.colori_reference}</span> : null}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {!!line.ref_fil_bio && (
            <Badge className="bg-green-500/10 text-green-700 text-[10px] py-0 px-1.5 gap-0.5">
              <Leaf className="h-2.5 w-2.5" />Bio
            </Badge>
          )}
          {!isEditing && nbLotsLies > 0 && (
            <Badge variant="secondary" className="text-[10px] py-0 px-1.5 gap-0.5">
              <Package className="h-2.5 w-2.5" />
              {nbLotsLies} lot{nbLotsLies > 1 ? 's' : ''}
              {totalKgLie > 0 ? ` · ${fmtNum(totalKgLie, 1)} kg` : ''}
            </Badge>
          )}
          <CommandeEtatBadge etat={line.etat} />
          {isEditing && !linesLocked && (
            <div className="flex gap-0.5">
              <Button
                variant="ghost" size="icon" className="h-6 w-6"
                onClick={(e) => { e.stopPropagation(); onToggleEtat() }}
                title={line.etat === 1 ? 'Marquer en cours' : 'Marquer livrée'}
              >
                {line.etat === 1 ? <Clock className="h-3 w-3" /> : <CheckCircle2 className="h-3 w-3" />}
              </Button>
              <Button variant="ghost" size="icon" className="h-6 w-6" onClick={(e) => { e.stopPropagation(); onEdit() }}>
                <Pencil className="h-3 w-3" />
              </Button>
              <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive" onClick={(e) => { e.stopPropagation(); onDelete() }}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          )}
        </div>
      </div>
      {/* Bottom row: quantite · prix · total · livraison */}
      <div className="flex items-center gap-3 mt-2 ml-9 text-[11px] text-muted-foreground tabular-nums">
        {line.quantite != null && <span>{fmtNum(Number(line.quantite), 1)} kg</span>}
        {line.prix_unitaire != null && Number(line.prix_unitaire) > 0 && (
          <span>× {fmtNum(Number(line.prix_unitaire), 2)} €/kg</span>
        )}
        {lineTotal > 0 && (
          <span className="font-medium text-foreground">→ {fmtNum(lineTotal, 2)} €</span>
        )}
        {line.date_livraison && (() => {
          const lineUrgency = deliveryUrgency(line.date_livraison, line.etat)
          return (
            <span
              className={cn(
                'ml-auto',
                lineUrgency === 'late' && 'font-bold text-red-600',
                lineUrgency === 'soon' && 'font-bold text-amber-600'
              )}
            >
              Livraison {formatHfsqlDate(line.date_livraison)}
            </span>
          )
        })()}
      </div>
    </div>
  )
}

// ── Stock linkage drawer ───────────────────────────────

function StockLinkDrawer({
  commandeId, ligne, onClose, onSuccess,
}: {
  commandeId: number
  ligne: LigneCommande
  onClose: () => void
  onSuccess: () => void
}) {
  const queryClient = useQueryClient()
  const queryKey = ['commande-fil-stock', commandeId, ligne.IDref_fil_commande]

  const { data, isLoading, isError } = useQuery<LineStockPayload>({
    queryKey,
    queryFn: () => apiFetch(`/commandes-fil/${commandeId}/lignes/${ligne.IDref_fil_commande}/stock`),
  })

  const linkMut = useMutation({
    mutationFn: (stockId: number) => apiFetch(
      `/commandes-fil/${commandeId}/lignes/${ligne.IDref_fil_commande}/stock/${stockId}`,
      { method: 'PUT' }
    ),
    onSuccess: (payload: LineStockPayload) => {
      queryClient.setQueryData(queryKey, payload)
      onSuccess()
    },
  })

  const unlinkMut = useMutation({
    mutationFn: (stockId: number) => apiFetch(
      `/commandes-fil/${commandeId}/lignes/${ligne.IDref_fil_commande}/stock/${stockId}`,
      { method: 'DELETE' }
    ),
    onSuccess: (payload: LineStockPayload) => {
      queryClient.setQueryData(queryKey, payload)
      onSuccess()
    },
  })

  const linked = data?.linked ?? []
  const available = data?.available ?? []

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden bg-zinc-100/80">
      {/* Minimal top bar — close X on a darker zinc strip, matching the
          §31.4 chrome convention (right DetailSidebar's tab header band). */}
      <div className="flex-shrink-0 px-2 py-1 border-b bg-zinc-200/50 flex items-center justify-end">
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          className="h-7 w-7"
          title="Fermer"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-3 space-y-4 scrollbar-transparent">
        {isLoading && (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => <div key={i} className="h-14 bg-muted animate-pulse rounded-lg" />)}
          </div>
        )}
        {isError && (
          <div className="flex flex-col items-center justify-center py-6 text-destructive">
            <AlertCircle className="h-6 w-6 mb-2" />
            <p className="text-sm">Erreur de chargement</p>
          </div>
        )}
        {!isLoading && !isError && linked.length === 0 && available.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Package className="h-8 w-8 mb-2 opacity-50" />
            <p className="text-sm font-medium">Aucun lot en stock</p>
            <p className="text-xs mt-1">Aucun lot de fil correspondant à cette ligne n'est encore entré en stock.</p>
          </div>
        )}

        {linked.length > 0 && (
          <section>
            <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1.5">
              Lots liés ({linked.length})
            </h3>
            <div className="space-y-1.5">
              {linked.map((lot) => (
                <StockLotRow
                  key={lot.IDstock_fil}
                  lot={lot}
                  action="unlink"
                  onAction={() => unlinkMut.mutate(lot.IDstock_fil)}
                  isBusy={unlinkMut.isPending && unlinkMut.variables === lot.IDstock_fil}
                />
              ))}
            </div>
          </section>
        )}

        {available.length > 0 && (
          <section>
            <h3 className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-1.5">
              Lots disponibles ({available.length})
            </h3>
            <div className="space-y-1.5">
              {available.map((lot) => (
                <StockLotRow
                  key={lot.IDstock_fil}
                  lot={lot}
                  action="link"
                  onAction={() => linkMut.mutate(lot.IDstock_fil)}
                  isBusy={linkMut.isPending && linkMut.variables === lot.IDstock_fil}
                />
              ))}
            </div>
          </section>
        )}

        {!isLoading && !isError && linked.length > 0 && available.length === 0 && (
          <p className="text-xs text-muted-foreground italic text-center">
            Aucun lot supplémentaire disponible pour ce fournisseur.
          </p>
        )}
      </div>
    </div>
  )
}

function StockLotRow({
  lot, action, onAction, isBusy,
}: {
  lot: StockLotLite
  action: 'link' | 'unlink'
  onAction: () => void
  isBusy: boolean
}) {
  const stockKg = Number(lot.stock) || 0
  const initialKg = Number(lot.stock_initial) || 0
  return (
    <div className="rounded-lg border border-border/60 bg-card shadow-sm p-3 flex items-center gap-3">
      <div className="h-8 w-8 rounded-md bg-zinc-100 flex items-center justify-center flex-shrink-0">
        <BobineIcon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-semibold truncate">Lot {lot.lot || '—'}</span>
          {lot.lot_frs && (
            <span className="text-xs text-muted-foreground truncate">· frs: {lot.lot_frs}</span>
          )}
          {!!lot.bio && (
            <Badge className="bg-green-500/10 text-green-700 text-[10px] py-0 px-1.5 gap-0.5">
              <Leaf className="h-2.5 w-2.5" />Bio
            </Badge>
          )}
          {!!lot.termine && (
            <Badge variant="secondary" className="text-[10px] py-0 px-1.5">Terminé</Badge>
          )}
        </div>
        <div className="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground tabular-nums">
          <span className="font-medium text-foreground">{fmtNum(stockKg, 1)} kg</span>
          {initialKg > 0 && initialKg !== stockKg && (
            <span>/ {fmtNum(initialKg, 1)} kg initial</span>
          )}
          {lot.emplacement && (
            <span className="flex items-center gap-0.5"><MapPin className="h-2.5 w-2.5" />{lot.emplacement}</span>
          )}
          {lot.date_entree && (
            <span>entré {formatHfsqlDate(lot.date_entree)}</span>
          )}
        </div>
      </div>
      <Button
        size="sm"
        variant={action === 'link' ? 'default' : 'outline'}
        onClick={onAction}
        disabled={isBusy}
        className="flex-shrink-0"
      >
        {isBusy ? (
          <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
        ) : action === 'link' ? (
          <Link2 className="h-3.5 w-3.5 mr-1.5" />
        ) : (
          <Unlink className="h-3.5 w-3.5 mr-1.5" />
        )}
        {action === 'link' ? 'Lier' : 'Dissocier'}
      </Button>
    </div>
  )
}

function LineFormFields({
  form, setForm, refsGrouped,
}: {
  form: { IDref_fil: number; IDcolori_fil: number; quantite: string; prix_unitaire: string; date_livraison: string }
  setForm: (f: typeof form) => void
  refsGrouped: { IDref_fil: number; reference: string; bio: boolean; coloris: { IDcolori_fil: number; reference: string }[] }[]
}) {
  const selectedRef = refsGrouped.find((r) => r.IDref_fil === form.IDref_fil)
  const coloris = selectedRef?.coloris ?? []

  return (
    <>
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Référence</label>
        <SearchableCombobox<{ IDref_fil: number; reference: string; bio: boolean }>
          options={refsGrouped}
          value={form.IDref_fil}
          onChange={(id) => setForm({ ...form, IDref_fil: id, IDcolori_fil: 0 })}
          getId={(r) => r.IDref_fil}
          getPrimary={(r) => `${r.reference}${r.bio ? ' (Bio)' : ''}`}
          placeholder="Choisir une référence"
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Coloris</label>
        <PopoverSelect
          options={coloris.map((c) => ({ id: c.IDcolori_fil, primary: c.reference }))}
          value={form.IDcolori_fil}
          onChange={(id) => setForm({ ...form, IDcolori_fil: id })}
          disabled={!form.IDref_fil}
          emptyLabel="— Choisir —"
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <LabeledInput label="Quantité (kg)" type="number" value={form.quantite} onChange={(v) => setForm({ ...form, quantite: v })} />
        <LabeledInput label="Prix (€/kg)" type="number" value={form.prix_unitaire} onChange={(v) => setForm({ ...form, prix_unitaire: v })} />
      </div>
      <LabeledInput label="Date livraison" type="date" value={form.date_livraison} onChange={(v) => setForm({ ...form, date_livraison: v })} />
    </>
  )
}

// ── Right Panel: Sidebar with Tabs ─────────────────────

type SidebarTab = 'info' | 'adresses' | 'docs' | 'journal'

function DetailSidebar({
  commande, isLoading, isEditing,
  editDateCommande, onEditDateCommandeChange,
  editCommentaire, onEditCommentaireChange,
  editJournal, onEditJournalChange,
  editIDModePaiement, onEditIDModePaiementChange,
  editIDEcheance, onEditIDEcheanceChange,
  editIDAdresseFacturation, onEditIDAdresseFacturationChange,
  editIDAdresseLivraison, onEditIDAdresseLivraisonChange,
  onToggleEtat, isTogglingEtat,
}: {
  commande: CommandeDetail | null
  isLoading: boolean
  isEditing: boolean
  editDateCommande: string
  onEditDateCommandeChange: (v: string) => void
  editCommentaire: string
  onEditCommentaireChange: (v: string) => void
  editJournal: string
  onEditJournalChange: (v: string) => void
  editIDModePaiement: number
  onEditIDModePaiementChange: (v: number) => void
  editIDEcheance: number
  onEditIDEcheanceChange: (v: number) => void
  editIDAdresseFacturation: number
  onEditIDAdresseFacturationChange: (v: number) => void
  editIDAdresseLivraison: number
  onEditIDAdresseLivraisonChange: (v: number) => void
  onToggleEtat: () => void
  isTogglingEtat: boolean
}) {
  const [activeTab, setActiveTab] = useState<SidebarTab>('info')

  const { data: modesPaiement } = useQuery<ModePaiement[]>({
    queryKey: ['lookup-modes-paiement'],
    queryFn: () => apiFetch('/commandes-fil/lookups/modes-paiement'),
    enabled: isEditing,
  })
  const { data: echeances } = useQuery<Echeance[]>({
    queryKey: ['lookup-echeances'],
    queryFn: () => apiFetch('/commandes-fil/lookups/echeances'),
    enabled: isEditing,
  })
  const { data: adresses } = useQuery<AdresseLookup[]>({
    queryKey: ['commande-fil-adresses', commande?.IDfournisseur],
    queryFn: () => apiFetch(`/commandes-fil/lookups/adresses?fournisseur=${commande?.IDfournisseur}`),
    enabled: isEditing && !!commande?.IDfournisseur,
  })

  if (isLoading) return (
    <div className="w-96 flex-shrink-0 bg-muted/30 rounded-xl border p-4 space-y-4">
      <div className="flex gap-2">
        <div className="h-8 flex-1 bg-muted animate-pulse rounded-md" />
        <div className="h-8 flex-1 bg-muted animate-pulse rounded-md" />
        <div className="h-8 flex-1 bg-muted animate-pulse rounded-md" />
      </div>
      {[1, 2, 3].map((i) => <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />)}
    </div>
  )
  if (!commande) return null

  const tabs: { key: SidebarTab; label: string; icon: React.ElementType }[] = [
    { key: 'info', label: 'Info', icon: Info },
    { key: 'adresses', label: 'Adresses', icon: MapPin },
    { key: 'docs', label: 'Docs', icon: FileText },
    { key: 'journal', label: 'Journal', icon: BookOpen },
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
                  : 'text-muted-foreground hover:bg-accent/10'
              )}
            >
              <Icon className="h-3.5 w-3.5" />{tab.label}
            </button>
          )
        })}
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-transparent">
        {activeTab === 'info' && (
          <InfoTab
            commande={commande}
            isEditing={isEditing}
            modesPaiement={modesPaiement ?? []}
            echeances={echeances ?? []}
            editDateCommande={editDateCommande}
            onEditDateCommandeChange={onEditDateCommandeChange}
            editCommentaire={editCommentaire}
            onEditCommentaireChange={onEditCommentaireChange}
            editIDModePaiement={editIDModePaiement}
            onEditIDModePaiementChange={onEditIDModePaiementChange}
            editIDEcheance={editIDEcheance}
            onEditIDEcheanceChange={onEditIDEcheanceChange}
          />
        )}
        {activeTab === 'adresses' && (
          <AdressesTab
            commande={commande}
            isEditing={isEditing}
            adresses={adresses ?? []}
            editIDAdresseFacturation={editIDAdresseFacturation}
            onEditIDAdresseFacturationChange={onEditIDAdresseFacturationChange}
            editIDAdresseLivraison={editIDAdresseLivraison}
            onEditIDAdresseLivraisonChange={onEditIDAdresseLivraisonChange}
          />
        )}
        {activeTab === 'docs' && (
          <DocsTab commande={commande} isEditing={isEditing} />
        )}
        {activeTab === 'journal' && (
          <JournalTab
            commande={commande}
            isEditing={isEditing}
            editJournal={editJournal}
            onEditJournalChange={onEditJournalChange}
          />
        )}
      </div>
      </div>
      <StatusFooter
        etat={commande.etat}
        onToggle={onToggleEtat}
        isToggling={isTogglingEtat}
        disabled={isEditing}
      />
    </div>
  )
}

// ── Sidebar Status Footer ──────────────────────────────

function StatusFooter({
  etat, onToggle, isToggling, disabled,
}: {
  etat: number | null
  onToggle: () => void
  isToggling: boolean
  disabled: boolean
}) {
  const isTerminee = etat === 1
  const Icon = isTerminee ? CheckCircle2 : Clock
  const label = isTerminee ? 'Terminée' : 'En cours'
  const actionLabel = isTerminee ? 'Rouvrir' : 'Clôturer'
  const ActionIcon = isTerminee ? Clock : CheckCircle2

  return (
    <div
      className={cn(
        'flex-shrink-0 rounded-xl border shadow-sm overflow-hidden flex items-stretch h-11',
        isTerminee ? 'bg-success border-success' : 'bg-primary border-primary'
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
        title={isTerminee ? 'Marquer en cours' : 'Marquer terminée'}
        className="px-3.5 bg-white/15 hover:bg-white/25 active:bg-white/30 disabled:bg-white/5 disabled:opacity-60 disabled:cursor-not-allowed text-white text-xs font-semibold border-l border-white/25 flex items-center gap-1.5 transition-colors"
      >
        <ActionIcon className="h-3.5 w-3.5" />
        {actionLabel}
      </button>
    </div>
  )
}

// ── Sidebar Tab: Info ──────────────────────────────────

function InfoTab({
  commande, isEditing, modesPaiement, echeances,
  editDateCommande, onEditDateCommandeChange,
  editCommentaire, onEditCommentaireChange,
  editIDModePaiement, onEditIDModePaiementChange,
  editIDEcheance, onEditIDEcheanceChange,
}: {
  commande: CommandeDetail
  isEditing: boolean
  modesPaiement: ModePaiement[]
  echeances: Echeance[]
  editDateCommande: string
  onEditDateCommandeChange: (v: string) => void
  editCommentaire: string
  onEditCommentaireChange: (v: string) => void
  editIDModePaiement: number
  onEditIDModePaiementChange: (v: number) => void
  editIDEcheance: number
  onEditIDEcheanceChange: (v: number) => void
}) {
  return (
    <div className="space-y-3">
      {/* Metadata card */}
      <div className={cn('p-3 rounded-lg border bg-card shadow-sm space-y-2', isEditing && editSectionClass)}>
        <KV label="Fournisseur" value={commande.fournisseur_nom || '—'} />
        <KV
          label="Date commande"
          value={isEditing ? (
            <input
              type="date"
              value={editDateCommande}
              onChange={(e) => onEditDateCommandeChange(e.target.value)}
              className="h-7 px-2 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring text-right"
            />
          ) : (commande.date_commande ? formatHfsqlDate(commande.date_commande) : '—')}
        />
        <KV
          label="Mode paiement"
          value={isEditing ? (
            <PopoverSelect
              size="sm"
              options={modesPaiement.map((m) => ({ id: m.IDmode_paiement, primary: m.libelle }))}
              value={editIDModePaiement}
              onChange={onEditIDModePaiementChange}
              emptyLabel="—"
            />
          ) : (commande.mode_paiement_libelle || '—')}
        />
        <KV
          label="Échéance"
          value={isEditing ? (
            <PopoverSelect
              size="sm"
              options={echeances.map((e) => ({ id: e.IDecheance, primary: e.libelle }))}
              value={editIDEcheance}
              onChange={onEditIDEcheanceChange}
              emptyLabel="—"
            />
          ) : (commande.echeance_libelle || '—')}
        />
      </div>

      {/* Commentaire card */}
      <div className={cn('p-3 rounded-lg border bg-card shadow-sm', isEditing && editSectionClass)}>
        <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
          <MessageSquare className="h-3.5 w-3.5" />Commentaire
        </p>
        {isEditing ? (
          <textarea
            value={editCommentaire}
            onChange={(e) => onEditCommentaireChange(e.target.value)}
            rows={4}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
          />
        ) : commande.commentaire?.trim() ? (
          <p className="text-sm text-muted-foreground whitespace-pre-line">{commande.commentaire.trim()}</p>
        ) : (
          <p className="text-sm text-muted-foreground italic">Aucun commentaire</p>
        )}
      </div>
    </div>
  )
}

// ── Sidebar Tab: Adresses ──────────────────────────────

function AdressesTab({
  commande, isEditing, adresses,
  editIDAdresseFacturation, onEditIDAdresseFacturationChange,
  editIDAdresseLivraison, onEditIDAdresseLivraisonChange,
}: {
  commande: CommandeDetail
  isEditing: boolean
  adresses: AdresseLookup[]
  editIDAdresseFacturation: number
  onEditIDAdresseFacturationChange: (v: number) => void
  editIDAdresseLivraison: number
  onEditIDAdresseLivraisonChange: (v: number) => void
}) {
  return (
    <div className="space-y-3">
      <AdresseCard
        label="Facturation"
        adresse={commande.adresse_facturation}
        isEditing={isEditing}
        options={adresses}
        selectedId={editIDAdresseFacturation}
        onSelect={onEditIDAdresseFacturationChange}
      />
      <AdresseCard
        label="Livraison"
        adresse={commande.adresse_livraison}
        isEditing={isEditing}
        options={adresses}
        selectedId={editIDAdresseLivraison}
        onSelect={onEditIDAdresseLivraisonChange}
      />
    </div>
  )
}

function AdresseCard({
  label, adresse, isEditing, options, selectedId, onSelect,
}: {
  label: string
  adresse: AdresseLite | null
  isEditing: boolean
  options: AdresseLookup[]
  selectedId: number
  onSelect: (id: number) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  // In edit mode, resolve the selected adresse from the lookup list so the preview
  // reflects the draft selection (not the saved one). Fall back to the saved adresse
  // if the lookup hasn't loaded yet.
  const displayAdresse: AdresseLite | null = isEditing
    ? (options.find((o) => o.IDadresse === selectedId) ?? adresse)
    : adresse

  return (
    <div className={cn('p-3 rounded-lg border bg-card shadow-sm', isEditing && editSectionClass)}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
          <MapPin className="h-3.5 w-3.5" />{label}
        </p>
        {isEditing && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px] gap-1"
            onClick={() => setPickerOpen(true)}
          >
            <Search className="h-3 w-3" />
            Choisir
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
      <AdressePickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        label={label}
        options={options}
        selectedId={selectedId}
        onSelect={(id) => { onSelect(id); setPickerOpen(false) }}
      />
    </div>
  )
}

function AdressePickerDialog({
  open, onClose, label, options, selectedId, onSelect,
}: {
  open: boolean
  onClose: () => void
  label: string
  options: AdresseLookup[]
  selectedId: number
  onSelect: (id: number) => void
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg space-y-4" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MapPin className="h-5 w-5 text-accent" />
            Choisir une adresse de {label.toLowerCase()}
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto space-y-2 px-1">
          {options.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <MapPin className="h-10 w-10 mb-2 opacity-40" />
              <p className="text-sm">Aucune adresse disponible</p>
            </div>
          ) : options.map((a) => {
            const isSelected = a.IDadresse === selectedId
            return (
              <button
                key={a.IDadresse}
                type="button"
                onClick={() => onSelect(a.IDadresse)}
                className={cn(
                  'w-full text-left p-3 rounded-lg border transition-all',
                  isSelected
                    ? 'border-accent bg-accent/5 ring-1 ring-accent'
                    : 'border-border bg-card hover:border-accent/50 hover:bg-accent/[0.02]'
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-medium text-sm truncate">{a.nom || `Adresse #${a.IDadresse}`}</p>
                      {!!a.est_defaut && (
                        <Badge variant="secondary" className="text-[10px] py-0">Principale</Badge>
                      )}
                      {!!a.est_defaut_facturation && (
                        <Badge variant="outline" className="text-[10px] py-0">Facturation</Badge>
                      )}
                      {!!a.est_defaut_livraison && (
                        <Badge variant="outline" className="text-[10px] py-0">Livraison</Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                      {a.adresse1 && <p className="truncate">{a.adresse1}</p>}
                      {a.adresse2 && <p className="truncate">{a.adresse2}</p>}
                      {a.adresse3 && <p className="truncate">{a.adresse3}</p>}
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
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Annuler</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Sidebar Tab: Docs ──────────────────────────────────

interface GedDocument {
  IDged: number
  nom: string | null
  commentaire: string | null
  IDtype_doc: number
  type_nom: string | null
  linked_lots: Array<{ IDstock_fil: number; lot: string | null }>
}

interface TypeDoc {
  IDtype_doc: number
  nom: string
}

function DocsTab({ commande, isEditing }: { commande: CommandeDetail; isEditing: boolean }) {
  const queryClient = useQueryClient()
  const commandeId = commande.IDcommande_fil
  const docsQueryKey = ['commande-fil-docs', commandeId] as const

  const { data, isLoading, error } = useQuery<GedDocument[]>({
    queryKey: docsQueryKey,
    queryFn: () => apiFetch(`/commandes-fil/${commandeId}/documents`),
  })

  const [viewDoc, setViewDoc] = useState<GedDocument | null>(null)
  const [editingDoc, setEditingDoc] = useState<GedDocument | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteDocConfirm, setDeleteDocConfirm] = useState<GedDocument | null>(null)

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: docsQueryKey })
  }, [queryClient, commandeId])

  const deleteMut = useMutation({
    mutationFn: (idged: number) =>
      apiFetch(`/commandes-fil/${commandeId}/documents/${idged}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  })

  return (
    <>
      {isLoading && (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="h-4 w-4 animate-spin text-accent" />
        </div>
      )}

      {!!error && (
        <div className="flex items-center gap-1.5 py-3 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5" />
          <span>Erreur de chargement</span>
        </div>
      )}

      {!isLoading && !error && !data?.length && (
        <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
          <FileText className="h-10 w-10 mb-3 opacity-40" />
          <p className="text-sm font-medium">Aucun document</p>
          <p className="text-[11px] mt-1 text-center">
            Les bons de commande, factures et autres documents liés à cette commande apparaîtront ici.
          </p>
        </div>
      )}

      {!!data?.length && (
        <div className="space-y-2">
          {data.map((doc) => {
            const title = doc.nom?.trim() || `Document #${doc.IDged}`
            return (
              <div
                key={doc.IDged}
                onClick={() => isEditing ? setEditingDoc(doc) : setViewDoc(doc)}
                className={cn(
                  'group p-3 rounded-lg border bg-card shadow-sm cursor-pointer hover:border-accent/40 transition-colors',
                  isEditing && editSectionClass,
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-amber-400/10">
                    <FileText className="h-3.5 w-3.5 text-amber-600" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate" title={title}>{title}</p>
                    {!!doc.type_nom && (
                      <p className="text-[11px] text-muted-foreground truncate">{doc.type_nom}</p>
                    )}
                  </div>
                  {doc.linked_lots.length > 0 && (
                    <div
                      className="flex items-center gap-1 min-w-0 max-w-[45%]"
                      title={doc.linked_lots.map((l) => `Lot ${l.lot || '—'}`).join(', ')}
                    >
                      <BobineIcon className="h-3 w-3 text-accent flex-shrink-0" />
                      <p className="text-[10px] text-muted-foreground truncate">
                        {doc.linked_lots.map((l) => `Lot ${l.lot || '—'}`).join(', ')}
                      </p>
                    </div>
                  )}
                  {isEditing && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-destructive hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                      onClick={(e) => {
                        e.stopPropagation()
                        setDeleteDocConfirm(doc)
                      }}
                      title="Supprimer"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  )}
                </div>
                {!!doc.commentaire?.trim() && (
                  <div className="flex items-start gap-1.5 mt-2 ml-9">
                    <MessageSquare className="h-3 w-3 text-muted-foreground/50 flex-shrink-0 mt-0.5" />
                    <p className="text-[11px] text-muted-foreground italic">{doc.commentaire.trim()}</p>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {isEditing && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full mt-2 text-muted-foreground hover:text-foreground"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="h-4 w-4 mr-1.5" />Ajouter un document
        </Button>
      )}

      <DocViewDialog
        commandeId={commandeId}
        doc={viewDoc}
        onClose={() => setViewDoc(null)}
      />

      <DocCreateEditDialog
        open={createOpen || editingDoc !== null}
        commandeId={commandeId}
        doc={editingDoc}
        onClose={() => { setCreateOpen(false); setEditingDoc(null) }}
        onSuccess={() => { setCreateOpen(false); setEditingDoc(null); invalidate() }}
      />

      <ConfirmDialog
        open={deleteDocConfirm !== null}
        title="Supprimer le document"
        description={deleteDocConfirm ? `« ${deleteDocConfirm.nom?.trim() || `Document #${deleteDocConfirm.IDged}`} » sera supprimé définitivement.` : undefined}
        confirmLabel="Supprimer"
        isPending={deleteMut.isPending}
        onCancel={() => setDeleteDocConfirm(null)}
        onConfirm={() => {
          if (deleteDocConfirm) {
            deleteMut.mutate(deleteDocConfirm.IDged, {
              onSuccess: () => setDeleteDocConfirm(null),
            })
          }
        }}
      />
    </>
  )
}

interface DocLotsPayload {
  linked: StockLotLite[]
  available: StockLotLite[]
}

function DocCreateEditDialog({
  open, commandeId, doc, onClose, onSuccess,
}: {
  open: boolean
  commandeId: number
  doc: GedDocument | null  // null = create mode
  onClose: () => void
  onSuccess: () => void
}) {
  const isNew = doc === null
  const queryClient = useQueryClient()
  const [nom, setNom] = useState('')
  const [idTypeDoc, setIdTypeDoc] = useState<number>(0)
  const [commentaire, setCommentaire] = useState('')
  const [newFile, setNewFile] = useState<File | null>(null)
  const [newFileUrl, setNewFileUrl] = useState<string | null>(null)
  const [removeFichier, setRemoveFichier] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingLotId, setPendingLotId] = useState<number | null>(null)
  // "all lots" (default) vs "specific selection". Initialized from server
  // state on first data arrival: zero stock_fil_ged rows = "all".
  const [allLotsMode, setAllLotsMode] = useState(true)
  const modeInitializedRef = useRef(false)

  const { data: typeDocs } = useQuery<TypeDoc[]>({
    queryKey: ['commande-fil-types-doc'],
    queryFn: () => apiFetch('/commandes-fil/lookups/type-doc'),
    enabled: open,
  })

  // Doc ↔ lot linkage — only meaningful once the doc has an IDged (i.e.
  // in edit mode). At create time the lots section stays hidden until the
  // user re-opens the dialog after the initial save.
  const lotsQueryKey = ['commande-fil-doc-lots', commandeId, doc?.IDged ?? 0] as const
  const { data: lotsData, isLoading: lotsLoading } = useQuery<DocLotsPayload>({
    queryKey: lotsQueryKey,
    queryFn: () => apiFetch(`/commandes-fil/${commandeId}/documents/${doc!.IDged}/lots`),
    enabled: open && !isNew && doc !== null,
  })

  const toggleLotMut = useMutation({
    mutationFn: async ({ stockId, linked }: { stockId: number; linked: boolean }): Promise<DocLotsPayload> => {
      const method = linked ? 'DELETE' : 'PUT'
      return apiFetch(`/commandes-fil/${commandeId}/documents/${doc!.IDged}/lots/${stockId}`, { method })
    },
    onMutate: ({ stockId }) => { setPendingLotId(stockId) },
    onSuccess: (payload) => {
      queryClient.setQueryData(lotsQueryKey, payload)
      // Keep the parent docs list in sync — the linked_lots field on each
      // card reflects stock_fil_ged and must refresh after any toggle.
      queryClient.invalidateQueries({ queryKey: ['commande-fil-docs', commandeId] })
      setPendingLotId(null)
    },
    onError: () => { setPendingLotId(null) },
  })

  const clearLotsMut = useMutation({
    mutationFn: (): Promise<DocLotsPayload> =>
      apiFetch(`/commandes-fil/${commandeId}/documents/${doc!.IDged}/lots`, { method: 'DELETE' }),
    onSuccess: (payload) => {
      queryClient.setQueryData(lotsQueryKey, payload)
      queryClient.invalidateQueries({ queryKey: ['commande-fil-docs', commandeId] })
    },
  })

  // Initialize the toggle state from the first server payload: if the doc
  // has no per-lot rows, treat it as "applies to all lots" by default.
  useEffect(() => {
    if (!open) { modeInitializedRef.current = false; return }
    if (lotsData && !modeInitializedRef.current) {
      setAllLotsMode(lotsData.linked.length === 0)
      modeInitializedRef.current = true
    }
  }, [open, lotsData])

  const handleAllLotsToggle = (nextAll: boolean) => {
    setAllLotsMode(nextAll)
    // Flipping back to "all" clears any previously-selected specific links.
    if (nextAll && lotsData && lotsData.linked.length > 0) {
      clearLotsMut.mutate()
    }
  }

  // Combined + sorted list for stable rendering (linked on top, then
  // available, each sorted by ref / colori / lot).
  const lotRows = useMemo(() => {
    if (!lotsData) return [] as Array<StockLotLite & { isLinked: boolean }>
    const sortFn = (a: StockLotLite, b: StockLotLite) =>
      (a.ref_fil ?? '').localeCompare(b.ref_fil ?? '') ||
      (a.colori_reference ?? '').localeCompare(b.colori_reference ?? '') ||
      (a.lot ?? '').localeCompare(b.lot ?? '')
    return [
      ...[...lotsData.linked].sort(sortFn).map((l) => ({ ...l, isLinked: true })),
      ...[...lotsData.available].sort(sortFn).map((l) => ({ ...l, isLinked: false })),
    ]
  }, [lotsData])

  // Reset form whenever the dialog opens (or the target doc changes).
  useEffect(() => {
    if (!open) return
    setNom(doc?.nom ?? '')
    setIdTypeDoc(doc?.IDtype_doc ?? 0)
    setCommentaire(doc?.commentaire ?? '')
    setNewFile(null)
    if (newFileUrl) URL.revokeObjectURL(newFileUrl)
    setNewFileUrl(null)
    setRemoveFichier(false)
    setError(null)
    setIsSaving(false)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, doc?.IDged])

  // Clean up blob URL when dialog closes.
  useEffect(() => {
    if (!open && newFileUrl) {
      URL.revokeObjectURL(newFileUrl)
      setNewFileUrl(null)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const handleFilePick = (f: File) => {
    if (newFileUrl) URL.revokeObjectURL(newFileUrl)
    setNewFile(f)
    setNewFileUrl(URL.createObjectURL(f))
    setRemoveFichier(false)
  }

  const handleRemoveFile = () => {
    if (newFileUrl) URL.revokeObjectURL(newFileUrl)
    setNewFile(null)
    setNewFileUrl(null)
    setRemoveFichier(true)
  }

  const handleSave = async () => {
    setError(null)
    setIsSaving(true)
    try {
      const formData = new FormData()
      formData.append('nom', nom)
      formData.append('commentaire', commentaire)
      formData.append('IDtype_doc', String(idTypeDoc))
      if (newFile) formData.append('fichier', newFile)
      if (removeFichier && !newFile) formData.append('remove_fichier', '1')

      const url = isNew
        ? `${API_URL}/commandes-fil/${commandeId}/documents`
        : `${API_URL}/commandes-fil/${commandeId}/documents/${doc!.IDged}`
      const method = isNew ? 'POST' : 'PUT'
      // Raw fetch with credentials: the shared apiFetch forces JSON, which
      // would clobber multer's multipart boundary.
      const res = await fetch(url, { method, body: formData, credentials: 'include' })
      if (!res.ok) {
        const txt = await res.text().catch(() => '')
        throw new Error(txt || `HTTP ${res.status}`)
      }
      onSuccess()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue')
      setIsSaving(false)
    }
  }

  // Preview source: freshly-picked file blob OR existing stored blob OR nothing.
  const previewUrl = newFileUrl
    ? newFileUrl
    : !isNew && !removeFichier && doc
      ? `${API_URL}/commandes-fil/${commandeId}/documents/${doc.IDged}/fichier#view=FitH`
      : null

  if (!open) return null

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-5xl h-[85vh] flex flex-col" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-accent" />
            {isNew ? 'Ajouter un document' : 'Modifier le document'}
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 min-h-0 flex gap-4">
          {/* Left: form fields */}
          <div className="w-80 flex-shrink-0 overflow-y-auto space-y-3 px-1">
            <LabeledInput label="Nom" value={nom} onChange={setNom} autoFocus />
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Type de document</label>
              <PopoverSelect
                options={(typeDocs ?? []).map((t) => ({ id: t.IDtype_doc, primary: t.nom }))}
                value={idTypeDoc}
                onChange={setIdTypeDoc}
                emptyLabel="— Aucun —"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Commentaire</label>
              <textarea
                value={commentaire}
                onChange={(e) => setCommentaire(e.target.value)}
                rows={4}
                className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
              />
            </div>
            {!isNew && doc && (
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border border-border/60 bg-white shadow-sm">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 text-xs font-semibold">
                      <BobineIcon className="h-3.5 w-3.5 text-accent" />
                      <span>Appliquer à tous les lots</span>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {allLotsMode
                        ? 'Ce document concerne toute la commande'
                        : lotsData
                          ? `${lotsData.linked.length} lot${lotsData.linked.length > 1 ? 's' : ''} sélectionné${lotsData.linked.length > 1 ? 's' : ''}`
                          : 'Sélection spécifique'}
                    </p>
                  </div>
                  {clearLotsMut.isPending && <Loader2 className="h-3 w-3 animate-spin text-accent flex-shrink-0" />}
                  <button
                    type="button"
                    role="switch"
                    aria-checked={allLotsMode}
                    disabled={lotsLoading || clearLotsMut.isPending}
                    onClick={() => handleAllLotsToggle(!allLotsMode)}
                    className={cn(
                      'relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors',
                      'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                      'disabled:opacity-50 disabled:cursor-not-allowed',
                      allLotsMode ? 'bg-accent shadow-inner' : 'bg-zinc-300 hover:bg-zinc-400/80',
                    )}
                  >
                    <span
                      className={cn(
                        'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ease-out',
                        allLotsMode ? 'translate-x-[18px]' : 'translate-x-0.5',
                      )}
                    />
                  </button>
                </div>

                {!allLotsMode && (
                  <div className="rounded-md border border-input bg-white max-h-48 overflow-y-auto scrollbar-transparent">
                    {lotsLoading && (
                      <div className="flex items-center justify-center py-4">
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
                      </div>
                    )}
                    {!lotsLoading && lotRows.length === 0 && (
                      <p className="px-2 py-3 text-[11px] text-muted-foreground italic text-center">
                        Aucun lot de fil pour cette commande
                      </p>
                    )}
                    {!lotsLoading && lotRows.length > 0 && (
                      <ul>
                        {lotRows.map((lot) => {
                          const isPending = pendingLotId === lot.IDstock_fil
                          return (
                            <li
                              key={lot.IDstock_fil}
                              className="flex items-center gap-2 px-2 py-1.5 border-b border-border/40 last:border-0 hover:bg-accent/5"
                            >
                              <input
                                type="checkbox"
                                checked={lot.isLinked}
                                disabled={isPending || toggleLotMut.isPending}
                                onChange={() => toggleLotMut.mutate({ stockId: lot.IDstock_fil, linked: lot.isLinked })}
                                className="h-3.5 w-3.5 rounded border-input text-accent focus:ring-2 focus:ring-ring cursor-pointer disabled:cursor-not-allowed"
                              />
                              <div className="min-w-0 flex-1">
                                <p className="text-[11px] font-medium truncate">
                                  {lot.ref_fil ?? '—'}
                                  {!!lot.colori_reference && <span className="text-muted-foreground"> · {lot.colori_reference}</span>}
                                </p>
                                <p className="text-[10px] text-muted-foreground truncate">
                                  Lot {lot.lot || '—'}
                                  {lot.stock != null && <span> · {fmtNum(Number(lot.stock), 1)} kg</span>}
                                  {!!lot.bio && <span className="text-green-600"> · Bio</span>}
                                </p>
                              </div>
                              {isPending && <Loader2 className="h-3 w-3 animate-spin text-accent flex-shrink-0" />}
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            )}
            {!!error && (
              <div className="flex items-start gap-1.5 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                <span className="break-all">{error}</span>
              </div>
            )}
          </div>

          {/* Right: viewer + file controls + action buttons */}
          <div className="flex-1 min-w-0 flex flex-col gap-2">
            <div className="flex-1 min-h-0 rounded-lg border border-border/60 bg-zinc-50 overflow-hidden">
              {previewUrl ? (
                <iframe src={previewUrl} className="w-full h-full" title="Document" />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center text-muted-foreground">
                  <FileText className="h-12 w-12 mb-2 opacity-30" />
                  <p className="text-sm">Aucun fichier</p>
                  <p className="text-[11px]">Choisissez un fichier ci-dessous</p>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <label className="cursor-pointer">
                <input
                  type="file"
                  className="hidden"
                  /* No `accept` filter: documents can be any file type (PDF,
                   * image, Excel, Word, email…). Omitting it makes the Windows
                   * picker show all files by default instead of forcing the
                   * user to switch to "Tous les fichiers". */
                  onClick={(e) => { (e.target as HTMLInputElement).value = '' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f) handleFilePick(f)
                  }}
                />
                <span className={cn(inputClass, 'inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/5 w-auto px-3')}>
                  <Upload className="h-3.5 w-3.5" />
                  {newFile ? newFile.name : 'Choisir un fichier'}
                </span>
              </label>
              {(newFile || (!isNew && !removeFichier && doc)) && (
                <Button variant="ghost" size="sm" className="h-8 px-2" onClick={handleRemoveFile} title="Retirer le fichier">
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
              <div className="flex items-center gap-2 ml-auto">
                <Button variant="outline" size="sm" onClick={onClose} disabled={isSaving}>Annuler</Button>
                <Button size="sm" onClick={handleSave} disabled={isSaving}>
                  {isSaving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                  <Save className="h-3.5 w-3.5 mr-1.5" />
                  Enregistrer
                </Button>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function DocViewDialog({
  commandeId, doc, onClose,
}: { commandeId: number; doc: GedDocument | null; onClose: () => void }) {
  const [fichierOk, setFichierOk] = useState<boolean | null>(null)

  useEffect(() => {
    if (!doc) { setFichierOk(null); return }
    setFichierOk(null)
    fetch(`${API_URL}/commandes-fil/${commandeId}/documents/${doc.IDged}/fichier`, {
      method: 'HEAD',
      credentials: 'include',
    })
      .then((r) => setFichierOk(r.ok))
      .catch(() => setFichierOk(false))
  }, [doc?.IDged, commandeId])

  if (!doc) return null

  return (
    <Dialog open={!!doc} onOpenChange={() => onClose()}>
      {fichierOk ? (
        <div
          className="relative z-50 w-[60vw] max-w-3xl h-[95vh]"
          onClick={(e) => e.stopPropagation()}
        >
          <iframe
            src={`${API_URL}/commandes-fil/${commandeId}/documents/${doc.IDged}/fichier#view=FitH`}
            className="w-full h-full rounded-lg"
            title={doc.nom ?? 'Document'}
          />
        </div>
      ) : (
        <DialogContent className="max-w-sm" onClose={onClose}>
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <div className="text-center space-y-2">
              <FileText className="h-12 w-12 mx-auto opacity-30" />
              <p className="text-sm">
                {fichierOk === null ? 'Chargement...' : 'Aucun document attaché'}
              </p>
            </div>
          </div>
        </DialogContent>
      )}
    </Dialog>
  )
}

// ── Sidebar Tab: Journal ───────────────────────────────

function JournalTab({
  commande, isEditing, editJournal, onEditJournalChange,
}: {
  commande: CommandeDetail
  isEditing: boolean
  editJournal: string
  onEditJournalChange: (v: string) => void
}) {
  return (
    <div className={cn('p-3 rounded-lg border bg-card shadow-sm', isEditing && editSectionClass)}>
      <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
        <BookOpen className="h-3.5 w-3.5" />Journal
      </p>
      {isEditing ? (
        <textarea
          value={editJournal}
          onChange={(e) => onEditJournalChange(e.target.value)}
          rows={16}
          placeholder="Entrées de journal..."
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y font-mono"
        />
      ) : commande.journal?.trim() ? (
        <p className="text-sm text-muted-foreground whitespace-pre-line font-mono">{commande.journal.trim()}</p>
      ) : (
        <p className="text-sm text-muted-foreground italic">Aucune entrée de journal</p>
      )}
    </div>
  )
}

// ── Create Dialog ──────────────────────────────────────

function CreateCommandeDialog({
  open, onClose, onCreated,
}: {
  open: boolean
  onClose: () => void
  onCreated: (newId: number) => void
}) {
  const [fournisseurId, setFournisseurId] = useState<number>(0)
  const [dateCommande, setDateCommande] = useState<string>(() => new Date().toISOString().slice(0, 10))
  const [modePaiementId, setModePaiementId] = useState<number>(0)
  const [echeanceId, setEcheanceId] = useState<number>(0)
  const [adresseFactId, setAdresseFactId] = useState<number>(0)
  const [adresseLivId, setAdresseLivId] = useState<number>(0)
  const [commentaire, setCommentaire] = useState('')

  const { data: fournisseurs } = useQuery<FournisseurLite[]>({
    queryKey: ['fournisseurs-lite'],
    queryFn: () => apiFetch('/fournisseurs'),
    enabled: open,
  })
  const { data: modesPaiement } = useQuery<ModePaiement[]>({
    queryKey: ['lookup-modes-paiement'],
    queryFn: () => apiFetch('/commandes-fil/lookups/modes-paiement'),
    enabled: open,
  })
  const { data: echeances } = useQuery<Echeance[]>({
    queryKey: ['lookup-echeances'],
    queryFn: () => apiFetch('/commandes-fil/lookups/echeances'),
    enabled: open,
  })
  const { data: adresses } = useQuery<AdresseLookup[]>({
    queryKey: ['create-commande-adresses', fournisseurId],
    queryFn: () => apiFetch(`/commandes-fil/lookups/adresses?fournisseur=${fournisseurId}`),
    enabled: open && fournisseurId > 0,
  })

  // Auto-select default addresses when supplier changes
  useEffect(() => {
    if (!adresses) return
    const defaultFact = adresses.find((a) => a.est_defaut_facturation) ?? adresses.find((a) => a.est_defaut) ?? adresses[0]
    const defaultLiv = adresses.find((a) => a.est_defaut_livraison) ?? adresses.find((a) => a.est_defaut) ?? adresses[0]
    setAdresseFactId(defaultFact?.IDadresse ?? 0)
    setAdresseLivId(defaultLiv?.IDadresse ?? 0)
  }, [adresses])

  // Reset when dialog closes
  useEffect(() => {
    if (!open) {
      setFournisseurId(0)
      setDateCommande(new Date().toISOString().slice(0, 10))
      setModePaiementId(0)
      setEcheanceId(0)
      setAdresseFactId(0)
      setAdresseLivId(0)
      setCommentaire('')
    }
  }, [open])

  const createMut = useMutation({
    mutationFn: () => apiFetch('/commandes-fil', {
      method: 'POST',
      body: JSON.stringify({
        IDfournisseur: fournisseurId,
        date_commande: inputDateToHfsql(dateCommande),
        IDmode_paiement: modePaiementId || 0,
        IDecheance: echeanceId || 0,
        IDadresse_fournisseur: adresseFactId || 0,
        IDadresse_livraison: adresseLivId || 0,
        commentaire,
      }),
    }),
    onSuccess: (data: { IDcommande_fil: number }) => onCreated(data.IDcommande_fil),
  })

  const canSave = fournisseurId > 0 && dateCommande.length > 0

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShoppingCart className="h-5 w-5 text-accent" />
            Nouvelle commande
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Fournisseur</label>
            <SearchableCombobox<FournisseurLite>
              options={fournisseurs ?? []}
              value={fournisseurId}
              onChange={setFournisseurId}
              getId={(f) => f.IDfournisseur}
              getPrimary={(f) => f.nom}
              placeholder="Choisir un fournisseur"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Date commande</label>
            <input
              type="date"
              value={dateCommande}
              onChange={(e) => setDateCommande(e.target.value)}
              className={cn(inputClass, 'h-9')}
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Mode paiement</label>
              <PopoverSelect
                options={(modesPaiement ?? []).map((m) => ({ id: m.IDmode_paiement, primary: m.libelle }))}
                value={modePaiementId}
                onChange={setModePaiementId}
                emptyLabel="—"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Échéance</label>
              <PopoverSelect
                options={(echeances ?? []).map((e) => ({ id: e.IDecheance, primary: e.libelle }))}
                value={echeanceId}
                onChange={setEcheanceId}
                emptyLabel="—"
              />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Commentaire</label>
            <textarea
              value={commentaire}
              onChange={(e) => setCommentaire(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={() => createMut.mutate()} disabled={!canSave || createMut.isPending}>
            {createMut.isPending ? (
              <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />Création...</>
            ) : (
              <><Save className="h-3.5 w-3.5 mr-1.5" />Créer</>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Shared components ──────────────────────────────────

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm text-right truncate">{value}</span>
    </div>
  )
}

function LabeledInput({
  label, value, onChange, type = 'text', autoFocus,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  autoFocus?: boolean
}) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        autoComplete="off"
        data-form-type="other"
        data-lpignore="true"
        className={inputClass}
      />
    </div>
  )
}

function InlineForm({
  title, children, onSave, onCancel, isSaving,
}: {
  title: string
  children: React.ReactNode
  onSave: () => void
  onCancel: () => void
  isSaving: boolean
}) {
  return (
    <div className="rounded-lg border border-accent/25 bg-accent/[0.03] p-4 space-y-3">
      <p className="text-xs font-semibold text-accent uppercase tracking-wide">{title}</p>
      {children}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" size="sm" onClick={onCancel}>Annuler</Button>
        <Button size="sm" onClick={onSave} disabled={isSaving}>
          {isSaving ? 'Enregistrement...' : 'Enregistrer'}
        </Button>
      </div>
    </div>
  )
}
