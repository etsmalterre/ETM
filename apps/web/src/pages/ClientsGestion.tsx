import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { UnsavedChangesDialog } from '@/components/shared/UnsavedChangesDialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useUnsavedGuard } from '@/hooks/useUnsavedGuard'
import {
  Users,
  Search,
  Loader2,
  AlertCircle,
  Check,
  MapPin,
  Mail,
  User,
  Star,
  Pencil,
  Plus,
  X,
  Save,
  Trash2,
  FileText,
  Phone,
  Printer,
  AtSign,
  Receipt,
  Briefcase,
  CalendarClock,
  Palette,
  BadgeEuro,
  Percent,
  FileSignature,
  Tag,
  History,
  Truck,
  Send,
  Archive,
  ArchiveRestore,
  ArrowUp,
  ArrowDown,
  Link2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { PopoverSelect, SearchableCombobox } from '@/components/ui/popover-select'
import { MasterDetailLayout } from '@/components/layout/MasterDetailLayout'
import { useAutoSelectFirst } from '@/hooks/useAutoSelectFirst'
import { SendEmailDialog } from '@/components/email/SendEmailDialog'
import { postEmail } from '@/lib/email'
import { cn } from '@/lib/utils'
import { hfsqlDateToInput, inputDateToHfsql, formatHfsqlDate } from '@/lib/dates'
import { fmtNum } from '@/lib/format'
import { apiFetch, API_URL } from '@/lib/api'
import { invalidateStockCaches } from '@/lib/cache-sync'
import { compteError, normalizeCompte } from '@/lib/compte-client'
import { useHasPermission } from '@/contexts/PermissionsContext'

/** POST/PUT helper that surfaces the API's French `message` field — `apiFetch`
 *  only reports the status code, and the compte-client conflicts (409
 *  `compte_duplique`, 400 `compte_invalide`) need to be readable by the user.
 *  Same raw-fetch approach as `postEmail` in lib/email.ts. */
async function apiSend<T = any>(path: string, options: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) {
    const err: Error & { status?: number } = new Error(
      json?.message || json?.error || `Erreur HTTP ${res.status}`,
    )
    err.status = res.status
    throw err
  }
  return json as T
}

// ── Types ──────────────────────────────────────────────

interface ClientListRow {
  IDclient: number
  nom: string | null
  tel: string | null
  client_interne: number
  archive: number
}

interface Contact {
  IDcontact: number
  nom: string | null
  prenom: string | null
  tel: string | null
  mail: string | null
  commentaire: string | null
  est_defaut: boolean
  envoi_bl: boolean
  envoi_facture: boolean
  envoi_commande: boolean
  envoi_soumission: boolean
}

interface Adresse {
  IDadresse: number
  nom: string | null
  adresse1: string | null
  adresse2: string | null
  adresse3: string | null
  cp: string | null
  ville: string | null
  pays: string | null
  commentaire: string | null
  est_defaut: boolean
  est_defaut_facturation: boolean
  est_defaut_livraison: boolean
}

interface ClientDetail {
  IDclient: number
  nom: string | null
  tel: string | null
  fax: string | null
  num_tva: string | null
  compte: string | null
  commentaire: string | null
  journal_commercial: string | null
  pct_remise: number
  pct_ajeol: number
  IDtva: number
  IDmode_paiement: number
  IDecheance: number
  IDcode_comptable: number
  IDsecteur_activite: number
  IDactivite: number
  client_interne: number
  inclureRapportQualite: number
  dernier_contact: string | null
  date_creation: string | null
  archive: number
  adresses: Adresse[]
  contacts: Contact[]
}

interface LookupLabel { id: number; label: string }

// ── API hooks ──────────────────────────────────────────

function useClients() {
  return useQuery<ClientListRow[]>({ queryKey: ['clients'], queryFn: () => apiFetch('/clients') })
}
function useClientDetail(id: number | null) {
  return useQuery<ClientDetail>({ queryKey: ['client', id], queryFn: () => apiFetch(`/clients/${id}`), enabled: id !== null })
}

function useLookup(path: string, key: string, map: (r: any) => LookupLabel) {
  const { data } = useQuery<any[]>({ queryKey: ['client-lookup', key], queryFn: () => apiFetch(`/clients/lookups/${path}`), staleTime: 5 * 60_000 })
  return useMemo(() => (data ?? []).map(map), [data, map])
}

/** Every compte client already in use, so a duplicate is flagged while the user
 *  types rather than only when the write comes back rejected. The API re-checks
 *  on save — this set can go stale if someone else creates a client meanwhile. */
function useComptesPris() {
  const { data, isLoading } = useQuery<{ comptes: string[] }>({
    queryKey: ['client-comptes'],
    queryFn: () => apiFetch('/clients/comptes'),
    staleTime: 30_000,
  })
  const taken = useMemo(() => new Set(data?.comptes ?? []), [data])
  return { taken, isLoading }
}

// ── Shared styling ─────────────────────────────────────

const inputClass = 'w-full h-8 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring'
const editSectionClass = 'border-l-4 border-l-accent/70 bg-accent/[0.03]'

// ── Edit draft ─────────────────────────────────────────

interface Draft {
  nom: string
  tel: string
  fax: string
  num_tva: string
  compte: string
  commentaire: string
  journal_commercial: string
  pct_remise: string
  pct_ajeol: string
  IDtva: number
  IDmode_paiement: number
  IDecheance: number
  IDcode_comptable: number
  IDsecteur_activite: number
  IDactivite: number
  client_interne: boolean
  inclureRapportQualite: boolean
  dernier_contact: string // YYYY-MM-DD for <input type=date>
}

function draftFromDetail(d: ClientDetail): Draft {
  return {
    nom: d.nom ?? '',
    tel: d.tel ?? '',
    fax: d.fax ?? '',
    num_tva: d.num_tva ?? '',
    compte: d.compte ?? '',
    commentaire: d.commentaire ?? '',
    journal_commercial: d.journal_commercial ?? '',
    pct_remise: d.pct_remise ? String(d.pct_remise) : '',
    pct_ajeol: d.pct_ajeol ? String(d.pct_ajeol) : '',
    IDtva: d.IDtva ?? 0,
    IDmode_paiement: d.IDmode_paiement ?? 0,
    IDecheance: d.IDecheance ?? 0,
    IDcode_comptable: d.IDcode_comptable ?? 0,
    IDsecteur_activite: d.IDsecteur_activite ?? 0,
    IDactivite: d.IDactivite ?? 0,
    client_interne: !!d.client_interne,
    inclureRapportQualite: !!d.inclureRapportQualite,
    dernier_contact: hfsqlDateToInput(d.dernier_contact),
  }
}

function draftToBody(d: Draft) {
  return {
    nom: d.nom.trim() || 'Client',
    tel: d.tel,
    fax: d.fax,
    num_tva: d.num_tva,
    compte: d.compte,
    commentaire: d.commentaire,
    journal_commercial: d.journal_commercial,
    pct_remise: Number(d.pct_remise.replace(',', '.')) || 0,
    pct_ajeol: Number(d.pct_ajeol.replace(',', '.')) || 0,
    IDtva: d.IDtva,
    IDmode_paiement: d.IDmode_paiement,
    IDecheance: d.IDecheance,
    IDcode_comptable: d.IDcode_comptable,
    IDsecteur_activite: d.IDsecteur_activite,
    IDactivite: d.IDactivite,
    client_interne: d.client_interne,
    inclureRapportQualite: d.inclureRapportQualite,
    dernier_contact: inputDateToHfsql(d.dernier_contact),
  }
}

// ── Main Page ──────────────────────────────────────────

type ArchiveFilter = 'encours' | 'archive' | 'tous'

export function ClientsGestion() {
  const queryClient = useQueryClient()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [archiveFilter, setArchiveFilter] = useState<ArchiveFilter>('encours')
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [subFormsDirty, setSubFormsDirty] = useState(false)
  const [autoEditForId, setAutoEditForId] = useState<number | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  // Non-null while a save is refused because the compte client is empty or
  // malformed — holds the French explanation shown in the blocking alert.
  const [saveBlockedReason, setSaveBlockedReason] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  // Tarifs selector modal — opened by both the Print and Email header buttons;
  // the mode drives its title and which footer action is primary.
  const [tarifsSelector, setTarifsSelector] = useState<'print' | 'email' | null>(null)
  // Non-null while the tarifs SendEmailDialog is open — holds the selected
  // ref_client_colori ids so the PDF preview/attachment matches the selection.
  const [tarifsEmailItems, setTarifsEmailItems] = useState<number[] | null>(null)

  const originalDraftRef = useRef<Draft | null>(null)

  const { data: clients, isLoading, isError, error } = useClients()
  const { data: detail, isLoading: detailLoading } = useClientDetail(selectedId)

  // Deletability is fetched as soon as edit mode opens so the header can show
  // the right icon upfront (bin = deletable, archive = has commandes /
  // marchandise) instead of explaining after the click. Same query key as the
  // confirm dialog, so the dialog reads it from cache.
  const canDelete = useHasPermission('delete_client')
  const canManageTarifs = useHasPermission('gestion_tarifs')
  const canManageRefs = useHasPermission('gestion_references')
  // Narrow permission: add a coloris to an existing ref without the (broader)
  // références / tarifs rights. Redundant when canManageRefs is granted.
  const canManageColoris = useHasPermission('gestion_coloris')
  const canRetourMarchandise = useHasPermission('retour_marchandise')
  // Sidebar tab scopes — each grants edit rights on one tab only. The lone
  // "Inclure rapports contrôle" toggle is separate from the rest of the Info
  // tab so it can be granted on its own.
  const canEditInfo = useHasPermission('edit_client_info')
  const canEditRapportQualite = useHasPermission('edit_client_rapport_qualite')
  const canEditCommercial = useHasPermission('edit_client_commercial')
  const canCrudContacts = useHasPermission('crud_client_contacts')
  const canCrudAdresses = useHasPermission('crud_client_adresses')
  const { data: deletability } = useQuery<Deletability>({
    queryKey: ['client-deletability', selectedId],
    queryFn: () => apiFetch(`/clients/${selectedId}/deletability`),
    enabled: canDelete && isEditing && selectedId !== null,
  })

  // Lookups (shared across edit + view-mode label resolution)
  const secteurs = useLookup('secteurs', 'secteurs', (r) => ({ id: r.IDsecteur_activite, label: r.nom }))
  const activites = useLookup('activites', 'activites', (r) => ({ id: r.IDactivite, label: r.nom }))
  const modesPaiement = useLookup('modes-paiement', 'modes-paiement', (r) => ({ id: r.IDmode_paiement, label: r.libelle }))
  const echeances = useLookup('echeances', 'echeances', (r) => ({ id: r.IDecheance, label: r.libelle }))
  const tvas = useLookup('tva', 'tva', (r) => ({ id: r.IDtva, label: r.libelle }))
  const codesComptables = useLookup('codes-comptables', 'codes-comptables', (r) => ({ id: r.IDcode_comptable, label: r.libelle }))
  const { taken: comptesPris } = useComptesPris()

  const filtered = useMemo(() => {
    if (!clients) return []
    const q = searchQuery.trim().toLowerCase()
    return clients.filter((c) => {
      if (archiveFilter === 'encours' && c.archive) return false
      if (archiveFilter === 'archive' && !c.archive) return false
      if (q && !(c.nom ?? '').toLowerCase().includes(q)) return false
      return true
    })
  }, [clients, searchQuery, archiveFilter])

  // Keep selection valid against the (search/filter-narrowed) list.
  useAutoSelectFirst({
    rows: filtered,
    selectedId,
    getId: (c) => c.IDclient,
    select: setSelectedId,
    suspended: isEditing,
  })

  const startEdit = useCallback(() => {
    if (!detail) return
    const snap = draftFromDetail(detail)
    setDraft(snap)
    originalDraftRef.current = snap
    setIsEditing(true)
    // Rows predating the mandatory compte have an empty one, and a handful of
    // legacy rows hold a malformed value ("411", "9999"…). Either way, pull a
    // suggestion straight away so the user is handed a fix instead of just
    // being stopped by a validation error on a field they never touched.
    // The snapshot is updated too, so the pre-fill alone doesn't make the form
    // look dirty — leaving without saving still changes nothing.
    const nom = (detail.nom ?? '').trim()
    if (canEditInfo && nom && compteError(detail.compte) !== null) {
      apiFetch<{ compte: string }>(`/clients/compte-suggestion?nom=${encodeURIComponent(nom)}&exclude=${detail.IDclient}`)
        .then(({ compte }) => {
          // Only apply if the user hasn't already typed a valid one meanwhile.
          setDraft((d) => (d && compteError(d.compte) !== null ? { ...d, compte } : d))
          if (originalDraftRef.current && compteError(originalDraftRef.current.compte) !== null) {
            originalDraftRef.current = { ...originalDraftRef.current, compte }
          }
        })
        .catch(() => { /* the user can still type one — validation will ask */ })
    }
  }, [detail, canEditInfo])

  const cancelEdit = useCallback(() => {
    setIsEditing(false)
    setDraft(null)
    setSaveError(null)
  }, [])

  const isDirty = useMemo(() => {
    if (!isEditing || !draft) return false
    if (subFormsDirty) return true
    return JSON.stringify(draft) !== JSON.stringify(originalDraftRef.current)
  }, [isEditing, draft, subFormsDirty])

  const invalidateAll = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['clients'] })
    queryClient.invalidateQueries({ queryKey: ['client', selectedId] })
    // A save may have changed a compte — refresh the set the live duplicate
    // check reads from.
    queryClient.invalidateQueries({ queryKey: ['client-comptes'] })
  }, [queryClient, selectedId])

  const saveMutation = useMutation({
    mutationFn: () => apiSend(`/clients/${selectedId}`, { method: 'PUT', body: JSON.stringify(draftToBody(draft!)) }),
    onSuccess: () => { invalidateAll(); setIsEditing(false); setDraft(null); setSaveError(null) },
    onError: (e: Error) => setSaveError(e.message),
  })

  // The compte client is mandatory, format-checked (411 + 3 alphanumerics) and
  // unique. Only the Info scope writes it, so a user without that permission is
  // never held responsible for a field they cannot edit.
  const compteIssue = useMemo(
    () => (isEditing && canEditInfo && draft
      ? compteError(draft.compte, { taken: comptesPris, ownCompte: detail?.compte })
      : null),
    [isEditing, canEditInfo, draft, comptesPris, detail?.compte],
  )

  const attemptSave = useCallback(() => {
    if (compteIssue) { setSaveBlockedReason(compteIssue); return }
    saveMutation.mutate()
  }, [compteIssue, saveMutation])

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/clients/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, deletedId) => {
      const cached = queryClient.getQueryData<ClientListRow[]>(['clients']) ?? []
      const remaining = cached.filter((c) => c.IDclient !== deletedId)
      queryClient.invalidateQueries({ queryKey: ['clients'] })
      setIsEditing(false)
      setDraft(null)
      setDeleteConfirm(false)
      setSelectedId(remaining.length > 0 ? remaining[0].IDclient : null)
    },
  })

  // Archive keeps the row (it just moves to the « Archivés » filter) — the
  // keep-selection-valid effect re-targets the list if it drops out of view.
  const archiveMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/clients/${id}/archive`, { method: 'POST' }),
    onSuccess: () => {
      invalidateAll()
      setIsEditing(false)
      setDraft(null)
      setDeleteConfirm(false)
    },
  })

  const unarchiveMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/clients/${id}/unarchive`, { method: 'POST' }),
    onSuccess: invalidateAll,
  })

  // Auto-enter edit mode once the freshly-created client's detail loads.
  useEffect(() => {
    if (autoEditForId !== null && detail?.IDclient === autoEditForId) {
      startEdit()
      setAutoEditForId(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEditForId, detail])

  const guard = useUnsavedGuard({
    isDirty,
    save: async () => { await saveMutation.mutateAsync() },
    onDiscard: () => { setIsEditing(false); setDraft(null); setSaveError(null) },
    // Leaving edit mode with an invalid compte would let the client be saved
    // (via the guard's « Enregistrer ») without one. Block the exit and
    // explain instead; « Annuler » is still a way out, it just discards.
    shouldBlockExit: compteIssue !== null,
    onExitBlocked: () => setSaveBlockedReason(compteIssue),
  })

  const handleSelect = useCallback((id: number) => {
    guard.guardAction(() => { setIsEditing(false); setDraft(null); setSelectedId(id) })
  }, [guard])

  const patch = useCallback((p: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...p } : d)), [])

  return (
    <>
      <MasterDetailLayout
        list={<ClientList clients={filtered} total={clients?.length ?? 0} isLoading={isLoading} isError={isError} error={error as Error | null}
          selectedId={selectedId} onSelect={handleSelect} searchQuery={searchQuery} onSearchChange={setSearchQuery}
          archiveFilter={archiveFilter} onArchiveFilterChange={setArchiveFilter}
          onNew={() => setCreateOpen(true)} isEditing={isEditing} />}
        detailHeader={<DetailHeader client={detail ?? null} isLoading={detailLoading && selectedId !== null}
          isEditing={isEditing} draft={draft} onPatch={patch}
          onStartEdit={startEdit} onCancelEdit={cancelEdit} onSave={attemptSave} isSaving={saveMutation.isPending}
          canDelete={canDelete} deletable={deletability?.deletable}
          onDelete={() => setDeleteConfirm(true)}
          onUnarchive={() => { if (selectedId !== null) unarchiveMutation.mutate(selectedId) }}
          isUnarchiving={unarchiveMutation.isPending}
          onPrint={() => setTarifsSelector('print')} onEmail={() => setTarifsSelector('email')} />}
        detail={<DetailMain client={detail ?? null} isLoading={detailLoading && selectedId !== null}
          hasSelection={selectedId !== null} isEditing={isEditing} canManageTarifs={canManageTarifs}
          canManageRefs={canManageRefs} canManageColoris={canManageColoris}
          canRetourMarchandise={canRetourMarchandise} />}
        sidebar={selectedId !== null ? <DetailSidebar client={detail ?? null} isLoading={detailLoading}
          isEditing={isEditing} clientId={selectedId} onMutationSuccess={invalidateAll}
          onSubFormsDirtyChange={setSubFormsDirty} draft={draft} onPatch={patch}
          canEditInfo={canEditInfo} canEditRapportQualite={canEditRapportQualite} canEditCommercial={canEditCommercial}
          canCrudContacts={canCrudContacts} canCrudAdresses={canCrudAdresses}
          secteurs={secteurs} activites={activites} modesPaiement={modesPaiement} echeances={echeances} tvas={tvas} codesComptables={codesComptables} /> : null}
        sidebarTitle="Contacts & Adresses" hasSelection={selectedId !== null}
        onBack={() => guard.guardAction(() => { setIsEditing(false); setDraft(null); setSelectedId(null) })}
      />
      <UnsavedChangesDialog open={guard.showDialog} onAction={guard.handleAction} isSaving={guard.isSaving} />
      <CreateClientDialog
        open={createOpen}
        secteurs={secteurs}
        activites={activites}
        onClose={() => setCreateOpen(false)}
        onCreated={(newId) => {
          setCreateOpen(false)
          queryClient.invalidateQueries({ queryKey: ['clients'] })
          queryClient.invalidateQueries({ queryKey: ['client-comptes'] })
          setArchiveFilter('encours')
          setSelectedId(newId)
          setAutoEditForId(newId)
        }}
      />
      <AlertDialog open={saveBlockedReason !== null} onOpenChange={(o) => { if (!o) setSaveBlockedReason(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-destructive" />
              Compte client requis
            </AlertDialogTitle>
            <AlertDialogDescription>
              {saveBlockedReason} Il figure dans l'onglet Info, rubrique Facturation.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:gap-2 mt-4">
            <Button onClick={() => setSaveBlockedReason(null)}>OK</Button>
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
      <DeleteOrArchiveDialog
        open={deleteConfirm}
        clientId={selectedId}
        isDeleting={deleteMutation.isPending}
        isArchiving={archiveMutation.isPending}
        onCancel={() => setDeleteConfirm(false)}
        onDelete={() => { if (selectedId !== null) deleteMutation.mutate(selectedId) }}
        onArchive={() => { if (selectedId !== null) archiveMutation.mutate(selectedId) }}
      />
      {selectedId !== null && (
        <TarifsSelectionDialog
          open={tarifsSelector !== null}
          mode={tarifsSelector ?? 'print'}
          clientId={selectedId}
          onClose={() => setTarifsSelector(null)}
          onEmail={(items) => { setTarifsSelector(null); setTarifsEmailItems(items) }}
        />
      )}
      {selectedId !== null && (
        <SendEmailDialog
          open={tarifsEmailItems !== null}
          onClose={() => setTarifsEmailItems(null)}
          contextLabel={detail?.nom ?? undefined}
          queryKey={['client-tarifs-email-defaults', selectedId]}
          loadDefaults={() => apiFetch(`/clients/${selectedId}/tarifs/email-defaults`)}
          pdfUrl={tarifsEmailItems !== null ? `${API_URL}/clients/${selectedId}/tarifs/pdf?items=${tarifsEmailItems.join(',')}` : undefined}
          pdfAttachmentLabel="fiche-tarifs.pdf"
          onSend={(p) => postEmail(`${API_URL}/clients/${selectedId}/tarifs/email?items=${(tarifsEmailItems ?? []).join(',')}`, p, { includeAttachPdf: true })}
        />
      )}
    </>
  )
}

// ── Delete-or-archive confirm flow ─────────────────────
// A client with commandes or marchandise can never be hard-deleted. The header
// button already shows the matching icon (bin vs archive box) from the shared
// deletability query, so this dialog goes straight to the right confirm — no
// "deletion impossible" explanation. The API enforces the same rule
// server-side (409 client_has_activity).

interface Deletability { commandes: number; marchandises: number; deletable: boolean }

function DeleteOrArchiveDialog({ open, clientId, isDeleting, isArchiving, onCancel, onDelete, onArchive }: {
  open: boolean; clientId: number | null; isDeleting: boolean; isArchiving: boolean
  onCancel: () => void; onDelete: () => void; onArchive: () => void
}) {
  // Same query key as the page-level fetch — resolved from cache instantly.
  const { data } = useQuery<Deletability>({
    queryKey: ['client-deletability', clientId],
    queryFn: () => apiFetch(`/clients/${clientId}/deletability`),
    enabled: open && clientId !== null,
  })
  const checking = !data
  const deletable = data?.deletable ?? false
  const archiveMode = !checking && !deletable

  return (
    <ConfirmDialog
      open={open}
      title={archiveMode ? 'Archiver le client' : 'Supprimer le client'}
      description={archiveMode
        ? 'Le client n’apparaîtra plus dans la liste « En cours ». Vous pourrez le désarchiver à tout moment.'
        : 'Cette action supprimera le client, ses contacts et ses adresses. Elle est irréversible.'}
      variant={archiveMode ? 'default' : 'destructive'}
      confirmLabel={archiveMode ? 'Archiver' : 'Supprimer'}
      isPending={checking || isDeleting || isArchiving}
      onCancel={onCancel}
      onConfirm={() => { if (checking) return; if (deletable) onDelete(); else onArchive() }}
    />
  )
}

// ── Tarifs: sélection réfs × coloris → PDF / email ─────
// Port of the legacy Choix_Matiere_Tarif modal: pick the (référence, coloris)
// pairs to include in the Fiche Tarifs, then print the PDF or email it.
// Opened by both the Print and Email header buttons — `mode` only changes the
// title and which footer action is the primary one; the email path hands the
// selection to the standard SendEmailDialog with the PDF attached.

interface TarifRow {
  rccId: number
  ref: string
  refInterne: string
  coloris: string
  priceable: boolean
  expired: boolean
}

function TarifsSelectionDialog({ open, mode, clientId, onClose, onEmail }: {
  open: boolean; mode: 'print' | 'email'; clientId: number; onClose: () => void; onEmail: (items: number[]) => void
}) {
  const { data, isLoading } = useQuery<ClientReference[]>({
    queryKey: ['client-references', clientId],
    queryFn: () => apiFetch(`/clients/${clientId}/references`),
    enabled: open,
  })
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [search, setSearch] = useState('')

  // Fresh selection each time the dialog opens (or the client changes).
  useEffect(() => { setSelected(new Set()); setSearch('') }, [open, clientId])

  const rows = useMemo<TarifRow[]>(() => {
    if (!data) return []
    const out: TarifRow[] = []
    for (const r of data) {
      for (const c of r.coloris) {
        out.push({
          rccId: c.IDref_client_colori,
          ref: r.client_ref,
          refInterne: r.ref_interne,
          coloris: c.label,
          // Only fini references with a real coloris have a PrixDeVente tarif,
          // and an expired contract makes the ref unavailable (no fallback).
          priceable: r.IDref_fini > 0 && c.coloris_id > 0 && !c.contrat_expire,
          expired: c.contrat_expire,
        })
      }
    }
    return out
  }, [data])

  // Accent-insensitive filter on ref client / ref interne / coloris, so typing
  // the ref name jumps straight to it instead of scrolling the coloris list.
  const visibleRows = useMemo(() => {
    const q = normSearch(search.trim())
    if (!q) return rows
    return rows.filter((r) => normSearch(`${r.ref} ${r.refInterne} ${r.coloris}`).includes(q))
  }, [rows, search])

  const visiblePriceableIds = useMemo(() => visibleRows.filter((r) => r.priceable).map((r) => r.rccId), [visibleRows])

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const items = [...selected]
  const pdfUrl = `${API_URL}/clients/${clientId}/tarifs/pdf?items=${items.join(',')}`

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-2xl" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {mode === 'email'
              ? <><AtSign className="h-5 w-5 text-accent" />Envoyer les tarifs par email</>
              : <><Printer className="h-5 w-5 text-accent" />Imprimer les tarifs</>}
          </DialogTitle>
        </DialogHeader>

        <div className="mt-4">
          {isLoading ? (
            <div className="flex items-center justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
              <Tag className="h-12 w-12 mb-3 opacity-40" />
              <p className="text-sm">Aucune référence pour ce client</p>
            </div>
          ) : (
            <div className="space-y-2">
              {/* Type-to-filter: the coloris list gets long, let the user jump to a ref. */}
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Rechercher une référence ou un coloris..."
                  autoFocus
                  autoComplete="off"
                  className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div className="rounded-lg border border-border/60 overflow-hidden">
              {/* Header strip + Tous/Aucun (scoped to the filtered rows) */}
              <div className="flex items-center gap-2 px-3 py-2 bg-zinc-200/50 border-b border-border/60 text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                <span className="w-4" />
                <span className="w-24">Ref client</span>
                <span className="w-24">Ref interne</span>
                <span className="flex-1">Coloris</span>
                <button type="button" onClick={() => setSelected((prev) => new Set([...prev, ...visiblePriceableIds]))}
                  className="normal-case tracking-normal text-xs font-medium text-accent hover:bg-accent/10 rounded px-1.5 py-0.5 transition-colors">
                  Tous
                </button>
                <button type="button" onClick={() => setSelected((prev) => { const next = new Set(prev); for (const r of visibleRows) next.delete(r.rccId); return next })}
                  className="normal-case tracking-normal text-xs font-medium text-muted-foreground hover:bg-accent/10 rounded px-1.5 py-0.5 transition-colors">
                  Aucun
                </button>
              </div>
              <div className="max-h-[45vh] overflow-y-auto scrollbar-transparent">
                {visibleRows.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
                    <Search className="h-8 w-8 mb-2 opacity-40" />
                    <p className="text-sm">Aucune référence ne correspond à « {search.trim()} »</p>
                  </div>
                ) : visibleRows.map((r) => (
                  <label
                    key={r.rccId}
                    title={r.priceable ? undefined : r.expired ? 'Contrat expiré — référence indisponible jusqu’à l’établissement d’un nouveau contrat' : 'Tarif indisponible pour cette référence'}
                    className={cn(
                      'flex items-center gap-2 px-3 py-2 border-b border-border/40 last:border-b-0 text-sm transition-colors',
                      r.priceable ? 'cursor-pointer hover:bg-accent/5' : 'opacity-50 cursor-not-allowed',
                      selected.has(r.rccId) && 'bg-accent/10',
                    )}
                  >
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-input text-accent focus:ring-2 focus:ring-ring cursor-pointer disabled:cursor-not-allowed"
                      checked={selected.has(r.rccId)}
                      disabled={!r.priceable}
                      onChange={() => toggle(r.rccId)}
                    />
                    <span className="w-24 font-medium truncate">{r.ref || '—'}</span>
                    <span className="w-24 text-muted-foreground truncate">{r.refInterne || '—'}</span>
                    <span className="flex-1 truncate flex items-center gap-1.5">
                      <Palette className="h-3 w-3 text-muted-foreground/60 flex-shrink-0" />
                      {r.coloris || '—'}
                      {r.expired && <span className="text-[9px] font-semibold px-1 rounded bg-red-500/10 text-red-700 border border-red-500/25 flex-shrink-0">Contrat expiré</span>}
                    </span>
                  </label>
                ))}
              </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="mt-4">
          <span className="text-xs text-muted-foreground mr-auto self-center">
            {selected.size} coloris sélectionné{selected.size > 1 ? 's' : ''}
          </span>
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          {mode === 'email' ? (
            <Button disabled={selected.size === 0} onClick={() => onEmail(items)}>
              <AtSign className="h-3.5 w-3.5 mr-1.5" />Envoyer par email
            </Button>
          ) : (
            <>
              <Button variant="outline" disabled={selected.size === 0} onClick={() => onEmail(items)}>
                <AtSign className="h-3.5 w-3.5 mr-1.5" />Envoyer par email
              </Button>
              <Button disabled={selected.size === 0} onClick={() => { window.open(pdfUrl, '_blank'); onClose() }}>
                <Printer className="h-3.5 w-3.5 mr-1.5" />Imprimer
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Left Panel: List ───────────────────────────────────

const ARCHIVE_FILTERS: { key: ArchiveFilter; label: string }[] = [
  { key: 'encours', label: 'En cours' },
  { key: 'archive', label: 'Archivés' },
  { key: 'tous', label: 'Tous' },
]

function ClientList({ clients, total, isLoading, isError, error, selectedId, onSelect, searchQuery, onSearchChange, archiveFilter, onArchiveFilterChange, onNew, isEditing }: {
  clients: ClientListRow[]; total: number; isLoading: boolean; isError: boolean; error: Error | null
  selectedId: number | null; onSelect: (id: number) => void; searchQuery: string; onSearchChange: (q: string) => void
  archiveFilter: ArchiveFilter; onArchiveFilterChange: (f: ArchiveFilter) => void
  onNew: () => void; isEditing: boolean
}) {
  return (
    <div className="flex flex-col h-full rounded-lg border shadow-sm bg-zinc-100/80">
      <div className="p-3 border-b rounded-t-lg bg-zinc-200/50 space-y-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input type="text" placeholder="Rechercher..." value={searchQuery} onChange={(e) => onSearchChange(e.target.value)}
            autoComplete="off" className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
        <div className="flex flex-wrap gap-1">
          {ARCHIVE_FILTERS.map((opt) => (
            <button key={opt.key} type="button" onClick={() => onArchiveFilterChange(opt.key)}
              className={cn('px-2 py-1 text-xs rounded-md transition-colors flex-grow basis-[calc(33.333%-0.25rem)]',
                archiveFilter === opt.key ? 'bg-accent text-accent-foreground shadow-sm font-medium' : 'text-muted-foreground hover:bg-accent/10')}>
              {opt.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-auto p-3 space-y-2 scrollbar-transparent">
        {isLoading ? <div className="flex items-center justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-accent" /></div>
        : isError ? <div className="flex flex-col items-center justify-center py-8 text-destructive"><AlertCircle className="h-6 w-6 mb-2" /><p className="text-sm">{error?.message || 'Erreur'}</p></div>
        : clients.length === 0 ? <div className="flex flex-col items-center justify-center py-8 text-muted-foreground"><Users className="h-12 w-12 mb-3 opacity-50" /><p className="text-sm">Aucun client</p></div>
        : clients.map((c) => (
          <div key={c.IDclient} onClick={() => onSelect(c.IDclient)}
            className={cn('p-3 border rounded-lg cursor-pointer transition-all',
              selectedId === c.IDclient ? 'border-accent bg-white ring-1 ring-accent' : 'border-border bg-white hover:border-accent/50')}>
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <p className="font-medium text-sm truncate flex-1">{c.nom || '—'}</p>
              {!!c.client_interne && <Badge variant="secondary" className="text-[10px] py-0 flex-shrink-0">Interne</Badge>}
            </div>
          </div>
        ))}
      </div>
      <div className="p-3 border-t text-xs text-muted-foreground flex items-center justify-between rounded-b-lg bg-zinc-200/50">
        <span>{clients.length} / {total} client{total !== 1 ? 's' : ''}</span>
        {!isEditing && (
          <Button size="sm" variant="ghost" onClick={onNew} className="text-accent hover:text-accent hover:bg-accent/10">
            <Plus className="h-3.5 w-3.5 mr-1" />Nouveau
          </Button>
        )}
      </div>
    </div>
  )
}

// ── "Nouveau client" dialog ────────────────────────────
//
// Asks for the identity fields up front instead of dropping a "Nouveau client"
// placeholder row (the old flow left 3 of those in the table). Knowing the name
// before the INSERT is also what lets the compte client be derived from it.

function CreateClientDialog({ open, secteurs, activites, onClose, onCreated }: {
  open: boolean
  secteurs: LookupLabel[]
  activites: LookupLabel[]
  onClose: () => void
  onCreated: (id: number) => void
}) {
  const [nom, setNom] = useState('')
  const [IDsecteur, setIDsecteur] = useState(0)
  const [IDactivite, setIDactivite] = useState(0)
  const [compte, setCompte] = useState('')
  /** True once the user edits the compte by hand — stops the name-driven
   *  suggestion from overwriting their choice on the next keystroke. */
  const [compteTouched, setCompteTouched] = useState(false)
  const [suggesting, setSuggesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { taken, isLoading: takenLoading } = useComptesPris()

  // Reset every time the dialog opens.
  useEffect(() => {
    if (!open) return
    setNom(''); setIDsecteur(0); setIDactivite(0)
    setCompte(''); setCompteTouched(false); setError(null)
  }, [open])

  // Debounced suggestion: the code is derived from the name, so it follows
  // whatever the user types until they take the field over.
  const trimmedNom = nom.trim()
  useEffect(() => {
    if (!open || compteTouched || !trimmedNom) {
      if (!trimmedNom && !compteTouched) setCompte('')
      return
    }
    let cancelled = false
    setSuggesting(true)
    const t = setTimeout(() => {
      apiFetch<{ compte: string }>(`/clients/compte-suggestion?nom=${encodeURIComponent(trimmedNom)}`)
        .then(({ compte: c }) => { if (!cancelled) setCompte(c) })
        .catch(() => { /* the field stays editable; validation will ask */ })
        .finally(() => { if (!cancelled) setSuggesting(false) })
    }, 350)
    return () => { cancelled = true; clearTimeout(t); setSuggesting(false) }
  }, [open, trimmedNom, compteTouched])

  const compteIssue = compteError(compte, { taken })
  const canSubmit = trimmedNom.length > 0 && compteIssue === null && !suggesting && !takenLoading

  const createMut = useMutation({
    mutationFn: () => apiSend<{ IDclient: number }>('/clients', {
      method: 'POST',
      body: JSON.stringify({
        nom: trimmedNom,
        IDsecteur_activite: IDsecteur,
        IDactivite: IDactivite,
        compte: normalizeCompte(compte),
      }),
    }),
    onSuccess: (data) => onCreated(data.IDclient),
    onError: (e: Error) => setError(e.message),
  })

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-md max-h-[90dvh] overflow-y-auto" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="h-5 w-5 text-accent" />
            Nouveau client
          </DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Nom <span className="text-destructive">*</span></label>
            <input value={nom} onChange={(e) => setNom(e.target.value)} autoFocus autoComplete="off"
              placeholder="Raison sociale du client"
              className="w-full h-9 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Secteur</label>
            <SearchableCombobox options={secteurs} value={IDsecteur} onChange={setIDsecteur}
              getId={(o) => o.id} getPrimary={(o) => o.label} placeholder="Rechercher un secteur" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Activité</label>
            <SearchableCombobox options={activites} value={IDactivite} onChange={setIDactivite}
              getId={(o) => o.id} getPrimary={(o) => o.label} placeholder="Rechercher une activité" />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
              Compte client <span className="text-destructive">*</span>
              {suggesting && <Loader2 className="h-3 w-3 animate-spin text-accent" />}
            </label>
            <input value={compte}
              onChange={(e) => { setCompteTouched(true); setCompte(normalizeCompte(e.target.value)) }}
              autoComplete="off" spellCheck={false} maxLength={12}
              className={cn(
                'w-full h-9 px-2.5 text-sm font-mono tracking-wider rounded-md border bg-white focus:outline-none focus:ring-2 focus:ring-ring',
                compte && compteIssue ? 'border-destructive' : 'border-input',
              )} />
            <p className={cn('text-[11px]', compte && compteIssue ? 'text-destructive' : 'text-muted-foreground')}>
              {compte && compteIssue
                ? compteIssue
                : 'Proposé d’après le nom — 411 suivi de 3 lettres ou chiffres, unique par client.'}
            </p>
          </div>
          {error && (
            <p className="text-xs text-destructive flex items-start gap-1.5 mt-3">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-px" />{error}
            </p>
          )}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose} disabled={createMut.isPending}>Annuler</Button>
          <Button onClick={() => { setError(null); createMut.mutate() }} disabled={!canSubmit || createMut.isPending}>
            {createMut.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Plus className="h-3.5 w-3.5 mr-1.5" />}
            Créer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Center: Detail Header ──────────────────────────────

function DetailHeader({ client, isLoading, isEditing, draft, onPatch, onStartEdit, onCancelEdit, onSave, isSaving, canDelete, deletable, onDelete, onUnarchive, isUnarchiving, onPrint, onEmail }: {
  client: ClientDetail | null; isLoading: boolean; isEditing: boolean; draft: Draft | null; onPatch: (p: Partial<Draft>) => void
  onStartEdit: () => void; onCancelEdit: () => void; onSave: () => void; isSaving: boolean
  canDelete: boolean; deletable: boolean | undefined
  onDelete: () => void; onUnarchive: () => void; isUnarchiving: boolean; onPrint: () => void; onEmail: () => void
}) {
  if (!client && !isLoading) return null
  return (
    <div className="flex-shrink-0 pt-0.5">
      <div className="flex items-center gap-3">
        <div className={cn('h-11 w-11 rounded-lg flex items-center justify-center', isEditing ? 'bg-accent/15' : 'icon-box-gold')}>
          <Users className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          {isLoading ? <div className="h-8 w-48 bg-muted animate-pulse rounded" />
          : isEditing ? (
            <div className="flex items-center gap-3">
              <input value={draft?.nom ?? ''} onChange={(e) => onPatch({ nom: e.target.value })} autoFocus
                className="flex-1 text-xl font-heading font-bold h-10 px-3 rounded-md border border-input bg-background focus:outline-none focus:ring-2 focus:ring-ring" />
              <Badge className="bg-accent text-accent-foreground flex-shrink-0 gap-1 shadow-sm"><Pencil className="h-3 w-3" />Mode edition</Badge>
            </div>
          ) : (
            <>
              <h1 className="text-2xl font-heading font-bold tracking-tight truncate">{client?.nom || '—'}</h1>
              {!!client?.archive && (
                <div className="flex gap-1.5 mt-1 flex-wrap">
                  <Badge variant="outline" className="text-xs">Archivé</Badge>
                </div>
              )}
            </>
          )}
        </div>
        {!isLoading && client && (
          <div className="flex items-center gap-2 flex-shrink-0">
            {isEditing ? (
              <>
                {/* Delete/archive is an edit-mode-only, permission-gated action.
                    The icon reflects what will actually happen: bin when the
                    client is deletable, archive box when it has commandes /
                    marchandise (deletion impossible → archive instead). */}
                {canDelete && (client?.archive ? (
                  <Button variant="outline" size="icon" className="h-9 w-9" title="Désarchiver" onClick={onUnarchive} disabled={isUnarchiving}>
                    {isUnarchiving ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArchiveRestore className="h-4 w-4" />}
                  </Button>
                ) : deletable === false ? (
                  <Button variant="outline" size="icon" className="h-9 w-9" title="Archiver" onClick={onDelete}>
                    <Archive className="h-4 w-4" />
                  </Button>
                ) : (
                  <Button variant="outline" size="icon" className="h-9 w-9 text-destructive hover:text-destructive" title="Supprimer" onClick={onDelete} disabled={deletable === undefined}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                ))}
                <Button variant="outline" size="sm" onClick={onCancelEdit}><X className="h-3.5 w-3.5 mr-1.5" />Annuler</Button>
                <Button size="sm" onClick={onSave} disabled={isSaving}>
                  <Save className="h-3.5 w-3.5 mr-1.5" />{isSaving ? 'Enregistrement...' : 'Enregistrer'}
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" size="icon" className="h-9 w-9" title="Imprimer les tarifs" onClick={onPrint}><Printer className="h-4 w-4" /></Button>
                <Button variant="outline" size="icon" className="h-9 w-9" title="Envoyer un email" onClick={onEmail}><AtSign className="h-4 w-4" /></Button>
                <Button variant="gold" size="sm" onClick={onStartEdit}><Pencil className="h-3.5 w-3.5 mr-1.5" />Modifier</Button>
              </>
            )}
          </div>
        )}
      </div>
      <div className={cn('h-1 w-24 mt-3 rounded-full', isEditing ? 'bg-accent' : 'bg-gradient-to-r from-accent via-accent to-accent/30')} />
    </div>
  )
}

// ── Field primitives ───────────────────────────────────

function TogglePill({ label, checked, disabled, onChange }: {
  label: string; checked: boolean; disabled: boolean; onChange: (v: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-border/60 bg-white shadow-sm">
      <span className={cn('text-xs font-medium', disabled && 'text-muted-foreground')}>{label}</span>
      {/* The hover tint is gated on !disabled: a read-only pill that still
          lights up on hover reads as clickable and silently swallows the click. */}
      <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}
        className={cn('relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          'disabled:opacity-50 disabled:cursor-not-allowed',
          checked ? 'bg-accent shadow-inner' : 'bg-zinc-300',
          !disabled && !checked && 'hover:bg-zinc-400/80')}>
        <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ease-out',
          checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
      </button>
    </div>
  )
}

// ── Center: Detail Main (master-tabbed history views) ──
// "Classeur" layout (mps_designer §39): master tabs switch the center panel
// between datasets so the active view gets the full panel height.

const MAIN_TABS = [
  { key: 'references', label: 'Références', icon: Tag },
  { key: 'historique', label: 'Historique des commandes', icon: History },
  { key: 'marchandise', label: 'Marchandise expédiée', icon: Truck },
] as const
type MainTab = (typeof MAIN_TABS)[number]['key']

function DetailMain({ client, isLoading, hasSelection, isEditing, canManageTarifs, canManageRefs, canManageColoris, canRetourMarchandise }: {
  client: ClientDetail | null; isLoading: boolean; hasSelection: boolean; isEditing: boolean; canManageTarifs: boolean
  canManageRefs: boolean; canManageColoris: boolean; canRetourMarchandise: boolean
}) {
  const [activeTab, setActiveTab] = useState<MainTab>('references')
  // Land on Références (the client's main info) whenever the selection changes.
  useEffect(() => { setActiveTab('references') }, [client?.IDclient])

  if (!hasSelection) return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center space-y-3">
        <div className="icon-box-gold h-16 w-16 mx-auto"><Users className="h-8 w-8" /></div>
        <p className="text-muted-foreground text-sm">Sélectionnez un client dans la liste</p>
      </div>
    </div>
  )
  if (isLoading) return <div className="flex-1 flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-accent" /></div>
  if (!client) return null

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Master tabs — header-submenu style pills on the natural background */}
      <div className="flex-shrink-0 flex items-center gap-1 border-b border-border/60 pb-2">
        {MAIN_TABS.map((t) => {
          const Icon = t.icon
          const active = activeTab === t.key
          return (
            <button key={t.key} type="button" onClick={() => setActiveTab(t.key)}
              className={cn('flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap',
                active ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10 hover:text-accent')}>
              <Icon className="h-3.5 w-3.5" />{t.label}
            </button>
          )
        })}
      </div>
      {/* Flex column (not a scroll container): each tab owns its scrolling so
          Références can host the §31 in-screen drawer with the shrink mechanic. */}
      <div className="flex-1 min-h-0 flex flex-col gap-2 pt-3 pb-1">
        {/* Commercial sub-views (tarif modes editable in edit mode, permission-gated) */}
        {activeTab === 'references' && <ReferencesTab clientId={client.IDclient} isEditing={isEditing} canManageTarifs={canManageTarifs} canManageRefs={canManageRefs} canManageColoris={canManageColoris} />}
        {activeTab === 'historique' && (
          <div className="flex-1 min-h-0 overflow-auto scrollbar-transparent px-1"><HistoriqueTab clientId={client.IDclient} /></div>
        )}
        {activeTab === 'marchandise' && (
          // Flex column, not a scroll container: the tab pins its toolbar and
          // selection action bar while the table scrolls internally.
          <div className="flex-1 min-h-0 flex flex-col px-1"><MarchandiseTab clientId={client.IDclient} clientNom={client.nom ?? ''} canRetour={canRetourMarchandise} /></div>
        )}
      </div>
    </div>
  )
}

// ── Shared form components (contacts/adresses) ─────────

function LabeledInput({ label, value, onChange, autoFocus }: { label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      <input value={value} onChange={(e) => onChange(e.target.value)} autoFocus={autoFocus}
        autoComplete="off" data-form-type="other" data-lpignore="true" className={inputClass} />
    </div>
  )
}

function InlineForm({ title, children, onSave, onCancel, isSaving }: { title: string; children: React.ReactNode; onSave: () => void; onCancel: () => void; isSaving: boolean }) {
  return (
    <div className="rounded-lg border border-accent/25 bg-accent/[0.03] p-4 space-y-3">
      <p className="text-xs font-semibold text-accent uppercase tracking-wide">{title}</p>
      {children}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="outline" size="sm" onClick={onCancel}>Annuler</Button>
        <Button size="sm" onClick={onSave} disabled={isSaving}>{isSaving ? 'Enregistrement...' : 'Enregistrer'}</Button>
      </div>
    </div>
  )
}

// ── Right Panel: Sidebar with Tabs ─────────────────────

type SidebarTab = 'info' | 'commercial' | 'contacts' | 'adresses'

function DetailSidebar({ client, isLoading, isEditing, clientId, onMutationSuccess, onSubFormsDirtyChange, draft, onPatch,
  canEditInfo, canEditRapportQualite, canEditCommercial, canCrudContacts, canCrudAdresses,
  secteurs, activites, modesPaiement, echeances, tvas, codesComptables }: {
  client: ClientDetail | null; isLoading: boolean; isEditing: boolean; clientId: number; onMutationSuccess: () => void
  onSubFormsDirtyChange: (dirty: boolean) => void
  draft: Draft | null; onPatch: (p: Partial<Draft>) => void
  canEditInfo: boolean; canEditRapportQualite: boolean; canEditCommercial: boolean
  canCrudContacts: boolean; canCrudAdresses: boolean
  secteurs: LookupLabel[]; activites: LookupLabel[]; modesPaiement: LookupLabel[]; echeances: LookupLabel[]; tvas: LookupLabel[]; codesComptables: LookupLabel[]
}) {
  const [activeTab, setActiveTab] = useState<SidebarTab>('info')
  if (isLoading) return (
    <div className="w-[26rem] flex-shrink-0 bg-muted/30 rounded-xl border p-4 space-y-4">
      <div className="flex gap-2"><div className="h-8 flex-1 bg-muted animate-pulse rounded-md" /><div className="h-8 flex-1 bg-muted animate-pulse rounded-md" /></div>
      {[1, 2, 3].map((i) => <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />)}
    </div>
  )
  if (!client) return null

  const tabs: { key: SidebarTab; label: string; icon: React.ElementType }[] = [
    { key: 'info', label: 'Info', icon: Briefcase },
    { key: 'commercial', label: 'Commercial', icon: CalendarClock },
    { key: 'contacts', label: 'Contacts', icon: User },
    { key: 'adresses', label: 'Adresses', icon: MapPin },
  ]

  return (
    <div className="w-[26rem] flex-shrink-0 rounded-xl border flex flex-col overflow-hidden bg-zinc-100/80">
      <div className="flex border-b p-1 gap-1 rounded-t-xl bg-zinc-200/50">
        {tabs.map((tab) => {
          const Icon = tab.icon
          return (
            <button key={tab.key} onClick={() => setActiveTab(tab.key)}
              className={cn('flex-1 min-w-0 flex items-center justify-center gap-1 px-1.5 py-2 text-xs font-medium rounded-md transition-colors',
                activeTab === tab.key ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10')}>
              <Icon className="h-3.5 w-3.5 flex-shrink-0" /><span className="truncate">{tab.label}</span>
            </button>
          )
        })}
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2 scrollbar-transparent">
        {/* Each tab gets its own permission scope — without it, edit mode renders
            that tab exactly like view mode (mirrored server-side in clients.ts). */}
        {activeTab === 'info' && <InfoTab client={client} isEditing={isEditing && canEditInfo}
          canEditRapportQualite={isEditing && canEditRapportQualite} draft={draft} onPatch={onPatch}
          secteurs={secteurs} activites={activites} modesPaiement={modesPaiement} echeances={echeances} tvas={tvas} codesComptables={codesComptables} />}
        {activeTab === 'commercial' && <CommercialTab client={client} isEditing={isEditing && canEditCommercial} draft={draft} onPatch={onPatch} />}
        {activeTab === 'contacts' && <ContactsTab contacts={client.contacts} isEditing={isEditing && canCrudContacts} clientId={clientId} onMutationSuccess={onMutationSuccess} onDirtyChange={onSubFormsDirtyChange} />}
        {activeTab === 'adresses' && <AdressesTab adresses={client.adresses} isEditing={isEditing && canCrudAdresses} clientId={clientId} onMutationSuccess={onMutationSuccess} onDirtyChange={onSubFormsDirtyChange} />}
      </div>
    </div>
  )
}

// ── Sidebar Tab: Info (général · facturation · commentaire) ──

function InfoCard({ icon, title, isEditing, children }: { icon: React.ReactNode; title: string; isEditing: boolean; children: React.ReactNode }) {
  return (
    <div className={cn('p-3 rounded-lg border bg-card shadow-sm', isEditing && editSectionClass)}>
      <div className="flex items-center gap-2 mb-2">{icon}<h3 className="text-sm font-semibold">{title}</h3></div>
      <div className="space-y-2">{children}</div>
    </div>
  )
}

function KVRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-2 min-h-[1.75rem]">
      <span className="text-xs text-muted-foreground flex-shrink-0">{label}</span>
      <div className="min-w-0 text-sm text-right">{children}</div>
    </div>
  )
}

function KVText({ label, value, edit, onChange, type = 'text', invalid, mono, maxLength }: {
  label: string; value: string; edit: boolean; onChange: (v: string) => void; type?: string
  /** Red border while the value fails validation (compte client). */
  invalid?: boolean; mono?: boolean; maxLength?: number
}) {
  return (
    <KVRow label={label}>
      {edit ? (
        // w-[220px] matches PopoverSelect / SearchableCombobox size="sm"
        // (mps_designer §11bis) so text inputs and dropdowns share one KV column.
        <input type={type} value={value} onChange={(e) => onChange(e.target.value)} maxLength={maxLength}
          autoComplete="off" data-form-type="other" data-lpignore="true"
          className={cn('h-7 w-[220px] px-2 text-sm text-right rounded-md border bg-white focus:outline-none focus:ring-2 focus:ring-ring',
            invalid ? 'border-destructive' : 'border-input',
            mono && 'font-mono tracking-wider')} />
      ) : (
        <span className="block truncate">{value?.trim() ? value : <span className="text-muted-foreground">—</span>}</span>
      )}
    </KVRow>
  )
}

function KVSelect({ label, value, edit, options, onChange, searchable }: {
  label: string; value: number; edit: boolean; options: LookupLabel[]; onChange: (id: number) => void; searchable?: boolean
}) {
  const current = options.find((o) => o.id === value)
  return (
    <KVRow label={label}>
      {edit ? (
        searchable ? (
          <SearchableCombobox options={options} value={value} onChange={onChange} getId={(o) => o.id} getPrimary={(o) => o.label} placeholder={`Rechercher ${label.toLowerCase()}`} size="sm" />
        ) : (
          <PopoverSelect options={options.map((o) => ({ id: o.id, primary: o.label }))} value={value} onChange={onChange} emptyLabel="— Aucun —" size="sm" />
        )
      ) : (
        <span className="block truncate">{current ? current.label : <span className="text-muted-foreground">—</span>}</span>
      )}
    </KVRow>
  )
}

function InfoTab({ client, isEditing, canEditRapportQualite, draft, onPatch, secteurs, activites, modesPaiement, echeances, tvas, codesComptables }: {
  client: ClientDetail; isEditing: boolean
  /** "Inclure rapports contrôle" is its own permission — editable even when the
   *  rest of the tab is read-only, and read-only when the rest is editable. */
  canEditRapportQualite: boolean
  draft: Draft | null; onPatch: (p: Partial<Draft>) => void
  secteurs: LookupLabel[]; activites: LookupLabel[]; modesPaiement: LookupLabel[]; echeances: LookupLabel[]; tvas: LookupLabel[]; codesComptables: LookupLabel[]
}) {
  const ed = isEditing && draft !== null
  const edRapport = canEditRapportQualite && draft !== null
  // Same query key as the page, so React Query dedupes this to zero extra
  // requests rather than threading the set down through DetailSidebar.
  const { taken: comptesPris } = useComptesPris()
  const compteIssue = ed ? compteError(draft!.compte, { taken: comptesPris, ownCompte: client.compte }) : null
  // tel / fax / pct_ajeol are still carried by the draft (so a save round-trips
  // the stored values untouched) — they're just no longer surfaced here.
  const v = {
    num_tva: ed ? draft!.num_tva : client.num_tva ?? '',
    compte: ed ? draft!.compte : client.compte ?? '',
    commentaire: ed ? draft!.commentaire : client.commentaire ?? '',
    pct_remise: ed ? draft!.pct_remise : (client.pct_remise ? String(client.pct_remise) : ''),
    IDtva: ed ? draft!.IDtva : client.IDtva,
    IDmode_paiement: ed ? draft!.IDmode_paiement : client.IDmode_paiement,
    IDecheance: ed ? draft!.IDecheance : client.IDecheance,
    IDcode_comptable: ed ? draft!.IDcode_comptable : client.IDcode_comptable,
    IDsecteur_activite: ed ? draft!.IDsecteur_activite : client.IDsecteur_activite,
    IDactivite: ed ? draft!.IDactivite : client.IDactivite,
    client_interne: ed ? draft!.client_interne : !!client.client_interne,
    inclureRapportQualite: edRapport ? draft!.inclureRapportQualite : !!client.inclureRapportQualite,
  }
  return (
    <>
      {/* Général carries both scopes — the gold edit edge shows if either applies. */}
      <InfoCard icon={<Briefcase className="h-4 w-4 text-accent" />} title="Général" isEditing={ed || edRapport}>
        <KVText label="Remise (%)" value={v.pct_remise} edit={ed} type="number" onChange={(x) => onPatch({ pct_remise: x })} />
        <KVSelect label="Secteur" value={v.IDsecteur_activite} edit={ed} options={secteurs} onChange={(id) => onPatch({ IDsecteur_activite: id })} searchable />
        <KVSelect label="Activité" value={v.IDactivite} edit={ed} options={activites} onChange={(id) => onPatch({ IDactivite: id })} searchable />
        <div className="space-y-2 pt-1">
          <TogglePill label="Client interne" checked={v.client_interne} disabled={!ed} onChange={(x) => onPatch({ client_interne: x })} />
          <TogglePill label="Inclure rapports contrôle (exp.)" checked={v.inclureRapportQualite} disabled={!edRapport} onChange={(x) => onPatch({ inclureRapportQualite: x })} />
        </div>
      </InfoCard>

      <InfoCard icon={<Receipt className="h-4 w-4 text-accent" />} title="Facturation" isEditing={ed}>
        <KVSelect label="Mode de paiement" value={v.IDmode_paiement} edit={ed} options={modesPaiement} onChange={(id) => onPatch({ IDmode_paiement: id })} />
        <KVSelect label="Échéance" value={v.IDecheance} edit={ed} options={echeances} onChange={(id) => onPatch({ IDecheance: id })} />
        <KVSelect label="TVA" value={v.IDtva} edit={ed} options={tvas} onChange={(id) => onPatch({ IDtva: id })} />
        <KVText label="N° TVA" value={v.num_tva} edit={ed} onChange={(x) => onPatch({ num_tva: x })} />
        <KVSelect label="Code comptable" value={v.IDcode_comptable} edit={ed} options={codesComptables} onChange={(id) => onPatch({ IDcode_comptable: id })} searchable />
        {/* Compte client is mandatory and format-checked (411 + 3 alphanumerics).
            It is generated at creation; here it stays editable but a save is
            refused while it is empty or malformed. */}
        <KVText label="Compte client" value={v.compte} edit={ed} mono maxLength={12}
          invalid={ed && compteIssue !== null}
          onChange={(x) => onPatch({ compte: normalizeCompte(x) })} />
        {ed && compteIssue !== null && (
          <p className="text-[11px] text-destructive text-right">{compteIssue}</p>
        )}
      </InfoCard>

      <InfoCard icon={<FileText className="h-4 w-4 text-accent" />} title="Commentaire" isEditing={ed}>
        {ed ? (
          <textarea value={v.commentaire} onChange={(e) => onPatch({ commentaire: e.target.value })} rows={4}
            className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y" />
        ) : v.commentaire?.trim() ? (
          <p className="text-sm text-muted-foreground whitespace-pre-line">{v.commentaire}</p>
        ) : <p className="text-sm text-muted-foreground italic">Aucun commentaire</p>}
      </InfoCard>
    </>
  )
}

// ── Sidebar Tab: Commercial (dernier contact · journal) ──

function CommercialTab({ client, isEditing, draft, onPatch }: {
  client: ClientDetail; isEditing: boolean; draft: Draft | null; onPatch: (p: Partial<Draft>) => void
}) {
  const ed = isEditing && draft !== null
  const dernierContactInput = ed ? draft!.dernier_contact : hfsqlDateToInput(client.dernier_contact)
  const journal = ed ? draft!.journal_commercial : client.journal_commercial ?? ''
  return (
    <InfoCard icon={<CalendarClock className="h-4 w-4 text-accent" />} title="Commercial" isEditing={ed}>
      <KVRow label="Dernier contact">
        {ed ? (
          <input type="date" value={dernierContactInput} onChange={(e) => onPatch({ dernier_contact: e.target.value })}
            autoComplete="off" data-form-type="other" data-lpignore="true"
            className="h-7 w-[160px] px-2 text-sm text-right rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring" />
        ) : (
          <span className="block truncate">{client.dernier_contact && /\d{8}/.test(client.dernier_contact) ? formatHfsqlDate(client.dernier_contact) : <span className="text-muted-foreground">—</span>}</span>
        )}
      </KVRow>
      <div className="space-y-1 pt-1">
        <label className="text-xs font-medium text-muted-foreground">Journal commercial</label>
        {ed ? (
          <textarea value={journal} onChange={(e) => onPatch({ journal_commercial: e.target.value })} rows={8}
            className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y" />
        ) : journal?.trim() ? (
          <p className="text-sm text-muted-foreground whitespace-pre-line">{journal}</p>
        ) : <p className="text-sm text-muted-foreground italic">Aucun journal</p>}
      </div>
    </InfoCard>
  )
}

// ── Sidebar Tab: Contacts ──────────────────────────────

const ENVOI_FLAGS = [
  { key: 'envoi_commande' as const, label: 'Commande' },
  { key: 'envoi_bl' as const, label: 'BL' },
  { key: 'envoi_facture' as const, label: 'Facture' },
  { key: 'envoi_soumission' as const, label: 'Soumission' },
]

// Hue-per-document category chips (mps_designer §36 style): one stable colour
// per doc type so a contact's send-flags read at a glance. Soumission matches
// the amber "À soumettre" pill on ref cards; Facturation/Livraison on address
// cards reuse the Facture/BL hues.
const ENVOI_CHIP_CLASS: Record<(typeof ENVOI_FLAGS)[number]['key'], string> = {
  envoi_commande: 'bg-sky-500/10 text-sky-700 border-sky-500/25',
  envoi_bl: 'bg-teal-500/10 text-teal-700 border-teal-500/25',
  envoi_facture: 'bg-orange-500/10 text-orange-700 border-orange-500/25',
  envoi_soumission: 'bg-amber-500/15 text-amber-800 border-amber-500/30',
}
const chipClass = 'inline-flex items-center px-1.5 py-0 rounded text-[10px] font-medium border'

// Gold "Principal(e)" star badge + gold avatar tint (icon-box-gold gradient,
// with the darker gold text the utility uses — text-accent is too light on white).
const principalBadgeClass = 'text-[10px] py-0 flex-shrink-0 bg-accent/10 text-amber-700 border-accent/30'
const goldAvatarClass = 'bg-gradient-to-br from-gold/30 to-gold/10 text-amber-700'

function contactInitials(prenom: string | null, nom: string | null): string {
  return [prenom, nom].map((s) => (s ?? '').trim().charAt(0).toUpperCase()).filter(Boolean).join('')
}

function ContactsTab({ contacts, isEditing, clientId, onMutationSuccess, onDirtyChange }: {
  contacts: Contact[]; isEditing: boolean; clientId: number; onMutationSuccess: () => void; onDirtyChange: (dirty: boolean) => void
}) {
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState({ nom: '', prenom: '', tel: '', mail: '', envoi_bl: false, envoi_facture: false, envoi_commande: false, envoi_soumission: false })
  const [showForm, setShowForm] = useState(false)

  const onDirtyChangeRef = useRef(onDirtyChange)
  useEffect(() => { onDirtyChangeRef.current = onDirtyChange })
  useEffect(() => { onDirtyChangeRef.current(showForm || editingId !== null) }, [showForm, editingId])
  useEffect(() => () => { onDirtyChangeRef.current(false) }, [])

  const createMut = useMutation({ mutationFn: () => apiFetch(`/clients/${clientId}/contacts`, { method: 'POST', body: JSON.stringify(form) }), onSuccess: () => { onMutationSuccess(); resetForm() } })
  const updateMut = useMutation({ mutationFn: (cid: number) => apiFetch(`/clients/${clientId}/contacts/${cid}`, { method: 'PUT', body: JSON.stringify(form) }), onSuccess: () => { onMutationSuccess(); setEditingId(null) } })
  const deleteMut = useMutation({ mutationFn: (cid: number) => apiFetch(`/clients/${clientId}/contacts/${cid}`, { method: 'DELETE' }), onSuccess: onMutationSuccess })

  const resetForm = () => { setForm({ nom: '', prenom: '', tel: '', mail: '', envoi_bl: false, envoi_facture: false, envoi_commande: false, envoi_soumission: false }); setShowForm(false) }
  const startEditContact = (c: Contact) => {
    setEditingId(c.IDcontact)
    setForm({ nom: c.nom ?? '', prenom: c.prenom ?? '', tel: c.tel ?? '', mail: c.mail ?? '', envoi_bl: !!c.envoi_bl, envoi_facture: !!c.envoi_facture, envoi_commande: !!c.envoi_commande, envoi_soumission: !!c.envoi_soumission })
  }

  const contactForm = (
    <>
      <div className="grid grid-cols-2 gap-2">
        <LabeledInput label="Prénom" value={form.prenom} onChange={(v) => setForm({ ...form, prenom: v })} autoFocus />
        <LabeledInput label="Nom" value={form.nom} onChange={(v) => setForm({ ...form, nom: v })} />
      </div>
      <LabeledInput label="Téléphone" value={form.tel} onChange={(v) => setForm({ ...form, tel: v })} />
      <LabeledInput label="Email" value={form.mail} onChange={(v) => setForm({ ...form, mail: v })} />
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Envoi documents</label>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1">
          {ENVOI_FLAGS.map(({ key, label }) => (
            <label key={key} className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="checkbox" checked={form[key]} onChange={(e) => setForm({ ...form, [key]: e.target.checked })} className="h-3.5 w-3.5 rounded border-input accent-accent" />
              {label}
            </label>
          ))}
        </div>
      </div>
    </>
  )

  if (contacts.length === 0 && !isEditing) return (
    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground"><User className="h-10 w-10 mb-2 opacity-40" /><p className="text-sm">Aucun contact</p></div>
  )

  return (
    <>
      {contacts.map((c) =>
        isEditing && editingId === c.IDcontact ? (
          <InlineForm key={c.IDcontact} title="Modifier le contact" onSave={() => updateMut.mutate(c.IDcontact)} onCancel={() => setEditingId(null)} isSaving={updateMut.isPending}>{contactForm}</InlineForm>
        ) : (
          <div key={c.IDcontact} className={cn('p-3 rounded-lg border bg-card shadow-sm group relative', isEditing && editSectionClass)}>
            <div className="flex items-start gap-2.5">
              {/* Initials avatar — gold for the principal contact, zinc otherwise */}
              <div className={cn('h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0 text-[11px] font-bold select-none',
                c.est_defaut ? goldAvatarClass : 'bg-zinc-200/70 text-zinc-500')}>
                {contactInitials(c.prenom, c.nom) || <User className="h-3.5 w-3.5" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-sm flex items-center gap-2">
                  <span className="truncate min-w-0">{[c.prenom, c.nom].filter(Boolean).join(' ') || 'Contact'}</span>
                  {/* Pinned top-right corner of the card */}
                  {!!c.est_defaut && (
                    <Badge variant="outline" className={cn(principalBadgeClass, 'ml-auto')}>
                      <Star className="h-2.5 w-2.5 mr-0.5 fill-current" />Principal
                    </Badge>
                  )}
                </div>
                {c.tel && (
                  <div className="text-xs text-muted-foreground flex items-center gap-1.5 mt-1">
                    <Phone className="h-3 w-3 text-amber-600/70 flex-shrink-0" />
                    <a href={`tel:${c.tel}`} className="hover:text-accent transition-colors">{c.tel}</a>
                  </div>
                )}
                {c.mail && (
                  <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <Mail className="h-3 w-3 text-amber-600/70 flex-shrink-0" />
                    <a href={`mailto:${c.mail}`} className="truncate hover:text-accent transition-colors">{c.mail}</a>
                  </div>
                )}
                {ENVOI_FLAGS.some(({ key }) => !!c[key]) && (
                  <div className="flex gap-1 mt-1.5 flex-wrap">
                    {ENVOI_FLAGS.map(({ key, label }) => !!c[key] && (
                      <span key={key} className={cn(chipClass, ENVOI_CHIP_CLASS[key])}>{label}</span>
                    ))}
                  </div>
                )}
              </div>
              {isEditing && (
                <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => startEditContact(c)}><Pencil className="h-3 w-3" /></Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive" onClick={() => deleteMut.mutate(c.IDcontact)}><Trash2 className="h-3 w-3" /></Button>
                </div>
              )}
            </div>
          </div>
        )
      )}
      {isEditing && !showForm && editingId === null && (
        <Button variant="ghost" size="sm" className="w-full text-muted-foreground hover:text-foreground" onClick={() => setShowForm(true)}><Plus className="h-4 w-4 mr-1.5" />Ajouter un contact</Button>
      )}
      {isEditing && showForm && <InlineForm title="Nouveau contact" onSave={() => createMut.mutate()} onCancel={resetForm} isSaving={createMut.isPending}>{contactForm}</InlineForm>}
    </>
  )
}

// ── Sidebar Tab: Adresses ──────────────────────────────

function AdressesTab({ adresses, isEditing, clientId, onMutationSuccess, onDirtyChange }: {
  adresses: Adresse[]; isEditing: boolean; clientId: number; onMutationSuccess: () => void; onDirtyChange: (dirty: boolean) => void
}) {
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState({ nom: '', adresse1: '', adresse2: '', adresse3: '', cp: '', ville: '', pays: '', commentaire: '', est_defaut_facturation: false, est_defaut_livraison: false })
  const [showForm, setShowForm] = useState(false)

  const onDirtyChangeRef = useRef(onDirtyChange)
  useEffect(() => { onDirtyChangeRef.current = onDirtyChange })
  useEffect(() => { onDirtyChangeRef.current(showForm || editingId !== null) }, [showForm, editingId])
  useEffect(() => () => { onDirtyChangeRef.current(false) }, [])

  const createMut = useMutation({ mutationFn: () => apiFetch(`/clients/${clientId}/adresses`, { method: 'POST', body: JSON.stringify(form) }), onSuccess: () => { onMutationSuccess(); resetForm() } })
  const updateMut = useMutation({ mutationFn: (aid: number) => apiFetch(`/clients/${clientId}/adresses/${aid}`, { method: 'PUT', body: JSON.stringify(form) }), onSuccess: () => { onMutationSuccess(); setEditingId(null) } })
  const deleteMut = useMutation({ mutationFn: (aid: number) => apiFetch(`/clients/${clientId}/adresses/${aid}`, { method: 'DELETE' }), onSuccess: onMutationSuccess })

  const resetForm = () => { setForm({ nom: '', adresse1: '', adresse2: '', adresse3: '', cp: '', ville: '', pays: '', commentaire: '', est_defaut_facturation: false, est_defaut_livraison: false }); setShowForm(false) }
  const startEditAddr = (a: Adresse) => {
    setEditingId(a.IDadresse)
    setForm({ nom: a.nom ?? '', adresse1: a.adresse1 ?? '', adresse2: a.adresse2 ?? '', adresse3: a.adresse3 ?? '', cp: a.cp ?? '', ville: a.ville ?? '', pays: a.pays ?? '', commentaire: a.commentaire ?? '', est_defaut_facturation: !!a.est_defaut_facturation, est_defaut_livraison: !!a.est_defaut_livraison })
  }

  const adresseForm = (
    <>
      <LabeledInput label="Libellé" value={form.nom} onChange={(v) => setForm({ ...form, nom: v })} autoFocus />
      <LabeledInput label="Adresse 1" value={form.adresse1} onChange={(v) => setForm({ ...form, adresse1: v })} />
      <LabeledInput label="Adresse 2" value={form.adresse2} onChange={(v) => setForm({ ...form, adresse2: v })} />
      <LabeledInput label="Adresse 3" value={form.adresse3} onChange={(v) => setForm({ ...form, adresse3: v })} />
      <div className="grid grid-cols-3 gap-2">
        <LabeledInput label="CP" value={form.cp} onChange={(v) => setForm({ ...form, cp: v })} />
        <div className="col-span-2"><LabeledInput label="Ville" value={form.ville} onChange={(v) => setForm({ ...form, ville: v })} /></div>
      </div>
      <LabeledInput label="Pays" value={form.pays} onChange={(v) => setForm({ ...form, pays: v })} />
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground">Type d'adresse</label>
        <div className="flex gap-4">
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input type="checkbox" checked={form.est_defaut_facturation} onChange={(e) => setForm({ ...form, est_defaut_facturation: e.target.checked })} className="h-3.5 w-3.5 rounded border-input accent-accent" />Facturation
          </label>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input type="checkbox" checked={form.est_defaut_livraison} onChange={(e) => setForm({ ...form, est_defaut_livraison: e.target.checked })} className="h-3.5 w-3.5 rounded border-input accent-accent" />Livraison
          </label>
        </div>
      </div>
    </>
  )

  if (adresses.length === 0 && !isEditing) return (
    <div className="flex flex-col items-center justify-center py-8 text-muted-foreground"><MapPin className="h-10 w-10 mb-2 opacity-40" /><p className="text-sm">Aucune adresse</p></div>
  )

  return (
    <>
      {adresses.map((a) => {
        if (isEditing && editingId === a.IDadresse) {
          return <InlineForm key={a.IDadresse} title="Modifier l'adresse" onSave={() => updateMut.mutate(a.IDadresse)} onCancel={() => setEditingId(null)} isSaving={updateMut.isPending}>{adresseForm}</InlineForm>
        }
        // Icon + hue follow the address type: Livraison teal Truck, Facturation
        // orange Receipt, both/neither (or principale) gold MapPin.
        const fact = !!a.est_defaut_facturation
        const livr = !!a.est_defaut_livraison
        const AddrIcon = livr && !fact ? Truck : fact && !livr ? Receipt : MapPin
        const iconBoxClass = livr && !fact ? 'bg-teal-500/10 text-teal-600'
          : fact && !livr ? 'bg-orange-500/10 text-orange-600'
          : goldAvatarClass
        return (
          <div key={a.IDadresse} className={cn('p-3 rounded-lg border bg-card shadow-sm group relative', isEditing && editSectionClass)}>
            <div className="flex items-start gap-2.5">
              <div className={cn('h-8 w-8 rounded-md flex items-center justify-center flex-shrink-0', iconBoxClass)}>
                <AddrIcon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-medium text-sm flex items-center gap-2">
                  <span className="truncate min-w-0">{a.nom || 'Adresse'}</span>
                  {/* Pinned top-right corner of the card, mirroring the contacts tab */}
                  {!!a.est_defaut && (
                    <Badge variant="outline" className={cn(principalBadgeClass, 'ml-auto')}>
                      <Star className="h-2.5 w-2.5 mr-0.5 fill-current" />Principale
                    </Badge>
                  )}
                </div>
                {(fact || livr) && (
                  <div className="flex gap-1 mt-1">
                    {fact && <span className={cn(chipClass, ENVOI_CHIP_CLASS.envoi_facture)}>Facturation</span>}
                    {livr && <span className={cn(chipClass, ENVOI_CHIP_CLASS.envoi_bl)}>Livraison</span>}
                  </div>
                )}
                <div className="text-xs text-muted-foreground mt-1 space-y-0.5">
                  {a.adresse1 && <p>{a.adresse1}</p>}
                  {a.adresse2 && <p>{a.adresse2}</p>}
                  {a.adresse3 && <p>{a.adresse3}</p>}
                  {(a.cp || a.ville) && <p className="font-medium text-foreground/75">{[a.cp, a.ville].filter(Boolean).join(' ')}</p>}
                  {a.pays && <p>{a.pays}</p>}
                </div>
              </div>
              {isEditing && (
                <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => startEditAddr(a)}><Pencil className="h-3 w-3" /></Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive" onClick={() => deleteMut.mutate(a.IDadresse)}><Trash2 className="h-3 w-3" /></Button>
                </div>
              )}
            </div>
          </div>
        )
      })}
      {isEditing && !showForm && editingId === null && (
        <Button variant="ghost" size="sm" className="w-full text-muted-foreground hover:text-foreground" onClick={() => setShowForm(true)}><Plus className="h-4 w-4 mr-1.5" />Ajouter une adresse</Button>
      )}
      {isEditing && showForm && <InlineForm title="Nouvelle adresse" onSave={() => createMut.mutate()} onCancel={resetForm} isSaving={createMut.isPending}>{adresseForm}</InlineForm>}
    </>
  )
}

// ── Commercial sub-views (read-only collapsible sections) ──

const UNITE_LABEL: Record<number, string> = { 1: 'Kg', 3: 'Ml', 4: 'unité', 5: 'm²' }

function SectionSpinner() { return <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-accent" /></div> }
function SectionEmpty({ text }: { text: string }) { return <p className="text-sm text-muted-foreground italic py-2">{text}</p> }

const thHead = 'bg-zinc-100/80 border-b text-[10px] uppercase tracking-wide text-muted-foreground'

// ── Références catalogue ───────────────────────────────

interface ContratTarif { IDcontrat_tarif: number; date_debut: string; date_expiration: string; tranches: { nb_rouleaux: number; prix: number }[] }
type TarifMode = 'standard' | 'coefficient' | 'contrat'
interface RefColoris {
  IDref_client_colori: number; label: string; coloris_id: number; lst_tranche: string; contrat: number
  tarif_mode: TarifMode; coefficient: number; contrats: ContratTarif[]; contrat_actif: ContratTarif | null; contrat_expire: boolean
}
interface ClientReference { IDdesignation_client: number; client_ref: string; IDref_fini: number; IDref_ecru: number; ref_interne: string; designation: string; avec_teinture: number; soumettre: number; unite: number; fil_non_facture: number[]; associees: number[]; coloris: RefColoris[] }

interface RefAssocieeLookup { IDref_fini: number; reference: string; designation: string }

/** Small category tag showing a coloris' non-standard tarif mode on its chip. */
function TarifModeTag({ c }: { c: RefColoris }) {
  if (c.tarif_mode === 'coefficient') {
    return <span className="text-[9px] font-semibold px-1 rounded bg-sky-500/10 text-sky-700 border border-sky-500/25">Coef {c.coefficient}</span>
  }
  if (c.tarif_mode === 'contrat') {
    return c.contrat_expire ? (
      <span className="text-[9px] font-semibold px-1 rounded bg-red-500/10 text-red-700 border border-red-500/25">Contrat expiré</span>
    ) : (
      <span className="text-[9px] font-semibold px-1 rounded bg-emerald-500/10 text-emerald-700 border border-emerald-500/25">
        Contrat → {c.contrat_actif ? formatHfsqlDate(c.contrat_actif.date_expiration) : '?'}
      </span>
    )
  }
  return null
}

/** Accent-insensitive lowercase for the references filter (strips combining marks U+0300..U+036F). */
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g')
function normSearch(s: string): string {
  return s.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase()
}

function ReferencesTab({ clientId, isEditing, canManageTarifs, canManageRefs, canManageColoris }: {
  clientId: number; isEditing: boolean; canManageTarifs: boolean; canManageRefs: boolean; canManageColoris: boolean
}) {
  // Without the gestion_references permission, edit mode behaves like view
  // mode on this tab: cards open the coloris drawer, no settings dialog,
  // no "Ajouter une référence".
  const canEditRefs = isEditing && canManageRefs
  // gestion_coloris users get the one extra affordance they're entitled to:
  // "Ajouter un coloris" in the drawer. Redundant when they can edit the ref
  // outright (the settings dialog already manages the coloris list).
  const canAddColoris = isEditing && !canManageRefs && canManageColoris
  const [addColorisRefId, setAddColorisRefId] = useState<number | null>(null)
  const [tarif, setTarif] = useState<{ rccId: number; label: string } | null>(null)
  const [tarifMode, setTarifMode] = useState<{ coloris: RefColoris; label: string; duplicate?: boolean } | null>(null)
  // Ref-level settings dialog: { refId: null } = create, { refId: n } = edit.
  // Stores the id (not a snapshot) so the dialog's Tarifs tab re-derives the
  // ref from the live query after a tarif-mode save invalidates the list.
  const [settings, setSettings] = useState<{ refId: number | null } | null>(null)
  const [search, setSearch] = useState('')
  // §31 in-screen drawer: the selected ref's coloris. Toggle on reclick.
  const [drawerRefId, setDrawerRefId] = useState<number | null>(null)
  const { data, isLoading } = useQuery<ClientReference[]>({ queryKey: ['client-references', clientId], queryFn: () => apiFetch(`/clients/${clientId}/references`) })
  // The tab stays mounted across client switches; don't carry the filter/drawer over.
  useEffect(() => { setSearch(''); setDrawerRefId(null) }, [clientId])
  // Entering edit mode reserves the card click for the settings dialog (§31.3)
  // — close the coloris drawer so it doesn't linger with no way to reopen it.
  useEffect(() => { if (canEditRefs) setDrawerRefId(null) }, [canEditRefs])
  // Multi-criteria filter: every space-separated term must match at least one of
  // the ref's fields (commercial name, internal ref, designation, coloris labels).
  const filtered = useMemo(() => {
    const all = data ?? []
    const terms = normSearch(search).split(/\s+/).filter(Boolean)
    if (terms.length === 0) return all
    return all.filter((r) => {
      const hay = [r.client_ref, r.ref_interne, r.designation, ...r.coloris.map((c) => c.label)].map(normSearch)
      return terms.every((t) => hay.some((h) => h.includes(t)))
    })
  }, [data, search])

  const drawerRef = drawerRefId !== null ? filtered.find((r) => r.IDdesignation_client === drawerRefId) ?? null : null
  const drawerOpen = drawerRef !== null
  const settingsExisting = settings !== null && settings.refId !== null
    ? (data ?? []).find((r) => r.IDdesignation_client === settings.refId) ?? null
    : null
  // Close the drawer when the search narrows its ref out of the visible list.
  useEffect(() => {
    if (drawerRefId !== null && !filtered.some((r) => r.IDdesignation_client === drawerRefId)) setDrawerRefId(null)
  }, [filtered, drawerRefId])
  // When the drawer closes, the full list re-renders from scrollTop 0 — bring
  // the card the user was working on back into view.
  const lastDrawerRefId = useRef<number | null>(null)
  useEffect(() => {
    if (drawerRefId !== null) { lastDrawerRefId.current = drawerRefId; return }
    const last = lastDrawerRefId.current
    if (last === null) return
    requestAnimationFrame(() => {
      document.querySelector(`[data-ref-card="${last}"]`)?.scrollIntoView({ block: 'nearest' })
    })
  }, [drawerRefId])

  return (
    <>
      {!isLoading && !!data && data.length > 0 && (
        <div className="relative flex-shrink-0 mx-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Filtrer (réf, désignation, coloris...)"
            className="w-full h-9 pl-9 pr-3 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring" />
        </div>
      )}
      {isLoading ? <SectionSpinner /> : !data || data.length === 0 ? <SectionEmpty text="Aucune référence client" />
        : filtered.length === 0 ? <SectionEmpty text="Aucune référence ne correspond à la recherche" /> : (
        <div className={cn('space-y-2 p-1 scrollbar-transparent',
          // Open drawer: the band renders ONLY the selected card (exact height,
          // drawer docks right under it); the full scrollable list is view state.
          drawerOpen ? 'flex-shrink-0' : 'flex-1 min-h-0 overflow-auto')}>
          {(drawerOpen ? filtered.filter((r) => r.IDdesignation_client === drawerRefId) : filtered).map((r) => (
            <div key={r.IDdesignation_client} data-ref-card={r.IDdesignation_client}
              // Edit mode: the card click is reserved for the settings dialog (§31.3);
              // the drawer only opens from view mode.
              onClick={() => {
                if (canEditRefs) setSettings({ refId: r.IDdesignation_client })
                else setDrawerRefId((prev) => (prev === r.IDdesignation_client ? null : r.IDdesignation_client))
              }}
              title={canEditRefs ? 'Modifier la référence' : drawerRefId === r.IDdesignation_client ? 'Masquer les coloris' : 'Voir les coloris'}
              className={cn('group rounded-lg border-l-4 border border-border/60 bg-zinc-100/80 p-3', 'border-l-amber-400/60',
                'cursor-pointer hover:bg-zinc-100 hover:border-accent/40 transition-colors',
                drawerRefId === r.IDdesignation_client && 'ring-1 ring-accent bg-accent/[0.06] border-accent/50')}>
              <div className="flex items-center gap-2">
                <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-amber-400/10"><Tag className="h-3.5 w-3.5 text-amber-600" /></div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 min-w-0">
                    <p className="text-sm font-medium truncate">{r.client_ref || '—'}</p>
                    {r.ref_interne && <Badge variant="outline" className="text-[10px] py-0 flex-shrink-0">{r.ref_interne}</Badge>}
                    {r.unite === 1 && <Badge variant="outline" className="text-[10px] py-0 flex-shrink-0">Kg</Badge>}
                    <div className="flex items-center gap-1.5 ml-auto flex-shrink-0">
                      {!!r.soumettre && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border bg-amber-100 text-amber-800 border-amber-200 whitespace-nowrap">
                          À soumettre
                        </span>
                      )}
                      {r.associees.length > 0 && (
                        <span className="text-[11px] text-muted-foreground tabular-nums flex items-center gap-1" title={`${r.associees.length} référence(s) associée(s)`}>
                          <Link2 className="h-3 w-3" />{r.associees.length}
                        </span>
                      )}
                      <span className="text-[11px] text-muted-foreground tabular-nums flex items-center gap-1">
                        <Palette className="h-3 w-3" />{r.coloris.length}
                      </span>
                      {canEditRefs && <Pencil className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />}
                    </div>
                  </div>
                  {r.designation && <p className="text-[11px] text-muted-foreground truncate">{r.designation}</p>}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
      {drawerOpen && drawerRef && (
        <div className="flex-1 min-h-0 flex flex-col mx-1 rounded-lg border border-border/60 overflow-hidden bg-zinc-50/80 animate-in slide-in-from-bottom-4 fade-in-0 duration-200">
          <ColorisDrawer
            refItem={drawerRef}
            tarifEditable={isEditing && canManageTarifs}
            onAddColoris={canAddColoris ? () => setAddColorisRefId(drawerRef.IDdesignation_client) : undefined}
            onClose={() => setDrawerRefId(null)}
            onOpenTarif={(c) => setTarif({ rccId: c.IDref_client_colori, label: `${drawerRef.client_ref} · ${c.label}` })}
            onOpenTarifMode={(c) => setTarifMode({ coloris: c, label: `${drawerRef.client_ref} · ${c.label}` })}
          />
        </div>
      )}
      {canEditRefs && (
        <div className="flex-shrink-0 mx-1">
          <Button variant="ghost" size="sm" className="w-full text-muted-foreground hover:text-foreground" onClick={() => setSettings({ refId: null })}>
            <Plus className="h-4 w-4 mr-1.5" />Ajouter une référence
          </Button>
        </div>
      )}
      <AddColorisDialog
        open={addColorisRefId !== null}
        refItem={addColorisRefId !== null ? (data ?? []).find((r) => r.IDdesignation_client === addColorisRefId) ?? null : null}
        clientId={clientId}
        canManageTarifs={canManageTarifs}
        onClose={() => setAddColorisRefId(null)} />
      <TarifDialog open={tarif !== null} onClose={() => setTarif(null)} clientId={clientId} rccId={tarif?.rccId ?? 0} label={tarif?.label ?? ''} />
      <TarifModeDialog open={tarifMode !== null} onClose={() => setTarifMode(null)} clientId={clientId} target={tarifMode} />
      <RefSettingsDialog open={settings !== null} existing={settingsExisting} clientId={clientId} onClose={() => setSettings(null)}
        canManageTarifs={canManageTarifs}
        onOpenTarif={(c, label) => setTarif({ rccId: c.IDref_client_colori, label })}
        onOpenTarifMode={(c, label) => setTarifMode({ coloris: c, label })} />
    </>
  )
}

// ── Coloris drawer (§31 in-screen contained drawer, slides up under the ref list) ──

function ColorisDrawer({ refItem, tarifEditable, onAddColoris, onClose, onOpenTarif, onOpenTarifMode }: {
  refItem: ClientReference
  tarifEditable: boolean
  /** Provided only for gestion_coloris users (§ add-a-coloris permission) — opens AddColorisDialog. */
  onAddColoris?: () => void
  onClose: () => void
  onOpenTarif: (c: RefColoris) => void
  onOpenTarifMode: (c: RefColoris) => void
}) {
  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden bg-zinc-100/80">
      {/* Minimal top strip: the selected ref card is highlighted right above (§31.4). */}
      <div className="flex-shrink-0 px-2 py-1 border-b bg-zinc-200/50 flex items-center justify-between">
        <span className="pl-1 text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
          Coloris ({refItem.coloris.length})
        </span>
        <Button variant="ghost" size="icon" onClick={onClose} className="h-7 w-7" title="Fermer">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 scrollbar-transparent">
        {refItem.coloris.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">
            Aucun coloris disponible pour cette référence{tarifEditable && !onAddColoris ? ' - ajoutez-en via le crayon de la référence' : ''}
          </p>
        ) : (
          <div className="grid grid-cols-2 xl:grid-cols-3 gap-2">
            {refItem.coloris.map((c) => {
              const priceable = refItem.IDref_fini > 0 && c.coloris_id > 0
              return (
                <button key={c.IDref_client_colori} type="button" disabled={!priceable}
                  onClick={() => { if (priceable) (tarifEditable ? onOpenTarifMode(c) : onOpenTarif(c)) }}
                  title={priceable ? (tarifEditable ? 'Modifier le tarif' : 'Voir le tarif') : undefined}
                  className={cn('group flex items-center gap-2 rounded-lg border bg-card shadow-sm p-2.5 text-left transition-colors',
                    priceable ? 'hover:border-accent/50 cursor-pointer' : 'opacity-60 cursor-default')}>
                  <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-accent/10">
                    <Palette className="h-3.5 w-3.5 text-accent" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{c.label || '—'}</p>
                    <div className="mt-0.5">
                      {c.tarif_mode === 'standard'
                        ? <span className="text-[10px] text-muted-foreground">Tarif standard</span>
                        : <TarifModeTag c={c} />}
                    </div>
                  </div>
                  {priceable && (tarifEditable
                    ? <Pencil className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                    : <BadgeEuro className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />)}
                </button>
              )
            })}
          </div>
        )}
      </div>
      {onAddColoris && (
        <div className="flex-shrink-0 p-2 border-t bg-zinc-200/50">
          <Button variant="ghost" size="sm" className="w-full text-muted-foreground hover:text-foreground" onClick={onAddColoris}>
            <Plus className="h-4 w-4 mr-1.5" />Ajouter un coloris
          </Button>
        </div>
      )}
    </div>
  )
}

// ── Ajouter un coloris (gestion_coloris) ───────────────────────────
// Restricted path for users who may extend a ref's coloris list but can't edit
// the reference or its tarifs. The new coloris has to inherit the terms already
// in force, so the ref must be uniform: every coloris on tarif standard, all
// sharing the same visible tranches. When it isn't, the dialog explains that a
// tarif manager has to do it. Mirrored server-side in POST
// /clients/:id/references/:did/coloris — this is UX, not the security boundary.

/** Normalised, comparable form of an rcc lst_tranche ("" → the 0..6 default). */
function trancheSignature(raw: string): string {
  const idx = [...new Set(
    String(raw ?? '').split(',').map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 8),
  )].sort((a, b) => a - b)
  return idx.length === 0 ? '0,1,2,3,4,5,6' : idx.join(',')
}

/** Human recap of a tranche signature, e.g. "< 1 · 1 · 2 · 3 · 4 · 5 · 10 rouleaux". */
function trancheSummary(signature: string): string {
  const labels = signature.split(',')
    .map((s) => TRANCHE_NB_VALUES[parseInt(s, 10)])
    .filter((v) => v !== undefined)
    .map((v) => (v === 0 ? '< 1' : String(v)))
  return labels.length === 0 ? '—' : `${labels.join(' · ')} rouleaux`
}

/** The single set of terms shared by every coloris of a ref, or null when they diverge. */
function sharedStandardTerms(coloris: RefColoris[]): string | null {
  if (coloris.length === 0) return '0,1,2,3,4,5,6'
  if (coloris.some((c) => c.tarif_mode !== 'standard')) return null
  const signatures = new Set(coloris.map((c) => trancheSignature(c.lst_tranche)))
  return signatures.size === 1 ? [...signatures][0] : null
}

function AddColorisDialog({ open, refItem, clientId, canManageTarifs, onClose }: {
  open: boolean
  refItem: ClientReference | null
  clientId: number
  canManageTarifs: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const [checked, setChecked] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)
  // Blocked path: an explicit "Prévenir le responsable" click, never an
  // automatic send on dialog open — one email per real request.
  const [note, setNote] = useState('')
  const [demande, setDemande] = useState<{ subscribers: number; notified: number } | null>(null)

  const refId = refItem ? (refItem.IDref_fini > 0 ? refItem.IDref_fini : refItem.IDref_ecru) : 0
  const isFini = (refItem?.IDref_fini ?? 0) > 0
  const did = refItem?.IDdesignation_client ?? 0

  useEffect(() => {
    if (!open) return
    setChecked(new Set())
    setError(null)
    setNote('')
    setDemande(null)
  }, [open, did])

  const colorisQ = useQuery<Array<{ id?: number; IDcolori_ecru?: number; reference: string }>>({
    queryKey: ['lookup-ref-coloris', isFini ? 'ennobli' : 'tm', refId],
    queryFn: () => isFini
      ? apiFetch(`/commandes-client/lookups/colori-fini?ref_fini=${refId}`)
      : apiFetch(`/commandes-client/lookups/colori-ecru?ref_ecru=${refId}`),
    enabled: open && refId > 0,
  })

  // Terms the new coloris will inherit. A tarif manager isn't blocked by a
  // divergent ref — they can set the tarif afterwards.
  const sharedTerms = refItem ? sharedStandardTerms(refItem.coloris) : null
  const blocked = !canManageTarifs && sharedTerms === null

  const linked = new Set((refItem?.coloris ?? []).map((c) => c.coloris_id).filter((x) => x > 0))
  const available = (colorisQ.data ?? [])
    .map((c) => ({ id: c.id ?? c.IDcolori_ecru ?? 0, label: c.reference }))
    .filter((c) => c.id > 0 && !linked.has(c.id))

  const demandeMut = useMutation({
    mutationFn: () => apiFetch<{ subscribers: number; notified: number }>(
      `/clients/${clientId}/references/${did}/coloris/demande`,
      { method: 'POST', body: JSON.stringify({ coloris: [...checked], note: note.trim() }) },
    ),
    onSuccess: (r) => setDemande(r),
    onError: () => setDemande({ subscribers: 0, notified: 0 }),
  })

  const saveMut = useMutation({
    mutationFn: () => apiFetch(`/clients/${clientId}/references/${did}/coloris`, {
      method: 'POST',
      body: JSON.stringify({ coloris: [...checked] }),
    }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-references', clientId] })
      onClose()
    },
    onError: (e: unknown) => {
      // The API re-checks the same rule; a 403 here means the ref diverged
      // between load and save.
      const status = (e as { status?: number } | null)?.status
      setError(status === 403
        ? 'Merci de demander à un utilisateur ayant le droit d’éditer les tarifs pour ajouter ce coloris.'
        : e instanceof Error ? e.message : 'Erreur lors de l’enregistrement')
    },
  })

  return (
    <Dialog open={open} onOpenChange={() => onClose()}>
      <DialogContent className="max-w-md max-h-[85vh] flex flex-col" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Palette className="h-5 w-5 text-accent" />
            Ajouter un coloris{refItem ? ` - ${refItem.client_ref}` : ''}
          </DialogTitle>
        </DialogHeader>

        <div className="mt-4 flex-1 min-h-0 overflow-y-auto scrollbar-transparent px-1 space-y-3">
          {blocked ? (
            <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg border border-amber-500/25 bg-amber-500/10 text-amber-800">
              <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-xs font-semibold">
                  Merci de demander à un utilisateur ayant le droit d’éditer les tarifs pour ajouter ce coloris.
                </p>
                <p className="text-[11px] mt-1 text-amber-800/80">
                  Les coloris de cette référence n’ont pas tous le même tarif standard avec les mêmes tranches - il n’y a
                  pas de conditions uniques à reprendre pour un nouveau coloris.
                </p>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-border/60 bg-white shadow-sm">
              <BadgeEuro className="h-3.5 w-3.5 text-accent flex-shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-xs font-semibold">Conditions appliquées</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Tarif standard · {trancheSummary(sharedTerms ?? '0,1,2,3,4,5,6')}
                </p>
              </div>
            </div>
          )}

          {/* The checklist stays live when blocked: picking the coloris is what
              makes the request to the responsable actionable. */}
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              {blocked ? 'Coloris souhaités' : 'Coloris à ajouter'}
              {available.length > 0 && ` (${[...checked].filter((id) => available.some((c) => c.id === id)).length}/${available.length})`}
            </label>
            <CheckList items={available}
              isChecked={(id) => checked.has(id)}
              onToggle={(id) => setChecked((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })}
              emptyText="Tous les coloris du catalogue sont déjà attribués à cette référence"
              isLoading={colorisQ.isLoading} />
          </div>

          {blocked && demande === null && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Note pour le responsable (facultatif)</label>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2}
                placeholder="Ex : commande client à saisir cette semaine"
                className="w-full rounded-md border border-input bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-y" />
            </div>
          )}

          {demande !== null && (
            <div className={cn('flex items-start gap-2 px-3 py-2.5 rounded-lg border text-xs font-medium',
              demande.notified > 0
                ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-800'
                : 'border-amber-500/30 bg-amber-500/10 text-amber-800')}>
              {demande.notified > 0
                ? <Check className="h-4 w-4 flex-shrink-0 mt-0.5" />
                : <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />}
              <span>
                {demande.notified > 0
                  ? 'Un email a été envoyé au responsable.'
                  : demande.subscribers === 0
                    ? 'Aucun responsable n’est abonné à ces notifications. Prévenez directement une personne pouvant éditer les tarifs.'
                    : 'L’envoi de l’email a échoué. Prévenez directement une personne pouvant éditer les tarifs.'}
              </span>
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>{blocked ? 'Fermer' : 'Annuler'}</Button>
          {blocked ? (
            demande === null && (
              <Button onClick={() => demandeMut.mutate()} disabled={demandeMut.isPending}>
                <AtSign className="h-3.5 w-3.5 mr-1.5" />
                {demandeMut.isPending ? 'Envoi...' : 'Prévenir le responsable'}
              </Button>
            )
          ) : (
            <Button onClick={() => saveMut.mutate()} disabled={checked.size === 0 || saveMut.isPending}>
              {saveMut.isPending ? 'Ajout...' : 'Ajouter'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Référence client settings dialog (create / edit, mirrors the legacy "Référence client" window) ──

interface RefFiniLookup { IDref_fini: number; reference: string; designation: string; avec_teinture: number }
interface RefEcruLookup { IDref_ecru: number; reference: string; designation: string }
interface CompoFil { IDref_fil: number; reference: string }

/** Two-option segmented control for small exclusive choices (Finition, Unité). */
function SegmentedPair<T extends string | number>({ options, value, onChange }: {
  options: { value: T; label: string }[]; value: T; onChange: (v: T) => void
}) {
  return (
    <div className="flex gap-1">
      {options.map((o) => (
        <button key={String(o.value)} type="button" onClick={() => onChange(o.value)}
          className={cn('flex-1 px-3 py-1.5 text-xs rounded-md transition-colors whitespace-nowrap',
            value === o.value
              ? 'bg-accent text-accent-foreground shadow-sm font-medium'
              : 'bg-zinc-100 text-muted-foreground hover:bg-accent/10')}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function CheckList({ items, isChecked, onToggle, emptyText, isLoading }: {
  items: { id: number; label: string }[]
  isChecked: (id: number) => boolean
  onToggle: (id: number) => void
  emptyText: string
  isLoading: boolean
}) {
  if (isLoading) return <SectionSpinner />
  if (items.length === 0) return <p className="text-xs text-muted-foreground italic py-1">{emptyText}</p>
  return (
    <div className="max-h-44 overflow-y-auto scrollbar-transparent rounded-md border border-input bg-background p-1 space-y-0.5">
      {items.map((it) => (
        <label key={it.id} className="flex items-center gap-2 px-2 py-1 text-sm cursor-pointer hover:bg-accent/5 rounded select-none">
          <input type="checkbox" checked={isChecked(it.id)} onChange={() => onToggle(it.id)}
            className="h-4 w-4 rounded border-input text-accent focus:ring-2 focus:ring-ring cursor-pointer flex-shrink-0" />
          <span className="truncate">{it.label || '—'}</span>
        </label>
      ))}
    </div>
  )
}

// Tarifs tab of the settings dialog: the saved coloris of the ref with their
// tarif mode — the entry point to the tarif-mode editor (standard / coefficient
// / contrat) now that edit mode no longer opens the coloris drawer.
function RefTarifsTab({ refItem, draftColoris, canManageTarifs, onOpenTarif, onOpenTarifMode }: {
  refItem: ClientReference
  /** The Informations tab's in-progress coloris selection — used only to flag unsaved changes. */
  draftColoris: Set<number>
  canManageTarifs: boolean
  onOpenTarif: (c: RefColoris, label: string) => void
  onOpenTarifMode: (c: RefColoris, label: string) => void
}) {
  // Tarifs hang off ref_client_colori rows, which exist only after Enregistrer.
  const savedIds = new Set(refItem.coloris.map((c) => c.coloris_id).filter((x) => x > 0))
  const draftDiffers = draftColoris.size !== savedIds.size || [...draftColoris].some((id) => !savedIds.has(id))

  if (refItem.IDref_fini === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
        <BadgeEuro className="h-10 w-10 mb-3 opacity-40" />
        <p className="text-sm">Les tarifs ne sont disponibles que pour les références ennoblies.</p>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {draftDiffers && (
        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/25 bg-amber-500/10 text-amber-800 text-xs font-medium">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
          <span>Les modifications de coloris de l’onglet Informations n’apparaîtront ici qu’après enregistrement.</span>
        </div>
      )}
      {refItem.coloris.length === 0 ? (
        <p className="text-sm text-muted-foreground italic py-2">Aucun coloris enregistré pour cette référence.</p>
      ) : refItem.coloris.map((c) => {
        const priceable = c.coloris_id > 0
        const label = `${refItem.client_ref} · ${c.label}`
        return (
          <button key={c.IDref_client_colori} type="button" disabled={!priceable}
            onClick={() => { if (priceable) (canManageTarifs ? onOpenTarifMode(c, label) : onOpenTarif(c, label)) }}
            title={priceable ? (canManageTarifs ? 'Modifier le tarif' : 'Voir le tarif') : 'Tarif indisponible pour ce coloris'}
            className={cn('group w-full flex items-center gap-2 rounded-lg border bg-card shadow-sm p-2.5 text-left transition-colors',
              priceable ? 'hover:border-accent/50 cursor-pointer' : 'opacity-60 cursor-default')}>
            <div className="h-7 w-7 rounded-md flex items-center justify-center flex-shrink-0 bg-accent/10">
              <Palette className="h-3.5 w-3.5 text-accent" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">{c.label || '—'}</p>
              <div className="mt-0.5">
                {c.tarif_mode === 'standard'
                  ? <span className="text-[10px] text-muted-foreground">Tarif standard</span>
                  : <TarifModeTag c={c} />}
              </div>
            </div>
            {priceable && (canManageTarifs
              ? <Pencil className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
              : <BadgeEuro className="h-3.5 w-3.5 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />)}
          </button>
        )
      })}
    </div>
  )
}

function RefSettingsDialog({ open, existing, clientId, onClose, canManageTarifs, onOpenTarif, onOpenTarifMode }: {
  open: boolean; existing: ClientReference | null; clientId: number; onClose: () => void
  canManageTarifs: boolean
  /** Open the read-only tarif breakdown / the tarif-mode editor for a saved coloris (stacks over this dialog). */
  onOpenTarif: (c: RefColoris, label: string) => void
  onOpenTarifMode: (c: RefColoris, label: string) => void
}) {
  const queryClient = useQueryClient()
  const isNew = existing === null
  const [tab, setTab] = useState<'infos' | 'tarifs'>('infos')
  const [nom, setNom] = useState('')
  const [finition, setFinition] = useState<'tm' | 'ennobli'>('ennobli')
  const [refId, setRefId] = useState(0)
  const [unite, setUnite] = useState<1 | 3>(3)
  const [soumettre, setSoumettre] = useState(false)
  const [checkedColoris, setCheckedColoris] = useState<Set<number>>(new Set())
  // Inverted like the legacy storage: the set holds yarns NOT invoiced (unchecked).
  const [uncheckedFils, setUncheckedFils] = useState<Set<number>>(new Set())
  // Associated refs (IDref_fini) linked to this client ref — e.g. the cote
  // always ordered (and dyed) along with a molleton.
  const [checkedAssociees, setCheckedAssociees] = useState<Set<number>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const originalRefId = existing ? (existing.IDref_fini > 0 ? existing.IDref_fini : existing.IDref_ecru) : 0

  // Hydrate on open (and when switching between create / different refs).
  // Keyed on the ref ID, not the object: `existing` is derived from the live
  // client-references query, so a tarif-mode save from the Tarifs tab produces
  // a fresh object for the same ref — re-hydrating then would clobber the
  // in-progress Informations draft.
  const existingId = existing?.IDdesignation_client ?? null
  useEffect(() => {
    if (!open) return
    setTab('infos')
    setError(null)
    if (existing) {
      setNom(existing.client_ref)
      setFinition(existing.IDref_ecru > 0 ? 'tm' : 'ennobli')
      setRefId(existing.IDref_fini > 0 ? existing.IDref_fini : existing.IDref_ecru)
      setUnite(existing.unite === 1 ? 1 : 3)
      setSoumettre(!!existing.soumettre)
      setCheckedColoris(new Set(existing.coloris.map((c) => c.coloris_id).filter((x) => x > 0)))
      setUncheckedFils(new Set(existing.fil_non_facture))
      setCheckedAssociees(new Set(existing.associees))
    } else {
      setNom(''); setFinition('ennobli'); setRefId(0); setUnite(3); setSoumettre(false)
      setCheckedColoris(new Set()); setUncheckedFils(new Set()); setCheckedAssociees(new Set())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existingId])

  const finiQ = useQuery<RefFiniLookup[]>({
    queryKey: ['lookup-refs-fini'],
    queryFn: () => apiFetch('/commandes-client/lookups/refs-fini'),
    enabled: open && finition === 'ennobli',
  })
  const ecruQ = useQuery<RefEcruLookup[]>({
    queryKey: ['lookup-refs-ecru'],
    queryFn: () => apiFetch('/commandes-client/lookups/refs-ecru'),
    enabled: open && finition === 'tm',
  })
  const colorisQ = useQuery<Array<{ id?: number; IDcolori_ecru?: number; reference: string }>>({
    queryKey: ['lookup-ref-coloris', finition, refId],
    queryFn: () => finition === 'ennobli'
      ? apiFetch(`/commandes-client/lookups/colori-fini?ref_fini=${refId}`)
      : apiFetch(`/commandes-client/lookups/colori-ecru?ref_ecru=${refId}`),
    enabled: open && refId > 0,
  })
  const filsQ = useQuery<CompoFil[]>({
    queryKey: ['lookup-compo-fils', finition, refId],
    queryFn: () => apiFetch(`/clients/lookups/composition-fils?${finition === 'ennobli' ? 'ref_fini' : 'ref_ecru'}=${refId}`),
    enabled: open && refId > 0,
  })
  // Candidates come from the ref-to-ref association defined in Finis › Références
  // (ref_fini.associee) — only fini refs can have associated refs.
  const associeesQ = useQuery<RefAssocieeLookup[]>({
    queryKey: ['lookup-refs-associees', refId],
    queryFn: () => apiFetch(`/clients/lookups/refs-associees?ref_fini=${refId}`),
    enabled: open && finition === 'ennobli' && refId > 0,
  })
  const coloris = (colorisQ.data ?? []).map((c) => ({ id: c.id ?? c.IDcolori_ecru ?? 0, label: c.reference }))
  const fils = filsQ.data ?? []
  const associables = finition === 'ennobli' ? (associeesQ.data ?? []) : []

  // Picking a different internal ref resets the per-ref selections (back to the
  // saved ones when returning to the original ref).
  const handleRefChange = useCallback((id: number) => {
    setRefId(id)
    if (existing && id === originalRefId) {
      setCheckedColoris(new Set(existing.coloris.map((c) => c.coloris_id).filter((x) => x > 0)))
      setUncheckedFils(new Set(existing.fil_non_facture))
      setCheckedAssociees(new Set(existing.associees))
    } else {
      setCheckedColoris(new Set())
      setUncheckedFils(new Set())
      setCheckedAssociees(new Set())
    }
  }, [existing, originalRefId])
  const handleFinitionChange = useCallback((f: 'tm' | 'ennobli') => {
    if (f === finition) return
    setFinition(f)
    const originalIsTm = existing !== null && existing.IDref_ecru > 0
    handleRefChange(existing && ((f === 'tm') === originalIsTm) ? originalRefId : 0)
  }, [finition, existing, originalRefId, handleRefChange])

  const saveMut = useMutation({
    mutationFn: () => {
      const body = {
        designation: nom.trim(),
        IDref_fini: finition === 'ennobli' ? refId : 0,
        IDref_ecru: finition === 'tm' ? refId : 0,
        soumettre,
        unite,
        // Keep only yarns still in the ref's composition (stale ids drop off).
        fil_non_facture: [...uncheckedFils].filter((id) => fils.length === 0 || fils.some((f) => f.IDref_fil === id)),
        coloris: [...checkedColoris],
        // Same stale-drop rule against the catalog's current association list.
        associees: finition === 'ennobli'
          ? [...checkedAssociees].filter((id) => associables.length === 0 || associables.some((a) => a.IDref_fini === id))
          : [],
      }
      return isNew
        ? apiFetch(`/clients/${clientId}/references`, { method: 'POST', body: JSON.stringify(body) })
        : apiFetch(`/clients/${clientId}/references/${existing.IDdesignation_client}`, { method: 'PUT', body: JSON.stringify(body) })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-references', clientId] })
      onClose()
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Erreur lors de l\'enregistrement'),
  })

  const canSave = nom.trim().length > 0 && refId > 0 && !saveMut.isPending

  return (
    <Dialog open={open} onOpenChange={() => onClose()}>
      <DialogContent className="max-w-xl max-h-[85vh] flex flex-col" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Tag className="h-5 w-5 text-accent" />
            {isNew ? 'Nouvelle référence client' : `Référence client - ${existing.client_ref}`}
          </DialogTitle>
        </DialogHeader>

        {/* Master tabs (§39 pill style): Informations = the ref form, Tarifs = per-coloris tarif management. */}
        <div className="mt-4 flex-shrink-0 flex items-center gap-1 border-b border-border/60 pb-2">
          <button type="button" onClick={() => setTab('infos')}
            className={cn('flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap',
              tab === 'infos' ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10 hover:text-accent')}>
            <Tag className="h-3.5 w-3.5" />Informations
          </button>
          <button type="button" disabled={isNew} onClick={() => setTab('tarifs')}
            title={isNew ? 'Enregistrez d’abord la référence' : undefined}
            className={cn('flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap',
              tab === 'tarifs' ? 'bg-accent text-accent-foreground shadow-sm' : 'text-muted-foreground hover:bg-accent/10 hover:text-accent',
              isNew && 'opacity-50 cursor-not-allowed hover:bg-transparent hover:text-muted-foreground')}>
            <BadgeEuro className="h-3.5 w-3.5" />Tarifs
          </button>
        </div>

        <div className="mt-3 flex-1 min-h-0 overflow-y-auto scrollbar-transparent px-1 space-y-3">
          {tab === 'tarifs' && existing !== null ? (
            <RefTarifsTab refItem={existing} draftColoris={checkedColoris} canManageTarifs={canManageTarifs}
              onOpenTarif={onOpenTarif} onOpenTarifMode={onOpenTarifMode} />
          ) : (
          <>
          <LabeledInput label="Nom commercial" value={nom} onChange={setNom} autoFocus={isNew} />
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Finition</label>
              <SegmentedPair options={[{ value: 'tm', label: 'Tombé de métier' }, { value: 'ennobli', label: 'Ennobli' }]}
                value={finition} onChange={handleFinitionChange} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Unité</label>
              <SegmentedPair options={[{ value: 3 as const, label: 'Ml' }, { value: 1 as const, label: 'Kg' }]}
                value={unite} onChange={setUnite} />
            </div>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Référence interne</label>
            {finition === 'ennobli' ? (
              <SearchableCombobox
                options={finiQ.data ?? []}
                value={refId}
                onChange={handleRefChange}
                getId={(r: RefFiniLookup) => r.IDref_fini}
                getPrimary={(r: RefFiniLookup) => r.reference}
                getSecondary={(r: RefFiniLookup) => r.designation}
                placeholder="Rechercher une référence finie"
                loading={finiQ.isLoading}
              />
            ) : (
              <SearchableCombobox
                options={ecruQ.data ?? []}
                value={refId}
                onChange={handleRefChange}
                getId={(r: RefEcruLookup) => r.IDref_ecru}
                getPrimary={(r: RefEcruLookup) => r.reference}
                getSecondary={(r: RefEcruLookup) => r.designation}
                placeholder="Rechercher une référence écrue"
                loading={ecruQ.isLoading}
              />
            )}
          </div>

          {/* Soumission toggle (§35 pill) */}
          <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border border-border/60 bg-white shadow-sm">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 text-xs font-semibold">
                <Send className="h-3.5 w-3.5 text-accent" />
                <span>Soumission</span>
              </div>
              <p className="text-[10px] text-muted-foreground mt-0.5">Soumettre une tirelle au client avant réception</p>
            </div>
            <button type="button" role="switch" aria-checked={soumettre} onClick={() => setSoumettre(!soumettre)}
              className={cn('relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors',
                'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                soumettre ? 'bg-accent shadow-inner' : 'bg-zinc-300 hover:bg-zinc-400/80')}>
              <span className={cn('inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ease-out',
                soumettre ? 'translate-x-[18px]' : 'translate-x-0.5')} />
            </button>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">
              Coloris disponibles pour le client{coloris.length > 0 && ` (${[...checkedColoris].filter((id) => coloris.some((c) => c.id === id)).length}/${coloris.length})`}
            </label>
            {refId === 0 ? <p className="text-xs text-muted-foreground italic py-1">Sélectionnez d'abord une référence interne</p> : (
              <CheckList items={coloris.map((c) => ({ id: c.id, label: c.label }))}
                isChecked={(id) => checkedColoris.has(id)}
                onToggle={(id) => setCheckedColoris((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })}
                emptyText="Aucun coloris dans le catalogue de cette référence"
                isLoading={colorisQ.isLoading} />
            )}
          </div>

          {/* Associated refs (legacy "référence associée" list): shown only when the
              catalog defines associations for the selected fini ref. Checking one
              links it to this client ref — it shares the parent's tranche de tarif
              (dyed together) and order entry can remind the customer to order it. */}
          {finition === 'ennobli' && refId > 0 && (associeesQ.isLoading || associables.length > 0) && (
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Références associées{associables.length > 0 && ` (${[...checkedAssociees].filter((id) => associables.some((a) => a.IDref_fini === id)).length}/${associables.length})`}
              </label>
              <CheckList items={associables.map((a) => ({ id: a.IDref_fini, label: a.designation ? `${a.reference} · ${a.designation}` : a.reference }))}
                isChecked={(id) => checkedAssociees.has(id)}
                onToggle={(id) => setCheckedAssociees((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })}
                emptyText="Aucune référence associée dans le catalogue"
                isLoading={associeesQ.isLoading} />
            </div>
          )}

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Fils facturés au client</label>
            {refId === 0 ? <p className="text-xs text-muted-foreground italic py-1">Sélectionnez d'abord une référence interne</p> : (
              <CheckList items={fils.map((f) => ({ id: f.IDref_fil, label: f.reference }))}
                isChecked={(id) => !uncheckedFils.has(id)}
                onToggle={(id) => setUncheckedFils((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })}
                emptyText="Aucun fil dans la composition de cette référence"
                isLoading={filsQ.isLoading} />
            )}
          </div>
          </>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={() => saveMut.mutate()} disabled={!canSave}>
            {saveMut.isPending ? 'Enregistrement...' : 'Enregistrer'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Tarif dialog (PrixDeVente breakdown, client tarif mode aware) ──

interface TarifDetailLine { label: string; valueKg: number }
interface TarifTranche {
  rolls: number; isMetrage: boolean; qte_ml: number; poids_ref: number
  moFil: number; detailFil: TarifDetailLine[]
  moTricotage: number; detailTricotage: TarifDetailLine | null
  moTraitements: number; detailTraitement: TarifDetailLine[]
  moTeinte: number; detailTeinture: TarifDetailLine | null
  moRevient: number; rCoeff: number; tauxFraisDePort: number
  moPortAuKg: number; moPortAuMl: number; moPrixDeVenteAuKg: number; moPrixDeVenteAuMl: number
  prixContrat: number | null
}
interface TarifResult {
  IDref_fini: number; IDcoloris: number; avec_teinture: number; rendement: number; tranches: TarifTranche[]
  tranche_idx: number[]
  tarif_mode: TarifMode; coefficient: number; contrats: ContratTarif[]; contrat_actif: ContratTarif | null; contrat_expire: boolean
}

function CostSection({ title, total, children }: { title: string; total?: string; children?: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold">{title}</p>
        {total && <p className="text-xs font-semibold tabular-nums">{total}</p>}
      </div>
      {children && <div className="mt-1 space-y-0.5 pl-2 border-l border-border/50">{children}</div>}
    </div>
  )
}
function CostLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11px] text-muted-foreground">
      <span className="min-w-0">{label}</span>
      <span className="tabular-nums flex-shrink-0">{value}</span>
    </div>
  )
}

/** §35 toggle-pill row for one negotiated tranche (15 / 30 rouleaux). */
function TrancheToggleRow({ label, tranche, value, onChange, disabled }: {
  label: string; tranche: TarifTranche | null; value: boolean; onChange: (v: boolean) => void; disabled: boolean
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-lg border border-border/60 bg-white shadow-sm">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold">{label}</p>
        <p className="text-[10px] text-muted-foreground mt-0.5">
          {tranche ? `${fmtNum(tranche.qte_ml)} Ml · ${fmtNum(tranche.moPrixDeVenteAuMl, 2)} €/Ml` : '—'}
          {' · '}{value ? 'proposée au client' : 'non proposée'}
        </p>
      </div>
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
        <span className={cn(
          'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-200 ease-out',
          value ? 'translate-x-[18px]' : 'translate-x-0.5',
        )} />
      </button>
    </div>
  )
}

function TarifDialog({ open, onClose, clientId, rccId, label }: {
  open: boolean; onClose: () => void; clientId: number; rccId: number; label: string
}) {
  const [selectedTranche, setSelectedTranche] = useState(0)
  useEffect(() => { if (open) setSelectedTranche(0) }, [open, rccId])
  const { data, isLoading, isError } = useQuery<TarifResult>({
    queryKey: ['client-tarif', clientId, rccId],
    queryFn: () => apiFetch(`/clients/${clientId}/coloris/${rccId}/tarif`),
    enabled: open && rccId > 0,
  })
  // Contrat mode (active contract): the user only ever buys at the negotiated
  // prices — show exclusively the contracted tranches, like the legacy Tarifs
  // tab. Standard rows only reappear when the contract has expired (fallback).
  // Otherwise, honor lst_tranche: the 15/30 rlx rows only show when negotiated.
  const allTranches = data?.tranches ?? []
  const enabledIdx = data?.tranche_idx ?? [0, 1, 2, 3, 4, 5, 6]
  const tranches = data?.tarif_mode === 'contrat' && data.contrat_actif
    ? allTranches.filter((t) => t.prixContrat != null)
    : allTranches.filter((_, i) => enabledIdx.includes(i))
  const current = tranches[Math.min(selectedTranche, Math.max(tranches.length - 1, 0))] ?? null
  const eurKg = (v: number) => `${fmtNum(v, 2)} €/Kg`
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><BadgeEuro className="h-5 w-5 text-accent" /><span className="truncate">Tarif — {label}</span></DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-3 max-h-[70vh] overflow-y-auto pr-1 scrollbar-transparent">
          {isLoading ? <SectionSpinner /> : isError ? <p className="text-sm text-destructive">Erreur lors du calcul du tarif.</p>
          : data?.tarif_mode === 'contrat' && data.contrat_expire ? (
            // Expired contract: the negotiated prices are gone and the ref is
            // simply not sellable until a new contract is signed — never fall
            // back to the standard tarif here. The old contract stays readable
            // below so it can serve as the base for a renewal (Dupliquer).
            <>
              <div className="flex items-start gap-2 px-3 py-2.5 rounded-lg border border-red-500/25 bg-red-500/10 text-red-700 text-xs font-medium">
                <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
                <span>
                  Contrat expiré{data.contrats[0]?.date_expiration ? ` depuis le ${formatHfsqlDate(data.contrats[0].date_expiration)}` : ''} —
                  cette référence n’est plus disponible tant qu’un nouveau contrat n’a pas été établi.
                </span>
              </div>
              {data.contrats[0] && (
                <div className="rounded-lg border border-border/60 overflow-hidden bg-card shadow-sm">
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-border/40 text-xs font-medium text-muted-foreground">
                    <FileSignature className="h-3.5 w-3.5 flex-shrink-0" />
                    Contrat du {formatHfsqlDate(data.contrats[0].date_debut)} au {formatHfsqlDate(data.contrats[0].date_expiration)}
                    <span className="text-[9px] font-semibold px-1 rounded bg-red-500/10 text-red-700 border border-red-500/25">expiré</span>
                  </div>
                  <table className="w-full text-xs" style={{ tableLayout: 'fixed' }}>
                    <colgroup><col style={{ width: '26%' }} /><col style={{ width: '34%' }} /><col style={{ width: '40%' }} /></colgroup>
                    <thead className={thHead}><tr>
                      <th className="px-2 py-1.5 text-left font-semibold">Qté (Rlx)</th>
                      <th className="px-2 py-1.5 text-right font-semibold">Qté (Ml)</th>
                      <th className="px-2 py-1.5 text-right font-semibold">Prix / Ml</th>
                    </tr></thead>
                    <tbody>
                      {data.contrats[0].tranches.map((t) => {
                        const idx = TRANCHE_NB_VALUES.indexOf(t.nb_rouleaux)
                        const qteMl = idx >= 0 ? allTranches[idx]?.qte_ml ?? null : null
                        return (
                          <tr key={t.nb_rouleaux} className="border-b border-border/40 last:border-b-0 text-muted-foreground">
                            <td className="px-2 py-1.5 tabular-nums">{t.nb_rouleaux === 0 ? '< 1' : `${t.nb_rouleaux} et plus`}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{qteMl != null ? `${t.nb_rouleaux === 0 ? '< ' : ''}${fmtNum(qteMl)}` : '—'}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums font-medium">{fmtNum(t.prix, 2)} €</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : tranches.length === 0 ? (
            <p className="text-sm text-muted-foreground italic">Tarif indisponible pour cette référence / ce coloris.</p>
          ) : (
            <>
              {data?.tarif_mode === 'coefficient' && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-sky-500/25 bg-sky-500/10 text-sky-800 text-xs font-medium">
                  <Percent className="h-3.5 w-3.5 flex-shrink-0" />
                  Coefficient fixe : {data.coefficient} (appliqué à toutes les tranches)
                </div>
              )}
              {data?.tarif_mode === 'contrat' && data.contrat_actif && (
                <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 text-emerald-800 text-xs font-medium">
                  <FileSignature className="h-3.5 w-3.5 flex-shrink-0" />
                  Contrat du {formatHfsqlDate(data.contrat_actif.date_debut)} au {formatHfsqlDate(data.contrat_actif.date_expiration)}
                </div>
              )}
              <div className="rounded-lg border border-border/60 overflow-hidden bg-card shadow-sm">
                <table className="w-full text-xs" style={{ tableLayout: 'fixed' }}>
                  <colgroup><col style={{ width: '26%' }} /><col style={{ width: '34%' }} /><col style={{ width: '40%' }} /></colgroup>
                  <thead className={thHead}><tr>
                    <th className="px-2 py-1.5 text-left font-semibold">Qté (Rlx)</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Qté (Ml)</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Prix / Ml</th>
                  </tr></thead>
                  <tbody>
                    {tranches.map((t, i) => (
                      <tr key={i} onClick={() => setSelectedTranche(i)}
                        className={cn('border-b border-border/40 last:border-b-0 cursor-pointer transition-colors', selectedTranche === i ? 'bg-accent/10' : 'hover:bg-accent/5')}>
                        <td className="px-2 py-1.5 tabular-nums">{t.isMetrage ? '< 1' : t.prixContrat != null ? `${t.rolls} et plus` : t.rolls}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums">{t.isMetrage ? '< ' : ''}{fmtNum(t.qte_ml)}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums font-medium">
                          {t.prixContrat != null ? (
                            <span className="inline-flex items-center gap-1.5">
                              <span className="text-[9px] font-semibold px-1 rounded bg-emerald-500/10 text-emerald-700 border border-emerald-500/25">contrat</span>
                              {fmtNum(t.prixContrat, 2)} €
                            </span>
                          ) : (
                            <>{fmtNum(t.moPrixDeVenteAuMl, 2)} €</>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {current && (() => {
                // Contract tranche: legacy computes the "Calcul du Tarif" detail
                // on the 15-roll cost basis (bulk dye/treatment bands, -5%
                // tricotage) — the coefficient is then DERIVED from the fixed
                // contract price against those bulk costs ("Coeff Calculé").
                const isContrat = current.prixContrat != null && (data?.rendement ?? 0) > 0
                const basis = isContrat ? (allTranches.find((t) => !t.isMetrage && t.rolls === 15) ?? current) : current
                const rdt = Math.round((data?.rendement ?? 0) * 100) / 100
                const pvKgContrat = isContrat ? current.prixContrat! * rdt : 0
                const coefDerive = isContrat
                  ? Math.round(100 * (1 - basis.moRevient / (pvKgContrat * (1 - basis.tauxFraisDePort))))
                  : 0
                return (
                <div className="p-3 rounded-lg border bg-card shadow-sm space-y-2.5">
                  <CostSection title="Fil" total={eurKg(basis.moFil)}>{basis.detailFil.map((l, i) => <CostLine key={i} label={l.label} value={eurKg(l.valueKg)} />)}</CostSection>
                  <CostSection title="Tricotage" total={eurKg(basis.moTricotage)}>{basis.detailTricotage && <CostLine label={basis.detailTricotage.label} value={eurKg(basis.detailTricotage.valueKg)} />}</CostSection>
                  <CostSection title="Traitement" total={eurKg(basis.moTraitements)}>
                    {basis.detailTraitement.length > 0 ? basis.detailTraitement.map((l, i) => <CostLine key={i} label={l.label} value={eurKg(l.valueKg)} />) : <p className="text-[11px] text-muted-foreground italic">Aucun traitement</p>}
                  </CostSection>
                  {(data?.avec_teinture ?? 0) !== 0 && (
                    <CostSection title="Teinture" total={eurKg(basis.moTeinte)}>{basis.detailTeinture && <CostLine label={basis.detailTeinture.label} value={eurKg(basis.detailTeinture.valueKg)} />}</CostSection>
                  )}
                  <CostSection title="Prix de vente">
                    <CostLine label="Prix de revient au Kg" value={eurKg(basis.moRevient)} />
                    {isContrat ? (
                      <>
                        <CostLine label="Coefficient (calculé du contrat)" value={String(coefDerive)} />
                        <CostLine label={`Prix de vente au Kg · port ${Math.round(basis.tauxFraisDePort * 100)}% inclus`} value={`${fmtNum(pvKgContrat, 2)} €/Kg`} />
                        <CostLine label={`Prix de vente au Ml · port ${Math.round(basis.tauxFraisDePort * 100)}% inclus`} value={`${fmtNum(current.prixContrat!, 2)} €/Ml`} />
                      </>
                    ) : (
                      <>
                        <CostLine label="Coefficient" value={String(Math.round(current.rCoeff * 100))} />
                        <CostLine label={`Prix de vente au Kg · port ${Math.round(current.tauxFraisDePort * 100)}% inclus`} value={`${fmtNum(current.moPrixDeVenteAuKg, 2)} €/Kg`} />
                        <CostLine label={`Prix de vente au Ml · port ${Math.round(current.tauxFraisDePort * 100)}% inclus`} value={`${fmtNum(current.moPrixDeVenteAuMl, 2)} €/Ml`} />
                      </>
                    )}
                  </CostSection>
                </div>
                )
              })()}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// ── Tarif mode dialog (edit mode, permission « gestion_tarifs ») ──
// Switches a référence×coloris between the three legacy tarif modes:
// standard (marge dégressive), coefficient fixe (marge fixe %), contrat
// (prix négociés €/Ml par tranche + dates de validité, renouvellements
// conservés en historique).

const TRANCHE_NB_VALUES = [0, 1, 2, 3, 4, 5, 10, 15, 30]
const TRANCHE_QTY_OPTIONS = TRANCHE_NB_VALUES.map((nb, i) => ({
  id: i + 1,
  primary: nb === 0 ? '< 1 rouleau (métrage)' : nb === 1 ? '1 rouleau' : `${nb} rouleaux`,
}))
const nbToOptionId = (nb: number) => {
  const i = TRANCHE_NB_VALUES.indexOf(nb)
  return i >= 0 ? i + 1 : 2
}
const optionIdToNb = (id: number) => TRANCHE_NB_VALUES[id - 1] ?? 1

interface TrancheDraft { key: number; nb_rouleaux: number; prix: string }

function TarifModeCard({ selected, onSelect, icon: Icon, title, desc, children }: {
  selected: boolean; onSelect: () => void; icon: React.ElementType; title: string; desc: string; children?: React.ReactNode
}) {
  return (
    <div className={cn('rounded-lg border transition-colors', selected ? 'border-accent ring-1 ring-accent bg-accent/5' : 'border-border hover:border-accent/40')}>
      <button type="button" className="w-full text-left p-3 flex items-start gap-2.5" onClick={onSelect}>
        <Icon className="h-4 w-4 mt-0.5 text-accent flex-shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">{desc}</p>
        </div>
        <span className={cn('mt-1 h-3.5 w-3.5 rounded-full border-2 flex-shrink-0', selected ? 'border-accent bg-accent' : 'border-zinc-300')} />
      </button>
      {selected && children && <div className="px-3 pb-3">{children}</div>}
    </div>
  )
}

function TarifModeDialog({ open, onClose, clientId, target }: {
  open: boolean; onClose: () => void; clientId: number
  target: { coloris: RefColoris; label: string } | null
}) {
  const queryClient = useQueryClient()
  const [mode, setMode] = useState<TarifMode>('standard')
  const [coefficient, setCoefficient] = useState('')
  const [contratId, setContratId] = useState<number | null>(null)
  const [dateDebut, setDateDebut] = useState('')
  const [dateExpiration, setDateExpiration] = useState('')
  const [tranches, setTranches] = useState<TrancheDraft[]>([])
  // Negotiated 15/30 rouleaux tranches (lst_tranche indices 7/8) — apply to the
  // standard and coefficient modes only (a contrat rules its own tranches).
  const [t15, setT15] = useState(false)
  const [t30, setT30] = useState(false)
  const initialTranchesRef = useRef({ t15: false, t30: false })
  const [showHistory, setShowHistory] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const keyRef = useRef(0)

  // Hydrate from the coloris' current mode each time the dialog opens.
  useEffect(() => {
    if (!open || !target) return
    const c = target.coloris
    setMode(c.tarif_mode)
    setCoefficient(c.coefficient > 0 ? String(c.coefficient) : '')
    const base = c.contrat_actif ?? c.contrats[0] ?? null
    if (base) {
      setContratId(base.IDcontrat_tarif)
      setDateDebut(hfsqlDateToInput(base.date_debut))
      setDateExpiration(hfsqlDateToInput(base.date_expiration))
      setTranches(base.tranches.map((t) => ({ key: ++keyRef.current, nb_rouleaux: t.nb_rouleaux, prix: String(t.prix) })))
    } else {
      setContratId(null)
      setDateDebut(new Date().toISOString().slice(0, 10))
      setDateExpiration('')
      setTranches([{ key: ++keyRef.current, nb_rouleaux: 1, prix: '' }])
    }
    // Empty lst_tranche = legacy default (base tranches only, no 15/30).
    const idx = c.lst_tranche.split(',').map((s) => parseInt(s, 10))
    const init = { t15: idx.includes(7), t30: idx.includes(8) }
    setT15(init.t15)
    setT30(init.t30)
    initialTranchesRef.current = init
    setShowHistory(false)
    setError(null)
  }, [open, target])

  const rccId = target?.coloris.IDref_client_colori ?? 0
  // Same computation the view dialog shows — here it feeds the Ml / €/Ml info
  // on the 15/30 toggle rows (cache-shared with the view dialog).
  const tarifQ = useQuery<TarifResult>({
    queryKey: ['client-tarif', clientId, rccId],
    queryFn: () => apiFetch(`/clients/${clientId}/coloris/${rccId}/tarif`),
    enabled: open && rccId > 0,
  })
  const allTranches = tarifQ.data?.tranches ?? []
  const saveMut = useMutation({
    mutationFn: async (body: { mode: TarifMode } & Record<string, unknown>) => {
      await apiFetch(`/clients/${clientId}/coloris/${rccId}/tarif-mode`, { method: 'PUT', body: JSON.stringify(body) })
      // The 15/30 toggles ride along for the non-contrat modes.
      const init = initialTranchesRef.current
      if (body.mode !== 'contrat' && (t15 !== init.t15 || t30 !== init.t30)) {
        await apiFetch(`/clients/${clientId}/coloris/${rccId}/tranches`, { method: 'PUT', body: JSON.stringify({ t15, t30 }) })
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['client-references', clientId] })
      queryClient.invalidateQueries({ queryKey: ['client-tarif', clientId, rccId] })
      onClose()
    },
    onError: (err: Error) => setError(err.message || 'Erreur lors de l’enregistrement.'),
  })

  // Start a fresh contract (renewal) — history is kept server-side.
  const startNewContrat = () => {
    setContratId(null)
    setDateDebut(new Date().toISOString().slice(0, 10))
    setDateExpiration('')
  }

  const addTranche = () => {
    const used = new Set(tranches.map((t) => t.nb_rouleaux))
    const next = TRANCHE_NB_VALUES.find((nb) => !used.has(nb)) ?? 1
    setTranches((prev) => [...prev, { key: ++keyRef.current, nb_rouleaux: next, prix: '' }])
  }

  const save = () => {
    if (!target) return
    setError(null)
    if (mode === 'coefficient') {
      const n = parseInt(coefficient, 10)
      if (!Number.isInteger(n) || n < 1 || n > 99) { setError('Coefficient invalide (entier de 1 à 99).'); return }
      saveMut.mutate({ mode, coefficient: n })
      return
    }
    if (mode === 'contrat') {
      if (!dateDebut || !dateExpiration) { setError('Les dates de début et d’expiration sont requises.'); return }
      const d1 = inputDateToHfsql(dateDebut)
      const d2 = inputDateToHfsql(dateExpiration)
      if (d2 <= d1) { setError('La date d’expiration doit être postérieure à la date de début.'); return }
      const rows = tranches
        .map((t) => ({ nb_rouleaux: t.nb_rouleaux, prix: Number(t.prix.replace(',', '.')) }))
        .filter((t) => Number.isFinite(t.prix) && t.prix > 0)
      if (rows.length === 0) { setError('Au moins une tranche avec un prix est requise.'); return }
      if (new Set(rows.map((r) => r.nb_rouleaux)).size !== rows.length) { setError('Chaque quantité de tranche ne peut apparaître qu’une seule fois.'); return }
      saveMut.mutate({ mode, contrat: { date_debut: d1, date_expiration: d2, tranches: rows, ...(contratId ? { IDcontrat_tarif: contratId } : {}) } })
      return
    }
    saveMut.mutate({ mode })
  }

  if (!target) return null
  const pastContrats = target.coloris.contrats.filter((c) => c.IDcontrat_tarif !== contratId)

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-xl" onClose={onClose}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><BadgeEuro className="h-5 w-5 text-accent" /><span className="truncate">Mode de tarification — {target.label}</span></DialogTitle>
        </DialogHeader>
        <div className="mt-4 space-y-2 max-h-[65vh] overflow-y-auto pr-1 scrollbar-transparent">
          <TarifModeCard selected={mode === 'standard'} onSelect={() => setMode('standard')} icon={BadgeEuro}
            title="Standard" desc="Tarif calculé — marge dégressive selon la quantité commandée." />

          <TarifModeCard selected={mode === 'coefficient'} onSelect={() => setMode('coefficient')} icon={Percent}
            title="Coefficient fixe" desc="Marge fixe appliquée à toutes les tranches à la place de la marge dégressive.">
            <div className="flex items-center gap-2 pl-6">
              <label className="text-xs font-medium text-muted-foreground">Coefficient</label>
              <input value={coefficient} onChange={(e) => setCoefficient(e.target.value.replace(/[^0-9]/g, ''))}
                inputMode="numeric" placeholder="20" autoComplete="off"
                className="h-8 w-20 px-2.5 text-sm text-right rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring" />
              <span className="text-xs text-muted-foreground">(marge en % — ex. 20)</span>
            </div>
          </TarifModeCard>

          <TarifModeCard selected={mode === 'contrat'} onSelect={() => setMode('contrat')} icon={FileSignature}
            title="Contrat" desc="Prix négociés au Ml par tranche, valables sur une période définie.">
            <div className="pl-6 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-accent uppercase tracking-wide">
                  {contratId ? 'Contrat en cours' : 'Nouveau contrat'}
                </p>
                {contratId !== null && (
                  <Button variant="ghost" size="sm" className="h-7 text-accent hover:text-accent hover:bg-accent/10" onClick={startNewContrat}>
                    <Plus className="h-3.5 w-3.5 mr-1" />Nouveau contrat
                  </Button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Début</label>
                  <input type="date" value={dateDebut} onChange={(e) => setDateDebut(e.target.value)}
                    className="w-full h-8 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring" />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Expiration</label>
                  <input type="date" value={dateExpiration} onChange={(e) => setDateExpiration(e.target.value)}
                    className="w-full h-8 px-2.5 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring" />
                </div>
              </div>
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">Prix négociés (€/Ml)</p>
                {tranches.map((t) => (
                  <div key={t.key} className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <PopoverSelect size="sm" hideEmpty value={nbToOptionId(t.nb_rouleaux)}
                        onChange={(id) => setTranches((prev) => prev.map((x) => (x.key === t.key ? { ...x, nb_rouleaux: optionIdToNb(id) } : x)))}
                        options={TRANCHE_QTY_OPTIONS} />
                    </div>
                    <input value={t.prix} inputMode="decimal" placeholder="0,00" autoComplete="off"
                      onChange={(e) => setTranches((prev) => prev.map((x) => (x.key === t.key ? { ...x, prix: e.target.value } : x)))}
                      className="h-7 w-24 px-2 text-sm text-right rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring tabular-nums" />
                    <span className="text-xs text-muted-foreground">€/Ml</span>
                    <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive hover:text-destructive"
                      disabled={tranches.length <= 1}
                      onClick={() => setTranches((prev) => prev.filter((x) => x.key !== t.key))}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
                {tranches.length < TRANCHE_NB_VALUES.length && (
                  <Button variant="ghost" size="sm" className="w-full text-muted-foreground hover:text-foreground" onClick={addTranche}>
                    <Plus className="h-4 w-4 mr-1.5" />Ajouter une tranche
                  </Button>
                )}
              </div>
              {pastContrats.length > 0 && (
                <div>
                  <button type="button" onClick={() => setShowHistory(!showHistory)}
                    className="text-xs text-muted-foreground hover:text-foreground transition-colors">
                    {showHistory ? 'Masquer les contrats précédents' : `Afficher les contrats précédents (${pastContrats.length})`}
                  </button>
                  {showHistory && (
                    <div className="mt-1.5 space-y-1">
                      {pastContrats.map((c) => (
                        <div key={c.IDcontrat_tarif} className="flex items-center gap-2 text-[11px] text-muted-foreground px-2 py-1 rounded border border-border/50 bg-zinc-100/60">
                          <CalendarClock className="h-3 w-3 flex-shrink-0" />
                          <span>{formatHfsqlDate(c.date_debut)} → {formatHfsqlDate(c.date_expiration)}</span>
                          <span className="ml-auto tabular-nums">
                            {c.tranches.map((tr) => `${tr.nb_rouleaux === 0 ? '<1' : tr.nb_rouleaux} Rlx : ${fmtNum(tr.prix, 2)} €`).join(' · ')}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </TarifModeCard>

          {/* Negotiated 15/30 rlx tranches — only meaningful when the standard
              table rules the rows (a contrat manages its own tranche grid). */}
          {mode !== 'contrat' && (
            <div className="pt-2 space-y-2">
              <p className="text-xs font-semibold text-accent uppercase tracking-wide">Tranches négociées</p>
              <TrancheToggleRow label="15 rouleaux" tranche={allTranches[7] ?? null} value={t15}
                onChange={setT15} disabled={saveMut.isPending} />
              <TrancheToggleRow label="30 rouleaux" tranche={allTranches[8] ?? null} value={t30}
                onChange={setT30} disabled={saveMut.isPending} />
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-red-500/25 bg-red-500/10 text-red-700 text-xs">
              <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />{error}
            </div>
          )}
        </div>
        <DialogFooter className="mt-4">
          <Button variant="outline" onClick={onClose}>Annuler</Button>
          <Button onClick={save} disabled={saveMut.isPending}>
            <Save className="h-3.5 w-3.5 mr-1.5" />{saveMut.isPending ? 'Enregistrement...' : 'Enregistrer'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Historique des commandes ───────────────────────────

interface HistLigne { IDligne: number; IDcommande_client: number; numero: number; date_commande: string | null; type_kind: number; ref: string; coloris: string; quantite: number; unite: number; prix: number }

function HistoriqueTab({ clientId }: { clientId: number }) {
  const { data, isLoading } = useQuery<{ lignes: HistLigne[]; capped: boolean }>({ queryKey: ['client-historique', clientId], queryFn: () => apiFetch(`/clients/${clientId}/historique`) })
  const lignes = data?.lignes ?? []
  return (
    <>
      {isLoading ? <SectionSpinner /> : lignes.length === 0 ? <SectionEmpty text="Aucune commande" /> : (
        <>
          <div className="rounded-lg border border-border/60 overflow-x-auto bg-card shadow-sm scrollbar-transparent">
            <table className="w-full text-xs">
              <thead className={thHead}><tr>
                <th className="px-2 py-1.5 text-left font-semibold">Date</th>
                <th className="px-2 py-1.5 text-left font-semibold">N°</th>
                <th className="px-2 py-1.5 text-left font-semibold">Référence</th>
                <th className="px-2 py-1.5 text-left font-semibold">Coloris</th>
                <th className="px-2 py-1.5 text-right font-semibold">Qté</th>
                <th className="px-2 py-1.5 text-right font-semibold">Prix</th>
              </tr></thead>
              <tbody>
                {lignes.map((l) => (
                  <tr key={l.IDligne} className="border-b border-border/40 last:border-b-0 hover:bg-accent/5">
                    <td className="px-2 py-1.5 whitespace-nowrap">{l.date_commande && /\d{8}/.test(l.date_commande) ? formatHfsqlDate(l.date_commande) : '—'}</td>
                    <td className="px-2 py-1.5 tabular-nums">{l.numero || '—'}</td>
                    <td className="px-2 py-1.5 truncate max-w-[160px]" title={l.ref}>{l.ref || '—'}</td>
                    <td className="px-2 py-1.5 truncate max-w-[160px]" title={l.coloris}>{l.coloris || '—'}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">{fmtNum(l.quantite)} {UNITE_LABEL[l.unite] ?? ''}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">{l.prix ? `${fmtNum(l.prix, 2)} €` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data?.capped && <p className="text-[11px] text-muted-foreground italic mt-2">120 commandes les plus récentes affichées.</p>}
        </>
      )}
    </>
  )
}

// ── Marchandise expédiée ───────────────────────────────

interface MarchLigne { IDexpedition: number; IDstock_fini: number; date: string | null; piece: string; lot: string; ref: string; coloris: string; poids: number; metrage: number; second_choix: number }
interface MarchPayload { lignes: MarchLigne[]; matched: number; total: number; offset: number; limit: number }

type MarchSortKey = 'expedition' | 'date' | 'ref' | 'coloris' | 'piece' | 'poids' | 'metrage'

/** Columns of the marchandise table — one definition drives the header cells,
 *  their sort keys and their alignment, so a column can never be sortable in
 *  the header but unsorted on the server. */
const MARCH_COLUMNS: { key: MarchSortKey; label: string; align?: 'right' }[] = [
  { key: 'date', label: 'Expédié le' },
  { key: 'expedition', label: 'Expé N°' },
  { key: 'ref', label: 'Référence' },
  { key: 'coloris', label: 'Coloris' },
  { key: 'piece', label: 'Pièce' },
  { key: 'poids', label: 'Poids', align: 'right' },
  { key: 'metrage', label: 'Métrage', align: 'right' },
]

/** Rows per page. The table lazy-loads the next page as the user scrolls, so
 *  this only sets how often that happens — never what is reachable. */
const MARCH_PAGE = 200

/** Sortable header cell — §27.4: the active column goes gold and carries the
 *  direction arrow. */
function MarchSortTh({ col, sort, onSort }: {
  col: { key: MarchSortKey; label: string; align?: 'right' }
  sort: { key: MarchSortKey; dir: 'asc' | 'desc' } | null
  onSort: (k: MarchSortKey) => void
}) {
  const active = sort?.key === col.key
  return (
    <th
      onClick={() => onSort(col.key)}
      className={cn('px-2 py-1.5 font-semibold cursor-pointer select-none whitespace-nowrap',
        col.align === 'right' ? 'text-right' : 'text-left',
        active && 'text-accent')}
    >
      <span className={cn('inline-flex items-center gap-1', col.align === 'right' && 'flex-row-reverse')}>
        {col.label}
        {active && (sort.dir === 'asc' ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
      </span>
    </th>
  )
}

function MarchandiseTab({ clientId, clientNom, canRetour }: { clientId: number; clientNom: string; canRetour: boolean }) {
  const queryClient = useQueryClient()
  // Search and sort run server-side over the client's WHOLE history (ticket
  // #1085) — a piece shipped two years ago has to be findable to be returned —
  // while the rows themselves arrive one page at a time as the user scrolls.
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState<{ key: MarchSortKey; dir: 'asc' | 'desc' } | null>(null)
  // Debounced so typing does not fire a query per keystroke: each one is a full
  // history scan on the shared HFSQL server.
  const [debouncedSearch, setDebouncedSearch] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])

  const params = new URLSearchParams()
  if (debouncedSearch) params.set('q', debouncedSearch)
  if (sort) { params.set('sort', sort.key); params.set('dir', sort.dir) }
  const qs = params.toString()
  // Pages accumulate. A new search or sort is a new query key, so the list
  // restarts at page 1 by itself — no manual reset to forget.
  const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery<MarchPayload>({
    queryKey: ['client-marchandise', clientId, qs],
    queryFn: ({ pageParam }) => apiFetch(
      `/clients/${clientId}/marchandise?offset=${pageParam as number}&limit=${MARCH_PAGE}${qs ? `&${qs}` : ''}`,
    ),
    initialPageParam: 0,
    getNextPageParam: (last, all) => {
      const loaded = all.reduce((k, p) => k + p.lignes.length, 0)
      return loaded < last.matched ? loaded : undefined
    },
  })

  // Return-to-stock flow (retour_marchandise permission): the table is
  // read-only until the user enters selection mode via "Reprendre des pièces";
  // checkboxes only exist in that mode, exited by Annuler or a completed return.
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [confirmOpen, setConfirmOpen] = useState(false)
  // Shift+click anchor (§44) — an IDstock_fini, never a row index: the rendered
  // list grows and re-sorts under the user, and a stale index would extend the
  // range across rows they never saw.
  const lastSelectedId = useRef<number | null>(null)
  useEffect(() => {
    setSelectMode(false); setSelected(new Set()); lastSelectedId.current = null
    setSearch(''); setSort(null)
  }, [clientId])

  // Every loaded page flattened — this IS the rendered list, and therefore the
  // array the Shift+click range and "Tout sélectionner" run against.
  const lignes = useMemo(() => data?.pages.flatMap((p) => p.lignes) ?? [], [data])
  const matched = data?.pages[0]?.matched ?? 0
  const total = data?.pages[0]?.total ?? 0

  // Lazy loading: a sentinel at the end of the scroll container pulls the next
  // page into view before the user reaches the bottom (rootMargin), so the list
  // feels continuous instead of stepping. `root` is the scrolling div, not the
  // viewport — the table scrolls internally, so a viewport-rooted observer
  // would fire once and never again.
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const root = scrollRef.current
    const target = sentinelRef.current
    if (!root || !target || !hasNextPage) return
    const io = new IntersectionObserver((entries) => {
      // isFetchingNextPage is read from the closure, which this effect
      // re-creates whenever it flips — so no double-fetch on one intersection.
      if (entries.some((en) => en.isIntersecting) && !isFetchingNextPage) fetchNextPage()
    }, { root, rootMargin: '200px' })
    io.observe(target)
    return () => io.disconnect()
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, lignes.length])

  const retourMut = useMutation({
    mutationFn: () => apiFetch(`/clients/${clientId}/marchandise/retour-stock`, { method: 'POST', body: JSON.stringify({ ids: [...selected] }) }),
    onSuccess: () => {
      setConfirmOpen(false)
      setSelectMode(false)
      setSelected(new Set())
      lastSelectedId.current = null
      queryClient.invalidateQueries({ queryKey: ['client-marchandise', clientId] })
      // A retour puts the roll back in stock (clears the expedition line,
      // demotes état 4 → 3, releases the order line). Finis › Stock is exactly
      // the screen the user checks next to confirm it landed.
      invalidateStockCaches(queryClient)
    },
  })

  const exitSelectMode = () => { setSelectMode(false); setSelected(new Set()); lastSelectedId.current = null }
  const handleSort = (k: MarchSortKey) => {
    setSort((prev) => (prev?.key === k ? { key: k, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: 'asc' }))
    lastSelectedId.current = null   // the rendered order changed — the anchor is meaningless
  }
  // §44.1: plain click toggles and re-anchors; Shift+click applies the inclusive
  // range in RENDERED order, adding or removing depending on the clicked row's
  // state, and deliberately does not move the anchor.
  const handleRowClick = useCallback((id: number, shiftKey: boolean) => {
    const ids = lignes.map((l) => l.IDstock_fini)
    const anchor = lastSelectedId.current
    if (shiftKey && anchor !== null && anchor !== id) {
      const a = ids.indexOf(anchor), b = ids.indexOf(id)
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        setSelected((prev) => {
          const next = new Set(prev)
          const deselect = prev.has(id)
          for (let i = lo; i <= hi; i++) { if (deselect) next.delete(ids[i]); else next.add(ids[i]) }
          return next
        })
        return
      }
    }
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
    lastSelectedId.current = id
  }, [lignes])
  // "Tout" is scoped to the pages loaded — the only rows the user can see.
  const allSelected = lignes.length > 0 && lignes.every((l) => selected.has(l.IDstock_fini))
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(lignes.map((l) => l.IDstock_fini)))
    lastSelectedId.current = allSelected ? null : (lignes[lignes.length - 1]?.IDstock_fini ?? null)
  }
  const selPoids = lignes.filter((l) => selected.has(l.IDstock_fini)).reduce((s, l) => s + l.poids, 0)
  // Pieces can be ticked, then searched away — keep the count honest.
  const selOffscreen = selected.size - lignes.filter((l) => selected.has(l.IDstock_fini)).length
  const today = new Date().toLocaleDateString('fr-FR')

  return (
    <>
      {/* mb-2: this tab's wrapper is a plain flex column with no gap (the table
          pins the toolbar and scrolls internally), so the spacing is the
          search bar's own — without it the table sits flush against it. */}
      {(total > 0 || debouncedSearch !== '') && (
        <div className="relative flex-shrink-0 mx-1 mb-2">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher une pièce (n° pièce, réf, coloris, lot, n° expédition…)"
            className="w-full h-9 pl-9 pr-9 text-sm rounded-md border border-input bg-white focus:outline-none focus:ring-2 focus:ring-ring" />
          {search !== '' && (
            <button type="button" onClick={() => setSearch('')} title="Effacer la recherche"
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-zinc-100">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
      {isLoading ? <SectionSpinner /> : lignes.length === 0 ? (
        <SectionEmpty text={debouncedSearch ? 'Aucune pièce ne correspond à la recherche' : 'Aucune expédition'} />
      ) : (
        <>
          {/* min-h-0 + default flex-shrink: the table takes its natural height
              on short lists and scrolls internally on long ones. */}
          <div ref={scrollRef} className="min-h-0 overflow-auto rounded-lg border border-border/60 bg-card shadow-sm scrollbar-transparent">
            <table className="w-full text-xs">
              <thead className={cn(thHead, 'sticky top-0 z-10 bg-zinc-100')}><tr>
                {selectMode && (
                  <th className="px-2 py-1.5 w-7">
                    <input type="checkbox" checked={allSelected} onChange={toggleAll} title="Tout sélectionner (lignes chargées)"
                      className="h-3.5 w-3.5 rounded border-input accent-accent cursor-pointer align-middle" />
                  </th>
                )}
                {MARCH_COLUMNS.map((c) => <MarchSortTh key={c.key} col={c} sort={sort} onSort={handleSort} />)}
              </tr></thead>
              <tbody>
                {lignes.map((l) => (
                  <tr key={l.IDstock_fini}
                    onClick={selectMode ? (e) => handleRowClick(l.IDstock_fini, e.shiftKey) : undefined}
                    className={cn('border-b border-border/40 last:border-b-0',
                      // select-none: Shift+click must extend the selection, not select text
                      selectMode && 'cursor-pointer select-none',
                      selectMode && selected.has(l.IDstock_fini) ? 'bg-accent/10' : 'hover:bg-accent/5')}>
                    {selectMode && (
                      <td className="px-2 py-1.5">
                        <input type="checkbox" checked={selected.has(l.IDstock_fini)} onChange={() => {}}
                          onClick={(e) => { e.stopPropagation(); handleRowClick(l.IDstock_fini, e.shiftKey) }}
                          className="h-3.5 w-3.5 rounded border-input accent-accent cursor-pointer align-middle" />
                      </td>
                    )}
                    <td className="px-2 py-1.5 whitespace-nowrap">{l.date && /\d{8}/.test(l.date) ? formatHfsqlDate(l.date) : '—'}</td>
                    <td className="px-2 py-1.5 tabular-nums">{l.IDexpedition}</td>
                    <td className="px-2 py-1.5 truncate max-w-[150px]" title={l.ref}>{l.ref || '—'}</td>
                    <td className="px-2 py-1.5 truncate max-w-[150px]" title={l.coloris}>{l.coloris || '—'}</td>
                    <td className="px-2 py-1.5 whitespace-nowrap">{l.piece || '—'}{!!l.second_choix && <Badge variant="outline" className="ml-1 text-[9px] py-0 px-1">2nd</Badge>}</td>
                    <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">{fmtNum(l.poids, 2)} kg</td>
                    <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">{fmtNum(l.metrage, 1)} Ml</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* Lazy-load sentinel — inside the scroll container, after the table,
                so it enters view as the user nears the last row. */}
            {hasNextPage && (
              <div ref={sentinelRef} className="flex items-center justify-center gap-2 py-3 text-[11px] text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
                Chargement des pièces suivantes…
              </div>
            )}
          </div>
          {/* Count + the entry into selection mode. The count names the whole
              population, so the list can never look like it holds everything
              when it does not — the ambiguity ticket #1085 was about. */}
          <div className="flex-shrink-0 flex items-center gap-2 mt-2">
            <p className="text-[11px] text-muted-foreground italic">
              {debouncedSearch
                ? `${fmtNum(matched)} pièce${matched > 1 ? 's' : ''} trouvée${matched > 1 ? 's' : ''} sur ${fmtNum(total)}`
                : `${fmtNum(total)} pièce${total > 1 ? 's' : ''}`}
            </p>
            {canRetour && !selectMode && (
              <Button variant="outline" size="sm" className="ml-auto" onClick={() => setSelectMode(true)}>
                <ArchiveRestore className="h-3.5 w-3.5 mr-1.5" />Reprendre des pièces
              </Button>
            )}
          </div>
          {selectMode && (
            <div className="flex-shrink-0 mt-2 flex items-center gap-2 px-3 py-2 rounded-lg border border-accent/30 bg-accent/10 shadow-sm">
              <span className="text-xs font-medium">
                {selected.size === 0
                  ? 'Sélectionnez les pièces à reprendre — MAJ + clic pour une plage'
                  : `${selected.size} pièce${selected.size > 1 ? 's' : ''} sélectionnée${selected.size > 1 ? 's' : ''} · ${fmtNum(selPoids, 2)} kg${selOffscreen > 0 ? ` (dont ${selOffscreen} hors liste)` : ''}`}
              </span>
              <Button variant="outline" size="sm" className="ml-auto" onClick={exitSelectMode} disabled={retourMut.isPending}>
                Annuler
              </Button>
              <Button size="sm" onClick={() => setConfirmOpen(true)} disabled={selected.size === 0 || retourMut.isPending}>
                <ArchiveRestore className="h-3.5 w-3.5 mr-1.5" />Remettre en stock
              </Button>
            </div>
          )}
        </>
      )}
      <ConfirmDialog
        open={confirmOpen}
        variant="default"
        title="Remettre en stock"
        // The wording spells out the reservation release: the roll leaves its
        // client-order line, so that order reads as under-delivered again.
        description={`${selected.size} pièce${selected.size > 1 ? 's' : ''} sera${selected.size > 1 ? 'ont' : ''} retirée${selected.size > 1 ? 's' : ''} de la marchandise expédiée et de sa commande client, puis réapparaîtra${selected.size > 1 ? 'ont' : ''} dans Finis > Stock en état « Validé », avec l'observation « Récupéré chez ${clientNom} le ${today} ».`}
        confirmLabel="Remettre en stock"
        isPending={retourMut.isPending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => retourMut.mutate()}
      />
    </>
  )
}
