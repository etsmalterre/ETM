import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useHasPermission } from '@/contexts/PermissionsContext'
import { UnsavedChangesDialog } from '@/components/shared/UnsavedChangesDialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import {
  FileText,
  Search,
  Loader2,
  AlertCircle,
  MapPin,
  Info,
  History,
  Pencil,
  Plus,
  X,
  Save,
  Trash2,
  MessageSquare,
  CheckCircle2,
  Clock,
  Layers,
  Printer,
  AtSign,
  Upload,
  ShoppingCart,
  ArrowRight,
  Sparkles,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { PopoverSelect, SearchableCombobox } from '@/components/ui/popover-select'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'
import { SendEmailDialog } from '@/components/email/SendEmailDialog'
import { cn } from '@/lib/utils'
import { formatHfsqlDate, hfsqlDateToInput, inputDateToHfsql } from '@/lib/dates'
import { fmtNum } from '@/lib/format'
import { apiFetch, API_URL } from '@/lib/api'
import { postEmail } from '@/lib/email'

// ── Types ──────────────────────────────────────────────

interface DevisListRow {
  IDDevis_etm: number
  IDclient: number
  IDprospect: number
  numero: number | null
  date: string | null
  date_expiration: string | null
  est_soldee: number
  IDcommande_ETM: number
  client_nom: string
  prospect_nom: string
  total_eur: number
  total_qte: number
  nb_lignes: number
}

interface LigneDevis {
  IDligne_devis_etm: number
  IDDevis_etm: number
  type: number // 1=écru, 2=fini, 3=divers
  IDreference: number
  IDref_ecru: number
  IDcolori: number
  quantite: number
  unite: number
  unite_label: string
  prix: number
  poids: number
  date_livraison: string | null
  commentaire: string | null
  ref_label: string | null
  ref_kind: 'ecru' | 'fini' | 'divers' | null
  colori_reference: string | null
  montant: number
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
  est_defaut_facturation: number
  est_defaut_livraison: number
}

interface DevisDetail {
  IDDevis_etm: number
  IDclient: number
  IDprospect: number
  client_nom: string
  prospect_nom: string
  prospect_email: string | null
  numero: number | null
  date: string | null
  date_expiration: string | null
  ref_client: string | null
  IDadresse_livraison: number
  IDadresse_facturation: number
  IDmode_paiement: number
  IDecheance: number
  commentaire: string | null
  commentaire_interne: string | null
  observations_facturation: string | null
  est_soldee: number
  remise: number // fraction (0.05 = 5%)
  frais_port: number
  IDcommande_ETM: number
  adresse_livraison: AdresseLite | null
  adresse_facturation: AdresseLite | null
  lignes: LigneDevis[]
}

interface ClientLite { IDclient: number; nom: string }
interface ModePaiement { IDmode_paiement: number; libelle: string }
interface Echeance { IDecheance: number; libelle: string }
interface RefEcru { IDref_ecru: number; reference: string }
interface RefFini { IDref_fini: number; reference: string; designation: string; avec_teinture: number }
interface RefDivers { IDref_divers: number; designation: string; unite: number }
interface ColoriOption { id: number; reference: string }

// ── Shared styling ─────────────────────────────────────

const inputClass = 'w-full h-8 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring'
const editSectionClass = 'border-l-4 border-l-accent/70 bg-accent/[0.03]'

// ── Status helpers (binary est_soldee → footer + list pill) ──

const STATUT_META = {
  open: { label: 'En cours', solid: 'bg-primary border-primary', icon: Clock },
  solde: { label: 'Soldé', solid: 'bg-success border-success', icon: CheckCircle2 },
} as const

function StatutPill({ soldee, className }: { soldee: number; className?: string }) {
  const meta = soldee === 1 ? STATUT_META.solde : STATUT_META.open
  const Icon = meta.icon
  return (
    <Badge variant="outline" className={cn('text-[10px] py-0 gap-1 border text-white', meta.solid, className)}>
      <Icon className="h-2.5 w-2.5" />{meta.label}
    </Badge>
  )
}

// Prospect chip — category tag (§36 style, own hue) marking a devis attached
// to a prospect rather than a client (#1112).
function ProspectChip({ className }: { className?: string }) {
  return (
    <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium bg-violet-500/10 text-violet-700 border border-violet-500/25', className)}>
      Prospect
    </span>
  )
}

/** Display name of the devis's counterpart: the client, else the prospect. */
function devisTiers(d: { client_nom: string; prospect_nom: string }): string {
  return d.client_nom || d.prospect_nom || ''
}

// Line type chip — category color per écru / fini / divers (matches Commandes).
function lineTypeChip(type: number): { label: string; classes: string } | null {
  if (type === 1) return { label: 'Écru', classes: 'bg-amber-500/15 text-amber-800 border border-amber-500/30' }
  if (type === 2) return { label: 'Fini', classes: 'bg-sky-500/10 text-sky-700 border border-sky-500/25' }
  if (type === 3) return { label: 'Divers', classes: 'bg-stone-500/10 text-stone-700 border border-stone-500/25' }
  return null
}

// Validity-urgency flag based on date_expiration (the devis deadline).
function expirationUrgency(expirationHfsql: string | null, estSoldee: number): 'late' | 'soon' | null {
  if (estSoldee === 1) return null
  if (!expirationHfsql || !/^\d{8}$/.test(expirationHfsql)) return null // no expiration = not flagged
  const target = new Date(Number(expirationHfsql.slice(0, 4)), Number(expirationHfsql.slice(4, 6)) - 1, Number(expirationHfsql.slice(6, 8)))
  target.setHours(0, 0, 0, 0)
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86_400_000)
  if (diffDays <= 0) return 'late'
  if (diffDays <= 3) return 'soon'
  return null
}

function lineCardBorder(type: number): string {
  if (type === 1) return 'border-l-amber-400/60'
  if (type === 2) return 'border-l-sky-400/60'
  return 'border-l-stone-400/60'
}

// ── Main Page ──────────────────────────────────────────

export function ClientsDevis() {
  const queryClient = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  // Deep link from Prospects › Demandes (« Créer un devis » / the Devis tab):
  // /clients/devis?devis=<id> arrives with the target selected. Status filter
  // starts at 'all' so the linked devis is in the list whatever its state.
  const linkedDevisId = (() => {
    const raw = parseInt(searchParams.get('devis') ?? '', 10)
    return isNaN(raw) || raw <= 0 ? null : raw
  })()
  const [selectedId, setSelectedId] = useState<number | null>(linkedDevisId)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'open' | 'terminee'>(linkedDevisId !== null ? 'all' : 'open')
  const canEditProspectDevis = useHasPermission('devis_prospect')
  const [isEditing, setIsEditing] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [emailModalOpen, setEmailModalOpen] = useState(false)
  const [autoEditForId, setAutoEditForId] = useState<number | null>(null)
  const [deleteDevisConfirmOpen, setDeleteDevisConfirmOpen] = useState(false)
  const [convertConfirmOpen, setConvertConfirmOpen] = useState(false)
  const [convertResult, setConvertResult] = useState<{ numero: number } | null>(null)

  // Edit-mode header draft.
  const [editDate, setEditDate] = useState('')
  const [editDateExpiration, setEditDateExpiration] = useState('')
  const [editRefClient, setEditRefClient] = useState('')
  const [editCommentaire, setEditCommentaire] = useState('')
  const [editCommentaireInterne, setEditCommentaireInterne] = useState('')
  const [editIDModePaiement, setEditIDModePaiement] = useState(0)
  const [editIDEcheance, setEditIDEcheance] = useState(0)
  const [editRemise, setEditRemise] = useState('') // percentage as typed
  const [editFraisPort, setEditFraisPort] = useState('')
  const [editIDAdresseFacturation, setEditIDAdresseFacturation] = useState(0)
  const [editIDAdresseLivraison, setEditIDAdresseLivraison] = useState(0)

  const originalDraftRef = useRef<Record<string, string | number> | null>(null)
  const [linesDirty, setLinesDirty] = useState(false)

  // Consume the deep-link param once — it already seeded the initial state,
  // and leaving it in the URL would re-select on every refresh.
  useEffect(() => {
    if (searchParams.has('devis')) {
      const next = new URLSearchParams(searchParams)
      next.delete('devis')
      setSearchParams(next, { replace: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery.trim()), 250)
    return () => clearTimeout(t)
  }, [searchQuery])

  const { data: devis, isLoading, isError, error, isFetching } = useQuery<DevisListRow[]>({
    queryKey: ['devis', statusFilter, debouncedQuery],
    queryFn: () => apiFetch(`/devis?status=${statusFilter}&q=${encodeURIComponent(debouncedQuery)}&limit=200`),
  })

  const { data: detail, isLoading: detailLoading } = useQuery<DevisDetail>({
    queryKey: ['devis-detail', selectedId],
    queryFn: () => apiFetch(`/devis/${selectedId}`),
    enabled: selectedId !== null,
  })

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['devis'] })
    queryClient.invalidateQueries({ queryKey: ['devis-detail', selectedId] })
  }, [queryClient, selectedId])

  const startEdit = useCallback(() => {
    if (!detail) return
    const snapshot = {
      date: hfsqlDateToInput(detail.date),
      dateExpiration: hfsqlDateToInput(detail.date_expiration),
      refClient: detail.ref_client?.trim() ?? '',
      commentaire: detail.commentaire?.trim() ?? '',
      commentaireInterne: detail.commentaire_interne?.trim() ?? '',
      IDmodePaiement: detail.IDmode_paiement ?? 0,
      IDecheance: detail.IDecheance ?? 0,
      remise: detail.remise ? String(Math.round(detail.remise * 100 * 100) / 100) : '',
      fraisPort: detail.frais_port ? String(detail.frais_port) : '',
      IDadresseFact: detail.IDadresse_facturation ?? 0,
      IDadresseLiv: detail.IDadresse_livraison ?? 0,
    }
    setEditDate(snapshot.date)
    setEditDateExpiration(snapshot.dateExpiration)
    setEditRefClient(snapshot.refClient)
    setEditCommentaire(snapshot.commentaire)
    setEditCommentaireInterne(snapshot.commentaireInterne)
    setEditIDModePaiement(snapshot.IDmodePaiement)
    setEditIDEcheance(snapshot.IDecheance)
    setEditRemise(snapshot.remise)
    setEditFraisPort(snapshot.fraisPort)
    setEditIDAdresseFacturation(snapshot.IDadresseFact)
    setEditIDAdresseLivraison(snapshot.IDadresseLiv)
    originalDraftRef.current = snapshot
    setIsEditing(true)
  }, [detail])

  const cancelEdit = useCallback(() => setIsEditing(false), [])

  const isDirty = useMemo(() => {
    if (!isEditing) return false
    const o = originalDraftRef.current
    if (!o) return false
    if (editDate !== o.date) return true
    if (editDateExpiration !== o.dateExpiration) return true
    if (editRefClient !== o.refClient) return true
    if (editCommentaire !== o.commentaire) return true
    if (editCommentaireInterne !== o.commentaireInterne) return true
    if (editIDModePaiement !== o.IDmodePaiement) return true
    if (editIDEcheance !== o.IDecheance) return true
    if (editRemise !== o.remise) return true
    if (editFraisPort !== o.fraisPort) return true
    if (editIDAdresseFacturation !== o.IDadresseFact) return true
    if (editIDAdresseLivraison !== o.IDadresseLiv) return true
    if (linesDirty) return true
    return false
  }, [isEditing, editDate, editDateExpiration, editRefClient, editCommentaire, editCommentaireInterne, editIDModePaiement, editIDEcheance, editRemise, editFraisPort, editIDAdresseFacturation, editIDAdresseLivraison, linesDirty])

  const saveHeaderMut = useMutation({
    mutationFn: () => apiFetch(`/devis/${selectedId}`, {
      method: 'PUT',
      body: JSON.stringify({
        date: inputDateToHfsql(editDate),
        date_expiration: editDateExpiration ? inputDateToHfsql(editDateExpiration) : '',
        ref_client: editRefClient,
        commentaire: editCommentaire,
        commentaire_interne: editCommentaireInterne,
        IDmode_paiement: editIDModePaiement || 0,
        IDecheance: editIDEcheance || 0,
        remise: editRemise ? (Number(editRemise) || 0) / 100 : 0,
        frais_port: Number(editFraisPort) || 0,
        IDadresse_facturation: editIDAdresseFacturation || 0,
        IDadresse_livraison: editIDAdresseLivraison || 0,
      }),
    }),
    onSuccess: () => { invalidateAll(); setIsEditing(false) },
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/devis/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, deletedId) => {
      const cached = queryClient.getQueryData<DevisListRow[]>(['devis', statusFilter, debouncedQuery]) ?? []
      const remaining = cached.filter((c) => c.IDDevis_etm !== deletedId)
      queryClient.invalidateQueries({ queryKey: ['devis'] })
      setIsEditing(false)
      setDeleteDevisConfirmOpen(false)
      setSelectedId(remaining.length > 0 ? remaining[0].IDDevis_etm : null)
    },
  })

  const convertMut = useMutation({
    mutationFn: (id: number) => apiFetch<{ IDcommande_client: number; numero: number }>(`/devis/${id}/convert`, { method: 'POST' }),
    onSuccess: (data) => {
      setConvertConfirmOpen(false)
      setConvertResult({ numero: data.numero })
      invalidateAll()
      queryClient.invalidateQueries({ queryKey: ['commandes-client'] })
    },
  })

  useEffect(() => {
    if (autoEditForId !== null && detail?.IDDevis_etm === autoEditForId) {
      startEdit()
      setAutoEditForId(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEditForId, detail])

  const guard = useUnsavedGuard({
    isDirty,
    save: async () => { await saveHeaderMut.mutateAsync() },
    onDiscard: () => { setIsEditing(false) },
  })

  const toggleEtatMut = useMutation({
    mutationFn: (newEtat: number) => apiFetch(`/devis/${selectedId}/etat`, {
      method: 'PUT',
      body: JSON.stringify({ est_soldee: newEtat }),
    }),
    onSuccess: invalidateAll,
  })

  const handleSelect = useCallback((id: number) => {
    guard.guardAction(() => { setIsEditing(false); setSelectedId(id) })
  }, [guard])

  const handleStatusFilterChange = useCallback((s: 'all' | 'open' | 'terminee') => {
    guard.guardAction(() => { setIsEditing(false); setStatusFilter(s); setSelectedId(null) })
  }, [guard])

  const rows = devis ?? []

  // A prospect devis is writable only with the devis_prospect key; client
  // devis writes stay open (matching the API's gating).
  const isProspectDevis = (detail?.IDprospect ?? 0) > 0
  const canEditCurrent = !isProspectDevis || canEditProspectDevis

  useAutoSelectFirst({
    rows,
    selectedId,
    getId: (c) => c.IDDevis_etm,
    select: setSelectedId,
    suspended: isEditing || isFetching,
  })

  return (
    <>
      <MasterDetailLayout
        list={
          <DevisList
            rows={rows}
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
            devis={detail ?? null}
            isLoading={detailLoading && selectedId !== null}
            isEditing={isEditing}
            canEdit={canEditCurrent}
            onStartEdit={startEdit}
            onCancelEdit={cancelEdit}
            onSave={() => saveHeaderMut.mutate()}
            isSaving={saveHeaderMut.isPending}
            onDelete={() => setDeleteDevisConfirmOpen(true)}
            onPrintClick={() => { if (selectedId !== null) window.open(`${API_URL}/devis/${selectedId}/pdf`, '_blank') }}
            onEmailClick={() => setEmailModalOpen(true)}
            onConvertClick={() => setConvertConfirmOpen(true)}
          />
        }
        detail={
          <DetailMain
            devis={detail ?? null}
            isLoading={detailLoading && selectedId !== null}
            hasSelection={selectedId !== null}
            isEditing={isEditing}
            onMutationSuccess={invalidateAll}
            onLinesDirtyChange={setLinesDirty}
          />
        }
        sidebar={selectedId !== null ? (
          <DetailSidebar
            devis={detail ?? null}
            isLoading={detailLoading}
            isEditing={isEditing}
            editDate={editDate} onEditDateChange={setEditDate}
            editDateExpiration={editDateExpiration} onEditDateExpirationChange={setEditDateExpiration}
            editRefClient={editRefClient} onEditRefClientChange={setEditRefClient}
            editCommentaire={editCommentaire} onEditCommentaireChange={setEditCommentaire}
            editCommentaireInterne={editCommentaireInterne} onEditCommentaireInterneChange={setEditCommentaireInterne}
            editIDModePaiement={editIDModePaiement} onEditIDModePaiementChange={setEditIDModePaiement}
            editIDEcheance={editIDEcheance} onEditIDEcheanceChange={setEditIDEcheance}
            editRemise={editRemise} onEditRemiseChange={setEditRemise}
            editFraisPort={editFraisPort} onEditFraisPortChange={setEditFraisPort}
            editIDAdresseFacturation={editIDAdresseFacturation} onEditIDAdresseFacturationChange={setEditIDAdresseFacturation}
            editIDAdresseLivraison={editIDAdresseLivraison} onEditIDAdresseLivraisonChange={setEditIDAdresseLivraison}
            onToggleEtat={() => toggleEtatMut.mutate(detail?.est_soldee === 1 ? 0 : 1)}
            isTogglingEtat={toggleEtatMut.isPending}
            canEdit={canEditCurrent}
          />
        ) : null}
        sidebarTitle="Informations"
        hasSelection={selectedId !== null}
        onBack={() => guard.guardAction(() => { setIsEditing(false); setSelectedId(null) })}
      />

      <UnsavedChangesDialog open={guard.showDialog} onAction={guard.handleAction} isSaving={guard.isSaving} />

      <CreateDevisDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(newId) => {
          setCreateOpen(false)
          queryClient.invalidateQueries({ queryKey: ['devis'] })
          setSelectedId(newId)
          setAutoEditForId(newId)
        }}
      />

      <ConfirmDialog
        open={deleteDevisConfirmOpen}
        title="Supprimer le devis"
        description="Cette action supprimera le devis et ses lignes. Elle est irréversible."
        confirmLabel="Supprimer"
        isPending={deleteMut.isPending}
        onCancel={() => setDeleteDevisConfirmOpen(false)}
        onConfirm={() => { if (selectedId !== null) deleteMut.mutate(selectedId) }}
      />

      <ConfirmDialog
        open={convertConfirmOpen}
        variant="default"
        title="Passer le devis en commande"
        description="Une commande client sera créée à partir de ce devis (mêmes lignes et conditions). Le devis sera marqué soldé."
        confirmLabel="Passer en commande"
        isPending={convertMut.isPending}
        onCancel={() => setConvertConfirmOpen(false)}
        onConfirm={() => { if (selectedId !== null) convertMut.mutate(selectedId) }}
      />

      <Dialog open={convertResult !== null} onOpenChange={(o) => { if (!o) setConvertResult(null) }}>
        <DialogContent className="max-w-sm" onClose={() => setConvertResult(null)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><ShoppingCart className="h-5 w-5 text-accent" />Commande créée</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center justify-center py-6 text-center">
            <div className="icon-box-gold h-14 w-14 mb-3"><CheckCircle2 className="h-7 w-7" /></div>
            <p className="text-sm">Le devis a été transformé en commande client</p>
            {convertResult && <p className="text-lg font-heading font-bold tracking-tight mt-1">N° {convertResult.numero}</p>}
            <p className="text-xs text-muted-foreground mt-2">Retrouvez-la dans Clients › Commandes.</p>
          </div>
          <DialogFooter>
            <Button onClick={() => setConvertResult(null)}>Fermer</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {selectedId !== null && (
        <SendEmailDialog
          open={emailModalOpen}
          onClose={() => setEmailModalOpen(false)}
          contextLabel={detail ? devisTiers(detail) || undefined : undefined}
          queryKey={['devis-email-defaults', selectedId]}
          loadDefaults={() => apiFetch(`/devis/${selectedId}/email-defaults`)}
          pdfUrl={`${API_URL}/devis/${selectedId}/pdf`}
          pdfAttachmentLabel={`devis-${selectedId}.pdf`}
          onSend={async (p) => {
            await postEmail(`${API_URL}/devis/${selectedId}/email`, p, { includeAttachPdf: true })
            // The send logs an envoi_email row server-side — refresh the
            // historique tab without a manual reload.
            queryClient.invalidateQueries({ queryKey: ['devis-historique', selectedId] })
          }}
        />
      )}
    </>
  )
}

// ── Left Panel: List ───────────────────────────────────

function DevisList({
  rows, isLoading, isError, error,
  selectedId, onSelect,
  searchQuery, onSearchChange,
  statusFilter, onStatusFilterChange,
  onNew, isEditing,
}: {
  rows: DevisListRow[]
  isLoading: boolean
  isError: boolean
  error: Error | null
  selectedId: number | null
  onSelect: (id: number) => void
  searchQuery: string
  onSearchChange: (q: string) => void
  statusFilter: 'all' | 'open' | 'terminee'
  onStatusFilterChange: (s: 'all' | 'open' | 'terminee') => void
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
            placeholder="Rechercher (n°, client...)"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            autoComplete="off"
            className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex gap-1">
          {([
            { key: 'open', label: 'En cours' },
            { key: 'terminee', label: 'Soldés' },
            { key: 'all', label: 'Tous' },
          ] as const).map((opt) => (
            <button
              key={opt.key}
              onClick={() => onStatusFilterChange(opt.key)}
              className={cn(
                'flex-1 px-2 py-1 text-xs rounded-md transition-colors',
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
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <FileText className="h-12 w-12 mb-3 opacity-50" />
            <p className="text-sm">Aucun devis</p>
          </div>
        ) : rows.map((row) => {
          const isSelected = selectedId === row.IDDevis_etm
          const urgency = expirationUrgency(row.date_expiration, row.est_soldee)
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
              key={row.IDDevis_etm}
              onClick={() => onSelect(row.IDDevis_etm)}
              className={cn(
                'p-3 border rounded-lg cursor-pointer transition-all bg-white',
                isSelected ? selectedRingClass : hoverClass,
                urgency === 'late' && 'shadow-[inset_4px_0_0_0_rgb(239_68_68)]',
                urgency === 'soon' && 'shadow-[inset_4px_0_0_0_rgb(245_158_11)]',
              )}
            >
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                <span className="font-medium text-sm">N° {row.numero ?? row.IDDevis_etm}</span>
                {row.IDcommande_ETM > 0 && (
                  <span title="Transformé en commande" className="flex items-center text-[10px] text-success">
                    <ArrowRight className="h-3 w-3" /><ShoppingCart className="h-3 w-3" />
                  </span>
                )}
                {row.IDprospect > 0 && <ProspectChip />}
                <StatutPill soldee={row.est_soldee} className="ml-auto" />
              </div>
              <p className="text-xs text-muted-foreground mt-1 truncate">{devisTiers(row) || '—'}</p>
              <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground">
                {row.date && <span>{formatHfsqlDate(row.date)}</span>}
                {row.date_expiration && /^\d{8}$/.test(row.date_expiration) && (
                  <span className={cn(urgency === 'late' && 'font-bold text-red-600', urgency === 'soon' && 'font-bold text-amber-600')}>
                    · exp. {formatHfsqlDate(row.date_expiration)}
                  </span>
                )}
                {row.total_eur > 0 && (
                  <span className="ml-auto px-1.5 py-0.5 rounded bg-accent/10 font-medium text-foreground tabular-nums">
                    {fmtNum(row.total_eur)} €
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div className="p-3 border-t text-xs text-muted-foreground flex items-center justify-between rounded-b-lg bg-zinc-200/50">
        <span>{rows.length} devis</span>
        {!isEditing && (
          <Button size="sm" variant="ghost" onClick={onNew} className="text-accent hover:text-accent hover:bg-accent/10">
            <Plus className="h-3.5 w-3.5 mr-1" />Nouveau
          </Button>
        )}
      </div>
    </div>
  )
}

// ── Center Panel: Detail Header ──────────────────────────

function DetailHeader({
  devis, isLoading, isEditing, canEdit,
  onStartEdit, onCancelEdit, onSave, isSaving,
  onDelete, onPrintClick, onEmailClick, onConvertClick,
}: {
  devis: DevisDetail | null
  isLoading: boolean
  isEditing: boolean
  canEdit: boolean
  onStartEdit: () => void
  onCancelEdit: () => void
  onSave: () => void
  isSaving: boolean
  onDelete: () => void
  onPrintClick: () => void
  onEmailClick: () => void
  onConvertClick: () => void
}) {
  if (!devis && !isLoading) return null
  const converted = (devis?.IDcommande_ETM ?? 0) > 0
  const isProspect = (devis?.IDprospect ?? 0) > 0
  return (
    <div className="flex-shrink-0 pt-0.5">
      <div className="flex items-center gap-3">
        <div className={cn('h-11 w-11 rounded-lg flex items-center justify-center', isEditing ? 'bg-accent/15' : 'icon-box-gold')}>
          <FileText className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          {isLoading ? (
            <div className="h-8 w-48 bg-muted animate-pulse rounded" />
          ) : (
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-heading font-bold tracking-tight truncate">
                Devis N° {devis?.numero ?? devis?.IDDevis_etm}
                <span className="text-muted-foreground font-normal"> · {(devis ? devisTiers(devis) : '') || '—'}</span>
              </h1>
              <div className="flex items-center gap-2 flex-shrink-0">
                {isProspect && <ProspectChip />}
                {devis?.date && (
                  <Badge variant="secondary" className="text-xs">{formatHfsqlDate(devis.date)}</Badge>
                )}
                {converted && (
                  <Badge variant="success" className="text-xs gap-1"><ShoppingCart className="h-3 w-3" />Transformé</Badge>
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
        {!isLoading && devis && (
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
                {/* A prospect devis can never become a commande — the prospect
                    must be converted to a client first (the devis follows). */}
                {!converted && !isProspect && (
                  <Button variant="outline" size="sm" onClick={onConvertClick} title="Transformer le devis en commande">
                    <ShoppingCart className="h-3.5 w-3.5 mr-1.5" />Passer en commande
                  </Button>
                )}
                <Button variant="outline" size="icon" className="h-9 w-9" title="Imprimer" onClick={onPrintClick}>
                  <Printer className="h-4 w-4" />
                </Button>
                {canEdit && (
                  <Button variant="outline" size="icon" className="h-9 w-9" title="Envoyer un email" onClick={onEmailClick}>
                    <AtSign className="h-4 w-4" />
                  </Button>
                )}
                {canEdit && (
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

// ── Center Panel: Detail Main ────────────────────────────

function DetailMain({
  devis, isLoading, hasSelection, isEditing, onMutationSuccess, onLinesDirtyChange,
}: {
  devis: DevisDetail | null
  isLoading: boolean
  hasSelection: boolean
  isEditing: boolean
  onMutationSuccess: () => void
  onLinesDirtyChange: (dirty: boolean) => void
}) {
  if (!hasSelection) return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="icon-box-gold h-16 w-16 mx-auto"><FileText className="h-8 w-8" /></div>
        <p className="text-muted-foreground text-sm">Sélectionnez un devis dans la liste</p>
      </div>
    </div>
  )
  if (isLoading) return <div className="flex-1 flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-accent" /></div>
  if (!devis) return null

  const totalHT = devis.lignes.reduce((s, l) => s + (Number(l.montant) || 0), 0)
  const remise = Number(devis.remise) || 0
  const fraisPort = Number(devis.frais_port) || 0
  const totalNet = totalHT * (1 - remise) + fraisPort

  return (
    <LignesSection
      devis={devis}
      isEditing={isEditing}
      totalHT={totalHT}
      remise={remise}
      fraisPort={fraisPort}
      totalNet={totalNet}
      onMutationSuccess={onMutationSuccess}
      onLinesDirtyChange={onLinesDirtyChange}
    />
  )
}

// ── Center: Lignes Section ─────────────────────────────

const emptyLineForm = {
  type: 2,
  IDreference: 0,
  IDcolori: 0,
  quantite: '',
  unite: 3,
  prix: '',
  date_livraison: '',
  commentaire: '',
}
type LineFormState = typeof emptyLineForm

function LignesSection({
  devis, isEditing, totalHT, remise, fraisPort, totalNet, onMutationSuccess, onLinesDirtyChange,
}: {
  devis: DevisDetail
  isEditing: boolean
  totalHT: number
  remise: number
  fraisPort: number
  totalNet: number
  onMutationSuccess: () => void
  onLinesDirtyChange: (dirty: boolean) => void
}) {
  const [lineDialogOpen, setLineDialogOpen] = useState(false)
  const [editingLine, setEditingLine] = useState<LigneDevis | null>(null)
  const [deleteLineConfirmId, setDeleteLineConfirmId] = useState<number | null>(null)

  const linesLocked = devis.est_soldee === 1

  useEffect(() => {
    if (!isEditing || linesLocked) { setLineDialogOpen(false); setEditingLine(null) }
  }, [isEditing, linesLocked])

  useEffect(() => {
    onLinesDirtyChange(lineDialogOpen)
  }, [lineDialogOpen, onLinesDirtyChange])

  const deleteLineMut = useMutation({
    mutationFn: (lineId: number) => apiFetch(`/devis/lignes/${lineId}`, { method: 'DELETE' }),
    onSuccess: onMutationSuccess,
  })

  const startAddLine = () => { setEditingLine(null); setLineDialogOpen(true) }
  const startEditLine = (l: LigneDevis) => { setEditingLine(l); setLineDialogOpen(true) }

  return (
    <>
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="flex-1 min-h-0 overflow-auto space-y-2 p-1 scrollbar-transparent">
          {devis.lignes.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Layers className="h-12 w-12 mb-3 opacity-40" />
              <p className="text-sm">Aucune ligne</p>
              {isEditing && !linesLocked && (
                <Button variant="outline" size="sm" className="mt-3" onClick={startAddLine}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter une ligne
                </Button>
              )}
            </div>
          ) : (
            devis.lignes.map((l) => (
              <LineCard
                key={l.IDligne_devis_etm}
                line={l}
                isEditing={isEditing}
                linesLocked={linesLocked}
                onEdit={() => startEditLine(l)}
                onDelete={() => setDeleteLineConfirmId(l.IDligne_devis_etm)}
              />
            ))
          )}

          {isEditing && !linesLocked && devis.lignes.length > 0 && (
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

        {devis.lignes.length > 0 && (
          <div className="flex-shrink-0 mt-3 pt-3 border-t border-border/60 space-y-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
              <span className="uppercase tracking-wide">Sous-total HT · {devis.lignes.length} ligne{devis.lignes.length > 1 ? 's' : ''}</span>
              <span>{fmtNum(totalHT, 2)} €</span>
            </div>
            {remise > 0 && (
              <div className="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
                <span>Remise ({fmtNum(remise * 100, remise * 100 % 1 === 0 ? 0 : 1)} %)</span>
                <span>- {fmtNum(totalHT * remise, 2)} €</span>
              </div>
            )}
            {fraisPort > 0 && (
              <div className="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
                <span>Frais de port</span>
                <span>{fmtNum(fraisPort, 2)} €</span>
              </div>
            )}
            <div className="flex items-center justify-between text-sm font-medium pt-0.5">
              <span className="text-muted-foreground text-xs uppercase tracking-wide">Montant total</span>
              <span className="text-accent text-base tabular-nums">{fmtNum(totalNet, 2)} €</span>
            </div>
          </div>
        )}
      </div>

      <LineFormDialog
        open={lineDialogOpen}
        devis={devis}
        line={editingLine}
        onClose={() => { setLineDialogOpen(false); setEditingLine(null) }}
        onSuccess={() => { setLineDialogOpen(false); setEditingLine(null); onMutationSuccess() }}
      />

      <ConfirmDialog
        open={deleteLineConfirmId !== null}
        title="Supprimer la ligne"
        description="Cette ligne sera supprimée du devis."
        confirmLabel="Supprimer"
        isPending={deleteLineMut.isPending}
        onCancel={() => setDeleteLineConfirmId(null)}
        onConfirm={() => {
          if (deleteLineConfirmId !== null) deleteLineMut.mutate(deleteLineConfirmId, { onSuccess: () => setDeleteLineConfirmId(null) })
        }}
      />
    </>
  )
}

function LineCard({
  line, isEditing, linesLocked, onEdit, onDelete,
}: {
  line: LigneDevis
  isEditing: boolean
  linesLocked: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const chip = lineTypeChip(line.type)
  return (
    <div className={cn('group rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3', lineCardBorder(line.type))}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-muted">
            <Layers className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">
              {line.ref_label || '—'}
              {line.colori_reference ? <span className="text-muted-foreground"> / {line.colori_reference}</span> : null}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {chip && (
            <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium', chip.classes)}>{chip.label}</span>
          )}
          {isEditing && !linesLocked && (
            <div className="flex gap-0.5">
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
      <div className="flex items-center gap-3 mt-2 ml-9 text-[11px] text-muted-foreground tabular-nums">
        <span>{fmtNum(line.quantite, 1)} {line.unite_label}</span>
        {line.prix > 0 && <span>× {fmtNum(line.prix, 2)} €</span>}
        {line.montant > 0 && <span className="font-medium text-foreground">→ {fmtNum(line.montant, 2)} €</span>}
        {line.date_livraison && /^\d{8}$/.test(line.date_livraison) && (
          <span className="ml-auto">Livraison {formatHfsqlDate(line.date_livraison)}</span>
        )}
      </div>
      {line.commentaire?.trim() && (
        <div className="flex items-start gap-1.5 mt-2 ml-9">
          <MessageSquare className="h-3 w-3 text-muted-foreground/50 flex-shrink-0 mt-0.5" />
          <p className="text-[11px] text-muted-foreground italic">{line.commentaire.trim()}</p>
        </div>
      )}
    </div>
  )
}

// ── Line create/edit dialog (with PrixDeVenteV4 auto-suggest) ──

function LineFormDialog({
  open, devis, line, onClose, onSuccess,
}: {
  open: boolean
  devis: DevisDetail
  line: LigneDevis | null
  onClose: () => void
  onSuccess: () => void
}) {
  const isNew = line === null
  const [form, setForm] = useState<LineFormState>(emptyLineForm)
  const [error, setError] = useState<string | null>(null)
  const [debouncedQty, setDebouncedQty] = useState(0)
  const priceAutoFilledRef = useRef(false)

  useEffect(() => {
    if (!open) return
    if (line) {
      setForm({
        type: line.type || 2,
        IDreference: line.IDreference || 0,
        IDcolori: line.IDcolori || 0,
        quantite: line.quantite != null ? String(line.quantite) : '',
        unite: line.unite || 3,
        prix: line.prix != null ? String(line.prix) : '',
        date_livraison: hfsqlDateToInput(line.date_livraison),
        commentaire: line.commentaire ?? '',
      })
    } else {
      setForm(emptyLineForm)
    }
    setError(null)
    priceAutoFilledRef.current = false
  }, [open, line])

  // Debounce the quantity feeding the price suggestion (avoids a heavy
  // PrixDeVenteV4 recompute on every keystroke).
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQty(Number(form.quantite) || 0), 300)
    return () => clearTimeout(t)
  }, [form.quantite])

  const { data: refsEcru } = useQuery<RefEcru[]>({ queryKey: ['devis-refs-ecru'], queryFn: () => apiFetch('/devis/lookups/refs-ecru'), enabled: open && form.type === 1 })
  const { data: refsFini } = useQuery<RefFini[]>({ queryKey: ['devis-refs-fini'], queryFn: () => apiFetch('/devis/lookups/refs-fini'), enabled: open && form.type === 2 })
  const { data: refsDivers } = useQuery<RefDivers[]>({ queryKey: ['devis-refs-divers'], queryFn: () => apiFetch('/devis/lookups/refs-divers'), enabled: open && form.type === 3 })

  const { data: coloriOptions } = useQuery<ColoriOption[]>({
    queryKey: ['devis-coloris', form.type, form.IDreference],
    queryFn: async () => {
      if (form.type === 1) {
        const rows = await apiFetch<{ IDcolori_ecru: number; reference: string }[]>(`/devis/lookups/colori-ecru?ref_ecru=${form.IDreference}`)
        return rows.map((r) => ({ id: r.IDcolori_ecru, reference: r.reference }))
      }
      return apiFetch<ColoriOption[]>(`/devis/lookups/colori-fini?ref_fini=${form.IDreference}`)
    },
    enabled: open && form.IDreference > 0 && (form.type === 1 || form.type === 2),
  })

  // PrixDeVenteV4 auto-suggest — finished (type-2) refs only.
  const suggestEnabled = open && form.type === 2 && form.IDreference > 0 && form.IDcolori > 0 && debouncedQty > 0
  const { data: suggest, isFetching: suggestFetching } = useQuery<{ prix: number | null; tranche_rolls?: number }>({
    queryKey: ['devis-price-suggest', form.IDreference, form.IDcolori, debouncedQty, form.unite],
    queryFn: () => apiFetch(`/devis/pricing/suggest?ref_fini=${form.IDreference}&coloris=${form.IDcolori}&quantite=${debouncedQty}&unite=${form.unite}`),
    enabled: suggestEnabled,
  })
  const suggestedPrix = suggest?.prix ?? null

  // Auto-fill the price once, only when the user hasn't typed one yet.
  useEffect(() => {
    if (suggestedPrix != null && form.prix === '' && !priceAutoFilledRef.current) {
      priceAutoFilledRef.current = true
      setForm((f) => (f.prix === '' ? { ...f, prix: String(suggestedPrix) } : f))
    }
  }, [suggestedPrix, form.prix])

  const saveMut = useMutation({
    mutationFn: () => {
      const body = JSON.stringify({
        type: form.type,
        IDreference: form.IDreference,
        IDcolori: form.IDcolori,
        quantite: Number(form.quantite) || 0,
        unite: form.unite,
        prix: Number(form.prix) || 0,
        date_livraison: form.date_livraison ? inputDateToHfsql(form.date_livraison) : '',
        commentaire: form.commentaire,
      })
      return isNew
        ? apiFetch(`/devis/${devis.IDDevis_etm}/lignes`, { method: 'POST', body })
        : apiFetch(`/devis/lignes/${line!.IDligne_devis_etm}`, { method: 'PUT', body })
    },
    onSuccess,
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Erreur'),
  })

  const refOptions = form.type === 1
    ? (refsEcru ?? []).map((r) => ({ id: r.IDref_ecru, primary: r.reference }))
    : form.type === 2
      ? (refsFini ?? []).map((r) => ({ id: r.IDref_fini, primary: r.reference, secondary: r.designation }))
      : (refsDivers ?? []).map((r) => ({ id: r.IDref_divers, primary: r.designation }))

  const setType = (t: number) => {
    priceAutoFilledRef.current = false
    setForm({ ...form, type: t, IDreference: 0, IDcolori: 0, unite: t === 1 ? 1 : t === 3 ? 4 : 3 })
  }

  const canSave = form.IDreference > 0 && Number(form.quantite) > 0

  if (!open) return null

  const showSuggest = form.type === 2 && suggestedPrix != null && String(suggestedPrix) !== form.prix

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers className="h-5 w-5 text-accent" />
            {isNew ? 'Nouvelle ligne' : 'Modifier la ligne'}
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Type</label>
            <div className="flex gap-1">
              {([{ t: 1, l: 'Écru' }, { t: 2, l: 'Fini' }, { t: 3, l: 'Divers' }] as const).map((o) => (
                <button
                  key={o.t}
                  type="button"
                  onClick={() => setType(o.t)}
                  className={cn(
                    'flex-1 px-2 py-1.5 text-xs rounded-md transition-colors border',
                    form.type === o.t ? 'bg-accent text-accent-foreground border-accent shadow-sm font-medium' : 'border-input text-muted-foreground hover:bg-accent/10',
                  )}
                >
                  {o.l}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Référence</label>
            <SearchableCombobox<{ id: number; primary: string; secondary?: string }>
              options={refOptions}
              value={form.IDreference}
              onChange={(id) => { priceAutoFilledRef.current = false; setForm({ ...form, IDreference: id, IDcolori: 0 }) }}
              getId={(r) => r.id}
              getPrimary={(r) => r.primary}
              getSecondary={(r) => r.secondary}
              placeholder="Choisir une référence"
            />
          </div>
          {form.type !== 3 && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Coloris</label>
              <PopoverSelect
                options={(coloriOptions ?? []).map((c) => ({ id: c.id, primary: c.reference }))}
                value={form.IDcolori}
                onChange={(id) => { priceAutoFilledRef.current = false; setForm({ ...form, IDcolori: id }) }}
                disabled={!form.IDreference}
                emptyLabel="— Choisir —"
              />
            </div>
          )}
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-1 space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Quantité</label>
              <input type="number" value={form.quantite} onChange={(e) => setForm({ ...form, quantite: e.target.value })} className={inputClass} />
            </div>
            <div className="col-span-1 space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Unité</label>
              <PopoverSelect
                options={[{ id: 1, primary: 'Kg' }, { id: 3, primary: 'Ml' }, { id: 4, primary: 'U' }, { id: 5, primary: 'm²' }]}
                value={form.unite}
                onChange={(id) => setForm({ ...form, unite: id })}
                hideEmpty
              />
            </div>
            <div className="col-span-1 space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Prix (€)</label>
              <input type="number" value={form.prix} onChange={(e) => setForm({ ...form, prix: e.target.value })} className={inputClass} />
            </div>
          </div>
          {/* Auto-suggest hint (finished refs) */}
          {form.type === 2 && (
            <div className="min-h-[18px]">
              {suggestFetching ? (
                <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <Loader2 className="h-3 w-3 animate-spin" />Calcul du prix suggéré…
                </span>
              ) : showSuggest ? (
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, prix: String(suggestedPrix) }))}
                  className="text-[11px] text-accent hover:underline flex items-center gap-1"
                  title="Prix calculé par PrixDeVenteV4 (cliquer pour appliquer)"
                >
                  <Sparkles className="h-3 w-3" />Prix suggéré : {fmtNum(suggestedPrix ?? 0, 2)} € — appliquer
                </button>
              ) : suggestEnabled && suggest && suggestedPrix == null ? (
                <span className="text-[11px] text-muted-foreground">Prix non calculable (rendement/coloris manquant) — saisir manuellement.</span>
              ) : null}
            </div>
          )}
          <LabeledInput label="Date livraison" type="date" value={form.date_livraison} onChange={(v) => setForm({ ...form, date_livraison: v })} />
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Commentaire</label>
            <textarea value={form.commentaire} onChange={(e) => setForm({ ...form, commentaire: e.target.value })} rows={2}
              className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y" />
          </div>
          {error && (
            <div className="flex items-start gap-1.5 text-xs text-destructive mt-3">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" /><span>{error}</span>
            </div>
          )}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={() => saveMut.mutate()} disabled={!canSave || saveMut.isPending}>
            {saveMut.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
            Enregistrer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Right Panel: Sidebar with Tabs ─────────────────────

type SidebarTab = 'info' | 'adresses' | 'docs' | 'historique'

function DetailSidebar({
  devis, isLoading, isEditing,
  editDate, onEditDateChange,
  editDateExpiration, onEditDateExpirationChange,
  editRefClient, onEditRefClientChange,
  editCommentaire, onEditCommentaireChange,
  editCommentaireInterne, onEditCommentaireInterneChange,
  editIDModePaiement, onEditIDModePaiementChange,
  editIDEcheance, onEditIDEcheanceChange,
  editRemise, onEditRemiseChange,
  editFraisPort, onEditFraisPortChange,
  editIDAdresseFacturation, onEditIDAdresseFacturationChange,
  editIDAdresseLivraison, onEditIDAdresseLivraisonChange,
  onToggleEtat, isTogglingEtat, canEdit,
}: {
  devis: DevisDetail | null
  isLoading: boolean
  isEditing: boolean
  editDate: string; onEditDateChange: (v: string) => void
  editDateExpiration: string; onEditDateExpirationChange: (v: string) => void
  editRefClient: string; onEditRefClientChange: (v: string) => void
  editCommentaire: string; onEditCommentaireChange: (v: string) => void
  editCommentaireInterne: string; onEditCommentaireInterneChange: (v: string) => void
  editIDModePaiement: number; onEditIDModePaiementChange: (v: number) => void
  editIDEcheance: number; onEditIDEcheanceChange: (v: number) => void
  editRemise: string; onEditRemiseChange: (v: string) => void
  editFraisPort: string; onEditFraisPortChange: (v: string) => void
  editIDAdresseFacturation: number; onEditIDAdresseFacturationChange: (v: number) => void
  editIDAdresseLivraison: number; onEditIDAdresseLivraisonChange: (v: number) => void
  onToggleEtat: () => void
  isTogglingEtat: boolean
  canEdit: boolean
}) {
  const [activeTab, setActiveTab] = useState<SidebarTab>('info')

  const { data: modesPaiement } = useQuery<ModePaiement[]>({
    queryKey: ['devis-modes-paiement'],
    queryFn: () => apiFetch('/devis/lookups/modes-paiement'),
    enabled: isEditing,
  })
  const { data: echeances } = useQuery<Echeance[]>({
    queryKey: ['devis-echeances'],
    queryFn: () => apiFetch('/devis/lookups/echeances'),
    enabled: isEditing,
  })
  const { data: adresses } = useQuery<AdresseLookup[]>({
    queryKey: ['devis-adresses', devis?.IDclient],
    queryFn: () => apiFetch(`/devis/lookups/adresses?client=${devis?.IDclient}`),
    enabled: isEditing && !!devis?.IDclient,
  })

  if (isLoading) return (
    <div className="w-96 flex-shrink-0 bg-muted/30 rounded-xl border p-4 space-y-4">
      <div className="flex gap-2">{[1, 2, 3].map((i) => <div key={i} className="h-8 flex-1 bg-muted animate-pulse rounded-md" />)}</div>
      {[1, 2, 3].map((i) => <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />)}
    </div>
  )
  if (!devis) return null

  const tabs: { key: SidebarTab; label: string; icon: React.ElementType }[] = [
    { key: 'info', label: 'Info', icon: Info },
    { key: 'adresses', label: 'Adresses', icon: MapPin },
    { key: 'docs', label: 'Docs', icon: FileText },
    { key: 'historique', label: 'Historique', icon: History },
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
                  'flex-1 flex items-center justify-center gap-1.5 px-2 py-2 text-sm font-medium rounded-md transition-colors',
                  activeTab === tab.key ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10',
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
              devis={devis} isEditing={isEditing}
              modesPaiement={modesPaiement ?? []} echeances={echeances ?? []}
              editDate={editDate} onEditDateChange={onEditDateChange}
              editDateExpiration={editDateExpiration} onEditDateExpirationChange={onEditDateExpirationChange}
              editRefClient={editRefClient} onEditRefClientChange={onEditRefClientChange}
              editCommentaire={editCommentaire} onEditCommentaireChange={onEditCommentaireChange}
              editCommentaireInterne={editCommentaireInterne} onEditCommentaireInterneChange={onEditCommentaireInterneChange}
              editIDModePaiement={editIDModePaiement} onEditIDModePaiementChange={onEditIDModePaiementChange}
              editIDEcheance={editIDEcheance} onEditIDEcheanceChange={onEditIDEcheanceChange}
              editRemise={editRemise} onEditRemiseChange={onEditRemiseChange}
              editFraisPort={editFraisPort} onEditFraisPortChange={onEditFraisPortChange}
            />
          )}
          {activeTab === 'adresses' && (
            <AdressesTab
              devis={devis} isEditing={isEditing} adresses={adresses ?? []}
              editIDAdresseFacturation={editIDAdresseFacturation} onEditIDAdresseFacturationChange={onEditIDAdresseFacturationChange}
              editIDAdresseLivraison={editIDAdresseLivraison} onEditIDAdresseLivraisonChange={onEditIDAdresseLivraisonChange}
            />
          )}
          {activeTab === 'docs' && <DocsTab devis={devis} isEditing={isEditing} />}
          {activeTab === 'historique' && <HistoriqueTab devisId={devis.IDDevis_etm} />}
        </div>
      </div>
      <StatusFooter etat={devis.est_soldee} onToggle={onToggleEtat} isToggling={isTogglingEtat} disabled={isEditing || !canEdit} />
    </div>
  )
}

function StatusFooter({ etat, onToggle, isToggling, disabled }: { etat: number; onToggle: () => void; isToggling: boolean; disabled: boolean }) {
  const isSolde = etat === 1
  const Icon = isSolde ? CheckCircle2 : Clock
  const label = isSolde ? 'Soldé' : 'En cours'
  const actionLabel = isSolde ? 'Revalider' : 'Solder'
  const ActionIcon = isSolde ? Clock : CheckCircle2
  return (
    <div className={cn('flex-shrink-0 rounded-xl border shadow-sm overflow-hidden flex items-stretch h-11', isSolde ? 'bg-success border-success' : 'bg-primary border-primary')}>
      <div className="flex items-center gap-2 px-3 flex-1 text-white min-w-0">
        <Icon className="h-4 w-4 flex-shrink-0" />
        <span className="text-sm font-bold uppercase tracking-wide truncate">{label}</span>
      </div>
      <button
        type="button"
        onClick={onToggle}
        disabled={disabled || isToggling}
        title={isSolde ? 'Revalider le devis' : 'Solder le devis'}
        className="px-3.5 bg-white/15 hover:bg-white/25 active:bg-white/30 disabled:bg-white/5 disabled:opacity-60 disabled:cursor-not-allowed text-white text-xs font-semibold border-l border-white/25 flex items-center gap-1.5 transition-colors"
      >
        <ActionIcon className="h-3.5 w-3.5" />{actionLabel}
      </button>
    </div>
  )
}

// ── Sidebar Tab: Info ──────────────────────────────────

function InfoTab({
  devis, isEditing, modesPaiement, echeances,
  editDate, onEditDateChange,
  editDateExpiration, onEditDateExpirationChange,
  editRefClient, onEditRefClientChange,
  editCommentaire, onEditCommentaireChange,
  editCommentaireInterne, onEditCommentaireInterneChange,
  editIDModePaiement, onEditIDModePaiementChange,
  editIDEcheance, onEditIDEcheanceChange,
  editRemise, onEditRemiseChange,
  editFraisPort, onEditFraisPortChange,
}: {
  devis: DevisDetail
  isEditing: boolean
  modesPaiement: ModePaiement[]
  echeances: Echeance[]
  editDate: string; onEditDateChange: (v: string) => void
  editDateExpiration: string; onEditDateExpirationChange: (v: string) => void
  editRefClient: string; onEditRefClientChange: (v: string) => void
  editCommentaire: string; onEditCommentaireChange: (v: string) => void
  editCommentaireInterne: string; onEditCommentaireInterneChange: (v: string) => void
  editIDModePaiement: number; onEditIDModePaiementChange: (v: number) => void
  editIDEcheance: number; onEditIDEcheanceChange: (v: number) => void
  editRemise: string; onEditRemiseChange: (v: string) => void
  editFraisPort: string; onEditFraisPortChange: (v: string) => void
}) {
  const modeLabel = modesPaiement.find((m) => m.IDmode_paiement === devis.IDmode_paiement)?.libelle
  const echeanceLabel = echeances.find((e) => e.IDecheance === devis.IDecheance)?.libelle
  const smallInput = 'h-7 px-2 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring text-right w-[120px]'
  const dateInput = 'h-7 px-2 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring text-right'
  return (
    <div className="space-y-3">
      <div className={cn('p-3 rounded-lg border bg-card shadow-sm space-y-2', isEditing && editSectionClass)}>
        <KV
          label={devis.IDprospect > 0 ? 'Prospect' : 'Client'}
          value={devis.IDprospect > 0 ? (
            <span className="inline-flex items-center gap-1.5"><ProspectChip />{devis.prospect_nom || '—'}</span>
          ) : (devis.client_nom || '—')}
        />
        <KV label="Date" value={isEditing ? (
          <input type="date" value={editDate} onChange={(e) => onEditDateChange(e.target.value)} className={dateInput} />
        ) : (devis.date ? formatHfsqlDate(devis.date) : '—')} />
        <KV label="Expiration" value={isEditing ? (
          <input type="date" value={editDateExpiration} onChange={(e) => onEditDateExpirationChange(e.target.value)} className={dateInput} />
        ) : (devis.date_expiration && /^\d{8}$/.test(devis.date_expiration) ? formatHfsqlDate(devis.date_expiration) : '—')} />
        <KV label="Réf. client" value={isEditing ? (
          <input type="text" value={editRefClient} onChange={(e) => onEditRefClientChange(e.target.value)} className={smallInput} />
        ) : (devis.ref_client || '—')} />
        <KV label="Mode paiement" value={isEditing ? (
          <PopoverSelect size="sm" options={modesPaiement.map((m) => ({ id: m.IDmode_paiement, primary: m.libelle }))}
            value={editIDModePaiement} onChange={onEditIDModePaiementChange} emptyLabel="—" />
        ) : (modeLabel || '—')} />
        <KV label="Échéance" value={isEditing ? (
          <PopoverSelect size="sm" options={echeances.map((e) => ({ id: e.IDecheance, primary: e.libelle }))}
            value={editIDEcheance} onChange={onEditIDEcheanceChange} emptyLabel="—" />
        ) : (echeanceLabel || '—')} />
        <KV label="Remise (%)" value={isEditing ? (
          <input type="number" value={editRemise} onChange={(e) => onEditRemiseChange(e.target.value)} className={smallInput} />
        ) : (devis.remise ? `${fmtNum(devis.remise * 100, devis.remise * 100 % 1 === 0 ? 0 : 1)} %` : '—')} />
        <KV label="Frais de port (€)" value={isEditing ? (
          <input type="number" value={editFraisPort} onChange={(e) => onEditFraisPortChange(e.target.value)} className={smallInput} />
        ) : (devis.frais_port ? fmtNum(devis.frais_port, 2) : '—')} />
      </div>

      <div className={cn('p-3 rounded-lg border bg-card shadow-sm', isEditing && editSectionClass)}>
        <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
          <MessageSquare className="h-3.5 w-3.5" />Commentaire
        </p>
        {isEditing ? (
          <textarea value={editCommentaire} onChange={(e) => onEditCommentaireChange(e.target.value)} rows={3}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y" />
        ) : devis.commentaire?.trim() ? (
          <p className="text-sm text-muted-foreground whitespace-pre-line">{devis.commentaire.trim()}</p>
        ) : (
          <p className="text-sm text-muted-foreground italic">Aucun commentaire</p>
        )}
      </div>

      <div className={cn('p-3 rounded-lg border bg-card shadow-sm', isEditing && editSectionClass)}>
        <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1.5">
          <MessageSquare className="h-3.5 w-3.5" />Note interne
        </p>
        {isEditing ? (
          <textarea value={editCommentaireInterne} onChange={(e) => onEditCommentaireInterneChange(e.target.value)} rows={3}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y" />
        ) : devis.commentaire_interne?.trim() ? (
          <p className="text-sm text-muted-foreground whitespace-pre-line">{devis.commentaire_interne.trim()}</p>
        ) : (
          <p className="text-sm text-muted-foreground italic">Aucune note interne</p>
        )}
      </div>
    </div>
  )
}

// ── Sidebar Tab: Adresses ──────────────────────────────

function AdressesTab({
  devis, isEditing, adresses,
  editIDAdresseFacturation, onEditIDAdresseFacturationChange,
  editIDAdresseLivraison, onEditIDAdresseLivraisonChange,
}: {
  devis: DevisDetail
  isEditing: boolean
  adresses: AdresseLookup[]
  editIDAdresseFacturation: number; onEditIDAdresseFacturationChange: (v: number) => void
  editIDAdresseLivraison: number; onEditIDAdresseLivraisonChange: (v: number) => void
}) {
  // Prospect devis: the address shown is the prospect's own (from the
  // prospect record) — there are no `adresse` rows to pick from, so the
  // « Choisir » picker is hidden. Edit the address in Prospects › Demandes.
  const isProspect = devis.IDprospect > 0
  return (
    <div className="space-y-3">
      <AdresseCard label="Facturation" adresse={devis.adresse_facturation} isEditing={isEditing && !isProspect}
        options={adresses} selectedId={editIDAdresseFacturation} onSelect={onEditIDAdresseFacturationChange} />
      <AdresseCard label="Livraison" adresse={devis.adresse_livraison} isEditing={isEditing && !isProspect}
        options={adresses} selectedId={editIDAdresseLivraison} onSelect={onEditIDAdresseLivraisonChange} />
      {isProspect && (
        <p className="text-[11px] text-muted-foreground italic px-1">
          Adresse reprise de la demande du prospect — modifiable dans Prospects › Demandes.
        </p>
      )}
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
  const displayAdresse: AdresseLite | null = isEditing ? (options.find((o) => o.IDadresse === selectedId) ?? adresse) : adresse
  return (
    <div className={cn('p-3 rounded-lg border bg-card shadow-sm', isEditing && editSectionClass)}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" />{label}</p>
        {isEditing && (
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
      <AdressePickerDialog open={pickerOpen} onClose={() => setPickerOpen(false)} label={label}
        options={options} selectedId={selectedId} onSelect={(id) => { onSelect(id); setPickerOpen(false) }} />
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
          <DialogTitle className="flex items-center gap-2"><MapPin className="h-5 w-5 text-accent" />Choisir une adresse de {label.toLowerCase()}</DialogTitle>
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
                      {!!a.est_defaut_facturation && <Badge variant="outline" className="text-[10px] py-0">Facturation</Badge>}
                      {!!a.est_defaut_livraison && <Badge variant="outline" className="text-[10px] py-0">Livraison</Badge>}
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

// ── Sidebar Tab: Docs ──────────────────────────────────

interface GedDocument {
  IDged: number
  nom: string | null
  commentaire: string | null
  IDtype_doc: number
  type_nom: string | null
}

function DocsTab({ devis, isEditing }: { devis: DevisDetail; isEditing: boolean }) {
  const queryClient = useQueryClient()
  const devisId = devis.IDDevis_etm
  const docsQueryKey = ['devis-docs', devisId] as const

  const { data, isLoading, error } = useQuery<GedDocument[]>({
    queryKey: docsQueryKey,
    queryFn: () => apiFetch(`/devis/${devisId}/documents`),
  })

  const [viewDoc, setViewDoc] = useState<GedDocument | null>(null)
  const [editingDoc, setEditingDoc] = useState<GedDocument | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteDocConfirm, setDeleteDocConfirm] = useState<GedDocument | null>(null)

  const invalidate = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: docsQueryKey })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, devisId])

  const deleteMut = useMutation({
    mutationFn: (idged: number) => apiFetch(`/devis/${devisId}/documents/${idged}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  })

  return (
    <>
      {isLoading && <div className="flex items-center justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-accent" /></div>}
      {!!error && (
        <div className="flex items-center gap-1.5 py-3 text-xs text-destructive"><AlertCircle className="h-3.5 w-3.5" /><span>Erreur de chargement</span></div>
      )}
      {!isLoading && !error && !data?.length && (
        <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
          <FileText className="h-10 w-10 mb-3 opacity-40" />
          <p className="text-sm font-medium">Aucun document</p>
          <p className="text-[11px] mt-1 text-center">Les devis et autres documents liés apparaîtront ici.</p>
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
                className={cn('group p-3 rounded-lg border bg-card shadow-sm cursor-pointer hover:border-accent/40 transition-colors', isEditing && editSectionClass)}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-amber-400/10"><FileText className="h-3.5 w-3.5 text-amber-600" /></div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate" title={title}>{title}</p>
                    {!!doc.type_nom && <p className="text-[11px] text-muted-foreground truncate">{doc.type_nom}</p>}
                  </div>
                  {isEditing && (
                    <Button variant="ghost" size="icon"
                      className="h-6 w-6 text-destructive hover:text-destructive opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                      onClick={(e) => { e.stopPropagation(); setDeleteDocConfirm(doc) }} title="Supprimer">
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
        <Button variant="ghost" size="sm" className="w-full mt-2 text-muted-foreground hover:text-foreground" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-1.5" />Ajouter un document
        </Button>
      )}

      <DocViewDialog devisId={devisId} doc={viewDoc} onClose={() => setViewDoc(null)} />
      <DocCreateEditDialog
        open={createOpen || editingDoc !== null}
        devisId={devisId}
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
        onConfirm={() => { if (deleteDocConfirm) deleteMut.mutate(deleteDocConfirm.IDged, { onSuccess: () => setDeleteDocConfirm(null) }) }}
      />
    </>
  )
}

function DocCreateEditDialog({
  open, devisId, doc, onClose, onSuccess,
}: {
  open: boolean
  devisId: number
  doc: GedDocument | null
  onClose: () => void
  onSuccess: () => void
}) {
  const isNew = doc === null
  const [nom, setNom] = useState('')
  const [commentaire, setCommentaire] = useState('')
  const [newFile, setNewFile] = useState<File | null>(null)
  const [newFileUrl, setNewFileUrl] = useState<string | null>(null)
  const [removeFichier, setRemoveFichier] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setNom(doc?.nom ?? '')
    setCommentaire(doc?.commentaire ?? '')
    setNewFile(null)
    if (newFileUrl) URL.revokeObjectURL(newFileUrl)
    setNewFileUrl(null)
    setRemoveFichier(false)
    setError(null)
    setIsSaving(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, doc?.IDged])

  useEffect(() => {
    if (!open && newFileUrl) { URL.revokeObjectURL(newFileUrl); setNewFileUrl(null) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const handleFilePick = (f: File) => {
    if (newFileUrl) URL.revokeObjectURL(newFileUrl)
    setNewFile(f); setNewFileUrl(URL.createObjectURL(f)); setRemoveFichier(false)
  }
  const handleRemoveFile = () => {
    if (newFileUrl) URL.revokeObjectURL(newFileUrl)
    setNewFile(null); setNewFileUrl(null); setRemoveFichier(true)
  }

  const handleSave = async () => {
    setError(null); setIsSaving(true)
    try {
      const formData = new FormData()
      formData.append('nom', nom)
      formData.append('commentaire', commentaire)
      if (newFile) formData.append('fichier', newFile)
      if (removeFichier && !newFile) formData.append('remove_fichier', '1')
      const url = isNew
        ? `${API_URL}/devis/${devisId}/documents`
        : `${API_URL}/devis/${devisId}/documents/${doc!.IDged}`
      const res = await fetch(url, { method: isNew ? 'POST' : 'PUT', body: formData, credentials: 'include' })
      if (!res.ok) throw new Error((await res.text().catch(() => '')) || `HTTP ${res.status}`)
      onSuccess()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue'); setIsSaving(false)
    }
  }

  const previewUrl = newFileUrl ? newFileUrl
    : !isNew && !removeFichier && doc ? `${API_URL}/devis/${devisId}/documents/${doc.IDged}/fichier#view=FitH` : null

  if (!open) return null

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-5xl h-[85vh] flex flex-col" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FileText className="h-4 w-4 text-accent" />{isNew ? 'Ajouter un document' : 'Modifier le document'}</DialogTitle>
        </DialogHeader>
        <div className="flex-1 min-h-0 flex gap-4">
          <div className="w-80 flex-shrink-0 overflow-y-auto space-y-3 px-1">
            <LabeledInput label="Nom" value={nom} onChange={setNom} autoFocus />
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Commentaire</label>
              <textarea value={commentaire} onChange={(e) => setCommentaire(e.target.value)} rows={4}
                className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y" />
            </div>
            {!!error && (
              <div className="flex items-start gap-1.5 text-xs text-destructive"><AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" /><span className="break-all">{error}</span></div>
            )}
          </div>
          <div className="flex-1 min-w-0 flex flex-col gap-2">
            <div className="flex-1 min-h-0 rounded-lg border border-border/60 bg-zinc-50 overflow-hidden">
              {previewUrl ? (
                <iframe src={previewUrl} className="w-full h-full" title="Document" />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center text-muted-foreground">
                  <FileText className="h-12 w-12 mb-2 opacity-30" /><p className="text-sm">Aucun fichier</p><p className="text-[11px]">Choisissez un fichier ci-dessous</p>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2">
              <label className="cursor-pointer">
                <input type="file" className="hidden"
                  onClick={(e) => { (e.target as HTMLInputElement).value = '' }}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFilePick(f) }} />
                <span className={cn(inputClass, 'inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/5 w-auto px-3')}>
                  <Upload className="h-3.5 w-3.5" />{newFile ? newFile.name : 'Choisir un fichier'}
                </span>
              </label>
              {(newFile || (!isNew && !removeFichier && doc)) && (
                <Button variant="ghost" size="sm" className="h-8 px-2" onClick={handleRemoveFile} title="Retirer le fichier"><X className="h-3.5 w-3.5" /></Button>
              )}
              <div className="flex items-center gap-2 ml-auto">
                <Button variant="outline" size="sm" onClick={onClose} disabled={isSaving}>Annuler</Button>
                <Button size="sm" onClick={handleSave} disabled={isSaving}>
                  {isSaving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}<Save className="h-3.5 w-3.5 mr-1.5" />Enregistrer
                </Button>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function DocViewDialog({ devisId, doc, onClose }: { devisId: number; doc: GedDocument | null; onClose: () => void }) {
  const [fichierOk, setFichierOk] = useState<boolean | null>(null)
  useEffect(() => {
    if (!doc) { setFichierOk(null); return }
    setFichierOk(null)
    fetch(`${API_URL}/devis/${devisId}/documents/${doc.IDged}/fichier`, { method: 'HEAD', credentials: 'include' })
      .then((r) => setFichierOk(r.ok)).catch(() => setFichierOk(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.IDged, devisId])
  if (!doc) return null
  return (
    <Dialog open={!!doc} onOpenChange={() => onClose()}>
      {fichierOk ? (
        <div className="relative z-50 w-[60vw] max-w-3xl h-[95vh]" onClick={(e) => e.stopPropagation()}>
          <iframe src={`${API_URL}/devis/${devisId}/documents/${doc.IDged}/fichier#view=FitH`} className="w-full h-full rounded-lg" title={doc.nom ?? 'Document'} />
        </div>
      ) : (
        <DialogContent className="max-w-sm" onClose={onClose}>
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <div className="text-center space-y-2">
              <FileText className="h-12 w-12 mx-auto opacity-30" />
              <p className="text-sm">{fichierOk === null ? 'Chargement...' : 'Aucun document attaché'}</p>
            </div>
          </div>
        </DialogContent>
      )}
    </Dialog>
  )
}

// ── Sidebar Tab: Historique ────────────────────────────

interface HistoriqueEvent { kind: 'email'; type_label: string; recipients: string[]; DATE: string }

function HistoriqueTab({ devisId }: { devisId: number }) {
  const { data, isLoading, error } = useQuery<HistoriqueEvent[]>({
    queryKey: ['devis-historique', devisId],
    queryFn: () => apiFetch(`/devis/${devisId}/historique`),
  })
  if (isLoading) return <div className="flex items-center justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-accent" /></div>
  if (error) return <div className="flex items-center gap-1.5 py-3 text-xs text-destructive"><AlertCircle className="h-3.5 w-3.5" /><span>Erreur de chargement</span></div>
  if (!data?.length) return (
    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
      <History className="h-10 w-10 mb-3 opacity-40" />
      <p className="text-sm font-medium">Aucun évènement</p>
      <p className="text-[11px] mt-1 text-center">Les envois d'emails liés à ce devis apparaîtront ici.</p>
    </div>
  )
  return (
    <div className="space-y-2">
      {data.map((ev, i) => (
        <div key={i} className="p-3 rounded-lg border bg-card shadow-sm">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-accent/10"><AtSign className="h-3.5 w-3.5 text-accent" /></div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">{ev.type_label}</p>
              <p className="text-[11px] text-muted-foreground">{ev.DATE ? formatDateTime(ev.DATE) : ''}</p>
            </div>
          </div>
          {ev.recipients.length > 0 && (
            <p className="text-[11px] text-muted-foreground mt-1.5 ml-9 truncate" title={ev.recipients.join(', ')}>
              À : {ev.recipients.join(', ')}
            </p>
          )}
        </div>
      ))}
    </div>
  )
}

function formatDateTime(raw: string): string {
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
  if (!m) return raw
  return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`
}

// ── Create Dialog ──────────────────────────────────────

function CreateDevisDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (newId: number) => void }) {
  const [clientId, setClientId] = useState(0)
  const [date, setDate] = useState<string>(() => new Date().toISOString().slice(0, 10))
  const [dateExpiration, setDateExpiration] = useState('')
  const [refClient, setRefClient] = useState('')
  const [modePaiementId, setModePaiementId] = useState(0)
  const [echeanceId, setEcheanceId] = useState(0)
  const [adresseFactId, setAdresseFactId] = useState(0)
  const [adresseLivId, setAdresseLivId] = useState(0)

  const { data: clients } = useQuery<ClientLite[]>({ queryKey: ['devis-clients'], queryFn: () => apiFetch('/devis/lookups/clients'), enabled: open })
  const { data: modesPaiement } = useQuery<ModePaiement[]>({ queryKey: ['devis-modes-paiement'], queryFn: () => apiFetch('/devis/lookups/modes-paiement'), enabled: open })
  const { data: echeances } = useQuery<Echeance[]>({ queryKey: ['devis-echeances'], queryFn: () => apiFetch('/devis/lookups/echeances'), enabled: open })
  const { data: adresses } = useQuery<AdresseLookup[]>({
    queryKey: ['devis-create-adresses', clientId],
    queryFn: () => apiFetch(`/devis/lookups/adresses?client=${clientId}`),
    enabled: open && clientId > 0,
  })

  useEffect(() => {
    if (!adresses) return
    const defaultFact = adresses.find((a) => a.est_defaut_facturation) ?? adresses.find((a) => a.est_defaut) ?? adresses[0]
    const defaultLiv = adresses.find((a) => a.est_defaut_livraison) ?? adresses.find((a) => a.est_defaut) ?? adresses[0]
    setAdresseFactId(defaultFact?.IDadresse ?? 0)
    setAdresseLivId(defaultLiv?.IDadresse ?? 0)
  }, [adresses])

  useEffect(() => {
    if (!open) {
      setClientId(0); setDate(new Date().toISOString().slice(0, 10)); setDateExpiration(''); setRefClient('')
      setModePaiementId(0); setEcheanceId(0); setAdresseFactId(0); setAdresseLivId(0)
    }
  }, [open])

  const createMut = useMutation({
    mutationFn: () => apiFetch('/devis', {
      method: 'POST',
      body: JSON.stringify({
        IDclient: clientId,
        date: inputDateToHfsql(date),
        date_expiration: dateExpiration ? inputDateToHfsql(dateExpiration) : '',
        ref_client: refClient,
        IDmode_paiement: modePaiementId || 0,
        IDecheance: echeanceId || 0,
        IDadresse_facturation: adresseFactId || 0,
        IDadresse_livraison: adresseLivId || 0,
      }),
    }),
    onSuccess: (data: { IDDevis_etm: number }) => onCreated(data.IDDevis_etm),
  })

  const canSave = clientId > 0 && date.length > 0

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><FileText className="h-5 w-5 text-accent" />Nouveau devis</DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Client</label>
            <SearchableCombobox<ClientLite>
              options={clients ?? []}
              value={clientId}
              onChange={setClientId}
              getId={(c) => c.IDclient}
              getPrimary={(c) => c.nom}
              placeholder="Choisir un client"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Date</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={cn(inputClass, 'h-9')} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Expiration</label>
              <input type="date" value={dateExpiration} onChange={(e) => setDateExpiration(e.target.value)} className={cn(inputClass, 'h-9')} />
            </div>
          </div>
          <LabeledInput label="Réf. client" value={refClient} onChange={setRefClient} />
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Mode paiement</label>
              <PopoverSelect options={(modesPaiement ?? []).map((m) => ({ id: m.IDmode_paiement, primary: m.libelle }))} value={modePaiementId} onChange={setModePaiementId} emptyLabel="—" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Échéance</label>
              <PopoverSelect options={(echeances ?? []).map((e) => ({ id: e.IDecheance, primary: e.libelle }))} value={echeanceId} onChange={setEcheanceId} emptyLabel="—" />
            </div>
          </div>
          {clientId > 0 && (
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Adr. facturation</label>
                <PopoverSelect options={(adresses ?? []).map((a) => ({ id: a.IDadresse, primary: a.nom || `Adresse #${a.IDadresse}`, secondary: a.ville ?? undefined }))} value={adresseFactId} onChange={setAdresseFactId} emptyLabel="—" />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Adr. livraison</label>
                <PopoverSelect options={(adresses ?? []).map((a) => ({ id: a.IDadresse, primary: a.nom || `Adresse #${a.IDadresse}`, secondary: a.ville ?? undefined }))} value={adresseLivId} onChange={setAdresseLivId} emptyLabel="—" />
              </div>
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

// ── Shared components ──────────────────────────────────

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm text-right truncate">{value}</span>
    </div>
  )
}

function LabeledInput({ label, value, onChange, type = 'text', autoFocus }: { label: string; value: string; onChange: (v: string) => void; type?: string; autoFocus?: boolean }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus} autoComplete="off" className={inputClass} />
    </div>
  )
}
