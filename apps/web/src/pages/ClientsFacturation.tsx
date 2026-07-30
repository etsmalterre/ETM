import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { UnsavedChangesDialog } from '@/components/shared/UnsavedChangesDialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import {
  Receipt,
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
  AtSign,
  Printer,
  Layers,
  CheckCircle2,
  FileCheck,
  Lock,
  FileText,
  FilePlus2,
  FileMinus2,
  FileDown,
  Package,
  CalendarDays,
} from 'lucide-react'
import { FiniRollIcon } from '@/components/icons/FiniRollIcon'
import { TmRollIcon } from '@/components/icons/TmRollIcon'
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
import { useHasPermission } from '@/contexts/PermissionsContext'

// ── Types ──────────────────────────────────────────────

// 'prov' = proforma (editable draft, facture_prov) · 'def' = definitive
// (locked, facture). The list shows one bucket at a time; selection lives
// within the current bucket, so kind === bucket everywhere.
type Kind = 'prov' | 'def'

interface FactureListRow {
  id: number
  kind: Kind
  numero: number | null
  date: string | null
  IDclient: number
  client_nom: string
  type: number // 1 = Facture, 2 = Avoir
  tva_rate: number
  total_ht: number
  total_tva: number
  total_ttc: number
  nb_lignes: number
  /** Definitive only: 1 when at least one email send is logged in
   *  envoi_email. Proformas always report 1 (they never log sends). */
  est_envoye: number
}

// Domain kind of a line — drives the per-line icon (fini roll / tombé-de-métier
// roll / Package for divers & manual lines), same glyphs as ClientsExpeditions.
type LineStockKind = 'fini' | 'ecru' | 'divers'

interface LigneFacture {
  IDligne_facture: number
  IDligne_expedition: number
  designation: string | null
  quantite: number
  unite: string
  prix: number
  montant: number
  stock_kind: LineStockKind
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

interface FactureDetail {
  id: number
  kind: Kind
  IDclient: number
  client_nom: string
  numero: number | null
  date: string | null
  type: number
  IDadresse: number
  IDmode_paiement: number
  mode_paiement_label: string | null
  IDecheance: number
  echeance_label: string | null
  date_echeance: string | null
  IDtva: number
  tva_rate: number
  tva_label: string | null
  num_tva: string
  IDcode_comptable: number
  adresse_facturation: AdresseLite | null
  lignes: LigneFacture[]
  total_ht: number
  total_tva: number
  total_ttc: number
}

interface GenerateSummary {
  created: Array<{ id: number; numero: number; client_nom: string; nb_lignes: number; nb_expeditions: number }>
  skipped: { internes: number; donations: number; vides: number }
}
interface DeleteAllSummary { deleted: number; expeditions_reouvertes: number }
interface ConvertBatchSummary {
  converted: Array<{ prov_id: number; IDfacture: number; numero: number; client_nom: string }>
  skipped: number
}
type BatchResult =
  | ({ action: 'generate' } & GenerateSummary)
  | ({ action: 'deleteAll' } & DeleteAllSummary)
  | ({ action: 'convertBatch' } & ConvertBatchSummary)

interface XImportSummary {
  date: string
  nb_factures: number
  nb_avoirs: number
  nb_lignes: number
  total_ttc: number
}

interface ClientLite { IDclient: number; nom: string }
interface ModePaiement { IDmode_paiement: number; libelle: string }
interface Echeance { IDecheance: number; libelle: string }
interface TvaOption { IDtva: number; valeur: number; libelle: string }

// ── Shared styling ─────────────────────────────────────

const inputClass = 'w-full h-8 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring'
const editSectionClass = 'border-l-4 border-l-accent/70 bg-accent/[0.03]'

// ── Type (Facture / Avoir) helpers ─────────────────────

function typeChip(type: number): { label: string; classes: string } {
  return type === 2
    ? { label: 'Avoir', classes: 'bg-destructive/10 text-destructive border border-destructive/25' }
    : { label: 'Facture', classes: 'bg-sky-500/10 text-sky-700 border border-sky-500/25' }
}

/** An Avoir is a credit → shown negative in ledger contexts (list + footer). */
function signed(value: number, type: number): number {
  return type === 2 ? -value : value
}

/** A 0 % rate means the client is flagged "Exonération" in Clients › Gestion
 *  (export customers) — say so rather than print a meaningless "0 %". */
function tvaRateLabel(rate: number): string {
  if (!(rate > 0)) return 'Exonération'
  return `${fmtNum(rate, rate % 1 === 0 ? 0 : 1)} %`
}

function formatDateTime(raw: string): string {
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
  if (!m) return raw
  return `${m[3]}/${m[2]}/${m[1]} ${m[4]}:${m[5]}`
}

// ── Main Page ──────────────────────────────────────────

export function ClientsFacturation() {
  const queryClient = useQueryClient()
  // Gates the invoice-lifecycle actions: generate proformas, batch-delete
  // proformas, convert proforma → definitive (edit_factures permission).
  const canEditFactures = useHasPermission('edit_factures')
  const [bucket, setBucket] = useState<Kind>('def')
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<'all' | 'facture' | 'avoir'>('all')
  const [isEditing, setIsEditing] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [emailModalOpen, setEmailModalOpen] = useState(false)
  const [autoEditForId, setAutoEditForId] = useState<number | null>(null)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [convertConfirmOpen, setConvertConfirmOpen] = useState(false)
  const [avoirConfirmOpen, setAvoirConfirmOpen] = useState(false)
  const [convertResult, setConvertResult] = useState<{ numero: number } | null>(null)
  // Batch actions on the proforma list panel (generate from expeditions /
  // pick-and-convert / pick-and-delete proformas).
  const [generateConfirmOpen, setGenerateConfirmOpen] = useState(false)
  const [convertBatchOpen, setConvertBatchOpen] = useState(false)
  const [deleteBatchOpen, setDeleteBatchOpen] = useState(false)
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null)
  // XImport accounting export (definitive bucket only).
  const [ximportOpen, setXimportOpen] = useState(false)
  // "Non envoyé" red filter pill (definitive bucket only) — mirrors the
  // Sous-traitants › Commandes urgency pills.
  const [nonEnvoyeOn, setNonEnvoyeOn] = useState(false)

  // Edit-mode header draft.
  const [editDate, setEditDate] = useState('')
  const [editType, setEditType] = useState(1)
  const [editIDModePaiement, setEditIDModePaiement] = useState(0)
  const [editIDEcheance, setEditIDEcheance] = useState(0)
  const [editIDTva, setEditIDTva] = useState(0)
  const [editNumTva, setEditNumTva] = useState('')
  const [editIDAdresse, setEditIDAdresse] = useState(0)

  const originalDraftRef = useRef<Record<string, string | number> | null>(null)
  const [linesDirty, setLinesDirty] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery.trim()), 250)
    return () => clearTimeout(t)
  }, [searchQuery])

  const { data: factures, isLoading, isError, error, isFetching } = useQuery<FactureListRow[]>({
    queryKey: ['factures', bucket, typeFilter, debouncedQuery],
    queryFn: () => apiFetch(`/factures?status=${bucket}&type=${typeFilter}&q=${encodeURIComponent(debouncedQuery)}&limit=200`),
  })

  const { data: detail, isLoading: detailLoading } = useQuery<FactureDetail>({
    queryKey: ['facture', bucket, selectedId],
    queryFn: () => apiFetch(`/factures/${bucket}/${selectedId}`),
    enabled: selectedId !== null,
  })

  // Only proformas are editable (a definitive facture is locked at creation).
  const editable = !!detail && detail.kind === 'prov'

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['factures'] })
    queryClient.invalidateQueries({ queryKey: ['facture', bucket, selectedId] })
  }, [queryClient, bucket, selectedId])

  const startEdit = useCallback(() => {
    if (!detail || detail.kind !== 'prov') return
    const snapshot = {
      date: hfsqlDateToInput(detail.date),
      type: detail.type ?? 1,
      IDmodePaiement: detail.IDmode_paiement ?? 0,
      IDecheance: detail.IDecheance ?? 0,
      IDtva: detail.IDtva ?? 0,
      numTva: detail.num_tva?.trim() ?? '',
      IDadresse: detail.IDadresse ?? 0,
    }
    setEditDate(snapshot.date)
    setEditType(snapshot.type)
    setEditIDModePaiement(snapshot.IDmodePaiement)
    setEditIDEcheance(snapshot.IDecheance)
    setEditIDTva(snapshot.IDtva)
    setEditNumTva(snapshot.numTva)
    setEditIDAdresse(snapshot.IDadresse)
    originalDraftRef.current = snapshot
    setIsEditing(true)
  }, [detail])

  const cancelEdit = useCallback(() => setIsEditing(false), [])

  const isDirty = useMemo(() => {
    if (!isEditing) return false
    const o = originalDraftRef.current
    if (!o) return false
    if (editDate !== o.date) return true
    if (editType !== o.type) return true
    if (editIDModePaiement !== o.IDmodePaiement) return true
    if (editIDEcheance !== o.IDecheance) return true
    if (editIDTva !== o.IDtva) return true
    if (editNumTva !== o.numTva) return true
    if (editIDAdresse !== o.IDadresse) return true
    if (linesDirty) return true
    return false
  }, [isEditing, editDate, editType, editIDModePaiement, editIDEcheance, editIDTva, editNumTva, editIDAdresse, linesDirty])

  const saveHeaderMut = useMutation({
    mutationFn: () => apiFetch(`/factures/${bucket}/${selectedId}`, {
      method: 'PUT',
      body: JSON.stringify({
        date: inputDateToHfsql(editDate),
        type: editType,
        IDmode_paiement: editIDModePaiement || 0,
        IDecheance: editIDEcheance || 0,
        IDtva: editIDTva || 0,
        num_tva: editNumTva,
        IDadresse: editIDAdresse || 0,
      }),
    }),
    onSuccess: () => { invalidateAll(); setIsEditing(false) },
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => apiFetch(`/factures/${bucket}/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, deletedId) => {
      const cached = queryClient.getQueryData<FactureListRow[]>(['factures', bucket, typeFilter, debouncedQuery]) ?? []
      const remaining = cached.filter((f) => f.id !== deletedId)
      queryClient.invalidateQueries({ queryKey: ['factures'] })
      setIsEditing(false)
      setDeleteConfirmOpen(false)
      setSelectedId(remaining.length > 0 ? remaining[0].id : null)
    },
  })

  const convertMut = useMutation({
    mutationFn: (provId: number) => apiFetch(`/factures/prov/${provId}/convert`, { method: 'POST' }),
    onSuccess: (data: { IDfacture: number; numero: number }) => {
      queryClient.invalidateQueries({ queryKey: ['factures'] })
      setConvertConfirmOpen(false)
      setIsEditing(false)
      setConvertResult({ numero: data.numero })
      setBucket('def')
      setSelectedId(data.IDfacture)
    },
  })

  // "Faire un avoir" — creates a proforma Avoir prefilled from the selected
  // definitive facture (header + all lines), then jumps to it in the proforma
  // bucket in edit mode so the user can trim the lines to reimburse.
  const avoirMut = useMutation({
    mutationFn: (defId: number) => apiFetch(`/factures/def/${defId}/avoir`, { method: 'POST' }),
    onSuccess: (data: { id: number }) => {
      queryClient.invalidateQueries({ queryKey: ['factures'] })
      setAvoirConfirmOpen(false)
      setIsEditing(false)
      setBucket('prov')
      setNonEnvoyeOn(false)
      // Make sure the new avoir is visible in the list (a 'facture'-only type
      // filter or a stale search would hide it and auto-select would steal
      // the selection right after the jump).
      if (typeFilter === 'facture') setTypeFilter('all')
      setSearchQuery('')
      setSelectedId(data.id)
      setAutoEditForId(data.id)
    },
  })

  // Batch generate / wipe flip expedition.est_facture, which drives the
  // "non facturée" filter and status pill on Clients › Expéditions. Invalidate
  // both expedition query families so that screen refetches on next mount
  // instead of sitting on the 5-minute-staleTime cache (see lib/cache-sync.ts
  // for the pattern rationale).
  const invalidateExpeditions = () => {
    queryClient.invalidateQueries({ queryKey: ['expeditions'] }) // list (état pills, filter buckets)
    queryClient.invalidateQueries({ queryKey: ['expedition'] }) // any open detail (facturée state)
  }

  const generateMut = useMutation({
    mutationFn: (): Promise<GenerateSummary> => apiFetch('/factures/prov/generate', { method: 'POST' }),
    onSuccess: (r) => {
      setGenerateConfirmOpen(false)
      queryClient.invalidateQueries({ queryKey: ['factures'] })
      invalidateExpeditions()
      setBatchResult({ action: 'generate', ...r })
    },
  })

  const deleteBatchMut = useMutation({
    mutationFn: (ids: number[]): Promise<DeleteAllSummary> =>
      apiFetch('/factures/prov/delete-batch', { method: 'POST', body: JSON.stringify({ ids }) }),
    onSuccess: (r, ids) => {
      // Read the cache BEFORE invalidating so the next selection is computed
      // against the post-delete list, not the stale one (§25.2 pattern).
      const deletedSet = new Set(ids)
      const cached = queryClient.getQueryData<FactureListRow[]>(['factures', bucket, typeFilter, debouncedQuery]) ?? []
      const remaining = cached.filter((f) => !deletedSet.has(f.id))
      queryClient.invalidateQueries({ queryKey: ['factures'] })
      invalidateExpeditions()
      setIsEditing(false)
      if (bucket === 'prov' && selectedId !== null && deletedSet.has(selectedId)) {
        setSelectedId(remaining.length > 0 ? remaining[0].id : null)
      }
      setDeleteBatchOpen(false)
      setBatchResult({ action: 'deleteAll', ...r })
    },
  })

  const convertBatchMut = useMutation({
    mutationFn: (ids: number[]): Promise<ConvertBatchSummary> =>
      apiFetch('/factures/prov/convert-batch', { method: 'POST', body: JSON.stringify({ ids }) }),
    onSuccess: (r) => {
      // Converted proformas vanish from the prov bucket (they moved to the
      // definitive ledger) — same next-selection dance as the batch delete.
      const goneSet = new Set(r.converted.map((c) => c.prov_id))
      const cached = queryClient.getQueryData<FactureListRow[]>(['factures', bucket, typeFilter, debouncedQuery]) ?? []
      const remaining = cached.filter((f) => !goneSet.has(f.id))
      queryClient.invalidateQueries({ queryKey: ['factures'] })
      setIsEditing(false)
      if (bucket === 'prov' && selectedId !== null && goneSet.has(selectedId)) {
        setSelectedId(remaining.length > 0 ? remaining[0].id : null)
      }
      setConvertBatchOpen(false)
      setBatchResult({ action: 'convertBatch', ...r })
    },
  })

  useEffect(() => {
    if (autoEditForId !== null && detail?.id === autoEditForId && detail.kind === 'prov') {
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

  const handleSelect = useCallback((id: number) => {
    guard.guardAction(() => { setIsEditing(false); setSelectedId(id) })
  }, [guard])

  const handleBucketChange = useCallback((b: Kind) => {
    if (b === bucket) return
    guard.guardAction(() => { setIsEditing(false); setBucket(b); setSelectedId(null); setNonEnvoyeOn(false) })
  }, [guard, bucket])

  const handleTypeFilterChange = useCallback((t: 'all' | 'facture' | 'avoir') => {
    guard.guardAction(() => { setIsEditing(false); setTypeFilter(t); setSelectedId(null) })
  }, [guard])

  const allRows = factures ?? []
  // "Non envoyé" (red) count within the current view — definitive bucket only.
  const nonEnvoyeCount = bucket === 'def' ? allRows.filter((f) => !f.est_envoye).length : 0
  const rows = bucket === 'def' && nonEnvoyeOn ? allRows.filter((f) => !f.est_envoye) : allRows

  // Auto-release the filter when the last red row leaves the view (e.g. the
  // facture just got emailed) so the list doesn't sit on an empty filter.
  useEffect(() => {
    if (nonEnvoyeOn && !isFetching && nonEnvoyeCount === 0) setNonEnvoyeOn(false)
  }, [nonEnvoyeOn, isFetching, nonEnvoyeCount])

  useAutoSelectFirst({
    rows,
    selectedId,
    getId: (f) => f.id,
    select: setSelectedId,
    suspended: isEditing || isFetching,
  })

  return (
    <>
      <MasterDetailLayout
        list={
          <FactureList
            rows={rows}
            isLoading={isLoading}
            isError={isError}
            error={error as Error | null}
            selectedId={selectedId}
            onSelect={handleSelect}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            bucket={bucket}
            onBucketChange={handleBucketChange}
            typeFilter={typeFilter}
            onTypeFilterChange={handleTypeFilterChange}
            onNew={() => setCreateOpen(true)}
            onGenerate={() => setGenerateConfirmOpen(true)}
            onConvertBatch={() => setConvertBatchOpen(true)}
            onDeleteBatch={() => setDeleteBatchOpen(true)}
            onXImport={() => setXimportOpen(true)}
            nonEnvoyeCount={nonEnvoyeCount}
            nonEnvoyeOn={nonEnvoyeOn}
            onToggleNonEnvoye={() => setNonEnvoyeOn((v) => !v)}
            isEditing={isEditing}
            canEdit={canEditFactures}
          />
        }
        detailHeader={
          <DetailHeader
            facture={detail ?? null}
            isLoading={detailLoading && selectedId !== null}
            isEditing={isEditing}
            editable={editable}
            onStartEdit={startEdit}
            onCancelEdit={cancelEdit}
            onSave={() => saveHeaderMut.mutate()}
            isSaving={saveHeaderMut.isPending}
            onDelete={() => setDeleteConfirmOpen(true)}
            onPrintClick={() => { if (selectedId !== null) window.open(`${API_URL}/factures/${bucket}/${selectedId}/pdf`, '_blank') }}
            onEmailClick={() => setEmailModalOpen(true)}
            onConvertClick={() => setConvertConfirmOpen(true)}
            onAvoirClick={() => setAvoirConfirmOpen(true)}
            canEdit={canEditFactures}
          />
        }
        detail={
          <DetailMain
            facture={detail ?? null}
            isLoading={detailLoading && selectedId !== null}
            hasSelection={selectedId !== null}
            isEditing={isEditing}
            onMutationSuccess={invalidateAll}
            onLinesDirtyChange={setLinesDirty}
          />
        }
        sidebar={selectedId !== null ? (
          <DetailSidebar
            facture={detail ?? null}
            isLoading={detailLoading}
            isEditing={isEditing}
            editDate={editDate} onEditDateChange={setEditDate}
            editType={editType} onEditTypeChange={setEditType}
            editIDModePaiement={editIDModePaiement} onEditIDModePaiementChange={setEditIDModePaiement}
            editIDEcheance={editIDEcheance} onEditIDEcheanceChange={setEditIDEcheance}
            editIDTva={editIDTva} onEditIDTvaChange={setEditIDTva}
            editNumTva={editNumTva} onEditNumTvaChange={setEditNumTva}
            editIDAdresse={editIDAdresse} onEditIDAdresseChange={setEditIDAdresse}
          />
        ) : null}
        sidebarTitle="Informations"
        hasSelection={selectedId !== null}
        onBack={() => guard.guardAction(() => { setIsEditing(false); setSelectedId(null) })}
      />

      <UnsavedChangesDialog open={guard.showDialog} onAction={guard.handleAction} isSaving={guard.isSaving} />

      <CreateFactureDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(newId, newKind) => {
          setCreateOpen(false)
          queryClient.invalidateQueries({ queryKey: ['factures'] })
          setBucket(newKind)
          setSelectedId(newId)
          // Definitive opens read-only; proforma auto-enters edit mode.
          if (newKind === 'prov') setAutoEditForId(newId)
        }}
      />

      <ConfirmDialog
        open={deleteConfirmOpen}
        title={detail?.type === 2 ? "Supprimer l'avoir proforma" : 'Supprimer le proforma'}
        description="Ce proforma et toutes ses lignes seront supprimés. Cette action est irréversible."
        confirmLabel="Supprimer"
        isPending={deleteMut.isPending}
        onCancel={() => setDeleteConfirmOpen(false)}
        onConfirm={() => { if (selectedId !== null) deleteMut.mutate(selectedId) }}
      />

      <ConfirmDialog
        open={convertConfirmOpen}
        variant="default"
        title="Convertir en facture"
        description="Une facture définitive sera créée à partir de ce proforma, avec un numéro de facture officiel. Le proforma sera ensuite supprimé."
        confirmLabel="Convertir"
        isPending={convertMut.isPending}
        onCancel={() => setConvertConfirmOpen(false)}
        onConfirm={() => { if (selectedId !== null) convertMut.mutate(selectedId) }}
      />

      <ConfirmDialog
        open={avoirConfirmOpen}
        variant="default"
        title="Faire un avoir"
        description={`Un avoir proforma sera créé à partir de la facture N° ${detail?.numero ?? ''} avec toutes ses lignes. Vous pourrez ensuite ajuster les lignes à rembourser avant de le convertir en avoir définitif.`}
        confirmLabel="Créer l'avoir"
        isPending={avoirMut.isPending}
        onCancel={() => setAvoirConfirmOpen(false)}
        onConfirm={() => { if (selectedId !== null) avoirMut.mutate(selectedId) }}
      />

      <ConfirmDialog
        open={generateConfirmOpen}
        variant="default"
        title="Générer les factures"
        description="Un proforma sera créé par client à partir de toutes les expéditions non facturées. Les clients internes et les donations sont exclus."
        confirmLabel="Générer"
        isPending={generateMut.isPending}
        onCancel={() => setGenerateConfirmOpen(false)}
        onConfirm={() => generateMut.mutate()}
      />

      <ProformaPickDialog
        open={convertBatchOpen}
        isPending={convertBatchMut.isPending}
        onClose={() => setConvertBatchOpen(false)}
        onConfirm={(ids) => convertBatchMut.mutate(ids)}
        title="Convertir des factures proforma"
        titleIcon={<FileCheck className="h-5 w-5 text-accent" />}
        intro="Sélectionnez les proformas à convertir : chacun deviendra une facture définitive avec un numéro officiel, puis sera supprimé."
        emptyText="Aucun proforma à convertir"
        confirmLabel="Convertir"
        confirmVariant="default"
        confirmIcon={<FileCheck className="h-3.5 w-3.5 mr-1.5" />}
      />

      <ProformaPickDialog
        open={deleteBatchOpen}
        isPending={deleteBatchMut.isPending}
        onClose={() => setDeleteBatchOpen(false)}
        onConfirm={(ids) => deleteBatchMut.mutate(ids)}
        title="Supprimer des factures proforma"
        titleIcon={<Trash2 className="h-5 w-5 text-destructive" />}
        intro="Sélectionnez les proformas à supprimer : leurs expéditions redeviendront facturables."
        emptyText="Aucun proforma à supprimer"
        confirmLabel="Supprimer"
        confirmVariant="destructive"
        confirmIcon={<Trash2 className="h-3.5 w-3.5 mr-1.5" />}
      />

      <BatchResultDialog result={batchResult} onClose={() => setBatchResult(null)} />

      <XImportDialog open={ximportOpen} onClose={() => setXimportOpen(false)} />

      <Dialog open={convertResult !== null} onOpenChange={(o) => { if (!o) setConvertResult(null) }}>
        <DialogContent className="max-w-sm" onClose={() => setConvertResult(null)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileCheck className="h-5 w-5 text-accent" />Facture créée
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col items-center justify-center py-6 text-center mt-4">
            <div className="icon-box-gold h-14 w-14 mb-3 flex items-center justify-center"><CheckCircle2 className="h-7 w-7" /></div>
            <p className="text-sm text-muted-foreground">Le proforma a été converti en facture définitive.</p>
            {convertResult && <p className="text-lg font-heading font-bold mt-1">N° {convertResult.numero}</p>}
          </div>
        </DialogContent>
      </Dialog>

      {selectedId !== null && (
        <SendEmailDialog
          open={emailModalOpen}
          onClose={() => setEmailModalOpen(false)}
          contextLabel={detail?.client_nom ?? undefined}
          queryKey={['facture-email-defaults', bucket, selectedId]}
          loadDefaults={() => apiFetch(`/factures/${bucket}/${selectedId}/email-defaults`)}
          pdfUrl={`${API_URL}/factures/${bucket}/${selectedId}/pdf`}
          pdfAttachmentLabel={`${bucket === 'prov' ? 'proforma' : detail?.type === 2 ? 'avoir' : 'facture'}-${detail?.numero ?? selectedId}.pdf`}
          onSend={async (p) => {
            await postEmail(`${API_URL}/factures/${bucket}/${selectedId}/email`, p, { includeAttachPdf: true })
            // The send logs an envoi_email row server-side — refresh the
            // historique tab without a manual reload (kind === bucket), and
            // the list so the "non envoyé" red frame clears.
            queryClient.invalidateQueries({ queryKey: ['facture-historique', bucket, selectedId] })
            queryClient.invalidateQueries({ queryKey: ['factures'] })
          }}
        />
      )}
    </>
  )
}

// ── Batch result summary (generate / delete-all) ───────

function BatchResultDialog({ result, onClose }: { result: BatchResult | null; onClose: () => void }) {
  const skippedText = (s: GenerateSummary['skipped']): string | null => {
    const parts: string[] = []
    if (s.internes > 0) parts.push(`${s.internes} client interne`)
    if (s.donations > 0) parts.push(`${s.donations} donation`)
    if (s.vides > 0) parts.push(`${s.vides} sans marchandise`)
    return parts.length > 0 ? `Expéditions ignorées : ${parts.join(' · ')}` : null
  }
  return (
    <Dialog open={result !== null} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {result?.action === 'deleteAll'
              ? <><Trash2 className="h-5 w-5 text-accent" />Proformas supprimés</>
              : result?.action === 'convertBatch'
                ? <><FileCheck className="h-5 w-5 text-accent" />Factures converties</>
                : <><FilePlus2 className="h-5 w-5 text-accent" />Factures générées</>}
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4">
          {result?.action === 'generate' && (
            result.created.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-6 text-muted-foreground text-center">
                <Receipt className="h-12 w-12 mb-3 opacity-40" />
                <p className="text-sm font-medium">Aucune expédition à facturer</p>
                {skippedText(result.skipped) && <p className="text-xs mt-1">{skippedText(result.skipped)}</p>}
              </div>
            ) : (
              <>
                <p className="text-sm text-muted-foreground mb-3">
                  {result.created.length} proforma{result.created.length > 1 ? 's' : ''} créé{result.created.length > 1 ? 's' : ''} :
                </p>
                <div className="space-y-1.5 max-h-64 overflow-y-auto scrollbar-transparent p-0.5">
                  {result.created.map((c) => (
                    <div key={c.id} className="flex items-center gap-2 p-2 rounded-md border border-border/60 bg-zinc-100/80 text-sm">
                      <Receipt className="h-4 w-4 text-amber-500 flex-shrink-0" />
                      <span className="font-medium flex-shrink-0">N° {c.numero}</span>
                      <span className="text-muted-foreground truncate flex-1">{c.client_nom || '—'}</span>
                      <span className="text-xs text-muted-foreground flex-shrink-0 tabular-nums">
                        {c.nb_lignes} ligne{c.nb_lignes > 1 ? 's' : ''}
                      </span>
                    </div>
                  ))}
                </div>
                {skippedText(result.skipped) && (
                  <p className="text-xs text-muted-foreground mt-3">{skippedText(result.skipped)}</p>
                )}
              </>
            )
          )}
          {result?.action === 'deleteAll' && (
            <div className="flex flex-col items-center justify-center py-6 text-center">
              <div className="icon-box-gold h-14 w-14 mb-3 flex items-center justify-center"><CheckCircle2 className="h-7 w-7" /></div>
              <p className="text-sm text-muted-foreground">
                {result.deleted === 0
                  ? 'Aucun proforma à supprimer.'
                  : `${result.deleted} proforma${result.deleted > 1 ? 's' : ''} supprimé${result.deleted > 1 ? 's' : ''}.`}
              </p>
              {result.expeditions_reouvertes > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  {result.expeditions_reouvertes} expédition{result.expeditions_reouvertes > 1 ? 's' : ''} à nouveau facturable{result.expeditions_reouvertes > 1 ? 's' : ''}.
                </p>
              )}
            </div>
          )}
          {result?.action === 'convertBatch' && (
            result.converted.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-6 text-muted-foreground text-center">
                <Receipt className="h-12 w-12 mb-3 opacity-40" />
                <p className="text-sm font-medium">Aucun proforma converti</p>
              </div>
            ) : (
              <>
                <p className="text-sm text-muted-foreground mb-3">
                  {result.converted.length} facture{result.converted.length > 1 ? 's' : ''} définitive{result.converted.length > 1 ? 's' : ''} créée{result.converted.length > 1 ? 's' : ''} :
                </p>
                <div className="space-y-1.5 max-h-64 overflow-y-auto scrollbar-transparent p-0.5">
                  {result.converted.map((c) => (
                    <div key={c.IDfacture} className="flex items-center gap-2 p-2 rounded-md border border-border/60 bg-zinc-100/80 text-sm">
                      <FileCheck className="h-4 w-4 text-green-600 flex-shrink-0" />
                      <span className="text-muted-foreground flex-shrink-0 tabular-nums">Proforma N° {c.prov_id}</span>
                      <span className="text-muted-foreground flex-shrink-0">→</span>
                      <span className="font-medium flex-shrink-0 tabular-nums">N° {c.numero}</span>
                      <span className="text-muted-foreground truncate flex-1">{c.client_nom || '—'}</span>
                    </div>
                  ))}
                </div>
                {result.skipped > 0 && (
                  <p className="text-xs text-muted-foreground mt-3">
                    {result.skipped} proforma{result.skipped > 1 ? 's' : ''} introuvable{result.skipped > 1 ? 's' : ''} (liste obsolète).
                  </p>
                )}
              </>
            )
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── XImport export dialog (definitive bucket) ──────────

/** Pick a day → preview how many definitive invoices it holds → download the
 *  fixed-width XImport.txt accounting file for that day. Mirrors the legacy
 *  "Date des factures à envoyer en compta" prompt. */
function XImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [date, setDate] = useState('')

  // Fresh default (today) every time the dialog opens.
  useEffect(() => {
    if (open) {
      const t = new Date()
      const pad = (x: number) => String(x).padStart(2, '0')
      setDate(`${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`)
    }
  }, [open])

  const dateDigits = date.replace(/-/g, '')
  const dateValid = /^\d{8}$/.test(dateDigits)

  const { data: summary, isFetching } = useQuery<XImportSummary>({
    queryKey: ['factures', 'ximport-summary', dateDigits],
    queryFn: () => apiFetch(`/factures/ximport/summary?date=${dateDigits}`),
    enabled: open && dateValid,
  })

  const nbDocs = (summary?.nb_factures ?? 0) + (summary?.nb_avoirs ?? 0)

  const download = () => {
    window.open(`${API_URL}/factures/ximport?date=${dateDigits}`, '_blank')
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-sm" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileDown className="h-5 w-5 text-accent" />Export XImport
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Le fichier XImport.txt contiendra les écritures comptables de toutes les factures définitives du jour sélectionné.
          </p>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Date des factures à envoyer en compta</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full h-9 px-2.5 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          {/* Preview of what the file will contain for the picked day. */}
          {dateValid && (
            <div className="rounded-lg border border-border/60 bg-zinc-100/80 p-3">
              {isFetching ? (
                <div className="flex items-center justify-center py-2"><Loader2 className="h-4 w-4 animate-spin text-accent" /></div>
              ) : nbDocs === 0 ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <CalendarDays className="h-4 w-4 flex-shrink-0" />
                  Aucune facture définitive à cette date
                </div>
              ) : (
                <div className="space-y-1 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Factures</span>
                    <span className="font-medium tabular-nums">{summary?.nb_factures ?? 0}</span>
                  </div>
                  {(summary?.nb_avoirs ?? 0) > 0 && (
                    <div className="flex items-center justify-between">
                      <span className="text-muted-foreground">Avoirs</span>
                      <span className="font-medium tabular-nums">{summary?.nb_avoirs}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between pt-1 border-t border-border/60">
                    <span className="text-muted-foreground">Total TTC</span>
                    <span className="font-semibold tabular-nums">{fmtNum(summary?.total_ttc ?? 0, 2)} €</span>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={download} disabled={!dateValid || isFetching || nbDocs === 0}>
            <FileDown className="h-3.5 w-3.5 mr-1.5" />Générer le fichier
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Proforma batch picker (convert / delete) ───────────

/** Selection dialog shared by the "Convertir des factures" and "Supprimer des
 *  factures" batch actions: lists every proforma with checkboxes and a
 *  select-all header. The dialog itself is the confirmation surface — no
 *  second ConfirmDialog. */
function ProformaPickDialog({
  open, isPending, onClose, onConfirm,
  title, titleIcon, intro, emptyText, confirmLabel, confirmVariant, confirmIcon,
}: {
  open: boolean
  isPending: boolean
  onClose: () => void
  onConfirm: (ids: number[]) => void
  title: string
  titleIcon: React.ReactNode
  intro: string
  emptyText: string
  confirmLabel: string
  confirmVariant: 'default' | 'destructive'
  confirmIcon: React.ReactNode
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set())

  // Independent of the list panel's search/type filters — the user picks from
  // ALL proformas. Key shares the ['factures'] root so the existing
  // batch-mutation invalidations refresh it too.
  const { data, isLoading } = useQuery<FactureListRow[]>({
    queryKey: ['factures', 'prov-pick'],
    queryFn: () => apiFetch('/factures?status=prov&type=all&q=&limit=200'),
    enabled: open,
  })
  const rows = data ?? []

  // Fresh selection every time the dialog opens.
  useEffect(() => { if (open) setSelected(new Set()) }, [open])

  const allSelected = rows.length > 0 && selected.size === rows.length
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))
  const toggleOne = (id: number) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const checkboxClass = 'h-4 w-4 rounded border-input text-accent focus:ring-2 focus:ring-ring cursor-pointer'

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !isPending) onClose() }}>
      <DialogContent className="max-w-lg" onClose={() => { if (!isPending) onClose() }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {titleIcon}{title}
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground text-center">
              <Receipt className="h-12 w-12 mb-3 opacity-40" />
              <p className="text-sm font-medium">{emptyText}</p>
            </div>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{intro}</p>
              <label className="flex items-center gap-2 mt-3 px-2 py-1.5 text-sm font-medium cursor-pointer select-none rounded-md hover:bg-accent/5">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = selected.size > 0 && !allSelected }}
                  onChange={toggleAll}
                  disabled={isPending}
                  className={checkboxClass}
                />
                Tout sélectionner
                <span className="ml-auto text-xs font-normal text-muted-foreground tabular-nums">
                  {selected.size}/{rows.length}
                </span>
              </label>
              <div className="mt-1.5 space-y-1.5 max-h-72 overflow-y-auto scrollbar-transparent p-0.5">
                {rows.map((row) => {
                  const isChecked = selected.has(row.id)
                  const chip = typeChip(row.type)
                  const ttc = signed(row.total_ttc, row.type)
                  return (
                    <label
                      key={row.id}
                      className={cn(
                        'flex items-center gap-2.5 p-2 rounded-md border text-sm cursor-pointer select-none transition-colors',
                        isChecked ? 'border-accent/50 bg-accent/[0.06]' : 'border-border/60 bg-zinc-100/80 hover:border-accent/40',
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleOne(row.id)}
                        disabled={isPending}
                        className={cn(checkboxClass, 'flex-shrink-0')}
                      />
                      <Receipt className="h-4 w-4 text-amber-500 flex-shrink-0" />
                      <span className="font-medium flex-shrink-0">N° {row.numero ?? row.id}</span>
                      <span className="text-muted-foreground truncate flex-1">{row.client_nom || '—'}</span>
                      {row.date && (
                        <span className="text-xs text-muted-foreground flex-shrink-0">{formatHfsqlDate(row.date)}</span>
                      )}
                      <span className={cn('px-1.5 py-0.5 rounded text-[10px] font-medium flex-shrink-0', chip.classes)}>{chip.label}</span>
                      <span className={cn('text-xs font-medium tabular-nums flex-shrink-0', row.type === 2 ? 'text-red-600' : 'text-foreground')}>
                        {fmtNum(ttc, 2)} €
                      </span>
                    </label>
                  )
                })}
              </div>
            </>
          )}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose} disabled={isPending}>Annuler</Button>
          <Button
            variant={confirmVariant}
            disabled={selected.size === 0 || isPending}
            onClick={() => onConfirm(Array.from(selected))}
          >
            {isPending
              ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              : confirmIcon}
            {confirmLabel}{selected.size > 0 ? ` (${selected.size})` : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Left Panel: List ───────────────────────────────────

function FactureList({
  rows, isLoading, isError, error,
  selectedId, onSelect,
  searchQuery, onSearchChange,
  bucket, onBucketChange,
  typeFilter, onTypeFilterChange,
  onNew, onGenerate, onConvertBatch, onDeleteBatch, onXImport,
  nonEnvoyeCount, nonEnvoyeOn, onToggleNonEnvoye,
  isEditing, canEdit,
}: {
  rows: FactureListRow[]
  isLoading: boolean
  isError: boolean
  error: Error | null
  selectedId: number | null
  onSelect: (id: number) => void
  searchQuery: string
  onSearchChange: (q: string) => void
  bucket: Kind
  onBucketChange: (b: Kind) => void
  typeFilter: 'all' | 'facture' | 'avoir'
  onTypeFilterChange: (t: 'all' | 'facture' | 'avoir') => void
  onNew: () => void
  onGenerate: () => void
  onConvertBatch: () => void
  onDeleteBatch: () => void
  onXImport: () => void
  nonEnvoyeCount: number
  nonEnvoyeOn: boolean
  onToggleNonEnvoye: () => void
  isEditing: boolean
  canEdit: boolean
}) {
  return (
    <div className="flex flex-col h-full rounded-lg border shadow-sm bg-zinc-100/80">
      <div className="p-3 border-b rounded-t-lg bg-zinc-200/50 space-y-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
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
          {/* "Non envoyé" red pill — definitive bucket only, hidden when the
              current view has no unsent facture. Number-only toggle flush to
              the search input, mirroring the SousTraitantsCommandes urgency
              pills. */}
          {bucket === 'def' && nonEnvoyeCount > 0 && (
            <button
              type="button"
              onClick={onToggleNonEnvoye}
              aria-pressed={nonEnvoyeOn}
              title="Factures non envoyées"
              className={cn(
                'h-7 min-w-[1.75rem] px-1.5 inline-flex items-center justify-center rounded-md text-xs font-semibold tabular-nums border transition-colors flex-shrink-0',
                nonEnvoyeOn
                  ? 'bg-red-500 text-white border-red-500 shadow-sm'
                  : 'bg-red-500/10 text-red-700 border-red-500/30 hover:bg-red-500/20'
              )}
            >
              {nonEnvoyeCount}
            </button>
          )}
        </div>
        {/* Category switch — proforma drafts vs issued (definitive) invoices.
            Prominent bordered segmented control: this picks which set of
            documents you're looking at, so it reads as the dominant control. */}
        <div className="flex gap-1 p-1 rounded-lg border border-border bg-background shadow-sm">
          {([
            { key: 'prov', label: 'Proforma' },
            { key: 'def', label: 'Définitives' },
          ] as const).map((opt) => (
            <button
              key={opt.key}
              onClick={() => onBucketChange(opt.key)}
              className={cn(
                'flex-1 px-3 py-2 text-sm rounded-md transition-colors font-semibold',
                bucket === opt.key
                  ? 'bg-accent text-accent-foreground shadow-sm'
                  : 'text-muted-foreground hover:bg-accent/10',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {/* Type filter within the current category — standard left-list
            filter button group (matches every other screen). */}
        <div className="flex flex-wrap gap-1">
          {([
            { key: 'all', label: 'Tous' },
            { key: 'facture', label: 'Factures' },
            { key: 'avoir', label: 'Avoirs' },
          ] as const).map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => onTypeFilterChange(opt.key)}
              className={cn(
                'px-2 py-1 text-xs rounded-md transition-colors flex-grow basis-[calc(33.333%-0.25rem)]',
                typeFilter === opt.key
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
            <Receipt className="h-12 w-12 mb-3 opacity-50" />
            <p className="text-sm">{bucket === 'prov' ? 'Aucun proforma' : 'Aucune facture'}</p>
          </div>
        ) : rows.map((row) => {
          const isSelected = selectedId === row.id
          const chip = typeChip(row.type)
          const ttc = signed(row.total_ttc, row.type)
          // Definitive facture never emailed → red urgency frame (inset left
          // strip + red selection ring), same visual language as the
          // Sous-traitants › Commandes deadline cards (mps_designer §30).
          const isNonEnvoye = row.kind === 'def' && !row.est_envoye
          return (
            <div
              key={row.id}
              onClick={() => onSelect(row.id)}
              className={cn(
                'p-3 border rounded-lg cursor-pointer transition-all bg-white',
                isSelected
                  ? (isNonEnvoye ? 'border-red-500 ring-1 ring-red-500' : 'border-accent ring-1 ring-accent')
                  : (isNonEnvoye ? 'border-border hover:border-red-500/50' : 'border-border hover:border-accent/50'),
                isNonEnvoye && 'shadow-[inset_4px_0_0_0_rgb(239_68_68)]',
              )}
            >
              <div className="flex items-center gap-2">
                <Receipt className={cn('h-4 w-4 flex-shrink-0', row.kind === 'prov' ? 'text-amber-500' : 'text-muted-foreground')} />
                <span className="font-medium text-sm">
                  {row.kind === 'prov' ? 'Proforma ' : ''}N° {row.numero ?? row.id}
                </span>
                <span className={cn('ml-auto px-1.5 py-0.5 rounded text-[10px] font-medium', chip.classes)}>{chip.label}</span>
              </div>
              <p className="text-xs text-muted-foreground mt-1 truncate">{row.client_nom || '—'}</p>
              <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground">
                {row.date && <span>{formatHfsqlDate(row.date)}</span>}
                <span className="ml-auto text-muted-foreground/70">{row.nb_lignes} ligne{row.nb_lignes > 1 ? 's' : ''}</span>
                <span className={cn('px-1.5 py-0.5 rounded bg-accent/10 font-medium tabular-nums', row.type === 2 ? 'text-red-600' : 'text-foreground')}>
                  {fmtNum(ttc, 2)} €
                </span>
              </div>
            </div>
          )
        })}
      </div>

      {/* Batch actions — proforma bucket only: definitive invoices are
          immutable once created (the API 409s any mutation on them), so
          batch generate/convert/delete only ever operates on proformas.
          Pinned above the footer (flex sibling of the scrollable list, so
          they stay visible however long the list is). Disabled during edit
          mode rather than hidden: batch operations while a proforma edit
          is in flight would be destructive. Hidden entirely without the
          edit_factures permission (API gates the endpoints too). */}
      {bucket === 'prov' && canEdit && (
        <div className="flex-shrink-0 p-3 border-t bg-zinc-200/50 space-y-1.5">
          <Button size="sm" className="w-full" onClick={onGenerate} disabled={isEditing}>
            <FilePlus2 className="h-3.5 w-3.5 mr-1.5" />Générer les factures
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onConvertBatch}
            disabled={isEditing}
            className="w-full"
          >
            <FileCheck className="h-3.5 w-3.5 mr-1.5" />Convertir des factures
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onDeleteBatch}
            disabled={isEditing}
            className="w-full text-destructive border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5 mr-1.5" />Supprimer des factures
          </Button>
        </div>
      )}

      {/* XImport — definitive bucket only: exports one day's issued invoices
          as the fixed-width accounting file (legacy FI_Facturation_ETM
          "envoyer en compta" flow). Read-only, so no permission gate. */}
      {bucket === 'def' && (
        <div className="flex-shrink-0 p-3 border-t bg-zinc-200/50">
          <Button size="sm" variant="outline" className="w-full" onClick={onXImport}>
            <FileDown className="h-3.5 w-3.5 mr-1.5" />XImport
          </Button>
        </div>
      )}

      <div className="p-3 border-t text-xs text-muted-foreground flex items-center justify-between rounded-b-lg bg-zinc-200/50">
        <span>{rows.length} document{rows.length !== 1 ? 's' : ''}</span>
        {!isEditing && canEdit && (
          <Button size="sm" variant="ghost" onClick={onNew} className="text-accent hover:text-accent hover:bg-accent/10">
            <Plus className="h-3.5 w-3.5 mr-1" />Nouveau
          </Button>
        )}
      </div>
    </div>
  )
}

// ── Center: Detail Header ──────────────────────────────

function DetailHeader({
  facture, isLoading, isEditing, editable,
  onStartEdit, onCancelEdit, onSave, isSaving,
  onDelete, onPrintClick, onEmailClick, onConvertClick, onAvoirClick,
  canEdit,
}: {
  facture: FactureDetail | null
  isLoading: boolean
  isEditing: boolean
  editable: boolean
  onStartEdit: () => void
  onCancelEdit: () => void
  onSave: () => void
  isSaving: boolean
  onDelete: () => void
  onPrintClick: () => void
  onEmailClick: () => void
  onConvertClick: () => void
  onAvoirClick: () => void
  canEdit: boolean
}) {
  if (!facture && !isLoading) return null
  const chip = facture ? typeChip(facture.type) : null
  const isProforma = facture?.kind === 'prov'
  return (
    <div className="flex-shrink-0 pt-0.5">
      <div className="flex items-center gap-3">
        <div className={cn('h-11 w-11 rounded-lg flex items-center justify-center', isEditing ? 'bg-accent/15' : 'icon-box-gold')}>
          <Receipt className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          {isLoading ? (
            <div className="h-8 w-48 bg-muted animate-pulse rounded" />
          ) : (
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-heading font-bold tracking-tight truncate">
                {isProforma ? 'Proforma ' : ''}N° {facture?.numero ?? facture?.id}
                <span className="text-muted-foreground font-normal"> · {facture?.client_nom || '—'}</span>
              </h1>
              <div className="flex items-center gap-2 flex-shrink-0">
                {chip && <span className={cn('px-2 py-0.5 rounded text-xs font-medium', chip.classes)}>{chip.label}</span>}
                {isProforma ? (
                  <Badge className="bg-amber-400/15 text-amber-700 border border-amber-500/30 text-xs gap-1"><FileText className="h-3 w-3" />Proforma</Badge>
                ) : (
                  <Badge variant="secondary" className="text-xs gap-1"><Lock className="h-3 w-3" />Définitive</Badge>
                )}
                {facture?.date && (
                  <Badge variant="secondary" className="text-xs">{formatHfsqlDate(facture.date)}</Badge>
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
        {!isLoading && facture && (
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
                {/* Faire un avoir — definitive factures only (not on an avoir):
                    creates a prefilled proforma Avoir (edit_factures permission) */}
                {facture?.kind === 'def' && facture.type !== 2 && canEdit && (
                  <Button variant="outline" size="icon" className="h-9 w-9" onClick={onAvoirClick} title="Créer un avoir à partir de cette facture">
                    <FileMinus2 className="h-4 w-4" />
                  </Button>
                )}
                <Button variant="outline" size="icon" className="h-9 w-9" title="Imprimer" onClick={onPrintClick}>
                  <Printer className="h-4 w-4" />
                </Button>
                <Button variant="outline" size="icon" className="h-9 w-9" title="Envoyer un email" onClick={onEmailClick}>
                  <AtSign className="h-4 w-4" />
                </Button>
                {/* Convert proforma → definitive — edit_factures permission */}
                {editable && canEdit && (
                  <Button variant="outline" size="sm" onClick={onConvertClick} title="Convertir le proforma en facture définitive">
                    <FileCheck className="h-3.5 w-3.5 mr-1.5" />Convertir en facture
                  </Button>
                )}
                {/* Modifier — only an open proforma is editable, and only
                    with the edit_factures permission */}
                {editable && canEdit && (
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

// ── Center: Detail Main (lines + totals) ───────────────

function DetailMain({
  facture, isLoading, hasSelection, isEditing, onMutationSuccess, onLinesDirtyChange,
}: {
  facture: FactureDetail | null
  isLoading: boolean
  hasSelection: boolean
  isEditing: boolean
  onMutationSuccess: () => void
  onLinesDirtyChange: (dirty: boolean) => void
}) {
  if (!hasSelection) return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="icon-box-gold h-16 w-16 mx-auto"><Receipt className="h-8 w-8" /></div>
        <p className="text-muted-foreground text-sm">Sélectionnez un document dans la liste</p>
      </div>
    </div>
  )
  if (isLoading) return <div className="flex-1 flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-accent" /></div>
  if (!facture) return null

  return (
    <LignesSection
      facture={facture}
      isEditing={isEditing}
      onMutationSuccess={onMutationSuccess}
      onLinesDirtyChange={onLinesDirtyChange}
    />
  )
}

// ── Center: Lignes Section ─────────────────────────────

const emptyLineForm = { designation: '', quantite: '', unite: 'Ml', prix: '' }
type LineFormState = typeof emptyLineForm

function LignesSection({
  facture, isEditing, onMutationSuccess, onLinesDirtyChange,
}: {
  facture: FactureDetail
  isEditing: boolean
  onMutationSuccess: () => void
  onLinesDirtyChange: (dirty: boolean) => void
}) {
  const [lineDialogOpen, setLineDialogOpen] = useState(false)
  const [editingLine, setEditingLine] = useState<LigneFacture | null>(null)
  const [deleteLineConfirmId, setDeleteLineConfirmId] = useState<number | null>(null)

  useEffect(() => {
    if (!isEditing) { setLineDialogOpen(false); setEditingLine(null) }
  }, [isEditing])

  useEffect(() => {
    onLinesDirtyChange(lineDialogOpen)
  }, [lineDialogOpen, onLinesDirtyChange])

  const deleteLineMut = useMutation({
    mutationFn: (lineId: number) => apiFetch(`/factures/${facture.kind}/lignes/${lineId}`, { method: 'DELETE' }),
    onSuccess: onMutationSuccess,
  })

  const startAddLine = () => { setEditingLine(null); setLineDialogOpen(true) }
  const startEditLine = (l: LigneFacture) => { setEditingLine(l); setLineDialogOpen(true) }

  const isAvoir = facture.type === 2

  return (
    <>
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="flex-1 min-h-0 overflow-auto space-y-2 p-1 scrollbar-transparent">
          {facture.lignes.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Layers className="h-12 w-12 mb-3 opacity-40" />
              <p className="text-sm">Aucune ligne</p>
              {isEditing && (
                <Button variant="outline" size="sm" className="mt-3" onClick={startAddLine}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" />Ajouter une ligne
                </Button>
              )}
            </div>
          ) : (
            facture.lignes.map((l) => (
              <LineCard
                key={l.IDligne_facture}
                line={l}
                isEditing={isEditing}
                onEdit={() => startEditLine(l)}
                onDelete={() => setDeleteLineConfirmId(l.IDligne_facture)}
              />
            ))
          )}

          {isEditing && facture.lignes.length > 0 && (
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

        {/* Totals footer */}
        <div className="flex-shrink-0 mt-3 pt-3 border-t border-border/60">
          {/* An exonerated client (Clients › Gestion) carries no VAT, so the
              block collapses to the HT total — same as the PDF. */}
          <div className="flex flex-col items-end gap-1 text-sm tabular-nums">
            {!(facture.tva_rate > 0) ? null : (
              <>
                <div className="flex items-center gap-6">
                  <span className="text-muted-foreground text-xs uppercase tracking-wide">Total HT</span>
                  <span className="w-32 text-right font-medium">{fmtNum(facture.total_ht, 2)} €</span>
                </div>
                <div className="flex items-center gap-6">
                  <span className="text-muted-foreground text-xs uppercase tracking-wide">TVA ({tvaRateLabel(facture.tva_rate)})</span>
                  <span className="w-32 text-right">{fmtNum(facture.total_tva, 2)} €</span>
                </div>
              </>
            )}
            <div className={cn('flex items-center gap-6', facture.tva_rate > 0 && 'mt-0.5 pt-1.5 border-t border-border/60')}>
              <span className={cn('text-xs uppercase tracking-wide font-bold', isAvoir ? 'text-destructive' : 'text-primary')}>
                {facture.tva_rate > 0
                  ? (isAvoir ? 'Total Avoir TTC' : 'Total TTC')
                  : (isAvoir ? 'Total Avoir HT' : 'Total HT')}
              </span>
              <span className={cn('w-32 text-right text-base font-bold', isAvoir ? 'text-destructive' : 'text-accent')}>
                {fmtNum(signed(facture.tva_rate > 0 ? facture.total_ttc : facture.total_ht, facture.type), 2)} €
              </span>
            </div>
          </div>
        </div>
      </div>

      <LineFormDialog
        open={lineDialogOpen}
        facture={facture}
        line={editingLine}
        onClose={() => { setLineDialogOpen(false); setEditingLine(null) }}
        onSuccess={() => { setLineDialogOpen(false); setEditingLine(null); onMutationSuccess() }}
      />

      <ConfirmDialog
        open={deleteLineConfirmId !== null}
        title="Supprimer la ligne"
        description="Cette ligne sera définitivement supprimée."
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
  line, isEditing, onEdit, onDelete,
}: {
  line: LigneFacture
  isEditing: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const descLines = String(line.designation ?? '').split(/\r?\n/).filter((s) => s.trim().length > 0)
  const title = descLines[0] || '—'
  const rest = descLines.slice(1)
  // Domain glyph per line kind: fini roll / tombé-de-métier (écru) roll — the
  // same icons as ClientsExpeditions line cards. Divers/manual lines keep Package.
  const LineIcon = line.stock_kind === 'fini' ? FiniRollIcon : line.stock_kind === 'ecru' ? TmRollIcon : Package
  const lineIconSize = line.stock_kind === 'divers' ? 'h-3.5 w-3.5' : 'h-5 w-5'
  return (
    <div className={cn('group rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3', 'border-l-amber-400/60')}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-amber-400/10 mt-0.5">
            <LineIcon className={cn(lineIconSize, 'text-amber-600')} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-medium">{title}</p>
            {rest.map((r, i) => (
              <p key={i} className="text-[11px] text-muted-foreground">{r}</p>
            ))}
          </div>
        </div>
        {isEditing && (
          <div className="flex gap-0.5 flex-shrink-0">
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onEdit}>
              <Pencil className="h-3 w-3" />
            </Button>
            <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive" onClick={onDelete}>
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        )}
      </div>
      <div className="flex items-center gap-3 mt-2 ml-9 text-[11px] text-muted-foreground tabular-nums">
        <span>{fmtNum(line.quantite, 2)} {line.unite}</span>
        <span>× {fmtNum(line.prix, 2)} €</span>
        <span className="ml-auto font-medium text-foreground">{fmtNum(line.montant, 2)} €</span>
      </div>
    </div>
  )
}

// ── Line create/edit dialog ────────────────────────────

function LineFormDialog({
  open, facture, line, onClose, onSuccess,
}: {
  open: boolean
  facture: FactureDetail
  line: LigneFacture | null
  onClose: () => void
  onSuccess: () => void
}) {
  const isNew = line === null
  const [form, setForm] = useState<LineFormState>(emptyLineForm)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    if (line) {
      setForm({
        designation: line.designation ?? '',
        quantite: line.quantite != null ? String(line.quantite) : '',
        unite: line.unite || 'Ml',
        prix: line.prix != null ? String(line.prix) : '',
      })
    } else {
      setForm(emptyLineForm)
    }
    setError(null)
  }, [open, line])

  const saveMut = useMutation({
    mutationFn: () => {
      const body = JSON.stringify({
        designation: form.designation,
        quantite: Number(form.quantite) || 0,
        unite: form.unite,
        prix: Number(form.prix) || 0,
      })
      return isNew
        ? apiFetch(`/factures/${facture.kind}/${facture.id}/lignes`, { method: 'POST', body })
        : apiFetch(`/factures/${facture.kind}/lignes/${line!.IDligne_facture}`, { method: 'PUT', body })
    },
    onSuccess,
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Erreur'),
  })

  const montant = (Number(form.quantite) || 0) * (Number(form.prix) || 0)
  const canSave = form.designation.trim().length > 0

  if (!open) return null

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
            <label className="text-xs font-medium text-muted-foreground">Désignation</label>
            <textarea
              value={form.designation}
              onChange={(e) => setForm({ ...form, designation: e.target.value })}
              rows={4}
              autoFocus
              placeholder="Référence, V/ref, N° commande, avis…"
              className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y"
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Quantité</label>
              <input type="number" value={form.quantite} onChange={(e) => setForm({ ...form, quantite: e.target.value })} className={inputClass} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Unité</label>
              <input type="text" value={form.unite} onChange={(e) => setForm({ ...form, unite: e.target.value })} placeholder="Ml" className={inputClass} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Prix (€)</label>
              <input type="number" value={form.prix} onChange={(e) => setForm({ ...form, prix: e.target.value })} className={inputClass} />
            </div>
          </div>
          <div className="flex items-center justify-between rounded-md bg-zinc-100 px-3 py-2 text-sm">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">Montant HT</span>
            <span className="font-semibold tabular-nums">{fmtNum(montant, 2)} €</span>
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

type SidebarTab = 'info' | 'historique'

function DetailSidebar({
  facture, isLoading, isEditing,
  editDate, onEditDateChange,
  editType, onEditTypeChange,
  editIDModePaiement, onEditIDModePaiementChange,
  editIDEcheance, onEditIDEcheanceChange,
  editIDTva, onEditIDTvaChange,
  editNumTva, onEditNumTvaChange,
  editIDAdresse, onEditIDAdresseChange,
}: {
  facture: FactureDetail | null
  isLoading: boolean
  isEditing: boolean
  editDate: string; onEditDateChange: (v: string) => void
  editType: number; onEditTypeChange: (v: number) => void
  editIDModePaiement: number; onEditIDModePaiementChange: (v: number) => void
  editIDEcheance: number; onEditIDEcheanceChange: (v: number) => void
  editIDTva: number; onEditIDTvaChange: (v: number) => void
  editNumTva: string; onEditNumTvaChange: (v: string) => void
  editIDAdresse: number; onEditIDAdresseChange: (v: number) => void
}) {
  const [activeTab, setActiveTab] = useState<SidebarTab>('info')

  const { data: modesPaiement } = useQuery<ModePaiement[]>({
    queryKey: ['fac-modes-paiement'],
    queryFn: () => apiFetch('/factures/lookups/modes-paiement'),
    enabled: isEditing,
  })
  const { data: echeances } = useQuery<Echeance[]>({
    queryKey: ['fac-echeances'],
    queryFn: () => apiFetch('/factures/lookups/echeances'),
    enabled: isEditing,
  })
  const { data: tvaOptions } = useQuery<TvaOption[]>({
    queryKey: ['fac-tva'],
    queryFn: () => apiFetch('/factures/lookups/tva'),
    enabled: isEditing,
  })
  const { data: adresses } = useQuery<AdresseLookup[]>({
    queryKey: ['fac-adresses', facture?.IDclient],
    queryFn: () => apiFetch(`/factures/lookups/adresses?client=${facture?.IDclient}`),
    enabled: isEditing && !!facture?.IDclient,
  })

  if (isLoading) return (
    <div className="w-96 flex-shrink-0 bg-muted/30 rounded-xl border p-4 space-y-4">
      <div className="flex gap-2">{[1, 2].map((i) => <div key={i} className="h-8 flex-1 bg-muted animate-pulse rounded-md" />)}</div>
      {[1, 2, 3].map((i) => <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />)}
    </div>
  )
  if (!facture) return null

  const tabs: { key: SidebarTab; label: string; icon: React.ElementType }[] = [
    { key: 'info', label: 'Info', icon: Info },
    { key: 'historique', label: 'Historique', icon: History },
  ]

  return (
    <div className="w-96 flex-shrink-0 flex flex-col min-h-0">
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
              facture={facture} isEditing={isEditing}
              modesPaiement={modesPaiement ?? []} echeances={echeances ?? []} tvaOptions={tvaOptions ?? []}
              adresses={adresses ?? []}
              editDate={editDate} onEditDateChange={onEditDateChange}
              editType={editType} onEditTypeChange={onEditTypeChange}
              editIDModePaiement={editIDModePaiement} onEditIDModePaiementChange={onEditIDModePaiementChange}
              editIDEcheance={editIDEcheance} onEditIDEcheanceChange={onEditIDEcheanceChange}
              editIDTva={editIDTva} onEditIDTvaChange={onEditIDTvaChange}
              editNumTva={editNumTva} onEditNumTvaChange={onEditNumTvaChange}
              editIDAdresse={editIDAdresse} onEditIDAdresseChange={onEditIDAdresseChange}
            />
          )}
          {activeTab === 'historique' && <HistoriqueTab kind={facture.kind} factureId={facture.id} />}
        </div>
      </div>
    </div>
  )
}

// ── Sidebar Tab: Info ──────────────────────────────────

function InfoTab({
  facture, isEditing, modesPaiement, echeances, tvaOptions, adresses,
  editDate, onEditDateChange,
  editType, onEditTypeChange,
  editIDModePaiement, onEditIDModePaiementChange,
  editIDEcheance, onEditIDEcheanceChange,
  editIDTva, onEditIDTvaChange,
  editNumTva, onEditNumTvaChange,
  editIDAdresse, onEditIDAdresseChange,
}: {
  facture: FactureDetail
  isEditing: boolean
  modesPaiement: ModePaiement[]
  echeances: Echeance[]
  tvaOptions: TvaOption[]
  adresses: AdresseLookup[]
  editDate: string; onEditDateChange: (v: string) => void
  editType: number; onEditTypeChange: (v: number) => void
  editIDModePaiement: number; onEditIDModePaiementChange: (v: number) => void
  editIDEcheance: number; onEditIDEcheanceChange: (v: number) => void
  editIDTva: number; onEditIDTvaChange: (v: number) => void
  editNumTva: string; onEditNumTvaChange: (v: string) => void
  editIDAdresse: number; onEditIDAdresseChange: (v: number) => void
}) {
  const smallInput = 'h-7 px-2 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring text-right w-[150px]'
  const tvaDisplay = facture.tva_rate != null ? tvaRateLabel(facture.tva_rate) : '—'
  return (
    <div className="space-y-3">
      <div className={cn('p-3 rounded-lg border bg-card shadow-sm space-y-2', isEditing && editSectionClass)}>
        <KV label="Client" value={facture.client_nom || '—'} />
        <KV label="Type" value={isEditing ? (
          <div className="flex gap-1">
            {([{ t: 1, l: 'Facture' }, { t: 2, l: 'Avoir' }] as const).map((o) => (
              <button
                key={o.t}
                type="button"
                onClick={() => onEditTypeChange(o.t)}
                className={cn(
                  'px-2 py-1 text-xs rounded-md transition-colors border',
                  editType === o.t ? 'bg-accent text-accent-foreground border-accent shadow-sm font-medium' : 'border-input text-muted-foreground hover:bg-accent/10',
                )}
              >
                {o.l}
              </button>
            ))}
          </div>
        ) : (
          <span className={cn('px-1.5 py-0.5 rounded text-[11px] font-medium', typeChip(facture.type).classes)}>{typeChip(facture.type).label}</span>
        )} />
        <KV label="Date" value={isEditing ? (
          <input type="date" value={editDate} onChange={(e) => onEditDateChange(e.target.value)}
            className="h-7 px-2 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring text-right" />
        ) : (facture.date ? formatHfsqlDate(facture.date) : '—')} />
        <KV label="Mode paiement" value={isEditing ? (
          <PopoverSelect size="sm" options={modesPaiement.map((m) => ({ id: m.IDmode_paiement, primary: m.libelle }))}
            value={editIDModePaiement} onChange={onEditIDModePaiementChange} emptyLabel="—" />
        ) : (facture.mode_paiement_label || '—')} />
        <KV label="Échéance" value={isEditing ? (
          <PopoverSelect size="sm" options={echeances.map((e) => ({ id: e.IDecheance, primary: e.libelle }))}
            value={editIDEcheance} onChange={onEditIDEcheanceChange} emptyLabel="—" />
        ) : (facture.echeance_label || '—')} />
        {/* Computed due date (facture date + echeance rule) — server-side calc,
            so it only shows in view mode; refreshed on save. */}
        {!isEditing && facture.date_echeance && (
          <KV label="Date d'échéance" value={facture.date_echeance} />
        )}
        <KV label="TVA" value={isEditing ? (
          <PopoverSelect size="sm" options={tvaOptions.map((t) => {
            const primary = tvaRateLabel(t.valeur)
            // Drop the libellé when it just repeats the rate label (exonération).
            const secondary = t.libelle && t.libelle.trim().toLowerCase() !== primary.toLowerCase() ? t.libelle : undefined
            return { id: t.IDtva, primary, secondary }
          })}
            value={editIDTva} onChange={onEditIDTvaChange} emptyLabel="—" />
        ) : tvaDisplay} />
        <KV label="N° TVA" value={isEditing ? (
          <input type="text" value={editNumTva} onChange={(e) => onEditNumTvaChange(e.target.value)} className={smallInput} />
        ) : (facture.num_tva?.trim() || '—')} />
      </div>

      <AdresseCard
        adresse={facture.adresse_facturation}
        isEditing={isEditing}
        options={adresses}
        selectedId={editIDAdresse}
        onSelect={onEditIDAdresseChange}
      />
    </div>
  )
}

// ── Billing address card + picker ──────────────────────

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
        <p className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5"><MapPin className="h-3.5 w-3.5" />Adresse de facturation</p>
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
          <DialogTitle className="flex items-center gap-2"><MapPin className="h-5 w-5 text-accent" />Choisir une adresse de facturation</DialogTitle>
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

// ── Sidebar Tab: Historique ────────────────────────────

interface HistoriqueEvent { kind: 'email'; type_label: string; recipients: string[]; DATE: string }

function HistoriqueTab({ kind, factureId }: { kind: Kind; factureId: number }) {
  const { data, isLoading, error } = useQuery<HistoriqueEvent[]>({
    queryKey: ['facture-historique', kind, factureId],
    queryFn: () => apiFetch(`/factures/${kind}/${factureId}/historique`),
  })
  if (isLoading) return <div className="flex items-center justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-accent" /></div>
  if (error) return <div className="flex items-center gap-1.5 py-3 text-xs text-destructive"><AlertCircle className="h-3.5 w-3.5" /><span>Erreur de chargement</span></div>
  if (!data?.length) return (
    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
      <History className="h-10 w-10 mb-3 opacity-40" />
      <p className="text-sm font-medium">Aucun évènement</p>
      <p className="text-[11px] mt-1 text-center">
        {kind === 'prov' ? "Les envois de proformas ne sont pas historisés." : "Les envois d'emails liés à ce document apparaîtront ici."}
      </p>
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

// ── Create Dialog ──────────────────────────────────────

function CreateFactureDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (newId: number, kind: Kind) => void }) {
  const [kind, setKind] = useState<Kind>('prov')
  const [clientId, setClientId] = useState(0)
  const [type, setType] = useState(1)
  const [date, setDate] = useState<string>(() => new Date().toISOString().slice(0, 10))
  const [error, setError] = useState<string | null>(null)

  const { data: clients } = useQuery<ClientLite[]>({ queryKey: ['fac-clients'], queryFn: () => apiFetch('/factures/lookups/clients'), enabled: open })

  useEffect(() => {
    if (!open) { setKind('prov'); setClientId(0); setType(1); setDate(new Date().toISOString().slice(0, 10)); setError(null) }
  }, [open])

  const createMut = useMutation({
    mutationFn: () => apiFetch(`/factures/${kind}`, {
      method: 'POST',
      body: JSON.stringify({ IDclient: clientId, type, date: inputDateToHfsql(date) }),
    }),
    onSuccess: (data: { id: number; kind: Kind }) => onCreated(data.id, data.kind),
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Erreur'),
  })

  const canSave = clientId > 0 && date.length > 0

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Receipt className="h-5 w-5 text-accent" />Nouveau document</DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Document</label>
            <div className="flex gap-1">
              {([
                { k: 'prov', l: 'Proforma' },
                { k: 'def', l: 'Facture définitive' },
              ] as const).map((o) => (
                <button
                  key={o.k}
                  type="button"
                  onClick={() => setKind(o.k)}
                  className={cn(
                    'flex-1 px-2 py-1.5 text-xs rounded-md transition-colors border',
                    kind === o.k ? 'bg-accent text-accent-foreground border-accent shadow-sm font-medium' : 'border-input text-muted-foreground hover:bg-accent/10',
                  )}
                >
                  {o.l}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">
              {kind === 'prov'
                ? 'Un proforma reste modifiable jusqu’à sa conversion en facture.'
                : 'Une facture définitive est verrouillée dès sa création et reçoit un numéro officiel.'}
            </p>
          </div>
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
              <label className="text-xs font-medium text-muted-foreground">Type</label>
              <div className="flex gap-1">
                {([{ t: 1, l: 'Facture' }, { t: 2, l: 'Avoir' }] as const).map((o) => (
                  <button
                    key={o.t}
                    type="button"
                    onClick={() => setType(o.t)}
                    className={cn(
                      'flex-1 px-2 py-1.5 text-xs rounded-md transition-colors border',
                      type === o.t ? 'bg-accent text-accent-foreground border-accent shadow-sm font-medium' : 'border-input text-muted-foreground hover:bg-accent/10',
                    )}
                  >
                    {o.l}
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Date</label>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={cn(inputClass, 'h-9')} />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Le mode de paiement, l'échéance, la TVA et l'adresse de facturation seront pré-remplis depuis la fiche client.
          </p>
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

// ── Shared components ──────────────────────────────────

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm text-right truncate">{value}</span>
    </div>
  )
}
